"""Stage 7: score how similar two entities (or two predicates) are, as a
precursor to stage 8's LLM-confirmed deduplication - following Carta et al.,
2023's weighted-combination similarity score:

- Label similarity: normalized Levenshtein distance between the two names/predicates.
- Type similarity (entities only): normalized Levenshtein distance between the two entities' sorted, joined type lists.
- Description similarity: cosine similarity between sentence-embeddings of the two descriptions.

Predicates have no "types", so predicate_pair_similarity renormalizes over
just the label and description weights.

Uses the same sentence-transformers model segmentation/embeddings.py uses,
but loaded independently here - segmentation_carta doesn't import from
segmentation/ by design (see chunking.py's docstring for the same point).
"""
import numpy as np
from sentence_transformers import SentenceTransformer

_EMBEDDING_MODEL_NAME = 'all-MiniLM-L6-v2'
_model = None


def _get_model():
    global _model
    if _model is None:
        _model = SentenceTransformer(_EMBEDDING_MODEL_NAME)
    return _model


def embed_descriptions(descriptions: list) -> np.ndarray:
    """Batch-embed every description once (L2-normalized), so pairwise
    comparisons are a cheap dot product instead of re-embedding per pair."""
    model = _get_model()
    return np.asarray(model.encode(list(descriptions), normalize_embeddings=True))


def _levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        curr = [i] + [0] * len(b)
        for j, cb in enumerate(b, start=1):
            cost = 0 if ca == cb else 1
            curr[j] = min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
        prev = curr
    return prev[-1]


def _label_similarity(a: str, b: str) -> float:
    a, b = (a or '').strip().lower(), (b or '').strip().lower()
    if not a and not b:
        return 1.0
    return 1 - _levenshtein(a, b) / max(len(a), len(b), 1)


def _types_similarity(types_a, types_b) -> float:
    a = ','.join(sorted(t.strip().lower() for t in (types_a or [])))
    b = ','.join(sorted(t.strip().lower() for t in (types_b or [])))
    return _label_similarity(a, b)


def _cosine_similarity(vec_a, vec_b) -> float:
    # already L2-normalized by embed_descriptions, so the dot product is cosine similarity
    return float(np.dot(vec_a, vec_b))


def entity_pair_similarity(entity_a: dict, entity_b: dict, embedding_a, embedding_b, config) -> float:
    label_sim = _label_similarity(entity_a['name'], entity_b['name'])
    type_sim = _types_similarity(entity_a.get('types'), entity_b.get('types'))
    desc_sim = _cosine_similarity(embedding_a, embedding_b)
    return (
        config.similarity_label_weight * label_sim
        + config.similarity_type_weight * type_sim
        + config.similarity_description_weight * desc_sim
    )


def predicate_pair_similarity(predicate_a: dict, predicate_b: dict, embedding_a, embedding_b, config) -> float:
    label_sim = _label_similarity(predicate_a['predicate'], predicate_b['predicate'])
    desc_sim = _cosine_similarity(embedding_a, embedding_b)
    total_weight = config.similarity_label_weight + config.similarity_description_weight
    return (config.similarity_label_weight * label_sim + config.similarity_description_weight * desc_sim) / total_weight
