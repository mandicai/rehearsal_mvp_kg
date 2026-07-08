// Reusable, self-contained functions and data: text analysis, algorithms,
// and DOM-building routines that take their target container/data as
// parameters rather than reaching into page-specific global state.
// App wiring and mutable state live in main.js instead.

// --- Target audience inference ---
// Suggestions are computed for real from the actual transcript text (simple
// keyword matching below) — not mocked. The list of candidate audiences and
// their trigger words is still a hand-picked heuristic, not a real model.

const AUDIENCE_RULES = [
  { label: 'Presenters / Educators', re: /\bpresenters?\b|\bpresenter'?s notes\b/gi },
  { label: 'Students / Classroom Learners', re: /\bstudents?\b|\bclass\b|\blesson\b/gi },
  { label: 'Biology / Life-Science Learners', re: /\breproductive\b|\bovule\b|\bpollen\b|\borganism\b/gi },
  { label: 'Gardening Enthusiasts', re: /\bgarden\w*|\bbloom\w*|\bpetal\w*/gi },
  { label: 'Allergy-aware Audience', re: /\ballerg\w*/gi }
];

function computeInferredAudiences(slideData) {
  const fullText = slideData.map(s => s.transcript || '').join(' ');
  return AUDIENCE_RULES
    .map(rule => ({ label: rule.label, count: (fullText.match(rule.re) || []).length }))
    .filter(r => r.count > 0)
    .sort((a, b) => b.count - a.count);
}

// --- Structure-aware semantic segmentation ---
// Real implementation: parses document structure (headings/paragraphs/lists),
// builds base text units, embeds them with a sentence-transformer
// (all-MiniLM-L6-v2), scores candidate boundaries from semantic + entity +
// keyphrase shift plus heading signals, refines for entity continuity and
// length constraints, then labels each final segment with a topic label,
// summary, entities, and keyphrases (via an LLM when an API key is
// configured server-side, otherwise a local spaCy/keyphrase heuristic).
// All of that only runs in Python, so the pipeline lives in
// backend/segmentation/ behind a small local HTTP service
// (backend/server.py) — this function just calls it. Start it with
// `python backend/server.py` before using the upload/URL extractor.

const SEGMENT_API_URL = 'http://127.0.0.1:8000/segment';

function fetchSegments(text, documentId) {
  return fetch(SEGMENT_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, document_id: documentId })
  })
    .then(res => {
      if (!res.ok) {
        return res.json()
          .catch(() => ({}))
          .then(body => { throw new Error(body.error || `server responded with ${res.status}`); });
      }
      return res.json();
    })
    .catch(err => {
      throw new Error(
        `Could not reach the segmentation server at ${SEGMENT_API_URL} (${err.message}). ` +
        `Start it with: python backend/server.py`
      );
    });
}

function renderChipList(container, values, chipClass) {
  values.forEach(value => {
    const chip = document.createElement('span');
    chip.className = `chip ${chipClass}`;
    chip.textContent = value;
    container.appendChild(chip);
  });
}

function renderSegmentation(container, result, sourceLabel) {
  const section = document.createElement('div');
  section.className = 'segments-section';

  const label = document.createElement('div');
  label.className = 'section-label';
  label.textContent = `Segments for "${sourceLabel}" — structure-aware semantic segmentation, computed for real from this input (${result.segments.length} segment${result.segments.length === 1 ? '' : 's'})${result.truncated ? ', truncated' : ''}`;
  section.appendChild(label);

  result.segments.forEach(segment => {
    const card = document.createElement('div');
    card.className = 'segment-card';

    const title = document.createElement('div');
    title.className = 'segment-title';
    title.textContent = segment.topic_label;
    card.appendChild(title);

    const meta = segment.source_metadata || {};
    const metaParts = [meta.section_title, meta.subsection_title].filter(Boolean);
    if (metaParts.length > 0) {
      const metaEl = document.createElement('div');
      metaEl.className = 'segment-meta';
      metaEl.textContent = metaParts.join(' › ');
      card.appendChild(metaEl);
    }

    if (segment.summary) {
      const summary = document.createElement('div');
      summary.className = 'segment-summary';
      summary.textContent = segment.summary;
      card.appendChild(summary);
    }

    const chips = document.createElement('div');
    chips.className = 'segment-chips';
    renderChipList(chips, segment.top_entities || [], 'entity');
    renderChipList(chips, segment.keyphrases || [], 'keyphrase');
    if (chips.children.length > 0) card.appendChild(chips);

    const text = document.createElement('div');
    text.className = 'segment-text';
    text.textContent = segment.text;
    card.appendChild(text);

    section.appendChild(card);
  });

  container.appendChild(section);
}

