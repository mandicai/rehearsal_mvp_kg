// html/calibrate-priors.html - collects real human answers (not LLM-simulated
// ones) to "cold" comprehension questions, grouped by stated audience
// description, to empirically estimate js/simulate-audience.js's
// BKT_DEFAULTS.priorKnow per audience type instead of a single guessed
// constant. Reuses the existing /assessment/generate_question and
// /assessment/grade_answers calls (via helpers.js's fetchGenerateQuestion/
// fetchGradeAnswers) exactly as simulate-audience.js does - simulate_answer
// and suggest_fix are never used here, since a real person answers instead
// of an LLM persona.

const RECORDS_STORAGE_KEY = 'calibrate-priors-records';

let records = loadRecords();
let currentQuestion = null; // {audience, topic, context, question, rubric, reference_answer}

function loadRecords() {
  try {
    return JSON.parse(localStorage.getItem(RECORDS_STORAGE_KEY)) || [];
  } catch (err) {
    return [];
  }
}

function saveRecords() {
  localStorage.setItem(RECORDS_STORAGE_KEY, JSON.stringify(records));
}

function setModuleEnabled(moduleId, enabled) {
  document.getElementById(moduleId).classList.toggle('disabled', !enabled);
}

function setStatus(elementId, message, isError) {
  const el = document.getElementById(elementId);
  el.textContent = message || '';
  el.classList.toggle('error', !!isError);
}

// --- 1. Generate a cold question ---

function generateQuestion() {
  const audience = document.getElementById('calibrate-audience-input').value.trim();
  const topic = document.getElementById('calibrate-topic-input').value.trim();
  const context = document.getElementById('calibrate-context-input').value.trim();

  if (!audience) {
    setStatus('generate-question-status', 'Enter an audience description first.', true);
    return;
  }
  if (!topic) {
    setStatus('generate-question-status', 'Enter a learning objective / topic first.', true);
    return;
  }

  const btn = document.getElementById('generate-question-btn');
  btn.disabled = true;
  setStatus('generate-question-status', 'Generating question...');

  // When no grounding context is given, the placeholder text must tell the
  // model to write a genuine general-knowledge question - NOT just say "no
  // material provided", which (confirmed live) makes it write a rubric
  // demanding the answer say "the transcript doesn't cover this", marking
  // any real correct answer wrong.
  const syntheticSlide = {
    slide_index: 1,
    transcript: context || 'No specific source text was provided - write a general-knowledge question '
      + 'and rubric based on standard subject-matter knowledge about this topic, not restricted to any '
      + 'particular document.',
  };

  fetchGenerateQuestion(topic, 'no prior instruction', [syntheticSlide])
    .then(result => {
      currentQuestion = { audience, topic, context, ...result };
      document.getElementById('calibrate-question-display').textContent = `Question: ${result.question}`;
      document.getElementById('calibrate-answer-input').value = '';
      document.getElementById('graded-result').innerHTML = '';
      setStatus('submit-answer-status', '');
      setModuleEnabled('answer-module', true);
      setStatus('generate-question-status', '');
    })
    .catch(err => setStatus('generate-question-status', err.message, true))
    .finally(() => { btn.disabled = false; });
}

document.getElementById('generate-question-btn').addEventListener('click', generateQuestion);

// --- 2/3. Submit the real human's answer, grade it, record it ---

function submitAnswer() {
  if (!currentQuestion) {
    setStatus('submit-answer-status', 'Generate a question first.', true);
    return;
  }
  const answerText = document.getElementById('calibrate-answer-input').value.trim();
  if (!answerText) {
    setStatus('submit-answer-status', 'Type an answer first.', true);
    return;
  }

  const btn = document.getElementById('submit-answer-btn');
  btn.disabled = true;
  setStatus('submit-answer-status', 'Grading...');

  fetchGradeAnswers(currentQuestion.question, currentQuestion.rubric, currentQuestion.reference_answer, [answerText])
    .then(result => {
      const grade = result.grades[0];
      const record = {
        timestamp: new Date().toISOString(),
        audience: currentQuestion.audience,
        topic: currentQuestion.topic,
        context: currentQuestion.context,
        question: currentQuestion.question,
        rubric: currentQuestion.rubric,
        reference_answer: currentQuestion.reference_answer,
        human_answer: answerText,
        correct: grade.correct,
        explanation: grade.explanation,
      };
      records.push(record);
      saveRecords();
      renderGradedResult(record);
      renderAggregateTable();
      renderRecordsList();
      setStatus('submit-answer-status', '');
    })
    .catch(err => setStatus('submit-answer-status', err.message, true))
    .finally(() => { btn.disabled = false; });
}

