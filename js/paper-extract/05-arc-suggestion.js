//#region --- ARC SUGGESTION
// The paper's own extracted abstract, if it has one - paper_extraction.py
// has no dedicated abstract field (see its own docstring on why), it's
// just a heading like any other, so this is a title match over the
// already-extracted sections rather than a separate lookup. Sent alongside
// whatever the filmmaker said (see fetchSuggestArcs) to ground the arc/
// documentary-mode suggestion in the paper's own framing of its
// contribution too, not just the spoken narration/focus chips.
function findAbstractText() {
  const abstractSection = currentSections.find(s => /\babstract\b/i.test(s.title || ''));
  return abstractSection ? abstractSection.text : '';
}

// The paper's real sections (index + title) sent with an arc-suggestion
// request so each suggested arc can map them into its parts - the preview and
// auto-placement on accept (see renderArcSuggestion/runAcceptArc). Excludes
// excluded (removed) sections and narrativeOnly scaffold/placeholder scenes,
// which aren't real paper content.
function paperSectionsForArc() {
  return currentSections
    .filter(s => !s.removed && !s.narrativeOnly)
    // A short body snippet (not the full text) gives the distillation real
    // placement signal beyond the (often generic) title, while keeping the
    // whole-paper prompt lean - see distill_from_moodboard's listing. The
    // arc-only /paper/suggest_arcs route ignores the extra field.
    .map(s => ({ index: s.index, title: s.title, snippet: (s.text || '').trim().slice(0, 280) }));
}

function runSuggestArcs() {
  // suggestArcsBtn.disabled = true;
  suggestArcsStatusEl.textContent = 'Suggesting narrative arcs ...';
  suggestArcsStatusEl.classList.remove('error');
  arcSuggestionPanelEl.style.display = 'none';

  fetchSuggestArcs(Array.from(selectedFocusStatements), findAbstractText(), paperSectionsForArc())
    .then(({ recommended, alternatives }) => {
      suggestArcsStatusEl.textContent = '';
      // suggestArcsBtn.disabled = false;
      renderArcSuggestionWithNarration(recommended, alternatives, selectedDocumentaryMode);
    })
    .catch(err => {
      suggestArcsStatusEl.textContent = err.message;
      suggestArcsStatusEl.classList.add('error');
      // suggestArcsBtn.disabled = false;
    });
}

// suggestArcsBtn only exists on storyboard.html - guarded so this is a
// no-op on index.html (which loads the same shared script).
// if (suggestArcsBtn) suggestArcsBtn.addEventListener('click', runSuggestArcs);

// --- Moodboard entry point (moodboard.html): add references, poll their
// background analysis, and (on storyboard.html) distill them into a
// suggested arc + mode + techniques. Replaces the old narration recorder.

function addMoodboardReference({ kind, name, url, file }) {
  // Optimistic placeholder card shown immediately; the fetch fills in its
  // ref_id, then polling flips it to ready/error.
  const entry = {
    refId: null,
    sourceKind: kind,
    title: name || (file ? file.name : (url || 'Reference')),
    sourceUrl: url || '',
    note: '',
    state: 'analyzing',
    profile: null,
    thumbnailUrl: null,
  };
  moodboardReferences.push(entry);
  renderMoodboardList();
  refreshMoodboardStatusLine();

  fetchAddMoodboardReference({ kind, name, url, file, note: '', projectId: premiereProjectId })
    .then(({ project_id, ref_id }) => {
      premiereProjectId = project_id;
      entry.refId = ref_id;
      saveDebugSession();
      pollMoodboardReference(ref_id);
    })
    .catch(err => {
      entry.state = 'error';
      entry.errorMessage = err.message;
      renderMoodboardList();
      refreshMoodboardStatusLine();
    });
}

function pollMoodboardReference(refId) {
  if (!premiereProjectId) return;
  fetchMoodboardReferenceStatus(premiereProjectId, refId)
    .then(status => {
      const entry = moodboardReferences.find(r => r.refId === refId);
      if (!entry) return;  // removed while a poll was in flight
      if (status.state === 'ready') {
        entry.state = 'ready';
        entry.profile = status.profile || null;
        if (entry.profile) {
          entry.title = entry.profile.title || entry.title;
          entry.thumbnailUrl = entry.profile.thumbnail_url || null;
          if (!entry.note) entry.note = entry.profile.note || '';
        }
        renderMoodboardList();
        refreshMoodboardStatusLine();
        saveDebugSession();
        updateComposeStoryboardVisibility();
        refreshSuggestionsFromMoodboard();  // storyboard: re-distill once analyzed
      } else if (status.state === 'error' || status.state === 'unknown') {
        entry.state = 'error';
        entry.errorMessage = status.message || 'Analysis failed.';
        renderMoodboardList();
        refreshMoodboardStatusLine();
        saveDebugSession();
      } else {
        entry.stepMessage = status.message || '';
        renderMoodboardList();
        setTimeout(() => pollMoodboardReference(refId), 2500);
      }
    })
    .catch(() => {
      // Transient network blip - keep polling a little slower.
      setTimeout(() => pollMoodboardReference(refId), 4000);
    });
}

function refreshMoodboardStatusLine() {
  if (!moodboardStatusEl) return;
  const analyzing = moodboardReferences.filter(r => r.state === 'analyzing').length;
  const ready = moodboardReferences.filter(r => r.state === 'ready').length;
  moodboardStatusEl.classList.remove('error');
  if (analyzing > 0) {
    moodboardStatusEl.textContent = `Analyzing ${analyzing} reference${analyzing === 1 ? '' : 's'} … you can keep adding more.`;
  } else if (ready > 0) {
    moodboardStatusEl.textContent = `${ready} reference${ready === 1 ? '' : 's'} analyzed.`;
  } else {
    moodboardStatusEl.textContent = '';
  }
}