// --- segmentation_carta inspector (carta.html) ---
// Calls the separate segmentation_carta pipeline (backend/segmentation_carta/,
// exposed at /segment_carta) - real, like fetchSegments above, but a
// different, still-growing pipeline. So far: text -> overlapping chunks
// (each carrying a rolling summary of prior chunks) -> LLM-extracted entity
// mentions per chunk -> merged into one global entity list per document ->
// per-entity declarative-sentence evidence gathered from every chunk that
// mentions it -> per-entity recognition of which other entities are
// mentioned within that evidence. No local fallback server-side anywhere
// past chunking, so a missing LLM key surfaces as a 503 here.

const CARTA_API_URL = 'http://127.0.0.1:8000/segment_carta';

function fetchCartaResult(text, documentId) {
  return fetch(CARTA_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, document_id: documentId })
  })
    .then(res => {
      if (!res.ok) {
        return res.json()
          .catch(() => ({}))
          .then(body => { throw new Error(body.error || `server responded with ${res.status}`); });
      }
      return res.json();
    })
    .catch(err => {
      throw new Error(
        `Could not reach the segmentation_carta server at ${CARTA_API_URL} (${err.message}). ` +
        `Start it with: python backend/server.py`
      );
    });
}

function renderCartaChunks(container, result, sourceLabel) {
  const section = document.createElement('div');
  section.className = 'segments-section';

  const label = document.createElement('div');
  label.className = 'section-label';
  label.textContent = `Chunks for "${sourceLabel}" — segmentation_carta pipeline, computed for real from this input (${result.chunks.length} chunk${result.chunks.length === 1 ? '' : 's'})${result.truncated ? ', truncated' : ''}`;
  section.appendChild(label);

  result.chunks.forEach(chunk => {
    const card = document.createElement('div');
    card.className = 'segment-card';

    const title = document.createElement('div');
    title.className = 'segment-title';
    const wordCount = (chunk.text || '').split(/\s+/).filter(Boolean).length;
    title.textContent = `Chunk ${chunk.chunk_index + 1} — chars ${chunk.char_start}-${chunk.char_end} (${wordCount} words)`;
    card.appendChild(title);

    if (chunk.context_summary) {
      const summary = document.createElement('div');
      summary.className = 'segment-summary';
      summary.textContent = `Context so far: ${chunk.context_summary}`;
      card.appendChild(summary);
    }

    const text = document.createElement('div');
    text.className = 'segment-text';
    text.textContent = chunk.text;
    card.appendChild(text);

    const entities = chunk.entities || [];
    const entityHeader = document.createElement('div');
    entityHeader.className = 'carta-entity-header';
    entityHeader.textContent = `Entity mentions (${entities.length})`;
    card.appendChild(entityHeader);

    if (entities.length === 0) {
      const note = document.createElement('div');
      note.className = 'graph-empty-note';
      note.textContent = 'No entity mentions extracted for this chunk.';
      card.appendChild(note);
    } else {
      const list = document.createElement('div');
      list.className = 'carta-entity-list';
      entities.forEach(entity => renderCartaEntityRow(list, entity));
      card.appendChild(list);
    }

    section.appendChild(card);
  });

  container.appendChild(section);
}

// One entity's row: name + type chips + description, plus (only present on
// the global, merged entities from renderCartaEntities below - per-chunk
// mentions in renderCartaChunks above don't have these yet) stage 3's
// cross-document evidence sentences and stage 4's related entities.
function renderCartaEntityRow(container, entity) {
  const row = document.createElement('div');
  row.className = 'carta-entity';

  const nameRow = document.createElement('div');
  nameRow.className = 'carta-entity-name-row';
  const name = document.createElement('span');
  name.className = 'carta-entity-name';
  name.textContent = entity.name;
  nameRow.appendChild(name);
  renderChipList(nameRow, entity.types || [], 'keyphrase');
  row.appendChild(nameRow);

  if (entity.description) {
    const description = document.createElement('div');
    description.className = 'carta-entity-description';
    description.textContent = entity.description;
    row.appendChild(description);
  }

  if (entity.evidence_sentences && entity.evidence_sentences.length > 0) {
    const evidenceHeader = document.createElement('div');
    evidenceHeader.className = 'carta-entity-subheader';
    evidenceHeader.textContent = `Evidence sentences (${entity.evidence_sentences.length})`;
    row.appendChild(evidenceHeader);

    const ul = document.createElement('ul');
    ul.className = 'carta-entity-evidence-list';
    entity.evidence_sentences.forEach(sentence => {
      const li = document.createElement('li');
      li.textContent = sentence;
      ul.appendChild(li);
    });
    row.appendChild(ul);
  }

  if (entity.related_entities && entity.related_entities.length > 0) {
    const relatedHeader = document.createElement('div');
    relatedHeader.className = 'carta-entity-subheader';
    relatedHeader.textContent = `Related entities (${entity.related_entities.length})`;
    row.appendChild(relatedHeader);

    const relatedChips = document.createElement('div');
    relatedChips.className = 'carta-entity-related-chips';
    renderChipList(relatedChips, entity.related_entities, 'entity');
    row.appendChild(relatedChips);
  }

  if (entity.relations && entity.relations.length > 0) {
    const relationsHeader = document.createElement('div');
    relationsHeader.className = 'carta-entity-subheader';
    relationsHeader.textContent = `Relations (${entity.relations.length})`;
    row.appendChild(relationsHeader);

    const ul = document.createElement('ul');
    ul.className = 'carta-entity-evidence-list';
    entity.relations.forEach(rel => {
      const li = document.createElement('li');
      li.textContent = `${rel.subject} → ${rel.predicate} → ${rel.object}`;
      ul.appendChild(li);
    });
    row.appendChild(ul);
  }

  container.appendChild(row);
}

