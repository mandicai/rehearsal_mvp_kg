"""Server-side ffmpeg assembly of a real, playable documentary MP4 from an
already-storyboarded arc - the automated alternative to the Premiere Pro UXP
export path (see premiere_bridge.py and server.py's /premiere/export), which
needs Premiere open and a lot of manual steps and still produces no audio.

This path instead renders each shot to an identical-parameter intermediate
clip (1920x1080, yuv420p, 30fps, H.264 + AAC 48kHz stereo) so the concat
demuxer's fast, lossless `-c copy` join works at the end, and produces a
final documentary.mp4 automatically with original footage audio, narration,
and sound-effect audio actually mixed in. Pure subprocess ffmpeg orchestration (no ffmpeg-python
wrapper), matching premiere_bridge.py's own remux_for_reliable_playback
convention.

Every intermediate/final ffmpeg command was verified live against real
still/clip/silence inputs before this module was written - see the plan at
.claude/plans/ for the specific patterns (zoompan on a -loop 1 still,
drawtext via a textfile to sidestep escaping, amix ducking, and a
still+clip+silence concat all confirmed to decode cleanly).

ffmpeg/ffprobe are invoked by name from PATH by default (as the deployed
Debian image provides them - see backend/Dockerfile), overridable via
FFMPEG_BIN/FFPROBE_BIN so a local dev box whose default ffmpeg lacks
drawtext (e.g. Homebrew's plain `ffmpeg`, which isn't built with
libfreetype) can point at one that has it.
"""
import json
import os
import subprocess
import tempfile
from pathlib import Path

# Uniform output parameters every shot is normalized to, so concat_shots'
# `-c copy` join is valid (mismatched resolution/fps/codec/sample-rate
# between segments makes the concat demuxer produce a broken file).
_WIDTH = 1920
_HEIGHT = 1080
_FPS = 30
_SAMPLE_RATE = 48000

FFMPEG_BIN = os.environ.get('FFMPEG_BIN', 'ffmpeg')
FFPROBE_BIN = os.environ.get('FFPROBE_BIN', 'ffprobe')

# drawtext needs a real font file - the deployed Debian ffmpeg is built with
# libfreetype but `apt-get install ffmpeg` pulls in no font, so one is
# bundled in-repo (see backend/assets/fonts/, license alongside it).
_FONT_PATH = Path(__file__).resolve().parent / 'assets' / 'fonts' / 'DejaVuSans.ttf'

# Per-frame zoom increment for a Ken Burns "in"/"out" move - ~0.29 total
# over a typical ~195-frame (6.5s) shot, a gentle drift rather than a
# lurch; shorter shots simply move less.
_ZOOM_STEP = 0.0015
_ZOOM_MAX = 1.3
# Constant zoom for a left/right pan - has to be > 1 so there's off-frame
# image to actually pan across.
_PAN_ZOOM = 1.2

# A sound-effect pick sits under narration (ducked well below it) when both
# are present, but comes up to a comfortable bed level when it's the only
# audio in the shot.
_SFX_DUCKED_VOLUME = 0.22
_SFX_SOLO_VOLUME = 0.5

# A dip_to_black transition can't be a real blend through the concat
# demuxer (it joins finished segments, it doesn't composite between them),
# so it's approximated by concatenating a short black+silent segment in
# front of the shot - see render_documentary.
_DIP_TO_BLACK_SECONDS = 0.5

# Image extensions that mean "still" (rendered via zoompan/hold) vs.
# anything else, treated as a real clip (trimmed/looped). Kept lowercase.
# .gif is deliberately NOT here - the only GIFs this pipeline sees are the
# animated storyboard-sketch sequences (see animate_llm.py's GIF method), so
# routing them through the clip path (which loops/animates) rather than the
# still path (which would freeze on frame one) is what preserves them.
_STILL_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp', '.bmp'}

_MIN_SHOT_SECONDS = 1.0


class MovieRenderError(Exception):
    pass


