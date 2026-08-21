"""Media extraction for the reference-documentary moodboard entry point
(see server.py's /moodboard/add_reference and its _analyze_moodboard_reference
worker). Given a reference - a YouTube link or an uploaded footage file - this
samples still frames and extracts a short audio track so moodboard_llm can
read the reference's visual/aural style, which the distillation step then
turns into suggested arcs/mode/techniques.

Pure subprocess orchestration, matching backend/movie_render.py's convention
(no ffmpeg-python wrapper). ffmpeg/ffprobe are invoked by name from PATH,
overridable via FFMPEG_BIN/FFPROBE_BIN; yt-dlp is likewise a binary (there is
no reliable yt_dlp python module here), invoked by name, overridable via
YTDLP_BIN.

Every operation here is deliberately TOLERANT - a failed download, a frame
that won't extract, or a missing binary returns None/[] rather than raising,
because the worker running these is best-effort and always has a degraded
fallback (an oEmbed thumbnail, or title-only reasoning). YouTube in
particular is treated as best-effort: it bot-blocks and shifts formats
release-to-release, so download_youtube never raises to its caller.
"""
import base64
import os
import subprocess
from pathlib import Path

import requests

FFMPEG_BIN = os.environ.get('FFMPEG_BIN', 'ffmpeg')
FFPROBE_BIN = os.environ.get('FFPROBE_BIN', 'ffprobe')
YTDLP_BIN = os.environ.get('YTDLP_BIN', 'yt-dlp')

# How many stills to sample per reference, evenly spaced across its duration.
# The dominant cost/latency knob for the downstream vision call - 8 small
# frames is enough to read pacing/composition/palette without a large payload.
_FRAME_COUNT = 8
_FRAME_WIDTH = 512  # keeps the base64 vision payload small
# Only the first few minutes are transcribed - bounds the gemini input_audio
# payload; the opening of a documentary is plenty to read its narration style.
_AUDIO_MAX_SECONDS = 480
_YTDLP_MAX_FILESIZE = '300M'
_YTDLP_TIMEOUT = 300
_FFMPEG_TIMEOUT = 120
_MAX_THUMBNAIL_BYTES = 20 * 1024 * 1024


def _probe_duration(path):
    """Seconds of media at path via ffprobe, or None if it can't be read -
    a local copy of movie_render.probe_duration to keep this module
    standalone (it has no other reason to import movie_render)."""
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


