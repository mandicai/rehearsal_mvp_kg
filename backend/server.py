"""
Local HTTP service exposing the structure-aware semantic segmentation
pipeline (see segmentation/) to the static frontend in rehearsal_mvp_kg/,
which has no server or package manager of its own. Run with:
python server.py (listens on http://127.0.0.1:8000).

Optional LLM-based segment labeling (richer topic labels/entities/summaries
than the local fallback) activates automatically when an API key is present:
  OPENAI_API_KEY or OPENROUTER_API_KEY   (+ OPENAI_BASE_URL for OpenRouter)
These can be exported in the shell, or dropped in a .env file in this
directory (see .env.example) - loaded below before anything reads them.
See segmentation/llm.py for details - no key is required to run the app.

Also exposes segmentation_carta/ (an independent, in-progress pipeline: text
-> overlapping chunks -> LLM-extracted entity mentions per chunk) at
/segment_carta, for the carta.html inspector page. Unlike /segment, this one
has no local fallback and returns 503 without an LLM key.

Also exposes paper_extraction.py's Docling-backed PDF section extraction at
/paper/extract, for index.html's paper-upload tool - no LLM key needed, but
the first request downloads Docling's layout/OCR model weights (needs
internet access once).

Also exposes narrative_arc_llm.py's ranked narrative-arc recommendations
from a recorded intent narration and/or a few chosen focus statements (plus
the paper's own abstract, if the frontend found one) at /paper/suggest_arcs
- unlike /paper/extract, this does need an LLM key and returns 503 without
one.

Also exposes storyboard_llm.py's LLM-generated loose storyboard (a visual
direction + narration line per already-arranged section) at
/paper/storyboard - also needs an LLM key, returns 503 without one. That
route also runs segmentation_carta's per-chunk entity extraction
(CartaLLMClient.extract_entities) over each section first, reusing that
pipeline's stage 2 in isolation - skipping its chunking/clustering/dedup
machinery, since each section here is already a natural unit - to ground
the storyboard's shots in specific named entities, and the storyboard
response also carries a video_query/audio_query per section for the two
routes below.

Also exposes edit_plan_llm.py's LLM-generated editing plan (transitions,
pacing, Ken-Burns motion, text overlays) at /paper/edit_plan, for that same
tool's "Generate Edit Plan" action, once a storyboard already exists - also
needs an LLM key, returns 503 without one.

Also exposes sketch_llm.py's AI-generated storyboard reference image at
/paper/generate_sketch, for that same tool's per-shot "Generate Sketch"
action, once a storyboard's `visual` text exists for that shot - also needs
an LLM key, returns 503 without one. Unlike the other /paper/* routes, this
one writes to disk (premiere_exports/<project_id>/sketches/, see
premiere_bridge.py) and returns a preview_url rather than inline JSON data -
the image itself is a couple MB of base64, too big to hold in the
storyboard/edit-plan response shapes above.

Also exposes animate_llm.py's 3 interchangeable ways to animate a shot's
"Pan"/"Push in"/"Pull out" camera technique - all need an LLM key, return
503 without one, and share the same disk-based response shape as
/paper/generate_sketch, under premiere_exports/<project_id>/animated_sketches/:
  - /paper/generate_animated_sketch: image-to-video, once a sketch already
    exists for that shot (via /paper/generate_sketch above).
  - /paper/generate_video_from_text: text-to-video, no existing sketch
    needed, straight from the shot's own `visual` text.
  - /paper/generate_sketch_sequence: 2-3 sketch_llm.py stills (each its own
    call, same as /paper/generate_sketch) stitched into a hard-cut, looping
    animated GIF locally with Pillow - no video model involved, cheaper
    than the other two, and returns an actual .gif rather than an .mp4.

Also exposes stock_media.py's video/audio search at /media/search_video and
/media/search_audio, for that same tool's per-section "Find Footage"
action. /media/search_video queries 3 providers concurrently - Pexels
(modern stock footage, needs PEXELS_API_KEY, silently skipped without one)
and Internet Archive + Library of Congress (real archival/historical
footage, no key needed at all) - and tags each result with its source.
/media/search_audio (Freesound) needs FREESOUND_API_KEY, returns 503
without one.

Also exposes premiere_bridge.py's file-based hand-off to a Premiere Pro UXP
plugin (see premiere-plugin/) at /premiere/upload_footage,
/premiere/upload_narration, /premiere/upload_media_bank_item, and
/premiere/export - no LLM/API key needed, writes into premiere_exports/ at
the repo root, which the same static file server serving html/js/css
already serves at /premiere_exports/... (no separate route needed for that
direction - see premiere-plugin/README.md for the full round trip).
"""
import json
import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv

load_dotenv()  # populate os.environ from backend/.env, if present, before any env var is read

from flask import Flask, jsonify, request
from flask_cors import CORS
from werkzeug.utils import secure_filename

from segmentation import PipelineConfig
from segmentation_carta import CartaConfig
from segmentation_carta.llm import CartaLLMClient, CartaLLMCallError
from feedback_llm import FeedbackLLMClient, LLMCallError as FeedbackLLMCallError
from ingest import IngestConfig, render_pptx_to_slides, PptxRenderError, SofficeNotFoundError
from ingest import next_rehearsal_run_id, project_dir, snapshots_dir, save_project, PROJECTS_DIR
from ingest import TranscriptionClient, TranscriptionCallError
from ingest import align_transcript, AlignError
from ingest import ObjectivesLLMClient, ObjectivesLLMCallError
from ingest import AssessmentLLMClient, AssessmentLLMCallError
from paper_extraction import extract_sections, PaperExtractionError
from narrative_arc_llm import NarrativeArcLLMClient, NarrativeArcLLMCallError
from storyboard_llm import StoryboardLLMClient, StoryboardLLMCallError
from edit_plan_llm import EditPlanLLMClient, EditPlanLLMCallError
from sketch_llm import SketchLLMClient, SketchLLMCallError
from animate_llm import (
    AnimateLLMClient, AnimateLLMCallError, TECHNIQUES as ANIMATE_TECHNIQUES,
    build_sequence_prompts, compose_gif,
)
from documentary_modes import DOCUMENTARY_MODE_KEYS
from stock_media import PexelsClient, InternetArchiveClient, LibraryOfCongressClient, FreesoundClient, StockMediaCallError
from premiere_bridge import (
    next_premiere_project_id, premiere_project_dir, premiere_footage_dir, premiere_sketch_dir,
    premiere_animated_sketch_dir, premiere_narration_dir, premiere_media_bank_dir, premiere_stock_media_dir,
    remux_for_reliable_playback, download_stock_media_to_disk, resolve_static_preview_path, PREMIERE_EXPORTS_DIR,
)

# Structural parsing + NER run in roughly linear time, but boundary scoring
# and refinement are O(n^2)-ish over base units, so this caps worst-case
# request latency on a pathologically long upload. Applied to the raw input
# before structure parsing (cheaper than checking after the fact).
MAX_CHARS = 200_000

# segmentation_carta calls the LLM once per chunk (not once per final segment
# like segmentation/, which algorithmically merges units down first), so the
# same MAX_CHARS would mean far more LLM calls per request. Capped lower to
# keep a single request's cost/latency reasonable for what is, for now, a
# manual double-checking tool rather than the main pipeline.
MAX_CARTA_CHARS = 40_000

# Each slide sends a full image to a vision LLM call, so an unreasonably
# long deck would blow up request size/latency/cost for little benefit.
MAX_FEEDBACK_SLIDES = 60