// The global, per-document entity list (stage 2b's merge output, enriched by
// stages 3-5): one row per real-world entity, deduplicated across chunks,
// each with its cross-document evidence, related entities, and RDF-triple
// relations - the main thing to double-check once those stages are in the
// pipeline, since renderCartaChunks above only shows each chunk's raw
// (possibly duplicated, evidence-free) extraction.
function renderCartaEntities(container, result, sourceLabel) {
  const section = document.createElement('div');
  section.className = 'segments-section';

  const entities = result.entities || [];
  const label = document.createElement('div');
  label.className = 'section-label';
  label.textContent = `Global entities for "${sourceLabel}" — merged across all chunks, with cross-document evidence and related entities (${entities.length} entit${entities.length === 1 ? 'y' : 'ies'})`;
  section.appendChild(label);

  if (entities.length === 0) {
    const note = document.createElement('div');
    note.className = 'graph-empty-note';
    note.textContent = 'No entities extracted for this source.';
    section.appendChild(note);
    container.appendChild(section);
    return;
  }

  const card = document.createElement('div');
  card.className = 'segment-card';
  const list = document.createElement('div');
  list.className = 'carta-entity-list';
  entities.forEach(entity => renderCartaEntityRow(list, entity));
  card.appendChild(list);
  section.appendChild(card);

  container.appendChild(section);
}

// Stage 6's output: one description per unique predicate used across every
// entity's stage-5 relations, plus the (subject, object) triples that used
// it - lets you double-check predicate canonicalization (are near-duplicate
// predicates like "feeds_on" / "is_fed_by" being collapsed, or not?) and
// whether each description is grounded in the text rather than invented.
function renderCartaPredicates(container, result, sourceLabel) {
  const section = document.createElement('div');
  section.className = 'segments-section';

  const predicates = result.predicates || [];
  const label = document.createElement('div');
  label.className = 'section-label';
  label.textContent = `Predicate glossary for "${sourceLabel}" — one description per unique predicate used across all relations (${predicates.length} predicate${predicates.length === 1 ? '' : 's'})`;
  section.appendChild(label);

  if (predicates.length === 0) {
    const note = document.createElement('div');
    note.className = 'graph-empty-note';
    note.textContent = 'No relations/predicates extracted for this source.';
    section.appendChild(note);
    container.appendChild(section);
    return;
  }

  const card = document.createElement('div');
  card.className = 'segment-card';
  const list = document.createElement('div');
  list.className = 'carta-entity-list';

  predicates.forEach(p => {
    const row = document.createElement('div');
    row.className = 'carta-entity';

    const nameRow = document.createElement('div');
    nameRow.className = 'carta-entity-name-row';
    const name = document.createElement('span');
    name.className = 'carta-entity-name';
    name.textContent = p.predicate;
    nameRow.appendChild(name);
    row.appendChild(nameRow);

    if (p.description) {
      const description = document.createElement('div');
      description.className = 'carta-entity-description';
      description.textContent = p.description;
      row.appendChild(description);
    }

    const triplesHeader = document.createElement('div');
    triplesHeader.className = 'carta-entity-subheader';
    triplesHeader.textContent = `Triples using this predicate (${p.triples.length})`;
    row.appendChild(triplesHeader);

    const ul = document.createElement('ul');
    ul.className = 'carta-entity-evidence-list';
    p.triples.forEach(t => {
      const li = document.createElement('li');
      li.textContent = `${t.subject} → ${p.predicate} → ${t.object}`;
      ul.appendChild(li);
    });
    row.appendChild(ul);

    list.appendChild(row);
  });

  card.appendChild(list);
  section.appendChild(card);
  container.appendChild(section);
}

