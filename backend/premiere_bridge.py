"""On-disk bridge to a Premiere Pro UXP plugin (see premiere-plugin/ and
server.py's /premiere/* routes). premiere_exports/<project_id>/ holds an
uploaded footage/ folder and an edit_plan.json; once the plugin has run, the
same folder gets a rough_cut.mp4 back (see server.py's static route for it).

Deliberately file-based in both directions, not a network call - a UXP
plugin *can* fetch a local server, but macOS specifically restricts plain
http:// for that (verified against Adobe's UXP network docs), which is
exactly what this app's Flask backend uses. Local file access has no such
restriction, so the bridge is: this backend writes into the folder, the
plugin reads from it and later writes its export back into the same folder.

Follows the same "scan existing directories for the next sequential id"
convention as backend/ingest/storage.py's rehearsal-run projects, kept as
its own directory/id-space since a documentary export isn't a rehearsal run.
"""
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import requests

PREMIERE_EXPORTS_DIR = Path(__file__).resolve().parent.parent / 'premiere_exports'

# Extensions ffmpeg's mp4 muxer understands - -movflags +faststart (moves
# the moov atom to the front, for progressive-download playback) is only
# valid for that muxer; passing it for e.g. a webm output would be a
# no-op at best, so it's only added for these.
_FASTSTART_EXTENSIONS = {'.mp4', '.mov', '.m4a', '.m4v'}


def remux_for_reliable_playback(path):
    """Re-multiplexes (not re-encodes) a just-saved recording in place via
    ffmpeg, if it's installed - a no-op otherwise, since the raw upload is
    still perfectly servable either way, just without this reliability fix.

    MediaRecorder-produced clips (Safari's video/mp4 output in particular)
    are often a fragmented container with no upfront duration/seek
    metadata - <video>/<audio> playback via a plain src (see
    js/paper-extract.js's buildVisualBox/renderMediaBankItems) needs a
    browser's *native* media pipeline to parse that metadata up front, and
    Safari in particular can simply refuse to play such a file even though
    it's otherwise perfectly valid - controls appear, but pressing play
    does nothing. (This is a different, further issue than a wrong
    extension/Content-Type - see runTranscribeIntent's own mimeType
    comment for that one; this affects even a correctly-labeled file.)

    A `-c copy` remux rewrites the container's metadata without touching
    the actual encoded audio/video frames at all - same quality, same
    bytes for the payload, just a cleaned-up wrapper - so it's both safe
    and (since there's no re-encoding) fast even for several minutes of
    footage. Runs synchronously; callers are expected to be short
    recordings, not long-form video."""
    if shutil.which('ffmpeg') is None:
        return

    fd, tmp_path = tempfile.mkstemp(suffix=path.suffix, dir=path.parent)
    os.close(fd)
    try:
        cmd = ['ffmpeg', '-y', '-i', str(path), '-c', 'copy']
        if path.suffix.lower() in _FASTSTART_EXTENSIONS:
            cmd += ['-movflags', '+faststart']
        cmd.append(tmp_path)
        result = subprocess.run(cmd, capture_output=True, timeout=30)
        if result.returncode == 0 and os.path.getsize(tmp_path) > 0:
            os.replace(tmp_path, path)
    except (subprocess.SubprocessError, OSError):
        pass  # the raw upload is already saved - not worth failing the request over
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

_PROJECT_ID_RE = re.compile(r'^documentary-(\d+)$')


def next_premiere_project_id():
    existing = [
        int(m.group(1))
        for p in (PREMIERE_EXPORTS_DIR.iterdir() if PREMIERE_EXPORTS_DIR.exists() else [])
        if (m := _PROJECT_ID_RE.match(p.name))
    ]
    return f'documentary-{max(existing, default=0) + 1}'


def premiere_project_dir(project_id):
    return PREMIERE_EXPORTS_DIR / project_id


def premiere_footage_dir(project_id):
    return premiere_project_dir(project_id) / 'footage'


def premiere_sketch_dir(project_id):
    """AI-generated storyboard reference images (see sketch_llm.py's
    generate_sketch and server.py's /paper/generate_sketch) - a sibling of
    footage/, not stock/final media Premiere itself needs."""
    return premiere_project_dir(project_id) / 'sketches'


def premiere_animated_sketch_dir(project_id):
    """AI-generated animated storyboard previews (see animate_llm.py's
    generate_animated_sketch and server.py's /paper/generate_animated_sketch) -
    a sibling of sketches/, one clip per section+technique combination
    rather than one file per section, since switching techniques should
    never require overwriting/cache-busting a previous clip."""
    return premiere_project_dir(project_id) / 'animated_sketches'


def premiere_narration_dir(project_id):
    """The presenter's own recorded documentary-intent narration (see
    server.py's /premiere/upload_narration and js/paper-extract.js's
    Record Your Intent flow) - one recording per project, not per shot, so
    unlike footage/sketches this holds at most a single file."""
    return premiere_project_dir(project_id) / 'narration'