def _run(cmd, timeout):
    """Runs an ffmpeg/ffprobe command, raising MovieRenderError with the
    tail of stderr on failure - ffmpeg's actual complaint is the only
    useful thing to surface to a caller trying to figure out why a render
    died."""
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except FileNotFoundError as exc:
        raise MovieRenderError(f'{cmd[0]} not found on PATH (set FFMPEG_BIN/FFPROBE_BIN?): {exc}')
    except subprocess.SubprocessError as exc:
        raise MovieRenderError(f'{cmd[0]} failed to run: {exc}')
    if result.returncode != 0:
        stderr = result.stderr.decode('utf-8', 'replace')
        tail = '\n'.join(stderr.strip().splitlines()[-6:])
        raise MovieRenderError(f'{cmd[0]} exited {result.returncode}:\n{tail}')
    return result


def probe_duration(path):
    """Seconds of media at path via ffprobe, or None if it can't be read -
    used to anchor a shot's length to its narration (never truncate the
    voice) rather than the LLM's abstract duration guess."""
    try:
        result = subprocess.run(
            [FFPROBE_BIN, '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'default=noprint_wrappers=1:nokey=1', str(path)],
            capture_output=True, timeout=30,
        )
    except (FileNotFoundError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    try:
        return float(result.stdout.decode('utf-8', 'replace').strip())
    except ValueError:
        return None


def _has_audio_stream(path):
    """Return whether a visual clip contains a readable audio stream.

    Uploaded/stock footage can be silent or video-only. We only reference
    ``[0:a]`` in the ffmpeg filtergraph when ffprobe confirms an audio stream,
    otherwise a perfectly valid silent video would make the whole render fail.
    """
    try:
        result = subprocess.run(
            [FFPROBE_BIN, '-v', 'error', '-select_streams', 'a:0',
             '-show_entries', 'stream=index', '-of', 'csv=p=0', str(path)],
            capture_output=True, timeout=30,
        )
    except (FileNotFoundError, subprocess.SubprocessError):
        return False
    return result.returncode == 0 and bool(result.stdout.decode('utf-8', 'replace').strip())


def _is_still(visual_path):
    return Path(visual_path).suffix.lower() in _STILL_EXTENSIONS


def _zoompan_expr(pan, total_frames):
    """A zoompan filter string for a Ken Burns move, or None for no motion
    (caller then just scales/holds the still). total_frames is the whole
    shot's frame count, since we -loop 1 a single input image."""
    span = max(total_frames - 1, 1)
    if pan == 'in':
        z, x, y = f'min(zoom+{_ZOOM_STEP},{_ZOOM_MAX})', 'iw/2-(iw/zoom/2)', 'ih/2-(ih/zoom/2)'
    elif pan == 'out':
        # zoom starts in and eases back out (zoompan's zoom var accumulates
        # frame-to-frame, so it has to be seeded high on frame 0).
        z, x, y = f'if(eq(on,0),{_ZOOM_MAX},max(zoom-{_ZOOM_STEP},1.0))', 'iw/2-(iw/zoom/2)', 'ih/2-(ih/zoom/2)'
    elif pan == 'left_to_right':
        z, x, y = str(_PAN_ZOOM), f'(iw-iw/zoom)*on/{span}', 'ih/2-(ih/zoom/2)'
    elif pan == 'right_to_left':
        z, x, y = str(_PAN_ZOOM), f'(iw-iw/zoom)*(1-on/{span})', 'ih/2-(ih/zoom/2)'
    else:
        return None
    return (f"zoompan=z='{z}':d={total_frames}:x='{x}':y='{y}':"
            f's={_WIDTH}x{_HEIGHT}:fps={_FPS}')


def _video_filter_for_still(shot, total_frames, overlay_file):
    """Filter chain for a still image: optional Ken Burns via zoompan (else
    scale-and-pad hold), then an optional drawtext overlay, ending in
    yuv420p."""
    kb = shot.get('ken_burns') or {}
    zoompan = _zoompan_expr(kb.get('pan'), total_frames) if kb.get('enabled') else None
    if zoompan:
        chain = [f'scale={_WIDTH}:{_HEIGHT}', zoompan]
    else:
        chain = [
            f'scale={_WIDTH}:{_HEIGHT}:force_original_aspect_ratio=decrease',
            f'pad={_WIDTH}:{_HEIGHT}:(ow-iw)/2:(oh-ih)/2',
            'setsar=1',
            f'fps={_FPS}',
        ]
    if overlay_file is not None:
        chain.append(_drawtext_expr(overlay_file))
    chain.append('format=yuv420p')
    return ','.join(chain)


def _video_filter_for_clip(overlay_file, pad_seconds=0.0):
    """Filter chain for a real clip: scale+pad into the target frame (letter/
    pillarbox rather than crop, so nothing important is cut off), normalize
    sar/fps, optional overlay, yuv420p. Ken Burns is intentionally ignored
    for clips (it's a stills technique - matches edit_plan_llm's own note).

    `pad_seconds` appends black to the end so a clip shorter than its shot
    still fills the slot exactly. The alternative - looping the clip - makes it
    visibly restart, which reads as a broken player rather than an edit. A gap
    is the honest outcome when a clip has run out of material.
    """
    chain = [
        f'scale={_WIDTH}:{_HEIGHT}:force_original_aspect_ratio=decrease',
        f'pad={_WIDTH}:{_HEIGHT}:(ow-iw)/2:(oh-ih)/2',
        'setsar=1',
        f'fps={_FPS}',
    ]
    if pad_seconds > 0:
        # -t on the command truncates the padded stream back to the shot's
        # exact length, so over-padding here is safe and keeps concat aligned.
        chain.append(
            f'tpad=stop_mode=add:stop_duration={pad_seconds:.3f}:color=black')
    if overlay_file is not None:
        chain.append(_drawtext_expr(overlay_file))
    chain.append('format=yuv420p')
    return ','.join(chain)


def _drawtext_expr(overlay_file):
    # textfile= (never text=) so LLM-authored overlay text with colons/
    # apostrophes/etc. doesn't have to be escaped into the filtergraph.
    # The font path and textfile path are ours (a bundled asset and a temp
    # file), so only their few filtergraph-special chars need escaping.
    return (f"drawtext=fontfile='{_escape_filter_path(str(_FONT_PATH))}':"
            f"textfile='{_escape_filter_path(str(overlay_file))}':"
            'fontcolor=white:fontsize=48:box=1:boxcolor=black@0.5:boxborderw=12:'
            'x=(w-text_w)/2:y=h-text_h-80')


def _escape_filter_path(path):
    # Inside a filtergraph, ':' separates options and '\' escapes - a path
    # containing either would otherwise be misparsed. Our paths are
    # controlled (repo asset dir, tempdir) so this is belt-and-suspenders,
    # but cheap.
    return path.replace('\\', '\\\\').replace(':', r'\:')


# The scale/pad/normalize chain shared by every still (single or start/end
# pair) - letterbox/pillarbox into the target frame, fixed sar/fps, yuv420p.
_STILL_NORM_CHAIN = (
    f'scale={_WIDTH}:{_HEIGHT}:force_original_aspect_ratio=decrease,'
    f'pad={_WIDTH}:{_HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={_FPS},format=yuv420p'
)


def _audio_inputs_and_filter(shot, effective_seconds, audio_base_index=1, source_audio=False):
    """Builds the ffmpeg input args and the audio half of a filtergraph for
    a shot - original footage audio, narration at full level, a sound effect
    ducked under it, or generated silence when there's none. Returns
    (input_args, filter_str, audio_label).

    audio_base_index is the ffmpeg input index the FIRST audio input will
    land at - i.e. the number of video inputs already declared before these
    (1 for the usual single-visual shot, 2 for a start/end still pair). The
    filtergraph's `[N:a]` labels are computed from it.

    When source_audio is true, the single visual input already has the source
    audio at index 0; it is mixed directly instead of being added as another
    ffmpeg input.

    The video side always caps the shot at effective_seconds via -t, so the
    audio only needs to be *at least* that long (silence/anullsrc is
    infinite; a real track is trimmed by the same -t)."""
    narration = shot.get('narration_audio_path')
    sfx = shot.get('sfx_audio_path')
    n = audio_base_index
    source = '[0:a]aresample=%d,aformat=channel_layouts=stereo' % _SAMPLE_RATE if source_audio else None

    inputs = []
    labels = []
    filters = []
    if source:
        # Preserve camera/production audio, but keep it below narration when
        # narration is present so the spoken track remains intelligible.
        # The presenter's own level for this clip, ducked under narration so the
        # spoken track stays intelligible. Without the node level a clip turned
        # down on the board came back at full volume in the export.
        node_volume = shot.get('source_volume')
        node_volume = (float(node_volume)
                       if isinstance(node_volume, (int, float)) and node_volume >= 0 else 1.0)
        duck = 0.35 if (narration or shot.get('duck_source_audio')) else 1.0
        source_volume = round(max(0.0, min(1.0, node_volume)) * duck, 4)
        filters.append(f'{source},volume={source_volume}[source]')
        labels.append('[source]')
    if narration:
        inputs += ['-i', str(narration)]
        filters.append(
            f'[{n}:a]aresample={_SAMPLE_RATE},aformat=channel_layouts=stereo,volume=1.0[nar]')
        labels.append('[nar]')
        n += 1
    if sfx:
        inputs += ['-i', str(sfx)]
        sfx_volume = _SFX_DUCKED_VOLUME if (narration or source_audio) else _SFX_SOLO_VOLUME
        filters.append(
            f'[{n}:a]aresample={_SAMPLE_RATE},aformat=channel_layouts=stereo,volume={sfx_volume}[sfx]')
        labels.append('[sfx]')

    if labels:
        if len(labels) == 1:
            filters.append(f'{labels[0]}anull[aout]')
        else:
            filters.append(
                f'{"".join(labels)}amix=inputs={len(labels)}:duration=longest:normalize=0[aout]')
        return inputs, ';'.join(filters), '[aout]'

    # No audio at all - a generated silent stereo track, so every shot
    # still has a uniform audio stream for the concat to line up.
    inputs = ['-f', 'lavfi', '-i', f'anullsrc=channel_layout=stereo:sample_rate={_SAMPLE_RATE}']
    flt = f'[{n}:a]anull[aout]'
    return inputs, flt, '[aout]'


def _effective_seconds(shot):
    """A shot is at least its planned duration, but never shorter than its
    narration (the voice is the timing anchor - truncating it mid-sentence
    would be the one unacceptable failure)."""
    planned = shot.get('duration_seconds')
    seconds = float(planned) if isinstance(planned, (int, float)) and planned > 0 else 5.0
    narration = shot.get('narration_audio_path')
    if narration:
        narration_seconds = probe_duration(narration)
        if narration_seconds:
            seconds = max(seconds, narration_seconds)
    return max(seconds, _MIN_SHOT_SECONDS)


def render_shot(shot, output_path, tmp_dir):
    """Renders one shot spec to a normalized MP4 at output_path.

    A shot is one of:
    - a start/end still PAIR (start_visual_path + end_visual_path) - the
      narration-driven shot design (see backend/shot_plan_llm.py): the start
      frame is held for the first half of the shot, then a hard cut to the
      end frame for the second half, with the audio mix over the whole shot.
    - a single visual_path - a still (Ken Burns via ken_burns) or a real clip
      (looped/trimmed to length).

    Other keys: narration_audio_path / sfx_audio_path (optional local paths),
    duration_seconds (from the edit plan), ken_burns {enabled, pan} (single
    still only), text_overlay (optional str). tmp_dir is a caller-owned
    scratch dir for the drawtext textfile."""
    seconds = _effective_seconds(shot)
    total_frames = max(int(round(seconds * _FPS)), 1)

    overlay_file = None
    overlay_text = (shot.get('text_overlay') or '').strip()
    if overlay_text:
        fd, overlay_file = tempfile.mkstemp(suffix='.txt', dir=str(tmp_dir))
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(overlay_text)

    cutaway_paths = [p for p in (shot.get('cutaway_paths') or []) if p and Path(p).is_file()]

    start_path = shot.get('start_visual_path')
    end_path = shot.get('end_visual_path')
    two_still = bool(start_path and end_path and Path(start_path).is_file() and Path(end_path).is_file())
    split_visual_paths = [
        str(path) for path in (shot.get('split_visual_paths') or [])
        if path and Path(path).is_file()
    ]
    source_audio = False

    if len(split_visual_paths) >= 2:
        # Act-board split-screen shots are rendered as a single normalized
        # frame so the selected composition survives both scene playback and
        # the final MP4. Each source keeps its own still/clip behavior; source
        # audio is intentionally omitted because the board mixes narration and
        # sound-effect tracks independently.
        n = len(split_visual_paths)
        pane_width = max(1, _WIDTH // n)
        source_starts = shot.get('split_source_start_seconds') or []
        video_input = []
        parts = []
        for index, path in enumerate(split_visual_paths):
            source_start = max(0.0, float(source_starts[index] or 0)) if index < len(source_starts) else 0.0
            pane_pad = 0.0
            if _is_still(path):
                video_input += ['-loop', '1', '-t', f'{seconds:.3f}', '-i', path]
            else:
                # Pad a short pane with black rather than looping it - one pane
                # restarting while the other plays on is especially obvious.
                pane_seconds = probe_duration(path) or 0.0
                pane_available = max(0.0, pane_seconds - source_start) if pane_seconds else 0.0
                pane_pad = max(0.0, seconds - pane_available) if pane_available else 0.0
                if source_start > 0:
                    video_input += ['-ss', f'{source_start:.3f}']
                video_input += ['-i', path]
            pane_pad_filter = (
                f',tpad=stop_mode=add:stop_duration={pane_pad:.3f}:color=black'
                if pane_pad > 0 else '')
            parts.append(
                f'[{index}:v]scale={pane_width}:{_HEIGHT}:force_original_aspect_ratio=decrease,'
                f'pad={pane_width}:{_HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={_FPS}'
                f'{pane_pad_filter},format=yuv420p'
                f'[split{index}]')
        split_inputs = ''.join(f'[split{index}]' for index in range(n))
        parts.append(f'{split_inputs}hstack=inputs={n}:shortest=1[vcat]')
        if overlay_file is not None:
            parts.append(f'[vcat]{_drawtext_expr(overlay_file)},format=yuv420p[vout]')
        else:
            parts.append('[vcat]format=yuv420p[vout]')
        video_part = ';'.join(parts)
        audio_base = n
    elif len(cutaway_paths) >= 2:
        # Expository cutaways: every cutaway still shown in sequence, hard cuts,
        # each held for an equal slice of the shot (seconds/N); the concat filter
        # joins them into one continuous stream and the audio mix (inputs after
        # the N image inputs) plays over the whole shot. Generalizes the
        # two-still branch below to N stills.
        n = len(cutaway_paths)
        slice_t = max(seconds / n, 0.1)
        video_input = []
        for p in cutaway_paths:
            video_input += ['-loop', '1', '-t', f'{slice_t:.3f}', '-i', str(p)]
        parts = [f'[{k}:v]{_STILL_NORM_CHAIN}[v{k}]' for k in range(n)]
        concat_in = ''.join(f'[v{k}]' for k in range(n))
        if overlay_file is not None:
            parts.append(f'{concat_in}concat=n={n}:v=1:a=0[vcat]')
            parts.append(f'[vcat]{_drawtext_expr(overlay_file)},format=yuv420p[vout]')
        else:
            parts.append(f'{concat_in}concat=n={n}:v=1:a=0[vout]')
        video_part = ';'.join(parts)
        audio_base = n
    elif two_still:
        # Two frames, hard cut at the midpoint. Derive the two holds from the
        # output frame count rather than independently rounded second values:
        # this guarantees that the final encoded frame belongs to the end
        # still (rather than the concat filter ending one frame early). The
        # total duration remains the requested shot duration.
        total_frames = max(int(round(seconds * _FPS)), 1)
        first_frames = max(1, total_frames // 2)
        if total_frames > 1:
            first_frames = min(first_frames, total_frames - 1)
        second_frames = max(1, total_frames - first_frames)
        first_duration = first_frames / _FPS
        second_duration = second_frames / _FPS
        video_input = [
            '-loop', '1', '-t', f'{first_duration:.6f}', '-i', str(start_path),
            '-loop', '1', '-t', f'{second_duration:.6f}', '-i', str(end_path),
        ]
        parts = [f'[0:v]{_STILL_NORM_CHAIN}[v0]', f'[1:v]{_STILL_NORM_CHAIN}[v1]']
        if overlay_file is not None:
            parts.append('[v0][v1]concat=n=2:v=1:a=0[vcat]')
            parts.append(f'[vcat]{_drawtext_expr(overlay_file)},format=yuv420p[vout]')
        else:
            parts.append('[v0][v1]concat=n=2:v=1:a=0[vout]')
        video_part = ';'.join(parts)
        audio_base = 2
    else:
        visual_path = shot.get('visual_path')
        if not visual_path or not Path(visual_path).is_file():
            raise MovieRenderError(f'shot has no readable visual: {visual_path!r}')
        if _is_still(visual_path):
            video_input = ['-loop', '1', '-i', str(visual_path)]
            video_filter = _video_filter_for_still(shot, total_frames, overlay_file)
            source_audio = False
        else:
            # A clip shorter than its shot is padded with black to the end of
            # the slot, never looped. Looping (-stream_loop -1, used here
            # previously) makes a short clip restart on screen - the failure
            # the board's own duration clamp exists to prevent, and the one
            # generated clips hit constantly since the model caps them well
            # short of most narration phrases. A longer clip is trimmed by -t
            # as before. A board footage node can also choose a source
            # in-point, applied before the input so the rendered shot uses the
            # same portion selected in the browser.
            source_start = max(0.0, float(shot.get('source_start_seconds') or 0))
            clip_seconds = probe_duration(visual_path) or 0.0
            available = max(0.0, clip_seconds - source_start) if clip_seconds else 0.0
            pad_seconds = max(0.0, seconds - available) if available else 0.0
            video_input = []
            if source_start > 0:
                video_input += ['-ss', f'{source_start:.3f}']
            video_input += ['-i', str(visual_path)]
            video_filter = _video_filter_for_clip(overlay_file, pad_seconds)
            # Some generated video models return an incidental soundtrack.
            # The caller can explicitly suppress it while keeping separate
            # narration/SFX inputs available to the mix.
            source_audio = (
                _has_audio_stream(visual_path)
                and not bool(shot.get('mute_source_audio'))
            )
        video_part = f'[0:v]{video_filter}[vout]'
        audio_base = 1

    audio_inputs, audio_filter, audio_label = _audio_inputs_and_filter(
        shot, seconds, audio_base, source_audio=source_audio)

    filter_complex = f'{video_part};{audio_filter}'
    cmd = [
        FFMPEG_BIN, '-y',
        *video_input,
        *audio_inputs,
        '-filter_complex', filter_complex,
        '-map', '[vout]', '-map', audio_label,
        '-t', f'{seconds:.3f}',
        '-r', str(_FPS),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast',
        '-c:a', 'aac', '-ar', str(_SAMPLE_RATE), '-ac', '2',
        str(output_path),
    ]
    # Generous per-shot timeout: encoding a minute of 1080p on a modest
    # CPU-only box is still well under this, but a pathological input
    # shouldn't hang the render thread forever.
    _run(cmd, timeout=600)


def render_black_segment(output_path, seconds=_DIP_TO_BLACK_SECONDS):
    """A short black + silent segment, normalized to the same params as
    every other shot - concatenated in front of a dip_to_black shot to
    approximate the transition (see render_documentary)."""
    cmd = [
        FFMPEG_BIN, '-y',
        '-f', 'lavfi', '-i', f'color=c=black:s={_WIDTH}x{_HEIGHT}:r={_FPS}',
        '-f', 'lavfi', '-i', f'anullsrc=channel_layout=stereo:sample_rate={_SAMPLE_RATE}',
        '-map', '0:v', '-map', '1:a',
        '-t', f'{seconds:.3f}',
        '-r', str(_FPS),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast',
        '-c:a', 'aac', '-ar', str(_SAMPLE_RATE), '-ac', '2',
        str(output_path),
    ]
    _run(cmd, timeout=120)


def concat_shots(paths, output_path):
    """Losslessly joins the per-shot MP4s (all already identical-param) via
    the concat demuxer - `-c copy`, no re-encode. +faststart moves the moov
    atom up front for progressive playback over HTTP (see serve.py's static
    serving of premiere_exports/)."""
    if not paths:
        raise MovieRenderError('nothing to concat - no shots rendered')
    list_path = Path(output_path).parent / 'concat_list.txt'
    # concat demuxer reads each `file` line relative to the list's own
    # location by default; absolute POSIX paths (single-quoted, quotes in a
    # path escaped) sidestep that entirely.
    list_path.write_text('\n'.join(
        "file '{}'".format(str(p).replace("'", r"'\''")) for p in paths
    ) + '\n')
    cmd = [
        FFMPEG_BIN, '-y', '-f', 'concat', '-safe', '0', '-i', str(list_path),
        '-c', 'copy', '-movflags', '+faststart', str(output_path),
    ]
    try:
        _run(cmd, timeout=300)
    finally:
        if list_path.exists():
            list_path.unlink()


def mix_global_sound_effects(input_path, sound_effects, output_path):
    """Mix absolute-time SFX events over an already-joined documentary.

    `adelay` places every chosen clip at its browser/timeline start;
    `atrim` applies its selected source in-point and duration (already capped
    at documentary end by the client). Video is stream-copied, while only the
    final audio is encoded.
    """
    if not sound_effects:
        Path(input_path).replace(output_path)
        return

    inputs = ['-i', str(input_path)]
    has_narration = any(effect.get('kind') == 'narration' for effect in sound_effects)
    base_volume = 0.35 if has_narration else 1.0
    filters = [
        f'[0:a]aresample={_SAMPLE_RATE},aformat=channel_layouts=stereo,volume={base_volume}[base]'
    ]
    labels = ['[base]']
    for i, effect in enumerate(sound_effects, start=1):
        inputs += ['-i', str(effect['file_path'])]
        delay_ms = max(0, int(round(float(effect['start_seconds']) * 1000)))
        source_start = max(0, float(effect.get('source_start_seconds') or 0))
        duration = max(0.001, float(effect['duration_seconds']))
        label = f'sfx{i}'
        volume = max(0, float(effect.get('gain', _SFX_DUCKED_VOLUME)))
        # Optional fades, used by J/L-cut audio so the sound that crosses a
        # picture cut rises and falls instead of appearing at full level.
        fade_in = max(0.0, min(duration, float(effect.get('fade_in_seconds') or 0)))
        fade_out = max(0.0, min(duration, float(effect.get('fade_out_seconds') or 0)))
        fades = ''
        if fade_in > 0:
            fades += f',afade=t=in:st=0:d={fade_in:.3f}'
        if fade_out > 0:
            fades += f',afade=t=out:st={max(0.0, duration - fade_out):.3f}:d={fade_out:.3f}'
        filters.append(
            f'[{i}:a]aresample={_SAMPLE_RATE},aformat=channel_layouts=stereo,'
            f'atrim={source_start:.6f}:{source_start + duration:.6f},'
            f'asetpts=PTS-STARTPTS{fades},volume={volume},'
            f'adelay={delay_ms}|{delay_ms}[{label}]'
        )
        labels.append(f'[{label}]')
    filters.append(f'{"".join(labels)}amix=inputs={len(labels)}:duration=first:normalize=0[aout]')
    cmd = [
        FFMPEG_BIN, '-y', *inputs,
        '-filter_complex', ';'.join(filters),
        '-map', '0:v', '-map', '[aout]', '-c:v', 'copy',
        '-c:a', 'aac', '-ar', str(_SAMPLE_RATE), '-ac', '2',
        '-movflags', '+faststart', str(output_path),
    ]
    _run(cmd, timeout=600)


def _write_status(status_path, state, step='', message=''):
    try:
        Path(status_path).write_text(json.dumps({
            'state': state, 'step': step, 'message': message,
        }))
    except OSError:
        pass  # a status write failing shouldn't itself abort a render


def render_documentary(project_id, shots, sound_effects, output_path, status_path):
    """Top-level orchestrator: renders each shot to a scratch dir, joins
    them into output_path, and writes coarse progress to status_path
    ({state: 'rendering'|'done'|'error', step, message}) as it goes so the
    frontend can poll (see server.py's /render/status). Runs on a plain
    background thread (see /render/start) - any failure is caught and
    recorded as an 'error' state rather than raised, since there's no
    request still waiting on it by then."""
    output_path = Path(output_path)
    try:
        if not shots:
            raise MovieRenderError('no shots to render')
        if not _FONT_PATH.is_file():
            raise MovieRenderError(f'bundled font missing at {_FONT_PATH}')

        _write_status(status_path, 'rendering', 'starting', f'Preparing {len(shots)} shot(s) ...')
        work_dir = output_path.parent / 'render_work'
        work_dir.mkdir(parents=True, exist_ok=True)
        # Do not leave gap/transition intermediates from an earlier render in
        # the work directory. The current render uses its in-memory segment
        # list, but cleaning these stale files makes it impossible to mistake
        # an old black segment for part of the new export while debugging.
        for stale in (*work_dir.glob('board_gap_*.mp4'), *work_dir.glob('black_*.mp4')):
            try:
                stale.unlink()
            except OSError:
                pass

        segment_paths = []
        timeline_cursor = 0.0
        for i, shot in enumerate(shots):
            # Act-board footage carries the spoken-fragment start time. Keep
            # any real pause between fragments in the rendered picture instead
            # of silently collapsing the DAG into a back-to-back concat.
            target_start = shot.get('timeline_start_seconds')
            # Board shots carry timeline timestamps. Treat those as a
            # continuous visual sequence even for payloads saved before the
            # explicit hold_for_timeline_gaps flag was added.
            is_board_shot = bool(shot.get('hold_for_timeline_gaps')) or isinstance(
                target_start, (int, float))
            render_shot_spec = shot
            # A board pause should hold/loop the preceding visual, not insert
            # a black clip. Extend this shot to the next board timestamp so
            # the concat cursor reaches that timestamp naturally. This also
            # prevents short Pexels clips from exposing a black interval while
            # the narration continues.
            board_render_start = float(target_start) if isinstance(target_start, (int, float)) else None
            if (is_board_shot and board_render_start is not None
                    and board_render_start > timeline_cursor + 0.03):
                # A board sequence can begin after a recorded-transcript
                # offset. Keep the selected visual on screen during that lead-
                # in rather than creating an unexplained black frame.
                board_render_start = timeline_cursor
            if is_board_shot and isinstance(target_start, (int, float)):
                next_target = None
                for following in shots[i + 1:]:
                    candidate = following.get('timeline_start_seconds')
                    if isinstance(candidate, (int, float)):
                        next_target = float(candidate)
                        break
                current_seconds = _effective_seconds(shot)
                needed_seconds = None
                if next_target is not None and board_render_start is not None and next_target > board_render_start:
                    needed_seconds = next_target - board_render_start
                elif board_render_start is not None and board_render_start < float(target_start):
                    # The final (or only) shot has no following timestamp to
                    # anchor its extension, so carry its lead-in into the
                    # shot duration explicitly.
                    needed_seconds = current_seconds + (float(target_start) - board_render_start)
                if needed_seconds is not None and needed_seconds > current_seconds + 0.01:
                    render_shot_spec = dict(shot)
                    render_shot_spec['duration_seconds'] = needed_seconds
            if (isinstance(target_start, (int, float)) and target_start > timeline_cursor + 0.03
                    and not is_board_shot):
                gap_path = work_dir / f'board_gap_{i:03d}.mp4'
                gap_seconds = target_start - timeline_cursor
                _write_status(status_path, 'rendering', f'shot {i + 1}/{len(shots)}', 'Preserving narration timing ...')
                render_black_segment(gap_path, seconds=gap_seconds)
                segment_paths.append(gap_path)
                timeline_cursor += gap_seconds
            # dip_to_black is faked as a leading black+silent segment (the
            # concat demuxer can't blend between segments) - the Premiere
            # path still gets a real dip. Not applied to the very first
            # shot (nothing to dip from).
            if i > 0 and shot.get('transition_in') == 'dip_to_black' and not is_board_shot:
                black_path = work_dir / f'black_{i:03d}.mp4'
                _write_status(status_path, 'rendering', f'shot {i + 1}/{len(shots)}', 'Rendering dip to black ...')
                render_black_segment(black_path)
                segment_paths.append(black_path)

            _write_status(status_path, 'rendering', f'shot {i + 1}/{len(shots)}',
                          f'Rendering shot {i + 1} of {len(shots)} ...')
            shot_path = work_dir / f'shot_{i:03d}.mp4'
            render_shot(render_shot_spec, shot_path, work_dir)
            segment_paths.append(shot_path)
            timeline_cursor += _effective_seconds(render_shot_spec)

        _write_status(status_path, 'rendering', 'joining', 'Joining shots into the final cut ...')
        if sound_effects:
            joined_path = work_dir / 'joined_without_sfx.mp4'
            concat_shots(segment_paths, joined_path)
            _write_status(status_path, 'rendering', 'mixing', 'Mixing the sound-effects track ...')
            mix_global_sound_effects(joined_path, sound_effects, output_path)
        else:
            concat_shots(segment_paths, output_path)

        _write_status(status_path, 'done', 'done', f'Rendered {len(shots)} shot(s).')
    except Exception as exc:  # noqa: BLE001 - background thread, nothing to re-raise to
        _write_status(status_path, 'error', 'error', str(exc))
