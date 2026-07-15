// helper functions in helpers.js loaded before this
// --- shared state (populated across the upload -> record -> align ->
// objectives -> dependencies -> save flow) ---
let slides = [];               // [{slide_index, snapshot_image, start_time, end_time, start_seconds, end_seconds, transcript, transcript_segments}]
let activeIndex = 0;
let projectId = null;
let pptxFilename = null;

let slideActivations = [];     // [{slide_index, start_seconds}]
let audience = '';
let presentationObjectives = [];    // [string, ...]
let sectionsByRange = {};           // {"start-end": {start_slide_index, end_slide_index, objectives: [string, ...]}}
let currentSectionRange = null;     // {start_slide_index, end_slide_index} or null (nothing drag-selected yet)
let learningObjectivesBySlide = {}; // {slide_index: [string, ...]}
let dependencies = [];         // [{prerequisite_slide_index, dependent_slide_index}]

// Drag-to-select-a-section state (see the carousel wiring below): a plain
// click (mousedown+mouseup with no movement) still just selects that one
// slide via the existing click listener - this only engages once the
// pointer actually moves to a different thumbnail while held down.
let dragStartIndex = null;
let dragging = false;
let didDrag = false;

let mediaRecorder = null;
let audioChunks = [];
let recording = false;
let recordingStartMs = null;
let transcriptionResult = null;  // {text, words, duration}, set once /transcribe resolves
let totalDurationSeconds = null;

// --- slide carousel + transcript panel (same pattern as main.js/feedback.js/carta.js,
// just populated from the /ingest/pptx response instead of slides.json) ---
// This panel doubles as the alignment review/edit UI: start/end/transcript
// are editable inputs, scoped to whichever slide is currently selected,
// rather than a separate list-of-all-slides module.

function selectSlide(index) {
  activeIndex = index;
  const slide = slides[index];

  document.querySelectorAll('.slide-thumb').forEach((el, i) => {
    el.classList.toggle('active', i === index);
  });

  document.getElementById('slide-number').textContent = `Slide ${slide.slide_index}`;
  document.getElementById('panel-start-input').value = (slide.start_seconds ?? 0).toFixed(2);
  document.getElementById('panel-end-input').value = (slide.end_seconds ?? 0).toFixed(2);
  document.getElementById('panel-transcript-input').value = slide.transcript || '';

  const activeThumb = document.querySelectorAll('.slide-thumb')[index];
  if (activeThumb) {
    activeThumb.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }

  renderLearningObjectivesModule();
}

// Wired once (not per-slide): each listener reads/writes whichever slide is
// currently active at the moment the user types, mirroring the old
// per-row alignment-review listeners but scoped to the single visible slide.
document.getElementById('panel-start-input').addEventListener('input', e => {
  const slide = slides[activeIndex];
  slide.start_seconds = parseFloat(e.target.value) || 0;
  slide.start_time = formatSecondsAsTimestamp(slide.start_seconds);
});
document.getElementById('panel-end-input').addEventListener('input', e => {
  const slide = slides[activeIndex];
  slide.end_seconds = parseFloat(e.target.value) || 0;
  slide.end_time = formatSecondsAsTimestamp(slide.end_seconds);
});
document.getElementById('panel-transcript-input').addEventListener('input', e => {
  slides[activeIndex].transcript = e.target.value;
});

function renderCarousel() {
  const carousel = document.getElementById('carousel');
  carousel.innerHTML = '';

  slides.forEach((slide, i) => {
    const thumb = document.createElement('div');
    thumb.className = 'slide-thumb';
    thumb.innerHTML = `
      <img src="/${slide.snapshot_image}" alt="Slide ${slide.slide_index}" draggable="false">
      <div class="thumb-label">Slide ${slide.slide_index}</div>
    `;
    thumb.addEventListener('click', (e) => onSlideThumbClick(i, e));
    thumb.addEventListener('mousedown', () => onSlideThumbMouseDown(i));
    carousel.appendChild(thumb);
  });

  selectSlide(0);
}

// Clicking a thumb always selects it; while recording is active (see
// section 2), it also logs the slide-activation timestamp used for alignment.
// Shift+click is a second, click-only way to define a section (in addition
// to the drag-select below): it extends the range from whichever slide was
// already active to the shift-clicked one, mirroring the drag-select
// finalize logic in the mouseup listener further down.
function onSlideThumbClick(index, event) {
  if (event && event.shiftKey && slides.length > 0) {
    const loIndex = Math.min(activeIndex, index);
    const hiIndex = Math.max(activeIndex, index);
    currentSectionRange = { start_slide_index: slides[loIndex].slide_index, end_slide_index: slides[hiIndex].slide_index };
    highlightSectionRange(loIndex, hiIndex);
    renderSectionObjectives();
  }

  selectSlide(index);
  if (recording) {
    slideActivations.push({
      slide_index: slides[index].slide_index,
      start_seconds: (Date.now() - recordingStartMs) / 1000,
    });
  }
}

// --- Drag-to-select a section (range of slides) on the carousel ---
// Additive on top of the plain click handling above: mousedown starts
// tracking, mousemove (while held) only "counts" as a drag once the
// pointer reaches a different thumbnail, and mouseup finalizes the range.
// A plain click (no movement) never sets didDrag, so onSlideThumbClick's
// normal single-slide selection above is unaffected.

