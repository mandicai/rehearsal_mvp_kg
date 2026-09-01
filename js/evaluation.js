// evaluation.html — generate a MATRIX of shot examples for one selected act
// and its narration. The act-wide mode sweep maps several shot plans per mode;
// the legacy documentary technique × mode × track matrix remains available.
// Both paths reuse the
// same backend prompt construction storyboard.html uses. Standalone: depends
// only on js/helpers.js (fetchCatalogs / fetchEvalRun / fetchEvalStatus) plus
// the paper+moodboard+arc it inherits from the shared localStorage session.

const EVAL_SESSION_KEY = 'paperExtractDebugSession';
const EVAL_RUN_KEY = 'evaluationLastRun';

// --- Inherited session state ---
let paperLabel = '';
let paperAbstract = '';
let sessionSections = [];      // [{index, title, text, removed}]
let arcParts = [];             // [{key, label, description}]
let assignments = {};          // section.index -> arc-part key
let moodboardProfiles = [];    // generation-ready profiles
let projectId = '';

// --- Catalog + selection state ---
let allTechniques = [];        // [{key,label}]
let allModes = [];             // [{key,label}]
const selTech = new Set();
const selMode = new Set();
const selEntity = new Set();

// Read from the inherited Act Board rather than the arc part: the recorded
// narration and the phrases marked filmable in it live on the narration nodes.
let actBoardNodes = {};        // actKey -> nodes
let moodboardTechniques = [];  // technique keys distilled from the moodboard
let actEntities = [];          // [{text, query, bucket}] for the selected act
let recordedNarration = '';

let pollTimer = null;

// ---------------------------------------------------------------------------

function $(id) { return document.getElementById(id); }

function inheritSession() {
  let session = null;
  try { session = JSON.parse(localStorage.getItem(EVAL_SESSION_KEY) || 'null'); } catch (e) { session = null; }
  if (!session) return false;

  paperLabel = session.currentLabel || '';
  sessionSections = (session.currentSections || []).filter(s => s && !s.removed);
  const abstractSection = sessionSections.find(s => /\babstract\b/i.test(s.title || ''));
  paperAbstract = abstractSection ? (abstractSection.text || '') : '';
  arcParts = session.currentArcSections || [];
  assignments = session.currentAssignments || {};
  projectId = session.premiereProjectId || '';
  actBoardNodes = session.actBoardNodes || {};
  // The technique rows sweep what the moodboard distilled, not the whole catalog.
  moodboardTechniques = (session.lastDistillResult?.suggested_techniques
    || session.selectedTechniques || []).filter(t => typeof t === 'string');

  moodboardProfiles = (session.moodboardReferences || [])
    .filter(r => r && r.state === 'ready' && r.profile)
    .map(r => ({
      title: r.profile.title,
      visual_style: r.profile.visual_style,
      tone: r.profile.tone,
      pacing: r.profile.pacing,
      observed_techniques: r.profile.observed_techniques,
    }));

  return arcParts.length > 0 && sessionSections.length > 0;
}

function renderSetupSummary() {
  const el = $('eval-setup-summary');
  const moodTitle = moodboardProfiles[0] ? moodboardProfiles[0].title : '(none)';
  const arcName = (arcParts || []).map(p => p.label).join(' → ');
  el.innerHTML = '';
  const rows = [
    ['Paper', paperLabel || '(untitled)'],
    ['Abstract', paperAbstract ? paperAbstract.slice(0, 160) + (paperAbstract.length > 160 ? '…' : '') : '(none found)'],
    ['Moodboard reference', moodTitle],
    ['Arc', arcName || '(none)'],
  ];
  rows.forEach(([k, v]) => {
    const row = document.createElement('div');
    row.className = 'eval-summary-row';
    row.innerHTML = `<span class="eval-summary-key">${k}</span><span class="eval-summary-val"></span>`;
    row.querySelector('.eval-summary-val').textContent = v;
    el.appendChild(row);
  });
}

function showMissing() {
  const el = $('eval-setup-missing');
  el.style.display = '';
  el.classList.add('error');
  el.innerHTML = 'No paper + moodboard + accepted arc found in your last session. ' +
    'Set one up in the <a href="/html/index.html">main app</a> (upload a paper, add a moodboard ' +
    'reference, accept an arc on the <a href="/html/storyboard.html">storyboard</a>), then reload this page.';
}

// --- Scene picker -----------------------------------------------------------

