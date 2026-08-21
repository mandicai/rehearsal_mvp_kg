// evaluation.html — generate a MATRIX of shot examples for one fixed scene
// across documentary technique × mode × track (Primary/Cutaway), reusing the
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
let allRoles = [];             // [{key,label}]
const selTech = new Set();
const selMode = new Set();
const selRole = new Set();

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
  buildChecklist($('eval-tech-list'), allTechniques, selTech, updateEstimate);
  buildChecklist($('eval-mode-list'), allModes, selMode, updateEstimate);
  buildChecklist($('eval-role-list'), allRoles, selRole, updateEstimate);
  updateEstimate();
}

function updateEstimate() {
  const n = selTech.size * selMode.size * selRole.size;
  const video = $('eval-video-toggle').checked;
  const perCell = video ? 65 : 15; // rough seconds/cell
  const secs = n * perCell;
  const mins = Math.max(1, Math.round(secs / 60));
  const est = $('eval-run-estimate');
  const runBtn = $('eval-run-btn');
  if (!n) {
    est.textContent = 'Select at least one of each axis.';
    est.classList.remove('error');
    runBtn.disabled = true;
    return;
  }
  const over = n > 24;
  est.textContent = `${n} cell${n === 1 ? '' : 's'} · ~${mins} min${over ? ' — too many (max 24), narrow the axes' : ''}`;
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
    roles: Array.from(selRole),
    video: $('eval-video-toggle').checked,
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
      renderGrid(status.cells || []);
      if (status.state === 'ready') {
        statusEl.textContent = `Done — ${status.total} cell${status.total === 1 ? '' : 's'}.`;
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

function renderGrid(cells) {
  const grid = $('eval-grid');
  grid.innerHTML = '';
  if (!cells.length) return;

  const modeLabel = k => (allModes.find(m => m.key === k) || {}).label || k;
  const roles = allRoles.length ? allRoles.map(r => r.key) : ['Primary', 'Cutaway'];
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
  head.textContent = `${cell.technique} · ${(allModes.find(m => m.key === cell.mode) || {}).label || cell.mode} · ${cell.role}`;
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
  const wild = $('eval-wildness');
  wild.addEventListener('input', () => { $('eval-wildness-val').textContent = parseFloat(wild.value).toFixed(1); });
  $('eval-run-btn').addEventListener('click', runMatrix);
  $('eval-cell-modal').querySelector('.eval-modal-backdrop').addEventListener('click', hideCellModal);

  fetchCatalogs()
    .then(({ modes, techniques, roles }) => {
      allModes = modes || [];
      allTechniques = techniques || [];
      allRoles = roles || [];
      // Sensible small defaults: first 3 techniques, first mode, both tracks.
      allTechniques.slice(0, 3).forEach(t => selTech.add(t.key));
      if (allModes[0]) selMode.add(allModes[0].key);
      allRoles.forEach(r => selRole.add(r.key));
      renderAxes();
    })
    .catch(err => {
      $('eval-run-status').textContent = err.message;
      $('eval-run-status').classList.add('error');
    });
}

init();
