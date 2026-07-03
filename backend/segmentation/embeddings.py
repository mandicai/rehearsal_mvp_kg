"""Stage 3: semantic embeddings for base units, with optional sliding windows.

Default model is 'all-MiniLM-L6-v2' - a general-purpose sentence embedding
model, chosen over the old pipeline's 'allenai-specter' (tuned for academic
paper title+abstract similarity) since this pipeline runs over arbitrary
prose: presentation transcripts, Wikipedia articles, uploaded docs.
"""
import numpy as np
from sentence_transformers import SentenceTransformer


class EmbeddingModel:
    def __init__(self, model_name='all-MiniLM-L6-v2', device=None):
        self.model = SentenceTransformer(model_name, device=device)

    def encode(self, texts):
        if not texts:
            return np.zeros((0, self.model.get_sentence_embedding_dimension()))
        return np.asarray(self.model.encode(list(texts)))


def windowed_embeddings(unit_embeddings: np.ndarray, window_size: int) -> np.ndarray:
    """Average each embedding with its (window_size - 1) neighbors so boundary
    decisions use local context rather than an isolated unit. window_size <= 1
    is a no-op (windowing disabled, the pipeline default)."""
    n = len(unit_embeddings)
    if window_size <= 1 or n == 0:
        return unit_embeddings

    half = window_size // 2
    windowed = np.zeros_like(unit_embeddings)
    for i in range(n):
        lo = max(0, i - half)
        hi = min(n, i + half + 1)
        windowed[i] = unit_embeddings[lo:hi].mean(axis=0)
    return windowed
