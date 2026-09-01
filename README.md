# README.md

## Setup

1. **Install Python dependencies** (from the repo root):
   ```
   python3 -m pip install -r requirements.txt
   python3 -m spacy download en_core_web_sm
   ```
   `docling` will download models automatically the first time it runs (needs internet access once - `docling`'s layout/OCR models in particular can take a minute).

<!-- 2. **Install LibreOffice** (provides the `soffice` command), needed only for converting an uploaded `.pptx` into slide images in `presenter-view.html`:
   - macOS: `brew install --cask libreoffice`
   - Linux: `apt install libreoffice` (or your distro's equivalent)

   Confirm it's on your `PATH` with `soffice --version`. -->

3. **Configure API keys**: copy `backend/.env.example` to `backend/.env`. Put the direct OpenAI key in `OPENAI_API_KEY` for Whisper transcription, and put the proxy key/URL in `PROXY_API_KEY` / `PROXY_BASE_URL` for the other LLM-backed features.

<!-- Without a key, most LLM-backed features (learning objective suggestions, Simulate Audience, feedback) won't work, though the app will still start. `participant-view.html` doesn't call the LLM at all. -->

4. **Start both servers** (two separate terminals, both from the repo root):
   ```
   python3 backend/server.py      # backend Flask API, http://127.0.0.1:8000
   python3 serve.py 5500           # frontend static files, http://localhost:5500
   ```
   `serve.py` is a drop-in replacement for `python3 -m http.server` that adds HTTP Range support (206 Partial Content) - the standard library's version lacks it entirely, which can silently break playback of recorded/uploaded video and audio (served from `premiere_exports/`, under this same root) in browsers - Safari in particular - that require it. Plain `python3 -m http.server 5500` still works for everything else if you'd rather not use it.

5. **Open `http://localhost:5500/html/index.html`** in your browser. Upload an academic paper (PDF) and extract its section titles and body text for review. PDFs are parsed server-side by Docling.

## Act Board regression simulations

Run the browser-level regression suite:

```sh
python3 -m pip install playwright
python3 -m playwright install chromium
python3 tests/act_board_regression.py
```

Use `--headed` to watch the simulation, or `--url http://localhost:5500/html/storyboard.html` when the frontend is already running. The suite mocks backend routes and checks track/source-editor synchronization, free footage-card movement and placement, visualize highlights, phrase classification, narration record/stop/rerecord/new-segment flows, footage merge/split composition, edited narration/image/video inputs, scene reload safety, scene/full playback order, and combined Premiere + MP4 requests.

   <!-- - `http://localhost:5500/html/presenter-view.html` - upload a `.pptx`, record/align a transcript, define an audience and learning objectives, then run the Simulate Audience (Bayesian Knowledge Tracing) feature.
   - `http://localhost:5500/html/participant-view.html` - collect real human takeaways/reactions/ratings after watching a presentation.
   - `http://localhost:5500/html/index.html` - upload an academic paper (PDF/text/Markdown) and extract its section titles and body text for review. PDFs are parsed server-side by Docling; `.txt`/`.md` uploads use a client-side heuristic instead (Docling only handles PDFs).
   - `http://localhost:5500/html/knowledge.html`, `.../feedback.html`, `.../carta.html` - the other tools described below. -->

HTML pages live in `html/` and JS files live in `js/`; both are served as static files from the repo root by the `serve.py`/`http.server` command above, so page/script/asset references use root-absolute paths (e.g. `/js/helpers.js`, `/slides.json`) rather than paths relative to `html/`.

## Deploying the backend

This site's frontend deploys to Netlify (`netlify.toml`), but Netlify only runs short-lived serverless functions - not a persistent process like `python backend/server.py`, which several routes need (long-polling a video-generation job, `ffmpeg`/Docling model calls that can take longer than a function timeout, etc.). So the backend deploys separately, to [Render](https://render.com), as an always-running Docker container:

1. On Render: **New +** → **Blueprint** → point it at this repo. Render reads `render.yaml` and creates the `rehearsal-mvp-kg-backend` web service from `backend/Dockerfile`.
2. Render will prompt for the env vars marked `sync: false` in `render.yaml` (including the transcription and proxy credentials, plus `PEXELS_API_KEY` and `FREESOUND_API_KEY`) - same values as your local `backend/.env`, entered directly in Render's dashboard instead (never committed).
3. Once deployed, copy the service's `https://<name>.onrender.com` URL into `window.API_BASE_URL` near the top of `html/index.html` and `html/storyboard.html` (both currently have this commented out, defaulting to `http://127.0.0.1:8000` for local dev - see `js/helpers.js`'s `API_BASE_URL`).
4. Redeploy the frontend to Netlify so it picks up that change.

A couple of things worth knowing about this setup:
- Render's free tier spins the service down when idle and cold-starts on the next request - expect the first request after a while to be slow.
- **`/paper/extract` (PDF upload) is memory-tight on Render's free tier (512MB) and can still OOM-kill the whole instance** - which then fails every *other* request too until Render restarts it, not just PDF uploads. `paper_extraction.py`'s heavy imports (torch/transformers/opencv, via Docling) are deferred to first use rather than loaded at startup, and Docling's OCR path is disabled (`do_ocr = False` - not needed for papers with real embedded text, and RapidOCR's own torch-based models were a big chunk of the peak), but even with both fixes, extracting a single trivial one-page test PDF measured at ~505MB/512MB peak - a real multi-page paper with figures/tables will likely exceed it. If this keeps happening, upgrade the Render service's instance type for more RAM (Starter or above) - that's the real fix, the code-level mitigations above just buy headroom.
- `premiere_exports/` (generated sketches, uploaded footage, animated previews) lives on the container's own ephemeral disk - it's wiped on every restart/redeploy. Fine for now since nothing in the live UI depends on that persisting across deploys; a paid Render plan's persistent disk would fix this if it ever needs to.
- `LibreOffice` isn't installed in `backend/Dockerfile` (see `backend/requirements.txt`'s own comment) - that's only needed for `ingest/pptx_render.py`'s PPTX rendering, which isn't wired to any button on the current live pages.

