"""Apple ml-sharp (SHARP) single-image -> 3D Gaussian Splat reconstruction for
the 3D-reconstruction entry point (see server.py's _reconstruct_worker,
engine='sharp'). SHARP regresses a metric 3D Gaussian representation from one
photo in a single feedforward pass; the resulting .ply is explored in-browser
with a WebGL splat renderer (js/reconstruct-viewer.js).

SHARP needs Python 3.13 + torch/gsplat and a ~5.4GB checkpoint, so - like
yt-dlp/ffmpeg and the depth CLI - it is a SEPARATE, SUBPROCESS-BY-NAME tool,
never imported into the Flask process. Point SHARP_CMD at the `sharp` console
script of its own venv, e.g.
    SHARP_CMD="/path/to/ml-sharp/.venv/bin/sharp"
The default probes backend/.sharp-venv/bin/sharp (see setup_sharp.sh). When
SHARP isn't configured/available, run_sharp_predict returns None and the worker
falls back to the monocular-depth engine.

Only `sharp predict` is ever invoked (never `--render`, which needs CUDA):
prediction runs on Apple Silicon MPS and just writes the .ply we need.
"""
import os
import shlex
import shutil
import subprocess
from pathlib import Path

import numpy as np

_DEFAULT_SHARP = Path(__file__).with_name('.sharp-venv') / 'bin' / 'sharp'
# A shell-splittable command whose subcommand `predict` we drive. Empty/missing
# disables SHARP (worker degrades to depth).
SHARP_CMD = os.environ.get('SHARP_CMD', str(_DEFAULT_SHARP) if _DEFAULT_SHARP.exists() else '')

# First run downloads the 5.4GB checkpoint; give it room. Overridable.
_SHARP_TIMEOUT = int(os.environ.get('SHARP_TIMEOUT', '1800'))


def is_available():
    if not SHARP_CMD:
        return False
    try:
        parts = shlex.split(SHARP_CMD)
    except ValueError:
        return False
    if not parts:
        return False
    exe = parts[0]
    return bool(shutil.which(exe) or Path(exe).exists())


