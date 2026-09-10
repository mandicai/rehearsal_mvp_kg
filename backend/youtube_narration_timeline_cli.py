#!/usr/bin/env python3
"""Standalone research CLI: for a batch of YouTube documentary/explainer
videos, build a birds-eye-view HTML timeline of narration text next to the
video frame on screen at that moment - useful for studying how narration
timing aligns with footage (see backend/shot_plan_llm.py and the moodboard
footage-placement features this app already has).

Not wired into server.py/Flask - run by hand, like backend/depth_cli.py.

Pipeline per video:
  1. Download the video with yt-dlp (reuses moodboard_media.download_youtube).
  2. Get a timestamped transcript, preferring YouTube's own captions (free,
     already segmented) over Whisper:
       - yt-dlp --write-subs --write-auto-subs (manual captions preferred,
         auto-captions as yt-dlp's own fallback), parsed by hand (no new
         subtitle-parsing dependency - VTT's cue format is simple).
       - If a video has no captions at all, fall back to Whisper via
         backend/ingest/transcription.py's TranscriptionClient.
  3. Extract one frame via ffmpeg at each transcript segment's midpoint.
  4. Render a single self-contained HTML report per video (frames embedded
     as base64 data URLs, same idiom as moodboard_media.frames_to_data_urls),
     plus a shared index.html linking every processed video.

Usage:
    python backend/youtube_narration_timeline_cli.py URL1 URL2 ... [--out-dir DIR]
    python backend/youtube_narration_timeline_cli.py --urls-file urls.txt

YouTube is treated as best-effort (bot-blocks, missing captions, transient
failures): a video that fails is skipped with a warning, not fatal to the
batch.
"""
import argparse
import base64
import html
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from moodboard_media import (  # noqa: E402
    FFMPEG_BIN, FFPROBE_BIN, YTDLP_BIN, download_youtube, youtube_oembed,
)

_FRAME_WIDTH = 480
_YTDLP_SUB_TIMEOUT = 60
_FFMPEG_FRAME_TIMEOUT = 60
_SENTENCE_END_RE = re.compile(r'[.!?]$')
_VTT_TIMESTAMP_RE = re.compile(
    r'(\d{2}:)?(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}:)?(\d{2}):(\d{2})\.(\d{3})'
)
_INLINE_WORD_TS_RE = re.compile(r'<(\d{2}:)?(\d{2}):(\d{2})\.(\d{3})>')
_TAG_RE = re.compile(r'</?c[^>]*>')


def _log(msg):
    print(f'[youtube_narration_timeline] {msg}', file=sys.stderr)


def _vtt_timestamp_to_seconds(match_groups):
    hours, minutes, seconds, millis = match_groups
    hours = int(hours[:-1]) if hours else 0
    return hours * 3600 + int(minutes) * 60 + int(seconds) + int(millis) / 1000.0


