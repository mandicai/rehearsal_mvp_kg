//#region SESSION CACHE
// --- Cross-page session persistence ---
// index.html and storyboard.html are two separate pages (see html/
// storyboard.html), so a real navigation between them clears all in-memory
// JS state. This is the bridge: saves the state either page might need to
// localStorage on every meaningful change, and restores it on every page
// load (see restoreDebugSession, called unconditionally at the bottom of
// this file on both pages) - not just a "reload to resume" dev convenience
// anymore, though it still doubles as that too (no server round-trip, no
// attempt to reconcile with a paper re-uploaded in another tab).
const DEBUG_SESSION_STORAGE_KEY = 'paperExtractDebugSession';
const PAPER_SNAPSHOT_ID_STORAGE_KEY = 'paperExtractSnapshotId';

// Set once "Clear saved session" is clicked, so the beforeunload handler
// below doesn't immediately re-save the (still in-memory) old state right
// back to localStorage on the very reload meant to clear it - that was the
// bug: clearDebugSession() removed the key, but saveDebugSession() ran
// again a moment later on unload and put it right back.
let debugSessionCleared = false;
let debugSessionSaveTimer = null;
let debugSessionSavePending = false;
let debugSessionSaveIdle = false;

function createPaperSnapshotId() {
  const raw = (window.crypto && typeof window.crypto.randomUUID === 'function')
    ? window.crypto.randomUUID().replaceAll('-', '')
    : `paper${Date.now()}${Math.random().toString(36).slice(2, 12)}`;
  return raw.slice(0, 100);
}

function ensurePaperSnapshotId() {
  if (paperSnapshotId) return paperSnapshotId;
  try {
    paperSnapshotId = localStorage.getItem(PAPER_SNAPSHOT_ID_STORAGE_KEY) || null;
  } catch (err) { /* private browsing/localStorage unavailable */ }
  if (!paperSnapshotId) paperSnapshotId = createPaperSnapshotId();
  try { localStorage.setItem(PAPER_SNAPSHOT_ID_STORAGE_KEY, paperSnapshotId); } catch (err) { }
  return paperSnapshotId;
}

function rotatePaperSnapshotId() {
  paperSnapshotId = createPaperSnapshotId();
  try { localStorage.setItem(PAPER_SNAPSHOT_ID_STORAGE_KEY, paperSnapshotId); } catch (err) { }
}

function queuePaperSnapshotSave() {
  if (debugSessionCleared) return;
  const hasSource = currentSections.length > 0 || moodboardReferences.some(ref => ref.sourceUrl);
  if (!hasSource) return;
  clearTimeout(paperSnapshotSaveTimer);
  paperSnapshotSaveTimer = setTimeout(() => {
    const payload = {
      snapshot_id: ensurePaperSnapshotId(),
      label: currentLabel,
      sections: currentSections.map(section => ({
        index: section.index,
        title: section.title,
        text: section.text,
        removed: !!section.removed,
      })),
      youtube_references: moodboardReferences
        .filter(ref => ref.sourceKind === 'youtube' && ref.sourceUrl)
        .map(ref => ({ title: ref.title, url: ref.sourceUrl })),
    };
    fetchSavePaperSnapshot(payload).catch(() => {
      // LocalStorage remains the immediate fallback when the backend is down.
    });
  }, 350);
}

