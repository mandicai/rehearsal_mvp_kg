#!/usr/bin/env python3
"""Compare SHOT PACING across the downloaded YouTube documentary timelines.

The sibling `youtube_narration_timeline_cli.py` downloads each video and lays
its narration next to the frame on screen at each caption's midpoint - useful
for reading narration-to-footage alignment, but it samples by CAPTION, not by
CUT, so it says nothing about how long each SHOT is held.

This tool answers the pacing question directly: for every already-downloaded
video dir (source.webm + captions.en.vtt, produced by the sibling CLI), it

  1. detects real shot cuts with ffmpeg scene detection,
  2. turns them into shots with measured durations,
  3. pulls one thumbnail per shot and the narration spoken over it, and
  4. renders ONE self-contained HTML that stacks every video on a shared
     seconds-per-pixel scale, so a glance compares shot lengths across films -
     which cut fast, which hold long, and what footage/narration each shot
     carries.

Reuses the sibling CLI's VTT parser + frame helpers and moodboard_media's
ffmpeg/ffprobe binaries. Run by hand, like the sibling:

    python backend/youtube_timeline_compare_cli.py
    python backend/youtube_timeline_compare_cli.py --dir youtube_narration_timelines --threshold 0.3
"""
import argparse
import re
import statistics
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from moodboard_media import FFMPEG_BIN, FFPROBE_BIN  # noqa: E402
from youtube_narration_timeline_cli import (  # noqa: E402
    parse_vtt, _frame_data_url, _format_timestamp, youtube_oembed,
)
import base64  # noqa: E402
import html  # noqa: E402

_DEFAULT_TIMELINES_DIR = Path(__file__).resolve().parent.parent / 'youtube_narration_timelines'
_THUMB_WIDTH = 168
_SCENE_TIMEOUT = 600
_PROBE_TIMEOUT = 30
# Below this, two detected cuts are one shot boundary jittering, not two shots.
_MIN_SHOT_SECONDS = 0.4


def _log(msg):
    print(f'[timeline_compare] {msg}', file=sys.stderr)


def video_duration(video_path):
    """Total duration in seconds via ffprobe, or None."""
    cmd = [FFPROBE_BIN, '-v', 'error', '-show_entries', 'format=duration',
           '-of', 'default=noprint_wrappers=1:nokey=1', str(video_path)]
    try:
        out = subprocess.run(cmd, capture_output=True, timeout=_PROBE_TIMEOUT)
        return float(out.stdout.decode().strip())
    except (subprocess.SubprocessError, ValueError, OSError):
        return None


def detect_cut_times(video_path, threshold):
    """Timestamps (seconds) where ffmpeg's scene score exceeds `threshold`.

    Uses the scene-detection select filter + showinfo, parsing the pts_time of
    each frame the filter passes (a scene change). A boundary at 0 is added by
    the caller; this returns only the detected interior cuts, de-jittered."""
    cmd = [
        FFMPEG_BIN, '-i', str(video_path),
        '-filter:v', f"select='gt(scene,{threshold})',showinfo",
        '-an', '-f', 'null', '-',
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=_SCENE_TIMEOUT)
    except (subprocess.SubprocessError, OSError) as exc:
        _log(f'  scene detection failed: {exc}')
        return []
    stderr = result.stderr.decode(errors='replace')
    times = sorted(float(m) for m in re.findall(r'pts_time:([0-9.]+)', stderr))
    deduped = []
    for t in times:
        if not deduped or t - deduped[-1] >= _MIN_SHOT_SECONDS:
            deduped.append(t)
    return deduped


def build_shots(video_path, threshold):
    """List of {'start','end','dur'} shots from detected cuts + total duration."""
    duration = video_duration(video_path)
    if not duration or duration <= 0:
        return [], 0.0
    cuts = [t for t in detect_cut_times(video_path, threshold) if 0 < t < duration]
    boundaries = [0.0, *cuts, duration]
    shots = []
    for i in range(len(boundaries) - 1):
        start, end = boundaries[i], boundaries[i + 1]
        if end - start >= _MIN_SHOT_SECONDS:
            shots.append({'start': start, 'end': end, 'dur': end - start})
    return shots, duration