// Cards mark the reference itself as .user-content (the presenter's own pick)
// and the analysis-derived style summary as .llm-generated, so the two are
// visually distinct (see styles-index.css).
// The analysis-derived style summary for a reference profile (the same LLM
// output shown on index.html's cards and storyboard.html's recap). Built from
// DOM nodes so tone/pacing/mode and the "Techniques:" label can be bold.
// Carries the .llm-generated treatment.
function buildMoodboardStyleSummary(profile) {
  const style = document.createElement('div');
  style.className = 'moodboard-card-style llm-generated';
  const sep = () => { if (style.childNodes.length) style.appendChild(document.createTextNode(' — ')); };
  const bold = text => { const b = document.createElement('strong'); b.textContent = text; return b; };

  if (profile.visual_style) style.appendChild(document.createTextNode(profile.visual_style));

  const modeLabel = (DOCUMENTARY_MODES.find(m => m.key === profile.suggested_mode) || {}).label
    || profile.suggested_mode || '';
  const metaParts = [profile.tone, profile.pacing, modeLabel].filter(Boolean);
  if (metaParts.length) {
    sep();
    metaParts.forEach((val, i) => {
      if (i) style.appendChild(document.createTextNode(' · '));
      style.appendChild(bold(val));
    });
  }

  const techs = profile.observed_techniques || [];
  if (techs.length) {
    sep();
    style.appendChild(bold('Techniques:'));
    style.appendChild(document.createTextNode(' ' + techs.join(', ')));
  }

  if (!style.childNodes.length) {
    // An empty profile is ambiguous on its own: the model may have found
    // nothing, or it may never have been asked. `style_source` says which, and
    // during a session that difference is the whole story.
    style.textContent = profile.style_source === 'unconfigured'
      ? 'Not analyzed — no LLM key configured. Set PROXY_API_KEY in backend/.env and restart the backend.'
      : profile.style_source === 'error'
        ? 'Style analysis failed — the reference was added, but the model call did not return a profile.'
        : 'Analyzed (no distinct style cues detected).';
  }
  return style;
}

// The horizontal strip of frames sampled from a clip (null when there are none,
// e.g. a named reference).
function buildMoodboardFramesStrip(profile) {
  const frameUrls = profile.frame_urls || [];
  if (!frameUrls.length) return null;
  const strip = document.createElement('div');
  strip.className = 'moodboard-card-frames';
  frameUrls.forEach(url => {
    const fimg = document.createElement('img');
    fimg.className = 'moodboard-frame';
    fimg.src = url;
    fimg.alt = 'sampled frame';
    fimg.loading = 'lazy';
    strip.appendChild(fimg);
  });
  return strip;
}

// storyboard.html's read-only "Moodboard" recap module (#moodboard-summary-module)
// - shows the analyzed references carried over from index.html (thumbnail,
// title, source badge, style summary, sampled frames, and any note), without
// the add/remove/poll controls. Hides itself when there's nothing analyzed.
function renderMoodboardSummaryList() {
  if (!moodboardSummaryListEl) return;
  const refs = moodboardReferences.filter(r => r.profile);
  if (moodboardSummaryModuleEl) {
    moodboardSummaryModuleEl.style.display = document.body.classList.contains('storyboard-page')
      ? 'none' : (refs.length ? '' : 'none');
  }
  moodboardSummaryListEl.innerHTML = '';

  refs.forEach(ref => {
    const card = document.createElement('div');
    card.className = 'moodboard-card user-content';

    const thumb = document.createElement('div');
    thumb.className = 'moodboard-card-thumb';
    if (ref.thumbnailUrl) {
      const img = document.createElement('img');
      img.src = ref.thumbnailUrl;
      img.alt = ref.title || 'reference';
      thumb.appendChild(img);
    } else {
      thumb.classList.add('moodboard-card-thumb--placeholder');
      thumb.textContent = ref.sourceKind === 'named' ? '🎬' : (ref.sourceKind === 'youtube' ? '▶' : '🎞');
    }
    card.appendChild(thumb);

    const body = document.createElement('div');
    body.className = 'moodboard-card-body';

    const titleRow = document.createElement('div');
    titleRow.className = 'moodboard-card-title-row';
    const title = document.createElement('span');
    title.className = 'moodboard-card-title';
    title.textContent = ref.title || 'Reference';
    titleRow.appendChild(title);
    const badge = document.createElement('span');
    badge.className = 'moodboard-source-badge';
    badge.textContent = ref.sourceKind === 'named' ? 'Named' : (ref.sourceKind === 'youtube' ? 'YouTube' : 'Upload');
    titleRow.appendChild(badge);
    body.appendChild(titleRow);

    body.appendChild(buildMoodboardStyleSummary(ref.profile));
    const strip = buildMoodboardFramesStrip(ref.profile);
    if (strip) body.appendChild(strip);
    if (ref.note) {
      const noteEl = document.createElement('div');
      noteEl.className = 'moodboard-card-note-static';
      noteEl.textContent = `Note: ${ref.note}`;
      body.appendChild(noteEl);
    }

    card.appendChild(body);
    moodboardSummaryListEl.appendChild(card);
  });
}

function renderMoodboardList() {
  if (!moodboardListEl) return;
  // The moodboard is a setup-page input. Keep it hidden on storyboard.html
  // even when this renderer is called during session restore or relocation.
  if (moodboardSummaryModuleEl) {
    moodboardSummaryModuleEl.style.display = document.body.classList.contains('storyboard-page')
      ? 'none' : '';
  }
  moodboardListEl.innerHTML = '';
  moodboardReferences.forEach(ref => {
    const card = document.createElement('div');
    card.className = 'moodboard-card user-content';
    card.dataset.state = ref.state;

    const thumb = document.createElement('div');
    thumb.className = 'moodboard-card-thumb';
    if (ref.thumbnailUrl) {
      const img = document.createElement('img');
      img.src = ref.thumbnailUrl;
      img.alt = ref.title || 'reference';
      thumb.appendChild(img);
    } else {
      thumb.classList.add('moodboard-card-thumb--placeholder');
      thumb.textContent = ref.sourceKind === 'named' ? '🎬' : (ref.sourceKind === 'youtube' ? '▶' : '🎞');
    }
    card.appendChild(thumb);

    const body = document.createElement('div');
    body.className = 'moodboard-card-body';

    const titleRow = document.createElement('div');
    titleRow.className = 'moodboard-card-title-row';
    const title = document.createElement('span');
    title.className = 'moodboard-card-title';
    title.textContent = ref.title || 'Reference';
    titleRow.appendChild(title);
    const badge = document.createElement('span');
    badge.className = 'moodboard-source-badge';
    badge.textContent = ref.sourceKind === 'named' ? 'Named' : (ref.sourceKind === 'youtube' ? 'YouTube' : 'Upload');
    titleRow.appendChild(badge);
    const pill = document.createElement('span');
    pill.className = `moodboard-status-pill moodboard-status-pill--${ref.state}`;
    pill.textContent = ref.state === 'ready' ? 'Analyzed' : (ref.state === 'error' ? 'Failed' : 'Analyzing…');
    titleRow.appendChild(pill);
    body.appendChild(titleRow);

    if (ref.state === 'ready' && ref.profile) {
      body.appendChild(buildMoodboardStyleSummary(ref.profile));
      const strip = buildMoodboardFramesStrip(ref.profile);
      if (strip) body.appendChild(strip);
    } else if (ref.state === 'error') {
      const errEl = document.createElement('div');
      errEl.className = 'moodboard-card-error';
      errEl.textContent = ref.errorMessage || 'Analysis failed.';
      body.appendChild(errEl);
    }

    const noteInput = document.createElement('input');
    noteInput.type = 'text';
    noteInput.className = 'moodboard-card-note';
    noteInput.placeholder = 'Add a note (what you like about it)…';
    noteInput.value = ref.note || '';
    noteInput.addEventListener('change', () => {
      ref.note = noteInput.value;
      if (ref.profile) ref.profile.note = noteInput.value;
      saveDebugSession();
    });
    body.appendChild(noteInput);

    card.appendChild(body);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'moodboard-card-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Remove this reference';
    removeBtn.addEventListener('click', () => {
      moodboardReferences = moodboardReferences.filter(r => r !== ref);
      renderMoodboardList();
      refreshMoodboardStatusLine();
      saveDebugSession();
      updateComposeStoryboardVisibility();
      refreshSuggestionsFromMoodboard();  // storyboard: re-distill after removal
    });
    card.appendChild(removeBtn);

    moodboardListEl.appendChild(card);
  });
}

