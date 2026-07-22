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
const DECK_FOLDER_STORAGE_KEY = 'calibrate-priors-deck-folder-v1';
const TALK_ABSTRACT_STORAGE_KEY = 'calibrate-priors-talk-abstract-v1';

// --- TEMPORARY: seeded Setup defaults for a fresh deploy ---
// A fresh browser has no localStorage yet, so Setup would otherwise come up
// blank on every new visitor's machine. This snapshot (captured from an
// already-filled-in Setup page) is used as a fallback only when localStorage
// is empty - a researcher's own edits in their own browser still always win
// (see loadObjectivesState() and the deck-folder/abstract restore near the
// bottom of this file, both of which check localStorage first).
//
// TO REMOVE LATER: delete this DEFAULT_SETUP constant, then in
// loadObjectivesState() change `return DEFAULT_SETUP.objectives;` back to
// `return { presentationObjectives: [], sectionsByRange: {}, slideObjectives: {} };`,
// and near the bottom of the file change
// `localStorage.getItem(DECK_FOLDER_STORAGE_KEY) || DEFAULT_SETUP.deckFolder`
// and `localStorage.getItem(TALK_ABSTRACT_STORAGE_KEY) || DEFAULT_SETUP.talkAbstract`
// back to plain `localStorage.getItem(...)` calls.
const DEFAULT_SETUP = {
  deckFolder: 'presentation-examples/agent',
  talkAbstract: 'We propose and explore the concept of Partial Participation, facilitating remote collaborators to contribute to meetings in which they are not able to fully participate via an AI agent acting as a proxy. During the meeting, users can monitor LLM-generated real-time meeting updates and respond to questions posed by other attendees. Through a mixed-methods user study with 24 participants using our prototype, ProxyMe, we investigated how the frequency of updates (high vs. low) and the type of response style (multiple choice vs. text input) impact perceived presence and mental workload. Our findings reveal that no single setup is universally optimal, and the partial participation fosters a moderate level of social presence and attentional mental workload. Our contributions introduce partial participation as a new paradigm for remote collaboration and highlight how AI can mediate participation when full presence is not feasible.',
  objectives: {
    presentationObjectives: [],
    sectionsByRange: {
      '1-1': { start_slide_index: 1, end_slide_index: 1, title: 'Opening', objectives: [] },
      '2-15': { start_slide_index: 2, end_slide_index: 15, title: 'Motivating Problem', objectives: [] },
      '16-16': { start_slide_index: 16, end_slide_index: 16, title: 'System Build', objectives: [] },
      '17-26': { start_slide_index: 17, end_slide_index: 26, title: 'Experimental Design', objectives: [] },
      '27-49': { start_slide_index: 27, end_slide_index: 49, title: 'Study Findings & Design Implications', objectives: [] },
      '50-52': { start_slide_index: 50, end_slide_index: 52, title: 'Limitations & Future Work', objectives: [] },
      '53-54': { start_slide_index: 53, end_slide_index: 54, title: 'Takeaways', objectives: [] },
    },
    slideObjectives: {},
  },
};
const RATING_KEYS = ['understandability', 'relevance', 'detail'];

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
  return DEFAULT_SETUP.objectives;
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
let deckFolder = '';
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

// Reflection is three sequential steps: state all takeaways (freely add/
// edit/delete), tag parts of the presentation (global, not tied to any one
// takeaway), then link/cluster those parts with the takeaways and the
// participant's stated pre-talk goal - then finish (reveal the cut/add +
// ratings sections).
const REFLECTION_STEPS = ['reflection-step-takeaway', 'reflection-step-build-up', 'reflection-step-link'];
let reflectionStepIndex = 0;
let takeawayEditDraftId = null; // set while editing an existing takeaway in place; null while adding a new one

const presentationAudio = document.getElementById('presentation-audio');

// --- Carousel + drag-select-a-section (ported from js/presenter-view.js) ---

// --- Sections: every slide must belong to a titled section (see
// switchToParticipantMode's gate) - shown wherever a slide/transcript
// reference appears, via sectionLabelText(). ---

function findSectionForSlide(slideIndex) {
  return Object.values(sectionsByRange).find(s => slideIndex >= s.start_slide_index && slideIndex <= s.end_slide_index) || null;
}

function sectionLabelText(slideIndex) {
  const section = findSectionForSlide(slideIndex);
  if (!section) return 'No section defined for this slide yet.';
  const title = section.title && section.title.trim() ? section.title.trim() : '(untitled section)';
  return `Section: ${title} (Slides ${section.start_slide_index}–${section.end_slide_index})`;
}

// Range currently being defined/edited via the Presentation Preview's inline
// form, or null when just viewing. Never touches sectionsByRange until Save
// is clicked (see the Save handler below) - highlighting/browsing alone
// never materializes an empty section.
let setupSectionEditRange = null;

function renderSetupSectionArea() {
  const viewEl = document.getElementById('setup-section-view');
  const formEl = document.getElementById('setup-section-edit-form');

  if (setupSectionEditRange) {
    viewEl.style.display = 'none';
    formEl.style.display = '';
    const section = sectionsByRange[sectionKey(setupSectionEditRange)];
    document.getElementById('setup-section-title-input').value = section ? section.title || '' : '';
    setStatus('setup-section-status', '');
    return;
  }
  formEl.style.display = 'none';

  const slide = slides[activeIndex];
  if (!slide) {
    viewEl.style.display = 'none';
    return;
  }
  viewEl.style.display = '';
  viewEl.innerHTML = '';

  const section = findSectionForSlide(slide.slide_index);
  if (!section) {
    viewEl.textContent = 'No section defined for this slide yet.';
    return;
  }
  const title = section.title && section.title.trim() ? section.title.trim() : '(untitled section)';
  const textSpan = document.createElement('b');
  textSpan.textContent = `Section: ${title} (Slides ${section.start_slide_index}–${section.end_slide_index}) `;
  viewEl.appendChild(textSpan);

  const range = { start_slide_index: section.start_slide_index, end_slide_index: section.end_slide_index };

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'btn-secondary';
  editBtn.style.marginLeft = '8px';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', () => {
    setupSectionEditRange = range;
    renderSetupSectionArea();
  });
  viewEl.appendChild(editBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn-primary';
  deleteBtn.style.marginLeft = '8px';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', () => deleteSection(sectionKey(range)));
  viewEl.appendChild(deleteBtn);
}

// Each slide belongs to at most one section - reject saving a title for a
// range that overlaps an already-titled section (rather than allowing a
// slide to silently end up covered by two).
function findOverlappingSection(range, excludeKey) {
  return Object.entries(sectionsByRange).find(([key, s]) =>
    key !== excludeKey && s.title && s.title.trim() &&
    range.start_slide_index <= s.end_slide_index && range.end_slide_index >= s.start_slide_index
  );
}

document.getElementById('save-setup-section-title-btn').addEventListener('click', () => {
  if (!setupSectionEditRange) return;
  const key = sectionKey(setupSectionEditRange);
  const overlap = findOverlappingSection(setupSectionEditRange, key);
  if (overlap) {
    const [, overlapSection] = overlap;
    setStatus('setup-section-status',
      `Slides ${setupSectionEditRange.start_slide_index}-${setupSectionEditRange.end_slide_index} overlap with `
      + `"${overlapSection.title.trim()}" (Slides ${overlapSection.start_slide_index}-${overlapSection.end_slide_index}). `
      + `Sections can't overlap.`, true);
    return;
  }
  const section = getOrCreateSection(setupSectionEditRange);
  section.title = document.getElementById('setup-section-title-input').value.trim();
  saveObjectives();
  currentSectionRange = setupSectionEditRange;
  setupSectionEditRange = null;
  renderSetupSectionArea();
  renderAllSectionsList();
});

document.getElementById('cancel-setup-section-title-btn').addEventListener('click', () => {
  setupSectionEditRange = null;
  setStatus('setup-section-status', '');
  renderSetupSectionArea();
});

