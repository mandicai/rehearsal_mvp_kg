"""Stage 2b: merge the per-chunk entity mentions from stage 2 (llm.py's
extract_entities, one call per chunk) into a single global, deduplicated
entity list for the whole document.

Needed because stage 1's chunks are overlapping sliding windows by design
(see chunking.py), so the same entity is routinely extracted more than once
across neighboring chunks - without merging, "for each entity" in stages 3-4
would redo the same work per duplicate and the final entity list would have
repeats. Entities are merged by case-insensitive exact name match, not fuzzy
matching, so genuinely different phrasings of the same real-world entity
(e.g. "the queen" vs "queen bee") can still end up as separate entries -
a known limitation of this deliberately simple approach.
"""


def merge_entities(entities_per_chunk: list) -> list:
    merged = {}
    order = []

    for entities in entities_per_chunk:
        for entity in entities:
            name = (entity.get('name') or '').strip()
            if not name:
                continue
            key = name.lower()
            if key not in merged:
                merged[key] = {
                    'name': name,
                    'description': entity.get('description', '') or '',
                    'types': list(dict.fromkeys(entity.get('types') or [])),
                }
                order.append(key)
            else:
                existing = merged[key]
                if not existing['description'] and entity.get('description'):
                    existing['description'] = entity['description']
                for t in (entity.get('types') or []):
                    if t not in existing['types']:
                        existing['types'].append(t)

    return [merged[key] for key in order]
