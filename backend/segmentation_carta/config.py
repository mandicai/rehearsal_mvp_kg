"""Configuration knobs for the segmentation_carta pipeline (see pipeline.py).

Separate from segmentation/config.py by design - this is an independent
pipeline, not a variant of the existing one."""
from dataclasses import dataclass


@dataclass
class CartaConfig:
    # chunking (stage 1)
    chunk_target_words: int = 600         # approx. token-count proxy per chunk, keeps each LLM call well under context limits
    chunk_overlap_words: int = 80         # trailing words repeated at the start of the next chunk (sliding window)
    context_sentences_per_chunk: int = 2  # representative sentences pulled from each chunk into the rolling context summary
    max_context_summary_words: int = 120  # cap on the rolling summary handed to later chunks; oldest sentences dropped first

    # entity mention extraction (stage 2)
    llm_model: str = 'gpt-4o-mini'

    # similarity-based clustering (stage 7): weighted combination of label
    # similarity (Levenshtein), entity-type similarity (Levenshtein, entities
    # only), and description similarity (embedding cosine similarity).
    # Weights are normalized per pair-scoring function, so they don't need to
    # sum to 1 (predicates have no type term and renormalize over label+description only).
    similarity_label_weight: float = 0.2
    similarity_type_weight: float = 0.2
    similarity_description_weight: float = 0.6
    similarity_cluster_threshold: float = 0.82  # min combined score to treat two items as candidate duplicates
