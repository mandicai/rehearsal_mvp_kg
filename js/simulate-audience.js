// presenter-view.html's "4. Simulate Audience" module. Loaded after
// presenter-view.js, so it reads/depends on that file's globals directly
// (slides, audience, presentationObjectives, getAllObjectiveNodes,
// objectiveDependencies, setStatus) - no module system in this repo.
//
// For every learning objective (presentation/section/slide scope - unlike
// the objective-dependency graph, presentation-wide objectives ARE tracked
// here), simulates ~3 independent audience members answering an open-ended
// question grounded in that objective, at the point in the presentation
// where its content has been fully delivered, and folds the result into a
// Bayesian-Knowledge-Tracing-style running estimate of P(the audience knows
// this). Any weak objective gets a suggested fix and surfaces in the
// Presentation Feedback section (lives in the sidebar, not this module).

const BKT_DEFAULTS = {
  priorKnow: 0.3,      // P(L0): baseline probability of already knowing, pre-instruction
  pTransition: 0.3,    // P(T): base probability of acquiring the skill from its one instructional opportunity
  pSlip: 0.1,          // P(S): probability of answering wrong despite knowing
  pGuess: 0.1,         // P(G): probability of answering right despite not knowing (low - open-ended, not MCQ)
  weakThreshold: 0.5,  // final P(know) below this => "weak"
  prereqFloor: 0.2,    // even a fully-unmastered prerequisite leaves this fraction of normal learning rate
};

const SIMULATION_CONCURRENCY = 4;
const SAMPLES_PER_OBJECTIVE = 3;

// Set by renderSimulationResults() on every run - lets exportPresenterNotes()
// build a download from the last simulation's findings on demand, without
// re-deriving anything.
let lastWeakObjectives = [];

// --- BKT-inspired math (pure, no network calls) ---

function clampProb(p) {
  return Math.min(0.999999, Math.max(0.000001, p));
}

function bayesUpdateKnow(pKnow, correct, pSlip, pGuess) {
  pKnow = clampProb(pKnow);
  if (correct) {
    const num = pKnow * (1 - pSlip);
    return clampProb(num / (num + (1 - pKnow) * pGuess));
  }
  const num = pKnow * pSlip;
  return clampProb(num / (num + (1 - pKnow) * (1 - pGuess)));
}

// The ~3 samples are independent observations of the SAME pre-opportunity
// knowledge state (three simulated people asked the same question at the
// same point in the timeline), so successive Bayesian updates against the
// same evolving posterior - with no transition step between them - equal
// the combined posterior. Exactly one transition step follows, once, since
// the audience is only instructed once.
function combineSamplesIntoKnow(pKnowPrior, sampleGrades, pSlip, pGuess) {
  let pKnow = pKnowPrior;
  sampleGrades.forEach(g => { pKnow = bayesUpdateKnow(pKnow, g.correct, pSlip, pGuess); });
  return pKnow;
}

// Scales a dependent objective's learning rate by its prerequisites'
// average current P(know) - average (not min), so one weak prerequisite
// among several doesn't fully tank the rest. A floor keeps partial learning
// possible even with a fully-unmastered prerequisite, rather than blocking
// it outright.
function effectiveTransition(node, pKnowById, defaults) {
  const prereqIds = objectiveDependencies
    .filter(d => d.dependent_objective_id === node.id)
    .map(d => d.prerequisite_objective_id)
    .filter(id => pKnowById.has(id));

  if (prereqIds.length === 0) return defaults.pTransition;
  const avgPrereqKnow = prereqIds.reduce((sum, id) => sum + pKnowById.get(id), 0) / prereqIds.length;
  return defaults.pTransition * (defaults.prereqFloor + (1 - defaults.prereqFloor) * avgPrereqKnow);
}

function updateObjectiveKnowledge(node, pKnowById, defaults) {
  const pKnowAfterEvidence = combineSamplesIntoKnow(defaults.priorKnow, node.assessment.samples, defaults.pSlip, defaults.pGuess);
  const pT = effectiveTransition(node, pKnowById, defaults);
  const pKnowFinal = pKnowAfterEvidence + (1 - pKnowAfterEvidence) * pT;
  node.pKnowAfterEvidence = pKnowAfterEvidence;
  node.pTransitionEffective = pT;
  node.pKnow = pKnowFinal;
  pKnowById.set(node.id, pKnowFinal);
}

