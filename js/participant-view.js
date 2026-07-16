// html/participant-view.html - a research-study tool where participants
// actually watch a presentation (slides + audio, auto-advancing together)
// start to finish, uninterrupted, then reflect on it afterward in their own
// words: main takeaways they'd feel comfortable explaining to a friend,
// which slides/transcript excerpts ("pieces") contributed to that
// understanding or were confusing, dependency links drawn between all of
// those, and Likert + open-response ratings of the presentation overall.
// Deliberately open-ended (no LLM-graded quiz) - the researcher-defined
// Learning Objectives module (Setup mode) still exists for context/scoping,
// but no longer generates a comprehension question or drives any runtime
// checkpoint.
//
// Two modes, toggled without a page reload:
// - Setup (#setup-view, researcher-facing): define objectives at all three
//   scopes (plain text, for reference only), upload the narration audio.
// - Participant (#participant-view): demographics, then the slide+audio
//   presentation played straight through, then the Reflection phase
//   described above.

const OBJECTIVES_STORAGE_KEY = 'calibrate-priors-objectives-v2';
const PARTICIPANTS_STORAGE_KEY = 'calibrate-priors-participants-v3';
const EXAMPLE_PROJECT_DIR = 'presentation-examples/dog';
const RATING_KEYS = ['informativeness', 'confusingness', 'understandability'];

function shorten(text) {
  return text.length > 26 ? `${text.slice(0, 26)}…` : text;
}

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function setStatus(elementId, message, isError) {
  const el = document.getElementById(elementId);
  el.textContent = message || '';
  el.classList.toggle('error', !!isError);
}

// --- Persistence (audio is deliberately NOT persisted - see module docstring) ---

function loadObjectivesState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(OBJECTIVES_STORAGE_KEY));
    if (parsed) return parsed;
  } catch (err) { /* fall through to defaults */ }
  return { presentationObjectives: [], sectionsByRange: {}, slideObjectives: {} };
}
function saveObjectives() {
  localStorage.setItem(OBJECTIVES_STORAGE_KEY, JSON.stringify({
    presentationObjectives, sectionsByRange, slideObjectives,
  }));
}

function loadParticipants() {
  try {
    return JSON.parse(localStorage.getItem(PARTICIPANTS_STORAGE_KEY)) || [];
  } catch (err) {
    return [];
  }
}
function saveParticipants() {
  localStorage.setItem(PARTICIPANTS_STORAGE_KEY, JSON.stringify(participants));
}

// --- State ---

let slides = [];
let activeIndex = 0;
let currentSectionRange = null;
let dragStartIndex = null;
let dragging = false;
let didDrag = false;

const initialObjectivesState = loadObjectivesState();
let presentationObjectives = initialObjectivesState.presentationObjectives;
let sectionsByRange = initialObjectivesState.sectionsByRange;
let slideObjectives = initialObjectivesState.slideObjectives;

let participants = loadParticipants();

let audioObjectUrl = null;
let currentParticipant = null;
let playerActiveIndex = 0;

// --- Reflection-phase state (participant mode only, reset per session) ---
let reflectionActiveSlideIndex = null; // which slide's transcript is shown in the reference panel
let pieceNoteDraft = null;             // { type, slide_index, excerpt } while the note form is open
let linkDragSourceId = null;   // set on node mousedown, cleared on mouseup, drives the drag-to-link gesture
let pendingLinkDraft = null;   // { from_id, to_id } while the predicate form is open

const presentationAudio = document.getElementById('presentation-audio');

// --- Carousel + drag-select-a-section (ported from js/presenter-view.js) ---

function selectSlide(index) {
  activeIndex = index;
  document.querySelectorAll('.slide-thumb').forEach((el, i) => {
    el.classList.toggle('active', i === index);
  });
  const activeThumb = document.querySelectorAll('.slide-thumb')[index];
  if (activeThumb) activeThumb.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  renderSlideObjectivesList();
}

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
    thumb.addEventListener('click', e => onSlideThumbClick(i, e));
    thumb.addEventListener('mousedown', () => onSlideThumbMouseDown(i));
    carousel.appendChild(thumb);
  });
  selectSlide(0);
}

function onSlideThumbClick(index, event) {
  if (event && event.shiftKey && slides.length > 0) {
    const loIndex = Math.min(activeIndex, index);
    const hiIndex = Math.max(activeIndex, index);
    currentSectionRange = { start_slide_index: slides[loIndex].slide_index, end_slide_index: slides[hiIndex].slide_index };
    highlightSectionRange(loIndex, hiIndex);
    renderSectionEditor();
  }
  selectSlide(index);
}

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
  if (!didDrag) return;
  const idx = thumbIndexFromPoint(e.clientX, e.clientY) ?? dragStartIndex;
  const loIndex = Math.min(dragStartIndex, idx);
  const hiIndex = Math.max(dragStartIndex, idx);
  currentSectionRange = { start_slide_index: slides[loIndex].slide_index, end_slide_index: slides[hiIndex].slide_index };
  renderSectionEditor();
});

// --- Objective scopes: helpers ---

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
// --- Shared objective row (reused across all three scopes) - just the
// objective text plus a remove-x, matching .dependency-edge-row elsewhere on
// this page, since there's no generated question to expand into anymore. ---

function buildObjectiveSetupRow(obj, onRemove) {
  const row = document.createElement('div');
  row.className = 'dependency-edge-row';
  const text = document.createElement('span');
  text.textContent = obj.text;
  const removeX = document.createElement('span');
  removeX.className = 'remove-x';
  removeX.textContent = '×';
  removeX.addEventListener('click', onRemove);
  row.appendChild(text);
  row.appendChild(removeX);
  return row;
}