# Bounds on presenter-view.html uploads (see /ingest/pptx, /transcribe below).
MAX_PPTX_SIZE_MB = 50
MAX_AUDIO_SIZE_MB = 50

# Bound on index.html's paper upload (see /paper/extract below).
MAX_PAPER_SIZE_MB = 50

# Bounds on index.html's storyboard request (see /paper/storyboard below) -
# a tighter per-section cap than narrative-arc's since this call's output
# (a visual + narration line per section) is already richer/larger, and the
# LLM only needs enough of each section to draft a shot from, not its full body.
MAX_STORYBOARD_SECTIONS = 100
MAX_STORYBOARD_SECTION_CHARS = 1500

# Bounds on index.html's edit-plan request (see /paper/edit_plan below) -
# this call only needs each shot's already-drafted visual/narration (not
# its full original section text), so the per-shot cap is tighter still.
MAX_EDIT_PLAN_SECTIONS = 100
MAX_EDIT_PLAN_TEXT_CHARS = 500

# Bound on index.html's sketch request (see /paper/generate_sketch below) -
# same role as MAX_EDIT_PLAN_TEXT_CHARS, just for the one 'visual' string
# a sketch prompt is built from.
MAX_SKETCH_VISUAL_CHARS = 500

# Bound on the free-text "documentary intent" statement index.html's
# narrative-arc/storyboard requests can optionally include (see both routes
# below) - a presenter's stated focus/message, not a document, so this is
# generous headroom rather than an expected length.
MAX_DOCUMENTARY_GOAL_CHARS = 500

# Bound on the transcript index.html's /paper/suggest_arcs request carries
# (see that route below) - a spoken monologue, so a far larger cap than
# MAX_DOCUMENTARY_GOAL_CHARS, but still bounded to keep prompt size/latency
# reasonable for a single request.
MAX_NARRATION_TRANSCRIPT_CHARS = 20_000

# Bound on the optional "abstract" text /paper/suggest_arcs' request can
# carry (see that route below) - the extracted paper's own abstract
# section, if the frontend found one (see js/paper-extract.js's
# findAbstractText). Real abstracts run a few hundred words; this is
# generous headroom, not an expected length, same posture as
# MAX_DOCUMENTARY_GOAL_CHARS above.
MAX_ABSTRACT_CHARS = 3_000

# Bound on the optional "arc_sections" list /paper/storyboard and
# /paper/edit_plan can accept - the accepted arc's part names, in order,
# forwarded for pacing/positional context (roughly 3-8 in practice). Also
# reused by /paper/suggest_arcs' own resolved arcs, which follow the same
# 2-8 range (see narrative_arc_llm.py's parse_arc).
MAX_ARC_SECTIONS = 8
MAX_ARC_SECTION_NAME_CHARS = 80

# Bounds on /paper/suggest_arcs' optional focus_statements list (see that
# route below) - a handful of short suggested-focus chips plus maybe one
# typed-in custom addition, not a document.
MAX_FOCUS_STATEMENTS = 6
MAX_FOCUS_STATEMENT_CHARS = 200

# Bound on index.html's own-footage upload (see /premiere/upload_footage
# below) - real video files, so a larger cap than the other uploads here.
MAX_FOOTAGE_SIZE_MB = 500

app = Flask(__name__)
CORS(app)
app.config['MAX_CONTENT_LENGTH'] = max(MAX_PPTX_SIZE_MB, MAX_AUDIO_SIZE_MB, MAX_PAPER_SIZE_MB, MAX_FOOTAGE_SIZE_MB) * 1024 * 1024

# Lazy, not module-level like every client below - SegmentationPipeline
# eagerly loads a full sentence-transformers model (~all-MiniLM-L6-v2) plus
# spaCy, and CartaPipeline loads spaCy too (see segmentation/pipeline.py,
# segmentation_carta/pipeline.py) - real memory (spaCy is tens of MB,
# sentence-transformers' torch dependency alone is far more), not just
# import time. /segment and /segment_carta below (for the now-removed
# carta.html/knowledge.html) aren't reachable from any page js/paper-
# extract.js actually wires up - constructing these eagerly at process
# start paid that memory cost on every deploy for two routes nothing calls,
# which is what pushed the deployed container over Render's free-tier
# 512MB limit. Built the exact same way as every *_client's own lazy
# _get_client() elsewhere in this codebase, just at module scope since
# these aren't instance methods.
_pipeline = None
_carta_pipeline = None


def _get_pipeline():
    global _pipeline
    if _pipeline is None:
        # Imported here, not at module top (see segmentation/__init__.py's
        # own comment) - .pipeline is what actually pulls in spacy/
        # sentence-transformers, so this import itself is part of what
        # needs to stay deferred, not just the SegmentationPipeline(...) call.
        from segmentation.pipeline import SegmentationPipeline
        _pipeline = SegmentationPipeline(PipelineConfig())
    return _pipeline


def _get_carta_pipeline():
    global _carta_pipeline
    if _carta_pipeline is None:
        # See _get_pipeline's own comment - same reasoning, spacy this time.
        from segmentation_carta.pipeline import CartaPipeline
        _carta_pipeline = CartaPipeline(CartaConfig())
    return _carta_pipeline


feedback_client = FeedbackLLMClient()
ingest_config = IngestConfig()
transcription_client = TranscriptionClient(model=ingest_config.transcription_model)
objectives_client = ObjectivesLLMClient()
assessment_client = AssessmentLLMClient()
narrative_arc_client = NarrativeArcLLMClient()
storyboard_client = StoryboardLLMClient()
edit_plan_client = EditPlanLLMClient()
sketch_client = SketchLLMClient()
animate_client = AnimateLLMClient()
carta_entity_client = CartaLLMClient()
pexels_client = PexelsClient()
internet_archive_client = InternetArchiveClient()
library_of_congress_client = LibraryOfCongressClient()
freesound_client = FreesoundClient()


@app.route('/segment', methods=['POST'])
def segment():
    data = request.get_json(silent=True) or {}
    text = data.get('text', '')
    document_id = data.get('document_id') or None

    if not isinstance(text, str) or not text.strip():
        return jsonify({'segments': [], 'truncated': False})

    truncated = len(text) > MAX_CHARS
    if truncated:
        text = text[:MAX_CHARS]

    try:
        segments = _get_pipeline().run(text, document_id=document_id)
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500

    return jsonify({'segments': segments, 'truncated': truncated})


@app.route('/segment_carta', methods=['POST'])
def segment_carta():
    data = request.get_json(silent=True) or {}
    text = data.get('text', '')
    document_id = data.get('document_id') or None

    if not isinstance(text, str) or not text.strip():
        return jsonify({
            'chunks': [], 'entities': [], 'predicates': [],
            'entity_clusters': [], 'predicate_clusters': [],
            'schema_levels': [], 'schema_relations': [],
            'truncated': False,
        })

    truncated = len(text) > MAX_CARTA_CHARS
    if truncated:
        text = text[:MAX_CARTA_CHARS]

    carta_pipeline = _get_carta_pipeline()
    if not carta_pipeline.llm_client.is_configured():
        return jsonify({
            'error': 'segmentation_carta requires an LLM API key (no local fallback). Set OPENAI_API_KEY (or OPENROUTER_API_KEY) in backend/.env.'
        }), 503

    try:
        result = carta_pipeline.run(text, document_id=document_id)
    except CartaLLMCallError as exc:
        return jsonify({'error': str(exc)}), 500
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500

    return jsonify({
        'chunks': result['chunks'],
        'entities': result['entities'],
        'predicates': result['predicates'],
        'entity_clusters': result['entity_clusters'],
        'predicate_clusters': result['predicate_clusters'],
        'schema_levels': result['schema_levels'],
        'schema_relations': result['schema_relations'],
        'truncated': truncated,
    })