function isWeak(node, defaults = BKT_DEFAULTS) {
  return node.pKnow != null && node.pKnow < defaults.weakThreshold;
}

// Whether this objective is a prerequisite for at least one other objective
// (per the dependency graph) - used only to phrase buildSummaryRow's message,
// not to decide whether a weak objective gets surfaced at all.
function isFoundational(node) {
  return objectiveDependencies.some(d => d.prerequisite_objective_id === node.id);
}

// --- Timeline / ordering (including presentation-wide objectives) ---

function objectiveOpportunitySlideIndex(node) {
  return node.slideIndices[node.slideIndices.length - 1];
}

// Reuses helpers.js's imageToDataUrl (same downscale-then-JPEG pipeline the
// feedback.html module already relies on) instead of duplicating it. Caches
// the *promise*, not just the resolved value, so multiple objectives whose
// scopes overlap the same slide only fetch+encode it once. A failed image
// load degrades gracefully (that slide's image just stays null) rather than
// failing the whole simulation.
const slideImageDataUrlCache = new Map(); // slide_index -> Promise<dataUrl|null>

function getSlideImageDataUrl(slide) {
  if (!slide.snapshot_image) return Promise.resolve(null);
  if (!slideImageDataUrlCache.has(slide.slide_index)) {
    slideImageDataUrlCache.set(
      slide.slide_index,
      imageToDataUrl(`/${slide.snapshot_image}`, FEEDBACK_IMAGE_MAX_WIDTH).catch(() => null)
    );
  }
  return slideImageDataUrlCache.get(slide.slide_index);
}

// Attaches everything simulateObjective/render need: the opportunity point,
// the transcript+image slides to ground the question in (this objective's
// own scope only - every slide gets an image, since the scope is always
// small), the cumulative slides to hand the persona (every slide up to the
// opportunity point - no lookahead; transcript is cumulative in full, but
// only the LAST slide carries an image, since the audience remembers what
// was said but isn't still looking at an earlier slide's visual), and a
// natural-language scope label for the LLM prompts.
async function annotateObjectiveNodeForAssessment(node) {
  const opportunityIndex = objectiveOpportunitySlideIndex(node);
  node.opportunitySlideIndex = opportunityIndex;

  const scopeSlideObjs = slides.filter(s => node.slideIndices.includes(s.slide_index));
  const cumulativeSlideObjs = slides.filter(s => s.slide_index <= opportunityIndex);

  node.scopeSlides = await Promise.all(scopeSlideObjs.map(async s => ({
    slide_index: s.slide_index,
    transcript: s.transcript || '',
    image: await getSlideImageDataUrl(s),
  })));
  node.cumulativeSlides = await Promise.all(cumulativeSlideObjs.map(async (s, i, arr) => ({
    slide_index: s.slide_index,
    transcript: s.transcript || '',
    image: i === arr.length - 1 ? await getSlideImageDataUrl(s) : null,
  })));

  node.scopeLabel = node.scope === 'presentation'
    ? 'the entire presentation'
    : node.scope === 'section'
      ? `slides ${node.slideIndices[0]}-${node.slideIndices[node.slideIndices.length - 1]}`
      : `slide ${node.slideIndices[0]}`;
  return node;
}

function assessmentChipLabel(node) {
  if (node.scope === 'presentation') return 'All';
  if (node.scope === 'section') return `S${node.slideIndices[0]}-${node.slideIndices[node.slideIndices.length - 1]}`;
  return `Slide ${node.slideIndices[0]}`;
}

const SCOPE_RANK = { slide: 0, section: 1, presentation: 2 };

// So a prerequisite's pKnow exists by the time its dependent is processed.
function compareByOpportunity(a, b) {
  const diff = objectiveOpportunitySlideIndex(a) - objectiveOpportunitySlideIndex(b);
  if (diff !== 0) return diff;
  const rankDiff = SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope];
  return rankDiff !== 0 ? rankDiff : a.id.localeCompare(b.id);
}