// Stages 7-9's output: entities/predicates grouped into candidate-duplicate
// clusters by weighted label/type/description similarity (stage 7),
// narrowed to LLM-confirmed subsets of genuinely semantically-equal items
// (stage 8), each given one canonical label via a two-hop meta-prompt
// (stage 9). Every entity/predicate appears exactly once, in a cluster of
// its own if nothing matched it - useful for double-checking both that real
// duplicates got merged AND that the heuristic's false positives got
// correctly rejected by stage 8's LLM check.
function renderClusterList(container, clusters, kindLabel) {
  const header = document.createElement('div');
  header.className = 'carta-entity-header';
  const mergedCount = clusters.filter(c => c.members.length > 1).length;
  header.textContent = `${kindLabel} (${clusters.length} total, ${mergedCount} merged)`;
  container.appendChild(header);

  if (clusters.length === 0) {
    const note = document.createElement('div');
    note.className = 'graph-empty-note';
    note.textContent = `No ${kindLabel.toLowerCase()} to show.`;
    container.appendChild(note);
    return;
  }

  const list = document.createElement('div');
  list.className = 'carta-entity-list';
  clusters.forEach(cluster => {
    const row = document.createElement('div');
    row.className = 'carta-entity';

    const nameRow = document.createElement('div');
    nameRow.className = 'carta-entity-name-row';
    const name = document.createElement('span');
    name.className = 'carta-entity-name';
    name.textContent = cluster.canonical_label;
    nameRow.appendChild(name);
    if (cluster.members.length > 1) {
      const badge = document.createElement('span');
      badge.className = 'chip keyphrase';
      badge.textContent = `merged from ${cluster.members.length}`;
      nameRow.appendChild(badge);
    }
    row.appendChild(nameRow);

    if (cluster.members.length > 1) {
      const membersEl = document.createElement('div');
      membersEl.className = 'carta-entity-description';
      membersEl.textContent = `Members: ${cluster.members.join(', ')}`;
      row.appendChild(membersEl);
    }

    list.appendChild(row);
  });
  container.appendChild(list);
}

function renderCartaClusters(container, result, sourceLabel) {
  const section = document.createElement('div');
  section.className = 'segments-section';

  const label = document.createElement('div');
  label.className = 'section-label';
  label.textContent = `Similarity clusters for "${sourceLabel}" — stages 7-9: candidate duplicates grouped by label/type/description similarity, confirmed by an LLM, each given a canonical label`;
  section.appendChild(label);

  const card = document.createElement('div');
  card.className = 'segment-card';
  renderClusterList(card, result.entity_clusters || [], 'Entity clusters');
  renderClusterList(card, result.predicate_clusters || [], 'Predicate clusters');
  section.appendChild(card);

  container.appendChild(section);
}

// Stage 10's output: the schema (type taxonomy) built one level at a time -
// level 0 starts from each entity cluster's deduplicated types, every level
// after that works on the previous level's deduplicated hypernym labels,
// and the whole thing converges once a level collapses to a single
// hypernym (the taxonomy's root). Shows both the raw per-cluster hypernym
// groups a level generated and what they deduplicated down to, so you can
// double-check the climb one level at a time, plus the flat "is type of"
// edge list underneath.
function renderCartaSchema(container, result, sourceLabel) {
  const section = document.createElement('div');
  section.className = 'segments-section';

  const levels = result.schema_levels || [];
  const label = document.createElement('div');
  label.className = 'section-label';
  label.textContent = `Schema for "${sourceLabel}" — stage 10: iterative hypernym generation + hierarchical agglomeration (${levels.length} level${levels.length === 1 ? '' : 's'}${levels.length > 0 && levels[levels.length - 1].deduped_hypernyms.length === 1 ? ', converged to a single root' : ''})`;
  section.appendChild(label);

  if (levels.length === 0) {
    const note = document.createElement('div');
    note.className = 'graph-empty-note';
    note.textContent = 'No schema levels generated for this source.';
    section.appendChild(note);
    container.appendChild(section);
    return;
  }

  levels.forEach(level => {
    const card = document.createElement('div');
    card.className = 'segment-card';

    const title = document.createElement('div');
    title.className = 'segment-title';
    title.textContent = `Level ${level.level}`;
    card.appendChild(title);

    const groupsHeader = document.createElement('div');
    groupsHeader.className = 'carta-entity-subheader';
    groupsHeader.textContent = `Hypernym groups generated (${level.hypernym_groups.length})`;
    card.appendChild(groupsHeader);

    const groupsList = document.createElement('ul');
    groupsList.className = 'carta-entity-evidence-list';
    level.hypernym_groups.forEach(g => {
      const li = document.createElement('li');
      li.textContent = `${g.types.join(', ')} → ${g.hypernym}`;
      groupsList.appendChild(li);
    });
    card.appendChild(groupsList);

    const dedupHeader = document.createElement('div');
    dedupHeader.className = 'carta-entity-subheader';
    dedupHeader.textContent = `Deduplicated hypernyms (${level.deduped_hypernyms.length})`;
    card.appendChild(dedupHeader);

    const dedupList = document.createElement('div');
    dedupList.className = 'carta-entity-list';
    level.deduped_hypernyms.forEach(d => {
      const row = document.createElement('div');
      row.className = 'carta-entity';

      const nameRow = document.createElement('div');
      nameRow.className = 'carta-entity-name-row';
      const name = document.createElement('span');
      name.className = 'carta-entity-name';
      name.textContent = d.canonical_label;
      nameRow.appendChild(name);
      if (d.members.length > 1) {
        const badge = document.createElement('span');
        badge.className = 'chip keyphrase';
        badge.textContent = `merged from ${d.members.length}`;
        nameRow.appendChild(badge);
      }
      row.appendChild(nameRow);

      if (d.members.length > 1) {
        const membersEl = document.createElement('div');
        membersEl.className = 'carta-entity-description';
        membersEl.textContent = `Members: ${d.members.join(', ')}`;
        row.appendChild(membersEl);
      }

      dedupList.appendChild(row);
    });
    card.appendChild(dedupList);

    section.appendChild(card);
  });

  const relations = result.schema_relations || [];
  const relationsCard = document.createElement('div');
  relationsCard.className = 'segment-card';
  const relationsHeader = document.createElement('div');
  relationsHeader.className = 'carta-entity-header';
  relationsHeader.textContent = `"is type of" edges across the whole taxonomy (${relations.length})`;
  relationsCard.appendChild(relationsHeader);
  const relationsList = document.createElement('ul');
  relationsList.className = 'carta-entity-evidence-list';
  relations.forEach(r => {
    const li = document.createElement('li');
    li.textContent = `${r.subject} → ${r.predicate} → ${r.object}`;
    relationsList.appendChild(li);
  });
  relationsCard.appendChild(relationsList);
  section.appendChild(relationsCard);

  container.appendChild(section);
}

