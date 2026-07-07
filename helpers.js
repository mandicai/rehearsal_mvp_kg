// Reusable, self-contained functions and data: text analysis, algorithms,
// and DOM-building routines that take their target container/data as
// parameters rather than reaching into page-specific global state.
// App wiring and mutable state live in main.js instead.

// --- Target audience inference ---
// Suggestions are computed for real from the actual transcript text (simple
// keyword matching below) — not mocked. The list of candidate audiences and
// their trigger words is still a hand-picked heuristic, not a real model.

const AUDIENCE_RULES = [
  { label: 'Presenters / Educators', re: /\bpresenters?\b|\bpresenter'?s notes\b/gi },
  { label: 'Students / Classroom Learners', re: /\bstudents?\b|\bclass\b|\blesson\b/gi },
  { label: 'Biology / Life-Science Learners', re: /\breproductive\b|\bovule\b|\bpollen\b|\borganism\b/gi },
  { label: 'Gardening Enthusiasts', re: /\bgarden\w*|\bbloom\w*|\bpetal\w*/gi },
  { label: 'Allergy-aware Audience', re: /\ballerg\w*/gi }
];

function computeInferredAudiences(slideData) {
  const fullText = slideData.map(s => s.transcript || '').join(' ');
  return AUDIENCE_RULES
    .map(rule => ({ label: rule.label, count: (fullText.match(rule.re) || []).length }))
    .filter(r => r.count > 0)
    .sort((a, b) => b.count - a.count);
}

// --- Structure-aware semantic segmentation ---
// Real implementation: parses document structure (headings/paragraphs/lists),
// builds base text units, embeds them with a sentence-transformer
// (all-MiniLM-L6-v2), scores candidate boundaries from semantic + entity +
// keyphrase shift plus heading signals, refines for entity continuity and
// length constraints, then labels each final segment with a topic label,
// summary, entities, and keyphrases (via an LLM when an API key is
// configured server-side, otherwise a local spaCy/keyphrase heuristic).
// All of that only runs in Python, so the pipeline lives in
// backend/segmentation/ behind a small local HTTP service
// (backend/server.py) — this function just calls it. Start it with
// `python backend/server.py` before using the upload/URL extractor.

const SEGMENT_API_URL = 'http://127.0.0.1:8000/segment';

function fetchSegments(text, documentId) {
  return fetch(SEGMENT_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, document_id: documentId })
  })
    .then(res => {
      if (!res.ok) {
        return res.json()
          .catch(() => ({}))
          .then(body => { throw new Error(body.error || `server responded with ${res.status}`); });
      }
      return res.json();
    })
    .catch(err => {
      throw new Error(
        `Could not reach the segmentation server at ${SEGMENT_API_URL} (${err.message}). ` +
        `Start it with: python backend/server.py`
      );
    });
}

function renderChipList(container, values, chipClass) {
  values.forEach(value => {
    const chip = document.createElement('span');
    chip.className = `chip ${chipClass}`;
    chip.textContent = value;
    container.appendChild(chip);
  });
}

function renderSegmentation(container, result, sourceLabel) {
  const section = document.createElement('div');
  section.className = 'segments-section';

  const label = document.createElement('div');
  label.className = 'section-label';
  label.textContent = `Segments for "${sourceLabel}" — structure-aware semantic segmentation, computed for real from this input (${result.segments.length} segment${result.segments.length === 1 ? '' : 's'})${result.truncated ? ', truncated' : ''}`;
  section.appendChild(label);

  result.segments.forEach(segment => {
    const card = document.createElement('div');
    card.className = 'segment-card';

    const title = document.createElement('div');
    title.className = 'segment-title';
    title.textContent = segment.topic_label;
    card.appendChild(title);

    const meta = segment.source_metadata || {};
    const metaParts = [meta.section_title, meta.subsection_title].filter(Boolean);
    if (metaParts.length > 0) {
      const metaEl = document.createElement('div');
      metaEl.className = 'segment-meta';
      metaEl.textContent = metaParts.join(' › ');
      card.appendChild(metaEl);
    }

    if (segment.summary) {
      const summary = document.createElement('div');
      summary.className = 'segment-summary';
      summary.textContent = segment.summary;
      card.appendChild(summary);
    }

    const chips = document.createElement('div');
    chips.className = 'segment-chips';
    renderChipList(chips, segment.top_entities || [], 'entity');
    renderChipList(chips, segment.keyphrases || [], 'keyphrase');
    if (chips.children.length > 0) card.appendChild(chips);

    const text = document.createElement('div');
    text.className = 'segment-text';
    text.textContent = segment.text;
    card.appendChild(text);

    section.appendChild(card);
  });

  container.appendChild(section);
}

