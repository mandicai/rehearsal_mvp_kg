"""Stage 9: for each stage-8 confirmed subset of 2+ semantically-equal
entities (or relations), get a single canonical label to represent the
whole group - via the two-hop meta-prompting approach in Carta et al., 2023:
first ask an LLM to compose a further, self-contained prompt for eliciting a
unique label for this specific group (llm.py's compose_label_prompt), then
send that composed prompt back to the LLM, standalone, to actually get the
label (apply_label_prompt).

Subsets of size 1 didn't need merging in the first place, so they keep
their existing name/predicate as-is with no LLM calls at all.
"""


def canonical_label_for_subset(subset: list, name_key: str, llm_client, kind: str) -> str:
    if len(subset) < 2:
        return subset[0][name_key]

    items = [{'name': item[name_key], 'description': item.get('description', '')} for item in subset]
    composed_prompt = llm_client.compose_label_prompt(items, kind=kind)
    label = llm_client.apply_label_prompt(composed_prompt)
    return label or subset[0][name_key]  # fall back to an arbitrary member's existing name if nothing usable came back