@app.route('/feedback', methods=['POST'])
def feedback():
    data = request.get_json(silent=True) or {}
    audience = (data.get('audience') or '').strip()
    prompt = (data.get('prompt') or '').strip()
    slides = data.get('slides')

    if not audience:
        return jsonify({'error': 'audience is required'}), 400
    if not isinstance(slides, list) or not slides:
        return jsonify({'error': 'slides is required'}), 400
    if len(slides) > MAX_FEEDBACK_SLIDES:
        return jsonify({'error': f'too many slides (max {MAX_FEEDBACK_SLIDES})'}), 400

    if not feedback_client.is_configured():
        return jsonify({
            'error': 'Feedback requires an LLM API key. Set OPENAI_API_KEY (or OPENROUTER_API_KEY) in backend/.env.'
        }), 503

    try:
        feedback_text = feedback_client.get_feedback(audience, prompt, slides)
    except FeedbackLLMCallError as exc:
        return jsonify({'error': str(exc)}), 500

    return jsonify({'feedback': feedback_text})


@app.route('/feedback/progressive_step', methods=['POST'])
def feedback_progressive_step():
    # One step of "progressive" mode (see feedback_llm.get_progressive_reaction):
    # the frontend calls this once per turn (a real slide, or a synthetic
    # section-recap/overall checkpoint), in order, carrying the growing
    # `messages` conversation forward itself between calls - this route is
    # stateless like every other route here, so nothing is stored server-side.
    data = request.get_json(silent=True) or {}
    audience = (data.get('audience') or '').strip()
    prompt = (data.get('prompt') or '').strip()
    goal = (data.get('goal') or '').strip()
    messages = data.get('messages') or []
    slide = data.get('slide')

    if not audience:
        return jsonify({'error': 'audience is required'}), 400
    if not isinstance(slide, dict):
        return jsonify({'error': 'slide is required'}), 400
    if not isinstance(messages, list):
        return jsonify({'error': 'messages must be a list'}), 400

    if not feedback_client.is_configured():
        return jsonify({
            'error': 'Feedback requires an LLM API key. Set OPENAI_API_KEY (or OPENROUTER_API_KEY) in backend/.env.'
        }), 503

    try:
        parsed, updated_messages = feedback_client.get_progressive_reaction(audience, prompt, messages, slide, goal)
    except FeedbackLLMCallError as exc:
        return jsonify({'error': str(exc)}), 500

    return jsonify({
        'flow_feedback': parsed.get('flow_feedback', ''),
        'understanding_feedback': parsed.get('understanding_feedback', ''),
        'messages': updated_messages,
    })


@app.route('/paper/extract', methods=['POST'])
def paper_extract():
    uploaded = request.files.get('file')
    if uploaded is None or not uploaded.filename:
        return jsonify({'error': 'file is required (multipart field "file")'}), 400
    if not uploaded.filename.lower().endswith('.pdf'):
        return jsonify({'error': 'file must be a .pdf'}), 400

    pdf_bytes = uploaded.read()
    if len(pdf_bytes) > MAX_PAPER_SIZE_MB * 1024 * 1024:
        return jsonify({'error': f'file exceeds max size of {MAX_PAPER_SIZE_MB}MB'}), 400

    try:
        result = extract_sections(pdf_bytes, uploaded.filename)
    except PaperExtractionError as exc:
        return jsonify({'error': str(exc)}), 500

    return jsonify(result)


_NARRATIVE_ARC_NOT_CONFIGURED_ERROR = (
    'Arranging sections into a narrative arc requires an LLM API key. Set OPENAI_API_KEY (or OPENROUTER_API_KEY) in backend/.env.'
)


def _parse_arc_sections(data):
    """Optional client-given ordered list of arc-part names - the accepted
    arc's part names, forwarded for positional context by /paper/storyboard
    and /paper/edit_plan. Shared validation for both routes. Returns
    (cleaned_list_or_None, error_response_or_None)."""
    raw = data.get('arc_sections')
    if raw is None:
        return None, None
    if (not isinstance(raw, list) or not (1 <= len(raw) <= MAX_ARC_SECTIONS)
            or not all(isinstance(s, str) and s.strip() for s in raw)):
        return None, (jsonify({'error': f'arc_sections must be a list of 1-{MAX_ARC_SECTIONS} non-empty strings'}), 400)
    return [s.strip()[:MAX_ARC_SECTION_NAME_CHARS] for s in raw], None


def _parse_documentary_mode(data):
    """Optional stylistic axis (see documentary_modes.py) - independent of
    arc structure/documentary_goal, used by /paper/storyboard and
    /paper/edit_plan only. Returns (mode_key_or_None, error_response_or_None)."""
    mode = data.get('documentary_mode')
    if mode is None:
        return None, None
    if mode not in DOCUMENTARY_MODE_KEYS:
        return None, (jsonify({'error': f'documentary_mode must be one of {DOCUMENTARY_MODE_KEYS}'}), 400)
    return mode, None


@app.route('/paper/suggest_arcs', methods=['POST'])
def paper_suggest_arcs():
    # Ranked arc recommendations from a recorded narration (+ optional
    # suggested-focus chips) - see js/paper-extract.js's Record Your Intent
    # flow. Once the presenter accepts a recommendation/alternative/custom
    # arc, its parts become the narrative-act groups shown right away
    # (js/paper-extract.js's runAcceptArc) - no server call to place paper
    # sections into them; the presenter does that manually from there.
    data = request.get_json(silent=True) or {}
    transcript = (data.get('transcript') or '').strip()[:MAX_NARRATION_TRANSCRIPT_CHARS]
    abstract = (data.get('abstract') or '').strip()[:MAX_ABSTRACT_CHARS]

    focus_statements_raw = data.get('focus_statements')
    focus_statements = None
    if focus_statements_raw is not None:
        if (not isinstance(focus_statements_raw, list) or len(focus_statements_raw) > MAX_FOCUS_STATEMENTS
                or not all(isinstance(s, str) for s in focus_statements_raw)):
            return jsonify({'error': f'focus_statements must be a list of up to {MAX_FOCUS_STATEMENTS} strings'}), 400
        focus_statements = [s.strip()[:MAX_FOCUS_STATEMENT_CHARS] for s in focus_statements_raw if s.strip()]

    # A recording is the usual case, but the presenter can reach this step
    # via a chosen focus chip alone (see js/paper-extract.js's
    # updateComposeStoryboardVisibility) - only reject if neither exists.
    # abstract is pure enrichment on top of either, never required on its
    # own (see narrative_arc_llm.py's own docstring).
    if not transcript and not focus_statements:
        return jsonify({'error': 'transcript or focus_statements is required'}), 400

    if not narrative_arc_client.is_configured():
        return jsonify({'error': _NARRATIVE_ARC_NOT_CONFIGURED_ERROR}), 503

    try:
        recommended, alternatives = narrative_arc_client.suggest_arcs_from_intent(transcript, focus_statements, abstract)
    except NarrativeArcLLMCallError as exc:
        return jsonify({'error': str(exc)}), 500

    return jsonify({'recommended': recommended, 'alternatives': alternatives})