<!-- ## `backend/segmentation/*.py`

Handles segmentation of input documents or a Wikipedia URL (placeholder for now, as an example of "common knowledge")

1. `structure.py` - recover and data-fy structure of input documents (base of knowledge)
2. `units.py` - build base units from document structure elements, essentially sentences
3. `embeddings.py` - turn sentence units into embeddings
4. `entities.py`, `keyphrases.py` - use `spaCy` to extract entities and keyphrases (noun chunks - nouns with descriptive phrases)
5. `boundaries.py` - calculate forced and soft boundaries between units (soft boundary score is based on semantic distance, entity shift and keyphrase shift scores between adjacent units)
6. `refine.py` - use calculated boundary scores to veto particular boundaries, based on presence of referral pronouns, semantic similarity, and entity similarity between two units; enforce length of final segments (though this is commented out for now)
7. `labeling.py` - call LLM model with instructions to generate a topic label, top-line summary, key entities, and keyphrases for returned segments; if no API key is present, fall back to a local keyphrase labeler option

## html/index.html

- Uploads an academic paper (PDF/.txt/.md) and extracts its section titles and body text as reviewable blocks, so the extraction can be sanity-checked against the source paper. No LLM call either way: PDFs are parsed server-side by `backend/paper_extraction.py` using Docling (a real structural parse, not a heuristic - see `/paper/extract` in `backend/server.py`); `.txt`/`.md` uploads stay client-side, using a pattern-matching heuristic (relative to common section names/numbered headings) since Docling only handles PDFs.

## html/knowledge.html

- Our system that provides improves feedback over naive system

## html/feedback.html

- Naive presentation feedback system that feeds presentation transcript/images to LLM; asks LLM to simulate a particular audience and return feedback

## html/presenter-view.html

- The main rehearsal-prep tool: upload a `.pptx`, record and align a transcript against the slides, define an audience and learning objectives (presentation-wide/section/slide), define dependency relationships between objectives, then run **Simulate Audience** - simulates ~3 independent audience members answering a comprehension question per learning objective, at the point in the presentation where it's first assessable, using a Bayesian-Knowledge-Tracing-style update to estimate how well the audience actually understood each objective. Weak objectives (especially ones other objectives depend on) surface with a suggested fix in the sidebar, exportable as presenter notes.

## html/participant-view.html

- A standalone tool for collecting **real human** (not LLM-simulated) reactions to a presentation: participants watch a slide+audio deck straight through, then reflect on it open-endedly - main takeaways they'd feel comfortable explaining to a friend, which slides/transcript excerpts contributed to or confused that understanding (and why), dependency links drawn between all of those, and Likert + open-response ratings of the presentation's informativeness/confusingness/understandability. No LLM calls or API key needed - the researcher's Learning Objectives module is reference-only context, not a comprehension quiz. Records persist in the browser's `localStorage` and are exportable as JSON. -->

### Task list

- Feels like there's a fair bit of duplicative work happening in `segmentation.py`, specifically in entity and keyphrase extraction, because earlier steps in the document segmentation pipeline use `spaCy` to extract entities and keyphrase in order to calculate boundaries to separate blocks of text into `segments` (in `boundaries.py` and `refine.py`, based on semantic distance, entity shift, and keyphrase shift between units of text) ... but then we call an LLM in `labeling.py` to again produce a summary, topic label, top entities, and keyphrases of the final text segments that is displayed in the frontend. We could just ask the LLM to segment a document or webpage, then directly generate the labels.