// --- Knowledge hierarchy Venn diagram ---
// NOTE: this section is MOCKED — it always renders the same fixed demo data
// regardless of input, since real hierarchy classification needs a model
// this prototype doesn't call. Circles are laid out in a 2x2 overlapping
// cluster (viewBox 0 0 480 380) so all four visually intersect near the
// center. "common" is the shared core known across every audience; each
// audience's "items" are the knowledge unique to that group, layered on top
// of the common core.

const VENN_DATA = {
  common: {
    title: 'Common knowledge',
    subtitle: 'Known by nearly everyone, across all audiences',
    items: [
      'A flower is the colorful part of a plant, usually with petals and a pleasant scent',
      'Flowers grow on stems and eventually wilt or fall off',
      'Bees, butterflies, and other insects visit flowers',
      'Flowers are given as gifts and used in weddings, funerals, and decoration',
      'Flowers can turn into fruit (an apple starts as a flower)',
      'Flowers come in many colors, sizes, and shapes'
    ]
  },
  audiences: [
    {
      id: 'public',
      label: 'General Public',
      cx: 190, cy: 150,
      color: '#FFFFFF',
      textColor: '#EB1000',
      labelPos: { x: 23, y: 21 },
      items: []
    },
    {
      id: 'educated',
      label: 'Educated Learner',
      cx: 290, cy: 150,
      color: '#FFD166',
      textColor: '#5C3D00',
      labelPos: { x: 77, y: 21 },
      items: [
        'Anatomy: petals (corolla) vs. sepals (calyx)',
        'Flowers are the plant’s reproductive organ: stamens (male) and pistil (female)',
        'Pollination moves pollen from stamen to pistil, via insects, wind, or birds',
        'After pollination the ovary becomes fruit and ovules become seeds',
        'Some flowers are radially symmetrical (daisy) vs. irregular (orchid)',
        'Cultural facts: national flowers, flower symbolism, floristry as an industry',
        'Major food crops (rice, wheat, corn) are flowering plants'
      ]
    },
    {
      id: 'student',
      label: 'Botany Student',
      cx: 190, cy: 230,
      color: '#06D6A0',
      textColor: '#003B2E',
      labelPos: { x: 23, y: 79 },
      items: [
        'Precise structure: anther + filament (stamen); stigma + style + ovary (carpel)',
        'Flower sexuality: perfect/imperfect, monoecious/dioecious, heterantherous',
        'Biotic vs. abiotic pollination; nectar guides visible only in UV',
        'Double fertilisation produces both a zygote and triploid endosperm',
        'Seed/embryo development: cotyledon, radicle, epicotyl, hypocotyl',
        'Fruit anatomy: exocarp, mesocarp, endocarp/pyrena',
        'Inflorescences and pseudanthia (a sunflower is a cluster of florets)'
      ]
    },
    {
      id: 'specialist',
      label: 'Specialist / Researcher',
      cx: 290, cy: 230,
      color: '#118AB2',
      textColor: '#FFFFFF',
      labelPos: { x: 77, y: 79 },
      items: [
        'ABC(DE) model: MADS-box gene combinations specify organ identity',
        'Floral formulae and floral diagrams as formal notation systems',
        'Structural coloration: iridescence and photonic crystals in petals',
        'Flowering-transition physiology: photoperiodism, vernalization, florigen',
        'Coevolution case studies, e.g. honeysuckle timed to nocturnal moths',
        'Evolutionary history debates: molecular estimates vs. fossil record',
        'History of plant taxonomy from Linnaeus to DNA-sequence classification'
      ]
    }
  ]
};