// --- Scope 1: Entire Presentation ---

function addPresentationObjective() {
  const input = document.getElementById('presentation-objective-input');
  const text = input.value.trim();
  if (!text) {
    setStatus('add-presentation-objective-status', 'Enter an objective first.', true);
    return;
  }

  presentationObjectives.push({ id: makeId('obj'), text });
  saveObjectives();
  input.value = '';
  renderPresentationObjectivesList();
  setStatus('add-presentation-objective-status', '');
}
document.getElementById('add-presentation-objective-btn').addEventListener('click', addPresentationObjective);

function renderPresentationObjectivesList() {
  const list = document.getElementById('presentation-objectives-list');
  list.innerHTML = '';
  presentationObjectives.forEach(obj => {
    list.appendChild(buildObjectiveSetupRow(obj, () => {
      presentationObjectives = presentationObjectives.filter(o => o.id !== obj.id);
      saveObjectives();
      renderPresentationObjectivesList();
    }));
  });
}

// --- Scope 2: Section of Slides ---

function renderSectionEditor() {
  const label = document.getElementById('current-section-label');
  const editor = document.getElementById('section-editor');
  if (!currentSectionRange) {
    label.textContent = 'No section selected yet - drag across slide thumbnails above to select a range.';
    editor.style.display = 'none';
    return;
  }
  label.textContent = `Section: Slide ${currentSectionRange.start_slide_index}-${currentSectionRange.end_slide_index}`;
  editor.style.display = '';
  renderSectionObjectivesList();
}

function addSectionObjective() {
  if (!currentSectionRange) return;
  const input = document.getElementById('section-objective-input');
  const text = input.value.trim();
  if (!text) {
    setStatus('add-section-objective-status', 'Enter an objective first.', true);
    return;
  }

  const section = getOrCreateSection(currentSectionRange);
  section.objectives.push({ id: makeId('obj'), text });
  saveObjectives();
  input.value = '';
  renderSectionObjectivesList();
  setStatus('add-section-objective-status', '');
}
document.getElementById('add-section-objective-btn').addEventListener('click', addSectionObjective);

function renderSectionObjectivesList() {
  const list = document.getElementById('section-objectives-list');
  list.innerHTML = '';
  if (currentSectionRange) {
    const section = sectionsByRange[sectionKey(currentSectionRange)];
    if (section) {
      section.objectives.forEach(obj => {
        list.appendChild(buildObjectiveSetupRow(obj, () => {
          section.objectives = section.objectives.filter(o => o.id !== obj.id);
          saveObjectives();
          renderSectionObjectivesList();
          renderAllSectionsList();
        }));
      });
    }
  }
  renderAllSectionsList();
}

function renderAllSectionsList() {
  const list = document.getElementById('all-sections-list');
  list.innerHTML = '';
  Object.values(sectionsByRange).forEach(section => {
    if (section.objectives.length === 0) return;
    const row = document.createElement('div');
    row.className = 'dependency-edge-row';
    row.innerHTML = `<span>Slides ${section.start_slide_index}-${section.end_slide_index}: ${section.objectives.map(o => o.text).join(', ')}</span>`;
    list.appendChild(row);
  });
}

// --- Scope 3: Single Slide ---

function addSlideObjective() {
  const slide = slides[activeIndex];
  if (!slide) return;
  const input = document.getElementById('slide-objective-input');
  const text = input.value.trim();
  if (!text) {
    setStatus('add-slide-objective-status', 'Enter an objective first.', true);
    return;
  }

  if (!slideObjectives[slide.slide_index]) slideObjectives[slide.slide_index] = [];
  slideObjectives[slide.slide_index].push({ id: makeId('obj'), text });
  saveObjectives();
  input.value = '';
  renderSlideObjectivesList();
  setStatus('add-slide-objective-status', '');
}
document.getElementById('add-slide-objective-btn').addEventListener('click', addSlideObjective);

function renderSlideObjectivesList() {
  const slide = slides[activeIndex];
  document.getElementById('current-slide-label').textContent = slide ? `Objectives for Slide ${slide.slide_index}` : '';

  const list = document.getElementById('slide-objectives-list');
  list.innerHTML = '';
  if (!slide) return;
  const objs = slideObjectives[slide.slide_index] || [];
  objs.forEach(obj => {
    list.appendChild(buildObjectiveSetupRow(obj, () => {
      slideObjectives[slide.slide_index] = slideObjectives[slide.slide_index].filter(o => o.id !== obj.id);
      saveObjectives();
      renderSlideObjectivesList();
    }));
  });
}

// --- Audio upload (session-only, never persisted) ---

document.getElementById('audio-upload-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
  audioObjectUrl = URL.createObjectURL(file);
  setStatus('audio-upload-status', `Loaded: ${file.name}`);
});

// --- Mode switching ---

function switchToParticipantMode() {
  if (slides.length === 0) {
    setStatus('start-session-status', 'Deck failed to load - reload the page.', true);
    return;
  }
  document.getElementById('setup-view').style.display = 'none';
  document.getElementById('participant-view').style.display = '';
  resetParticipantView();
}
document.getElementById('start-participant-mode-btn').addEventListener('click', switchToParticipantMode);