// --- Parallel LLM orchestration ---

// Runs `items` through `worker` (item -> Promise) with at most `limit`
// concurrently in flight. Never rejects - each item resolves to
// {ok: true, value} or {ok: false, error}, in original order, so one
// failing item never aborts the rest of the batch.
function runWithConcurrencyLimit(items, limit, worker) {
  return new Promise(resolve => {
    if (items.length === 0) { resolve([]); return; }
    const results = new Array(items.length);
    let nextIndex = 0;
    let completed = 0;

    function launchNext() {
      if (nextIndex >= items.length) return;
      const index = nextIndex++;
      Promise.resolve(worker(items[index], index))
        .then(value => { results[index] = { ok: true, value }; })
        .catch(error => { results[index] = { ok: false, error }; })
        .finally(() => {
          completed++;
          if (completed === items.length) resolve(results);
          else launchNext();
        });
    }
    for (let i = 0; i < Math.min(limit, items.length); i++) launchNext();
  });
}

async function simulateObjective(node) {
  const q = await fetchGenerateQuestion(node.text, node.scopeLabel, node.scopeSlides);
  const answers = await Promise.all(
    Array.from({ length: SAMPLES_PER_OBJECTIVE }, () =>
      fetchSimulateAnswer(audience, q.question, node.cumulativeSlides))
  );
  const graded = await fetchGradeAnswers(q.question, q.rubric, q.reference_answer, answers.map(a => a.answer));
  return {
    question: q.question,
    rubric: q.rubric,
    reference_answer: q.reference_answer,
    samples: answers.map((a, i) => ({
      answer: a.answer,
      correct: graded.grades[i].correct,
      explanation: graded.grades[i].explanation,
    })),
  };
}

async function runSimulation() {
  if (!audience) {
    setStatus('simulate-audience-status', 'Enter an audience description in the Audience module first.', true);
    return;
  }
  if (presentationObjectives.length === 0) {
    setStatus('simulate-audience-status', 'Add at least one presentation-wide learning objective first - it\'s required to assess overall understanding.', true);
    return;
  }

  const rawObjectiveNodes = getAllObjectiveNodesForAssessment();
  if (rawObjectiveNodes.length === 0) {
    setStatus('simulate-audience-status', 'Add some learning objectives first - there is nothing to assess yet.', true);
    return;
  }

  const runBtn = document.getElementById('run-simulation-btn');
  runBtn.disabled = true;
  document.getElementById('simulation-objectives-list').innerHTML = '';
  setStatus('simulate-audience-status', `Preparing slide images for ${rawObjectiveNodes.length} objective(s)...`);

  const objectiveNodes = await Promise.all(rawObjectiveNodes.map(node => annotateObjectiveNodeForAssessment(node)));
  setStatus('simulate-audience-status', `Assessing ${objectiveNodes.length} objective(s) (up to ${SIMULATION_CONCURRENCY} at a time)...`);

  // 1. Parallel phase - independent per-objective LLM work.
  const settled = await runWithConcurrencyLimit(objectiveNodes, SIMULATION_CONCURRENCY, simulateObjective);
  objectiveNodes.forEach((node, i) => {
    node.assessment = settled[i].ok ? settled[i].value : null;
    node.assessmentError = settled[i].ok ? null : settled[i].error.message;
  });

  // 2. Sequential phase - pure, fast BKT arithmetic, strict timeline order.
  const ordered = [...objectiveNodes].sort(compareByOpportunity);
  const pKnowById = new Map();
  ordered.forEach(node => {
    if (node.assessment) updateObjectiveKnowledge(node, pKnowById, BKT_DEFAULTS);
  });

  // 3. Bounded second wave - suggest_fix only for weak objectives (bounded
  // by "weak", not "weak and foundational" - any objective the audience
  // didn't grasp is worth a suggestion, not just ones that block others).
  const nodesById = {};
  objectiveNodes.forEach(n => { nodesById[n.id] = n; });
  const weak = objectiveNodes.filter(n => isWeak(n));
  await runWithConcurrencyLimit(weak, SIMULATION_CONCURRENCY, async node => {
    const blockedObjectiveTexts = objectiveDependencies
      .filter(d => d.prerequisite_objective_id === node.id)
      .map(d => nodesById[d.dependent_objective_id] && nodesById[d.dependent_objective_id].text)
      .filter(Boolean);
    const result = await fetchSuggestFix(node.text, node.scopeLabel, node.scopeSlides, node.assessment.samples, blockedObjectiveTexts);
    node.fix = result.suggestion;
  });

  const failedCount = objectiveNodes.filter(n => !n.assessment).length;
  setStatus(
    'simulate-audience-status',
    failedCount > 0 ? `Simulation complete - ${failedCount} objective(s) failed, see details below.` : 'Simulation complete.',
    failedCount > 0
  );
  runBtn.disabled = false;
  renderSimulationResults(objectiveNodes);
}

