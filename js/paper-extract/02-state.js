//#region --- KEEP TRACK OF STATE
// --- State: populated once per successful extraction, then mutated in
// place as sections are excluded/restored or arranged into a narrative arc.
// `index` is assigned once here and never reused, even once a section is
// filtered out of a request - it's the stable id both the removal toggle
// and the narrative-arc response key off of.

let currentLabel = '';
let currentSections = [];

// Stable id for the quiet server-side source snapshot. It is separate from
// Premiere's project id because this snapshot contains only reusable paper
// sections and moodboard links, not generated/export media.
let paperSnapshotId = null;
let paperSnapshotSaveTimer = null;

// index -> arc-part name string (one of currentArcSections' keys below) -
// starts empty on every accepted arc (see runAcceptArc); populated
// manually from there, one section at a time (handleChipDrop's drag, or
// the per-row "+ Add Section" button in renderMovieEditor).
let currentAssignments = {};

// Indices of sections currently highlighted (via a card or its compact chip
// - see handleSectionClick) - a plain click replaces this with just that one
// index, a shift-click toggles it into/out of the set. Drives the .selected
// highlight and, in the sticky action bar (see renderMovieEditor), which
// section(s) "Generate Storyboard"/"Generate Edit Plan" target - the
// selection if non-empty, otherwise the whole arc.
let selectedSectionIndices = new Set();

// Status text for the sticky action bar's own buttons (see
// setStoryboardStatus/setEditPlanStatus) - kept as state, not just a live
// DOM write, because a successful generation re-renders the whole bar (fresh
// status-line elements) before the "Done" message is set; renderMovieEditor
// reads this state to populate those fresh elements.
let storyboardBarStatus = { message: '', isError: false };
let editPlanBarStatus = { message: '', isError: false };

// The accepted narrative arc's named parts, in order - [{key, label,
// description}, ...] with key === label === the part-name string. Populated
// straight from whichever arc was accepted (see runAcceptArc) - no LLM
// section-assignment step, so this is set client-side, not from a server
// response. Drives
// how many columns/timeline segments renderMovieEditor draws.
let currentArcSections = [];

// The act board is the default presentation of the same scene objects. The
// established timeline/scene-card layout remains available through its
// toggle, and switching views never replaces or rewrites storyboard data.
let storyboardView = 'board';