function switchToSetupMode() {
  presentationAudio.pause();
  document.getElementById('participant-view').style.display = 'none';
  document.getElementById('setup-view').style.display = '';
  renderParticipantCountStatus();
  renderAggregateTable();
  renderParticipantsList();
}
document.getElementById('back-to-setup-btn').addEventListener('click', switchToSetupMode);

function resetParticipantView() {
  document.getElementById('demo-age-input').value = '';
  document.getElementById('demo-education-input').value = '';
  document.getElementById('demo-field-input').value = '';
  document.getElementById('demo-familiarity-input').value = '';
  document.getElementById('interview-worked-input').value = '';
  document.getElementById('interview-confusing-input').value = '';
  document.getElementById('interview-understanding-input').value = '';
  document.getElementById('interview2-presented-input').value = '';
  document.getElementById('interview2-feedback-input').value = '';
  document.getElementById('presentation-player-module').style.display = 'none';
  document.getElementById('reflection-module').style.display = 'none';
  currentParticipant = null;
  showPreStep(0);
}

// --- Pre-presentation step navigation: Welcome -> Demographics -> Interview
// Questions -> More Intro Questions -> Familiarity, with Back/Next arrows via
// a single shared nav bar (only one step div is ever visible, so one bar
// reused across all of them is simpler than duplicating Back/Next controls
// per step). ---

const PRE_PRESENTATION_STEPS = ['welcome-module', 'demographics-module', 'interview-module', 'interview-module-2', 'familiarity-module'];
let preStepIndex = 0;

function showPreStep(index) {
  preStepIndex = index;
  PRE_PRESENTATION_STEPS.forEach((id, i) => {
    document.getElementById(id).style.display = i === index ? '' : 'none';
  });
  document.getElementById('pre-nav').style.display = '';
  document.getElementById('pre-nav-back-btn').style.display = index === 0 ? 'none' : '';
  document.getElementById('pre-nav-next-btn').textContent = index === 0 ? 'Begin'
    : index === PRE_PRESENTATION_STEPS.length - 1 ? 'Begin Presentation →'
    : 'Next →';
  setStatus('pre-nav-status', '');
}

function validatePreStep(index) {
  const stepId = PRE_PRESENTATION_STEPS[index];
  if (stepId === 'demographics-module') {
    const age = document.getElementById('demo-age-input').value;
    const education = document.getElementById('demo-education-input').value;
    const field = document.getElementById('demo-field-input').value.trim();
    if (!age || !education || !field) return 'Please answer all three questions first.';
  }
  if (stepId === 'familiarity-module') {
    if (!document.getElementById('demo-familiarity-input').value) return 'Please answer this question first.';
    if (!audioObjectUrl) return 'Presentation audio isn’t loaded yet - ask the researcher to check Setup.';
  }
  return null;
}

function goToNextPreStep() {
  const error = validatePreStep(preStepIndex);
  if (error) {
    setStatus('pre-nav-status', error, true);
    return;
  }
  if (preStepIndex === PRE_PRESENTATION_STEPS.length - 1) {
    beginPresentation();
    return;
  }
  showPreStep(preStepIndex + 1);
}
document.getElementById('pre-nav-next-btn').addEventListener('click', goToNextPreStep);

function goToPrevPreStep() {
  if (preStepIndex === 0) return;
  showPreStep(preStepIndex - 1);
}
document.getElementById('pre-nav-back-btn').addEventListener('click', goToPrevPreStep);

// --- Participant: pre-presentation steps -> start ---

function beginPresentation() {
  currentParticipant = {
    participant_id: makeId('p'),
    timestamp: new Date().toISOString(),
    demographics: {
      age_range: document.getElementById('demo-age-input').value,
      education: document.getElementById('demo-education-input').value,
      field: document.getElementById('demo-field-input').value.trim(),
      familiarity: document.getElementById('demo-familiarity-input').value,
    },
    interview: {
      talk_that_worked: document.getElementById('interview-worked-input').value.trim(),
      talk_that_confused: document.getElementById('interview-confusing-input').value.trim(),
      what_determines_understanding: document.getElementById('interview-understanding-input').value.trim(),
      presented_talk_topic_and_audience: document.getElementById('interview2-presented-input').value.trim(),
      presented_talk_feedback: document.getElementById('interview2-feedback-input').value.trim(),
    },
    takeaways: [],
    pieces: [],
    links: [],
    ratings: { informativeness: null, confusingness: null, understandability: null, flow_feedback: '', comments: '' },
  };

  PRE_PRESENTATION_STEPS.forEach(id => { document.getElementById(id).style.display = 'none'; });
  document.getElementById('pre-nav').style.display = 'none';
  document.getElementById('presentation-player-module').style.display = '';
  document.getElementById('reflection-module').style.display = 'none';

  updatePlayerSlide(0);
  presentationAudio.src = audioObjectUrl;
  presentationAudio.currentTime = 0;
}

function updatePlayerSlide(index) {
  playerActiveIndex = index;
  const slide = slides[index];
  document.getElementById('player-slide-display').innerHTML =
    `<img src="/${slide.snapshot_image}" alt="Slide ${slide.slide_index}" style="max-width: 100%; border-radius: 8px;">`;
  document.getElementById('player-progress').textContent = `Slide ${index + 1} of ${slides.length}`;
}

// --- Audio-driven auto-advance (no checkpoints - presentation plays straight through) ---

