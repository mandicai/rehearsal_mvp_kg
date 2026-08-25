"""LLM prompts/calls for every stage of segmentation_carta that needs one:
stage 2 (entity mention extraction), stage 3 (per-entity declarative-sentence
evidence gathering), stage 4 (recognizing related entities within that
evidence), stage 5 (extracting RDF-triple relations to those related
entities), stage 6 (describing each unique predicate produced by stage 5),
stage 8 (confirming which items in a stage-7 candidate similarity cluster
are genuinely semantically equal), stage 9 (composing, then applying, a
further prompt to get a unique canonical label for a confirmed subset), and
stage 10 (partitioning a set of types into hypernym groups, one level of the
schema/taxonomy at a time). See stage docstrings below for what each prompt
is asking for and why; these all follow the prompting approach in Carta et
al., 2023.

Independent of segmentation/llm.py by design (segmentation_carta is a
separate pipeline from segmentation/), even though the client shape is
intentionally similar: same env vars, same OpenAI-compatible API for either
OpenAI or OpenRouter.

    OPENAI_API_KEY    or OPENROUTER_API_KEY   (checked in that order)
    OPENAI_BASE_URL   default 'https://api.openai.com/v1'
    LLM_MODEL         default 'gpt-4o-mini'

There is no local fallback for any of these - each needs real language
understanding, so CartaLLMClient raises CartaLLMCallError when unconfigured
or when a call fails after retry, rather than degrading to a heuristic.
"""
import json
import os

try:
    from openai import OpenAI
except ImportError:  # openai isn't installed - client stays unconfigured
    OpenAI = None

_ENTITY_SYSTEM_PROMPT = """You are extracting entity mentions from one chunk of a larger document, as part of an iterative knowledge-graph construction pipeline.

An "entity" is a specific, identifiable real-world thing referred to in the text: a named person, organization, place, product, event, work, or a clearly delineated concept - not a generic, non-specific common noun (e.g. "a flower" mentioned generically is not an entity, but "the western honey bee" as a named species is; "a country" is not an entity, but "France" is).

You may also be given a brief summary of the document so far, purely for context - use it to help resolve references in the current chunk (pronouns, "the aforementioned X", etc.), but only report entities that are explicitly mentioned in the CURRENT CHUNK TEXT below, not entities that appear only in the summary.

Retrieve every entity mention in the current chunk text. For each one, respond with an object containing:
- "name": the entity's name or mention text, as it appears in the chunk
- "description": a one-sentence description of the entity, grounded only in what this text says about it
- "types": a list of one or more short type labels for the entity (e.g. ["Person"], ["Organization", "Company"], ["Concept"], ["Place"])

Respond with a single JSON object of the form {"entities": [{"name": ..., "description": ..., "types": [...]}, ...]}. If there are no entities, return {"entities": []}. Respond with only the JSON object, no other text."""

_EVIDENCE_SYSTEM_PROMPT = """You are gathering information about one specific entity from a chunk of a larger document, as part of an iterative knowledge-graph construction pipeline.

You will be given the entity's name (and, if available, its known description and types so far) and a chunk of the source document's text. Read the chunk and pull out every simple, self-contained declarative sentence that states a fact about this entity - rewrite each as a short declarative sentence (subject-verb-object where possible), grounded only in what the chunk actually says. Do not infer facts the text doesn't support, and do not include sentences that don't mention the entity (directly, by alias, or via an unambiguous pronoun/reference) or that are only tangentially related.

Respond with a single JSON object: {"sentences": [<sentence>, ...]}. If this chunk has no information about the entity, respond with {"sentences": []}. Respond with only the JSON object, no other text."""