// Deletes a section outright (title + any takeaways attached to it) -
// confirms first only if it actually has takeaways attached, since an
// empty/just-titled section is low-risk to remove without asking.
function deleteSection(key) {
  const section = sectionsByRange[key];
  if (!section) return;
  if (section.objectives.length > 0
    && !confirm(`Delete section "${section.title}" and its ${section.objectives.length} attached takeaway(s)? This cannot be undone.`)) return;
  delete sectionsByRange[key];
  if (currentSectionRange && sectionKey(currentSectionRange) === key) currentSectionRange = null;
  if (setupSectionEditRange && sectionKey(setupSectionEditRange) === key) setupSectionEditRange = null;
  saveObjectives();
  renderSetupSectionArea();
  renderAllSectionsList();
}

function selectSlide(index) {
  activeIndex = index;
  document.querySelectorAll('.slide-thumb').forEach((el, i) => {
    el.classList.toggle('active', i === index);
  });
  const activeThumb = document.querySelectorAll('.slide-thumb')[index];
  if (activeThumb) activeThumb.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  const slide = slides[index];
  document.getElementById('setup-transcript').textContent = slide?.transcript || '(No transcript for this slide.)';
  renderSetupSectionArea();
  renderSlideObjectivesList();
}

function renderCarousel() {
  const carousel = document.getElementById('carousel');
  carousel.innerHTML = '';
  document.getElementById('setup-transcript').style.display = slides.length > 0 ? '' : 'none';
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
  onSlideThumbClick(0, null);
}

// Decide whether highlighting `range` should open the inline title editor
// (brand-new / untitled range) or just show it in view mode (already titled).
function enterSectionViewOrEdit(range) {
  currentSectionRange = range;
  const existing = sectionsByRange[sectionKey(range)];
  setupSectionEditRange = (existing && existing.title && existing.title.trim()) ? null : range;
}

// Shift+click extends a brand-new drag-selected range. A plain click instead
// jumps straight to whatever pre-existing named section already contains
// that slide, if any - so browsing the deck doubles as browsing sections,
// per the requirement that every slide belong to one.
function onSlideThumbClick(index, event) {
  if (event && event.shiftKey && slides.length > 0) {
    const loIndex = Math.min(activeIndex, index);
    const hiIndex = Math.max(activeIndex, index);
    highlightSectionRange(loIndex, hiIndex);
    enterSectionViewOrEdit({ start_slide_index: slides[loIndex].slide_index, end_slide_index: slides[hiIndex].slide_index });
  } else if (slides[index]) {
    const section = findSectionForSlide(slides[index].slide_index);
    if (section) {
      // Already part of a (possibly multi-slide) section - plain click just
      // views it, matching that section's full highlighted range.
      currentSectionRange = { start_slide_index: section.start_slide_index, end_slide_index: section.end_slide_index };
      const loIndex = slides.findIndex(s => s.slide_index === section.start_slide_index);
      const hiIndex = slides.findIndex(s => s.slide_index === section.end_slide_index);
      highlightSectionRange(loIndex, hiIndex);
      setupSectionEditRange = null;
    } else {
      // Not yet covered by any section - a plain click alone is enough to
      // designate this one slide as its own single-slide section, no drag
      // needed.
      highlightSectionRange(index, index);
      enterSectionViewOrEdit({ start_slide_index: slides[index].slide_index, end_slide_index: slides[index].slide_index });
    }
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
  highlightSectionRange(loIndex, hiIndex);
  enterSectionViewOrEdit({ start_slide_index: slides[loIndex].slide_index, end_slide_index: slides[hiIndex].slide_index });
  renderSetupSectionArea();
});

// --- Objective scopes: helpers ---