presentationAudio.addEventListener('timeupdate', () => {
  if (!currentParticipant) return;
  const currentSlide = slides[playerActiveIndex];
  if (!currentSlide || currentSlide.end_seconds == null) return;
  if (presentationAudio.currentTime >= currentSlide.end_seconds && playerActiveIndex < slides.length - 1) {
    updatePlayerSlide(playerActiveIndex + 1);
  }
});

presentationAudio.addEventListener('ended', () => {
  if (!currentParticipant) return;
  enterReflectionPhase();
});

function finalizeSession() {
  participants.push(currentParticipant);
  saveParticipants();
  presentationAudio.pause();
  resetParticipantView();
  setStatus('pre-nav-status', 'Thanks! Your responses have been recorded. Ready for a new participant.');
}

// --- Reflection phase: reference panel (slide picker + selectable transcript) ---

function enterReflectionPhase() {
  presentationAudio.pause();
  document.getElementById('presentation-player-module').style.display = 'none';
  document.getElementById('reflection-module').style.display = '';

  reflectionActiveSlideIndex = null;
  pieceNoteDraft = null;
  linkDragSourceId = null;
  pendingLinkDraft = null;
  clearLinkDragLine();
  hideSelectionTagPopup();

  document.getElementById('reflection-transcript').textContent = '';
  document.getElementById('piece-note-form').style.display = 'none';
  document.getElementById('link-predicate-form').style.display = 'none';
  document.getElementById('rating-flow-feedback-input').value = '';
  document.getElementById('rating-comments-input').value = '';

  renderReflectionCarousel();
  renderTakeawaysList();
  renderPiecesLists();
  renderLinkGraph();
  renderLikertRows();
  setStatus('reflection-status', '');
}

function renderReflectionCarousel() {
  const carousel = document.getElementById('reflection-carousel');
  carousel.innerHTML = '';
  slides.forEach(slide => {
    const thumb = document.createElement('div');
    thumb.className = 'slide-thumb';
    thumb.classList.toggle('active', slide.slide_index === reflectionActiveSlideIndex);
    thumb.innerHTML = `
      <img src="/${slide.snapshot_image}" alt="Slide ${slide.slide_index}" draggable="false">
      <div class="thumb-label">Slide ${slide.slide_index}</div>
    `;
    thumb.addEventListener('click', () => onReflectionSlideClick(slide));
    carousel.appendChild(thumb);
  });
}

function onReflectionSlideClick(slide) {
  reflectionActiveSlideIndex = slide.slide_index;
  document.getElementById('reflection-transcript').textContent = slide.transcript || '(No transcript for this slide.)';
  renderReflectionCarousel();
}

// --- Reflection phase: Main Takeaways ---

function addTakeaway() {
  const input = document.getElementById('takeaway-input');
  const text = input.value.trim();
  if (!text) {
    setStatus('add-takeaway-status', 'Enter a takeaway first.', true);
    return;
  }
  currentParticipant.takeaways.push({ id: makeId('takeaway'), text });
  input.value = '';
  setStatus('add-takeaway-status', '');
  renderTakeawaysList();
  renderLinkGraph();
}
document.getElementById('add-takeaway-btn').addEventListener('click', addTakeaway);

function buildRemovableRow(labelText, onRemove) {
  const row = document.createElement('div');
  row.className = 'dependency-edge-row';
  const label = document.createElement('span');
  label.textContent = labelText;
  const removeX = document.createElement('span');
  removeX.className = 'remove-x';
  removeX.textContent = '×';
  removeX.addEventListener('click', onRemove);
  row.appendChild(label);
  row.appendChild(removeX);
  return row;
}

function renderTakeawaysList() {
  const list = document.getElementById('takeaways-list');
  list.innerHTML = '';
  currentParticipant.takeaways.forEach(takeaway => {
    list.appendChild(buildRemovableRow(takeaway.text, () => {
      currentParticipant.takeaways = currentParticipant.takeaways.filter(t => t.id !== takeaway.id);
      currentParticipant.links = currentParticipant.links.filter(l => l.from_id !== takeaway.id && l.to_id !== takeaway.id);
      renderTakeawaysList();
      renderLinkGraph();
    }));
  });
}

// --- Reflection phase: Pieces (contributing / confusing) - tagged by
// highlighting: select transcript text and a floating popup offers to tag
// that excerpt, or use the always-visible "Tag This Slide as..." buttons to
// tag the whole currently-viewed slide. No mode to toggle first. ---

function beginPieceNote(type, slideIndex, excerpt) {
  pieceNoteDraft = { type, slide_index: slideIndex, excerpt };
  document.getElementById('piece-note-input').value = '';
  document.getElementById('piece-note-form').style.display = '';
  const quote = excerpt ? ` ("${shorten(excerpt)}")` : '';
  setStatus('piece-picker-status', `Tagged Slide ${slideIndex}${quote} as ${type}. Add an optional note and save.`);
}

document.getElementById('tag-slide-contributing-btn').addEventListener('click', () => {
  if (reflectionActiveSlideIndex == null) {
    setStatus('piece-picker-status', 'Click a slide first.', true);
    return;
  }
  beginPieceNote('contributing', reflectionActiveSlideIndex, null);
});
document.getElementById('tag-slide-confusing-btn').addEventListener('click', () => {
  if (reflectionActiveSlideIndex == null) {
    setStatus('piece-picker-status', 'Click a slide first.', true);
    return;
  }
  beginPieceNote('confusing', reflectionActiveSlideIndex, null);
});

