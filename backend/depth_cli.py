#!/usr/bin/env python3
"""Monocular depth CLI for depth_media.estimate_depth (the 3D-reconstruction
worker). Reads an image, runs Depth-Anything-V2-Small (Apache-2.0) via
transformers, and writes a single-channel PNG where BRIGHT = NEAR (larger
disparity), which is what js/reconstruct-viewer.js expects for +Z displacement.

Invoked as a subprocess (see depth_media.DEPTH_CMD), never imported into Flask,
so its heavy torch/transformers import cost and the ~100MB model download stay
out of the API process. Kept dependency-light and self-contained: on any missing
dependency it exits non-zero so the worker degrades to a flat plane.

Usage:  python depth_cli.py -i <image_path> -o <depth_png_path>
"""
import argparse
import sys

# The checkpoint is small and permissively licensed; downloaded once and cached
# under ~/.cache/huggingface on first run. Override with DEPTH_MODEL if desired.
import os
_MODEL = os.environ.get('DEPTH_MODEL', 'depth-anything/Depth-Anything-V2-Small-hf')


def _pick_device():
    import torch
    if torch.backends.mps.is_available():
        return 'mps'
    if torch.cuda.is_available():
        return 'cuda'
    return 'cpu'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('-i', '--input', required=True)
    parser.add_argument('-o', '--output', required=True)
    args = parser.parse_args()

    try:
        import numpy as np
        import torch
        from PIL import Image
        from transformers import pipeline
    except Exception as exc:  # missing dep -> worker degrades to flat plane
        print(f'depth_cli: dependency unavailable: {exc}', file=sys.stderr)
        return 2

    try:
        image = Image.open(args.input).convert('RGB')
    except Exception as exc:
        print(f'depth_cli: cannot read input: {exc}', file=sys.stderr)
        return 3

    try:
        device = _pick_device()
        pipe = pipeline('depth-estimation', model=_MODEL, device=device)
        result = pipe(image)
        depth = result['depth']  # PIL image (near=bright), model resolution

        # Normalize to full 0..255 so the viewer's displacement uses the whole
        # range regardless of the scene's absolute depth spread.
        arr = np.asarray(depth).astype('float32')
        lo, hi = float(arr.min()), float(arr.max())
        if hi > lo:
            arr = (arr - lo) / (hi - lo) * 255.0
        else:
            arr = np.zeros_like(arr)
        out = Image.fromarray(arr.astype('uint8'), mode='L')
        # Match the color texture's dimensions so the viewer can sample 1:1.
        if out.size != image.size:
            out = out.resize(image.size, Image.BILINEAR)
        out.save(args.output, 'PNG')
    except Exception as exc:
        print(f'depth_cli: inference failed: {exc}', file=sys.stderr)
        return 4
    return 0


if __name__ == '__main__':
    sys.exit(main())
