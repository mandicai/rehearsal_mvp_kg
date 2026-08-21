#!/usr/bin/env bash
# Sets up Apple ml-sharp (SHARP) for the 3D-reconstruction "3D splats" engine
# (see backend/sharp_media.py). SHARP needs its own Python 3.13 env with
# torch/gsplat and a ~2.6GB checkpoint (downloaded on first predict), so it
# lives in a SEPARATE, gitignored venv invoked as a subprocess - never imported
# into the Flask process.
#
# Requires `uv` (https://docs.astral.sh/uv/) and git. Idempotent-ish: re-running
# refreshes the install. After this, backend/sharp_media.py's default SHARP_CMD
# (backend/.sharp-venv/bin/sharp) resolves automatically; no env var needed.
#
# Usage:  cd backend && ./setup_sharp.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
VENDOR="$HERE/vendor/ml-sharp"
VENV="$HERE/.sharp-venv"

echo "==> Cloning apple/ml-sharp into $VENDOR"
mkdir -p "$HERE/vendor"
if [ -d "$VENDOR/.git" ]; then
  git -C "$VENDOR" pull --ff-only || true
else
  rm -rf "$VENDOR"
  git clone --depth 1 https://github.com/apple/ml-sharp.git "$VENDOR"
fi

echo "==> Creating Python 3.13 venv at $VENV"
uv venv --python 3.13 "$VENV"

echo "==> Installing SHARP + deps (torch/gsplat/timm/...)"
# The upstream requirements.txt pins `-e .`, which resolves against the CWD, so
# install from inside the clone with an absolute interpreter path.
( cd "$VENDOR" && uv pip install --python "$VENV/bin/python" -r requirements.txt )

echo "==> Verifying"
"$VENV/bin/sharp" --help >/dev/null && echo "OK: $VENV/bin/sharp"
echo
echo "Done. The backend will now use SHARP by default. The ~2.6GB model"
echo "downloads on the first reconstruction (cached in ~/.cache/torch/hub)."
echo "Only 'sharp predict' is used (never --render, which needs CUDA)."