// index.html add-controls (guarded - null on storyboard.html).
if (moodboardAddNameBtn && moodboardNameInput) {
  const addName = () => {
    const name = (moodboardNameInput.value || '').trim();
    if (!name) return;
    addMoodboardReference({ kind: 'named', name });
    moodboardNameInput.value = '';
  };
  moodboardAddNameBtn.addEventListener('click', addName);
  moodboardNameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addName(); } });
}
if (moodboardAddUrlBtn && moodboardUrlInput) {
  const addUrl = () => {
    const url = (moodboardUrlInput.value || '').trim();
    if (!url) return;
    addMoodboardReference({ kind: 'youtube', url });
    moodboardUrlInput.value = '';
  };
  moodboardAddUrlBtn.addEventListener('click', addUrl);
  moodboardUrlInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addUrl(); } });
}
if (moodboardFileInput) {
  moodboardFileInput.addEventListener('change', () => {
    const file = moodboardFileInput.files && moodboardFileInput.files[0];
    if (!file) return;
    addMoodboardReference({ kind: 'upload', file });
    moodboardFileInput.value = '';
  });
}

// --- 3D reconstruction entry point (index.html): upload a photo/panorama/clip,
// poll its background reconstruction, then explore it in an INLINE three.js
// viewer (js/reconstruct-viewer.js). Mirrors the moodboard add/poll flow.

function addReconstruct({ file, kindHint, engine }) {
  const item = {
    reconId: null,
    name: file ? file.name : 'Reconstruction',
    kindHint: kindHint || 'auto',
    engine: engine || 'sharp',
    state: 'reconstructing',
    stepMessage: '',
    profile: null,
    expanded: false,
    teardown: null,
  };
  reconstructItems.push(item);
  renderReconstructList();
  refreshReconstructStatusLine();

  fetchAddReconstruct({ file, kind: kindHint, engine, projectId: premiereProjectId })
    .then(({ project_id, recon_id }) => {
      premiereProjectId = project_id;
      item.reconId = recon_id;
      saveDebugSession();
      pollReconstruct(recon_id);
    })
    .catch(err => {
      item.state = 'error';
      item.errorMessage = err.message;
      renderReconstructList();
      refreshReconstructStatusLine();
    });
}

function pollReconstruct(reconId) {
  if (!premiereProjectId) return;
  fetchReconstructStatus(premiereProjectId, reconId)
    .then(status => {
      const item = reconstructItems.find(r => r.reconId === reconId);
      if (!item) return;  // removed while a poll was in flight
      if (status.state === 'ready') {
        item.state = 'ready';
        item.profile = status.profile || null;
        renderReconstructList();
        refreshReconstructStatusLine();
        saveDebugSession();
      } else if (status.state === 'error' || status.state === 'unknown') {
        item.state = 'error';
        item.errorMessage = status.message || 'Reconstruction failed.';
        renderReconstructList();
        refreshReconstructStatusLine();
        saveDebugSession();
      } else {
        item.stepMessage = status.message || '';
        renderReconstructList();
        setTimeout(() => pollReconstruct(reconId), 2500);
      }
    })
    .catch(() => {
      setTimeout(() => pollReconstruct(reconId), 4000);
    });
}

function refreshReconstructStatusLine() {
  if (!reconstructStatusEl) return;
  const working = reconstructItems.filter(r => r.state === 'reconstructing').length;
  const ready = reconstructItems.filter(r => r.state === 'ready').length;
  reconstructStatusEl.classList.remove('error');
  if (working > 0) {
    reconstructStatusEl.textContent = `Reconstructing ${working} item${working === 1 ? '' : 's'} …`;
  } else if (ready > 0) {
    reconstructStatusEl.textContent = `${ready} scene${ready === 1 ? '' : 's'} ready — click "View in 3D".`;
  } else {
    reconstructStatusEl.textContent = '';
  }
}

const RECONSTRUCT_MODE_LABEL = {
  'splat': '3D Gaussian splats',
  'depth-displace': '2.5D depth',
  'pano': '360° panorama',
  'flat': 'flat (no depth)',
};

// Collapse any other expanded viewer first (tears down its WebGL context) so at
// most one is live at a time.
function collapseReconstruct(except) {
  reconstructItems.forEach(other => {
    if (other !== except && other.expanded) {
      other.expanded = false;
      if (other.teardown) { try { other.teardown(); } catch (e) { } other.teardown = null; }
    }
  });
}