_RELATED_ENTITIES_SYSTEM_PROMPT = """You are identifying which known entities are mentioned within a passage about one focus entity, as part of an iterative knowledge-graph construction pipeline.

You will be given: the focus entity's name, a passage of declarative sentences gathered about that focus entity from a larger document, and a list of other entity names already known from the same document.

Read the passage and determine which of the LISTED ENTITIES are explicitly mentioned or unambiguously referenced within it (by name, alias, or an unambiguous pronoun) - exclude the focus entity itself, and only include a listed entity if the passage genuinely supports the mention.

Respond with a single JSON object: {"mentioned_entities": [<exact name from the listed entities>, ...]}. If none of the listed entities are mentioned, respond with {"mentioned_entities": []}. Respond with only the JSON object, no other text."""

_RELATION_SYSTEM_PROMPT = """You are extracting relations between entities from a passage about one focus entity, as part of an iterative knowledge-graph construction pipeline.

You will be given the focus entity's name, a passage of declarative sentences about it, and a list of other entities known to be mentioned in that passage.

Express the entity relations you find in the form of RDF triplets - {"subject": ..., "predicate": ..., "object": ...} - using subjects and objects selected only from the focus entity and the listed entities (never invent an entity that isn't one of these), and by choosing an expressive predicate for each relation.

When choosing a predicate, generate predicates that correctly represent the relationship between the two entities without being too specific, as it would make the predicate hardly reusable and observable in other triplets - aim for a sort of predicate canonicalization, so the same predicate can be reused for similar relations elsewhere in the graph (e.g. prefer "located_in" over "has_its_corporate_headquarters_situated_within").

Only extract relations the passage actually supports - do not infer relations it doesn't state. Respond with a single JSON object: {"relations": [{"subject": ..., "predicate": ..., "object": ...}, ...]}. If there are no relations, respond with {"relations": []}. Respond with only the JSON object, no other text."""

_PREDICATE_DESCRIPTION_SYSTEM_PROMPT = """You are describing one predicate used across a knowledge graph's relation triples, as part of an iterative knowledge-graph construction pipeline.

You will be given a predicate, the (subject, object) pairs it was used to relate, and the source text passages those relations were grounded in.

Return the description of this predicate, referencing the text: write one or two sentences that capture the generic nature of the relation expressed by the predicate - general enough to apply to any (subject, object) pair this predicate might connect elsewhere in the graph, not a description of only the specific pairs shown here.

Respond with a single JSON object: {"description": <description>}. Respond with only the JSON object, no other text."""

_SUBSET_CONFIRMATION_SYSTEM_PROMPT = """You are checking a candidate group of {kind} that a similarity heuristic flagged as possibly referring to the same real-world {kind_singular}, as part of an iterative knowledge-graph construction pipeline.

You will be given a list of candidate {kind}, each with its label{types_note} and description. The heuristic can be wrong in either direction, and a candidate group might actually contain more than one genuinely distinct {kind_singular}, not just one.

Partition the candidates into subsets of {kind} that are semantically equal - i.e. that refer to the exact same real-world {kind_singular}, not just related or similar ones. Every candidate must appear in exactly one subset; a {kind_singular} with nothing else semantically equal to it is its own subset of size one.

Respond with a single JSON object: {{"subsets": [[<label>, ...], ...]}}, where each inner list is one subset of labels, exactly as given. Respond with only the JSON object, no other text."""

_COMPOSE_LABEL_PROMPT_SYSTEM_PROMPT = """You are preparing to unify a group of {kind} that have been confirmed to all refer to the same real-world {kind_singular}, as part of an iterative knowledge-graph construction pipeline.

You will be given the group's members, each with its label and description. Compose a further prompt: a complete, self-contained set of instructions that, when given on its own to a language model with no other context, would ask for a single unique label representing this whole group - one well-suited for reuse as this {kind_singular}'s canonical name across the rest of the graph. Your composed prompt must itself include the group's members and their descriptions, since it will be sent standalone with no other context attached.

Respond with a single JSON object: {{"prompt": <the composed prompt, as a string>}}. Respond with only the JSON object, no other text."""

_APPLY_LABEL_PROMPT_SYSTEM_PROMPT = """Follow the user's instructions and respond with a single JSON object of the form {"label": <the unique label>}, with no other text."""