// --- Knowledge graph: entity relations ---
// Real (LLM-extracted): each segment's "relations" field (see
// backend/segmentation/llm.py's enrichment prompt, exported per-segment in
// schema.py) is a list of {subject, predicate, object} triples the model
// found asserted in that segment's text. There's no local fallback for this
// (see labeling.KeyphraseLabeler) - without an LLM key, relations is always
// [] and the graph renders empty for that source. This aggregates every
// segment's triples into one entity/predicate graph per source: nodes are
// unique entities (deduped by lowercased text), edges are predicate-labeled
// directed relations, laid out with a self-contained force-directed
// simulation (no charting library in this codebase).

function aggregateRelations(segments) {
  const triples = new Map(); // `${subj}|${pred}|${obj}` (lowercased) -> { subject, predicate, object, segmentLabels: Set }

  segments.forEach(seg => {
    (seg.relations || []).forEach(rel => {
      const subject = (rel.subject || '').trim();
      const predicate = (rel.predicate || '').trim();
      const object = (rel.object || '').trim();
      if (!subject || !predicate || !object || subject.toLowerCase() === object.toLowerCase()) return;

      const key = `${subject.toLowerCase()}|${predicate.toLowerCase()}|${object.toLowerCase()}`;
      if (!triples.has(key)) {
        triples.set(key, { subject, predicate, object, segmentLabels: new Set() });
      }
      triples.get(key).segmentLabels.add(seg.topic_label || 'Untitled segment');
    });
  });

  return Array.from(triples.values());
}

function buildEntityGraph(triples) {
  const nodeIndex = new Map(); // lowercased entity text -> node index
  const nodes = [];

  function nodeFor(text) {
    const key = text.toLowerCase();
    if (!nodeIndex.has(key)) {
      nodeIndex.set(key, nodes.length);
      nodes.push({ label: text, index: nodes.length });
    }
    return nodeIndex.get(key);
  }

  const edges = triples.map(t => ({
    source: nodeFor(t.subject),
    target: nodeFor(t.object),
    predicate: t.predicate,
    segmentLabels: Array.from(t.segmentLabels),
  }));

  return { nodes, edges };
}

