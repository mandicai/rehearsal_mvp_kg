# README.md

- To start frontend: `python3 backend/server.py`
- To start backend server: `python3 -m http.server 5500`
- Create a `.env` file in `backend/` and add a key for the LLM proxy

HTML pages live in `html/` and JS files live in `js/` (e.g. `http://localhost:5500/html/index.html`); both are served as static files from the repo root by the `http.server` command above, so page/script/asset references use root-absolute paths (e.g. `/js/helpers.js`, `/slides.json`) rather than paths relative to `html/`.

## `backend/segmentation/*.py`

Handles segmentation of input documents or a Wikipedia URL (placeholder for now, as an example of "common knowledge")

1. `structure.py` - recover and data-fy structure of input documents (base of knowledge)
2. `units.py` - build base units from document structure elements, essentially sentences
3. `embeddings.py` - turn sentence units into embeddings
4. `entities.py`, `keyphrases.py` - use `spaCy` to extract entities and keyphrases (noun chunks - nouns with descriptive phrases)
5. `boundaries.py` - calculate forced and soft boundaries between units (soft boundary score is based on semantic distance, entity shift and keyphrase shift scores between adjacent units)
6. `refine.py` - use calculated boundary scores to veto particular boundaries, based on presence of referral pronouns, semantic similarity, and entity similarity between two units; enforce length of final segments (though this is commented out for now)
7. `labeling.py` - call LLM model with instructions to generate a topic label, top-line summary, key entities, and keyphrases for returned segments; if no API key is present, fall back to a local keyphrase labeler option

## html/index.html

- Our system that provides improves feedback over naive system

## html/feedback.html

- Naive presentation feedback system that feeds presentation transcript/images to LLM; asks LLM to simulate a particular audience and return feedback

### Task list

- Feels like there's a fair bit of duplicative work happening in `segmentation.py`, specifically in entity and keyphrase extraction, because earlier steps in the document segmentation pipeline use `spaCy` to extract entities and keyphrase in order to calculate boundaries to separate blocks of text into `segments` (in `boundaries.py` and `refine.py`, based on semantic distance, entity shift, and keyphrase shift between units of text) ... but then we call an LLM in `labeling.py` to again produce a summary, topic label, top entities, and keyphrases of the final text segments that is displayed in the frontend. We could just ask the LLM to segment a document or webpage, then directly generate the labels.

### Prompts for building

#### Prompt

I'd like to try a different backend pipeline, separate from what is in `segmentation/`. You can call this pipeline `segmentation_carta/`. The first step of the pipeline should be to split input texts into reasonable lengths that don't flood the token limit/context window of the called LLM in later steps. The splitting technique should provide some signal of the global context, by providing a summary of previous chunks. Split chunks can also be partially overlapping sliding windows of the input text. The second step of the pipeline should be identifying entity mentions in a split text chunk, using an LLM. The prompt to this LLM should include an explanation of what is meant by an "entity" and "an explicit request to retrieve the entity mentions in the user’s text, specifying the additional requirement of providing a description and a list of types for each" (Carta et al., 2023). Stop here for now, although I will add more steps later.

#### Returned

