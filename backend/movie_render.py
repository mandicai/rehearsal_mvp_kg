"""Server-side ffmpeg assembly of a real, playable documentary MP4 from an
already-storyboarded arc - the automated alternative to the Premiere Pro UXP
export path (see premiere_bridge.py and server.py's /premiere/export), which
needs Premiere open and a lot of manual steps and still produces no audio.

This path instead renders each shot to an identical-parameter intermediate
clip (1920x1080, yuv420p, 30fps, H.264 + AAC 48kHz stereo) so the concat
demuxer's fast, lossless `-c copy` join works at the end, and produces a
final documentary.mp4 automatically with narration + sound-effect audio
actually mixed in. Pure subprocess ffmpeg orchestration (no ffmpeg-python
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
_STILL_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'}

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


def _video_filter_for_clip(overlay_file):
    """Filter chain for a real clip: scale+pad into the target frame (letter/
    pillarbox rather than crop, so nothing important is cut off), normalize
    sar/fps, optional overlay, yuv420p. Ken Burns is intentionally ignored
    for clips (it's a stills technique - matches edit_plan_llm's own note)."""
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


def _audio_inputs_and_filter(shot, effective_seconds):
    """Builds the ffmpeg input args and the audio half of a filtergraph for
    a shot - narration at full level, a sound effect ducked under it, or a
    solo sound effect at a bed level, or generated silence when there's
    neither. Returns (input_args, filter_str, audio_label, needs_shortest).

    The video side always caps the shot at effective_seconds via -t, so the
    audio only needs to be *at least* that long (silence/anullsrc is
    infinite; a real track is trimmed by the same -t)."""
    narration = shot.get('narration_audio_path')
    sfx = shot.get('sfx_audio_path')

    if narration and sfx:
        inputs = ['-i', str(narration), '-i', str(sfx)]
        flt = (
            f'[1:a]aresample={_SAMPLE_RATE},aformat=channel_layouts=stereo,volume=1.0[nar];'
            f'[2:a]aresample={_SAMPLE_RATE},aformat=channel_layouts=stereo,volume={_SFX_DUCKED_VOLUME}[sfx];'
            '[nar][sfx]amix=inputs=2:duration=longest:normalize=0[aout]'
        )
        return inputs, flt, '[aout]'
    if narration:
        inputs = ['-i', str(narration)]
        flt = f'[1:a]aresample={_SAMPLE_RATE},aformat=channel_layouts=stereo[aout]'
        return inputs, flt, '[aout]'
    if sfx:
        inputs = ['-i', str(sfx)]
        flt = f'[1:a]aresample={_SAMPLE_RATE},aformat=channel_layouts=stereo,volume={_SFX_SOLO_VOLUME}[aout]'
        return inputs, flt, '[aout]'
    # No audio at all - a generated silent stereo track, so every shot
    # still has a uniform audio stream for the concat to line up.
    inputs = ['-f', 'lavfi', '-i', f'anullsrc=channel_layout=stereo:sample_rate={_SAMPLE_RATE}']
    flt = f'[1:a]anull[aout]'
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

    shot keys: visual_path (required, a still image or a real clip),
    narration_audio_path / sfx_audio_path (optional local paths),
    duration_seconds (from the edit plan), ken_burns {enabled, pan},
    text_overlay (optional str). tmp_dir is a caller-owned scratch dir for
    the drawtext textfile."""
    visual_path = shot.get('visual_path')
    if not visual_path or not Path(visual_path).is_file():
        raise MovieRenderError(f'shot has no readable visual: {visual_path!r}')

    seconds = _effective_seconds(shot)
    total_frames = max(int(round(seconds * _FPS)), 1)

    overlay_file = None
    overlay_text = (shot.get('text_overlay') or '').strip()
    if overlay_text:
        fd, overlay_file = tempfile.mkstemp(suffix='.txt', dir=str(tmp_dir))
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(overlay_text)

    still = _is_still(visual_path)
    if still:
        video_input = ['-loop', '1', '-i', str(visual_path)]
        video_filter = _video_filter_for_still(shot, total_frames, overlay_file)
    else:
        # -stream_loop -1 loops a clip shorter than the shot (capped by -t);
        # a longer clip is simply trimmed by -t. Either way the shot lasts
        # exactly `seconds`.
        video_input = ['-stream_loop', '-1', '-i', str(visual_path)]
        video_filter = _video_filter_for_clip(overlay_file)

    audio_inputs, audio_filter, audio_label = _audio_inputs_and_filter(shot, seconds)

    filter_complex = f'[0:v]{video_filter}[vout];{audio_filter}'
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


def _write_status(status_path, state, step='', message=''):
    try:
        Path(status_path).write_text(json.dumps({
            'state': state, 'step': step, 'message': message,
        }))
    except OSError:
        pass  # a status write failing shouldn't itself abort a render


def render_documentary(project_id, shots, output_path, status_path):
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

        segment_paths = []
        for i, shot in enumerate(shots):
            # dip_to_black is faked as a leading black+silent segment (the
            # concat demuxer can't blend between segments) - the Premiere
            # path still gets a real dip. Not applied to the very first
            # shot (nothing to dip from).
            if i > 0 and shot.get('transition_in') == 'dip_to_black':
                black_path = work_dir / f'black_{i:03d}.mp4'
                _write_status(status_path, 'rendering', f'shot {i + 1}/{len(shots)}', 'Rendering dip to black ...')
                render_black_segment(black_path)
                segment_paths.append(black_path)

            _write_status(status_path, 'rendering', f'shot {i + 1}/{len(shots)}',
                          f'Rendering shot {i + 1} of {len(shots)} ...')
            shot_path = work_dir / f'shot_{i:03d}.mp4'
            render_shot(shot, shot_path, work_dir)
            segment_paths.append(shot_path)

        _write_status(status_path, 'rendering', 'joining', 'Joining shots into the final cut ...')
        concat_shots(segment_paths, output_path)

        _write_status(status_path, 'done', 'done', f'Rendered {len(shots)} shot(s).')
    except Exception as exc:  # noqa: BLE001 - background thread, nothing to re-raise to
        _write_status(status_path, 'error', 'error', str(exc))