def extract_thumb_data_url(video_path, seconds):
    """Small JPEG at `seconds`, inlined as a base64 data URL, or None."""
    cmd = [
        FFMPEG_BIN, '-y', '-ss', f'{max(0.0, seconds):.3f}', '-i', str(video_path),
        '-frames:v', '1', '-vf', f'scale={_THUMB_WIDTH}:-2', '-f', 'image2', 'pipe:1',
    ]
    try:
        out = subprocess.run(cmd, capture_output=True, timeout=60)
    except (subprocess.SubprocessError, OSError):
        return None
    if out.returncode != 0 or not out.stdout:
        return None
    return 'data:image/jpeg;base64,' + base64.b64encode(out.stdout).decode('ascii')


def narration_over(cues, start, end):
    """Caption text spoken during a shot's [start, end) span, joined."""
    parts = [c['text'] for c in cues
             if c['start'] < end and c['end'] > start and c['text']]
    return ' '.join(parts).strip()


def analyze_video(video_dir, threshold):
    """One video's pacing profile, or None if it has no source video."""
    source = next((video_dir / name for name in ('source.webm', 'source.mp4')
                   if (video_dir / name).is_file()), None)
    if not source:
        return None
    _log(f'{video_dir.name}: detecting shots...')
    shots, duration = build_shots(source, threshold)
    if not shots:
        return None
    vtt = video_dir / 'captions.en.vtt'
    cues = parse_vtt(vtt) if vtt.is_file() else []
    for shot in shots:
        shot['thumb'] = extract_thumb_data_url(source, shot['start'] + shot['dur'] / 2)
        shot['narration'] = narration_over(cues, shot['start'], shot['end'])
    durs = [s['dur'] for s in shots]
    title = ''
    try:
        title = (youtube_oembed(f'https://www.youtube.com/watch?v={video_dir.name}') or {}).get('title', '')
    except Exception:
        title = ''
    return {
        'id': video_dir.name,
        'title': title or video_dir.name,
        'duration': duration,
        'shots': shots,
        'shot_count': len(shots),
        'mean_shot': statistics.mean(durs),
        'median_shot': statistics.median(durs),
        'cuts_per_min': (len(shots) - 1) / (duration / 60) if duration else 0,
    }