function sectionKey(range) {
  return `${range.start_slide_index}-${range.end_slide_index}`;
}
function getOrCreateSection(range) {
  const key = sectionKey(range);
  if (!sectionsByRange[key]) {
    sectionsByRange[key] = { start_slide_index: range.start_slide_index, end_slide_index: range.end_slide_index, title: '', objectives: [] };
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

// --- Scope 2: Section of Slides - titles are defined/edited inline in the
// Presentation Preview module (see renderSetupSectionArea() above); this is
// just a list of every already-titled section, each with its own place to
// attach takeaways to it. ---

function renderAllSectionsList() {
  const list = document.getElementById('all-sections-list');
  list.style.fontSize = '13px';
  list.style.fontWeight = '700';
  list.innerHTML = '';
  const titledSections = Object.values(sectionsByRange)
    .filter(section => section.title && section.title.trim())
    .sort((a, b) => a.start_slide_index - b.start_slide_index);

  if (titledSections.length === 0) {
    list.textContent = 'No sections defined yet - highlight a range of slides in the Presentation Preview above.';
    return;
  }

  titledSections.forEach(section => {
    const block = document.createElement('div');
    block.className = 'objectives-scope';

    // Sections are only deleted from the Presentation Preview module (where
    // they're defined) - no delete control here, this list is just for
    // attaching takeaways to already-defined sections.
    const heading = document.createElement('div');
    heading.style.fontSize = '13px';
    heading.style.fontWeight = '700';
    heading.style.marginBottom = '8px';
    heading.textContent = `Slides ${section.start_slide_index}-${section.end_slide_index} — ${section.title.trim()}`;
    block.appendChild(heading);

    const row = document.createElement('div');
    row.className = 'audience-input-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Add a takeaway for this section';
    const addBtn = document.createElement('button');
    addBtn.className = 'btn-primary';
    addBtn.textContent = 'Add';
    row.appendChild(input);
    row.appendChild(addBtn);
    block.appendChild(row);

    const status = document.createElement('div');
    status.className = 'status-line';
    block.appendChild(status);

    const objList = document.createElement('div');
    block.appendChild(objList);

    function renderSectionObjectives() {
      objList.innerHTML = '';
      section.objectives.forEach(obj => {
        objList.appendChild(buildObjectiveSetupRow(obj, () => {
          section.objectives = section.objectives.filter(o => o.id !== obj.id);
          saveObjectives();
          renderSectionObjectives();
        }));
      });
    }
    renderSectionObjectives();

    addBtn.addEventListener('click', () => {
      const text = input.value.trim();
      if (!text) {
        status.textContent = 'Enter a takeaway first.';
        status.classList.add('error');
        return;
      }
      section.objectives.push({ id: makeId('obj'), text });
      saveObjectives();
      input.value = '';
      status.textContent = '';
      status.classList.remove('error');
      renderSectionObjectives();
    });

    list.appendChild(block);
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
  document.getElementById('current-slide-label').textContent = slide ? `Takeaways for Slide ${slide.slide_index}` : '';

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

// --- Presentation Files: presenter designates a folder containing a
// matched set of slides.json + snapshots/ + narration.mp3 (audio is
// deliberately not persisted across reloads - only the folder path string
// is, via DECK_FOLDER_STORAGE_KEY, so re-loading is one click not a retype). ---

// `resetTakeaways` defaults to true for the presenter explicitly clicking
// "Load" (a new/re-declared deck starts with a blank takeaway slate for it -
// old section/slide-scoped takeaways are tied to a specific deck's slide
// indices and don't carry meaning for a different one). It's passed false
// only by the silent auto-restore on page Init below, which is just
// re-establishing the same already-configured deck after an unavoidable
// in-memory reset from the page refresh, not a deliberate "load new files."
function loadDeckFolder(folder, { resetTakeaways = true } = {}) {
  folder = folder.trim();
  if (!folder) {
    setStatus('deck-load-status', 'Enter a folder path first.', true);
    return;
  }
  setStatus('deck-load-status', 'Loading...');
  fetch(`/${folder}/slides.json`)
    .then(res => {
      if (!res.ok) throw new Error(`slides.json not found (HTTP ${res.status})`);
      return res.json();
    })
    .then(data => {
      deckFolder = folder;
      localStorage.setItem(DECK_FOLDER_STORAGE_KEY, folder);
      slides = data.map(slide => ({ ...slide, snapshot_image: `${deckFolder}/${slide.snapshot_image}` }));

      if (resetTakeaways) {
        presentationObjectives = [];
        sectionsByRange = {};
        slideObjectives = {};
        currentSectionRange = null;
        setupSectionEditRange = null;
        saveObjectives();
      }
      renderCarousel();
      renderAllSectionsList();
      renderPresentationObjectivesList();
      renderSlideObjectivesList();

      return fetch(`/${deckFolder}/narration.mp3`);
    })
    .then(res => {
      if (!res.ok) throw new Error(`narration.mp3 not found (HTTP ${res.status})`);
      return res.blob();
    })
    .then(blob => {
      if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
      audioObjectUrl = URL.createObjectURL(blob);
      setStatus('deck-load-status', `Loaded ${slides.length} slides + narration audio from ${deckFolder}/`);
    })
    .catch(err => setStatus('deck-load-status', `Could not load deck: ${err.message}`, true));
}
document.getElementById('load-deck-btn').addEventListener('click', () => loadDeckFolder(document.getElementById('deck-folder-input').value));

// --- Talk abstract: persisted free text, shown to the participant on the
// Familiarity step right after the "we will show you..." blurb. ---

function renderTalkAbstractDisplay() {
  const text = document.getElementById('talk-abstract-input').value.trim();
  document.getElementById('talk-abstract-text').textContent = text;
  document.getElementById('talk-abstract-display').style.display = text ? '' : 'none';
}

document.getElementById('talk-abstract-input').addEventListener('input', () => {
  localStorage.setItem(TALK_ABSTRACT_STORAGE_KEY, document.getElementById('talk-abstract-input').value);
  renderTalkAbstractDisplay();
});

// --- Mode switching ---

function switchToParticipantMode() {
  if (slides.length === 0) {
    setStatus('start-session-status', 'Load a presentation folder first (see Presentation Files above).', true);
    return;
  }
  if (!document.getElementById('talk-abstract-input').value.trim()) {
    setStatus('start-session-status', 'Add a talk abstract first (see Talk Abstract above).', true);
    return;
  }
  const uncoveredSlide = slides.find(slide => {
    const section = findSectionForSlide(slide.slide_index);
    return !section || !(section.title || '').trim();
  });
  if (uncoveredSlide) {
    setStatus('start-session-status',
      `Divide every slide into a titled section first (see Section of Slides above - Slide ${uncoveredSlide.slide_index} isn't covered yet).`, true);
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
  document.getElementById('talk-goal-input').value = '';
  document.getElementById('presentation-player-module').style.display = 'none';
  document.getElementById('reflection-module').style.display = 'none';
  currentParticipant = null;
  stopParticipantAudioRecording({ download: false });
  resetRecordAudioButton();
  showPreStep(0);
}

// --- Pre-presentation step navigation: Welcome -> Interview Questions ->
// More Intro Questions -> Familiarity, with Back/Next arrows via a single
// shared nav bar (only one step div is ever visible, so one bar reused
// across all of them is simpler than duplicating Back/Next controls per
// step). Demographics is currently skipped - collected at study sign-up
// instead - but its module/data-collection code is left in place to make
// re-enabling it later a one-line change (add it back to this array). ---

const PRE_PRESENTATION_STEPS = ['welcome-module', 'interview-module', 'interview-module-2', 'familiarity-module'];
let preStepIndex = 0;

// Interview questions are read aloud one at a time (in-person, semi-
// structured interview - see the modules' own mentor-notes), not typed
// answers - so instead of a scrollable list, one question is highlighted
// and the rest faded, advanced via arrow keys (see the keydown handler
// below `renderInterviewHighlight`).
let interviewQuestionIndex = 0;

function renderInterviewHighlight(stepId, index) {
  const questions = document.querySelectorAll(`#${stepId} .objectives-scope`);
  questions.forEach((el, i) => {
    el.classList.toggle('interview-q-active', i === index);
    el.classList.toggle('interview-q-faded', i !== index);
  });
}

function showPreStep(index) {
  preStepIndex = index;
  PRE_PRESENTATION_STEPS.forEach((id, i) => {
    document.getElementById(id).style.display = i === index ? '' : 'none';
  });
  const stepId = PRE_PRESENTATION_STEPS[index];
  if (stepId === 'interview-module' || stepId === 'interview-module-2') {
    interviewQuestionIndex = 0;
    renderInterviewHighlight(stepId, 0);
  }
  document.getElementById('pre-nav').style.display = '';
  document.getElementById('pre-nav-back-btn').style.display = index === 0 ? 'none' : '';
  document.getElementById('record-audio-btn').style.display = index === 0 ? '' : 'none';
  document.getElementById('stop-recording-audio-btn').style.display = stepId === 'interview-module-2' ? '' : 'none';
  document.getElementById('pre-nav-next-btn').textContent = index === 0 ? 'Begin'
    : index === PRE_PRESENTATION_STEPS.length - 1 ? 'Begin presentation →'
    : 'Next →';
  setStatus('pre-nav-status', '');
}

// Left/Up move to the previous question, Right/Down to the next - only
// while an interview-questions step is the active pre-presentation step, so
// this never interferes with e.g. the familiarity <select> elsewhere.
document.addEventListener('keydown', e => {
  const stepId = PRE_PRESENTATION_STEPS[preStepIndex];
  if (stepId !== 'interview-module' && stepId !== 'interview-module-2') return;
  const questions = document.querySelectorAll(`#${stepId} .objectives-scope`);
  if (questions.length === 0) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
    e.preventDefault();
    interviewQuestionIndex = Math.min(interviewQuestionIndex + 1, questions.length - 1);
    renderInterviewHighlight(stepId, interviewQuestionIndex);
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
    e.preventDefault();
    interviewQuestionIndex = Math.max(interviewQuestionIndex - 1, 0);
    renderInterviewHighlight(stepId, interviewQuestionIndex);
  }
});

function validatePreStep(index) {
  const stepId = PRE_PRESENTATION_STEPS[index];
  if (stepId === 'familiarity-module') {
    if (!document.getElementById('demo-familiarity-input').value) return 'Please answer these questions first.';
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

// --- Participant audio recording: captures the participant's own mic
// audio for the whole session (not the presentation narration) - started
// once from the Welcome step, stopped and auto-downloaded whenever the
// session ends (submit or an early reset), so the researcher has a
// recording to go with each participant's data. No backend upload here
// (unlike presenter-view.js's record+transcribe flow) - just a local
// download, since participant-view.js otherwise only ever fetches static
// files. ---

let participantAudioRecorder = null;
let participantAudioChunks = [];
let participantAudioStream = null;

function resetRecordAudioButton() {
  const btn = document.getElementById('record-audio-btn');
  btn.textContent = 'Record audio';
  btn.disabled = false;
  document.getElementById('stop-recording-audio-btn').disabled = false;
}

function startParticipantAudioRecording() {
  navigator.mediaDevices.getUserMedia({ audio: true })
    .then(stream => {
      participantAudioStream = stream;
      const mimeCandidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
      const mimeType = mimeCandidates.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
      participantAudioRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      participantAudioChunks = [];
      participantAudioRecorder.addEventListener('dataavailable', e => {
        if (e.data.size > 0) participantAudioChunks.push(e.data);
      });
      participantAudioRecorder.start();
      const btn = document.getElementById('record-audio-btn');
      btn.textContent = '● Recording...';
      btn.disabled = true;
      setStatus('pre-nav-status', 'Recording participant audio for this session.');
    })
    .catch(err => setStatus('pre-nav-status', `Could not start recording: ${err.message}`, true));
}
document.getElementById('record-audio-btn').addEventListener('click', startParticipantAudioRecording);

// `download: false` for an early/aborted reset (nothing meaningful to keep);
// the real end-of-session path (finalizeSession) uses the default `true`.
function stopParticipantAudioRecording({ download = true } = {}) {
  if (!participantAudioRecorder || participantAudioRecorder.state === 'inactive') return;
  const recorder = participantAudioRecorder;
  const participantId = currentParticipant?.participant_id;
  if (download) {
    recorder.addEventListener('stop', () => {
      const blob = new Blob(participantAudioChunks, { type: recorder.mimeType || 'audio/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `participant-audio-${participantId || Date.now()}.webm`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }, { once: true });
  }
  recorder.stop();
  if (participantAudioStream) participantAudioStream.getTracks().forEach(t => t.stop());
  participantAudioRecorder = null;
  participantAudioStream = null;
}

// Manual "stop early" trigger, right after the intro questions the recording
// is meant to capture - the recording (if one was ever started) would
// otherwise keep running silently through the rest of the session until
// finalizeSession()'s end-of-session stop.
document.getElementById('stop-recording-audio-btn').addEventListener('click', () => {
  const wasRecording = !!participantAudioRecorder;
  stopParticipantAudioRecording({ download: true });
  const btn = document.getElementById('stop-recording-audio-btn');
  btn.disabled = true;
  setStatus('pre-nav-status', wasRecording
    ? 'Recording stopped and downloaded.'
    : 'No recording was in progress.');
});

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
    talk_goal: document.getElementById('talk-goal-input').value.trim(),
    talk_goal_outcome: { rating: null, why: '' },
    takeaways: [],
    pieces: [],
    links: [],
    edits: [],
    presenter_takeaway_clarity: [],
    ratings: { understandability: null, relevance: null, detail: null, flow_feedback: '', comments: '' },
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
  stopParticipantAudioRecording(); // downloads the recording before resetParticipantView() no-ops on it
  resetParticipantView();
  setStatus('pre-nav-status', 'Thanks! Your responses have been recorded. Ready for a new participant.');
}

// --- Reflection phase: reference panel (slide picker + selectable transcript) ---

function enterReflectionPhase() {
  presentationAudio.pause();
  document.getElementById('presentation-player-module').style.display = 'none';
  document.getElementById('reflection-module').style.display = '';

  reflectionActiveSlideIndex = null;
  editsActiveSlideIndex = null;
  pieceNoteDraft = null;
  editNoteDraft = null;
  linkDragSourceId = null;
  pendingLinkDraft = null;
  takeawayEditDraftId = null;
  clearLinkDragLine();
  hideSelectionTagPopup();
  hideEditSelectionTagPopup();

  document.getElementById('reflection-transcript').textContent = '';
  document.getElementById('edits-transcript').textContent = '';
  document.getElementById('piece-note-form').style.display = 'none';
  document.getElementById('edit-note-form').style.display = 'none';
  document.getElementById('link-predicate-form').style.display = 'none';
  document.getElementById('takeaway-input').value = '';
  document.getElementById('cancel-takeaway-edit-btn').style.display = 'none';
  document.getElementById('add-takeaway-btn').textContent = 'Add';
  document.getElementById('rating-comments-input').value = '';
  document.getElementById('talk-goal-outcome-why-input').value = '';

  document.getElementById('reflection-steps-card').style.display = '';
  document.getElementById('reflection-step-nav').style.display = '';
  document.getElementById('reflection-summary-module').style.display = 'none';
  document.getElementById('edits-module').style.display = 'none';
  document.getElementById('presenter-takeaway-clarity-module').style.display = 'none';
  document.getElementById('ratings-module').style.display = 'none';
  document.getElementById('submit-reflection-btn').style.display = 'none';

  // Snapshot the presenter's presentation-level takeaways (defined in Setup
  // mode's "Presenter's Takeaways" module) fresh each session, so the
  // clarity question always reflects what's currently configured.
  currentParticipant.presenter_takeaway_clarity = presentationObjectives.map(o => ({
    objective_id: o.id, objective_text: o.text, clear: null, why: '',
  }));

  renderReflectionCarousel();
  renderEditsCarousel();
  renderReflectionActiveSlideImage();
  renderEditsActiveSlideImage();
  showReflectionStep(0);
  renderTalkGoalReminder();
  renderTalkGoalOutcomeRating();
  renderTakeawaysList();
  renderPiecesLists();
  renderLinkGraph();
  renderEditsLists();
  renderPresenterTakeawayClarity();
  renderLikertRows();
  setStatus('reflection-status', '');
}

// Reminds the participant of what they said they wanted out of the talk
// (captured at the Familiarity step - see talk_goal in beginPresentation()),
// and reveals the matching "did you get it?" question - both hidden if that
// field was left blank, since the question wouldn't make sense otherwise.
function renderTalkGoalReminder() {
  const goalText = (currentParticipant.talk_goal || '').trim();
  const reminderEl = document.getElementById('talk-goal-reminder');
  const outcomeEl = document.getElementById('talk-goal-outcome-module');
  if (goalText) {
    reminderEl.textContent = `Reminder — before watching, you said you wanted to get out of this talk: "${goalText}"`;
    reminderEl.style.display = '';
    outcomeEl.style.display = '';
  } else {
    reminderEl.style.display = 'none';
    outcomeEl.style.display = 'none';
  }
}

function renderTalkGoalOutcomeRating() {
  const container = document.querySelector('#rating-talk-goal-outcome .likert-pills');
  container.innerHTML = '';
  for (let value = 1; value <= 5; value++) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'likert-pill';
    pill.textContent = String(value);
    pill.classList.toggle('selected', currentParticipant.talk_goal_outcome.rating === value);
    pill.addEventListener('click', () => {
      currentParticipant.talk_goal_outcome.rating = value;
      renderTalkGoalOutcomeRating();
    });
    container.appendChild(pill);
  }
}

document.getElementById('talk-goal-outcome-why-input').addEventListener('input', () => {
  currentParticipant.talk_goal_outcome.why = document.getElementById('talk-goal-outcome-why-input').value;
});

// --- Reflection phase: step navigation ---

// Reminder shown underneath the tagging column in "Tag parts of the
// presentation" (REFLECTION_STEPS[1]) - the pre-talk goal and whatever
// takeaways were stated in the previous step, so they're easy to keep in
// mind while tagging pieces. Read-only (no edit/remove) - editing the
// takeaways themselves still only happens back in that first step.
function renderBuildUpReminder() {
  const goalText = (currentParticipant.talk_goal || '').trim();
  const goalEl = document.getElementById('build-up-goal-reminder');
  if (goalText) {
    goalEl.textContent = `What you wanted to get out of this talk: "${goalText}"`;
    goalEl.style.display = '';
  } else {
    goalEl.style.display = 'none';
  }
  const list = document.getElementById('build-up-takeaways-reminder-list');
  list.innerHTML = '';
  currentParticipant.takeaways.forEach(takeaway => {
    const row = document.createElement('div');
    row.className = 'dependency-edge-row';
    row.textContent = takeaway.text;
    list.appendChild(row);
  });
}

function showReflectionStep(index) {
  reflectionStepIndex = index;
  REFLECTION_STEPS.forEach((id, i) => {
    document.getElementById(id).style.display = i === index ? '' : 'none';
  });
  document.getElementById('reflection-nav-back-btn').style.display = index === 0 ? 'none' : '';
  document.getElementById('reflection-nav-next-btn').textContent = 'Next →';
  setStatus('reflection-nav-status', '');
  if (index === 1) renderBuildUpReminder();
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
  document.getElementById('reflection-section-label').textContent = sectionLabelText(slide.slide_index);
  renderReflectionCarousel();
  renderReflectionActiveSlideImage();
  // Offer to tag the whole slide right away - dismissed the same way as any
  // other selection-tag popup (click elsewhere) if they only meant to browse.
  // Anchored to the top of the carousel (not the active slide image, which
  // can be scrolled anywhere) so it consistently shows up top.
  pendingWholeSlideTag = true;
  const anchorRect = document.getElementById('reflection-carousel').getBoundingClientRect();
  showSelectionTagPopup({ left: anchorRect.left + anchorRect.width / 2, top: anchorRect.top, width: 0 });
}

// Shows a large image of the active slide with any already-tagged regions
// for it drawn on top (color-coded contributing/confusing) - drawing a new
// region on it is handled by setupRegionDrawing() further down. Also draws
// the in-progress region (just drawn, popup showing, or note form open but
// not yet saved) as a dashed "draft" path so it doesn't disappear until the
// participant actually saves or cancels - see pendingRegionPoints/
// pieceNoteDraft below.
function renderReflectionActiveSlideImage() {
  const wrap = document.getElementById('reflection-active-slide-wrap');
  const slide = slides.find(s => s.slide_index === reflectionActiveSlideIndex);
  if (!slide) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  document.getElementById('reflection-active-slide-img').src = `/${slide.snapshot_image}`;
  const svg = document.getElementById('reflection-active-slide-svg');
  svg.innerHTML = '';
  currentParticipant.pieces
    .filter(p => p.slide_index === slide.slide_index && p.region)
    .forEach(p => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('class', `region-saved-path ${p.type}`);
      path.setAttribute('d', regionToPathData(p.region));
      svg.appendChild(path);
    });
  const draftPoints = pendingRegionPoints
    || (pieceNoteDraft && pieceNoteDraft.slide_index === slide.slide_index ? pieceNoteDraft.region : null);
  if (draftPoints) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'region-draft-path');
    path.setAttribute('d', regionToPathData(draftPoints));
    svg.appendChild(path);
  }
}

// --- Reflection phase: Main Takeaways - freely add as many as you want,
// edit or delete any of them, all on one page (see REFLECTION_STEPS[0]). ---

// Adds a new takeaway, or - if takeawayEditDraftId is set (via
// beginEditTakeaway) - saves the edit to that existing takeaway in place
// instead of creating a duplicate.
function addOrSaveTakeaway() {
  const input = document.getElementById('takeaway-input');
  const text = input.value.trim();
  if (!text) {
    setStatus('add-takeaway-status', 'Enter a takeaway first.', true);
    return;
  }
  if (takeawayEditDraftId) {
    const takeaway = currentParticipant.takeaways.find(t => t.id === takeawayEditDraftId);
    takeaway.text = text;
    cancelEditTakeaway();
  } else {
    currentParticipant.takeaways.push({ id: makeId('takeaway'), text });
    input.value = '';
  }
  setStatus('add-takeaway-status', '');
  renderTakeawaysList();
  renderLinkGraph();
}
document.getElementById('add-takeaway-btn').addEventListener('click', addOrSaveTakeaway);

function beginEditTakeaway(takeaway) {
  takeawayEditDraftId = takeaway.id;
  document.getElementById('takeaway-input').value = takeaway.text;
  document.getElementById('add-takeaway-btn').textContent = 'Save';
  document.getElementById('cancel-takeaway-edit-btn').style.display = '';
}

function cancelEditTakeaway() {
  takeawayEditDraftId = null;
  document.getElementById('takeaway-input').value = '';
  document.getElementById('add-takeaway-btn').textContent = 'Add';
  document.getElementById('cancel-takeaway-edit-btn').style.display = 'none';
}
document.getElementById('cancel-takeaway-edit-btn').addEventListener('click', cancelEditTakeaway);

// Shared nav bar for all 3 Reflection steps (mirrors #pre-nav-back-btn/
// #pre-nav-next-btn's single-pair-drives-every-step pattern).
document.getElementById('reflection-nav-back-btn').addEventListener('click', () => {
  if (reflectionStepIndex > 0) showReflectionStep(reflectionStepIndex - 1);
});

document.getElementById('reflection-nav-next-btn').addEventListener('click', () => {
  if (reflectionStepIndex === 0 && currentParticipant.takeaways.length === 0) {
    setStatus('reflection-nav-status', 'Add at least one takeaway first.', true);
    return;
  }
  if (reflectionStepIndex === REFLECTION_STEPS.length - 1) {
    document.getElementById('reflection-steps-card').style.display = 'none';
    document.getElementById('reflection-step-nav').style.display = 'none';
    document.getElementById('reflection-summary-module').style.display = '';
    document.getElementById('ratings-module').style.display = '';
    document.getElementById('submit-reflection-btn').style.display = '';
    return;
  }
  if (reflectionStepIndex === 1) renderLinkGraph(); // build-up -> link transition needs a fresh graph
  showReflectionStep(reflectionStepIndex + 1);
});

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
    const row = document.createElement('div');
    row.className = 'dependency-edge-row';

    const text = document.createElement('span');
    text.textContent = takeaway.text;
    text.style.flex = '1';
    row.appendChild(text);

    const editLink = document.createElement('span');
    editLink.className = 'remove-x';
    editLink.textContent = 'Edit';
    editLink.addEventListener('click', () => beginEditTakeaway(takeaway));
    row.appendChild(editLink);

    const removeX = document.createElement('span');
    removeX.className = 'remove-x';
    removeX.textContent = '×';
    removeX.addEventListener('click', () => {
      if (takeawayEditDraftId === takeaway.id) cancelEditTakeaway();
      currentParticipant.takeaways = currentParticipant.takeaways.filter(t => t.id !== takeaway.id);
      currentParticipant.links = currentParticipant.links.filter(l => l.from_id !== takeaway.id && l.to_id !== takeaway.id);
      renderTakeawaysList();
      renderLinkGraph();
    });
    row.appendChild(removeX);

    list.appendChild(row);
  });
}

// --- Freehand region drawing on the large "active slide" image (shared by
// the "Tag parts of the presentation" and "Parts to cut or add" reference
// columns) - a third way to tag a piece, alongside whole-slide buttons and
// transcript-excerpt highlighting. Points are stored normalized 0-1 per the
// image's own width/height (not pixels), so a region survives the image
// being resized (window resize, different screen, etc). ---

function regionToPathData(points) {
  if (!points || points.length === 0) return '';
  const [first, ...rest] = points;
  const fmt = ([x, y]) => `${(x * 100).toFixed(2)},${(y * 100).toFixed(2)}`;
  return `M ${fmt(first)} ` + rest.map(p => `L ${fmt(p)}`).join(' ') + ' Z';
}

// Screen-space bounding rect of a normalized region, in the same shape as a
// DOMRect (left/top/width/height) - used to position the existing tag popup
// next to a drawn region the same way it's positioned next to a text selection.
function regionBoundingClientRect(imgEl, points) {
  const imgRect = imgEl.getBoundingClientRect();
  const xs = points.map(p => p[0]);
  const ys = points.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  return {
    left: imgRect.left + minX * imgRect.width,
    top: imgRect.top + minY * imgRect.height,
    width: (maxX - minX) * imgRect.width,
    height: (maxY - minY) * imgRect.height,
  };
}

// Crops `imgEl` (already-loaded and on-screen, so this can run synchronously
// with no need to reload the image) down to a region's bounding box, at the
// image's own natural resolution, so the link graph can show a real close-up
// of what was circled instead of the whole slide. Returns a data URL, stored
// once on the piece so this only ever runs at tag-save time, not every render.
function cropRegionThumbnail(imgEl, points) {
  const xs = points.map(p => p[0]);
  const ys = points.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const sx = minX * imgEl.naturalWidth;
  const sy = minY * imgEl.naturalHeight;
  const sw = Math.max(1, (maxX - minX) * imgEl.naturalWidth);
  const sh = Math.max(1, (maxY - minY) * imgEl.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  canvas.getContext('2d').drawImage(imgEl, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas.toDataURL('image/png');
}

// Wires up drag-to-draw on `svgId` (overlaying `imgId`): mousedown starts a
// path, mousemove appends points and redraws the live in-progress path,
// mouseup finalizes it and calls onRegionDrawn(points) - unless the drag was
// too small to be a deliberate region (e.g. an accidental click), which is
// silently ignored.
function setupRegionDrawing({ imgId, svgId, isSlideSelected, onRegionDrawn }) {
  const img = document.getElementById(imgId);
  const svg = document.getElementById(svgId);
  let drawing = false;
  let points = [];
  let livePath = null;

  function pointFromEvent(e) {
    const rect = img.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
  }

  svg.addEventListener('mousedown', e => {
    if (!isSlideSelected()) return;
    drawing = true;
    points = [pointFromEvent(e)];
    livePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    livePath.setAttribute('class', 'region-draw-path');
    svg.appendChild(livePath);
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!drawing) return;
    points.push(pointFromEvent(e));
    livePath.setAttribute('d', regionToPathData(points));
  });

  document.addEventListener('mouseup', () => {
    if (!drawing) return;
    drawing = false;
    if (livePath) {
      livePath.remove();
      livePath = null;
    }
    const xs = points.map(p => p[0]);
    const ys = points.map(p => p[1]);
    const bigEnough = points.length > 2
      && (Math.max(...xs) - Math.min(...xs)) > 0.02
      && (Math.max(...ys) - Math.min(...ys)) > 0.02;
    const drawnPoints = points;
    points = [];
    if (bigEnough) onRegionDrawn(drawnPoints);
  });
}

// --- Reflection phase: Pieces (contributing / confusing) - tagged by
// highlighting: select transcript text and a floating popup offers to tag
// that excerpt, clicking a slide thumbnail to pop up a whole-slide tag
// choice (see onReflectionSlideClick), or draw a region directly on the
// slide image above (see setupRegionDrawing()). ---

function beginPieceNote(type, slideIndex, excerpt, region) {
  pieceNoteDraft = { type, slide_index: slideIndex, excerpt: excerpt || null, region: region || null };
  document.getElementById('piece-note-input').value = '';
  document.getElementById('piece-note-form').style.display = '';
  const quote = excerpt ? ` ("${shorten(excerpt)}")` : '';
  setStatus('piece-picker-status', `Tagged Slide ${slideIndex}${quote} as ${type}. Add an optional note and save.`);
  renderReflectionActiveSlideImage();
}

// Floating popup shown near a text selection inside the transcript, built
// once here (not per-selection, unlike the transient link-drag line) since
// its two buttons need persistent click handlers.
const selectionTagPopup = document.createElement('div');
selectionTagPopup.className = 'selection-tag-popup';
selectionTagPopup.style.display = 'none';

const tagSelectionContributingBtn = document.createElement('button');
tagSelectionContributingBtn.type = 'button';
tagSelectionContributingBtn.className = 'btn-secondary';
tagSelectionContributingBtn.textContent = 'Tag as helping';
tagSelectionContributingBtn.addEventListener('click', () => tagCurrentSelection('helping'));

const tagSelectionConfusingBtn = document.createElement('button');
tagSelectionConfusingBtn.type = 'button';
tagSelectionConfusingBtn.className = 'btn-secondary';
tagSelectionConfusingBtn.textContent = 'Tag as confusing';
tagSelectionConfusingBtn.addEventListener('click', () => tagCurrentSelection('confusing'));

selectionTagPopup.appendChild(tagSelectionContributingBtn);
selectionTagPopup.appendChild(tagSelectionConfusingBtn);
document.body.appendChild(selectionTagPopup);

function showSelectionTagPopup(rect) {
  selectionTagPopup.style.display = '';
  selectionTagPopup.style.left = `${rect.left + rect.width / 2}px`;
  selectionTagPopup.style.top = `${rect.top - 8}px`;
}

// Set right before showSelectionTagPopup() is called for a freshly-drawn
// region (as opposed to a text selection) - tagCurrentSelection() checks
// this first. Always cleared by hideSelectionTagPopup() so a stale region
// never gets attached to an unrelated later text selection.
let pendingRegionPoints = null;

// Set right before showSelectionTagPopup() is called for a whole-slide tag
// triggered by clicking a slide thumbnail (as opposed to a drawn region or a
// text selection) - tagCurrentSelection() checks this last, after region/text.
let pendingWholeSlideTag = false;

function hideSelectionTagPopup() {
  selectionTagPopup.style.display = 'none';
  pendingRegionPoints = null;
  pendingWholeSlideTag = false;
  renderReflectionActiveSlideImage();
}

function tagCurrentSelection(type) {
  const region = pendingRegionPoints;
  const text = window.getSelection().toString().trim();
  const wholeSlide = pendingWholeSlideTag;
  hideSelectionTagPopup();
  if (reflectionActiveSlideIndex == null) return;
  if (region) {
    beginPieceNote(type, reflectionActiveSlideIndex, null, region);
  } else if (text) {
    beginPieceNote(type, reflectionActiveSlideIndex, text, null);
  } else if (wholeSlide) {
    beginPieceNote(type, reflectionActiveSlideIndex, null, null);
  }
}

document.getElementById('reflection-transcript').addEventListener('mouseup', () => {
  const text = window.getSelection().toString().trim();
  if (!text || reflectionActiveSlideIndex == null) {
    hideSelectionTagPopup();
    return;
  }
  showSelectionTagPopup(window.getSelection().getRangeAt(0).getBoundingClientRect());
});

setupRegionDrawing({
  imgId: 'reflection-active-slide-img',
  svgId: 'reflection-active-slide-svg',
  isSlideSelected: () => reflectionActiveSlideIndex != null,
  onRegionDrawn: points => {
    pendingRegionPoints = points;
    showSelectionTagPopup(regionBoundingClientRect(document.getElementById('reflection-active-slide-img'), points));
    renderReflectionActiveSlideImage();
  },
});

document.addEventListener('mousedown', e => {
  if (selectionTagPopup.style.display !== 'none' && !selectionTagPopup.contains(e.target)
    && e.target.id !== 'reflection-transcript' && e.target.id !== 'reflection-active-slide-svg') {
    hideSelectionTagPopup();
  }
});

document.getElementById('save-piece-btn').addEventListener('click', () => {
  if (!pieceNoteDraft) return;
  const regionThumbnail = pieceNoteDraft.region
    ? cropRegionThumbnail(document.getElementById('reflection-active-slide-img'), pieceNoteDraft.region)
    : null;
  currentParticipant.pieces.push({
    id: makeId('piece'),
    type: pieceNoteDraft.type,
    slide_index: pieceNoteDraft.slide_index,
    excerpt: pieceNoteDraft.excerpt,
    region: pieceNoteDraft.region,
    regionThumbnail,
    note: document.getElementById('piece-note-input').value.trim(),
  });
  pieceNoteDraft = null;
  document.getElementById('piece-note-form').style.display = 'none';
  setStatus('piece-picker-status', '');
  renderPiecesLists();
  renderLinkGraph();
  renderReflectionActiveSlideImage();
});

document.getElementById('cancel-piece-btn').addEventListener('click', () => {
  pieceNoteDraft = null;
  document.getElementById('piece-note-form').style.display = 'none';
  setStatus('piece-picker-status', '');
  renderReflectionActiveSlideImage();
});

function renderPiecesLists() {
  const contributingList = document.getElementById('contributing-pieces-list');
  const confusingList = document.getElementById('confusing-pieces-list');
  contributingList.innerHTML = '';
  confusingList.innerHTML = '';
  currentParticipant.pieces.forEach(piece => {
    const list = piece.type === 'helping' ? contributingList : confusingList;
    const quote = piece.excerpt ? `: "${piece.excerpt}"` : '';
    const note = piece.note ? ` — ${piece.note}` : '';
    list.appendChild(buildRemovableRow(`Slide ${piece.slide_index}${quote}${note}`, () => {
      currentParticipant.pieces = currentParticipant.pieces.filter(p => p.id !== piece.id);
      currentParticipant.links = currentParticipant.links.filter(l => l.from_id !== piece.id && l.to_id !== piece.id);
      renderPiecesLists();
      renderLinkGraph();
      renderReflectionActiveSlideImage();
    }));
  });
}

// --- Reflection phase: Link Them Together (reuses helpers.js's shared
// renderDependencyStyleGraph; click-drag from one node to another to link
// them - mousedown on the source via onNodeMouseDown, then a page-wide
// mouseup checks whatever's under the pointer via elementFromPoint, same
// pattern as the carousel's drag-to-select-a-section). ---

// Graph includes: the participant's stated pre-talk goal (from the
// familiarity step's "what do you want to get out of this talk?"), every
// takeaway, and every tagged piece - global, not scoped to any one takeaway,
// so the participant can cluster whatever parts actually relate together.
// Shared by reflectionGraphNodes()/participantGraphNodes() - a piece node's
// label always names its kind (Helping/Confusing); a drawn-region piece also
// gets its slide/section as a stacked label above its cropped close-up
// (rather than inline next to it, and without the redundant "(drawn
// region)" - the close-up image already makes that obvious).
function pieceGraphNode(p, fallbackImageSrc) {
  const kind = p.type === 'helping' ? 'Helping' : 'Confusing';
  const nodeClass = p.type === 'helping' ? 'graph-node-piece-contributing' : 'graph-node-piece-confusing';
  const section = findSectionForSlide(p.slide_index);
  const slideText = section && section.title && section.title.trim()
    ? `Slide ${p.slide_index} — ${section.title.trim()}`
    : `Slide ${p.slide_index}`;
  const detail = p.excerpt ? `: "${p.excerpt}"` : '';
  const title = `${slideText}${detail}${p.note ? ` — ${p.note}` : ''}`;
  if (p.region) {
    return {
      id: p.id, label: kind, aboveLabel: shorten(slideText), title, nodeClass,
      imageSrc: p.regionThumbnail || fallbackImageSrc,
    };
  }
  return {
    id: p.id, label: shorten(`${kind}: ${p.excerpt || slideText}`), title, nodeClass,
    imageSrc: fallbackImageSrc,
  };
}

function reflectionGraphNodes() {
  const goalText = (currentParticipant.talk_goal || '').trim();
  const goalNodes = goalText ? [{
    id: 'goal', label: `Desired takeaway: ${shorten(goalText)}`, title: goalText, nodeClass: 'graph-node-goal',
  }] : [];
  const takeawayNodes = currentParticipant.takeaways.map(t => ({
    id: t.id, label: `Takeaway: ${shorten(t.text)}`, title: t.text, nodeClass: 'graph-node-takeaway',
  }));
  const pieceNodes = currentParticipant.pieces.map(p => {
    const slide = slides.find(s => s.slide_index === p.slide_index);
    return pieceGraphNode(p, slide ? `/${slide.snapshot_image}` : null);
  });
  return [...goalNodes, ...takeawayNodes, ...pieceNodes];
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
    // Taller than the default dependency-graph shape (1.8:1) - this graph
    // tends to have more nodes spread with images, and needs more vertical
    // room to breathe than a plain takeaway/slide dependency graph does.
    aspect: 1.3,
    minArea: 560 * 420,
  });
}

// --- Reflection phase: Parts to cut or add (shown once the takeaway loop
// is done, alongside Overall Ratings - not tied to any one takeaway).
// Tagged the same way as Pieces in the build-up step: its own slide/transcript
// reference panel, "Tag This Slide as..." buttons, and highlight-to-tag an
// excerpt, so cutting/adding feels like the same gesture as tagging a piece. ---

let editsActiveSlideIndex = null; // which slide's transcript is shown in this section's own reference panel
let editNoteDraft = null;         // { action, slide_index, excerpt } while the note form is open

function renderEditsCarousel() {
  const carousel = document.getElementById('edits-carousel');
  carousel.innerHTML = '';
  slides.forEach(slide => {
    const thumb = document.createElement('div');
    thumb.className = 'slide-thumb';
    thumb.classList.toggle('active', slide.slide_index === editsActiveSlideIndex);
    thumb.innerHTML = `
      <img src="/${slide.snapshot_image}" alt="Slide ${slide.slide_index}" draggable="false">
      <div class="thumb-label">Slide ${slide.slide_index}</div>
    `;
    thumb.addEventListener('click', () => onEditsSlideClick(slide));
    carousel.appendChild(thumb);
  });
}

function onEditsSlideClick(slide) {
  editsActiveSlideIndex = slide.slide_index;
  document.getElementById('edits-transcript').textContent = slide.transcript || '(No transcript for this slide.)';
  document.getElementById('edits-section-label').textContent = sectionLabelText(slide.slide_index);
  renderEditsCarousel();
  renderEditsActiveSlideImage();
}

// Mirrors renderReflectionActiveSlideImage() for the "Parts to cut or add"
// reference column (color-coded cut/add instead of contributing/confusing).
function renderEditsActiveSlideImage() {
  const wrap = document.getElementById('edits-active-slide-wrap');
  const slide = slides.find(s => s.slide_index === editsActiveSlideIndex);
  if (!slide) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  document.getElementById('edits-active-slide-img').src = `/${slide.snapshot_image}`;
  const svg = document.getElementById('edits-active-slide-svg');
  svg.innerHTML = '';
  currentParticipant.edits
    .filter(e => e.slide_index === slide.slide_index && e.region)
    .forEach(e => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('class', `region-saved-path ${e.action}`);
      path.setAttribute('d', regionToPathData(e.region));
      svg.appendChild(path);
    });
  const draftPoints = pendingEditRegionPoints
    || (editNoteDraft && editNoteDraft.slide_index === slide.slide_index ? editNoteDraft.region : null);
  if (draftPoints) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'region-draft-path');
    path.setAttribute('d', regionToPathData(draftPoints));
    svg.appendChild(path);
  }
}