_STORYBOARD_NOT_CONFIGURED_ERROR = (
    'Generating a storyboard requires an LLM API key. Set OPENAI_API_KEY (or OPENROUTER_API_KEY) in backend/.env.'
)


@app.route('/paper/storyboard', methods=['POST'])
def paper_storyboard():
    data = request.get_json(silent=True) or {}
    sections = data.get('sections')

    if not isinstance(sections, list) or not sections:
        return jsonify({'error': 'sections is required and must be a non-empty list'}), 400
    if len(sections) > MAX_STORYBOARD_SECTIONS:
        return jsonify({'error': f'too many sections (max {MAX_STORYBOARD_SECTIONS})'}), 400

    cleaned = []
    for i, section in enumerate(sections):
        if not isinstance(section, dict):
            return jsonify({'error': f'section {i} must be an object'}), 400
        index = section.get('index')
        title = (section.get('title') or '').strip()
        act = section.get('act')
        if not isinstance(index, int) or not title or not isinstance(act, str) or not act.strip():
            return jsonify({'error': f'section {i} must have an integer "index", non-empty "title", and non-empty "act"'}), 400
        cleaned.append({
            'index': index,
            'title': title,
            'act': act.strip(),
            'text': (section.get('text') or '').strip()[:MAX_STORYBOARD_SECTION_CHARS],
        })

    documentary_goal = (data.get('documentary_goal') or '').strip()[:MAX_DOCUMENTARY_GOAL_CHARS]
    arc_sections, err = _parse_arc_sections(data)
    if err:
        return err
    documentary_mode, err = _parse_documentary_mode(data)
    if err:
        return err

    if not storyboard_client.is_configured():
        return jsonify({'error': _STORYBOARD_NOT_CONFIGURED_ERROR}), 503

    # Entities are an enrichment, not a requirement - a failed/unconfigured
    # extraction just means that section's shot stays generic, it doesn't
    # sink the whole storyboard request. One LLM call per section, run in
    # parallel (mirrors segmentation_carta/pipeline.py's own stage-2 fan-out).
    entities_by_index = {section['index']: [] for section in cleaned}
    if carta_entity_client.is_configured():
        with ThreadPoolExecutor(max_workers=4) as executor:
            future_to_section = {
                executor.submit(carta_entity_client.extract_entities, section['text']): section
                for section in cleaned
            }
            for future in future_to_section:
                section = future_to_section[future]
                try:
                    entities_by_index[section['index']] = future.result()
                except CartaLLMCallError:
                    pass  # leave that section's entities empty

    for section in cleaned:
        section['entities'] = entities_by_index[section['index']]

    try:
        storyboard = storyboard_client.generate_storyboard(cleaned, documentary_goal, arc_sections, documentary_mode)
    except StoryboardLLMCallError as exc:
        return jsonify({'error': str(exc)}), 500

    return jsonify({'storyboard': [
        {
            'index': index,
            'visual': entry['visual'],
            'narration': entry['narration'],
            'video_query': entry['video_query'],
            'audio_query': entry['audio_query'],
            'entities': entities_by_index.get(index, []),
        }
        for index, entry in storyboard.items()
    ]})


_EDIT_PLAN_NOT_CONFIGURED_ERROR = (
    'Generating an edit plan requires an LLM API key. Set OPENAI_API_KEY (or OPENROUTER_API_KEY) in backend/.env.'
)


@app.route('/paper/edit_plan', methods=['POST'])
def paper_edit_plan():
    data = request.get_json(silent=True) or {}
    sections = data.get('sections')

    if not isinstance(sections, list) or not sections:
        return jsonify({'error': 'sections is required and must be a non-empty list'}), 400
    if len(sections) > MAX_EDIT_PLAN_SECTIONS:
        return jsonify({'error': f'too many sections (max {MAX_EDIT_PLAN_SECTIONS})'}), 400

    cleaned = []
    for i, section in enumerate(sections):
        if not isinstance(section, dict):
            return jsonify({'error': f'section {i} must be an object'}), 400
        index = section.get('index')
        title = (section.get('title') or '').strip()
        act = section.get('act')
        if not isinstance(index, int) or not title or not isinstance(act, str) or not act.strip():
            return jsonify({'error': f'section {i} must have an integer "index", non-empty "title", and non-empty "act"'}), 400
        cleaned.append({
            'index': index,
            'title': title,
            'act': act.strip(),
            'text': (section.get('text') or '').strip()[:MAX_EDIT_PLAN_TEXT_CHARS],
            'visual': (section.get('visual') or '').strip()[:MAX_EDIT_PLAN_TEXT_CHARS],
            'narration': (section.get('narration') or '').strip()[:MAX_EDIT_PLAN_TEXT_CHARS],
            'has_figure_image': bool(section.get('has_figure_image')),
        })

    documentary_goal = (data.get('documentary_goal') or '').strip()[:MAX_DOCUMENTARY_GOAL_CHARS]
    arc_sections, err = _parse_arc_sections(data)
    if err:
        return err
    documentary_mode, err = _parse_documentary_mode(data)
    if err:
        return err

    if not edit_plan_client.is_configured():
        return jsonify({'error': _EDIT_PLAN_NOT_CONFIGURED_ERROR}), 503

    try:
        plan, overall_notes = edit_plan_client.generate_edit_plan(cleaned, documentary_goal, arc_sections, documentary_mode)
    except EditPlanLLMCallError as exc:
        return jsonify({'error': str(exc)}), 500

    return jsonify({
        'shots': [
            {
                'index': index,
                'transition_in': entry['transition_in'],
                'duration_seconds': entry['duration_seconds'],
                'ken_burns': entry['ken_burns'],
                'text_overlay': entry['text_overlay'],
            }
            for index, entry in plan.items()
        ],
        'overall_notes': overall_notes,
    })


_SKETCH_NOT_CONFIGURED_ERROR = (
    'Generating a sketch requires an LLM API key. Set OPENAI_API_KEY (or OPENROUTER_API_KEY) in backend/.env.'
)


@app.route('/paper/generate_sketch', methods=['POST'])
def paper_generate_sketch():
    data = request.get_json(silent=True) or {}

    try:
        section_index = int(data.get('section_index'))
    except (TypeError, ValueError):
        return jsonify({'error': 'section_index is required and must be an integer'}), 400

    visual = (data.get('visual') or '').strip()[:MAX_SKETCH_VISUAL_CHARS]
    if not visual:
        return jsonify({'error': 'visual is required and must be a non-empty string'}), 400

    documentary_mode, err = _parse_documentary_mode(data)
    if err:
        return err

    project_id = (data.get('project_id') or '').strip() or next_premiere_project_id()

    if not sketch_client.is_configured():
        return jsonify({'error': _SKETCH_NOT_CONFIGURED_ERROR}), 503

    try:
        png_bytes = sketch_client.generate_sketch(visual, documentary_mode)
    except SketchLLMCallError as exc:
        return jsonify({'error': str(exc)}), 500

    sketch_dir = premiere_sketch_dir(project_id)
    sketch_dir.mkdir(parents=True, exist_ok=True)
    saved_path = sketch_dir / f'{section_index}.png'
    saved_path.write_bytes(png_bytes)

    # Same static-file-server convention as /premiere/upload_footage's
    # preview_url - a path relative to the repo root, not saved_path's
    # absolute filesystem path.
    preview_url = '/' + saved_path.relative_to(PREMIERE_EXPORTS_DIR.parent).as_posix()

    return jsonify({'project_id': project_id, 'preview_url': preview_url})