def run_sharp_predict(image_path, out_dir):
    """Reconstruct one image into a 3D Gaussian Splat .ply via `sharp predict`.
    Returns the .ply Path on success, or None on ANY failure (SHARP not
    configured/installed, non-zero exit, timeout, no .ply produced) so the
    worker can fall back to the depth engine. Never raises.

    `sharp predict -i <dir> -o <dir>` treats -i as a DIRECTORY of images and
    writes one .ply per image, so we stage the single image in its own input
    dir to avoid pulling in siblings."""
    if not is_available():
        return None
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    input_dir = out_dir / 'sharp_in'
    gaussians_dir = out_dir / 'gaussians'
    input_dir.mkdir(parents=True, exist_ok=True)
    gaussians_dir.mkdir(parents=True, exist_ok=True)

    staged = input_dir / Path(image_path).name
    try:
        shutil.copyfile(image_path, staged)
    except OSError:
        return None

    try:
        cmd = shlex.split(SHARP_CMD) + ['predict', '-i', str(input_dir), '-o', str(gaussians_dir)]
    except ValueError:
        return None
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=_SHARP_TIMEOUT)
    except (FileNotFoundError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None

    plys = sorted(gaussians_dir.rglob('*.ply'))
    for p in plys:
        if p.is_file() and p.stat().st_size > 0:
            cleaned = _vertex_only_ply(p, out_dir / 'scene.ply')
            return cleaned or p
    return None


# Property-type -> byte size for a binary_little_endian PLY.
_PLY_TYPE_SIZES = {
    'char': 1, 'uchar': 1, 'int8': 1, 'uint8': 1,
    'short': 2, 'ushort': 2, 'int16': 2, 'uint16': 2,
    'int': 4, 'uint': 4, 'int32': 4, 'uint32': 4, 'float': 4, 'float32': 4,
    'double': 8, 'float64': 8,
}


def _vertex_only_ply(src_ply, dst_ply, max_splats=500000):
    """SHARP writes a 3DGS .ply whose `vertex` element (x/y/z, f_dc_*, opacity,
    scale_*, rot_*) is followed by extra metadata elements (extrinsic/intrinsic/
    frame/...). Many WebGL splat loaders only expect the single vertex element,
    so rewrite a clean binary_little_endian .ply containing JUST that element.

    SHARP is also dense (often >1M splats / tens of MB), which the browser splat
    viewer struggles to parse + push to the GPU (no shared-memory workers here),
    so downsample to `max_splats` by keeping the highest-opacity splats (the
    solid structure) - the result looks ~identical but loads reliably. Returns
    dst path, or None on any parse surprise (caller then serves the original)."""
    try:
        data = src_ply.read_bytes()
    except OSError:
        return None
    marker = b'end_header\n'
    hi = data.find(marker)
    if hi < 0:
        return None
    header = data[:hi].decode('ascii', 'replace')
    body = data[hi + len(marker):]

    lines = header.splitlines()
    if not lines or not lines[0].startswith('ply'):
        return None
    fmt_line = next((l for l in lines if l.startswith('format')), 'format binary_little_endian 1.0')
    if 'binary_little_endian' not in fmt_line:
        return None  # only the format SHARP actually emits is handled

    # Walk elements in declaration order; the vertex element is first, so its
    # binary block is at the start of `body`.
    elements = []  # (name, count, [property_lines], stride_bytes)
    cur = None
    for l in lines:
        parts = l.split()
        if not parts:
            continue
        if parts[0] == 'element':
            if cur:
                elements.append(cur)
            cur = {'name': parts[1], 'count': int(parts[2]), 'props': [], 'stride': 0}
        elif parts[0] == 'property' and cur is not None:
            # 'property <type> <name>' (SHARP has no list properties here)
            ptype = parts[1]
            size = _PLY_TYPE_SIZES.get(ptype)
            if size is None:
                return None
            cur['props'].append(l)
            cur['stride'] += size
    if cur:
        elements.append(cur)
    if not elements or elements[0]['name'] != 'vertex':
        return None

    vtx = elements[0]
    count = vtx['count']
    stride = vtx['stride']
    vbytes = count * stride
    if vbytes <= 0 or vbytes > len(body):
        return None

    prop_names = [l.split()[2] for l in vtx['props']]
    all_float = all(l.split()[1] in ('float', 'float32') for l in vtx['props'])

    payload = body[:vbytes]
    out_count = count
    if all_float and count > max_splats and 'opacity' in prop_names:
        try:
            arr = np.frombuffer(payload, dtype='<f4').reshape(count, len(prop_names))
            op = arr[:, prop_names.index('opacity')]
            # indices of the max_splats highest-opacity splats, kept in original
            # order (cache-friendlier for the loader than a shuffled subset)
            keep = np.argpartition(op, count - max_splats)[count - max_splats:]
            keep.sort()
            payload = arr[keep].tobytes()
            out_count = int(keep.size)
        except (ValueError, MemoryError):
            payload = body[:vbytes]
            out_count = count

    new_header = 'ply\n' + fmt_line + '\n'
    new_header += f"element vertex {out_count}\n"
    new_header += '\n'.join(vtx['props']) + '\n'
    new_header += 'end_header\n'
    try:
        with open(dst_ply, 'wb') as f:
            f.write(new_header.encode('ascii'))
            f.write(payload)
    except OSError:
        return None
    return dst_ply


def scene_bounds(ply_path):
    """Robust center + a fitted camera for a vertex-only 3DGS .ply, so the
    web viewer frames the splats correctly instead of orbiting the wrong pivot
    (which reads as a flat billboard). SHARP scenes sit in front of the
    canonical camera (origin, looking +z in OpenCV coords), so we place the
    viewer camera on the origin side of the scene center, offset to fit.

    Returns {'center':[x,y,z], 'camera':[x,y,z], 'radius':r} or None on failure.
    Reads the first 3 floats (x/y/z) of each vertex record; assumes the clean
    all-float32 vertex layout _vertex_only_ply writes."""
    try:
        data = ply_path.read_bytes()
    except OSError:
        return None
    hi = data.find(b'end_header\n')
    if hi < 0:
        return None
    header = data[:hi].decode('ascii', 'replace').splitlines()
    body = data[hi + len(b'end_header\n'):]
    try:
        count = next(int(l.split()[2]) for l in header if l.startswith('element vertex'))
        nprops = sum(1 for l in header if l.startswith('property'))
    except (StopIteration, ValueError, IndexError):
        return None
    stride = nprops * 4
    if stride <= 0 or count <= 0 or count * stride > len(body):
        return None
    try:
        arr = np.frombuffer(body[:count * stride], dtype='<f4').reshape(count, nprops)
    except ValueError:
        return None
    xyz = arr[:, 0:3].astype('float64')
    # Median center + a robust radius (95th pct distance) shrug off stray splats.
    center = np.median(xyz, axis=0)
    dist = np.linalg.norm(xyz - center, axis=1)
    radius = float(np.percentile(dist, 95)) or 1.0

    # Camera on the canonical (origin) side of the center, pulled back enough to
    # fit the scene; look_at is the center (also the orbit pivot).
    norm = float(np.linalg.norm(center))
    to_scene = (center / norm) if norm > 1e-6 else np.array([0.0, 0.0, 1.0])
    d = max(1.6 * radius, 0.6)
    camera = center - to_scene * d
    return {
        'center': [round(float(c), 4) for c in center],
        'camera': [round(float(c), 4) for c in camera],
        'radius': round(radius, 4),
    }
