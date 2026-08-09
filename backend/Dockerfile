# Deployed to Render (see /render.yaml at the repo root) so this backend
# keeps running as a persistent process - Netlify (hosting the static
# html/js/css) only runs short-lived serverless functions, not a server
# like this one. See README.md's "Deploying the backend" section.
FROM python:3.11-slim

# ffmpeg: used by premiere_bridge.py's remux_for_reliable_playback (every
# upload route) and previously by animate_llm.py's crossfade path.
# LibreOffice (needed for ingest/pptx_render.py's PPTX rendering) is
# deliberately NOT installed here - see requirements.txt's own comment on
# why that route isn't reachable from the current live pages.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .

# CPU-only torch (+ torchvision, pulled in transitively by
# docling-ibm-models/sentence-transformers below) from the SAME index,
# pinned together - pip's default resolution otherwise pulls torch's CUDA
# build (multiple GB, pointless on Render's CPU-only containers) AND, worse,
# can mix a CPU-only torch with a torchvision wheel built against a
# different torch variant from the default PyPI index. That mismatch is
# silent on arm64 (aarch64 PyPI wheels are CPU-only either way) but fails
# loudly on Render's x86_64 containers at import time: "RuntimeError:
# operator torchvision::nms does not exist" - torchvision's compiled
# extension expects torch internals that don't match a differently-built
# torch. Verified live (built + ran with --platform linux/amd64) that
# installing both from the CPU index together fixes it.
RUN pip install --no-cache-dir torch==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cpu

RUN pip install --no-cache-dir -r requirements.txt

# segmentation/segmentation_carta's spacy pipelines both load this model by
# name (see segmentation/pipeline.py, segmentation_carta/pipeline.py) -
# spacy doesn't fetch it automatically like sentence-transformers/docling's
# own on-demand model downloads do.
RUN python -m spacy download en_core_web_sm

COPY . .

# Render sets $PORT itself and routes external traffic to it - server.py's
# own __main__ block reads this (falling back to 8000 for local dev).
ENV PORT=8000
EXPOSE 8000

CMD ["python", "server.py"]