function actTitleFor(part, idx) { return `Act ${idx + 1}: ${part.label}`; }

function notesForAct(actKey) {
  return sessionSections
    .filter(s => assignments[s.index] === actKey)
    .map(s => s.text)
    .filter(Boolean)
    .join('\n\n');
}

function populateScenePicker() {
  const sel = $('eval-scene-act');
  sel.innerHTML = '';
  arcParts.forEach((part, idx) => {
    const opt = document.createElement('option');
    opt.value = String(idx);
    opt.textContent = actTitleFor(part, idx);
    sel.appendChild(opt);
  });
  sel.addEventListener('change', () => fillSceneFields(parseInt(sel.value, 10) || 0));
  fillSceneFields(0);
}

function fillSceneFields(idx) {
  const part = arcParts[idx];
  if (!part) return;
  $('eval-scene-title').value = part.label || 'Scene';
  $('eval-scene-narration').value = part.description || '';
  $('eval-scene-notes').value = notesForAct(part.key);
  loadActNarrationAndEntities(part.key);
}

function loadActNarrationAndEntities(actKey) {
  const narrations = (actBoardNodes[actKey] || []).filter(node =>
    node && node.type === 'narration' && String(node.transcript || '').trim());
  recordedNarration = narrations.map(node => String(node.transcript).trim()).join('\n\n');

  const seen = new Set();
  actEntities = [];
  narrations.forEach(node => {
    (node.narrationSpans || []).forEach(span => {
      const text = String(span?.text || '').trim();
      // 'ignore' is the classifier saying the phrase would not help pick a shot;
      // 'pending' has not been classified yet.
      if (!text || span.bucket === 'ignore' || span.bucket === 'pending') return;
      const key = text.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      actEntities.push({
        text,
        query: String(span.query || span.visual_proxy || text).trim(),
        bucket: span.bucket || '',
      });
    });
  });

  selEntity.clear();
  // Default to the first three, so a run stays bounded with no clicking.
  actEntities.slice(0, 3).forEach(entity => selEntity.add(entity.text));
  renderRecordedNarration();
  renderEntityList();
  updateEstimate();
}

function renderRecordedNarration() {
  const host = $('eval-recorded-narration');
  if (!host) return;
  host.textContent = '';
  if (!recordedNarration) {
    host.classList.add('eval-empty');
    host.textContent = 'No recorded narration for this act yet — record it in the storyboard to populate entities.';
    return;
  }
  host.classList.remove('eval-empty');
  // Mark each highlighted phrase inside the transcript, so the entity list below
  // reads as a selection out of the recording rather than a detached list.
  const marks = actEntities
    .map(entity => ({ entity, at: recordedNarration.toLowerCase().indexOf(entity.text.toLowerCase()) }))
    .filter(item => item.at >= 0)
    .sort((a, b) => a.at - b.at);
  let cursor = 0;
  marks.forEach(({ entity, at }) => {
    if (at < cursor) return;
    host.appendChild(document.createTextNode(recordedNarration.slice(cursor, at)));
    const mark = document.createElement('mark');
    mark.className = 'eval-entity-mark';
    mark.textContent = recordedNarration.slice(at, at + entity.text.length);
    host.appendChild(mark);
    cursor = at + entity.text.length;
  });
  host.appendChild(document.createTextNode(recordedNarration.slice(cursor)));
}

function renderEntityList() {
  const host = $('eval-entity-list');
  if (!host) return;
  if (!actEntities.length) {
    host.innerHTML = '<span class="eval-empty">No highlighted entities — visualize the narration first.</span>';
    return;
  }
  buildChecklist(host, actEntities.map(entity => ({
    key: entity.text,
    label: entity.bucket && entity.bucket !== 'depictable'
      ? `${entity.text} (${entity.bucket})` : entity.text,
  })), selEntity, () => { renderRecordedNarration(); updateEstimate(); });
}

function entityMatrixEnabled() {
  return Boolean($('eval-entity-matrix') && $('eval-entity-matrix').checked);
}

function selectedEntities() {
  return actEntities.filter(entity => selEntity.has(entity.text))
    .map(entity => ({ text: entity.text, query: entity.query }));
}

function currentScenePayload() {
  const idx = parseInt($('eval-scene-act').value, 10) || 0;
  const part = arcParts[idx];
  return {
    title: $('eval-scene-title').value.trim(),
    narration: $('eval-scene-narration').value.trim(),
    scene_notes: $('eval-scene-notes').value.trim(),
    act_title: part ? actTitleFor(part, idx) : '',
    abstract: paperAbstract,
  };
}