// --- Rendering ---

function buildSummaryRow(node) {
  const row = document.createElement('div');
  row.className = 'dependency-edge-row sim-alert-row';

  const qualifier = isFoundational(node) ? ' is a prerequisite for other objectives.' : ' needs attention.';
  const line = document.createElement('span');
  line.textContent = `${node.scopeLabel}: "${node.text}" (${Math.round(node.pKnow * 100)}% simulated mastery)${qualifier}`;
  row.appendChild(line);

  if (node.fix) {
    const fix = document.createElement('span');
    fix.className = 'sim-summary-fix';
    fix.textContent = `Suggested fix: ${node.fix}`;
    row.appendChild(fix);
  }

  return row;
}

function buildObjectiveRow(node) {
  const row = document.createElement('div');
  row.className = 'sim-objective-row';

  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'sim-objective-header';

  const scopeChip = document.createElement('span');
  scopeChip.className = 'sim-scope-chip';
  scopeChip.textContent = assessmentChipLabel(node);
  header.appendChild(scopeChip);

  const textEl = document.createElement('span');
  textEl.className = 'sim-objective-text';
  textEl.textContent = node.text;
  header.appendChild(textEl);

  if (node.assessment) {
    const pct = Math.round(node.pKnow * 100);
    const bar = document.createElement('span');
    bar.className = 'mastery-bar';
    bar.title = `${pct}% simulated probability this audience understood this objective (Bayesian Knowledge Tracing-style estimate - see the ⓘ above for details).`;
    const fill = document.createElement('span');
    fill.className = `mastery-bar-fill ${node.pKnow < BKT_DEFAULTS.weakThreshold ? 'weak' : 'strong'}`;
    fill.style.width = `${pct}%`;
    bar.appendChild(fill);
    header.appendChild(bar);

    const pctLabel = document.createElement('span');
    pctLabel.className = 'mastery-pct';
    pctLabel.textContent = `${pct}%`;
    header.appendChild(pctLabel);
  } else {
    const errLabel = document.createElement('span');
    errLabel.className = 'mastery-pct';
    errLabel.textContent = 'error';
    header.appendChild(errLabel);
  }

  const caret = document.createElement('span');
  caret.className = 'sim-expand-caret';
  caret.textContent = '▾';
  header.appendChild(caret);

  const detail = document.createElement('div');
  detail.className = 'sim-objective-detail';
  detail.style.display = 'none';

  if (node.assessment) {
    const question = document.createElement('div');
    question.className = 'sim-question';
    const questionLabel = document.createElement('strong');
    questionLabel.textContent = 'Question: ';
    question.appendChild(questionLabel);
    question.appendChild(document.createTextNode(node.assessment.question));
    detail.appendChild(question);

    if (node.assessment.rubric) {
      const rubric = document.createElement('div');
      rubric.className = 'sim-rubric status-line';
      rubric.textContent = `Rubric: ${node.assessment.rubric}`;
      detail.appendChild(rubric);
    }

    node.assessment.samples.forEach(sample => {
      const sampleRow = document.createElement('div');
      sampleRow.className = 'sim-sample';

      const answerEl = document.createElement('div');
      answerEl.className = 'sim-sample-answer';
      answerEl.textContent = `"${sample.answer}"`;
      sampleRow.appendChild(answerEl);

      const gradeEl = document.createElement('div');
      gradeEl.className = `sim-sample-grade ${sample.correct ? 'sim-correct' : 'sim-incorrect'}`;
      gradeEl.textContent = `${sample.correct ? 'Correct' : 'Incorrect'} - ${sample.explanation}`;
      sampleRow.appendChild(gradeEl);

      detail.appendChild(sampleRow);
    });

    if (node.fix) {
      const fix = document.createElement('div');
      fix.className = 'sim-fix-suggestion status-line';
      fix.textContent = `Suggested fix: ${node.fix}`;
      detail.appendChild(fix);
    }
  } else {
    const err = document.createElement('div');
    err.className = 'status-line error';
    err.textContent = node.assessmentError || 'Assessment failed.';
    detail.appendChild(err);
  }

  header.addEventListener('click', () => {
    const isOpen = detail.style.display !== 'none';
    detail.style.display = isOpen ? 'none' : '';
    header.classList.toggle('expanded', !isOpen);
  });

  row.appendChild(header);
  row.appendChild(detail);
  return row;
}