function renderReconstructList() {
  if (!reconstructListEl) return;
  // The list is rebuilt wholesale, so any live viewer's canvas is about to be
  // detached - tear each down (expanded items are re-created in the loop below)
  // to avoid orphaned WebGL contexts.
  reconstructItems.forEach(it => {
    if (it.teardown) { try { it.teardown(); } catch (e) { } it.teardown = null; }
  });
  reconstructListEl.innerHTML = '';
  reconstructItems.forEach(item => {
    const card = document.createElement('div');
    card.className = 'moodboard-card user-content reconstruct-card';
    card.dataset.state = item.state;

    const thumb = document.createElement('div');
    thumb.className = 'moodboard-card-thumb';
    if (item.profile && item.profile.color_url) {
      const img = document.createElement('img');
      img.src = item.profile.color_url;
      img.alt = item.name;
      thumb.appendChild(img);
    } else {
      thumb.classList.add('moodboard-card-thumb--placeholder');
      thumb.textContent = '🧊';
    }
    card.appendChild(thumb);

    const body = document.createElement('div');
    body.className = 'moodboard-card-body';

    const titleRow = document.createElement('div');
    titleRow.className = 'moodboard-card-title-row';
    const title = document.createElement('span');
    title.className = 'moodboard-card-title';
    title.textContent = item.name;
    titleRow.appendChild(title);
    if (item.profile) {
      const badge = document.createElement('span');
      badge.className = 'moodboard-source-badge';
      badge.textContent = RECONSTRUCT_MODE_LABEL[item.profile.viewer_mode] || item.profile.viewer_mode;
      titleRow.appendChild(badge);
    }
    const pill = document.createElement('span');
    pill.className = `moodboard-status-pill moodboard-status-pill--${item.state === 'reconstructing' ? 'analyzing' : item.state}`;
    pill.textContent = item.state === 'ready' ? 'Ready' : (item.state === 'error' ? 'Failed' : 'Reconstructing…');
    titleRow.appendChild(pill);
    body.appendChild(titleRow);

    if (item.state === 'ready' && item.profile) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'btn-secondary reconstruct-view-toggle';
      toggle.textContent = item.expanded ? 'Hide 3D ▲' : 'View in 3D ▼';
      const host = document.createElement('div');
      host.className = 'reconstruct-viewer-host';
      host.style.display = item.expanded ? '' : 'none';
      toggle.addEventListener('click', () => {
        item.expanded = !item.expanded;
        if (item.expanded) {
          collapseReconstruct(item);
          host.style.display = '';
          toggle.textContent = 'Hide 3D ▲';
          item.teardown = openReconstructViewer(item.profile, host);
        } else {
          host.style.display = 'none';
          toggle.textContent = 'View in 3D ▼';
          if (item.teardown) { try { item.teardown(); } catch (e) { } item.teardown = null; }
        }
      });
      body.appendChild(toggle);
      body.appendChild(host);
      if (item.expanded) item.teardown = openReconstructViewer(item.profile, host);
    } else if (item.state === 'error') {
      const errEl = document.createElement('div');
      errEl.className = 'moodboard-card-error';
      errEl.textContent = item.errorMessage || 'Reconstruction failed.';
      body.appendChild(errEl);
    } else {
      const stepEl = document.createElement('div');
      stepEl.className = 'moodboard-card-style';
      stepEl.textContent = item.stepMessage || 'Reconstructing …';
      body.appendChild(stepEl);
    }

    card.appendChild(body);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'moodboard-card-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Remove this reconstruction';
    removeBtn.addEventListener('click', () => {
      if (item.teardown) { try { item.teardown(); } catch (e) { } item.teardown = null; }
      reconstructItems = reconstructItems.filter(r => r !== item);
      renderReconstructList();
      refreshReconstructStatusLine();
      saveDebugSession();
    });
    card.appendChild(removeBtn);

    reconstructListEl.appendChild(card);
  });
}

if (reconstructFileInput) {
  reconstructFileInput.addEventListener('change', () => {
    const file = reconstructFileInput.files && reconstructFileInput.files[0];
    if (!file) return;
    const checked = document.querySelector('input[name="reconstruct-kind"]:checked');
    const engineChecked = document.querySelector('input[name="reconstruct-engine"]:checked');
    addReconstruct({
      file,
      kindHint: checked ? checked.value : 'auto',
      engine: engineChecked ? engineChecked.value : 'sharp',
    });
    reconstructFileInput.value = '';
  });
}

// A plain-text summary of the ready references, used as the documentary_goal
// fallback the rest of the pipeline reads (the shot/storyboard/edit-plan
// generation all read recordedTranscript when there's no intent textarea) -
// keeps those flows working now that there's no spoken narration.
// The analyzed moodboard profiles (compact) passed into shot generation to
// anchor the frames' visual style (see fetchGenerateShot / shot_plan_llm's
// _format_moodboard). Only the style-relevant fields.
function moodboardProfilesForGeneration() {
  return moodboardReferences
    .filter(r => r.state === 'ready' && r.profile)
    .map(r => ({
      title: r.profile.title,
      visual_style: r.profile.visual_style,
      tone: r.profile.tone,
      pacing: r.profile.pacing,
      observed_techniques: r.profile.observed_techniques,
    }));
}

function buildMoodboardGoalSummary() {
  return moodboardReferences
    .filter(r => r.state === 'ready' && r.profile)
    .map(r => [r.profile.title, r.profile.visual_style, r.profile.tone, r.note].filter(Boolean).join(' — '))
    .join(' | ');
}

// Use exactly the same inputs as the narration batch that runs after
// "Apply this arc" (see runAcceptArc/autoSuggestNarrationForStoryboard), but
// draft against an arc part before there is a scene object to attach it to.
// Each part's mapped paper sections become the new scene's attached source
// material, just as they do on accept.
function compactArcSuggestedNarration(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';

  // Keep the arc preview to the first two complete sentences. This is only
  // used for the narrative-arc view; narration suggestions for nodes retain
  // their normal, fuller length.
  let sentenceCount = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!/[.!?]/.test(text[index])) continue;
    const next = text[index + 1] || '';
    if (next && !/\s/.test(next)) continue;
    sentenceCount += 1;
    if (sentenceCount === 2) return text.slice(0, index + 1).trim();
  }
  return text;
}