// --- Axis selectors ---------------------------------------------------------

function buildChecklist(hostEl, items, selSet, onToggle) {
  hostEl.innerHTML = '';
  items.forEach(it => {
    const label = document.createElement('label');
    label.className = 'eval-check';
    label.dataset.key = it.key;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selSet.has(it.key);
    cb.addEventListener('change', () => {
      if (cb.checked) selSet.add(it.key); else selSet.delete(it.key);
      onToggle();
    });
    const span = document.createElement('span');
    span.textContent = it.label;
    label.appendChild(cb);
    label.appendChild(span);
    hostEl.appendChild(label);
  });
}

function renderAxes() {
  // The technique rows are meant to sweep what the moodboard distilled, so
  // start from that set instead of an empty (or whole-catalog) selection.
  if (!selTech.size) {
    moodboardTechniques
      .filter(key => allTechniques.some(item => item.key === key))
      .forEach(key => selTech.add(key));
    // A distilled key the catalog no longer carries would otherwise leave the
    // technique axis empty and the run un-startable.
    if (!selTech.size) allTechniques.slice(0, 3).forEach(item => selTech.add(item.key));
  }
  buildChecklist($('eval-tech-list'), allTechniques, selTech, updateEstimate);
  buildChecklist($('eval-mode-list'), allModes, selMode, updateEstimate);
  updateEstimate();
}

function actSweepEnabled() {
  return Boolean($('eval-act-sweep')?.checked);
}

// Two images per cell and one 3-clip camera set per entity x mode, so the
// entity matrix is costed differently from the legacy sweeps.
const EVAL_IMAGES_PER_CELL = 2;
const EVAL_CAMERA_VARIANTS = 3;
const EVAL_MAX_ENTITY_IMAGES = 48;

function updateEstimate() {
  const est = $('eval-run-estimate');
  const runBtn = $('eval-run-btn');
  const video = $('eval-video-toggle').checked;

  if (entityMatrixEnabled()) {
    const cells = selEntity.size * selMode.size * selTech.size;
    const images = cells * EVAL_IMAGES_PER_CELL;
    const clips = video ? selEntity.size * selMode.size * EVAL_CAMERA_VARIANTS : 0;
    if (!cells) {
      est.textContent = 'Select at least one entity, one mode, and one scene technique.';
      est.classList.remove('error');
      runBtn.disabled = true;
      return;
    }
    const mins = Math.max(1, Math.round((images * 15 + clips * 60) / 60));
    const over = images > EVAL_MAX_ENTITY_IMAGES;
    est.textContent = `${cells} cell${cells === 1 ? '' : 's'} · ${images} images`
      + (clips ? ` · ${clips} clips` : '') + ` · ~${mins} min`
      + (over ? ` — too many (max ${EVAL_MAX_ENTITY_IMAGES} images), narrow the axes` : '');
    est.classList.toggle('error', over);
    runBtn.disabled = over;
    return;
  }

  // With the Track axis retired, anything that is not the entity matrix is the
  // act-wide mode sweep.
  const n = selMode.size * 3;
  const perCell = video ? 65 : 15; // rough seconds/cell
  const secs = n * perCell;
  const mins = Math.max(1, Math.round(secs / 60));
  if (!n) {
    est.textContent = 'Select at least one documentary mode.';
    est.classList.remove('error');
    runBtn.disabled = true;
    return;
  }
  const over = n > 24;
  est.textContent =
    `${n} shot plan${n === 1 ? '' : 's'} · ~${mins} min${over ? ' — too many (max 24), narrow the modes' : ''}`;
  est.classList.toggle('error', over);
  runBtn.disabled = over;
}

function wireTechFilter() {
  const filter = $('eval-tech-filter');
  filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    $('eval-tech-list').querySelectorAll('.eval-check').forEach(el => {
      el.style.display = el.dataset.key.toLowerCase().includes(q) ? '' : 'none';
    });
  });
  $('eval-tech-none').addEventListener('click', () => {
    selTech.clear();
    $('eval-tech-list').querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
    updateEstimate();
  });
}

// --- Run + poll -------------------------------------------------------------