document.getElementById('submit-answer-btn').addEventListener('click', submitAnswer);

function renderGradedResult(record) {
  const container = document.getElementById('graded-result');
  container.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'dependency-edge-row';
  row.innerHTML = `<span>${record.correct ? 'Correct' : 'Incorrect'} - ${record.explanation}</span>`;
  container.appendChild(row);
}

// --- Aggregate table: empirical priorKnow per audience (simple
// lowercase+trim grouping only - no fuzzy/NLP clustering of similarly-worded
// audience descriptions, a known limitation rather than something worth
// engineering around for a first version) ---

function renderAggregateTable() {
  const container = document.getElementById('aggregate-table');
  container.innerHTML = '';

  if (records.length === 0) {
    container.textContent = 'No data yet.';
    return;
  }

  const groups = new Map(); // normalized audience -> {label, n, correct}
  records.forEach(r => {
    const key = r.audience.trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, { label: r.audience.trim(), n: 0, correct: 0 });
    const g = groups.get(key);
    g.n += 1;
    if (r.correct) g.correct += 1;
  });

  const table = document.createElement('table');
  table.className = 'calibrate-aggregate-table';
  table.innerHTML = `
    <thead>
      <tr><th>Audience</th><th># responses</th><th># correct</th><th>Empirical priorKnow</th></tr>
    </thead>
  `;
  const tbody = document.createElement('tbody');
  groups.forEach(g => {
    const tr = document.createElement('tr');
    const priorKnow = (g.correct / g.n).toFixed(2);
    tr.innerHTML = `<td>${g.label}</td><td>${g.n}</td><td>${g.correct}</td><td>${priorKnow}</td>`;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.appendChild(table);
}

function renderRecordsList() {
  const container = document.getElementById('records-list');
  container.innerHTML = '';

  if (records.length === 0) {
    container.textContent = 'No records yet.';
    return;
  }

  [...records].reverse().forEach(r => {
    const row = document.createElement('div');
    row.className = 'dependency-edge-row';
    row.innerHTML = `<span>[${r.audience}] "${r.topic}" - ${r.correct ? 'correct' : 'incorrect'} (${new Date(r.timestamp).toLocaleString()})</span>`;
    container.appendChild(row);
  });
}

// --- Export / clear ---

function csvEscape(value) {
  const str = String(value == null ? '' : value);
  return `"${str.replace(/"/g, '""')}"`;
}

function exportDataset() {
  if (records.length === 0) {
    setStatus('dataset-status', 'Nothing to export yet.', true);
    return;
  }

  const columns = [
    'timestamp', 'audience', 'topic', 'context', 'question', 'rubric',
    'reference_answer', 'human_answer', 'correct', 'explanation',
  ];
  const lines = [columns.join(',')];
  records.forEach(r => {
    lines.push(columns.map(col => csvEscape(r[col])).join(','));
  });

  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'bkt-prior-calibration.csv';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

document.getElementById('export-dataset-btn').addEventListener('click', exportDataset);

function clearDataset() {
  if (records.length === 0) return;
  if (!confirm('Delete all collected calibration data? This cannot be undone.')) return;
  records = [];
  saveRecords();
  renderAggregateTable();
  renderRecordsList();
  setStatus('dataset-status', 'Cleared.');
}

document.getElementById('clear-dataset-btn').addEventListener('click', clearDataset);

// --- Init ---
renderAggregateTable();
renderRecordsList();