function renderGroupPanel(panelEl, group, isCommon) {
  panelEl.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'venn-panel-title';
  title.textContent = isCommon ? group.title : group.label;
  panelEl.appendChild(title);

  const subtitle = document.createElement('div');
  subtitle.className = 'venn-panel-subtitle';
  subtitle.textContent = isCommon ? group.subtitle : 'Knowledge unique to this audience, on top of the common core';
  panelEl.appendChild(subtitle);

  if (group.items.length === 0) {
    const note = document.createElement('div');
    note.className = 'empty-note';
    note.textContent = 'No knowledge beyond the common core — this audience relies entirely on what most people already know.';
    panelEl.appendChild(note);
    return;
  }

  const ul = document.createElement('ul');
  group.items.forEach(item => {
    const li = document.createElement('li');
    li.textContent = item;
    ul.appendChild(li);
  });
  panelEl.appendChild(ul);
}

function buildVenn(container, sourceLabel) {
  const section = document.createElement('div');
  section.className = 'venn-section';

  const sourceEl = document.createElement('div');
  sourceEl.className = 'section-label';
  sourceEl.textContent = `Knowledge hierarchy for "${sourceLabel}" — demo output (not yet connected to a real model)`;
  section.appendChild(sourceEl);

  const wrap = document.createElement('div');
  wrap.className = 'venn-wrap';

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 480 380');

  VENN_DATA.audiences.forEach(a => {
    const circle = document.createElementNS(svgNS, 'circle');
    circle.setAttribute('cx', a.cx);
    circle.setAttribute('cy', a.cy);
    circle.setAttribute('r', 100);
    circle.setAttribute('fill', a.color);
    circle.setAttribute('fill-opacity', '0.45');
    circle.dataset.id = a.id;
    svg.appendChild(circle);
  });

  wrap.appendChild(svg);

  const panel = document.createElement('div');
  panel.className = 'venn-panel';

  function selectGroup(id) {
    wrap.querySelectorAll('.venn-label').forEach(el => {
      el.classList.toggle('active', el.dataset.id === id);
    });
    svg.querySelectorAll('circle').forEach(el => {
      el.classList.toggle('active-circle', el.dataset.id === id);
    });

    if (id === 'common') {
      renderGroupPanel(panel, VENN_DATA.common, true);
    } else {
      renderGroupPanel(panel, VENN_DATA.audiences.find(a => a.id === id), false);
    }
  }

  VENN_DATA.audiences.forEach(a => {
    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'venn-label';
    label.dataset.id = a.id;
    label.textContent = a.label;
    label.style.left = `${a.labelPos.x}%`;
    label.style.top = `${a.labelPos.y}%`;
    label.style.background = a.color;
    label.style.color = a.textColor;
    label.addEventListener('click', () => selectGroup(a.id));
    wrap.appendChild(label);
  });

  const commonLabel = document.createElement('button');
  commonLabel.type = 'button';
  commonLabel.className = 'venn-label common';
  commonLabel.dataset.id = 'common';
  commonLabel.textContent = 'Common Knowledge';
  commonLabel.style.left = '50%';
  commonLabel.style.top = '50%';
  commonLabel.style.background = '#FFFFFF';
  commonLabel.style.color = '#EB1000';
  commonLabel.addEventListener('click', () => selectGroup('common'));
  wrap.appendChild(commonLabel);

  section.appendChild(wrap);
  section.appendChild(panel);
  container.appendChild(section);

  selectGroup('common');
}

// --- Slide image payload prep for the feedback module (feedback.html) ---
// Downscales each slide snapshot via canvas before base64-encoding, since
// sending a full deck of full-resolution PNGs to a vision LLM would bloat
// the request/cost with no benefit to feedback quality.

const FEEDBACK_IMAGE_MAX_WIDTH = 640;

function imageToDataUrl(src, maxWidth) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.72));
    };
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}

