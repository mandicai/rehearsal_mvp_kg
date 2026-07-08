"""Stage 4: for each entity, recognize which of the document's OTHER known
entities are mentioned within the declarative-sentence evidence gathered
about it in stage 3 (evidence.py) - i.e. within the "narrowed text" that is
that stage's output.

This identifies which entity pairs are worth relating to each other
(co-mention within one entity's own evidence); extracting the actual
relationship between a related pair is left to a later stage.
"""


def find_related_entities(entity: dict, evidence_sentences: list, all_entities: list, llm_client) -> list:
    narrowed_text = ' '.join(evidence_sentences)
    other_names = [e['name'] for e in all_entities if e['name'].lower() != entity['name'].lower()]
    if not narrowed_text or not other_names:
        return []
    return llm_client.recognize_related_entities(entity['name'], narrowed_text, other_names)