function onSlideThumbMouseDown(index) {
  dragStartIndex = index;
  dragging = true;
  didDrag = false;
}

function thumbIndexFromPoint(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  const thumb = el && el.closest('.slide-thumb');
  if (!thumb) return null;
  const index = Array.from(document.querySelectorAll('.slide-thumb')).indexOf(thumb);
  return index === -1 ? null : index;
}

function highlightSectionRange(loIndex, hiIndex) {
  document.querySelectorAll('.slide-thumb').forEach((el, i) => {
    el.classList.toggle('section-selected', i >= loIndex && i <= hiIndex);
  });
}

document.addEventListener('mousemove', e => {
  if (!dragging) return;
  const idx = thumbIndexFromPoint(e.clientX, e.clientY);
  if (idx === null) return;
  if (idx !== dragStartIndex) didDrag = true;
  highlightSectionRange(Math.min(dragStartIndex, idx), Math.max(dragStartIndex, idx));
});

document.addEventListener('mouseup', e => {
  if (!dragging) return;
  dragging = false;
  if (!didDrag) return;  // plain click - the existing click listener already handled slide selection

  const idx = thumbIndexFromPoint(e.clientX, e.clientY) ?? dragStartIndex;
  const loIndex = Math.min(dragStartIndex, idx);
  const hiIndex = Math.max(dragStartIndex, idx);
  currentSectionRange = { start_slide_index: slides[loIndex].slide_index, end_slide_index: slides[hiIndex].slide_index };
  renderSectionObjectives();
});

// Lets the presenter advance slides with the keyboard instead of clicking a
// thumbnail - handy while recording, since it keeps both hands free. Reuses
// onSlideThumbClick (not a copy of its logic) so this behaves exactly like
// clicking the equivalent thumbnail, including logging a slideActivations
// entry if a recording is in progress. Not gated on `recording` - works any
// time, same as clicking a thumbnail does.
document.addEventListener('keydown', e => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;  // don't hijack cursor movement while typing
  if (slides.length === 0) return;

  const newIndex = e.key === 'ArrowRight' ? activeIndex + 1 : activeIndex - 1;
  if (newIndex < 0 || newIndex >= slides.length) return;

  e.preventDefault();
  onSlideThumbClick(newIndex, null);
});

// Formats seconds as "HH:MM:SS.mmm", matching backend/ingest/align.py's
// seconds_to_timestamp (used here only for live display while editing).
function formatSecondsAsTimestamp(seconds) {
  seconds = Math.max(0, seconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const pad2 = n => String(n).padStart(2, '0');
  return `${pad2(hours)}:${pad2(minutes)}:${secs.toFixed(3).padStart(6, '0')}`;
}

function setModuleUnlocked(moduleId, unlocked) {
  document.getElementById(moduleId).classList.toggle('disabled', !unlocked);
}

function setStatus(elementId, message, isError) {
  const el = document.getElementById(elementId);
  el.textContent = message || '';
  el.classList.toggle('error', !!isError);
}

// --- 1. Upload slides ---

const pptxInput = document.getElementById('pptx-input');
const uploadPptxBtn = document.getElementById('upload-pptx-btn');

function uploadPptx() {
  const file = pptxInput.files[0];
  if (!file) {
    setStatus('pptx-upload-status', 'Please choose a .pptx file first.', true);
    return;
  }

  uploadPptxBtn.disabled = true;
  setStatus('pptx-upload-status', 'Uploading and rendering slides (this can take a little while for large decks)...');

  fetchIngestPptx(file)
    .then(data => {
      projectId = data.project_id;
      pptxFilename = file.name;
      slides = data.slides;
      renderCarousel();
      setStatus('pptx-upload-status', `Loaded ${data.slide_count} slide${data.slide_count === 1 ? '' : 's'}.`);
      setModuleUnlocked('transcript-source-module', true);
      // Audience/objectives/dependencies/save don't require an aligned
      // transcript to be usable, so they unlock as soon as there are real
      // slides to work with.
      setModuleUnlocked('audience-section', true);
      setModuleUnlocked('learning-objectives-module', true);
      setModuleUnlocked('dependencies-module', true);
      setModuleUnlocked('simulate-audience-module', true);
      setModuleUnlocked('save-module', true);
      renderDependencyGraph();
      uploadPptxBtn.disabled = false;
    })
    .catch(err => {
      setStatus('pptx-upload-status', err.message, true);
      uploadPptxBtn.disabled = false;
    });
}

uploadPptxBtn.addEventListener('click', uploadPptx);

// Collapsible right-side upload panel - purely a display toggle, no state
// beyond the CSS class, so collapsing/expanding never affects upload logic.
const uploadSidebar = document.getElementById('upload-sidebar');
const uploadSidebarToggle = document.getElementById('upload-sidebar-toggle');

uploadSidebarToggle.addEventListener('click', () => {
  const collapsed = uploadSidebar.classList.toggle('collapsed');
  uploadSidebarToggle.textContent = collapsed ? '«' : '»';
  uploadSidebarToggle.title = collapsed ? 'Expand' : 'Collapse';
});

// --- 4. Audience ---
// Single free-text field (unlike main.js's multi-chip target-audience
// list - a presentation has one intended audience here). No suggested-chip
// feature for now - just plain free text.

const audienceInputEl = document.getElementById('audience-input');
audienceInputEl.addEventListener('input', () => { audience = audienceInputEl.value.trim(); });

// --- 2. Record fresh: mic recording + click-to-tag slide activations ---
// Mirrors rehearsal_mvp's StepPresenter.vue (getUserMedia/MediaRecorder,
// candidate mimeType list) and its logSlide() timestamp-tagging idea, with
// the actual transcription proxied server-side (see /transcribe) instead of
// called directly from the browser.

const RECORDING_MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];

