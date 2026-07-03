"""
Local HTTP service exposing the structure-aware semantic segmentation
pipeline (see segmentation/) to the static frontend in rehearsal_mvp_2/,
which has no server or package manager of its own. Run with:
python server.py (listens on http://127.0.0.1:8000).

Optional LLM-based segment labeling (richer topic labels/entities/summaries
than the local fallback) activates automatically when an API key is present:
  OPENAI_API_KEY or OPENROUTER_API_KEY   (+ OPENAI_BASE_URL for OpenRouter)
These can be exported in the shell, or dropped in a .env file in this
directory (see .env.example) - loaded below before anything reads them.
See segmentation/llm.py for details - no key is required to run the app.
"""
from dotenv import load_dotenv

load_dotenv()  # populate os.environ from backend/.env, if present, before any env var is read

from flask import Flask, jsonify, request
from flask_cors import CORS

from segmentation import PipelineConfig, SegmentationPipeline

# Structural parsing + NER run in roughly linear time, but boundary scoring
# and refinement are O(n^2)-ish over base units, so this caps worst-case
# request latency on a pathologically long upload. Applied to the raw input
# before structure parsing (cheaper than checking after the fact).
MAX_CHARS = 200_000

app = Flask(__name__)
CORS(app)

pipeline = SegmentationPipeline(PipelineConfig())


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


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=8000)