// One draft per arc part, kept for the session. A part is identified by its
// name and the paper sections it covers (plus the documentary mode the draft
// was written for), so re-suggesting arcs, promoting an alternative, or
// re-rendering the panel never re-drafts a part the presenter has already
// read - the narration they saw is the narration they keep, and it is the
// same text that seeds the act's first narration segment on the storyboard.
const arcNarrationDraftCache = new Map();
function arcNarrationDraftKey(part, documentaryMode) {
  return [
    String(part?.name || part?.label || part?.key || ''),
    (part?.section_indices || []).join(','),
    String(documentaryMode || ''),
  ].join('|');
}

function suggestNarrationForArcPart(part, documentaryMode) {
  const cached = arcNarrationDraftCache.get(arcNarrationDraftKey(part, documentaryMode));
  if (cached) {
    part.suggested_narration = cached;
    return Promise.resolve();
  }
  const sourceByIndex = new Map(currentSections.map(section => [section.index, section]));
  const sectionText = (part.section_indices || [])
    .map(index => sourceByIndex.get(index))
    .filter(section => section && !section.removed && !section.narrativeOnly)
    .map(section => section.text)
    .filter(Boolean)
    .join('\n\n');
  return fetchSuggestNarration({
    sectionTitle: 'New Scene',
    sectionText,
    actTitle: part.name || part.label || '',
    actDescription: part.description || '',
    abstract: findAbstractText(),
    documentaryMode,
    maxSentences: 2,
  }).then(({ narration }) => {
    part.suggested_narration = compactArcSuggestedNarration(narration);
    if (part.suggested_narration) {
      arcNarrationDraftCache.set(arcNarrationDraftKey(part, documentaryMode), part.suggested_narration);
    }
  });
}

// Render an arc immediately with a per-part loading state, then replace those
// states with the generated drafts as they arrive. Only the visible/current arc
// is drafted up front; an alternative is drafted when the presenter selects it
// so the distillation step does not make a large burst of unnecessary calls.
function renderArcSuggestionWithNarration(current, others, documentaryMode) {
  const generation = ++arcNarrationGeneration;
  const arcs = [current].filter(Boolean);
  arcs.forEach(arc => (arc.sections || []).forEach(part => {
    arcNarrationFailedParts.delete(part);
    // A part rebuilt from a fresh suggestion carries no draft, but the cache
    // may already hold the one written for the same part earlier.
    if (!(part.suggested_narration || '').trim()) {
      const cached = arcNarrationDraftCache.get(arcNarrationDraftKey(part, documentaryMode));
      if (cached) part.suggested_narration = cached;
    }
    if ((part.suggested_narration || '').trim()) {
      arcNarrationPendingParts.delete(part);
    } else {
      arcNarrationPendingParts.add(part);
    }
  }));
  renderArcSuggestion(current, others);

  const jobs = arcs.flatMap(arc => (arc.sections || []).map(part => {
    if ((part.suggested_narration || '').trim()) return Promise.resolve();
    return suggestNarrationForArcPart(part, documentaryMode)
      .catch(() => {
        arcNarrationFailedParts.add(part);
        part.suggested_narration = '';
      })
      .finally(() => arcNarrationPendingParts.delete(part));
  }));
  return Promise.all(jobs).then(() => {
    if (generation !== arcNarrationGeneration) return;
    saveDebugSession();
    renderArcSuggestion(current, others);
  });
}

// storyboard.html: distill the analyzed moodboard into a suggested arc (+ its
// alternatives), a documentary mode, and techniques. The arc rendering is
// identical to runSuggestArcs; additionally we pre-select the suggested mode
// + technique chips and stash the rationale for renderMovieEditor to show.
function runDistillMoodboard() {
  const readyProfiles = moodboardReferences
    .filter(r => r.state === 'ready' && r.profile)
    .map(r => ({ ...r.profile, note: r.note || r.profile.note || '' }));
  if (!readyProfiles.length) {
    // Documentary references are optional creative guidance. The extracted
    // paper itself is always enough to produce a useful arc, including while
    // moodboard uploads are still analyzing or when the presenter skips them.
    if (paperSectionsForArc().length || findAbstractText()) {
      runPaperArcSuggestion();
    } else {
      suggestArcsRowEl.style.display = '';
      suggestArcsStatusEl.textContent = 'Upload and extract a research paper, or add a reference documentary, to suggest an arc.';
    }
    return;
  }
  // suggestArcsBtn.disabled = true;
  suggestArcsStatusEl.textContent = 'Distilling your moodboard into a narrative arc, mode, and techniques ...';
  suggestArcsStatusEl.classList.remove('error');
  arcSuggestionPanelEl.style.display = 'none';

  fetchDistillMoodboard(readyProfiles, findAbstractText(), paperSectionsForArc())
    .then(({ recommended, alternatives, suggested_mode, suggested_techniques, style_rationale }) => {
      suggestArcsStatusEl.textContent = '';
      // suggestArcsBtn.disabled = false;
      if (suggested_mode) {
        selectedDocumentaryMode = suggested_mode;
        actBoardSetupMode = suggested_mode;
      }
      const cleanSuggestedTechniques = sanitizeDocumentaryTechniques(suggested_techniques);
      selectedTechniques = new Set(cleanSuggestedTechniques);
      distilledStyleRationale = style_rationale || '';
      lastDistillResult = {
        recommended, alternatives, suggested_mode,
        source: 'moodboard',
        suggested_techniques: cleanSuggestedTechniques, style_rationale,
      };
      // Keep existing Act Board scene boards in sync with a newly distilled
      // setup mode unless a presenter explicitly chose a local scene mode.
      syncActBoardSceneModesToSetupMode();
      recordedTranscript = buildMoodboardGoalSummary();
      saveDebugSession();
      renderArcSuggestionWithNarration(recommended, alternatives, selectedDocumentaryMode);
      // If an arc's already been accepted (the movie editor is on screen),
      // refresh it so the "Moodboard styles:" + techniques modules reflect the
      // new distill. currentArcSections is unchanged (a NEW arc still needs an
      // explicit Accept - see the suggestion panel), so scenes are preserved.
      if (currentArcSections.length > 0 && resultsEl) {
        const remaining = currentSections.filter(s => !s.removed);
        renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      }
    })
    .catch(err => {
      suggestArcsStatusEl.textContent = err.message;
      suggestArcsStatusEl.classList.add('error');
      // suggestArcsBtn.disabled = false;
    });
}

