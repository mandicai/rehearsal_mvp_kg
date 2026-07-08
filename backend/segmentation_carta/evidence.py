"""Stage 3: for each globally-deduplicated entity (stage 2b, aggregate.py),
gather declarative-sentence evidence about it from across the WHOLE
document - not just the chunk(s) it happened to be extracted from in stage
2, since an entity's most informative sentence can live in a different
chunk than wherever it was first mentioned.

This still respects the token-budget concern chunking.py exists for: rather
than sending the raw whole document text in one LLM call, it re-uses stage
1's chunks and asks the same "does this chunk say anything about entity X"
question of each one - but only for chunks whose raw text actually mentions
the entity by name. That pre-filter is a cheap, imperfect proxy (it misses a
chunk that only refers to the entity pronomially, without ever repeating its
name) but keeps the number of LLM calls proportional to actual name mentions
instead of growing as (entity count x chunk count) regardless of relevance.
"""
import re


def _mentions_entity(chunk_text: str, entity_name: str) -> bool:
    name = entity_name.strip()
    if not name:
        return False
    pattern = r'\b' + re.escape(name) + r'\b'
    return re.search(pattern, chunk_text, re.IGNORECASE) is not None


def gather_entity_evidence(entity: dict, chunks: list, llm_client) -> list:
    """Return a flat, deduplicated list of simple declarative sentences about
    `entity`, gathered from every chunk whose text mentions its name."""
    candidate_chunks = [c for c in chunks if _mentions_entity(c.text, entity['name'])]
    if not candidate_chunks:
        return []

    seen = set()
    sentences = []
    for chunk in candidate_chunks:
        for sentence in llm_client.extract_entity_evidence(entity, chunk.text):
            key = sentence.strip().lower()
            if key and key not in seen:
                seen.add(key)
                sentences.append(sentence.strip())
    return sentences