// Floating popup shown near a text selection inside the transcript, built
// once here (not per-selection, unlike the transient link-drag line) since
// its two buttons need persistent click handlers.
const selectionTagPopup = document.createElement('div');
selectionTagPopup.className = 'selection-tag-popup';
selectionTagPopup.style.display = 'none';

const tagSelectionContributingBtn = document.createElement('button');
tagSelectionContributingBtn.type = 'button';
tagSelectionContributingBtn.className = 'btn-secondary';
tagSelectionContributingBtn.textContent = 'Tag as Contributing';
tagSelectionContributingBtn.addEventListener('click', () => tagCurrentSelection('contributing'));

const tagSelectionConfusingBtn = document.createElement('button');
tagSelectionConfusingBtn.type = 'button';
tagSelectionConfusingBtn.className = 'btn-secondary';
tagSelectionConfusingBtn.textContent = 'Tag as Confusing';
tagSelectionConfusingBtn.addEventListener('click', () => tagCurrentSelection('confusing'));

selectionTagPopup.appendChild(tagSelectionContributingBtn);
selectionTagPopup.appendChild(tagSelectionConfusingBtn);
document.body.appendChild(selectionTagPopup);

function showSelectionTagPopup(rect) {
  selectionTagPopup.style.display = '';
  selectionTagPopup.style.left = `${rect.left + rect.width / 2}px`;
  selectionTagPopup.style.top = `${rect.top - 8}px`;
}

function hideSelectionTagPopup() {
  selectionTagPopup.style.display = 'none';
}

function tagCurrentSelection(type) {
  const text = window.getSelection().toString().trim();
  hideSelectionTagPopup();
  if (!text || reflectionActiveSlideIndex == null) return;
  beginPieceNote(type, reflectionActiveSlideIndex, text);
}

document.getElementById('reflection-transcript').addEventListener('mouseup', () => {
  const text = window.getSelection().toString().trim();
  if (!text || reflectionActiveSlideIndex == null) {
    hideSelectionTagPopup();
    return;
  }
  showSelectionTagPopup(window.getSelection().getRangeAt(0).getBoundingClientRect());
});

document.addEventListener('mousedown', e => {
  if (selectionTagPopup.style.display !== 'none' && !selectionTagPopup.contains(e.target) && e.target.id !== 'reflection-transcript') {
    hideSelectionTagPopup();
  }
});

document.getElementById('save-piece-btn').addEventListener('click', () => {
  if (!pieceNoteDraft) return;
  currentParticipant.pieces.push({
    id: makeId('piece'),
    type: pieceNoteDraft.type,
    slide_index: pieceNoteDraft.slide_index,
    excerpt: pieceNoteDraft.excerpt,
    note: document.getElementById('piece-note-input').value.trim(),
  });
  pieceNoteDraft = null;
  document.getElementById('piece-note-form').style.display = 'none';
  setStatus('piece-picker-status', '');
  renderPiecesLists();
  renderLinkGraph();
});

document.getElementById('cancel-piece-btn').addEventListener('click', () => {
  pieceNoteDraft = null;
  document.getElementById('piece-note-form').style.display = 'none';
  setStatus('piece-picker-status', '');
});

function renderPiecesLists() {
  const contributingList = document.getElementById('contributing-pieces-list');
  const confusingList = document.getElementById('confusing-pieces-list');
  contributingList.innerHTML = '';
  confusingList.innerHTML = '';
  currentParticipant.pieces.forEach(piece => {
    const list = piece.type === 'contributing' ? contributingList : confusingList;
    const quote = piece.excerpt ? `: "${piece.excerpt}"` : '';
    const note = piece.note ? ` — ${piece.note}` : '';
    list.appendChild(buildRemovableRow(`Slide ${piece.slide_index}${quote}${note}`, () => {
      currentParticipant.pieces = currentParticipant.pieces.filter(p => p.id !== piece.id);
      currentParticipant.links = currentParticipant.links.filter(l => l.from_id !== piece.id && l.to_id !== piece.id);
      renderPiecesLists();
      renderLinkGraph();
    }));
  });
}

// --- Reflection phase: Link Them Together (reuses helpers.js's shared
// renderDependencyStyleGraph; click-drag from one node to another to link
// them - mousedown on the source via onNodeMouseDown, then a page-wide
// mouseup checks whatever's under the pointer via elementFromPoint, same
// pattern as the carousel's drag-to-select-a-section). ---

function reflectionGraphNodes() {
  const takeawayNodes = currentParticipant.takeaways.map(t => ({
    id: t.id, label: shorten(t.text), title: t.text, nodeClass: 'graph-node-takeaway',
  }));
  const pieceNodes = currentParticipant.pieces.map(p => {
    const short = p.excerpt || `Slide ${p.slide_index}`;
    const title = `Slide ${p.slide_index}${p.excerpt ? `: "${p.excerpt}"` : ''}${p.note ? ` — ${p.note}` : ''}`;
    const slide = slides.find(s => s.slide_index === p.slide_index);
    return {
      id: p.id, label: shorten(short), title,
      nodeClass: p.type === 'contributing' ? 'graph-node-piece-contributing' : 'graph-node-piece-confusing',
      imageSrc: slide ? `/${slide.snapshot_image}` : null,
    };
  });
  return [...takeawayNodes, ...pieceNodes];
}

function onLinkNodeMouseDown(node) {
  linkDragSourceId = node.id;
  renderLinkGraph();
}

// Drawn fresh on each mousemove while dragging - a `fixed`-positioned div
// stretched/rotated between the source node's current screen position and
// the cursor, so the participant can see the link forming before they drop it.
let linkDragLineEl = null;