function pickSupportedMimeType() {
  return RECORDING_MIME_CANDIDATES.find(type => MediaRecorder.isTypeSupported(type)) || '';
}

function startRecording() {
  navigator.mediaDevices.getUserMedia({ audio: true })
    .then(stream => {
      const mimeType = pickSupportedMimeType();
      mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      audioChunks = [];
      slideActivations = [];

      mediaRecorder.addEventListener('dataavailable', e => {
        if (e.data && e.data.size > 0) audioChunks.push(e.data);
      });
      mediaRecorder.addEventListener('stop', () => {
        stream.getTracks().forEach(track => track.stop());
      });

      mediaRecorder.start(250);
      recording = true;
      recordingStartMs = Date.now();
      slideActivations.push({ slide_index: slides[activeIndex].slide_index, start_seconds: 0 });

      document.getElementById('start-recording-btn').style.display = 'none';
      document.getElementById('stop-recording-btn').style.display = '';
      setStatus('recording-status', 'Recording... click a slide thumbnail each time you move on to it.');
    })
    .catch(err => {
      setStatus('recording-status', `Could not access the microphone: ${err.message}`, true);
    });
}

function stopRecording() {
  totalDurationSeconds = (Date.now() - recordingStartMs) / 1000;
  const mimeType = mediaRecorder.mimeType || 'audio/webm';

  mediaRecorder.addEventListener('stop', () => {
    recording = false;
    document.getElementById('start-recording-btn').style.display = '';
    document.getElementById('stop-recording-btn').style.display = 'none';

    const audioBlob = new Blob(audioChunks, { type: mimeType });
    setStatus('recording-status', 'Transcribing...');

    fetchTranscription(audioBlob, `recording.${mimeType.split('/')[1].split(';')[0]}`)
      .then(result => {
        transcriptionResult = result;
        setStatus('recording-status', 'Transcribed. Aligning...');
        onTranscriptReady();
      })
      .catch(err => {
        setStatus('recording-status', err.message, true);
      });
  }, { once: true });

  mediaRecorder.stop();
}

document.getElementById('start-recording-btn').addEventListener('click', startRecording);
document.getElementById('stop-recording-btn').addEventListener('click', stopRecording);

// Called once a recording has produced a transcriptionResult and
// slideActivations/totalDurationSeconds are set - runs /align, then
// refreshes the transcript panel above (selectSlide) with the newly
// aligned start/end/transcript for whichever slide is currently showing.
// transcriptionResult.words is always empty (this proxy's transcription
// path has no per-word timestamps - see transcription.py), so `text` is
// sent too as the fallback /align falls through to for a proportional split.
function onTranscriptReady() {
  fetchAlignment({
    slide_activations: slideActivations,
    total_duration_seconds: totalDurationSeconds,
    words: transcriptionResult.words,
    text: transcriptionResult.text,
  })
    .then(data => {
      mergeAlignmentIntoSlides(data.slides);
      setStatus('recording-status', 'Aligned. Review each slide in the panel above.');
      selectSlide(activeIndex);
    })
    .catch(err => {
      setStatus('recording-status', err.message, true);
    });
}

function mergeAlignmentIntoSlides(alignedSlides) {
  const byIndex = {};
  alignedSlides.forEach(s => { byIndex[s.slide_index] = s; });
  slides = slides.map(slide => {
    const aligned = byIndex[slide.slide_index];
    return aligned ? Object.assign({}, slide, aligned) : slide;
  });
}

// --- 5. Learning objectives: presentation / section / slide scopes ---
// All three reuse the same .chip.target/.remove-x add/remove markup
// (originally main.js's target-audience pattern); each scope also gets a
// "Suggest" button that calls the real /learning_objectives/suggest LLM
// route and renders results as two labeled rows of click-to-add
// .chip.suggested chips (instructor-style objectives, and what the stated
// audience would want to know) - either row adds into the same underlying
// objectives list for that scope.
//
// Objectives are {id, text} objects, not bare strings: the new
// objective-dependency graph further down needs a stable identity per
// objective (independent of its text, which can be edited/duplicated) to
// use as graph nodes.

let objectiveIdCounter = 0;
function nextObjectiveId() {
  objectiveIdCounter += 1;
  return `obj-${objectiveIdCounter}`;
}

function chipListRender(containerId, items, emptyHint, onRemove) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';

  if (items.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'audience-empty-hint';
    hint.textContent = emptyHint;
    container.appendChild(hint);
    return;
  }

  items.forEach(item => {
    const chip = document.createElement('span');
    chip.className = 'chip target';
    chip.innerHTML = `<span>${item.text}</span><span class="remove-x">×</span>`;
    chip.querySelector('.remove-x').addEventListener('click', () => onRemove(item));
    container.appendChild(chip);
  });
}

