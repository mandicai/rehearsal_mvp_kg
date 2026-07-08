"""Stage 5: for each entity, extract RDF-triple relations to its stage-4
related entities, grounded in its stage-3 narrowed evidence text, following
Carta et al., 2023.

Subjects and objects are constrained (by the prompt, and re-checked
defensively in llm.py) to the focus entity plus its related entities - the
only entities actually known to appear in this narrowed text - so a triple
can't invent a relation to some entity absent from the local context.
"""


def extract_entity_relations(entity: dict, llm_client) -> list:
    narrowed_text = ' '.join(entity.get('evidence_sentences') or [])
    related_names = entity.get('related_entities') or []
    return llm_client.extract_relations(entity['name'], narrowed_text, related_names)