def render_comparison(videos, out_path, px_per_second):
    """One self-contained HTML: every video a row of duration-scaled shot
    blocks on a shared time axis, with per-video pacing stats."""
    max_duration = max((v['duration'] for v in videos), default=0)
    axis_ticks = ''.join(
        f'<span class="tick" style="left:{sec * px_per_second}px">{_format_timestamp(sec)}</span>'
        for sec in range(0, int(max_duration) + 30, 30))
    rows = []
    for v in sorted(videos, key=lambda x: x['mean_shot']):
        blocks = []
        for shot in v['shots']:
            width = max(2, shot['dur'] * px_per_second)
            img = (f'<img loading="lazy" src="{shot["thumb"]}" alt="">'
                   if shot['thumb'] else '')
            tip = html.escape(f'{shot["dur"]:.1f}s · {_format_timestamp(shot["start"])}'
                              + (f' · {shot["narration"]}' if shot['narration'] else ''))
            dur_label = f'<span class="dur">{shot["dur"]:.1f}s</span>' if width >= 34 else ''
            blocks.append(
                f'<div class="shot" style="width:{width:.1f}px" title="{tip}">{img}{dur_label}</div>')
        rows.append(f'''
    <div class="vrow">
      <div class="meta">
        <div class="vtitle">{html.escape(v['title'])}</div>
        <div class="stats">{v['shot_count']} shots · avg {v['mean_shot']:.1f}s · median {v['median_shot']:.1f}s · {v['cuts_per_min']:.1f} cuts/min · {_format_timestamp(v['duration'])} total</div>
      </div>
      <div class="track" style="width:{v['duration'] * px_per_second:.0f}px">{''.join(blocks)}</div>
    </div>''')

    doc = f'''<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Shot pacing comparison</title>
<style>
  body {{ margin: 0; padding: 20px; background: #14161a; color: #e8eaed;
         font: 13px/1.4 -apple-system, Segoe UI, Roboto, sans-serif; }}
  h1 {{ font-size: 18px; margin: 0 0 4px; }}
  .sub {{ color: #9aa0a6; margin: 0 0 18px; }}
  .legend {{ color: #9aa0a6; margin: 0 0 18px; font-size: 12px; }}
  .axis {{ position: relative; height: 16px; margin-left: 280px; color: #6b7176; font-size: 11px; }}
  .tick {{ position: absolute; border-left: 1px solid #2c3036; padding-left: 3px; }}
  .vrow {{ display: flex; align-items: stretch; margin-bottom: 10px; }}
  .meta {{ width: 280px; flex: 0 0 280px; padding-right: 12px; box-sizing: border-box; }}
  .vtitle {{ font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }}
  .stats {{ color: #9aa0a6; font-size: 11px; margin-top: 2px; }}
  .track {{ display: flex; height: 56px; background: #0e1013; border-radius: 3px; overflow: hidden; }}
  .shot {{ position: relative; flex: 0 0 auto; border-right: 1px solid #14161a;
           background: #23272e; overflow: hidden; }}
  .shot img {{ width: 100%; height: 100%; object-fit: cover; display: block; opacity: .82; }}
  .shot .dur {{ position: absolute; left: 2px; bottom: 1px; font-size: 9px;
               background: rgba(0,0,0,.6); padding: 0 2px; border-radius: 2px; }}
  .wrap {{ overflow-x: auto; }}
</style></head>
<body>
  <h1>Shot pacing comparison</h1>
  <p class="sub">{len(videos)} videos · each block is one detected shot, width &prop; its on-screen duration · shared scale ({px_per_second}px/s) · sorted by average shot length (fastest-cutting at bottom)</p>
  <p class="legend">Hover a shot for its exact duration, timecode, and the narration spoken over it.</p>
  <div class="wrap">
    <div class="axis">{axis_ticks}</div>
    {''.join(rows)}
  </div>
</body></html>'''
    Path(out_path).write_text(doc, encoding='utf-8')


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--dir', default=str(_DEFAULT_TIMELINES_DIR),
                    help='timelines directory (default: youtube_narration_timelines/)')
    ap.add_argument('--threshold', type=float, default=0.3,
                    help='ffmpeg scene-cut sensitivity 0-1 (lower = more cuts; default 0.3)')
    ap.add_argument('--px-per-second', type=float, default=6.0,
                    help='horizontal scale of the shared time axis (default 6)')
    ap.add_argument('--out', default=None,
                    help='output HTML (default: <dir>/shot_pacing_comparison.html)')
    args = ap.parse_args()

    base = Path(args.dir)
    if not base.is_dir():
        _log(f'no such directory: {base}')
        return 1
    out_path = Path(args.out) if args.out else base / 'shot_pacing_comparison.html'

    videos = []
    for child in sorted(base.iterdir()):
        if not child.is_dir():
            continue
        profile = analyze_video(child, args.threshold)
        if profile:
            _log(f'  {child.name}: {profile["shot_count"]} shots, avg {profile["mean_shot"]:.1f}s')
            videos.append(profile)
        else:
            _log(f'  {child.name}: skipped (no source video / no shots)')
    if not videos:
        _log('no analyzable videos found')
        return 1
    render_comparison(videos, out_path, args.px_per_second)
    _log(f'wrote {out_path} ({len(videos)} videos)')
    print(str(out_path))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
