"""Stage 5: candidate boundary detection.

Headings are "forced" boundaries, decided by structure alone - not one vote
in a weighted sum - so heading-heavy documents (e.g. Wikipedia extracts)
aren't swamped by noisy soft signals fighting for the same threshold.

All soft signals are intrinsically bounded to [0, 1] rather than min-max
normalized per document: per-document normalization would always rescale the
single largest gap in a document to 1.0 regardless of true magnitude, which
manufactures a "strong" boundary out of pure noise on any short or
topically-homogeneous document.
"""
from dataclasses import dataclass
from typing import Dict, List, Set, Tuple

import numpy as np

from .config import BoundaryReason, BoundaryWeights
from .entities import entity_text_set


@dataclass
class BoundaryScore:
    index: int  # boundary sits between units[index - 1] and units[index]
    score: float
    reason: BoundaryReason


def cosine_similarity(a, b) -> float:
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def jaccard_distance(set_a: Set, set_b: Set) -> float:
    union = set_a | set_b
    if not union:
        return 0.0
    return 1.0 - len(set_a & set_b) / len(union)


def is_heading_boundary(prev_unit, unit) -> bool:
    return (
        unit.section_title != prev_unit.section_title
        or unit.subsection_title != prev_unit.subsection_title
    )


def _dominant_reason(semantic_distance, entity_shift, keyphrase_shift) -> BoundaryReason:
    if entity_shift >= keyphrase_shift and entity_shift >= semantic_distance:
        return BoundaryReason.ENTITY_SHIFT
    if keyphrase_shift >= semantic_distance:
        return BoundaryReason.KEYPHRASE_SHIFT
    return BoundaryReason.SEMANTIC_SHIFT


def pairwise_signals(prev_unit, unit, unit_embeddings, unit_entities, unit_keyphrases):
    semantic_distance = (1 - cosine_similarity(
        unit_embeddings[prev_unit.unit_id], unit_embeddings[unit.unit_id]
    )) / 2
    entity_shift = jaccard_distance(
        entity_text_set(unit_entities[prev_unit.unit_id]),
        entity_text_set(unit_entities[unit.unit_id]),
    )
    keyphrase_shift = jaccard_distance(
        unit_keyphrases[prev_unit.unit_id], unit_keyphrases[unit.unit_id]
    )
    return semantic_distance, entity_shift, keyphrase_shift


class BoundaryScorer:
    def __init__(self, weights: BoundaryWeights = None, threshold: float = 0.45):
        self.weights = weights or BoundaryWeights()
        self.threshold = threshold

    def score(
        self, units, unit_embeddings: Dict[str, np.ndarray], unit_entities, unit_keyphrases
    ) -> Tuple[Set[int], List[BoundaryScore]]:
        n = len(units)
        forced: Set[int] = set()
        soft: List[BoundaryScore] = []

        if n < 2:
            return forced, soft

        for i in range(1, n):
            prev_unit, unit = units[i - 1], units[i]
            if is_heading_boundary(prev_unit, unit):
                forced.add(i)
                continue

            semantic_distance, entity_shift, keyphrase_shift = pairwise_signals(
                prev_unit, unit, unit_embeddings, unit_entities, unit_keyphrases
            )
            score = (
                self.weights.semantic * semantic_distance
                + self.weights.entity * entity_shift
                + self.weights.keyphrase * keyphrase_shift
            )
            if score >= self.threshold:
                reason = _dominant_reason(semantic_distance, entity_shift, keyphrase_shift)
                soft.append(BoundaryScore(index=i, score=score, reason=reason))

        return forced, soft
