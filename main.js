// helper functions in helpers.js loaded before this
// --- slide carousel + transcript ---
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
    // render plausible target audiences from slide transcript
    renderSuggestedChips(computeInferredAudiences(slides));
  })
  .catch(err => {
    document.getElementById('transcript-text').textContent = 'Failed to load slides.json: ' + err;
  });

// --- target audiences module ---
let targetAudiences = [];

// ability to enter and click to add audiences/click to remove audiences
function renderTargetAudiences() {
  const container = document.getElementById('target-audiences-list');
  container.innerHTML = '';

  if (targetAudiences.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'audience-empty-hint';
    hint.textContent = 'No target audiences yet — add one above or click a suggestion.';
    container.appendChild(hint);
    return;
  }

  targetAudiences.forEach(name => {
    const chip = document.createElement('span');
    chip.className = 'chip target';
    chip.innerHTML = `<span>${name}</span><span class="remove-x" data-name="${name}">×</span>`;
    chip.querySelector('.remove-x').addEventListener('click', () => {
      targetAudiences = targetAudiences.filter(n => n !== name);
      renderTargetAudiences();
    });
    container.appendChild(chip);
  });
}

function addTargetAudience(rawName) {
  const name = rawName.trim();
  if (!name) return;
  if (targetAudiences.some(n => n.toLowerCase() === name.toLowerCase())) return;
  targetAudiences.push(name);
  renderTargetAudiences();
}

// show suggested audiences that can be added
function renderSuggestedChips(inferred) {
  const container = document.getElementById('suggested-chips');
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
    chip.addEventListener('click', () => addTargetAudience(item.label));
    container.appendChild(chip);
  });
}

const audienceInput = document.getElementById('audience-input');
const addAudienceBtn = document.getElementById('add-audience-btn');

addAudienceBtn.addEventListener('click', () => {
  addTargetAudience(audienceInput.value);
  audienceInput.value = '';
});
audienceInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    addTargetAudience(audienceInput.value);
    audienceInput.value = '';
  }
});

// initial call
renderTargetAudiences();

// --- target audiences --> sphere of knowledge extracted from each module ---
// NOTE: the knowledge-hierarchy step (buildVenn, in helpers.js) is MOCKED —
// real content is fetched for Wikipedia URLs / uploaded files, but the venn
// diagram shown is fixed demo data, built once from all sources combined

// text segmentation (fetchSegments, also in helpers.js) is REAL and runs
// separately on each source (each uploaded document and the URL each get
// their own segmentation pass) rather than on their text concatenated together
// it calls a local Python backend (backend/server.py) that must be running
const fileInput = document.getElementById('file-input');
const urlInput = document.getElementById('url-input');
const extractBtn = document.getElementById('extract-btn');
const statusEl = document.getElementById('hierarchy-status');
const treeEl = document.getElementById('hierarchy-tree');

function setStatus(message, isError) {
  statusEl.textContent = message || '';
  statusEl.classList.toggle('error', !!isError);
}

function processSources(sources) {
  treeEl.innerHTML = '';

  const totalChars = sources.reduce((sum, s) => sum + s.text.length, 0);
  const headerEl = document.createElement('div');
  headerEl.className = 'tree-source';
  headerEl.textContent = `${sources.length} source${sources.length === 1 ? '' : 's'} loaded (${totalChars.toLocaleString()} characters total): ${sources.map(s => s.label).join(', ')}`;
  treeEl.appendChild(headerEl);

  setStatus('Segmenting each source (this calls the local Python backend)...');

  const feedEl = document.createElement('div');
  feedEl.className = 'segments-feed';
  treeEl.appendChild(feedEl);

  // segmentation is real, running once per source against the Python
  // backend, so a topic shift between documents (e.g. an unrelated upload
  // vs. the URL's article) doesn't get folded into a single shared
  // segmentation pass
  // requests run concurrently; the venn step (still mocked) only starts
  // once every source has finished
  // all segments render into feedEl, a fixed-height scrollable feed, so a
  // large number of segments/sources doesn't make the whole page balloon in length
  const segmentTasks = sources.map(source =>
    fetchSegments(source.text, source.label).then(segmentation => {
      renderSegmentation(feedEl, segmentation, source.label);
    })
  );

  const combinedLabel = sources.map(s => s.label).join(' + ');

  Promise.all(segmentTasks)
    .then(() => {
      setStatus(`Segmented ${sources.length} source${sources.length === 1 ? '' : 's'}. Extracting knowledge hierarchy...`);
      setTimeout(() => {
        buildVenn(treeEl, combinedLabel);
        setStatus(`Done. Parsed "${combinedLabel}".`);
        extractBtn.disabled = false;
      }, 700);
    })
    .catch(err => {
      setStatus(err.message, true);
      extractBtn.disabled = false;
    });
}

function runExtraction() {
  const files = Array.from(fileInput.files);
  const rawUrl = urlInput.value.trim();

  if (files.length === 0 && !rawUrl) {
    setStatus('Please upload a document, enter a Wikipedia URL, or both.', true);
    return;
  }

  const tasks = files.map(f => readFile(f));
  if (rawUrl) tasks.push(fetchWikipediaUrl(rawUrl));

  setStatus('Reading input...');
  extractBtn.disabled = true;

  Promise.all(tasks)
    .then(results => processSources(results))
    .catch(err => {
      extractBtn.disabled = false;
      setStatus(err.message, true);
    });
}

extractBtn.addEventListener('click', runExtraction);
urlInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') runExtraction();
});