// Paper-only fallback for the arc step. This intentionally uses the existing
// /paper/suggest_arcs pipeline rather than requiring a moodboard profile: the
// paper's extracted sections (and abstract, when present) are sufficient
// grounding. If references finish analyzing later, runDistillMoodboard will
// replace this cached suggestion with the moodboard-informed version.
function runPaperArcSuggestion() {
  if (!suggestArcsRowEl || !suggestArcsStatusEl || !arcSuggestionPanelEl) return;
  const sections = paperSectionsForArc();
  const abstract = findAbstractText();
  if (!sections.length && !abstract) {
    suggestArcsRowEl.style.display = '';
    suggestArcsStatusEl.textContent = 'Upload and extract a research paper, or add a reference documentary, to suggest an arc.';
    return;
  }
  suggestArcsRowEl.style.display = '';
  suggestArcsStatusEl.textContent = 'Suggesting a narrative arc from your research paper ...';
  suggestArcsStatusEl.classList.remove('error');
  arcSuggestionPanelEl.style.display = 'none';

  // Keep a synthetic focus statement for compatibility with older deployed
  // backends that still validate this field as required. It does not add a
  // user preference; it tells the model to derive the focus from the paper.
  const paperInferredFocus = [
    'Infer the strongest documentary focus from the extracted research paper itself.',
  ];
  fetchSuggestArcs(paperInferredFocus, abstract, sections)
    .then(({ recommended, alternatives }) => {
      suggestArcsStatusEl.textContent = '';
      // Cache the paper-only result so a refresh does not request it again.
      // The optional moodboard distillation can overwrite this later.
      lastDistillResult = {
        recommended,
        alternatives,
        source: 'paper',
        suggested_mode: null,
        suggested_techniques: [],
        style_rationale: '',
      };
      saveDebugSession();
      renderArcSuggestionWithNarration(recommended, alternatives, selectedDocumentaryMode);
    })
    .catch(err => {
      suggestArcsStatusEl.textContent = err.message;
      suggestArcsStatusEl.classList.add('error');
    });
}

// storyboard.html: after the moodboard changes (a reference added or removed),
// re-distill the suggested arc/mode/techniques and refresh the styles +
// techniques modules. Debounced so several references finishing analysis at
// once (or a burst of edits) collapse into a single distill. No-op on
// index.html, which has no arc suggestion panel.
let moodboardRefreshTimer = null;
function refreshSuggestionsFromMoodboard() {
  if (!arcSuggestionPanelEl) return;  // storyboard-only
  clearTimeout(moodboardRefreshTimer);
  moodboardRefreshTimer = setTimeout(() => {
    if (moodboardReferences.some(r => r.state === 'ready')) runDistillMoodboard();
  }, 500);
}

