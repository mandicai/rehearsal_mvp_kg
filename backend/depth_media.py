"""Image prep + monocular-depth estimation for the 3D-reconstruction entry
point (see server.py's /reconstruct/add and its _reconstruct_worker). Given a
still (an uploaded photo, or one frame sampled from footage) this normalizes a
bounded color.png and estimates a depth.png that the in-browser three.js viewer
displaces into a 2.5D scene.

Mirrors moodboard_media.py's conventions: the depth model is a separate,
heavyweight dependency, so it is invoked as a SUBPROCESS BY NAME rather than
imported into the Flask process - overridable via DEPTH_CMD (a shell-splittable
command string). The default runs the bundled depth_cli.py with the same
interpreter, which uses transformers' Depth-Anything-V2 if it's installed.

Every operation here is deliberately TOLERANT - a missing model, a non-zero
exit, or an unreadable image returns None rather than raising, because the
worker is best-effort: without a depth map the viewer simply degrades to a
flat textured plane (viewer_mode='flat'), and a panorama skips depth entirely.
"""
import os
import shlex
import subprocess
import sys
from pathlib import Path

from PIL import Image

# A shell-splittable command that takes `-i <image> -o <depth_png>` and writes a
# single-channel (near=bright) depth PNG. Defaults to the bundled CLI run with
# this interpreter; override to point at a dedicated env, e.g.
#   DEPTH_CMD="/path/to/venv/bin/python /path/to/depth_cli.py"
_DEFAULT_DEPTH_CMD = f'{shlex.quote(sys.executable)} {shlex.quote(str(Path(__file__).with_name("depth_cli.py")))}'
DEPTH_CMD = os.environ.get('DEPTH_CMD', _DEFAULT_DEPTH_CMD)

# Depth inference (and its first-run model download) can be slow on CPU/MPS.
_DEPTH_TIMEOUT = int(os.environ.get('DEPTH_TIMEOUT', '600'))

# Bound the texture the viewer downloads/uploads to the GPU. Panoramas keep more
# width (they wrap the whole sphere); flat stills need less.
_PANO_MAX_WIDTH = 4096
_FLAT_MAX_WIDTH = 1600

# An equirectangular panorama is ~2:1 and wide; anything outside this band is
# treated as a flat photo. A heuristic - the UI offers an explicit override.
_PANO_MIN_ASPECT = 1.9
_PANO_MAX_ASPECT = 2.2
_PANO_MIN_WIDTH = 2048


def detect_input_kind(image_path):
    """'panorama' for a wide ~2:1 equirectangular still, else 'flat'. Returns
    'flat' if the image can't be read (the safe default - a flat plane)."""
    try:
        with Image.open(image_path) as im:
            w, h = im.size
    except Exception:
        return 'flat'
    if h <= 0:
        return 'flat'
    aspect = w / h
    if _PANO_MIN_ASPECT <= aspect <= _PANO_MAX_ASPECT and w >= _PANO_MIN_WIDTH:
        return 'panorama'
    return 'flat'


def prepare_color(image_path, out_dir, is_panorama=False):
    """Normalize the source still into out_dir/color.png (RGB, bounded width)
    for use as the viewer's color texture. Best-effort: on any failure copies
    the original bytes to color.png so the viewer still has something to show.
    Returns the color.png Path (always), plus its (width, height)."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / 'color.png'
    max_width = _PANO_MAX_WIDTH if is_panorama else _FLAT_MAX_WIDTH
    try:
        with Image.open(image_path) as im:
            im = im.convert('RGB')
            if im.width > max_width:
                new_h = max(1, round(im.height * max_width / im.width))
                im = im.resize((max_width, new_h), Image.LANCZOS)
            im.save(out_path, 'PNG')
            return out_path, (im.width, im.height)
    except Exception:
        try:
            out_path.write_bytes(Path(image_path).read_bytes())
        except OSError:
            pass
        try:
            with Image.open(out_path) as im:
                return out_path, im.size
        except Exception:
            return out_path, (0, 0)


def estimate_depth(color_path, out_dir):
    """Run the depth CLI on color_path, writing out_dir/depth.png. Returns that
    Path on success, or None on ANY failure (missing/unconfigured model,
    non-zero exit, timeout, empty output) - the worker then degrades to a flat
    plane. Never raises."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    depth_path = out_dir / 'depth.png'
    try:
        cmd = shlex.split(DEPTH_CMD) + ['-i', str(color_path), '-o', str(depth_path)]
    except ValueError:
        return None
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=_DEPTH_TIMEOUT)
    except (FileNotFoundError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    if not depth_path.is_file() or depth_path.stat().st_size == 0:
        return None
    return depth_path
