# README.md

## Setup

1. **Install Python dependencies** (from the repo root):
   ```
   python3 -m pip install -r requirements.txt
   python3 -m spacy download en_core_web_sm
   ```
   The spaCy model is used by `backend/segmentation/` and `backend/segmentation_carta/`; `sentence-transformers` will download its embedding model automatically the first time it runs (needs internet access once).

2. **Install LibreOffice** (provides the `soffice` command), needed only for converting an uploaded `.pptx` into slide images in `presenter-view.html`:
   - macOS: `brew install --cask libreoffice`
   - Linux: `apt install libreoffice` (or your distro's equivalent)

   Confirm it's on your `PATH` with `soffice --version`.

3. **Configure an LLM API key**: copy `backend/.env.example` to `backend/.env` and fill in `OPENAI_API_KEY` with a real OpenAI (or OpenRouter) key. If you're using the real OpenAI API directly (not an internal proxy), delete/blank out the `OPENAI_BASE_URL` line - it's only needed to point at a custom OpenAI-compatible proxy. Without a key, most LLM-backed features (learning objective suggestions, Simulate Audience, feedback) won't work, though the app will still start. `participant-view.html` doesn't call the LLM at all.

4. **Start both servers** (two separate terminals, both from the repo root):
   ```
   python3 backend/server.py      # backend Flask API, http://127.0.0.1:8000
   python3 -m http.server 5500    # frontend static files, http://localhost:5500
   ```

5. **Open a page** in your browser:
   - `http://localhost:5500/html/presenter-view.html` - upload a `.pptx`, record/align a transcript, define an audience and learning objectives, then run the Simulate Audience (Bayesian Knowledge Tracing) feature.
   - `http://localhost:5500/html/participant-view.html` - collect real human takeaways/reactions/ratings after watching a presentation.
   - `http://localhost:5500/html/index.html`, `.../feedback.html`, `.../carta.html` - the other tools described below.

HTML pages live in `html/` and JS files live in `js/`; both are served as static files from the repo root by the `http.server` command above, so page/script/asset references use root-absolute paths (e.g. `/js/helpers.js`, `/slides.json`) rather than paths relative to `html/`.

## `backend/segmentation/*.py`

Handles segmentation of input documents or a Wikipedia URL (placeholder for now, as an example of "common knowledge")

1. `structure.py` - recover and data-fy structure of input documents (base of knowledge)
2. `units.py` - build base units from document structure elements, essentially sentences
3. `embeddings.py` - turn sentence units into embeddings
4. `entities.py`, `keyphrases.py` - use `spaCy` to extract entities and keyphrases (noun chunks - nouns with descriptive phrases)
5. `boundaries.py` - calculate forced and soft boundaries between units (soft boundary score is based on semantic distance, entity shift and keyphrase shift scores between adjacent units)
6. `refine.py` - use calculated boundary scores to veto particular boundaries, based on presence of referral pronouns, semantic similarity, and entity similarity between two units; enforce length of final segments (though this is commented out for now)
7. `labeling.py` - call LLM model with instructions to generate a topic label, top-line summary, key entities, and keyphrases for returned segments; if no API key is present, fall back to a local keyphrase labeler option

## html/index.html

- Our system that provides improves feedback over naive system

## html/feedback.html

- Naive presentation feedback system that feeds presentation transcript/images to LLM; asks LLM to simulate a particular audience and return feedback

## html/presenter-view.html

- The main rehearsal-prep tool: upload a `.pptx`, record and align a transcript against the slides, define an audience and learning objectives (presentation-wide/section/slide), define dependency relationships between objectives, then run **Simulate Audience** - simulates ~3 independent audience members answering a comprehension question per learning objective, at the point in the presentation where it's first assessable, using a Bayesian-Knowledge-Tracing-style update to estimate how well the audience actually understood each objective. Weak objectives (especially ones other objectives depend on) surface with a suggested fix in the sidebar, exportable as presenter notes.

## html/participant-view.html

- A standalone tool for collecting **real human** (not LLM-simulated) reactions to a presentation: participants watch a slide+audio deck straight through, then reflect on it open-endedly - main takeaways they'd feel comfortable explaining to a friend, which slides/transcript excerpts contributed to or confused that understanding (and why), dependency links drawn between all of those, and Likert + open-response ratings of the presentation's informativeness/confusingness/understandability. No LLM calls or API key needed - the researcher's Learning Objectives module is reference-only context, not a comprehension quiz. Records persist in the browser's `localStorage` and are exportable as JSON.

### Task list

- Feels like there's a fair bit of duplicative work happening in `segmentation.py`, specifically in entity and keyphrase extraction, because earlier steps in the document segmentation pipeline use `spaCy` to extract entities and keyphrase in order to calculate boundaries to separate blocks of text into `segments` (in `boundaries.py` and `refine.py`, based on semantic distance, entity shift, and keyphrase shift between units of text) ... but then we call an LLM in `labeling.py` to again produce a summary, topic label, top entities, and keyphrases of the final text segments that is displayed in the frontend. We could just ask the LLM to segment a document or webpage, then directly generate the labels.