function addUnique(list, rawText) {
  const text = rawText.trim();
  if (!text) return list;
  if (list.some(o => o.text.toLowerCase() === text.toLowerCase())) return list;
  return [...list, { id: nextObjectiveId(), text }];
}

// The label only appears once there are actual suggestions to show - if
// texts is empty (nothing suggested yet, or a scope with no results), the
// container is left completely empty rather than showing a bare label.
function renderSuggestedChipRow(containerId, label, texts, onAdd) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  if (texts.length === 0) return;

  const labelEl = document.createElement('div');
  labelEl.className = 'audience-section-label';
  labelEl.textContent = label;
  container.appendChild(labelEl);

  texts.forEach(text => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip suggested';
    chip.textContent = `+ ${text}`;
    chip.addEventListener('click', () => onAdd(text));
    container.appendChild(chip);
  });
}

// Shared "Suggest" flow: POSTs to /learning_objectives/suggest and renders
// the response as two labeled rows of suggested chips the presenter can
// click to add - objectiveSuggestedContainerId for instructor-style
// objectives, audienceSuggestedContainerId for what the audience would
// want to know. Both call the same onAdd(text).
function suggestObjectives(scopeLabel, slidesForScope, statusElId, objectiveSuggestedContainerId, audienceSuggestedContainerId, onAdd) {
  if (!audience) {
    setStatus(statusElId, 'Please enter an audience first (see the Audience module above).', true);
    return;
  }

  setStatus(statusElId, 'Asking the LLM for suggestions...');

  fetchSuggestObjectives(audience, scopeLabel, slidesForScope)
    .then(data => {
      setStatus(statusElId, '');
      renderSuggestedChipRow(objectiveSuggestedContainerId, 'Suggested objectives:', data.objectives || [], onAdd);
      renderSuggestedChipRow(audienceSuggestedContainerId, 'What your audience might want to know:', data.audience_questions || [], onAdd);
    })
    .catch(err => setStatus(statusElId, err.message, true));
}

function renderLearningObjectivesModule() {
  renderPresentationObjectives();
  renderSectionObjectives();
  renderSlideObjectives();
}

// -- 5a. Presentation-level --

function renderPresentationObjectives() {
  chipListRender('presentation-objectives-list', presentationObjectives,
    'No presentation-wide learning objectives yet.',
    item => {
      presentationObjectives = presentationObjectives.filter(o => o.id !== item.id);
      renderPresentationObjectives();
    });
  // No renderObjectiveDependencyGraph() call here - presentation-wide
  // objectives are intentionally excluded from that graph (see getAllObjectiveNodes).
}

function addPresentationObjective(rawText) {
  presentationObjectives = addUnique(presentationObjectives, rawText);
  renderPresentationObjectives();
}

const presentationObjectiveInput = document.getElementById('presentation-objective-input');
document.getElementById('add-presentation-objective-btn').addEventListener('click', () => {
  addPresentationObjective(presentationObjectiveInput.value);
  presentationObjectiveInput.value = '';
});
presentationObjectiveInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    addPresentationObjective(presentationObjectiveInput.value);
    presentationObjectiveInput.value = '';
  }
});
document.getElementById('suggest-presentation-objective-btn').addEventListener('click', () => {
  if (slides.length === 0) return;
  suggestObjectives(
    'the entire presentation',
    slides.map(s => ({ slide_index: s.slide_index, transcript: s.transcript || '' })),
    'presentation-objectives-status',
    'presentation-objectives-suggested',
    'presentation-audience-questions-suggested',
    addPresentationObjective
  );
});

// -- 5b. Section-level (drag-selected range, see the carousel wiring above) --

function sectionKey(range) {
  return `${range.start_slide_index}-${range.end_slide_index}`;
}

function getOrCreateSection(range) {
  const key = sectionKey(range);
  if (!sectionsByRange[key]) {
    sectionsByRange[key] = { start_slide_index: range.start_slide_index, end_slide_index: range.end_slide_index, objectives: [] };
  }
  return sectionsByRange[key];
}

function renderSectionObjectives() {
  const label = document.getElementById('current-section-label');
  const editor = document.getElementById('section-editor');

  if (!currentSectionRange) {
    label.textContent = 'No section selected yet - drag across slide thumbnails above to select a range.';
    editor.style.display = 'none';
  } else {
    const section = getOrCreateSection(currentSectionRange);
    label.textContent = `Editing objectives for Slides ${section.start_slide_index}-${section.end_slide_index}`;
    editor.style.display = '';
    chipListRender('section-objectives-list', section.objectives,
      'No learning objectives yet for this section.',
      item => {
        section.objectives = section.objectives.filter(o => o.id !== item.id);
        renderSectionObjectives();
      });
  }

  renderAllSectionsList();
  renderObjectiveDependencyGraph();
}

function renderAllSectionsList() {
  const container = document.getElementById('all-sections-list');
  container.innerHTML = '';
  const currentKey = currentSectionRange ? sectionKey(currentSectionRange) : null;

  Object.entries(sectionsByRange).forEach(([key, section]) => {
    if (key === currentKey || section.objectives.length === 0) return;  // current section is already shown above
    const row = document.createElement('div');
    row.className = 'dependency-edge-row';
    row.innerHTML = `<span>Slides ${section.start_slide_index}-${section.end_slide_index}: ${section.objectives.map(o => o.text).join(', ')}</span>`;
    container.appendChild(row);
  });
}