_ANIMATE_NOT_CONFIGURED_ERROR = (
    'Generating an animated sketch requires an LLM API key. Set OPENAI_API_KEY (or OPENROUTER_API_KEY) in backend/.env.'
)


@app.route('/paper/generate_animated_sketch', methods=['POST'])
def paper_generate_animated_sketch():
    data = request.get_json(silent=True) or {}

    try:
        section_index = int(data.get('section_index'))
    except (TypeError, ValueError):
        return jsonify({'error': 'section_index is required and must be an integer'}), 400

    technique = data.get('technique')
    if technique not in ANIMATE_TECHNIQUES:
        return jsonify({'error': f'technique must be one of {ANIMATE_TECHNIQUES}'}), 400

    documentary_mode, err = _parse_documentary_mode(data)
    if err:
        return err

    project_id = (data.get('project_id') or '').strip()
    if not project_id:
        return jsonify({'error': 'project_id is required - generate a sketch for this section first'}), 400

    sketch_path = premiere_sketch_dir(project_id) / f'{section_index}.png'
    if not sketch_path.exists():
        return jsonify({'error': 'No sketch found for this section yet - generate a sketch first.'}), 400

    if not animate_client.is_configured():
        return jsonify({'error': _ANIMATE_NOT_CONFIGURED_ERROR}), 503

    try:
        mp4_bytes = animate_client.generate_animated_sketch(sketch_path.read_bytes(), technique, documentary_mode)
    except AnimateLLMCallError as exc:
        return jsonify({'error': str(exc)}), 500

    animated_dir = premiere_animated_sketch_dir(project_id)
    animated_dir.mkdir(parents=True, exist_ok=True)
    saved_path = animated_dir / f'{section_index}_{technique}.mp4'
    saved_path.write_bytes(mp4_bytes)
    remux_for_reliable_playback(saved_path)

    # Same static-file-server convention as /paper/generate_sketch's own
    # preview_url - a path relative to the repo root.
    preview_url = '/' + saved_path.relative_to(PREMIERE_EXPORTS_DIR.parent).as_posix()

    return jsonify({'project_id': project_id, 'preview_url': preview_url})


@app.route('/paper/generate_video_from_text', methods=['POST'])
def paper_generate_video_from_text():
    # Same video model as /paper/generate_animated_sketch above, but
    # text-only (no existing sketch required) - see animate_llm.py's
    # generate_text_to_video.
    data = request.get_json(silent=True) or {}

    try:
        section_index = int(data.get('section_index'))
    except (TypeError, ValueError):
        return jsonify({'error': 'section_index is required and must be an integer'}), 400

    visual = (data.get('visual') or '').strip()[:MAX_SKETCH_VISUAL_CHARS]
    if not visual:
        return jsonify({'error': 'visual is required and must be a non-empty string'}), 400

    technique = data.get('technique')
    if technique not in ANIMATE_TECHNIQUES:
        return jsonify({'error': f'technique must be one of {ANIMATE_TECHNIQUES}'}), 400

    documentary_mode, err = _parse_documentary_mode(data)
    if err:
        return err

    project_id = (data.get('project_id') or '').strip() or next_premiere_project_id()

    if not animate_client.is_configured():
        return jsonify({'error': _ANIMATE_NOT_CONFIGURED_ERROR}), 503

    try:
        mp4_bytes = animate_client.generate_text_to_video(visual, technique, documentary_mode)
    except AnimateLLMCallError as exc:
        return jsonify({'error': str(exc)}), 500

    animated_dir = premiere_animated_sketch_dir(project_id)
    animated_dir.mkdir(parents=True, exist_ok=True)
    saved_path = animated_dir / f'{section_index}_{technique}_text2video.mp4'
    saved_path.write_bytes(mp4_bytes)
    remux_for_reliable_playback(saved_path)

    preview_url = '/' + saved_path.relative_to(PREMIERE_EXPORTS_DIR.parent).as_posix()

    return jsonify({'project_id': project_id, 'preview_url': preview_url})


@app.route('/paper/generate_sketch_sequence', methods=['POST'])
def paper_generate_sketch_sequence():
    # Cheaper, non-video-model alternative to the two routes above - 2-3
    # sketch_llm.py stills (one real model call each, same as
    # /paper/generate_sketch) stitched into a hard-cut, looping animated
    # GIF locally (see animate_llm.py's build_sequence_prompts/compose_gif).
    data = request.get_json(silent=True) or {}

    try:
        section_index = int(data.get('section_index'))
    except (TypeError, ValueError):
        return jsonify({'error': 'section_index is required and must be an integer'}), 400

    visual = (data.get('visual') or '').strip()[:MAX_SKETCH_VISUAL_CHARS]
    if not visual:
        return jsonify({'error': 'visual is required and must be a non-empty string'}), 400

    technique = data.get('technique')
    if technique not in ANIMATE_TECHNIQUES:
        return jsonify({'error': f'technique must be one of {ANIMATE_TECHNIQUES}'}), 400

    frame_count = data.get('frame_count', 3)
    if frame_count not in (2, 3):
        return jsonify({'error': 'frame_count must be 2 or 3'}), 400

    documentary_mode, err = _parse_documentary_mode(data)
    if err:
        return err

    project_id = (data.get('project_id') or '').strip() or next_premiere_project_id()

    if not sketch_client.is_configured():
        return jsonify({'error': _SKETCH_NOT_CONFIGURED_ERROR}), 503

    try:
        prompts = build_sequence_prompts(visual, technique, frame_count)
        frame_bytes = [sketch_client.generate_sketch(prompt, documentary_mode) for prompt in prompts]
        gif_bytes = compose_gif(frame_bytes)
    except (SketchLLMCallError, AnimateLLMCallError) as exc:
        return jsonify({'error': str(exc)}), 500

    animated_dir = premiere_animated_sketch_dir(project_id)
    animated_dir.mkdir(parents=True, exist_ok=True)
    saved_path = animated_dir / f'{section_index}_{technique}_sequence.gif'
    saved_path.write_bytes(gif_bytes)
    # No remux_for_reliable_playback here (unlike the two routes above) -
    # that helper's ffmpeg -c copy remux fixes video/audio container
    # metadata issues; a GIF has no such issue and isn't one of ffmpeg's
    # -c copy-friendly containers anyway.

    preview_url = '/' + saved_path.relative_to(PREMIERE_EXPORTS_DIR.parent).as_posix()

    return jsonify({'project_id': project_id, 'preview_url': preview_url})


_FREESOUND_NOT_CONFIGURED_ERROR = (
    'Audio search requires a Freesound API key. Set FREESOUND_API_KEY in backend/.env '
    '(free at freesound.org/apiv2/apply - non-commercial use only).'
)