function renderSimulationResults(objectiveNodes) {
  const weak = objectiveNodes.filter(n => isWeak(n));
  lastWeakObjectives = weak;

  // Lives in the sidebar (see html/presenter-view.html), not this module -
  // the module itself only shows the full per-objective list below.
  const notesSection = document.getElementById('presentation-notes-section');
  const notesList = document.getElementById('presentation-notes-list');
  notesList.innerHTML = '';

  if (weak.length > 0) {
    notesSection.style.display = '';
    weak.forEach(node => notesList.appendChild(buildSummaryRow(node)));
  } else {
    notesSection.style.display = 'none';
  }

  const listEl = document.getElementById('simulation-objectives-list');
  listEl.innerHTML = '';
  [...objectiveNodes].sort(compareByOpportunity).forEach(node => {
    listEl.appendChild(buildObjectiveRow(node));
  });
}

document.getElementById('run-simulation-btn').addEventListener('click', runSimulation);

// Click-toggleable info popup explaining the mastery bars - toggles on
// clicking the "i" button, and closes when clicking anywhere else on the page.
const simInfoBtn = document.getElementById('sim-info-btn');
const simInfoPopup = document.getElementById('sim-info-popup');

simInfoBtn.addEventListener('click', e => {
  e.stopPropagation();
  const isOpen = simInfoPopup.style.display !== 'none';
  simInfoPopup.style.display = isOpen ? 'none' : '';
  simInfoBtn.classList.toggle('active', !isOpen);
});

document.addEventListener('click', e => {
  if (simInfoPopup.style.display === 'none') return;
  if (e.target === simInfoBtn || simInfoPopup.contains(e.target)) return;
  simInfoPopup.style.display = 'none';
  simInfoBtn.classList.remove('active');
});

// Downloads the same weak-objective findings shown in the Presentation
// Feedback section as a plain-text file, so the presenter can have them on
// hand (printed or on a phone) during the actual live talk, away from this
// page. Client-side Blob download - no backend involved.
function exportPresenterNotes() {
  if (lastWeakObjectives.length === 0) {
    setStatus('simulate-audience-status', 'Nothing to export yet - run the simulation first.', true);
    return;
  }

  const lines = [
    'Presenter Notes - Simulated Audience Feedback',
    'Generated from a "Run Simulation" pass in the Simulate Audience module.',
    '',
  ];
  lastWeakObjectives.forEach((node, i) => {
    lines.push(`${i + 1}. [${assessmentChipLabel(node)}] "${node.text}" - ${Math.round(node.pKnow * 100)}% simulated mastery`);
    if (node.fix) lines.push(`   Suggested fix: ${node.fix}`);
    lines.push('');
  });

  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'presenter-notes.txt';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

document.getElementById('export-presenter-notes-btn').addEventListener('click', exportPresenterNotes);
