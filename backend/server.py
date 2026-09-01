"""
Local HTTP service exposing the structure-aware semantic segmentation
pipeline (see segmentation/) to the static frontend in rehearsal_mvp_kg/,
which has no server or package manager of its own. Run with:
python server.py (listens on http://127.0.0.1:8000).

Optional LLM-based segment labeling (richer topic labels/entities/summaries
than the local fallback) activates automatically when a proxy key is present:
  PROXY_API_KEY or OPENROUTER_API_KEY   (+ PROXY_BASE_URL)
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
import base64
import hashlib
import io
import json
import os
import random
import re
import threading
import time
import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv
from PIL import Image

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
from narration_llm import NarrationLLMClient, NarrationLLMCallError
from media_query_llm import MediaQueryLLMClient, MediaQueryLLMCallError
from edit_plan_llm import EditPlanLLMClient, EditPlanLLMCallError
from sketch_llm import SketchLLMClient, SketchLLMCallError, _build_image_prompt
from shot_plan_llm import ShotPlanLLMClient, ShotPlanLLMCallError, framing_directive, wildness_directive
from animate_llm import (
    AnimateLLMClient, AnimateLLMCallError, TECHNIQUES as ANIMATE_TECHNIQUES,
    build_sequence_prompts, compose_gif,
)
from documentary_modes import DOCUMENTARY_MODE_KEYS, DOCUMENTARY_MODES
from documentary_techniques import DOCUMENTARY_TECHNIQUES, DOCUMENTARY_TECHNIQUE_KEYS
import movie_render
from stock_media import PexelsClient, InternetArchiveClient, LibraryOfCongressClient, FreesoundClient, StockMediaCallError
from premiere_bridge import (
    next_premiere_project_id, premiere_project_dir, premiere_footage_dir, premiere_sketch_dir,
    premiere_animated_sketch_dir, premiere_narration_dir, premiere_media_bank_dir, premiere_stock_media_dir,
    premiere_moodboard_dir, premiere_moodboard_ref_dir, premiere_reconstruct_dir, premiere_eval_dir,
    remux_for_reliable_playback, download_stock_media_to_disk, resolve_static_preview_path, PREMIERE_EXPORTS_DIR,
)
import moodboard_media
import depth_media
import sharp_media
from moodboard_llm import MoodboardLLMClient, MoodboardLLMCallError

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

# A short per-section body snippet the moodboard distillation gets alongside
# each section's title, for better arc placement without shipping full bodies
# (see /moodboard/distill and narrative_arc_llm.distill_from_moodboard).
MAX_SECTION_SNIPPET_CHARS = 300

# Bounds on index.html's edit-plan request (see /paper/edit_plan below) -
# this call only needs each shot's already-drafted visual/narration (not
# its full original section text), so the per-shot cap is tighter still.
MAX_EDIT_PLAN_SECTIONS = 100
MAX_EDIT_PLAN_TEXT_CHARS = 500

# Bound on index.html's sketch request (see /paper/generate_sketch below) -
# same role as MAX_EDIT_PLAN_TEXT_CHARS, just for the one 'visual' string
# a sketch prompt is built from.
MAX_SKETCH_VISUAL_CHARS = 1000

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

# Quiet, file-backed snapshots for the paper/storyboard workspace. These are
# intentionally separate from Premiere exports and the presentation-ingest
# projects: they contain only the reusable paper sections and moodboard source
# links needed to resume a documentary later.
PAPER_SNAPSHOTS_DIR = Path(__file__).resolve().parent.parent / 'paper_snapshots'
_PAPER_SNAPSHOT_ID_RE = re.compile(r'^[A-Za-z0-9_-]{8,100}$')

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
_narration_nlp = None
_filmability_cache = {}
_filmability_cache_lock = threading.Lock()


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


def _get_narration_nlp():
    """Return the lightweight spaCy pipeline used by narration spans.

    The main segmentation pipeline also owns a spaCy model, but constructing
    it pulls in the embedding model as well. Narration is an interactive path,
    so keep its first request independent and cheap while still reusing the
    same installed model and tokenizer/tagger/NER components.
    """
    global _narration_nlp
    if _narration_nlp is None:
        import spacy
        _narration_nlp = spacy.load('en_core_web_sm')
    return _narration_nlp


def _narration_span_fallback(span):
    """Best-effort local label when no classifier key is available."""
    text = str(span.get('text') or '').strip()
    label = str(span.get('label') or '').upper()
    lower = text.lower()
    filler_words = {
        'also', 'because', 'everything', 'it', 'many', 'more', 'nothing',
        'something', 'that', 'the', 'this', 'things', 'what', 'which', 'you',
    }
    if not text or (len(text.split()) <= 1 and lower in filler_words):
        return {'bucket': 'ignore', 'query': '', 'visual_proxy': '', 'salience': 0.0}
    abstract_terms = (
        'algorithm', 'analysis', 'accuracy', 'concept', 'dataset', 'equation',
        'framework', 'hypothesis', 'method', 'model', 'network', 'parameter',
        'probability', 'process', 'research', 'system', 'theory', 'variable',
    )
    lower_tokens = set(re.findall(r'[a-z]+', lower))
    if any(term in lower_tokens for term in abstract_terms) or label in {'CARDINAL', 'PERCENT', 'MONEY', 'QUANTITY'}:
        proxy = 'researchers comparing charts and data'
        return {'bucket': 'abstract', 'query': proxy, 'visual_proxy': proxy, 'salience': 0.55}
    return {
        'bucket': 'depictable',
        'query': ' '.join(text.split()[:8]),
        'visual_proxy': '',
        'salience': float(span.get('salience') or 0.5),
    }


def _normalise_filmability_results(raw_results, candidates):
    by_range = {(int(item.get('start', -1)), int(item.get('end', -1))): item
                for item in candidates if isinstance(item, dict)}
    normalised = []
    seen = set()
    for item in raw_results if isinstance(raw_results, list) else []:
        if not isinstance(item, dict):
            continue
        try:
            start, end = int(item.get('start')), int(item.get('end'))
        except (TypeError, ValueError):
            continue
        source = by_range.get((start, end))
        if not source or (start, end) in seen:
            continue
        bucket = str(item.get('bucket') or '').strip().lower()
        if bucket not in {'depictable', 'abstract', 'ignore'}:
            continue
        seen.add((start, end))
        normalised.append({
            'text': source.get('text', ''),
            'start': start,
            'end': end,
            'kind': source.get('kind', ''),
            'label': source.get('label', ''),
            'bucket': bucket,
            'query': str(item.get('query') or '').strip()[:160],
            'visual_proxy': str(item.get('visual_proxy') or '').strip()[:240],
            'salience': max(0.0, min(1.0, float(item.get('salience') or source.get('salience') or 0))),
        })
    # Keep the UI focused: the strongest three visual beats are enough to seed
    # footage while the full local candidate set remains available for a later
    # reclassification if the narration changes.
    normalised.sort(key=lambda item: (-item['salience'], item['start']))
    chosen = []
    for item in normalised:
        if item['bucket'] == 'ignore':
            continue
        if any(item['start'] < other['end'] and other['start'] < item['end'] for other in chosen):
            continue
        chosen.append(item)
        if len(chosen) >= 3:
            break
    return sorted(chosen, key=lambda item: item['start'])


feedback_client = FeedbackLLMClient()
ingest_config = IngestConfig()
transcription_client = TranscriptionClient(model=ingest_config.transcription_model)
objectives_client = ObjectivesLLMClient()
assessment_client = AssessmentLLMClient()
narrative_arc_client = NarrativeArcLLMClient()
narration_client = NarrationLLMClient()
moodboard_client = MoodboardLLMClient()
media_query_client = MediaQueryLLMClient()
edit_plan_client = EditPlanLLMClient()
sketch_client = SketchLLMClient()
shot_plan_client = ShotPlanLLMClient()
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
            'error': 'segmentation_carta requires a proxy LLM key (no local fallback). Set PROXY_API_KEY (and PROXY_BASE_URL) in backend/.env.'
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
            'error': 'Feedback requires a proxy LLM key. Set PROXY_API_KEY (and PROXY_BASE_URL) in backend/.env.'
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
            'error': 'Feedback requires a proxy LLM key. Set PROXY_API_KEY (and PROXY_BASE_URL) in backend/.env.'
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
    'Arranging sections into a narrative arc requires a proxy LLM key. Set PROXY_API_KEY (and PROXY_BASE_URL) in backend/.env.'
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


# Cap on how many technique labels we forward to an LLM (a stylistic hint, not
# a payload) and how long each may be - keeps a malformed/oversized client
# request from bloating the prompt. Only the shared technique catalog is valid:
# track roles such as Primary/Cutaway must never leak into this stylistic axis.
MAX_TECHNIQUES = 12
MAX_TECHNIQUE_CHARS = 80


def _parse_techniques(data):
    """Optional list of filming/editing technique labels the presenter has
    selected (js/paper-extract.js's selectedTechniques). Closed-vocabulary
    stylistic hints appended to shot/cutaway/storyboard prompts. Returns a
    cleaned list (possibly empty); tolerant of a non-list or junk entries."""
    raw = data.get('techniques')
    if not isinstance(raw, list):
        return []
    out = []
    for t in raw:
        if isinstance(t, str):
            technique = t.strip()[:MAX_TECHNIQUE_CHARS]
            if technique in DOCUMENTARY_TECHNIQUE_KEYS and technique not in out:
                out.append(technique)
        if len(out) >= MAX_TECHNIQUES:
            break
    return out


def _parse_technique_variants(data):
    """Read optional per-image technique subsets for Act Board example batches.

    Each variant is a small list from the shared documentary-technique
    vocabulary. Invalid values are discarded so a malformed client payload
    cannot leak arbitrary prompt text into the image-generation request.
    """
    raw = data.get('technique_variants')
    if not isinstance(raw, list):
        return []
    variants = []
    for variant in raw[:20]:
        if not isinstance(variant, list):
            variants.append([])
            continue
        cleaned = []
        for value in variant:
            if isinstance(value, str):
                technique = value.strip()[:MAX_TECHNIQUE_CHARS]
                if technique in DOCUMENTARY_TECHNIQUE_KEYS and technique not in cleaned:
                    cleaned.append(technique)
                    # Act Board image options are intentionally single-technique
                    # variants so each generated image has one clear visual
                    # direction. Ignore any extra values from older clients.
                    if len(cleaned) >= 1:
                        break
            if len(cleaned) >= MAX_TECHNIQUES:
                break
        variants.append(cleaned)
    return variants


def _parse_generation_context(data):
    """Read the Act Board's visual context as distinct API fields.

    Timeline callers may still provide only ``scene_notes``/``narration``;
    these fields are optional so that older requests remain compatible.
    """
    specific_phrase = str(data.get('specific_phrase') or '').strip()[:MAX_STORYBOARD_SECTION_CHARS]
    parent_narration = str(data.get('parent_narration') or '').strip()[:MAX_NARRATION_TRANSCRIPT_CHARS]
    raw_linked = data.get('linked_footage_phrases') or []
    if isinstance(raw_linked, str):
        raw_linked = [raw_linked]
    linked = []
    if isinstance(raw_linked, list):
        for phrase in raw_linked:
            if not isinstance(phrase, str):
                continue
            value = phrase.strip()[:MAX_STORYBOARD_SECTION_CHARS]
            if value and value not in linked:
                linked.append(value)
            if len(linked) >= 20:
                break
    return specific_phrase, parent_narration, linked


def _generation_context_notes(scene_notes, specific_phrase='', parent_narration='', linked_phrases=None):
    """Build prompt notes from the separate Act Board context fields."""
    parts = []
    if specific_phrase:
        parts.append(
            'Specific image-generation phrase (AUTHORITATIVE subject focus): '
            + specific_phrase)
    if parent_narration:
        parts.append('Parent narration context:\n' + parent_narration)
    if linked_phrases:
        parts.append(
            'Linked footage phrases (avoid duplicate visuals): '
            + ' → '.join(linked_phrases))
    if (scene_notes or '').strip():
        parts.append(scene_notes.strip())
    return '\n'.join(parts)[:MAX_STORYBOARD_SECTION_CHARS]


def _unified_shot_visual_field(user_visual='', generated_visual='', animation_direction=''):
    """Combine the editable visual field and camera direction into one
    generation-ready shot-plan description.

    The shot-plan LLM is asked to rewrite the user's visual field and camera
    choice as one coherent generation-ready description. Prefer that rewritten
    value when it exists; the deterministic fallback is used only when the
    planner did not return a visual description.
    """
    generated = str(generated_visual or '').strip()
    motion = str(animation_direction or '').strip()
    if generated:
        if not motion or motion.casefold() in generated.casefold():
            return generated[:MAX_SKETCH_VISUAL_CHARS]
        # The planner normally integrates the motion itself. If it omitted
        # the exact user wording, retain that direction explicitly rather than
        # allowing the old planner movement to become the only motion cue.
        return (
            f'{generated.rstrip(".").strip()}. '
            f'Camera animation: {motion.rstrip(".").strip()}.'
        )[:MAX_SKETCH_VISUAL_CHARS]
    visual = str(user_visual or '').strip()
    if not visual and not motion:
        return ''
    if not visual:
        return f'Camera animation: {motion.rstrip(".").strip()}.'
    if not motion:
        return visual
    # Avoid repeating a motion the user already included in the visual field.
    if motion.casefold() in visual.casefold():
        return visual[:MAX_SKETCH_VISUAL_CHARS]
    return (
        f'{visual.rstrip(".").strip()}. '
        f'Camera animation: {motion.rstrip(".").strip()}.'
    )[:MAX_SKETCH_VISUAL_CHARS]


ACT_BOARD_CAMERA_MOVEMENT_TO_PLAN = {
    'Follow shot': 'tracking',
    'Pan': 'pan',
    'Tilt': 'tilt',
    'Push-in': 'push_in',
    'Pull-back': 'pull_out',
    'Whip pan': 'pan',
    'Slow motion': 'static',
    'Time-lapse': 'static',
}


def _parse_moodboard_profiles(data):
    """Optional list of analyzed moodboard reference profiles the frontend
    sends to anchor shot generation in the moodboard's visual style (see
    js/paper-extract.js's moodboardProfilesForGeneration). Cleaned/capped;
    tolerant of a non-list or junk entries. Only the fields shot_plan_llm's
    _format_moodboard reads are kept."""
    raw = data.get('moodboard')
    if not isinstance(raw, list):
        return []
    out = []
    for ref in raw[:MAX_MOODBOARD_REFERENCES]:
        if not isinstance(ref, dict):
            continue
        out.append({
            'title': (ref.get('title') or '').strip()[:MAX_STORYBOARD_SECTION_CHARS],
            'visual_style': (ref.get('visual_style') or '').strip()[:MAX_MOODBOARD_REF_FIELD_CHARS],
            'tone': (ref.get('tone') or '').strip()[:200],
            'pacing': (ref.get('pacing') or '').strip()[:200],
            'observed_techniques': [t for t in (ref.get('observed_techniques') or []) if isinstance(t, str)][:8],
        })
    return out


@app.route('/paper/suggest_arcs', methods=['POST'])
def paper_suggest_arcs():
    # Ranked arc recommendations from the presenter's chosen focus statements
    # (suggested chips and/or their own typed-in description), grounded in the
    # paper's abstract + sections. (The recorded-narration transcript that used
    # to feed this was removed with the recorder UI.) Once the presenter accepts
    # a recommendation/alternative/custom arc, its parts become the narrative-act
    # groups shown right away (js/paper-extract.js's runAcceptArc) - no server
    # call to place paper sections into them; the presenter does that manually.
    data = request.get_json(silent=True) or {}
    abstract = (data.get('abstract') or '').strip()[:MAX_ABSTRACT_CHARS]

    focus_statements_raw = data.get('focus_statements')
    focus_statements = None
    if focus_statements_raw is not None:
        if (not isinstance(focus_statements_raw, list) or len(focus_statements_raw) > MAX_FOCUS_STATEMENTS
                or not all(isinstance(s, str) for s in focus_statements_raw)):
            return jsonify({'error': f'focus_statements must be a list of up to {MAX_FOCUS_STATEMENTS} strings'}), 400
        focus_statements = [s.strip()[:MAX_FOCUS_STATEMENT_CHARS] for s in focus_statements_raw if s.strip()]

    # The paper's real sections (index + title), so the arc suggestions can
    # map each section into a part - the frontend previews that mapping and
    # auto-places the sections into the chosen arc's chapters (see
    # js/paper-extract.js's renderArcSuggestion/runAcceptArc). Optional and
    # tolerant: malformed entries are dropped rather than rejected.
    sections = None
    sections_raw = data.get('sections')
    if isinstance(sections_raw, list):
        sections = [
            {
                'index': s['index'],
                'title': (s.get('title') or '').strip()[:MAX_STORYBOARD_SECTION_CHARS],
                'snippet': (s.get('snippet') or '').strip()[:MAX_SECTION_SNIPPET_CHARS],
            }
            for s in sections_raw[:MAX_STORYBOARD_SECTIONS]
            if isinstance(s, dict) and isinstance(s.get('index'), int)
        ]

    # Focus statements are optional when the paper itself is available. The
    # paper-only setup path asks the model to infer a fitting documentary arc
    # from the extracted abstract/sections; explicit focus statements remain
    # an optional creative override.
    if not focus_statements and not abstract and not sections:
        return jsonify({'error': 'focus_statements, abstract, or sections is required'}), 400

    if not narrative_arc_client.is_configured():
        return jsonify({'error': _NARRATIVE_ARC_NOT_CONFIGURED_ERROR}), 503

    try:
        recommended, alternatives = narrative_arc_client.suggest_arcs_from_intent(
            focus_statements, abstract, sections)
    except NarrativeArcLLMCallError as exc:
        return jsonify({'error': str(exc)}), 500

    return jsonify({'recommended': recommended, 'alternatives': alternatives})


@app.route('/paper/suggest_narration', methods=['POST'])
def paper_suggest_narration():
    """Draft one readable voice-over passage for the current paper section.

    The act title/description tells the writer what this scene should do in
    the arc; the section text remains the factual source of the narration.
    This returns text only - the presenter still records the voice track.
    """
    data = request.get_json(silent=True) or {}
    section_title = (data.get('section_title') or '').strip()[:MAX_STORYBOARD_SECTION_CHARS]
    section_text = (data.get('section_text') or '').strip()[:MAX_STORYBOARD_SECTION_CHARS]
    act_title = (data.get('act_title') or '').strip()[:MAX_STORYBOARD_SECTION_CHARS]
    act_description = (data.get('act_description') or '').strip()[:MAX_STORYBOARD_SECTION_CHARS]
    abstract = (data.get('abstract') or '').strip()[:MAX_ABSTRACT_CHARS]
    mode = (data.get('documentary_mode') or '').strip()[:80]
    max_sentences = data.get('max_sentences')
    try:
        max_sentences = int(max_sentences) if max_sentences is not None else None
    except (TypeError, ValueError):
        max_sentences = None
    if max_sentences is not None:
        max_sentences = max(1, min(max_sentences, 4))
    if not section_text and not section_title:
        return jsonify({'error': 'section_title or section_text is required'}), 400
    if not narration_client.is_configured():
        return jsonify({'error': _STORYBOARD_NOT_CONFIGURED_ERROR}), 503
    try:
        narration = narration_client.suggest(
            section_title, section_text, act_title, act_description, abstract, mode, max_sentences)
    except NarrationLLMCallError as exc:
        return jsonify({'error': str(exc)}), 500
    return jsonify({'narration': narration})


_STORYBOARD_NOT_CONFIGURED_ERROR = (
    'Generating a storyboard requires a proxy LLM key. Set PROXY_API_KEY (and PROXY_BASE_URL) in backend/.env.'
)


@app.route('/paper/snapshots/save', methods=['POST'])
def save_paper_snapshot():
    """Persist the reusable paper/storyboard source state.

    This is deliberately a quiet persistence endpoint rather than a visible
    load workflow. The frontend sends cleaned section text and moodboard
    metadata after meaningful edits; generated media and large embedded figure
    images are excluded so the snapshot stays portable and readable.
    """
    data = request.get_json(silent=True) or {}
    snapshot_id = (data.get('snapshot_id') or '').strip()
    if not _PAPER_SNAPSHOT_ID_RE.fullmatch(snapshot_id):
        return jsonify({'error': 'snapshot_id is required and must be a safe identifier'}), 400

    raw_sections = data.get('sections') or []
    if not isinstance(raw_sections, list):
        return jsonify({'error': 'sections must be a list'}), 400
    sections = []
    for raw in raw_sections:
        if not isinstance(raw, dict):
            continue
        index = raw.get('index')
        if not isinstance(index, int):
            continue
        sections.append({
            'index': index,
            'title': str(raw.get('title') or '')[:MAX_STORYBOARD_SECTION_CHARS],
            'text': str(raw.get('text') or '')[:MAX_CHARS],
            'removed': bool(raw.get('removed')),
        })

    raw_refs = data.get('youtube_references') or []
    if not isinstance(raw_refs, list):
        raw_refs = []
    youtube_references = [
        {
            'title': str(ref.get('title') or '')[:MAX_STORYBOARD_SECTION_CHARS],
            'url': str(ref.get('url') or '')[:2000],
        }
        for ref in raw_refs
        if isinstance(ref, dict) and str(ref.get('url') or '').strip()
    ]

    snapshot = {
        'snapshot_id': snapshot_id,
        'saved_at': datetime.now(timezone.utc).isoformat(),
        'label': str(data.get('label') or '')[:MAX_STORYBOARD_SECTION_CHARS],
        'sections': sections,
        'youtube_references': youtube_references,
    }
    PAPER_SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    target = PAPER_SNAPSHOTS_DIR / f'{snapshot_id}.json'
    temporary = target.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(snapshot, indent=2, ensure_ascii=False))
    temporary.replace(target)
    return jsonify({'snapshot_id': snapshot_id, 'path': str(target.relative_to(PAPER_SNAPSHOTS_DIR.parent))})


@app.route('/narration/spans', methods=['POST'])
def narration_spans():
    """Extract offset-bearing, locally filmable narration candidates.

    This route intentionally does not call an LLM. spaCy's entities, noun
    chunks, and numeric/temporal mentions make a quick deterministic first
    pass that the browser can render while the filmability classifier is
    debounced in the background.
    """
    data = request.get_json(silent=True) or {}
    text = str(data.get('text') or '').strip()[:MAX_NARRATION_TRANSCRIPT_CHARS]
    if not text:
        return jsonify({'spans': [], 'text': ''})

    doc = _get_narration_nlp()(text)
    candidates = []

    def add_candidate(start, end, kind, label='', score=0.5):
        try:
            start, end = int(start), int(end)
        except (TypeError, ValueError):
            return
        if start < 0 or end <= start or end > len(text):
            return
        raw = text[start:end]
        leading = len(raw) - len(raw.lstrip())
        trailing = len(raw.rstrip())
        start += leading
        end = start + max(0, trailing - leading)
        value = text[start:end].strip()
        words = value.split()
        if not value or not words or len(words) > 10:
            return
        if all(not char.isalnum() for char in value):
            return
        candidates.append({
            'text': value,
            'start': start,
            'end': end,
            'kind': kind,
            'label': label or kind,
            'salience': max(0.0, min(1.0, float(score))),
        })

    for ent in doc.ents:
        label = ent.label_ or 'ENTITY'
        score = 0.82 if label in {'PERSON', 'ORG', 'GPE', 'LOC', 'FAC', 'EVENT', 'PRODUCT'} else 0.68
        add_candidate(ent.start_char, ent.end_char, 'entity', label, score)

    try:
        for chunk in doc.noun_chunks:
            tokens = [token for token in chunk if not token.is_punct]
            while tokens and (tokens[0].is_stop or tokens[0].pos_ == 'DET'):
                tokens.pop(0)
            while tokens and (tokens[-1].is_stop or tokens[-1].is_punct):
                tokens.pop()
            if not tokens or all(token.is_stop for token in tokens):
                continue
            score = 0.58 + min(0.22, 0.04 * sum(token.pos_ in {'NOUN', 'PROPN'} for token in tokens))
            add_candidate(tokens[0].idx, tokens[-1].idx + len(tokens[-1]), 'noun_chunk', 'NOUN_CHUNK', score)
    except (AttributeError, ValueError):
        # A custom lightweight spaCy pipeline may omit the parser. Entities
        # and numeric/temporal spans still provide useful candidates.
        pass

    for ent in doc.ents:
        if ent.label_ in {'DATE', 'TIME', 'CARDINAL', 'ORDINAL', 'QUANTITY', 'PERCENT', 'MONEY'}:
            add_candidate(ent.start_char, ent.end_char, 'numeric_temporal', ent.label_, 0.62)

    # Catch simple duration phrases that small NER models sometimes leave as
    # separate tokens ("12 seconds", "three years") while preserving offsets.
    for match in re.finditer(r'\b(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?|%)\b', text, re.I):
        add_candidate(match.start(), match.end(), 'numeric_temporal', 'DURATION', 0.64)

    # Prefer a more specific/longer candidate when spans overlap, then return
    # source order for straightforward character-offset rendering.
    deduped = []
    for candidate in sorted(candidates, key=lambda item: (-item['salience'], -(item['end'] - item['start']), item['start'])):
        if any(candidate['start'] < existing['end'] and existing['start'] < candidate['end'] for existing in deduped):
            continue
        if candidate['text'].lower() in {item['text'].lower() for item in deduped}:
            continue
        deduped.append(candidate)
        if len(deduped) >= 24:
            break
    deduped.sort(key=lambda item: item['start'])
    return jsonify({'spans': deduped, 'text': text})


@app.route('/narration/classify', methods=['POST'])
def narration_classify():
    """Bucket local narration candidates by documentary filmability."""
    data = request.get_json(silent=True) or {}
    narration = str(data.get('narration') or '').strip()[:MAX_NARRATION_TRANSCRIPT_CHARS]
    raw_spans = data.get('spans') or []
    if not narration or not isinstance(raw_spans, list):
        return jsonify({'spans': [], 'source': 'empty'})
    spans = [
        {
            'text': str(item.get('text') or '').strip()[:240],
            'start': int(item.get('start')),
            'end': int(item.get('end')),
            'kind': str(item.get('kind') or ''),
            'label': str(item.get('label') or ''),
            'salience': float(item.get('salience') or 0),
        }
        for item in raw_spans[:24]
        if isinstance(item, dict)
        and str(item.get('text') or '').strip()
        and str(item.get('start', '')).lstrip('-').isdigit()
        and str(item.get('end', '')).lstrip('-').isdigit()
    ]
    mode = str(data.get('documentary_mode') or '').strip()[:80]
    cache_key = hashlib.sha256(json.dumps(
        {'narration': narration, 'spans': spans, 'mode': mode},
        sort_keys=True, ensure_ascii=False).encode('utf-8')).hexdigest()
    with _filmability_cache_lock:
        cached = _filmability_cache.get(cache_key)
    if cached is not None:
        return jsonify({'spans': cached, 'source': 'cache'})

    source = 'fallback'
    raw_results = []
    if media_query_client.is_configured():
        try:
            raw_results = media_query_client.classify_filmability(narration, spans, mode)
            source = 'llm'
        except MediaQueryLLMCallError:
            raw_results = []
    if not raw_results:
        raw_results = [
            {
                **span,
                **_narration_span_fallback(span),
            }
            for span in spans
        ]
    results = _normalise_filmability_results(raw_results, spans)
    # A presenter-authored selection is an explicit request, so never let a
    # malformed or incomplete model response silently drop it. Preserve any
    # valid model results and fill only the missing user-selection ranges with
    # the deterministic fallback query.
    result_ranges = {(int(item.get('start', -1)), int(item.get('end', -1)))
                     for item in results}
    for span in spans:
        if span.get('kind') != 'user_selection':
            continue
        key = (int(span.get('start', -1)), int(span.get('end', -1)))
        if key in result_ranges:
            continue
        results.append({
            **span,
            **_narration_span_fallback(span),
        })
        result_ranges.add(key)
    results.sort(key=lambda item: int(item.get('start', 0)))
    with _filmability_cache_lock:
        # Bound this process-local cache so long-running browser sessions do
        # not retain every prior narration forever.
        if len(_filmability_cache) >= 256:
            _filmability_cache.pop(next(iter(_filmability_cache)))
        _filmability_cache[cache_key] = results
    return jsonify({'spans': results, 'source': source})


@app.route('/paper/media_queries', methods=['POST'])
def paper_media_queries():
    """Dedicated query planner used by Find Footage and Find Sound."""
    data = request.get_json(silent=True) or {}
    title = (data.get('title') or '').strip()[:MAX_STORYBOARD_SECTION_CHARS]
    if not title:
        return jsonify({'error': 'title is required'}), 400
    documentary_mode, err = _parse_documentary_mode(data)
    if err:
        return err
    scene = {
        'title': title,
        'act': (data.get('act') or '').strip()[:MAX_STORYBOARD_SECTION_CHARS],
        'scene_notes': (data.get('scene_notes') or '').strip()[:MAX_STORYBOARD_SECTION_CHARS],
        'footage_fragment': (data.get('footage_fragment') or '').strip()[:MAX_STORYBOARD_SECTION_CHARS],
        'scene_techniques': _parse_techniques(data),
        'narration': (data.get('narration') or '').strip()[:MAX_NARRATION_TRANSCRIPT_CHARS],
        'narration_entities': data.get('narration_entities') or [],
        'reference_footage_description': (data.get('reference_footage_description') or '').strip()[:MAX_SKETCH_VISUAL_CHARS],
        'reference_footage_entities': data.get('reference_footage_entities') or [],
        'abstract': (data.get('abstract') or '').strip()[:MAX_ABSTRACT_CHARS],
        'documentary_mode': documentary_mode or '',
    }
    if not media_query_client.is_configured():
        return jsonify({'error': _STORYBOARD_NOT_CONFIGURED_ERROR}), 503
    try:
        return jsonify(media_query_client.generate_queries(scene))
    except MediaQueryLLMCallError as exc:
        return jsonify({'error': str(exc)}), 500


@app.route('/paper/storyboard', methods=['POST'])
def paper_storyboard():
    return jsonify({'error': 'This endpoint was replaced by /paper/media_queries; shot generation now plans its own visual.'}), 410
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
            # Optional content/subject anchors (Find Footage sends these so the
            # stock query matches the track role + any uploaded footage).
            'role': (section.get('role') or '').strip(),
            'reference_subject': (section.get('reference_subject') or '').strip()[:MAX_SKETCH_VISUAL_CHARS],
        })

    documentary_goal = (data.get('documentary_goal') or '').strip()[:MAX_DOCUMENTARY_GOAL_CHARS]
    abstract = (data.get('abstract') or '').strip()[:MAX_ABSTRACT_CHARS]
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
        storyboard = storyboard_client.generate_storyboard(cleaned, documentary_goal, arc_sections, documentary_mode, techniques=_parse_techniques(data), abstract=abstract)
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
    'Generating an edit plan requires a proxy LLM key. Set PROXY_API_KEY (and PROXY_BASE_URL) in backend/.env.'
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
    'Generating a sketch requires a proxy LLM key. Set PROXY_API_KEY (and PROXY_BASE_URL) in backend/.env.'
)

# Deliberate gap between a shot's two frame-image calls (see
# /paper/generate_shot) so the pair doesn't burst the image model's
# per-minute limit. A shot takes ~30s of model time already, so a few extra
# seconds here is negligible against the odds of a RESOURCE_EXHAUSTED failure.
_SHOT_FRAME_GAP_SECONDS = 6


def _subject_locked_visual(reference_subject, visual, scene_notes='', techniques=None):
    """Keep content reference separate from authoritative shot direction.

    Shot planning is an LLM hop of its own, so relying only on its rewritten
    scene_description can dilute or replace the actual filmed subject. This
    second constraint reaches the image model directly and preserves it even
    when the generated staging conflicts.
    """
    subject = (reference_subject or '').strip()
    visual = (visual or '').strip()
    notes = (scene_notes or '').strip()
    tech = [t.strip() for t in (techniques or []) if isinstance(t, str) and t.strip()]
    parts = []
    if notes or tech:
        direction = []
        if notes:
            direction.append(f'Scene notes: {notes[:300]}')
        if tech:
            direction.append('Selected techniques: ' + ', '.join(tech))
        parts.append(
            'AUTHORITATIVE SHOT DIRECTION — use this for composition, camera angle/movement, staging, '
            'and lighting; make it clearly visible in the image:\n' + '\n'.join(direction))
    if subject:
        parts.append(
            'CONTENT REFERENCE ONLY — depict these people/objects/setting, but do not copy framing, camera, '
            f'movement, staging, lighting, or style from the uploaded footage:\n{subject[:300]}')
    if visual:
        parts.append('PLANNED FRAME:\n' + visual)
    return '\n\n'.join(parts)[:MAX_SKETCH_VISUAL_CHARS]


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


@app.route('/paper/generate_shot_plan', methods=['POST'])
def paper_generate_shot_plan():
    """Generate only the shot plan used by Act Board image-to-video."""
    data = request.get_json(silent=True) or {}
    try:
        int(data.get('section_index'))
    except (TypeError, ValueError):
        return jsonify({'error': 'section_index is required and must be an integer'}), 400

    if not shot_plan_client.is_configured():
        return jsonify({'error': _STORYBOARD_NOT_CONFIGURED_ERROR}), 503

    title = (data.get('title') or '').strip()[:MAX_STORYBOARD_SECTION_CHARS]
    scene_notes = (data.get('scene_notes') or '').strip()[:MAX_STORYBOARD_SECTION_CHARS]
    specific_phrase, parent_narration, linked_phrases = _parse_generation_context(data)
    scene_notes = _generation_context_notes(
        scene_notes, specific_phrase, '', linked_phrases)
    documentary_mode, err = _parse_documentary_mode(data)
    if err:
        return err
    scene_techniques = [technique for technique in _parse_techniques(data)
                        if technique in ACT_BOARD_CAMERA_MOVEMENT_TO_PLAN]
    animation_direction = (data.get('animation_direction') or '').strip()[:500]
    user_visual_description = (data.get('visual_description') or '').strip()[:MAX_SKETCH_VISUAL_CHARS]
    camera_movement = str(data.get('camera_movement') or '').strip()
    requested_movement = ACT_BOARD_CAMERA_MOVEMENT_TO_PLAN.get(camera_movement)
    if camera_movement and not requested_movement:
        return jsonify({'error': 'camera_movement must be a valid Camera movement technique'}), 400
    if camera_movement:
        camera_direction_label = (
            'Supporting camera movement hint'
            if animation_direction else 'Requested camera movement (AUTHORITATIVE)'
        )
        scene_notes = (
            f'{scene_notes}\n{camera_direction_label}: {camera_movement}'
        ).strip()[:MAX_STORYBOARD_SECTION_CHARS]
    if animation_direction:
        scene_notes = (
            f'Derived animation direction (AUTHORITATIVE): {animation_direction}\n{scene_notes}'
        ).strip()[:MAX_STORYBOARD_SECTION_CHARS]
    if user_visual_description:
        scene_notes = (
            'User-edited visual field (AUTHORITATIVE; integrate this with the requested camera motion): '
            f'{user_visual_description}\n{scene_notes}'
        ).strip()[:MAX_STORYBOARD_SECTION_CHARS]

    project_id = (data.get('project_id') or '').strip() or next_premiere_project_id()
    try:
        shot_plan = shot_plan_client.generate_shot_plan(
            title, scene_notes, parent_narration, '', documentary_mode,
            techniques=scene_techniques, count=1, return_all=False)
    except ShotPlanLLMCallError as exc:
        return jsonify({'error': str(exc)}), 500
    shot_plan['visual_description'] = _unified_shot_visual_field(
        user_visual_description,
        shot_plan.get('visual_description'),
        animation_direction,
    )
    if user_visual_description:
        # Preserve the raw edited field separately so the animation request can
        # enforce explicit subject/object actions without confusing them with
        # the planner's rewritten visual description.
        shot_plan['user_visual_field'] = user_visual_description
        shot_plan['subject_action'] = user_visual_description
    if requested_movement:
        if animation_direction:
            shot_plan['supporting_movement'] = requested_movement
        else:
            shot_plan['movement'] = requested_movement
    if animation_direction:
        # Keep the derived motion direction in the returned shot plan so it
        # remains the canonical instruction when the plan is saved and used
        # for the subsequent image-to-video request.
        shot_plan['animation_direction'] = animation_direction
    return jsonify({'project_id': project_id, 'shot_plan': shot_plan})


@app.route('/paper/generate_shot', methods=['POST'])
def paper_generate_shot():
    # Narration-driven shot design (see backend/shot_plan_llm.py and
    # js/paper-extract.js's "Generate shot"): from the scene's title + scene
    # notes + recorded narration, infer one shot and render a single held frame.
    # The response retains two preview URL fields for frontend/export
    # compatibility, but both point to that same generated image.
    data = request.get_json(silent=True) or {}

    try:
        section_index = int(data.get('section_index'))
    except (TypeError, ValueError):
        return jsonify({'error': 'section_index is required and must be an integer'}), 400

    # Whatever's available drives the shot; none are required (with nothing at
    # all, generate_shot_plan invents a plausible generic shot). abstract is
    # the whole paper's abstract, so it gets the larger transcript-style cap.
    title = (data.get('title') or '').strip()[:MAX_STORYBOARD_SECTION_CHARS]
    scene_notes = (data.get('scene_notes') or '').strip()[:MAX_STORYBOARD_SECTION_CHARS]
    specific_phrase, parent_narration, linked_footage_phrases = _parse_generation_context(data)
    scene_notes = _generation_context_notes(
        scene_notes, specific_phrase, '', linked_footage_phrases)
    reference_subject = (data.get('reference_subject') or '').strip()[:MAX_SKETCH_VISUAL_CHARS]
    narration = (data.get('narration') or '').strip()[:MAX_NARRATION_TRANSCRIPT_CHARS]
    if parent_narration:
        narration = parent_narration
    act_title = (data.get('act_title') or '').strip()[:MAX_STORYBOARD_SECTION_CHARS]

    documentary_mode, err = _parse_documentary_mode(data)
    if err:
        return err

    project_id = (data.get('project_id') or '').strip() or next_premiere_project_id()

    if not shot_plan_client.is_configured() or not sketch_client.is_configured():
        return jsonify({'error': _SKETCH_NOT_CONFIGURED_ERROR}), 503

    abstract = (data.get('abstract') or '').strip()[:MAX_ABSTRACT_CHARS]
    role = (data.get('role') or '').strip()
    reference_subject = (data.get('reference_subject') or '').strip()[:MAX_SKETCH_VISUAL_CHARS]
    scene_techniques = _parse_techniques(data)

    try:
        shot_plan = shot_plan_client.generate_shot_plan(
            title, scene_notes, narration, act_title, documentary_mode,
            techniques=scene_techniques, moodboard=_parse_moodboard_profiles(data),
            abstract=abstract, role=role, reference_subject=reference_subject)
    except ShotPlanLLMCallError as exc:
        return jsonify({'error': str(exc)}), 500

    visual_description = (shot_plan.get('visual_description') or '').strip()
    frame_prompt = _subject_locked_visual(
        reference_subject, visual_description, scene_notes, scene_techniques)
    reference_sketch_path = resolve_static_preview_path(data.get('reference_sketch_url'))
    # Open-slot footage/video references take precedence; paper figures arrive
    # as embedded data URLs rather than premiere_exports paths and are the
    # fallback when no uploaded sketch/video reference is present.
    if reference_sketch_path is None:
        reference_sketch_path = _resolve_video_reference_image(data, project_id, section_index)
    if reference_sketch_path is None and data.get('reference_figure_data_url'):
        reference_sketch_path = _decode_figure_data_url(
            data.get('reference_figure_data_url'), premiere_sketch_dir(project_id),
            f'{section_index}_figure_reference')

    # Framing directive (shot size + perspective/techniques) so the still actually
    # composes the specified shot rather than a generic mid-frame.
    framing = framing_directive(shot_plan.get('shot_size'), scene_techniques)

    # A SINGLE frame per shot (a held composition) - one image call. It's reused
    # as both the start and end preview so the timeline and MP4 render keep their
    # existing start/end shape without a second generation.
    try:
        if reference_sketch_path is not None:
            sketch_guidance = (
                ' Uploaded footage remains authoritative for the subject/content; use this visual reference as a secondary guide.'
                if reference_subject else
                ' Treat this uploaded sketch or attached paper figure as the authoritative visual reference for the subject, objects, and setting.'
            )
            frame_png = sketch_client.generate_sketch_from_image(
                reference_sketch_path.read_bytes(),
                f'Shot framing: {framing}. {frame_prompt}{sketch_guidance}',
                documentary_mode, style='shot_frame')
        else:
            frame_png = sketch_client.generate_sketch(
                frame_prompt, documentary_mode, style='shot_frame', framing=framing)
    except SketchLLMCallError as exc:
        return jsonify({'error': str(exc)}), 500

    # An optional shot_index disambiguates the filenames when a scene has a
    # SEQUENCE of shots (one per dragged technique - see js/paper-extract.js's
    # runGenerateShot); omitted, it's the legacy single shot at {section}_start.
    try:
        shot_index = int(data.get('shot_index'))
    except (TypeError, ValueError):
        shot_index = None
    suffix = f'_{shot_index}' if shot_index is not None else ''

    sketch_dir = premiere_sketch_dir(project_id)
    sketch_dir.mkdir(parents=True, exist_ok=True)
    frame_path = sketch_dir / f'{section_index}{suffix}_start.png'
    frame_path.write_bytes(frame_png)

    url = '/' + frame_path.relative_to(PREMIERE_EXPORTS_DIR.parent).as_posix()

    return jsonify({
        'project_id': project_id,
        'shot_plan': shot_plan,
        'start_preview_url': url,
        'end_preview_url': url,
    })


@app.route('/paper/generate_shot_video', methods=['POST'])
def paper_generate_shot_video():
    # Animate the exact image the presenter selected from the examples gallery.
    # No new image-generation hop: the selected plan's composition, narrative
    # operation, notes, and scene-only techniques guide image-to-video. When a
    # derived animation direction is present, it is the canonical motion
    # instruction and the planner's movement is only metadata.
    # Act Board callers may optionally provide start_image_url and
    # end_image_url to render a two-frame start/end clip instead.
    data = request.get_json(silent=True) or {}

    try:
        section_index = int(data.get('section_index'))
    except (TypeError, ValueError):
        return jsonify({'error': 'section_index is required and must be an integer'}), 400

    scene_notes = (data.get('scene_notes') or '').strip()[:MAX_STORYBOARD_SECTION_CHARS]
    specific_phrase, parent_narration, linked_footage_phrases = _parse_generation_context(data)
    scene_notes = _generation_context_notes(
        scene_notes, specific_phrase, parent_narration, linked_footage_phrases)
    documentary_mode, err = _parse_documentary_mode(data)
    if err:
        return err

    project_id = (data.get('project_id') or '').strip() or next_premiere_project_id()

    scene_techniques = [technique for technique in _parse_techniques(data)
                        if technique in ACT_BOARD_CAMERA_MOVEMENT_TO_PLAN]
    # In two-frame mode the start frame is the primary image input. Accept it
    # independently of the legacy chosen_image_url field so API callers can
    # provide the two image fields without duplicating the start URL.
    start_image_url = (data.get('start_image_url') or '').strip()
    chosen_path = resolve_static_preview_path(
        start_image_url or data.get('chosen_image_url'))
    if not _is_readable_image(chosen_path):
        return jsonify({'error': 'Choose, generate, or upload an image before generating a video'}), 400

    animation_direction = (data.get('animation_direction') or '').strip()[:500]
    subject_action = (data.get('subject_action') or '').strip()[:MAX_SKETCH_VISUAL_CHARS]
    movement = (data.get('movement') or '').strip()
    requested_movement = ACT_BOARD_CAMERA_MOVEMENT_TO_PLAN.get(
        str(data.get('camera_movement') or '').strip())
    if requested_movement and not animation_direction:
        movement = requested_movement
    narrative_operation = (data.get('narrative_operation') or '').strip()[:80]
    shot_size = (data.get('shot_size') or '').strip()
    purpose = (data.get('purpose') or '').strip()[:500]
    visual_description = (data.get('visual_description') or '').strip()[:MAX_SKETCH_VISUAL_CHARS]
    framing = framing_directive(shot_size, scene_techniques)
    shot_plan = {
        'shot_size': shot_size,
        'movement': movement,
        'narrative_operation': narrative_operation,
        'purpose': purpose,
        'visual_description': visual_description,
    }
    if animation_direction:
        shot_plan['animation_direction'] = animation_direction
    if subject_action:
        shot_plan['subject_action'] = subject_action
    # Optional two-frame mode: when both a start and end image are supplied,
    # render a deterministic, continuous MP4 from the pair. This keeps the
    # feature independent of the single-reference video model and reuses the
    # same start/end-frame renderer already used by the regular timeline
    # export. The existing one-image AI animation path remains unchanged.
    start_url = start_image_url
    end_url = (data.get('end_image_url') or '').strip()
    start_path = resolve_static_preview_path(start_url) if start_url else chosen_path
    end_path = resolve_static_preview_path(end_url) if end_url else None
    if start_url and not _is_readable_image(start_path):
        return jsonify({'error': 'The selected start frame is not a readable image'}), 400
    if end_url and not _is_readable_image(end_path):
        return jsonify({'error': 'The selected end frame is not a readable image'}), 400
    two_frame = bool(end_path and _is_readable_image(start_path) and _is_readable_image(end_path))
    generation_mode = 'single-image'
    try:
        chosen_image_bytes = start_path.read_bytes() if start_path else chosen_path.read_bytes()
        if two_frame:
            # Keep this clip at the same maximum duration as AI-generated
            # videos. render_shot hard-cuts at the midpoint while preserving
            # an exact, playable 8-second output.
            with tempfile.TemporaryDirectory(prefix='act-board-two-frame-') as temp_dir:
                temp_output = Path(temp_dir) / 'two_frame.mp4'
                movie_render.render_shot({
                    'start_visual_path': str(start_path),
                    'end_visual_path': str(end_path),
                    'duration_seconds': 8,
                    'ken_burns': {'enabled': False, 'pan': None},
                    'text_overlay': None,
                    'narration_audio_path': None,
                    'sfx_audio_path': None,
                }, temp_output, Path(temp_dir))
                mp4_bytes = temp_output.read_bytes()
            generation_mode = 'two-frame'
        else:
            if not animate_client.is_configured():
                return jsonify({'error': _ANIMATE_NOT_CONFIGURED_ERROR}), 503
            # Once the presenter has edited the shot-plan motion direction,
            # omit the planner's structured movement from the animation call so
            # it cannot compete with the canonical freeform instruction.
            motion_hint = '' if animation_direction else movement
            mp4_bytes = animate_client.generate_shot_video(
                chosen_image_bytes, motion_hint, documentary_mode, framing=framing,
                scene_notes=scene_notes, techniques=scene_techniques,
                narrative_operation=narrative_operation,
                visual_description=visual_description,
                animation_direction=animation_direction,
                subject_action=subject_action)
    except (OSError, movie_render.MovieRenderError, AnimateLLMCallError) as exc:
        return jsonify({'error': str(exc)}), 500

    animated_dir = premiere_animated_sketch_dir(project_id)
    animated_dir.mkdir(parents=True, exist_ok=True)
    # Keep every generation as a distinct asset. Reusing `<section>_shot.mp4`
    # made a second preview overwrite the first file, so previously appended
    # gallery cards silently played the newest video instead.
    generation_id = uuid.uuid4().hex
    saved_path = animated_dir / f'{section_index}_{generation_id}_shot.mp4'
    poster_path = animated_dir / f'{section_index}_{generation_id}_shot_poster.png'
    poster_path.write_bytes(chosen_image_bytes)
    saved_path.write_bytes(mp4_bytes)
    remux_for_reliable_playback(saved_path)

    return jsonify({
        'project_id': project_id,
        'shot_plan': shot_plan,
        'preview_url': '/' + saved_path.relative_to(PREMIERE_EXPORTS_DIR.parent).as_posix(),
        'thumbnail_url': '/' + poster_path.relative_to(PREMIERE_EXPORTS_DIR.parent).as_posix(),
        'generation_mode': generation_mode,
    })


# Batch of example options per shot (see js/paper-extract.js's Generate-examples
# flow): ~N cheap still frames + one Veo clip, all from the same shot plan and
# framing, for the presenter to pick from.
MAX_SHOT_EXAMPLES = 20


@app.route('/paper/generate_shot_examples', methods=['POST'])
def paper_generate_shot_examples():
    data = request.get_json(silent=True) or {}

    try:
        section_index = int(data.get('section_index'))
    except (TypeError, ValueError):
        return jsonify({'error': 'section_index is required and must be an integer'}), 400

    title = (data.get('title') or '').strip()[:MAX_STORYBOARD_SECTION_CHARS]
    act_title = (data.get('act_title') or '').strip()[:MAX_STORYBOARD_SECTION_CHARS]

    scene_notes = (data.get('scene_notes') or '').strip()[:MAX_STORYBOARD_SECTION_CHARS]
    specific_phrase, parent_narration, linked_footage_phrases = _parse_generation_context(data)
    scene_notes = _generation_context_notes(
        scene_notes, specific_phrase, '', linked_footage_phrases)
    role = (data.get('role') or '').strip()
    documentary_mode, err = _parse_documentary_mode(data)
    if err:
        return err
    scene_techniques = _parse_techniques(data)
    technique_variants = _parse_technique_variants(data)

    narration = (data.get('narration') or '').strip()[:MAX_NARRATION_TRANSCRIPT_CHARS]
    if parent_narration:
        narration = parent_narration
    # Content/subject anchors: the paper abstract, the track role (Primary vs
    # Cutaway), the uploaded-footage subject, and a visual frame/thumbnail when
    # the open slot contains video.
    abstract = (data.get('abstract') or '').strip()[:MAX_STORYBOARD_SECTION_CHARS]
    reference_subject = (data.get('reference_subject') or '').strip()[:MAX_SKETCH_VISUAL_CHARS]
    project_id = (data.get('project_id') or '').strip() or next_premiere_project_id()
    reference_sketch_path = resolve_static_preview_path(data.get('reference_sketch_url'))
    if reference_sketch_path is None:
        reference_sketch_path = _resolve_video_reference_image(data, project_id, section_index)
    if reference_sketch_path is None and data.get('reference_figure_data_url'):
        reference_sketch_path = _decode_figure_data_url(
            data.get('reference_figure_data_url'), premiere_sketch_dir(project_id),
            f'{section_index}_figure_reference')

    try:
        count = int(data.get('count') or 4)
    except (TypeError, ValueError):
        count = 4
    count = max(1, min(count, MAX_SHOT_EXAMPLES))
    want_video = data.get('video') is not False  # default True

    if not (shot_plan_client.is_configured() and sketch_client.is_configured()):
        return jsonify({'error': _SKETCH_NOT_CONFIGURED_ERROR}), 503

    # Ask the planner for distinct narrative operations and camera pairings in
    # one call. Narration grounds them when present; without it, the prompt
    # deliberately samples a varied set of possibilities. Per-option technique
    # assignments keep the larger image batch varied without requiring one LLM
    # request per image.
    image_scene_notes = scene_notes
    planner_scene_notes = scene_notes
    planner_techniques = list(scene_techniques)
    if technique_variants:
        for technique in (item for variant in technique_variants for item in variant):
            if technique not in planner_techniques and len(planner_techniques) < MAX_TECHNIQUES:
                planner_techniques.append(technique)
        assignments = [
            f'Option {index + 1}: {", ".join(variant) if variant else "no additional technique"}'
            for index, variant in enumerate(technique_variants[:MAX_SHOT_EXAMPLES])
        ]
        planner_scene_notes = (
            f'{scene_notes}\n\nPER-OPTION TECHNIQUE ASSIGNMENTS (apply only the listed subset to each option):\n'
            + '\n'.join(assignments)
        ).strip()
    example_wildness = 0.7
    try:
        shot_plans = shot_plan_client.generate_shot_plan(
            title, planner_scene_notes, narration, act_title, documentary_mode,
            techniques=planner_techniques, moodboard=_parse_moodboard_profiles(data),
            abstract=abstract, role=role, reference_subject=reference_subject,
            wildness=example_wildness, count=count, return_all=True)
    except ShotPlanLLMCallError as exc:
        return jsonify({'error': str(exc)}), 500

    boldness = wildness_directive(example_wildness, reference_subject)
    specs = []
    for index, plan in enumerate(shot_plans):
        plan_techniques = technique_variants[index] if index < len(technique_variants) else scene_techniques
        visual = (plan.get('visual_description') or '').strip() or abstract
        if boldness:
            visual = f'{visual}\n\n{boldness}'
        visual = _subject_locked_visual(
            reference_subject, visual, image_scene_notes, plan_techniques)
        specs.append({
            'visual': visual,
            'framing': framing_directive(plan['shot_size'], plan_techniques),
        })

    try:
        example_pngs = sketch_client.generate_examples(
            specs, documentary_mode, style='shot_frame',
            reference_image_bytes=(reference_sketch_path.read_bytes() if reference_sketch_path else None))
    except SketchLLMCallError as exc:
        return jsonify({'error': str(exc)}), 500

    sketch_dir = premiere_sketch_dir(project_id)
    sketch_dir.mkdir(parents=True, exist_ok=True)
    examples = []
    generation_id = uuid.uuid4().hex
    for i, (png, plan) in enumerate(zip(example_pngs, shot_plans)):
        if png is None:
            continue  # this variant's generation failed - skip it, keep the rest
        # Never reuse a scene/example filename. A pinned card keeps its URL;
        # overwriting a fixed `<section>_ex{i}.png` would silently replace the
        # pinned image's pixels on the next regeneration even though its card
        # metadata remained in pinnedExamples.
        p = sketch_dir / f'{section_index}_{generation_id}_ex{i}.png'
        p.write_bytes(png)
        preview_url = '/' + p.relative_to(PREMIERE_EXPORTS_DIR.parent).as_posix()
        examples.append({
            'preview_url': preview_url,
            'thumbnail_url': preview_url,
            'kind': 'image',
            'label': plan['narrative_operation'].replace('_', ' ').title(),
            'shot_size': plan['shot_size'],
            'movement': plan['movement'],
            'narrative_operation': plan['narrative_operation'],
            'purpose': plan['purpose'],
            'visual_description': plan['visual_description'],
            'techniques': technique_variants[i] if i < len(technique_variants) else scene_techniques,
        })

    return jsonify({
        'project_id': project_id,
        'shot_plan': shot_plans[0],
        'examples': examples,
    })


@app.route('/paper/generate_cutaways', methods=['POST'])
def paper_generate_cutaways():
    return jsonify({'error': 'Expository scenes now use the standard shot-plan, sketch, and animation pipeline.'}), 410
    # B-roll cutaways for an expository scene's voice-of-god narration (see
    # backend/cutaway_llm.py and js/paper-extract.js's Generate-shot flow for
    # an expository scene): infer the narration's important phrases/entities,
    # generate a background still per cutaway, and pair each with a directional
    # camera motion the UI animates over it. Planning-only previews - not the
    # render (the scene renders as the first cutaway still under its narration).
    data = request.get_json(silent=True) or {}

    try:
        section_index = int(data.get('section_index'))
    except (TypeError, ValueError):
        return jsonify({'error': 'section_index is required and must be an integer'}), 400

    narration = (data.get('narration') or '').strip()[:MAX_NARRATION_TRANSCRIPT_CHARS]
    title = (data.get('title') or '').strip()[:MAX_STORYBOARD_SECTION_CHARS]
    scene_notes = (data.get('scene_notes') or '').strip()[:MAX_STORYBOARD_SECTION_CHARS]
    act_title = (data.get('act_title') or '').strip()[:MAX_STORYBOARD_SECTION_CHARS]
    abstract = (data.get('abstract') or '').strip()[:MAX_NARRATION_TRANSCRIPT_CHARS]
    reference_subject = (data.get('reference_subject') or '').strip()[:MAX_SKETCH_VISUAL_CHARS]
    scene_techniques = _parse_techniques(data)

    documentary_mode, err = _parse_documentary_mode(data)
    if err:
        return err

    project_id = (data.get('project_id') or '').strip() or next_premiere_project_id()

    if not cutaway_client.is_configured() or not sketch_client.is_configured():
        return jsonify({'error': _SKETCH_NOT_CONFIGURED_ERROR}), 503

    try:
        cutaways = cutaway_client.generate_cutaways(
            narration, scene_notes, abstract, documentary_mode, reference_subject,
            title, act_title)
    except CutawayLLMCallError as exc:
        return jsonify({'error': str(exc)}), 500

    # Techniques steer the cutaway stills' COMPOSITION (framing/lighting) - same
    # framing directive the regular shots + the eval matrix use - even though
    # cutaways have no shot_size of their own (motion_type drives the move).
    cutaway_framing = framing_directive(None, scene_techniques)

    sketch_dir = premiere_sketch_dir(project_id)
    sketch_dir.mkdir(parents=True, exist_ok=True)

    result = []
    last_error = None
    for i, cut in enumerate(cutaways):
        if i:
            # Space the per-cutaway image calls so the batch doesn't burst the
            # image model's quota (same reasoning as /paper/generate_shot).
            time.sleep(_SHOT_FRAME_GAP_SECONDS)
        try:
            png = sketch_client.generate_sketch(
                _subject_locked_visual(
                    reference_subject, cut['background_visual'], scene_notes, scene_techniques),
                documentary_mode,
                style='shot_frame', framing=cutaway_framing)
        except SketchLLMCallError as exc:
            # A transient empty/failed image response on ONE cutaway shouldn't
            # sink the whole batch - skip it and keep the rest (same tolerance
            # as generate_examples). Raise only if EVERY cutaway failed (below).
            last_error = exc
            continue
        saved = sketch_dir / f'{section_index}_cutaway_{i}.png'
        saved.write_bytes(png)
        result.append({
            'caption': cut['caption'],
            'motion_type': cut['motion_type'],
            'preview_url': '/' + saved.relative_to(PREMIERE_EXPORTS_DIR.parent).as_posix(),
        })

    if not result:
        return jsonify({'error': f'Cutaway still generation failed: {last_error}'}), 500

    return jsonify({'project_id': project_id, 'cutaways': result})


_ANIMATE_NOT_CONFIGURED_ERROR = (
    'Generating an animated sketch requires a proxy LLM key. Set PROXY_API_KEY (and PROXY_BASE_URL) in backend/.env.'
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
    try:
        min_duration_seconds = max(0.0, float(data.get('min_duration_seconds') or 0))
    except (TypeError, ValueError):
        return jsonify({'error': 'min_duration_seconds must be a number'}), 400

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

    # A clip shorter than the requested narration/phrase window would loop or
    # expose a provider's end-of-stream black frame in playback. Providers
    # that do not publish duration metadata are kept when no minimum was
    # requested, but are excluded from a duration-constrained search because
    # their length cannot be validated safely.
    if min_duration_seconds > 0:
        filtered_videos = []
        for video in videos:
            try:
                duration = float(video.get('duration'))
            except (TypeError, ValueError):
                continue
            if duration >= min_duration_seconds:
                filtered_videos.append(video)
        videos = filtered_videos

    # Only a total failure (every provider errored, none returned even a
    # partial result) is worth surfacing as an error - one provider being
    # down/misconfigured shouldn't hide results the others found fine.
    if not videos and errors:
        return jsonify({'error': '; '.join(errors)}), 500

    return jsonify({'videos': videos, 'min_duration_seconds': min_duration_seconds})


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

    # A real opening-frame poster gives immediate visual confirmation of what
    # was uploaded, even before the browser has decoded any video metadata.
    thumbnail_path = moodboard_media.extract_first_frame(
        saved_path, footage_dir / f'{section_index}_thumbnail.jpg')

    # Describe the SUBJECT the presenter actually filmed (best-effort: several
    # sampled frames -> a concise, stable vision read) so future generated shot
    # examples/videos for this scene can match that subject. Never fatal.
    footage_subject = ''
    try:
        subj_frames = moodboard_media.sample_frames(saved_path, footage_dir / f'{section_index}_subj', count=4)
        if subj_frames:
            footage_subject = moodboard_client.describe_subject(
                moodboard_media.frames_to_data_urls(subj_frames))
    except Exception:
        footage_subject = ''

    # premiere_exports/ is served statically by the same server serving
    # html/js/css (see premiere-plugin/README.md) - a path relative to the
    # repo root, not footage_path's absolute filesystem path (which is what
    # Premiere itself needs), lets index.html preview the upload in a
    # <video> tag.
    preview_url = '/' + saved_path.relative_to(PREMIERE_EXPORTS_DIR.parent).as_posix()
    thumbnail_url = (
        '/' + thumbnail_path.relative_to(PREMIERE_EXPORTS_DIR.parent).as_posix()
        if thumbnail_path else ''
    )

    return jsonify({'project_id': project_id, 'footage_path': str(saved_path),
                    'preview_url': preview_url, 'thumbnail_url': thumbnail_url,
                    'footage_subject': footage_subject})


@app.route('/premiere/upload_sketch', methods=['POST'])
def premiere_upload_sketch():
    """Store a presenter-supplied scene sketch as a normalized PNG."""
    uploaded = request.files.get('file')
    if uploaded is None or not uploaded.filename:
        return jsonify({'error': 'file is required'}), 400
    try:
        section_index = int(request.form.get('section_index'))
    except (TypeError, ValueError):
        return jsonify({'error': 'section_index is required and must be an integer'}), 400
    raw = uploaded.read()
    if not raw or len(raw) > 25 * 1024 * 1024:
        return jsonify({'error': 'sketch must be a non-empty image under 25MB'}), 400
    try:
        image = Image.open(io.BytesIO(raw))
        image.load()
        image = image.convert('RGBA')
    except Exception:
        return jsonify({'error': 'sketch must be a valid PNG, JPEG, or WebP image'}), 400

    project_id = (request.form.get('project_id') or '').strip() or next_premiere_project_id()
    sketch_dir = premiere_sketch_dir(project_id)
    sketch_dir.mkdir(parents=True, exist_ok=True)
    saved_path = sketch_dir / f'{section_index}_uploaded.png'
    image.save(saved_path, format='PNG', optimize=True)
    # Use the same best-effort vision subject read as uploaded video. The
    # returned description pre-populates the editable subject field, so the
    # presenter can correct it before regenerating examples.
    sketch_subject = ''
    try:
        if moodboard_client.is_configured():
            subject_image = image.convert('RGB').copy()
            resampling = getattr(Image, 'Resampling', Image)
            subject_image.thumbnail((1280, 1280), resampling.LANCZOS)
            subject_buffer = io.BytesIO()
            subject_image.save(subject_buffer, format='JPEG', quality=86, optimize=True)
            subject_data_url = 'data:image/jpeg;base64,' + base64.b64encode(subject_buffer.getvalue()).decode('ascii')
            sketch_subject = moodboard_client.describe_subject([subject_data_url], content_type='sketch')
    except Exception:
        sketch_subject = ''
    preview_url = '/' + saved_path.relative_to(PREMIERE_EXPORTS_DIR.parent).as_posix()
    return jsonify({'project_id': project_id, 'sketch_path': str(saved_path),
                    'preview_url': preview_url, 'sketch_subject': sketch_subject,
                    # Keep the shared upload response field for older clients.
                    'footage_subject': sketch_subject})


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
    try:
        min_duration_seconds = max(0.0, float(data.get('min_duration_seconds') or 0))
    except (TypeError, ValueError):
        return jsonify({'error': 'min_duration_seconds must be a number'}), 400
    # Act-board footage is selected per node, so section_index alone is not a
    # unique filename. A stable, sanitized asset id prevents one Pexels pick
    # from overwriting another and lets the browser reuse the same local file
    # on subsequent playback/export passes.
    asset_id = re.sub(r'[^A-Za-z0-9_-]+', '_', str(data.get('asset_id') or '')).strip('_')[:80]

    # Extension from the URL's own path if it looks like a real one,
    # otherwise a sane default per kind - a Freesound/Pexels/archive.org
    # URL's path segment is usually the real filename, but not guaranteed.
    url_extension = Path(urlparse(url).path).suffix.lstrip('.').lower()
    extension = url_extension if _STOCK_MEDIA_EXTENSION_RE.match(url_extension) else ('mp4' if kind == 'video' else 'mp3')

    stock_dir = premiere_stock_media_dir(project_id)
    stock_dir.mkdir(parents=True, exist_ok=True)
    stem = f'{section_index}_{kind}' + (f'_{asset_id}' if asset_id else '')
    saved_path = stock_dir / f'{stem}.{extension}'

    try:
        download_stock_media_to_disk(url, saved_path)
    except (requests.RequestException, ValueError, OSError) as exc:
        return jsonify({'error': f'Could not download media: {exc}'}), 502
    remux_for_reliable_playback(saved_path)

    actual_duration = movie_render.probe_duration(saved_path)
    if (kind == 'video' and min_duration_seconds > 0
            and (actual_duration is None or actual_duration + 0.05 < min_duration_seconds)):
        try:
            saved_path.unlink()
        except OSError:
            pass
        return jsonify({
            'error': f'The selected footage is only {actual_duration or 0:.1f}s; '
                     f'a minimum of {min_duration_seconds:.1f}s is required.'
        }), 422

    preview_url = '/' + saved_path.relative_to(PREMIERE_EXPORTS_DIR.parent).as_posix()
    thumbnail_url = ''
    if kind == 'video':
        thumbnail_path = moodboard_media.extract_first_frame(
            saved_path, stock_dir / f'{stem}_thumbnail.jpg')
        if thumbnail_path:
            thumbnail_url = '/' + thumbnail_path.relative_to(PREMIERE_EXPORTS_DIR.parent).as_posix()

    return jsonify({
        'project_id': project_id,
        'preview_url': preview_url,
        'file_path': str(saved_path),
        'duration_seconds': actual_duration,
        'thumbnail_url': thumbnail_url,
    })


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

    return jsonify({
        'project_id': project_id, 'preview_url': preview_url,
        'file_path': str(saved_path),
        'duration_seconds': movie_render.probe_duration(saved_path),
    })


@app.route('/premiere/export', methods=['POST'])
def premiere_export():
    data = request.get_json(silent=True) or {}
    sections = data.get('sections')
    board_sequences = data.get('board_sequences') or []
    if board_sequences and isinstance(board_sequences, list):
        # The Act Board sends its graph separately from Timeline + Scenes.
        # Flatten it into Premiere shot records while retaining composition
        # metadata for split-screen footage nodes.
        board_sections = []
        for sequence_index, sequence in enumerate(board_sequences):
            if not isinstance(sequence, dict):
                continue
            act_label = str(sequence.get('act_key') or f'Act {sequence_index + 1}')
            sequence_start = float(sequence.get('start_seconds') or 0)
            for footage_index, footage in enumerate(sequence.get('footage') or []):
                if not isinstance(footage, dict):
                    continue
                board_sections.append({
                    'index': sequence_index * 1000 + footage_index,
                    'title': str(footage.get('fragment') or f'Footage {footage_index + 1}'),
                    'act': act_label,
                    'start_seconds': sequence_start + float(footage.get('start_seconds') or 0),
                    'visual_preview_url': footage.get('media_url') or '',
                    'edit_plan': {'duration_seconds': footage.get('duration_seconds')},
                    '_board_mode': True,
                    '_board_composition': footage.get('composition_mode') or '',
                    '_board_split_visuals': footage.get('split_visuals') or [],
                    '_board_mute_audio': bool(footage.get('mute_audio')),
                })
        if board_sections:
            sections = board_sections
    sound_effect_specs = data.get('sound_effects') or []
    narration_specs = data.get('narrations') or []

    if not isinstance(sections, list) or not sections:
        return jsonify({'error': 'sections is required and must be a non-empty list'}), 400

    project_id = (data.get('project_id') or '').strip() or next_premiere_project_id()
    project_dir_path = premiere_project_dir(project_id)
    project_dir_path.mkdir(parents=True, exist_ok=True)
    figures_dir = project_dir_path / 'premiere_figures'

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
        uploaded_path = section.get('uploaded_footage_path') or None
        footage_path = uploaded_path if uploaded_path and Path(uploaded_path).is_file() else None
        split_footage_paths = []
        split_source_start_seconds = []
        if section.get('_board_mode'):
            resolved_board_media = _resolve_board_media(
                section.get('visual_preview_url'), project_id, i, 0)
            footage_path = str(resolved_board_media) if resolved_board_media else None
            split_visuals = section.get('_board_split_visuals') or []
            if section.get('_board_composition') == 'split-screen' and isinstance(split_visuals, list):
                for split_index, split_visual in enumerate(split_visuals[:4]):
                    if not isinstance(split_visual, dict):
                        continue
                    resolved_split = _resolve_board_media(
                        split_visual.get('media_url'), project_id, i, split_index + 1)
                    if resolved_split is not None:
                        split_footage_paths.append(str(resolved_split))
                        split_source_start_seconds.append(
                            max(0, float(split_visual.get('source_start_seconds') or 0)))
                if footage_path is None and split_footage_paths:
                    footage_path = split_footage_paths[0]
        if footage_path is None:
            visual = resolve_static_preview_path(section.get('visual_preview_url'))
            if visual is None:
                visual = resolve_static_preview_path(
                    selected_video.get('localPreviewUrl') or selected_video.get('local_preview_url'))
            if visual is not None:
                footage_path = str(visual)
        if footage_path is None and section.get('figure_image_data_url'):
            figure = _decode_figure_data_url(
                section.get('figure_image_data_url'), figures_dir, f'{index}_{i}')
            if figure is not None:
                footage_path = str(figure)

        narration = resolve_static_preview_path(section.get('narration_audio_path'))
        start_seconds = section.get('start_seconds')
        shots.append({
            'index': index,
            'cutaway_index': section.get('cutaway_index'),
            'title': title,
            'act': act,
            'role': section.get('role') if section.get('role') in ('aRoll', 'bRoll') else 'aRoll',
            'start_seconds': float(start_seconds) if isinstance(start_seconds, (int, float)) and start_seconds >= 0 else None,
            'narration': (section.get('narration') or '').strip(),
            # Real local path to the recorded/dragged narration audio. The
            # independently-timed SFX clips live in top-level sound_effects;
            # narration remains shot-scoped for backward compatibility.
            'narration_audio_path': str(narration) if narration else None,
            'narration_duration_seconds': section.get('narration_duration_seconds'),
            'mute_source_audio': bool(section.get('_board_mute_audio')),
            # Uploaded footage (a real local path this machine's Premiere can
            # import directly) takes priority; otherwise this just notes
            # which Pexels clip was picked - the file itself isn't
            # downloaded/mirrored here, per Pexels' terms and simplicity.
            'footage_path': footage_path,
            'stock_video_source_url': selected_video.get('source_url'),
            'stock_audio_preview_url': selected_audio.get('preview_url'),
            'composition_mode': 'split-screen' if len(split_footage_paths) >= 2 else '',
            'split_footage_paths': split_footage_paths,
            'split_source_start_seconds': split_source_start_seconds,
            'edit_plan': section.get('edit_plan') or None,
        })

    sound_effects = []
    if not isinstance(sound_effect_specs, list):
        return jsonify({'error': 'sound_effects must be a list'}), 400
    for i, effect in enumerate(sound_effect_specs):
        if not isinstance(effect, dict):
            return jsonify({'error': f'sound_effect {i} must be an object'}), 400
        resolved = resolve_static_preview_path(effect.get('preview_url'))
        start = effect.get('start_seconds')
        source_start = effect.get('source_start_seconds', 0)
        duration = effect.get('duration_seconds')
        lane = effect.get('lane')
        if resolved is None or not isinstance(start, (int, float)) or start < 0:
            return jsonify({'error': f'sound_effect {i} has an invalid preview_url or start_seconds'}), 400
        if (not isinstance(source_start, (int, float)) or source_start < 0
                or not isinstance(duration, (int, float)) or duration <= 0
                or not isinstance(lane, int) or lane < 0):
            return jsonify({'error': f'sound_effect {i} has an invalid source_start_seconds, duration_seconds, or lane'}), 400
        sound_effects.append({
            'section_index': effect.get('section_index'),
            'name': (effect.get('name') or resolved.name).strip(),
            'file_path': str(resolved),
            'start_seconds': float(start),
            'source_start_seconds': float(source_start),
            'duration_seconds': float(duration),
            'lane': lane,
        })

    narrations = []
    if not isinstance(narration_specs, list):
        return jsonify({'error': 'narrations must be a list'}), 400
    for i, narration in enumerate(narration_specs):
        if not isinstance(narration, dict):
            return jsonify({'error': f'narration {i} must be an object'}), 400
        resolved = resolve_static_preview_path(narration.get('preview_url'))
        start = narration.get('start_seconds')
        source_start = narration.get('source_start_seconds', 0)
        duration = narration.get('duration_seconds')
        lane = narration.get('lane')
        if (resolved is None or not isinstance(start, (int, float)) or start < 0
                or not isinstance(source_start, (int, float)) or source_start < 0
                or not isinstance(duration, (int, float)) or duration <= 0
                or not isinstance(lane, int) or lane < 0):
            return jsonify({'error': f'narration {i} has invalid timing, lane, or preview_url'}), 400
        narrations.append({
            'section_index': narration.get('section_index'),
            'name': (narration.get('name') or resolved.name).strip(),
            'file_path': str(resolved), 'start_seconds': float(start),
            'source_start_seconds': float(source_start),
            'duration_seconds': float(duration), 'lane': lane,
        })

    edit_plan_path = project_dir_path / 'edit_plan.json'
    edit_plan_path.write_text(json.dumps({
        'shots': shots,
        'narrations': narrations,
        'sound_effects': sound_effects,
        **({'board_sequences': board_sequences} if board_sequences else {}),
    }, indent=2))

    return jsonify({
        'project_id': project_id,
        'folder_path': str(project_dir_path),
        'edit_plan_path': str(edit_plan_path),
    })


# A section's figure image (see paper_extraction.py's _picture_data_url)
# arrives as a data: URL rather than a preview_url like every other visual,
# since it was embedded at extraction time, never written under
# premiere_exports/. The render pipeline needs a real file, so /render/start
# decodes it to one - matches these two shapes and caps the decoded size
# the same spirit as MAX_FOOTAGE_SIZE_MB, since it round-trips through
# client JSON.
_DATA_URL_RE = re.compile(r'^data:image/(png|jpe?g|webp);base64,(.+)$', re.IGNORECASE | re.DOTALL)
_MAX_FIGURE_IMAGE_BYTES = 20 * 1024 * 1024


def _decode_figure_data_url(data_url, dest_dir, index):
    """Decodes a section's figure-image data: URL to a real PNG/JPEG/WebP
    file under dest_dir, returning its Path, or None if it isn't a
    well-formed, reasonably-sized image data URL."""
    if not data_url or not isinstance(data_url, str):
        return None
    match = _DATA_URL_RE.match(data_url.strip())
    if not match:
        return None
    ext = 'jpg' if match.group(1).lower() in ('jpg', 'jpeg') else match.group(1).lower()
    try:
        # binascii.Error (bad base64) is itself a ValueError subclass.
        raw = base64.b64decode(match.group(2), validate=True)
    except ValueError:
        return None
    if not raw or len(raw) > _MAX_FIGURE_IMAGE_BYTES:
        return None
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_path = dest_dir / f'{index}.{ext}'
    dest_path.write_bytes(raw)
    return dest_path


def _is_readable_image(path):
    """Return whether *path* is a decodable still image, without trusting its
    filename extension (a dragged/generated video may carry a thumbnail URL,
    while older sessions sometimes stored the video URL in that field)."""
    if not path or not path.is_file():
        return False
    try:
        with Image.open(path) as image:
            image.verify()
        return True
    except (OSError, ValueError):
        return False


def _resolve_video_reference_image(data, project_id, section_index):
    """Resolve an open-slot video's thumbnail, or extract its first frame.

    Uploads normally provide ``reference_video_thumbnail_url`` immediately.
    A generated video dragged into the slot may only have its MP4 URL, so the
    fallback samples a real frame under the current Premiere project and
    returns that still for the image model.
    """
    thumbnail_path = resolve_static_preview_path(data.get('reference_video_thumbnail_url'))
    if _is_readable_image(thumbnail_path):
        return thumbnail_path

    video_path = resolve_static_preview_path(data.get('reference_video_url'))
    if not video_path:
        return None
    frame_path = premiere_sketch_dir(project_id) / f'{section_index}_video_reference.jpg'
    return moodboard_media.extract_first_frame(video_path, frame_path)


def _resolve_board_media(media_url, project_id, sequence_index, footage_index):
    """Resolve a linked act-board visual to a local renderable file.

    Board footage suggestions may still be remote search results, while
    generated/uploaded visuals are already served from the local Premiere
    export tree. Resolve local files first; download a remote suggestion only
    when the board sequence is actually rendered.
    """
    local = resolve_static_preview_path(media_url)
    if local is not None:
        return local
    url = (media_url or '').strip()
    if not url.startswith(('http://', 'https://')):
        return None
    path = urlparse(url).path
    extension = Path(path).suffix.lstrip('.').lower()
    if not _STOCK_MEDIA_EXTENSION_RE.match(extension):
        extension = 'mp4'
    target_dir = premiere_stock_media_dir(project_id) / 'act_board'
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f'{sequence_index}_{footage_index}.{extension}'
    try:
        download_stock_media_to_disk(url, target)
        if extension not in ('jpg', 'jpeg', 'png', 'webp', 'bmp'):
            remux_for_reliable_playback(target)
    except (requests.RequestException, ValueError, OSError):
        return None
    return target if target.is_file() and target.stat().st_size > 0 else None


@app.route('/render/start', methods=['POST'])
def render_start():
    # Kicks off a server-side ffmpeg assembly of a real documentary.mp4 (see
    # backend/movie_render.py) - the automated counterpart to /premiere/export
    # above, which only writes a plan for a human to finish in Premiere. It
    # also accepts an optional board_sequences graph: linked act-board footage
    # nodes become the ordered shots, while narration events are mixed over
    # their complete sequence. Same per-section payload shape /premiere/export
    # accepts, plus the resolved local preview_urls for the chosen visual/
    # narration/sound-effect (all
    # already downloaded to disk by the time a render is possible - see
    # /premiere/download_stock_media and the upload routes). Resolves + fully
    # validates every path synchronously (so a bad shot fails the request,
    # not the background render), then runs the render on a daemon thread and
    # returns immediately; the frontend polls /render/status.
    data = request.get_json(silent=True) or {}
    sections = data.get('sections')
    board_sequences = data.get('board_sequences') or []
    sound_effect_specs = data.get('sound_effects') or []
    narration_specs = data.get('narrations') or []
    if not isinstance(sections, list):
        sections = []
    if not isinstance(board_sequences, list):
        return jsonify({'error': 'board_sequences must be a list'}), 400
    if not sections and not board_sequences:
        return jsonify({'error': 'sections or board_sequences is required and must be non-empty'}), 400

    project_id = (data.get('project_id') or '').strip() or next_premiere_project_id()
    project_dir_path = premiere_project_dir(project_id)
    project_dir_path.mkdir(parents=True, exist_ok=True)
    figures_dir = project_dir_path / 'render_figures'

    shots = []
    if board_sequences:
        for sequence_index, sequence in enumerate(board_sequences):
            if not isinstance(sequence, dict):
                return jsonify({'error': f'board_sequence {sequence_index} must be an object'}), 400
            footage_items = sequence.get('footage') or []
            if not isinstance(footage_items, list) or not footage_items:
                return jsonify({'error': f'board_sequence {sequence_index} has no footage nodes'}), 400
            sequence_start_seconds = sequence.get('start_seconds', 0)
            if not isinstance(sequence_start_seconds, (int, float)) or sequence_start_seconds < 0:
                return jsonify({'error': f'board_sequence {sequence_index} has invalid start_seconds'}), 400
            sequence_duration = sequence.get('duration_seconds')
            if sequence_duration is not None and (
                    not isinstance(sequence_duration, (int, float)) or sequence_duration <= 0):
                return jsonify({'error': f'board_sequence {sequence_index} has invalid duration_seconds'}), 400
            for footage_index, footage in enumerate(footage_items):
                if not isinstance(footage, dict):
                    return jsonify({'error': f'board_sequence {sequence_index} footage {footage_index} must be an object'}), 400
                duration = footage.get('duration_seconds')
                if not isinstance(duration, (int, float)) or duration <= 0:
                    return jsonify({'error': f'board_sequence {sequence_index} footage {footage_index} has invalid duration_seconds'}), 400
                start_seconds = footage.get('start_seconds', 0)
                if not isinstance(start_seconds, (int, float)) or start_seconds < 0:
                    return jsonify({'error': f'board_sequence {sequence_index} footage {footage_index} has invalid start_seconds'}), 400
                source_start_seconds = footage.get('source_start_seconds', 0)
                if (not isinstance(source_start_seconds, (int, float))
                        or source_start_seconds < 0):
                    return jsonify({'error': f'board_sequence {sequence_index} footage {footage_index} has invalid source_start_seconds'}), 400
                # If the recorded umbrella narration runs a little longer
                # than its last referenced phrase, hold the final visual
                # through the end of that narration rather than cutting the
                # voice off at the last footage duration.
                render_duration = float(duration)
                if sequence_duration is not None and footage_index == len(footage_items) - 1:
                    render_duration = max(
                        render_duration,
                        float(sequence_duration) - float(start_seconds),
                    )
                split_visual_paths = []
                split_source_start_seconds = []
                split_visuals = footage.get('split_visuals') or []
                if footage.get('composition_mode') == 'split-screen' and isinstance(split_visuals, list):
                    for split_index, split_visual in enumerate(split_visuals[:4]):
                        if not isinstance(split_visual, dict):
                            continue
                        resolved_split = _resolve_board_media(
                            split_visual.get('media_url'), project_id, sequence_index,
                            footage_index * 10 + split_index)
                        if resolved_split is not None:
                            split_visual_paths.append(str(resolved_split))
                            split_source_start_seconds.append(
                                max(0, float(split_visual.get('source_start_seconds') or 0)))
                visual = _resolve_board_media(
                    footage.get('media_url'), project_id, sequence_index, footage_index)
                if visual is None and split_visual_paths:
                    visual = Path(split_visual_paths[0])
                if visual is None:
                    return jsonify({'error': f'board_sequence {sequence_index} footage {footage_index} has no usable media'}), 400
                shots.append({
                    'visual_path': str(visual),
                    'start_visual_path': None,
                    'end_visual_path': None,
                    'cutaway_paths': [],
                    'duck_source_audio': bool(narration_specs),
                    'narration_audio_path': None,
                    'sfx_audio_path': None,
                    'duration_seconds': render_duration,
                    'source_start_seconds': float(source_start_seconds),
                    # Generated Act Board videos may contain an incidental
                    # model soundtrack. Narration and sound-effect tracks are
                    # mixed separately, so keep that embedded audio muted.
                    'mute_source_audio': bool(footage.get('mute_audio')),
                    'composition_mode': 'split-screen' if len(split_visual_paths) >= 2 else '',
                    'split_visual_paths': split_visual_paths,
                    'split_source_start_seconds': split_source_start_seconds,
                    # Board footage timings are relative to the complete
                    # narration-led sequence. The renderer uses this to
                    # preserve any gap between spoken fragments instead of
                    # collapsing every linked shot into a purely sequential
                    # concat.
                    'timeline_start_seconds': (
                        float(sequence_start_seconds)
                        + float(start_seconds)
                    ),
                    'ken_burns': {'enabled': False, 'pan': None},
                    'text_overlay': None,
                    'transition_in': footage.get('transition_in') or 'hard_cut',
                    # Board playback holds the active shot through transcript
                    # pauses; the renderer uses this to avoid black filler
                    # between linked footage nodes.
                    'hold_for_timeline_gaps': True,
                })
        # Normalize the board's visual timeline before handing it to the
        # renderer. Each shot absorbs the pause before the next spoken phrase,
        # so even an older/restarted worker cannot synthesize a black gap clip
        # from sparse transcript timestamps. The narration event still keeps
        # its original absolute timing; only the visual hold is made explicit.
        board_cursor = 0.0
        board_shots = [shot for shot in shots if shot.get('hold_for_timeline_gaps')]
        for board_index, shot in enumerate(board_shots):
            original_start = float(shot.get('timeline_start_seconds') or 0)
            duration = max(0.1, float(shot.get('duration_seconds') or 0.1))
            next_start = None
            if board_index + 1 < len(board_shots):
                next_start = float(board_shots[board_index + 1].get('timeline_start_seconds') or 0)
            if next_start is not None and next_start > original_start:
                duration = max(duration, next_start - original_start)
            if original_start > board_cursor:
                duration += original_start - board_cursor
            shot['timeline_start_seconds'] = board_cursor
            shot['duration_seconds'] = duration
            board_cursor += duration
    for i, section in enumerate(sections if not board_sequences else []):
        if not isinstance(section, dict):
            return jsonify({'error': f'section {i} must be an object'}), 400
        title = (section.get('title') or '').strip() or f'section {i}'

        # Visual, in priority order:
        # 1. A narration-driven start/end frame PAIR (see /paper/generate_shot)
        #    - both must resolve; render_shot hard-cuts between them.
        # 2. A single resolved local file (stock video, uploaded footage,
        #    sketch - all under premiere_exports/).
        # 3. The paper figure decoded from its data URL.
        # A shot with none can't be rendered, so reject the whole request
        # rather than silently drop a shot and produce a shorter video than
        # the presenter arranged.
        start_frame_resolved = resolve_static_preview_path(section.get('start_frame_preview_url'))
        end_frame_resolved = resolve_static_preview_path(section.get('end_frame_preview_url'))
        two_frame = start_frame_resolved is not None and end_frame_resolved is not None

        visual_path = None
        if not two_frame:
            resolved_visual = resolve_static_preview_path(section.get('visual_preview_url'))
            if resolved_visual is not None:
                visual_path = str(resolved_visual)
            elif section.get('figure_image_data_url'):
                decoded = _decode_figure_data_url(section.get('figure_image_data_url'), figures_dir, i)
                if decoded is not None:
                    visual_path = str(decoded)
            if visual_path is None:
                return jsonify({'error': f'section "{title}" has no usable visual - generate or pick one, then try again'}), 400

        narration_resolved = resolve_static_preview_path(section.get('narration_audio_path'))
        # Backward compatibility for saved/older clients that still attach an
        # effect directly to a shot instead of sending the global event list.
        sfx_resolved = resolve_static_preview_path(section.get('stock_audio_preview_url'))

        # Expository cutaway scenes render every cutaway still in sequence under
        # the narration (see movie_render.render_shot). Resolve them all; the
        # renderer only uses this when there are 2+ (a single one falls through
        # to the plain visual_path still).
        cutaway_paths = []
        for cu_url in (section.get('cutaway_preview_urls') or []):
            resolved_cu = resolve_static_preview_path(cu_url)
            if resolved_cu is not None:
                cutaway_paths.append(str(resolved_cu))

        edit_plan = section.get('edit_plan') or {}
        ken_burns = edit_plan.get('ken_burns') or {}
        shots.append({
            'visual_path': visual_path,
            'start_visual_path': str(start_frame_resolved) if two_frame else None,
            'end_visual_path': str(end_frame_resolved) if two_frame else None,
            'cutaway_paths': cutaway_paths,
            'mute_source_audio': bool(section.get('mute_source_audio')),
            # Narration is mixed as an independently timed global event after
            # the shots are joined. Lower any embedded footage audio whenever
            # that voice track exists so it remains intelligible in the MP4.
            'duck_source_audio': bool(narration_specs),
            'narration_audio_path': str(narration_resolved) if narration_resolved else None,
            'sfx_audio_path': str(sfx_resolved) if sfx_resolved else None,
            'duration_seconds': edit_plan.get('duration_seconds'),
            'ken_burns': {'enabled': bool(ken_burns.get('enabled')), 'pan': ken_burns.get('pan')},
            'text_overlay': edit_plan.get('text_overlay') or None,
            'transition_in': edit_plan.get('transition_in') or 'hard_cut',
        })

    if not isinstance(sound_effect_specs, list):
        return jsonify({'error': 'sound_effects must be a list'}), 400
    sound_effects = []
    for i, effect in enumerate(sound_effect_specs):
        if not isinstance(effect, dict):
            return jsonify({'error': f'sound_effect {i} must be an object'}), 400
        resolved = resolve_static_preview_path(effect.get('preview_url'))
        start = effect.get('start_seconds')
        source_start = effect.get('source_start_seconds', 0)
        duration = effect.get('duration_seconds')
        if resolved is None or not isinstance(start, (int, float)) or start < 0:
            return jsonify({'error': f'sound_effect {i} has an invalid preview_url or start_seconds'}), 400
        if (not isinstance(source_start, (int, float)) or source_start < 0
                or not isinstance(duration, (int, float)) or duration <= 0):
            return jsonify({'error': f'sound_effect {i} has an invalid source_start_seconds or duration_seconds'}), 400
        try:
            gain = max(0.0, min(2.0, float(effect.get('gain', 1.0))))
        except (TypeError, ValueError):
            gain = 1.0
        sound_effects.append({
            'file_path': str(resolved),
            'start_seconds': float(start),
            'source_start_seconds': float(source_start),
            'duration_seconds': float(duration),
            'kind': effect.get('kind') if effect.get('kind') in ('sfx', 'music') else 'sfx',
            'gain': gain,
        })

    if not isinstance(narration_specs, list):
        return jsonify({'error': 'narrations must be a list'}), 400
    narrations = []
    for i, narration in enumerate(narration_specs):
        if not isinstance(narration, dict):
            return jsonify({'error': f'narration {i} must be an object'}), 400
        resolved = resolve_static_preview_path(narration.get('preview_url'))
        start = narration.get('start_seconds')
        source_start = narration.get('source_start_seconds', 0)
        duration = narration.get('duration_seconds')
        if (resolved is None or not isinstance(start, (int, float)) or start < 0
                or not isinstance(source_start, (int, float)) or source_start < 0
                or not isinstance(duration, (int, float)) or duration <= 0):
            return jsonify({'error': f'narration {i} has invalid timing or preview_url'}), 400
        narrations.append({
            'file_path': str(resolved), 'start_seconds': float(start),
            'source_start_seconds': float(source_start), 'duration_seconds': float(duration),
            'gain': 1.0, 'kind': 'narration',
        })

    output_path = project_dir_path / 'documentary.mp4'
    status_path = project_dir_path / 'render_status.json'
    # Seed the status before the thread starts, so an immediate poll from the
    # frontend sees 'rendering' rather than racing the thread's first write.
    status_path.write_text(json.dumps({'state': 'rendering', 'step': 'starting', 'message': 'Starting render ...'}))

    thread = threading.Thread(
        target=movie_render.render_documentary,
        args=(project_id, shots, sound_effects + narrations, output_path, status_path),
        daemon=True,
    )
    thread.start()

    return jsonify({
        'project_id': project_id,
        # Where the finished file will be, servable by serve.py's static
        # tree the moment it exists (same as rough_cut.mp4) - the frontend
        # cache-busts this once /render/status reports done.
        'preview_url': '/' + output_path.relative_to(PREMIERE_EXPORTS_DIR.parent).as_posix(),
    })


@app.route('/render/status', methods=['GET'])
def render_status():
    # Polled by the frontend after /render/start (see js/paper-extract.js's
    # runRenderMovie) - just reads back the render_status.json the render
    # thread keeps updating (see movie_render.render_documentary). A missing
    # file means no render was ever started for this project.
    project_id = (request.args.get('project_id') or '').strip()
    if not project_id:
        return jsonify({'error': 'project_id is required'}), 400
    status_path = premiere_project_dir(project_id) / 'render_status.json'
    if not status_path.is_file():
        return jsonify({'state': 'unknown', 'step': '', 'message': 'No render found for this project.'})
    try:
        return jsonify(json.loads(status_path.read_text()))
    except (OSError, ValueError):
        return jsonify({'state': 'unknown', 'step': '', 'message': 'Could not read render status.'})


# --- Moodboard entry point (see js/paper-extract.js's moodboard flow) ---
# The presenter assembles reference documentaries (a typed name, a YouTube
# link, or an uploaded clip); each is analyzed in the background (frames +
# audio + a vision style read - see moodboard_media.py/moodboard_llm.py) and
# the results are distilled into suggested arcs/mode/techniques
# (narrative_arc_llm.distill_from_moodboard). Analysis mirrors the
# /render/start + /render/status daemon-thread + status.json pattern above, at
# per-reference granularity so a slow/blocked YouTube ref never stalls the
# others.
MAX_MOODBOARD_REFERENCES = 10
MAX_MOODBOARD_NOTE_CHARS = 500
MAX_MOODBOARD_REF_FIELD_CHARS = 2_000


def _write_moodboard_status(status_path, state, step='', message='', profile=None):
    payload = {'state': state, 'step': step, 'message': message}
    if profile is not None:
        payload['profile'] = profile
    try:
        status_path.write_text(json.dumps(payload))
    except OSError:
        pass


def _preview_url_for(path):
    """Repo-root-relative static URL for a file under premiere_exports/ -
    same convention as the upload routes' preview_url."""
    return '/' + Path(path).relative_to(PREMIERE_EXPORTS_DIR.parent).as_posix()


def _transcribe_if_possible(audio_path):
    """Best-effort transcription of an extracted audio file - returns '' if
    transcription isn't configured or fails (a reference without a usable
    transcript still contributes its frames/title)."""
    if audio_path is None or not transcription_client.is_configured():
        return ''
    try:
        return (transcription_client.transcribe(audio_path.read_bytes(), audio_path.name).get('text') or '').strip()
    except Exception:
        return ''


def _analyze_moodboard_reference(project_id, ref_id, source_kind, source, note, status_path, profile_path):
    """Daemon-thread worker: runs the fallback ladder (download -> frames +
    audio -> vision style read; degrading to an oEmbed thumbnail or title-only
    reasoning) for one reference, writing coarse progress to status_path and
    the final profile to profile_path. Best-effort - records an 'error' state
    rather than raising, since no request is waiting on it."""
    ref_dir = premiere_moodboard_ref_dir(project_id, ref_id)
    try:
        ref_dir.mkdir(parents=True, exist_ok=True)
        title = ''
        source_url = ''
        transcript = ''
        thumbnail_url = None
        frames_data_urls = []
        frame_urls = []  # disk-served preview URLs for the sampled frames (the card's strip)

        if source_kind == 'named':
            title = source
        elif source_kind == 'youtube':
            source_url = source
            _write_moodboard_status(status_path, 'analyzing', 'fetching', 'Fetching reference details ...')
            oembed = moodboard_media.youtube_oembed(source)
            if oembed:
                title = oembed.get('title') or ''
                if oembed.get('thumbnail_url'):
                    thumb_path = moodboard_media.download_thumbnail(oembed['thumbnail_url'], ref_dir / 'thumbnail.jpg')
                    if thumb_path:
                        thumbnail_url = _preview_url_for(thumb_path)
            _write_moodboard_status(status_path, 'analyzing', 'downloading', 'Downloading video ...')
            video_path = moodboard_media.download_youtube(source, ref_dir)
            if video_path:
                _write_moodboard_status(status_path, 'analyzing', 'sampling', 'Sampling frames ...')
                frames = moodboard_media.sample_frames(video_path, ref_dir / 'frames')
                frames_data_urls = moodboard_media.frames_to_data_urls(frames)
                frame_urls = [_preview_url_for(f) for f in frames]
                if frames and not thumbnail_url:
                    thumbnail_url = _preview_url_for(frames[0])
                _write_moodboard_status(status_path, 'analyzing', 'transcribing', 'Transcribing audio ...')
                transcript = _transcribe_if_possible(moodboard_media.extract_audio(video_path, ref_dir))
            elif (ref_dir / 'thumbnail.jpg').is_file():
                # Download failed - fall back to reading the single oEmbed thumbnail.
                frames_data_urls = moodboard_media.frames_to_data_urls([ref_dir / 'thumbnail.jpg'])
        elif source_kind == 'upload':
            video_path = Path(source)
            title = video_path.stem
            _write_moodboard_status(status_path, 'analyzing', 'sampling', 'Sampling frames ...')
            frames = moodboard_media.sample_frames(video_path, ref_dir / 'frames')
            frames_data_urls = moodboard_media.frames_to_data_urls(frames)
            frame_urls = [_preview_url_for(f) for f in frames]
            if frames:
                thumbnail_url = _preview_url_for(frames[0])
            _write_moodboard_status(status_path, 'analyzing', 'transcribing', 'Transcribing audio ...')
            transcript = _transcribe_if_possible(moodboard_media.extract_audio(video_path, ref_dir))

        style = {}
        if moodboard_client.is_configured():
            _write_moodboard_status(status_path, 'analyzing', 'reading', 'Reading style ...')
            try:
                style = moodboard_client.read_style(
                    frames_data_urls, transcript=transcript, title=title, source_kind=source_kind)
            except MoodboardLLMCallError:
                style = {}

        profile = {
            'ref_id': ref_id,
            'source_kind': source_kind,
            'title': (title or (source if source_kind == 'named' else 'Untitled reference')).strip(),
            'source_url': source_url,
            'transcript': transcript,
            'visual_style': style.get('visual_style', ''),
            'observed_techniques': style.get('observed_techniques', []),
            'tone': style.get('tone', ''),
            'pacing': style.get('pacing', ''),
            'suggested_mode': style.get('suggested_mode'),
            'transcript_summary': style.get('transcript_summary', ''),
            'thumbnail_url': thumbnail_url,
            'frame_urls': frame_urls,
            'note': (note or '').strip(),
        }
        try:
            profile_path.write_text(json.dumps(profile, indent=2))
        except OSError:
            pass
        _write_moodboard_status(status_path, 'ready', 'done', 'Ready', profile=profile)
    except Exception as exc:  # best-effort worker - never let the thread die silently
        _write_moodboard_status(status_path, 'error', '', f'Analysis failed: {exc}')


def _allocate_moodboard_ref_id(project_id):
    moodboard_dir = premiere_moodboard_dir(project_id)
    existing = []
    if moodboard_dir.exists():
        for p in moodboard_dir.iterdir():
            if p.is_dir() and p.name.startswith('ref-'):
                try:
                    existing.append(int(p.name[len('ref-'):]))
                except ValueError:
                    pass
    return f'ref-{max(existing, default=0) + 1}'


@app.route('/moodboard/add_reference', methods=['POST'])
def moodboard_add_reference():
    # multipart (an uploaded footage file) OR JSON (a YouTube link / a named
    # documentary). Allocates a ref_id, seeds status.json BEFORE the thread
    # starts (so an immediate poll sees 'analyzing', not a missing file - same
    # race-avoidance as /render/start), then analyzes on a daemon thread.
    is_multipart = request.files.get('file') is not None
    if is_multipart:
        kind = 'upload'
        project_id = (request.form.get('project_id') or '').strip() or next_premiere_project_id()
        note = (request.form.get('note') or '').strip()[:MAX_MOODBOARD_NOTE_CHARS]
    else:
        data = request.get_json(silent=True) or {}
        kind = (data.get('kind') or '').strip()
        project_id = (data.get('project_id') or '').strip() or next_premiere_project_id()
        note = (data.get('note') or '').strip()[:MAX_MOODBOARD_NOTE_CHARS]

    ref_id = _allocate_moodboard_ref_id(project_id)
    ref_dir = premiere_moodboard_ref_dir(project_id, ref_id)
    ref_dir.mkdir(parents=True, exist_ok=True)

    if kind == 'upload':
        uploaded = request.files.get('file')
        media_bytes = uploaded.read()
        if len(media_bytes) > MAX_FOOTAGE_SIZE_MB * 1024 * 1024:
            return jsonify({'error': f'file exceeds max size of {MAX_FOOTAGE_SIZE_MB}MB'}), 400
        filename = secure_filename(uploaded.filename) or 'reference'
        source_path = ref_dir / f'source_{filename}'
        source_path.write_bytes(media_bytes)
        remux_for_reliable_playback(source_path)
        source = str(source_path)
    elif kind == 'youtube':
        source = (data.get('url') or '').strip()
        if not source:
            return jsonify({'error': 'url is required for a youtube reference'}), 400
    elif kind == 'named':
        source = (data.get('name') or '').strip()
        if not source:
            return jsonify({'error': 'name is required for a named reference'}), 400
    else:
        return jsonify({'error': "kind must be 'upload', 'youtube', or 'named'"}), 400

    status_path = ref_dir / 'status.json'
    profile_path = ref_dir / 'profile.json'
    status_path.write_text(json.dumps({'state': 'analyzing', 'step': 'starting', 'message': 'Analyzing reference ...'}))
    threading.Thread(
        target=_analyze_moodboard_reference,
        args=(project_id, ref_id, kind, source, note, status_path, profile_path),
        daemon=True,
    ).start()

    return jsonify({'project_id': project_id, 'ref_id': ref_id, 'state': 'analyzing'})


@app.route('/moodboard/reference_status', methods=['GET'])
def moodboard_reference_status():
    # Polled by the frontend after add_reference - reads back the status.json
    # the worker keeps updating (same shape as /render/status).
    project_id = (request.args.get('project_id') or '').strip()
    ref_id = (request.args.get('ref_id') or '').strip()
    if not project_id or not ref_id:
        return jsonify({'error': 'project_id and ref_id are required'}), 400
    status_path = premiere_moodboard_ref_dir(project_id, ref_id) / 'status.json'
    if not status_path.is_file():
        return jsonify({'state': 'unknown', 'step': '', 'message': 'No such reference.'})
    try:
        return jsonify(json.loads(status_path.read_text()))
    except (OSError, ValueError):
        return jsonify({'state': 'unknown', 'step': '', 'message': 'Could not read reference status.'})


# --- 3D reconstruction entry point: upload a photo (flat or panoramic) or
# footage, reconstruct it into a scene the in-browser three.js viewer can
# explore. Mirrors the moodboard worker+poll pattern exactly (background daemon
# thread, status.json seeded synchronously, profile.json on 'ready'). v1 is a
# light monocular-depth 2.5D reconstruction; the profile's engine/viewer_mode
# fields leave room for a future Gaussian-splat engine without reshaping this.

_RECONSTRUCT_VIDEO_EXTS = ('.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv')


def _allocate_reconstruct_id(project_id):
    recon_root = premiere_project_dir(project_id) / 'reconstruct'
    existing = []
    if recon_root.exists():
        for p in recon_root.iterdir():
            if p.is_dir() and p.name.startswith('recon-'):
                try:
                    existing.append(int(p.name[len('recon-'):]))
                except ValueError:
                    pass
    return f'recon-{max(existing, default=0) + 1}'


def _reconstruct_worker(project_id, recon_id, kind_hint, engine_pref, source_path, status_path, profile_path):
    """Daemon-thread worker: turn one uploaded still/footage into a viewer
    profile. Best-effort - records an 'error' state rather than raising. Reuses
    moodboard_media's frame sampling for footage and _write_moodboard_status for
    progress (both generic).

    engine_pref ('sharp'|'depth'): 'sharp' runs Apple ml-sharp -> a 3D Gaussian
    Splat .ply (viewer_mode='splat'), falling back to monocular depth if SHARP
    isn't available or fails; 'depth' forces the light 2.5D path. Panoramas
    always use the 360 sphere viewer regardless (SHARP is single-view frontal).
    """
    recon_dir = premiere_reconstruct_dir(project_id, recon_id)
    try:
        recon_dir.mkdir(parents=True, exist_ok=True)
        source_path = Path(source_path)

        # Footage -> reconstruct a single representative frame.
        if source_path.suffix.lower() in _RECONSTRUCT_VIDEO_EXTS:
            _write_moodboard_status(status_path, 'reconstructing', 'sampling', 'Sampling a frame ...')
            frames = moodboard_media.sample_frames(source_path, recon_dir / 'frames', count=1)
            if not frames:
                _write_moodboard_status(status_path, 'error', '', 'Could not read a frame from the footage.')
                return
            working_image = frames[0]
            base_kind = 'footage'
        else:
            working_image = source_path
            base_kind = None  # a photo - detect flat vs panorama below

        # Kind: an explicit UI hint (auto/photo/panorama radio) wins; otherwise
        # detect equirectangular. base_kind is 'footage' for a sampled clip
        # frame, None for a photo. A panorama (hinted or detected) always wins
        # since it drives a different viewer.
        if kind_hint == 'panorama':
            input_kind = 'panorama'
        elif kind_hint in ('photo', 'footage'):
            input_kind = base_kind or 'flat'
        else:
            detected = depth_media.detect_input_kind(working_image)
            input_kind = 'panorama' if detected == 'panorama' else (base_kind or 'flat')

        is_panorama = (input_kind == 'panorama')
        _write_moodboard_status(status_path, 'reconstructing', 'coloring', 'Preparing color ...')
        color_path, (width, height) = depth_media.prepare_color(working_image, recon_dir, is_panorama=is_panorama)

        depth_path = None
        gaussians_path = None
        scene = None
        engine = 'none'
        viewer_mode = None

        if is_panorama:
            viewer_mode = 'pano'  # single-view SHARP/depth don't apply to a 360 pano
        elif engine_pref == 'sharp' and sharp_media.is_available():
            _write_moodboard_status(status_path, 'reconstructing', 'splatting',
                                    'Reconstructing 3D Gaussian splats (first run downloads the model) ...')
            gaussians_path = sharp_media.run_sharp_predict(color_path, recon_dir)
            if gaussians_path is not None:
                viewer_mode = 'splat'
                engine = 'ml-sharp'
                scene = sharp_media.scene_bounds(gaussians_path)

        if viewer_mode is None:
            # 'depth' engine, or a SHARP miss/failure -> monocular-depth fallback.
            _write_moodboard_status(status_path, 'reconstructing', 'depth', 'Estimating depth ...')
            depth_path = depth_media.estimate_depth(color_path, recon_dir)
            if depth_path is not None:
                viewer_mode = 'depth-displace'
                engine = 'depth-anything-v2-small'
            else:
                viewer_mode = 'flat'  # depth model unavailable/failed - graceful

        profile = {
            'recon_id': recon_id,
            'input_kind': input_kind,
            'viewer_mode': viewer_mode,
            'engine': engine,
            'color_url': _preview_url_for(color_path),
            'depth_url': _preview_url_for(depth_path) if depth_path is not None else None,
            'gaussians_url': _preview_url_for(gaussians_path) if gaussians_path is not None else None,
            'source_url': _preview_url_for(source_path) if source_path.is_file() else None,
            'scene_center': scene['center'] if scene else None,
            'camera_position': scene['camera'] if scene else None,
            'scene_radius': scene['radius'] if scene else None,
            'width': width,
            'height': height,
        }
        try:
            profile_path.write_text(json.dumps(profile, indent=2))
        except OSError:
            pass
        _write_moodboard_status(status_path, 'ready', 'done', 'Ready', profile=profile)
    except Exception as exc:  # best-effort worker - never let the thread die silently
        _write_moodboard_status(status_path, 'error', '', f'Reconstruction failed: {exc}')


@app.route('/reconstruct/add', methods=['POST'])
def reconstruct_add():
    # multipart upload (a photo/panorama/footage file). Allocates a recon_id,
    # seeds status.json BEFORE the thread starts (so an immediate poll sees
    # 'reconstructing', not a missing file - same race-avoidance as
    # /moodboard/add_reference), then reconstructs on a daemon thread.
    uploaded = request.files.get('file')
    if uploaded is None:
        return jsonify({'error': 'a file is required'}), 400
    project_id = (request.form.get('project_id') or '').strip() or next_premiere_project_id()
    kind_hint = (request.form.get('kind') or '').strip().lower() or None
    # 'sharp' (Gaussian splats, default) or 'depth' (light 2.5D). SHARP falls
    # back to depth automatically when it isn't installed/available.
    engine_pref = (request.form.get('engine') or 'sharp').strip().lower()
    if engine_pref not in ('sharp', 'depth'):
        engine_pref = 'sharp'

    media_bytes = uploaded.read()
    if len(media_bytes) > MAX_FOOTAGE_SIZE_MB * 1024 * 1024:
        return jsonify({'error': f'file exceeds max size of {MAX_FOOTAGE_SIZE_MB}MB'}), 400

    recon_id = _allocate_reconstruct_id(project_id)
    recon_dir = premiere_reconstruct_dir(project_id, recon_id)
    recon_dir.mkdir(parents=True, exist_ok=True)
    filename = secure_filename(uploaded.filename) or 'source'
    source_path = recon_dir / f'source_{filename}'
    source_path.write_bytes(media_bytes)
    if source_path.suffix.lower() in _RECONSTRUCT_VIDEO_EXTS:
        remux_for_reliable_playback(source_path)

    status_path = recon_dir / 'status.json'
    profile_path = recon_dir / 'profile.json'
    status_path.write_text(json.dumps({'state': 'reconstructing', 'step': 'starting', 'message': 'Reconstructing ...'}))
    threading.Thread(
        target=_reconstruct_worker,
        args=(project_id, recon_id, kind_hint, engine_pref, str(source_path), status_path, profile_path),
        daemon=True,
    ).start()

    return jsonify({'project_id': project_id, 'recon_id': recon_id, 'state': 'reconstructing'})


@app.route('/reconstruct/status', methods=['GET'])
def reconstruct_status():
    # Polled by the frontend after /reconstruct/add - reads back status.json
    # (same shape as /moodboard/reference_status and /render/status).
    project_id = (request.args.get('project_id') or '').strip()
    recon_id = (request.args.get('recon_id') or '').strip()
    if not project_id or not recon_id:
        return jsonify({'error': 'project_id and recon_id are required'}), 400
    status_path = premiere_reconstruct_dir(project_id, recon_id) / 'status.json'
    if not status_path.is_file():
        return jsonify({'state': 'unknown', 'step': '', 'message': 'No such reconstruction.'})
    try:
        return jsonify(json.loads(status_path.read_text()))
    except (OSError, ValueError):
        return jsonify({'state': 'unknown', 'step': '', 'message': 'Could not read reconstruction status.'})


# --- Evaluation harness (evaluation.html): generate a MATRIX of shot examples
# for ONE fixed scene across combinations of documentary technique × mode ×
# track (Primary/Cutaway), using the exact same prompt construction the
# storyboard uses (generate_shot_plan -> framing_directive -> generate_sketch /
# generate_shot_video). Mirrors the moodboard/reconstruct worker+poll pattern.

MAX_EVAL_CELLS = 24  # bound the batch (each cell is an LLM call + image [+ ~1min video])
_EVAL_ROLE_MAP = {'primary': 'Primary', 'cutaway': 'Cutaway', 'aroll': 'Primary', 'broll': 'Cutaway',
                  'a-roll': 'Primary', 'b-roll': 'Cutaway'}
_EVAL_ACT_PLANS_PER_MODE = 3
_EVAL_VARIANT_DIRECTIONS = (
    ('orient', 'pan', 'Gently pan across the scene to orient the viewer.'),
    ('inspect', 'push_in', 'Slowly push toward the key subject or detail so the viewer can inspect it.'),
    ('reveal', 'pull_out', 'Pull back gradually to reveal the wider context around the subject.'),
    ('accompany', 'tracking', 'Track smoothly alongside the subject as the action unfolds.'),
    ('observe', 'static', 'Hold the composition with only subtle environmental motion.'),
    ('connect', 'tilt', 'Tilt deliberately to connect the subject with the surrounding space.'),
)


@app.route('/catalogs', methods=['GET'])
def catalogs():
    # The full mode/technique/track vocabularies so evaluation.html can build its
    # axis selectors without duplicating ~55 technique keys.
    return jsonify({
        'modes': [{'key': m['key'], 'label': m['label']} for m in DOCUMENTARY_MODES],
        'techniques': [{'key': t['key'], 'label': t['label']} for t in DOCUMENTARY_TECHNIQUES],
        'roles': [{'key': 'Primary', 'label': 'Primary'}, {'key': 'Cutaway', 'label': 'Cutaway'}],
    })


def _allocate_eval_run_id(project_id):
    root = premiere_project_dir(project_id) / 'eval'
    existing = []
    if root.exists():
        for p in root.iterdir():
            if p.is_dir() and p.name.startswith('run-'):
                try:
                    existing.append(int(p.name[len('run-'):]))
                except ValueError:
                    pass
    return f'run-{max(existing, default=0) + 1}'


def _eval_worker(project_id, run_id, scene, moodboard, cells, want_video, wildness, status_path, manifest_path,
                 act_sweep=False, technique_pool=None):
    """Daemon-thread worker: one image (+ optional video) per legacy
    technique×mode×track cell, or per act-mode shot plan in act_sweep mode.
    Best-effort per cell (a failure is recorded and the rest continue).
    Two phases so the grid is usable quickly: all images concurrently, then the
    heavier Veo videos at low concurrency. Writes the growing cell list to
    status.json after each step so the page can render partial results live."""
    eval_dir = premiere_eval_dir(project_id, run_id)
    total = len(cells)
    results = [None] * total  # aligned to cells

    def _clean(entry):
        return {k: v for k, v in entry.items() if not k.startswith('_')}

    def _write(state, done, message):
        payload = {'state': state, 'step': message, 'message': message, 'done': done,
                   'total': total, 'cells': [_clean(r) for r in results if r is not None]}
        # Atomic write (temp + os.replace) so a concurrent /eval/status poll never
        # reads a half-written file - this status.json is rewritten frequently as
        # cells complete across the worker's threads.
        try:
            tmp = status_path.parent / (status_path.name + '.tmp')
            tmp.write_text(json.dumps(payload))
            os.replace(tmp, status_path)
        except OSError:
            pass

    try:
        eval_dir.mkdir(parents=True, exist_ok=True)
        title = scene.get('title', '')
        scene_notes = scene.get('scene_notes', '')
        narration = scene.get('narration', '')
        act_title = scene.get('act_title', '')
        abstract = scene.get('abstract', '')

        # Phase 1 - one image per cell (each with its own shot_plan so the SUBJECT
        # reflects that mode/role/technique, exactly like the storyboard).
        def _image_cell(i_cell):
            i, cell = i_cell
            technique, mode, role = cell.get('technique', ''), cell['mode'], cell.get('role', 'Act plan')
            entry = {'index': i, 'technique': technique, 'mode': mode, 'role': role,
                     'image_url': None, 'video_url': None}
            try:
                variant_index = int(cell.get('plan_index', 0)) if act_sweep else 0
                if act_sweep:
                    # Use a stable per-run seed so retries/reloads do not make
                    # the same matrix jump between technique combinations.
                    pool = [t for t in (technique_pool or []) if t]
                    rng = random.Random(f'{run_id}:{mode}:{variant_index}')
                    rng.shuffle(pool)
                    subset_size = min(len(pool), 1 + (variant_index % 3))
                    selected_techniques = pool[:subset_size] or []
                    operation, movement, animation_direction = _EVAL_VARIANT_DIRECTIONS[
                        variant_index % len(_EVAL_VARIANT_DIRECTIONS)]
                    variant_notes = (
                        f"{scene_notes}\nVariant direction (AUTHORITATIVE): narrative operation={operation}; "
                        f"camera movement={movement}. {animation_direction}"
                    ).strip()
                    entry['plan_index'] = variant_index + 1
                    entry['techniques'] = selected_techniques
                    entry['technique'] = ', '.join(selected_techniques) or 'No selected techniques'
                    entry['role'] = 'Act plan'
                else:
                    selected_techniques = [technique]
                    variant_notes = scene_notes
                    operation = movement = animation_direction = ''
                shot_plan = shot_plan_client.generate_shot_plan(
                    title, variant_notes, narration, act_title, mode,
                    techniques=selected_techniques, moodboard=moodboard, abstract=abstract, role=role,
                    wildness=wildness)
                if act_sweep:
                    # Enforce distinct operation/movement pairings even if the
                    # planner returns a duplicate after a transient retry.
                    shot_plan['narrative_operation'] = operation
                    shot_plan['movement'] = movement
                visual = (shot_plan.get('visual_description') or '').strip()[:MAX_SKETCH_VISUAL_CHARS]
                framing = framing_directive(shot_plan.get('shot_size'), selected_techniques)
                entry['prompt'] = _build_image_prompt(visual, mode, 'shot_frame', framing)
                entry['shot_size'] = shot_plan.get('shot_size')
                entry['movement'] = shot_plan.get('movement')
                entry['narrative_operation'] = shot_plan.get('narrative_operation')
                entry['visual_description'] = visual
                entry['framing'] = framing
                png = sketch_client.generate_sketch(visual, mode, style='shot_frame', framing=framing)
                p = eval_dir / f'cell_{i}.png'
                p.write_bytes(png)
                entry['image_url'] = _preview_url_for(p)
                entry['_png_path'] = str(p)
            except Exception as exc:
                entry['error'] = f'image failed: {exc}'
            results[i] = entry
            return entry

        _write('running', 0, 'Generating images ...')
        done = 0
        with ThreadPoolExecutor(max_workers=4) as pool:
            for _ in pool.map(_image_cell, list(enumerate(cells))):
                done += 1
                _write('running', done, f'Generated {done}/{total} images ...')

        # Phase 2 - one Veo clip per cell (batched, low concurrency).
        if want_video and animate_client.is_configured():
            targets = [e for e in results if e and e.get('_png_path')]
            vdone = 0

            def _video_cell(entry):
                try:
                    png = Path(entry['_png_path']).read_bytes()
                    mp4 = animate_client.generate_shot_video(
                        png, entry.get('movement'), entry['mode'], framing=entry.get('framing'),
                        techniques=entry.get('techniques') or [],
                        narrative_operation=entry.get('narrative_operation') or '',
                        animation_direction=(
                            next((d for op, mv, d in _EVAL_VARIANT_DIRECTIONS
                                  if op == entry.get('narrative_operation') and mv == entry.get('movement')), '')
                            if act_sweep else ''),
                    )
                    vp = eval_dir / f"cell_{entry['index']}.mp4"
                    vp.write_bytes(mp4)
                    remux_for_reliable_playback(vp)
                    entry['video_url'] = _preview_url_for(vp)
                except Exception as exc:
                    entry['video_error'] = f'video failed: {exc}'
                return entry

            with ThreadPoolExecutor(max_workers=2) as pool:
                for _ in pool.map(_video_cell, targets):
                    vdone += 1
                    _write('running', total, f'Rendering videos {vdone}/{len(targets)} ...')

        manifest = {'run_id': run_id, 'total': total, 'cells': [_clean(e) for e in results if e]}
        try:
            manifest_path.write_text(json.dumps(manifest, indent=2))
        except OSError:
            pass
        _write('ready', total, 'Done')
    except Exception as exc:  # best-effort worker
        _write('error', 0, f'Evaluation failed: {exc}')


@app.route('/eval/run', methods=['POST'])
def eval_run():
    data = request.get_json(silent=True) or {}
    scene_in = data.get('scene')
    if not isinstance(scene_in, dict):
        return jsonify({'error': 'scene must be an object'}), 400
    scene = {
        'title': (scene_in.get('title') or '').strip()[:MAX_STORYBOARD_SECTION_CHARS],
        'scene_notes': (scene_in.get('scene_notes') or '').strip()[:MAX_STORYBOARD_SECTION_CHARS],
        'narration': (scene_in.get('narration') or '').strip()[:MAX_NARRATION_TRANSCRIPT_CHARS],
        'act_title': (scene_in.get('act_title') or '').strip()[:MAX_STORYBOARD_SECTION_CHARS],
        'abstract': (scene_in.get('abstract') or '').strip()[:MAX_ABSTRACT_CHARS],
    }

    techniques = list(dict.fromkeys(
        t for t in (data.get('techniques') or []) if isinstance(t, str) and t in DOCUMENTARY_TECHNIQUE_KEYS))
    modes = list(dict.fromkeys(
        m for m in (data.get('modes') or []) if isinstance(m, str) and m in DOCUMENTARY_MODE_KEYS))
    roles = []
    for r in (data.get('roles') or []):
        if isinstance(r, str):
            rr = _EVAL_ROLE_MAP.get(r.strip().lower(), r.strip())
            if rr in ('Primary', 'Cutaway') and rr not in roles:
                roles.append(rr)
    act_sweep = bool(data.get('act_sweep'))
    if act_sweep:
        if not modes:
            return jsonify({'error': 'select at least one documentary mode'}), 400
        # An empty checklist still produces varied plans by sampling from the
        # complete documentary-technique catalog.
        if not techniques:
            techniques = list(DOCUMENTARY_TECHNIQUE_KEYS)
        # The selected techniques form the pool; every plan receives a stable,
        # random non-empty subset of that pool. Three plans per mode provide
        # distinct operation/movement pairings without exploding the run size.
        cells = [
            {'mode': m, 'plan_index': i, 'role': 'Act plan', 'technique': ''}
            for m in modes for i in range(_EVAL_ACT_PLANS_PER_MODE)
        ]
    else:
        if not techniques or not modes or not roles:
            return jsonify({'error': 'select at least one technique, one mode, and one track'}), 400
        # Grouped by mode, then technique, then role - matches evaluation.html's grid.
        cells = [{'technique': t, 'mode': m, 'role': r} for m in modes for t in techniques for r in roles]
    if len(cells) > MAX_EVAL_CELLS:
        return jsonify({'error': f'matrix too large ({len(cells)} cells > max {MAX_EVAL_CELLS}); pick fewer options'}), 400

    want_video = bool(data.get('video'))
    try:
        wildness = max(0.0, min(1.0, float(data.get('wildness') or 0)))
    except (TypeError, ValueError):
        wildness = 0.0
    moodboard = _parse_moodboard_profiles(data)
    project_id = (data.get('project_id') or '').strip() or next_premiere_project_id()

    if not (shot_plan_client.is_configured() and sketch_client.is_configured()):
        return jsonify({'error': _SKETCH_NOT_CONFIGURED_ERROR}), 503

    run_id = _allocate_eval_run_id(project_id)
    eval_dir = premiere_eval_dir(project_id, run_id)
    eval_dir.mkdir(parents=True, exist_ok=True)
    status_path = eval_dir / 'status.json'
    manifest_path = eval_dir / 'manifest.json'
    status_path.write_text(json.dumps(
        {'state': 'running', 'step': 'starting', 'message': 'Starting ...', 'done': 0, 'total': len(cells), 'cells': []}))
    threading.Thread(
        target=_eval_worker,
        args=(project_id, run_id, scene, moodboard, cells, want_video, wildness, status_path, manifest_path,
              act_sweep, techniques),
        daemon=True,
    ).start()
    return jsonify({'project_id': project_id, 'run_id': run_id, 'state': 'running', 'total': len(cells)})


@app.route('/eval/status', methods=['GET'])
def eval_status():
    project_id = (request.args.get('project_id') or '').strip()
    run_id = (request.args.get('run_id') or '').strip()
    if not project_id or not run_id:
        return jsonify({'error': 'project_id and run_id are required'}), 400
    status_path = premiere_eval_dir(project_id, run_id) / 'status.json'
    if not status_path.is_file():
        return jsonify({'state': 'unknown', 'message': 'No such evaluation run.'})
    try:
        return jsonify(json.loads(status_path.read_text()))
    except (OSError, ValueError):
        return jsonify({'state': 'unknown', 'message': 'Could not read evaluation status.'})


@app.route('/moodboard/distill', methods=['POST'])
def moodboard_distill():
    # Distills the analyzed reference profiles into suggested arcs (with the
    # paper's sections mapped in, like /paper/suggest_arcs) plus a suggested
    # documentary mode + techniques. Replaces the narration-driven
    # /paper/suggest_arcs as the entry point's distillation step.
    data = request.get_json(silent=True) or {}
    references_raw = data.get('references')
    if not isinstance(references_raw, list) or not references_raw:
        return jsonify({'error': 'references is required and must be a non-empty list'}), 400

    references = []
    for ref in references_raw[:MAX_MOODBOARD_REFERENCES]:
        if not isinstance(ref, dict):
            continue
        references.append({
            'title': (ref.get('title') or '').strip()[:MAX_STORYBOARD_SECTION_CHARS],
            'source_kind': (ref.get('source_kind') or '').strip()[:40],
            'visual_style': (ref.get('visual_style') or '').strip()[:MAX_MOODBOARD_REF_FIELD_CHARS],
            'observed_techniques': [t for t in (ref.get('observed_techniques') or []) if isinstance(t, str)][:8],
            'tone': (ref.get('tone') or '').strip()[:200],
            'pacing': (ref.get('pacing') or '').strip()[:200],
            'transcript_summary': (ref.get('transcript_summary') or '').strip()[:MAX_MOODBOARD_REF_FIELD_CHARS],
            'transcript': (ref.get('transcript') or '').strip()[:MAX_MOODBOARD_REF_FIELD_CHARS],
            'note': (ref.get('note') or '').strip()[:MAX_MOODBOARD_NOTE_CHARS],
        })
    if not references:
        return jsonify({'error': 'no valid references'}), 400

    abstract = (data.get('abstract') or '').strip()[:MAX_ABSTRACT_CHARS]

    sections = None
    sections_raw = data.get('sections')
    if isinstance(sections_raw, list):
        sections = [
            {
                'index': s['index'],
                'title': (s.get('title') or '').strip()[:MAX_STORYBOARD_SECTION_CHARS],
                'snippet': (s.get('snippet') or '').strip()[:MAX_SECTION_SNIPPET_CHARS],
            }
            for s in sections_raw[:MAX_STORYBOARD_SECTIONS]
            if isinstance(s, dict) and isinstance(s.get('index'), int)
        ]

    if not narrative_arc_client.is_configured():
        return jsonify({'error': _NARRATIVE_ARC_NOT_CONFIGURED_ERROR}), 503

    try:
        recommended, alternatives, mode, techniques, rationale = narrative_arc_client.distill_from_moodboard(
            references, abstract, sections)
    except NarrativeArcLLMCallError as exc:
        return jsonify({'error': str(exc)}), 500

    return jsonify({
        'recommended': recommended,
        'alternatives': alternatives,
        'suggested_mode': mode,
        'suggested_techniques': techniques,
        'style_rationale': rationale,
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
            'error': 'Transcription requires a direct OpenAI key. Set OPENAI_API_KEY in backend/.env.'
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
            'error': 'Suggesting learning objectives requires a proxy LLM key. Set PROXY_API_KEY (and PROXY_BASE_URL) in backend/.env.'
        }), 503

    try:
        result = objectives_client.suggest_objectives(audience, scope_label, slides)
    except ObjectivesLLMCallError as exc:
        return jsonify({'error': str(exc)}), 500

    return jsonify({'objectives': result['objectives'], 'audience_questions': result['audience_questions']})


_ASSESSMENT_NOT_CONFIGURED_ERROR = (
    'Simulating an audience requires a proxy LLM key. Set PROXY_API_KEY (and PROXY_BASE_URL) in backend/.env.'
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