function runMatrix() {
  const scene = currentScenePayload();
  const payload = {
    ...(projectId ? { project_id: projectId } : {}),
    scene,
    moodboard: moodboardProfiles,
    techniques: Array.from(selTech),
    modes: Array.from(selMode),
    video: $('eval-video-toggle').checked,
    entity_matrix: entityMatrixEnabled(),
    entities: selectedEntities(),
    act_sweep: !entityMatrixEnabled(),
    wildness: parseFloat($('eval-wildness').value) || 0,
  };
  const statusEl = $('eval-run-status');
  statusEl.classList.remove('error');
  statusEl.textContent = 'Starting matrix…';
  $('eval-run-btn').disabled = true;

  fetchEvalRun(payload)
    .then(({ project_id, run_id }) => {
      projectId = project_id;
      localStorage.setItem(EVAL_RUN_KEY, JSON.stringify({ projectId, runId: run_id }));
      pollRun(run_id);
    })
    .catch(err => {
      statusEl.textContent = err.message;
      statusEl.classList.add('error');
      $('eval-run-btn').disabled = false;
      updateEstimate();
    });
}

function pollRun(runId) {
  fetchEvalStatus(projectId, runId)
    .then(status => {
      const statusEl = $('eval-run-status');
      renderGrid(status.cells || [], status);
      if (status.state === 'ready') {
        const noun = actSweepEnabled() ? 'shot plan' : 'cell';
        statusEl.textContent = `Done — ${status.total} ${noun}${status.total === 1 ? '' : 's'}.`;
        $('eval-run-btn').disabled = false;
        updateEstimate();
      } else if (status.state === 'error' || status.state === 'unknown') {
        statusEl.textContent = status.message || 'Run failed.';
        statusEl.classList.add('error');
        $('eval-run-btn').disabled = false;
        updateEstimate();
      } else {
        statusEl.textContent = status.message || `Working… ${status.done || 0}/${status.total || '?'}`;
        pollTimer = setTimeout(() => pollRun(runId), 2500);
      }
    })
    .catch(() => { pollTimer = setTimeout(() => pollRun(runId), 4000); });
}

// --- Results grid (one block per mode; rows = technique, cols = role) --------

function renderGrid(cells, status = {}) {
  const grid = $('eval-grid');
  grid.innerHTML = '';
  if (!cells.length) return;

  if (status.matrix === 'entity' || cells.some(cell => Array.isArray(cell.images))) {
    renderEntityMatrix(grid, cells, status.video_sets || []);
    return;
  }

  if (cells.some(cell => cell.plan_index != null)) {
    renderActSweepGrid(grid, cells);
    return;
  }

  const modeLabel = k => (allModes.find(m => m.key === k) || {}).label || k;
  // Roles are no longer an axis in this UI, but a previously saved run can still
  // carry them, so take the columns from the cells themselves.
  const roles = [...new Set(cells.map(cell => cell.role).filter(Boolean))];
  const byMode = {};
  cells.forEach(c => { (byMode[c.mode] = byMode[c.mode] || []).push(c); });

  Object.keys(byMode).forEach(mode => {
    const modeCells = byMode[mode];
    const techniques = [...new Set(modeCells.map(c => c.technique))];
    const usedRoles = roles.filter(r => modeCells.some(c => c.role === r));

    const block = document.createElement('div');
    block.className = 'module-card eval-mode-block';
    const h = document.createElement('h2');
    h.textContent = modeLabel(mode);
    block.appendChild(h);

    const table = document.createElement('div');
    table.className = 'eval-matrix';
    table.style.gridTemplateColumns = `160px repeat(${usedRoles.length}, minmax(140px, 1fr))`;

    // header row
    table.appendChild(cornerCell(''));
    usedRoles.forEach(r => table.appendChild(headerCell(r)));

    techniques.forEach(tech => {
      table.appendChild(headerCell(tech, true));
      usedRoles.forEach(role => {
        const cell = modeCells.find(c => c.technique === tech && c.role === role);
        table.appendChild(cell ? matrixCell(cell) : cornerCell('·'));
      });
    });

    block.appendChild(table);
    grid.appendChild(block);
  });
}

