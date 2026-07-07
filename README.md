# README.md

- To start frontend: `python3 backend/server.py`
- To start backend server: `python3 -m http.server 5500`

## `backend/segmentation.py`

Handles segmentation of input documents or a Wikipedia URL (placeholder for now, as an example of "common knowledge")

1. `structure.py` - recover and data-fy structure of input documents (base of knowledge)
2. `units.py` - build base units from document structure elements, essentially sentences
3. `embeddings.py` - turn sentence units into embeddings
4. `entities.py`, `keyphrases.py` - use `spaCy` to extract entities and keyphrases (noun chunks - nouns with descriptive phrases)
5. `boundaries.py` - calculate forced and soft boundaries between units (soft boundary score is based on semantic distance, entity shift and keyphrase shift scores between adjacent units)
6. `refine.py` - use calculated boundary scores to veto particular boundaries, based on presence of referral pronouns, semantic similarity, and entity similarity between two units; enforce length of final segments (though this is commented out for now)
7. `labeling.py` - call LLM model with instructions to generate a topic label, top-line summary, key entities, and keyphrases for returned segments; if no API key is present, fall back to a local keyphrase labeler option

### Task list

- Feels like there's a fair bit of duplicative work happening in `segmentation.py`, specifically in entity and keyphrase extraction, because earlier steps in the document segmentation pipeline use `spaCy` to extract entities and keyphrase in order to calculate boundaries to separate blocks of text into `segments` (in `boundaries.py` and `refine.py`, based on semantic distance, entity shift, and keyphrase shift between units of text) ... but then we call an LLM in `labeling.py` to again produce a summary, topic label, top entities, and keyphrases of the final text segments that is displayed in the frontend. We could just ask the LLM to segment a document or webpage, then directly generate the labels.