function addSectionObjective(rawText) {
  if (!currentSectionRange) return;
  const section = getOrCreateSection(currentSectionRange);
  section.objectives = addUnique(section.objectives, rawText);
  renderSectionObjectives();
}

const sectionObjectiveInput = document.getElementById('section-objective-input');
document.getElementById('add-section-objective-btn').addEventListener('click', () => {
  addSectionObjective(sectionObjectiveInput.value);
  sectionObjectiveInput.value = '';
});
sectionObjectiveInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    addSectionObjective(sectionObjectiveInput.value);
    sectionObjectiveInput.value = '';
  }
});
document.getElementById('suggest-section-objective-btn').addEventListener('click', () => {
  if (!currentSectionRange) return;
  const { start_slide_index, end_slide_index } = currentSectionRange;
  const scopeSlides = slides
    .filter(s => s.slide_index >= start_slide_index && s.slide_index <= end_slide_index)
    .map(s => ({ slide_index: s.slide_index, transcript: s.transcript || '' }));
  suggestObjectives(
    `slides ${start_slide_index}-${end_slide_index}`,
    scopeSlides,
    'section-objectives-status',
    'section-objectives-suggested',
    'section-audience-questions-suggested',
    addSectionObjective
  );
});

// -- 5c. Slide-level (scoped to the currently selected slide) --

function renderSlideObjectives() {
  if (slides.length === 0) return;
  const slide = slides[activeIndex];
  document.getElementById('current-slide-label').textContent = `Objectives for Slide ${slide.slide_index}`;
  const objectives = learningObjectivesBySlide[slide.slide_index] || [];
  chipListRender('objectives-list', objectives,
    'No learning objectives yet for this slide.',
    item => {
      learningObjectivesBySlide[slide.slide_index] = objectives.filter(o => o.id !== item.id);
      renderSlideObjectives();
    });
  renderObjectiveDependencyGraph();
}

function addLearningObjective(rawText) {
  if (slides.length === 0) return;
  const slideIndex = slides[activeIndex].slide_index;
  const objectives = learningObjectivesBySlide[slideIndex] || [];
  learningObjectivesBySlide[slideIndex] = addUnique(objectives, rawText);
  renderSlideObjectives();
}

const objectiveInput = document.getElementById('objective-input');
const addObjectiveBtn = document.getElementById('add-objective-btn');

addObjectiveBtn.addEventListener('click', () => {
  addLearningObjective(objectiveInput.value);
  objectiveInput.value = '';
});
objectiveInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    addLearningObjective(objectiveInput.value);
    objectiveInput.value = '';
  }
});
document.getElementById('suggest-objective-btn').addEventListener('click', () => {
  if (slides.length === 0) return;
  const slide = slides[activeIndex];
  suggestObjectives(
    `slide ${slide.slide_index}`,
    [{ slide_index: slide.slide_index, transcript: slide.transcript || '' }],
    'objectives-status',
    'objectives-suggested',
    'slide-audience-questions-suggested',
    addLearningObjective
  );
});

// --- 6. Dependencies: learning-objective graph (primary) + slide graph
// (secondary, auto-populated from the objective graph but still directly
// editable) ---
// Both reuse the same generic force-directed rendering (layoutForceGraph
// from helpers.js unmodified; SVG curved edges + arrowhead marker +
// parallel-edge offsetting via helpers.js's edgePairKey), factored into one
// shared renderDependencyStyleGraph() so the two graphs aren't ~80 lines of
// duplicated SVG-building code.

function renderDependencyStyleGraph(containerId, nodes, edges, options) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  if (nodes.length === 0) return;

  edges.forEach(e => { e.sourceNode = nodes[e.source]; e.targetNode = nodes[e.target]; });

  const ASPECT = 1.8;
  const area = Math.max(560 * 300, nodes.length * 9000);
  const wrapPxHeight = Math.max(260, Math.sqrt(area / ASPECT));
  const wrapPxWidth = Math.max(560, wrapPxHeight * ASPECT);
  const HEIGHT = 100;
  const WIDTH = HEIGHT * ASPECT;
  layoutForceGraph(nodes, edges, WIDTH, HEIGHT, 300);

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

  const markerId = `${containerId}-arrow`;
  const defs = document.createElementNS(svgNS, 'defs');
  const marker = document.createElementNS(svgNS, 'marker');
  marker.setAttribute('id', markerId);
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
    path.setAttribute('marker-end', `url(#${markerId})`);
    svg.appendChild(path);
  });

  wrap.appendChild(svg);

  nodes.forEach(node => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `graph-node ${options.nodeClass}`;
    if (options.isPendingSource && options.isPendingSource(node)) {
      btn.classList.add('pending-source');
    }
    btn.textContent = node.label;
    btn.title = node.title || node.label;
    btn.style.left = `${(node.x / WIDTH) * 100}%`;
    btn.style.top = `${(node.y / HEIGHT) * 100}%`;
    if (node.id !== undefined) btn.dataset.nodeId = node.id;
    if (options.onNodeClick) btn.addEventListener('click', () => options.onNodeClick(node));
    if (options.onNodeMouseDown) btn.addEventListener('mousedown', () => options.onNodeMouseDown(node));
    wrap.appendChild(btn);
  });

  scroll.appendChild(wrap);
  container.appendChild(scroll);
}

