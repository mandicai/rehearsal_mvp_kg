"""Stage 7 orchestration: batch-embed every entity/predicate description
once, then cluster entities and predicates independently by pairwise
similarity (similarity.py + clustering.py)."""
from .clustering import cluster_by_similarity
from .similarity import embed_descriptions, entity_pair_similarity, predicate_pair_similarity


def cluster_entities(entities: list, config) -> list:
    if len(entities) < 2:
        return [[e] for e in entities]

    embeddings = embed_descriptions([e.get('description') or e['name'] for e in entities])

    def pair_sim(i, j):
        return entity_pair_similarity(entities[i], entities[j], embeddings[i], embeddings[j], config)

    return cluster_by_similarity(entities, pair_sim, config.similarity_cluster_threshold)


def cluster_predicates(predicates: list, config) -> list:
    if len(predicates) < 2:
        return [[p] for p in predicates]

    embeddings = embed_descriptions([p.get('description') or p['predicate'] for p in predicates])

    def pair_sim(i, j):
        return predicate_pair_similarity(predicates[i], predicates[j], embeddings[i], embeddings[j], config)

    return cluster_by_similarity(predicates, pair_sim, config.similarity_cluster_threshold)