_HYPERNYM_GENERATION_SYSTEM_PROMPT = """You are building the schema (a type taxonomy) for a knowledge graph, one level at a time, as part of an iterative knowledge-graph construction pipeline.

You will be given a list of types - in later iterations these may themselves be hypernyms generated at a previous, lower level. Some lists are semantically uniform enough for a single common hypernym; others should be split into a small number of subsets, each with its own hypernym, when one shared label would be too generic to be useful.

For example, given the types legumes, green vegetables, poultry, pork, fish, and crustacean, the most suitable hypernyms are "vegetables" (covering legumes and green vegetables), "meat" (covering poultry and pork), and "seafood" (covering fish and crustacean) - three groups, not one, since a single hypernym over all six (e.g. just "food") would be too generic to be useful. Each type would be linked to its hypernym with the relation "is type of".

Partition the given types into one or more groups, and give each group a single, concise hypernym label - a more general category that every type in that group is an instance/example of. Every given type must appear in exactly one group.

Respond with a single JSON object: {"groups": [{"hypernym": <label>, "types": [<type>, ...]}, ...]}. Respond with only the JSON object, no other text."""


class CartaLLMCallError(Exception):
    pass


class CartaLLMClient:
    def __init__(self, model=None):
        self.api_key = os.environ.get('PROXY_API_KEY') or os.environ.get('OPENROUTER_API_KEY')
        self.base_url = os.environ.get('PROXY_BASE_URL') or os.environ.get('OPENAI_BASE_URL') or None
        self.model = model or os.environ.get('LLM_MODEL', 'gpt-4o-mini')
        self._client = None

    def is_configured(self):
        return bool(self.api_key) and OpenAI is not None

    def _get_client(self):
        if self._client is None:
            kwargs = {'api_key': self.api_key}
            if self.base_url:
                kwargs['base_url'] = self.base_url
            self._client = OpenAI(**kwargs)
        return self._client

    def extract_entities(self, chunk_text: str, context_summary: str = None) -> list:
        if not self.is_configured():
            raise CartaLLMCallError('LLM client is not configured (missing API key or openai package)')

        user_content = f'CURRENT CHUNK TEXT:\n{chunk_text}'
        if context_summary:
            user_content = f'SUMMARY OF THE DOCUMENT SO FAR:\n{context_summary}\n\n{user_content}'

        last_error = None
        for _ in range(2):  # one retry on transient failure
            try:
                client = self._get_client()
                response = client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {'role': 'system', 'content': _ENTITY_SYSTEM_PROMPT},
                        {'role': 'user', 'content': user_content},
                    ],
                    response_format={'type': 'json_object'},
                    temperature=0.1,
                )
                parsed = json.loads(response.choices[0].message.content)
                return [
                    {
                        'name': str(e.get('name', '')).strip(),
                        'description': str(e.get('description', '')).strip(),
                        'types': [str(t).strip() for t in (e.get('types') or []) if str(t).strip()],
                    }
                    for e in (parsed.get('entities', []) or [])
                    if str(e.get('name', '')).strip()
                ]
            except Exception as exc:  # network errors, malformed JSON, API errors
                last_error = exc
        raise CartaLLMCallError(f'Entity extraction failed after retry: {last_error}')

    def extract_entity_evidence(self, entity: dict, chunk_text: str) -> list:
        """Stage 3: pull declarative sentences about `entity` out of one chunk
        of the source document (see evidence.py, which calls this once per
        chunk that mentions the entity's name)."""
        if not self.is_configured():
            raise CartaLLMCallError('LLM client is not configured (missing API key or openai package)')

        entity_desc = f"Entity: {entity['name']}"
        if entity.get('types'):
            entity_desc += f" (types: {', '.join(entity['types'])})"
        if entity.get('description'):
            entity_desc += f"\nKnown description so far: {entity['description']}"
        user_content = f'{entity_desc}\n\nCHUNK TEXT:\n{chunk_text}'

        last_error = None
        for _ in range(2):
            try:
                client = self._get_client()
                response = client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {'role': 'system', 'content': _EVIDENCE_SYSTEM_PROMPT},
                        {'role': 'user', 'content': user_content},
                    ],
                    response_format={'type': 'json_object'},
                    temperature=0.1,
                )
                parsed = json.loads(response.choices[0].message.content)
                return [str(s).strip() for s in (parsed.get('sentences', []) or []) if str(s).strip()]
            except Exception as exc:
                last_error = exc
        raise CartaLLMCallError(f'Entity evidence extraction failed after retry: {last_error}')

    def recognize_related_entities(self, focus_entity_name: str, narrowed_text: str, listed_entity_names: list) -> list:
        """Stage 4: within `narrowed_text` (the focus entity's stage-3
        evidence), recognize mentions of the other entities in
        `listed_entity_names` (see related_entities.py)."""
        if not self.is_configured():
            raise CartaLLMCallError('LLM client is not configured (missing API key or openai package)')
        if not narrowed_text or not listed_entity_names:
            return []

        user_content = (
            f'FOCUS ENTITY: {focus_entity_name}\n\n'
            f'PASSAGE ABOUT THE FOCUS ENTITY:\n{narrowed_text}\n\n'
            f'LISTED ENTITIES:\n' + '\n'.join(f'- {name}' for name in listed_entity_names)
        )

        last_error = None
        for _ in range(2):
            try:
                client = self._get_client()
                response = client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {'role': 'system', 'content': _RELATED_ENTITIES_SYSTEM_PROMPT},
                        {'role': 'user', 'content': user_content},
                    ],
                    response_format={'type': 'json_object'},
                    temperature=0.1,
                )
                parsed = json.loads(response.choices[0].message.content)
                mentioned = [str(m).strip() for m in (parsed.get('mentioned_entities', []) or []) if str(m).strip()]
                valid_lower = {name.lower() for name in listed_entity_names}
                # defensively drop anything the model returned that isn't actually one of the listed names
                return [m for m in mentioned if m.lower() in valid_lower and m.lower() != focus_entity_name.strip().lower()]
            except Exception as exc:
                last_error = exc
        raise CartaLLMCallError(f'Related-entity recognition failed after retry: {last_error}')

    def extract_relations(self, focus_entity_name: str, narrowed_text: str, related_entity_names: list) -> list:
        """Stage 5: RDF-triple relations between the focus entity and its
        stage-4 related entities, grounded in the focus entity's stage-3
        evidence (see relations.py)."""
        if not self.is_configured():
            raise CartaLLMCallError('LLM client is not configured (missing API key or openai package)')
        if not narrowed_text or not related_entity_names:
            return []

        allowed_lower = {focus_entity_name.strip().lower()} | {name.lower() for name in related_entity_names}
        user_content = (
            f'FOCUS ENTITY: {focus_entity_name}\n\n'
            f'PASSAGE ABOUT THE FOCUS ENTITY:\n{narrowed_text}\n\n'
            f'OTHER ENTITIES MENTIONED IN THIS PASSAGE:\n' + '\n'.join(f'- {name}' for name in related_entity_names)
        )

        last_error = None
        for _ in range(2):
            try:
                client = self._get_client()
                response = client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {'role': 'system', 'content': _RELATION_SYSTEM_PROMPT},
                        {'role': 'user', 'content': user_content},
                    ],
                    response_format={'type': 'json_object'},
                    temperature=0.1,
                )
                parsed = json.loads(response.choices[0].message.content)
                relations = []
                for r in (parsed.get('relations', []) or []):
                    subject = str(r.get('subject', '')).strip()
                    predicate = str(r.get('predicate', '')).strip()
                    obj = str(r.get('object', '')).strip()
                    if not subject or not predicate or not obj or subject.lower() == obj.lower():
                        continue
                    # defensively drop triples that reference an entity outside the allowed set
                    if subject.lower() not in allowed_lower or obj.lower() not in allowed_lower:
                        continue
                    relations.append({'subject': subject, 'predicate': predicate, 'object': obj})
                return relations
            except Exception as exc:
                last_error = exc
        raise CartaLLMCallError(f'Relation extraction failed after retry: {last_error}')

    def describe_predicate(self, predicate: str, triples: list, reference_texts: list) -> str:
        """Stage 6: a generic, text-grounded description of one predicate
        that recurs across stage 5's triples (see predicates.py)."""
        if not self.is_configured():
            raise CartaLLMCallError('LLM client is not configured (missing API key or openai package)')

        pairs_str = '\n'.join(f"- {t['subject']} -> {t['object']}" for t in triples)
        texts_str = '\n\n'.join(reference_texts)
        user_content = (
            f'PREDICATE: {predicate}\n\n'
            f'(SUBJECT, OBJECT) PAIRS USING THIS PREDICATE:\n{pairs_str}\n\n'
            f'SOURCE TEXT PASSAGES:\n{texts_str}'
        )

        last_error = None
        for _ in range(2):
            try:
                client = self._get_client()
                response = client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {'role': 'system', 'content': _PREDICATE_DESCRIPTION_SYSTEM_PROMPT},
                        {'role': 'user', 'content': user_content},
                    ],
                    response_format={'type': 'json_object'},
                    temperature=0.1,
                )
                parsed = json.loads(response.choices[0].message.content)
                return str(parsed.get('description', '')).strip()
            except Exception as exc:
                last_error = exc
        raise CartaLLMCallError(f'Predicate description failed after retry: {last_error}')

    def confirm_semantic_subsets(self, items: list, kind: str) -> list:
        """Stage 8: partition a stage-7 candidate cluster of `items` (each
        {'name', 'description', 'types'?}) into subsets that are genuinely
        semantically equal (see dedup.py). `kind` is 'entities' or
        'relations', just to word the prompt appropriately - predicates have
        no 'types' field."""
        if not self.is_configured():
            raise CartaLLMCallError('LLM client is not configured (missing API key or openai package)')
        if len(items) < 2:
            return [[item['name'] for item in items]]

        kind_singular = 'entity' if kind == 'entities' else 'relation'
        types_note = ', its type(s),' if kind == 'entities' else ''
        system_prompt = _SUBSET_CONFIRMATION_SYSTEM_PROMPT.format(kind=kind, kind_singular=kind_singular, types_note=types_note)

        lines = []
        for item in items:
            line = f"- {item['name']}"
            if item.get('types'):
                line += f" (types: {', '.join(item['types'])})"
            if item.get('description'):
                line += f": {item['description']}"
            lines.append(line)
        user_content = f'CANDIDATE {kind.upper()}:\n' + '\n'.join(lines)

        last_error = None
        for _ in range(2):
            try:
                client = self._get_client()
                response = client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {'role': 'system', 'content': system_prompt},
                        {'role': 'user', 'content': user_content},
                    ],
                    response_format={'type': 'json_object'},
                    temperature=0.1,
                )
                parsed = json.loads(response.choices[0].message.content)
                name_by_lower = {item['name'].lower(): item['name'] for item in items}
                seen = set()
                cleaned = []
                for subset in (parsed.get('subsets', []) or []):
                    names = []
                    for n in subset:
                        key = str(n).strip().lower()
                        if key in name_by_lower and key not in seen:
                            names.append(name_by_lower[key])
                            seen.add(key)
                    if names:
                        cleaned.append(names)
                # anything the model dropped becomes its own singleton subset, so no item is silently lost
                for item in items:
                    key = item['name'].lower()
                    if key not in seen:
                        cleaned.append([item['name']])
                        seen.add(key)
                return cleaned
            except Exception as exc:
                last_error = exc
        raise CartaLLMCallError(f'Semantic subset confirmation failed after retry: {last_error}')

    def compose_label_prompt(self, items: list, kind: str) -> str:
        """Stage 9, hop 1: compose a self-contained further prompt for
        eliciting a unique canonical label for this confirmed subset (see
        canonical_label.py, which sends the result to apply_label_prompt)."""
        if not self.is_configured():
            raise CartaLLMCallError('LLM client is not configured (missing API key or openai package)')

        kind_singular = 'entity' if kind == 'entities' else 'relation'
        system_prompt = _COMPOSE_LABEL_PROMPT_SYSTEM_PROMPT.format(kind=kind, kind_singular=kind_singular)

        lines = [f"- {item['name']}: {item['description']}" if item.get('description') else f"- {item['name']}" for item in items]
        user_content = 'GROUP MEMBERS:\n' + '\n'.join(lines)

        last_error = None
        for _ in range(2):
            try:
                client = self._get_client()
                response = client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {'role': 'system', 'content': system_prompt},
                        {'role': 'user', 'content': user_content},
                    ],
                    response_format={'type': 'json_object'},
                    temperature=0.2,
                )
                parsed = json.loads(response.choices[0].message.content)
                composed = str(parsed.get('prompt', '')).strip()
                if composed:
                    return composed
            except Exception as exc:
                last_error = exc
        raise CartaLLMCallError(f'Composing the label prompt failed after retry: {last_error}')

    def apply_label_prompt(self, composed_prompt: str) -> str:
        """Stage 9, hop 2: send stage 9 hop 1's composed prompt to the LLM
        on its own, standalone, to actually get the canonical label back."""
        if not self.is_configured():
            raise CartaLLMCallError('LLM client is not configured (missing API key or openai package)')
        if not composed_prompt:
            return ''

        last_error = None
        for _ in range(2):
            try:
                client = self._get_client()
                response = client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {'role': 'system', 'content': _APPLY_LABEL_PROMPT_SYSTEM_PROMPT},
                        {'role': 'user', 'content': composed_prompt},
                    ],
                    response_format={'type': 'json_object'},
                    temperature=0.2,
                )
                parsed = json.loads(response.choices[0].message.content)
                label = str(parsed.get('label', '')).strip()
                if label:
                    return label
            except Exception as exc:
                last_error = exc
        raise CartaLLMCallError(f'Applying the composed label prompt failed after retry: {last_error}')

    def generate_hypernym_groups(self, types: list) -> list:
        """Stage 10a: partition `types` into one or more hypernym groups
        (see taxonomy.py, which links each type to its group's hypernym via
        a fixed "is type of" relation - the predicate itself isn't
        LLM-chosen, only the grouping and the hypernym labels are)."""
        if not self.is_configured():
            raise CartaLLMCallError('LLM client is not configured (missing API key or openai package)')
        if not types:
            return []

        user_content = 'TYPES:\n' + '\n'.join(f'- {t}' for t in types)

        last_error = None
        for _ in range(2):
            try:
                client = self._get_client()
                response = client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {'role': 'system', 'content': _HYPERNYM_GENERATION_SYSTEM_PROMPT},
                        {'role': 'user', 'content': user_content},
                    ],
                    response_format={'type': 'json_object'},
                    temperature=0.2,
                )
                parsed = json.loads(response.choices[0].message.content)
                type_by_lower = {t.strip().lower(): t.strip() for t in types}
                seen = set()
                groups = []
                for g in (parsed.get('groups', []) or []):
                    hypernym = str(g.get('hypernym', '')).strip()
                    if not hypernym:
                        continue
                    member_types = []
                    for t in (g.get('types', []) or []):
                        key = str(t).strip().lower()
                        if key in type_by_lower and key not in seen:
                            member_types.append(type_by_lower[key])
                            seen.add(key)
                    if member_types:
                        groups.append({'hypernym': hypernym, 'types': member_types})
                # anything the model dropped becomes its own singleton group under itself, so no type is silently lost
                for t in types:
                    key = t.strip().lower()
                    if key not in seen:
                        groups.append({'hypernym': t.strip(), 'types': [t.strip()]})
                        seen.add(key)
                return groups
            except Exception as exc:
                last_error = exc
        raise CartaLLMCallError(f'Hypernym generation failed after retry: {last_error}')