// Fruchterman-Reingold force-directed layout: nodes repel each other,
// connected nodes are pulled together along a spring, with a cooling
// schedule so positions settle instead of oscillating. width/height are in
// the same coordinate units as the final render (see aspect-matching in
// renderEntityGraph) so the simulated layout isn't stretched when displayed.
function layoutForceGraph(nodes, edges, width, height, iterations) {
  const n = nodes.length;
  nodes.forEach((node, i) => {
    const angle = (i / Math.max(n, 1)) * 2 * Math.PI;
    node.x = width / 2 + Math.cos(angle) * Math.min(width, height) * 0.35;
    node.y = height / 2 + Math.sin(angle) * Math.min(width, height) * 0.35;
  });

  const k = Math.sqrt((width * height) / Math.max(n, 1));

  for (let iter = 0; iter < iterations; iter++) {
    const dispX = new Array(n).fill(0);
    const dispY = new Array(n).fill(0);

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = nodes[i].x - nodes[j].x;
        const dy = nodes[i].y - nodes[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const force = (k * k) / dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        dispX[i] += fx; dispY[i] += fy;
        dispX[j] -= fx; dispY[j] -= fy;
      }
    }

    edges.forEach(edge => {
      const i = edge.source, j = edge.target;
      const dx = nodes[i].x - nodes[j].x;
      const dy = nodes[i].y - nodes[j].y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const force = (dist * dist) / k;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      dispX[i] -= fx; dispY[i] -= fy;
      dispX[j] += fx; dispY[j] += fy;
    });

    const temp = Math.min(width, height) * 0.1 * (1 - iter / iterations);
    for (let i = 0; i < n; i++) {
      const dlen = Math.sqrt(dispX[i] * dispX[i] + dispY[i] * dispY[i]) || 0.01;
      nodes[i].x += (dispX[i] / dlen) * Math.min(dlen, temp);
      nodes[i].y += (dispY[i] / dlen) * Math.min(dlen, temp);
      nodes[i].x = Math.min(width - 6, Math.max(6, nodes[i].x));
      nodes[i].y = Math.min(height - 6, Math.max(6, nodes[i].y));
    }
  }
}

function edgePairKey(edge) {
  return edge.source < edge.target ? `${edge.source}-${edge.target}` : `${edge.target}-${edge.source}`;
}

function renderRelationPanelForNode(panelEl, node, edges) {
  panelEl.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'graph-panel-title';
  title.textContent = node.label;
  panelEl.appendChild(title);

  const related = edges.filter(e => e.source === node.index || e.target === node.index);
  const subtitle = document.createElement('div');
  subtitle.className = 'graph-panel-subtitle';
  subtitle.textContent = `Entity — ${related.length} relation${related.length === 1 ? '' : 's'}`;
  panelEl.appendChild(subtitle);

  const ul = document.createElement('ul');
  related.forEach(e => {
    const li = document.createElement('li');
    li.textContent = e.source === node.index
      ? `${node.label} → ${e.predicate} → ${e.targetNode.label}`
      : `${e.sourceNode.label} → ${e.predicate} → ${node.label}`;
    ul.appendChild(li);
  });
  panelEl.appendChild(ul);
}

function renderRelationPanelForEdge(panelEl, edge) {
  panelEl.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'graph-panel-title';
  title.textContent = `${edge.sourceNode.label} → ${edge.predicate} → ${edge.targetNode.label}`;
  panelEl.appendChild(title);

  const subtitle = document.createElement('div');
  subtitle.className = 'graph-panel-subtitle';
  subtitle.textContent = 'Relation';
  panelEl.appendChild(subtitle);

  const ul = document.createElement('ul');
  edge.segmentLabels.forEach(segLabel => {
    const li = document.createElement('li');
    li.textContent = `Asserted in segment: ${segLabel}`;
    ul.appendChild(li);
  });
  panelEl.appendChild(ul);
}