def download_youtube(url, dest_dir):
    """Downloads a YouTube video (capped resolution + filesize, no playlist)
    to dest_dir/source.<ext> and returns that path, or None on ANY failure
    (missing binary, non-zero exit, timeout, bot-block). Never raises - the
    caller degrades to the oEmbed thumbnail fallback."""
    dest_dir = Path(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    out_tmpl = str(dest_dir / 'source.%(ext)s')
    cmd = [
        YTDLP_BIN,
        # Force the player clients that still hand back working media URLs.
        # YouTube's bot tightening now 403s the default 'android vr' fallback
        # ("unable to download video data: HTTP Error 403"); the 'tv' client
        # is currently the reliable one, with web_safari/ios/default behind it.
        '--extractor-args', 'youtube:player_client=tv,web_safari,ios,default',
        '-f', 'bv*[height<=720]+ba/b[height<=720]',
        '--max-filesize', _YTDLP_MAX_FILESIZE,
        '--no-playlist', '--no-progress',
        '-o', out_tmpl, url,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=_YTDLP_TIMEOUT)
    except (FileNotFoundError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    for p in sorted(dest_dir.glob('source.*')):
        if p.is_file() and p.suffix.lower() not in ('.json', '.part', '.ytdl'):
            return p
    return None


def youtube_oembed(url):
    """{'title', 'thumbnail_url'} for a YouTube URL via the public,
    key-free oEmbed endpoint, or None on failure. Cheap enough to always
    fetch (for the title) and the fallback when a download fails."""
    try:
        resp = requests.get(
            'https://www.youtube.com/oembed',
            params={'url': url, 'format': 'json'}, timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
    except (requests.RequestException, ValueError):
        return None
    return {
        'title': (data.get('title') or '').strip(),
        'thumbnail_url': (data.get('thumbnail_url') or '').strip(),
    }


def sample_frames(video_path, out_dir, count=_FRAME_COUNT):
    """Extracts up to `count` evenly spaced JPEG frames (scaled to
    _FRAME_WIDTH) into out_dir, returning the readable ones. Tolerant: a
    frame that fails to extract is skipped, not fatal; an unreadable
    duration falls back to a single frame at t=0."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    duration = _probe_duration(video_path)
    if not duration or duration <= 0:
        timestamps = [0.0]
    else:
        timestamps = [duration * (i + 0.5) / count for i in range(count)]

    frames = []
    for i, t in enumerate(timestamps):
        out_path = out_dir / f'frame_{i}.jpg'
        cmd = [
            FFMPEG_BIN, '-y', '-ss', f'{t:.3f}', '-i', str(video_path),
            '-frames:v', '1', '-vf', f'scale={_FRAME_WIDTH}:-2', str(out_path),
        ]
        try:
            result = subprocess.run(cmd, capture_output=True, timeout=_FFMPEG_TIMEOUT)
        except (FileNotFoundError, subprocess.SubprocessError):
            continue
        if result.returncode == 0 and out_path.is_file() and out_path.stat().st_size > 0:
            frames.append(out_path)
    return frames


def extract_first_frame(video_path, out_path):
    """Extract the video's opening frame as a JPEG thumbnail.

    Unlike sample_frames(), which deliberately samples midpoints for visual
    analysis, this is the immediate poster the presenter sees after uploading
    scene footage. Returns the path on success and None on any ffmpeg failure.
    """
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        FFMPEG_BIN, '-y', '-ss', '0', '-i', str(video_path),
        '-frames:v', '1', '-vf', f'scale={_FRAME_WIDTH}:-2', str(out_path),
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=_FFMPEG_TIMEOUT)
    except (FileNotFoundError, subprocess.SubprocessError):
        return None
    if result.returncode == 0 and out_path.is_file() and out_path.stat().st_size > 0:
        return out_path
    return None


def extract_audio(video_path, out_dir):
    """Extracts the first _AUDIO_MAX_SECONDS of audio as mono 64 kbps mp3 to
    out_dir/audio.mp3, returning the path or None on failure (e.g. a silent
    reference with no audio stream)."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / 'audio.mp3'
    cmd = [
        FFMPEG_BIN, '-y', '-i', str(video_path), '-t', str(_AUDIO_MAX_SECONDS),
        '-ac', '1', '-b:a', '64k', '-vn', str(out_path),
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=_FFMPEG_TIMEOUT)
    except (FileNotFoundError, subprocess.SubprocessError):
        return None
    if result.returncode == 0 and out_path.is_file() and out_path.stat().st_size > 0:
        return out_path
    return None


def download_thumbnail(url, dest_path):
    """Streams a remote thumbnail (oEmbed fallback) to dest_path, size-capped,
    returning the path or None on failure. Cleans up a partial file."""
    dest_path = Path(dest_path)
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with requests.get(url, stream=True, timeout=30) as response:
            response.raise_for_status()
            written = 0
            with open(dest_path, 'wb') as f:
                for chunk in response.iter_content(chunk_size=256 * 1024):
                    written += len(chunk)
                    if written > _MAX_THUMBNAIL_BYTES:
                        raise ValueError('thumbnail exceeded size cap')
                    f.write(chunk)
    except (requests.RequestException, ValueError, OSError):
        if dest_path.exists():
            try:
                dest_path.unlink()
            except OSError:
                pass
        return None
    return dest_path


def frames_to_data_urls(frame_paths):
    """Base64 data URLs for the given JPEG frames, for the vision call's
    image_url content blocks (same shape feedback_llm.get_feedback uses).
    Skips any frame that can't be read."""
    urls = []
    for p in frame_paths:
        try:
            data = Path(p).read_bytes()
        except OSError:
            continue
        urls.append('data:image/jpeg;base64,' + base64.b64encode(data).decode('ascii'))
    return urls