@app.route('/media/search_video', methods=['POST'])
def media_search_video():
    # 3 providers, each independently optional/best-effort - Pexels (modern
    # stock footage, needs PEXELS_API_KEY) alongside Internet Archive and
    # Library of Congress (real archival/historical footage, no key needed
    # at all - see stock_media.py's own module docstring for why these two
    # need no configuration check the way Pexels does below). Run
    # concurrently (same ThreadPoolExecutor fan-out convention as
    # /paper/storyboard's per-section entity extraction above) since
    # Archive/LOC each make several sequential follow-up requests per
    # search on top of Pexels' own single one - sequentially, this route
    # would be as slow as its slowest provider times three.
    data = request.get_json(silent=True) or {}
    query = (data.get('query') or '').strip()

    if not query:
        return jsonify({'error': 'query is required'}), 400

    providers = [('Internet Archive', internet_archive_client), ('Library of Congress', library_of_congress_client)]
    if pexels_client.is_configured():
        providers.append(('Pexels', pexels_client))

    videos = []
    errors = []
    with ThreadPoolExecutor(max_workers=len(providers)) as executor:
        future_to_source = {executor.submit(client.search_videos, query): source for source, client in providers}
        for future in future_to_source:
            source = future_to_source[future]
            try:
                for video in future.result():
                    video['source'] = source
                    videos.append(video)
            except StockMediaCallError as exc:
                errors.append(f'{source}: {exc}')

    # Only a total failure (every provider errored, none returned even a
    # partial result) is worth surfacing as an error - one provider being
    # down/misconfigured shouldn't hide results the others found fine.
    if not videos and errors:
        return jsonify({'error': '; '.join(errors)}), 500

    return jsonify({'videos': videos})


@app.route('/media/search_audio', methods=['POST'])
def media_search_audio():
    data = request.get_json(silent=True) or {}
    query = (data.get('query') or '').strip()

    if not query:
        return jsonify({'error': 'query is required'}), 400

    if not freesound_client.is_configured():
        return jsonify({'error': _FREESOUND_NOT_CONFIGURED_ERROR}), 503

    try:
        audio = freesound_client.search_sounds(query)
    except StockMediaCallError as exc:
        return jsonify({'error': str(exc)}), 500

    return jsonify({'audio': audio})


@app.route('/premiere/upload_footage', methods=['POST'])
def premiere_upload_footage():
    uploaded = request.files.get('file')
    if uploaded is None or not uploaded.filename:
        return jsonify({'error': 'file is required (multipart field "file")'}), 400

    try:
        section_index = int(request.form.get('section_index'))
    except (TypeError, ValueError):
        return jsonify({'error': 'section_index is required and must be an integer'}), 400

    project_id = (request.form.get('project_id') or '').strip() or next_premiere_project_id()

    footage_bytes = uploaded.read()
    if len(footage_bytes) > MAX_FOOTAGE_SIZE_MB * 1024 * 1024:
        return jsonify({'error': f'file exceeds max size of {MAX_FOOTAGE_SIZE_MB}MB'}), 400

    footage_dir = premiere_footage_dir(project_id)
    footage_dir.mkdir(parents=True, exist_ok=True)
    filename = secure_filename(uploaded.filename) or 'footage'
    saved_path = footage_dir / f'{section_index}_{filename}'
    saved_path.write_bytes(footage_bytes)
    remux_for_reliable_playback(saved_path)

    # premiere_exports/ is served statically by the same server serving
    # html/js/css (see premiere-plugin/README.md) - a path relative to the
    # repo root, not footage_path's absolute filesystem path (which is what
    # Premiere itself needs), lets index.html preview the upload in a
    # <video> tag.
    preview_url = '/' + saved_path.relative_to(PREMIERE_EXPORTS_DIR.parent).as_posix()

    return jsonify({'project_id': project_id, 'footage_path': str(saved_path), 'preview_url': preview_url})


_STOCK_MEDIA_EXTENSION_RE = re.compile(r'^[a-z0-9]{1,5}$')


@app.route('/premiere/download_stock_media', methods=['POST'])
def premiere_download_stock_media():
    # Downloads a stock-media pick (Pexels/Internet Archive/Library of
    # Congress video, Freesound audio - see js/paper-extract.js's
    # buildMediaVideoOption/buildMediaAudioOption) to a real local file the
    # moment it's picked, rather than leaving it as a bare remote URL - see
    # premiere_bridge.py's own comment on why neither export path
    # (Premiere or the ffmpeg render) can use a URL directly. Mirrors
    # /premiere/upload_footage's response shape (project_id + preview_url),
    # just sourced by download instead of a multipart upload.
    data = request.get_json(silent=True) or {}

    try:
        section_index = int(data.get('section_index'))
    except (TypeError, ValueError):
        return jsonify({'error': 'section_index is required and must be an integer'}), 400

    kind = data.get('kind')
    if kind not in ('video', 'audio'):
        return jsonify({'error': "kind must be 'video' or 'audio'"}), 400

    url = (data.get('url') or '').strip()
    if not url:
        return jsonify({'error': 'url is required'}), 400

    project_id = (data.get('project_id') or '').strip() or next_premiere_project_id()

    # Extension from the URL's own path if it looks like a real one,
    # otherwise a sane default per kind - a Freesound/Pexels/archive.org
    # URL's path segment is usually the real filename, but not guaranteed.
    url_extension = Path(urlparse(url).path).suffix.lstrip('.').lower()
    extension = url_extension if _STOCK_MEDIA_EXTENSION_RE.match(url_extension) else ('mp4' if kind == 'video' else 'mp3')

    stock_dir = premiere_stock_media_dir(project_id)
    stock_dir.mkdir(parents=True, exist_ok=True)
    saved_path = stock_dir / f'{section_index}_{kind}.{extension}'

    try:
        download_stock_media_to_disk(url, saved_path)
    except (requests.RequestException, ValueError, OSError) as exc:
        return jsonify({'error': f'Could not download media: {exc}'}), 502
    remux_for_reliable_playback(saved_path)

    preview_url = '/' + saved_path.relative_to(PREMIERE_EXPORTS_DIR.parent).as_posix()

    return jsonify({'project_id': project_id, 'preview_url': preview_url})


@app.route('/premiere/upload_narration', methods=['POST'])
def premiere_upload_narration():
    # Persists the presenter's recorded documentary-intent narration to
    # disk (see js/paper-extract.js's Record Your Intent flow) - mirrors
    # /premiere/upload_footage's shape (lazily allocates a project_id when
    # none is given yet), minus section_index since there's one narration
    # recording per project, not one per shot. Playback within the current
    # session still uses the in-memory recording directly (see
    # recordedNarrationUrl in js/paper-extract.js) - this is purely so a
    # real file exists on disk, independent of that.
    uploaded = request.files.get('file')
    if uploaded is None or not uploaded.filename:
        return jsonify({'error': 'file is required (multipart field "file")'}), 400

    project_id = (request.form.get('project_id') or '').strip() or next_premiere_project_id()

    audio_bytes = uploaded.read()
    if len(audio_bytes) > MAX_AUDIO_SIZE_MB * 1024 * 1024:
        return jsonify({'error': f'audio exceeds max size of {MAX_AUDIO_SIZE_MB}MB'}), 400

    narration_dir = premiere_narration_dir(project_id)
    narration_dir.mkdir(parents=True, exist_ok=True)
    filename = secure_filename(uploaded.filename) or 'narration.webm'
    saved_path = narration_dir / filename
    saved_path.write_bytes(audio_bytes)
    remux_for_reliable_playback(saved_path)

    # Same static-file-server convention as /premiere/upload_footage's
    # preview_url above - repo-root-relative, served by the plain
    # http.server hosting html/js/css, not the Flask backend itself.
    preview_url = '/' + saved_path.relative_to(PREMIERE_EXPORTS_DIR.parent).as_posix()

    return jsonify({'project_id': project_id, 'preview_url': preview_url})