function updateLinkDragLine(clientX, clientY) {
  const sourceEl = document.querySelector(`#link-graph .graph-node[data-node-id="${linkDragSourceId}"]`);
  if (!sourceEl) return;
  const rect = sourceEl.getBoundingClientRect();
  const x1 = rect.left + rect.width / 2;
  const y1 = rect.top + rect.height / 2;
  const dx = clientX - x1;
  const dy = clientY - y1;
  const length = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;

  if (!linkDragLineEl) {
    linkDragLineEl = document.createElement('div');
    linkDragLineEl.className = 'link-drag-line';
    document.body.appendChild(linkDragLineEl);
  }
  linkDragLineEl.style.left = `${x1}px`;
  linkDragLineEl.style.top = `${y1}px`;
  linkDragLineEl.style.width = `${length}px`;
  linkDragLineEl.style.transform = `rotate(${angle}deg)`;
}

function clearLinkDragLine() {
  if (linkDragLineEl) {
    linkDragLineEl.remove();
    linkDragLineEl = null;
  }
}

document.addEventListener('mousemove', e => {
  if (linkDragSourceId === null) return;
  updateLinkDragLine(e.clientX, e.clientY);
});

document.addEventListener('mouseup', e => {
  if (linkDragSourceId === null) return;
  const sourceId = linkDragSourceId;
  linkDragSourceId = null;
  clearLinkDragLine();
  renderLinkGraph();

  if (!currentParticipant) return;
  const nodeEl = document.elementFromPoint(e.clientX, e.clientY)?.closest('.graph-node');
  const targetId = nodeEl?.dataset.nodeId;
  if (!targetId || targetId === sourceId) return;

  const exists = currentParticipant.links.some(l => l.from_id === sourceId && l.to_id === targetId);
  if (exists) {
    setStatus('link-graph-status', 'That link already exists.', true);
    return;
  }

  // Created immediately so the edge is visible on the graph right away -
  // the predicate form below only ever edits this same link in place;
  // Cancel just closes the form, it doesn't undo the link.
  pendingLinkDraft = { from_id: sourceId, to_id: targetId, predicate: '' };
  currentParticipant.links.push(pendingLinkDraft);
  renderLinkGraph();

  document.getElementById('link-predicate-input').value = '';
  document.getElementById('link-predicate-form').style.display = '';
  setStatus('link-graph-status', '');
});

document.getElementById('save-link-btn').addEventListener('click', () => {
  if (!pendingLinkDraft) return;
  pendingLinkDraft.predicate = document.getElementById('link-predicate-input').value.trim();
  pendingLinkDraft = null;
  document.getElementById('link-predicate-form').style.display = 'none';
  renderLinkGraph();
});

document.getElementById('cancel-link-btn').addEventListener('click', () => {
  pendingLinkDraft = null;
  document.getElementById('link-predicate-form').style.display = 'none';
});

function nodeTitleById(nodes, id) {
  const node = nodes.find(n => n.id === id);
  return node ? node.title : id;
}

function renderLinkEdgeList(nodes) {
  const list = document.getElementById('link-edge-list');
  list.innerHTML = '';
  currentParticipant.links.forEach(link => {
    const arrow = link.predicate
      ? `${nodeTitleById(nodes, link.from_id)} --[${link.predicate}]--> ${nodeTitleById(nodes, link.to_id)}`
      : `${nodeTitleById(nodes, link.from_id)} → ${nodeTitleById(nodes, link.to_id)}`;
    list.appendChild(buildRemovableRow(arrow, () => {
      currentParticipant.links = currentParticipant.links.filter(l => l !== link);
      renderLinkGraph();
    }));
  });
}

function renderLinkGraph() {
  const nodes = reflectionGraphNodes();
  renderLinkEdgeList(nodes);
  if (nodes.length === 0) {
    document.getElementById('link-graph').innerHTML = '';
    return;
  }
  const nodeIndexById = new Map(nodes.map((n, i) => [n.id, i]));
  const edges = currentParticipant.links
    .filter(l => nodeIndexById.has(l.from_id) && nodeIndexById.has(l.to_id))
    .map(l => ({ source: nodeIndexById.get(l.from_id), target: nodeIndexById.get(l.to_id), predicate: l.predicate }));

  renderDependencyStyleGraph('link-graph', nodes, edges, {
    nodeClass: '',
    isPendingSource: node => node.id === linkDragSourceId,
    onNodeMouseDown: onLinkNodeMouseDown,
  });
}

// --- Reflection phase: Overall Ratings ---

function renderLikertRows() {
  RATING_KEYS.forEach(key => {
    const container = document.querySelector(`#rating-${key} .likert-pills`);
    container.innerHTML = '';
    for (let value = 1; value <= 5; value++) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'likert-pill';
      pill.textContent = String(value);
      pill.classList.toggle('selected', currentParticipant.ratings[key] === value);
      pill.addEventListener('click', () => {
        currentParticipant.ratings[key] = value;
        renderLikertRows();
      });
      container.appendChild(pill);
    }
  });
}

// --- Reflection phase: Submit ---

function submitReflection() {
  if (!currentParticipant) return;
  if (currentParticipant.takeaways.length === 0) {
    setStatus('reflection-status', 'Add at least one main takeaway first.', true);
    return;
  }
  const { informativeness, confusingness, understandability } = currentParticipant.ratings;
  if (informativeness == null || confusingness == null || understandability == null) {
    setStatus('reflection-status', 'Please set all three ratings first.', true);
    return;
  }
  currentParticipant.ratings.flow_feedback = document.getElementById('rating-flow-feedback-input').value.trim();
  currentParticipant.ratings.comments = document.getElementById('rating-comments-input').value.trim();
  finalizeSession();
}
document.getElementById('submit-reflection-btn').addEventListener('click', submitReflection);