function beginEditNote(action, slideIndex, excerpt, region) {
  editNoteDraft = { action, slide_index: slideIndex, excerpt: excerpt || null, region: region || null };
  document.getElementById('edit-note-input').value = '';
  document.getElementById('edit-note-form').style.display = '';
  const quote = excerpt ? ` ("${shorten(excerpt)}")` : '';
  const verb = action === 'cut' ? 'to cut' : 'as missing something';
  setStatus('edit-picker-status', `Tagged Slide ${slideIndex}${quote} ${verb}. Add a note and save.`);
  renderEditsActiveSlideImage();
}

document.getElementById('tag-slide-cut-btn').addEventListener('click', () => {
  if (editsActiveSlideIndex == null) {
    setStatus('edit-picker-status', 'Click a slide first.', true);
    return;
  }
  beginEditNote('cut', editsActiveSlideIndex, null);
});
document.getElementById('tag-slide-add-btn').addEventListener('click', () => {
  if (editsActiveSlideIndex == null) {
    setStatus('edit-picker-status', 'Click a slide first.', true);
    return;
  }
  beginEditNote('add', editsActiveSlideIndex, null);
});

// Floating popup for highlighting an excerpt in #edits-transcript, mirroring
// the piece-tagging selectionTagPopup but with Cut/Add buttons instead.
const editSelectionTagPopup = document.createElement('div');
editSelectionTagPopup.className = 'selection-tag-popup';
editSelectionTagPopup.style.display = 'none';

