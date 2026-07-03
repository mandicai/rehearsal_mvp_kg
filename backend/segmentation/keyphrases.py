"""Lightweight local keyphrase extraction from noun chunks - no extra
dependency (yake/keybert etc.). Used for the boundary-scoring keyphrase-shift
signal (per unit) and, aggregated across a segment's units, as the local
fallback keyphrase list in labeling.py."""
from collections import Counter

_MIN_WORDS = 1
_MAX_WORDS = 4


def _clean_chunk_text(span):
    tokens = list(span)
    while tokens and (tokens[0].is_stop or tokens[0].pos_ == 'DET'):
        tokens = tokens[1:]
    while tokens and tokens[-1].is_punct:
        tokens = tokens[:-1]
    if not tokens or all(t.is_stop or t.is_punct for t in tokens):
        return None
    if not (_MIN_WORDS <= len(tokens) <= _MAX_WORDS):
        return None
    # slice from the original doc (not span) to preserve exact spacing, e.g.
    # "event-level" rather than joining token texts with a forced space; the
    # final split()/join() also collapses embedded newlines from base units
    # that span multiple source lines (paragraphs keep their raw line breaks)
    sub_span = span.doc[tokens[0].i:tokens[-1].i + 1]
    return ' '.join(sub_span.text.split()).lower()


def noun_chunks_for_unit(unit):
    if unit.spacy_doc is None:
        return []
    phrases = []
    for chunk in unit.spacy_doc.noun_chunks:
        cleaned = _clean_chunk_text(chunk)
        if cleaned:
            phrases.append(cleaned)
    return phrases


def extract_keyphrase_set(unit):
    return set(noun_chunks_for_unit(unit))


def rank_keyphrases(units, top_n=6):
    counter = Counter()
    for unit in units:
        counter.update(noun_chunks_for_unit(unit))
    return [phrase for phrase, _ in counter.most_common(top_n)]
