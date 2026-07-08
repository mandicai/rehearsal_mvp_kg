"""Orchestrates segmentation_carta's stages, so far:

1. chunk (chunking.py)
2. extract entity mentions per chunk, via LLM (llm.py)
2b. merge per-chunk entity mentions into one global, deduplicated entity
    list (aggregate.py) - needed for "for each entity" in stages 3-6 to mean
    "for each real-world entity in the document", not "for each mention"
3. for each global entity, gather declarative-sentence evidence about it
   from across every chunk that mentions its name, via LLM
   (evidence.py + llm.py)
4. for each global entity, recognize which other entities are mentioned
   within its stage-3 evidence, via LLM (related_entities.py + llm.py)
5. for each global entity, extract RDF-triple relations to its stage-4
   related entities, grounded in its stage-3 evidence, via LLM
   (relations.py + llm.py)
6. for each unique predicate produced in stage 5, describe its generic
   meaning, referencing the text it was grounded in, via LLM
   (predicates.py + llm.py)
7. cluster entities, and separately predicates, into candidate duplicate
   groups by a weighted label/type/description similarity score
   (aggregate_similar.py + similarity.py + clustering.py)
8. for each candidate cluster of size >1, ask an LLM to confirm which items
   within it are genuinely semantically equal, since the stage-7 heuristic
   can conflate merely-related items with truly identical ones
   (dedup.py + llm.py)
9. for each stage-8 confirmed subset of size >1, get one canonical label via
   a two-hop meta-prompt: compose a further prompt for eliciting a unique
   label, then send that prompt back to the LLM to actually get it
   (canonical_label.py + llm.py)
10. iteratively build the schema (a type taxonomy): for each entity
    cluster's deduplicated types, generate one or more hypernym groups
    (linked to their types via a fixed "is type of" relation), merge
    redundant hypernyms across clusters by reusing stages 7-9's machinery,
    and repeat on the merged hypernyms as the next level up, until the
    schema converges to a single root (taxonomy.py + llm.py)

More stages land later - this pipeline is intentionally incomplete. Note
that stages 7-9 only *identify* duplicate groups and their canonical labels
- they don't yet rewrite entities/predicates/relations to use them; that's
left as a future step so every stage's raw output stays inspectable.

No local fallback anywhere past chunking: every stage here requires an LLM,
so run() raises CartaLLMCallError if no key is configured.

Cost/latency note: stage 2 makes one call per chunk; stage 3 makes one call
per (entity, chunk-that-mentions-it) pair; stages 4 and 5 make one call per
entity; stage 6 makes one call per unique predicate; stage 8 makes one call
per candidate cluster of size >1; stage 9 makes two calls per confirmed
subset of size >1; stage 10 repeats a stage-7/8/9-shaped cost once per
taxonomy level (capped at 8 levels). For a document with many chunks and
many distinct entities this adds up quickly - see server.py's
MAX_CARTA_CHARS for the resulting input-size cap.
"""
import uuid
from concurrent.futures import ThreadPoolExecutor

import spacy

from .aggregate import merge_entities
from .aggregate_similar import cluster_entities, cluster_predicates
from .canonical_label import canonical_label_for_subset
from .chunking import chunk_text
from .config import CartaConfig
from .dedup import confirm_entity_subsets, confirm_predicate_subsets
from .evidence import gather_entity_evidence
from .llm import CartaLLMClient
from .predicates import collect_predicate_groups, describe_predicate_group
from .related_entities import find_related_entities
from .relations import extract_entity_relations
from .taxonomy import build_schema

_WORKERS = 4  # LLM calls within any one stage are independent and I/O-bound


