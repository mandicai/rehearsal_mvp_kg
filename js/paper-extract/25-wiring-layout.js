//#region --- WIRING / LAYOUT REARRANGEMENT
const fileInput = document.getElementById('paper-file-input');
const extractBtn = document.getElementById('extract-paper-btn');
const statusEl = document.getElementById('paper-status');
const resultsEl = document.getElementById('paper-sections');
const storyboardArcModuleEl = document.getElementById('storyboard-arc-module');
const mediaBankModuleEl = document.getElementById('media-bank-module');
const sourceMaterialModuleEl = document.getElementById('source-material-module');
const deletedScenesModuleEl = document.getElementById('deleted-scenes-module');
const moodboardSummaryModuleEl = document.getElementById('moodboard-summary-module');
const moodboardSummaryListEl = document.getElementById('moodboard-summary-list');
const deletedScenesListEl = document.getElementById('deleted-scenes-list');
const sidebarStackEl = document.getElementById('storyboard-sidebar');
const togglePanelsBtn = document.getElementById('toggle-panels-btn');
const recordMediaAudioBtn = document.getElementById('record-media-audio-btn');
const recordMediaVideoBtn = document.getElementById('record-media-video-btn');
const mediaBankVideoPreviewEl = document.getElementById('media-bank-video-preview');
const uploadMediaInput = document.getElementById('upload-media-input');
const mediaBankStatusEl = document.getElementById('media-bank-status');
const mediaBankListEl = document.getElementById('media-bank-list');
const sourceMaterialListEl = document.getElementById('source-material-list');
// The "Render MP4" button + its status live in the storyboard heading row now
// (built per-render in renderMovieEditor, next to "Clear all scenes"), not in
// a fixed panel - so these are reassigned each render rather than queried once.
// The finished file is served from premiere_exports/<id>/documentary.mp4 and
// exposed as a Download MP4 link after the background render completes.
let renderMovieBtn = null;
let renderMovieStatusEl = null;