function renderEntityGraph(container, sourceLabel, segments) {
  const section = document.createElement('div');
  section.className = 'graph-section';

  const triples = aggregateRelations(segments);

  const label = document.createElement('div');
  label.className = 'section-label';
  label.textContent = `Knowledge graph for "${sourceLabel}" — ${triples.length} relation${triples.length === 1 ? '' : 's'} extracted between entities`;
  section.appendChild(label);

  if (triples.length === 0) {
    const note = document.createElement('div');
    note.className = 'graph-empty-note';
    note.textContent = 'No relations extracted for this source (requires an LLM API key configured in backend/.env - there is no local fallback for relation extraction).';
    section.appendChild(note);
    container.appendChild(section);
    return;
  }

  const { nodes, edges } = buildEntityGraph(triples);
  edges.forEach(e => { e.sourceNode = nodes[e.source]; e.targetNode = nodes[e.target]; });

  // Keep the simulation area roughly square-ish (fixed aspect) rather than
  // matching the very wide, short scroll box directly - an elongated
  // simulation space (e.g. 8:1) starves vertical spread and collapses every
  // node into a single cramped row. Both dimensions grow with node count so
  // larger graphs get proportionally more room without changing the aspect.
  const ASPECT = 1.8;
  const area = Math.max(560 * 300, nodes.length * 9000);
  const wrapPxHeight = Math.max(260, Math.sqrt(area / ASPECT));
  const wrapPxWidth = Math.max(560, wrapPxHeight * ASPECT);
  const HEIGHT = 100;
  const WIDTH = HEIGHT * ASPECT;
  layoutForceGraph(nodes, edges, WIDTH, HEIGHT, 300);

  // Parallel edges between the same pair of nodes get offset control points
  // so they render as distinguishable curves instead of overlapping lines.
  const pairCounts = new Map();
  edges.forEach(edge => {
    const key = edgePairKey(edge);
    edge._pairIndex = pairCounts.get(key) || 0;
    pairCounts.set(key, edge._pairIndex + 1);
  });
  edges.forEach(edge => { edge._pairTotal = pairCounts.get(edgePairKey(edge)); });

  const scroll = document.createElement('div');
  scroll.className = 'graph-scroll';

  const wrap = document.createElement('div');
  wrap.className = 'graph-wrap';
  wrap.style.minWidth = `${wrapPxWidth}px`;
  wrap.style.height = `${wrapPxHeight}px`;

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${WIDTH} ${HEIGHT}`);

  const defs = document.createElementNS(svgNS, 'defs');
  const marker = document.createElementNS(svgNS, 'marker');
  marker.setAttribute('id', 'graph-arrow');
  marker.setAttribute('viewBox', '0 0 10 10');
  marker.setAttribute('refX', '9');
  marker.setAttribute('refY', '5');
  marker.setAttribute('markerWidth', '5');
  marker.setAttribute('markerHeight', '5');
  marker.setAttribute('orient', 'auto-start-reverse');
  const arrowPath = document.createElementNS(svgNS, 'path');
  arrowPath.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
  arrowPath.setAttribute('class', 'graph-arrowhead');
  marker.appendChild(arrowPath);
  defs.appendChild(marker);
  svg.appendChild(defs);

  const panel = document.createElement('div');
  panel.className = 'graph-panel';

  function clearActive() {
    wrap.querySelectorAll('.graph-node.active, .graph-edge-relation.active').forEach(el => el.classList.remove('active'));
  }

  const edgeLabelEls = [];

  edges.forEach(edge => {
    const offset = (edge._pairIndex - (edge._pairTotal - 1) / 2) * (WIDTH * 0.05);
    const mx = (edge.sourceNode.x + edge.targetNode.x) / 2;
    const my = (edge.sourceNode.y + edge.targetNode.y) / 2;
    const dx = edge.targetNode.x - edge.sourceNode.x;
    const dy = edge.targetNode.y - edge.sourceNode.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const nx = -dy / dist, ny = dx / dist;
    const ctrlX = mx + nx * offset;
    const ctrlY = my + ny * offset;
    const d = `M ${edge.sourceNode.x} ${edge.sourceNode.y} Q ${ctrlX} ${ctrlY} ${edge.targetNode.x} ${edge.targetNode.y}`;

    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', 'graph-edge-relation');
    path.setAttribute('marker-end', 'url(#graph-arrow)');
    svg.appendChild(path);

    const hitPath = document.createElementNS(svgNS, 'path'); // wider invisible stroke, easier to click than the thin visible line
    hitPath.setAttribute('d', d);
    hitPath.setAttribute('class', 'graph-edge-hit');
    const selectEdge = () => {
      clearActive();
      path.classList.add('active');
      renderRelationPanelForEdge(panel, edge);
    };
    hitPath.addEventListener('click', selectEdge);
    svg.appendChild(hitPath);

    const labelX = 0.25 * edge.sourceNode.x + 0.5 * ctrlX + 0.25 * edge.targetNode.x;
    const labelY = 0.25 * edge.sourceNode.y + 0.5 * ctrlY + 0.25 * edge.targetNode.y;
    const labelEl = document.createElement('span');
    labelEl.className = 'graph-edge-label';
    labelEl.textContent = edge.predicate;
    labelEl.style.left = `${(labelX / WIDTH) * 100}%`;
    labelEl.style.top = `${(labelY / HEIGHT) * 100}%`;
    labelEl.addEventListener('click', selectEdge);
    edgeLabelEls.push(labelEl);
  });

  wrap.appendChild(svg);
  edgeLabelEls.forEach(el => wrap.appendChild(el));

  nodes.forEach(node => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'graph-node graph-node-entity';
    btn.textContent = node.label;
    btn.title = node.label;
    btn.style.left = `${(node.x / WIDTH) * 100}%`;
    btn.style.top = `${(node.y / HEIGHT) * 100}%`;
    btn.addEventListener('click', () => {
      clearActive();
      btn.classList.add('active');
      renderRelationPanelForNode(panel, node, edges);
    });
    wrap.appendChild(btn);
  });

  scroll.appendChild(wrap);
  section.appendChild(scroll);
  section.appendChild(panel);
  container.appendChild(section);

  renderRelationPanelForNode(panel, nodes[0], edges);
}

function buildEntityGraphs(container, results) {
  results.forEach(result => {
    renderEntityGraph(container, result.label, result.segmentation.segments || []);
  });
}

// --- Slide image payload prep for the feedback module (feedback.html) ---
// Downscales each slide snapshot via canvas before base64-encoding, since
// sending a full deck of full-resolution PNGs to a vision LLM would bloat
// the request/cost with no benefit to feedback quality.

const FEEDBACK_IMAGE_MAX_WIDTH = 640;

function imageToDataUrl(src, maxWidth) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.72));
    };
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}

function prepareSlidePayload(slideData, maxWidth) {
  return Promise.all(
    slideData.map(slide =>
      imageToDataUrl(slide.snapshot_image, maxWidth || FEEDBACK_IMAGE_MAX_WIDTH).then(dataUrl => ({
        slide_index: slide.slide_index,
        start_time: slide.start_time,
        end_time: slide.end_time,
        transcript: slide.transcript || '',
        image: dataUrl
      }))
    )
  );
}

// --- Feedback module (also real, like fetchSegments above): calls the same
// local Python backend (backend/server.py), which forwards the transcript +
// slide images to a vision-capable LLM role-playing as the chosen audience.

const FEEDBACK_API_URL = 'http://127.0.0.1:8000/feedback';

function fetchFeedback(audience, prompt, slidePayload) {
  return fetch(FEEDBACK_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audience, prompt, slides: slidePayload })
  })
    .then(res => {
      if (!res.ok) {
        return res.json()
          .catch(() => ({}))
          .then(body => { throw new Error(body.error || `server responded with ${res.status}`); });
      }
      return res.json();
    })
    .then(data => data.feedback)
    .catch(err => {
      throw new Error(
        `Could not reach the feedback server at ${FEEDBACK_API_URL} (${err.message}). ` +
        `Start it with: python backend/server.py`
      );
    });
}

function renderFeedbackResult(container, audience, feedbackText) {
  container.innerHTML = '';

  const card = document.createElement('div');
  card.className = 'feedback-response-card';

  const header = document.createElement('div');
  header.className = 'feedback-response-header';
  header.textContent = `Feedback from: ${audience}`;
  card.appendChild(header);

  const body = document.createElement('div');
  body.className = 'feedback-response-text';
  body.textContent = feedbackText;
  card.appendChild(body);

  container.appendChild(card);
}

// --- Input readers ---

if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

function isPdfFile(file) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

function readPdfFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const typedArray = new Uint8Array(reader.result);
      pdfjsLib.getDocument({ data: typedArray }).promise
        .then(pdf => {
          const pageNumbers = Array.from({ length: pdf.numPages }, (_, i) => i + 1);
          return pageNumbers.reduce(
            (chain, pageNum) => chain.then(pagesText =>
              pdf.getPage(pageNum)
                .then(page => page.getTextContent())
                .then(content => {
                  const pageText = content.items.map(item => item.str).join(' ');
                  return pagesText + (pagesText ? '\n\n' : '') + pageText;
                })
            ),
            Promise.resolve('')
          );
        })
        .then(text => resolve({ label: file.name, text }))
        .catch(err => reject(new Error(`Failed to extract text from ${file.name}: ${err.message}`)));
    };
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}.`));
    reader.readAsArrayBuffer(file);
  });
}