What I built, in backend/segmentation_carta/ (fully separate from segmentation/, no shared imports):
- config.py — CartaConfig: chunk size/overlap, rolling-summary budget, LLM model.
- chunking.py (Stage 1) — sentence-aware sliding-window chunker with a rolling extractive summary (frequency-based sentence scoring, fully local, no LLM) carried forward as each chunk's "document so far" context.
- llm.py (Stage 2) — CartaLLMClient.extract_entities(): the prompt defines what counts as an "entity," explicitly requests every mention in the chunk, and requires a description + types list per entity, per Carta et al. No local fallback — raises clearly if unconfigured, same philosophy as feedback_llm.py.
- pipeline.py — CartaPipeline.run() orchestrates chunk → per-chunk entity extraction (parallelized like the existing pipeline's labeling stage).

#### Prompt

I want to build more steps in the `segmentation_carta/` pipeline. The next step after entity extraction should be, for each entity, to look at the original whole text and prompt an LLM to grab simple declarative sentences that provide information about the given entity. Then, the step after should prompt an LLM requesting it to recognize the mentions of the listed entities in the narrowed text about the given entity (the output of the former step).

#### Returned

- aggregate.py (Stage 2b, new prerequisite) — merges per-chunk entity mentions into one deduplicated, document-level entity list (by case-insensitive name match). Needed because Stage 1's chunks overlap by design, so Stage 2 routinely extracts the same entity more than once.
- evidence.py (Stage 3) — for each global entity, gathers simple declarative sentences about it from across the whole document. Rather than sending raw full text to an LLM (reintroducing the token-limit problem Stage 1 solved), it reuses Stage 1's chunks and only spends an LLM call on chunks whose text actually mentions the entity's name — a cheap pre-filter that keeps cost proportional to real mentions.
- related_entities.py (Stage 4) — for each entity, prompts an LLM with its Stage 3 evidence ("narrowed text") plus the full list of other known entity names, asking which ones are mentioned within it. Responses are validated against the actual entity-name list so a hallucinated name can't leak through.
- llm.py — added extract_entity_evidence and recognize_related_entities, each with their own explicit prompt.
- pipeline.py — now orchestrates all four stages and returns {chunks, entities} instead of a flat chunk list.

Also updated server.py's /segment_carta route and the carta.html inspector (helpers.js/carta.js) to surface the new global entity list — each entity's evidence sentences and related-entity chips are now visible, since leaving them uncomputed-but-invisible in the existing double-checking tool would defeat its purpose.

Verified end-to-end with a real LLM against the test document — confirmed entities correctly merge across overlapping chunks (e.g. "Karl von Frisch" collapses from 2 mentions to 1), evidence sentences are gathered from the right chunks, and related-entity recognition produces sensible pairs (e.g. "queen bee" ↔ "royal jelly"). No console errors in the browser.

One cost/latency note worth flagging: Stage 3 makes one LLM call per (entity, chunk-that-mentions-it) pair and Stage 4 makes one per entity, so total calls scale with entity count, not just chunk count — for a document with many chunks and many distinct entities this could get slow/expensive. MAX_CARTA_CHARS (40k chars) caps this for now, but worth keeping in mind as you add more steps.

#### Prompt

Continue adding steps to the `segmentation_carta/` pipeline. The next step should extract relations between the identified entities in the narrowed text about the given entity, using an LLM. The LLM should "express the entity relations in the form of RDF triplets, using subjects and objects selected from the list of entities and by choosing an expressive predicate" (Carta et al., 2023). The prompt should instruct the LLM to generate "predicates that correctly represent the relationship between the two entities without being too specific, as it would make the predicate hardly reusable and observable in other triplets, aiming for a sort of predicate canonicalization" (Carta et al., 2023). The step after (a separate step) should prompt an LLM to "return the description of each unique predicate, referencing the text" (Carta et al., 2023). The description should capture "the generic nature of the relation expressed by the" (Carta et al., 2023) predicate.

#### Returned

- relations.py (Stage 5) — for each entity, extracts RDF-triple relations (subject/predicate/object) to its Stage-4 related entities, grounded in its Stage-3 narrowed evidence text. The prompt (llm.py's extract_relations) instructs the model to keep predicates general/reusable rather than maximally specific ("predicate canonicalization"), per the Carta et al. wording you quoted. Subjects/objects are constrained to the focus entity + its related entities and defensively re-validated against that set after the call.
- predicates.py (Stage 6) — collects every unique predicate produced across all entities' relations (case-insensitive), grouping each with the (subject, object) pairs that used it and the distinct evidence texts they came from, then prompts an LLM (describe_predicate) to write one generic, text-grounded description per predicate.
- pipeline.py now returns {chunks, entities, predicates}; server.py's /segment_carta route and carta.html's inspector (helpers.js/carta.js) were updated to show each entity's relations and a new predicate-glossary section, consistent with the established double-checking purpose of that page.

Verified end-to-end with real LLM calls (standalone script + browser), no console errors. Two honest observations from testing:

1. Predicate canonicalization is imperfect in practice: because each entity's Stage-5 call is independent, I saw near-duplicate predicates for the same relation in one run (feeds_on / fed_on / is_fed_with all describing "queen bee ← royal jelly"). The prompt asks for general predicates, but true document-wide canonicalization would need a step with global visibility across all entities' triples at once — worth considering as a future stage if this matters for your use case.
2. Cost continues to scale up: Stage 5 adds ~1 call/entity, Stage 6 adds ~1 call/unique predicate, on top of Stages 2–4's calls. Worth keeping an eye on for larger documents even with MAX_CARTA_CHARS capping input size.

#### Prompt

Keep writing steps for the `segmentation_carta/` pipeline. The next step should aggregate semantically similar entities and predicate relations, based on a similiarity score that is a weighted combination of label similarity (the Levenshtein distance between the two entity labels), entity types similarity (Levenshtein distance), and description similarity ("project all entity and relation descriptions in an embedding space", "compute the similarity between two descriptions i and j, relying on a classical cosine similarity metric" (Carta et al., 2023)). In the next step, with these aggregated clusters, prompt an LLM to return "subsets of semantically equal entities or relations" (Carta et al., 2023z). Finally in another step, prompt an LLM to "compose a further prompt aimed at asking for a unique label for representing" (Carta et al., 2023) the subsets.

#### Returned

- similarity.py (Stage 7 scoring) — pairwise similarity for entities (label Levenshtein + type-list Levenshtein + description cosine similarity via sentence-transformer embeddings) and predicates (label + description only, renormalized). Pure Python Levenshtein, no new dependency.
- clustering.py + aggregate_similar.py (Stage 7 grouping) — Union-Find over every pair whose combined score clears config.similarity_cluster_threshold (default 0.82), run independently for entities and predicates.
- dedup.py (Stage 8) — for each candidate cluster of size >1, an LLM call partitions it into subsets that are genuinely semantically equal, returning "subsets of semantically equal entities or relations" per Carta et al. Singletons skip the LLM call.
- canonical_label.py (Stage 9) — the two-hop meta-prompt you specified: compose_label_prompt asks the LLM to write a self-contained further prompt for eliciting a unique label for the confirmed subset, then apply_label_prompt sends that composed prompt back to the LLM, standalone, to get the actual label.
- pipeline.py now returns {chunks, entities, predicates, entity_clusters, predicate_clusters}, wired through server.py and the carta.html inspector.

Caught and fixed a real thing during testing (not a code bug, but worth noting): my first full-pipeline run showed zero merges even though a similarity score I computed by hand cleared the threshold — turned out to be LLM non-determinism between runs, not a wiring bug. I verified correctness by testing Stage 7 and Stage 8 in isolation against fixed data, then reran the full pipeline and got clean confirmation: is_known_for/are_known_for were correctly clustered, LLM-confirmed as the same relation, and given the canonical label "is_recognized_for" — while a false-positive candidate (butterflies/beetles, likely similar types+descriptions) was correctly rejected by Stage 8's LLM check rather than wrongly merged.

One design choice worth flagging: Stages 7–9 currently only identify duplicate clusters and canonical labels — they don't yet rewrite entities/predicates/relations to use them. I kept each stage additive/inspectable (consistent with every earlier stage), but "actually apply the merge" would be a natural next step if you want a fully deduplicated final graph rather than just the merge recommendations.

#### Prompt

Now, in another step in `segmentation_carta/`, we are going to generate a schema for the knowledge graph iteratively. In the next step, these two steps should happen iteratively with the cluster outputs from the previous step: (1) Hypernym Generation: "For each cluster, after removing the possible duplicates (as, obviously, different entities may belong to the same type), the types are embedded in an appropriate prompt sent to an LLM to find a common hypernym for the entire cluster and relation that links such hypernym to the entity types, or, depending on the cluster size and semantic similarities among types, finding a set of appropriate hypernyms, each one being related to a distinct cluster subset. For example, for the types legumes, green vegetables, poultry, pork, fish, and crustacean, the most suitable hypernyms may be vegetables (connected to the types legumes and green vegetables), meat (for pork and poultry), and seafood (for fish and crustacean). In all three cases, each type may be linked with the related hypernym with the relation is type of." (Carta et al., 2023) (2) "Subsequently, all generated hypernyms and relations are merged across all clusters to remove redundancies. Let us point out that the initial entity types will represent the lower level of the schema, whereas the hypernyms will represent the upper level of the taxonomy. Afterward, for the upper level, we apply the same Semantic Aggregation technique described in Section 4.3.2 for finding a new set of clusters. We then applied the Hypernym Generation and the Hierarchical Agglomeration iteratively for constructing the upper levels of the taxonomy until we reach the scenario in which, at this stage, only one cluster and one hypernym are generated." (Carta et al., 2023)

#### Returned

- taxonomy.py — the full iterative loop: (a) Hypernym Generation per entity-cluster's deduplicated types, linked via a fixed "is type of" relation (not LLM-chosen, per your quote); (b) redundancy removal by reusing Stages 7–9's exact machinery unmodified (hypernyms treated as pseudo-entities: name=hypernym, types=union of covered types, no description); repeats using each level's deduplicated hypernym labels as input to the next, until a level collapses to one root or a safety cap (8 levels) is hit.
- llm.py — added generate_hypernym_groups, with the worked example from your quote (legumes/vegetables/meat/seafood) embedded directly in the prompt.
- pipeline.py/server.py/carta.html inspector all updated to expose schema_levels and schema_relations.

Two real bugs caught and fixed during testing (not just "it ran," verified the actual taxonomy structure was sensible):

1. Non-convergence bug: my first version fed each level's original underlying types back into the next level's hypernym generation instead of the newly-created hypernym labels — so it just regenerated the same hypernyms forever and hit the 8-level cap without progress.
2. Oscillation bug: after fixing #1, single-item "clusters" at upper levels gave the LLM no comparison signal, so it bounced between near-synonyms (Entity → Concept → Abstract Entity → Entity → ...) rather than converging. Fixed by giving the LLM all remaining distinct hypernyms together in one call per level (matching the paper's own worked example, which hands the model 6 types at once) rather than pre-clustering them by bare-label embedding similarity, which turned out to be too weak a signal for short, decontextualized words.

After both fixes, verified a correct 3-level convergence: {Insect, Organism, Human, Vegetation} → Living Organism, Abstract Entity → Abstract Concept, Location → Geographical Entity, then all three converging to a single root Entity — exactly the "one cluster and one hypernym" termination condition described in the paper. Also deduped the final relations list, since independent entity clusters sharing identical type sets were producing exact-duplicate is type of triples.