class CartaPipeline:
    def __init__(self, config: CartaConfig = None):
        self.config = config or CartaConfig()
        self.nlp = spacy.load('en_core_web_sm')
        self.llm_client = CartaLLMClient(model=self.config.llm_model)

    def run(self, text: str, document_id: str = None) -> dict:
        empty_result = {
            'chunks': [], 'entities': [], 'predicates': [],
            'entity_clusters': [], 'predicate_clusters': [],
            'schema_levels': [], 'schema_relations': [],
        }
        if not text or not text.strip():
            return empty_result

        document_id = document_id or uuid.uuid4().hex
        chunks = chunk_text(text, self.nlp, self.config)
        if not chunks:
            return empty_result

        # stage 2: entity mentions per chunk
        with ThreadPoolExecutor(max_workers=_WORKERS) as pool:
            entities_per_chunk = list(pool.map(
                lambda c: self.llm_client.extract_entities(c.text, c.context_summary),
                chunks,
            ))

        chunk_records = [
            {
                'chunk_id': f'{document_id}_chunk{chunk.chunk_index + 1}',
                'document_id': document_id,
                'chunk_index': chunk.chunk_index,
                'char_start': chunk.char_start,
                'char_end': chunk.char_end,
                'text': chunk.text,
                'context_summary': chunk.context_summary,
                'entities': entities,
            }
            for chunk, entities in zip(chunks, entities_per_chunk)
        ]

        # stage 2b: merge per-chunk entities into one global, deduplicated list
        global_entities = merge_entities(entities_per_chunk)
        for i, entity in enumerate(global_entities):
            entity['entity_id'] = f'{document_id}_ent{i + 1}'

        # stage 3: cross-document declarative-sentence evidence, per entity
        with ThreadPoolExecutor(max_workers=_WORKERS) as pool:
            evidence_per_entity = list(pool.map(
                lambda e: gather_entity_evidence(e, chunks, self.llm_client),
                global_entities,
            ))
        for entity, sentences in zip(global_entities, evidence_per_entity):
            entity['evidence_sentences'] = sentences

        # stage 4: which other entities are mentioned in each entity's evidence
        with ThreadPoolExecutor(max_workers=_WORKERS) as pool:
            related_per_entity = list(pool.map(
                lambda e: find_related_entities(e, e['evidence_sentences'], global_entities, self.llm_client),
                global_entities,
            ))
        for entity, related in zip(global_entities, related_per_entity):
            entity['related_entities'] = related

        # stage 5: RDF-triple relations from each entity to its related entities
        with ThreadPoolExecutor(max_workers=_WORKERS) as pool:
            relations_per_entity = list(pool.map(
                lambda e: extract_entity_relations(e, self.llm_client),
                global_entities,
            ))
        for entity, relations in zip(global_entities, relations_per_entity):
            entity['relations'] = relations

        # stage 6: a generic, text-grounded description of each unique predicate
        predicate_groups = collect_predicate_groups(global_entities)
        with ThreadPoolExecutor(max_workers=_WORKERS) as pool:
            descriptions = list(pool.map(
                lambda g: describe_predicate_group(g, self.llm_client),
                predicate_groups,
            ))
        predicate_records = [
            {
                'predicate': group['predicate'],
                'description': description,
                'triples': group['triples'],
            }
            for group, description in zip(predicate_groups, descriptions)
        ]

        # stage 7: candidate duplicate clusters, entities and predicates scored independently
        entity_candidate_clusters = cluster_entities(global_entities, self.config)
        predicate_candidate_clusters = cluster_predicates(predicate_records, self.config)

        # stage 8: LLM-confirmed subsets of genuinely semantically-equal items within each candidate cluster
        with ThreadPoolExecutor(max_workers=_WORKERS) as pool:
            entity_subset_groups = list(pool.map(
                lambda cluster: confirm_entity_subsets(cluster, self.llm_client),
                entity_candidate_clusters,
            ))
        confirmed_entity_subsets = [subset for groups in entity_subset_groups for subset in groups]

        with ThreadPoolExecutor(max_workers=_WORKERS) as pool:
            predicate_subset_groups = list(pool.map(
                lambda cluster: confirm_predicate_subsets(cluster, self.llm_client),
                predicate_candidate_clusters,
            ))
        confirmed_predicate_subsets = [subset for groups in predicate_subset_groups for subset in groups]

        # stage 9: one canonical label per confirmed subset (singletons keep their own name/predicate, no LLM call)
        with ThreadPoolExecutor(max_workers=_WORKERS) as pool:
            entity_canonical_labels = list(pool.map(
                lambda subset: canonical_label_for_subset(subset, 'name', self.llm_client, kind='entities'),
                confirmed_entity_subsets,
            ))
        entity_clusters = [
            {'members': [e['name'] for e in subset], 'canonical_label': label}
            for subset, label in zip(confirmed_entity_subsets, entity_canonical_labels)
        ]

        with ThreadPoolExecutor(max_workers=_WORKERS) as pool:
            predicate_canonical_labels = list(pool.map(
                lambda subset: canonical_label_for_subset(subset, 'predicate', self.llm_client, kind='relations'),
                confirmed_predicate_subsets,
            ))
        predicate_clusters = [
            {'members': [p['predicate'] for p in subset], 'canonical_label': label}
            for subset, label in zip(confirmed_predicate_subsets, predicate_canonical_labels)
        ]

        # stage 10: iteratively build the schema (type taxonomy) from entity clusters' types
        entities_by_name = {e['name'].lower(): e for e in global_entities}
        schema = build_schema(entity_clusters, entities_by_name, self.config, self.llm_client)

        return {
            'chunks': chunk_records,
            'entities': global_entities,
            'predicates': predicate_records,
            'entity_clusters': entity_clusters,
            'predicate_clusters': predicate_clusters,
            'schema_levels': schema['levels'],
            'schema_relations': schema['relations'],
        }