// Record Audio - same getUserMedia/MediaRecorder toggle pattern as
// index.html's Record Your Intent button (see recordIntentBtn above), but
// uploads into the open-ended media-bank list instead of the one fixed
// intent-narration slot.
let mediaAudioStream = null;
let mediaAudioRecorder = null;
if (recordMediaAudioBtn) {
  recordMediaAudioBtn.addEventListener('click', async () => {
    if (mediaAudioRecorder && mediaAudioRecorder.state === 'recording') {
      mediaAudioRecorder.stop();
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      mediaBankStatusEl.textContent = `Could not access microphone: ${err.message}`;
      mediaBankStatusEl.classList.add('error');
      return;
    }
    mediaAudioStream = stream;
    const chunks = [];
    mediaAudioRecorder = new MediaRecorder(stream);
    const mimeType = mediaAudioRecorder.mimeType || 'audio/webm';
    mediaAudioRecorder.addEventListener('dataavailable', event => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    mediaAudioRecorder.addEventListener('stop', () => {
      mediaAudioStream.getTracks().forEach(track => track.stop());
      recordMediaAudioBtn.textContent = 'Record audio';
      const extensionMatch = /audio\/([a-z0-9]+)/i.exec(mimeType);
      const extension = extensionMatch ? extensionMatch[1] : 'webm';
      const blob = new Blob(chunks, { type: mimeType });
      const file = new File([blob], `media-audio-${Date.now()}.${extension}`, { type: mimeType });
      addMediaBankItem('audio', `Audio recording - ${new Date().toLocaleTimeString()}`, file);
    });
    mediaAudioRecorder.start();
    recordMediaAudioBtn.textContent = 'Stop Recording';
    mediaBankStatusEl.textContent = 'Recording audio - click again to stop.';
    mediaBankStatusEl.classList.remove('error');
  });
}

// Record Video - same webcam-recording pattern as buildSectionBlock's own
// "Record Webcam" button (see recordBtn there), but with a standalone live
// preview element (#media-bank-video-preview) instead of taking over a
// shot card's visual box, since this isn't tied to any one shot.
let mediaVideoStream = null;
let mediaVideoRecorder = null;
if (recordMediaVideoBtn) {
  recordMediaVideoBtn.addEventListener('click', async () => {
    if (mediaVideoRecorder && mediaVideoRecorder.state === 'recording') {
      mediaVideoRecorder.stop();
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (err) {
      mediaBankStatusEl.textContent = `Could not access camera: ${err.message}`;
      mediaBankStatusEl.classList.add('error');
      return;
    }
    mediaVideoStream = stream;
    mediaBankVideoPreviewEl.srcObject = stream;
    mediaBankVideoPreviewEl.style.display = '';

    const chunks = [];
    mediaVideoRecorder = new MediaRecorder(stream);
    // See buildSectionBlock's own webcamMimeType comment - not necessarily
    // webm (e.g. Safari produces video/mp4), so this has to be read back
    // rather than assumed, or the saved file gets labeled with the wrong
    // extension and silently fails to play back later.
    const mediaVideoMimeType = mediaVideoRecorder.mimeType || 'video/webm';
    mediaVideoRecorder.addEventListener('dataavailable', event => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    mediaVideoRecorder.addEventListener('stop', () => {
      mediaVideoStream.getTracks().forEach(track => track.stop());
      mediaBankVideoPreviewEl.style.display = 'none';
      mediaBankVideoPreviewEl.srcObject = null;
      recordMediaVideoBtn.textContent = 'Record Video';
      const extensionMatch = /video\/([a-z0-9]+)/i.exec(mediaVideoMimeType);
      const extension = extensionMatch ? extensionMatch[1] : 'webm';
      const blob = new Blob(chunks, { type: mediaVideoMimeType });
      const file = new File([blob], `media-video-${Date.now()}.${extension}`, { type: mediaVideoMimeType });
      addMediaBankItem('video', `Video recording - ${new Date().toLocaleTimeString()}`, file);
    });
    mediaVideoRecorder.start();
    recordMediaVideoBtn.textContent = 'Stop Recording';
    mediaBankStatusEl.textContent = 'Recording video - click again to stop.';
    mediaBankStatusEl.classList.remove('error');
  });
}

// Upload File - either an audio or video file from disk, kind inferred
// from its own MIME type rather than a separate audio/video picker.
if (uploadMediaInput) {
  uploadMediaInput.addEventListener('change', () => {
    const file = uploadMediaInput.files[0];
    if (!file) return;
    const kind = file.type.startsWith('video/') ? 'video' : 'audio';
    addMediaBankItem(kind, file.name, file);
    uploadMediaInput.value = '';
  });
}

function setStatus(message, isError) {
  statusEl.textContent = message || '';
  statusEl.classList.toggle('error', !!isError);
}

// Both write into the sticky action bar (see renderMovieEditor) - kept as
// state, not just a live DOM write, because a successful generation
// re-renders that whole bar (fresh status-line elements) before the "Done"
// message is set; renderMovieEditor reads this state to populate them.
function setStoryboardStatus(message, isError) {
  storyboardBarStatus = { message: message || '', isError: !!isError };
  const el = document.querySelector('.action-bar .storyboard-status-line');
  if (el) {
    el.textContent = storyboardBarStatus.message;
    el.classList.toggle('error', storyboardBarStatus.isError);
  }
}

function setEditPlanStatus(message, isError) {
  editPlanBarStatus = { message: message || '', isError: !!isError };
  const el = document.querySelector('.action-bar .edit-plan-status-line');
  if (el) {
    el.textContent = editPlanBarStatus.message;
    el.classList.toggle('error', editPlanBarStatus.isError);
  }
}

function setRenderMovieStatus(message, isError) {
  if (!renderMovieStatusEl) return; // heading row not built (e.g. index.html)
  renderMovieStatusEl.textContent = message || '';
  renderMovieStatusEl.classList.toggle('error', !!isError);
}

// extractBtn only exists on index.html, while both pages load this shared
// script, so its wiring is guarded on storyboard.html.
if (extractBtn) extractBtn.addEventListener('click', runExtraction);
// Selecting a paper is the upload action on index.html. Start extraction
// immediately; the file picker can be used again to retry with another file.
if (fileInput) fileInput.addEventListener('change', () => {
  if (extractBtn?.disabled || !fileInput.files?.[0]) return;
  runExtraction();
});
// The "Render MP4" button is built + wired per-render in the storyboard
// heading row (see renderMovieEditor), so there's no fixed element to wire here.

// Moves the "Suggested narrative arc" module (#storyboard-arc-module) into
// the dedicated left sidebar once an arc's been accepted (see
// runAcceptArc/restoreDebugSession), freeing the main column for the
// arranged view - stays interactive there (see renderArcSuggestion) so the
// presenter can still switch arcs afterward. Always inserted first (see
// relocateMediaBankToSidebar/relocateSourceMaterialToSidebar below, which
// always appendChild - i.e. add last) so this stays above them regardless
// of relocation order. insertBefore(el, null) (an empty sidebar) degrades
// to appendChild anyway, and moving a node to right before itself is a
// harmless no-op, so this is safe to call again on every subsequent
// accept/restore.
function setupSidebarModuleCollapse(moduleEl) {
  if (!moduleEl || moduleEl.dataset.sidebarCollapseReady === 'true') return;
  // Use direct children rather than a selector rooted at :scope so this also
  // works in the embedded browser used by the desktop app.
  const heading = Array.from(moduleEl.children).find(child => child.tagName === 'H2');
  if (!heading) return;

  const moduleId = moduleEl.id || `sidebar-module-${Date.now()}`;
  const header = document.createElement('div');
  header.className = 'sidebar-module-header';
  header.setAttribute('role', 'heading');
  header.setAttribute('aria-level', '2');

  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'premiere-timeline-collapse-btn sidebar-module-collapse-btn';
  collapseBtn.addEventListener('click', () => {
    sidebarModuleCollapsed[moduleId] = !sidebarModuleCollapsed[moduleId];
    updateSidebarModuleCollapse(moduleEl, collapseBtn, heading);
    saveDebugSession();
    collapseBtn.blur();
  });

  heading.parentNode.insertBefore(header, heading);
  header.appendChild(heading);
  header.appendChild(collapseBtn);
  // Put every other module child behind one explicit body element. Using the
  // native `hidden` property makes collapse reliable even when a module's
  // list renderer applies its own display/flex styles (as Source material and
  // Deleted source and scenes do).
  const body = document.createElement('div');
  body.className = 'sidebar-module-body';
  while (header.nextSibling) body.appendChild(header.nextSibling);
  moduleEl.appendChild(body);
  moduleEl._sidebarModuleBodyEl = body;
  moduleEl.dataset.sidebarCollapseReady = 'true';
  moduleEl.dataset.sidebarModuleId = moduleId;
  updateSidebarModuleCollapse(moduleEl, collapseBtn, heading);
}

function setupAllSidebarModuleCollapses() {
  if (!sidebarStackEl) return;
  sidebarStackEl.querySelectorAll('.module-card--in-sidebar').forEach(setupSidebarModuleCollapse);
}

function updateSidebarModuleCollapse(moduleEl, collapseBtn, heading) {
  if (!moduleEl || !collapseBtn) return;
  const moduleId = moduleEl.dataset.sidebarModuleId || moduleEl.id;
  const collapsed = !!sidebarModuleCollapsed[moduleId];
  moduleEl.classList.toggle('sidebar-module-collapsed', collapsed);
  if (moduleEl._sidebarModuleBodyEl) moduleEl._sidebarModuleBodyEl.hidden = collapsed;
  const action = collapsed ? 'Expand' : 'Collapse';
  const label = heading ? heading.textContent.trim() : 'panel';
  collapseBtn.textContent = collapsed ? '▾' : '▴';
  collapseBtn.title = `${action} ${label}`;
  collapseBtn.setAttribute('aria-label', `${action} ${label}`);
  collapseBtn.setAttribute('aria-expanded', String(!collapsed));
}

function relocateArcSuggestionToSidebar() {
  if (!sidebarStackEl || !storyboardArcModuleEl) return;
  storyboardArcModuleEl.classList.add('module-card--in-sidebar');
  setupSidebarModuleCollapse(storyboardArcModuleEl);
  sidebarStackEl.insertBefore(storyboardArcModuleEl, sidebarStackEl.firstChild);
}

// Moves "Your media" (#media-bank-module) and "Source material"
// (#source-material-module) into the same sidebar, underneath
// #storyboard-arc-module - both start hidden in .main-column (see
// html/storyboard.html) and only ever appear once an arc's been accepted,
// not before (there was nothing arranged yet to record media for or
// compare against source material). Called alongside
// relocateArcSuggestionToSidebar at both its call sites.
function relocateMediaBankToSidebar() {
  if (!sidebarStackEl || !mediaBankModuleEl) return;
  mediaBankModuleEl.classList.add('module-card--in-sidebar');
  setupSidebarModuleCollapse(mediaBankModuleEl);
  mediaBankModuleEl.style.display = '';
  sidebarStackEl.appendChild(mediaBankModuleEl);
}

function relocateSourceMaterialToSidebar() {
  if (!sidebarStackEl || !sourceMaterialModuleEl) return;
  sourceMaterialModuleEl.classList.add('module-card--in-sidebar');
  setupSidebarModuleCollapse(sourceMaterialModuleEl);
  sourceMaterialModuleEl.style.display = '';
  sidebarStackEl.appendChild(sourceMaterialModuleEl);
}

// Deleted scenes module (see renderDeletedScenesList) - moved into the same
// sidebar, but its visibility is left to renderDeletedScenesList (hidden when
// nothing's deleted), unlike the others which are always shown once relocated.
function relocateDeletedScenesToSidebar() {
  if (!sidebarStackEl || !deletedScenesModuleEl) return;
  deletedScenesModuleEl.classList.add('module-card--in-sidebar');
  setupSidebarModuleCollapse(deletedScenesModuleEl);
  sidebarStackEl.appendChild(deletedScenesModuleEl);
  renderDeletedScenesList();
}

// Read-only moodboard recap (see renderMoodboardSummaryList) - pinned to the
// TOP of the sidebar stack (inserted before the first child, so it sits above
// the arc panel and the other modules). Its own render toggles visibility
// (hidden when nothing analyzed).
function relocateMoodboardSummaryToSidebar() {
  if (!sidebarStackEl || !moodboardSummaryModuleEl) return;
  moodboardSummaryModuleEl.classList.add('module-card--in-sidebar');
  setupSidebarModuleCollapse(moodboardSummaryModuleEl);
  sidebarStackEl.insertBefore(moodboardSummaryModuleEl, sidebarStackEl.firstChild);
  // Editable moodboard (add/remove references re-distills - see
  // refreshSuggestionsFromMoodboard); renders the same cards moodboard.html uses.
  renderMoodboardList();
  refreshMoodboardStatusLine();
}

// Runs all relocations together (both call sites always wanted them all
// anyway) and reveals #toggle-panels-btn - there's nothing worth
// collapsing before the sidebar actually has content.
function relocateAllSidebarModules() {
  relocateArcSuggestionToSidebar();
  // "Your media" (#media-bank-module) is hidden for now - not relocated/
  // revealed (see storyboard.html). The one recorded-intent clip it held
  // moved into #storyboard-arc-module.
  relocateSourceMaterialToSidebar();
  relocateMoodboardSummaryToSidebar();
  relocateDeletedScenesToSidebar();
  // Final scan keeps cards such as Source material and Deleted source and
  // scenes wired even when their content was initially hidden or rendered
  // after the first relocation pass.
  setupAllSidebarModuleCollapses();
  if (sidebarStackEl) sidebarStackEl.classList.toggle('collapsed', sidebarPanelsCollapsed);
  if (togglePanelsBtn) {
    togglePanelsBtn.style.display = '';
    togglePanelsBtn.textContent = sidebarPanelsCollapsed ? 'Show setup' : 'Hide setup';
  }
}

// Collapses/expands #storyboard-arc-module + #media-bank-module +
// #source-material-module together, by hiding the one shared container
// they've all relocated into (see relocateAllSidebarModules) rather than
// each individually - #main-column (the same flex row's other child)
// naturally expands to fill the freed width, no extra rule needed for that
// side (see styles-index.css's .sidebar-stack.collapsed).
if (togglePanelsBtn) {
  togglePanelsBtn.addEventListener('click', () => {
    sidebarPanelsCollapsed = !sidebarPanelsCollapsed;
    sidebarStackEl.classList.toggle('collapsed', sidebarPanelsCollapsed);
    togglePanelsBtn.textContent = sidebarPanelsCollapsed ? 'Show setup' : 'Hide setup';
    saveDebugSession();
  });
}

// Collapsible left-side upload panel - purely a display toggle, no state
// beyond the CSS class (same pattern as presenter-view.js's upload sidebar).
const uploadSidebar = document.getElementById('upload-sidebar');
const uploadSidebarToggle = document.getElementById('upload-sidebar-toggle');

// Guarded - the toggle button is currently commented out in html/index.html;
// without this check, calling addEventListener on null here would throw
// and silently stop every top-level statement after it from running,
// including debug-session save/restore below.
if (uploadSidebarToggle) {
  uploadSidebarToggle.addEventListener('click', () => {
    const collapsed = uploadSidebar.classList.toggle('collapsed');
    uploadSidebarToggle.textContent = collapsed ? '«' : '»';
    uploadSidebarToggle.title = collapsed ? 'Expand' : 'Collapse';
  });
}
//#endregion

