"""Stage 8: given each stage-7 candidate cluster (entities or predicates
whose heuristic similarity score cleared the threshold), ask an LLM to
return the subsets of items within it that are genuinely semantically equal
- Levenshtein + embedding similarity alone can conflate merely-related items
(e.g. "queen" and "queen bee") with truly identical ones, so a candidate
cluster of size 3 might really be two separate equivalence classes.
Singleton candidate clusters skip the LLM call entirely (nothing to split).
"""


def _partition_by_name(cluster: list, name_key: str, name_partitions: list) -> list:
    by_name = {item[name_key].lower(): item for item in cluster}
    return [[by_name[name.lower()] for name in group if name.lower() in by_name] for group in name_partitions]


def confirm_entity_subsets(cluster: list, llm_client) -> list:
    if len(cluster) < 2:
        return [cluster]

    items = [{'name': e['name'], 'types': e.get('types'), 'description': e.get('description', '')} for e in cluster]
    name_partitions = llm_client.confirm_semantic_subsets(items, kind='entities')
    return _partition_by_name(cluster, 'name', name_partitions)


def confirm_predicate_subsets(cluster: list, llm_client) -> list:
    if len(cluster) < 2:
        return [cluster]

    items = [{'name': p['predicate'], 'description': p.get('description', '')} for p in cluster]
    name_partitions = llm_client.confirm_semantic_subsets(items, kind='relations')
    return _partition_by_name(cluster, 'predicate', name_partitions)