def fetch_captions_vtt(url, dest_dir):
    """Downloads the best available English captions (manual preferred, else
    auto) as a VTT file via yt-dlp, returning its path or None if the video
    has no captions / the fetch fails. Never raises."""
    dest_dir = Path(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    out_tmpl = str(dest_dir / 'captions.%(ext)s')
    cmd = [
        YTDLP_BIN,
        '--extractor-args', 'youtube:player_client=tv,web_safari,ios,default',
        '--write-subs', '--write-auto-subs', '--sub-lang', 'en',
        '--sub-format', 'vtt', '--skip-download', '--no-playlist', '--no-progress',
        '-o', out_tmpl, url,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=_YTDLP_SUB_TIMEOUT)
    except (FileNotFoundError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    matches = sorted(dest_dir.glob('captions*.vtt'))
    return matches[0] if matches else None


def parse_vtt(vtt_path):
    """Returns a list of {'start', 'end', 'text'} cues from a WebVTT file,
    with rolling-caption duplication cleaned up. YouTube auto-captions often
    render as scrolling text: each cue repeats words from the previous cue
    (optionally with inline <HH:MM:SS.mmm> per-word timestamps) until the
    line is complete. We keep only the final, complete form of each line."""
    try:
        raw = Path(vtt_path).read_text(encoding='utf-8', errors='replace')
    except OSError:
        return []

    blocks = re.split(r'\n\s*\n', raw)
    cues = []
    for block in blocks:
        lines = [l for l in block.splitlines() if l.strip()]
        header_idx = None
        for i, line in enumerate(lines):
            if '-->' in line:
                header_idx = i
                break
        if header_idx is None:
            continue
        m = _VTT_TIMESTAMP_RE.search(lines[header_idx])
        if not m:
            continue
        start = _vtt_timestamp_to_seconds(m.groups()[0:4])
        end = _vtt_timestamp_to_seconds(m.groups()[4:8])
        text_lines = lines[header_idx + 1:]
        if not text_lines:
            continue
        # Strip inline word-timestamp tags and styling tags (<c>, </c>) -
        # cue-level start/end is precise enough for a birds-eye timeline.
        text = ' '.join(text_lines)
        text = _INLINE_WORD_TS_RE.sub('', text)
        text = _TAG_RE.sub('', text)
        text = html.unescape(text).strip()
        text = re.sub(r'\s+', ' ', text)
        if text:
            cues.append({'start': start, 'end': end, 'text': text})

    # Rolling-caption dedup: drop a cue if its text is a prefix of the next
    # cue's text (i.e. it's a partial, still-growing version of the same line).
    deduped = []
    for i, cue in enumerate(cues):
        next_text = cues[i + 1]['text'] if i + 1 < len(cues) else None
        if next_text and next_text.startswith(cue['text']) and next_text != cue['text']:
            continue
        deduped.append(cue)
    # A second pass: consecutive identical/overlapping text (common once the
    # prefix check above leaves same-text neighbors) collapses into one cue
    # spanning both timestamps.
    merged = []
    for cue in deduped:
        if merged and merged[-1]['text'] == cue['text']:
            merged[-1]['end'] = cue['end']
        else:
            merged.append(dict(cue))
    return merged


_MAX_SEGMENT_SECONDS = 20.0  # older/rougher auto-captions often carry no
# punctuation at all, so sentence-boundary grouping alone would collapse an
# entire unpunctuated video into a single segment - cap segment length so the
# timeline stays at a birds-eye granularity even then.


def group_into_segments(cues):
    """Groups caption cues into sentence-level segments (split on a trailing
    .!?, or once a segment would exceed _MAX_SEGMENT_SECONDS), matching a
    birds-eye view granularity rather than one row per (often sub-second)
    caption cue."""
    if not cues:
        return []
    segments = []
    current = []
    for cue in cues:
        current.append(cue)
        too_long = cue['end'] - current[0]['start'] >= _MAX_SEGMENT_SECONDS
        if _SENTENCE_END_RE.search(cue['text']) or too_long or cue is cues[-1]:
            segments.append({
                'start': current[0]['start'],
                'end': current[-1]['end'],
                'text': ' '.join(c['text'] for c in current),
            })
            current = []
    return segments


def transcribe_with_whisper(video_path, work_dir):
    """Fallback transcript source for videos with no captions at all: full-
    length audio extraction (no time cap, unlike moodboard_media.extract_audio
    which only reads the opening minutes) + Whisper via the ingest package's
    existing client. Returns segments in the same shape as group_into_segments,
    or [] if transcription isn't available/fails."""
    from ingest.transcription import TranscriptionClient

    client = TranscriptionClient()
    if not client.is_configured():
        _log('no captions available and OPENAI_API_KEY is not set - skipping transcript')
        return []

    audio_path = Path(work_dir) / 'audio_full.mp3'
    cmd = [FFMPEG_BIN, '-y', '-i', str(video_path), '-ac', '1', '-b:a', '64k',
           '-vn', str(audio_path)]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=300)
    except (FileNotFoundError, subprocess.SubprocessError):
        return []
    if result.returncode != 0 or not audio_path.is_file():
        return []

    try:
        response = client.transcribe(audio_path.read_bytes(), audio_path.name)
    except Exception as exc:
        _log(f'Whisper transcription failed: {exc}')
        return []

    words = response.get('words') or []
    if words:
        cues = [{'start': w['start'], 'end': w['end'], 'text': w['word']} for w in words]
        return group_into_segments(cues)
    segments = response.get('segments') or []
    return [{'start': s['start'], 'end': s['end'], 'text': s['text'].strip()} for s in segments]


def extract_frame_at(video_path, seconds, out_path):
    """Single JPEG frame at the given timestamp, or None on any ffmpeg failure."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        FFMPEG_BIN, '-y', '-ss', f'{max(0.0, seconds):.3f}', '-i', str(video_path),
        '-frames:v', '1', '-vf', f'scale={_FRAME_WIDTH}:-2', str(out_path),
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=_FFMPEG_FRAME_TIMEOUT)
    except (FileNotFoundError, subprocess.SubprocessError):
        return None
    if result.returncode == 0 and out_path.is_file() and out_path.stat().st_size > 0:
        return out_path
    return None


def _frame_data_url(path):
    try:
        data = Path(path).read_bytes()
    except OSError:
        return None
    return 'data:image/jpeg;base64,' + base64.b64encode(data).decode('ascii')


def _format_timestamp(seconds):
    minutes = int(seconds // 60)
    secs = int(seconds % 60)
    return f'{minutes:02d}:{secs:02d}'


def render_video_report(title, url, rows, out_path):
    """rows: list of {'start', 'end', 'frame_path', 'text'}. Self-contained
    HTML (frames inlined as base64) so the report can be opened directly or
    shared without its asset folder."""
    row_html = []
    for row in rows:
        data_url = _frame_data_url(row['frame_path']) if row['frame_path'] else None
        img_html = (f'<img src="{data_url}" alt="frame">' if data_url
                    else '<div class="no-frame">no frame</div>')
        row_html.append(f'''
        <div class="row">
          <div class="time">{_format_timestamp(row['start'])}&ndash;{_format_timestamp(row['end'])}</div>
          <div class="frame">{img_html}</div>
          <div class="text">{html.escape(row['text'])}</div>
        </div>''')

    doc = f'''<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>{html.escape(title)}</title>
<style>
  body {{ font-family: -apple-system, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; background: #111; color: #eee; }}
  h1 {{ font-size: 1.1rem; font-weight: 600; }}
  a {{ color: #8ab4ff; }}
  .row {{ display: grid; grid-template-columns: 70px 200px 1fr; gap: 1rem; align-items: center; padding: 0.75rem 0; border-bottom: 1px solid #333; }}
  .time {{ font-variant-numeric: tabular-nums; color: #999; font-size: 0.85rem; }}
  .frame img {{ width: 100%; border-radius: 4px; display: block; }}
  .no-frame {{ width: 100%; aspect-ratio: 16/9; background: #222; border-radius: 4px; display: flex; align-items: center; justify-content: center; color: #666; font-size: 0.75rem; }}
  .text {{ font-size: 0.95rem; line-height: 1.4; }}
</style>
</head>
<body>
  <h1>{html.escape(title)}</h1>
  <p><a href="{html.escape(url)}">{html.escape(url)}</a> &middot; <a href="index.html">&larr; all videos</a></p>
  {''.join(row_html)}
</body>
</html>'''
    Path(out_path).write_text(doc, encoding='utf-8')


def render_index(entries, out_path):
    """entries: list of {'title', 'url', 'report_path', 'thumb_path'}."""
    items = []
    for e in entries:
        data_url = _frame_data_url(e['thumb_path']) if e.get('thumb_path') else None
        img_html = f'<img src="{data_url}">' if data_url else '<div class="no-frame"></div>'
        items.append(f'''
        <a class="card" href="{html.escape(e['report_path'])}">
          {img_html}
          <div class="title">{html.escape(e['title'])}</div>
        </a>''')

    doc = f'''<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Narration/frame timelines</title>
<style>
  body {{ font-family: -apple-system, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; background: #111; color: #eee; }}
  h1 {{ font-size: 1.2rem; }}
  .grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1rem; }}
  .card {{ color: inherit; text-decoration: none; background: #1a1a1a; border-radius: 6px; overflow: hidden; }}
  .card img {{ width: 100%; aspect-ratio: 16/9; object-fit: cover; display: block; }}
  .no-frame {{ width: 100%; aspect-ratio: 16/9; background: #222; }}
  .title {{ padding: 0.5rem 0.75rem; font-size: 0.85rem; }}
</style>
</head>
<body>
  <h1>Narration/frame timelines</h1>
  <div class="grid">{''.join(items)}</div>
</body>
</html>'''
    Path(out_path).write_text(doc, encoding='utf-8')


def process_video(url, out_dir):
    """Runs the full pipeline for one URL, writing <out_dir>/<video_id>/index.html.
    Returns an index entry dict on success, None if the video is skipped."""
    oembed = youtube_oembed(url) or {}
    title = oembed.get('title') or url

    video_id_match = re.search(r'(?:v=|youtu\.be/|shorts/)([\w-]{6,})', url)
    video_id = video_id_match.group(1) if video_id_match else re.sub(r'\W+', '_', url)[:40]
    video_dir = Path(out_dir) / video_id
    video_dir.mkdir(parents=True, exist_ok=True)

    _log(f'{video_id}: downloading video...')
    video_path = download_youtube(url, video_dir)
    if not video_path:
        _log(f'{video_id}: download failed, skipping')
        return None

    _log(f'{video_id}: fetching captions...')
    vtt_path = fetch_captions_vtt(url, video_dir)
    segments = group_into_segments(parse_vtt(vtt_path)) if vtt_path else []

    if not segments:
        _log(f'{video_id}: no captions found, falling back to Whisper transcription...')
        segments = transcribe_with_whisper(video_path, video_dir)

    if not segments:
        _log(f'{video_id}: no transcript available (no captions, no Whisper), skipping')
        return None

    _log(f'{video_id}: extracting {len(segments)} frame(s)...')
    frames_dir = video_dir / 'frames'
    rows = []
    for i, seg in enumerate(segments):
        midpoint = (seg['start'] + seg['end']) / 2
        frame_path = extract_frame_at(video_path, midpoint, frames_dir / f'frame_{i:04d}.jpg')
        rows.append({'start': seg['start'], 'end': seg['end'], 'text': seg['text'],
                     'frame_path': frame_path})

    report_path = video_dir / 'index.html'
    render_video_report(title, url, rows, report_path)
    _log(f'{video_id}: wrote {report_path}')

    thumb_path = rows[0]['frame_path'] if rows else None
    return {
        'title': title, 'url': url,
        'report_path': f'{video_id}/index.html',
        'thumb_path': thumb_path,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                      formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('urls', nargs='*', help='YouTube video URLs')
    parser.add_argument('--urls-file', help='text file with one YouTube URL per line')
    parser.add_argument('--out-dir', default='youtube_narration_timelines',
                         help='output directory (default: youtube_narration_timelines)')
    args = parser.parse_args()

    urls = list(args.urls)
    if args.urls_file:
        lines = Path(args.urls_file).read_text(encoding='utf-8').splitlines()
        urls.extend(line.strip() for line in lines if line.strip() and not line.startswith('#'))
    if not urls:
        parser.error('provide at least one URL (positionally or via --urls-file)')

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    entries = []
    for url in urls:
        entry = process_video(url, out_dir)
        if entry:
            entries.append(entry)

    if entries:
        render_index(entries, out_dir / 'index.html')
        _log(f'wrote {out_dir / "index.html"} ({len(entries)}/{len(urls)} video(s))')
    else:
        _log('no videos processed successfully')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