const tagSelectionCutBtn = document.createElement('button');
tagSelectionCutBtn.type = 'button';
tagSelectionCutBtn.className = 'btn-secondary';
tagSelectionCutBtn.textContent = 'Tag to Cut';
tagSelectionCutBtn.addEventListener('click', () => tagCurrentEditSelection('cut'));

const tagSelectionAddBtn = document.createElement('button');
tagSelectionAddBtn.type = 'button';
tagSelectionAddBtn.className = 'btn-secondary';
tagSelectionAddBtn.textContent = 'Tag as Missing';
tagSelectionAddBtn.addEventListener('click', () => tagCurrentEditSelection('add'));

editSelectionTagPopup.appendChild(tagSelectionCutBtn);
editSelectionTagPopup.appendChild(tagSelectionAddBtn);
document.body.appendChild(editSelectionTagPopup);

function showEditSelectionTagPopup(rect) {
  editSelectionTagPopup.style.display = '';
  editSelectionTagPopup.style.left = `${rect.left + rect.width / 2}px`;
  editSelectionTagPopup.style.top = `${rect.top - 8}px`;
}

// See pendingRegionPoints above (same pattern, kept separate since edits and
// pieces are entirely independent lists).
let pendingEditRegionPoints = null;

function hideEditSelectionTagPopup() {
  editSelectionTagPopup.style.display = 'none';
  pendingEditRegionPoints = null;
  renderEditsActiveSlideImage();
}

