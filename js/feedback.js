// js/feedback.js - persona+goal progressive presentation feedback. Reuses
// whatever deck + presenter-defined sections/takeaways are already
// configured in Setup (participant-view.html), via the exact same
// localStorage keys js/participant-view.js reads/writes - no separate deck
// picker lives on this page at all.
// helper functions in helpers.js loaded before this.

const DECK_FOLDER_STORAGE_KEY = 'calibrate-priors-deck-folder-v1';
const OBJECTIVES_STORAGE_KEY = 'calibrate-priors-objectives-v2';

let slides = [];
let activeIndex = 0;
let sectionsByRange = {};
let presentationObjectives = [];

// --- Sections/takeaways: read-only mirror of participant-view.js's own
// findSectionForSlide() - section-level recaps are simply skipped (see
// runFeedbackSession) if the loaded deck has none defined. ---
function findSectionForSlide(slideIndex) {
  return Object.values(sectionsByRange).find(s => slideIndex >= s.start_slide_index && slideIndex <= s.end_slide_index) || null;
}

function isLastSlideOfSection(slide) {
  const section = findSectionForSlide(slide.slide_index);
  return section && section.end_slide_index === slide.slide_index ? section : null;
}

function sectionKeyFor(section) {
  return `section:${section.start_slide_index}-${section.end_slide_index}`;
}

// --- Carousel + transcript (same wiring shape as main.js/presenter-view.js) ---

function selectSlide(index) {
  activeIndex = index;
  const slide = slides[index];

  document.querySelectorAll('.slide-thumb').forEach((el, i) => {
    el.classList.toggle('active', i === index);
  });

  document.getElementById('slide-number').textContent = `Slide ${slide.slide_index}`;
  document.getElementById('timestamp').textContent = `${slide.start_time} - ${slide.end_time}`;
  document.getElementById('transcript-text').textContent = slide.transcript || '(no speech on this slide)';

  const activeThumb = document.querySelectorAll('.slide-thumb')[index];
  if (activeThumb) {
    activeThumb.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }

  renderSlideFeedbackPanel(slide);
}

function loadDeck() {
  const folder = localStorage.getItem(DECK_FOLDER_STORAGE_KEY);
  if (!folder) {
    document.getElementById('transcript-text').textContent =
      'No deck configured yet - load one in Setup (participant-view.html) first.';
    return;
  }

  try {
    const parsed = JSON.parse(localStorage.getItem(OBJECTIVES_STORAGE_KEY));
    if (parsed) {
      presentationObjectives = parsed.presentationObjectives || [];
      sectionsByRange = parsed.sectionsByRange || {};
    }
  } catch (err) { /* no takeaways configured yet - section recaps just get skipped */ }

  fetch(`/${folder}/slides.json`)
    .then(res => {
      if (!res.ok) throw new Error(`slides.json not found (HTTP ${res.status})`);
      return res.json();
    })
    .then(data => {
      slides = data.map(slide => ({ ...slide, snapshot_image: `${folder}/${slide.snapshot_image}` }));
      const carousel = document.getElementById('carousel');
      carousel.innerHTML = '';
      slides.forEach((slide, i) => {
        const thumb = document.createElement('div');
        thumb.className = 'slide-thumb';
        thumb.innerHTML = `
          <img src="/${slide.snapshot_image}" alt="Slide ${slide.slide_index}">
          <div class="thumb-label">${slide.start_time}</div>
        `;
        thumb.addEventListener('click', () => selectSlide(i));
        carousel.appendChild(thumb);
      });
      selectSlide(0);
    })
    .catch(err => {
      document.getElementById('transcript-text').textContent = `Could not load deck "${folder}": ${err.message}`;
    });
}

loadDeck();

// --- Setup inputs ---
const audienceInput = document.getElementById('feedback-audience-input');
const goalInput = document.getElementById('feedback-goal-input');
const promptInput = document.getElementById('feedback-prompt-input');
const getFeedbackBtn = document.getElementById('get-feedback-btn');
const statusEl = document.getElementById('feedback-status');
const timelineEl = document.getElementById('feedback-timeline');