// Act-board nodes are deliberately separate from scene objects. A presenter
// can iterate on a narration/footage idea without changing the timeline,
// attached source material, or recorded narration. Each narration node owns
// an ordered `footageNodeIds` chain with per-node timing; the graph is
// persisted with the normal storyboard session so refreshes do not re-run
// suggestions.
let actBoardNodes = Object.create(null);
// Act-board scene groupings. These are visual containers made by lassoing
// nodes (plus the initial empty scene per act); unlike Timeline + Scenes
// cards, they intentionally do not point at or mutate `currentSections`.
let actBoardScenes = Object.create(null);
// The scene whose nodes are currently loaded into an Act Board canvas. This
// lets scene-scoped actions (such as Clear links) avoid touching saved scenes
// that are not open.
let actBoardOpenSceneByAct = Object.create(null);
// The first act-board visit gets one empty, mode-aware scene per act. Keep a
// separate flag so Clear board remains a real clear operation instead of
// recreating the starter scenes on every rerender.
let actBoardInitialScenesInitialized = false;
let actBoardInitialSceneActKeys = new Set();
// The first accepted narrative arc scaffolds each Act Board scene with a
// suggested narration, its filmable footage beats, and an empty audio node.
// Persist this one-shot marker so a refresh (or a later arc application) never
// silently regenerates or duplicates that starter work.
let actBoardFirstArcAutoPopulationDone = false;
// Runtime-only flag used to keep the Act Board covered while the first-arc
// scaffold finishes generating/searching footage and assigning each footage
// node a selected preview. This is intentionally not persisted: a refresh
// should never leave a stale loading veil over a board.
let actBoardFirstArcAutoPopulationActive = false;
// Incremental Act Board rendering is intentionally feature-gated so the
// existing full-render path remains an easy rollback while the scene-scoped
// patches are exercised in production.
const ACT_BOARD_INCREMENTAL_RENDERING = true;
let actBoardDomRegistry = null;
let actBoardPatchFrame = null;
let actBoardPendingPatch = null;
const actBoardSceneLoadingCounts = new Map();
const actBoardSceneVisualizeTokens = new Map();
let actBoardPlaybackState = null;
// Persist the currently inspected node across Act Board rerenders. Several
// act columns can retain their focused shell, so a DOM-only first match is not
// a reliable indication of which narration panel the presenter was using.
let actBoardSelectedNodeId = '';
let actBoardSelectedNodeActKey = '';
// Scene narration controls keep the currently selected recording separate
// from the general node focus. This lets the scene rail switch into
// re-record mode without changing which node is open in the content panel.
const actBoardSelectedNarrationSegmentByScene = new Map();
let actBoardFullPlaybackPanel = null;
let actBoardFullPlaybackPanelCollapsed = false;
let actBoardSelectedScenePlaybackPanelCollapsed = false;
let actBoardFullPlaybackView = 'overview';
let actBoardSelectedPlaybackView = 'scene';
let actBoardFullPlaybackStatus = {
  state: 'idle',
  url: '',
  message: '',
};
// The full-playback MP4 is a server-side composite of the saved scene
// playbacks. It is started explicitly from the All acts panel's Build button.
let actBoardFullPlaybackRenderTimer = null;
let actBoardNativeAudioElement = null;
let activeActBoardResizeHandler = null;
const actBoardNarrationAnalysisPromises = new Map();
const actBoardNarrationAbortControllers = new Map();
// Manual narration selections are classified independently from the broad
// transcript analysis.  Keep one in-flight request per exact transcript
// range so rapid highlighting/Visualize clicks can share the same result.
const actBoardManualFilmabilityPromises = new Map();
// Keep microphone recorder ownership outside an individual rendered button.
// Narration controls are mirrored in the scene rail and their hidden source
// cards can be rebuilt while a recording is in progress; a closure-local
// MediaRecorder would then be unreachable from the next click.
const actBoardNarrationRecorderStates = new Map();
const actBoardFootageSearchCache = new Map();
const actBoardGenerationJobs = new Map();
// Image generation is expensive and the proxy is shared by every node. Keep
// requests bounded so a single "Visualize highlights" click cannot fan out
// into dozens of simultaneous image calls and freeze the UI/proxy.
const ACT_BOARD_IMAGE_REQUEST_CONCURRENCY = 2;
let actBoardImageRequestsActive = 0;
const actBoardImageRequestQueue = [];
const actBoardGenerationAbortControllers = new Map();
// Visualize Highlights owns one cancellable media job per footage node. Jobs
// are intentionally keyed by node rather than act so a later visualization
// cannot cancel unrelated cards that are still loading.
const actBoardFootageMediaJobs = new Map();
const actBoardSceneMediaPatchTimers = new Map();
const actBoardImageGenerationCache = new Map();
const actBoardFootageDownloadJobs = new Map();

// Small, expiring persistence for expensive deterministic/contextual work.
// The in-memory maps remain the hot path; this second layer prevents a page
// refresh from re-running narration classification, stock searches, or cached
// image-example batches. Only JSON metadata/URLs are stored here (never media
// blobs), with conservative bounds so it cannot crowd out the main session.
const ACT_BOARD_CACHE_STORAGE_KEY = 'actBoardPerformanceCache:v1';
const ACT_BOARD_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const ACT_BOARD_CACHE_MAX_ENTRIES = 64;
let actBoardPersistentCacheLoaded = false;
let actBoardPersistentCache = { narration: {}, footage: {}, images: {} };
let actBoardPersistentCacheWriteTimer = null;
let actBoardPersistentCacheWriteIdle = false;