function tagCurrentEditSelection(action) {
  const region = pendingEditRegionPoints;
  const text = window.getSelection().toString().trim();
  hideEditSelectionTagPopup();
  if (editsActiveSlideIndex == null) return;
  if (region) {
    beginEditNote(action, editsActiveSlideIndex, null, region);
  } else if (text) {
    beginEditNote(action, editsActiveSlideIndex, text, null);
  }
}

document.getElementById('edits-transcript').addEventListener('mouseup', () => {
  const text = window.getSelection().toString().trim();
  if (!text || editsActiveSlideIndex == null) {
    hideEditSelectionTagPopup();
    return;
  }
  showEditSelectionTagPopup(window.getSelection().getRangeAt(0).getBoundingClientRect());
});

setupRegionDrawing({
  imgId: 'edits-active-slide-img',
  svgId: 'edits-active-slide-svg',
  isSlideSelected: () => editsActiveSlideIndex != null,
  onRegionDrawn: points => {
    pendingEditRegionPoints = points;
    showEditSelectionTagPopup(regionBoundingClientRect(document.getElementById('edits-active-slide-img'), points));
    renderEditsActiveSlideImage();
  },
});

document.addEventListener('mousedown', e => {
  if (editSelectionTagPopup.style.display !== 'none' && !editSelectionTagPopup.contains(e.target)
    && e.target.id !== 'edits-transcript' && e.target.id !== 'edits-active-slide-svg') {
    hideEditSelectionTagPopup();
  }
});

