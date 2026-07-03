"""Stage 6-7: entity-continuity refinement and length-constraint enforcement.

Only soft (scored) boundaries are ever reconsidered here - forced heading
boundaries are always respected, since a new heading is a document-author
signal, not something a similarity heuristic should be allowed to override.
"""
from dataclasses import dataclass
from typing import Dict, List, Set

import numpy as np

from .boundaries import BoundaryScore, cosine_similarity, jaccard_distance, pairwise_signals
from .config import BoundaryReason, PipelineConfig
from .entities import entity_text_set

_CONTINUITY_PRONOUNS = {
    'this', 'that', 'these', 'those', 'it', 'they', 'him', 'her', 'them',
}
_MAX_LENGTH_PASSES = 3


@dataclass
class Segment:
    units: List
    start_reason: BoundaryReason
    end_reason: BoundaryReason

    @property
    def char_start(self) -> int:
        return self.units[0].char_start

    @property
    def char_end(self) -> int:
        return self.units[-1].char_end

    @property
    def word_count(self) -> int:
        return sum(len(u.text.split()) for u in self.units)

    @property
    def sentence_count(self) -> int:
        return sum(
            sum(1 for _ in u.spacy_doc.sents) for u in self.units if u.spacy_doc is not None
        )

    @property
    def section_title(self):
        return self.units[0].section_title if self.units else None

    @property
    def subsection_title(self):
        return self.units[0].subsection_title if self.units else None

    @property
    def source_paragraph_indices(self) -> List[int]:
        indices = []
        for u in self.units:
            indices.extend(u.source_paragraph_indices)
        return indices

    @property
    def is_list_only(self) -> bool:
        return bool(self.units) and all(u.is_list for u in self.units)


def _starts_with_reference_pronoun(unit) -> bool:
    if unit.spacy_doc is None:
        return False
    tokens = [t for t in unit.spacy_doc if not t.is_space]
    return bool(tokens) and tokens[0].text.lower() in _CONTINUITY_PRONOUNS


def _should_veto_split(prev_unit, unit, unit_embeddings, unit_entities) -> bool:
    """Entity-continuity refinement (stage 6): cancel a soft boundary the
    scorer proposed if the two units are actually still part of one thought -
    shared entities, a referring pronoun, or high same-section similarity."""
    if _starts_with_reference_pronoun(unit):
        return True

    prev_entities = entity_text_set(unit_entities[prev_unit.unit_id])
    cur_entities = entity_text_set(unit_entities[unit.unit_id])
    if cur_entities:
        overlap_ratio = len(prev_entities & cur_entities) / len(cur_entities)
        if overlap_ratio >= 0.5:
            return True

    same_section = (
        prev_unit.section_title == unit.section_title
        and prev_unit.subsection_title == unit.subsection_title
    )
    if same_section:
        sim = cosine_similarity(unit_embeddings[prev_unit.unit_id], unit_embeddings[unit.unit_id])
        if sim >= 0.75:
            return True

    return False


def _build_initial_segments(
    units, forced: Set[int], soft: List[BoundaryScore], unit_embeddings, unit_entities
) -> List[Segment]:
    reason_at = {i: BoundaryReason.HEADING for i in forced}
    for b in soft:
        if b.index in forced:
            continue
        prev_unit, unit = units[b.index - 1], units[b.index]
        if _should_veto_split(prev_unit, unit, unit_embeddings, unit_entities):
            continue
        reason_at[b.index] = b.reason

    # create refined boundary indices
    boundary_indices = sorted(reason_at.keys())

    segments = []
    start = 0
    for idx in boundary_indices + [len(units)]:
        segment_units = units[start:idx]
        if not segment_units:
            continue
        start_reason = (
            BoundaryReason.DOCUMENT_START if start == 0 else reason_at[start]
        )
        end_reason = (
            BoundaryReason.DOCUMENT_END if idx == len(units) else reason_at[idx]
        )
        segments.append(Segment(units=segment_units, start_reason=start_reason, end_reason=end_reason))
        start = idx

    return segments


def _segment_mean_embedding(segment: Segment, unit_embeddings):
    vecs = [unit_embeddings[u.unit_id] for u in segment.units]
    return np.mean(vecs, axis=0)


def _is_short(segment: Segment, config: PipelineConfig) -> bool:
    if segment.is_list_only:
        return False
    return segment.word_count < config.target_min_words or segment.sentence_count < config.min_sentences