// -- 6a. Slide dependencies (unchanged interaction: click prerequisite slide, then dependent slide) --

let addingDependencyMode = false;
let pendingDependencySourceIndex = null; // array index into `slides`, not slide_index

function toggleAddDependencyMode() {
  addingDependencyMode = !addingDependencyMode;
  pendingDependencySourceIndex = null;
  const btn = document.getElementById('add-dependency-btn');
  btn.textContent = addingDependencyMode ? 'Cancel' : 'Add Dependency Edge';
  btn.classList.toggle('active', addingDependencyMode);
  setStatus('dependency-graph-status', addingDependencyMode
    ? 'Click the prerequisite slide, then the slide that depends on it.' : '');
  renderDependencyGraph();
}

function onDependencyNodeClick(index) {
  if (!addingDependencyMode) return;

  if (pendingDependencySourceIndex === null) {
    pendingDependencySourceIndex = index;
    setStatus('dependency-graph-status', `Selected Slide ${slides[index].slide_index} as the prerequisite - now click the slide that depends on it.`);
    renderDependencyGraph();
    return;
  }

  if (pendingDependencySourceIndex === index) {
    pendingDependencySourceIndex = null;  // clicking the same node again cancels that selection
    setStatus('dependency-graph-status', 'Click the prerequisite slide, then the slide that depends on it.');
    renderDependencyGraph();
    return;
  }

  const prerequisiteSlideIndex = slides[pendingDependencySourceIndex].slide_index;
  const dependentSlideIndex = slides[index].slide_index;
  const exists = dependencies.some(d =>
    d.prerequisite_slide_index === prerequisiteSlideIndex && d.dependent_slide_index === dependentSlideIndex);
  if (!exists) {
    dependencies.push({ prerequisite_slide_index: prerequisiteSlideIndex, dependent_slide_index: dependentSlideIndex });
  }

  addingDependencyMode = false;
  pendingDependencySourceIndex = null;
  const btn = document.getElementById('add-dependency-btn');
  btn.textContent = 'Add Dependency Edge';
  btn.classList.remove('active');
  setStatus('dependency-graph-status', exists ? 'That dependency already exists.' : 'Dependency added.');
  renderDependencyGraph();
}

function removeDependency(dep) {
  dependencies = dependencies.filter(d => d !== dep);
  renderDependencyGraph();
}

function renderDependencyEdgeList() {
  const list = document.getElementById('dependency-edge-list');
  list.innerHTML = '';
  dependencies.forEach(dep => {
    const row = document.createElement('div');
    row.className = 'dependency-edge-row';
    row.innerHTML = `<span>Slide ${dep.prerequisite_slide_index} → Slide ${dep.dependent_slide_index}</span><span class="remove-x">×</span>`;
    row.querySelector('.remove-x').addEventListener('click', () => removeDependency(dep));
    list.appendChild(row);
  });
}

function renderDependencyGraph() {
  renderDependencyEdgeList();
  if (slides.length === 0) {
    document.getElementById('dependency-graph').innerHTML = '';
    return;
  }

  const nodes = slides.map((slide, i) => ({ label: `Slide ${slide.slide_index}`, index: i }));
  const edges = dependencies
    .map(dep => ({
      source: slides.findIndex(s => s.slide_index === dep.prerequisite_slide_index),
      target: slides.findIndex(s => s.slide_index === dep.dependent_slide_index),
    }))
    .filter(e => e.source !== -1 && e.target !== -1);

  renderDependencyStyleGraph('dependency-graph', nodes, edges, {
    nodeClass: 'graph-node-slide',
    isPendingSource: node => addingDependencyMode && pendingDependencySourceIndex === node.index,
    onNodeClick: node => onDependencyNodeClick(node.index),
  });
}

document.getElementById('add-dependency-btn').addEventListener('click', toggleAddDependencyMode);

// -- 6b. Learning-objective dependencies (new, primary) --
// Nodes = every section-level and slide-level objective (getAllObjectiveNodes).
// Presentation-wide objectives are deliberately excluded from this graph -
// since they'd map to every slide, linking one created a dense cross-product
// of derived edges in the Slide Dependencies graph below, which was too much
// visual clutter for too little signal. Linking two objectives additively
// derives the corresponding slide-to-slide edges above
// (deriveSlideDependenciesFromObjectives), based on which slide(s) each
// objective belongs to - it never removes a slide edge, even if the
// objective link that produced it is later deleted, since slide edges
// aren't tagged with which link (if any) created them.

let objectiveDependencies = []; // [{prerequisite_objective_id, dependent_objective_id}]

// Drag-to-link: mousedown on a node starts a drag, mouseup on a *different*
// node creates the edge (prerequisite -> dependent). Mirrors the carousel's
// drag-select-a-section gesture (onSlideThumbMouseDown/thumbIndexFromPoint).
let objectiveDragSourceId = null;
let objectiveDragging = false;
let objectiveDidDrag = false;