document.getElementById('save-edit-btn').addEventListener('click', () => {
  if (!editNoteDraft) return;
  currentParticipant.edits.push({
    id: makeId('edit'),
    action: editNoteDraft.action,
    slide_index: editNoteDraft.slide_index,
    excerpt: editNoteDraft.excerpt,
    region: editNoteDraft.region,
    note: document.getElementById('edit-note-input').value.trim(),
  });
  editNoteDraft = null;
  document.getElementById('edit-note-form').style.display = 'none';
  setStatus('edit-picker-status', '');
  renderEditsLists();
  renderEditsActiveSlideImage();
});

document.getElementById('cancel-edit-btn').addEventListener('click', () => {
  editNoteDraft = null;
  document.getElementById('edit-note-form').style.display = 'none';
  setStatus('edit-picker-status', '');
  renderEditsActiveSlideImage();
});

function renderEditsLists() {
  const cutList = document.getElementById('cut-edits-list');
  const addList = document.getElementById('add-edits-list');
  cutList.innerHTML = '';
  addList.innerHTML = '';
  currentParticipant.edits.forEach(edit => {
    const list = edit.action === 'cut' ? cutList : addList;
    const quote = edit.excerpt ? `: "${edit.excerpt}"` : '';
    const note = edit.note ? ` — ${edit.note}` : '';
    list.appendChild(buildRemovableRow(`Slide ${edit.slide_index}${quote}${note}`, () => {
      currentParticipant.edits = currentParticipant.edits.filter(e => e.id !== edit.id);
      renderEditsLists();
      renderEditsActiveSlideImage();
    }));
  });
}

