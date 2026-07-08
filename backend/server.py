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
from dotenv import load_dotenv

load_dotenv()  # populate os.environ from backend/.env, if present, before any env var is read

from flask import Flask, jsonify, request
from flask_cors import CORS

from segmentation import PipelineConfig, SegmentationPipeline
from segmentation_carta import CartaConfig, CartaPipeline
from segmentation_carta.llm import CartaLLMCallError
from feedback_llm import FeedbackLLMClient, LLMCallError as FeedbackLLMCallError

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

app = Flask(__name__)
CORS(app)

pipeline = SegmentationPipeline(PipelineConfig())
carta_pipeline = CartaPipeline(CartaConfig())
feedback_client = FeedbackLLMClient()


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


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=8000)