def premiere_media_bank_dir(project_id):
    """Supplementary audio/video clips recorded or uploaded on
    storyboard.html's "Your Media Bank" module (see server.py's
    /premiere/upload_media_bank_item and js/paper-extract.js's Record
    Audio/Record Video/Upload File wiring) - an open-ended reference
    collection, not tied to any specific shot the way footage/ is, and not
    limited to one file the way narration/ is."""
    return premiere_project_dir(project_id) / 'media_bank'


def premiere_moodboard_dir(project_id):
    """Reference documentaries the presenter added on the moodboard entry
    point (see server.py's /moodboard/add_reference and its
    _analyze_moodboard_reference worker). Holds one subdirectory per
    reference (see premiere_moodboard_ref_dir) with that reference's sampled
    frames, extracted audio, downloaded source/thumbnail, and the status.json
    / profile.json the worker writes - an analysis workspace, not final media
    Premiere or the render needs."""
    return premiere_project_dir(project_id) / 'moodboard'


def premiere_moodboard_ref_dir(project_id, ref_id):
    """One moodboard reference's own workspace under premiere_moodboard_dir."""
    return premiere_moodboard_dir(project_id) / ref_id


def premiere_reconstruct_dir(project_id, recon_id):
    """One 3D-reconstruction job's workspace (see server.py's /reconstruct/add
    and its _reconstruct_worker). Holds the uploaded source, the prepared
    color.png / depth.png (or a sampled footage frame), and the status.json /
    profile.json the worker writes - an analysis workspace for the in-browser
    3D viewer, not media the render/Premiere export consumes. One subdirectory
    per job, mirroring premiere_moodboard_ref_dir's shape."""
    return premiere_project_dir(project_id) / 'reconstruct' / recon_id


def premiere_eval_dir(project_id, run_id):
    """One evaluation run's workspace (see server.py's /eval/run and its
    _eval_worker). Holds one cell_*.png / cell_*.mp4 per technique×mode×track
    combination plus the status.json / manifest.json the worker writes - the
    matrix that evaluation.html renders. Mirrors premiere_reconstruct_dir."""
    return premiere_project_dir(project_id) / 'eval' / run_id


def premiere_stock_media_dir(project_id):
    """Stock-media picks (Pexels/Internet Archive/Library of Congress
    video, Freesound audio - see server.py's /premiere/download_stock_media
    and js/paper-extract.js's buildMediaVideoOption/buildMediaAudioOption)
    downloaded to a real local file the moment they're picked, rather than
    left as a bare remote URL - a URL alone isn't usable by either export
    path (the Premiere plugin or the ffmpeg render). A sibling of footage/,
    not the same directory, since these came from a search result, not the
    presenter's own upload."""
    return premiere_project_dir(project_id) / 'stock_media'


# Third-party URLs (Pexels/Internet Archive/Library of Congress/Freesound),
# not pre-validated - a hard cap keeps one oversized/misbehaving response
# from filling the disk, same spirit as MAX_FOOTAGE_SIZE_MB in server.py
# for a direct upload.
_MAX_STOCK_MEDIA_DOWNLOAD_BYTES = 200 * 1024 * 1024


def download_stock_media_to_disk(url, dest_path):
    """Streams a stock-media pick's URL to dest_path - see
    premiere_stock_media_dir's own comment on why this needs to happen at
    all. Raises requests.RequestException/ValueError on failure (bad URL,
    non-2xx, oversized response) - callers are expected to surface that as
    a clean error to the presenter (a dead search result is disappointing,
    not fatal), not retry silently."""
    with requests.get(url, stream=True, timeout=30) as response:
        response.raise_for_status()
        written = 0
        with open(dest_path, 'wb') as f:
            for chunk in response.iter_content(chunk_size=256 * 1024):
                written += len(chunk)
                if written > _MAX_STOCK_MEDIA_DOWNLOAD_BYTES:
                    raise ValueError(f'download exceeded {_MAX_STOCK_MEDIA_DOWNLOAD_BYTES} bytes')
                f.write(chunk)


def resolve_static_preview_path(preview_url):
    """Inverts the `'/' + saved_path.relative_to(PREMIERE_EXPORTS_DIR.parent).as_posix()`
    convention every upload route (and download_stock_media_to_disk's own
    caller) uses to build a preview_url in the first place - given a
    client-supplied preview_url (e.g. section.narrationAudioPreviewUrl,
    round-tripping through a /render/start or /premiere/export payload),
    returns the real absolute Path it points to, or None if it doesn't
    resolve to somewhere genuinely under premiere_exports/. A client can
    send any string here, so this rejects anything that escapes that tree
    (e.g. a `../` traversal) rather than blindly joining it - not just a
    convenience lookup, a trust boundary."""
    if not preview_url or not isinstance(preview_url, str):
        return None
    candidate = (PREMIERE_EXPORTS_DIR.parent / preview_url.lstrip('/')).resolve()
    try:
        candidate.relative_to(PREMIERE_EXPORTS_DIR.resolve())
    except ValueError:
        return None
    return candidate if candidate.is_file() else None