function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ label: file.name, text: String(reader.result || '') });
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}.`));
    reader.readAsText(file);
  });
}

function readFile(file) {
  return isPdfFile(file) ? readPdfFile(file) : readTextFile(file);
}

function fetchWikipediaUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (e) {
    return Promise.reject(new Error('Please enter a valid URL.'));
  }

  if (!/(^|\.)wikipedia\.org$/.test(url.hostname)) {
    return Promise.reject(new Error('Only Wikipedia URLs are supported right now.'));
  }

  const title = decodeURIComponent(url.pathname.replace(/^\/wiki\//, ''));
  if (!title) {
    return Promise.reject(new Error('Could not find a page title in that URL.'));
  }

  const apiUrl = `https://${url.hostname}/w/api.php?action=query&prop=extracts&explaintext=1&titles=${encodeURIComponent(title)}&format=json&origin=*`;

  return fetch(apiUrl)
    .then(res => res.json())
    .then(data => {
      const pages = data.query && data.query.pages;
      const page = pages && Object.values(pages)[0];
      if (!page || page.missing !== undefined || !page.extract) {
        throw new Error('Page not found.');
      }
      return { label: page.title, text: page.extract };
    })
    .catch(err => {
      throw new Error(`Failed to fetch that page: ${err.message}`);
    });
}