function saveDebugSessionNow() {
  if (debugSessionCleared) return;
  try {
    syncActBoardLiveSceneSnapshots();
    localStorage.setItem(DEBUG_SESSION_STORAGE_KEY, JSON.stringify({
      currentLabel,
      currentSections,
      currentAssignments,
      currentArcSections,
      actBoardNodes,
      actBoardScenes,
      actBoardOpenSceneByAct,
      actBoardInitialScenesInitialized,
      actBoardInitialSceneActKeys: Array.from(actBoardInitialSceneActKeys),
      actBoardFirstArcAutoPopulationDone,
      sceneRemovalStateVersion: 1,
      recordedTranscript,
      // Moodboard references (plain data only - no DOM); the disk-backed
      // thumbnail_url/profile survive the index->storyboard navigation.
      moodboardReferences: moodboardReferences.map(r => ({
        refId: r.refId, sourceKind: r.sourceKind, title: r.title, sourceUrl: r.sourceUrl,
        note: r.note, state: r.state, profile: r.profile, thumbnailUrl: r.thumbnailUrl,
      })),
      distilledStyleRationale,
      lastDistillResult,
      actBoardSetupMode,
      selectedFocusStatements: Array.from(selectedFocusStatements),
      selectedTechniques: Array.from(selectedTechniques),
      selectedNarrationArc,
      recordedNarrationDurationSeconds,
      recordedNarrationExtension,
      persistedNarrationPreviewUrl,
      premiereProjectId,
      premiereTimelineCollapsed,
      sidebarModuleCollapsed: { ...sidebarModuleCollapsed },
      sidebarPanelsCollapsed,
      paperSnapshotId,
      // mediaBankItems deliberately not persisted - see its own comment,
      // just above where it's declared.
    }));
  } catch (err) {
    // Quota exceeded (large embedded figure images) or localStorage
    // unavailable (private browsing) - not worth failing the UI over.
  }
  queuePaperSnapshotSave();
}

// Session payloads can contain many scenes, node snapshots, and media
// metadata. Keep interaction handlers synchronous, but serialize once after
// the current burst during idle time instead of stringifying the full board on
// every keystroke/drag/selection.
function saveDebugSession() {
  if (debugSessionCleared) return;
  debugSessionSavePending = true;
  if (debugSessionSaveTimer) return;
  const flush = () => {
    debugSessionSaveTimer = null;
    debugSessionSaveIdle = false;
    if (!debugSessionSavePending) return;
    debugSessionSavePending = false;
    saveDebugSessionNow();
  };
  if (typeof requestIdleCallback === 'function') {
    debugSessionSaveIdle = true;
    debugSessionSaveTimer = requestIdleCallback(flush, { timeout: 500 });
  } else {
    debugSessionSaveIdle = false;
    debugSessionSaveTimer = setTimeout(flush, 250);
  }
}

function flushDebugSessionSave() {
  if (debugSessionSaveTimer) {
    if (debugSessionSaveIdle && typeof cancelIdleCallback === 'function') {
      try { cancelIdleCallback(debugSessionSaveTimer); } catch (err) { /* optional */ }
    }
    clearTimeout(debugSessionSaveTimer);
  }
  debugSessionSaveTimer = null;
  debugSessionSaveIdle = false;
  if (!debugSessionSavePending) return;
  debugSessionSavePending = false;
  saveDebugSessionNow();
}

function clearDebugSession() {
  debugSessionCleared = true;
  if (debugSessionSaveTimer) {
    if (debugSessionSaveIdle && typeof cancelIdleCallback === 'function') {
      try { cancelIdleCallback(debugSessionSaveTimer); } catch (err) { /* optional */ }
    }
    clearTimeout(debugSessionSaveTimer);
  }
  debugSessionSaveTimer = null;
  debugSessionSaveIdle = false;
  debugSessionSavePending = false;
  localStorage.removeItem(DEBUG_SESSION_STORAGE_KEY);
}