// Flattens every section-level and slide-level objective into {id, text,
// scope, slideIndices} - the slides each objective "belongs to" (the
// range's slides for a section, the one slide for a slide-level objective).
// Presentation-wide objectives are intentionally left out - see the comment above.
function getAllObjectiveNodes() {
  const nodes = [];

  Object.values(sectionsByRange).forEach(section => {
    const slideIndices = slides
      .filter(s => s.slide_index >= section.start_slide_index && s.slide_index <= section.end_slide_index)
      .map(s => s.slide_index);
    section.objectives.forEach(obj => {
      nodes.push({ id: obj.id, text: obj.text, scope: 'section', slideIndices });
    });
  });

  Object.entries(learningObjectivesBySlide).forEach(([slideIndexStr, objectives]) => {
    const slideIndex = parseInt(slideIndexStr, 10);
    objectives.forEach(obj => {
      nodes.push({ id: obj.id, text: obj.text, scope: 'slide', slideIndices: [slideIndex] });
    });
  });

  return nodes;
}

// Like getAllObjectiveNodes(), but for js/simulate-audience.js - which
// (unlike the dependency graph) DOES track presentation-wide objectives,
// each mapped to every slide in the deck.
function getAllObjectiveNodesForAssessment() {
  const nodes = getAllObjectiveNodes();
  if (slides.length > 0) {
    const allSlideIndices = slides.map(s => s.slide_index);
    presentationObjectives.forEach(obj => {
      nodes.push({ id: obj.id, text: obj.text, scope: 'presentation', slideIndices: allSlideIndices });
    });
  }
  return nodes;
}

function objectiveNodeLabel(node) {
  const prefix = node.scope === 'section'
    ? `S${node.slideIndices[0]}-${node.slideIndices[node.slideIndices.length - 1]}: `
    : `Slide ${node.slideIndices[0]}: `;
  const text = node.text.length > 24 ? `${node.text.slice(0, 22)}…` : node.text;
  return prefix + text;
}

// Additive: for every current objective dependency, cross-products the
// prerequisite's slides against the dependent's slides and adds any
// missing slide-to-slide edge (skipping same-slide pairs). Safe to call
// repeatedly - never removes anything.
function deriveSlideDependenciesFromObjectives() {
  const nodesById = {};
  getAllObjectiveNodes().forEach(n => { nodesById[n.id] = n; });

  objectiveDependencies.forEach(dep => {
    const prereqNode = nodesById[dep.prerequisite_objective_id];
    const dependentNode = nodesById[dep.dependent_objective_id];
    if (!prereqNode || !dependentNode) return;

    prereqNode.slideIndices.forEach(prereqSlideIndex => {
      dependentNode.slideIndices.forEach(dependentSlideIndex => {
        if (prereqSlideIndex === dependentSlideIndex) return;
        const exists = dependencies.some(d =>
          d.prerequisite_slide_index === prereqSlideIndex && d.dependent_slide_index === dependentSlideIndex);
        if (!exists) {
          dependencies.push({ prerequisite_slide_index: prereqSlideIndex, dependent_slide_index: dependentSlideIndex });
        }
      });
    });
  });
}

function onObjectiveNodeMouseDown(node) {
  objectiveDragSourceId = node.id;
  objectiveDragging = true;
  objectiveDidDrag = false;
  setStatus('objective-dependency-graph-status', '');
  renderObjectiveDependencyGraph();
}

// Finds the objective node (by id) currently under the given point, if any -
// mirrors the carousel's thumbIndexFromPoint used for drag-select.
function objectiveNodeIdFromPoint(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  const btn = el && el.closest('#objective-dependency-graph .graph-node');
  return btn ? btn.dataset.nodeId : null;
}

document.addEventListener('mousemove', e => {
  if (!objectiveDragging) return;
  const hoverId = objectiveNodeIdFromPoint(e.clientX, e.clientY);
  if (hoverId && hoverId !== objectiveDragSourceId) objectiveDidDrag = true;
});

document.addEventListener('mouseup', e => {
  if (!objectiveDragging) return;
  objectiveDragging = false;
  const sourceId = objectiveDragSourceId;
  objectiveDragSourceId = null;
  const targetId = objectiveNodeIdFromPoint(e.clientX, e.clientY);

  if (!objectiveDidDrag || !targetId || targetId === sourceId) {
    renderObjectiveDependencyGraph();
    return;
  }

  const exists = objectiveDependencies.some(d =>
    d.prerequisite_objective_id === sourceId && d.dependent_objective_id === targetId);
  if (!exists) {
    objectiveDependencies.push({ prerequisite_objective_id: sourceId, dependent_objective_id: targetId });
    deriveSlideDependenciesFromObjectives();
  }

  setStatus('objective-dependency-graph-status', exists ? 'That dependency already exists.' : 'Dependency added - corresponding slide links added below.');
  renderObjectiveDependencyGraph();
  renderDependencyGraph();
});

function removeObjectiveDependency(dep) {
  objectiveDependencies = objectiveDependencies.filter(d => d !== dep);
  renderObjectiveDependencyGraph();
  // Deliberately does not remove any derived slide edges - see the comment
  // above this section for why.
}