function actBoardCacheKey(value) {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function loadActBoardPersistentCache() {
  if (actBoardPersistentCacheLoaded) return;
  actBoardPersistentCacheLoaded = true;
  try {
    const saved = JSON.parse(localStorage.getItem(ACT_BOARD_CACHE_STORAGE_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      ['narration', 'footage', 'images'].forEach(kind => {
        if (saved[kind] && typeof saved[kind] === 'object') {
          actBoardPersistentCache[kind] = saved[kind];
        }
      });
    }
  } catch (error) {
    actBoardPersistentCache = { narration: {}, footage: {}, images: {} };
  }
}

function scheduleActBoardPersistentCacheWrite() {
  if (actBoardPersistentCacheWriteTimer) return;
  const flush = () => {
    actBoardPersistentCacheWriteTimer = null;
    actBoardPersistentCacheWriteIdle = false;
    try {
      localStorage.setItem(ACT_BOARD_CACHE_STORAGE_KEY,
        JSON.stringify(actBoardPersistentCache));
    } catch (error) {
      // Cache persistence is best-effort; the main session remains separate.
    }
  };
  if (typeof requestIdleCallback === 'function') {
    actBoardPersistentCacheWriteIdle = true;
    actBoardPersistentCacheWriteTimer = requestIdleCallback(flush, { timeout: 1500 });
  } else {
    actBoardPersistentCacheWriteIdle = false;
    actBoardPersistentCacheWriteTimer = setTimeout(flush, 500);
  }
}

function flushActBoardPersistentCacheWrite() {
  if (actBoardPersistentCacheWriteTimer) {
    if (actBoardPersistentCacheWriteIdle && typeof cancelIdleCallback === 'function') {
      try { cancelIdleCallback(actBoardPersistentCacheWriteTimer); } catch (error) { /* optional */ }
    }
    clearTimeout(actBoardPersistentCacheWriteTimer);
  }
  actBoardPersistentCacheWriteTimer = null;
  actBoardPersistentCacheWriteIdle = false;
  if (!actBoardPersistentCacheLoaded) return;
  try {
    localStorage.setItem(ACT_BOARD_CACHE_STORAGE_KEY,
      JSON.stringify(actBoardPersistentCache));
  } catch (error) {
    // Cache persistence is best-effort; the main session remains separate.
  }
}

function readActBoardPersistentCache(kind, key) {
  loadActBoardPersistentCache();
  const bucket = actBoardPersistentCache[kind];
  if (!bucket) return null;
  const id = actBoardCacheKey(key);
  const entry = bucket[id];
  if (!entry || !entry.value || Date.now() - Number(entry.timestamp || 0) > ACT_BOARD_CACHE_TTL_MS) {
    if (entry) delete bucket[id];
    return null;
  }
  return entry.value;
}

function writeActBoardPersistentCache(kind, key, value) {
  if (!value || !actBoardPersistentCache[kind]) return;
  loadActBoardPersistentCache();
  const bucket = actBoardPersistentCache[kind];
  const id = actBoardCacheKey(key);
  bucket[id] = { timestamp: Date.now(), value };
  const entries = Object.entries(bucket).sort((a, b) =>
    Number(b[1]?.timestamp || 0) - Number(a[1]?.timestamp || 0));
  entries.slice(ACT_BOARD_CACHE_MAX_ENTRIES).forEach(([oldId]) => delete bucket[oldId]);
  scheduleActBoardPersistentCacheWrite();
}

function actBoardAbortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function pumpActBoardImageRequestQueue() {
  while (actBoardImageRequestsActive < ACT_BOARD_IMAGE_REQUEST_CONCURRENCY
    && actBoardImageRequestQueue.length) {
    const item = actBoardImageRequestQueue.shift();
    if (item.signal?.aborted) {
      item.reject(actBoardAbortError());
      continue;
    }
    item.started = true;
    actBoardImageRequestsActive += 1;
    Promise.resolve()
      .then(() => item.task())
      .then(item.resolve, item.reject)
      .finally(() => {
        actBoardImageRequestsActive = Math.max(0, actBoardImageRequestsActive - 1);
        if (item.signal && item.onAbort) item.signal.removeEventListener('abort', item.onAbort);
        pumpActBoardImageRequestQueue();
      });
  }
}

function enqueueActBoardImageRequest(task, signal) {
  return new Promise((resolve, reject) => {
    const item = { task, signal, resolve, reject, started: false, onAbort: null };
    if (signal?.aborted) {
      reject(actBoardAbortError());
      return;
    }
    if (signal) {
      item.onAbort = () => {
        if (item.started) return;
        const index = actBoardImageRequestQueue.indexOf(item);
        if (index >= 0) actBoardImageRequestQueue.splice(index, 1);
        reject(actBoardAbortError());
      };
      signal.addEventListener('abort', item.onAbort, { once: true });
    }
    actBoardImageRequestQueue.push(item);
    pumpActBoardImageRequestQueue();
  });
}

function actBoardNodeVolume(node, fallback = 0.8) {
  const raw = node?.volume;
  // Older saved nodes may contain null/empty volume fields. Treat those as
  // “not set” so they retain audible playback; preserve an explicit numeric
  // zero as a legitimate mute choice.
  if (raw === null || raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

function stopActBoardNativeAudio() {
  const audio = actBoardNativeAudioElement;
  if (!audio) return;
  try { audio.pause(); } catch (err) { /* already detached */ }
  try { audio.currentTime = 0; } catch (err) { /* optional */ }
  actBoardNativeAudioElement = null;
}

function wireActBoardAudioExclusivity(audio) {
  if (!audio) return;
  audio.addEventListener('play', () => {
    if (actBoardNativeAudioElement && actBoardNativeAudioElement !== audio) {
      try { actBoardNativeAudioElement.pause(); } catch (err) { /* detached */ }
      try { actBoardNativeAudioElement.currentTime = 0; } catch (err) { /* optional */ }
    }
    actBoardNativeAudioElement = audio;
  });
  const clear = () => {
    if (actBoardNativeAudioElement === audio) actBoardNativeAudioElement = null;
  };
  audio.addEventListener('ended', clear);
  audio.addEventListener('emptied', clear);
}

// A suggested passage is useful direction for shot/media generation, but it
// is not an actual recorded voice track. Prefer the real transcript whenever
// one exists; otherwise let the draft guide previews and searches without
// making the timeline think audio has been recorded.
function effectiveSectionNarration(section) {
  return (section && (section.narration || section.narrationSuggestion) || '').trim();
}

// The arc suggestion is the source of truth for a freshly accepted scene's
// draft. This lookup also repairs older sessions that persisted the arc part
// but not the scene-side copy, preventing the card and scene from drifting.
function acceptedArcNarrationForSection(section) {
  if (!section || !selectedNarrationArc || !Array.isArray(selectedNarrationArc.sections)) return '';
  const actKey = currentAssignments[section.index];
  const part = selectedNarrationArc.sections.find(candidate =>
    candidate && (candidate.name || candidate.key) === actKey);
  return (part && part.suggested_narration || '').trim();
}

function syncAcceptedArcNarrationDrafts() {
  currentSections.forEach(section => {
    const draft = acceptedArcNarrationForSection(section);
    if (!draft) return;
    section.arcSuggestedNarration = draft;
    section.narrationSuggestion = draft;
  });
}

// Source deletion and storyboard deletion are separate operations. A paper
// section can remain available as source material after its arranged scene is
// cleared from the timeline. Older sessions have no sceneRemoved field, which
// is equivalent to false.
function isSceneActive(section) {
  return !!section && !section.removed && !section.sceneRemoved;
}

// Scene composition notes are deliberately separate from the attached paper
// passage. Older sessions have no sceneNotes field, so their paper text remains
// the fallback input for generation until the presenter adds explicit notes.
function sectionCompositionNotes(section) {
  return ((section && section.sceneNotes) || '').trim()
    || ((section && section.text) || '').trim();
}

let narrationAutofillPromise = null;
let narrationAutofillGeneration = 0;

// Draft narration for every arranged scene that does not already have a real
// transcript or saved draft. The requests run in a small worker pool so
// opening a long paper (or preparing Preview All) does not flood the LLM
// provider; each result is saved and appears after the batch finishes.
function autoSuggestNarrationForStoryboard(options) {
  options = options || {};
  // A second caller while the first batch is in flight should join it. Once a
  // batch finishes, a later call may still pick up newly-added scenes; saved
  // suggestions mean refreshes never regenerate completed narration, and
  // sceneRemoved keeps cleared scenes out of this target list.
  if (narrationAutofillPromise && !options.force) return narrationAutofillPromise;
  const generation = ++narrationAutofillGeneration;
  const targets = options.targets || currentSections.filter(section =>
    isSceneActive(section) && currentAssignments[section.index]
    && !section.narration && !section.narrationSuggestion);
  if (!targets.length) {
    if (options.force) narrationAutofillPromise = null;
    return Promise.resolve();
  }
  setStoryboardStatus(`Drafting narration for ${targets.length} scene${targets.length === 1 ? '' : 's'}...`);
  const concurrency = Math.min(3, targets.length);
  let next = 0;
  let completed = 0;
  const worker = async () => {
    while (next < targets.length) {
      const section = targets[next++];
      const act = currentArcSections.find(a => a.key === currentAssignments[section.index]);
      try {
        const result = await fetchSuggestNarration({
          sectionTitle: section.title,
          sectionText: section.text,
          actTitle: act ? act.label : '',
          actDescription: act ? act.description : '',
          abstract: findAbstractText(),
          documentaryMode: selectedDocumentaryMode,
        });
        // Do not overwrite a recording or an explicit draft created while the
        // background request was in flight.
        if (generation === narrationAutofillGeneration && isSceneActive(section)
          && currentAssignments[section.index]) {
          section.narrationSuggestion = (result.narration || '').trim();
          if (section.narrationSuggestion) completed += 1;
        }
      } catch (err) {
        // Autocomplete is an enhancement; a missing key/network must not make
        // the storyboard unusable. The per-scene button remains available.
      }
    }
  };
  const batch = Promise.all(Array.from({ length: concurrency }, worker)).then(() => {
    if (generation !== narrationAutofillGeneration) return;
    const remaining = currentSections.filter(section => !section.removed);
    renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
    saveDebugSession();
    setStoryboardStatus(completed
      ? `Added suggested narration to ${completed} scene${completed === 1 ? '' : 's'}. Record the voice track when ready.`
      : 'No narration drafts were added; use Suggest narration on a scene to retry.', completed === 0);
  });
  const tracked = batch.finally(() => {
    if (generation === narrationAutofillGeneration) narrationAutofillPromise = null;
  });
  narrationAutofillPromise = tracked;
  return tracked;
}

// Set on an arc-template chip click, cleared the moment the presenter types
// in the textarea afterward (see the ARC_TEMPLATES wiring below) - tracks
// whether the textarea's current content is still exactly a known template
// (so its exact section names can be sent deterministically) or has become
// custom free text (so the backend must invent-or-match instead).
let selectedArcTemplate = null;

// Set/cleared by the documentary-mode chips in the Timeline + Scenes view.
// Act Board scenes use the separately persisted `actBoardSetupMode` captured
// from the index.html setup flow, so changing this future-view picker does not
// silently change a scene board's highlighted mode.
let selectedDocumentaryMode = null;

// The mode distilled from the moodboard setup page is the setup input for the
// Act Board. Keep it separate from the Timeline + Scenes mode picker: that
// picker remains available for the future timeline workflow, but changing it
// must not silently change the mode highlighted on existing act-board scenes.
let actBoardSetupMode = null;

// Set once the presenter accepts a recommended/alternative/custom arc from
// suggest_arcs_from_intent (see runAcceptArc) - { sections: [{name, description}] },
// same shape a chip-picked template's sections would have. Cleared the
// moment the presenter types in the textarea afterward or picks a chip,
// same as selectedArcTemplate (they're mutually exclusive - only one of
// the two is ever non-null), and the moment a fresh recording starts.
let selectedNarrationArc = null;

// The most recently recorded intent narration's playable object URL (used
// for in-session playback - see playIntentBtn/playNarrationRange - and as
// a download fallback if in-browser playback fails) and tracked duration
// (a wall-clock fallback for recordedAudioBuffer.duration, see below - the
// backend's own transcription never returns a real duration, see
// backend/ingest/transcription.py).
let recordedNarrationUrl = null;
let recordedNarrationDurationSeconds = null;
let recordedNarrationExtension = 'webm'; // real container (see runTranscribeIntent) - blob: URLs carry no filename/extension to read back later

// A disk-served copy of the same recording (see fetchUploadNarration in
// runTranscribeIntent) - unlike recordedNarrationUrl's blob: URL, this
// survives navigating to storyboard.html, where it's re-fetched and
// decoded fresh to restore in-browser playback there (see
// restoreDebugSession's page-2 branch).
let persistedNarrationPreviewUrl = null;

// Fallback source of the documentary_goal text when #documentary-intent-input
// isn't in the page (currently commented out in html/index.html, recording-
// only for now) - set alongside/instead of that textarea in
// runTranscribeIntent. Every documentaryGoal read below prefers the
// textarea's value when it exists, so this is a no-op once it's back.
let recordedTranscript = '';

// Whole-piece pacing/music guidance from the most recent "Generate Edit
// Plan" run (backend/edit_plan_llm.py) - per-shot detail lives on each
// section's own .editPlan instead.
let overallEditNotes = '';

// Set once the first /premiere/upload_footage or /premiere/export call
// returns one, so every subsequent call in this session lands in the same
// premiere_exports/<project_id>/ folder instead of minting a new one each time.
let premiereProjectId = null;

// The moodboard entry point (moodboard.html) - reference documentaries the
// presenter added, each analyzed in the background and later distilled into
// suggested arcs/mode/techniques (see runDistillMoodboard). Each entry:
// {refId, sourceKind:'named'|'youtube'|'upload', title, sourceUrl, note,
//  state:'analyzing'|'ready'|'error', profile:<distill-ready profile>|null,
//  thumbnailUrl}. Persisted across the index->storyboard navigation.
let moodboardReferences = [];
// 3D reconstruction jobs (index.html #reconstruct-module). Each entry:
// {reconId, name, kindHint:'auto'|'photo'|'panorama', state:'reconstructing'
//  |'ready'|'error', profile:<viewer profile>|null, expanded, teardown}.
let reconstructItems = [];
// The 1-3 sentence rationale the distillation returned for its suggested
// mode/techniques (see runDistillMoodboard) - surfaced in renderMovieEditor.
let distilledStyleRationale = '';

// The last moodboard distillation result ({recommended, alternatives,
// suggested_mode, suggested_techniques, style_rationale}) - cached + persisted
// so a storyboard.html reload re-renders the suggestion from it instead of
// firing a fresh (slow, non-deterministic) LLM call every refresh.
let lastDistillResult = null;

// Runtime-only state for narration drafts shown in the pre-accept arc
// suggestion. The generated text itself is stored on each arc part (and is
// therefore persisted with lastDistillResult); loading/error state stays out
// of the saved session so a refresh never restores a stale spinner.
const arcNarrationPendingParts = new WeakSet();
const arcNarrationFailedParts = new WeakSet();
let arcNarrationGeneration = 0;
//#endregion