def _merge_short_pass(segments: List[Segment], unit_embeddings, config: PipelineConfig):
    if len(segments) <= 1:
        return segments, False

    result = list(segments)
    changed = False
    i = 0
    while i < len(result):
        seg = result[i]
        if not _is_short(seg, config):
            i += 1
            continue

        neighbors = []
        if i > 0 and seg.start_reason != BoundaryReason.HEADING:
            neighbors.append(i - 1)
        if i < len(result) - 1 and seg.end_reason != BoundaryReason.HEADING:
            neighbors.append(i + 1)
        if not neighbors:
            i += 1
            continue

        same_section = [
            j for j in neighbors
            if result[j].section_title == seg.section_title
            and result[j].subsection_title == seg.subsection_title
        ]
        pool = same_section or neighbors
        seg_vec = _segment_mean_embedding(seg, unit_embeddings)
        target_idx = max(
            pool, key=lambda j: cosine_similarity(seg_vec, _segment_mean_embedding(result[j], unit_embeddings))
        )
        target_seg = result[target_idx]

        if target_idx < i:
            merged = Segment(
                units=target_seg.units + seg.units,
                start_reason=target_seg.start_reason,
                end_reason=seg.end_reason,
            )
            result[target_idx] = merged
            del result[i]
        else:
            merged = Segment(
                units=seg.units + target_seg.units,
                start_reason=seg.start_reason,
                end_reason=target_seg.end_reason,
            )
            result[i] = merged
            del result[target_idx]
        changed = True
        i += 1

    return result, changed


def _local_boundary_scores(segment: Segment, unit_embeddings, unit_entities, unit_keyphrases, weights):
    scores = []
    units = segment.units
    for i in range(1, len(units)):
        semantic_distance, entity_shift, keyphrase_shift = pairwise_signals(
            units[i - 1], units[i], unit_embeddings, unit_entities, unit_keyphrases
        )
        score = (
            weights.semantic * semantic_distance
            + weights.entity * entity_shift
            + weights.keyphrase * keyphrase_shift
        )
        scores.append((i, score))
    return scores


def _split_segment_recursive(segment: Segment, unit_embeddings, unit_entities, unit_keyphrases, weights, max_words):
    if segment.word_count <= max_words or len(segment.units) < 2:
        return [segment]

    scores = _local_boundary_scores(segment, unit_embeddings, unit_entities, unit_keyphrases, weights)
    if not scores:
        return [segment]

    best_idx, _ = max(scores, key=lambda pair: pair[1])
    if not (0 < best_idx < len(segment.units)):
        return [segment]

    left = Segment(
        units=segment.units[:best_idx],
        start_reason=segment.start_reason,
        end_reason=BoundaryReason.LENGTH_SPLIT,
    )
    right = Segment(
        units=segment.units[best_idx:],
        start_reason=BoundaryReason.LENGTH_SPLIT,
        end_reason=segment.end_reason,
    )
    return (
        _split_segment_recursive(left, unit_embeddings, unit_entities, unit_keyphrases, weights, max_words)
        + _split_segment_recursive(right, unit_embeddings, unit_entities, unit_keyphrases, weights, max_words)
    )


def _enforce_length(segments: List[Segment], unit_embeddings, unit_entities, unit_keyphrases, config: PipelineConfig):
    weights = config.boundary_weights
    for _ in range(_MAX_LENGTH_PASSES):
        segments, merge_changed = _merge_short_pass(segments, unit_embeddings, config)

        split_segments = []
        split_changed = False
        for seg in segments:
            pieces = _split_segment_recursive(seg, unit_embeddings, unit_entities, unit_keyphrases, weights, config.max_words)
            split_changed = split_changed or len(pieces) > 1
            split_segments.extend(pieces)
        segments = split_segments

        if not merge_changed and not split_changed:
            break

    return segments


class SegmentRefiner:
    def __init__(self, config: PipelineConfig):
        self.config = config

    def refine(
        self,
        units,
        forced: Set[int],
        soft: List[BoundaryScore],
        unit_embeddings: Dict[str, np.ndarray],
        unit_entities,
        unit_keyphrases,
    ) -> List[Segment]:
        if not units:
            return []
        if len(units) == 1:
            return [Segment(units=units, start_reason=BoundaryReason.DOCUMENT_START, end_reason=BoundaryReason.DOCUMENT_END)]

        segments = _build_initial_segments(units, forced, soft, unit_embeddings, unit_entities)
        segments = _enforce_length(segments, unit_embeddings, unit_entities, unit_keyphrases, self.config)
        return segments