function setStatus(message, isError) {
  statusEl.textContent = message || '';
  statusEl.classList.toggle('error', !!isError);
}

// --- Feedback results so far, keyed by slide_index (a number) for
// per-slide entries, or a synthetic string key for a section recap
// (sectionKeyFor) or the final 'overall' entry. ---
let feedbackByKey = {};

function appendFeedbackFields(container, entry) {
  const flow = document.createElement('div');
  flow.className = 'progressive-step-field';
  const flowLabel = document.createElement('b');
  flowLabel.textContent = 'Flow:';
  flow.appendChild(flowLabel);
  flow.appendChild(document.createTextNode(` ${entry.flow_feedback}`));
  container.appendChild(flow);

  const understanding = document.createElement('div');
  understanding.className = 'progressive-step-field';
  const understandingLabel = document.createElement('b');
  understandingLabel.textContent = 'Understanding:';
  understanding.appendChild(understandingLabel);
  understanding.appendChild(document.createTextNode(` ${entry.understanding_feedback}`));
  container.appendChild(understanding);
}

function renderTimelineEntry(headerText, entry) {
  const card = document.createElement('div');
  card.className = 'progressive-step-card';

  const header = document.createElement('div');
  header.className = 'progressive-step-header';
  header.textContent = headerText;
  card.appendChild(header);

  appendFeedbackFields(card, entry);

  timelineEl.appendChild(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Shows the selected slide's own feedback, plus (anchored to whichever
// slide triggered them) that slide's section recap if it's a section's
// last slide, and the overall wrap-up if it's the deck's last slide -
// entirely from already-fetched data, no network call.
function renderSlideFeedbackPanel(slide) {
  const panel = document.getElementById('slide-feedback-panel');
  panel.innerHTML = '';

  const slideBlock = document.createElement('div');
  const slideLabel = document.createElement('div');
  slideLabel.className = 'slide-feedback-label';
  slideLabel.textContent = `Slide ${slide.slide_index} feedback`;
  slideBlock.appendChild(slideLabel);
  const slideEntry = feedbackByKey[slide.slide_index];
  if (slideEntry) {
    appendFeedbackFields(slideBlock, slideEntry);
  } else {
    const hint = document.createElement('div');
    hint.className = 'progressive-step-field';
    hint.textContent = 'Not generated yet - click "Get Feedback" to run the session.';
    slideBlock.appendChild(hint);
  }
  panel.appendChild(slideBlock);

  const section = isLastSlideOfSection(slide);
  const recapEntry = section && feedbackByKey[sectionKeyFor(section)];
  if (recapEntry) {
    const recapBlock = document.createElement('div');
    recapBlock.style.marginTop = '14px';
    const recapLabel = document.createElement('div');
    recapLabel.className = 'slide-feedback-label';
    recapLabel.textContent = `Section recap: ${(section.title || '').trim() || '(untitled section)'}`;
    recapBlock.appendChild(recapLabel);
    appendFeedbackFields(recapBlock, recapEntry);
    panel.appendChild(recapBlock);
  }

  const isLastSlide = slides.length > 0 && slide.slide_index === slides[slides.length - 1].slide_index;
  const overallEntry = isLastSlide && feedbackByKey.overall;
  if (overallEntry) {
    const overallBlock = document.createElement('div');
    overallBlock.style.marginTop = '14px';
    const overallLabel = document.createElement('div');
    overallLabel.className = 'slide-feedback-label';
    overallLabel.textContent = 'Overall feedback';
    overallBlock.appendChild(overallLabel);
    appendFeedbackFields(overallBlock, overallEntry);
    panel.appendChild(overallBlock);
  }
}

function refreshPanelIfSelected(slideIndex) {
  if (slides[activeIndex] && slides[activeIndex].slide_index === slideIndex) {
    renderSlideFeedbackPanel(slides[activeIndex]);
  }
}

// Runs the whole deck as one real, continuing conversation: one turn per
// slide in order (paced by PROGRESSIVE_STEP_DELAY_MS - see helpers.js),
// with a synthetic section-recap turn (no image, skipped entirely if the
// deck has no sections defined) right after each section's last slide, and
// a final synthetic overall-feedback turn after the whole deck - see
// backend/feedback_llm.py's get_progressive_reaction for how these
// checkpoint turns share the exact same request/response shape as a real slide.
function runFeedbackSession() {
  const audience = audienceInput.value.trim();
  const goal = goalInput.value.trim();
  const prompt = promptInput.value.trim();

  if (!audience) {
    setStatus('Please enter an audience persona first.', true);
    return;
  }
  if (slides.length === 0) {
    setStatus('No deck loaded yet.', true);
    return;
  }

  getFeedbackBtn.disabled = true;
  feedbackByKey = {};
  timelineEl.innerHTML = '';
  renderSlideFeedbackPanel(slides[activeIndex]);
  setStatus('Preparing slide images...');

  let messages = [];

  function runCheckpoint(headerText, key, checkpointSlide, anchorSlideIndex) {
    return fetchProgressiveReaction(audience, prompt, messages, checkpointSlide, goal).then(data => {
      messages = data.messages;
      const entry = { flow_feedback: data.flow_feedback, understanding_feedback: data.understanding_feedback };
      feedbackByKey[key] = entry;
      renderTimelineEntry(headerText, entry);
      refreshPanelIfSelected(anchorSlideIndex);
    });
  }

  prepareSlidePayload(slides)
    .then(slidePayload => {
      setStatus(`Watching as "${audience}"...`);
      return slidePayload.reduce((chain, slidePayloadItem, index) => {
        const slide = slides[index];
        return chain
          .then(() => (index === 0 ? Promise.resolve() : delay(PROGRESSIVE_STEP_DELAY_MS)))
          .then(() => runCheckpoint(
            `Slide ${slide.slide_index} (${slide.start_time} - ${slide.end_time})`,
            slide.slide_index,
            slidePayloadItem,
            slide.slide_index,
          ))
          .then(() => {
            const section = isLastSlideOfSection(slide);
            if (!section) return;
            const sectionTitle = (section.title || '').trim() || '(untitled section)';
            const takeaways = (section.objectives || []).map(o => o.text).join('; ');
            return delay(PROGRESSIVE_STEP_DELAY_MS).then(() => runCheckpoint(
              `Section recap: ${sectionTitle}`,
              sectionKeyFor(section),
              {
                slide_index: null,
                transcript: `You've just finished the section titled "${sectionTitle}" (covering the slides you `
                  + 'just saw).'
                  + (takeaways ? ` The presenter's intended takeaway for this section: ${takeaways}.` : '')
                  + ' Reflect specifically on this section as a whole before moving on.',
              },
              slide.slide_index,
            ));
          });
      }, Promise.resolve());
    })
    .then(() => delay(PROGRESSIVE_STEP_DELAY_MS))
    .then(() => {
      const takeaways = presentationObjectives.map(o => o.text).join('; ');
      const lastSlide = slides[slides.length - 1];
      return runCheckpoint(
        'Overall feedback',
        'overall',
        {
          slide_index: null,
          transcript: 'The presentation has now ended entirely.'
            + (takeaways ? ` The presenter's overall intended takeaway: ${takeaways}.` : '')
            + ' Give your overall feedback on the presentation as a whole now, thinking back on everything you saw.',
        },
        lastSlide.slide_index,
      );
    })
    .then(() => setStatus('Done.'))
    .catch(err => setStatus(err.message, true))
    .finally(() => { getFeedbackBtn.disabled = false; });
}

getFeedbackBtn.addEventListener('click', runFeedbackSession);