// --- Reflection phase: The Presenter's Intended Takeaways (clarity check) -
// shown alongside Parts to cut/add and Overall Ratings, once the takeaway
// loop is done. One Yes/No + why-or-why-not per presentation-level takeaway
// the researcher defined in Setup mode's "Presenter's Takeaways" module
// (see the snapshot taken in enterReflectionPhase()). ---

function renderPresenterTakeawayClarity() {
  const container = document.getElementById('presenter-takeaway-clarity-list');
  container.innerHTML = '';
  if (currentParticipant.presenter_takeaway_clarity.length === 0) {
    container.textContent = 'The researcher hasn\'t specified any presentation-level takeaways for this study.';
    return;
  }
  currentParticipant.presenter_takeaway_clarity.forEach(entry => {
    const block = document.createElement('div');
    block.className = 'objectives-scope';

    const label = document.createElement('div');
    label.className = 'likert-label';
    label.textContent = `"${entry.objective_text}"`;
    block.appendChild(label);

    const pillsRow = document.createElement('div');
    pillsRow.className = 'audience-input-row';
    pillsRow.style.margin = '8px 0';

    const yesBtn = document.createElement('button');
    yesBtn.type = 'button';
    yesBtn.className = 'btn-secondary';
    yesBtn.classList.toggle('active', entry.clear === true);
    yesBtn.textContent = 'Yes, clear';
    yesBtn.addEventListener('click', () => {
      entry.clear = true;
      renderPresenterTakeawayClarity();
    });

    const noBtn = document.createElement('button');
    noBtn.type = 'button';
    noBtn.className = 'btn-secondary';
    noBtn.classList.toggle('active', entry.clear === false);
    noBtn.textContent = 'No, not clear';
    noBtn.addEventListener('click', () => {
      entry.clear = false;
      renderPresenterTakeawayClarity();
    });

    pillsRow.appendChild(yesBtn);
    pillsRow.appendChild(noBtn);
    block.appendChild(pillsRow);

    const why = document.createElement('textarea');
    why.className = 'styled-textarea';
    why.rows = 2;
    why.placeholder = 'Why or why not?';
    why.value = entry.why;
    why.addEventListener('input', () => { entry.why = why.value; });
    block.appendChild(why);

    container.appendChild(block);
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
  const unansweredPresenterTakeaway = currentParticipant.presenter_takeaway_clarity.some(e => e.clear === null);
  if (unansweredPresenterTakeaway) {
    setStatus('reflection-status', 'Please answer whether each of the presenter\'s takeaways was clear.', true);
    return;
  }
  const { understandability, relevance, detail } = currentParticipant.ratings;
  if (understandability == null || relevance == null || detail == null) {
    setStatus('reflection-status', 'Please set all three ratings first.', true);
    return;
  }
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

  const groups = new Map(); // familiarity rating -> {n, understandability, relevance, detail}
  participants.forEach(p => {
    const key = p.demographics.familiarity;
    if (!groups.has(key)) groups.set(key, { n: 0, understandability: 0, relevance: 0, detail: 0 });
    const g = groups.get(key);
    g.n += 1;
    g.understandability += p.ratings.understandability;
    g.relevance += p.ratings.relevance;
    g.detail += p.ratings.detail;
  });

  if (groups.size === 0) {
    container.textContent = 'No data yet.';
    return;
  }

  const table = document.createElement('table');
  table.className = 'calibrate-aggregate-table';
  table.innerHTML = `
    <thead>
      <tr><th>Self-rated familiarity</th><th># participants</th><th>Avg understandability</th><th>Avg relevance</th><th>Avg level of detail</th></tr>
    </thead>
  `;
  const tbody = document.createElement('tbody');
  [...groups.keys()].sort().forEach(familiarity => {
    const g = groups.get(familiarity);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${familiarity}</td><td>${g.n}</td><td>${(g.understandability / g.n).toFixed(2)}</td>`
      + `<td>${(g.relevance / g.n).toFixed(2)}</td><td>${(g.detail / g.n).toFixed(2)}</td>`;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.appendChild(table);
}

function participantGraphNodes(participant) {
  const goalText = (participant.talk_goal || '').trim();
  const goalNodes = goalText ? [{
    id: 'goal', label: `Desired takeaway: ${shorten(goalText)}`, title: goalText, nodeClass: 'graph-node-goal',
  }] : [];
  const takeawayNodes = participant.takeaways.map(t => ({
    id: t.id, label: `Takeaway: ${shorten(t.text)}`, title: t.text, nodeClass: 'graph-node-takeaway',
  }));
  const pieceNodes = participant.pieces.map(p => pieceGraphNode(p, null));
  return [...goalNodes, ...takeawayNodes, ...pieceNodes];
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

  const { understandability, relevance, detail: detailRating } = participant.ratings;
  const text = document.createElement('span');
  text.className = 'sim-objective-text';
  text.textContent = `${participant.demographics.age_range}, ${participant.demographics.education}, `
    + `${participant.demographics.field} - ${participant.takeaways.length} takeaway(s), `
    + `U:${understandability} R:${relevance} D:${detailRating}`;
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
    label.className = `sim-sample-grade ${piece.type === 'helping' ? 'sim-correct' : 'sim-incorrect'}`;
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
  if (!confirm('Delete all takeaways AND all participant data? This cannot be undone.')) return;

  presentationObjectives = [];
  sectionsByRange = {};
  slideObjectives = {};
  participants = [];
  currentSectionRange = null;
  setupSectionEditRange = null;
  saveObjectives();
  saveParticipants();

  renderPresentationObjectivesList();
  renderAllSectionsList();
  renderSetupSectionArea();
  renderSlideObjectivesList();
  renderAggregateTable();
  renderParticipantsList();
  renderParticipantCountStatus();
  setStatus('dataset-status', 'Cleared.');
}
document.getElementById('clear-dataset-btn').addEventListener('click', clearDataset);

// --- Init ---

renderPresentationObjectivesList();
renderAllSectionsList();
renderParticipantCountStatus();
renderAggregateTable();
renderParticipantsList();

// Silently restore the last-loaded deck folder on page refresh - a plain
// reload isn't a deliberate "load new presentation files" act, so it
// shouldn't reset the takeaways already specified for it (resetTakeaways: false).
const savedDeckFolder = localStorage.getItem(DECK_FOLDER_STORAGE_KEY) || DEFAULT_SETUP.deckFolder;
if (savedDeckFolder) {
  document.getElementById('deck-folder-input').value = savedDeckFolder;
  loadDeckFolder(savedDeckFolder, { resetTakeaways: false });
}

const savedTalkAbstract = localStorage.getItem(TALK_ABSTRACT_STORAGE_KEY) || DEFAULT_SETUP.talkAbstract;
if (savedTalkAbstract) document.getElementById('talk-abstract-input').value = savedTalkAbstract;
renderTalkAbstractDisplay();
