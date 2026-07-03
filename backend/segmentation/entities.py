"""Stage 4: per-base-unit entity extraction, used for the boundary-scoring
entity-shift signal (before segments exist). Exported segment-level entities
come from labeling.py instead, aggregated across a segment's units (local
mode) or produced by a single LLM call (LLM mode) - not from here."""
from abc import ABC, abstractmethod


class EntityExtractor(ABC):
    @abstractmethod
    def extract(self, unit):
        """Return a list of {'text': str, 'type': str} for one base unit."""


class SpacyEntityExtractor(EntityExtractor):
    """Reuses unit.spacy_doc (already parsed in units.py) rather than
    re-parsing the unit's text."""

    def extract(self, unit):
        if unit.spacy_doc is None:
            return []
        return [{'text': ent.text, 'type': ent.label_} for ent in unit.spacy_doc.ents]


def entity_text_set(entities):
    return {e['text'].strip().lower() for e in entities if e['text'].strip()}
