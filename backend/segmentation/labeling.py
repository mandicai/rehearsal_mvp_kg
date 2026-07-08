"""Stage 8: label each finalized segment with a topic label, one-sentence
summary, top entities, and keyphrases.

KeyphraseLabeler is the fully-local fallback (aggregates the per-unit spaCy
entities already computed during boundary scoring, plus keyphrases.py's
frequency ranking) and needs no configuration. LLMLabeler produces
noticeably more fluent labels (matching the quality of hand-written examples
like "Customer journey analytics workflows") by making one combined call per
segment via llm.LLMClient, and falls back to KeyphraseLabeler for any segment
where the call fails, so one bad response doesn't fail the whole request.
AutoLabeler (the pipeline default) picks LLMLabeler when a key is configured,
else KeyphraseLabeler - decided once per pipeline run.
"""
from abc import ABC, abstractmethod
from collections import Counter

from .keyphrases import rank_keyphrases
from .llm import LLMCallError, LLMClient


class SegmentLabeler(ABC):
    @abstractmethod
    def label(self, segment, doc_text, unit_entities):
        """Return {'topic_label', 'summary', 'top_entities', 'keyphrases'}."""


def _aggregate_entities(segment, unit_entities, top_n=8):
    counts = Counter()
    entity_type = {}
    for unit in segment.units:
        for ent in unit_entities.get(unit.unit_id, []):
            text = ent['text'].strip()
            if not text:
                continue
            counts[text] += 1
            entity_type.setdefault(text, ent['type'])
    top = [text for text, _ in counts.most_common(top_n)]
    return [{'text': text, 'type': entity_type[text]} for text in top]


def _extractive_summary(segment, top_terms):
    sentences = []
    for unit in segment.units:
        if unit.spacy_doc is None:
            continue
        sentences.extend(s.text.strip() for s in unit.spacy_doc.sents if s.text.strip()) # .sents is sentences
    if not sentences:
        return ''
    if len(sentences) == 1:
        return sentences[0]

    terms = {t.lower() for t in top_terms if t}

    def overlap(sentence):
        lowered = sentence.lower()
        return sum(1 for t in terms if t in lowered)

    best = max(sentences, key=overlap) # return sentence that overlaps the most with entities/keyphrases in the segment, as summary
    return best if overlap(best) > 0 else sentences[0]


def _build_topic_label(entities, keyphrases):
    candidates = [e['text'] for e in entities[:3]] + keyphrases[:3]
    picked = []
    for candidate in candidates:
        candidate = candidate.strip()
        if candidate and candidate.lower() not in {p.lower() for p in picked}:
            picked.append(candidate)
        if len(picked) == 3:
            break
    return ' · '.join(picked) if picked else 'Untitled segment'


class KeyphraseLabeler(SegmentLabeler):
    # Relation extraction (subject-predicate-object triples) needs real language
    # understanding to avoid asserting relations the text doesn't support, so
    # unlike topic_label/summary/entities/keyphrases it has no local heuristic
    # fallback here - 'relations' is always empty outside LLM mode.
    def label(self, segment, doc_text, unit_entities):
        entities = _aggregate_entities(segment, unit_entities)
        keyphrases = rank_keyphrases(segment.units)
        return {
            'topic_label': _build_topic_label(entities, keyphrases),
            'summary': _extractive_summary(segment, keyphrases + [e['text'] for e in entities]),
            'top_entities': entities,
            'keyphrases': keyphrases,
            'relations': [],
        }


class LLMLabeler(SegmentLabeler):
    def __init__(self, client: LLMClient = None):
        self.client = client or LLMClient()
        self._fallback = KeyphraseLabeler()

    def label(self, segment, doc_text, unit_entities):
        text = doc_text[segment.char_start:segment.char_end].strip()
        try:
            return self.client.enrich_segment(text, segment.section_title, segment.subsection_title)
        except LLMCallError:
            return self._fallback.label(segment, doc_text, unit_entities)


class AutoLabeler(SegmentLabeler):
    def __init__(self, llm_model=None):
        client = LLMClient(model=llm_model)
        self._delegate = LLMLabeler(client) if client.is_configured() else KeyphraseLabeler()

    def label(self, segment, doc_text, unit_entities):
        return self._delegate.label(segment, doc_text, unit_entities)


def build_labeler(labeling_method: str, llm_model=None) -> SegmentLabeler:
    if labeling_method == 'llm':
        return LLMLabeler(LLMClient(model=llm_model))
    if labeling_method == 'local':
        return KeyphraseLabeler()
    return AutoLabeler(llm_model=llm_model)