function renderObjectiveDependencyEdgeList() {
  const list = document.getElementById('objective-dependency-edge-list');
  list.innerHTML = '';
  const nodesById = {};
  getAllObjectiveNodes().forEach(n => { nodesById[n.id] = n; });

  objectiveDependencies.forEach(dep => {
    const prereq = nodesById[dep.prerequisite_objective_id];
    const dependent = nodesById[dep.dependent_objective_id];
    if (!prereq || !dependent) return;
    const row = document.createElement('div');
    row.className = 'dependency-edge-row';
    row.innerHTML = `<span>${objectiveNodeLabel(prereq)} → ${objectiveNodeLabel(dependent)}</span><span class="remove-x">×</span>`;
    row.querySelector('.remove-x').addEventListener('click', () => removeObjectiveDependency(dep));
    list.appendChild(row);
  });
}

function renderObjectiveDependencyGraph() {
  renderObjectiveDependencyEdgeList();
  const objectiveNodes = getAllObjectiveNodes();
  if (objectiveNodes.length === 0) {
    document.getElementById('objective-dependency-graph').innerHTML = '';
    return;
  }

  const nodes = objectiveNodes.map(o => ({ ...o, label: objectiveNodeLabel(o), title: o.text }));
  const idToIndex = {};
  nodes.forEach((n, i) => { idToIndex[n.id] = i; });
  const edges = objectiveDependencies
    .map(dep => ({ source: idToIndex[dep.prerequisite_objective_id], target: idToIndex[dep.dependent_objective_id] }))
    .filter(e => e.source !== undefined && e.target !== undefined);

  renderDependencyStyleGraph('objective-dependency-graph', nodes, edges, {
    nodeClass: 'graph-node-slide',
    isPendingSource: node => objectiveDragging && objectiveDragSourceId === node.id,
    onNodeMouseDown: node => onObjectiveNodeMouseDown(node),
  });
}

// -- 6c. Toggle between the two dependency views (only one visible at a time) --

function switchDependencyTab(tab) {
  const showObjective = tab === 'objective';
  document.getElementById('objective-deps-panel').style.display = showObjective ? '' : 'none';
  document.getElementById('slide-deps-panel').style.display = showObjective ? 'none' : '';
  document.getElementById('tab-objective-deps-btn').classList.toggle('active', showObjective);
  document.getElementById('tab-slide-deps-btn').classList.toggle('active', !showObjective);
}

document.getElementById('tab-objective-deps-btn').addEventListener('click', () => switchDependencyTab('objective'));
document.getElementById('tab-slide-deps-btn').addEventListener('click', () => switchDependencyTab('slide'));

// --- 6. Save ---

const saveProjectBtn = document.getElementById('save-project-btn');

function saveProject() {
  if (!projectId || slides.length === 0) {
    setStatus('save-status', 'Upload a deck first.', true);
    return;
  }
  if (!audience) {
    setStatus('save-status', 'Add an audience description first (see the Audience module).', true);
    return;
  }
  if (presentationObjectives.length === 0) {
    setStatus('save-status', 'Add at least one presentation-wide learning objective first (see the Learning Objectives module).', true);
    return;
  }

  const slidesWithObjectives = slides.map(slide => ({
    ...slide,
    learning_objectives: learningObjectivesBySlide[slide.slide_index] || [],
  }));

  saveProjectBtn.disabled = true;
  setStatus('save-status', 'Saving...');

  fetchSaveProject({
    project_id: projectId,
    pptx_filename: pptxFilename,
    transcript_source: 'recording',
    audience,
    learning_objectives: {
      presentation: presentationObjectives,
      sections: Object.values(sectionsByRange).filter(s => s.objectives.length > 0),
    },
    slides: slidesWithObjectives,
    dependencies,
    objective_dependencies: objectiveDependencies,
  })
    .then(data => {
      setStatus('save-status', `Saved to ${data.path}`);
      saveProjectBtn.disabled = false;
    })
    .catch(err => {
      setStatus('save-status', err.message, true);
      saveProjectBtn.disabled = false;
    });
}

saveProjectBtn.addEventListener('click', saveProject);

// --- TESTING ONLY: auto-load a pre-baked example project ---
// The presenter's own upload+record flow above is the real path; this just
// bootstraps collect-data.html with an already-aligned example (slides +
// transcript, no learning objectives/dependencies yet) so the objectives
// and dependency-graph features can be tested immediately, without an
// upload+recording round trip every time. Remove this block once real
// projects are being exercised end to end.
const EXAMPLE_PROJECT_DIR = 'presentation-examples/dog';

fetch(`/${EXAMPLE_PROJECT_DIR}/slides.json`)
  .then(res => res.json())
  .then(data => {
    projectId = 'dog-example';
    pptxFilename = 'Huskies_service_dog.pptx';
    slides = data.map(slide => ({ ...slide, snapshot_image: `${EXAMPLE_PROJECT_DIR}/${slide.snapshot_image}` }));
    renderCarousel();
    setStatus('pptx-upload-status', `Loaded example project (${slides.length} slides, already aligned).`);
    setModuleUnlocked('transcript-source-module', true);
    setModuleUnlocked('audience-section', true);
    setModuleUnlocked('learning-objectives-module', true);
    setModuleUnlocked('dependencies-module', true);
    setModuleUnlocked('simulate-audience-module', true);
    setModuleUnlocked('save-module', true);
    renderDependencyGraph();
  })
  .catch(err => {
    console.error('Could not auto-load example project:', err);
  });