@app.route('/premiere/upload_media_bank_item', methods=['POST'])
def premiere_upload_media_bank_item():
    # Saves a supplementary recorded/uploaded audio or video clip to disk
    # for storyboard.html's "Your Media Bank" module (js/paper-extract.js's
    # Record Audio/Record Video/Upload File wiring) - unlike
    # /premiere/upload_narration (one fixed recording per project), this is
    # an open-ended list, so each file is timestamp-prefixed to avoid
    # collisions between same-named uploads rather than overwriting.
    uploaded = request.files.get('file')
    if uploaded is None or not uploaded.filename:
        return jsonify({'error': 'file is required (multipart field "file")'}), 400

    project_id = (request.form.get('project_id') or '').strip() or next_premiere_project_id()

    media_bytes = uploaded.read()
    if len(media_bytes) > MAX_FOOTAGE_SIZE_MB * 1024 * 1024:
        return jsonify({'error': f'file exceeds max size of {MAX_FOOTAGE_SIZE_MB}MB'}), 400

    media_dir = premiere_media_bank_dir(project_id)
    media_dir.mkdir(parents=True, exist_ok=True)
    filename = secure_filename(uploaded.filename) or 'media'
    timestamp = datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')
    saved_path = media_dir / f'{timestamp}_{filename}'
    saved_path.write_bytes(media_bytes)
    remux_for_reliable_playback(saved_path)

    # Same static-file-server convention as /premiere/upload_footage's
    # preview_url above - repo-root-relative, served by the plain
    # http.server hosting html/js/css, not the Flask backend itself.
    preview_url = '/' + saved_path.relative_to(PREMIERE_EXPORTS_DIR.parent).as_posix()

    return jsonify({'project_id': project_id, 'preview_url': preview_url})


@app.route('/premiere/export', methods=['POST'])
def premiere_export():
    data = request.get_json(silent=True) or {}
    sections = data.get('sections')

    if not isinstance(sections, list) or not sections:
        return jsonify({'error': 'sections is required and must be a non-empty list'}), 400

    project_id = (data.get('project_id') or '').strip() or next_premiere_project_id()

    shots = []
    for i, section in enumerate(sections):
        if not isinstance(section, dict):
            return jsonify({'error': f'section {i} must be an object'}), 400
        index = section.get('index')
        title = (section.get('title') or '').strip()
        act = section.get('act')
        if not isinstance(index, int) or not title or not isinstance(act, str) or not act.strip():
            return jsonify({'error': f'section {i} must have an integer "index", non-empty "title", and non-empty "act"'}), 400
        act = act.strip()

        selected_video = section.get('selected_video') or {}
        selected_audio = section.get('selected_audio') or {}
        shots.append({
            'index': index,
            'title': title,
            'act': act,
            'narration': (section.get('narration') or '').strip(),
            # Real local path to the recorded/dragged narration audio (see
            # js/paper-extract.js's runExportForPremiere) - written here too,
            # even though the plugin itself has no audio support yet, so
            # this file doesn't silently drop the one piece of audio every
            # other pipeline (the ffmpeg render in particular) depends on.
            'narration_audio_path': section.get('narration_audio_path') or None,
            # Uploaded footage (a real local path this machine's Premiere can
            # import directly) takes priority; otherwise this just notes
            # which Pexels clip was picked - the file itself isn't
            # downloaded/mirrored here, per Pexels' terms and simplicity.
            'footage_path': section.get('uploaded_footage_path') or None,
            'stock_video_source_url': selected_video.get('source_url'),
            'stock_audio_preview_url': selected_audio.get('preview_url'),
            'edit_plan': section.get('edit_plan') or None,
        })

    project_dir_path = premiere_project_dir(project_id)
    project_dir_path.mkdir(parents=True, exist_ok=True)
    edit_plan_path = project_dir_path / 'edit_plan.json'
    edit_plan_path.write_text(json.dumps({'shots': shots}, indent=2))

    return jsonify({
        'project_id': project_id,
        'folder_path': str(project_dir_path),
        'edit_plan_path': str(edit_plan_path),
    })


@app.route('/ingest/pptx', methods=['POST'])
def ingest_pptx():
    uploaded = request.files.get('file')
    if uploaded is None or not uploaded.filename:
        return jsonify({'error': 'file is required (multipart field "file")'}), 400
    if not uploaded.filename.lower().endswith('.pptx'):
        return jsonify({'error': 'file must be a .pptx'}), 400

    project_id = next_rehearsal_run_id()
    target_dir = project_dir(project_id)
    target_dir.mkdir(parents=True, exist_ok=True)
    pptx_path = target_dir / 'source.pptx'
    uploaded.save(str(pptx_path))

    if pptx_path.stat().st_size > MAX_PPTX_SIZE_MB * 1024 * 1024:
        return jsonify({'error': f'.pptx exceeds max size of {MAX_PPTX_SIZE_MB}MB'}), 400

    try:
        slide_paths = render_pptx_to_slides(pptx_path, snapshots_dir(project_id), ingest_config)
    except SofficeNotFoundError as exc:
        return jsonify({'error': str(exc)}), 503
    except PptxRenderError as exc:
        return jsonify({'error': str(exc)}), 500

    slides = [
        {
            'slide_index': i,
            'snapshot_image': f'projects/{project_id}/snapshots/{path.name}',
        }
        for i, path in enumerate(slide_paths, start=1)
    ]

    return jsonify({'project_id': project_id, 'slide_count': len(slides), 'slides': slides})


@app.route('/transcribe', methods=['POST'])
def transcribe():
    uploaded = request.files.get('file')
    if uploaded is None or not uploaded.filename:
        return jsonify({'error': 'file is required (multipart field "file")'}), 400

    audio_bytes = uploaded.read()
    if len(audio_bytes) > MAX_AUDIO_SIZE_MB * 1024 * 1024:
        return jsonify({'error': f'audio exceeds max size of {MAX_AUDIO_SIZE_MB}MB'}), 400

    if not transcription_client.is_configured():
        return jsonify({
            'error': 'Transcription requires an LLM API key. Set OPENAI_API_KEY (or OPENROUTER_API_KEY) in backend/.env.'
        }), 503

    try:
        result = transcription_client.transcribe(audio_bytes, uploaded.filename)
    except TranscriptionCallError as exc:
        return jsonify({'error': str(exc)}), 500

    return jsonify(result)


@app.route('/align', methods=['POST'])
def align():
    data = request.get_json(silent=True) or {}
    slide_activations = data.get('slide_activations')
    total_duration_seconds = data.get('total_duration_seconds')
    words = data.get('words')
    full_text_fallback = data.get('text')

    if not isinstance(slide_activations, list) or not slide_activations:
        return jsonify({'error': 'slide_activations is required and must be a non-empty list'}), 400
    if not isinstance(total_duration_seconds, (int, float)) or total_duration_seconds <= 0:
        return jsonify({'error': 'total_duration_seconds is required and must be a positive number'}), 400
    if not (isinstance(words, list) and words) and not full_text_fallback:
        return jsonify({'error': 'one of words or text is required'}), 400

    try:
        slides = align_transcript(slide_activations, total_duration_seconds, words=words, full_text_fallback=full_text_fallback)
    except AlignError as exc:
        return jsonify({'error': str(exc)}), 400

    return jsonify({'slides': slides})