// Entity matrix: one block per documentary mode. Columns are the highlighted
// entities, rows within a block are the moodboard's scene techniques, and each
// cell holds the two generated images with their own shot plan and timing. The
// camera-variation clips seeded from that mode's chosen image close each block.
function renderEntityMatrix(grid, cells, videoSets) {
  const modeLabel = key => (allModes.find(m => m.key === key) || {}).label || key;
  const techLabel = key => (allTechniques.find(t => t.key === key) || {}).label || key || 'No technique';
  // Preserve the order the run was built in rather than sorting, so the columns
  // match the entity checklist the presenter ticked.
  const entities = [...new Set(cells.map(cell => cell.entity))];
  const modes = [...new Set(cells.map(cell => cell.mode))];

  modes.forEach(mode => {
    const modeCells = cells.filter(cell => cell.mode === mode);
    const techniques = [...new Set(modeCells.map(cell => cell.technique))];

    const block = document.createElement('div');
    block.className = 'module-card eval-mode-block';
    const heading = document.createElement('h2');
    heading.textContent = modeLabel(mode);
    block.appendChild(heading);

    const table = document.createElement('div');
    table.className = 'eval-matrix eval-entity-matrix';
    table.style.gridTemplateColumns = `150px repeat(${entities.length}, minmax(280px, 1fr))`;
    table.appendChild(cornerCell('Technique ╲ Entity'));
    entities.forEach(entity => table.appendChild(headerCell(entity, false)));

    techniques.forEach(technique => {
      table.appendChild(headerCell(techLabel(technique), true));
      entities.forEach(entity => {
        const cell = modeCells.find(item => item.entity === entity && item.technique === technique);
        table.appendChild(entityCell(cell));
      });
    });

    // One camera-variation row per mode block, aligned to the same columns.
    const modeSets = (videoSets || []).filter(set => set.mode === mode);
    if (modeSets.length) {
      table.appendChild(headerCell('Camera variations', true));
      entities.forEach(entity => {
        table.appendChild(videoSetCell(modeSets.find(set => set.entity === entity)));
      });
    }
    block.appendChild(table);
    grid.appendChild(block);
  });
}

function entityCell(cell) {
  const host = document.createElement('div');
  host.className = 'eval-matrix-cell eval-entity-cell';
  if (!cell) {
    host.classList.add('eval-empty');
    host.textContent = '—';
    return host;
  }
  const pair = document.createElement('div');
  pair.className = 'eval-image-pair';
  (cell.images || []).forEach(image => pair.appendChild(imageWithPlan(cell, image)));
  host.appendChild(pair);
  return host;
}

// One generated image with the shot plan that produced it and how long it took.
function imageWithPlan(cell, image) {
  const wrap = document.createElement('div');
  wrap.className = 'eval-image-plan';
  if (image.image_url) {
    const img = document.createElement('img');
    img.src = image.image_url;
    img.alt = `${cell.entity} — ${cell.mode}`;
    img.loading = 'lazy';
    img.addEventListener('click', () => openCellModal({
      ...cell, ...image, technique: cell.technique, mode: cell.mode,
    }));
    wrap.appendChild(img);
  } else {
    const failed = document.createElement('div');
    failed.className = 'eval-empty eval-image-failed';
    failed.textContent = image.error || 'no image';
    wrap.appendChild(failed);
  }
  const plan = document.createElement('div');
  plan.className = 'eval-plan';
  [
    ['Shot', image.shot_size],
    ['Move', image.movement],
    ['Function', image.narrative_operation],
  ].forEach(([key, value]) => {
    if (!value) return;
    const row = document.createElement('div');
    row.innerHTML = `<span class="eval-plan-key">${key}</span> ${escapeHtml(String(value))}`;
    plan.appendChild(row);
  });
  if (image.visual_description) {
    const visual = document.createElement('div');
    visual.className = 'eval-plan-visual';
    visual.textContent = image.visual_description;
    plan.appendChild(visual);
  }
  const seconds = document.createElement('div');
  seconds.className = 'eval-timing';
  seconds.textContent = image.seconds != null ? `${image.seconds}s` : '';
  plan.appendChild(seconds);
  wrap.appendChild(plan);
  return wrap;
}