function prepareSlidePayload(slideData, maxWidth) {
  return Promise.all(
    slideData.map(slide =>
      imageToDataUrl(slide.snapshot_image, maxWidth || FEEDBACK_IMAGE_MAX_WIDTH).then(dataUrl => ({
        slide_index: slide.slide_index,
        start_time: slide.start_time,
        end_time: slide.end_time,
        transcript: slide.transcript || '',
        image: dataUrl
      }))
    )
  );
}

// --- Feedback module (also real, like fetchSegments above): calls the same
// local Python backend (backend/server.py), which forwards the transcript +
// slide images to a vision-capable LLM role-playing as the chosen audience.

const FEEDBACK_API_URL = 'http://127.0.0.1:8000/feedback';

function fetchFeedback(audience, prompt, slidePayload) {
  return fetch(FEEDBACK_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audience, prompt, slides: slidePayload })
  })
    .then(res => {
      if (!res.ok) {
        return res.json()
          .catch(() => ({}))
          .then(body => { throw new Error(body.error || `server responded with ${res.status}`); });
      }
      return res.json();
    })
    .then(data => data.feedback)
    .catch(err => {
      throw new Error(
        `Could not reach the feedback server at ${FEEDBACK_API_URL} (${err.message}). ` +
        `Start it with: python backend/server.py`
      );
    });
}

function renderFeedbackResult(container, audience, feedbackText) {
  container.innerHTML = '';

  const card = document.createElement('div');
  card.className = 'feedback-response-card';

  const header = document.createElement('div');
  header.className = 'feedback-response-header';
  header.textContent = `Feedback from: ${audience}`;
  card.appendChild(header);

  const body = document.createElement('div');
  body.className = 'feedback-response-text';
  body.textContent = feedbackText;
  card.appendChild(body);

  container.appendChild(card);
}

// --- Input readers ---

if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

function isPdfFile(file) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

function readPdfFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const typedArray = new Uint8Array(reader.result);
      pdfjsLib.getDocument({ data: typedArray }).promise
        .then(pdf => {
          const pageNumbers = Array.from({ length: pdf.numPages }, (_, i) => i + 1);
          return pageNumbers.reduce(
            (chain, pageNum) => chain.then(pagesText =>
              pdf.getPage(pageNum)
                .then(page => page.getTextContent())
                .then(content => {
                  const pageText = content.items.map(item => item.str).join(' ');
                  return pagesText + (pagesText ? '\n\n' : '') + pageText;
                })
            ),
            Promise.resolve('')
          );
        })
        .then(text => resolve({ label: file.name, text }))
        .catch(err => reject(new Error(`Failed to extract text from ${file.name}: ${err.message}`)));
    };
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}.`));
    reader.readAsArrayBuffer(file);
  });
}

function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ label: file.name, text: String(reader.result || '') });
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}.`));
    reader.readAsText(file);
  });
}

function readFile(file) {
  return isPdfFile(file) ? readPdfFile(file) : readTextFile(file);
}

function fetchWikipediaUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (e) {
    return Promise.reject(new Error('Please enter a valid URL.'));
  }

  if (!/(^|\.)wikipedia\.org$/.test(url.hostname)) {
    return Promise.reject(new Error('Only Wikipedia URLs are supported right now.'));
  }

  const title = decodeURIComponent(url.pathname.replace(/^\/wiki\//, ''));
  if (!title) {
    return Promise.reject(new Error('Could not find a page title in that URL.'));
  }

  const apiUrl = `https://${url.hostname}/w/api.php?action=query&prop=extracts&explaintext=1&titles=${encodeURIComponent(title)}&format=json&origin=*`;

  return fetch(apiUrl)
    .then(res => res.json())
    .then(data => {
      const pages = data.query && data.query.pages;
      const page = pages && Object.values(pages)[0];
      if (!page || page.missing !== undefined || !page.extract) {
        throw new Error('Page not found.');
      }
      return { label: page.title, text: page.extract };
    })
    .catch(err => {
      throw new Error(`Failed to fetch that page: ${err.message}`);
    });
}
