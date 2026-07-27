// helper functions in helpers.js loaded before this
// --- slide carousel + transcript (same wiring as main.js/feedback.js) ---
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

const DECK_DIR = 'presentation-examples/flower';

fetch(`/${DECK_DIR}/slides.json`)
  .then(res => res.json())
  .then(data => {
    slides = data.map(slide => ({ ...slide, snapshot_image: `${DECK_DIR}/${slide.snapshot_image}` }));
    const carousel = document.getElementById('carousel');

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
    document.getElementById('transcript-text').textContent = 'Failed to load slides.json: ' + err;
  });

// --- Carta pipeline inspector: upload document(s)/a Wikipedia URL, run them
// through the separate segmentation_carta pipeline (backend/segmentation_carta/,
// via /segment_carta - see helpers.js's fetchCartaResult/renderCartaChunks/
// renderCartaEntities/renderCartaPredicates/renderCartaClusters/renderCartaSchema),
// and show the resulting chunks (with their rolling context summary and raw
// per-chunk entity mentions), the merged per-document entity list (with
// cross-document evidence, related entities, and RDF-triple relations), the
// predicate glossary (one description per unique predicate), the
// similarity-based entity/predicate clusters with their canonical labels,
// and the iteratively-built schema (type taxonomy), for double-checking the
// pipeline's output at every stage. Real, not mocked - same local Python
// backend as knowledge.html's segmentation module, which must be running.
const fileInput = document.getElementById('carta-file-input');
const urlInput = document.getElementById('carta-url-input');
const extractBtn = document.getElementById('carta-extract-btn');
const statusEl = document.getElementById('carta-status');
const resultsEl = document.getElementById('carta-results');

function setStatus(message, isError) {
  statusEl.textContent = message || '';
  statusEl.classList.toggle('error', !!isError);
}

function processSources(sources) {
  resultsEl.innerHTML = '';

  const totalChars = sources.reduce((sum, s) => sum + s.text.length, 0);
  const headerEl = document.createElement('div');
  headerEl.className = 'tree-source';
  headerEl.textContent = `${sources.length} source${sources.length === 1 ? '' : 's'} loaded (${totalChars.toLocaleString()} characters total): ${sources.map(s => s.label).join(', ')}`;
  resultsEl.appendChild(headerEl);

  setStatus('Running the segmentation_carta pipeline - chunking, entity extraction, evidence gathering, related-entity recognition, relation extraction, predicate description, similarity clustering, canonical labeling, and iterative schema construction (this calls the local Python backend and can take a while)...');

  const feedEl = document.createElement('div');
  feedEl.className = 'segments-feed';
  resultsEl.appendChild(feedEl);

  // each source runs through the carta pipeline independently, same as the
  // segmentation module on knowledge.html - a topic shift between an upload and
  // a URL isn't folded into one shared chunking pass
  const tasks = sources.map(source =>
    fetchCartaResult(source.text, source.label).then(result => {
      renderCartaChunks(feedEl, result, source.label);
      renderCartaEntities(feedEl, result, source.label);
      renderCartaPredicates(feedEl, result, source.label);
      renderCartaClusters(feedEl, result, source.label);
      renderCartaSchema(feedEl, result, source.label);
    })
  );

  Promise.all(tasks)
    .then(() => {
      setStatus(`Done. Parsed "${sources.map(s => s.label).join(' + ')}".`);
      extractBtn.disabled = false;
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
