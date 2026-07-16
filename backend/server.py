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
"""
from datetime import datetime, timezone

from dotenv import load_dotenv

load_dotenv()  # populate os.environ from backend/.env, if present, before any env var is read

from flask import Flask, jsonify, request
from flask_cors import CORS

from segmentation import PipelineConfig, SegmentationPipeline
from segmentation_carta import CartaConfig, CartaPipeline
from segmentation_carta.llm import CartaLLMCallError
from feedback_llm import FeedbackLLMClient, LLMCallError as FeedbackLLMCallError
from ingest import IngestConfig, render_pptx_to_slides, PptxRenderError, SofficeNotFoundError
from ingest import next_rehearsal_run_id, project_dir, snapshots_dir, save_project, PROJECTS_DIR
from ingest import TranscriptionClient, TranscriptionCallError
from ingest import align_transcript, AlignError
from ingest import ObjectivesLLMClient, ObjectivesLLMCallError
from ingest import AssessmentLLMClient, AssessmentLLMCallError

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

app = Flask(__name__)
CORS(app)
app.config['MAX_CONTENT_LENGTH'] = max(MAX_PPTX_SIZE_MB, MAX_AUDIO_SIZE_MB) * 1024 * 1024

pipeline = SegmentationPipeline(PipelineConfig())
carta_pipeline = CartaPipeline(CartaConfig())
feedback_client = FeedbackLLMClient()
ingest_config = IngestConfig()
transcription_client = TranscriptionClient(model=ingest_config.transcription_model)
objectives_client = ObjectivesLLMClient()
assessment_client = AssessmentLLMClient()


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
        segments = pipeline.run(text, document_id=document_id)
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
    # the frontend calls this once per slide, in order, carrying the growing
    # `messages` conversation forward itself between calls - this route is
    # stateless like every other route here, so nothing is stored server-side.
    data = request.get_json(silent=True) or {}
    audience = (data.get('audience') or '').strip()
    prompt = (data.get('prompt') or '').strip()
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
        reaction, updated_messages = feedback_client.get_progressive_reaction(audience, prompt, messages, slide)
    except FeedbackLLMCallError as exc:
        return jsonify({'error': str(exc)}), 500

    return jsonify({'reaction': reaction, 'messages': updated_messages})


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
    app.run(host='127.0.0.1', port=8000)