// The clips generated from this block's chosen image, one per camera technique.
function videoSetCell(set) {
  const host = document.createElement('div');
  host.className = 'eval-matrix-cell eval-video-set';
  if (!set || !(set.videos || []).length) {
    host.classList.add('eval-empty');
    host.textContent = '—';
    return host;
  }
  const seed = document.createElement('div');
  seed.className = 'eval-plan-key eval-video-seed';
  seed.textContent = `seeded from image ${Number(set.variant || 0) + 1}`;
  host.appendChild(seed);
  set.videos.forEach(video => {
    const wrap = document.createElement('div');
    wrap.className = 'eval-video-variant';
    if (video.video_url) {
      const el = document.createElement('video');
      el.src = video.video_url;
      el.controls = true;
      el.muted = true;
      el.playsInline = true;
      el.preload = 'metadata';
      wrap.appendChild(el);
    } else {
      const failed = document.createElement('div');
      failed.className = 'eval-empty eval-image-failed';
      failed.textContent = video.error || 'no video';
      wrap.appendChild(failed);
    }
    const meta = document.createElement('div');
    meta.className = 'eval-plan';
    meta.innerHTML =
      `<div><span class="eval-plan-key">Camera</span> ${escapeHtml(video.movement || '')}</div>`
      + `<div><span class="eval-plan-key">Function</span> ${escapeHtml(video.narrative_operation || '')}</div>`;
    if (video.direction) {
      const direction = document.createElement('div');
      direction.className = 'eval-plan-visual';
      direction.textContent = video.direction;
      meta.appendChild(direction);
    }
    const seconds = document.createElement('div');
    seconds.className = 'eval-timing';
    seconds.textContent = video.seconds != null ? `${video.seconds}s` : '';
    meta.appendChild(seconds);
    wrap.appendChild(meta);
    host.appendChild(wrap);
  });
  return host;
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value == null ? '' : value);
  return div.innerHTML;
}

function renderActSweepGrid(grid, cells) {
  const modeLabel = key => (allModes.find(mode => mode.key === key) || {}).label || key;
  const byMode = {};
  cells.forEach(cell => { (byMode[cell.mode] = byMode[cell.mode] || []).push(cell); });
  Object.keys(byMode).forEach(mode => {
    const block = document.createElement('div');
    block.className = 'module-card eval-mode-block eval-act-sweep-block';
    const heading = document.createElement('h2');
    heading.textContent = modeLabel(mode);
    block.appendChild(heading);
    const cards = document.createElement('div');
    cards.className = 'eval-sweep-grid';
    byMode[mode].sort((a, b) => (a.plan_index || 0) - (b.plan_index || 0));
    byMode[mode].forEach(cell => {
      const card = document.createElement('article');
      card.className = 'eval-sweep-card';
      const title = document.createElement('strong');
      title.textContent = `Shot plan ${cell.plan_index || ''}`.trim();
      card.appendChild(title);
      const technique = document.createElement('div');
      technique.className = 'eval-sweep-techniques';
      technique.textContent = `Techniques: ${cell.technique || 'None'}`;
      card.appendChild(technique);
      if (cell.image_url) {
        const image = document.createElement('img');
        image.src = cell.image_url;
        image.loading = 'lazy';
        image.alt = `${modeLabel(mode)} shot plan ${cell.plan_index || ''}`;
        card.appendChild(image);
      } else if (cell.error) {
        const error = document.createElement('div');
        error.className = 'eval-cell-error';
        error.textContent = '⚠';
        error.title = cell.error;
        card.appendChild(error);
      } else {
        const pending = document.createElement('div');
        pending.className = 'eval-cell-pending';
        pending.textContent = '…';
        card.appendChild(pending);
      }
      const motion = document.createElement('div');
      motion.className = 'eval-sweep-motion';
      motion.textContent = [cell.narrative_operation, cell.movement].filter(Boolean).join(' · ');
      card.appendChild(motion);
      if (cell.video_url) {
        const badge = document.createElement('span');
        badge.className = 'eval-cell-video-badge';
        badge.textContent = '▶ video';
        card.appendChild(badge);
      }
      card.addEventListener('click', () => openCellModal(cell));
      cards.appendChild(card);
    });
    block.appendChild(cards);
    grid.appendChild(block);
  });
}

function cornerCell(t) { const d = document.createElement('div'); d.className = 'eval-matrix-corner'; d.textContent = t; return d; }
function headerCell(t, row) {
  const d = document.createElement('div');
  d.className = row ? 'eval-matrix-rowhead' : 'eval-matrix-colhead';
  d.textContent = t;
  d.title = t;
  return d;
}