// current: {arc_name, sections, reasoning} - the arc on offer for accept/
// swap right now; reasoning is only ever non-empty for the LLM's own top
// pick, not for an alternative the presenter has since promoted to current
// (see the alternative-chip handler below), which has no reasoning of its
// own to show. others: the remaining candidate arcs (excluding current),
// each {arc_name, sections}, shown as chips to swap to instead.
function renderArcSuggestion(current, others) {
  arcSuggestionPanelEl.innerHTML = '';
  arcSuggestionPanelEl.style.display = '';

  const card = document.createElement('div');
  card.className = 'arc-suggestion-card llm-generated';

  const title = document.createElement('div');
  title.className = 'arc-suggestion-title';
  title.textContent = current.arc_name;
  card.appendChild(title);

  // Concrete preview: under each chapter, show the generated narration and the
  // actual paper sections that would map into it (from section_indices), so the
  // presenter can compare what each arc would really do with THIS paper.
  const titleByIndex = new Map(currentSections.map(s => [s.index, s.title]));
  const partsList = document.createElement('div');
  partsList.className = 'arc-suggestion-parts';
  current.sections.forEach((part, partIdx) => {
    const partEl = document.createElement('div');
    partEl.className = 'arc-suggestion-part';

    const partHeader = document.createElement('div');
    partHeader.className = 'arc-suggestion-part-header';
    const nameEl = document.createElement('div');
    nameEl.className = 'arc-suggestion-part-name';
    const actLabel = `Act ${partIdx + 1}: ${part.name}`;
    nameEl.textContent = actLabel;
    partHeader.appendChild(nameEl);

    // Let the presenter shape the proposed arc before applying it. These
    // controls mutate the same section objects that runAcceptArc consumes, so
    // the resulting order/deletions are reflected on the Act Board canvas.
    const partControls = document.createElement('div');
    partControls.className = 'arc-suggestion-part-controls';
    const movePart = (direction, event) => {
      event.preventDefault();
      event.stopPropagation();
      const nextIndex = partIdx + direction;
      if (nextIndex < 0 || nextIndex >= current.sections.length) return;
      const reordered = current.sections.slice();
      const [moved] = reordered.splice(partIdx, 1);
      reordered.splice(nextIndex, 0, moved);
      current.sections = reordered;
      saveDebugSession();
      renderArcSuggestion(current, others);
    };
    const moveUpButton = document.createElement('button');
    moveUpButton.type = 'button';
    moveUpButton.className = 'arc-suggestion-part-control';
    moveUpButton.textContent = '↑';
    moveUpButton.title = 'Move act up';
    moveUpButton.setAttribute('aria-label', `Move ${actLabel} up`);
    moveUpButton.disabled = partIdx === 0;
    moveUpButton.addEventListener('click', event => movePart(-1, event));
    const moveDownButton = document.createElement('button');
    moveDownButton.type = 'button';
    moveDownButton.className = 'arc-suggestion-part-control';
    moveDownButton.textContent = '↓';
    moveDownButton.title = 'Move act down';
    moveDownButton.setAttribute('aria-label', `Move ${actLabel} down`);
    moveDownButton.disabled = partIdx === current.sections.length - 1;
    moveDownButton.addEventListener('click', event => movePart(1, event));
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'arc-suggestion-part-control arc-suggestion-part-delete';
    deleteButton.textContent = '×';
    deleteButton.title = 'Delete this act';
    deleteButton.setAttribute('aria-label', `Delete ${actLabel}`);
    // Keep one act available so Apply this arc always has a valid scene to
    // scaffold. The presenter can still delete any act when two or more exist.
    deleteButton.disabled = current.sections.length <= 1;
    deleteButton.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (current.sections.length <= 1) return;
      current.sections = current.sections.filter((_, index) => index !== partIdx);
      arcNarrationPendingParts.delete(part);
      arcNarrationFailedParts.delete(part);
      saveDebugSession();
      renderArcSuggestion(current, others);
    });
    partControls.append(moveUpButton, moveDownButton, deleteButton);
    partHeader.appendChild(partControls);
    partEl.appendChild(partHeader);

    const narrationEl = document.createElement('div');
    narrationEl.className = 'arc-suggestion-part-narration';
    const narrationLabel = document.createElement('strong');
    narrationLabel.textContent = 'Suggested narration:';
    narrationEl.appendChild(narrationLabel);
    if (arcNarrationPendingParts.has(part)) {
      narrationEl.appendChild(document.createTextNode(' Generating…'));
    } else if (compactArcSuggestedNarration(part.suggested_narration)) {
      narrationEl.appendChild(document.createTextNode(` ${compactArcSuggestedNarration(part.suggested_narration)}`));
    } else if (arcNarrationFailedParts.has(part)) {
      narrationEl.appendChild(document.createTextNode(' Unavailable — you can generate it after applying the arc.'));
    } else {
      narrationEl.appendChild(document.createTextNode(' Not generated yet.'));
    }
    partEl.appendChild(narrationEl);

    const titles = (part.section_indices || []).map(i => titleByIndex.get(i)).filter(Boolean);
    if (titles.length) {
      const secEl = document.createElement('div');
      secEl.className = 'arc-suggestion-part-sections';
      secEl.textContent = titles.join(' · ');
      partEl.appendChild(secEl);
    }
    partsList.appendChild(partEl);
  });
  card.appendChild(partsList);

  if (current.reasoning) {
    const reasoning = document.createElement('div');
    reasoning.className = 'arc-suggestion-reasoning';
    reasoning.textContent = current.reasoning;
    card.appendChild(reasoning);
  }

  const acceptBtn = document.createElement('button');
  acceptBtn.type = 'button';
  acceptBtn.id = 'accept-arc-btn';
  acceptBtn.className = 'btn-primary';
  const narrationPending = (current.sections || []).some(part => arcNarrationPendingParts.has(part));
  acceptBtn.textContent = narrationPending ? 'Generating narration…' : 'Apply this arc';
  acceptBtn.disabled = narrationPending;
  if (narrationPending) {
    acceptBtn.title = 'Wait for the suggested narration drafts to finish generating.';
  }
  acceptBtn.addEventListener('click', () => runAcceptArc(current));
  card.appendChild(acceptBtn);

  // Append the primary suggestion after the alternative controls below so
  // presenters see their choice/customization options before the suggested
  // arc card itself.
  if (others.length > 0) {
    const otherLabel = document.createElement('p');
    otherLabel.className = 'chip-row-caption';
    otherLabel.style.marginTop = '14px';
    otherLabel.style.fontSize = '12px';
    otherLabel.style.opacity = '0.75';
    otherLabel.textContent = 'Try different arcs:';
    arcSuggestionPanelEl.appendChild(otherLabel);

    const otherChips = document.createElement('div');
    otherChips.className = 'chip-row';
    others.forEach(alt => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip suggested';
      chip.textContent = alt.arc_name;
      chip.addEventListener('click', () => {
        // Promote this alternative to current - the previous current (its
        // reasoning dropped, since that reasoning was specific to it, not
        // to this swap) rejoins the alternatives list alongside whatever's
        // left of it.
        const remaining = others.filter(o => o !== alt);
        renderArcSuggestionWithNarration(
          { arc_name: alt.arc_name, sections: alt.sections, reasoning: null },
          remaining.concat([{ arc_name: current.arc_name, sections: current.sections }]),
          selectedDocumentaryMode
        );
      });
      otherChips.appendChild(chip);
    });
    arcSuggestionPanelEl.appendChild(otherChips);
  }

  // "Suggest your own" - a free-text focus/arc description, re-running the
  // suggestion with it added as an extra focus statement (on top of
  // whichever chips are already selected) rather than replacing anything.
  const customRow = document.createElement('div');
  customRow.className = 'arc-suggestion-custom-row';

  // Keep the input and its action together, while placing the progress/error
  // message directly beneath the focus field.  The status element used to sit
  // at the bottom of the whole module, which made it look unrelated to the
  // focus request that was in flight.
  const customControls = document.createElement('div');
  customControls.className = 'arc-suggestion-custom-controls';

  const customInput = document.createElement('input');
  customInput.type = 'text';
  customInput.placeholder = 'Or describe your own focus/arc ...';
  customInput.className = 'arc-suggestion-custom-input';
  customControls.appendChild(customInput);

  const customBtn = document.createElement('button');
  customBtn.type = 'button';
  customBtn.id = 'suggest-own-arc-btn';
  customBtn.className = 'btn-secondary suggest-arc-btn';
  customBtn.textContent = 'Suggest arc';
  customBtn.addEventListener('click', () => {
    const customText = customInput.value.trim();
    if (!customText) return;
    customBtn.disabled = true;
    suggestArcsStatusEl.textContent = 'Resolving your own focus into a narrative arc ...';
    suggestArcsStatusEl.classList.remove('error');
    fetchSuggestArcs(Array.from(selectedFocusStatements).concat([customText]), findAbstractText(), paperSectionsForArc())
      .then(({ recommended, alternatives }) => {
        suggestArcsStatusEl.textContent = '';
        renderArcSuggestionWithNarration(recommended, alternatives, selectedDocumentaryMode);
      })
      .catch(err => {
        suggestArcsStatusEl.textContent = err.message;
        suggestArcsStatusEl.classList.add('error');
        customBtn.disabled = false;
      });
  });
  customControls.appendChild(customBtn);
  customRow.appendChild(customControls);
  if (suggestArcsStatusEl) customRow.appendChild(suggestArcsStatusEl);

  arcSuggestionPanelEl.appendChild(customRow);
  arcSuggestionPanelEl.appendChild(card);
}