// --- Export Participant Data (Setup mode) ---

function renderParticipantCountStatus() {
  document.getElementById('participant-count-status').textContent = `${participants.length} participant(s) surveyed so far.`;
}

function renderAggregateTable() {
  const container = document.getElementById('aggregate-table');
  container.innerHTML = '';

  const groups = new Map(); // familiarity rating -> {n, informativeness, confusingness, understandability}
  participants.forEach(p => {
    const key = p.demographics.familiarity;
    if (!groups.has(key)) groups.set(key, { n: 0, informativeness: 0, confusingness: 0, understandability: 0 });
    const g = groups.get(key);
    g.n += 1;
    g.informativeness += p.ratings.informativeness;
    g.confusingness += p.ratings.confusingness;
    g.understandability += p.ratings.understandability;
  });

  if (groups.size === 0) {
    container.textContent = 'No data yet.';
    return;
  }

  const table = document.createElement('table');
  table.className = 'calibrate-aggregate-table';
  table.innerHTML = `
    <thead>
      <tr><th>Self-rated familiarity</th><th># participants</th><th>Avg informativeness</th><th>Avg confusingness</th><th>Avg understandability</th></tr>
    </thead>
  `;
  const tbody = document.createElement('tbody');
  [...groups.keys()].sort().forEach(familiarity => {
    const g = groups.get(familiarity);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${familiarity}</td><td>${g.n}</td><td>${(g.informativeness / g.n).toFixed(2)}</td>`
      + `<td>${(g.confusingness / g.n).toFixed(2)}</td><td>${(g.understandability / g.n).toFixed(2)}</td>`;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.appendChild(table);
}

function participantGraphNodes(participant) {
  const takeawayNodes = participant.takeaways.map(t => ({
    id: t.id, label: shorten(t.text), title: t.text, nodeClass: 'graph-node-takeaway',
  }));
  const pieceNodes = participant.pieces.map(p => {
    const short = p.excerpt || `Slide ${p.slide_index}`;
    const title = `Slide ${p.slide_index}${p.excerpt ? `: "${p.excerpt}"` : ''}${p.note ? ` — ${p.note}` : ''}`;
    return {
      id: p.id, label: shorten(short), title,
      nodeClass: p.type === 'contributing' ? 'graph-node-piece-contributing' : 'graph-node-piece-confusing',
    };
  });
  return [...takeawayNodes, ...pieceNodes];
}

function renderParticipantGraph(participant, containerId) {
  const nodes = participantGraphNodes(participant);
  if (nodes.length === 0) {
    document.getElementById(containerId).textContent = 'No takeaways or pieces recorded.';
    return;
  }
  const nodeIndexById = new Map(nodes.map((n, i) => [n.id, i]));
  const edges = participant.links
    .filter(l => nodeIndexById.has(l.from_id) && nodeIndexById.has(l.to_id))
    .map(l => ({ source: nodeIndexById.get(l.from_id), target: nodeIndexById.get(l.to_id), predicate: l.predicate }));
  renderDependencyStyleGraph(containerId, nodes, edges, { nodeClass: '' });
}

function buildParticipantRow(participant) {
  const row = document.createElement('div');
  row.className = 'sim-objective-row';

  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'sim-objective-header';

  const chip = document.createElement('span');
  chip.className = 'sim-scope-chip';
  chip.textContent = `Fam ${participant.demographics.familiarity}`;
  header.appendChild(chip);

  const { informativeness, confusingness, understandability } = participant.ratings;
  const text = document.createElement('span');
  text.className = 'sim-objective-text';
  text.textContent = `${participant.demographics.age_range}, ${participant.demographics.education}, `
    + `${participant.demographics.field} - ${participant.takeaways.length} takeaway(s), `
    + `I:${informativeness} C:${confusingness} U:${understandability}`;
  header.appendChild(text);

  const caret = document.createElement('span');
  caret.className = 'sim-expand-caret';
  caret.textContent = '▾';
  header.appendChild(caret);

  const detail = document.createElement('div');
  detail.className = 'sim-objective-detail';
  detail.style.display = 'none';

  if (participant.interview) {
    const interviewPairs = [
      ['What made a past talk work', participant.interview.talk_that_worked],
      ['What made a past talk confusing', participant.interview.talk_that_confused],
      ['What determines understanding', participant.interview.what_determines_understanding],
      ['A talk they presented - topic & audience', participant.interview.presented_talk_topic_and_audience],
      ['Feedback that helped them adapt it', participant.interview.presented_talk_feedback],
    ];
    interviewPairs.forEach(([label, answer]) => {
      if (!answer) return;
      const sample = document.createElement('div');
      sample.className = 'sim-sample';
      const q = document.createElement('div');
      q.className = 'sim-question';
      q.textContent = label;
      sample.appendChild(q);
      const a = document.createElement('div');
      a.className = 'sim-sample-answer';
      a.textContent = answer;
      sample.appendChild(a);
      detail.appendChild(sample);
    });
  }

  participant.takeaways.forEach(takeaway => {
    const sample = document.createElement('div');
    sample.className = 'sim-sample';
    const label = document.createElement('div');
    label.className = 'sim-question';
    label.textContent = `Takeaway: ${takeaway.text}`;
    sample.appendChild(label);
    detail.appendChild(sample);
  });

  participant.pieces.forEach(piece => {
    const sample = document.createElement('div');
    sample.className = 'sim-sample';

    const label = document.createElement('div');
    label.className = `sim-sample-grade ${piece.type === 'contributing' ? 'sim-correct' : 'sim-incorrect'}`;
    label.textContent = `[${piece.type}] Slide ${piece.slide_index}${piece.excerpt ? `: "${piece.excerpt}"` : ''}`;
    sample.appendChild(label);

    if (piece.note) {
      const noteEl = document.createElement('div');
      noteEl.className = 'sim-sample-answer';
      noteEl.textContent = piece.note;
      sample.appendChild(noteEl);
    }
    detail.appendChild(sample);
  });

  if (participant.ratings.flow_feedback) {
    const flowFeedbackEl = document.createElement('div');
    flowFeedbackEl.className = 'sim-question';
    flowFeedbackEl.textContent = `Flow feedback: ${participant.ratings.flow_feedback}`;
    detail.appendChild(flowFeedbackEl);
  }

  if (participant.ratings.comments) {
    const commentsEl = document.createElement('div');
    commentsEl.className = 'sim-question';
    commentsEl.textContent = `Comments: ${participant.ratings.comments}`;
    detail.appendChild(commentsEl);
  }

  const graphContainer = document.createElement('div');
  graphContainer.id = `participant-graph-${participant.participant_id}`;
  detail.appendChild(graphContainer);

  header.addEventListener('click', () => {
    const isOpen = detail.style.display !== 'none';
    detail.style.display = isOpen ? 'none' : '';
    header.classList.toggle('expanded', !isOpen);
    if (!isOpen) renderParticipantGraph(participant, graphContainer.id);
  });

  row.appendChild(header);
  row.appendChild(detail);
  return row;
}

function renderParticipantsList() {
  const list = document.getElementById('participants-list');
  list.innerHTML = '';
  if (participants.length === 0) {
    list.textContent = 'No participants yet.';
    return;
  }
  [...participants].reverse().forEach(p => list.appendChild(buildParticipantRow(p)));
}

function exportDataset() {
  if (participants.length === 0) {
    setStatus('dataset-status', 'Nothing to export yet.', true);
    return;
  }

  const blob = new Blob([JSON.stringify(participants, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'bkt-prior-calibration-participants.json';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
document.getElementById('export-dataset-btn').addEventListener('click', exportDataset);

function clearDataset() {
  const hasObjectives = presentationObjectives.length > 0
    || Object.keys(sectionsByRange).length > 0
    || Object.keys(slideObjectives).length > 0;
  if (!hasObjectives && participants.length === 0) return;
  if (!confirm('Delete all objectives AND all participant data? This cannot be undone.')) return;

  presentationObjectives = [];
  sectionsByRange = {};
  slideObjectives = {};
  participants = [];
  currentSectionRange = null;
  saveObjectives();
  saveParticipants();

  renderPresentationObjectivesList();
  renderSectionEditor();
  renderSlideObjectivesList();
  renderAggregateTable();
  renderParticipantsList();
  renderParticipantCountStatus();
  setStatus('dataset-status', 'Cleared.');
}
document.getElementById('clear-dataset-btn').addEventListener('click', clearDataset);

// --- TESTING ONLY: auto-load sample objectives + narration audio ---
// Only fires if nothing has been configured yet (first visit / after Clear
// All Data) - never overwrites real researcher setup, and never re-fires
// once objectives exist (they persist in localStorage). Remove this block
// once real studies are being run end to end.
function autoLoadTestingDefaults() {
  const isEmpty = presentationObjectives.length === 0
    && Object.keys(sectionsByRange).length === 0
    && Object.keys(slideObjectives).length === 0;
  if (isEmpty) {
    document.getElementById('presentation-objective-input').value =
      'Summarize the key factors that determine whether a husky could succeed as a service dog';
    addPresentationObjective();

    currentSectionRange = { start_slide_index: 2, end_slide_index: 3 };
    renderSectionEditor();
    document.getElementById('section-objective-input').value =
      'Explain what makes a dog a service dog and give examples of service-dog tasks';
    addSectionObjective();

    selectSlide(4); // slide 5
    document.getElementById('slide-objective-input').value =
      "Explain why huskies' independence and energy make consistent training especially important";
    addSlideObjective();
  }

  if (!audioObjectUrl) {
    fetch(`/${EXAMPLE_PROJECT_DIR}/narration.mp3`)
      .then(res => res.blob())
      .then(blob => {
        audioObjectUrl = URL.createObjectURL(blob);
        setStatus('audio-upload-status', 'Loaded default test narration (upload your own file to replace it).');
      })
      .catch(err => console.error('Could not load default test narration:', err));
  }
}

// --- Init ---

renderPresentationObjectivesList();
renderSectionEditor();
renderParticipantCountStatus();
renderAggregateTable();
renderParticipantsList();

fetch(`/${EXAMPLE_PROJECT_DIR}/slides.json`)
  .then(res => res.json())
  .then(data => {
    slides = data.map(slide => ({ ...slide, snapshot_image: `${EXAMPLE_PROJECT_DIR}/${slide.snapshot_image}` }));
    renderCarousel();
    renderAllSectionsList();
    autoLoadTestingDefaults();
  })
  .catch(err => console.error('Could not load example deck:', err));