// Hydrates every plain (non-DOM) piece of state both pages might need -
// page-specific follow-up (which view to render, which controls to reveal)
// happens separately below, once for each page.
function restoreDebugSession() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(DEBUG_SESSION_STORAGE_KEY) || 'null');
  } catch (err) {
    return null;
  }
  // A presenter can now enter the documentary-reference step before a paper
  // is uploaded. Preserve that valid session shape (empty sections plus
  // moodboard references) instead of treating it as no session at all.
  if (!saved || !Array.isArray(saved.currentSections)) return null;
  if (saved.currentSections.length === 0 && !Array.isArray(saved.moodboardReferences)) return null;

  currentLabel = saved.currentLabel || '';
  currentSections = saved.currentSections;
  paperSnapshotId = saved.paperSnapshotId || null;
  premiereTimelineCollapsed = !!saved.premiereTimelineCollapsed;
  // One-time migration: blank placeholders created before the default
  // title changed from "New Section" to "New Scene" (see renderMovieEditor/
  // its "+ Add Section" button) are still sitting in old saved sessions
  // with the old title - narrativeOnly (see insertSection) safely scopes
  // this to just those, not a real paper section a researcher happened to
  // title "New Section" themselves.
  currentSections.forEach(section => {
    // Normalize the independently persisted storyboard-deletion state.
    section.sceneRemoved = !!section.sceneRemoved;
    if (section.narrativeOnly && section.title === 'New Section') section.title = 'New Scene';
    // Sound effects used to be modeled as a mutually-exclusive scene role.
    // They now underlay either visual role, so retain the selected audio but
    // return legacy SFX-only scenes to the default Primary lane.
    if (section.role === 'soundEffects') section.role = 'aRoll';
    if (section.selectedAudio) {
      const legacyDuration = Number(section.selectedAudio.durationSeconds || section.selectedAudio.duration);
      if (!section.selectedAudio.sourceDurationSeconds && legacyDuration > 0) {
        section.selectedAudio.sourceDurationSeconds = Number(section.selectedAudio.duration) || legacyDuration;
      }
      if (!section.selectedAudio.durationSeconds && legacyDuration > 0) {
        section.selectedAudio.durationSeconds = legacyDuration;
      }
      if (!Number.isFinite(Number(section.selectedAudio.trimStartSeconds))) {
        section.selectedAudio.trimStartSeconds = 0;
      }
      normalizeSelectedAudioSegment(section.selectedAudio);
    }
  });
  currentAssignments = saved.currentAssignments || {};
  currentArcSections = Array.isArray(saved.currentArcSections) ? saved.currentArcSections : [];
  actBoardNodes = (saved.actBoardNodes && typeof saved.actBoardNodes === 'object')
    ? saved.actBoardNodes
    : Object.create(null);
  actBoardScenes = (saved.actBoardScenes && typeof saved.actBoardScenes === 'object')
    ? saved.actBoardScenes
    : Object.create(null);
  actBoardOpenSceneByAct = (saved.actBoardOpenSceneByAct
    && typeof saved.actBoardOpenSceneByAct === 'object')
    ? saved.actBoardOpenSceneByAct
    : Object.create(null);
  actBoardInitialScenesInitialized = saved.actBoardInitialScenesInitialized != null
    ? !!saved.actBoardInitialScenesInitialized
    : Object.values(actBoardScenes).some(scenes => Array.isArray(scenes) && scenes.length > 0);
  actBoardInitialSceneActKeys = new Set(Array.isArray(saved.actBoardInitialSceneActKeys)
    ? saved.actBoardInitialSceneActKeys : []);
  // Sessions saved before the one-time first-arc bootstrap existed already
  // have an accepted arc marker; treat those as completed so a refresh cannot
  // unexpectedly generate a new set of nodes.
  actBoardFirstArcAutoPopulationDone = saved.actBoardFirstArcAutoPopulationDone != null
    ? !!saved.actBoardFirstArcAutoPopulationDone
    : !!saved.selectedNarrationArc;
  Object.entries(actBoardScenes).forEach(([actKey, scenes]) => {
    if (!Array.isArray(scenes)) {
      actBoardScenes[actKey] = [];
      return;
    }
    scenes.forEach(scene => {
      if (!scene || typeof scene !== 'object') return;
      if (!scene.id) scene.id = createActBoardSceneId();
      scene.actKey = scene.actKey || actKey;
      if (!Array.isArray(scene.nodeIds)) scene.nodeIds = [];
      if (!scene.title) scene.title = 'Board scene';
      if (scene.includeNarration == null) scene.includeNarration = true;
      if (scene.sequenceStartNodeId === undefined) scene.sequenceStartNodeId = null;
      if (!Number.isFinite(Number(scene.boardX))) scene.boardX = 0;
      if (!Number.isFinite(Number(scene.boardY))) scene.boardY = 0;
      if (!Number.isFinite(Number(scene.boardWidth))) scene.boardWidth = 220;
      if (!Number.isFinite(Number(scene.boardHeight))) scene.boardHeight = ACT_BOARD_DEFAULT_SCENE_HEIGHT;
      // Older sessions hid the framed board after clearing its live nodes.
      // Empty scene boards are now intentional drop targets, so migrate them
      // back to the canvas while retaining their snapshots for restoration.
      if (scene.hidden === true) scene.hidden = false;
      normalizeActBoardSceneMode(scene);
      actBoardInitialSceneActKeys.add(scene.actKey);
    });
  });
  // Migrate the first act-board prototype, which keyed footage cards by
  // entity name. The board now keeps the original narration fragment visible
  // on each footage card instead.
  Object.entries(actBoardNodes).forEach(([actKey, nodes]) => {
    if (!Array.isArray(nodes)) return;
    nodes.forEach(node => {
      if (node && !node.actKey) node.actKey = actKey;
      if (node && node.type === 'footage' && !node.fragment && node.entity) {
        node.fragment = node.entity;
      }
      if (node && node.type === 'footage') {
        // A stock download is a transient request; never restore a stale
        // in-progress marker after a refresh.
        delete node.downloadStatus;
        node.previousFootageNodeId = node.previousFootageNodeId || null;
        node.nextFootageNodeId = node.nextFootageNodeId || null;
        node.trimStartSeconds = Math.max(0, Number(node.trimStartSeconds) || 0);
        const selectedKey = String(node.selectedVisualKey || '');
        const selectedResult = selectedKey.startsWith('result-') && Array.isArray(node.results)
          ? node.results[node.selectedResultIndex || 0] : null;
        const selectedGenerated = selectedKey.startsWith('generated-') && Array.isArray(node.generatedOptions)
          ? node.generatedOptions[node.selectedGeneratedIndex || 0] : null;
        node.sourceDurationSeconds = Math.max(0, Number(node.sourceDurationSeconds)
          || Number(selectedResult?.duration_seconds || selectedResult?.duration)
          || Number(selectedGenerated?.duration_seconds || selectedGenerated?.duration)
          || (node.mediaKind === 'video' ? Number(node.durationSeconds) || 0 : 0));
        if (selectedGenerated?.kind === 'video'
          && node.timingWasManuallyAdjusted !== true
          && node.sourceDurationSeconds > 0) {
          node.trimStartSeconds = 0;
          node.durationSeconds = node.sourceDurationSeconds;
          node.durationWasSuggested = false;
        }
      }
      if (node && node.type === 'narration') {
        // Repair older saved recordings whose transcript text was persisted
        // without word separators even though Whisper returned word timing
        // metadata. Keep normal whitespace untouched.
        const repairedTranscript = actBoardTranscriptionText({
          text: node.transcript,
          words: node.transcriptWords,
        });
        if (repairedTranscript && repairedTranscript !== node.transcript) {
          node.transcript = repairedTranscript;
        }
        if (node.includeNarration == null) {
          const nodeScene = actBoardScenesForAct(actKey).find(scene =>
            scene?.id === node.sceneId || (scene?.nodeIds || []).includes(node.id));
          // Preserve the old scene-level choice once, then keep the setting
          // on the individual narration node from this point forward.
          node.includeNarration = nodeScene?.includeNarration !== false;
        }
        delete node.entities;
        // Object URLs are page-local and become invalid on refresh. Never let
        // an old serialized blob: URL win over the persisted server preview.
        delete node._nativePreviewUrl;
        delete node._nativeAudioUrl;
        delete node.audioBuffer;
        if (typeof node.audioPreviewUrl === 'string' && node.audioPreviewUrl.startsWith('blob:')) {
          delete node.audioPreviewUrl;
        }
      }
      if (node && node.type === 'audio') {
        node.audioKind = node.audioKind === 'music' ? 'music' : 'sound-effects';
        node.linkedToNodeId = node.linkedToNodeId || null;
        node.linkedToType = node.linkedToType || null;
        delete node._nativePreviewUrl;
        delete node._nativeAudioUrl;
        if (node.selectedAudio && typeof node.selectedAudio === 'object') {
          if (typeof node.selectedAudio.localPreviewUrl === 'string'
            && node.selectedAudio.localPreviewUrl.startsWith('blob:')) {
            delete node.selectedAudio.localPreviewUrl;
          }
          if (typeof node.selectedAudio.preview_url === 'string'
            && node.selectedAudio.preview_url.startsWith('blob:')) {
            delete node.selectedAudio.preview_url;
          }
        }
        if (typeof node.audioPreviewUrl === 'string' && node.audioPreviewUrl.startsWith('blob:')) {
          delete node.audioPreviewUrl;
        }
      }
    });
  });
  // Before sceneRemoved existed, "Clear all scenes" marked the shared source
  // objects as removed. Repair that legacy all-scenes-cleared shape once so a
  // refresh restores the paper library while keeping the storyboard empty.
  if (!saved.sceneRemovalStateVersion) {
    const legacyArranged = currentSections.filter(section => currentAssignments[section.index]);
    if (legacyArranged.length > 0 && legacyArranged.every(section => section.removed)) {
      legacyArranged.forEach(section => {
        section.removed = false;
        section.sceneRemoved = true;
      });
    }
  }
  recordedTranscript = saved.recordedTranscript || '';
  moodboardReferences = Array.isArray(saved.moodboardReferences) ? saved.moodboardReferences : [];
  distilledStyleRationale = saved.distilledStyleRationale || '';
  lastDistillResult = saved.lastDistillResult || null;
  actBoardSetupMode = DOCUMENTARY_MODES.some(mode => mode.key === saved.actBoardSetupMode)
    ? saved.actBoardSetupMode
    : (DOCUMENTARY_MODES.some(mode => mode.key === lastDistillResult?.suggested_mode)
      ? lastDistillResult.suggested_mode : null);
  selectedFocusStatements = new Set(Array.isArray(saved.selectedFocusStatements) ? saved.selectedFocusStatements : []);
  selectedTechniques = new Set(sanitizeDocumentaryTechniques(saved.selectedTechniques));
  // Also migrate per-scene technique lists from older sessions where a track
  // role could be stored as though it were a technique.
  currentSections.forEach(section => {
    section.techniques = sanitizeDocumentaryTechniques(section.techniques);
    // Runtime-only request state must never survive a saved session.
    delete section._generating;
    // Runtime audio decodes/object URLs must be rebuilt from the persisted
    // preview URL on refresh; older sessions may contain a serialized `{}`
    // where an AudioBuffer used to be.
    delete section.narrationAudioBuffer;
    if (Array.isArray(section.narrationClips)) {
      section.narrationClips.forEach(clip => {
        delete clip.audioBuffer;
        delete clip._nativePreviewUrl;
      });
    }
  });
  selectedNarrationArc = saved.selectedNarrationArc || null;
  syncAcceptedArcNarrationDrafts();
  recordedNarrationDurationSeconds = saved.recordedNarrationDurationSeconds || null;
  recordedNarrationExtension = saved.recordedNarrationExtension || 'webm';
  persistedNarrationPreviewUrl = saved.persistedNarrationPreviewUrl || null;
  premiereProjectId = saved.premiereProjectId || null;
  sidebarModuleCollapsed = (saved.sidebarModuleCollapsed && typeof saved.sidebarModuleCollapsed === 'object')
    ? { ...saved.sidebarModuleCollapsed }
    : Object.create(null);
  sidebarPanelsCollapsed = typeof saved.sidebarPanelsCollapsed === 'boolean'
    ? saved.sidebarPanelsCollapsed : true;
  // mediaBankItems deliberately left at its MEDIA_BANK_ASSET_DEFAULTS
  // initial value here - not restored from a saved session (see its own
  // comment, just above where it's declared).

  // A session saved before dynamic arcs existed has assignments but no
  // currentArcSections - reconstruct a best-effort arc from the distinct
  // act values present (order isn't guaranteed to match the original arc,
  // but this is a convenience fallback, not something worth failing over).
  if (currentArcSections.length === 0 && Object.keys(currentAssignments).length > 0) {
    const seen = new Set();
    Object.values(currentAssignments).forEach(act => seen.add(act));
    currentArcSections = Array.from(seen).map(name => ({ key: name, label: name, description: '' }));
  }

  return saved;
}