function matrixCell(cell) {
  const d = document.createElement('div');
  d.className = 'eval-matrix-cell';
  if (cell.error) {
    d.classList.add('eval-cell-error');
    d.textContent = '⚠';
    d.title = cell.error;
    return d;
  }
  if (cell.image_url) {
    const img = document.createElement('img');
    img.src = cell.image_url;
    img.loading = 'lazy';
    img.alt = `${cell.technique} · ${cell.role}`;
    d.appendChild(img);
  } else {
    d.classList.add('eval-cell-pending');
    d.textContent = '…';
  }
  if (cell.video_url) {
    const badge = document.createElement('span');
    badge.className = 'eval-cell-video-badge';
    badge.textContent = '▶';
    d.appendChild(badge);
  }
  d.addEventListener('click', () => openCellModal(cell));
  return d;
}

// --- Cell detail modal ------------------------------------------------------

function openCellModal(cell) {
  const modal = $('eval-cell-modal');
  const body = $('eval-cell-modal-body');
  body.innerHTML = '';

  const close = document.createElement('button');
  close.className = 'btn-secondary eval-modal-close';
  close.textContent = 'Close ✕';
  close.addEventListener('click', hideCellModal);
  body.appendChild(close);

  const head = document.createElement('div');
  head.className = 'eval-modal-head';
  const modeLabel = (allModes.find(m => m.key === cell.mode) || {}).label || cell.mode;
  head.textContent = cell.plan_index != null
    ? `Shot plan ${cell.plan_index} · ${modeLabel}`
    : `${cell.technique} · ${modeLabel} · ${cell.role}`;
  body.appendChild(head);

  if (cell.image_url) {
    const img = document.createElement('img');
    img.src = cell.image_url;
    img.className = 'eval-modal-media';
    body.appendChild(img);
  }
  if (cell.video_url) {
    const vid = document.createElement('video');
    vid.src = cell.video_url;
    vid.controls = true;
    vid.loop = true;
    vid.className = 'eval-modal-media';
    body.appendChild(vid);
  }

  const meta = document.createElement('div');
  meta.className = 'eval-modal-meta';
  const parts = [
    ['Techniques', Array.isArray(cell.techniques) ? cell.techniques.join(', ') : ''],
    ['Narrative operation', cell.narrative_operation],
    ['Shot size', cell.shot_size],
    ['Movement', cell.movement],
    ['Scene description', cell.scene_description],
    ['Image prompt', cell.prompt],
  ];
  parts.forEach(([k, v]) => {
    if (!v) return;
    const row = document.createElement('div');
    row.innerHTML = `<strong>${k}:</strong> `;
    row.appendChild(document.createTextNode(v));
    meta.appendChild(row);
  });
  body.appendChild(meta);

  modal.style.display = '';
}

function hideCellModal() { $('eval-cell-modal').style.display = 'none'; }

// --- Boot -------------------------------------------------------------------

function init() {
  if (!inheritSession()) {
    renderSetupSummary();
    showMissing();
    return;
  }
  renderSetupSummary();
  $('eval-scene-module').style.display = '';
  $('eval-axes-module').style.display = '';
  populateScenePicker();
  wireTechFilter();
  $('eval-video-toggle').addEventListener('change', updateEstimate);
  // The three run shapes are alternatives, not layers: entity matrix wins over
  // the act sweep, which wins over the legacy technique x mode x track grid.
  $('eval-entity-matrix').addEventListener('change', () => {
    if ($('eval-entity-matrix').checked) $('eval-act-sweep').checked = false;
    updateEstimate();
  });
  $('eval-act-sweep').addEventListener('change', () => {
    if ($('eval-act-sweep').checked) $('eval-entity-matrix').checked = false;
    updateEstimate();
  });
  const wild = $('eval-wildness');
  wild.addEventListener('input', () => { $('eval-wildness-val').textContent = parseFloat(wild.value).toFixed(1); });
  $('eval-run-btn').addEventListener('click', runMatrix);
  $('eval-cell-modal').querySelector('.eval-modal-backdrop').addEventListener('click', hideCellModal);

  fetchCatalogs()
    .then(({ modes, techniques }) => {
      allModes = modes || [];
      allTechniques = techniques || [];
      // The act-wide sweep defaults to all documentary modes. The technique
      // checklist supplies the pool from which each shot plan receives a
      // stable random subset.
      // renderAxes seeds the technique axis from the moodboard distillation.
      allModes.forEach(mode => selMode.add(mode.key));
      renderAxes();
    })
    .catch(err => {
      $('eval-run-status').textContent = err.message;
      $('eval-run-status').classList.add('error');
    });
}

init();
