"""Stage 10: iteratively build the knowledge graph's schema (a type
taxonomy), following Carta et al., 2023's Hypernym Generation + Hierarchical
Agglomeration loop.

Level 0's input is the deduplicated union of entity types within each
stage-9 confirmed entity cluster (different entities in the same cluster
routinely share a type, so this is deduped per cluster before generating
hypernyms).

Each iteration:
(a) Hypernym Generation: for every cluster of types at the current level,
    prompt an LLM to partition them into one or more groups, each given a
    single hypernym label, linked to its member types via a fixed "is type
    of" relation (llm.py's generate_hypernym_groups - the predicate itself
    is fixed, not LLM-chosen; only the grouping and hypernym labels are).
(b) Remove redundancies: different clusters routinely produce the same (or
    a near-duplicate) hypernym independently, so these get merged by
    reusing the exact same similarity-clustering + LLM-confirmed-subset +
    canonical-labeling machinery from stages 7-9 (aggregate_similar.py,
    dedup.py, canonical_label.py) - hypernyms are treated as pseudo-entities
    (name=hypernym label, types=the union of types it covers, no
    description, so similarity scoring falls back to embedding the label
    itself) so that code works completely unmodified.
Level 0's input is naturally split into one type-list per entity cluster,
since types co-occurring on entities already known to cluster together are a
meaningful local grouping. From level 1 onward there's no such boundary left
- everything is just a flat, decontextualized set of hypernym labels - so
every remaining distinct hypernym is given to the LLM together in a single
call each level, letting it decide the grouping itself (the same way the
worked example above hands the model 6 types at once and lets it choose 1-3
groups), rather than pre-clustering by embedding similarity: an earlier
version of this module tried exactly that using bare label-embedding
similarity, and it was too weak a signal for short, decontextualized labels
- "Entity" and "Concept" don't embed as similar as they are - which produced
mostly-singleton "clusters" and just made hypernym generation oscillate
between near-synonyms (Entity -> Concept -> Abstract Entity -> Entity -> ...)
instead of converging.

This repeats until a level collapses to a single hypernym (the root of the
taxonomy), or a safety cap on iteration count is hit - LLM behavior isn't
guaranteed to converge to exactly one root on its own, unlike the paper's
idealized description.
"""
from .aggregate_similar import cluster_entities
from .canonical_label import canonical_label_for_subset
from .dedup import confirm_entity_subsets

_IS_TYPE_OF = 'is type of'
_MAX_LEVELS = 8  # safety cap: stop building upward even if the LLM never converges to a single root


def _entity_cluster_type_lists(entity_clusters: list, entities_by_name: dict) -> list:
    """The deduplicated union of member entities' types, per stage-9
    confirmed entity cluster - one list per cluster, empty clusters (no
    typed members) dropped."""
    type_lists = []
    for cluster in entity_clusters:
        seen = set()
        types = []
        for member_name in cluster['members']:
            entity = entities_by_name.get(member_name.lower())
            if not entity:
                continue
            for t in entity.get('types') or []:
                key = t.strip().lower()
                if key and key not in seen:
                    seen.add(key)
                    types.append(t.strip())
        if types:
            type_lists.append(types)
    return type_lists


def _generate_hypernyms_for_level(type_lists: list, llm_client) -> tuple:
    """Stage 10a across every cluster at the current level. Returns
    (hypernym_groups, is_type_of_relations)."""
    groups = []
    relations = []
    for types in type_lists:
        for group in llm_client.generate_hypernym_groups(types):
            groups.append(group)
            for t in group['types']:
                relations.append({'subject': t, 'predicate': _IS_TYPE_OF, 'object': group['hypernym']})
    return groups, relations


def _as_pseudo_entities(groups: list) -> list:
    return [{'name': g['hypernym'] if 'hypernym' in g else g['canonical_label'], 'types': g['types'], 'description': None} for g in groups]


def _remove_redundant_hypernyms(groups: list, config, llm_client) -> list:
    """Stage 10b: redundant hypernyms produced independently across
    different clusters get merged here (full stages 7-9 machinery, since
    this genuinely needs to confirm "is this the same concept?")."""
    candidate_clusters = cluster_entities(_as_pseudo_entities(groups), config)

    confirmed_subsets = []
    for cluster in candidate_clusters:
        confirmed_subsets.extend(confirm_entity_subsets(cluster, llm_client))

    deduped = []
    for subset in confirmed_subsets:
        canonical = canonical_label_for_subset(subset, 'name', llm_client, kind='entities')
        combined_types = []
        seen = set()
        for item in subset:
            for t in (item.get('types') or []):
                key = t.strip().lower()
                if key and key not in seen:
                    seen.add(key)
                    combined_types.append(t)
        deduped.append({
            'members': [item['name'] for item in subset],
            'canonical_label': canonical,
            'types': combined_types,
        })
    return deduped


def build_schema(entity_clusters: list, entities_by_name: dict, config, llm_client) -> dict:
    type_lists = _entity_cluster_type_lists(entity_clusters, entities_by_name)

    levels = []
    all_relations = []
    level_index = 0

    while type_lists and level_index < _MAX_LEVELS:
        hypernym_groups, level_relations = _generate_hypernyms_for_level(type_lists, llm_client)
        all_relations.extend(level_relations)
        if not hypernym_groups:
            break

        deduped_hypernyms = _remove_redundant_hypernyms(hypernym_groups, config, llm_client)
        levels.append({
            'level': level_index,
            'hypernym_groups': hypernym_groups,
            'deduped_hypernyms': deduped_hypernyms,
        })

        level_index += 1
        if len(deduped_hypernyms) <= 1:
            break  # converged: the whole schema rolled up into a single root hypernym

        # next level's input is every remaining distinct hypernym LABEL
        # (not their now-stale underlying types), all given to the LLM
        # together in one call so it can decide the grouping itself
        type_lists = [[d['canonical_label'] for d in deduped_hypernyms]]

    return {'levels': levels, 'relations': _dedupe_relations(all_relations)}


def _dedupe_relations(relations: list) -> list:
    # multiple entity clusters independently sharing an identical type set
    # (e.g. three separate clusters all typed ['Insect', 'Pollinator'])
    # produce the exact same "is type of" triple more than once
    seen = set()
    deduped = []
    for r in relations:
        key = (r['subject'].lower(), r['predicate'].lower(), r['object'].lower())
        if key not in seen:
            seen.add(key)
            deduped.append(r)
    return deduped
