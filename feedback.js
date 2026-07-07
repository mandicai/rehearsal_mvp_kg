// helper functions in helpers.js loaded before this
// --- slide carousel + transcript (same wiring as main.js) ---
let slides = [];
let activeIndex = 0;

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
}

fetch('slides.json')
  .then(res => res.json())
  .then(data => {
    slides = data;
    const carousel = document.getElementById('carousel');

    slides.forEach((slide, i) => {
      const thumb = document.createElement('div');
      thumb.className = 'slide-thumb';
      thumb.innerHTML = `
        <img src="${slide.snapshot_image}" alt="Slide ${slide.slide_index}">
        <div class="thumb-label">${slide.start_time}</div>
      `;
      thumb.addEventListener('click', () => selectSlide(i));
      carousel.appendChild(thumb);
    });

    selectSlide(0);
    renderSuggestedChips(computeInferredAudiences(slides));
  })
  .catch(err => {
    document.getElementById('transcript-text').textContent = 'Failed to load slides.json: ' + err;
  });

// --- audience picker: unlike index.html's multi-select target-audience
// list, the feedback module only ever role-plays as one persona at a time,
// so a suggested chip just fills the text input rather than adding to a list ---
const audienceInput = document.getElementById('feedback-audience-input');

function renderSuggestedChips(inferred) {
  const container = document.getElementById('feedback-suggested-chips');
  container.innerHTML = '';

  if (inferred.length === 0) {
    container.innerHTML = '<span class="audience-empty-hint">No strong audience signals detected in this transcript.</span>';
    return;
  }

  inferred.forEach(item => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip suggested';
    chip.innerHTML = `+ ${item.label} <span class="hit-count">(${item.count})</span>`;
    chip.addEventListener('click', () => { audienceInput.value = item.label; });
    container.appendChild(chip);
  });
}

// --- feedback module: audience + prompt + transcript + slide images feed
// into a vision-capable LLM (real, via backend/server.py's /feedback route,
// see feedback_llm.py) that role-plays as the chosen audience and reacts to
// the presentation ---
const promptInput = document.getElementById('feedback-prompt-input');
const getFeedbackBtn = document.getElementById('get-feedback-btn');
const statusEl = document.getElementById('feedback-status');
const resultEl = document.getElementById('feedback-result');

function setStatus(message, isError) {
  statusEl.textContent = message || '';
  statusEl.classList.toggle('error', !!isError);
}

function runFeedback() {
  const audience = audienceInput.value.trim();
  const prompt = promptInput.value.trim();

  if (!audience) {
    setStatus('Please enter or pick a target audience first.', true);
    return;
  }
  if (slides.length === 0) {
    setStatus('Slides have not loaded yet.', true);
    return;
  }

  getFeedbackBtn.disabled = true;
  resultEl.innerHTML = '';
  setStatus('Preparing slide images...');

  prepareSlidePayload(slides)
    .then(slidePayload => {
      console.log('slidePayload', slidePayload.map(s => ({ ...s, image: `${s.image.length} chars` })));
      setStatus(`Asking "${audience}" to review the presentation (this calls the local Python backend)...`);
      return fetchFeedback(audience, prompt, slidePayload);
    })
    .then(feedbackText => {
      renderFeedbackResult(resultEl, audience, feedbackText);
      setStatus('Done.');
    })
    .catch(err => {
      setStatus(err.message, true);
    })
    .finally(() => {
      getFeedbackBtn.disabled = false;
    });
}

getFeedbackBtn.addEventListener('click', runFeedback);
