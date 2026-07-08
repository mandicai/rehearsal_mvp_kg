"""Stage 6: for each unique predicate produced across all entities' stage-5
relation triples, prompt an LLM to describe what that predicate generically
means - referencing the text passages its triples were actually grounded in,
but describing the canonical/generic nature of the relation rather than any
one specific triple, since stage 5 deliberately reuses the same predicate
across many different entity pairs (its "predicate canonicalization" goal).
"""


def collect_predicate_groups(entities: list) -> list:
    """Flatten every entity's stage-5 relations into groups keyed by
    predicate (case-insensitive), each carrying the (subject, object) pairs
    that used it and the distinct narrowed texts they were grounded in."""
    groups = {}
    order = []

    for entity in entities:
        narrowed_text = ' '.join(entity.get('evidence_sentences') or [])
        for rel in entity.get('relations') or []:
            predicate = (rel.get('predicate') or '').strip()
            if not predicate:
                continue
            key = predicate.lower()
            if key not in groups:
                groups[key] = {'predicate': predicate, 'triples': [], 'texts': []}
                order.append(key)
            groups[key]['triples'].append({'subject': rel['subject'], 'object': rel['object']})
            if narrowed_text and narrowed_text not in groups[key]['texts']:
                groups[key]['texts'].append(narrowed_text)

    return [groups[key] for key in order]


def describe_predicate_group(group: dict, llm_client) -> str:
    return llm_client.describe_predicate(group['predicate'], group['triples'], group['texts'])