@app.route('/learning_objectives/suggest', methods=['POST'])
def suggest_learning_objectives():
    data = request.get_json(silent=True) or {}
    audience = (data.get('audience') or '').strip()
    scope_label = (data.get('scope_label') or '').strip()
    slides = data.get('slides')

    if not audience:
        return jsonify({'error': 'audience is required'}), 400
    if not scope_label:
        return jsonify({'error': 'scope_label is required'}), 400
    if not isinstance(slides, list) or not slides:
        return jsonify({'error': 'slides is required and must be a non-empty list'}), 400

    if not objectives_client.is_configured():
        return jsonify({
            'error': 'Suggesting learning objectives requires an LLM API key. Set OPENAI_API_KEY (or OPENROUTER_API_KEY) in backend/.env.'
        }), 503

    try:
        result = objectives_client.suggest_objectives(audience, scope_label, slides)
    except ObjectivesLLMCallError as exc:
        return jsonify({'error': str(exc)}), 500

    return jsonify({'objectives': result['objectives'], 'audience_questions': result['audience_questions']})


_ASSESSMENT_NOT_CONFIGURED_ERROR = (
    'Simulating an audience requires an LLM API key. Set OPENAI_API_KEY (or OPENROUTER_API_KEY) in backend/.env.'
)


@app.route('/assessment/generate_question', methods=['POST'])
def assessment_generate_question():
    data = request.get_json(silent=True) or {}
    objective_text = (data.get('objective_text') or '').strip()
    scope_label = (data.get('scope_label') or '').strip()
    slides = data.get('slides')

    if not objective_text:
        return jsonify({'error': 'objective_text is required'}), 400
    if not scope_label:
        return jsonify({'error': 'scope_label is required'}), 400
    if not isinstance(slides, list) or not slides:
        return jsonify({'error': 'slides is required and must be a non-empty list'}), 400

    if not assessment_client.is_configured():
        return jsonify({'error': _ASSESSMENT_NOT_CONFIGURED_ERROR}), 503

    try:
        result = assessment_client.generate_question(objective_text, scope_label, slides)
    except AssessmentLLMCallError as exc:
        return jsonify({'error': str(exc)}), 500

    return jsonify(result)


@app.route('/assessment/simulate_answer', methods=['POST'])
def assessment_simulate_answer():
    data = request.get_json(silent=True) or {}
    audience = (data.get('audience') or '').strip()
    question = (data.get('question') or '').strip()
    cumulative_slides = data.get('cumulative_slides')

    if not audience:
        return jsonify({'error': 'audience is required'}), 400
    if not question:
        return jsonify({'error': 'question is required'}), 400
    if not isinstance(cumulative_slides, list) or not cumulative_slides:
        return jsonify({'error': 'cumulative_slides is required and must be a non-empty list'}), 400

    if not assessment_client.is_configured():
        return jsonify({'error': _ASSESSMENT_NOT_CONFIGURED_ERROR}), 503

    try:
        answer = assessment_client.simulate_answer(audience, question, cumulative_slides)
    except AssessmentLLMCallError as exc:
        return jsonify({'error': str(exc)}), 500

    return jsonify({'answer': answer})


@app.route('/assessment/grade_answers', methods=['POST'])
def assessment_grade_answers():
    data = request.get_json(silent=True) or {}
    question = (data.get('question') or '').strip()
    rubric = (data.get('rubric') or '').strip()
    reference_answer = (data.get('reference_answer') or '').strip()
    answers = data.get('answers')

    if not question or not rubric:
        return jsonify({'error': 'question and rubric are required'}), 400
    if not isinstance(answers, list) or not answers or not all(isinstance(a, str) and a.strip() for a in answers):
        return jsonify({'error': 'answers is required and must be a non-empty list of non-empty strings'}), 400

    if not assessment_client.is_configured():
        return jsonify({'error': _ASSESSMENT_NOT_CONFIGURED_ERROR}), 503

    try:
        grades = assessment_client.grade_answers(question, rubric, reference_answer, answers)
    except AssessmentLLMCallError as exc:
        return jsonify({'error': str(exc)}), 500

    return jsonify({'grades': grades})


@app.route('/assessment/suggest_fix', methods=['POST'])
def assessment_suggest_fix():
    data = request.get_json(silent=True) or {}
    objective_text = (data.get('objective_text') or '').strip()
    scope_label = (data.get('scope_label') or '').strip()
    slides = data.get('slides')
    graded_samples = data.get('graded_samples') or []
    blocked_objective_texts = data.get('blocked_objective_texts') or []

    if not objective_text:
        return jsonify({'error': 'objective_text is required'}), 400
    if not scope_label:
        return jsonify({'error': 'scope_label is required'}), 400
    if not isinstance(slides, list) or not slides:
        return jsonify({'error': 'slides is required and must be a non-empty list'}), 400

    if not assessment_client.is_configured():
        return jsonify({'error': _ASSESSMENT_NOT_CONFIGURED_ERROR}), 503

    try:
        result = assessment_client.suggest_fix(objective_text, scope_label, slides, graded_samples, blocked_objective_texts)
    except AssessmentLLMCallError as exc:
        return jsonify({'error': str(exc)}), 500

    return jsonify(result)


@app.route('/projects/save', methods=['POST'])
def save_project_route():
    data = request.get_json(silent=True) or {}
    project_id = data.get('project_id')
    slides = data.get('slides')
    deps = data.get('dependencies') or []
    audience = data.get('audience')
    learning_objectives = data.get('learning_objectives') or {'presentation': [], 'sections': []}

    if not project_id:
        return jsonify({'error': 'project_id is required'}), 400
    if not isinstance(slides, list) or not slides:
        return jsonify({'error': 'slides is required and must be a non-empty list'}), 400
    if not isinstance(deps, list):
        return jsonify({'error': 'dependencies must be a list'}), 400

    slide_indices = {s.get('slide_index') for s in slides}
    for dep in deps:
        prereq = dep.get('prerequisite_slide_index')
        dependent = dep.get('dependent_slide_index')
        if prereq not in slide_indices or dependent not in slide_indices:
            return jsonify({'error': f'dependency references a slide_index not present in slides: {dep}'}), 400
        if prereq == dependent:
            return jsonify({'error': f'dependency cannot have the same slide as both prerequisite and dependent: {dep}'}), 400

    project_data = {
        'project_id': project_id,
        'created_at': datetime.now(timezone.utc).isoformat(),
        'source': {
            'pptx_filename': data.get('pptx_filename'),
            'transcript_source': data.get('transcript_source'),
        },
        'audience': audience,
        'learning_objectives': learning_objectives,
        'slides': slides,
        'dependencies': deps,
        'objective_dependencies': data.get('objective_dependencies') or [],
    }

    path = save_project(project_id, project_data)
    return jsonify({'project_id': project_id, 'path': str(path.relative_to(PROJECTS_DIR.parent))})


if __name__ == '__main__':
    # host 0.0.0.0 + $PORT (falling back to 127.0.0.1:8000 for local dev,
    # unchanged from before) - Render (see backend/Dockerfile) assigns its
    # own port via $PORT and routes external traffic to it; binding only to
    # 127.0.0.1 there would make the service unreachable from outside the
    # container.
    # threaded=True: without it, a single slow/hung request (e.g. an LLM call
    # stuck on a broken network path) blocks every other request - including
    # completely unrelated ones - until it resolves or times out.
    port = int(os.environ.get('PORT', 8000))
    host = '0.0.0.0' if 'PORT' in os.environ else '127.0.0.1'
    app.run(host=host, port=port, threaded=True)