window.addEventListener('beforeunload', flushDebugSessionSave);
window.addEventListener('beforeunload', flushActBoardPersistentCacheWrite);

// Guarded - .upload-sidebar-body only exists on index.html.
const uploadSidebarBodyEl = document.querySelector('.upload-sidebar-body');
if (uploadSidebarBodyEl) {
  const clearSessionBtn = document.createElement('button');
  clearSessionBtn.type = 'button';
  clearSessionBtn.className = 'clear-debug-session-btn';
  clearSessionBtn.textContent = 'Clear saved session';
  clearSessionBtn.title = 'Forget the locally-saved session (see localStorage) so the next reload/navigation starts fresh';
  clearSessionBtn.addEventListener('click', () => {
    clearDebugSession();
    clearSessionBtn.disabled = true;
    clearSessionBtn.textContent = 'Cleared - reload to start fresh';
  });
  uploadSidebarBodyEl.appendChild(clearSessionBtn);
}

const restoredSession = restoreDebugSession();
const forceMoodboardDistill = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('distill') === '1';

if (restoredSession) {
  if (fileInput) {
    // --- index.html: restore the editable source-material feed and the
    // moodboard of reference documentaries (re-polling any that were still
    // analyzing when the page was left).
    if (currentSections.length) renderSectionFeed(resultsEl, currentLabel, currentSections);
    renderMoodboardList();
    refreshMoodboardStatusLine();
    moodboardReferences.forEach(r => {
      if (r.state === 'analyzing' && r.refId) pollMoodboardReference(r.refId);
    });
    updateComposeStoryboardVisibility();
    if (currentLabel) setStatus(`Restored "${currentLabel}" from your last session.`);
  } else if (document.body.classList.contains('moodboard-page')) {
    // --- moodboard.html: restore the separate documentary-reference step.
    // Keep analysis polling alive across a refresh/navigation, but do not
    // distill an arc here; that remains the responsibility of storyboard.html.
    renderMoodboardList();
    refreshMoodboardStatusLine();
    moodboardReferences.forEach(r => {
      if (r.state === 'analyzing' && r.refId) pollMoodboardReference(r.refId);
    });
  } else if (suggestArcsRowEl) {
    // --- storyboard.html: render the movie editor if an arc's already been
    // accepted (relocating the suggestion module into the sidebar to match).
    // The distillation is NOT re-run on reload - its result is cached in
    // lastDistillResult (persisted), so a refresh re-renders the suggestion
    // from cache rather than firing a fresh LLM call. A brand-new arrival with
    // ready references but no cache distills once.
    restorePersistedNarrationPlayback();
    renderMediaBankItems();
    // A presenter can now continue to the arc step while a documentary
    // reference is still being analyzed. Keep that background job alive on
    // this page too; once it becomes ready, the existing refresh hook can
    // distill the moodboard without requiring a detour back to setup.
    moodboardReferences.forEach(r => {
      if (r.state === 'analyzing' && r.refId) pollMoodboardReference(r.refId);
    });
    // Populates the underlying content even before an arc's accepted, so
    // it's ready the moment relocateSourceMaterialToSidebar reveals it
    // below (renderMovieEditor, called just below once an arc has been
    // accepted, refreshes it again from then on - see its own tail call).
    renderSourceMaterialList();
    const remaining = currentSections.filter(section => !section.removed);
    if (currentArcSections.length > 0) {
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      // Setup inputs are Act Board-first. The timeline's existing autofill
      // path remains available when its view is intentionally used, but a
      // refresh on the default Act Board must not start new timeline LLM work.
      if (storyboardView === 'timeline') autoSuggestNarrationForStoryboard();
      relocateAllSidebarModules();
    }
    const hasReadyMoodboard = moodboardReferences.some(r => r.state === 'ready');
    const cachedPaperOnly = lastDistillResult
      && (lastDistillResult.source === 'paper'
        // Older paper-only caches predate the explicit source marker.
        || (!lastDistillResult.source
          && !lastDistillResult.suggested_mode
          && !lastDistillResult.style_rationale
          && !(lastDistillResult.suggested_techniques || []).length));
    if (forceMoodboardDistill && hasReadyMoodboard) {
      // The moodboard page's Next step link explicitly requests this first
      // distillation, even if an older paper-only or cached arc exists.
      suggestArcsRowEl.style.display = '';
      runDistillMoodboard();
    } else if (lastDistillResult && !(hasReadyMoodboard && cachedPaperOnly)) {
      // Re-render the cached suggestion (no LLM call). mode/techniques were
      // restored from the session, so don't re-apply them here.
      suggestArcsRowEl.style.display = '';
      renderArcSuggestion(lastDistillResult.recommended, lastDistillResult.alternatives);
    } else if (hasReadyMoodboard) {
      suggestArcsRowEl.style.display = '';
      runDistillMoodboard();
    } else if (paperSectionsForArc().length || findAbstractText()) {
      // Moodboard references are optional; with an extracted paper, suggest
      // an arc immediately from its sections even when the moodboard is empty
      // or its references are still being analyzed.
      suggestArcsRowEl.style.display = '';
      runPaperArcSuggestion();
    } else if (currentArcSections.length === 0) {
      suggestArcsRowEl.style.display = '';
      suggestArcsStatusEl.textContent = 'Upload and extract a research paper, or add a reference documentary, to suggest an arc.';
    }
    if (forceMoodboardDistill && window.history?.replaceState) {
      // Keep a normal refresh cache-safe; only the explicit navigation from
      // the moodboard page should force a new distillation.
      const cleanUrl = `${window.location.pathname}${window.location.hash || ''}`;
      window.history.replaceState(null, '', cleanUrl);
    }
    // Keep the setup moodboard out of the storyboard page. The setup page
    // remains the place where references are edited and re-distilled.
    if (moodboardSummaryModuleEl && moodboardListEl) {
      moodboardSummaryModuleEl.style.display = 'none';
      renderMoodboardList();
      refreshMoodboardStatusLine();
    }
  }
}
// Initialize a fresh documentary-reference page as well. This is separate
// from the restored-session branch so an empty moodboard still has a usable
// status line and controls on first visit.
if (!restoredSession && document.body.classList.contains('moodboard-page') && moodboardListEl) {
  renderMoodboardList();
  refreshMoodboardStatusLine();
}
// Mirror an already-restored browser session into the quiet file-backed
// snapshot too, so an existing paper/YouTube reference is captured without
// requiring the presenter to make another edit first.
if (restoredSession) queuePaperSnapshotSave();
//#endregion