// Locks in whichever arc (recommended/alternative/custom) the presenter
// accepted and shows it straight away as a vertical list of narrative-act
// groups (renderMovieEditor). Each new act receives one fresh scene whose
// source-material field is populated from the paper sections mapped to that
// act. Narration generated during distillation is carried into the new scene;
// any missing draft is generated against the same act/scene context below.
// Existing source sections and generated work remain in state, while the new
// arc gets a clean assigned scene for each of its parts.
function runAcceptArc(arc) {
  // Only the first accepted arc bootstraps the Act Board. Capture this before
  // replacing the accepted arc so later iterations preserve the presenter's
  // existing nodes instead of duplicating starter content.
  const shouldAutoPopulateActBoard = !actBoardFirstArcAutoPopulationDone;
  selectedNarrationArc = { sections: arc.sections, arc_name: arc.arc_name };
  currentArcSections = arc.sections.map(s => ({ key: s.name, label: s.name, description: s.description || '' }));
  // Snapshot the setup choice at the moment the arc is accepted. This is the
  // mode that new Act Board scene boards should highlight, even if the
  // optional Timeline + Scenes mode picker is changed later.
  if (DOCUMENTARY_MODES.some(mode => mode.key === selectedDocumentaryMode)) {
    actBoardSetupMode = selectedDocumentaryMode;
  } else if (!DOCUMENTARY_MODES.some(mode => mode.key === actBoardSetupMode)) {
    actBoardSetupMode = lastDistillResult?.suggested_mode || null;
  }
  // The setup/moodboard mode is the starting mode for Act Board scenes. A
  // scene that the presenter explicitly changed keeps its local override;
  // Timeline + Scenes data remains intact for its future view.
  syncActBoardSceneModesToSetupMode();
  selectedSectionIndices = new Set();

  // Preserve the paper library and all generated work (visual/narration/edit
  // plan/shot frames/cutaways/footage). Only blank scaffold placeholders from
  // the previous arc are dropped; a scaffold scene the presenter filled in is
  // retained in state, even though the new arc gets a clean scene set.
  const hasContent = s => !!(
    (s.text && s.text.trim()) || s.narration || s.narrationAudioPreviewUrl ||
    s.startFramePreviewUrl || (s.cutaways && s.cutaways.length) ||
    s.visualSource || s.selectedVideo || s.selectedAudio || s.uploadedFootagePreviewUrl
  );
  currentSections = currentSections.filter(s => !(s.narrativeOnly && !hasContent(s)));

  // The paper sections mapped into each arc part, in reading order.
  const validIndices = new Set(currentSections.filter(s => !s.removed).map(s => s.index));
  const sectionsByAct = {};
  const mappedPaperIndices = new Set();
  arc.sections.forEach(part => {
    sectionsByAct[part.name] = (part.section_indices || [])
      .filter(idx => validIndices.has(idx))
      .map(idx => currentSections.find(s => s.index === idx))
      .filter(source => source && !source.narrativeOnly);
    sectionsByAct[part.name].forEach(source => mappedPaperIndices.add(source.index));
  });
  // If the arc suggestion omitted some paper sections, attach the remaining
  // source material across the new acts instead of leaving it orphaned.
  const unassignedPaper = currentSections.filter(source =>
    !source.removed && !source.narrativeOnly && !mappedPaperIndices.has(source.index));
  splitContiguous(unassignedPaper, currentArcSections.length).forEach((bucket, index) => {
    const part = currentArcSections[index];
    if (part) sectionsByAct[part.key] = (sectionsByAct[part.key] || []).concat(bucket);
  });

  // A newly accepted arc gets one fresh scene per arc part. The original
  // paper sections remain untouched in `currentSections`; their text is copied
  // into the new scene as its attached source material, and the source indices
  // are retained so the relationship is explicit and recoverable. Existing
  // generated scenes are not deleted, but they are left unassigned to this new
  // arc rather than silently mixing old narration into the new structure.
  currentAssignments = {};
  const newArcScenes = [];
  currentArcSections.forEach(part => {
    const attachedSources = sectionsByAct[part.key] || [];
    const sourceText = attachedSources.map(source => source.text).filter(Boolean).join('\n\n');
    const scene = insertSection(-1, 'New Scene', sourceText, part.key, true);
    scene.sourceMaterialIndices = attachedSources.map(source => source.index);
    // Carry the first attached paper figure into the new scene's open slot.
    // Arc acceptance creates a fresh scene object, so copying only the text
    // would otherwise leave the source image behind on the library section.
    const attachedFigure = attachedSources.find(source => source && source.image);
    if (attachedFigure) scene.image = attachedFigure.image;
    scene.sceneNotes = '';
    scene.role = 'aRoll';
    const arcSuggestedNarration = compactArcSuggestedNarration(part.suggested_narration);
    if (arcSuggestedNarration) {
      // Carry the draft generated while distilling into the same field used
      // by the post-accept narration pipeline, so the scene card shows the
      // exact text the presenter already saw in the arc suggestion.
      scene.arcSuggestedNarration = arcSuggestedNarration;
      scene.narrationSuggestion = scene.arcSuggestedNarration;
    }
    scene.editPlan = {
      transitionIn: 'hard_cut',
      durationSeconds: DEFAULT_SCENE_SECONDS,
      kenBurns: { enabled: false, pan: null },
      textOverlay: null,
    };
    currentAssignments[scene.index] = part.key;
    newArcScenes.push(scene);
  });

  // Set this before rendering so the very first Act Board paint includes the
  // loading veil while its asynchronous starter footage pass runs.
  if (shouldAutoPopulateActBoard) actBoardFirstArcAutoPopulationActive = true;
  const remaining = currentSections.filter(section => !section.removed);
  renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
  relocateAllSidebarModules();
  saveDebugSession();
  if (shouldAutoPopulateActBoard) {
    // Mark this before async span/media work starts so a refresh or another
    // render cannot launch a second starter population in parallel.
    actBoardFirstArcAutoPopulationDone = true;
    saveDebugSession();
    autoPopulateActBoardScenesForFirstArc().catch(error => {
      // The arc is already accepted; optional footage generation should never
      // make that action appear to have failed.
      actBoardFirstArcAutoPopulationActive = false;
      rerenderActBoard();
      console.warn('Act Board starter population failed:', error);
    });
  }

  // Setup inputs are routed to the Act Board by default. Keep the existing
  // Timeline + Scenes generation pipeline intact for the future view, but do
  // not fire its expensive narration/technique/image pass from setup. The
  // timeline still renders its scene scaffolds and its Generate Storyboard
  // action remains available when the presenter explicitly switches to that
  // view.
  setStoryboardStatus('Arc ready on the Act Board. Timeline + Scenes is preserved for later generation.');
}
//#endregion

