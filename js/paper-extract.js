//#region --- DOCUMENTARY SPECIFICATIONS
const ARC_TEMPLATES = [
  {
    name: 'Solving a problem or puzzle',
    sections: [
      { name: 'Puzzle or problem', description: 'Introduce the central puzzle or open question this research sets out to solve.' },
      { name: 'Background of problem', description: "Give the context and why this problem is hard or hasn't been solved yet." },
      { name: 'Struggle to solve problem', description: 'Walk through the approach being tried, and the obstacles along the way.' },
      { name: 'Turning point', description: 'The key insight or moment where the approach starts to click.' },
      { name: 'Solution', description: 'The resolution - what was found, and why it solves the puzzle.' },
    ],
  },
  {
    name: 'Challenging an assumption',
    sections: [
      { name: 'Conventional belief', description: 'State the widely-held assumption this research questions.' },
      { name: 'Background of belief', description: 'Explain where that belief comes from and why it seemed reasonable.' },
      { name: 'Unexpected finding', description: 'The surprising result that contradicts the conventional belief.' },
      { name: 'Fallout of finding', description: 'What breaks or changes once the old belief no longer holds.' },
      { name: 'Revised understanding', description: 'The new, more accurate picture that replaces the old assumption.' },
    ],
  },
  {
    name: "Following a person or team's journey",
    sections: [
      { name: 'Character introduced', description: 'Introduce the researcher(s) and what drew them to this work.' },
      { name: 'Character confronted with problem', description: 'The problem or challenge they set out to tackle.' },
      { name: 'Character tackles problem and faces setbacks', description: 'Their attempts, false starts, and setbacks along the way.' },
      { name: 'Character faces turning point', description: 'The moment their approach shifts or a breakthrough emerges.' },
      { name: 'Character learns lessons and deals with outcomes', description: 'What they found, and what they took away from the process.' },
    ],
  },
  {
    name: 'Tracing a transformation',
    sections: [
      { name: 'Earlier state', description: 'Describe how things were before this change - the starting point.' },
      { name: 'Forces driving change', description: 'What pressures, needs, or discoveries pushed things to change.' },
      { name: 'Notable points of change', description: 'Key moments or milestones marking the transformation as it happened.' },
      { name: 'Present state', description: 'Where things stand now, as a result of this research.' },
      { name: 'Possible futures', description: 'Where this transformation could lead next.' },
    ],
  },
  {
    name: 'Exposing a hidden system',
    sections: [
      { name: 'Surface experiences', description: 'What people notice day-to-day, without seeing the mechanism behind it.' },
      { name: 'Clues for what is hidden', description: 'The hints or anomalies that suggested something deeper was going on.' },
      { name: 'Underlying mechanism', description: 'The hidden system or process this research uncovers.' },
      { name: 'Who is affected by the mechanism', description: 'Who or what is shaped by this mechanism, and how.' },
      { name: 'Implications and what to do next', description: 'What this discovery means, and what should happen as a result.' },
    ],
  },
];

// Kept in sync by convention with backend/documentary_modes.py's
// DOCUMENTARY_MODES - see that file's comment for why there's no shared-
// config mechanism here (same convention as ARC_TEMPLATES). A stylistic
// axis independent of arc structure and documentary_goal - biases narration
// voice/visual grammar (storyboard) and pacing/transitions (edit plan), not
// arc structure, so it's only sent with fetchStoryboard/fetchEditPlan.
const DOCUMENTARY_MODES = [
  { key: 'expository', label: 'Expository', description: 'A confident narrator explains directly to the audience - clear, didactic, fact-forward.' },
  { key: 'observational', label: 'Observational', description: 'Fly-on-the-wall - minimal narration, let the research and researchers speak for themselves.' },
  { key: 'participatory', label: 'Participatory', description: 'The filmmaker/researcher is visibly part of the story - interview-style, first-person.' },
  { key: 'poetic', label: 'Poetic', description: 'Mood and imagery over exposition - evocative, associative, unhurried.' },
];

// A concrete next action to nudge the presenter toward once they pick a
// mode (see the "Documentary modes" sidebar section built in
// renderMovieEditor) - each derived from that same mode's own description
// above, pointed at whichever existing feature actually produces that
// kind of material (Your Media's recording, Find Footage, sketch
// sequences, ...), rather than just restating the description back at them.
const DOCUMENTARY_MODE_PROMPTS = {
  expository: 'Expository works best with a confident narrator explaining things directly to the audience - try recording a long voice-of-god narration in Your Media.',
  observational: "Observational works best fly-on-the-wall, with minimal narration - try Find Footage instead, and let the research speak for itself.",
  participatory: "Participatory works best with you visibly part of the story - try recording an interview-style clip of yourself talking through the work.",
  poetic: 'Poetic works best led by mood and imagery over exposition - try a sketch sequence to set an evocative tone.',
};

// Default on-screen seconds for a scene with no edit plan yet - the timeline
// sizes each scene's clip by its duration (see buildNarrativeTimeline), so a
// scene needs some length even before an edit plan fills in a real one.
const DEFAULT_SCENE_SECONDS = 5;

const sceneGenerationControllers = new Map();
function beginSceneGeneration(section) {
  const key = section.index;
  const previous = sceneGenerationControllers.get(key);
  if (previous) previous.abort();
  const controller = new AbortController();
  sceneGenerationControllers.set(key, controller);
  return controller;
}
function finishSceneGeneration(section, controller) {
  if (sceneGenerationControllers.get(section.index) === controller) {
    sceneGenerationControllers.delete(section.index);
  }
}
function cancelSceneGeneration(section) {
  const controller = sceneGenerationControllers.get(section.index);
  if (controller) {
    controller.abort();
    sceneGenerationControllers.delete(section.index);
  }
}
function isGenerationAbort(error) {
  return error && error.name === 'AbortError';
}

// The two visual timeline tracks a scene can belong to - sound effects are
// independent clips attached to a scene, not a visual scene role.
// (its role/label, shown per-scene in buildSectionBlock and used as the track
// it lands in on the timeline). Keys match buildNarrativeTimeline's TRACK_DEFS.
const SCENE_ROLES = [
  { key: 'aRoll', label: 'Primary' },
  { key: 'bRoll', label: 'Cutaway' },
];
const SCENE_ROLE_LABELS = Object.fromEntries(SCENE_ROLES.map(r => [r.key, r.label]));

// What dragging a documentary mode onto a timeline act scaffolds there: a
// list of scenes to auto-create, each with a track role and an on-screen
// duration (seconds) that also seeds its edit plan. Only expository's shape
// was specified by the user (one long A-roll voice-of-god narration over
// several short B-roll cutaways); the other three are a judgment call from
// each mode's grammar - observational's long continuous takes with little
// cutaway, participatory's balanced interview/reference cutting, poetic's
// sparse spine under a dense montage. Each mode's A-roll and B-roll second
// totals are kept roughly equal so the two tracks line up across the act.
const MODE_SCENE_TEMPLATES = {
  expository: [
    { role: 'bRoll', title: 'Expository footage', durationSeconds: 8 },
    { role: 'bRoll', title: 'Expository footage', durationSeconds: 8 },
    { role: 'bRoll', title: 'Expository footage', durationSeconds: 8 },
  ],
  // Observational & participatory are A-roll only - no B-roll cutaways (fly-
  // on-the-wall takes / interview segments carry the whole act themselves).
  observational: [
    { role: 'bRoll', title: 'Continuous take', durationSeconds: 12 },
    { role: 'bRoll', title: 'Continuous take', durationSeconds: 12 },
  ],
  participatory: [
    { role: 'bRoll', title: 'Interview', durationSeconds: 12 },
    { role: 'bRoll', title: 'Interview', durationSeconds: 12 },
  ],
  poetic: [
    { role: 'bRoll', title: 'Poetic image', durationSeconds: 8 },
    { role: 'bRoll', title: 'Montage image', durationSeconds: 4 },
    { role: 'bRoll', title: 'Montage image', durationSeconds: 4 },
    { role: 'bRoll', title: 'Montage image', durationSeconds: 4 },
    { role: 'bRoll', title: 'Montage image', durationSeconds: 4 },
    { role: 'bRoll', title: 'Montage image', durationSeconds: 4 },
    { role: 'bRoll', title: 'Montage image', durationSeconds: 4 },
  ],
};

// Specific filming/editing tactics, shown as toggleable chips under the
// arc outline (see renderMovieEditor) - a lighter-weight, multi-select
// complement to DOCUMENTARY_MODES above: a mode is a single stance for the
// whole piece, these are concrete techniques that can each apply or not,
// independent of one another and of which mode is picked (interviews fit
// an expository OR a participatory piece just as easily). Presenter-facing
// reminders of what's in play for this arc, not yet threaded into any LLM
// call - storyboard/edit-plan generation only take selectedDocumentaryMode
// today (see fetchStoryboard/fetchEditPlan).
const DOCUMENTARY_TECHNIQUES = [
  'Interview/direct address',
  'Montage',
  'Split-screen juxtaposition',
  'Time-lapse',
];

// Categories used to group the technique chips in the Documentary techniques
// module (see renderMovieEditor). Order = display order of the subheadings.
const TECHNIQUE_CATEGORY_ORDER = [
  { key: 'composition', label: 'Shot composition' },
  { key: 'movement', label: 'Camera movement' },
  { key: 'lighting', label: 'Lighting' },
  { key: 'metaphor_dataviz', label: 'Visual metaphor & data-vis' },
];

// Every technique in the (backend) catalog -> its category. Anything not listed
// falls into an "Other" group. Kept in sync by convention with
// backend/documentary_techniques.py's keys.
const TECHNIQUE_CATEGORY = {
  // Shot composition / framing / shot type
  'Interview/direct address': 'composition',
  'Split-screen juxtaposition': 'composition',
  'Observational sequence': 'composition',
  'Point-of-view shot': 'composition',
  'Reveal': 'composition',
  'Wide-to-detail sequence': 'composition',
  'Detail-to-context reveal': 'composition',
  'Reaction shot': 'composition',
  'Object close-up': 'composition',
  'Static tableau': 'composition',
  'Rack focus': 'composition',
  'Long take': 'composition',
  'B-roll illustration': 'composition',
  'Reenactment': 'composition',
  'Demonstration': 'composition',
  'Screen recording': 'composition',
  'Archival footage': 'composition',
  'Archival document': 'composition',
  // Camera movement (+ temporal camera treatments)
  'Follow shot': 'movement',
  'Pan': 'movement',
  'Tilt': 'movement',
  'Push-in': 'movement',
  'Pull-back': 'movement',
  'Whip pan': 'movement',
  'Slow motion': 'movement',
  'Time-lapse': 'movement',
  // Lighting
  'Three-point lighting': 'lighting',
  'High-key lighting': 'lighting',
  'Low-key lighting': 'lighting',
  'Natural light': 'lighting',
  'Silhouette / backlight': 'lighting',
  'Practical lighting': 'lighting',
  // Visual metaphor / data-vis / meaning-through-juxtaposition
  'Montage': 'metaphor_dataviz',
  'Process sequence': 'metaphor_dataviz',
  'Before-and-after comparison': 'metaphor_dataviz',
  'Parallel editing': 'metaphor_dataviz',
  'Match cut': 'metaphor_dataviz',
  'Graphic match': 'metaphor_dataviz',
  'Contrast cut': 'metaphor_dataviz',
  'Data visualization': 'metaphor_dataviz',
  'Animated diagram': 'metaphor_dataviz',
  'Map progression': 'metaphor_dataviz',
  'Visual motif': 'metaphor_dataviz',
  'Visual metaphor': 'metaphor_dataviz',
  'Juxtaposition': 'metaphor_dataviz',
  'On-screen text': 'metaphor_dataviz',
};

const ACT_BOARD_IMAGE_TECHNIQUE_CATEGORIES = new Set([
  'composition', 'lighting', 'metaphor_dataviz',
]);
const ACT_BOARD_VIDEO_TECHNIQUE_CATEGORIES = new Set(['movement']);
const ACT_BOARD_DEFAULT_VIDEO_TECHNIQUES = ['Pan'];

function filterActBoardTechniques(values, allowedCategories) {
  return sanitizeDocumentaryTechniques(values).filter(technique =>
    !allowedCategories || allowedCategories.has(TECHNIQUE_CATEGORY[technique]));
}

function ensureActBoardVideoGenerationTechniques(node) {
  if (!node) return [];
  const selected = filterActBoardTechniques(
    node.videoGenerationTechniques, ACT_BOARD_VIDEO_TECHNIQUE_CATEGORIES);
  if (selected.length) {
    node.videoGenerationTechniques = selected;
    return selected;
  }
  node.videoGenerationTechniques = [...ACT_BOARD_DEFAULT_VIDEO_TECHNIQUES];
  return node.videoGenerationTechniques;
}

// A compact baseline toolkit shown to every presenter, regardless of what a
// moodboard distillation happens to notice. These are intentionally familiar,
// practical choices for framing, camera movement, and lighting; they remain
// draggable onto scenes but are kept visually separate from moodboard output.
const STANDARD_TECHNIQUE_GROUPS = [
  {
    label: 'Shot composition',
    techniques: [
      'Interview/direct address', 'Wide-to-detail sequence',
      'Point-of-view shot', 'Reaction shot', 'Object close-up', 'Static tableau',
    ],
  },
  {
    label: 'Camera movement',
    techniques: ['Pan', 'Tilt', 'Push-in', 'Pull-back', 'Follow shot', 'Rack focus'],
  },
  {
    label: 'Lighting',
    techniques: ['Three-point lighting', 'Natural light', 'High-key lighting', 'Low-key lighting', 'Silhouette / backlight', 'Practical lighting'],
  },
];
const STANDARD_TECHNIQUE_SET = new Set(STANDARD_TECHNIQUE_GROUPS.flatMap(group => group.techniques));

// The backend catalog is the closed technique vocabulary. In particular,
// Primary/Cutaway belong to SCENE_ROLES and must never become technique chips,
// even when restoring stale state or handling a malformed model response.
function isDocumentaryTechnique(value) {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(TECHNIQUE_CATEGORY, value);
}
function sanitizeDocumentaryTechniques(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).filter(isDocumentaryTechnique)));
}

// Animated directorial-motion diagrams shown on hover over a technique chip
// (ported from directional_motion_sketches_2.html - see the .technique-motion-*
// CSS). Hand-authored entries use the richest technique-specific diagrams;
// getTechniqueMotionSketch supplies an animated semantic diagram for every
// other key in backend/documentary_techniques.py.
const TECHNIQUE_MOTION_SKETCH = {
  'Follow shot': { cls: 'follow', title: 'Follow shot', html: '<div class="ground"></div><div class="trees"><div class="tree t1"></div><div class="tree t2"></div><div class="tree t3"></div></div><div class="person"></div><div class="camera"></div><div class="arrow"></div>' },
  'Point-of-view shot': { cls: 'pov', title: 'Point-of-view shot', html: '<div class="person"></div><div class="eye"></div><div class="cone"></div><div class="tree a"></div><div class="tree b"></div><div class="sensor"></div><div class="focusBox"></div>' },
  'Wide-to-detail sequence': { cls: 'wide', title: 'Wide-to-detail', html: '<div class="tree w1"></div><div class="tree w2"></div><div class="tree w3"></div><div class="person"></div><div class="sensor"></div><div class="camera"></div>' },
  'Observational sequence': { cls: 'obs', title: 'Observational', html: '<div class="camera"></div><div class="tree"></div><div class="sensor"></div><div class="note"></div><div class="person"></div>' },
  'Data visualization': { cls: 'data', title: 'Data visualization', html: '<div class="tree d1"></div><div class="tree d2"></div><div class="tree d3"></div><div class="tree d4"></div><div class="tree d5"></div><div class="measure">measurement ↓</div><div class="chart"></div><div class="pt p1"></div><div class="pt p2"></div><div class="pt p3"></div><div class="pt p4"></div><div class="pt p5"></div>' },
  'Object close-up': { cls: 'close', title: 'Object close-up', html: '<div class="person"></div><div class="tree"></div><div class="sensor"></div><div class="sensorCopy"></div><div class="camera"></div>' },
  'Visual metaphor': {
    cls: 'metaphor',
    title: 'Visual metaphor',
    html: '<div class="metaphor-abstract-label">ABSTRACT IDEA</div>'
      + '<div class="metaphor-abstract"><i class="node n1"></i><i class="node n2"></i><i class="node n3"></i><i class="node n4"></i><i class="link l1"></i><i class="link l2"></i><i class="link l3"></i></div>'
      + '<div class="metaphor-means">BECOMES RELATABLE</div><div class="metaphor-direction"></div>'
      + '<div class="metaphor-world"><div class="bank left"></div><div class="bank right"></div><div class="bridge"><i></i><i></i><i></i><i></i><i></i></div><div class="traveler"></div></div>'
      + '<div class="metaphor-relatable-label">“A BRIDGE”</div>',
  },
};

// Preview families for the rest of the catalog. Every backend catalog key is
// already represented in TECHNIQUE_CATEGORY; category is the final fallback,
// while these groups make the motion communicate the technique more precisely.
const TECHNIQUE_PREVIEW_FAMILIES = [
  { kind: 'edit', keys: ['Montage', 'Split-screen juxtaposition', 'Before-and-after comparison', 'Parallel editing', 'Match cut', 'Graphic match', 'Contrast cut', 'Juxtaposition'] },
  { kind: 'evidence', keys: ['B-roll illustration', 'Archival footage', 'Archival document', 'Reenactment', 'Demonstration', 'Screen recording', 'Reaction shot'] },
  { kind: 'graphic', keys: ['Animated diagram', 'Map progression', 'Visual motif', 'Visual metaphor', 'On-screen text'] },
  { kind: 'time', keys: ['Time-lapse', 'Slow motion', 'Long take', 'Process sequence'] },
  { kind: 'camera', keys: ['Reveal', 'Detail-to-context reveal', 'Pan', 'Tilt', 'Push-in', 'Pull-back', 'Whip pan', 'Rack focus'] },
  { kind: 'light', keys: ['Three-point lighting', 'High-key lighting', 'Low-key lighting', 'Natural light', 'Silhouette / backlight', 'Practical lighting'] },
  { kind: 'subject', keys: ['Interview/direct address', 'Static tableau'] },
];
const TECHNIQUE_PREVIEW_KIND = {};
TECHNIQUE_PREVIEW_FAMILIES.forEach(({ kind, keys }) => keys.forEach(key => { TECHNIQUE_PREVIEW_KIND[key] = kind; }));

// Family animations share a common stage, but each catalog technique gets a
// semantic variant class so related techniques do not collapse into the same
// generic animation (for example Pan, Tilt, Push-in, and Pull-back all used to
// look identical, as did Interview and Static tableau).
const TECHNIQUE_PREVIEW_VARIANT = {
  'Interview/direct address': 'interview',
  'Montage': 'montage',
  'Split-screen juxtaposition': 'split-screen',
  'Time-lapse': 'time-lapse',
  'Observational sequence': 'observational',
  'Follow shot': 'follow-shot',
  'Point-of-view shot': 'point-of-view',
  'Reveal': 'reveal',
  'Wide-to-detail sequence': 'wide-detail',
  'Detail-to-context reveal': 'detail-context',
  'Process sequence': 'process',
  'Before-and-after comparison': 'before-after',
  'Parallel editing': 'parallel',
  'Match cut': 'match-cut',
  'Graphic match': 'graphic-match',
  'Contrast cut': 'contrast-cut',
  'Reaction shot': 'reaction',
  'B-roll illustration': 'b-roll',
  'Archival footage': 'archival-footage',
  'Archival document': 'archival-document',
  'Data visualization': 'data-visualization',
  'Animated diagram': 'animated-diagram',
  'Map progression': 'map-progression',
  'Reenactment': 'reenactment',
  'Demonstration': 'demonstration',
  'Screen recording': 'screen-recording',
  'Object close-up': 'object-close-up',
  'Slow motion': 'slow-motion',
  'Long take': 'long-take',
  'Static tableau': 'static-tableau',
  'Rack focus': 'rack-focus',
  'Pan': 'pan',
  'Tilt': 'tilt',
  'Push-in': 'push-in',
  'Pull-back': 'pull-back',
  'Whip pan': 'whip-pan',
  'Visual motif': 'visual-motif',
  'Visual metaphor': 'visual-metaphor',
  'Juxtaposition': 'juxtaposition',
  'On-screen text': 'on-screen-text',
  'Three-point lighting': 'three-point',
  'High-key lighting': 'high-key',
  'Low-key lighting': 'low-key',
  'Natural light': 'natural-light',
  'Silhouette / backlight': 'silhouette',
  'Practical lighting': 'practical-light',
};

function genericTechniquePreviewHtml(technique) {
  const shortLabel = technique.length > 24 ? `${technique.slice(0, 22)}…` : technique;
  return '<div class="generic-scene">'
    + '<div class="generic-frame frame-a"><i class="generic-subject"></i><i class="generic-object"></i></div>'
    + '<div class="generic-frame frame-b"><i class="generic-subject"></i><i class="generic-object"></i></div>'
    + '<div class="generic-light light-a"></div><div class="generic-light light-b"></div>'
    + '<div class="generic-wave">' + '<i></i>'.repeat(18) + '</div>'
    + '<div class="generic-playhead"></div><div class="generic-arrow"></div>'
    + `<div class="generic-caption">${shortLabel}</div></div>`;
}

function getTechniqueMotionSketch(technique) {
  if (TECHNIQUE_MOTION_SKETCH[technique]) return TECHNIQUE_MOTION_SKETCH[technique];
  const category = TECHNIQUE_CATEGORY[technique];
  if (!category) return null;
  const categoryDefaults = {
    composition: 'subject', movement: 'camera', lighting: 'light',
    metaphor_dataviz: 'graphic', other: 'edit',
  };
  const kind = TECHNIQUE_PREVIEW_KIND[technique] || categoryDefaults[category] || 'edit';
  const variant = TECHNIQUE_PREVIEW_VARIANT[technique] || 'default';
  return {
    cls: `generic ${kind} ${variant}`,
    title: technique,
    html: genericTechniquePreviewHtml(technique),
  };
}

let techniqueMotionPopoverEl = null;
function showTechniqueMotionPreview(technique, chipEl) {
  const sketch = getTechniqueMotionSketch(technique);
  if (!sketch) return;
  if (!techniqueMotionPopoverEl) {
    techniqueMotionPopoverEl = document.createElement('div');
    techniqueMotionPopoverEl.className = 'technique-motion-popover';
    document.body.appendChild(techniqueMotionPopoverEl);
  }
  const pop = techniqueMotionPopoverEl;
  pop.innerHTML = `<div class="technique-motion-popover-title">${sketch.title}</div>`
    + `<div class="technique-motion-scale"><div class="technique-motion-preview ${sketch.cls}"><div class="stage">${sketch.html}</div></div></div>`;
  pop.style.display = 'block';
  // Position below the chip, clamped to the viewport (flip above if needed).
  const r = chipEl.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - pw - 8);
  let top = r.bottom + 6;
  if (top + ph > window.innerHeight - 8) top = r.top - ph - 6;
  pop.style.left = `${Math.max(8, left)}px`;
  pop.style.top = `${Math.max(8, top)}px`;
}
function hideTechniqueMotionPreview() {
  if (techniqueMotionPopoverEl) techniqueMotionPopoverEl.style.display = 'none';
}

// One toggleable, draggable technique chip (shared by the grouped render in
// renderMovieEditor). Clicking toggles it in selectedTechniques; dragging it
// carries application/x-technique onto a paper-section block.
function buildTechniqueChip(technique, options) {
  options = options || {};
  const selectable = options.selectable !== false;
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip suggested chip-draggable';
  if (options.standard) chip.classList.add('standard-technique-chip');
  if (options.moodboardDerived) chip.classList.add('moodboard-derived');
  const selectionSet = options.selectionSet || selectedTechniques;
  chip.classList.toggle('selected', selectable && selectionSet.has(technique));
  chip.textContent = technique;
  if (selectable) {
    chip.addEventListener('click', () => {
      if (selectionSet.has(technique)) selectionSet.delete(technique);
      else selectionSet.add(technique);
      chip.classList.toggle('selected', selectionSet.has(technique));
      saveDebugSession();
    });
  }
  if (options.standard) {
    chip.title = options.moodboardDerived
      ? 'Standard technique · also highlighted by the moodboard distillation'
      : 'Standard filmmaking technique · drag onto a scene to apply';
  }
  chip.draggable = true;
  chip.addEventListener('dragstart', event => {
    event.dataTransfer.setData('application/x-technique', technique);
    event.dataTransfer.effectAllowed = 'copy';
  });
  // Every catalog technique has an animated preview. Hand-authored diagrams
  // are used when available; the rest use a semantic family animation.
  if (getTechniqueMotionSketch(technique)) {
    chip.classList.add('has-motion-preview');
    chip.addEventListener('mouseenter', () => showTechniqueMotionPreview(technique, chip));
    chip.addEventListener('mouseleave', hideTechniqueMotionPreview);
    chip.addEventListener('dragstart', hideTechniqueMotionPreview);
  }
  return chip;
}

// Kept in sync by convention with backend/animate_llm.py's TECHNIQUES (same
// convention as DOCUMENTARY_MODES above) - the 4 camera moves a sketch can
// be animated into (see buildSectionBlock's animate buttons and
// runGenerateAnimatedSketch).
const ANIMATE_TECHNIQUES = [
  { key: 'left_to_right', label: 'Pan →' },
  { key: 'right_to_left', label: 'Pan ←' },
  { key: 'in', label: 'Push in' },
  { key: 'out', label: 'Pull out' },
];

// Pre-populated reference footage (see assets/ at the repo root, served
// statically the same way premiere_exports/ is) - Record Audio/Record
// Video are hidden for now (see styles-index.css), so this is the
// standing way to have something to work with in "Your Media" without
// depending on the recording pipeline. Kept in sync by convention with
// assets/'s actual contents - no build step scans the directory, so a
// file added/removed there needs a matching edit here.
// Kept in sync by hand with what's actually in assets/ - listing a
// filename here that isn't actually there gives a list entry whose player
// can never load anything (verified live: assets/ only ever had 5 of an
// originally-intended 13 clips).
const MEDIA_BANK_ASSET_DEFAULTS = [
  'IMG_2387.mp4', 'IMG_2388.mp4', 'IMG_2389.mp4', 'IMG_2390.mp4',
  'IMG_2391.mp4',
].map(filename => ({ kind: 'video', label: filename, previewUrl: `/assets/${filename}` }));

let selectedTechniques = new Set();
// The techniques panel opens on the moodboard-distilled view; keep the
// toggle selection while the panel is re-rendered during the current session.
let techniquePanelView = 'moodboard';
let actBoardTechniquePopupEl = null;
let actBoardTechniquePopupCleanup = null;

const documentaryIntentInput = document.getElementById('documentary-intent-input');
const intentSuggestedChipsEl = document.getElementById('intent-suggested-chips');

// Moodboard entry-point elements (index.html only - null on storyboard.html).
const moodboardNameInput = document.getElementById('moodboard-name-input');
const moodboardAddNameBtn = document.getElementById('moodboard-add-name-btn');
const moodboardUrlInput = document.getElementById('moodboard-url-input');
const moodboardAddUrlBtn = document.getElementById('moodboard-add-url-btn');
const moodboardFileInput = document.getElementById('moodboard-file-input');
const moodboardListEl = document.getElementById('moodboard-list');
const moodboardStatusEl = document.getElementById('moodboard-status');
// 3D reconstruction entry-point elements (index.html only).
const reconstructFileInput = document.getElementById('reconstruct-file-input');
const reconstructListEl = document.getElementById('reconstruct-list');
const reconstructStatusEl = document.getElementById('reconstruct-status');
//#endregion

//#region --- KEEP TRACK OF STATE
// --- State: populated once per successful extraction, then mutated in
// place as sections are excluded/restored or arranged into a narrative arc.
// `index` is assigned once here and never reused, even once a section is
// filtered out of a request - it's the stable id both the removal toggle
// and the narrative-arc response key off of.

let currentLabel = '';
let currentSections = [];

// Stable id for the quiet server-side source snapshot. It is separate from
// Premiere's project id because this snapshot contains only reusable paper
// sections and moodboard links, not generated/export media.
let paperSnapshotId = null;
let paperSnapshotSaveTimer = null;

// index -> arc-part name string (one of currentArcSections' keys below) -
// starts empty on every accepted arc (see runAcceptArc); populated
// manually from there, one section at a time (handleChipDrop's drag, or
// the per-row "+ Add Section" button in renderMovieEditor).
let currentAssignments = {};

// Indices of sections currently highlighted (via a card or its compact chip
// - see handleSectionClick) - a plain click replaces this with just that one
// index, a shift-click toggles it into/out of the set. Drives the .selected
// highlight and, in the sticky action bar (see renderMovieEditor), which
// section(s) "Generate Storyboard"/"Generate Edit Plan" target - the
// selection if non-empty, otherwise the whole arc.
let selectedSectionIndices = new Set();

// Status text for the sticky action bar's own buttons (see
// setStoryboardStatus/setEditPlanStatus) - kept as state, not just a live
// DOM write, because a successful generation re-renders the whole bar (fresh
// status-line elements) before the "Done" message is set; renderMovieEditor
// reads this state to populate those fresh elements.
let storyboardBarStatus = { message: '', isError: false };
let editPlanBarStatus = { message: '', isError: false };

// The accepted narrative arc's named parts, in order - [{key, label,
// description}, ...] with key === label === the part-name string. Populated
// straight from whichever arc was accepted (see runAcceptArc) - no LLM
// section-assignment step, so this is set client-side, not from a server
// response. Drives
// how many columns/timeline segments renderMovieEditor draws.
let currentArcSections = [];

// The act board is the default presentation of the same scene objects. The
// established timeline/scene-card layout remains available through its
// toggle, and switching views never replaces or rewrites storyboard data.
let storyboardView = 'board';

// Act-board nodes are deliberately separate from scene objects. A presenter
// can iterate on a narration/footage idea without changing the timeline,
// attached source material, or recorded narration. Each narration node owns
// an ordered `footageNodeIds` chain with per-node timing; the graph is
// persisted with the normal storyboard session so refreshes do not re-run
// suggestions.
let actBoardNodes = Object.create(null);
// Act-board scene groupings. These are visual containers made by lassoing
// nodes (plus the initial empty scene per act); unlike Timeline + Scenes
// cards, they intentionally do not point at or mutate `currentSections`.
let actBoardScenes = Object.create(null);
// The scene whose nodes are currently loaded into an Act Board canvas. This
// lets scene-scoped actions (such as Clear links) avoid touching saved scenes
// that are not open.
let actBoardOpenSceneByAct = Object.create(null);
// The first act-board visit gets one empty, mode-aware scene per act. Keep a
// separate flag so Clear board remains a real clear operation instead of
// recreating the starter scenes on every rerender.
let actBoardInitialScenesInitialized = false;
let actBoardInitialSceneActKeys = new Set();
let actBoardPlaybackState = null;
let actBoardNativeAudioElement = null;
let activeActBoardResizeHandler = null;
const actBoardNarrationAnalysisPromises = new Map();
const actBoardFootageSearchCache = new Map();
const actBoardGenerationJobs = new Map();

function actBoardNodeVolume(node, fallback = 0.8) {
  const raw = node?.volume;
  // Older saved nodes may contain null/empty volume fields. Treat those as
  // “not set” so they retain audible playback; preserve an explicit numeric
  // zero as a legitimate mute choice.
  if (raw === null || raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

function stopActBoardNativeAudio() {
  const audio = actBoardNativeAudioElement;
  if (!audio) return;
  try { audio.pause(); } catch (err) { /* already detached */ }
  try { audio.currentTime = 0; } catch (err) { /* optional */ }
  actBoardNativeAudioElement = null;
}

function wireActBoardAudioExclusivity(audio) {
  if (!audio) return;
  audio.addEventListener('play', () => {
    if (actBoardNativeAudioElement && actBoardNativeAudioElement !== audio) {
      try { actBoardNativeAudioElement.pause(); } catch (err) { /* detached */ }
      try { actBoardNativeAudioElement.currentTime = 0; } catch (err) { /* optional */ }
    }
    actBoardNativeAudioElement = audio;
  });
  const clear = () => {
    if (actBoardNativeAudioElement === audio) actBoardNativeAudioElement = null;
  };
  audio.addEventListener('ended', clear);
  audio.addEventListener('emptied', clear);
}

// A suggested passage is useful direction for shot/media generation, but it
// is not an actual recorded voice track. Prefer the real transcript whenever
// one exists; otherwise let the draft guide previews and searches without
// making the timeline think audio has been recorded.
function effectiveSectionNarration(section) {
  return (section && (section.narration || section.narrationSuggestion) || '').trim();
}

// The arc suggestion is the source of truth for a freshly accepted scene's
// draft. This lookup also repairs older sessions that persisted the arc part
// but not the scene-side copy, preventing the card and scene from drifting.
function acceptedArcNarrationForSection(section) {
  if (!section || !selectedNarrationArc || !Array.isArray(selectedNarrationArc.sections)) return '';
  const actKey = currentAssignments[section.index];
  const part = selectedNarrationArc.sections.find(candidate =>
    candidate && (candidate.name || candidate.key) === actKey);
  return (part && part.suggested_narration || '').trim();
}

function syncAcceptedArcNarrationDrafts() {
  currentSections.forEach(section => {
    const draft = acceptedArcNarrationForSection(section);
    if (!draft) return;
    section.arcSuggestedNarration = draft;
    section.narrationSuggestion = draft;
  });
}

// Source deletion and storyboard deletion are separate operations. A paper
// section can remain available as source material after its arranged scene is
// cleared from the timeline. Older sessions have no sceneRemoved field, which
// is equivalent to false.
function isSceneActive(section) {
  return !!section && !section.removed && !section.sceneRemoved;
}

// Scene composition notes are deliberately separate from the attached paper
// passage. Older sessions have no sceneNotes field, so their paper text remains
// the fallback input for generation until the presenter adds explicit notes.
function sectionCompositionNotes(section) {
  return ((section && section.sceneNotes) || '').trim()
    || ((section && section.text) || '').trim();
}

let narrationAutofillPromise = null;
let narrationAutofillGeneration = 0;

// Draft narration for every arranged scene that does not already have a real
// transcript or saved draft. The requests run in a small worker pool so
// opening a long paper (or preparing Preview All) does not flood the LLM
// provider; each result is saved and appears after the batch finishes.
function autoSuggestNarrationForStoryboard(options) {
  options = options || {};
  // A second caller while the first batch is in flight should join it. Once a
  // batch finishes, a later call may still pick up newly-added scenes; saved
  // suggestions mean refreshes never regenerate completed narration, and
  // sceneRemoved keeps cleared scenes out of this target list.
  if (narrationAutofillPromise && !options.force) return narrationAutofillPromise;
  const generation = ++narrationAutofillGeneration;
  const targets = options.targets || currentSections.filter(section =>
    isSceneActive(section) && currentAssignments[section.index]
    && !section.narration && !section.narrationSuggestion);
  if (!targets.length) {
    if (options.force) narrationAutofillPromise = null;
    return Promise.resolve();
  }
  setStoryboardStatus(`Drafting narration for ${targets.length} scene${targets.length === 1 ? '' : 's'}...`);
  const concurrency = Math.min(3, targets.length);
  let next = 0;
  let completed = 0;
  const worker = async () => {
    while (next < targets.length) {
      const section = targets[next++];
      const act = currentArcSections.find(a => a.key === currentAssignments[section.index]);
      try {
        const result = await fetchSuggestNarration({
          sectionTitle: section.title,
          sectionText: section.text,
          actTitle: act ? act.label : '',
          actDescription: act ? act.description : '',
          abstract: findAbstractText(),
          documentaryMode: selectedDocumentaryMode,
        });
        // Do not overwrite a recording or an explicit draft created while the
        // background request was in flight.
        if (generation === narrationAutofillGeneration && isSceneActive(section)
          && currentAssignments[section.index]) {
          section.narrationSuggestion = (result.narration || '').trim();
          if (section.narrationSuggestion) completed += 1;
        }
      } catch (err) {
        // Autocomplete is an enhancement; a missing key/network must not make
        // the storyboard unusable. The per-scene button remains available.
      }
    }
  };
  const batch = Promise.all(Array.from({ length: concurrency }, worker)).then(() => {
    if (generation !== narrationAutofillGeneration) return;
    const remaining = currentSections.filter(section => !section.removed);
    renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
    saveDebugSession();
    setStoryboardStatus(completed
      ? `Added suggested narration to ${completed} scene${completed === 1 ? '' : 's'}. Record the voice track when ready.`
      : 'No narration drafts were added; use Suggest narration on a scene to retry.', completed === 0);
  });
  const tracked = batch.finally(() => {
    if (generation === narrationAutofillGeneration) narrationAutofillPromise = null;
  });
  narrationAutofillPromise = tracked;
  return tracked;
}

// Set on an arc-template chip click, cleared the moment the presenter types
// in the textarea afterward (see the ARC_TEMPLATES wiring below) - tracks
// whether the textarea's current content is still exactly a known template
// (so its exact section names can be sent deterministically) or has become
// custom free text (so the backend must invent-or-match instead).
let selectedArcTemplate = null;

// Set/cleared by the documentary-mode chips in the Timeline + Scenes view.
// Act Board scenes use the separately persisted `actBoardSetupMode` captured
// from the index.html setup flow, so changing this future-view picker does not
// silently change a scene board's highlighted mode.
let selectedDocumentaryMode = null;

// The mode distilled from the index.html moodboard is the setup input for the
// Act Board. Keep it separate from the Timeline + Scenes mode picker: that
// picker remains available for the future timeline workflow, but changing it
// must not silently change the mode highlighted on existing act-board scenes.
let actBoardSetupMode = null;

// Set once the presenter accepts a recommended/alternative/custom arc from
// suggest_arcs_from_intent (see runAcceptArc) - { sections: [{name, description}] },
// same shape a chip-picked template's sections would have. Cleared the
// moment the presenter types in the textarea afterward or picks a chip,
// same as selectedArcTemplate (they're mutually exclusive - only one of
// the two is ever non-null), and the moment a fresh recording starts.
let selectedNarrationArc = null;

// The most recently recorded intent narration's playable object URL (used
// for in-session playback - see playIntentBtn/playNarrationRange - and as
// a download fallback if in-browser playback fails) and tracked duration
// (a wall-clock fallback for recordedAudioBuffer.duration, see below - the
// backend's own transcription never returns a real duration, see
// backend/ingest/transcription.py).
let recordedNarrationUrl = null;
let recordedNarrationDurationSeconds = null;
let recordedNarrationExtension = 'webm'; // real container (see runTranscribeIntent) - blob: URLs carry no filename/extension to read back later

// A disk-served copy of the same recording (see fetchUploadNarration in
// runTranscribeIntent) - unlike recordedNarrationUrl's blob: URL, this
// survives navigating to storyboard.html, where it's re-fetched and
// decoded fresh to restore in-browser playback there (see
// restoreDebugSession's page-2 branch).
let persistedNarrationPreviewUrl = null;

// Fallback source of the documentary_goal text when #documentary-intent-input
// isn't in the page (currently commented out in html/index.html, recording-
// only for now) - set alongside/instead of that textarea in
// runTranscribeIntent. Every documentaryGoal read below prefers the
// textarea's value when it exists, so this is a no-op once it's back.
let recordedTranscript = '';

// Whole-piece pacing/music guidance from the most recent "Generate Edit
// Plan" run (backend/edit_plan_llm.py) - per-shot detail lives on each
// section's own .editPlan instead.
let overallEditNotes = '';

// Set once the first /premiere/upload_footage or /premiere/export call
// returns one, so every subsequent call in this session lands in the same
// premiere_exports/<project_id>/ folder instead of minting a new one each time.
let premiereProjectId = null;

// The moodboard entry point (index.html) - reference documentaries the
// presenter added, each analyzed in the background and later distilled into
// suggested arcs/mode/techniques (see runDistillMoodboard). Each entry:
// {refId, sourceKind:'named'|'youtube'|'upload', title, sourceUrl, note,
//  state:'analyzing'|'ready'|'error', profile:<distill-ready profile>|null,
//  thumbnailUrl}. Persisted across the index->storyboard navigation.
let moodboardReferences = [];
// 3D reconstruction jobs (index.html #reconstruct-module). Each entry:
// {reconId, name, kindHint:'auto'|'photo'|'panorama', state:'reconstructing'
//  |'ready'|'error', profile:<viewer profile>|null, expanded, teardown}.
let reconstructItems = [];
// The 1-3 sentence rationale the distillation returned for its suggested
// mode/techniques (see runDistillMoodboard) - surfaced in renderMovieEditor.
let distilledStyleRationale = '';

// The last moodboard distillation result ({recommended, alternatives,
// suggested_mode, suggested_techniques, style_rationale}) - cached + persisted
// so a storyboard.html reload re-renders the suggestion from it instead of
// firing a fresh (slow, non-deterministic) LLM call every refresh.
let lastDistillResult = null;

// Runtime-only state for narration drafts shown in the pre-accept arc
// suggestion. The generated text itself is stored on each arc part (and is
// therefore persisted with lastDistillResult); loading/error state stays out
// of the saved session so a refresh never restores a stale spinner.
const arcNarrationPendingParts = new WeakSet();
const arcNarrationFailedParts = new WeakSet();
let arcNarrationGeneration = 0;
//#endregion

//#region --- RECORD YOUR INTENT
// --- SUGGESTED FOCUS CHIPS
const FOCUS_STATEMENTS = [
  'A behind-the-scenes look at the research process',
  'An illustration of the research problem and your findings',
  'A call-to-action that discusses the implications of this research',
];

let selectedFocusStatements = new Set();

// intentSuggestedChipsEl only exists on index.html - guarded so this is a
// no-op on storyboard.html (which loads the same shared script).
if (intentSuggestedChipsEl) {
  FOCUS_STATEMENTS.forEach(statement => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip suggested';
    chip.textContent = statement;
    chip.addEventListener('click', () => {
      if (selectedFocusStatements.has(statement)) {
        selectedFocusStatements.delete(statement);
        chip.classList.remove('selected');
      } else {
        selectedFocusStatements.add(statement);
        chip.classList.add('selected');
      }
      updateComposeStoryboardVisibility();
    });
    intentSuggestedChipsEl.appendChild(chip);
  });
}

const recordIntentBtn = document.getElementById('record-intent-btn');
const recordIntentStatusEl = document.getElementById('record-intent-status');
const playIntentBtn = document.getElementById('play-intent-btn');
// intent-waveform-canvas only exists on index.html (the recording UI) -
// waveformCtx stays null on storyboard.html; drawLiveWaveform/
// drawStaticWaveform are only ever reached from index.html-only code
// paths (the record button, and runTranscribeIntent's decode success),
// so a null context there is never actually dereferenced.
const waveformCanvasEl = document.getElementById('intent-waveform-canvas');
const waveformCtx = waveformCanvasEl ? waveformCanvasEl.getContext('2d') : null;
const intentTranscriptDisplayEl = document.getElementById('intent-transcript-display');
const intentTranscriptTextEl = document.getElementById('intent-transcript-text');
const suggestArcsRowEl = document.getElementById('suggest-arcs-row');
// const suggestArcsBtn = document.getElementById('suggest-arcs-btn');
const suggestArcsStatusEl = document.getElementById('suggest-arcs-status');
const arcSuggestionPanelEl = document.getElementById('arc-suggestion-panel');

let intentRecorder = null;
let intentStream = null;
let intentRecordStartMs = null;

// Live oscilloscope trace while recording (see drawLiveWaveform, wired into
// the record button handler below) - separate from playbackAudioCtx below,
// which handles both decoding a finished clip and playing it back.
let liveWaveformAudioCtx = null;
let liveWaveformAnalyser = null;
let liveWaveformAnimationId = null;

// Cached peak-amplitude buckets for the most recent recording (see
// decodeRecordedNarration) - kept around so playNarrationRange's playhead
// loop below can redraw the static waveform on every frame without
// recomputing peaks.
let recordedPeaks = null;

// The fully-decoded recording, playable via Web Audio (see
// playNarrationRange) rather than an <audio> element - Safari can't play a
// MediaRecorder-produced blob back through <audio src>, even though
// decodeAudioData (used here and for the waveform) decodes it fine, so
// this sidesteps the native media pipeline entirely for playback too.
let recordedAudioBuffer = null;

// One long-lived AudioContext for both decoding and playback (not a fresh
// one per call) - separate from liveWaveformAudioCtx above, which is only
// for the live mic-input trace during an active recording.
let playbackAudioCtx = null;

function ensurePlaybackAudioCtx() {
  if (!playbackAudioCtx) playbackAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return playbackAudioCtx;
}

// The currently-playing AudioBufferSourceNode, if any - an
// AudioBufferSourceNode has no pause/resume of its own (only start/stop),
// so "pausing" means stopping this and remembering how far in we were
// (see playbackState) rather than a native pause. Only one clip plays at a
// time across the whole page - the intent recording (playIntentBtn), or
// any one section's own narration (see buildSectionBlock) - starting a new
// one stops whatever was playing before it. currentPlaybackOwner is
// whichever button currently "holds" playback (or null), so each button's
// own click handler can tell whether IT is the one to pause vs. start a
// new (and implicitly stop whichever other one was playing).
let currentPlaybackSource = null;
let currentPlaybackAnimationId = null;
let currentPlaybackStopCallback = null;
let currentPlaybackOwner = null;
let playbackState = { isPlaying: false, startedAtCtxTime: 0, offsetSeconds: 0 };

function stopNarrationPlayback() {
  if (currentPlaybackSource) {
    try { currentPlaybackSource.stop(); } catch (err) { /* already stopped/ended */ }
    currentPlaybackSource.disconnect();
    currentPlaybackSource = null;
  }
  if (currentPlaybackAnimationId) cancelAnimationFrame(currentPlaybackAnimationId);
  currentPlaybackAnimationId = null;
  playbackState.isPlaying = false;
  currentPlaybackOwner = null;
  if (currentPlaybackStopCallback) currentPlaybackStopCallback();
  currentPlaybackStopCallback = null;
}

// Plays [startSeconds, endSeconds) of audioBuffer (or the whole thing,
// both omitted) through Web Audio for the intent-recording player. Per-scene
// narration uses its native <audio> element instead. This remains deliberately
// not a plain
// <audio src> - see decodeRecordedNarration's own comment on why: Safari
// can't reliably play a MediaRecorder-produced clip back that way, even
// from a real disk-served file, but decodeAudioData/an
// AudioBufferSourceNode does. owner is whatever UI element the caller
// wants to identify as currently holding playback (see currentPlaybackOwner
// above); onStop() is called once playback stops or ends, for the caller
// to reset its own button's label. See playNarrationRange below.
function playAudioBuffer(audioBuffer, owner, onStop, startSeconds, endSeconds) {
  stopSfxPreview(true);
  stopNarrationPlayback();
  if (!audioBuffer) return;
  const ctx = ensurePlaybackAudioCtx();
  // decodeRecordedNarration/decodeAudioData create this context outside of
  // any user gesture (they run after an async transcription/upload call),
  // so Safari in particular can leave it 'suspended' until explicitly
  // resumed inside a real click handler like this one - resuming here is
  // always allowed.
  if (ctx.state === 'suspended') ctx.resume();
  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(ctx.destination);
  const offset = Math.max(0, Math.min(startSeconds || 0, audioBuffer.duration));
  const duration = endSeconds != null ? Math.max(0, endSeconds - offset) : undefined;
  source.start(0, offset, duration);
  source.addEventListener('ended', () => {
    if (currentPlaybackSource === source) stopNarrationPlayback();
  });
  currentPlaybackSource = source;
  currentPlaybackStopCallback = onStop;
  currentPlaybackOwner = owner;
  playbackState = { isPlaying: true, startedAtCtxTime: ctx.currentTime, offsetSeconds: offset };
}

function onNarrationPlaybackStateChange() {
  // Icon-only (see html/index.html's own comment on #play-intent-btn) -
  // title carries the label a sighted mouse-hover would've gotten from the
  // old text, and doubles as the accessible name screen readers announce.
  playIntentBtn.textContent = playbackState.isPlaying ? '⏸' : '▶';
  playIntentBtn.title = playbackState.isPlaying ? 'Pause' : 'Play recording';
}

// Plays [startSeconds, endSeconds) of the intent recording (or the whole
// thing, endSeconds/startSeconds omitted) - used by playIntentBtn.
function playNarrationRange(startSeconds, endSeconds) {
  if (!recordedAudioBuffer) return;
  playAudioBuffer(recordedAudioBuffer, playIntentBtn, onNarrationPlaybackStateChange, startSeconds, endSeconds);
  onNarrationPlaybackStateChange();

  const drawPlayhead = () => {
    if (!playbackState.isPlaying) return;
    currentPlaybackAnimationId = requestAnimationFrame(drawPlayhead);
    if (!recordedPeaks) return;
    const elapsed = playbackAudioCtx.currentTime - playbackState.startedAtCtxTime;
    const fraction = recordedAudioBuffer.duration ? (playbackState.offsetSeconds + elapsed) / recordedAudioBuffer.duration : 0;
    drawStaticWaveform(recordedPeaks, fraction);
  };
  drawPlayhead();
}

function drawLiveWaveform() {
  const bufferLength = liveWaveformAnalyser.fftSize;
  const dataArray = new Uint8Array(bufferLength);
  const draw = () => {
    liveWaveformAnimationId = requestAnimationFrame(draw);
    liveWaveformAnalyser.getByteTimeDomainData(dataArray);
    waveformCtx.fillStyle = '#ffffff';
    waveformCtx.fillRect(0, 0, waveformCanvasEl.width, waveformCanvasEl.height);
    waveformCtx.lineWidth = 2;
    waveformCtx.strokeStyle = '#ff1751';
    waveformCtx.beginPath();
    const sliceWidth = waveformCanvasEl.width / bufferLength;
    let x = 0;
    for (let i = 0; i < bufferLength; i++) {
      const y = (dataArray[i] / 128.0) * (waveformCanvasEl.height / 2);
      if (i === 0) waveformCtx.moveTo(x, y); else waveformCtx.lineTo(x, y);
      x += sliceWidth;
    }
    waveformCtx.stroke();
  };
  draw();
}

function stopLiveWaveform() {
  if (liveWaveformAnimationId) cancelAnimationFrame(liveWaveformAnimationId);
  liveWaveformAnimationId = null;
  if (liveWaveformAudioCtx) liveWaveformAudioCtx.close();
  liveWaveformAudioCtx = null;
  liveWaveformAnalyser = null;
}

// Decodes a finished recording into both a playable AudioBuffer (see
// playNarrationRange) and a fixed number of peak-amplitude buckets for a
// static waveform (see drawStaticWaveform) - one decode serves both, since
// decodeAudioData is the only thing that's actually reliable across
// browsers for a MediaRecorder-produced blob (see runTranscribeIntent's
// comment on why <audio src> can't be trusted for the same data). A
// rejection here means "no waveform and no in-browser playback" - callers
// should treat that as degraded, not fatal (transcription/arc-resolution
// don't depend on this succeeding).
const WAVEFORM_BUCKET_COUNT = 200;

function decodeRecordedNarration(blob, bucketCount) {
  return blob.arrayBuffer().then(arrayBuffer => {
    return ensurePlaybackAudioCtx().decodeAudioData(arrayBuffer).then(audioBuffer => {
      const channelData = audioBuffer.getChannelData(0);
      const samplesPerBucket = Math.max(1, Math.floor(channelData.length / bucketCount));
      const peaks = [];
      for (let i = 0; i < bucketCount; i++) {
        let max = 0;
        const start = i * samplesPerBucket;
        for (let j = 0; j < samplesPerBucket && start + j < channelData.length; j++) {
          const value = Math.abs(channelData[start + j]);
          if (value > max) max = value;
        }
        peaks.push(max);
      }
      return { audioBuffer, peaks };
    });
  });
}

// Best-effort in-browser playback of the last recorded intent narration,
// restored from its disk-persisted copy (see fetchUploadNarration/
// persistedNarrationPreviewUrl) rather than the blob: URL, which dies the
// moment a page is navigated away from. Shared by both pages' restore (see
// restoreDebugSession below) - index.html's #play-intent-btn re-enables
// playback of a recording made in an earlier session; storyboard.html's
// (same id, different page) only ever plays one back, never records.
function restorePersistedNarrationPlayback() {
  if (!persistedNarrationPreviewUrl || !playIntentBtn) return;
  fetch(persistedNarrationPreviewUrl)
    .then(response => response.arrayBuffer())
    .then(arrayBuffer => ensurePlaybackAudioCtx().decodeAudioData(arrayBuffer))
    .then(audioBuffer => {
      recordedAudioBuffer = audioBuffer;
      playIntentBtn.style.display = '';
    })
    .catch(() => { }); // no in-browser playback for this recording - not fatal
}

function drawStaticWaveform(peaks, playheadFraction) {
  const { width, height } = waveformCanvasEl;
  waveformCtx.clearRect(0, 0, width, height);
  waveformCtx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  waveformCtx.fillRect(0, 0, width, height);
  const barWidth = width / peaks.length;
  waveformCtx.fillStyle = '#ff1751';
  peaks.forEach((peak, i) => {
    const barHeight = Math.max(1, peak * height);
    waveformCtx.fillRect(i * barWidth, (height - barHeight) / 2, Math.max(1, barWidth - 1), barHeight);
  });
  if (typeof playheadFraction === 'number') {
    const x = playheadFraction * width;
    waveformCtx.strokeStyle = '#FFFFFF';
    waveformCtx.lineWidth = 2;
    waveformCtx.beginPath();
    waveformCtx.moveTo(x, 0);
    waveformCtx.lineTo(x, height);
    waveformCtx.stroke();
  }
}

// recordIntentBtn only exists on index.html (recording only ever happens
// there) - guarded (via short-circuit, so the handler body below doesn't
// need re-indenting) so this is a no-op on storyboard.html.
recordIntentBtn && recordIntentBtn.addEventListener('click', async () => {
  if (intentRecorder && intentRecorder.state === 'recording') {
    intentRecorder.stop();
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    recordIntentStatusEl.textContent = `Could not access microphone: ${err.message}`;
    recordIntentStatusEl.classList.add('error');
    return;
  }
  intentStream = stream;

  liveWaveformAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  liveWaveformAnalyser = liveWaveformAudioCtx.createAnalyser();
  liveWaveformAnalyser.fftSize = 2048;
  liveWaveformAudioCtx.createMediaStreamSource(stream).connect(liveWaveformAnalyser);
  waveformCanvasEl.style.display = '';
  drawLiveWaveform();

  const chunks = [];
  intentRecorder = new MediaRecorder(stream);
  // The actual container/codec MediaRecorder settled on - NOT necessarily
  // webm (e.g. Safari's MediaRecorder produces audio/mp4). Used below for
  // the Blob's declared type and to derive a correct file extension (for
  // the backend's format hint and the saved-to-disk copy) - playback
  // itself goes through decodeAudioData (see decodeRecordedNarration),
  // which sniffs the real bytes rather than trusting this label, since
  // Safari can't reliably play a MediaRecorder blob back via <audio src>
  // even when it's labeled correctly.
  const intentMimeType = intentRecorder.mimeType || 'audio/webm';
  intentRecorder.addEventListener('dataavailable', event => {
    if (event.data.size > 0) chunks.push(event.data);
  });
  intentRecordStartMs = Date.now();
  intentRecorder.addEventListener('stop', () => {
    intentStream.getTracks().forEach(track => track.stop());
    stopLiveWaveform();
    const durationSeconds = (Date.now() - intentRecordStartMs) / 1000;
    const blob = new Blob(chunks, { type: intentMimeType });
    recordIntentBtn.textContent = 'Record';
    runTranscribeIntent(blob, durationSeconds, intentMimeType);
  });
  intentRecorder.start();
  recordIntentBtn.textContent = 'Stop Recording';
  recordIntentStatusEl.textContent = '';
  recordIntentStatusEl.classList.remove('error');
  playIntentBtn.style.display = 'none';
  stopNarrationPlayback();
  // A fresh recording invalidates anything derived from the previous one -
  // the old transcript display and any already-accepted arc
  // (selectedNarrationArc) both pertained to that earlier take. Arc
  // suggestions live on storyboard.html (a separate page - see
  // saveDebugSession/restoreDebugSession for how state crosses over), so
  // there's no DOM to reset here; it'll simply read the now-cleared state
  // fresh next time that page loads. Focus chip picks are left alone - a
  // re-record for the same intended focus is a reasonable thing to want.
  intentTranscriptDisplayEl.style.display = 'none';
  selectedNarrationArc = null;
});

// Plays back the whole recording from the start (or resumes stopping/
// starting doesn't preserve position the way a native <audio> pause would,
// but that's an acceptable trade-off - see playNarrationRange/
// stopNarrationPlayback above). Shown once a recording's decoded and ready
// - either freshly (decodeRecordedNarration, see runTranscribeIntent, only
// on index.html) or restored from disk (restorePersistedNarrationPlayback,
// on either page); if decoding failed, recordedAudioBuffer stays null and
// playNarrationRange is a no-op, but the button itself stays hidden in
// that case so this shouldn't be reachable in practice.
playIntentBtn && playIntentBtn.addEventListener('click', () => {
  if (currentPlaybackOwner === playIntentBtn) {
    stopNarrationPlayback();
  } else {
    playNarrationRange(0, recordedAudioBuffer ? recordedAudioBuffer.duration : undefined);
  }
});

// --- TRANSCRIBE RECORDING
function runTranscribeIntent(blob, durationSeconds, mimeType) {
  recordIntentBtn.disabled = true;
  recordIntentStatusEl.textContent = 'Transcribing your narration ...';
  recordIntentStatusEl.classList.remove('error');
  // Matches the recording's real container (see intentMimeType above) -
  // backend/ingest/transcription.py derives its Gemini audio_format hint
  // from this extension, and the saved-to-disk copy should be openable
  // with a correct extension too.
  const extensionMatch = /audio\/([a-z0-9]+)/i.exec(mimeType || '');
  const extension = extensionMatch ? extensionMatch[1] : 'webm';
  const filename = `intent-narration-${Date.now()}.${extension}`;

  // Set up-front (doesn't depend on any of the three async calls below) so
  // it's available immediately for a decode-failure download fallback.
  if (recordedNarrationUrl) URL.revokeObjectURL(recordedNarrationUrl);
  recordedNarrationUrl = URL.createObjectURL(blob);
  recordedNarrationDurationSeconds = durationSeconds;
  recordedNarrationExtension = extension;

  // Best-effort side paths, independent of the transcription/arc-resolution
  // chain below - a decode/waveform failure or a disk-save failure
  // shouldn't block stating the documentary's intent. Saving to disk is
  // silent (no visible status) - only premiereProjectId bookkeeping
  // depends on it.
  decodeRecordedNarration(blob, WAVEFORM_BUCKET_COUNT)
    .then(({ audioBuffer, peaks }) => {
      recordedAudioBuffer = audioBuffer;
      recordedPeaks = peaks;
      drawStaticWaveform(peaks);
      playIntentBtn.style.display = ''; // only shown once there's a decoded buffer to actually play
    })
    .catch(() => { }); // no waveform/in-browser playback for this recording - it's still downloadable via recordedNarrationUrl

  fetchUploadNarration(blob, filename, premiereProjectId)
    .then(({ project_id, preview_url }) => {
      premiereProjectId = project_id;
      // A real, disk-served URL (unlike recordedNarrationUrl's blob: URL,
      // which dies the moment this page is navigated away from) - lets
      // storyboard.html re-fetch and decode the same recording for
      // playback there (see restoreDebugSession's page-2 branch).
      persistedNarrationPreviewUrl = preview_url || null;
      saveDebugSession();
    })
    .catch(() => { });

  fetchTranscription(blob, filename)
    .then(({ text }) => {
      const transcript = (text || '').trim();
      if (!transcript) throw new Error('Transcription returned no text - try recording again.');

      recordedTranscript = transcript;
      if (documentaryIntentInput) documentaryIntentInput.value = transcript;
      selectedArcTemplate = null;

      // Show what was actually heard - the next step (picking a focus,
      // then asking for arc suggestions) happens on storyboard.html, once
      // "Compose Storyboard" is clicked (see runSuggestArcs there).
      intentTranscriptTextEl.textContent = transcript;
      intentTranscriptDisplayEl.style.display = '';
      recordIntentStatusEl.textContent = '';
      recordIntentBtn.disabled = false;
      updateComposeStoryboardVisibility();
    })
    .catch(err => {
      recordIntentStatusEl.textContent = err.message;
      recordIntentStatusEl.classList.add('error');
      recordIntentBtn.disabled = false;
    });
}
//#endregion

//#region --- EXTRACT SOURCE MATERIAL
// Click-to-edit in place: turns `el` into a contenteditable field on click
// (without letting that click also bubble up to the section block's own
// click-to-exclude handler), saves back through `setValue` on blur/Enter,
// and reverts on Escape. Leaves `el` untouched if nothing actually changed,
// so a click-then-blur with no edit can't clobber real content with
// whatever placeholder text happened to be showing (e.g. "(no text
// captured for this section)" for an empty section).
function makeEditable(el, getValue, setValue, { multiline, allowEmpty } = {}) {
  el.classList.add('editable-field');

  el.addEventListener('click', event => {
    event.stopPropagation();
    if (el.isContentEditable) return;

    el.contentEditable = 'true';
    el.classList.add('editing');
    el.focus();

    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });

  el.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      el.textContent = getValue();
      el.blur();
    } else if (event.key === 'Enter' && !multiline) {
      event.preventDefault();
      el.blur();
    }
  });

  el.addEventListener('blur', () => {
    el.contentEditable = 'false';
    el.classList.remove('editing');

    const oldValue = getValue();
    const newValue = el.textContent.trim();
    if (!newValue) {
      if (allowEmpty) {
        // Clear the underlying value; getValue() then returns the placeholder,
        // so the field shows that (e.g. Scene Notes emptied out).
        setValue('');
        el.textContent = getValue();
      } else {
        el.textContent = oldValue; // don't allow clearing a field (e.g. titles)
      }
      return;
    }
    if (newValue !== oldValue) {
      setValue(newValue);
    }
  });
}

// Indices are assigned once and never reused (see the state comment near
// currentSections), so a manually-created section - via "+ Add Section" -
// needs a genuinely new one rather than reusing/incrementing off
// currentSections.length (which drifts once any section is added/removed).
function nextSectionIndex() {
  return Math.max(-1, ...currentSections.map(s => s.index)) + 1;
}

// Inserts a brand-new section right after `afterIndex` (or at the end, if
// afterIndex isn't found - e.g. the flat pre-arrangement feed has nothing to
// insert "after" in arc terms). `act`, when given, is one of
// currentArcSections' keys, so the new section immediately appears in that
// row; omitted when there's no arrangement yet to place it into.
// `narrativeOnly`, when true, marks this as a blank placeholder created for
// the arc's structure rather than derived from the paper (an empty act row,
// an accepted arc, or a mode scaffold - see renderMovieEditor). These scene
// placeholders never belong in the index.html source-material feed.
function insertSection(afterIndex, title, text, act, narrativeOnly) {
  const section = { index: nextSectionIndex(), title, text, image: null, removed: false };
  if (narrativeOnly) section.narrativeOnly = true;
  const pos = currentSections.findIndex(s => s.index === afterIndex);
  currentSections.splice(pos === -1 ? currentSections.length : pos + 1, 0, section);
  if (act) currentAssignments[section.index] = act;
  return section;
}

// The visual box (black, top-left of an arranged card - see buildSectionBlock)
// shows whichever media is currently the best candidate for this shot, in
// priority order: a picked stock video, uploaded/recorded footage, the
// paper's own figure image, or (nothing concrete yet) the storyboard's
// suggested visual direction as plain text.
// Each of these mirrors one concrete visual a section could have - built
// as a lookup (rather than an if/else chain) so buildVisualBox below can
// try section.visualSource (whichever one the presenter most recently
// recorded/generated/picked - see runUploadFootage/runGenerateSketch/
// buildMediaVideoOption, all of which set it) first, falling through to
// the rest only if that one's own data is missing (e.g. a stale session).
// Without visualSource, a *fixed* priority order would mean whichever of
// these got set first (say, clicking a Find Footage frame) permanently
// shadows anything done after it (recording new webcam footage, say) -
// each returns null when its own section field isn't set, so the caller
// can just move on to the next candidate.
// Human-readable movement labels for the shot-frames artboard header (see
// the shotFrames renderer) - keys are shot_plan_llm.py's movement vocabulary.
const SHOT_MOVEMENT_LABELS = {
  static: 'STATIC', pan: 'PAN', tilt: 'TILT', push_in: 'PUSH IN',
  pull_out: 'PULL OUT', tracking: 'TRACKING', handheld: 'HANDHELD',
};

// Maps a shot's inferred camera movement (shot_plan_llm.py's 7-value
// vocabulary) onto one of the cutaway motion types, so a narration-driven
// shot's frames animate with the SAME orange camera-frame overlay the
// expository cutaways use (see the cutaways renderer + .cutaway-stage.motion-*
// CSS). 'static' still gets a gentle move so every generated shot animates.
const SHOT_MOVEMENT_TO_MOTION = {
  static: 'approach', pan: 'reveal', tilt: 'ascend', push_in: 'approach',
  pull_out: 'retreat', tracking: 'orbit', handheld: 'countermotion',
};

// Display labels for a cutaway's camera motion (see the cutaways renderer /
// cutaway_llm.py's _MOTION_TYPES / directional_motion_sketches.html).
const CUTAWAY_MOTION_LABELS = {
  reveal: 'Reveal →', return: 'Return ←', approach: 'Approach', retreat: 'Retreat',
  ascend: 'Ascend ↑', descend: 'Descend ↓', orbit: 'Orbit ↻',
  countermotion: 'Countermotion', enterexit: 'Enter / Exit',
};

function configureUploadedFootagePreview(player, section) {
  if (section.uploadedFootageThumbnailUrl) {
    player.poster = section.uploadedFootageThumbnailUrl;
    player.preload = 'metadata';
    return;
  }
  // Migration fallback for uploads saved before thumbnail_url existed: make
  // the browser decode an early frame instead of leaving a black rectangle.
  player.preload = 'auto';
  player.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(player.duration) && player.duration > 0) {
      player.currentTime = Math.min(0.05, player.duration / 2);
    }
  }, { once: true });
}

function configureGeneratedVideoPreview(player, section) {
  // Prefer the exact frame used to seed the video. Older responses/sessions
  // may not have animatedSketchThumbnailUrl, so fall back through the selected
  // example, generated shot frame, and first example instead of showing black.
  const firstExample = section.exampleShots && section.exampleShots[0];
  const posterUrl = section.animatedSketchThumbnailUrl
    || (section.selectedExample && section.selectedExample.url)
    || section.startFramePreviewUrl
    || (firstExample && (firstExample.thumbnail_url || firstExample.url));
  if (posterUrl) {
    const separator = posterUrl.includes('?') ? '&' : '?';
    const version = section.animatedSketchGeneratedAt || section.examplesGeneratedAt || Date.now();
    player.poster = `${posterUrl}${separator}t=${version}`;
    player.preload = 'metadata';
    return;
  }
  // Last-resort migration path when no generated still was persisted.
  player.preload = 'auto';
  player.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(player.duration) && player.duration > 0) {
      player.currentTime = Math.min(0.05, player.duration / 2);
    }
  }, { once: true });
}

const VISUAL_BOX_RENDERERS = {
  uploadedSketch(section) {
    if (!section.uploadedSketchPreviewUrl) return null;
    const img = document.createElement('img');
    img.className = 'paper-section-visual-media user-sketch-preview';
    img.src = `${section.uploadedSketchPreviewUrl}?t=${section.uploadedSketchUploadedAt || ''}`;
    img.alt = 'Uploaded scene sketch';
    return img;
  },
  // Expository B-roll cutaways (see runGenerateCutaways / /paper/generate_cutaways):
  // a horizontal scroll of cards, each an AI background still with an animated
  // orange camera-frame overlay (motion-<type>, ported from
  // directional_motion_sketches.html) and a caption. Planning-only previews.
  cutaways(section) {
    if (!section.cutaways || !section.cutaways.length) return null;
    const bust = section.cutawaysGeneratedAt ? `?t=${section.cutawaysGeneratedAt}` : '';
    const row = document.createElement('div');
    row.className = 'cutaways-row';
    section.cutaways.forEach(cut => {
      const card = document.createElement('div');
      card.className = 'cutaway-card';

      const stage = document.createElement('div');
      stage.className = `cutaway-stage motion-${cut.motion_type || 'approach'}`;
      const img = document.createElement('img');
      img.className = 'cutaway-bg';
      img.src = `${cut.preview_url}${bust}`;
      img.alt = cut.caption || 'cutaway';
      stage.appendChild(img);
      const cam = document.createElement('div'); // the animated camera frame
      cam.className = 'cutaway-camera';
      stage.appendChild(cam);
      card.appendChild(stage);

      const cap = document.createElement('div');
      cap.className = 'cutaway-caption';
      const motionLabel = CUTAWAY_MOTION_LABELS[cut.motion_type] || cut.motion_type || '';
      cap.textContent = motionLabel ? `${cut.caption} · ${motionLabel}` : (cut.caption || '');
      card.appendChild(cap);

      row.appendChild(card);
    });
    return row;
  },
  // The narration-driven shot(s): a start frame → end frame artboard per shot
  // (see /paper/generate_shot). A scene has one shot per dragged technique (see
  // runGenerateShot), so this renders section.shots as a vertical sequence of
  // boards, each labeled with its technique + shot-size/movement + purpose.
  // Falls back to the legacy single start/end pair for older sessions.
  shotFrames(section) {
    const shots = (section.shots && section.shots.length)
      ? section.shots
      : ((section.startFramePreviewUrl && section.endFramePreviewUrl)
        ? [{ technique: null, shotPlan: section.shotPlan || {}, startFramePreviewUrl: section.startFramePreviewUrl, endFramePreviewUrl: section.endFramePreviewUrl }]
        : null);
    if (!shots) return null;
    const bust = section.shotFramesGeneratedAt ? `?t=${section.shotFramesGeneratedAt}` : '';

    const sequence = document.createElement('div');
    sequence.className = 'shot-sequence';

    shots.forEach((shot, idx) => {
      const plan = shot.shotPlan || {};
      const board = document.createElement('div');
      board.className = 'shot-frames';

      const move = SHOT_MOVEMENT_LABELS[plan.movement] || (plan.movement || '').toUpperCase();
      const header = document.createElement('div');
      header.className = 'shot-frames-header';
      const headerBits = [];
      if (shots.length > 1) headerBits.push(`SHOT ${idx + 1}`);
      if (shot.technique) headerBits.push(shot.technique);
      if (move) headerBits.push(move);
      if (plan.shot_size) headerBits.push(plan.shot_size);
      header.textContent = headerBits.join(' · ');
      board.appendChild(header);

      // ONE box that cycles between the start and end frame (a hard-cut loop),
      // rather than two side-by-side frames - both stacked in the same
      // .cutaway-stage (with the animated camera overlay), cross-cut via CSS
      // (.shot-cycle-start / .shot-cycle-end). The camera move is mapped onto a
      // cutaway motion so it animates like the expository cutaways do.
      const motion = SHOT_MOVEMENT_TO_MOTION[plan.movement] || 'approach';
      const stage = document.createElement('div');
      stage.className = `cutaway-stage motion-${motion} shot-frame-stage shot-cycle-stage`;
      const startImg = document.createElement('img');
      startImg.className = 'cutaway-bg shot-cycle-frame shot-cycle-start';
      startImg.src = `${shot.startFramePreviewUrl}${bust}`;
      startImg.alt = 'start frame';
      const endImg = document.createElement('img');
      endImg.className = 'cutaway-bg shot-cycle-frame shot-cycle-end';
      endImg.src = `${shot.endFramePreviewUrl}${bust}`;
      endImg.alt = 'end frame';
      stage.appendChild(startImg);
      stage.appendChild(endImg);
      const cam = document.createElement('div');
      cam.className = 'cutaway-camera';
      stage.appendChild(cam);
      board.appendChild(stage);

      const cap = document.createElement('div');
      cap.className = 'shot-frame-caption';
      cap.textContent = 'START ⇄ END';
      board.appendChild(cap);

      if (plan.purpose) {
        const purpose = document.createElement('div');
        purpose.className = 'shot-frames-purpose';
        purpose.textContent = `Purpose: ${plan.purpose}`;
        board.appendChild(purpose);
      }
      sequence.appendChild(board);
    });
    return sequence;
  },
  // A batch of generated options (see runGenerateShotExamples) - a horizontal
  // rail of cheap still frames + videos, each clickable to COMMIT it as the
  // shot's visual (image -> modern example; video -> animated preview).
  examples(section) {
    // exampleShots: [{url, label, shot_size, movement}] - deliberately
    // contrasting camera treatments of the same scene. Pinned cards are
    // merged first so a later examples/video generation cannot discard them.
    const generatedShots = (section.exampleShots && section.exampleShots.length)
      ? section.exampleShots
      : (section.exampleImages || []).map(url => ({ url, label: '', shot_size: '', movement: '' }));
    const pinnedShots = Array.isArray(section.pinnedExamples) ? section.pinnedExamples : [];
    const shotByUrl = new Map();
    pinnedShots.forEach(shot => {
      if (shot && shot.url) shotByUrl.set(shot.url, { ...shot, pinned: true });
    });
    generatedShots.forEach(shot => {
      if (shot && shot.url && !shotByUrl.has(shot.url)) shotByUrl.set(shot.url, shot);
    });
    const shots = Array.from(shotByUrl.values());
    if (!shots.length) return null;
    const bust = section.examplesGeneratedAt ? `?t=${section.examplesGeneratedAt}` : '';

    const wrap = document.createElement('div');
    wrap.className = 'shot-examples';

    const hint = document.createElement('div');
    hint.className = 'shot-examples-hint';
    hint.textContent = 'Drag an image to your footage or sketch  · double-click to pin for future generation';
    wrap.appendChild(hint);

    const grid = document.createElement('div');
    // Kept under the historical class name for CSS compatibility; visually
    // this is a horizontal scroll rail, not a multi-row grid.
    grid.className = 'shot-examples-grid';
    grid.setAttribute('role', 'list');
    grid.setAttribute('aria-label', 'Generated shot examples');

    const rerender = () => {
      saveDebugSession();
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      // Rendering rebuilds the rail DOM. Restore the selected card's
      // horizontal position without scrolling the whole page vertically.
      const selectedUrl = section.selectedExample && section.selectedExample.url;
      if (!selectedUrl) return;
      requestAnimationFrame(() => {
        const block = resultsEl.querySelector(
          `.paper-section-block[data-section-index="${section.index}"]`);
        const rail = block && block.querySelector('.shot-examples-grid');
        const selected = rail && Array.from(rail.querySelectorAll('.shot-example-option'))
          .find(option => option.dataset.exampleUrl === selectedUrl);
        if (!rail || !selected) return;
        const target = selected.offsetLeft - (rail.clientWidth - selected.offsetWidth) / 2;
        rail.scrollLeft = Math.max(0, target);
      });
    };

    const commitExampleSelection = shot => {
      if (shot.kind === 'video') {
        clearLegacyShotFrames(section);
        section.animatedSketchPreviewUrl = shot.url;
        section.animatedSketchThumbnailUrl = shot.thumbnail_url || null;
        section.selectedExample = {
          url: shot.url, label: shot.label,
          kind: 'video', shot_size: shot.shot_size, movement: shot.movement,
        };
        section.visualSource = 'examples';
        rerender();
        return;
      }
      // Do not copy this modern example into startFrame/endFrame or
      // section.shots: those are the legacy shotFrames() data model and
      // would make the old START ⇄ END artboard reappear after a click.
      clearLegacyShotFrames(section);
      const pickedPlan = Object.assign({}, section.shotPlan || {},
        shot.shot_size ? { shot_size: shot.shot_size } : {},
        shot.movement ? { movement: shot.movement } : {},
        shot.narrative_operation ? { narrative_operation: shot.narrative_operation } : {},
        shot.purpose ? { purpose: shot.purpose } : {},
        shot.visual_description ? { visual_description: shot.visual_description } : {});
      section.shotPlan = pickedPlan;
      section.animatedSketchPreviewUrl = null;
      section.selectedExample = {
        url: shot.url, label: shot.label,
        kind: 'image', shot_size: shot.shot_size, movement: shot.movement,
      };
      section.visualSource = 'examples';
      rerender();
    };

    const togglePinnedExample = shot => {
      if (!shot || !shot.url) return;
      if (!Array.isArray(section.pinnedExamples)) section.pinnedExamples = [];
      const index = section.pinnedExamples.findIndex(item => item && item.url === shot.url);
      if (index >= 0) {
        section.pinnedExamples.splice(index, 1);
      } else {
        section.pinnedExamples.push({ ...shot, pinned: true, pinnedAt: Date.now() });
      }
      // A double-click both pins and selects the card, so it remains the
      // featured preview while new results are generated around it.
      commitExampleSelection(shot);
    };

    // Which option is currently in use (picking one commits it for the render
    // but KEEPS the gallery visible so the others can still be compared/picked).
    const sel = section.selectedExample || null;

    // A large, immediate still above the option grid—matching the uploaded-
    // footage poster treatment. Before anything is selected, the first result
    // is the representative preview; selecting another promotes that one.
    const featuredShot = (sel && shots.find(shot => shot.url === sel.url)) || shots[0];
    const featured = document.createElement('div');
    featured.className = 'shot-examples-featured';
    const featuredLabel = document.createElement('div');
    featuredLabel.className = 'shot-examples-featured-label';
    featuredLabel.textContent = sel ? 'Selected generated example' : 'Generated example preview';
    featured.appendChild(featuredLabel);
    if (featuredShot.kind === 'video') {
      const featuredVideo = document.createElement('video');
      featuredVideo.className = 'shot-examples-featured-video';
      featuredVideo.src = `${featuredShot.url}${bust}`;
      featuredVideo.poster = `${featuredShot.thumbnail_url || ''}${bust}`;
      featuredVideo.autoplay = true;
      featuredVideo.muted = true;
      featuredVideo.loop = true;
      featuredVideo.playsInline = true;
      featured.appendChild(featuredVideo);
    } else {
      const featuredImg = document.createElement('img');
      featuredImg.src = `${featuredShot.thumbnail_url || featuredShot.url}${bust}`;
      featuredImg.alt = featuredShot.label || 'Generated example preview';
      featured.appendChild(featuredImg);
    }
    wrap.appendChild(featured);

    shots.forEach((shot, i) => {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'shot-example-option';
      opt.setAttribute('role', 'listitem');
      opt.draggable = true;
      opt.dataset.exampleUrl = shot.url;
      if (shot.pinned) opt.classList.add('pinned');
      if (sel && sel.url === shot.url) opt.classList.add('selected');
      opt.title = shot.pinned
        ? 'Pinned example — double-click to unpin; click to select'
        : 'Click to select; double-click to pin';
      opt.addEventListener('dragstart', event => {
        event.stopPropagation();
        event.dataTransfer.effectAllowed = 'copy';
        event.dataTransfer.setData('application/x-generated-shot', JSON.stringify({
          url: shot.url,
          thumbnail_url: shot.thumbnail_url || shot.url,
          kind: shot.kind || 'image',
          label: shot.label || '',
          visual_description: shot.visual_description || '',
          shot_size: shot.shot_size || '',
          movement: shot.movement || '',
        }));
      });
      if (shot.kind === 'video') {
        const video = document.createElement('video');
        video.className = 'shot-example-video';
        video.src = `${shot.url}${bust}`;
        video.poster = `${shot.thumbnail_url || ''}${bust}`;
        video.muted = true;
        video.autoplay = true;
        video.loop = true;
        video.playsInline = true;
        opt.appendChild(video);
      } else {
        const img = document.createElement('img');
        img.src = `${shot.thumbnail_url || shot.url}${bust}`;
        img.alt = shot.label || `example ${i + 1}`;
        img.loading = 'lazy';
        opt.appendChild(img);
      }
      if (shot.label) {
        const lbl = document.createElement('div');
        lbl.className = 'shot-example-label';
        const movementLabel = SHOT_MOVEMENT_LABELS[shot.movement]
          || (shot.movement || '').replaceAll('_', ' ').toUpperCase();
        lbl.textContent = [shot.label, shot.shot_size, movementLabel].filter(Boolean).join(' · ');
        opt.appendChild(lbl);
      }
      let clickTimer = null;
      opt.addEventListener('click', event => {
        event.stopPropagation();
        // Defer a single-click commit briefly so a double-click can pin the
        // card without the first click rebuilding its DOM underneath us.
        if (event.detail > 1) return;
        clickTimer = setTimeout(() => commitExampleSelection(shot), 220);
      });
      opt.addEventListener('dblclick', event => {
        event.stopPropagation();
        if (clickTimer) clearTimeout(clickTimer);
        togglePinnedExample(shot);
      });
      grid.appendChild(opt);
    });

    wrap.appendChild(grid);

    return wrap;
  },
  stockVideo(section) {
    if (!section.selectedVideo) return null;
    const player = document.createElement('video');
    player.className = 'paper-section-visual-media';
    player.src = section.selectedVideo.video_url;
    player.poster = section.selectedVideo.thumbnail_url || '';
    player.controls = true;
    player.preload = 'metadata';
    // Without this, a click anywhere on the player (including its native
    // play button) bubbles up to the card's own click-to-select handler
    // (see handleSectionClick), which re-renders the whole card - tearing
    // down and rebuilding this exact element mid-interaction, so pressing
    // play visibly never seems to do anything. Same fix already applied
    // to this same player inside buildMediaVideoOption.
    player.addEventListener('click', event => event.stopPropagation());
    return player;
  },
  video(section) {
    // A generated video dragged into the footage/sketch slot has a preview
    // URL but no local upload path. It is still valid scene-reference media,
    // so render it exactly like an uploaded clip; only hide the renderer when
    // neither a path nor a preview exists.
    if (!section.uploadedFootagePath && !section.uploadedFootagePreviewUrl) return null;
    if (!section.uploadedFootagePreviewUrl) {
      // Uploaded before preview_url existed (an older saved session) - no
      // URL to play back, just say so.
      const label = document.createElement('div');
      label.className = 'paper-section-visual-placeholder';
      label.textContent = `Footage uploaded ✓ (${section.uploadedFootagePath.split('/').pop()})`;
      return label;
    }
    const player = document.createElement('video');
    player.className = 'paper-section-visual-media';
    player.src = section.uploadedFootagePreviewUrl;
    configureUploadedFootagePreview(player, section);
    player.controls = true;
    // See stockVideo's own comment above - same reasoning.
    player.addEventListener('click', event => event.stopPropagation());
    return player;
  },
  sketch(section) {
    if (!section.sketchPreviewUrl) return null;
    const img = document.createElement('img');
    img.className = 'paper-section-visual-media';
    // Cache-busts the request so re-generating a sketch (see
    // runGenerateSketch) is actually visible - the backend saves every
    // sketch for this section to the same filename, so an unchanged URL
    // would otherwise just show the browser's cached copy of the old one.
    img.src = section.sketchGeneratedAt ? `${section.sketchPreviewUrl}?t=${section.sketchGeneratedAt}` : section.sketchPreviewUrl;
    img.alt = 'Generated storyboard sketch';
    return img;
  },
  image(section) {
    if (!section.image) return null;
    const img = document.createElement('img');
    img.className = 'paper-section-visual-media';
    img.src = section.image;
    img.alt = section.title;
    return img;
  },
  animatedSketch(section) {
    if (!section.animatedSketchPreviewUrl) return null;
    // Cache-busts the request so re-generating the same technique (see
    // runGenerateAnimatedSketch/runGenerateVideoFromText/
    // runGenerateSketchSequence) is actually visible - same reasoning as
    // the sketch renderer's own sketchGeneratedAt above.
    const src = section.animatedSketchGeneratedAt
      ? `${section.animatedSketchPreviewUrl}?t=${section.animatedSketchGeneratedAt}`
      : section.animatedSketchPreviewUrl;
    // The sketch-sequence method (see runGenerateSketchSequence) produces
    // an actual looping .gif, not a video file - a plain <img> already
    // autoplays/loops a GIF natively, so there's no reason to route it
    // through <video> like the other two (Veo-based) methods' .mp4 output.
    if (section.animatedSketchIsGif) {
      const img = document.createElement('img');
      img.className = 'paper-section-visual-media';
      img.src = src;
      img.alt = 'Animated storyboard sketch sequence';
      return img;
    }
    const player = document.createElement('video');
    player.className = 'paper-section-visual-media';
    player.src = src;
    configureGeneratedVideoPreview(player, section);
    player.controls = true;
    player.loop = true;
    player.preload = 'metadata';
    // See stockVideo's own comment above - same reasoning.
    player.addEventListener('click', event => event.stopPropagation());
    return player;
  },
};

function buildVisualBox(section, options) {
  options = options || {};
  const box = document.createElement('div');
  box.className = 'paper-section-visual-box';

  let rendered = null;
  let renderedKey = null;
  // User footage remains the visual preview priority when present. An
  // uploaded sketch is a generation/content reference, not a reason to hide
  // footage the presenter has supplied for the scene.
  const preferredSource = section.uploadedFootagePreviewUrl ? 'video' : section.visualSource;
  // A generated examples gallery is the active preview after Preview
  // examples/video. Prefer it over legacy shotFrames fields that are retained
  // only for export compatibility; otherwise an image click can fall through
  // to the old START ⇄ END artboard and its Purpose caption. `exampleImages`
  // is included for older saved sessions that predate `exampleShots`.
  const hasExamples = (Array.isArray(section.exampleShots) && section.exampleShots.length > 0)
    || (Array.isArray(section.exampleImages) && section.exampleImages.length > 0)
    || (Array.isArray(section.pinnedExamples) && section.pinnedExamples.length > 0);
  const examplesModeActive = section.visualSource === 'examples' || hasExamples;
  const candidates = [
    hasExamples ? 'examples' : null,
    preferredSource, 'uploadedSketch', 'cutaways',
    // Once the modern examples/video workflow is active, never render the
    // legacy start/end-frame artboard. It is the source of the misleading
    // Purpose + START ⇄ END captions users see after choosing an example.
    !examplesModeActive ? 'shotFrames' : null,
    'stockVideo',
    'video', 'animatedSketch', 'sketch', 'image',
  ]
    .filter(key => !(options.excludeUploadedFootage
      && (key === 'video' || key === 'uploadedSketch' || key === 'stockVideo')))
    .filter(key => !(options.excludePaperFigure && key === 'image'));
  for (const key of candidates) {
    if (!key) continue;
    rendered = VISUAL_BOX_RENDERERS[key](section);
    if (rendered) { renderedKey = key; break; }
  }

  // Distinguish AI-generated visuals from the presenter's own picked/uploaded
  // footage (see the user-vs-LLM visual language in styles-index.css). A
  // stock/uploaded clip is the presenter's choice; frames/cutaways/sketches
  // are model output.
  const LLM_VISUAL_KEYS = ['cutaways', 'shotFrames', 'examples', 'video', 'animatedSketch', 'sketch', 'image'];
  if (renderedKey && LLM_VISUAL_KEYS.includes(renderedKey)) box.classList.add('llm-generated');
  else if (renderedKey) box.classList.add('user-content');

  if (rendered) {
    box.appendChild(rendered);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'paper-section-visual-placeholder';
    placeholder.textContent = section.visual || '(suggested shots and video)';
    box.appendChild(placeholder);
  }

  return box;
}

// A generated example can be promoted to the scene's content/reference slot
// by dragging it onto "Your footage or sketches". The selected example's
// visual description becomes the editable subject description used by future
// generation requests.
function applyDraggedGeneratedReference(section, shot) {
  if (!section || !shot || !shot.url) return;
  cancelSceneGeneration(section);
  const description = (shot.visual_description || '').trim();
  if (shot.kind === 'video') {
    section.uploadedFootagePath = null;
    section.uploadedFootagePreviewUrl = shot.url;
    section.uploadedFootageThumbnailUrl = shot.thumbnail_url || shot.url;
    section.uploadedSketchPath = null;
    section.uploadedSketchPreviewUrl = null;
    section.visualSource = 'video';
    section.footageOrigin = 'generatedReference';
  } else {
    section.uploadedSketchPath = null;
    section.uploadedSketchPreviewUrl = shot.url;
    section.uploadedSketchUploadedAt = Date.now();
    section.uploadedFootagePath = null;
    section.uploadedFootagePreviewUrl = null;
    section.uploadedFootageThumbnailUrl = null;
    section.visualSource = 'uploadedSketch';
    section.footageOrigin = 'generatedReference';
  }
  if (description) section.footageSubject = description;
  section.generatedReferenceDescription = description || section.generatedReferenceDescription || '';
  saveDebugSession();
  const remaining = currentSections.filter(s => !s.removed);
  renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
}

function audioBufferToWavBlob(audioBuffer) {
  if (!audioBuffer || typeof audioBuffer.getChannelData !== 'function'
    || !(Number(audioBuffer.length) > 0) || !(Number(audioBuffer.sampleRate) > 0)) {
    throw new Error('Decoded narration audio is not a valid AudioBuffer.');
  }
  const channels = Math.min(audioBuffer.numberOfChannels || 1, 2);
  const frames = audioBuffer.length;
  const bytesPerSample = 2;
  const dataSize = frames * channels * bytesPerSample;
  const output = new ArrayBuffer(44 + dataSize);
  const view = new DataView(output);
  const writeString = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, audioBuffer.sampleRate, true);
  view.setUint32(28, audioBuffer.sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);
  const channelData = Array.from({ length: channels }, (_, index) => audioBuffer.getChannelData(index));
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channelData[channel][frame] || 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([output], { type: 'audio/wav' });
}

// Keep the visible narration player on a native <audio> element. If the
// browser rejects the original MediaRecorder container, decode the same clip
// through Web Audio and retry the visible player with a universal PCM/WAV
// object URL. The controls remain native in both cases.
function attachNativeAudioSource(audio, url, narrationClip) {
  if (!audio || !url) return;
  let fallbackStarted = false;
  let fallbackPromise = null;
  let objectUrl = null;
  audio.preload = 'auto';
  const startFallback = () => {
    if (fallbackPromise) return fallbackPromise;
    if (fallbackStarted || !narrationClip) {
      return Promise.reject(new Error('Narration fallback is unavailable.'));
    }
    fallbackStarted = true;
    fallbackPromise = ensureNarrationClipDecoded(narrationClip)
      .then(audioBufferToWavBlob)
      .then(blob => {
        const previousObjectUrl = objectUrl;
        const nextObjectUrl = URL.createObjectURL(blob);
        objectUrl = nextObjectUrl;
        audio.src = nextObjectUrl;
        audio.load();
        if (previousObjectUrl) URL.revokeObjectURL(previousObjectUrl);
        return true;
      });
    return fallbackPromise;
  };
  // Expose recovery to the linked-sequence button. Calling play() while the
  // error handler is asynchronously replacing src/load produces the browser's
  // misleading "The operation was aborted" rejection.
  try {
    Object.defineProperty(audio, '_startNarrationFallback', {
      value: startFallback, configurable: true, enumerable: false,
    });
  } catch (err) { audio._startNarrationFallback = startFallback; }
  audio.addEventListener('error', () => {
    startFallback().catch(() => { /* keep the native error state visible */ });
  });
  audio.addEventListener('emptied', () => {
    if (objectUrl && audio.src !== objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  });
  audio.src = url;
  audio.load();

  // A restored act-board recording has no in-memory blob URL. Decode it once
  // up front and use a PCM/WAV object URL when possible, which avoids browser
  // differences in persisted WebM/MP4 MediaRecorder containers. Keep the
  // original source active if the presenter starts the native controls before
  // normalization finishes; swapping an already-playing element would abort
  // that playback.
  let sourceReady = Promise.resolve();
  const restoredSource = narrationClip
    && !narrationClip._nativePreviewUrl
    && !String(url).startsWith('blob:');
  if (restoredSource) {
    sourceReady = ensureNarrationClipDecoded(narrationClip)
      .then(audioBufferToWavBlob)
      .then(blob => {
        if (!audio.paused) return false;
        const previousObjectUrl = objectUrl;
        objectUrl = URL.createObjectURL(blob);
        audio.src = objectUrl;
        audio.load();
        if (previousObjectUrl) URL.revokeObjectURL(previousObjectUrl);
        return true;
      })
      .catch(() => false);
  }
  try {
    Object.defineProperty(audio, '_narrationSourceReady', {
      value: sourceReady, configurable: true, enumerable: false,
    });
  } catch (err) { audio._narrationSourceReady = sourceReady; }
}

// The timeline transport still mixes narration through Web Audio. Keep that
// decode path independent from the visible native player above.
function narrationPreviewCandidates(clip) {
  const raw = clip && (clip._nativePreviewUrl || clip.previewUrl);
  if (!raw) return [];
  const candidates = [raw];
  // Disk previews are normally served by the same static server as the page,
  // but a deployed/forwarded page may need to fetch the identical path from
  // the API host instead. Try both before surfacing the native-player error.
  if (raw.startsWith('/') && typeof API_BASE_URL === 'string') {
    candidates.push(`${API_BASE_URL}${raw}`);
  }
  return Array.from(new Set(candidates));
}

function isDecodedNarrationAudioBuffer(value) {
  return !!value && typeof value.getChannelData === 'function'
    && Number(value.length) > 0 && Number(value.sampleRate) > 0;
}

function cacheNarrationAudioBuffer(clip, buffer) {
  // AudioBuffer is runtime-only. Keep it non-enumerable so saveDebugSession
  // never serializes a stale `{}` placeholder that later masquerades as a
  // decoded buffer after refresh.
  try {
    Object.defineProperty(clip, 'audioBuffer', {
      value: buffer, configurable: true, writable: true, enumerable: false,
    });
  } catch (err) {
    clip.audioBuffer = buffer;
  }
}

function ensureNarrationClipDecoded(clip) {
  if (isDecodedNarrationAudioBuffer(clip.audioBuffer)) return Promise.resolve(clip.audioBuffer);
  if (clip.audioBuffer) delete clip.audioBuffer;
  const candidates = narrationPreviewCandidates(clip);
  if (!candidates.length) return Promise.reject(new Error('Narration clip has no preview URL.'));
  const loadAndDecode = (index) => fetch(candidates[index]).then(response => {
    if (!response.ok) throw new Error(`Could not load narration audio (${response.status}).`);
    return response.arrayBuffer();
  }).then(bytes => ensurePlaybackAudioCtx().decodeAudioData(bytes)).catch(error => {
    if (index >= candidates.length - 1) throw error;
    return loadAndDecode(index + 1);
  });
  return loadAndDecode(0)
    .then(buffer => {
      cacheNarrationAudioBuffer(clip, buffer);
      clip.sourceDurationSeconds = buffer.duration;
      if (!(Number(clip.durationSeconds) > 0)) clip.durationSeconds = buffer.duration;
      return buffer;
    });
}

function migrateNarrationClips(section) {
  if (!Array.isArray(section.narrationClips)) section.narrationClips = [];
  if (section.narrationAudioPreviewUrl && !section.narrationClips.some(c => c.previewUrl === section.narrationAudioPreviewUrl)) {
    section.narrationClips.push({
      id: `legacy-${section.index}`,
      name: 'Narration', previewUrl: section.narrationAudioPreviewUrl,
      sourceDurationSeconds: Number(section.narrationDurationSeconds) || getSceneDuration(section),
      trimStartSeconds: 0,
      durationSeconds: Number(section.narrationDurationSeconds) || getSceneDuration(section),
      timelineOffsetSeconds: 0,
    });
  }
  return section.narrationClips;
}

function buildNarrationClipEditor(section, narrationClip) {
  // Render the native player immediately, even before Web Audio or metadata
  // has decoded a freshly uploaded clip. The metadata listener below replaces
  // this temporary duration with the file's real duration when available.
  let segment = normalizeSelectedAudioSegment(narrationClip);
  if (!segment) {
    const fallbackDuration = Math.max(
      MIN_SFX_SEGMENT_SECONDS,
      Number(section.narrationDurationSeconds) || getSceneDuration(section) || DEFAULT_SCENE_SECONDS);
    narrationClip.sourceDurationSeconds = fallbackDuration;
    narrationClip.durationSeconds = fallbackDuration;
    segment = normalizeSelectedAudioSegment(narrationClip);
  }
  if (!segment) return document.createTextNode('Loading narration…');
  const editor = document.createElement('div');
  editor.className = 'selected-sfx-summary narration-clip-editor';
  const narrationSummary = document.createElement('span');
  const clipDuration = Number(narrationClip.durationSeconds) || segment.durationSeconds;
  narrationSummary.textContent = `Narration · ${clipDuration.toFixed(1)}s selected`;
  editor.appendChild(narrationSummary);
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.addEventListener('click', event => event.stopPropagation());
  const keepPreviewInsideSelection = () => {
    const start = Number(narrationClip.trimStartSeconds) || 0;
    const end = start + (Number(narrationClip.durationSeconds) || segment.durationSeconds);
    if (audio.currentTime < start - 0.05 || audio.currentTime >= end - 0.02) audio.currentTime = start;
  };
  audio.addEventListener('play', keepPreviewInsideSelection);
  audio.addEventListener('timeupdate', () => {
    const start = Number(narrationClip.trimStartSeconds) || 0;
    const end = start + (Number(narrationClip.durationSeconds) || segment.durationSeconds);
    if (audio.currentTime >= end - 0.02) {
      audio.pause();
      audio.currentTime = start;
    }
  });
  audio.addEventListener('loadedmetadata', () => {
    if (!(Number(audio.duration) > 0)) return;
    const previousNatural = Number(narrationClip.sourceDurationSeconds) || 0;
    narrationClip.sourceDurationSeconds = audio.duration;
    if (!(Number(narrationClip.durationSeconds) > 0) ||
      narrationClip.durationSeconds >= previousNatural - 0.01) {
      narrationClip.durationSeconds = audio.duration;
    }
    segment = normalizeSelectedAudioSegment(narrationClip) || segment;
    narrationSummary.textContent = `Narration · ${Number(narrationClip.durationSeconds).toFixed(1)}s selected`;
    redraw();
  });
  editor.appendChild(audio);
  const trimEditor = document.createElement('div');
  trimEditor.className = 'sfx-segment-editor';
  trimEditor.addEventListener('click', event => event.stopPropagation());
  const readout = document.createElement('div');
  readout.className = 'sfx-segment-readout';
  trimEditor.appendChild(readout);
  const strip = document.createElement('div'); strip.className = 'sfx-source-strip';
  strip.title = 'Drag the selected window or either edge to choose the narration source';
  const selection = document.createElement('div'); selection.className = 'sfx-source-selection';
  const label = document.createElement('span'); label.className = 'sfx-source-selection-label'; selection.appendChild(label);
  const handles = ['start', 'end'].map(edge => {
    const h = document.createElement('span');
    h.className = `sfx-source-handle ${edge}`;
    h.title = edge === 'start' ? 'Drag narration in-point' : 'Drag narration out-point';
    selection.appendChild(h);
    return [h, edge];
  });
  strip.appendChild(selection); trimEditor.appendChild(strip); editor.appendChild(trimEditor);
  function redraw() {
    const start = Number(narrationClip.trimStartSeconds) || 0;
    const duration = Number(narrationClip.durationSeconds) || segment.naturalDurationSeconds;
    selection.style.left = `${start / segment.naturalDurationSeconds * 100}%`;
    selection.style.width = `${duration / segment.naturalDurationSeconds * 100}%`;
    label.textContent = `${duration.toFixed(1)}s`;
    readout.textContent = `Using ${start.toFixed(1)}s–${(start + duration).toFixed(1)}s · ${duration.toFixed(1)}s`;
  }
  const wire = (target, mode) => target.addEventListener('pointerdown', event => {
    event.preventDefault(); event.stopPropagation();
    const width = strip.getBoundingClientRect().width || 1;
    const x = event.clientX;
    const start = Number(narrationClip.trimStartSeconds) || 0;
    const duration = Number(narrationClip.durationSeconds) || segment.naturalDurationSeconds;
    const end = start + duration;
    try { target.setPointerCapture(event.pointerId); } catch (err) { /* optional */ }
    const move = e => {
      const delta = Math.round(((e.clientX - x) / width) * segment.naturalDurationSeconds * 10) / 10;
      if (mode === 'start') {
        narrationClip.trimStartSeconds = Math.max(0, Math.min(start + delta, end - MIN_SFX_SEGMENT_SECONDS));
        narrationClip.durationSeconds = end - narrationClip.trimStartSeconds;
      } else if (mode === 'end') {
        narrationClip.durationSeconds = Math.max(MIN_SFX_SEGMENT_SECONDS, Math.min(duration + delta, segment.naturalDurationSeconds - start));
      } else narrationClip.trimStartSeconds = Math.max(0, Math.min(start + delta, segment.naturalDurationSeconds - duration));
      redraw();
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      try { target.releasePointerCapture(event.pointerId); } catch (err) { /* optional */ }
      normalizeSelectedAudioSegment(narrationClip);
      saveDebugSession();
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
    };
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  });
  handles.forEach(([h, edge]) => wire(h, edge)); wire(selection, 'window'); redraw();
  // Attach only after all playback/metadata listeners are in place.
  attachNativeAudioSource(audio, narrationClip._nativePreviewUrl || narrationClip.previewUrl, narrationClip);
  const remove = document.createElement('button');
  remove.type = 'button'; remove.className = 'btn-secondary remove-narration-btn'; remove.textContent = 'Remove';
  remove.title = 'Remove narration clip';
  remove.addEventListener('click', event => {
    event.stopPropagation();
    section.narrationClips = migrateNarrationClips(section).filter(c => c.id !== narrationClip.id);
    if (section.narrationAudioPreviewUrl === narrationClip.previewUrl) {
      const replacement = section.narrationClips[section.narrationClips.length - 1];
      section.narrationAudioPreviewUrl = replacement ? replacement.previewUrl : null;
      section.narrationDurationSeconds = replacement ? replacement.durationSeconds : null;
    }
    saveDebugSession();
    renderMovieEditor(resultsEl, currentLabel, currentSections.filter(s => !s.removed), currentAssignments);
  });
  editor.appendChild(remove);
  return editor;
}

// Shared tail of both ways to attach real spoken narration audio to a
// section (see runRecordSectionNarration/runAssignDraggedNarration below) -
// saves the disk URL, decodes it for in-browser playback (see
// playAudioBuffer's own comment on why not a plain <audio src>), and
// transcribes it into section.narration, overwriting whatever an LLM
// storyboard call had put there - narration is required to come from an
// actual voice recording now, not generated text. filename must carry the
// clip's real extension (backend/ingest/transcription.py derives the audio
// format purely from it) - each caller below passes its own actual
// filename, not a hardcoded guess, since a dragged clip could be any
// format it was originally recorded/uploaded as.
function finishAssigningNarrationAudio(section, previewUrl, blob, filename, statusEl, filePath) {
  const clip = {
    id: `narration-${section.index}-${Date.now()}`,
    name: filename || 'Narration', previewUrl, filePath: filePath || null,
    trimStartSeconds: 0, timelineOffsetSeconds: 0,
  };
  // Keep a page-local Blob URL for the native player. The server URL remains
  // the persisted/exportable source; this transient URL avoids codec/container
  // quirks during the current recording session and is non-enumerable so it
  // can never overwrite saved session data.
  try {
    Object.defineProperty(clip, '_nativePreviewUrl', {
      value: URL.createObjectURL(blob), configurable: true, enumerable: false,
    });
  } catch (err) { /* object URLs are an optional playback enhancement */ }
  migrateNarrationClips(section).push(clip);
  // Legacy fields continue to point at the newest clip for old saved data and
  // older consumers; the timeline/export use narrationClips.
  section.narrationAudioPreviewUrl = previewUrl;
  delete section.narrationAudioBuffer; // stale until the decode below resolves
  saveDebugSession();

  blob.arrayBuffer()
    .then(arrayBuffer => ensurePlaybackAudioCtx().decodeAudioData(arrayBuffer))
    .then(audioBuffer => {
      cacheNarrationAudioBuffer(clip, audioBuffer);
      clip.sourceDurationSeconds = audioBuffer.duration;
      clip.durationSeconds = audioBuffer.duration;
      section.narrationDurationSeconds = audioBuffer.duration;
    })
    .catch(() => { }); // no in-browser playback for this clip - not fatal, still saved to disk

  statusEl.textContent = 'Transcribing narration ...';
  fetchTranscription(blob, filename)
    .then(({ text }) => {
      const transcript = (text || '').trim();
      // A fresh recording is the authoritative narration for this scene;
      // don't prepend an older generated draft to the new transcription.
      if (transcript) section.narration = transcript;
      statusEl.textContent = '';
    })
    .catch(err => {
      statusEl.textContent = `Saved, but transcription failed: ${err.message}`;
      statusEl.classList.add('error');
    })
    .then(() => {
      saveDebugSession();
      if (currentAssignments[section.index]) {
        const remaining = currentSections.filter(s => !s.removed);
        renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      }
    });
}

// Record Narration (and its "Re-record" state once one exists) - uploads
// the freshly recorded clip through the same /premiere/upload_media_bank_item
// bridge "Your Media"'s own recordings use, without adding it to that
// general list - this one's scoped to just this section.
function runRecordSectionNarration(section, file, statusEl) {
  statusEl.textContent = 'Uploading narration ...';
  statusEl.classList.remove('error');
  return fetchUploadMediaBankItem(file, premiereProjectId)
    .then(({ project_id, preview_url, file_path }) => {
      premiereProjectId = project_id;
      finishAssigningNarrationAudio(section, preview_url, file, file.name, statusEl, file_path);
    })
    .catch(err => {
      statusEl.textContent = err.message;
      statusEl.classList.add('error');
    });
}

// Dragging an audio clip in from "Your Media" (see renderMediaBankItems'
// draggable audio items and buildSectionBlock's drop handler below) - the
// clip's already on disk there, so this re-fetches its bytes (needed to
// transcribe it) rather than re-uploading a duplicate copy. The dropped
// blob itself carries no filename of its own (a fetch() response isn't a
// File), so the real extension is read back off previewUrl instead - it's
// whatever the clip was actually saved as, which may not be .webm (an
// uploaded file, or a Safari recording, saves as something else).
function runAssignDraggedNarration(section, mediaItem, statusEl) {
  statusEl.textContent = 'Using dropped audio ...';
  statusEl.classList.remove('error');
  const filename = mediaItem.previewUrl.split('/').pop() || 'narration.webm';
  fetch(mediaItem.previewUrl)
    .then(response => response.blob())
    .then(blob => finishAssigningNarrationAudio(section, mediaItem.previewUrl, blob, filename, statusEl, mediaItem.filePath))
    .catch(err => {
      statusEl.textContent = `Could not use that clip: ${err.message}`;
      statusEl.classList.add('error');
    });
}

// The draggables that drop into a scene's Scene Notes: documentary techniques,
// documentary modes, and Source material excerpts (see wireNotesDrop). Used to
// tell these apart from other drags (media-bank audio, section reordering) so
// only these highlight/drop into the notes.
const NOTES_DRAG_TYPES = ['application/x-technique', 'application/x-documentary-mode', 'application/x-source-material-index'];
function dataTransferHasType(dataTransfer, type) {
  return !!dataTransfer && Array.from(dataTransfer.types || []).includes(type);
}
function isNotesDrag(dataTransfer) {
  return NOTES_DRAG_TYPES.some(type => dataTransferHasType(dataTransfer, type));
}

function buildSectionBlock(section, selectable) {
  const block = document.createElement('div');
  block.className = 'paper-section-block';
  block.classList.toggle('paper-section-block-shot', !!selectable);
  block.classList.toggle('removed', selectable ? !!section.sceneRemoved : !!section.removed);
  block.classList.toggle('selected', selectedSectionIndices.has(section.index));
  block.dataset.sectionIndex = String(section.index);

  // Not draggable - reordering/reassigning between arc-part rows happens via
  // the compact chip strip instead (see buildArcRowChip/handleChipDrop);
  // dragging this much bigger two-column card felt too easy to trigger by
  // accident while editing its text or using its buttons.

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'paper-section-remove-btn';

  const title = document.createElement('div');
  title.className = 'paper-section-title';
  title.textContent = section.title;

  const body = document.createElement('div');
  body.className = 'paper-section-text';
  // Arranged storyboard cards have a separate editable composition-notes
  // field; the flat index.html paper feed must continue showing/editing the
  // extracted paper text itself.
  const bodyValue = selectable ? section.sceneNotes : section.text;
  body.textContent = bodyValue || '(add notes)';

  makeEditable(title, () => section.title, value => {
    section.title = value;
    // The arc row's compact chip strip (see buildArcRowChip) shows this
    // same title on its own separate element, built once at render time -
    // a plain state write here wouldn't reach it without this direct
    // update too (title edits happen often enough not to warrant a full
    // renderMovieEditor re-render just for this).
    const chip = document.querySelector(`.narrative-act-row-chip[data-section-index="${section.index}"]`);
    if (chip) {
      chip.textContent = value;
      chip.title = value;
    }
    saveDebugSession();
  });
  makeEditable(body, () => (selectable ? section.sceneNotes : section.text) || '(add notes)', value => {
    if (selectable) section.sceneNotes = value;
    else section.text = value;
    saveDebugSession();
  }, { multiline: true, allowEmpty: true });

  // Which visual timeline track this scene is (Primary or Cutaway).
  // Auto-inferred (see getSceneRole), overridable here;
  // changing it moves the scene's clip to the matching track on the timeline
  // (see buildNarrativeTimeline), so a full re-render follows. Only shown on
  // the arranged-view shot cards (selectable), not the flat pre-arrangement
  // feed - there's no track/timeline concept before an arrangement exists.
  const roleRow = document.createElement('div');
  roleRow.className = 'paper-section-role';
  const roleLabelEl = document.createElement('span');
  roleLabelEl.className = 'paper-section-role-label';
  roleLabelEl.textContent = 'Track';
  const roleSelect = document.createElement('select');
  roleSelect.className = 'paper-section-role-select';
  SCENE_ROLES.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r.key;
    opt.textContent = r.label;
    roleSelect.appendChild(opt);
  });
  roleSelect.value = getSceneRole(section);
  roleSelect.addEventListener('click', event => event.stopPropagation()); // don't select the card
  roleSelect.addEventListener('change', () => {
    section.role = roleSelect.value;
    saveDebugSession();
    const remaining = currentSections.filter(s => !s.removed);
    renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
  });
  roleRow.appendChild(roleLabelEl);
  roleRow.appendChild(roleSelect);
  const durationLabelEl = document.createElement('span');
  durationLabelEl.className = 'paper-section-role-label paper-section-duration-label';
  durationLabelEl.textContent = 'Seconds';
  const durationInput = document.createElement('input');
  durationInput.type = 'number';
  durationInput.className = 'paper-section-duration-input';
  durationInput.min = '0.5';
  durationInput.step = '0.5';
  durationInput.value = String(getSceneDuration(section));
  durationInput.title = 'Set this scene’s timeline duration in seconds';
  durationInput.setAttribute('aria-label', 'Scene duration in seconds');
  durationInput.addEventListener('click', event => event.stopPropagation());
  durationInput.addEventListener('change', () => {
    const seconds = Math.max(0.5, Number(durationInput.value) || DEFAULT_SCENE_SECONDS);
    section.editPlan = Object.assign(
      { transitionIn: 'hard_cut', kenBurns: { enabled: false, pan: null }, textOverlay: null },
      section.editPlan || {}, { durationSeconds: seconds });
    durationInput.value = String(seconds);
    saveDebugSession();
    const remaining = currentSections.filter(s => !s.removed);
    renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
  });
  roleRow.appendChild(durationLabelEl);
  roleRow.appendChild(durationInput);

  // Drop target for documentary techniques/modes and Source material excerpts.
  // Arranged cards use separate targets: techniques/modes go to Scene Notes,
  // while a Source material excerpt can only be dropped onto the dedicated
  // paper-section-source-material-text field. Flat index.html fields retain
  // the legacy all-purpose behavior.
  const wireNotesDrop = (dropEl, highlightEl, options) => {
    highlightEl = highlightEl || dropEl;
    options = options || {};
    const sourceOnly = !!options.sourceOnly;
    const notesOnly = !!options.notesOnly;
    const accepts = dataTransfer => {
      const hasSource = dataTransferHasType(dataTransfer, 'application/x-source-material-index');
      if (sourceOnly) return hasSource;
      if (notesOnly) return isNotesDrag(dataTransfer) && !hasSource;
      return isNotesDrag(dataTransfer);
    };
    dropEl.addEventListener('dragover', event => {
      if (!accepts(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      highlightEl.classList.add('drag-over');
    });
    dropEl.addEventListener('dragleave', event => {
      // Keep the outline while moving between the drop surface's own children;
      // only clear when the pointer actually leaves it.
      if (event.relatedTarget && dropEl.contains(event.relatedTarget)) return;
      highlightEl.classList.remove('drag-over');
    });
    dropEl.addEventListener('drop', event => {
      if (!accepts(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      highlightEl.classList.remove('drag-over');

      const technique = event.dataTransfer.getData('application/x-technique');
      const modeKey = event.dataTransfer.getData('application/x-documentary-mode');
      const sourceIndexRaw = event.dataTransfer.getData('application/x-source-material-index');

      if (sourceOnly) {
        const source = currentSections.find(s => s.index === parseInt(sourceIndexRaw, 10));
        const addition = source ? (source.text || '') : '';
        if (!addition) return;
        section.text = section.text ? `${section.text}\n\n${addition}` : addition;
        // A source excerpt can also carry the paper's extracted figure. Keep
        // that visual attached to the scene's open slot instead of copying
        // only the text and leaving the figure behind in the source library.
        const gainedFigure = !section.image && source && source.image;
        if (gainedFigure) section.image = source.image;
        const sourceField = document.querySelector(
          `.paper-section-block[data-section-index="${section.index}"] .paper-section-source-material-text`);
        if (sourceField) sourceField.textContent = section.text;
        saveDebugSession();
        if (gainedFigure) {
          const remaining = currentSections.filter(s => !s.removed);
          renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
        }
        return;
      }

      // A dropped technique applies to THIS scene's technique list. It does
      // not start an image/video request; the presenter can explicitly press
      // Generate examples or Generate video after editing the scene.
      if (technique) {
        applyTechniqueToScene(section, technique);
        return;
      }

      let addition = '';
      if (modeKey) {
        const mode = DOCUMENTARY_MODES.find(m => m.key === modeKey);
        addition = mode ? mode.label : modeKey;
      } else if (sourceIndexRaw !== '') {
        const source = currentSections.find(s => s.index === parseInt(sourceIndexRaw, 10));
        if (source) addition = source.text || '';
      }
      if (!addition) return;

      if (selectable) {
        section.sceneNotes = section.sceneNotes ? `${section.sceneNotes}\n\n${addition}` : addition;
        body.textContent = section.sceneNotes;
      } else {
        section.text = section.text ? `${section.text}\n\n${addition}` : addition;
        body.textContent = section.text;
      }
      saveDebugSession();
    });
  };

  if (selectable) {
    // Built here, appended in reading order at the bottom of this branch:
    // title -> narration -> the paper's own text (labeled "Scene Notes"
    // there) -> the visual box/footage actions (see buildVisualBox) - a
    // presenter reads what the shot's about and what to say before acting
    // on how to actually shoot/find it.
    // Uploaded footage previews in the dedicated "Your footage" slot beside
    // this box. Excluding it here preserves the generated/planned reference on
    // the left instead of showing the same uploaded video twice.
    const visualBox = buildVisualBox(section, {
      excludeUploadedFootage: true,
      // Attached paper figures are shown in the open slot at left as the
      // source visual, so do not duplicate them in the generated-preview box.
      excludePaperFigure: !!section.image,
    });

    const footageActions = document.createElement('div');
    footageActions.className = 'paper-section-footage-actions';

    // The single status line for the whole shot card - every operation
    // (find footage, sketch/animate generation, webcam/upload, narration
    // recording/assignment) writes here, and it sits at the very bottom of
    // the block (see the append order below). The find-footage-status class
    // (alongside the shared status-line styling) lets triggerFindFootageSweep
    // locate it by selector inside a re-rendered block.
    const sectionStatus = document.createElement('div');
    sectionStatus.className = 'status-line find-footage-status';

    // The scene's primary visual: a narration-driven shot - a start frame →
    // end frame + camera move designed from whatever's available (narration,
    // scene notes, scene title, the arc part, the paper abstract), inventing
    // a plausible shot if there's nothing at all (see runGenerateShot /
    // /paper/generate_shot). Never disabled - it always has *something* to go
    // on (at minimum the scene title / arc part), and even with nothing the
    // backend generates a shot rather than refusing. Clicking again redesigns.
    // const generateShotBtn = document.createElement('button');
    // generateShotBtn.type = 'button';
    // generateShotBtn.className = 'btn-secondary generate-shot-btn';
    // generateShotBtn.textContent = section.startFramePreviewUrl ? 'Re-preview shot' : 'Preview shot';
    // generateShotBtn.title = "Design this scene's shot (start frame → end frame) from its narration, notes, and title";
    // generateShotBtn.addEventListener('click', event => {
    //   event.stopPropagation();
    //   runGenerateShot(section, generateShotBtn, sectionStatus);
    // });
    // footageActions.appendChild(generateShotBtn);

    // A batch of two cheap image frames to pick from (see
    // runGenerateShotExamples). Cheaper model, more variety.
    const generateExamplesBtn = document.createElement('button');
    generateExamplesBtn.type = 'button';
    generateExamplesBtn.className = 'btn-secondary generate-shot-examples-btn';
    generateExamplesBtn.textContent = 'Generate examples';
    generateExamplesBtn.title = 'Generate two image options to pick from (cheaper model)';
    generateExamplesBtn.addEventListener('click', event => {
      event.stopPropagation();
      runGenerateShotExamples(section, generateExamplesBtn, sectionStatus);
    });
    footageActions.appendChild(generateExamplesBtn);

    // Video counterpart: same inputs, generates a short animated clip instead
    // of the stills (see runGenerateShotVideo). Slower; stills stay the default.
    const generateVideoBtn = document.createElement('button');
    generateVideoBtn.type = 'button';
    generateVideoBtn.className = 'btn-secondary generate-shot-video-btn';
    generateVideoBtn.textContent = 'Generate video';
    generateVideoBtn.title = 'Animate the chosen example image using this scene’s notes, techniques, and narrative operation (~60s)';
    generateVideoBtn.addEventListener('click', event => {
      event.stopPropagation();
      runGenerateShotVideo(section, generateVideoBtn, sectionStatus);
    });
    footageActions.appendChild(generateVideoBtn);

    // Captures video+audio via getUserMedia/MediaRecorder, then uploads the
    // recorded clip through the same /premiere/upload_footage bridge as a
    // manually-picked file (see runUploadFootage) - Premiere doesn't care
    // how the footage originated.
    const recordBtn = document.createElement('button');
    recordBtn.type = 'button';
    recordBtn.className = 'btn-secondary record-webcam-btn';
    recordBtn.textContent = 'Record webcam';
    let activeStream = null;
    let activeRecorder = null;
    recordBtn.addEventListener('click', async event => {
      event.stopPropagation();
      if (activeRecorder && activeRecorder.state === 'recording') {
        activeRecorder.stop();
        return;
      }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      } catch (err) {
        sectionStatus.textContent = `Could not access webcam: ${err.message}`;
        sectionStatus.classList.add('error');
        return;
      }
      activeStream = stream;
      visualBox.innerHTML = '';
      const livePreview = document.createElement('video');
      livePreview.className = 'paper-section-visual-media';
      livePreview.autoplay = true;
      livePreview.muted = true;
      livePreview.srcObject = stream;
      visualBox.appendChild(livePreview);

      const chunks = [];
      activeRecorder = new MediaRecorder(stream);
      // The actual container/codec MediaRecorder settled on - NOT
      // necessarily webm (e.g. Safari's MediaRecorder produces
      // video/mp4). Hardcoding 'video/webm' here regardless would label
      // the file with the wrong extension - served back and played
      // through a plain <video src> (see buildVisualBox), a browser
      // trying to decode the wrong container just fails silently (no
      // playback, no error shown) - same lesson as runTranscribeIntent's
      // own intentMimeType, just for video instead of audio.
      const webcamMimeType = activeRecorder.mimeType || 'video/webm';
      activeRecorder.addEventListener('dataavailable', dataEvent => {
        if (dataEvent.data.size > 0) chunks.push(dataEvent.data);
      });
      activeRecorder.addEventListener('stop', () => {
        activeStream.getTracks().forEach(track => track.stop());
        const extensionMatch = /video\/([a-z0-9]+)/i.exec(webcamMimeType);
        const extension = extensionMatch ? extensionMatch[1] : 'webm';
        const blob = new Blob(chunks, { type: webcamMimeType });
        const file = new File([blob], `webcam-section-${section.index}-${Date.now()}.${extension}`, { type: webcamMimeType });
        recordBtn.textContent = 'Record webcam';
        runUploadFootage(section, file, sectionStatus, recordBtn);
      });
      activeRecorder.start();
      recordBtn.textContent = 'Stop Recording';
      sectionStatus.textContent = 'Recording - click again to stop.';
      sectionStatus.classList.remove('error');
    });
    footageActions.appendChild(recordBtn);

    const mediaResults = document.createElement('div');
    mediaResults.className = 'paper-section-media';
    const sfxBlock = document.createElement('div');
    sfxBlock.className = 'paper-section-sfx-block';
    const sfxLabel = document.createElement('div');
    sfxLabel.className = 'paper-section-text-label';
    sfxLabel.textContent = 'Sound effects';
    sfxBlock.appendChild(sfxLabel);
    const sfxActions = document.createElement('div');
    sfxActions.className = 'paper-section-sfx-actions';
    sfxBlock.appendChild(sfxActions);
    const sfxResults = document.createElement('div');
    sfxResults.className = 'paper-section-media paper-section-sfx-results';

    // Always available. If the scene doesn't yet have LLM-suggested search
    // phrases (video_query/audio_query), runFindFootage derives them from the
    // scene's title/notes/narration on the fly (see ensureFootageQueries).
    const findFootageBtn = document.createElement('button');
    findFootageBtn.type = 'button';
    findFootageBtn.className = 'btn-secondary find-footage-btn';
    findFootageBtn.textContent = 'Find footage';
    const footageSearchGroup = document.createElement('div');
    footageSearchGroup.className = 'media-query-action-group footage-search-group';
    const videoQueryInput = document.createElement('input');
    videoQueryInput.type = 'text';
    videoQueryInput.className = 'media-query-input footage-query-input';
    videoQueryInput.placeholder = 'Video search query';
    videoQueryInput.value = section.videoQuery || '';
    videoQueryInput.title = 'Edit the suggested video search query';
    videoQueryInput.addEventListener('click', event => event.stopPropagation());
    videoQueryInput.addEventListener('keydown', event => event.stopPropagation());
    videoQueryInput.addEventListener('input', () => {
      section.videoQuery = videoQueryInput.value.trim();
      saveDebugSession();
    });
    findFootageBtn.addEventListener('click', event => {
      event.stopPropagation();
      runFindFootage(section, mediaResults, sectionStatus, findFootageBtn, videoQueryInput, audioQueryInput);
    });
    footageSearchGroup.appendChild(videoQueryInput);
    footageSearchGroup.appendChild(findFootageBtn);
    footageActions.appendChild(footageSearchGroup);

    // A presenter-supplied sound takes priority over search results and is
    // stored as the scene's selected SFX immediately after upload. Keep this
    // picker beside (and to the left of) Find Sound so the two choices are
    // equally discoverable.
    const uploadSfxInput = document.createElement('input');
    uploadSfxInput.type = 'file';
    uploadSfxInput.accept = 'audio/*,.mp3,.wav,.m4a,.aac,.ogg,.oga,.flac,.webm';
    uploadSfxInput.className = 'paper-section-sfx-input';
    uploadSfxInput.title = 'Upload your own sound effect';
    uploadSfxInput.addEventListener('click', event => event.stopPropagation());

    const uploadSfxBtn = document.createElement('button');
    uploadSfxBtn.type = 'button';
    uploadSfxBtn.className = 'btn-secondary upload-sfx-btn';
    uploadSfxBtn.textContent = 'Upload sound';
    uploadSfxBtn.title = 'Use your own audio file as this scene’s sound effect';
    uploadSfxBtn.addEventListener('click', event => {
      event.stopPropagation();
      if (uploadSfxInput.disabled) return;
      uploadSfxInput.value = '';
      uploadSfxInput.click();
    });
    uploadSfxInput.addEventListener('change', () => {
      const file = uploadSfxInput.files && uploadSfxInput.files[0];
      if (file) runUploadSoundEffect(section, file, sectionStatus, uploadSfxInput);
    });
    sfxActions.appendChild(uploadSfxBtn);
    sfxActions.appendChild(uploadSfxInput);

    const sfxSearchGroup = document.createElement('div');
    sfxSearchGroup.className = 'media-query-action-group sfx-search-group';
    const audioQueryInput = document.createElement('input');
    audioQueryInput.type = 'text';
    audioQueryInput.className = 'media-query-input sfx-query-input';
    audioQueryInput.placeholder = 'Sound search query';
    audioQueryInput.value = section.audioQuery || '';
    audioQueryInput.title = 'Edit the suggested sound search query';
    audioQueryInput.addEventListener('click', event => event.stopPropagation());
    audioQueryInput.addEventListener('keydown', event => event.stopPropagation());
    audioQueryInput.addEventListener('input', () => {
      section.audioQuery = audioQueryInput.value.trim();
      saveDebugSession();
    });
    const suggestSfxBtn = document.createElement('button');
    suggestSfxBtn.type = 'button';
    suggestSfxBtn.className = 'btn-secondary suggest-sfx-btn';
    suggestSfxBtn.textContent = 'Find Sound';
    suggestSfxBtn.addEventListener('click', event => {
      event.stopPropagation();
      runSuggestSoundEffects(section, sfxResults, sectionStatus, suggestSfxBtn, audioQueryInput, videoQueryInput);
    });
    sfxSearchGroup.appendChild(audioQueryInput);
    sfxSearchGroup.appendChild(suggestSfxBtn);
    sfxActions.appendChild(sfxSearchGroup);

    if (section.selectedAudio) {
      const segment = normalizeSelectedAudioSegment(section.selectedAudio);
      const selectedSfx = document.createElement('div');
      selectedSfx.className = 'selected-sfx-summary';
      const selectedSfxText = document.createElement('span');
      const selectedDuration = segment ? segment.durationSeconds : 0;
      selectedSfxText.textContent = `SFX: ${section.selectedAudio.name || 'Selected sound'}${selectedDuration > 0 ? ` · ${selectedDuration.toFixed(1)}s selected` : ''}`;
      selectedSfx.appendChild(selectedSfxText);
      const preview = document.createElement('audio');
      preview.controls = true;
      preview.preload = 'metadata';
      preview.src = section.selectedAudio.localPreviewUrl || section.selectedAudio.preview_url;
      preview.addEventListener('click', event => event.stopPropagation());
      if (segment) {
        const keepPreviewInsideSelection = () => {
          const start = section.selectedAudio.trimStartSeconds;
          const end = start + section.selectedAudio.durationSeconds;
          if (preview.currentTime < start - 0.05 || preview.currentTime >= end - 0.02) preview.currentTime = start;
        };
        preview.addEventListener('play', keepPreviewInsideSelection);
        preview.addEventListener('timeupdate', () => {
          const end = section.selectedAudio.trimStartSeconds + section.selectedAudio.durationSeconds;
          if (preview.currentTime >= end - 0.02) {
            preview.pause();
            preview.currentTime = section.selectedAudio.trimStartSeconds;
          }
        });
      }
      selectedSfx.appendChild(preview);

      if (segment) {
        const editor = document.createElement('div');
        editor.className = 'sfx-segment-editor';
        editor.addEventListener('click', event => event.stopPropagation());

        const selectionReadout = document.createElement('div');
        selectionReadout.className = 'sfx-segment-readout';
        const refreshSelectionReadout = () => {
          const start = section.selectedAudio.trimStartSeconds;
          const duration = section.selectedAudio.durationSeconds;
          selectionReadout.textContent = `Using ${start.toFixed(1)}s–${(start + duration).toFixed(1)}s · ${duration.toFixed(1)}s`;
          selectedSfxText.textContent = `SFX: ${section.selectedAudio.name || 'Selected sound'} · ${duration.toFixed(1)}s selected`;
        };
        editor.appendChild(selectionReadout);

        const sourceStrip = document.createElement('div');
        sourceStrip.className = 'sfx-source-strip';
        sourceStrip.title = 'Drag the selected window or either edge to choose the source sound';
        const sourceSelection = document.createElement('div');
        sourceSelection.className = 'sfx-source-selection';
        const selectionLabel = document.createElement('span');
        selectionLabel.className = 'sfx-source-selection-label';
        sourceSelection.appendChild(selectionLabel);
        const sourceInHandle = document.createElement('span');
        sourceInHandle.className = 'sfx-source-handle start';
        sourceInHandle.title = 'Drag source in-point';
        sourceSelection.appendChild(sourceInHandle);
        const sourceOutHandle = document.createElement('span');
        sourceOutHandle.className = 'sfx-source-handle end';
        sourceOutHandle.title = 'Drag source out-point';
        sourceSelection.appendChild(sourceOutHandle);
        sourceStrip.appendChild(sourceSelection);
        editor.appendChild(sourceStrip);

        const redrawSourceSelection = () => {
          const start = section.selectedAudio.trimStartSeconds;
          const duration = section.selectedAudio.durationSeconds;
          sourceSelection.style.left = `${(start / segment.naturalDurationSeconds) * 100}%`;
          sourceSelection.style.width = `${(duration / segment.naturalDurationSeconds) * 100}%`;
          selectionLabel.textContent = `${duration.toFixed(1)}s`;
          refreshSelectionReadout();
        };
        const wireSourceWindowDrag = (target, mode) => {
          target.addEventListener('pointerdown', pointerEvent => {
            pointerEvent.preventDefault();
            pointerEvent.stopPropagation();
            const stripWidth = sourceStrip.getBoundingClientRect().width || 1;
            const startX = pointerEvent.clientX;
            const initialStart = section.selectedAudio.trimStartSeconds;
            const initialDuration = section.selectedAudio.durationSeconds;
            const initialEnd = initialStart + initialDuration;
            try { target.setPointerCapture(pointerEvent.pointerId); } catch (err) { /* optional */ }
            const onMove = moveEvent => {
              const delta = Math.round(
                ((moveEvent.clientX - startX) / stripWidth) * segment.naturalDurationSeconds * 10) / 10;
              if (mode === 'start') {
                const nextStart = Math.max(0, Math.min(
                  initialStart + delta, initialEnd - MIN_SFX_SEGMENT_SECONDS));
                section.selectedAudio.trimStartSeconds = nextStart;
                section.selectedAudio.durationSeconds = initialEnd - nextStart;
              } else if (mode === 'end') {
                section.selectedAudio.durationSeconds = Math.max(MIN_SFX_SEGMENT_SECONDS, Math.min(
                  initialDuration + delta, segment.naturalDurationSeconds - initialStart));
              } else {
                section.selectedAudio.trimStartSeconds = Math.max(0, Math.min(
                  initialStart + delta, segment.naturalDurationSeconds - initialDuration));
              }
              try { preview.currentTime = section.selectedAudio.trimStartSeconds; } catch (err) { /* metadata not ready */ }
              redrawSourceSelection();
            };
            const onUp = () => {
              target.removeEventListener('pointermove', onMove);
              target.removeEventListener('pointerup', onUp);
              try { target.releasePointerCapture(pointerEvent.pointerId); } catch (err) { /* optional */ }
              normalizeSelectedAudioSegment(section.selectedAudio);
              saveDebugSession();
              const remaining = currentSections.filter(s => !s.removed);
              renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
            };
            target.addEventListener('pointermove', onMove);
            target.addEventListener('pointerup', onUp);
          });
        };
        wireSourceWindowDrag(sourceInHandle, 'start');
        wireSourceWindowDrag(sourceOutHandle, 'end');
        wireSourceWindowDrag(sourceSelection, 'window');
        redrawSourceSelection();
        refreshSelectionReadout();
        selectedSfx.appendChild(editor);
      }
      const removeSfxBtn = document.createElement('button');
      removeSfxBtn.type = 'button';
      removeSfxBtn.className = 'btn-secondary remove-sfx-btn';
      removeSfxBtn.textContent = 'Remove';
      removeSfxBtn.addEventListener('click', event => {
        event.stopPropagation();
        delete section.selectedAudio;
        saveDebugSession();
        const remaining = currentSections.filter(s => !s.removed);
        renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      });
      selectedSfx.appendChild(removeSfxBtn);
      sfxResults.appendChild(selectedSfx);
    }
    sfxBlock.appendChild(sfxResults);

    // Hidden picker opened by the large "Your footage" slot below. This input
    // had previously been commented out while the slot's click handler still
    // tried to find it, leaving that control as a silent no-op.
    const uploadFootageInput = document.createElement('input');
    uploadFootageInput.type = 'file';
    uploadFootageInput.accept = '.mp4,video/mp4,video/quicktime,video/webm,image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';
    uploadFootageInput.className = 'paper-section-footage-input';
    uploadFootageInput.title = 'Upload video footage or an image sketch for this scene';
    uploadFootageInput.addEventListener('click', event => event.stopPropagation());
    uploadFootageInput.addEventListener('change', () => {
      const file = uploadFootageInput.files && uploadFootageInput.files[0];
      if (!file) return;
      const looksLikeImage = (file.type && file.type.startsWith('image/'))
        || /\.(png|jpe?g|webp)$/i.test(file.name || '');
      if (looksLikeImage) {
        runUploadSketch(section, file, sectionStatus, uploadFootageInput);
      } else {
        runUploadFootage(section, file, sectionStatus, uploadFootageInput);
      }
    });
    footageActions.appendChild(uploadFootageInput);
    const openFootagePicker = () => {
      if (uploadFootageInput.disabled) return;
      // Reset first so choosing the same MP4 again after a failed upload still
      // emits a change event.
      uploadFootageInput.value = '';
      uploadFootageInput.click();
    };


    // Underneath the visual box: narration + audio.
    const narrationAudio = document.createElement('div');
    narrationAudio.className = 'paper-section-narration-audio';

    const narrationSuggestionLine = document.createElement('div');
    narrationSuggestionLine.className = 'paper-section-narration suggested-narration llm-generated';
    const narrationTranscriptLine = document.createElement('div');
    narrationTranscriptLine.className = 'paper-section-narration recorded-narration-transcript';
    // An accepted arc's draft is authoritative: it is the exact text shown in
    // .arc-suggestion-part-narration. Keep the ordinary per-scene field as a
    // fallback for scenes drafted later from their own Suggest narration
    // button.
    const suggestedNarration = (
      section.arcSuggestedNarration
      || acceptedArcNarrationForSection(section)
      || section.narrationSuggestion
      || ''
    ).trim();
    if (suggestedNarration) {
      const suggestedLabel = document.createElement('strong');
      suggestedLabel.textContent = 'Suggested narration:';
      narrationSuggestionLine.appendChild(suggestedLabel);
      narrationSuggestionLine.appendChild(document.createTextNode(` ${suggestedNarration}`));
    }
    if (section.narration) narrationTranscriptLine.textContent = section.narration;
    const narrationClips = migrateNarrationClips(section);

    // --- The section's actual spoken narration audio - required to come
    // from a human voice, not generated text: either recorded directly
    // here, or dragged in from an already-recorded/uploaded clip in
    // storyboard.html's "Your Media" module (see renderMediaBankItems'
    // draggable audio items, and the drop handlers on narrationAudio
    // itself, just below). Either way it's transcribed into
    // the narration text below and played from the native audio element in
    // each narration clip editor.
    // Distinct from section.selectedAudio further down - that's
    // stock/found ambience from Find Footage, not the presenter's voice.
    //
    const narrationAudioControls = document.createElement('div');
    narrationAudioControls.className = 'paper-section-narration-audio-controls';

    // Draft a voice-over from the attached paper section and the act this
    // scene belongs to. Keep the draft separate from section.narration so a
    // later microphone recording remains the authoritative transcript.
    const suggestNarrationBtn = document.createElement('button');
    suggestNarrationBtn.type = 'button';
    suggestNarrationBtn.className = 'btn-secondary suggest-narration-btn';
    suggestNarrationBtn.textContent = suggestedNarration ? 'Suggest again' : 'Suggest narration';
    suggestNarrationBtn.title = 'Draft a short voice-over from this paper section and its narrative act';
    suggestNarrationBtn.addEventListener('click', event => {
      event.stopPropagation();
      suggestNarrationBtn.disabled = true;
      sectionStatus.textContent = 'Drafting narration from this section and act...';
      sectionStatus.classList.remove('error');
      const act = currentArcSections.find(a => a.key === currentAssignments[section.index]);
      fetchSuggestNarration({
        sectionTitle: section.title,
        sectionText: section.text,
        actTitle: act ? act.label : '',
        actDescription: act ? act.description : '',
        abstract: findAbstractText(),
        documentaryMode: selectedDocumentaryMode,
      })
        .then(({ narration }) => {
          // A manual re-suggestion intentionally replaces the arc draft for
          // this scene; future renders should show the new text, not the old
          // arc-authoritative copy.
          section.arcSuggestedNarration = null;
          section.narrationSuggestion = (narration || '').trim();
          saveDebugSession();
          const remaining = currentSections.filter(s => !s.removed);
          renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
        })
        .catch(err => {
          sectionStatus.textContent = err.message;
          sectionStatus.classList.add('error');
          suggestNarrationBtn.disabled = false;
      });
    });

    const uploadNarrationBtn = document.createElement('button');
    uploadNarrationBtn.type = 'button';
    uploadNarrationBtn.className = 'btn-secondary upload-narration-btn';
    uploadNarrationBtn.textContent = 'Upload narration';
    uploadNarrationBtn.title = 'Upload an audio file to transcribe as this scene’s narration';
    const uploadNarrationInput = document.createElement('input');
    uploadNarrationInput.type = 'file';
    uploadNarrationInput.accept = 'audio/*,.wav,.mp3,.m4a,.mp4,.webm,.ogg,.aac,.flac';
    uploadNarrationInput.className = 'paper-section-narration-upload-input';
    uploadNarrationInput.hidden = true;
    uploadNarrationInput.addEventListener('click', event => event.stopPropagation());
    uploadNarrationBtn.addEventListener('click', event => {
      event.stopPropagation();
      uploadNarrationInput.value = '';
      uploadNarrationInput.click();
    });
    uploadNarrationInput.addEventListener('change', () => {
      const file = uploadNarrationInput.files?.[0];
      if (!file) return;
      const looksLikeAudio = (file.type && file.type.startsWith('audio/'))
        || /\.(wav|mp3|m4a|mp4|webm|ogg|aac|flac)$/i.test(file.name || '');
      if (!looksLikeAudio) {
        sectionStatus.textContent = 'Choose an audio narration file.';
        sectionStatus.classList.add('error');
        return;
      }
      uploadNarrationBtn.disabled = true;
      recordNarrationBtn.disabled = true;
      sectionStatus.textContent = 'Uploading narration ...';
      sectionStatus.classList.remove('error');
      runRecordSectionNarration(section, file, sectionStatus)
        .finally(() => {
        uploadNarrationBtn.disabled = false;
        recordNarrationBtn.disabled = false;
        });
    });
    narrationAudioControls.append(uploadNarrationBtn, uploadNarrationInput);

    const recordNarrationBtn = document.createElement('button');
    recordNarrationBtn.type = 'button';
    recordNarrationBtn.className = 'btn-secondary';
    const recordNarrationRestingLabel = narrationClips.length ? 'Record another narration' : 'Record narration';
    recordNarrationBtn.textContent = recordNarrationRestingLabel;
    let narrationRecordStream = null;
    let narrationRecorder = null;
    recordNarrationBtn.addEventListener('click', async event => {
      event.stopPropagation();
      if (narrationRecorder && narrationRecorder.state === 'recording') {
        narrationRecorder.stop();
        return;
      }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        sectionStatus.textContent = `Could not access microphone: ${err.message}`;
        sectionStatus.classList.add('error');
        return;
      }
      narrationRecordStream = stream;
      const chunks = [];
      narrationRecorder = new MediaRecorder(stream);
      const mimeType = narrationRecorder.mimeType || 'audio/webm';
      narrationRecorder.addEventListener('dataavailable', dataEvent => {
        if (dataEvent.data.size > 0) chunks.push(dataEvent.data);
      });
      narrationRecorder.addEventListener('stop', () => {
        narrationRecordStream.getTracks().forEach(track => track.stop());
        recordNarrationBtn.textContent = recordNarrationRestingLabel;
        const extensionMatch = /audio\/([a-z0-9]+)/i.exec(mimeType);
        const extension = extensionMatch ? extensionMatch[1] : 'webm';
        const blob = new Blob(chunks, { type: mimeType });
        const file = new File([blob], `narration-section-${section.index}-${Date.now()}.${extension}`, { type: mimeType });
        runRecordSectionNarration(section, file, sectionStatus);
      });
      narrationRecorder.start();
      recordNarrationBtn.textContent = 'Stop Recording';
      sectionStatus.textContent = 'Recording - click again to stop.';
      sectionStatus.classList.remove('error');
    });
    narrationAudioControls.appendChild(recordNarrationBtn);

    // Keep the suggested draft independent from recorded transcripts: it
    // stays above the controls while each fresh transcript is shown below
    // those controls and immediately above its clip editor.
    if (suggestedNarration) narrationAudio.appendChild(narrationSuggestionLine);
    narrationAudio.appendChild(suggestNarrationBtn);
    narrationAudio.appendChild(narrationAudioControls);
    if (section.narration) narrationAudio.appendChild(narrationTranscriptLine);
    narrationClips.forEach(clip => {
      narrationAudio.appendChild(buildNarrationClipEditor(section, clip));
    });

    // Drop target for dragging an audio clip in from "Your Media" (see
    // renderMediaBankItems) - a quicker alternative to recording fresh
    // when a clip that already fits exists there. stopPropagation on all
    // three so this doesn't also bubble up into .narrative-act-row's own
    // drop handler (handleChipDrop, for reordering/reassigning sections
    // between arc rows) - that one only ever expects a section-index drag,
    // not a media-bank one, so it'd just no-op, but there's no reason for
    // both handlers (and both drag-over highlights) to fire at once.
    narrationAudio.addEventListener('dragover', event => {
      // Only a media-bank audio clip can drop onto narration - a technique/
      // mode/source drag gets no outline here (it belongs in Scene Notes).
      if (!event.dataTransfer.types.includes('application/x-media-bank-index')) return;
      event.preventDefault();
      event.stopPropagation();
      narrationAudio.classList.add('drag-over');
    });
    narrationAudio.addEventListener('dragleave', event => {
      event.stopPropagation();
      narrationAudio.classList.remove('drag-over');
    });
    narrationAudio.addEventListener('drop', event => {
      event.preventDefault();
      event.stopPropagation();
      narrationAudio.classList.remove('drag-over');
      const indexRaw = event.dataTransfer.getData('application/x-media-bank-index');
      if (indexRaw === '') return;
      const item = mediaBankItems[parseInt(indexRaw, 10)];
      if (!item) return;
      if (item.kind !== 'audio') {
        sectionStatus.textContent = 'Only audio clips can be used as narration.';
        sectionStatus.classList.add('error');
        return;
      }
      runAssignDraggedNarration(section, item, sectionStatus);
    });

    // Stock/found ambience (see Find Footage above) - not the presenter's
    // own voice, so kept separate from the narration controls above.
    // if (section.selectedAudio) {
    //   const player = document.createElement('audio');
    //   player.controls = true;
    //   player.src = section.selectedAudio.preview_url;
    //   player.addEventListener('click', event => event.stopPropagation());
    //   narrationAudio.appendChild(player);
    // } else {
    //   const audioPlaceholder = document.createElement('div');
    //   audioPlaceholder.className = 'paper-section-audio-placeholder';
    //   audioPlaceholder.textContent = '(no ambience selected - use Find Footage above)';
    //   narrationAudio.appendChild(audioPlaceholder);
    // }

    // if (section.editPlan) {
    //   const plan = section.editPlan;
    //   const kenBurns = plan.kenBurns && plan.kenBurns.enabled ? `Ken Burns (${plan.kenBurns.pan})` : 'none';
    //   appendStoryboardLine(narrationAudio, 'Edit', `${plan.transitionIn}, ~${plan.durationSeconds}s, ${kenBurns}`);
    //   if (plan.textOverlay) appendStoryboardLine(narrationAudio, 'Overlay', plan.textOverlay);
    // }

    // Reading order: title, narration, then the visual-production unit. The
    // attached paper text is placed inside that unit below the visual row as
    // Source Material, keeping the visual reference and its grounding text
    // together.
    block.classList.add(`role-${getSceneRole(section)}`);
    block.appendChild(removeBtn);

    // Title on the left, the Track (role) picker pinned to the far right -
    // just left of the absolutely-positioned delete button in the corner
    // (the card's 44px right padding keeps this row clear of it). See
    // .paper-section-title-row.
    const titleRow = document.createElement('div');
    titleRow.className = 'paper-section-title-row';
    titleRow.appendChild(title);
    titleRow.appendChild(roleRow);
    block.appendChild(titleRow);

    // The "Narration" label + the narration/audio, wrapped as one unit that
    // gently wiggles (.needs-narration) until a narration is recorded - a
    // nudge to record the documentary's voiceover for this scene.
    const narrationBlock = document.createElement('div');
    narrationBlock.className = 'paper-section-narration-block';
    if (!narrationClips.length) narrationBlock.classList.add('needs-narration');
    const narrationLabel = document.createElement('div');
    narrationLabel.className = 'paper-section-text-label';
    narrationLabel.textContent = 'Your narration';
    narrationBlock.appendChild(narrationLabel);
    narrationBlock.appendChild(narrationAudio);
    block.appendChild(narrationBlock);

    // Scene direction, picture preview, and footage controls form one visual-
    // production unit. Keeping these three blocks under a shared parent also
    // gives layout changes a stable hook without affecting narration/SFX.
    const visualProductionBlock = document.createElement('div');
    visualProductionBlock.className = 'paper-section-visual-production-block';
    const footageNotesLabel = document.createElement('div');
    footageNotesLabel.className = 'paper-section-text-label';
    footageNotesLabel.textContent = 'Your footage';
    visualProductionBlock.appendChild(footageNotesLabel);

    block.appendChild(visualProductionBlock);

    const notesBlock = document.createElement('div');
    notesBlock.className = 'paper-section-notes-block';
    const sceneNotesLabel = document.createElement('div');
    sceneNotesLabel.className = 'paper-section-text-label';
    sceneNotesLabel.textContent = 'Scene composition & camera techniques';
    notesBlock.appendChild(sceneNotesLabel);
    notesBlock.appendChild(body);
    // The per-scene technique chips (dragged onto this scene) live right under
    // the notes now, each removable - see buildSceneTechniquesRow.
    const techRow = buildSceneTechniquesRow(section);
    if (techRow) notesBlock.appendChild(techRow);
    visualProductionBlock.appendChild(notesBlock);

    // Scene Notes accepts only technique/mode drags. Source excerpts have a
    // separate target below the visual row; the narration block remains a
    // dead zone for these drags (only media-bank audio can land there).
    wireNotesDrop(notesBlock, notesBlock, { notesOnly: true });
    // The whole paper-section block is also a valid technique target. Nested
    // media/source drop zones stop propagation, so the timeline is not needed
    // as a second technique target.
    wireNotesDrop(block, block, { notesOnly: true });
    narrationBlock.addEventListener('dragover', event => {
      if (!isNotesDrag(event.dataTransfer)) return; // let audio drags reach narrationAudio
      event.stopPropagation();                       // don't bubble to the block's notes-drop
      notesBlock.classList.remove('drag-over');       // and don't leave the notes highlighted
    });

    if (section.entities && section.entities.length) {
      const entitiesLine = document.createElement('div');
      entitiesLine.className = 'paper-section-storyboard';
      appendStoryboardLine(entitiesLine, 'Entities', section.entities.map(e => e.name).join(', '));
      block.appendChild(entitiesLine);
    }

    // The generated visual sits beside an "open slot" that invites the
    // presenter to go capture / upload their OWN footage for this scene (real
    // footage always beats a generated stand-in) - clicking it opens the same
    // footage file picker the footage actions use.
    const visualRow = document.createElement('div');
    visualRow.className = 'paper-section-visual-row';

    const openSlot = document.createElement('div');
    openSlot.className = 'paper-section-open-slot';
    // Generated example cards are draggable references. Accept only that
    // payload here, so ordinary scene/timeline drags do not turn the upload
    // slot into a generic drop target.
    openSlot.addEventListener('dragover', event => {
      if (!dataTransferHasType(event.dataTransfer, 'application/x-generated-shot')) return;
      event.preventDefault();
      event.stopPropagation();
      openSlot.classList.add('generated-reference-drag-over');
    });
    openSlot.addEventListener('dragleave', event => {
      if (event.relatedTarget && openSlot.contains(event.relatedTarget)) return;
      openSlot.classList.remove('generated-reference-drag-over');
    });
    openSlot.addEventListener('drop', event => {
      if (!dataTransferHasType(event.dataTransfer, 'application/x-generated-shot')) return;
      event.preventDefault();
      event.stopPropagation();
      openSlot.classList.remove('generated-reference-drag-over');
      try {
        const shot = JSON.parse(event.dataTransfer.getData('application/x-generated-shot'));
        applyDraggedGeneratedReference(section, shot);
      } catch (err) {
        // Ignore malformed external drag payloads.
      }
    });
    if (section.uploadedFootagePreviewUrl || section.uploadedSketchPreviewUrl || section.image) {
      openSlot.classList.add('has-footage');
      const openSlotOverlay = document.createElement('div');
      openSlotOverlay.className = 'open-slot-overlay';
      const ownFootageLabel = document.createElement('div');
      ownFootageLabel.className = 'open-slot-footage-label';
      ownFootageLabel.textContent = section.uploadedFootagePreviewUrl
        ? (section.footageOrigin === 'foundFootage' ? 'Found footage' : 'Your footage')
        : section.uploadedSketchPreviewUrl ? 'Your sketch' : 'Paper figure';
      openSlotOverlay.appendChild(ownFootageLabel);
      if (section.uploadedFootagePreviewUrl) {
        const ownFootageVideo = document.createElement('video');
        ownFootageVideo.className = 'paper-section-open-slot-video';
        ownFootageVideo.src = section.uploadedFootagePreviewUrl;
        configureUploadedFootagePreview(ownFootageVideo, section);
        ownFootageVideo.controls = true;
        ownFootageVideo.addEventListener('click', event => event.stopPropagation());
        openSlot.appendChild(ownFootageVideo);
      } else if (section.uploadedSketchPreviewUrl) {
        const ownSketchImage = document.createElement('img');
        ownSketchImage.className = 'paper-section-open-slot-image';
        ownSketchImage.src = section.uploadedSketchPreviewUrl;
        ownSketchImage.alt = 'Uploaded scene sketch';
        openSlot.appendChild(ownSketchImage);
      } else {
        const figureImage = document.createElement('img');
        figureImage.className = 'paper-section-open-slot-image paper-section-paper-figure';
        figureImage.src = section.image;
        figureImage.alt = `${section.title || 'Attached paper'} figure`;
        openSlot.appendChild(figureImage);
      }
      // Let the presenter explicitly identify the uploaded subject. The
      // server's footage analysis is only a starting guess; this field is the
      // authoritative content anchor sent with future example/video prompts.
      const subjectEditor = document.createElement('div');
      subjectEditor.className = 'open-slot-subject-editor';
      const subjectLabel = document.createElement('label');
      subjectLabel.className = 'open-slot-subject-label';
      subjectLabel.textContent = 'What does this footage/sketch show?';
      subjectEditor.appendChild(subjectLabel);
      const subjectInput = document.createElement('textarea');
      subjectInput.className = 'open-slot-subject-input';
      subjectInput.rows = 2;
      subjectInput.maxLength = 500;
      subjectInput.placeholder = 'e.g. A red boat crossing a foggy harbor';
      subjectInput.value = section.footageSubject || '';
      subjectInput.title = 'Describe the subject/content so generated shots stay anchored to your upload';
      subjectInput.addEventListener('click', event => event.stopPropagation());
      subjectInput.addEventListener('keydown', event => event.stopPropagation());
      subjectInput.addEventListener('input', () => {
        section.footageSubject = subjectInput.value.trim();
        saveDebugSession();
      });
      subjectEditor.appendChild(subjectInput);
      const subjectHint = document.createElement('div');
      subjectHint.className = 'open-slot-subject-hint';
      subjectHint.textContent = 'Used as the content reference for generated examples and video. Click Preview examples after editing.';
      subjectEditor.appendChild(subjectHint);
      openSlotOverlay.appendChild(subjectEditor);
      const replaceFootageBtn = document.createElement('button');
      replaceFootageBtn.type = 'button';
      replaceFootageBtn.className = 'btn-secondary replace-footage-btn';
      replaceFootageBtn.textContent = 'Upload';
      replaceFootageBtn.addEventListener('click', event => {
        event.stopPropagation();
        openFootagePicker();
      });
      openSlotOverlay.appendChild(replaceFootageBtn);
      openSlot.appendChild(openSlotOverlay);
      openSlot.title = 'Preview or replace your footage or sketch for this scene';
    } else {
      const slotIcon = document.createElement('div');
      slotIcon.className = 'open-slot-icon';
      slotIcon.textContent = '🎥';
      const slotText = document.createElement('div');
      slotText.className = 'open-slot-text';
      slotText.textContent = 'Your footage or sketch — go capture and upload your own for this scene';
      openSlot.appendChild(slotIcon);
      openSlot.appendChild(slotText);
      openSlot.title = 'Upload your own footage or sketch for this scene';
      openSlot.setAttribute('role', 'button');
      openSlot.tabIndex = 0;
      openSlot.addEventListener('click', event => {
        event.stopPropagation();
        openFootagePicker();
      });
      openSlot.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        openFootagePicker();
      });
    }
    // The user's reference stays on the left; generated examples/visuals are
    // shown on the right in the adjacent visual box.
    visualRow.appendChild(openSlot);
    visualRow.appendChild(visualBox);
    visualProductionBlock.appendChild(visualRow);

    // Keep the attached paper passage below the visual row, where it acts as
    // source material for the footage/sketch choices rather than competing
    // with the scene-direction controls above.
    const sourceMaterialBlock = document.createElement('div');
    sourceMaterialBlock.className = 'paper-section-source-material-block';
    const sourceMaterialLabel = document.createElement('div');
    sourceMaterialLabel.className = 'paper-section-text-label';
    sourceMaterialLabel.textContent = 'Source Material';
    sourceMaterialBlock.appendChild(sourceMaterialLabel);
    const sourceMaterialBody = document.createElement('div');
    sourceMaterialBody.className = 'paper-section-text paper-section-source-material-text';
    sourceMaterialBody.textContent = section.text || '(no attached paper text)';
    makeEditable(sourceMaterialBody, () => section.text || '(no attached paper text)', value => {
      section.text = value;
      saveDebugSession();
    }, { multiline: true, allowEmpty: true });
    wireNotesDrop(sourceMaterialBody, sourceMaterialBody, { sourceOnly: true });
    sourceMaterialBlock.appendChild(sourceMaterialBody);
    visualProductionBlock.appendChild(sourceMaterialBlock);

    // Keep shot-generation/search actions attached to the visual itself, at
    // its bottom edge, so the controls stay with the examples/video preview.
    visualBox.appendChild(footageActions);
    visualProductionBlock.appendChild(mediaResults);
    block.appendChild(sfxBlock);
    // The status line sits at the very bottom of the block, under all the
    // rest of the content (visual box, footage actions, media results),
    // rather than wedged between the actions and their results.
    block.appendChild(sectionStatus);
  } else {
    // Pre-arrangement flat feed - just the source material, no shot
    // production details yet (there's no act/shot concept before an
    // arrangement exists).
    block.appendChild(removeBtn);
    block.appendChild(title);
    if (section.image) {
      const image = document.createElement('img');
      image.className = 'paper-section-image';
      image.src = section.image;
      image.alt = section.title;
      block.appendChild(image);
    }
    wireNotesDrop(body); // flat feed: the field itself is the drop target
    block.appendChild(body);
  }

  function updateRemoveBtn() {
    const isRemoved = selectable ? !!section.sceneRemoved : !!section.removed;
    removeBtn.textContent = isRemoved ? '↺' : '×';
    removeBtn.title = isRemoved ? 'Restore this section' : 'Exclude this section';
  }
  updateRemoveBtn();

  removeBtn.addEventListener('click', event => {
    event.stopPropagation();
    if (selectable) {
      section.sceneRemoved = !section.sceneRemoved;
      // Arranged view: a deleted scene leaves the timeline and its arc row
      // entirely (renderMovieEditor is only ever fed non-removed sections)
      // and shows up in the "Deleted scenes" sidebar module, restorable
      // there (see renderDeletedScenesList) - rather than lingering in place
      // dimmed, which is the flat feed's behavior below.
      saveDebugSession();
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
    } else {
      section.removed = !section.removed;
      block.classList.toggle('removed', section.removed);
      updateRemoveBtn();
    }
    updateComposeStoryboardVisibility();
  });

  // Clicking the card (anywhere that isn't the remove button or an
  // editable field, all of which already stopPropagation their own clicks)
  // selects it, honoring shift-click for multi-select - see
  // handleSectionClick. Only wired in the arranged view - renderSectionFeed's
  // pre-arrangement flat feed passes selectable=false, since selection only
  // matters for generating a storyboard/edit plan, which needs an act.
  if (selectable) {
    block.addEventListener('click', event => handleSectionClick(section.index, event));
  }

  return block;
}

// A thin, low-opacity-until-hovered "+ Add Section" link sitting in the gap
// between two adjacent section cards (see renderSectionFeed) - clicking it
// inserts a new section right after `afterIndex`, same as the trailing
// "+ Add Section" button below the whole feed, just anywhere in the list
// instead of only at the end.
function buildInsertSectionDivider(afterIndex) {
  const divider = document.createElement('button');
  divider.type = 'button';
  divider.className = 'insert-section-divider';
  divider.textContent = '+ Add Section';
  divider.title = 'Insert a new section here';
  divider.addEventListener('click', () => {
    // A section added from the paper feed is source material, not a storyboard
    // scene, so keep it visible on index.html and out of the narrativeOnly
    // scaffold set.
    insertSection(afterIndex, 'New Section', '', null, false);
    renderSectionFeed(resultsEl, currentLabel, currentSections);
    updateComposeStoryboardVisibility();
    saveDebugSession();
  });
  return divider;
}

function renderSectionFeed(container, label, sections) {
  container.innerHTML = '';

  // The paper's own source material only - never the narrativeOnly scaffold
  // scenes added while arranging/storyboarding on storyboard.html. Those ride
  // along in the shared saved session but are not source material and must not
  // swell this feed.
  const sourceSections = sections.filter(section => !section.narrativeOnly);

  const title = document.createElement('h2');
  title.textContent = 'Source material';
  container.appendChild(title);

  const header = document.createElement('div');
  header.className = 'paper-source-label';
  header.textContent = `${sourceSections.length} section${sourceSections.length === 1 ? '' : 's'} extracted. You can edit section headers and content, click a section to exclude, and add new sections. These
  serve as source material for you to base scenes and narration on in the documentary.`;
  container.appendChild(header);

  const feed = document.createElement('div');
  feed.className = 'paper-sections-feed';
  // A subtle "+ Add Section" divider between each pair of adjacent
  // sections (not just at the very end, below) - inserts right after the
  // section above it, so a new section can land anywhere in the list, not
  // only appended last.
  sourceSections.forEach((section, i) => {
    feed.appendChild(buildSectionBlock(section));
    if (i < sourceSections.length - 1) feed.appendChild(buildInsertSectionDivider(section.index));
  });
  container.appendChild(feed);
}

// helper functions in helpers.js (isPdfFile, readTextFile,
// fetchPaperExtraction, fetchSuggestArcs) loaded before this.

// --- PDF: real structural parse, not a heuristic - handled server-side by
// Docling (backend/paper_extraction.py's /paper/extract route). See
// fetchPaperExtraction in helpers.js.

// --- Plain text / Markdown: Docling only handles PDFs, so these still use a
// client-side heuristic: headings come from literal "#" Markdown syntax, a
// common academic section name (Abstract, Introduction, ...), or a numbered
// heading pattern ("1. Introduction", "3.2 Analysis").

const KNOWN_SECTION_NAMES = new Set([
  'abstract', 'introduction', 'related work', 'related works', 'background',
  'method', 'methods', 'methodology', 'materials and methods', 'approach',
  'model', 'experiments', 'experimental setup', 'experimental results',
  'results', 'results and discussion', 'evaluation', 'discussion',
  'conclusion', 'conclusions', 'limitations', 'future work',
  'acknowledgments', 'acknowledgements', 'references', 'appendix',
]);

function normalizeHeadingCandidate(text) {
  return text.replace(/^(\d+(\.\d+)*\.?|[ivxlc]+\.)\s*/i, '').trim();
}

function matchesHeadingPattern(text) {
  if (!text || text.length > 100) return false;
  const stripped = normalizeHeadingCandidate(text);
  if (KNOWN_SECTION_NAMES.has(stripped.toLowerCase())) return true;
  return /^\d+(\.\d+)*\.?\s+[A-Z]/.test(text) && text.length < 90;
}

const PREAMBLE_TITLE = 'Title / Preamble';

function buildSections(lines, isHeadingFn) {
  const sections = [];
  let current = { title: PREAMBLE_TITLE, text: '' };
  lines.forEach(line => {
    if (isHeadingFn(line)) {
      const heading = line.text.trim();
      let newTitle;
      if (current.text.trim()) {
        sections.push(current);
        newTitle = heading;
      } else if (current.title !== PREAMBLE_TITLE) {
        // current was itself an empty heading (an "umbrella" with no body
        // text of its own) - carry it forward as a prefix instead of
        // discarding it, same as backend/paper_extraction.py.
        newTitle = `${current.title}: ${heading}`;
      } else {
        newTitle = heading;
      }
      current = { title: newTitle, text: '' };
    } else if (line.text.trim()) {
      current.text += (current.text ? ' ' : '') + line.text.trim();
    }
  });
  if (current.text.trim()) sections.push(current);
  return sections;
}

function extractPlainTextSections(label, text) {
  const rawLines = text.split(/\r?\n/);
  const lines = [];
  rawLines.forEach(raw => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const mdHeading = /^#{1,6}\s+(.*)/.exec(trimmed);
    lines.push(mdHeading ? { text: mdHeading[1].trim(), fontSize: 0, forceHeading: true } : { text: trimmed, fontSize: 0 });
  });
  const sections = buildSections(lines, line => line.forceHeading || matchesHeadingPattern(line.text));
  return { label, sections };
}

function runExtraction() {
  const file = fileInput.files[0];
  if (!file) {
    setStatus('Please choose a PDF file.', true);
    return;
  }

  extractBtn.disabled = true;
  setStatus(isPdfFile(file)
    ? 'Extracting sections...'
    : 'Reading and extracting sections...');

  const task = isPdfFile(file) // check if it's a PDF file
    ? fetchPaperExtraction(file).then(result => ({ label: file.name, sections: result.sections }))
    : readTextFile(file).then(({ label, text }) => extractPlainTextSections(label, text)); // if not do the text/markdown process

  task
    .then(({ label, sections }) => {
      // A new paper gets its own durable source snapshot; later edits to this
      // paper continue updating that file rather than overwriting a previous
      // extraction with the same browser session.
      rotatePaperSnapshotId();
      currentLabel = label;
      currentSections = sections.map((section, index) => ({
        index,
        title: section.title,
        text: section.text,
        image: section.image || null,
        removed: false,
      }));

      // restart everything - a new extraction invalidates any arc/
      // storyboard/edit-plan/export work built on the previous paper.
      // storyboard.html's own DOM (edit-plan/premiere-export panels,
      // narrative/preview status lines, ...) isn't reachable from here -
      // it's a separate page (see html/storyboard.html) that starts fresh
      // from this now-cleared state next time it loads, so there's
      // nothing to reset on it directly.
      currentAssignments = {};
      currentArcSections = [];
      selectedSectionIndices = new Set();
      selectedNarrationArc = null;
      storyboardBarStatus = { message: '', isError: false };
      editPlanBarStatus = { message: '', isError: false };
      overallEditNotes = '';
      premiereProjectId = null;

      renderSectionFeed(resultsEl, currentLabel, currentSections);
      updateComposeStoryboardVisibility();
      setStatus(`Done. Extracted ${sections.length} section${sections.length === 1 ? '' : 's'} from "${label}".`);
      extractBtn.disabled = false;
      // A deliberate new extraction always resumes saving, even if the
      // session had been cleared earlier without a reload in between.
      debugSessionCleared = false;
      saveDebugSession();
    })
    .catch(err => {
      setStatus(err.message, true);
      extractBtn.disabled = false;
    });
}
//#endregion

//#region --- ARC SUGGESTION
// The paper's own extracted abstract, if it has one - paper_extraction.py
// has no dedicated abstract field (see its own docstring on why), it's
// just a heading like any other, so this is a title match over the
// already-extracted sections rather than a separate lookup. Sent alongside
// whatever the filmmaker said (see fetchSuggestArcs) to ground the arc/
// documentary-mode suggestion in the paper's own framing of its
// contribution too, not just the spoken narration/focus chips.
function findAbstractText() {
  const abstractSection = currentSections.find(s => /\babstract\b/i.test(s.title || ''));
  return abstractSection ? abstractSection.text : '';
}

// The paper's real sections (index + title) sent with an arc-suggestion
// request so each suggested arc can map them into its parts - the preview and
// auto-placement on accept (see renderArcSuggestion/runAcceptArc). Excludes
// excluded (removed) sections and narrativeOnly scaffold/placeholder scenes,
// which aren't real paper content.
function paperSectionsForArc() {
  return currentSections
    .filter(s => !s.removed && !s.narrativeOnly)
    // A short body snippet (not the full text) gives the distillation real
    // placement signal beyond the (often generic) title, while keeping the
    // whole-paper prompt lean - see distill_from_moodboard's listing. The
    // arc-only /paper/suggest_arcs route ignores the extra field.
    .map(s => ({ index: s.index, title: s.title, snippet: (s.text || '').trim().slice(0, 280) }));
}

function runSuggestArcs() {
  // suggestArcsBtn.disabled = true;
  suggestArcsStatusEl.textContent = 'Suggesting narrative arcs ...';
  suggestArcsStatusEl.classList.remove('error');
  arcSuggestionPanelEl.style.display = 'none';

  fetchSuggestArcs(Array.from(selectedFocusStatements), findAbstractText(), paperSectionsForArc())
    .then(({ recommended, alternatives }) => {
      suggestArcsStatusEl.textContent = '';
      // suggestArcsBtn.disabled = false;
      renderArcSuggestionWithNarration(recommended, alternatives, selectedDocumentaryMode);
    })
    .catch(err => {
      suggestArcsStatusEl.textContent = err.message;
      suggestArcsStatusEl.classList.add('error');
      // suggestArcsBtn.disabled = false;
    });
}

// suggestArcsBtn only exists on storyboard.html - guarded so this is a
// no-op on index.html (which loads the same shared script).
// if (suggestArcsBtn) suggestArcsBtn.addEventListener('click', runSuggestArcs);

// --- Moodboard entry point (index.html): add references, poll their
// background analysis, and (on storyboard.html) distill them into a
// suggested arc + mode + techniques. Replaces the old narration recorder.

function addMoodboardReference({ kind, name, url, file }) {
  // Optimistic placeholder card shown immediately; the fetch fills in its
  // ref_id, then polling flips it to ready/error.
  const entry = {
    refId: null,
    sourceKind: kind,
    title: name || (file ? file.name : (url || 'Reference')),
    sourceUrl: url || '',
    note: '',
    state: 'analyzing',
    profile: null,
    thumbnailUrl: null,
  };
  moodboardReferences.push(entry);
  renderMoodboardList();
  refreshMoodboardStatusLine();

  fetchAddMoodboardReference({ kind, name, url, file, note: '', projectId: premiereProjectId })
    .then(({ project_id, ref_id }) => {
      premiereProjectId = project_id;
      entry.refId = ref_id;
      saveDebugSession();
      pollMoodboardReference(ref_id);
    })
    .catch(err => {
      entry.state = 'error';
      entry.errorMessage = err.message;
      renderMoodboardList();
      refreshMoodboardStatusLine();
    });
}

function pollMoodboardReference(refId) {
  if (!premiereProjectId) return;
  fetchMoodboardReferenceStatus(premiereProjectId, refId)
    .then(status => {
      const entry = moodboardReferences.find(r => r.refId === refId);
      if (!entry) return;  // removed while a poll was in flight
      if (status.state === 'ready') {
        entry.state = 'ready';
        entry.profile = status.profile || null;
        if (entry.profile) {
          entry.title = entry.profile.title || entry.title;
          entry.thumbnailUrl = entry.profile.thumbnail_url || null;
          if (!entry.note) entry.note = entry.profile.note || '';
        }
        renderMoodboardList();
        refreshMoodboardStatusLine();
        saveDebugSession();
        updateComposeStoryboardVisibility();
        refreshSuggestionsFromMoodboard();  // storyboard: re-distill once analyzed
      } else if (status.state === 'error' || status.state === 'unknown') {
        entry.state = 'error';
        entry.errorMessage = status.message || 'Analysis failed.';
        renderMoodboardList();
        refreshMoodboardStatusLine();
        saveDebugSession();
      } else {
        entry.stepMessage = status.message || '';
        renderMoodboardList();
        setTimeout(() => pollMoodboardReference(refId), 2500);
      }
    })
    .catch(() => {
      // Transient network blip - keep polling a little slower.
      setTimeout(() => pollMoodboardReference(refId), 4000);
    });
}

function refreshMoodboardStatusLine() {
  if (!moodboardStatusEl) return;
  const analyzing = moodboardReferences.filter(r => r.state === 'analyzing').length;
  const ready = moodboardReferences.filter(r => r.state === 'ready').length;
  moodboardStatusEl.classList.remove('error');
  if (analyzing > 0) {
    moodboardStatusEl.textContent = `Analyzing ${analyzing} reference${analyzing === 1 ? '' : 's'} … you can keep adding more or upload your paper.`;
  } else if (ready > 0) {
    moodboardStatusEl.textContent = `${ready} reference${ready === 1 ? '' : 's'} analyzed.`;
  } else {
    moodboardStatusEl.textContent = '';
  }
}

// Cards mark the reference itself as .user-content (the presenter's own pick)
// and the analysis-derived style summary as .llm-generated, so the two are
// visually distinct (see styles-index.css).
// The analysis-derived style summary for a reference profile (the same LLM
// output shown on index.html's cards and storyboard.html's recap). Built from
// DOM nodes so tone/pacing/mode and the "Techniques:" label can be bold.
// Carries the .llm-generated treatment.
function buildMoodboardStyleSummary(profile) {
  const style = document.createElement('div');
  style.className = 'moodboard-card-style llm-generated';
  const sep = () => { if (style.childNodes.length) style.appendChild(document.createTextNode(' — ')); };
  const bold = text => { const b = document.createElement('strong'); b.textContent = text; return b; };

  if (profile.visual_style) style.appendChild(document.createTextNode(profile.visual_style));

  const modeLabel = (DOCUMENTARY_MODES.find(m => m.key === profile.suggested_mode) || {}).label
    || profile.suggested_mode || '';
  const metaParts = [profile.tone, profile.pacing, modeLabel].filter(Boolean);
  if (metaParts.length) {
    sep();
    metaParts.forEach((val, i) => {
      if (i) style.appendChild(document.createTextNode(' · '));
      style.appendChild(bold(val));
    });
  }

  const techs = profile.observed_techniques || [];
  if (techs.length) {
    sep();
    style.appendChild(bold('Techniques:'));
    style.appendChild(document.createTextNode(' ' + techs.join(', ')));
  }

  if (!style.childNodes.length) style.textContent = 'Analyzed (no distinct style cues detected).';
  return style;
}

// The horizontal strip of frames sampled from a clip (null when there are none,
// e.g. a named reference).
function buildMoodboardFramesStrip(profile) {
  const frameUrls = profile.frame_urls || [];
  if (!frameUrls.length) return null;
  const strip = document.createElement('div');
  strip.className = 'moodboard-card-frames';
  frameUrls.forEach(url => {
    const fimg = document.createElement('img');
    fimg.className = 'moodboard-frame';
    fimg.src = url;
    fimg.alt = 'sampled frame';
    fimg.loading = 'lazy';
    strip.appendChild(fimg);
  });
  return strip;
}

// storyboard.html's read-only "Moodboard" recap module (#moodboard-summary-module)
// - shows the analyzed references carried over from index.html (thumbnail,
// title, source badge, style summary, sampled frames, and any note), without
// the add/remove/poll controls. Hides itself when there's nothing analyzed.
function renderMoodboardSummaryList() {
  if (!moodboardSummaryListEl) return;
  const refs = moodboardReferences.filter(r => r.profile);
  if (moodboardSummaryModuleEl) moodboardSummaryModuleEl.style.display = refs.length ? '' : 'none';
  moodboardSummaryListEl.innerHTML = '';

  refs.forEach(ref => {
    const card = document.createElement('div');
    card.className = 'moodboard-card user-content';

    const thumb = document.createElement('div');
    thumb.className = 'moodboard-card-thumb';
    if (ref.thumbnailUrl) {
      const img = document.createElement('img');
      img.src = ref.thumbnailUrl;
      img.alt = ref.title || 'reference';
      thumb.appendChild(img);
    } else {
      thumb.classList.add('moodboard-card-thumb--placeholder');
      thumb.textContent = ref.sourceKind === 'named' ? '🎬' : (ref.sourceKind === 'youtube' ? '▶' : '🎞');
    }
    card.appendChild(thumb);

    const body = document.createElement('div');
    body.className = 'moodboard-card-body';

    const titleRow = document.createElement('div');
    titleRow.className = 'moodboard-card-title-row';
    const title = document.createElement('span');
    title.className = 'moodboard-card-title';
    title.textContent = ref.title || 'Reference';
    titleRow.appendChild(title);
    const badge = document.createElement('span');
    badge.className = 'moodboard-source-badge';
    badge.textContent = ref.sourceKind === 'named' ? 'Named' : (ref.sourceKind === 'youtube' ? 'YouTube' : 'Upload');
    titleRow.appendChild(badge);
    body.appendChild(titleRow);

    body.appendChild(buildMoodboardStyleSummary(ref.profile));
    const strip = buildMoodboardFramesStrip(ref.profile);
    if (strip) body.appendChild(strip);
    if (ref.note) {
      const noteEl = document.createElement('div');
      noteEl.className = 'moodboard-card-note-static';
      noteEl.textContent = `Note: ${ref.note}`;
      body.appendChild(noteEl);
    }

    card.appendChild(body);
    moodboardSummaryListEl.appendChild(card);
  });
}

function renderMoodboardList() {
  if (!moodboardListEl) return;
  // On storyboard.html the moodboard lives in #moodboard-summary-module and is
  // always shown (so references can be edited any time), unlike index.html.
  if (moodboardSummaryModuleEl) moodboardSummaryModuleEl.style.display = '';
  moodboardListEl.innerHTML = '';
  moodboardReferences.forEach(ref => {
    const card = document.createElement('div');
    card.className = 'moodboard-card user-content';
    card.dataset.state = ref.state;

    const thumb = document.createElement('div');
    thumb.className = 'moodboard-card-thumb';
    if (ref.thumbnailUrl) {
      const img = document.createElement('img');
      img.src = ref.thumbnailUrl;
      img.alt = ref.title || 'reference';
      thumb.appendChild(img);
    } else {
      thumb.classList.add('moodboard-card-thumb--placeholder');
      thumb.textContent = ref.sourceKind === 'named' ? '🎬' : (ref.sourceKind === 'youtube' ? '▶' : '🎞');
    }
    card.appendChild(thumb);

    const body = document.createElement('div');
    body.className = 'moodboard-card-body';

    const titleRow = document.createElement('div');
    titleRow.className = 'moodboard-card-title-row';
    const title = document.createElement('span');
    title.className = 'moodboard-card-title';
    title.textContent = ref.title || 'Reference';
    titleRow.appendChild(title);
    const badge = document.createElement('span');
    badge.className = 'moodboard-source-badge';
    badge.textContent = ref.sourceKind === 'named' ? 'Named' : (ref.sourceKind === 'youtube' ? 'YouTube' : 'Upload');
    titleRow.appendChild(badge);
    const pill = document.createElement('span');
    pill.className = `moodboard-status-pill moodboard-status-pill--${ref.state}`;
    pill.textContent = ref.state === 'ready' ? 'Analyzed' : (ref.state === 'error' ? 'Failed' : 'Analyzing…');
    titleRow.appendChild(pill);
    body.appendChild(titleRow);

    if (ref.state === 'ready' && ref.profile) {
      body.appendChild(buildMoodboardStyleSummary(ref.profile));
      const strip = buildMoodboardFramesStrip(ref.profile);
      if (strip) body.appendChild(strip);
    } else if (ref.state === 'error') {
      const errEl = document.createElement('div');
      errEl.className = 'moodboard-card-error';
      errEl.textContent = ref.errorMessage || 'Analysis failed.';
      body.appendChild(errEl);
    }

    const noteInput = document.createElement('input');
    noteInput.type = 'text';
    noteInput.className = 'moodboard-card-note';
    noteInput.placeholder = 'Add a note (what you like about it)…';
    noteInput.value = ref.note || '';
    noteInput.addEventListener('change', () => {
      ref.note = noteInput.value;
      if (ref.profile) ref.profile.note = noteInput.value;
      saveDebugSession();
    });
    body.appendChild(noteInput);

    card.appendChild(body);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'moodboard-card-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Remove this reference';
    removeBtn.addEventListener('click', () => {
      moodboardReferences = moodboardReferences.filter(r => r !== ref);
      renderMoodboardList();
      refreshMoodboardStatusLine();
      saveDebugSession();
      updateComposeStoryboardVisibility();
      refreshSuggestionsFromMoodboard();  // storyboard: re-distill after removal
    });
    card.appendChild(removeBtn);

    moodboardListEl.appendChild(card);
  });
}

// index.html add-controls (guarded - null on storyboard.html).
if (moodboardAddNameBtn && moodboardNameInput) {
  const addName = () => {
    const name = (moodboardNameInput.value || '').trim();
    if (!name) return;
    addMoodboardReference({ kind: 'named', name });
    moodboardNameInput.value = '';
  };
  moodboardAddNameBtn.addEventListener('click', addName);
  moodboardNameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addName(); } });
}
if (moodboardAddUrlBtn && moodboardUrlInput) {
  const addUrl = () => {
    const url = (moodboardUrlInput.value || '').trim();
    if (!url) return;
    addMoodboardReference({ kind: 'youtube', url });
    moodboardUrlInput.value = '';
  };
  moodboardAddUrlBtn.addEventListener('click', addUrl);
  moodboardUrlInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addUrl(); } });
}
if (moodboardFileInput) {
  moodboardFileInput.addEventListener('change', () => {
    const file = moodboardFileInput.files && moodboardFileInput.files[0];
    if (!file) return;
    addMoodboardReference({ kind: 'upload', file });
    moodboardFileInput.value = '';
  });
}

// --- 3D reconstruction entry point (index.html): upload a photo/panorama/clip,
// poll its background reconstruction, then explore it in an INLINE three.js
// viewer (js/reconstruct-viewer.js). Mirrors the moodboard add/poll flow.

function addReconstruct({ file, kindHint, engine }) {
  const item = {
    reconId: null,
    name: file ? file.name : 'Reconstruction',
    kindHint: kindHint || 'auto',
    engine: engine || 'sharp',
    state: 'reconstructing',
    stepMessage: '',
    profile: null,
    expanded: false,
    teardown: null,
  };
  reconstructItems.push(item);
  renderReconstructList();
  refreshReconstructStatusLine();

  fetchAddReconstruct({ file, kind: kindHint, engine, projectId: premiereProjectId })
    .then(({ project_id, recon_id }) => {
      premiereProjectId = project_id;
      item.reconId = recon_id;
      saveDebugSession();
      pollReconstruct(recon_id);
    })
    .catch(err => {
      item.state = 'error';
      item.errorMessage = err.message;
      renderReconstructList();
      refreshReconstructStatusLine();
    });
}

function pollReconstruct(reconId) {
  if (!premiereProjectId) return;
  fetchReconstructStatus(premiereProjectId, reconId)
    .then(status => {
      const item = reconstructItems.find(r => r.reconId === reconId);
      if (!item) return;  // removed while a poll was in flight
      if (status.state === 'ready') {
        item.state = 'ready';
        item.profile = status.profile || null;
        renderReconstructList();
        refreshReconstructStatusLine();
        saveDebugSession();
      } else if (status.state === 'error' || status.state === 'unknown') {
        item.state = 'error';
        item.errorMessage = status.message || 'Reconstruction failed.';
        renderReconstructList();
        refreshReconstructStatusLine();
        saveDebugSession();
      } else {
        item.stepMessage = status.message || '';
        renderReconstructList();
        setTimeout(() => pollReconstruct(reconId), 2500);
      }
    })
    .catch(() => {
      setTimeout(() => pollReconstruct(reconId), 4000);
    });
}

function refreshReconstructStatusLine() {
  if (!reconstructStatusEl) return;
  const working = reconstructItems.filter(r => r.state === 'reconstructing').length;
  const ready = reconstructItems.filter(r => r.state === 'ready').length;
  reconstructStatusEl.classList.remove('error');
  if (working > 0) {
    reconstructStatusEl.textContent = `Reconstructing ${working} item${working === 1 ? '' : 's'} …`;
  } else if (ready > 0) {
    reconstructStatusEl.textContent = `${ready} scene${ready === 1 ? '' : 's'} ready — click "View in 3D".`;
  } else {
    reconstructStatusEl.textContent = '';
  }
}

const RECONSTRUCT_MODE_LABEL = {
  'splat': '3D Gaussian splats',
  'depth-displace': '2.5D depth',
  'pano': '360° panorama',
  'flat': 'flat (no depth)',
};

// Collapse any other expanded viewer first (tears down its WebGL context) so at
// most one is live at a time.
function collapseReconstruct(except) {
  reconstructItems.forEach(other => {
    if (other !== except && other.expanded) {
      other.expanded = false;
      if (other.teardown) { try { other.teardown(); } catch (e) { } other.teardown = null; }
    }
  });
}

function renderReconstructList() {
  if (!reconstructListEl) return;
  // The list is rebuilt wholesale, so any live viewer's canvas is about to be
  // detached - tear each down (expanded items are re-created in the loop below)
  // to avoid orphaned WebGL contexts.
  reconstructItems.forEach(it => {
    if (it.teardown) { try { it.teardown(); } catch (e) { } it.teardown = null; }
  });
  reconstructListEl.innerHTML = '';
  reconstructItems.forEach(item => {
    const card = document.createElement('div');
    card.className = 'moodboard-card user-content reconstruct-card';
    card.dataset.state = item.state;

    const thumb = document.createElement('div');
    thumb.className = 'moodboard-card-thumb';
    if (item.profile && item.profile.color_url) {
      const img = document.createElement('img');
      img.src = item.profile.color_url;
      img.alt = item.name;
      thumb.appendChild(img);
    } else {
      thumb.classList.add('moodboard-card-thumb--placeholder');
      thumb.textContent = '🧊';
    }
    card.appendChild(thumb);

    const body = document.createElement('div');
    body.className = 'moodboard-card-body';

    const titleRow = document.createElement('div');
    titleRow.className = 'moodboard-card-title-row';
    const title = document.createElement('span');
    title.className = 'moodboard-card-title';
    title.textContent = item.name;
    titleRow.appendChild(title);
    if (item.profile) {
      const badge = document.createElement('span');
      badge.className = 'moodboard-source-badge';
      badge.textContent = RECONSTRUCT_MODE_LABEL[item.profile.viewer_mode] || item.profile.viewer_mode;
      titleRow.appendChild(badge);
    }
    const pill = document.createElement('span');
    pill.className = `moodboard-status-pill moodboard-status-pill--${item.state === 'reconstructing' ? 'analyzing' : item.state}`;
    pill.textContent = item.state === 'ready' ? 'Ready' : (item.state === 'error' ? 'Failed' : 'Reconstructing…');
    titleRow.appendChild(pill);
    body.appendChild(titleRow);

    if (item.state === 'ready' && item.profile) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'btn-secondary reconstruct-view-toggle';
      toggle.textContent = item.expanded ? 'Hide 3D ▲' : 'View in 3D ▼';
      const host = document.createElement('div');
      host.className = 'reconstruct-viewer-host';
      host.style.display = item.expanded ? '' : 'none';
      toggle.addEventListener('click', () => {
        item.expanded = !item.expanded;
        if (item.expanded) {
          collapseReconstruct(item);
          host.style.display = '';
          toggle.textContent = 'Hide 3D ▲';
          item.teardown = openReconstructViewer(item.profile, host);
        } else {
          host.style.display = 'none';
          toggle.textContent = 'View in 3D ▼';
          if (item.teardown) { try { item.teardown(); } catch (e) { } item.teardown = null; }
        }
      });
      body.appendChild(toggle);
      body.appendChild(host);
      if (item.expanded) item.teardown = openReconstructViewer(item.profile, host);
    } else if (item.state === 'error') {
      const errEl = document.createElement('div');
      errEl.className = 'moodboard-card-error';
      errEl.textContent = item.errorMessage || 'Reconstruction failed.';
      body.appendChild(errEl);
    } else {
      const stepEl = document.createElement('div');
      stepEl.className = 'moodboard-card-style';
      stepEl.textContent = item.stepMessage || 'Reconstructing …';
      body.appendChild(stepEl);
    }

    card.appendChild(body);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'moodboard-card-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Remove this reconstruction';
    removeBtn.addEventListener('click', () => {
      if (item.teardown) { try { item.teardown(); } catch (e) { } item.teardown = null; }
      reconstructItems = reconstructItems.filter(r => r !== item);
      renderReconstructList();
      refreshReconstructStatusLine();
      saveDebugSession();
    });
    card.appendChild(removeBtn);

    reconstructListEl.appendChild(card);
  });
}

if (reconstructFileInput) {
  reconstructFileInput.addEventListener('change', () => {
    const file = reconstructFileInput.files && reconstructFileInput.files[0];
    if (!file) return;
    const checked = document.querySelector('input[name="reconstruct-kind"]:checked');
    const engineChecked = document.querySelector('input[name="reconstruct-engine"]:checked');
    addReconstruct({
      file,
      kindHint: checked ? checked.value : 'auto',
      engine: engineChecked ? engineChecked.value : 'sharp',
    });
    reconstructFileInput.value = '';
  });
}

// A plain-text summary of the ready references, used as the documentary_goal
// fallback the rest of the pipeline reads (the shot/storyboard/edit-plan
// generation all read recordedTranscript when there's no intent textarea) -
// keeps those flows working now that there's no spoken narration.
// The analyzed moodboard profiles (compact) passed into shot generation to
// anchor the frames' visual style (see fetchGenerateShot / shot_plan_llm's
// _format_moodboard). Only the style-relevant fields.
function moodboardProfilesForGeneration() {
  return moodboardReferences
    .filter(r => r.state === 'ready' && r.profile)
    .map(r => ({
      title: r.profile.title,
      visual_style: r.profile.visual_style,
      tone: r.profile.tone,
      pacing: r.profile.pacing,
      observed_techniques: r.profile.observed_techniques,
    }));
}

function buildMoodboardGoalSummary() {
  return moodboardReferences
    .filter(r => r.state === 'ready' && r.profile)
    .map(r => [r.profile.title, r.profile.visual_style, r.profile.tone, r.note].filter(Boolean).join(' — '))
    .join(' | ');
}

// Use exactly the same inputs as the narration batch that runs after
// "Apply this arc" (see runAcceptArc/autoSuggestNarrationForStoryboard), but
// draft against an arc part before there is a scene object to attach it to.
// Each part's mapped paper sections become the new scene's attached source
// material, just as they do on accept.
function suggestNarrationForArcPart(part, documentaryMode) {
  const sourceByIndex = new Map(currentSections.map(section => [section.index, section]));
  const sectionText = (part.section_indices || [])
    .map(index => sourceByIndex.get(index))
    .filter(section => section && !section.removed && !section.narrativeOnly)
    .map(section => section.text)
    .filter(Boolean)
    .join('\n\n');
  return fetchSuggestNarration({
    sectionTitle: 'New Scene',
    sectionText,
    actTitle: part.name || part.label || '',
    actDescription: part.description || '',
    abstract: findAbstractText(),
    documentaryMode,
  }).then(({ narration }) => {
    part.suggested_narration = (narration || '').trim();
  });
}

// Render an arc immediately with a per-part loading state, then replace those
// states with the generated drafts as they arrive. Only the visible/current arc
// is drafted up front; an alternative is drafted when the presenter selects it
// so the distillation step does not make a large burst of unnecessary calls.
function renderArcSuggestionWithNarration(current, others, documentaryMode) {
  const generation = ++arcNarrationGeneration;
  const arcs = [current].filter(Boolean);
  arcs.forEach(arc => (arc.sections || []).forEach(part => {
    arcNarrationFailedParts.delete(part);
    if ((part.suggested_narration || '').trim()) {
      arcNarrationPendingParts.delete(part);
    } else {
      arcNarrationPendingParts.add(part);
    }
  }));
  renderArcSuggestion(current, others);

  const jobs = arcs.flatMap(arc => (arc.sections || []).map(part => {
    if ((part.suggested_narration || '').trim()) return Promise.resolve();
    return suggestNarrationForArcPart(part, documentaryMode)
      .catch(() => {
        arcNarrationFailedParts.add(part);
        part.suggested_narration = '';
      })
      .finally(() => arcNarrationPendingParts.delete(part));
  }));
  return Promise.all(jobs).then(() => {
    if (generation !== arcNarrationGeneration) return;
    saveDebugSession();
    renderArcSuggestion(current, others);
  });
}

// storyboard.html: distill the analyzed moodboard into a suggested arc (+ its
// alternatives), a documentary mode, and techniques. The arc rendering is
// identical to runSuggestArcs; additionally we pre-select the suggested mode
// + technique chips and stash the rationale for renderMovieEditor to show.
function runDistillMoodboard() {
  const readyProfiles = moodboardReferences
    .filter(r => r.state === 'ready' && r.profile)
    .map(r => ({ ...r.profile, note: r.note || r.profile.note || '' }));
  if (!readyProfiles.length) {
    suggestArcsRowEl.style.display = '';
    suggestArcsStatusEl.textContent = 'Go back to setup and add at least one reference documentary to your moodboard first.';
    return;
  }
  // suggestArcsBtn.disabled = true;
  suggestArcsStatusEl.textContent = 'Distilling your moodboard into a narrative arc, mode, and techniques ...';
  suggestArcsStatusEl.classList.remove('error');
  arcSuggestionPanelEl.style.display = 'none';

  fetchDistillMoodboard(readyProfiles, findAbstractText(), paperSectionsForArc())
    .then(({ recommended, alternatives, suggested_mode, suggested_techniques, style_rationale }) => {
      suggestArcsStatusEl.textContent = '';
      // suggestArcsBtn.disabled = false;
      if (suggested_mode) {
        selectedDocumentaryMode = suggested_mode;
        actBoardSetupMode = suggested_mode;
      }
      const cleanSuggestedTechniques = sanitizeDocumentaryTechniques(suggested_techniques);
      selectedTechniques = new Set(cleanSuggestedTechniques);
      distilledStyleRationale = style_rationale || '';
      lastDistillResult = {
        recommended, alternatives, suggested_mode,
        suggested_techniques: cleanSuggestedTechniques, style_rationale,
      };
      // Keep existing Act Board scene boards in sync with a newly distilled
      // setup mode unless a presenter explicitly chose a local scene mode.
      syncActBoardSceneModesToSetupMode();
      recordedTranscript = buildMoodboardGoalSummary();
      saveDebugSession();
      renderArcSuggestionWithNarration(recommended, alternatives, selectedDocumentaryMode);
      // If an arc's already been accepted (the movie editor is on screen),
      // refresh it so the "Moodboard styles:" + techniques modules reflect the
      // new distill. currentArcSections is unchanged (a NEW arc still needs an
      // explicit Accept - see the suggestion panel), so scenes are preserved.
      if (currentArcSections.length > 0 && resultsEl) {
        const remaining = currentSections.filter(s => !s.removed);
        renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      }
    })
    .catch(err => {
      suggestArcsStatusEl.textContent = err.message;
      suggestArcsStatusEl.classList.add('error');
      // suggestArcsBtn.disabled = false;
    });
}

// storyboard.html: after the moodboard changes (a reference added or removed),
// re-distill the suggested arc/mode/techniques and refresh the styles +
// techniques modules. Debounced so several references finishing analysis at
// once (or a burst of edits) collapse into a single distill. No-op on
// index.html, which has no arc suggestion panel.
let moodboardRefreshTimer = null;
function refreshSuggestionsFromMoodboard() {
  if (!arcSuggestionPanelEl) return;  // storyboard-only
  clearTimeout(moodboardRefreshTimer);
  moodboardRefreshTimer = setTimeout(() => {
    if (moodboardReferences.some(r => r.state === 'ready')) runDistillMoodboard();
  }, 500);
}

// current: {arc_name, sections, reasoning} - the arc on offer for accept/
// swap right now; reasoning is only ever non-empty for the LLM's own top
// pick, not for an alternative the presenter has since promoted to current
// (see the alternative-chip handler below), which has no reasoning of its
// own to show. others: the remaining candidate arcs (excluding current),
// each {arc_name, sections}, shown as chips to swap to instead.
function renderArcSuggestion(current, others) {
  arcSuggestionPanelEl.innerHTML = '';
  arcSuggestionPanelEl.style.display = '';

  const card = document.createElement('div');
  card.className = 'arc-suggestion-card llm-generated';

  const title = document.createElement('div');
  title.className = 'arc-suggestion-title';
  title.textContent = current.arc_name;
  card.appendChild(title);

  // Concrete preview: under each chapter, show the generated narration and the
  // actual paper sections that would map into it (from section_indices), so the
  // presenter can compare what each arc would really do with THIS paper.
  const titleByIndex = new Map(currentSections.map(s => [s.index, s.title]));
  const partsList = document.createElement('div');
  partsList.className = 'arc-suggestion-parts';
  current.sections.forEach((part, partIdx) => {
    const partEl = document.createElement('div');
    partEl.className = 'arc-suggestion-part';

    const nameEl = document.createElement('div');
    nameEl.className = 'arc-suggestion-part-name';
    const actLabel = `Act ${partIdx + 1}: ${part.name}`;
    nameEl.textContent = actLabel;
    partEl.appendChild(nameEl);

    const narrationEl = document.createElement('div');
    narrationEl.className = 'arc-suggestion-part-narration';
    const narrationLabel = document.createElement('strong');
    narrationLabel.textContent = 'Suggested narration:';
    narrationEl.appendChild(narrationLabel);
    if (arcNarrationPendingParts.has(part)) {
      narrationEl.appendChild(document.createTextNode(' Generating…'));
    } else if ((part.suggested_narration || '').trim()) {
      narrationEl.appendChild(document.createTextNode(` ${part.suggested_narration.trim()}`));
    } else if (arcNarrationFailedParts.has(part)) {
      narrationEl.appendChild(document.createTextNode(' Unavailable — you can generate it after applying the arc.'));
    } else {
      narrationEl.appendChild(document.createTextNode(' Not generated yet.'));
    }
    partEl.appendChild(narrationEl);

    const titles = (part.section_indices || []).map(i => titleByIndex.get(i)).filter(Boolean);
    if (titles.length) {
      const secEl = document.createElement('div');
      secEl.className = 'arc-suggestion-part-sections';
      secEl.textContent = titles.join(' · ');
      partEl.appendChild(secEl);
    }
    partsList.appendChild(partEl);
  });
  card.appendChild(partsList);

  if (current.reasoning) {
    const reasoning = document.createElement('div');
    reasoning.className = 'arc-suggestion-reasoning';
    reasoning.textContent = current.reasoning;
    card.appendChild(reasoning);
  }

  const acceptBtn = document.createElement('button');
  acceptBtn.type = 'button';
  acceptBtn.id = 'accept-arc-btn';
  acceptBtn.className = 'btn-primary';
  const narrationPending = (current.sections || []).some(part => arcNarrationPendingParts.has(part));
  acceptBtn.textContent = narrationPending ? 'Generating narration…' : 'Apply this arc';
  acceptBtn.disabled = narrationPending;
  if (narrationPending) {
    acceptBtn.title = 'Wait for the suggested narration drafts to finish generating.';
  }
  acceptBtn.addEventListener('click', () => runAcceptArc(current));
  card.appendChild(acceptBtn);

  arcSuggestionPanelEl.appendChild(card);

  if (others.length > 0) {
    const otherLabel = document.createElement('p');
    otherLabel.className = 'chip-row-caption';
    otherLabel.style.marginTop = '25px';
    otherLabel.style.fontSize = '12px';
    otherLabel.style.opacity = '0.75';
    otherLabel.textContent = 'Or pick a different arc:';
    arcSuggestionPanelEl.appendChild(otherLabel);

    const otherChips = document.createElement('div');
    otherChips.className = 'chip-row';
    others.forEach(alt => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip suggested';
      chip.textContent = alt.arc_name;
      chip.addEventListener('click', () => {
        // Promote this alternative to current - the previous current (its
        // reasoning dropped, since that reasoning was specific to it, not
        // to this swap) rejoins the alternatives list alongside whatever's
        // left of it.
        const remaining = others.filter(o => o !== alt);
        renderArcSuggestionWithNarration(
          { arc_name: alt.arc_name, sections: alt.sections, reasoning: null },
          remaining.concat([{ arc_name: current.arc_name, sections: current.sections }]),
          selectedDocumentaryMode
        );
      });
      otherChips.appendChild(chip);
    });
    arcSuggestionPanelEl.appendChild(otherChips);
  }

  // "Suggest your own" - a free-text focus/arc description, re-running the
  // suggestion with it added as an extra focus statement (on top of
  // whichever chips are already selected) rather than replacing anything.
  const customRow = document.createElement('div');
  customRow.className = 'arc-suggestion-custom-row';

  const customInput = document.createElement('input');
  customInput.type = 'text';
  customInput.placeholder = 'Or describe your own focus/arc ...';
  customInput.className = 'arc-suggestion-custom-input';
  customRow.appendChild(customInput);

  const customBtn = document.createElement('button');
  customBtn.type = 'button';
  customBtn.id = 'suggest-own-arc-btn';
  customBtn.className = 'btn-secondary';
  customBtn.textContent = 'Suggest arc';
  customBtn.addEventListener('click', () => {
    const customText = customInput.value.trim();
    if (!customText) return;
    customBtn.disabled = true;
    suggestArcsStatusEl.textContent = 'Resolving your own focus into a narrative arc ...';
    suggestArcsStatusEl.classList.remove('error');
    fetchSuggestArcs(Array.from(selectedFocusStatements).concat([customText]), findAbstractText(), paperSectionsForArc())
      .then(({ recommended, alternatives }) => {
        suggestArcsStatusEl.textContent = '';
        renderArcSuggestionWithNarration(recommended, alternatives, selectedDocumentaryMode);
      })
      .catch(err => {
        suggestArcsStatusEl.textContent = err.message;
        suggestArcsStatusEl.classList.add('error');
        customBtn.disabled = false;
      });
  });
  customRow.appendChild(customBtn);

  arcSuggestionPanelEl.appendChild(customRow);
}

// Locks in whichever arc (recommended/alternative/custom) the presenter
// accepted and shows it straight away as a vertical list of narrative-act
// groups (renderMovieEditor). Each new act receives one fresh scene whose
// source-material field is populated from the paper sections mapped to that
// act. Narration generated during distillation is carried into the new scene;
// any missing draft is generated against the same act/scene context below.
// Existing source sections and generated work remain in state, while the new
// arc gets a clean assigned scene for each of its parts.
function runAcceptArc(arc) {
  selectedNarrationArc = { sections: arc.sections, arc_name: arc.arc_name };
  currentArcSections = arc.sections.map(s => ({ key: s.name, label: s.name, description: s.description || '' }));
  // Snapshot the setup choice at the moment the arc is accepted. This is the
  // mode that new Act Board scene boards should highlight, even if the
  // optional Timeline + Scenes mode picker is changed later.
  if (DOCUMENTARY_MODES.some(mode => mode.key === selectedDocumentaryMode)) {
    actBoardSetupMode = selectedDocumentaryMode;
  } else if (!DOCUMENTARY_MODES.some(mode => mode.key === actBoardSetupMode)) {
    actBoardSetupMode = lastDistillResult?.suggested_mode || null;
  }
  // The setup/moodboard mode is the starting mode for Act Board scenes. A
  // scene that the presenter explicitly changed keeps its local override;
  // Timeline + Scenes data remains intact for its future view.
  syncActBoardSceneModesToSetupMode();
  selectedSectionIndices = new Set();

  // Preserve the paper library and all generated work (visual/narration/edit
  // plan/shot frames/cutaways/footage). Only blank scaffold placeholders from
  // the previous arc are dropped; a scaffold scene the presenter filled in is
  // retained in state, even though the new arc gets a clean scene set.
  const hasContent = s => !!(
    (s.text && s.text.trim()) || s.narration || s.narrationAudioPreviewUrl ||
    s.startFramePreviewUrl || (s.cutaways && s.cutaways.length) ||
    s.visualSource || s.selectedVideo || s.selectedAudio || s.uploadedFootagePreviewUrl
  );
  currentSections = currentSections.filter(s => !(s.narrativeOnly && !hasContent(s)));

  // The paper sections mapped into each arc part, in reading order.
  const validIndices = new Set(currentSections.filter(s => !s.removed).map(s => s.index));
  const sectionsByAct = {};
  const mappedPaperIndices = new Set();
  arc.sections.forEach(part => {
    sectionsByAct[part.name] = (part.section_indices || [])
      .filter(idx => validIndices.has(idx))
      .map(idx => currentSections.find(s => s.index === idx))
      .filter(source => source && !source.narrativeOnly);
    sectionsByAct[part.name].forEach(source => mappedPaperIndices.add(source.index));
  });
  // If the arc suggestion omitted some paper sections, attach the remaining
  // source material across the new acts instead of leaving it orphaned.
  const unassignedPaper = currentSections.filter(source =>
    !source.removed && !source.narrativeOnly && !mappedPaperIndices.has(source.index));
  splitContiguous(unassignedPaper, currentArcSections.length).forEach((bucket, index) => {
    const part = currentArcSections[index];
    if (part) sectionsByAct[part.key] = (sectionsByAct[part.key] || []).concat(bucket);
  });

  // A newly accepted arc gets one fresh scene per arc part. The original
  // paper sections remain untouched in `currentSections`; their text is copied
  // into the new scene as its attached source material, and the source indices
  // are retained so the relationship is explicit and recoverable. Existing
  // generated scenes are not deleted, but they are left unassigned to this new
  // arc rather than silently mixing old narration into the new structure.
  currentAssignments = {};
  const newArcScenes = [];
  currentArcSections.forEach(part => {
    const attachedSources = sectionsByAct[part.key] || [];
    const sourceText = attachedSources.map(source => source.text).filter(Boolean).join('\n\n');
    const scene = insertSection(-1, 'New Scene', sourceText, part.key, true);
    scene.sourceMaterialIndices = attachedSources.map(source => source.index);
    // Carry the first attached paper figure into the new scene's open slot.
    // Arc acceptance creates a fresh scene object, so copying only the text
    // would otherwise leave the source image behind on the library section.
    const attachedFigure = attachedSources.find(source => source && source.image);
    if (attachedFigure) scene.image = attachedFigure.image;
    scene.sceneNotes = '';
    scene.role = 'aRoll';
    if ((part.suggested_narration || '').trim()) {
      // Carry the draft generated while distilling into the same field used
      // by the post-accept narration pipeline, so the scene card shows the
      // exact text the presenter already saw in the arc suggestion.
      scene.arcSuggestedNarration = part.suggested_narration.trim();
      scene.narrationSuggestion = scene.arcSuggestedNarration;
    }
    scene.editPlan = {
      transitionIn: 'hard_cut',
      durationSeconds: DEFAULT_SCENE_SECONDS,
      kenBurns: { enabled: false, pan: null },
      textOverlay: null,
    };
    currentAssignments[scene.index] = part.key;
    newArcScenes.push(scene);
  });

  const remaining = currentSections.filter(section => !section.removed);
  renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
  relocateAllSidebarModules();
  saveDebugSession();

  // Setup inputs are routed to the Act Board by default. Keep the existing
  // Timeline + Scenes generation pipeline intact for the future view, but do
  // not fire its expensive narration/technique/image pass from setup. The
  // timeline still renders its scene scaffolds and its Generate Storyboard
  // action remains available when the presenter explicitly switches to that
  // view.
  setStoryboardStatus('Arc ready on the Act Board. Timeline + Scenes is preserved for later generation.');
}
//#endregion

//#region --- NARRATIVE ARC
// --- COMPOSE STORYBOARD - navigates from index.html (record/upload) to
// storyboard.html (arc suggestion + movie editor) as a real page load, not
// a same-page view swap - all state either page needs
// (recordedTranscript, selectedFocusStatements, currentSections, ...) is
// persisted to localStorage first (see saveDebugSession) and restored on
// the next page's load (see restoreDebugSession, further below).
// #compose-storyboard-row/#compose-storyboard-btn only exist on
// index.html, so both are guarded here - a no-op on storyboard.html.
const composeStoryboardRowEl = document.getElementById('compose-storyboard-row');
const composeStoryboardBtn = document.getElementById('compose-storyboard-btn');

// Shown once both halves of the setup step are satisfied - recorded intent
// (or at least one focus chip) and at least one non-excluded extracted
// section. Called after transcription succeeds, a focus chip toggles, an
// extraction succeeds, and a section gets excluded/restored (see those
// call sites).
function updateComposeStoryboardVisibility() {
  if (!composeStoryboardRowEl) return;
  // At least one reference documentary must have finished analyzing before
  // there's anything to distill into an arc (see runDistillMoodboard).
  const hasIntent = moodboardReferences.some(r => r.state === 'ready');
  const hasSections = currentSections.some(section => !section.removed);
  composeStoryboardRowEl.style.display = (hasIntent && hasSections) ? '' : 'none';
}

if (composeStoryboardBtn) {
  composeStoryboardBtn.addEventListener('click', () => {
    saveDebugSession();
    window.location.href = 'storyboard.html';
  });
}
// --- END COMPOSE STORYBOARD

function buildMediaVideoOption(section, video) {
  const option = document.createElement('div');
  option.className = 'media-video-option';
  option.classList.toggle('selected', !!section.selectedVideo && section.selectedVideo.id === video.id);

  const player = document.createElement('video');
  player.src = video.video_url;
  player.poster = video.thumbnail_url || '';
  player.controls = true;
  player.preload = 'metadata';
  player.addEventListener('click', event => event.stopPropagation()); // let play/pause/scrub work without also selecting this option
  option.appendChild(player);

  // Which provider this came from (see server.py's /media/search_video,
  // which tags every result before returning it) - Pexels (modern stock
  // footage) vs. Internet Archive/Library of Congress (real archival
  // footage) isn't obvious from the thumbnail alone.
  if (video.source) {
    const sourceLabel = document.createElement('div');
    sourceLabel.className = 'media-video-option-source';
    sourceLabel.textContent = video.source;
    option.appendChild(sourceLabel);
  }

  const link = document.createElement('a');
  link.className = 'media-option-link';
  link.href = video.source_url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = '↗';
  link.title = video.source ? `Open on ${video.source}` : 'Open source';
  link.addEventListener('click', event => event.stopPropagation());
  option.appendChild(link);

  // The video fills this whole option (see .media-video-option's CSS), so
  // clicking it just plays/pauses (see the player's own stopPropagation
  // above) rather than ever reaching an option-level click-to-select -
  // there's no exposed area left to click for that. This overlay button is
  // the actual, discoverable way to pick a clip.
  const isSelected = !!section.selectedVideo && section.selectedVideo.id === video.id;
  const selectBtn = document.createElement('button');
  selectBtn.type = 'button';
  selectBtn.className = 'media-video-option-select-btn';
  selectBtn.textContent = isSelected ? '✓ Selected' : 'Use this clip';
  selectBtn.addEventListener('click', event => {
    event.stopPropagation();
    if (selectBtn.disabled) return;
    selectBtn.disabled = true;
    selectBtn.textContent = 'Downloading ...';
    // A pick is a bare remote URL until it's actually downloaded to disk -
    // neither export path (the Premiere plugin or the ffmpeg render) can
    // use a URL directly. See fetchDownloadStockMedia's own comment.
    fetchDownloadStockMedia(
      section.index,
      'video',
      video.video_url,
      premiereProjectId,
      getSceneDuration(section),
      video.id || `scene-${section.index}`,
    )
      .then(({ project_id, preview_url, file_path, thumbnail_url }) => {
        premiereProjectId = project_id;
        section.selectedVideo = { ...video, localPreviewUrl: preview_url };
        // A found-footage pick is the scene's open-slot reference, not a
        // generated visual-box result. Keep a local copy + extracted poster so
        // the same slot renders it like uploaded footage and future shot/image
        // generation can use its frame as an anchor.
        section.uploadedFootagePath = file_path || null;
        section.uploadedFootagePreviewUrl = preview_url || null;
        section.uploadedFootageThumbnailUrl = thumbnail_url || video.thumbnail_url || null;
        section.uploadedSketchPath = null;
        section.uploadedSketchPreviewUrl = null;
        section.uploadedSketchUploadedAt = null;
        section.footageOrigin = 'foundFootage';
        section.visualSource = 'video';
        // Full re-render so the open slot picks up the selected clip immediately.
        const remaining = currentSections.filter(s => !s.removed);
        renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
        saveDebugSession();
      })
      .catch(err => {
        selectBtn.disabled = false;
        selectBtn.textContent = 'Use this clip';
        window.alert(`Could not use this clip: ${err.message}`);
      });
  });
  option.appendChild(selectBtn);

  return option;
}

function buildMediaAudioOption(section, audio) {
  const option = document.createElement('div');
  option.className = 'media-audio-option';
  option.classList.toggle('selected', !!section.selectedAudio && section.selectedAudio.id === audio.id);

  const label = document.createElement('div');
  label.className = 'media-audio-option-label';
  const licenseSuffix = audio.license ? `, ${audio.license}` : '';
  const duration = Number(audio.duration);
  const durationSuffix = Number.isFinite(duration) && duration > 0 ? ` · ${duration.toFixed(1)}s` : '';
  label.textContent = `${audio.name || 'Untitled'} — ${audio.creator || 'unknown'}${licenseSuffix}${durationSuffix}`;
  option.appendChild(label);

  const player = document.createElement('audio');
  player.controls = true;
  player.src = audio.preview_url;
  player.addEventListener('click', event => event.stopPropagation());
  option.appendChild(player);

  if (audio.source_url) {
    const sourceLink = document.createElement('a');
    sourceLink.className = 'media-option-link';
    sourceLink.href = audio.source_url;
    sourceLink.target = '_blank';
    sourceLink.rel = 'noopener noreferrer';
    sourceLink.textContent = '↗';
    sourceLink.title = 'Open this sound on Freesound';
    sourceLink.addEventListener('click', event => event.stopPropagation());
    option.appendChild(sourceLink);
  }

  option.addEventListener('click', event => {
    event.stopPropagation(); // don't let this bubble to the card's own click-to-select handler
    if (option.classList.contains('downloading')) return;
    option.classList.add('downloading');
    // A pick is a bare remote URL until it's actually downloaded to disk -
    // neither export path (the Premiere plugin or the ffmpeg render) can
    // use a URL directly. See fetchDownloadStockMedia's own comment.
    fetchDownloadStockMedia(section.index, 'audio', audio.preview_url, premiereProjectId)
      .then(({ project_id, preview_url, file_path, duration_seconds }) => {
        premiereProjectId = project_id;
        const naturalDuration = Number(duration_seconds) > 0 ? Number(duration_seconds) : duration;
        section.selectedAudio = {
          ...audio,
          localPreviewUrl: preview_url,
          localFilePath: file_path || null,
          sourceDurationSeconds: naturalDuration,
          trimStartSeconds: 0,
          durationSeconds: naturalDuration,
        };
        // Full re-render so the audio placeholder under the visual box (see
        // buildSectionBlock) picks up the new player immediately.
        const remaining = currentSections.filter(s => !s.removed);
        renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
        saveDebugSession();
      })
      .catch(err => {
        option.classList.remove('downloading');
        window.alert(`Could not use this sound: ${err.message}`);
      });
  });

  return option;
}

// Sound effects use their own search action rather than piggy-backing on
// Find footage. The storyboard's audio_query is still shared, but the result
// area and request lifecycle are independent so video and SFX searches can be
// used/retried without replacing one another's UI.
function runUploadSoundEffect(section, file, statusEl, inputEl) {
  inputEl.disabled = true;
  statusEl.textContent = `Uploading “${file.name}”...`;
  statusEl.classList.remove('error');

  return fetchUploadMediaBankItem(file, premiereProjectId)
    .then(({ project_id, preview_url, file_path, duration_seconds }) => {
      premiereProjectId = project_id;
      const naturalDuration = Number(duration_seconds);
      section.selectedAudio = {
        name: file.name,
        source: 'user-upload',
        preview_url: preview_url,
        localPreviewUrl: preview_url,
        localFilePath: file_path || null,
        sourceDurationSeconds: naturalDuration > 0 ? naturalDuration : null,
        trimStartSeconds: 0,
        durationSeconds: naturalDuration > 0 ? naturalDuration : null,
      };
      normalizeSelectedAudioSegment(section.selectedAudio);
      saveDebugSession();
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
    })
    .catch(err => {
      statusEl.textContent = `Could not upload sound effect: ${err.message}`;
      statusEl.classList.add('error');
      inputEl.disabled = false;
    });
}

function runSuggestSoundEffects(section, resultsEl, statusEl, btn, queryInput, pairedQueryInput) {
  btn.disabled = true;
  statusEl.textContent = section.audioQuery
    ? 'Searching for sound effects...'
    : 'Finding a sound-effects search phrase, then searching...';
  statusEl.classList.remove('error');

  return ensureFootageQueries(section)
    .then(() => {
      if (queryInput) queryInput.value = section.audioQuery || '';
      if (pairedQueryInput) pairedQueryInput.value = section.videoQuery || '';
      statusEl.textContent = `Searching Freesound for “${section.audioQuery}”...`;
      return fetchAudioOptions(section.audioQuery);
    })
    .then(({ audio }) => {
      resultsEl.innerHTML = '';
      const queryLabel = document.createElement('div');
      queryLabel.className = 'sfx-search-query';
      queryLabel.textContent = `Freesound query: “${section.audioQuery}”`;
      resultsEl.appendChild(queryLabel);
      const row = document.createElement('div');
      row.className = 'media-audio-options';
      (audio || []).forEach(sound => row.appendChild(buildMediaAudioOption(section, sound)));
      resultsEl.appendChild(row);
      statusEl.textContent = audio && audio.length
        ? ''
        : `No sound effects found for “${section.audioQuery}”.`;
    })
    .catch(err => {
      statusEl.textContent = err.message;
      statusEl.classList.add('error');
    })
    .finally(() => { btn.disabled = false; });
}

// --- Narrative arc: a named, dynamically-sized documentary structure (see
// backend/narrative_arc_llm.py for the prompt; currentArcSections holds the
// resolved parts), presented as one full-width row per arc part, stacked
// top-to-bottom in arc order - each row's label sits to the left, its
// section cards listed to the right of that label, one on top of the other.

// A plain click replaces the selection with just this index; a shift-click
// toggles it into/out of the current selection - drives both the .selected
// highlight (cards and their compact chips alike) and, in renderMovieEditor,
// which section(s) the top "Generate Storyboard"/"Generate Edit Plan"
// buttons target.
function handleSectionClick(index, event) {
  if (event.shiftKey) {
    if (selectedSectionIndices.has(index)) selectedSectionIndices.delete(index);
    else selectedSectionIndices.add(index);
  } else {
    selectedSectionIndices = new Set([index]);
  }
  const remaining = currentSections.filter(section => !section.removed);
  renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
}

// Dropping a chip onto a different arc-part row reorders currentSections
// (the single array every render already derives display order from) and,
// if the drop landed on a different act than the chip's section's current
// one, reassigns it - a full manual override of the LLM's arrangement. Drop
// position is "immediately before whichever chip your cursor lands on" (or
// appended to the end of that row if dropped elsewhere in it) - not
// pixel-precise before/after based on cursor position, but enough for a
// rough rearrange. Full .paper-section-blocks are deliberately not
// draggable - dragging a big two-column card around felt too easy to
// trigger by accident while editing its text/using its buttons; the
// compact chip strip is the only drag handle now.
// Split an array into n balanced, CONTIGUOUS chunks (preserving order) - used
// when an arc response leaves some paper sections unmapped. Some chunks may be
// empty when there are fewer sources than acts.
function splitContiguous(arr, n) {
  const chunks = [];
  const len = arr.length;
  for (let i = 0; i < n; i++) {
    chunks.push(arr.slice(Math.floor(i * len / n), Math.floor((i + 1) * len / n)));
  }
  return chunks;
}

// The first scene (in reading order) assigned to an act - the target for
// paper-section content dragged onto the act (see appendSectionTextToFirstScene)
// and the merge target when a mode is scaffolded (see runAcceptArc).
function firstSceneOfAct(actKey) {
  return currentSections.find(s => isSceneActive(s) && currentAssignments[s.index] === actKey) || null;
}

// Append a source paper section's text to the first scene's Scene Notes in an
// act (rather than adding the section as its own scene). Returns whether it did
// anything (there was a first scene and some text to add).
function appendSectionTextToFirstScene(actKey, sourceSection) {
  const scene = firstSceneOfAct(actKey);
  if (!scene) return false;
  const addition = (sourceSection.text || '').trim();
  if (!addition) return false;
  scene.text = scene.text ? `${scene.text}\n\n${addition}` : addition;
  return true;
}

function handleChipDrop(event, actKey) {
  event.preventDefault();
  const draggedIndex = parseInt(event.dataTransfer.getData('text/plain'), 10);
  if (Number.isNaN(draggedIndex)) return;

  const draggedPos = currentSections.findIndex(s => s.index === draggedIndex);
  if (draggedPos === -1) return;
  const [draggedSection] = currentSections.splice(draggedPos, 1);

  const targetChipEl = event.target.closest('.narrative-act-row-chip:not(.dragging)');
  const targetIndex = targetChipEl ? parseInt(targetChipEl.dataset.sectionIndex, 10) : null;
  if (targetIndex !== null && !Number.isNaN(targetIndex) && targetIndex !== draggedIndex) {
    const targetPos = currentSections.findIndex(s => s.index === targetIndex);
    currentSections.splice(targetPos === -1 ? currentSections.length : targetPos, 0, draggedSection);
  } else {
    currentSections.push(draggedSection);
  }

  if (currentAssignments[draggedIndex] !== actKey) {
    // Moved to a different act - its storyboard shot (if any) was written
    // for the old act's tone, same reasoning runAcceptArc already applies
    // when a different arc is accepted.
    delete draggedSection.visual;
    delete draggedSection.narration;
    currentAssignments[draggedIndex] = actKey;
  }

  const remaining = currentSections.filter(section => !section.removed);
  renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
}

// Scroll a scene card below the sticky action bar + timeline. Native
// scrollIntoView({block:'start'}) leaves the card underneath the timeline when
// the timeline is expanded, so calculate the live chrome height instead.
function scrollSceneBelowStickyChrome(target) {
  if (!target) return;
  const chromeBottom = ['.action-bar', '.premiere-timeline']
    .map(selector => document.querySelector(selector))
    .filter(Boolean)
    .map(el => el.getBoundingClientRect())
    .filter(rect => rect.height > 0)
    .reduce((bottom, rect) => Math.max(bottom, rect.bottom), 0);
  const gap = 14;
  const targetY = window.scrollY + target.getBoundingClientRect().top - chromeBottom - gap;
  window.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
}

function scrollTimelineClipToScene(sectionIndex) {
  const target = document.querySelector(
    `.paper-section-block[data-section-index="${sectionIndex}"]`);
  if (!target) return;
  activeSfxSectionIndex = sectionIndex;
  timelinePreviewProgrammaticScrollUntil = performance.now() + 1200;
  scrollSceneBelowStickyChrome(target);
}

// A single click selects (like a card click - see handleSectionClick); a
// double-click instead scrolls the section's full card into view without
// changing the selection, for jumping to a section spotted in the chip
// strip without having to scroll and hunt for its card.
function buildArcRowChip(section) {
  const chip = document.createElement('div');
  chip.className = 'narrative-act-row-chip';
  chip.classList.toggle('selected', selectedSectionIndices.has(section.index));
  chip.textContent = section.title;
  chip.title = section.title;
  chip.dataset.sectionIndex = String(section.index);
  chip.draggable = true;
  chip.addEventListener('dragstart', event => {
    event.dataTransfer.setData('text/plain', String(section.index));
    event.dataTransfer.effectAllowed = 'move';
    chip.classList.add('dragging');
  });
  chip.addEventListener('dragend', () => {
    chip.classList.remove('dragging');
  });
  chip.addEventListener('click', event => handleSectionClick(section.index, event));
  chip.addEventListener('dblclick', event => {
    event.stopPropagation();
    const card = document.querySelector(`.paper-section-block[data-section-index="${section.index}"]`);
    scrollSceneBelowStickyChrome(card);
  });
  return chip;
}

// Roughly where .premiere-timeline's own sticky top sits (see
// renderMovieEditor's scroll listener below) - just below the sticky
// .action-bar above it.
const OUTLINE_ACTIVE_THRESHOLD_PX = 90;

// Premiere-style A-roll/B-roll timeline, replacing the old vertical
// .narrative-arc-outline sidebar (a jump-list of acts) - one act-sized
// group per arc part, one equal-width clip per section within it. There's
// no real per-shot duration data to size clips by (this is a storyboard,
// not an edited timeline yet), so clip width is proportional to shot
// COUNT per act, not time - still gives the "how much of the film is this
// act" read a real timeline gives, just on a coarser axis.
//
// Each track has its own 3-step ladder (see buildVisualBox /
// VISUAL_BOX_RENDERERS and finishAssigningNarrationAudio for the same
// "real asset > drafted text only > nothing" distinction made elsewhere):
// unfilled (dashed, nothing yet) -> .drafted (an LLM suggestion, no real
// asset attached) -> .filled (a real asset for THAT lane). A narration asset
// therefore cannot color footage, and an SFX asset cannot color narration.
//
// Returns a Map from section.index to that section's [aRollClip, bRollClip]
// pair - renderMovieEditor's scroll listener uses this to highlight
// whichever's currently scrolled past.
// One track builder shared by all 4 rows below - same label/body/group
// structure every time, just a different label and a different per-section
// fill/draft predicate (see the TRACK_DEFS array in buildNarrativeTimeline).
function buildTimelineTrack(timelineEl, label) {
  const track = document.createElement('div');
  track.className = 'premiere-timeline-track';
  const trackLabel = document.createElement('div');
  trackLabel.className = 'premiere-timeline-track-label';
  trackLabel.textContent = label;
  track.appendChild(trackLabel);
  const body = document.createElement('div');
  body.className = 'premiere-timeline-track-body';
  track.appendChild(body);
  timelineEl.appendChild(track);
  return body;
}

// A scene's timeline track role: an explicit user override (section.role, set
// via buildSectionBlock's role picker or a scaffolded mode template) if
// present, else inferred from whatever's attached - a picked stock clip reads
// as B-roll, a generated/uploaded primary visual as A-roll, otherwise A-roll
// by default (the narrative spine). Sound effects are attached independently.
function getSceneRole(section) {
  if (section.role && SCENE_ROLE_LABELS[section.role]) return section.role;
  if (section.visualSource === 'stockVideo') return 'bRoll';
  if (['sketch', 'animatedSketch', 'video'].includes(section.visualSource)) return 'aRoll';
  return 'aRoll';
}

// Expository is a project mode as well as a scaffolded scene kind. Older or
// hand-arranged scenes may not carry shotKind, so generation must honor the
// selected mode too. Cutaway-role scenes remain ordinary individual shots.
function isExpositoryPrimaryScene(section) {
  return getSceneRole(section) === 'aRoll' && (
    section.shotKind === 'expositoryNarration' || selectedDocumentaryMode === 'expository'
  );
}

// A scene's on-screen duration in seconds - from its (auto- or hand-)
// generated edit plan, falling back to a flat default so the timeline can
// still size it before an edit plan exists.
function getSceneDuration(section) {
  const d = section.editPlan && section.editPlan.durationSeconds;
  return (typeof d === 'number' && d > 0) ? d : DEFAULT_SCENE_SECONDS;
}

// A single expository cutaway's on-screen duration - each cutaway surfaces as
// its own B-roll segment on the timeline (see buildNarrativeTimeline). Uses a
// per-cutaway duration_seconds if the generator supplied one, else a flat
// default.
const DEFAULT_CUTAWAY_SECONDS = 4;
function getCutawayDuration(cutaway) {
  const d = cutaway && cutaway.duration_seconds;
  return (typeof d === 'number' && d > 0) ? d : DEFAULT_CUTAWAY_SECONDS;
}

// Timeline fill is lane-specific: narration audio must not color the footage
// lane, a selected SFX clip must not color either visual lane, and a visual
// preview must not color narration. Keep these predicates separate even though
// every scene is represented by one shared visual clip spec below.
function hasSceneNarrationAudio(section) {
  return !!(section && (
    (Array.isArray(section.narrationClips) && section.narrationClips.length) ||
    section.narrationAudioPreviewUrl
  ));
}

// The blue FOOTAGE timeline fill represents media that is actually in the
// paper-section-open-slot, not merely a suggestion or a preview in the visual
// box. Uploaded/recorded footage and sketches live here, as do generated
// image/video references after the presenter deliberately drags them into the
// slot (applyDraggedGeneratedReference uses the same fields).
function hasSceneOpenSlotMedia(section) {
  return !!(section && (
    section.uploadedFootagePreviewUrl || section.uploadedSketchPreviewUrl
  ));
}

function hasSceneSoundEffect(section) {
  return getSelectedSfxDuration(section) > 0;
}

function isSceneFilledForRole(section, roleKey) {
  if (roleKey === 'soundEffects') return hasSceneSoundEffect(section);
  if (roleKey === 'narration') return hasSceneNarrationAudio(section);
  return hasSceneOpenSlotMedia(section);
}

function isSceneDraftedForRole(section, roleKey) {
  if (roleKey === 'narration') return !!effectiveSectionNarration(section);
  if (roleKey === 'soundEffects') return !!(section && section.audioQuery);
  if (roleKey === 'bRoll') return !!(section && section.videoQuery);
  return !!(section && section.visual && section.visual.trim());
}

// Dragging a documentary mode onto a timeline act scaffolds that act with the
// mode's scene template (see MODE_SCENE_TEMPLATES) - one A-roll/B-roll scene
// per entry, each a blank narrativeOnly scene the presenter then fills, with
// its role and an auto-generated edit plan (duration in seconds) already set.
// Content-preserving, like runAcceptArc: only the act's EMPTY scaffold scenes
// (narrativeOnly with no generated shot/cutaways/footage/narration) are cleared
// first, so re-dragging a mode resets the blank placeholders without piling on
// duplicates. A scaffold scene the presenter has already invested work in is
// kept (it stays in the act alongside the new template scenes), and any real
// (non-narrativeOnly) scene is kept too.
function scaffoldModeOntoAct(actKey, modeKey) {
  const template = MODE_SCENE_TEMPLATES[modeKey];
  if (!template) return;

  // "Worth keeping" = actual generated/added work, not just auto-populated
  // scene notes (which every scaffold scene gets), so an untouched scaffold
  // still clears on a mode change.
  const hasGeneratedContent = s => !!(
    s.startFramePreviewUrl || (s.cutaways && s.cutaways.length) ||
    s.narration || s.narrationAudioPreviewUrl || s.visualSource ||
    s.selectedVideo || s.selectedAudio || s.uploadedFootagePreviewUrl || s.uploadedSketchPreviewUrl
  );

  currentSections = currentSections.filter(section => {
    const isEmptyActScaffold = section.narrativeOnly
      && currentAssignments[section.index] === actKey
      && !hasGeneratedContent(section);
    if (isEmptyActScaffold) delete currentAssignments[section.index];
    return !isEmptyActScaffold;
  });

  template.forEach(spec => {
    // Title is the generic "New Scene"; the mode's descriptive label goes into
    // the scene notes instead (see the runAcceptArc scaffold for the same).
    const scene = insertSection(-1, 'New Scene', spec.title, actKey, true);
    scene.role = 'bRoll';
    delete scene.shotKind;
    // The edit plan is auto-generated here from the mode spec itself (not an
    // LLM call) - just the duration for now, with the same neutral defaults
    // /premiere/export and the ffmpeg render already tolerate.
    scene.editPlan = {
      transitionIn: 'hard_cut',
      durationSeconds: spec.durationSeconds,
      kenBurns: { enabled: false, pan: null },
      textOverlay: null,
    };
  });
  saveDebugSession();
  const remaining = currentSections.filter(s => !s.removed);
  renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
}

// Keep the accepted arc's serialized section order in lockstep with the
// timeline order. `currentArcSections` is the render-friendly form; the
// accepted arc keeps the original section_indices and any other metadata.
function persistCurrentArcOrder() {
  if (!selectedNarrationArc) return;
  const original = new Map((selectedNarrationArc.sections || []).map(part => [part.name || part.key, part]));
  selectedNarrationArc.sections = currentArcSections.map(act => original.get(act.key) || ({
    name: act.key,
    description: act.description || '',
    section_indices: [],
  }));
}

function reorderTimelineActs(sourceKey, targetKey, before) {
  if (!sourceKey || !targetKey || sourceKey === targetKey) return;
  const sourceIndex = currentArcSections.findIndex(act => act.key === sourceKey);
  const targetIndex = currentArcSections.findIndex(act => act.key === targetKey);
  if (sourceIndex === -1 || targetIndex === -1) return;
  const [source] = currentArcSections.splice(sourceIndex, 1);
  const adjustedTarget = currentArcSections.findIndex(act => act.key === targetKey);
  currentArcSections.splice(adjustedTarget + (before ? 0 : 1), 0, source);
  persistCurrentArcOrder();
  saveDebugSession();
  const remaining = currentSections.filter(section => !section.removed);
  renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
}

// Resize a visual timeline clip by dragging its right edge. The clip width is
// frozen during the gesture so neighboring clips do not reflow underneath the
// pointer; the proportional layout returns on the next render.
function wireClipResize(handle, clip, spec) {
  handle.addEventListener('pointerdown', event => {
    event.preventDefault();
    event.stopPropagation();
    const group = clip.parentElement;
    const siblings = group ? Array.from(group.children) : [clip];
    siblings.forEach(el => { el.style.flex = `0 0 ${el.getBoundingClientRect().width}px`; });
    const startX = event.clientX;
    const startWidth = clip.getBoundingClientRect().width;
    const startSeconds = Math.max(spec.seconds, 0.5);
    const pxPerSecond = startWidth / startSeconds || 1;
    let newSeconds = spec.seconds;
    try { handle.setPointerCapture(event.pointerId); } catch (err) { /* optional */ }
    const onMove = moveEvent => {
      const width = Math.max(6, startWidth + moveEvent.clientX - startX);
      clip.style.flex = `0 0 ${width}px`;
      newSeconds = Math.max(0.5, Math.round((width / pxPerSecond) * 2) / 2);
      clip.title = `${spec.title} · ${newSeconds}s`;
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      try { handle.releasePointerCapture(event.pointerId); } catch (err) { /* optional */ }
      newSeconds = Math.max(1, newSeconds);
      if (spec.kind === 'cutaway' && spec.cutaway) spec.cutaway.duration_seconds = newSeconds;
      else if (spec.section) {
        spec.section.editPlan = Object.assign(
          { transitionIn: 'hard_cut', kenBurns: { enabled: false, pan: null }, textOverlay: null },
          spec.section.editPlan || {}, { durationSeconds: newSeconds });
      }
      saveDebugSession();
      renderMovieEditor(resultsEl, currentLabel, currentSections.filter(section => !section.removed), currentAssignments);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}

// Drag a visual scene clip to reorder it within the current arc or move it to
// another act. Only the FOOTAGE lane is a scene-reordering surface; narration
// and sound-effects clips have their own audio timing controls.
function wireClipDrag(clip, section) {
  clip.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    if (event.target.closest('.premiere-timeline-clip-handle')) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    let ghost = null;
    let drop = null;
    const onMove = moveEvent => {
      if (!dragging) {
        if (Math.abs(moveEvent.clientX - startX) < 4 && Math.abs(moveEvent.clientY - startY) < 4) return;
        dragging = true;
        clip.classList.add('dragging');
        ghost = clip.cloneNode(true);
        ghost.classList.add('premiere-timeline-clip-ghost');
        ghost.classList.remove('dragging');
        ghost.style.width = `${clip.getBoundingClientRect().width}px`;
        document.body.appendChild(ghost);
      }
      ghost.style.left = `${moveEvent.clientX + 8}px`;
      ghost.style.top = `${moveEvent.clientY - 10}px`;
      const el = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
      const group = el && el.closest('.premiere-timeline-act-group[data-role="visual"]');
      if (!group) { drop = null; if (clipDropIndicatorEl) clipDropIndicatorEl.style.display = 'none'; return; }
      const neighbor = el.closest('.premiere-timeline-clip:not(.spacer)');
      const rect = group.getBoundingClientRect();
      let neighborIndex = null;
      let before = true;
      let indicatorX = rect.left;
      if (neighbor && neighbor !== clip) {
        const neighborRect = neighbor.getBoundingClientRect();
        before = moveEvent.clientX < neighborRect.left + neighborRect.width / 2;
        neighborIndex = parseInt(neighbor.dataset.sectionIndex, 10);
        indicatorX = before ? neighborRect.left : neighborRect.right;
      }
      drop = { actKey: group.dataset.actKey, neighborIndex, before };
      const indicator = ensureClipDropIndicator();
      indicator.style.display = 'block';
      indicator.style.left = `${indicatorX}px`;
      indicator.style.top = `${rect.top}px`;
      indicator.style.height = `${rect.height}px`;
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (clipDropIndicatorEl) clipDropIndicatorEl.style.display = 'none';
      if (ghost) ghost.remove();
      clip.classList.remove('dragging');
      if (dragging && drop) moveSectionInTimeline(section, drop.actKey, drop.neighborIndex, drop.before);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
}

let clipDropIndicatorEl = null;
function ensureClipDropIndicator() {
  if (!clipDropIndicatorEl) {
    clipDropIndicatorEl = document.createElement('div');
    clipDropIndicatorEl.className = 'premiere-timeline-drop-indicator';
    document.body.appendChild(clipDropIndicatorEl);
  }
  return clipDropIndicatorEl;
}

function moveSectionInTimeline(section, actKey, neighborIndex, before) {
  currentAssignments[section.index] = actKey;
  const position = currentSections.indexOf(section);
  if (position !== -1) currentSections.splice(position, 1);
  let insertAt = currentSections.length;
  if (neighborIndex != null && neighborIndex !== section.index) {
    const neighborPosition = currentSections.findIndex(item => item.index === neighborIndex);
    insertAt = neighborPosition === -1 ? currentSections.length : neighborPosition + (before ? 0 : 1);
  } else {
    const actPositions = currentSections
      .map((item, index) => currentAssignments[item.index] === actKey ? index : -1)
      .filter(index => index >= 0);
    if (actPositions.length) insertAt = actPositions[actPositions.length - 1] + 1;
  }
  currentSections.splice(insertAt, 0, section);
  saveDebugSession();
  renderMovieEditor(resultsEl, currentLabel, currentSections.filter(item => !item.removed), currentAssignments);
}

function wireTimelineActDrag(rulerGroup, actKey) {
  rulerGroup.draggable = true;
  rulerGroup.dataset.actKey = actKey;
  rulerGroup.addEventListener('dragstart', event => {
    event.dataTransfer.setData('application/x-timeline-act', actKey);
    event.dataTransfer.effectAllowed = 'move';
    rulerGroup.classList.add('dragging');
  });
  rulerGroup.addEventListener('dragend', () => rulerGroup.classList.remove('dragging'));
  rulerGroup.addEventListener('dragover', event => {
    if (!event.dataTransfer.types.includes('application/x-timeline-act')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    rulerGroup.classList.add('act-drop-over');
  });
  rulerGroup.addEventListener('dragleave', event => {
    if (!rulerGroup.contains(event.relatedTarget)) rulerGroup.classList.remove('act-drop-over');
  });
  rulerGroup.addEventListener('drop', event => {
    if (!event.dataTransfer.types.includes('application/x-timeline-act')) return;
    event.preventDefault();
    event.stopPropagation();
    rulerGroup.classList.remove('act-drop-over');
    const sourceKey = event.dataTransfer.getData('application/x-timeline-act');
    const before = event.clientX < rulerGroup.getBoundingClientRect().left
      + rulerGroup.getBoundingClientRect().width / 2;
    reorderTimelineActs(sourceKey, actKey, before);
  });
}

const MIN_SFX_SEGMENT_SECONDS = 0.25;

function normalizeSelectedAudioSegment(audio) {
  if (!audio) return null;
  const natural = Number(audio.sourceDurationSeconds || audio.duration || audio.durationSeconds);
  if (!(natural > 0)) return null;
  const trimStart = Math.max(0, Math.min(Number(audio.trimStartSeconds) || 0,
    Math.max(0, natural - MIN_SFX_SEGMENT_SECONDS)));
  const requestedDuration = Number(audio.durationSeconds);
  const duration = Math.max(MIN_SFX_SEGMENT_SECONDS, Math.min(
    requestedDuration > 0 ? requestedDuration : natural - trimStart,
    natural - trimStart));
  audio.sourceDurationSeconds = natural;
  audio.trimStartSeconds = trimStart;
  audio.durationSeconds = duration;
  if (!Number.isFinite(Number(audio.timelineOffsetSeconds))) audio.timelineOffsetSeconds = 0;
  return { naturalDurationSeconds: natural, trimStartSeconds: trimStart, durationSeconds: duration };
}

function getSelectedSfxDuration(section) {
  const segment = normalizeSelectedAudioSegment(section && section.selectedAudio);
  return segment ? segment.durationSeconds : 0;
}

// Greedy interval packing: each event goes in the first lane whose previous
// clip has ended. The same lane number is exported to Premiere, so the browser
// timeline and the real sequence represent overlaps identically.
function allocateSfxLanes(events) {
  const laneEnds = [];
  events.slice().sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds).forEach(event => {
    let lane = laneEnds.findIndex(end => end <= event.startSeconds + 0.001);
    if (lane === -1) lane = laneEnds.length;
    event.lane = lane;
    laneEnds[lane] = event.endSeconds;
  });
  return Math.max(1, laneEnds.length);
}

function wireSfxClipTrim(handle, clip, label, sfxEvent, edge, timelineDuration) {
  handle.addEventListener('pointerdown', pointerEvent => {
    pointerEvent.preventDefault();
    pointerEvent.stopPropagation();
    const trackWidth = clip.parentElement.getBoundingClientRect().width || 1;
    const secondsPerPixel = Math.max(timelineDuration, 0.001) / trackWidth;
    const startX = pointerEvent.clientX;
    const initialTrim = sfxEvent.sourceStartSeconds;
    const initialDuration = sfxEvent.selectedDurationSeconds;
    const initialSourceEnd = initialTrim + initialDuration;
    const timelineRoom = Math.max(MIN_SFX_SEGMENT_SECONDS,
      timelineDuration - sfxEvent.startSeconds);
    let nextTrim = initialTrim;
    let nextDuration = initialDuration;
    try { handle.setPointerCapture(pointerEvent.pointerId); } catch (err) { /* optional */ }

    const redraw = () => {
      const visibleDuration = Math.min(nextDuration, timelineRoom);
      clip.style.width = `${(visibleDuration / Math.max(timelineDuration, 0.001)) * 100}%`;
      label.textContent = `${sfxEvent.name} · ${nextTrim.toFixed(1)}–${(nextTrim + nextDuration).toFixed(1)}s`;
      clip.title = `${sfxEvent.name} · source ${nextTrim.toFixed(1)}–${(nextTrim + nextDuration).toFixed(1)}s · ${nextDuration.toFixed(1)}s`;
    };
    const onMove = moveEvent => {
      const delta = Math.round((moveEvent.clientX - startX) * secondsPerPixel * 10) / 10;
      if (edge === 'start') {
        nextTrim = Math.max(0, Math.min(initialTrim + delta,
          initialSourceEnd - MIN_SFX_SEGMENT_SECONDS));
        nextDuration = initialSourceEnd - nextTrim;
      } else {
        nextDuration = Math.max(MIN_SFX_SEGMENT_SECONDS, Math.min(
          initialDuration + delta,
          sfxEvent.sourceDurationSeconds - initialTrim,
          timelineRoom));
      }
      redraw();
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      try { handle.releasePointerCapture(pointerEvent.pointerId); } catch (err) { /* optional */ }
      sfxEvent.audioClip.trimStartSeconds = nextTrim;
      sfxEvent.audioClip.durationSeconds = nextDuration;
      normalizeSelectedAudioSegment(sfxEvent.audioClip);
      saveDebugSession();
      const remaining = currentSections.filter(section => !section.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}

function wireSfxClipMove(clip, label, sfxEvent, timelineDuration) {
  clip.addEventListener('pointerdown', pointerEvent => {
    if (pointerEvent.target.closest('.premiere-sfx-trim-handle')) return;
    pointerEvent.preventDefault();
    pointerEvent.stopPropagation();
    const trackWidth = clip.parentElement.getBoundingClientRect().width || 1;
    const secondsPerPixel = Math.max(timelineDuration, 0.001) / trackWidth;
    const startX = pointerEvent.clientX;
    const initialStart = sfxEvent.startSeconds;
    const maxStart = Math.max(0,
      timelineDuration - Math.min(sfxEvent.selectedDurationSeconds, timelineDuration));
    let nextStart = initialStart;
    let moved = false;
    clip.classList.add('dragging');
    try { clip.setPointerCapture(pointerEvent.pointerId); } catch (err) { /* optional */ }

    const onMove = moveEvent => {
      const delta = Math.round((moveEvent.clientX - startX) * secondsPerPixel * 10) / 10;
      if (Math.abs(moveEvent.clientX - startX) > 2) moved = true;
      nextStart = Math.max(0, Math.min(initialStart + delta, maxStart));
      clip.style.left = `${(nextStart / Math.max(timelineDuration, 0.001)) * 100}%`;
      label.textContent = `${sfxEvent.name} · @ ${nextStart.toFixed(1)}s`;
      clip.title = `${sfxEvent.name} · timeline ${nextStart.toFixed(1)}s · drag to move`;
    };
    const onUp = () => {
      clip.removeEventListener('pointermove', onMove);
      clip.removeEventListener('pointerup', onUp);
      try { clip.releasePointerCapture(pointerEvent.pointerId); } catch (err) { /* optional */ }
      clip.classList.remove('dragging');
      if (!moved) return;
      // Once deliberately moved, the SFX is an independent absolute-time
      // timeline clip rather than following the scene where it was chosen.
      sfxEvent.audioClip.timelineStartSeconds = nextStart;
      delete sfxEvent.audioClip.timelineOffsetSeconds;
      saveDebugSession();
      const remaining = currentSections.filter(section => !section.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
    };
    clip.addEventListener('pointermove', onMove);
    clip.addEventListener('pointerup', onUp);
  });
}

let activeSfxLayout = null;
let sfxPreviewEnabled = false;
let sfxPreviewSources = [];
let sfxPreviewAnimationId = null;
let sfxPreviewAnchorCtxTime = 0;
let sfxPreviewAnchorTimelineTime = 0;
let sfxPreviewRequestId = 0;
let sfxPlayheadEl = null;
let activeSfxSectionIndex = null;
let timelinePreviewScrolledSectionIndex = null;
let timelinePreviewProgrammaticScrollUntil = 0;
let timelinePreviewPausedTime = null;
let timelinePreviewPausedSectionIndex = null;
let premiereTimelineCollapsed = false;

// Each module relocated into storyboard.html's left sidebar keeps its own
// open/closed state.  This mirrors the Premiere timeline's collapse affordance
// without hiding the other sidebar modules when one is tucked away.
let sidebarModuleCollapsed = Object.create(null);
// Keep the optional storyboard sidebar out of the way on a fresh load. The
// existing Show panels toggle can reveal it, and the choice is persisted for
// subsequent refreshes once the presenter changes it.
let sidebarPanelsCollapsed = true;
const sfxAudioBufferCache = new Map();

function stopSfxPreview(disable) {
  sfxPreviewRequestId += 1;
  sfxPreviewSources.forEach(source => {
    try { source.stop(); } catch (err) { /* already stopped */ }
    try { source.disconnect(); } catch (err) { /* already disconnected */ }
  });
  sfxPreviewSources = [];
  if (sfxPreviewAnimationId) cancelAnimationFrame(sfxPreviewAnimationId);
  sfxPreviewAnimationId = null;
  if (disable) {
    sfxPreviewEnabled = false;
    timelinePreviewPausedTime = null;
    timelinePreviewPausedSectionIndex = null;
  }
  if (disable) document.querySelectorAll('.premiere-sfx-playhead').forEach(el => { el.style.display = 'none'; });
  if (disable) timelinePreviewScrolledSectionIndex = null;
}

function ensureSfxAudioBuffer(event) {
  if (event.kind === 'narration') {
    return ensureNarrationClipDecoded(event.audioClip).then(buffer => {
      if (activeSfxLayout) {
        event.endSeconds = Math.min(
          activeSfxLayout.durationSeconds, event.startSeconds + buffer.duration);
        event.durationSeconds = Math.max(0, event.endSeconds - event.startSeconds);
      }
      return buffer;
    });
  }
  const url = event.previewUrl;
  if (!url) return Promise.reject(new Error('Sound effect has no local preview URL.'));
  if (sfxAudioBufferCache.has(url)) return sfxAudioBufferCache.get(url);
  const promise = fetch(url)
    .then(response => {
      if (!response.ok) throw new Error(`Could not load sound effect (${response.status}).`);
      return response.arrayBuffer();
    })
    .then(bytes => ensurePlaybackAudioCtx().decodeAudioData(bytes))
    .catch(err => {
      sfxAudioBufferCache.delete(url);
      throw err;
    });
  sfxAudioBufferCache.set(url, promise);
  return promise;
}

function updateSfxPlayhead(timelineTime) {
  if (!activeSfxLayout || !sfxPlayheadEl) return;
  const duration = Math.max(activeSfxLayout.durationSeconds, 0.001);
  const bounded = Math.max(0, Math.min(timelineTime, duration));
  sfxPlayheadEl.style.display = '';
  sfxPlayheadEl.style.left = `${(bounded / duration) * 100}%`;
  document.querySelectorAll('.premiere-sfx-playhead').forEach(playhead => {
    playhead.style.display = '';
    playhead.style.left = `${(bounded / duration) * 100}%`;
  });
  activeSfxLayout.audioEvents.forEach(event => {
    if (!event.clipEl) return;
    const progress = Math.max(0, Math.min(1, (bounded - event.startSeconds) / Math.max(event.durationSeconds, 0.001)));
    event.clipEl.style.setProperty('--sfx-progress', `${progress * 100}%`);
    event.clipEl.classList.toggle('playing', bounded >= event.startSeconds && bounded < event.endSeconds);
  });
}

function startSfxPreviewAt(timelineTime) {
  if (!sfxPreviewEnabled || !activeSfxLayout) return;
  stopNarrationPlayback();
  stopSfxPreview(false);
  const requestId = sfxPreviewRequestId;
  const layoutAtStart = activeSfxLayout;
  const time = Math.max(0, Math.min(timelineTime, layoutAtStart.durationSeconds));
  // Narration duration may only become authoritative after decoding (notably
  // on a restored session), so load narration even when its provisional scene
  // duration says it ended; the decoded duration below decides spillover.
  const playable = layoutAtStart.audioEvents.filter(event =>
    event.previewUrl && (event.kind === 'narration' || event.endSeconds > time));
  const ctx = ensurePlaybackAudioCtx();
  if (ctx.state === 'suspended') ctx.resume();

  Promise.all(playable.map(event => ensureSfxAudioBuffer(event).then(buffer => ({ event, buffer })).catch(() => null)))
    .then(loaded => {
      if (!sfxPreviewEnabled || activeSfxLayout !== layoutAtStart || requestId !== sfxPreviewRequestId) return;
      sfxPreviewAnchorCtxTime = ctx.currentTime;
      sfxPreviewAnchorTimelineTime = time;
      loaded.filter(Boolean).forEach(({ event, buffer }) => {
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        const gain = ctx.createGain();
        gain.gain.value = event.kind === 'narration' ? 1.0 : 0.5;
        source.connect(gain);
        gain.connect(ctx.destination);
        const delay = Math.max(0, event.startSeconds - time);
        const timelineOffset = Math.max(0, time - event.startSeconds);
        const offset = Math.max(0, Number(event.sourceStartSeconds) || 0) + timelineOffset;
        const remaining = Math.min(buffer.duration - offset, event.endSeconds - Math.max(time, event.startSeconds));
        if (remaining > 0.001) {
          source.start(ctx.currentTime + delay, offset, remaining);
          sfxPreviewSources.push(source);
        }
      });
      const draw = () => {
        if (!sfxPreviewEnabled || activeSfxLayout !== layoutAtStart) return;
        const now = sfxPreviewAnchorTimelineTime + (ctx.currentTime - sfxPreviewAnchorCtxTime);
        updateSfxPlayhead(now);
        const sceneWindow = layoutAtStart.sceneWindows.find(
          windowSpec => now >= windowSpec.startSeconds && now < windowSpec.endSeconds);
        if (sceneWindow && timelinePreviewScrolledSectionIndex !== sceneWindow.sectionIndex) {
          timelinePreviewScrolledSectionIndex = sceneWindow.sectionIndex;
          activeSfxSectionIndex = sceneWindow.sectionIndex;
          const target = document.querySelector(
            `.paper-section-block[data-section-index="${sceneWindow.sectionIndex}"]`);
          if (target) {
            timelinePreviewProgrammaticScrollUntil = performance.now() + 1200;
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }
        if (now >= layoutAtStart.durationSeconds) {
          stopSfxPreview(true);
          return;
        }
        sfxPreviewAnimationId = requestAnimationFrame(draw);
      };
      draw();
    });
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopSfxPreview(true);
});

// Spacebar is the single timeline transport. It starts from the scene currently
// active in the scrollspy, mixes narration + all overlapping SFX, advances the
// global playhead, and follows subsequent scene cards as time passes.
document.addEventListener('keydown', event => {
  if (event.code !== 'Space' || event.repeat || !activeSfxLayout) return;
  const target = event.target;
  if (target && (target.matches('input, textarea, select, button') || target.isContentEditable)) return;
  event.preventDefault();
  if (sfxPreviewEnabled) {
    const pausedAt = sfxPreviewAnchorTimelineTime
      + (ensurePlaybackAudioCtx().currentTime - sfxPreviewAnchorCtxTime);
    const pausedSection = activeSfxSectionIndex;
    stopSfxPreview(true);
    timelinePreviewPausedTime = pausedAt;
    timelinePreviewPausedSectionIndex = pausedSection;
    return;
  }
  if (!activeSfxLayout.audioEvents.length) return;
  sfxPreviewEnabled = true;
  timelinePreviewScrolledSectionIndex = null;
  const resumeHere = timelinePreviewPausedSectionIndex === activeSfxSectionIndex
    && Number.isFinite(timelinePreviewPausedTime);
  const start = resumeHere
    ? timelinePreviewPausedTime
    : (activeSfxLayout.sceneStartSeconds.get(activeSfxSectionIndex) || 0);
  timelinePreviewPausedTime = null;
  timelinePreviewPausedSectionIndex = null;
  startSfxPreviewAt(start);
});

function buildNarrativeTimeline(timelineEl, sections, assignmentsByIndex) {
  timelineEl.innerHTML = '';
  timelineEl.classList.toggle('collapsed', premiereTimelineCollapsed);

  const timelineHeader = document.createElement('div');
  timelineHeader.className = 'premiere-timeline-header';
  const timelineTitle = document.createElement('span');
  timelineTitle.textContent = 'Timeline';
  timelineHeader.appendChild(timelineTitle);
  // const timelineHint = document.createElement('span');
  // timelineHint.className = 'premiere-timeline-header-hint';
  // timelineHint.textContent = 'Drag Act headers to reorder · drag scene clips to rearrange or resize';
  // timelineHeader.appendChild(timelineHint);
  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'premiere-timeline-collapse-btn';
  const updateCollapseButton = () => {
    const action = premiereTimelineCollapsed ? 'Expand' : 'Collapse';
    collapseBtn.textContent = premiereTimelineCollapsed ? '▾' : '▴';
    collapseBtn.title = `${action} Timeline`;
    collapseBtn.setAttribute('aria-label', `${action} Timeline`);
    collapseBtn.setAttribute('aria-expanded', String(!premiereTimelineCollapsed));
  };
  updateCollapseButton();
  collapseBtn.addEventListener('click', () => {
    premiereTimelineCollapsed = !premiereTimelineCollapsed;
    timelineEl.classList.toggle('collapsed', premiereTimelineCollapsed);
    updateCollapseButton();
    saveDebugSession();
    collapseBtn.blur(); // next Space press remains the global audio transport
  });
  timelineHeader.appendChild(collapseBtn);
  timelineEl.appendChild(timelineHeader);

  // The ruler mirrors a track's structure (a label-width spacer + a body)
  // so its act labels line up exactly with the clip groups in the track
  // bodies below - see the .premiere-timeline-ruler* CSS. Acts go into
  // rulerBody, not the ruler directly.
  const ruler = document.createElement('div');
  ruler.className = 'premiere-timeline-ruler';
  const rulerSpacer = document.createElement('div');
  rulerSpacer.className = 'premiere-timeline-ruler-spacer';
  ruler.appendChild(rulerSpacer);
  const rulerBody = document.createElement('div');
  rulerBody.className = 'premiere-timeline-ruler-body';
  ruler.appendChild(rulerBody);
  timelineEl.appendChild(ruler);

  // Primary and Cutaway are mutually-exclusive visual scene roles. Sound
  // effects form an independent parallel track populated from selectedAudio,
  // so any visual scene can have one without moving visual lanes.
  const TRACK_DEFS = [
    { key: 'narration', label: 'NARRATION' },
    { key: 'footage', label: 'FOOTAGE' },
    { key: 'soundEffects', label: 'SOUND EFFECTS' },
  ];
  const trackBodies = TRACK_DEFS.map(def => buildTimelineTrack(timelineEl, def.label));

  // Dropping a mode onto an act scaffolds scenes there (see
  // scaffoldModeOntoAct). The whole act column - the ruler label plus every
  // track group - is ONE drop unit (actEls): hovering any of them highlights
  // them all together, so it reads as dropping onto the act, not a single
  // track. The highlight persists while the pointer moves between the act's
  // own rows and only clears when it leaves the act entirely.
  const makeActModeDropTarget = (el, actKey, actEls) => {
    const setHighlight = on => actEls.forEach(e => e.classList.toggle('mode-drop-over', on));
    el.addEventListener('dragover', event => {
      if (!event.dataTransfer.types.includes('application/x-documentary-mode')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setHighlight(true);
    });
    el.addEventListener('dragleave', event => {
      const to = event.relatedTarget;
      if (to && actEls.some(e => e === to || e.contains(to))) return; // still within this act
      setHighlight(false);
    });
    el.addEventListener('drop', event => {
      setHighlight(false);
      const modeKey = event.dataTransfer.getData('application/x-documentary-mode');
      if (!modeKey || !MODE_SCENE_TEMPLATES[modeKey]) return;
      event.preventDefault();
      scaffoldModeOntoAct(actKey, modeKey);
    });
  };

  const clipsBySectionIndex = new Map();
  const sceneStartSeconds = new Map();
  const actLayouts = [];
  let globalActStart = 0;

  currentArcSections.forEach((act, actIndex) => {
    const rowSections = sections.filter(s => assignmentsByIndex[s.index] === act.key);
    if (rowSections.length === 0) return; // renderMovieEditor auto-populates blank rows before this runs

    // Each scene sits in its own role's track as one clip spec, sized by its
    // duration in seconds. An expository scene additionally contributes one
    // B-roll clip spec PER cutaway. `combinedAB` keeps the A-roll/B-roll clips
    // in reading order (for the interspersed layout below).
    const clipsByTrack = { aRoll: [], bRoll: [], soundEffects: [] };
    const combinedAB = [];
    rowSections.forEach(section => {
      const role = getSceneRole(section);
      const spec = {
        kind: 'section', section, seconds: getSceneDuration(section),
        filled: isSceneFilledForRole(section, role),
        drafted: !isSceneFilledForRole(section, role) && isSceneDraftedForRole(section, role),
        title: section.title,
      };
      // Once an expository primary scene has generated cutaways, those
      // cutaways ARE its picture edit. Keep narration in the parallel audio
      // mix, but do not also draw a primary visual underneath them.
      const cutawaysReplacePrimary = role === 'aRoll' && section.cutaways && section.cutaways.length;
      if (!cutawaysReplacePrimary) {
        clipsByTrack[role].push(spec);
        if (role === 'aRoll' || role === 'bRoll') combinedAB.push({ roleKey: role, spec });
      }
      if (section.cutaways && section.cutaways.length) {
        section.cutaways.forEach((cut, ci) => {
          const cutawaySpec = {
            kind: 'cutaway', section, cutaway: cut, cutawayIndex: ci,
            seconds: getCutawayDuration(cut),
            // Cutaways are generated visual suggestions, not open-slot media;
            // only an uploaded or deliberately dragged-in reference should
            // turn the FOOTAGE lane blue for this scene.
            filled: hasSceneOpenSlotMedia(section),
            drafted: false,
            title: `${cut.caption || 'Cutaway'} · Cutaway`,
          };
          clipsByTrack.bRoll.push(cutawaySpec);
          combinedAB.push({ roleKey: 'bRoll', spec: cutawaySpec });
        });
      }
    });

    // Primary and Cutaway are one sequential visual edit: every clip receives
    // a unique time range and the opposite lane gets a spacer. This invariant
    // also applies to generated expository cutaways—visual tracks never overlap.
    // Narration and SFX remain independent audio layers and may span these cuts.
    let t = 0;
    combinedAB.forEach(c => {
      c.start = t;
      if (!sceneStartSeconds.has(c.spec.section.index)) {
        sceneStartSeconds.set(c.spec.section.index, globalActStart + t);
      }
      t += c.spec.seconds;
    });
    const actTotal = Math.max(1, t);
    actLayouts.push({ key: act.key, startSeconds: globalActStart, durationSeconds: actTotal });

    // flex-basis pinned to 0 (not the shorthand's implied auto) so the ruler
    // label's own text width doesn't compete with its flex-grow share and
    // misalign the ruler against the content-less clips below it.
    const actFlex = `${actTotal} 1 0`;

    const rulerGroup = document.createElement('div');
    rulerGroup.className = 'premiere-timeline-act';
    rulerGroup.style.flex = actFlex;
    rulerGroup.textContent = `Act ${actIndex + 1}: ${act.label}`;
    rulerGroup.title = 'Drag this act to reorder it; drag a documentary mode here to scaffold scenes';
    rulerBody.appendChild(rulerGroup);
    wireTimelineActDrag(rulerGroup, act.key);

    const trackGroups = trackBodies.map((body, trackIndex) => {
      const group = document.createElement('div');
      group.className = 'premiere-timeline-act-group';
      group.style.flex = actFlex;
      group.dataset.actKey = act.key;
      group.dataset.role = trackIndex === 1 ? 'visual' : TRACK_DEFS[trackIndex].key;
      body.appendChild(group);
      return group;
    });

    // Ruler label + all track groups are one drop unit (highlight together).
    const actDropEls = [rulerGroup, ...trackGroups];
    actDropEls.forEach(el => makeActModeDropTarget(el, act.key, actDropEls));

    const buildClip = spec => {
      const { section, seconds } = spec;
      const clip = document.createElement('div');
      clip.className = 'premiere-timeline-clip';
      if (spec.kind === 'cutaway') clip.classList.add('cutaway-clip');
      clip.style.flex = `${seconds} 1 0`; // width proportional to duration
      clip.dataset.sectionIndex = String(section.index);
      clip.classList.toggle('filled', spec.filled);
      clip.classList.toggle('drafted', spec.drafted);
      clip.title = `${spec.title} · ${Math.round(seconds)}s · Drag to rearrange; drag the right edge to resize`;
      clip.addEventListener('click', event => {
        if (event.detail > 1 || event.target.closest('.premiere-timeline-clip-handle')) return;
        scrollTimelineClipToScene(section.index);
      });
      const handle = document.createElement('div');
      handle.className = 'premiere-timeline-clip-handle';
      handle.title = 'Drag to change this scene duration';
      clip.appendChild(handle);
      wireClipResize(handle, clip, spec);
      if (spec.kind !== 'cutaway') wireClipDrag(clip, section);
      if (!clipsBySectionIndex.has(section.index)) clipsBySectionIndex.set(section.index, []);
      clipsBySectionIndex.get(section.index).push(clip);
      return clip;
    };
    const addSpacer = (group, seconds) => {
      if (seconds <= 0.001) return;
      const spacer = document.createElement('div');
      spacer.className = 'premiere-timeline-clip spacer';
      spacer.style.flex = `${seconds} 1 0`;
      group.appendChild(spacer);
    };

    TRACK_DEFS.forEach((def, ti) => {
      const group = trackGroups[ti];
      if (def.key === 'footage') {
        combinedAB.forEach(c => group.appendChild(buildClip(c.spec)));
      } else addSpacer(group, actTotal);
    });
    globalActStart += actTotal;
  });

  // Replace the per-act placeholder groups with one absolute-time SFX canvas.
  // This lets a natural-duration sound cross act boundaries, while lane packing
  // keeps overlapping effects visible and mirrors the Premiere export.
  const sfxBody = trackBodies[2];
  sfxBody.innerHTML = '';
  sfxBody.classList.add('premiere-sfx-track-body');
  const sfxEvents = sections.map(section => {
    const segment = normalizeSelectedAudioSegment(section.selectedAudio);
    const selectedDuration = segment && segment.durationSeconds;
    const sceneStart = sceneStartSeconds.get(section.index);
    if (!(selectedDuration > 0) || sceneStart == null || sceneStart >= globalActStart) return null;
    const storedTimelineStart = Number(section.selectedAudio.timelineStartSeconds);
    const requestedStart = Number.isFinite(storedTimelineStart)
      ? storedTimelineStart
      : sceneStart + (Number(section.selectedAudio.timelineOffsetSeconds) || 0);
    const latestStart = Math.max(0, globalActStart - Math.min(selectedDuration, globalActStart));
    const start = Math.max(0, Math.min(requestedStart, latestStart));
    const end = Math.min(globalActStart, start + selectedDuration);
    return {
      sectionIndex: section.index,
      section,
      audioClip: section.selectedAudio,
      name: section.selectedAudio.name || section.title || 'Sound effect',
      previewUrl: section.selectedAudio.localPreviewUrl || section.selectedAudio.preview_url || '',
      filePath: section.selectedAudio.localFilePath || null,
      sceneStartSeconds: sceneStart,
      startSeconds: start,
      endSeconds: end,
      durationSeconds: end - start,
      selectedDurationSeconds: selectedDuration,
      sourceStartSeconds: segment.trimStartSeconds,
      sourceDurationSeconds: segment.naturalDurationSeconds,
    };
  }).filter(Boolean);
  const narrationEvents = sections.flatMap(section => {
    const sceneStart = sceneStartSeconds.get(section.index);
    if (sceneStart == null) return [];
    return migrateNarrationClips(section).map(audioClip => {
      const segment = normalizeSelectedAudioSegment(audioClip);
      if (!segment) return null;
      const stored = Number(audioClip.timelineStartSeconds);
      const requested = Number.isFinite(stored)
        ? stored : sceneStart + (Number(audioClip.timelineOffsetSeconds) || 0);
      const start = Math.max(0, Math.min(requested, Math.max(0, globalActStart - MIN_SFX_SEGMENT_SECONDS)));
      const end = Math.min(globalActStart, start + segment.durationSeconds);
      return {
        kind: 'narration', sectionIndex: section.index, section, audioClip,
        name: 'Narration',
        previewUrl: audioClip.previewUrl, filePath: audioClip.filePath || null,
        startSeconds: start, endSeconds: end, durationSeconds: end - start,
        selectedDurationSeconds: segment.durationSeconds,
        sourceStartSeconds: segment.trimStartSeconds,
        sourceDurationSeconds: segment.naturalDurationSeconds,
      };
    }).filter(Boolean);
  });
  allocateSfxLanes(narrationEvents);
  const laneCount = allocateSfxLanes(sfxEvents);
  sfxBody.style.height = `${laneCount * 25}px`;

  actLayouts.forEach(act => {
    const zone = document.createElement('div');
    zone.className = 'premiere-sfx-act-zone';
    zone.style.left = `${(act.startSeconds / Math.max(globalActStart, 1)) * 100}%`;
    zone.style.width = `${(act.durationSeconds / Math.max(globalActStart, 1)) * 100}%`;
    sfxBody.appendChild(zone);
  });
  sfxEvents.forEach(event => {
    const clip = document.createElement('div');
    clip.className = 'premiere-sfx-clip filled';
    clip.dataset.sectionIndex = String(event.sectionIndex);
    clip.style.left = `${(event.startSeconds / Math.max(globalActStart, 1)) * 100}%`;
    clip.style.width = `${(event.durationSeconds / Math.max(globalActStart, 1)) * 100}%`;
    clip.style.top = `${event.lane * 25}px`;
    clip.title = `${event.name} · timeline ${event.startSeconds.toFixed(1)}s · source ${event.sourceStartSeconds.toFixed(1)}–${(event.sourceStartSeconds + event.selectedDurationSeconds).toFixed(1)}s · drag clip to move`;
    const label = document.createElement('span');
    label.textContent = `${event.name} · ${event.sourceStartSeconds.toFixed(1)}–${(event.sourceStartSeconds + event.selectedDurationSeconds).toFixed(1)}s`;
    clip.appendChild(label);
    const trimInHandle = document.createElement('span');
    trimInHandle.className = 'premiere-sfx-trim-handle start';
    trimInHandle.title = 'Drag to choose where the selected source segment begins';
    clip.appendChild(trimInHandle);
    const trimOutHandle = document.createElement('span');
    trimOutHandle.className = 'premiere-sfx-trim-handle end';
    trimOutHandle.title = 'Drag to change the selected sound duration';
    clip.appendChild(trimOutHandle);
    wireSfxClipTrim(trimInHandle, clip, label, event, 'start', globalActStart);
    wireSfxClipTrim(trimOutHandle, clip, label, event, 'end', globalActStart);
    wireSfxClipMove(clip, label, event, globalActStart);
    clip.addEventListener('click', clickEvent => {
      if (clickEvent.target.closest('.premiere-sfx-trim-handle')) return;
      scrollTimelineClipToScene(event.sectionIndex);
    });
    sfxBody.appendChild(clip);
    event.clipEl = clip;
    if (!clipsBySectionIndex.has(event.sectionIndex)) clipsBySectionIndex.set(event.sectionIndex, []);
    clipsBySectionIndex.get(event.sectionIndex).push(clip);
  });

  // Narration is a second independently timed, multi-lane audio canvas. It
  // uses the same clip mover/trimmers as SFX, including source-in selection.
  const narrationBody = trackBodies[0];
  narrationBody.innerHTML = '';
  narrationBody.classList.add('premiere-sfx-track-body');
  const narrationLaneCount = allocateSfxLanes(narrationEvents);
  narrationBody.style.height = `${narrationLaneCount * 25}px`;
  actLayouts.forEach(act => {
    const zone = document.createElement('div');
    zone.className = 'premiere-sfx-act-zone';
    zone.style.left = `${(act.startSeconds / Math.max(globalActStart, 1)) * 100}%`;
    zone.style.width = `${(act.durationSeconds / Math.max(globalActStart, 1)) * 100}%`;
    narrationBody.appendChild(zone);
  });
  narrationEvents.forEach(event => {
    const clip = document.createElement('div');
    clip.className = 'premiere-sfx-clip premiere-narration-clip filled';
    clip.dataset.sectionIndex = String(event.sectionIndex);
    clip.style.left = `${(event.startSeconds / Math.max(globalActStart, 1)) * 100}%`;
    clip.style.width = `${(event.durationSeconds / Math.max(globalActStart, 1)) * 100}%`;
    clip.style.top = `${event.lane * 25}px`;
    const label = document.createElement('span');
    label.textContent = `${event.name} · ${event.sourceStartSeconds.toFixed(1)}–${(event.sourceStartSeconds + event.selectedDurationSeconds).toFixed(1)}s`;
    clip.appendChild(label);
    ['start', 'end'].forEach(edge => {
      const handle = document.createElement('span');
      handle.className = `premiere-sfx-trim-handle ${edge}`;
      clip.appendChild(handle);
      wireSfxClipTrim(handle, clip, label, event, edge, globalActStart);
    });
    wireSfxClipMove(clip, label, event, globalActStart);
    clip.addEventListener('click', clickEvent => {
      if (clickEvent.target.closest('.premiere-sfx-trim-handle')) return;
      scrollTimelineClipToScene(event.sectionIndex);
    });
    narrationBody.appendChild(clip);
    event.clipEl = clip;
    ensureSfxAudioBuffer(event).catch(() => { });
  });
  const narrationPlayhead = document.createElement('div');
  narrationPlayhead.className = 'premiere-sfx-playhead';
  narrationPlayhead.style.display = 'none';
  narrationBody.appendChild(narrationPlayhead);
  const playhead = document.createElement('div');
  playhead.className = 'premiere-sfx-playhead';
  playhead.style.display = 'none';
  sfxBody.appendChild(playhead);

  // const sfxTrackLabel = sfxBody.parentElement.querySelector('.premiere-timeline-track-label');
  // const previewHint = document.createElement('span');
  // previewHint.className = 'premiere-audio-preview-hint';
  // previewHint.textContent = 'SPACE · AUDIO';
  // previewHint.title = 'Press Space to play or pause narration and sound effects from the active scene';
  // sfxTrackLabel.appendChild(previewHint);

  const sceneWindows = Array.from(sceneStartSeconds.entries())
    .map(([sectionIndex, startSeconds]) => ({ sectionIndex, startSeconds }))
    .sort((a, b) => a.startSeconds - b.startSeconds);
  sceneWindows.forEach((windowSpec, index) => {
    windowSpec.endSeconds = index + 1 < sceneWindows.length
      ? sceneWindows[index + 1].startSeconds : globalActStart;
  });
  activeSfxLayout = {
    durationSeconds: globalActStart, sceneStartSeconds, actLayouts, sfxEvents,
    narrationEvents, audioEvents: [...narrationEvents, ...sfxEvents], sceneWindows,
  };
  sfxPlayheadEl = playhead;
  sfxEvents.forEach(event => ensureSfxAudioBuffer(event).catch(() => { }));

  return { clipsBySectionIndex, layout: activeSfxLayout };
}

function moveSceneOnActBoard(sourceIndex, targetIndex, targetActKey) {
  if (sourceIndex == null || !targetActKey) return;
  const sourcePosition = currentSections.findIndex(section => section.index === sourceIndex);
  if (sourcePosition === -1) return;
  const [source] = currentSections.splice(sourcePosition, 1);

  let insertPosition = currentSections.length;
  if (targetIndex != null) {
    const targetPosition = currentSections.findIndex(section => section.index === targetIndex);
    if (targetPosition !== -1) insertPosition = targetPosition;
  } else {
    // Appending to an act means placing the scene after that act's last scene
    // in the shared section order, while leaving all source material intact.
    currentSections.forEach((section, index) => {
      if (currentAssignments[section.index] === targetActKey) insertPosition = index + 1;
    });
  }
  currentSections.splice(insertPosition, 0, source);
  currentAssignments[sourceIndex] = targetActKey;
  saveDebugSession();
  const remaining = currentSections.filter(section => !section.removed);
  renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
}

function actBoardNodesForAct(actKey) {
  if (!Array.isArray(actBoardNodes[actKey])) actBoardNodes[actKey] = [];
  return actBoardNodes[actKey];
}

function actBoardScenesForAct(actKey) {
  if (!Array.isArray(actBoardScenes[actKey])) actBoardScenes[actKey] = [];
  return actBoardScenes[actKey];
}

function actBoardDefaultSceneMode() {
  if (DOCUMENTARY_MODES.some(mode => mode.key === actBoardSetupMode)) {
    return actBoardSetupMode;
  }
  const moodboardMode = lastDistillResult?.suggested_mode;
  if (DOCUMENTARY_MODES.some(mode => mode.key === selectedDocumentaryMode)) {
    return selectedDocumentaryMode;
  }
  if (DOCUMENTARY_MODES.some(mode => mode.key === moodboardMode)) return moodboardMode;
  return DOCUMENTARY_MODES[0].key;
}

function normalizeActBoardSceneMode(scene) {
  if (!scene || typeof scene !== 'object') return actBoardDefaultSceneMode();
  if (!DOCUMENTARY_MODES.some(mode => mode.key === scene.documentaryMode)) {
    scene.documentaryMode = actBoardDefaultSceneMode();
  }
  if (scene.documentaryModeSource !== 'user') scene.documentaryModeSource = 'moodboard';
  return scene.documentaryMode;
}

function syncActBoardSceneModesToSetupMode() {
  const mode = actBoardDefaultSceneMode();
  currentArcSections.forEach(act => {
    actBoardScenesForAct(act.key).forEach(scene => {
      normalizeActBoardSceneMode(scene);
      if (scene.documentaryModeSource !== 'user') {
        scene.documentaryMode = mode;
        scene.documentaryModeSource = 'moodboard';
      }
    });
  });
}

function ensureActBoardInitialScenes() {
  if (!currentArcSections.length) return false;
  let changed = false;
  currentArcSections.forEach(act => {
    const scenes = actBoardScenesForAct(act.key);
    scenes.forEach(scene => {
      const before = scene.documentaryMode;
      normalizeActBoardSceneMode(scene);
      if (before !== scene.documentaryMode) changed = true;
      if (scene.includeNarration == null) {
        scene.includeNarration = true;
        changed = true;
      }
      if (scene.sequenceStartNodeId === undefined) {
        scene.sequenceStartNodeId = null;
        changed = true;
      }
      // Starter boards created before the scene-card alignment used an 18px
      // inset. Migrate that legacy starter position to the same left edge as
      // the loadable scene card without disturbing other user-positioned boards.
      if (scene.title === 'Scene 1'
        && Number(scene.boardX) === 18) {
        scene.boardX = 0;
        changed = true;
      }
    });
    if (scenes.length || actBoardInitialSceneActKeys.has(act.key)) {
      actBoardInitialSceneActKeys.add(act.key);
      return;
    }
    const starterScene = {
      id: createActBoardSceneId(),
      actKey: act.key,
      title: 'Scene 1',
      nodeIds: [],
      nodeSnapshots: [],
      nodeLinks: [],
      documentaryMode: actBoardDefaultSceneMode(),
      documentaryModeSource: 'moodboard',
      includeNarration: true,
      sequenceStartNodeId: null,
      boardX: 0,
      boardY: 0,
      boardWidth: 560,
      boardHeight: 360,
      boardPositionMode: 'manual',
      committedToStack: true,
    };
    scenes.push(starterScene);
    ensureActBoardPlaybackNode(act.key, null, { create: true, sceneId: starterScene.id });
    setActBoardOpenScene(act.key, starterScene);
    actBoardInitialSceneActKeys.add(act.key);
    changed = true;
  });
  actBoardInitialScenesInitialized = true;
  return changed;
}

function actBoardSceneForNode(actKey, node) {
  if (!node) return null;
  const scenes = actBoardScenesForAct(actKey);
  const explicit = scenes.find(scene => scene.id === node.sceneId);
  if (explicit) return explicit;
  const listed = scenes.find(scene => (scene.nodeIds || []).includes(node.id));
  if (listed) return listed;
  const position = actBoardNodePosition(node, 0);
  return scenes.find(scene => scene.hidden !== true
    && position.x >= (Number(scene.boardX) || 0)
    && position.x <= (Number(scene.boardX) || 0) + Math.max(220, Number(scene.boardWidth) || 220)
    && position.y >= (Number(scene.boardY) || 0)
    && position.y <= (Number(scene.boardY) || 0) + Math.max(116, Number(scene.boardHeight) || 116)) || null;
}

function actBoardOpenSceneForAct(actKey) {
  const scenes = actBoardScenesForAct(actKey);
  const savedId = actBoardOpenSceneByAct?.[actKey];
  const saved = scenes.find(scene => scene.id === savedId && scene.hidden !== true);
  if (saved) return saved;
  const nodes = actBoardNodesForAct(actKey);
  // Restoring a scene replaces the live node array. Prefer the visible scene
  // represented by those live node sceneIds (including its playback node).
  const liveSceneIds = new Set(nodes.map(node => node.sceneId).filter(Boolean));
  const live = scenes.find(scene => scene.hidden !== true && liveSceneIds.has(scene.id));
  if (live) {
    actBoardOpenSceneByAct[actKey] = live.id;
    return live;
  }
  const fallback = scenes.find(scene => scene.hidden !== true && scene.liveNodesCleared !== true)
    || scenes.find(scene => scene.hidden !== true);
  if (fallback) actBoardOpenSceneByAct[actKey] = fallback.id;
  return fallback || null;
}

function setActBoardOpenScene(actKey, scene) {
  if (!actKey) return;
  if (scene?.id) actBoardOpenSceneByAct[actKey] = scene.id;
  else delete actBoardOpenSceneByAct[actKey];
}

function actBoardDocumentaryModeForNode(actKey, node) {
  const scene = actBoardSceneForNode(actKey, node);
  return scene ? normalizeActBoardSceneMode(scene) : actBoardDefaultSceneMode();
}

function attachActBoardNodeToScene(actKey, node, preferredScene = null) {
  const scene = preferredScene || actBoardSceneForNode(actKey, node);
  if (!scene) return null;
  node.sceneId = scene.id;
  scene.nodeIds = Array.from(new Set([...(scene.nodeIds || []), node.id]));
  scene.liveNodesCleared = false;
  const snapshot = snapshotActBoardSceneNode(node);
  if (snapshot) {
    scene.nodeSnapshots = (scene.nodeSnapshots || []).filter(item => item.id !== node.id);
    scene.nodeSnapshots.push(snapshot);
  }
  return scene;
}

function assignActBoardNodeToSceneAtPosition(actKey, node) {
  if (!node) return null;
  const position = actBoardNodePosition(node, 0);
  const scenes = actBoardScenesForAct(actKey);
  const target = scenes.find(scene => scene.hidden !== true
    && position.x >= (Number(scene.boardX) || 0)
    && position.x <= (Number(scene.boardX) || 0) + Math.max(220, Number(scene.boardWidth) || 220)
    && position.y >= (Number(scene.boardY) || 0)
    && position.y <= (Number(scene.boardY) || 0) + Math.max(116, Number(scene.boardHeight) || 116));
  if (!target) return null;
  scenes.forEach(scene => {
    scene.nodeIds = (scene.nodeIds || []).filter(id => id !== node.id || scene.id === target.id);
    if (scene.id !== target.id) {
      scene.nodeSnapshots = (scene.nodeSnapshots || []).filter(item => item.id !== node.id);
    }
  });
  node.sceneId = target.id;
  target.nodeIds = Array.from(new Set([...(target.nodeIds || []), node.id]));
  target.liveNodesCleared = false;
  const snapshot = snapshotActBoardSceneNode(node);
  if (snapshot) {
    target.nodeSnapshots = (target.nodeSnapshots || []).filter(item => item.id !== node.id);
    target.nodeSnapshots.push(snapshot);
  }
  return target;
}

function expandActBoardScenesToContainNodes(nodeStack, actKey, nodes) {
  if (!nodeStack) return;
  const source = Array.isArray(nodes) ? nodes : actBoardNodesForAct(actKey);
  const scenes = actBoardScenesForAct(actKey);
  const cards = new Map(Array.from(nodeStack.querySelectorAll('.storyboard-act-board-node[data-node-id]'))
    .map(card => [card.dataset.nodeId, card]));
  scenes.filter(scene => scene.hidden !== true).forEach(scene => {
    const included = source.filter(node => (scene.nodeIds || []).includes(node.id)
      || node.sceneId === scene.id);
    if (!included.length) return;
    const sceneCard = nodeStack.querySelector(`[data-board-scene-id="${scene.id}"]`);
    const sceneTopBefore = Number(scene.boardY) || 0;
    const sceneHeader = sceneCard?.querySelector('.storyboard-act-board-board-scene-header');
    const sceneNodeList = sceneCard?.querySelector('.storyboard-act-board-board-scene-node-list');
    const headerHeight = Math.max(32, Number(sceneHeader?.offsetHeight) || 0);
    const nodeListHeight = Math.max(0, Number(sceneNodeList?.offsetHeight) || 0);
    // The framed board header is absolutely positioned. Reserve a band below
    // it so the first narration/footage card cannot render underneath the
    // header when a scene is initially created or expanded.
    if (sceneCard && headerHeight > 0) {
      const firstTop = Math.min(...included.map(node => {
        const card = cards.get(node.id);
        const position = actBoardNodePosition(node, 0);
        return Number.isFinite(Number(card?.style?.top))
          ? Number.parseFloat(card.style.top) : position.y;
      }));
      const minimumNodeTop = sceneTopBefore + headerHeight + 10;
      if (firstTop < minimumNodeTop) {
        const delta = minimumNodeTop - firstTop;
        included.forEach(node => {
          const card = cards.get(node.id);
          const position = actBoardNodePosition(node, 0);
          node.boardY = position.y + delta;
          if (card) card.style.top = `${node.boardY}px`;
        });
      }
    }
    const positions = included.map(node => {
      const card = cards.get(node.id);
      const position = actBoardNodePosition(node, 0);
      const cardTop = Number.isFinite(Number(card?.style?.top))
        ? Number.parseFloat(card.style.top) : position.y;
      // Footage cards can finish their media/search layout one frame after
      // the board is rendered. Include both the rendered box and its full
      // scroll height so the framed scene never stops above the bottom of a
      // generated footage node.
      const renderedHeight = Math.max(
        Number(card?.offsetHeight) || 0,
        Number(card?.scrollHeight) || 0,
        Number(node.boardHeight) || 0,
        node.type === 'footage' ? 154 : 180,
      );
      return {
        top: cardTop,
        bottom: cardTop + renderedHeight,
      };
    });
    const minTop = Math.min(...positions.map(position => position.top));
    const maxBottom = Math.max(...positions.map(position => position.bottom));
    const sceneTop = Math.max(0, Math.min(Number(scene.boardY) || 0, minTop - 24));
    // The node summary is anchored to the bottom of the framed scene. Reserve
    // room for it and the header together so a wrapped list cannot be hidden
    // underneath the header or clipped by the scene surface.
    const headerAndListHeight = headerHeight + nodeListHeight + 28;
    const sceneHeight = Math.max(116, maxBottom - sceneTop + 32, headerAndListHeight);
    if (sceneTop !== (Number(scene.boardY) || 0)) {
      scene.boardY = sceneTop;
      if (sceneCard) sceneCard.style.top = `${sceneTop}px`;
    }
    if (sceneHeight > (Number(scene.boardHeight) || 116)) {
      scene.boardHeight = sceneHeight;
      if (sceneCard) sceneCard.style.height = `${sceneHeight}px`;
    }
    const currentMinHeight = parseFloat(nodeStack.style.minHeight) || 0;
    nodeStack.style.minHeight = `${Math.max(360, currentMinHeight, sceneTop + sceneHeight + 24)}px`;
  });
}

function createActBoardSceneId() {
  const suffix = window.crypto && typeof window.crypto.randomUUID === 'function'
    ? window.crypto.randomUUID().slice(0, 8)
    : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `act-board-scene-${suffix}`;
}

function nextActBoardSceneTitle(scenes) {
  const numbers = (Array.isArray(scenes) ? scenes : [])
    .map(scene => String(scene?.title || '').match(/^Scene\s+(\d+)$/i)?.[1])
    .map(value => Number(value))
    .filter(Number.isFinite);
  return `Scene ${(numbers.length ? Math.max(...numbers) : 0) + 1}`;
}

function createActBoardEmptyScene(actKey, sourceScene = null) {
  const scenes = actBoardScenesForAct(actKey);
  const mode = sourceScene ? normalizeActBoardSceneMode(sourceScene) : actBoardDefaultSceneMode();
  const scene = {
    id: createActBoardSceneId(),
    actKey,
    title: nextActBoardSceneTitle(scenes),
    nodeIds: [],
    nodeSnapshots: [],
    nodeLinks: [],
      documentaryMode: mode,
      documentaryModeSource: 'moodboard',
      includeNarration: sourceScene?.includeNarration !== false,
      sequenceStartNodeId: null,
    boardX: sourceScene ? Number(sourceScene.boardX) || 0 : 0,
    boardY: sourceScene ? Number(sourceScene.boardY) || 0 : 0,
    boardWidth: sourceScene ? Number(sourceScene.boardWidth) || 560 : 560,
    boardHeight: sourceScene ? Number(sourceScene.boardHeight) || 360 : 360,
    boardPositionMode: 'manual',
    committedToStack: true,
  };
  scenes.push(scene);
  ensureActBoardPlaybackNode(actKey, null, { create: true, sceneId: scene.id });
  setActBoardOpenScene(actKey, scene);
  return scene;
}

// A defined board scene survives rerenders and can be restored independently
// from the live node canvas. Keep a compact, renderable snapshot rather than
// retaining DOM/native-media state in the saved session.
function snapshotActBoardSceneNode(node) {
  if (!node) return null;
  let snapshot = null;
  try {
    snapshot = JSON.parse(JSON.stringify(node));
  } catch (err) {
    snapshot = {
      id: node.id,
      type: node.type,
      actKey: node.actKey,
      fragment: node.fragment || '',
      text: node.text || '',
      transcript: node.transcript || '',
      sceneNotes: Object.prototype.hasOwnProperty.call(node, 'sceneNotes')
        ? String(node.sceneNotes || '') : undefined,
      query: node.query || '',
      durationSeconds: Number(node.durationSeconds) || 0,
      startSeconds: Number(node.startSeconds) || 0,
      trimStartSeconds: Number(node.trimStartSeconds) || 0,
      sourceDurationSeconds: Number(node.sourceDurationSeconds) || 0,
      mediaUrl: node.mediaUrl || '',
      mediaThumbnailUrl: node.mediaThumbnailUrl || '',
      mediaKind: node.mediaKind || '',
      mediaOrigin: node.mediaOrigin || '',
      selectedVisualKey: node.selectedVisualKey || '',
      audioKind: node.audioKind || '',
      audioName: node.audioName || '',
      audioPreviewUrl: node.audioPreviewUrl || '',
      includeNarration: node.includeNarration !== false,
    };
  }
  delete snapshot._nativePreviewUrl;
  delete snapshot._nativeAudioUrl;
  delete snapshot.audioBuffer;
  return snapshot;
}

function ensureActBoardSceneSnapshots(actKey) {
  const nodes = actBoardNodesForAct(actKey);
  actBoardScenesForAct(actKey).forEach(scene => {
    if (!(Array.isArray(scene.nodeSnapshots) && scene.nodeSnapshots.length)) {
      scene.nodeSnapshots = (scene.nodeIds || [])
        .map(nodeId => nodes.find(node => node.id === nodeId))
        .map(snapshotActBoardSceneNode)
        .filter(Boolean);
    }
    // Older saved scenes relied only on the links embedded in each node
    // snapshot. Materialize an explicit edge list too so restore remains
    // reliable if a node's relationship fields are normalized later.
    if (!Array.isArray(scene.nodeLinks)) {
      const linkNodes = Array.isArray(scene.nodeSnapshots) && scene.nodeSnapshots.length
        ? scene.nodeSnapshots : nodes;
      const linkIds = scene.nodeIds || linkNodes.map(node => node.id);
      scene.nodeLinks = snapshotActBoardSceneLinks(linkNodes, linkIds);
    }
  });
}

function snapshotActBoardSceneLinks(nodes, selectedIds) {
  const selected = new Set(selectedIds || []);
  const links = [];
  (Array.isArray(nodes) ? nodes : []).forEach(node => {
    if (node.type === 'narration') {
      (node.footageNodeIds || []).forEach(targetId => {
        if (selected.has(node.id) && selected.has(targetId)) {
          links.push({ sourceId: node.id, targetId, type: 'narration-footage' });
        }
      });
    }
    if (node.type === 'audio' && node.linkedToNodeId
      && selected.has(node.id) && selected.has(node.linkedToNodeId)) {
      links.push({ sourceId: node.linkedToNodeId, targetId: node.id, type: 'audio' });
    }
    if (node.type === 'audio' && node.previousAudioNodeId
      && selected.has(node.previousAudioNodeId) && selected.has(node.id)) {
      links.push({ sourceId: node.previousAudioNodeId, targetId: node.id, type: 'audio-chain' });
    }
    if (node.type === 'narration' && node.previousNarrationNodeId
      && selected.has(node.previousNarrationNodeId) && selected.has(node.id)) {
      links.push({ sourceId: node.previousNarrationNodeId, targetId: node.id, type: 'narration-chain' });
    }
    if (node.type === 'footage' && node.previousFootageNodeId
      && selected.has(node.id) && selected.has(node.previousFootageNodeId)) {
      links.push({ sourceId: node.previousFootageNodeId, targetId: node.id, type: 'footage' });
    }
  });
  return links;
}

function syncActBoardLiveSceneSnapshots() {
  Object.entries(actBoardScenes || {}).forEach(([actKey, scenes]) => {
    if (!Array.isArray(scenes)) return;
    const liveNodes = actBoardNodesForAct(actKey);
    scenes.forEach(scene => {
      if (!scene || scene.liveNodesCleared === true) return;
      const listed = new Set(scene.nodeIds || []);
      const members = liveNodes.filter(node => listed.has(node.id) || node.sceneId === scene.id);
      if (!members.length) return;
      scene.nodeIds = members.map(node => node.id);
      scene.nodeSnapshots = members.map(snapshotActBoardSceneNode).filter(Boolean);
      scene.nodeLinks = snapshotActBoardSceneLinks(members, scene.nodeIds);
    });
  });
}

function restoreActBoardSceneToCanvas(scene) {
  if (!scene || !scene.actKey) return;
  setActBoardOpenScene(scene.actKey, scene);
  // Save the currently live scene's latest node/link state before replacing
  // the canvas with another scene.
  syncActBoardLiveSceneSnapshots();
  scene.hidden = false;
  scene.liveNodesCleared = false;
  const actKey = scene.actKey;
  const currentNodes = actBoardNodesForAct(actKey);
  const snapshots = Array.isArray(scene.nodeSnapshots) && scene.nodeSnapshots.length
    ? scene.nodeSnapshots
    : (scene.nodeIds || [])
      .map(nodeId => currentNodes.find(node => node.id === nodeId))
      .map(snapshotActBoardSceneNode)
      .filter(Boolean);
  if (!snapshots.length) {
    // Empty saved scenes are still loadable: clear the previous scene's live
    // nodes and show this scene's empty board (with its playback affordance).
    const savedPlayback = currentNodes.find(node => node.type === 'playback'
      && node.sceneId === scene.id) || null;
    actBoardNodes[actKey] = savedPlayback ? [savedPlayback] : [];
    scene.nodeIds = savedPlayback ? [savedPlayback.id] : [];
    scene.nodeSnapshots = savedPlayback ? [snapshotActBoardSceneNode(savedPlayback)] : [];
    scene.nodeLinks = [];
    if (!savedPlayback) ensureActBoardPlaybackNode(actKey, null, {
      create: true, sceneId: scene.id,
    });
    saveDebugSession();
    rerenderActBoard();
    return;
  }
  if (!Array.isArray(scene.nodeIds)) scene.nodeIds = snapshots.map(snapshot => snapshot.id).filter(Boolean);
  actBoardNodes[actKey] = snapshots.map(snapshot => ({
    ...snapshot,
    actKey,
  }));
  const restoredById = new Map(actBoardNodesForAct(actKey).map(node => [node.id, node]));
  const embeddedLinks = snapshotActBoardSceneLinks(snapshots, snapshots.map(snapshot => snapshot.id));
  const restoredLinks = [...(Array.isArray(scene.nodeLinks) ? scene.nodeLinks : []), ...embeddedLinks]
    .filter((link, index, all) => all.findIndex(candidate =>
      candidate.sourceId === link.sourceId
      && candidate.targetId === link.targetId
      && candidate.type === link.type) === index);
  (restoredLinks || []).forEach(link => {
    const source = restoredById.get(link.sourceId);
    const target = restoredById.get(link.targetId);
    if (!source || !target) return;
    if (link.type === 'audio' && target.type === 'audio') {
      target.linkedToNodeId = source.id;
      target.linkedToType = source.type;
    } else if (link.type === 'audio-chain' && source.type === 'audio'
      && target.type === 'audio') {
      source.nextAudioNodeId = target.id;
      target.previousAudioNodeId = source.id;
    } else if (link.type === 'narration-chain' && source.type === 'narration'
      && target.type === 'narration') {
      source.nextNarrationNodeId = target.id;
      target.previousNarrationNodeId = source.id;
    } else if (link.type === 'footage' && source.type === 'footage'
      && target.type === 'footage') {
      source.nextFootageNodeId = target.id;
      target.previousFootageNodeId = source.id;
    } else if (link.type === 'narration-footage' && source.type === 'narration'
      && target.type === 'footage') {
      source.footageNodeIds = Array.from(new Set([...(source.footageNodeIds || []), target.id]));
      target.narrationNodeId = source.id;
    }
  });
  // Normalize relationship fields from the snapshots as well. This covers
  // scenes saved before `nodeLinks` was introduced and guarantees the link
  // layer sees the same graph that the restored cards represent.
  const restoredIds = new Set(actBoardNodesForAct(actKey).map(node => node.id));
  actBoardNodesForAct(actKey).forEach(node => {
    if (node.type === 'narration') {
      node.footageNodeIds = Array.from(new Set((node.footageNodeIds || [])
        .filter(targetId => restoredIds.has(targetId))));
      node.footageNodeIds.forEach(targetId => {
        const target = restoredById.get(targetId);
        if (target && target.type === 'footage') target.narrationNodeId = node.id;
      });
    }
    if (node.type === 'audio' && node.linkedToNodeId
      && !restoredIds.has(node.linkedToNodeId)) {
      node.linkedToNodeId = null;
      node.linkedToType = null;
    }
    if (node.type === 'footage') {
      if (node.previousFootageNodeId && !restoredIds.has(node.previousFootageNodeId)) {
        node.previousFootageNodeId = null;
      }
      if (node.nextFootageNodeId && !restoredIds.has(node.nextFootageNodeId)) {
        node.nextFootageNodeId = null;
      }
    }
    if (node.type === 'audio') {
      if (node.previousAudioNodeId && !restoredIds.has(node.previousAudioNodeId)) {
        node.previousAudioNodeId = null;
      }
      if (node.nextAudioNodeId && !restoredIds.has(node.nextAudioNodeId)) {
        node.nextAudioNodeId = null;
      }
    }
    if (node.type === 'narration') {
      if (node.previousNarrationNodeId && !restoredIds.has(node.previousNarrationNodeId)) {
        node.previousNarrationNodeId = null;
      }
      if (node.nextNarrationNodeId && !restoredIds.has(node.nextNarrationNodeId)) {
        node.nextNarrationNodeId = null;
      }
    }
  });
  const restoredNarrations = actBoardNodesForAct(actKey)
    .filter(node => node.type === 'narration');
  restoredNarrations.forEach(node => {
    // Playback belongs to the defined scene, not to the narration node. Do
    // not create or attach a playback card merely because narration exists.
    const playback = actBoardNodesForAct(actKey).find(item =>
      item.type === 'playback' && item.sceneId === scene.id);
    if (playback && !scene.nodeIds.includes(playback.id)) {
      scene.nodeIds.push(playback.id);
      const playbackSnapshot = snapshotActBoardSceneNode(playback);
      if (playbackSnapshot) scene.nodeSnapshots = [...(scene.nodeSnapshots || []), playbackSnapshot];
    }
  });
  saveDebugSession();
  rerenderActBoard();
}

function ensureActBoardPlaybackNode(actKey, narrationNode, options = {}) {
  const nodes = actBoardNodesForAct(actKey);
  const narration = narrationNode?.type === 'narration' ? narrationNode : null;
  const sceneId = options.sceneId || narration?.sceneId || null;
  if (!narration && !sceneId) return null;
  const scene = sceneId
    ? actBoardScenesForAct(actKey).find(item => item.id === sceneId)
    : null;
  // Older saved scenes may have a playback node listed in nodeIds/snapshots
  // without the newer sceneId field. Treat that membership as authoritative so
  // a render-time migration does not append another playback card on every
  // refresh.
  const sceneMemberIds = new Set([
    ...(scene?.nodeIds || []),
    ...(scene?.nodeSnapshots || []).map(snapshot => snapshot?.id),
    ...nodes.filter(node => node.sceneId === sceneId).map(node => node.id),
  ].filter(Boolean));
  const sceneNarrationIds = new Set(nodes
    .filter(node => node.type === 'narration' && sceneMemberIds.has(node.id))
    .map(node => node.id));
  let playbackMatches = nodes.filter(node => node.type === 'playback'
    && ((narration && node.narrationNodeId === narration.id)
      || (sceneId && (node.sceneId === sceneId
        || sceneMemberIds.has(node.id)
        || sceneNarrationIds.has(node.narrationNodeId)))));
  if (sceneId) {
    // Playback cards created before scene ownership was introduced have no
    // sceneId at all. Keep one as the migration candidate and fold any other
    // orphan cards into the duplicate cleanup below; otherwise each render
    // would leave the old cards visible while creating a new scoped one.
    const orphanPlayback = nodes.filter(node => node.type === 'playback'
      && !node.sceneId && !node.narrationNodeId
      && !playbackMatches.includes(node));
    playbackMatches = [...playbackMatches, ...orphanPlayback];
  }
  // A very old starter scene can contain one unscoped playback node. Claim it
  // for the first scene that needs one instead of creating an additional card;
  // subsequent scenes will then get their own scoped card normally.
  if (!playbackMatches.length && sceneId) {
    const claimedPlaybackIds = new Set(actBoardScenesForAct(actKey)
      .flatMap(item => item?.nodeIds || []));
    const unscoped = nodes.find(node => node.type === 'playback'
      && !node.sceneId && !node.narrationNodeId
      && !claimedPlaybackIds.has(node.id));
    if (unscoped) playbackMatches = [unscoped];
  }
  let playback = playbackMatches[0] || null;
  // Older scene restores could append a second playback card when the saved
  // scene already contained one. Keep the first saved node and remove only
  // duplicate playback references from the scene snapshot/card list.
  if (playbackMatches.length > 1) {
    const duplicateIds = new Set(playbackMatches.slice(1).map(node => node.id));
    nodes.splice(0, nodes.length, ...nodes.filter(node => !duplicateIds.has(node.id)));
    actBoardScenesForAct(actKey).forEach(sceneItem => {
      sceneItem.nodeIds = (sceneItem.nodeIds || []).filter(id => !duplicateIds.has(id));
      sceneItem.nodeSnapshots = (sceneItem.nodeSnapshots || [])
        .filter(snapshot => !duplicateIds.has(snapshot.id));
    });
  }
  if (playback) {
    if (narration) playback.narrationNodeId = narration.id;
    if (sceneId) playback.sceneId = sceneId;
    if (scene && !scene.nodeIds.includes(playback.id)) {
      scene.nodeIds = Array.from(new Set([...(scene.nodeIds || []), playback.id]));
      scene.liveNodesCleared = false;
    }
    if (playback.boardPositionMode === 'auto') {
      const position = narration
        ? actBoardNodePosition(narration, 0)
        : { x: 16, y: 56 };
      playback.boardX = narration
        ? position.x + actBoardNodeDurationWidth(narration) + ACT_BOARD_NODE_GAP
        : position.x;
      playback.boardY = position.y;
    }
    return playback;
  }
  // Playback is a defined-scene affordance. Do not add a standalone playback
  // card just because a narration node was created or its footage was edited.
  if (!options.create) return null;
  const position = narration ? actBoardNodePosition(narration, 0) : { x: 16, y: 56 };
  playback = {
    id: createActBoardNodeId('playback'),
    type: 'playback',
    actKey,
    narrationNodeId: narration?.id || null,
    status: 'ready',
    boardX: narration ? position.x + actBoardNodeDurationWidth(narration) + ACT_BOARD_NODE_GAP : position.x,
    boardY: position.y,
    boardWidth: 320,
    boardWidthMode: 'auto',
    boardPositionMode: 'auto',
    sceneId,
  };
  nodes.push(playback);
  if (scene) {
    scene.nodeIds = Array.from(new Set([...(scene.nodeIds || []), playback.id]));
    scene.liveNodesCleared = false;
    const snapshot = snapshotActBoardSceneNode(playback);
    if (snapshot) scene.nodeSnapshots = [...(scene.nodeSnapshots || []), snapshot];
  }
  return playback;
}

function removeActBoardPlaybackNode(actKey, narrationNodeId) {
  if (!narrationNodeId) return;
  actBoardNodes[actKey] = actBoardNodesForAct(actKey)
    .filter(node => !(node.type === 'playback' && node.narrationNodeId === narrationNodeId));
}

function createActBoardNodeId(type) {
  const suffix = window.crypto && typeof window.crypto.randomUUID === 'function'
    ? window.crypto.randomUUID().slice(0, 8)
    : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `act-board-${type}-${suffix}`;
}

function actBoardNarrationTextHash(text) {
  let hash = 2166136261;
  for (const char of String(text || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${hash >>> 0}-${String(text || '').length}`;
}

function actBoardNarrationSourceText(node) {
  return String(node?.transcript || node?.text || '').trim();
}

function requestActBoardNarrationAnalysis(narrationNode) {
  if (!narrationNode || narrationNode.type !== 'narration') return null;
  const text = actBoardNarrationSourceText(narrationNode);
  if (!text) return null;
  const hash = actBoardNarrationTextHash(text);
  if (narrationNode.narrationSpanHash === hash
    && ['extracting', 'classifying', 'ready', 'error'].includes(narrationNode.narrationSpanStatus)) return null;
  const key = `${narrationNode.id}:${hash}`;
  if (actBoardNarrationAnalysisPromises.has(key)) return actBoardNarrationAnalysisPromises.get(key);
  narrationNode.narrationSpanHash = hash;
  narrationNode.narrationSpanStatus = 'extracting';
  const promise = fetchNarrationSpans(text)
    .then(local => {
      if (actBoardNarrationTextHash(actBoardNarrationSourceText(narrationNode)) !== hash) return null;
      const candidates = Array.isArray(local.spans) ? local.spans : [];
      narrationNode.narrationCandidateSpans = candidates;
      narrationNode.narrationSpans = candidates.map(span => ({ ...span, bucket: 'pending' }));
      narrationNode.narrationSpanStatus = candidates.length ? 'classifying' : 'ready';
      saveDebugSession();
      // Do not rebuild the entire board while the optional filmability
      // classifier is still pending. A second full render here can cause the
      // scene-containment pass and browser scroll anchoring to re-measure the
      // growing narration card, which makes it appear to creep downward.
      // There is no useful visual state to show for an empty candidate list,
      // so only that terminal local-extraction case needs an immediate render.
      if (!candidates.length) {
        alignActBoardNarrationFragments(narrationNode, []);
        rerenderActBoard();
        return null;
      }
      // Let rapid edits settle before spending the classifier request. The
      // narration hash still guards against a stale response after an edit.
      return new Promise(resolve => setTimeout(resolve, 300)).then(() =>
        fetchNarrationFilmability({
          narration: text,
          spans: candidates,
          documentaryMode: actBoardDocumentaryModeForNode(narrationNode.actKey, narrationNode),
        }));
    })
    .then(classified => {
      if (!classified || actBoardNarrationTextHash(actBoardNarrationSourceText(narrationNode)) !== hash) return;
      narrationNode.narrationSpans = Array.isArray(classified.spans) ? classified.spans : [];
      narrationNode.narrationSpanSource = classified.source || 'fallback';
      narrationNode.narrationSpanStatus = 'ready';
      const detectedFragments = narrationNode.narrationSpans
        .filter(span => span && span.bucket !== 'ignore' && span.text)
        .map(span => span.text);
      alignActBoardNarrationFragments(narrationNode, detectedFragments);
      saveDebugSession();
      rerenderActBoard();
    })
    .catch(error => {
      // Local extraction is still useful if the optional classifier is down.
      if (actBoardNarrationTextHash(actBoardNarrationSourceText(narrationNode)) !== hash) return;
      narrationNode.narrationSpanStatus = 'error';
      narrationNode.narrationSpanError = error.message;
      narrationNode.narrationSpans = (narrationNode.narrationCandidateSpans || []).slice(0, 3).map(span => ({
        ...span, bucket: 'depictable', query: span.text,
      }));
      alignActBoardNarrationFragments(narrationNode,
        narrationNode.narrationSpans.map(span => span.text));
      saveDebugSession();
      rerenderActBoard();
    })
    .finally(() => actBoardNarrationAnalysisPromises.delete(key));
  actBoardNarrationAnalysisPromises.set(key, promise);
  return promise;
}

function actBoardNarrationFragments(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const seen = new Set();
  const fragments = [];
  const add = value => {
    const fragment = value.replace(/^[-–—:;,\s]+|[-–—:;,\s]+$/g, '').trim();
    if (fragment.split(/\s+/).filter(Boolean).length < 3) return;
    const key = fragment.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    fragments.push(fragment);
  };
  normalized.split(/(?<=[.!?])\s+/).forEach(sentence => {
    const clauses = sentence.split(/\s*[,;:—–]\s*/).filter(Boolean);
    if (clauses.length > 1) clauses.forEach(add);
    else add(sentence);
  });
  if (fragments.length < 2) normalized.split(/\s*[,;:—–]\s*/).forEach(add);
  if (!fragments.length) add(normalized);
  const maxFragments = 5;
  if (fragments.length <= maxFragments) return fragments;
  const evenlySpaced = [];
  for (let index = 0; index < maxFragments; index += 1) {
    const sourceIndex = Math.round(index * (fragments.length - 1) / (maxFragments - 1));
    const fragment = fragments[sourceIndex];
    if (fragment && !evenlySpaced.includes(fragment)) evenlySpaced.push(fragment);
  }
  return evenlySpaced;
}

function appendActBoardNarrationWords(parent, text, sourceOffset, source) {
  const value = String(text || '');
  if (!value) return;
  const baseWordIndex = normalizedBoardWords(String(source || '').slice(0, sourceOffset)).length;
  const wordPattern = /[A-Za-z0-9']+/g;
  let cursor = 0;
  let match;
  let localWordIndex = 0;
  while ((match = wordPattern.exec(value))) {
    if (match.index > cursor) parent.appendChild(document.createTextNode(value.slice(cursor, match.index)));
    const word = document.createElement('span');
    word.className = 'storyboard-act-board-narration-word';
    word.dataset.narrationWordIndex = String(baseWordIndex + localWordIndex);
    word.dataset.narrationSourceStart = String(sourceOffset + match.index);
    word.dataset.narrationSourceEnd = String(sourceOffset + match.index + match[0].length);
    word.textContent = match[0];
    parent.appendChild(word);
    cursor = match.index + match[0].length;
    localWordIndex += 1;
  }
  if (cursor < value.length) parent.appendChild(document.createTextNode(value.slice(cursor)));
}

function buildActBoardSuggestedNarrationText(text, fragments, onFragmentEdit, labelText = 'Suggested narration: ', onFragmentSelect, highlightFallback = true) {
  const container = document.createElement('p');
  container.className = 'storyboard-act-board-node-text';
  if (onFragmentSelect) {
    container.title = 'Click a word or drag-select a phrase, then press Suggest footage. Hold Command/Ctrl while clicking to select multiple phrases.';
  }
  const label = document.createElement('strong');
  label.textContent = labelText;
  container.appendChild(label);
  const source = String(text || '');
  const ranges = [];
  let searchFrom = 0;
  (Array.isArray(fragments) ? fragments : []).forEach(fragment => {
    const value = typeof fragment === 'string' ? fragment : fragment?.text;
    if (!value) return;
    const explicitStart = Number(fragment?.start);
    const explicitEnd = Number(fragment?.end);
    const hasOffsets = Number.isFinite(explicitStart) && Number.isFinite(explicitEnd)
      && explicitStart >= 0 && explicitEnd > explicitStart;
    const index = hasOffsets ? explicitStart
      : source.toLocaleLowerCase().indexOf(String(value).toLocaleLowerCase(), searchFrom);
    if (index < 0 || index >= source.length) return;
    const end = hasOffsets ? Math.min(source.length, explicitEnd) : index + String(value).length;
    ranges.push({ start: index, end, metadata: typeof fragment === 'string' ? {} : fragment });
    searchFrom = end;
  });
  ranges.sort((a, b) => a.start - b.start);
  let cursor = 0;
  ranges.forEach(range => {
    if (range.start < cursor) return;
    if (range.start > cursor) {
      appendActBoardNarrationWords(container, source.slice(cursor, range.start), cursor, source);
    }
    const highlight = document.createElement('span');
    const metadata = range.metadata || {};
    highlight.className = 'storyboard-act-board-node-fragment storyboard-act-board-narration-span';
    // `value` belongs to the range-building loop above; use the actual
    // rendered source slice here so this second loop does not reference an
    // out-of-scope variable.
    highlight.dataset.narrationFragment = source.slice(range.start, range.end);
    if (metadata.bucket) highlight.classList.add(`storyboard-act-board-narration-span-${metadata.bucket}`);
    appendActBoardNarrationWords(highlight, source.slice(range.start, range.end), range.start, source);
    const bucket = metadata.bucket;
    if (bucket === 'depictable') {
      highlight.title = `Find footage for “${metadata.query || highlight.textContent}”`;
    } else if (bucket === 'abstract') {
      highlight.title = `Use visual proxy: ${metadata.visual_proxy || metadata.query || 'find a concrete visual metaphor'}`;
    } else if (bucket === 'pending') {
      highlight.title = 'Classifying this narration phrase…';
    }
    if (onFragmentSelect && bucket && bucket !== 'ignore' && bucket !== 'pending') {
      highlight.classList.add('storyboard-act-board-narration-span-clickable');
      let selectTimer = null;
      highlight.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        clearTimeout(selectTimer);
        selectTimer = setTimeout(() => onFragmentSelect({
          ...metadata,
          start: range.start,
          end: range.end,
          text: highlight.textContent,
        }, highlight.textContent, Boolean(event.metaKey || event.ctrlKey)), 180);
      });
      highlight.addEventListener('dblclick', () => clearTimeout(selectTimer));
    }
    if (onFragmentEdit) {
      if (!bucket || bucket === 'ignore') highlight.title = 'Double-click to edit this narration phrase';
      highlight.addEventListener('dblclick', event => {
        event.preventDefault();
        event.stopPropagation();
        makeActBoardInlinePhraseEditor(
          highlight,
          highlight.textContent,
          replacement => onFragmentEdit(highlight.textContent, replacement)
        );
      });
    }
    container.appendChild(highlight);
    cursor = range.end;
  });
  // Keep narration editable even when the current transcript no longer contains
  // any of the previously detected phrase ranges.
  if (onFragmentEdit && source && !ranges.length) {
    const editable = document.createElement('span');
    editable.className = highlightFallback
      ? 'storyboard-act-board-node-fragment'
      : 'storyboard-act-board-node-plain-editable';
    appendActBoardNarrationWords(editable, source, 0, source);
    editable.title = 'Double-click to edit this narration';
    editable.addEventListener('dblclick', event => {
      event.preventDefault();
      event.stopPropagation();
      makeActBoardInlinePhraseEditor(
        editable,
        editable.textContent,
        replacement => onFragmentEdit(editable.textContent, replacement)
      );
    });
    container.appendChild(editable);
    cursor = source.length;
  }
  if (cursor < source.length) {
    appendActBoardNarrationWords(container, source.slice(cursor), cursor, source);
  }
  if (!source) container.appendChild(document.createTextNode('No narration draft yet.'));
  if (onFragmentSelect && source) {
    // Any word in the narration can seed a new footage idea, not just a span
    // returned by the filmability classifier. A click selects one word; a
    // native text selection selects an arbitrary phrase.
    let textSelectionCaptured = false;
    const emitSelection = (selectedText, start, end, append = false) => {
      const phrase = String(selectedText || '').replace(/\s+/g, ' ').trim();
      if (!phrase) return;
      const safeStart = Number.isFinite(Number(start)) && Number(start) >= 0
        ? Number(start) : source.toLocaleLowerCase().indexOf(phrase.toLocaleLowerCase());
      const safeEnd = Number.isFinite(Number(end)) && Number(end) > safeStart
        ? Number(end) : safeStart + phrase.length;
      onFragmentSelect({
        text: phrase,
        start: Math.max(0, safeStart),
        end: Math.max(Math.max(0, safeStart), safeEnd),
        bucket: 'depictable',
        query: phrase,
      }, phrase, append);
    };
    container.addEventListener('mouseup', () => {
      setTimeout(() => {
        const selection = window.getSelection?.();
        if (!selection || selection.isCollapsed || !selection.rangeCount
          || !container.contains(selection.anchorNode)
          || !container.contains(selection.focusNode)) return;
        const phrase = selection.toString().replace(/\s+/g, ' ').trim();
        if (!phrase) return;
        const range = selection.getRangeAt(0);
        const words = Array.from(container.querySelectorAll('[data-narration-source-start]'))
          .filter(word => {
            try { return range.intersectsNode(word); } catch (err) { return false; }
          });
        const starts = words.map(word => Number(word.dataset.narrationSourceStart))
          .filter(Number.isFinite);
        const ends = words.map(word => Number(word.dataset.narrationSourceEnd))
          .filter(Number.isFinite);
        const start = starts.length ? Math.min(...starts) : source.toLocaleLowerCase()
          .indexOf(phrase.toLocaleLowerCase());
        const end = ends.length ? Math.max(...ends) : start + phrase.length;
        textSelectionCaptured = true;
      emitSelection(phrase, start, end);
      }, 0);
    });
    container.addEventListener('click', event => {
      if (textSelectionCaptured) {
        textSelectionCaptured = false;
        return;
      }
      if (event.target.closest('.storyboard-act-board-narration-span')) return;
      const word = event.target.closest('[data-narration-source-start]');
      if (!word || !container.contains(word)) return;
      emitSelection(word.textContent, Number(word.dataset.narrationSourceStart),
        Number(word.dataset.narrationSourceEnd), Boolean(event.metaKey || event.ctrlKey));
    });
  }
  return container;
}

function applyActBoardNarrationPhraseSelection(root, narrationNode) {
  if (!root || !narrationNode) return;
  const selections = Array.isArray(narrationNode.selectedFootagePhrases)
    ? narrationNode.selectedFootagePhrases : [];
  const footageSuggested = Array.isArray(narrationNode.footageSuggestedPhrases)
    ? narrationNode.footageSuggestedPhrases : [];
  const ranges = selections.map(item => ({
    start: Number(item.start), end: Number(item.end),
  })).filter(item => Number.isFinite(item.start) && Number.isFinite(item.end));
  const footageRanges = footageSuggested.map(item => ({
    start: Number(item.start), end: Number(item.end),
  })).filter(item => Number.isFinite(item.start) && Number.isFinite(item.end));
  root.querySelectorAll('[data-narration-source-start]').forEach(word => {
    const start = Number(word.dataset.narrationSourceStart);
    const end = Number(word.dataset.narrationSourceEnd);
    word.classList.toggle('storyboard-act-board-narration-phrase-selected',
      ranges.some(range => end > range.start && start < range.end));
    word.classList.toggle('storyboard-act-board-narration-phrase-has-footage',
      footageRanges.some(range => end > range.start && start < range.end));
  });
  root.querySelectorAll('[data-narration-fragment]').forEach(fragment => {
    const value = fragment.dataset.narrationFragment || '';
    const source = String(narrationNode.transcript || narrationNode.text || '');
    const start = source.toLocaleLowerCase().indexOf(value.toLocaleLowerCase());
    const end = start >= 0 ? start + value.length : -1;
    fragment.classList.toggle('storyboard-act-board-narration-phrase-selected',
      start >= 0 && ranges.some(range => end > range.start && start < range.end));
    fragment.classList.toggle('storyboard-act-board-narration-phrase-has-footage',
      start >= 0 && footageRanges.some(range => end > range.start && start < range.end));
  });
}

function replaceActBoardNarrationPhrase(text, original, replacement) {
  const source = String(text || '');
  const index = source.toLocaleLowerCase().indexOf(String(original || '').toLocaleLowerCase());
  if (index < 0) return `${source}${source ? ' ' : ''}${replacement}`.trim();
  return `${source.slice(0, index)}${replacement}${source.slice(index + original.length)}`;
}

function editActBoardNarrationPhrase(narrationNode, original, replacement, sourceField = 'auto') {
  if (!narrationNode || !original || !replacement) return;
  const field = sourceField === 'text' || sourceField === 'transcript'
    ? sourceField
    : (narrationNode.transcript ? 'transcript' : 'text');
  const priorFragments = Array.isArray(narrationNode.footageFragments)
    && narrationNode.footageFragments.length
    ? narrationNode.footageFragments.slice()
    : actBoardNarrationFragments(narrationNode[field] || '');
  narrationNode[field] = replaceActBoardNarrationPhrase(narrationNode[field], original, replacement);
  narrationNode.footageFragments = priorFragments
    .map(fragment => fragment === original ? replacement : fragment);
  // Character offsets from the previous text are no longer trustworthy after
  // an inline edit. Re-run the local span pass and classifier against the new
  // narration instead of trying to patch overlapping entity ranges by hand.
  narrationNode.narrationSpanHash = '';
  narrationNode.narrationCandidateSpans = [];
  narrationNode.narrationSpans = [];
  narrationNode.narrationSpanStatus = 'stale';
  const footage = actBoardNodesForAct(narrationNode.actKey)
    .find(node => node.type === 'footage' && node.fragment === original
      && node.narrationNodeId === narrationNode.id);
  if (footage) {
    footage.fragment = replacement;
    footage.status = 'needs-search';
    footage.query = '';
    footage.results = [];
    footage.generatedOptions = [];
    footage.generationStatus = '';
    footage.generationError = '';
    footage.mediaUrl = '';
    footage.mediaThumbnailUrl = '';
    footage.mediaKind = '';
    footage.mediaOrigin = '';
    footage.selectedVisualKey = null;
  }
  if (field === 'transcript') alignActBoardNarrationFragments(narrationNode);
  else recomputeActBoardTiming(narrationNode);
  saveDebugSession();
  rerenderActBoard();
}

function editActBoardFootagePhrase(footageNode, replacement) {
  if (!footageNode || !replacement || replacement === footageNode.fragment) return;
  const parent = actBoardNodesForAct(footageNode.actKey)
    .find(node => node.type === 'narration' && node.id === footageNode.narrationNodeId);
  if (parent) {
    editActBoardNarrationPhrase(parent, footageNode.fragment, replacement);
    return;
  }
  footageNode.fragment = replacement;
  footageNode.status = 'needs-search';
  footageNode.query = '';
  footageNode.results = [];
  footageNode.generatedOptions = [];
  footageNode.generationStatus = '';
  footageNode.mediaUrl = '';
  footageNode.mediaThumbnailUrl = '';
  footageNode.mediaKind = '';
  footageNode.mediaOrigin = '';
  footageNode.selectedVisualKey = null;
  saveDebugSession();
  rerenderActBoard();
}

function handleActBoardNarrationSpanSelect(narrationNode, metadata, renderedText, appendSelection = false) {
  if (!narrationNode || !renderedText || !metadata || metadata.bucket === 'ignore') return;
  const source = String(narrationNode.transcript || narrationNode.text || '');
  const phrase = String(renderedText || metadata.text || '').replace(/\s+/g, ' ').trim();
  if (!phrase) return;
  const fallbackStart = source.toLocaleLowerCase().indexOf(phrase.toLocaleLowerCase());
  const start = Number.isFinite(Number(metadata.start)) && Number(metadata.start) >= 0
    ? Number(metadata.start) : fallbackStart;
  const end = Number.isFinite(Number(metadata.end)) && Number(metadata.end) > start
    ? Number(metadata.end) : start + phrase.length;
  const query = String(metadata.query || metadata.visual_proxy || phrase).trim();
  const nextSelection = {
    text: phrase,
    start: Math.max(0, start),
    end: Math.max(Math.max(0, start), end),
    query,
    bucket: metadata.bucket || 'depictable',
    visual_proxy: metadata.visual_proxy || '',
  };
  const priorSelections = Array.isArray(narrationNode.selectedFootagePhrases)
    ? narrationNode.selectedFootagePhrases : [];
  if (appendSelection) {
    const duplicate = priorSelections.findIndex(item =>
      String(item.text || '').toLocaleLowerCase() === phrase.toLocaleLowerCase()
      && Math.abs(Number(item.start) - nextSelection.start) < 1);
    narrationNode.selectedFootagePhrases = duplicate >= 0
      ? priorSelections.filter((item, index) => index !== duplicate)
      : [...priorSelections, nextSelection];
  } else {
    narrationNode.selectedFootagePhrases = [nextSelection];
  }
  const count = narrationNode.selectedFootagePhrases.length;
  narrationNode.footageStatus = count
    ? `${count} phrase${count === 1 ? '' : 's'} selected. Press Suggest footage to add ${count === 1 ? 'it' : 'them'} to the linked sequence.`
    : 'Phrase selection cleared.';
  saveDebugSession();
  rerenderActBoard();
}

function makeActBoardInlinePhraseEditor(element, original, onCommit) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = original;
  input.className = 'storyboard-act-board-node-fragment-editor';
  element.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = commit => {
    if (finished) return;
    finished = true;
    const value = input.value.trim();
    if (commit && value && value !== original) onCommit(value);
    else input.replaceWith(element);
  };
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true), { once: true });
}

function estimateActBoardNarrationSeconds(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(2, words / 2.5); // roughly 150 spoken words per minute
}

function normalizedBoardWords(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9']+/g) || [];
}

// Convert phrase timestamps into contiguous footage windows. The phrase start
// is the boundary where a later shot begins, while the first shot owns the
// pre-roll and the final shot owns the tail through the end of narration.
function actBoardNarrationFootageWindow(timings, index, totalDuration, previousStart = 0) {
  const timing = Array.isArray(timings) ? timings[index] : null;
  const requestedStart = index === 0
    ? 0 : Number(timing?.startSeconds);
  const start = Math.max(previousStart, Number.isFinite(requestedStart) ? requestedStart : previousStart);
  const nextTiming = Array.isArray(timings)
    ? timings.slice(index + 1).find(item => Number.isFinite(Number(item?.startSeconds)))
    : null;
  const requestedEnd = nextTiming ? Number(nextTiming.startSeconds) : Number(totalDuration);
  const end = Math.max(start, Number.isFinite(requestedEnd) ? requestedEnd : start);
  return {
    startSeconds: start,
    durationSeconds: Math.max(0.5, end - start),
    endSeconds: end,
  };
}

function alignActBoardNarrationFragments(narrationNode, fragmentOverride = null) {
  const transcript = (narrationNode.transcript || '').trim();
  const hasOverride = Array.isArray(fragmentOverride);
  const fragments = hasOverride
    ? fragmentOverride.map(fragment => String(fragment || '').trim()).filter(Boolean)
    : (narrationNode.footageFragments || actBoardNarrationFragments(narrationNode.text));
  if (!transcript) return;
  // A completed filmability pass can legitimately find no filmable phrases.
  // Clear stale rows from the prior transcript in that case.
  if (!fragments.length) {
    if (hasOverride) narrationNode.fragmentTimings = [];
    return;
  }
  const duration = Number(narrationNode.audioDurationSeconds) > 0
    ? Number(narrationNode.audioDurationSeconds)
    : estimateActBoardNarrationSeconds(transcript);
  const transcriptWords = normalizedBoardWords(transcript);
  const suppliedWords = Array.isArray(narrationNode.transcriptWords)
    ? narrationNode.transcriptWords.filter(word => Number.isFinite(Number(word.start)) && Number.isFinite(Number(word.end)))
    : [];
  const timedWords = transcriptWords.map((word, index) => {
    const supplied = suppliedWords[index];
    return {
      word,
      start: supplied ? Number(supplied.start) : (index / Math.max(transcriptWords.length, 1)) * duration,
      end: supplied ? Number(supplied.end) : ((index + 1) / Math.max(transcriptWords.length, 1)) * duration,
    };
  });
  let searchFrom = 0;
  const timings = fragments.map(fragment => {
    const phraseWords = normalizedBoardWords(fragment);
    let match = -1;
    for (let i = searchFrom; i <= timedWords.length - phraseWords.length; i += 1) {
      if (phraseWords.every((word, offset) => timedWords[i + offset].word === word)) {
        match = i;
        break;
      }
    }
    if (match >= 0) {
      searchFrom = match + phraseWords.length;
      return {
        fragment,
        startSeconds: timedWords[match].start,
        endSeconds: timedWords[match + phraseWords.length - 1].end,
        matchedText: timedWords.slice(match, match + phraseWords.length).map(item => item.word).join(' '),
      };
    }
    return null;
  });
  const fallbackWords = Math.max(1, fragments.reduce((sum, fragment) =>
    sum + normalizedBoardWords(fragment).length, 0));
  let fallbackCursor = 0;
  narrationNode.fragmentTimings = timings.map((timing, index) => {
    if (timing) {
      fallbackCursor = Math.max(fallbackCursor, timing.endSeconds);
      return timing;
    }
    const seconds = duration * normalizedBoardWords(fragments[index]).length / fallbackWords;
    const result = {
      fragment: fragments[index],
      startSeconds: fallbackCursor,
      endSeconds: Math.min(duration, fallbackCursor + seconds),
      matchedText: '',
    };
    fallbackCursor = result.endSeconds;
    return result;
  });
  narrationNode.alignmentSource = suppliedWords.length ? 'transcription timestamps' : 'estimated from transcript duration';
  narrationNode.audioDurationSeconds = duration;
  narrationNode.narrationAudioDurationSeconds = duration;
  narrationNode.narrationSegmentDurationSeconds = duration;
  const nodes = actBoardNodesForAct(narrationNode.actKey);
  const byFragment = new Map(narrationNode.fragmentTimings.map(timing => [timing.fragment, timing]));
  const linked = (narrationNode.footageNodeIds || [])
    .map(id => nodes.find(node => node.id === id)).filter(Boolean);
  let previousStart = 0;
  linked.forEach((node, index) => {
    const timing = byFragment.get(node.fragment);
    if (!timing) return;
    const timingIndex = narrationNode.fragmentTimings.findIndex(item => item === timing);
    const window = actBoardNarrationFootageWindow(
      narrationNode.fragmentTimings,
      timingIndex >= 0 ? timingIndex : index,
      duration,
      previousStart,
    );
    node.startSeconds = window.startSeconds;
    node.durationSeconds = window.durationSeconds;
    node.durationWasSuggested = false;
    node.alignedToNarration = true;
    node.timingWasManuallyAdjusted = false;
    previousStart = window.startSeconds;
  });
  narrationNode.durationSeconds = duration;
}

function setActBoardNarrationRecordStatus(statusEl, message, isError = false) {
  if (statusEl && typeof statusEl._setStatus === 'function') {
    statusEl._setStatus(message, isError);
    return;
  }
  if (!statusEl) return;
  statusEl.textContent = message || '';
  statusEl.classList.toggle('error', Boolean(isError));
}

async function recordActBoardNarration(node, blob, filename, statusEl) {
  setActBoardNarrationRecordStatus(statusEl, 'Uploading narration ...');
  try {
    // Persist a browser-independent PCM/WAV copy for refreshes. The live page
    // can use its original MediaRecorder blob, but WebM/MP4 container support
    // varies across browsers and was producing distorted or aborted playback
    // when the saved URL was loaded later.
    let uploadBlob = blob;
    let uploadFilename = filename;
    try {
      setActBoardNarrationRecordStatus(statusEl, 'Normalizing narration ...');
      const normalizedBuffer = await blob.arrayBuffer()
        .then(bytes => ensurePlaybackAudioCtx().decodeAudioData(bytes));
      uploadBlob = audioBufferToWavBlob(normalizedBuffer);
      uploadFilename = filename.replace(/\.[^.]+$/, '.wav');
    } catch (normalizeError) {
      // Keep recording support if a browser cannot decode its own container;
      // the server still receives the original file as a fallback.
      uploadBlob = blob;
      uploadFilename = filename;
    }
    const uploaded = await fetchUploadMediaBankItem(
      new File([uploadBlob], uploadFilename, { type: uploadBlob.type || 'audio/wav' }), premiereProjectId);
    premiereProjectId = uploaded.project_id;
    node.audioPreviewUrl = uploaded.preview_url;
    node.audioFilePath = uploaded.file_path || null;
    node.audioDurationSeconds = Number(uploaded.duration_seconds) || 0;
    if (node.audioDurationSeconds > 0) node.sourceDurationSeconds = node.audioDurationSeconds;
    if (node.audioDurationSeconds > 0) node.narrationSegmentDurationSeconds = node.audioDurationSeconds;
    try {
      if (typeof node._nativePreviewUrl === 'string' && node._nativePreviewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(node._nativePreviewUrl);
      }
      const nativeUrl = URL.createObjectURL(blob);
      Object.defineProperty(node, '_nativeAudioUrl', {
        value: nativeUrl, configurable: true, enumerable: false,
      });
      Object.defineProperty(node, '_nativePreviewUrl', {
        value: nativeUrl, configurable: true, enumerable: false,
      });
    } catch (err) { /* native playback is optional */ }
    if (!(node.audioDurationSeconds > 0)) {
      try {
        const audioBuffer = await blob.arrayBuffer()
          .then(bytes => ensurePlaybackAudioCtx().decodeAudioData(bytes));
        node.audioDurationSeconds = Number(audioBuffer.duration) || 0;
        if (node.audioDurationSeconds > 0) node.sourceDurationSeconds = node.audioDurationSeconds;
        if (node.audioDurationSeconds > 0) node.narrationSegmentDurationSeconds = node.audioDurationSeconds;
      } catch (err) { /* duration can still be estimated from the transcript */ }
    }
    setActBoardNarrationRecordStatus(statusEl, 'Transcribing narration ...');
    const transcript = await fetchTranscription(blob, filename);
    node.transcript = (transcript.text || '').trim();
    node.transcriptWords = Array.isArray(transcript.words) ? transcript.words : [];
    // The uploaded transcript is a new analysis input. Discard the previous
    // phrase/entity ranges so the timing rows are rebuilt from this recording
    // rather than trying to align stale phrases against the new words.
    node.narrationSpanHash = '';
    node.narrationSpanStatus = 'stale';
    node.narrationCandidateSpans = [];
    node.narrationSpans = [];
    node.selectedFootagePhrases = [];
    node.footageSuggestedPhrases = [];
    node.recordingStatus = 'ready';
    node.recordingError = '';
    const act = currentArcSections.find(item => item.key === node.actKey);
    if (act && node.transcript) {
      // Recording changes the narration reference only. Keep any existing
      // footage nodes intact until the presenter explicitly asks to refresh
      // them with Suggest footage.
      node.footageStatus = ''; // Narration updated — press Suggest footage to refresh the linked footage.
      node.footageFragments = actBoardNarrationFragments(node.transcript);
    }
    // Align after replacing the phrase list so the first rendered timing rows
    // already belong to the newly uploaded transcript.
    alignActBoardNarrationFragments(node);
    setActBoardNarrationRecordStatus(statusEl, '');
    saveDebugSession();
    rerenderActBoard();
  } catch (err) {
    node.recordingStatus = 'error';
    node.recordingError = err.message;
    setActBoardNarrationRecordStatus(statusEl,
      `Narration recording failed: ${err.message}`, true);
    saveDebugSession();
    rerenderActBoard();
  }
}

function recomputeActBoardTiming(narrationNode) {
  if (!narrationNode || narrationNode.type !== 'narration') return;
  const fragments = Array.isArray(narrationNode.footageFragments) && narrationNode.footageFragments.length
    ? narrationNode.footageFragments
    : actBoardNarrationFragments(narrationNode.text);
  const nodesById = new Map((actBoardNodesForAct(narrationNode.actKey) || [])
    .filter(node => node.type === 'footage' && node.narrationNodeId === narrationNode.id)
    .map(node => [node.id, node]));
  const linked = (narrationNode.footageNodeIds || [])
    .map(id => nodesById.get(id)).filter(Boolean);
  if (!linked.length) return;
  const narrationSeconds = Number(narrationNode.narrationAudioDurationSeconds) > 0
    ? Number(narrationNode.narrationAudioDurationSeconds)
    : estimateActBoardNarrationSeconds(narrationNode.text);
  const totalWords = Math.max(1, fragments.reduce((sum, fragment) =>
    sum + fragment.split(/\s+/).filter(Boolean).length, 0));
  const timingByFragment = new Map((narrationNode.fragmentTimings || [])
    .filter(timing => timing && timing.fragment)
    .map(timing => [timing.fragment, timing]));
  let cursor = 0;
  linked.forEach((node, index) => {
    const fragment = node.fragment || fragments[index] || '';
    const alignedTiming = node.alignedToNarration && timingByFragment.get(fragment);
    if (node.timingWasManuallyAdjusted) {
      node.sequenceIndex = index;
      node.startSeconds = Math.max(0, Number(node.startSeconds) || 0);
      node.durationSeconds = Math.max(0.5, Number(node.durationSeconds) || 0.5);
      cursor = Math.max(cursor, node.startSeconds + node.durationSeconds);
      return;
    }
    if (alignedTiming) {
      const timingIndex = (narrationNode.fragmentTimings || []).findIndex(item => item === alignedTiming);
      const window = actBoardNarrationFootageWindow(
        narrationNode.fragmentTimings,
        timingIndex >= 0 ? timingIndex : index,
        narrationSeconds,
        cursor,
      );
      node.startSeconds = window.startSeconds;
      node.durationSeconds = window.durationSeconds;
      node.durationWasSuggested = false;
      node.sequenceIndex = index;
      cursor = node.startSeconds + node.durationSeconds;
      return;
    }
    const words = fragment.split(/\s+/).filter(Boolean).length;
    const suggested = Math.max(1, narrationSeconds * words / totalWords);
    if (!(Number(node.durationSeconds) > 0) || node.durationWasSuggested !== false) {
      node.durationSeconds = suggested;
      node.durationWasSuggested = true;
    }
    node.startSeconds = cursor;
    cursor += Number(node.durationSeconds) > 0 ? Number(node.durationSeconds) : suggested;
    node.sequenceIndex = index;
  });
  narrationNode.durationSeconds = cursor;
}

function clearActBoardNarrationAlignment(narrationNode) {
  if (!narrationNode) return;
  actBoardNodesForAct(narrationNode.actKey)
    .filter(node => node.type === 'footage' && node.narrationNodeId === narrationNode.id)
    .forEach(node => { node.alignedToNarration = false; });
}

function orderedActBoardNodes(actKey, nodes) {
  const source = Array.isArray(nodes) ? nodes : actBoardNodesForAct(actKey);
  const byId = new Map(source.map(node => [node.id, node]));
  const emitted = new Set();
  const ordered = [];
  source.forEach(node => {
    if (node.type !== 'narration' || emitted.has(node.id)) return;
    ordered.push(node);
    emitted.add(node.id);
    (node.footageNodeIds || []).forEach(id => {
      const footage = byId.get(id);
      if (footage && !emitted.has(footage.id)) {
        ordered.push(footage);
        emitted.add(footage.id);
      }
    });
  });
  source.forEach(node => {
    if (!emitted.has(node.id)) ordered.push(node);
  });
  return ordered;
}

// Arrange the live nodes inside one framed scene board without changing their
// relationships or media timing.  The scene board is a free-form canvas, so
// this is deliberately an explicit user action rather than part of the normal
// responsive geometry pass (which should preserve the user's layout work).
function organizeActBoardSceneNodes(scene, nodes, nodeStack) {
  if (!scene || !nodeStack) return false;
  const source = Array.isArray(nodes) ? nodes : actBoardNodesForAct(scene.actKey);
  const sceneIds = new Set(scene.nodeIds || []);
  const included = source.filter(node => sceneIds.has(node.id) || node.sceneId === scene.id);
  if (!included.length) return false;

  const cards = new Map(Array.from(nodeStack.querySelectorAll('.storyboard-act-board-node[data-node-id]'))
    .map(card => [card.dataset.nodeId, card]));
  const byId = new Map(included.map(node => [node.id, node]));
  const narrations = included.filter(node => node.type === 'narration');
  const footage = included.filter(node => node.type === 'footage');
  const audio = included.filter(node => node.type === 'audio');
  const playback = included.filter(node => node.type === 'playback');

  // Follow the stored narration order first, then direct footage links. This
  // supports both narration → footage chains and footage-only chains.
  const orderedFootage = [];
  const emitted = new Set();
  const addFootage = node => {
    if (!node || node.type !== 'footage' || emitted.has(node.id)) return;
    emitted.add(node.id);
    orderedFootage.push(node);
    const next = byId.get(node.nextFootageNodeId);
    if (next) addFootage(next);
  };
  narrations.forEach(narration => {
    (narration.footageNodeIds || []).forEach(id => addFootage(byId.get(id)));
  });
  footage.filter(node => !node.previousFootageNodeId || !byId.has(node.previousFootageNodeId))
    .forEach(addFootage);
  footage.slice().sort((a, b) => {
    const aSequence = Number(a.sequenceIndex);
    const bSequence = Number(b.sequenceIndex);
    if (Number.isFinite(aSequence) && Number.isFinite(bSequence) && aSequence !== bSequence) {
      return aSequence - bSequence;
    }
    return (Number(a.startSeconds) || 0) - (Number(b.startSeconds) || 0);
  }).forEach(addFootage);

  const sceneCard = nodeStack.querySelector(`[data-board-scene-id="${scene.id}"]`);
  const headerHeight = Math.max(40,
    Number(sceneCard?.querySelector('.storyboard-act-board-board-scene-header')?.offsetHeight) || 0);
  const paddingX = 24;
  const paddingTop = headerHeight + 18;
  const rowGap = 24;
  const columnGap = 16;
  const sceneX = Math.max(0, Number(scene.boardX) || 0);
  const sceneY = Math.max(0, Number(scene.boardY) || 0);
  const dimensions = node => {
    const card = cards.get(node.id);
    const fallbackWidth = node.type === 'narration'
      ? actBoardNodeDurationWidth(node)
      : node.type === 'audio' ? Math.max(220, actBoardNodeDurationWidth(node)) : 154;
    const fallbackHeight = node.type === 'footage' ? 154 : node.type === 'audio' ? 190 : 260;
    return {
      width: Math.max(120, Number(card?.offsetWidth) || Number(node.boardWidth) || fallbackWidth),
      height: Math.max(80, Number(card?.offsetHeight) || Number(node.boardHeight) || fallbackHeight),
    };
  };
  const setPosition = (node, x, y) => {
    node.boardX = Math.max(0, Math.round(x));
    node.boardY = Math.max(0, Math.round(y));
    node.boardPositionMode = 'manual';
    const card = cards.get(node.id);
    if (card) {
      card.style.left = `${node.boardX}px`;
      card.style.top = `${node.boardY}px`;
    }
  };
  const placeRow = (row, y) => {
    let cursorX = sceneX + paddingX;
    let rowHeight = 0;
    row.forEach(node => {
      const size = dimensions(node);
      setPosition(node, cursorX, y);
      cursorX += size.width + columnGap;
      rowHeight = Math.max(rowHeight, size.height);
    });
    return row.length ? { bottom: y + rowHeight, right: cursorX - columnGap } : { bottom: y, right: cursorX };
  };

  let cursorY = sceneY + paddingTop;
  const narrationRow = placeRow(narrations, cursorY);
  cursorY = narrationRow.bottom + rowGap;
  const footageRow = placeRow(orderedFootage, cursorY);
  cursorY = footageRow.bottom + rowGap;
  const audioRow = placeRow(audio, cursorY);
  cursorY = audioRow.bottom + (audio.length ? rowGap : 0);
  // Playback is scene-level rather than part of the requested content order,
  // but placing it last keeps it from covering the organized content.
  const playbackRow = placeRow(playback, cursorY);
  const bottom = Math.max(narrationRow.bottom, footageRow.bottom, audioRow.bottom,
    playbackRow.bottom, sceneY + paddingTop) + 24;
  scene.boardHeight = Math.max(116, Math.round(bottom - sceneY));
  if (sceneCard && !sceneCard.classList.contains('storyboard-act-board-board-scene-in-stack')) {
    sceneCard.style.height = `${scene.boardHeight}px`;
  }
  if (Array.isArray(scene.nodeSnapshots)) {
    scene.nodeSnapshots = scene.nodeSnapshots.map(snapshot => {
      const node = included.find(item => item.id === snapshot.id);
      return node ? snapshotActBoardSceneNode(node) : snapshot;
    });
  }
  if (nodeStack._actBoardLinkState) refreshActBoardLinkPaths(nodeStack);
  expandActBoardScenesToContainNodes(nodeStack, scene.actKey, source);
  saveDebugSession();
  return true;
}

function clearActBoardDirectFootageLink(nodes, footageNode) {
  if (!footageNode || footageNode.type !== 'footage') return;
  const previous = nodes.find(node => node.id === footageNode.previousFootageNodeId);
  const next = nodes.find(node => node.id === footageNode.nextFootageNodeId);
  if (previous && previous.nextFootageNodeId === footageNode.id) previous.nextFootageNodeId = null;
  if (next && next.previousFootageNodeId === footageNode.id) next.previousFootageNodeId = null;
  footageNode.previousFootageNodeId = null;
  footageNode.nextFootageNodeId = null;
}

function wouldCreateActBoardFootageCycle(nodes, source, target) {
  let cursor = target;
  const visited = new Set();
  while (cursor && cursor.type === 'footage' && !visited.has(cursor.id)) {
    if (cursor.id === source.id) return true;
    visited.add(cursor.id);
    cursor = nodes.find(node => node.id === cursor.nextFootageNodeId);
  }
  return false;
}

function linkDirectActBoardFootage(nodes, source, target) {
  if (!source || !target || source.type !== 'footage' || target.type !== 'footage'
    || source.id === target.id || wouldCreateActBoardFootageCycle(nodes, source, target)) return false;
  // Detach both endpoints from their old neighbors before inserting the new
  // edge. Previously this only cleared source→old-next and old-previous→target;
  // a source could keep its old predecessor or a target could keep its old
  // successor, leaving a branched chain after relinking and stale timings on
  // the playback rail.
  const oldNext = nodes.find(node => node.id === source.nextFootageNodeId);
  const oldPreviousOfSource = nodes.find(node => node.id === source.previousFootageNodeId);
  const oldPrevious = nodes.find(node => node.id === target.previousFootageNodeId);
  const oldNextOfTarget = nodes.find(node => node.id === target.nextFootageNodeId);
  if (oldNext && oldNext.previousFootageNodeId === source.id) oldNext.previousFootageNodeId = null;
  if (oldPreviousOfSource && oldPreviousOfSource.nextFootageNodeId === source.id) {
    oldPreviousOfSource.nextFootageNodeId = null;
  }
  if (oldPrevious && oldPrevious.nextFootageNodeId === target.id) oldPrevious.nextFootageNodeId = null;
  if (oldNextOfTarget && oldNextOfTarget.previousFootageNodeId === target.id) {
    oldNextOfTarget.previousFootageNodeId = null;
  }
  source.previousFootageNodeId = null;
  source.nextFootageNodeId = null;
  target.previousFootageNodeId = null;
  target.nextFootageNodeId = null;
  source.nextFootageNodeId = target.id;
  target.previousFootageNodeId = source.id;
  return true;
}

function unlinkActBoardFootageNode(actKey, footageNode) {
  const nodes = actBoardNodesForAct(actKey);
  clearActBoardDirectFootageLink(nodes, footageNode);
  const parent = nodes.find(item => item.type === 'narration'
    && (item.footageNodeIds || []).includes(footageNode.id));
  if (parent) {
    parent.footageNodeIds = parent.footageNodeIds.filter(id => id !== footageNode.id);
    recomputeActBoardTiming(parent);
  }
  footageNode.narrationNodeId = null;
  footageNode.sequenceIndex = null;
}

function attachActBoardFootageBefore(actKey, source, target) {
  if (!source || !target || source.id === target.id) return null;
  const nodes = actBoardNodesForAct(actKey);
  const sourceParent = nodes.find(item => item.type === 'narration'
    && (item.footageNodeIds || []).includes(source.id));
  if (sourceParent) {
    sourceParent.footageNodeIds = sourceParent.footageNodeIds.filter(id => id !== source.id);
    clearActBoardNarrationAlignment(sourceParent);
    recomputeActBoardTiming(sourceParent);
  }
  const targetParent = nodes.find(item => item.type === 'narration'
    && (item.footageNodeIds || []).includes(target.id));
  if (targetParent) {
    const targetIndex = targetParent.footageNodeIds.indexOf(target.id);
    targetParent.footageNodeIds.splice(Math.max(0, targetIndex), 0, source.id);
    source.narrationNodeId = targetParent.id;
    source.actKey = actKey;
    source.durationWasSuggested = false;
    source.alignedToNarration = false;
  } else {
    source.narrationNodeId = null;
    source.sequenceIndex = null;
  }
  return targetParent;
}

function footageNodeVisualSummary(node) {
  if (!node) return '';
  const result = node.results && node.results[node.selectedResultIndex || 0];
  const generated = node.generatedOptions && node.generatedOptions[node.selectedGeneratedIndex || 0];
  return String(node.fragment || generated?.label || result?.source || 'footage').trim();
}

function clearActBoardFootageDropHover(boardLayer) {
  const hover = boardLayer?._actBoardFootageDropHover;
  if (!hover) return null;
  clearTimeout(hover.timer);
  hover.sourceCard?.classList.remove('footage-drop-hover', 'footage-drop-shaking');
  hover.targetCard?.classList.remove('footage-drop-hover', 'footage-drop-shaking');
  boardLayer._actBoardFootageDropHover = null;
  return hover;
}

function actBoardDropElementsAt(boardLayer, source, clientX, clientY) {
  const sourceCard = boardLayer?.querySelector?.(`[data-node-id="${source?.id}"]`);
  const previousPointerEvents = sourceCard?.style.pointerEvents || '';
  if (sourceCard) sourceCard.style.pointerEvents = 'none';
  const elements = typeof document.elementsFromPoint === 'function'
    ? document.elementsFromPoint(clientX, clientY)
    : [document.elementFromPoint(clientX, clientY)];
  if (sourceCard) sourceCard.style.pointerEvents = previousPointerEvents;
  return elements.filter(Boolean).filter(element => {
    const card = element.closest?.('.storyboard-act-board-node-footage');
    return !sourceCard || card !== sourceCard;
  });
}

function updateActBoardFootageDropHover(boardLayer, source, clientX, clientY) {
  if (!boardLayer || !source) return;
  const elements = actBoardDropElementsAt(boardLayer, source, clientX, clientY);
  updateActBoardLinkDropHover(boardLayer, source, elements);
  if (source.type !== 'footage') return;
  const targetCard = elements.map(element => element.closest?.('.storyboard-act-board-node-footage'))
    .find(Boolean);
  const targetId = targetCard?.dataset.nodeId;
  const target = targetId
    ? actBoardNodesForAct(source.actKey).find(node => node.id === targetId) : null;
  const current = boardLayer._actBoardFootageDropHover;
  if (target && target.id !== source.id) {
    if (current && current.target?.id === target.id && current.source?.id === source.id) return;
    clearActBoardFootageDropHover(boardLayer);
    const hover = { source, target, sourceCard: null, targetCard, ready: false, timer: null };
    hover.sourceCard = boardLayer.querySelector(`[data-node-id="${source.id}"]`);
    hover.sourceCard?.classList.add('footage-drop-hover');
    targetCard.classList.add('footage-drop-hover');
    hover.timer = setTimeout(() => {
      if (boardLayer._actBoardFootageDropHover !== hover) return;
      hover.ready = true;
      hover.sourceCard?.classList.add('footage-drop-shaking');
      hover.targetCard?.classList.add('footage-drop-shaking');
    }, 1000);
    boardLayer._actBoardFootageDropHover = hover;
    return;
  }
  if (current) clearActBoardFootageDropHover(boardLayer);
}

function clearActBoardLinkDropHover(boardLayer) {
  const hover = boardLayer?._actBoardLinkDropHover;
  if (!hover) return null;
  clearTimeout(hover.timer);
  hover.sourceCard?.classList.remove('footage-drop-hover', 'footage-drop-shaking');
  hover.targetCards?.forEach(card => card.classList.remove('footage-drop-hover', 'footage-drop-shaking'));
  boardLayer._actBoardLinkDropHover = null;
  return hover;
}

function updateActBoardLinkDropHover(boardLayer, source, elements) {
  if (!boardLayer || !source || !['footage', 'audio', 'narration'].includes(source.type)) return;
  const hit = (elements || []).map(element =>
    element.closest?.('.storyboard-act-board-link-hit-area')).find(Boolean);
  const sourceId = hit?.dataset.sourceId;
  const targetId = hit?.dataset.targetId;
  if (!hit || !sourceId || !targetId || sourceId === source.id || targetId === source.id) {
    clearActBoardLinkDropHover(boardLayer);
    return;
  }
  const current = boardLayer._actBoardLinkDropHover;
  if (current && current.source?.id === source.id
    && current.sourceId === sourceId && current.targetId === targetId) return;
  clearActBoardLinkDropHover(boardLayer);
  const sourceCard = boardLayer.querySelector(`[data-node-id="${source.id}"]`);
  const targetCards = [sourceId, targetId]
    .map(id => boardLayer.querySelector(`[data-node-id="${id}"]`))
    .filter(Boolean);
  const hover = {
    source, sourceId, targetId, sourceCard, targetCards, ready: false, timer: null,
  };
  sourceCard?.classList.add('footage-drop-hover');
  targetCards.forEach(card => card.classList.add('footage-drop-hover'));
  hover.timer = setTimeout(() => {
    if (boardLayer._actBoardLinkDropHover !== hover) return;
    hover.ready = true;
    sourceCard?.classList.add('footage-drop-shaking');
    targetCards.forEach(card => card.classList.add('footage-drop-shaking'));
  }, 1000);
  boardLayer._actBoardLinkDropHover = hover;
}

// Insert a newly-created node into an existing edge after the presenter has
// held it over that edge. Footage has the richer narration/timing behavior in
// the legacy helper below; audio and narration use their own typed chains.
function insertActBoardNodeOnLinkPath(actKey, source, sourceId, targetId) {
  if (!source || source.id === sourceId || source.id === targetId) return false;
  if (source.type === 'footage') {
    if (insertFreeFootageNodeOnActBoardPath(actKey, source, sourceId, targetId)) return true;
    const nodes = actBoardNodesForAct(actKey);
    const first = nodes.find(node => node.id === sourceId);
    const last = nodes.find(node => node.id === targetId);
    if (!first || !last || first.type !== 'footage' || last.type !== 'footage'
      || first.nextFootageNodeId !== last.id || source.narrationNodeId
      || source.previousFootageNodeId || source.nextFootageNodeId) return false;
    if (!linkDirectActBoardFootage(nodes, first, source)
      || !linkDirectActBoardFootage(nodes, source, last)) return false;
    source.actKey = actKey;
    attachActBoardNodeToScene(actKey, source,
      actBoardSceneForNode(actKey, first) || actBoardSceneForNode(actKey, last));
    saveDebugSession();
    rerenderActBoard();
    return true;
  }
  const chain = source.type === 'audio'
    ? { previous: 'previousAudioNodeId', next: 'nextAudioNodeId' }
    : source.type === 'narration'
      ? { previous: 'previousNarrationNodeId', next: 'nextNarrationNodeId' }
      : null;
  if (!chain) return false;
  const nodes = actBoardNodesForAct(actKey);
  const first = nodes.find(node => node.id === sourceId);
  const last = nodes.find(node => node.id === targetId);
  if (!first || !last || first.type !== source.type || last.type !== source.type
    || first[chain.next] !== last.id
    || source[chain.previous] || source[chain.next]) return false;
  if (!linkActBoardNodeChain(nodes, first, source, chain)
    || !linkActBoardNodeChain(nodes, source, last, chain)) return false;
  source.actKey = actKey;
  attachActBoardNodeToScene(actKey, source,
    actBoardSceneForNode(actKey, first) || actBoardSceneForNode(actKey, last));
  syncActBoardLiveSceneSnapshots();
  saveDebugSession();
  rerenderActBoard();
  return true;
}

function insertFreeFootageNodeOnActBoardPath(actKey, source, sourceId, targetId) {
  if (!source || source.type !== 'footage' || source.narrationNodeId) return false;
  const nodes = actBoardNodesForAct(actKey);
  const parent = nodes.find(node => node.type === 'narration'
    && (node.footageNodeIds || []).includes(targetId)
    && (node.id === sourceId || (node.footageNodeIds || []).includes(sourceId)));
  if (!parent) return false;
  const targetIndex = parent.footageNodeIds.indexOf(targetId);
  if (targetIndex < 0 || parent.footageNodeIds.includes(source.id)) return false;
  const targetNode = nodes.find(node => node.id === targetId);
  const oldTotal = parent.footageNodeIds.reduce((sum, id) => {
    const footage = nodes.find(node => node.id === id);
    return sum + Math.max(0.5, Number(footage?.durationSeconds) || 1);
  }, 0);
  const newDuration = Math.max(0.5, Number(source.durationSeconds) || oldTotal / (parent.footageNodeIds.length + 1));
  const scale = oldTotal / Math.max(0.001, oldTotal + newDuration);
  parent.footageNodeIds.splice(targetIndex, 0, source.id);
  source.narrationNodeId = parent.id;
  source.actKey = actKey;
  source.durationWasSuggested = false;
  source.alignedToNarration = false;
  const phrase = String(source.fragment || '').trim();
  const existingNarration = String(parent.transcript || parent.text || '').trim();
  const targetPhrase = String(targetNode?.fragment || '').trim();
  const insertAt = targetPhrase
    ? existingNarration.toLocaleLowerCase().indexOf(targetPhrase.toLocaleLowerCase()) : -1;
  const updatedNarration = insertAt >= 0
    ? `${existingNarration.slice(0, insertAt)}${phrase} ${existingNarration.slice(insertAt)}`.trim()
    : `${existingNarration}${existingNarration ? ' ' : ''}${phrase}`.trim();
  if (parent.transcript) parent.transcript = updatedNarration;
  else parent.text = updatedNarration;
  parent.footageFragments = parent.footageNodeIds
    .map(id => nodes.find(node => node.id === id)?.fragment || '')
    .filter(Boolean);
  nodes.filter(node => node.type === 'footage' && parent.footageNodeIds.includes(node.id))
    .forEach(node => {
      if (node.id === source.id) node.durationSeconds = Number((newDuration * scale).toFixed(1));
      else node.durationSeconds = Number((Math.max(0.5, Number(node.durationSeconds) || 1) * scale).toFixed(1));
      node.durationWasSuggested = false;
      node.alignedToNarration = false;
    });
  clearActBoardNarrationAlignment(parent);
  if (parent.transcript) alignActBoardNarrationFragments(parent);
  recomputeActBoardTiming(parent);
  saveDebugSession();
  rerenderActBoard();
  return true;
}

function openActBoardFootageDropMenu(actKey, source, target, boardLayer, clientX, clientY) {
  boardLayer.querySelector('.storyboard-act-board-footage-drop-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'storyboard-act-board-footage-drop-menu';
  const heading = document.createElement('strong');
  heading.textContent = 'Combine footage nodes';
  menu.appendChild(heading);
  const hint = document.createElement('span');
  hint.textContent = `“${footageNodeVisualSummary(source)}” dropped on “${footageNodeVisualSummary(target)}”`;
  menu.appendChild(hint);
  const choices = [
    ['split-time', 'Split sequence time', 'Give each shot half of the dropped-on shot’s duration.'],
    ['split-screen', 'Create split screen', 'Show both concepts together for the full duration.'],
    ['merge-generative', 'Merge with generative media', 'Generate a new visual concept combining both ideas.'],
  ];
  choices.forEach(([choice, label, description]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'storyboard-act-board-footage-drop-choice';
    const title = document.createElement('b');
    title.textContent = label;
    const detail = document.createElement('small');
    detail.textContent = description;
    button.append(title, detail);
    button.addEventListener('click', async event => {
      event.stopPropagation();
      menu.remove();
      await applyActBoardFootageDropChoice(actKey, source, target, choice);
    });
    menu.appendChild(button);
  });
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'storyboard-act-board-footage-drop-cancel';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', event => {
    event.stopPropagation();
    menu.remove();
  });
  menu.appendChild(cancel);
  const rect = boardLayer.getBoundingClientRect();
  menu.style.left = `${Math.max(8, clientX - rect.left)}px`;
  menu.style.top = `${Math.max(8, clientY - rect.top)}px`;
  menu.addEventListener('pointerdown', event => event.stopPropagation());
  boardLayer.appendChild(menu);
}

async function applyActBoardFootageDropChoice(actKey, source, target, choice) {
  const nodes = actBoardNodesForAct(actKey);
  if (!nodes.includes(source) || !nodes.includes(target)) return;
  const targetDuration = Math.max(0.5, Number(target.durationSeconds) || 1);
  if (choice === 'split-time') {
    const parent = attachActBoardFootageBefore(actKey, source, target);
    const halfDuration = Math.max(0.5, Number((targetDuration / 2).toFixed(1)));
    source.durationSeconds = halfDuration;
    target.durationSeconds = halfDuration;
    source.durationWasSuggested = false;
    target.durationWasSuggested = false;
    source.alignedToNarration = false;
    target.alignedToNarration = false;
    clearActBoardNarrationAlignment(parent);
    recomputeActBoardTiming(parent);
    saveDebugSession();
    rerenderActBoard();
    return;
  }

  const sourceLabel = footageNodeVisualSummary(source);
  const targetLabel = footageNodeVisualSummary(target);
  const parent = target.narrationNodeId
    ? nodes.find(item => item.type === 'narration' && item.id === target.narrationNodeId) : null;
  unlinkActBoardFootageNode(actKey, source);
  target.durationSeconds = targetDuration;
  target.durationWasSuggested = false;
  target.alignedToNarration = false;
  target.compositionMode = choice === 'split-screen' ? 'split-screen' : 'merged';
  target.combinedConceptPrompt = `${targetLabel}; ${sourceLabel}`;
  if (choice === 'split-screen') {
    target.splitScreenNodeIds = Array.from(new Set([target.id, source.id]));
    target.splitScreenLabels = [targetLabel, sourceLabel];
    target.generationStatus = '';
    target.generatedOptions = [];
    target.results = target.results || [];
    if (parent) {
      clearActBoardNarrationAlignment(parent);
      recomputeActBoardTiming(parent);
    }
    saveDebugSession();
    rerenderActBoard();
    return;
  }

  target.splitScreenNodeIds = [];
  target.splitScreenLabels = [];
  target.query = target.combinedConceptPrompt;
  target.generationStatus = 'generating-images';
  target.generationError = '';
  target.generatedOptions = [];
  target.results = [];
  target.mediaUrl = '';
  target.mediaThumbnailUrl = '';
  target.mediaKind = '';
  target.mediaOrigin = '';
  if (parent) {
    clearActBoardNarrationAlignment(parent);
    recomputeActBoardTiming(parent);
  }
  saveDebugSession();
  rerenderActBoard();
  const act = currentArcSections.find(item => item.key === actKey);
  if (act) await generateActBoardNodeExamples(actKey, act, target);
}

function wouldCreateActBoardNodeChainCycle(nodes, source, target, nextField) {
  let cursor = target;
  const visited = new Set();
  while (cursor && !visited.has(cursor.id)) {
    if (cursor.id === source.id) return true;
    visited.add(cursor.id);
    cursor = nodes.find(node => node.id === cursor[nextField]);
  }
  return false;
}

function linkActBoardNodeChain(nodes, source, target, fields) {
  if (!source || !target || source.id === target.id
    || wouldCreateActBoardNodeChainCycle(nodes, source, target, fields.next)) return false;
  const oldNext = nodes.find(node => node.id === source[fields.next]);
  const oldPrevious = nodes.find(node => node.id === target[fields.previous]);
  if (oldNext && oldNext[fields.previous] === source.id) oldNext[fields.previous] = null;
  if (oldPrevious && oldPrevious[fields.next] === target.id) oldPrevious[fields.next] = null;
  source[fields.next] = target.id;
  target[fields.previous] = source.id;
  return true;
}

function clearActBoardNodeChainLink(nodes, node, fields) {
  if (!node) return;
  const previous = nodes.find(item => item.id === node[fields.previous]);
  const next = nodes.find(item => item.id === node[fields.next]);
  if (previous && previous[fields.next] === node.id) previous[fields.next] = null;
  if (next && next[fields.previous] === node.id) next[fields.previous] = null;
  node[fields.previous] = null;
  node[fields.next] = null;
}

function connectActBoardNodes(actKey, sourceId, targetId, options = {}) {
  if (!sourceId || !targetId || sourceId === targetId) return;
  const nodes = actBoardNodesForAct(actKey);
  const source = nodes.find(node => node.id === sourceId);
  const target = nodes.find(node => node.id === targetId);
  if (!source || !target) return;

  if (source.type === 'audio' && target.type === 'audio') {
    if (!linkActBoardNodeChain(nodes, source, target, {
      previous: 'previousAudioNodeId', next: 'nextAudioNodeId',
    })) return;
    attachActBoardNodeToScene(actKey, source, actBoardSceneForNode(actKey, source)
      || actBoardSceneForNode(actKey, target));
    attachActBoardNodeToScene(actKey, target, actBoardSceneForNode(actKey, source)
      || actBoardSceneForNode(actKey, target));
    syncActBoardLiveSceneSnapshots();
    saveDebugSession();
    if (options.render !== false) rerenderActBoard();
    return;
  }
  if (source.type === 'narration' && target.type === 'narration') {
    if (!linkActBoardNodeChain(nodes, source, target, {
      previous: 'previousNarrationNodeId', next: 'nextNarrationNodeId',
    })) return;
    syncActBoardNarrationChainTiming(
      orderedActBoardNarrationChain(actKey, source, nodes));
    attachActBoardNodeToScene(actKey, source, actBoardSceneForNode(actKey, source)
      || actBoardSceneForNode(actKey, target));
    attachActBoardNodeToScene(actKey, target, actBoardSceneForNode(actKey, source)
      || actBoardSceneForNode(actKey, target));
    syncActBoardLiveSceneSnapshots();
    saveDebugSession();
    if (options.render !== false) rerenderActBoard();
    return;
  }
  if (source.type === 'audio' || target.type === 'audio') {
    const audioNode = source.type === 'audio' ? source : target;
    const linkedNode = source.type === 'audio' ? target : source;
    if (!linkActBoardAudioNode(actKey, audioNode, linkedNode)) return;
    saveDebugSession();
    if (options.render !== false) rerenderActBoard();
    return;
  }

  // Narration -> footage creates the umbrella edge. A footage node belongs to
  // one narration chain at a time, so reconnecting it removes the old edge.
  if (source.type === 'narration' && target.type === 'footage') {
    unlinkActBoardFootageNode(actKey, target);
    source.footageNodeIds = Array.from(new Set([...(source.footageNodeIds || []), target.id]));
    target.narrationNodeId = source.id;
    target.actKey = actKey;
    target.durationWasSuggested = true;
    target.alignedToNarration = false;
    const sourceScene = actBoardSceneForNode(actKey, source);
    if (sourceScene) attachActBoardNodeToScene(actKey, target, sourceScene);
    clearActBoardNarrationAlignment(source);
    recomputeActBoardTiming(source);
    // Footage -> footage moves the source node into the target's chain directly
    // before the target. This is the DAG-style way to change sequence order.
  } else if (source.type === 'footage' && target.type === 'footage') {
    if (wouldCreateActBoardFootageCycle(nodes, source, target)) return;
    const sourceScene = actBoardSceneForNode(actKey, source);
    const targetScene = actBoardSceneForNode(actKey, target);
    const sourceParent = nodes.find(node => node.type === 'narration'
      && (node.footageNodeIds || []).includes(source.id));
    const targetParent = nodes.find(node => node.type === 'narration'
      && (node.footageNodeIds || []).includes(target.id));
    if (targetParent) {
      // A footage-to-footage edge is independent of the narration umbrella.
      // Keep the source in its existing narration chain when both shots are
      // already under that narration; only move it between umbrellas when the
      // two parents are different.
      if (sourceParent && sourceParent.id !== targetParent.id) {
        sourceParent.footageNodeIds = sourceParent.footageNodeIds
          .filter(id => id !== source.id);
        clearActBoardNarrationAlignment(sourceParent);
        recomputeActBoardTiming(sourceParent);
      }
      clearActBoardDirectFootageLink(nodes, target);
      targetParent.footageNodeIds = targetParent.footageNodeIds
        .filter(id => id !== source.id);
      const targetIndex = targetParent.footageNodeIds.indexOf(target.id);
      targetParent.footageNodeIds.splice(Math.max(0, targetIndex), 0, source.id);
      source.narrationNodeId = targetParent.id;
      source.actKey = actKey;
      source.durationWasSuggested = true;
      source.alignedToNarration = false;
      if (!linkDirectActBoardFootage(nodes, source, target)) return;
      if (targetScene || targetParent) {
        attachActBoardNodeToScene(actKey, source, targetScene || actBoardSceneForNode(actKey, targetParent));
      }
      clearActBoardNarrationAlignment(targetParent);
      recomputeActBoardTiming(targetParent);
    } else {
      // If the source already belongs to a narration chain, carry the target
      // into that same umbrella rather than detaching the source. A footage
      // chain can therefore be extended without deleting narration → footage.
      if (sourceParent) {
        sourceParent.footageNodeIds = sourceParent.footageNodeIds
          .filter(id => id !== target.id);
        const sourceIndex = sourceParent.footageNodeIds.indexOf(source.id);
        if (sourceIndex >= 0) sourceParent.footageNodeIds.splice(sourceIndex + 1, 0, target.id);
        else sourceParent.footageNodeIds.push(target.id);
        target.narrationNodeId = sourceParent.id;
        target.actKey = actKey;
        target.durationWasSuggested = true;
        target.alignedToNarration = false;
        clearActBoardNarrationAlignment(sourceParent);
        recomputeActBoardTiming(sourceParent);
      }
      // A footage-only chain is also valid. Store the direct edge on both
      // cards so it survives refresh and renders as a normal DAG path.
      if (!linkDirectActBoardFootage(nodes, source, target)) return;
      source.actKey = actKey;
      target.actKey = actKey;
      if (targetScene || sourceScene) {
        attachActBoardNodeToScene(actKey, source, sourceScene || targetScene);
        attachActBoardNodeToScene(actKey, target, targetScene || sourceScene);
      }
      source.sequenceIndex = null;
      target.sequenceIndex = null;
    }
    // Dropping a footage output onto a narration node appends it to that
    // narration's umbrella chain.
  } else if (source.type === 'footage' && target.type === 'narration') {
    unlinkActBoardFootageNode(actKey, source);
    target.footageNodeIds = Array.from(new Set([...(target.footageNodeIds || []), source.id]));
    source.narrationNodeId = target.id;
    source.actKey = actKey;
    source.durationWasSuggested = true;
    source.alignedToNarration = false;
    const targetScene = actBoardSceneForNode(actKey, target);
    if (targetScene) attachActBoardNodeToScene(actKey, source, targetScene);
    clearActBoardNarrationAlignment(target);
    recomputeActBoardTiming(target);
  } else {
    return;
  }
  syncActBoardLiveSceneSnapshots();
  saveDebugSession();
  if (options.render !== false) rerenderActBoard();
}

function clearActBoardLinks(actKey, actLabel, options = {}) {
  const allNodes = actBoardNodesForAct(actKey);
  const openScene = options.sceneId
    ? actBoardScenesForAct(actKey).find(scene => scene.id === options.sceneId)
    : actBoardOpenSceneForAct(actKey);
  if (!openScene) return false;
  const sceneNodeIds = new Set([...(openScene.nodeIds || []),
    ...allNodes.filter(node => node.sceneId === openScene.id).map(node => node.id)]);
  const nodes = allNodes.filter(node => sceneNodeIds.has(node.id));
  if (!nodes.length) return false;
  const hasLinks = nodes.some(node => (node.type === 'narration'
    && Array.isArray(node.footageNodeIds)
    && node.footageNodeIds.some(id => sceneNodeIds.has(id)))
    || (node.type === 'footage' && node.narrationNodeId
      && sceneNodeIds.has(node.narrationNodeId))
    || (node.type === 'footage' && [node.previousFootageNodeId, node.nextFootageNodeId]
      .some(id => sceneNodeIds.has(id)))
    || (node.type === 'audio' && (sceneNodeIds.has(node.linkedToNodeId)
      || sceneNodeIds.has(node.previousAudioNodeId) || sceneNodeIds.has(node.nextAudioNodeId)))
    || (node.type === 'narration' && (sceneNodeIds.has(node.previousNarrationNodeId)
      || sceneNodeIds.has(node.nextNarrationNodeId))));
  if (!hasLinks) return false;
  if (typeof window !== 'undefined' && typeof window.confirm === 'function'
    && options.confirm !== false
    && !window.confirm(`Clear all links in ${openScene.title || actLabel || 'this scene'}? Narration, footage, and sound nodes will stay on the board.`)) return;
  const clearScopedDirectFootageLink = node => {
    const previous = allNodes.find(item => item.id === node.previousFootageNodeId);
    const next = allNodes.find(item => item.id === node.nextFootageNodeId);
    if (previous && sceneNodeIds.has(previous.id) && previous.nextFootageNodeId === node.id) {
      previous.nextFootageNodeId = null;
      node.previousFootageNodeId = null;
    }
    if (next && sceneNodeIds.has(next.id) && next.previousFootageNodeId === node.id) {
      next.previousFootageNodeId = null;
      node.nextFootageNodeId = null;
    }
  };
  const clearScopedChainLink = (node, fields) => {
    const previous = allNodes.find(item => item.id === node[fields.previous]);
    const next = allNodes.find(item => item.id === node[fields.next]);
    if (previous && sceneNodeIds.has(previous.id) && previous[fields.next] === node.id) {
      previous[fields.next] = null;
      node[fields.previous] = null;
    }
    if (next && sceneNodeIds.has(next.id) && next[fields.previous] === node.id) {
      next[fields.previous] = null;
      node[fields.next] = null;
    }
  };
  nodes.forEach(node => {
    if (node.type === 'narration') {
      node.footageNodeIds = (node.footageNodeIds || [])
        .filter(id => !sceneNodeIds.has(id));
    }
    if (node.type === 'footage' && node.narrationNodeId
      && sceneNodeIds.has(node.narrationNodeId)) {
      node.narrationNodeId = null;
      node.sequenceIndex = null;
      node.startSeconds = 0;
      node.durationWasSuggested = true;
      node.alignedToNarration = false;
    }
    if (node.type === 'footage') clearScopedDirectFootageLink(node);
    if (node.type === 'audio' && sceneNodeIds.has(node.linkedToNodeId)) {
      clearActBoardAudioLink(node);
    }
    if (node.type === 'audio') {
      clearScopedChainLink(node, {
        previous: 'previousAudioNodeId', next: 'nextAudioNodeId',
      });
    }
    if (node.type === 'narration') {
      clearScopedChainLink(node, {
        previous: 'previousNarrationNodeId', next: 'nextNarrationNodeId',
      });
    }
  });
  saveDebugSession();
  if (options.rerender !== false) rerenderActBoard();
  return true;
}

function clearActBoard() {
  const hasNodes = Object.values(actBoardNodes || {})
    .some(nodes => Array.isArray(nodes) && nodes.length);
  const hasScenes = Object.values(actBoardScenes || {})
    .some(scenes => Array.isArray(scenes) && scenes.length);
  if (!hasNodes && !hasScenes) return;
  if (typeof window !== 'undefined' && typeof window.confirm === 'function'
    && !window.confirm('Clear the entire act? This removes the current scene and saved scenes.')) return;
  actBoardNodes = Object.create(null);
  actBoardScenes = Object.create(null);
  actBoardOpenSceneByAct = Object.create(null);
  actBoardInitialScenesInitialized = true;
  currentArcSections.forEach(act => actBoardInitialSceneActKeys.add(act.key));
  saveDebugSession();
  rerenderActBoard();
}

function spawnActBoardNodeAt(actKey, type, x, y) {
  if (type === 'narration') {
    const act = currentArcSections.find(item => item.key === actKey);
    if (act) {
      suggestActBoardNarration(actKey, act, null, { x, y });
      return;
    }
  }
    const node = type === 'narration'
    ? {
      id: createActBoardNodeId('narration'), type, actKey, status: 'draft', text: '',
      footageFragments: [], footageNodeIds: [], footageStatus: '', error: '',
      includeNarration: true, startSeconds: 0, trimStartSeconds: 0,
      sourceDurationSeconds: 0, narrationSegmentDurationSeconds: 0,
      previousNarrationNodeId: null, nextNarrationNodeId: null,
    }
    : type === 'audio'
      ? {
        id: createActBoardNodeId('audio'), type, actKey, audioKind: 'sound-effects',
        status: 'ready', query: '', results: [], selectedAudio: null,
        linkedToNodeId: null, linkedToType: null, startSeconds: 0,
        durationSeconds: 2, durationWasSuggested: true, volume: 0.8,
        previousAudioNodeId: null, nextAudioNodeId: null,
      }
      : {
        id: createActBoardNodeId('footage'), type, actKey, status: 'ready',
        fragment: '', query: '', results: [], generationStatus: '',
        videoGenerationTechniques: [...ACT_BOARD_DEFAULT_VIDEO_TECHNIQUES],
        durationSeconds: 2, trimStartSeconds: 0, sourceDurationSeconds: 0,
        durationWasSuggested: true, sequenceIndex: null,
        previousFootageNodeId: null, nextFootageNodeId: null,
      };
  node.boardX = Math.max(0, Number(x) || 0);
  node.boardY = Math.max(0, Number(y) || 0);
  node.boardPositionMode = 'manual';
  attachActBoardNodeToScene(actKey, node);
  actBoardNodesForAct(actKey).push(node);
  saveDebugSession();
  rerenderActBoard();
}

const ACT_BOARD_PIXELS_PER_SECOND = 34;
const ACT_BOARD_NODE_GAP = 24;
const ACT_BOARD_FOOTAGE_GAP = 12;

function actBoardNodeDuration(node) {
  if (!node) return 1;
  const duration = node.type === 'narration'
    ? (Number(node.audioDurationSeconds) || Number(node.narrationAudioDurationSeconds)
      || Number(node.durationSeconds) || estimateActBoardNarrationSeconds(node.text))
    : Number(node.durationSeconds);
  return Math.max(node.type === 'narration' ? 1 : 0.5, Number(duration) || 1);
}

function actBoardNodeDurationWidth(node) {
  if (node.type === 'playback') return 320;
  // Footage cards need enough horizontal room for their thumbnail/source
  // treatment when they are first spawned. Users can still resize them
  // independently afterward.
  const minimum = node.type === 'narration' ? 300 : node.type === 'footage' ? 180 : 120;
  const maximum = node.type === 'narration' ? 1200 : 720;
  return Math.round(Math.max(minimum,
    Math.min(maximum, actBoardNodeDuration(node) * ACT_BOARD_PIXELS_PER_SECOND)));
}

function actBoardCanvasWidth(boardLayer) {
  const column = boardLayer?.closest?.('.storyboard-act-board-column');
  const canvas = boardLayer?.closest?.('.storyboard-act-board-canvas');
  const canvasRectWidth = Number(canvas?.getBoundingClientRect?.().width);
  const columnRectWidth = Number(column?.getBoundingClientRect?.().width);
  return Math.max(240, canvasRectWidth || Number(canvas?.clientWidth)
    || columnRectWidth || Number(column?.clientWidth) || Number(boardLayer?.clientWidth) || 720);
}

function actBoardNarrationMaxWidth(boardLayer) {
  return Math.max(120, Math.floor(actBoardCanvasWidth(boardLayer) * 0.8));
}

function actBoardNarrationWidth(node, boardLayer) {
  const natural = actBoardNodeDurationWidth(node);
  return Math.min(natural, actBoardNarrationMaxWidth(boardLayer));
}

function actBoardAutoWidth(node, boardLayer) {
  const width = node.type === 'narration'
    ? actBoardNarrationWidth(node, boardLayer)
    : node.type === 'audio'
      ? Math.max(220, actBoardNodeDurationWidth(node))
      : actBoardNodeDurationWidth(node);
  // Existing explicit widths are user work. New and previously auto-sized
  // nodes follow their narration/shot timing as durations change.
  // Initialize an auto width once. Rewriting it on every render makes a
  // narration card shrink when suggested footage changes the card's content;
  // the responsive refinement pass below handles actual canvas resizes.
  if (!Number.isFinite(Number(node.boardWidth))) {
    node.boardWidth = width;
    node.boardWidthMode = 'auto';
  }
  const explicitWidth = Number(node.boardWidth) > 0 ? Number(node.boardWidth) : width;
  return node.type === 'narration' && boardLayer
    ? Math.min(explicitWidth, actBoardNarrationMaxWidth(boardLayer)) : explicitWidth;
}

function layoutActBoardNodeGeometry(actKey, nodes) {
  const source = Array.isArray(nodes) ? nodes : actBoardNodesForAct(actKey);
  const narrations = source.filter(node => node.type === 'narration');
  narrations.forEach((narration, narrationIndex) => {
    const fallback = defaultActBoardNodePosition(narration, narrationIndex);
    if (!Number.isFinite(Number(narration.boardX))) {
      narration.boardX = fallback.x;
      narration.boardPositionMode = 'auto';
    }
    if (!Number.isFinite(Number(narration.boardY))) {
      narration.boardY = fallback.y;
      narration.boardPositionMode = 'auto';
    }
    actBoardAutoWidth(narration);
    const parentHeight = Number(narration.boardHeight) > 0
      ? Number(narration.boardHeight) : 260;
    let cursorX = Number(narration.boardX) || 0;
    const childY = (Number(narration.boardY) || 0) + parentHeight + ACT_BOARD_NODE_GAP;
    (narration.footageNodeIds || []).forEach(id => {
      const footage = source.find(node => node.id === id);
      if (!footage) return;
      if (!Number.isFinite(Number(footage.boardX)) || footage.boardPositionMode === 'auto') {
        footage.boardX = cursorX;
        footage.boardPositionMode = 'auto';
      }
      if (!Number.isFinite(Number(footage.boardY)) || footage.boardPositionMode === 'auto') {
        footage.boardY = childY;
        footage.boardPositionMode = 'auto';
      }
      const width = actBoardAutoWidth(footage);
      if (!Number.isFinite(Number(footage.boardHeight)) || footage.boardHeightMode === 'auto') {
        footage.boardHeight = 154;
        footage.boardHeightMode = 'auto';
      }
      cursorX += width + ACT_BOARD_FOOTAGE_GAP;
    });
  });
}

function refineActBoardRenderedGeometry(nodeStack, nodes) {
  if (!nodeStack || !Array.isArray(nodes)) return;
  const cards = new Map(Array.from(nodeStack.querySelectorAll('[data-node-id]'))
    .map(card => [card.dataset.nodeId, card]));
  const narrationNodes = nodes.filter(node => node.type === 'narration');
  const longestNarrationWidth = Math.max(1,
    ...narrationNodes.map(narration => actBoardNodeDurationWidth(narration)));
  const canvasWidth = actBoardCanvasWidth(nodeStack);
  const responsiveNarrationWidth = actBoardNarrationMaxWidth(nodeStack);
  const narrationWidthScale = responsiveNarrationWidth / longestNarrationWidth;
  narrationNodes.forEach(narration => {
    const narrationCard = cards.get(narration.id);
    if (!narrationCard) return;
    const calculatedNarrationWidth = Math.round(actBoardNodeDurationWidth(narration) * narrationWidthScale);
    const previousCanvasWidth = Number(narration.boardWidthCanvasWidth);
    const canvasResized = Number.isFinite(previousCanvasWidth)
      && Math.abs(previousCanvasWidth - canvasWidth) > 1;
    const existingAutoWidth = Number(narration.boardWidth) > 0
      ? Number(narration.boardWidth) : 0;
    const preferredNarrationWidth = narration.boardWidthMode === 'manual'
      && Number(narration.boardWidth) > 0
      ? Number(narration.boardWidth)
      : canvasResized ? calculatedNarrationWidth
        : Math.max(existingAutoWidth, calculatedNarrationWidth);
    const narrationWidth = Math.min(preferredNarrationWidth, actBoardNarrationMaxWidth(nodeStack));
    narrationCard.style.width = `${narrationWidth}px`;
    if (narration.boardWidthMode !== 'manual' || Number(narration.boardWidth) > narrationWidth) {
      narration.boardWidth = narrationWidth;
    }
    narration.boardWidthCanvasWidth = canvasWidth;
    const parentX = parseFloat(narrationCard.style.left) || Number(narration.boardX) || 0;
    const parentY = parseFloat(narrationCard.style.top) || Number(narration.boardY) || 0;
    const parentHeight = narrationCard.offsetHeight || Number(narration.boardHeight) || 260;
    const childY = parentY + parentHeight + ACT_BOARD_NODE_GAP;
    const linked = (narration.footageNodeIds || []).map(id => ({
      node: nodes.find(item => item.id === id), card: cards.get(id),
    })).filter(item => item.node && item.card);
    let cursorX = parentX;
    const defaultFootageWidth = Math.max(180, Math.round(narrationWidth * 0.3));
    linked.forEach(({ node: footage, card: footageCard }) => {
      const width = footage.boardWidthMode === 'manual' && Number(footage.boardWidth) > 0
        ? Number(footage.boardWidth) : defaultFootageWidth;
      if (footage.boardPositionMode === 'auto') {
        footage.boardX = cursorX;
        footage.boardY = childY;
        footageCard.style.left = `${cursorX}px`;
        footageCard.style.top = `${childY}px`;
      }
      if (footage.boardWidthMode !== 'manual') footage.boardWidth = width;
      footageCard.style.width = `${width}px`;
      cursorX += width + ACT_BOARD_FOOTAGE_GAP;
    });
  });
  const maxBottom = nodes.reduce((max, node, index) => {
    const card = cards.get(node.id);
    const position = actBoardNodePosition(node, index);
    const fallbackHeight = node.type === 'footage' ? 154 : 260;
    const height = card?.offsetHeight || Number(node.boardHeight) || fallbackHeight;
    return Math.max(max, position.y + height);
  }, 0);
  const actKey = nodeStack.closest('.storyboard-act-board-column')?.dataset.actKey;
  const maxSceneBottom = actKey
    ? actBoardScenesForAct(actKey)
      .filter(scene => scene.hidden !== true)
      .reduce((max, scene) => Math.max(max,
        (Number(scene.boardY) || 0) + Math.max(116, Number(scene.boardHeight) || 116)), 0)
    : 0;
  nodeStack.style.minHeight = `${Math.max(360, maxBottom + 24, maxSceneBottom + 24)}px`;
}

function defaultActBoardNodePosition(node, index) {
  if (node.type === 'narration') {
    return { x: 16, y: 16 + index * 230 };
  }
  const sequence = Number.isFinite(Number(node.sequenceIndex))
    ? Number(node.sequenceIndex) : index;
  return {
    x: 210 + (sequence % 3) * 174,
    y: 22 + Math.floor(sequence / 3) * 174,
  };
}

function actBoardNodePosition(node, index) {
  const fallback = defaultActBoardNodePosition(node, index);
  return {
    x: Number.isFinite(Number(node.boardX)) ? Number(node.boardX) : fallback.x,
    y: Number.isFinite(Number(node.boardY)) ? Number(node.boardY) : fallback.y,
  };
}

function wireActBoardNodeDragging(card, node, boardLayer, index) {
  if (!boardLayer) return;
  const startPosition = actBoardNodePosition(node, index);
  card.style.left = `${startPosition.x}px`;
  card.style.top = `${startPosition.y}px`;
  card.title = 'Drag to reposition; double-click a node + drag + double-click another to link them.';
  card.addEventListener('pointerdown', event => {
    if (event.target.closest('button, input, audio, a, select, textarea, label, details, summary, .storyboard-act-board-node-text, .storyboard-act-board-node-fragment, .storyboard-act-board-node-fragment-title, .paper-section-open-slot')) return;
    event.preventDefault();
    event.stopPropagation();
    const boardRect = boardLayer.getBoundingClientRect();
    const origin = actBoardNodePosition(node, index);
    const offsetX = event.clientX - boardRect.left - origin.x;
    const offsetY = event.clientY - boardRect.top - origin.y;
    const connectedNodeIds = node.type === 'narration'
      ? Array.from(new Set([...(node.footageNodeIds || []),
        ...actBoardNodesForAct(node.actKey)
          .filter(item => item.type === 'audio'
            && (item.linkedToNodeId === node.id || (node.footageNodeIds || []).includes(item.linkedToNodeId)))
          .map(item => item.id)]))
      : node.type === 'footage'
        ? actBoardNodesForAct(node.actKey)
          .filter(item => item.type === 'audio' && item.linkedToNodeId === node.id)
          .map(item => item.id)
        : [];
    const connectedDragGroup = connectedNodeIds.length
      ? connectedNodeIds
        .map(id => {
          const childNode = actBoardNodesForAct(node.actKey).find(item => item.id === id);
          const childCard = childNode && boardLayer.querySelector(`[data-node-id="${id}"]`);
          if (!childNode || !childCard) return null;
          return {
            node: childNode,
            card: childCard,
            x: parseFloat(childCard.style.left) || Number(childNode.boardX) || 0,
            y: parseFloat(childCard.style.top) || Number(childNode.boardY) || 0,
          };
        })
        .filter(Boolean)
      : [];
    card.classList.add('dragging');
    try { card.setPointerCapture(event.pointerId); } catch (err) { /* optional */ }
    const move = moveEvent => {
      const nextX = Math.max(0, moveEvent.clientX - boardRect.left - offsetX);
      const nextY = Math.max(0, moveEvent.clientY - boardRect.top - offsetY);
      card.style.left = `${nextX}px`;
      card.style.top = `${nextY}px`;
      if (node.type === 'narration' || node.type === 'footage') {
        const deltaX = nextX - origin.x;
        const deltaY = nextY - origin.y;
        connectedDragGroup.forEach(({ card: childCard, x, y }) => {
          childCard.style.left = `${Math.max(0, x + deltaX)}px`;
          childCard.style.top = `${Math.max(0, y + deltaY)}px`;
        });
      }
      if (['footage', 'audio', 'narration'].includes(node.type)) {
        updateActBoardFootageDropHover(boardLayer, node, moveEvent.clientX, moveEvent.clientY);
      }
      expandActBoardScenesToContainNodes(boardLayer, node.actKey);
      refreshActBoardLinkPaths(boardLayer);
    };
    const finish = endEvent => {
      card.removeEventListener('pointermove', move);
      card.removeEventListener('pointerup', finish);
      card.removeEventListener('pointercancel', finish);
      card.classList.remove('dragging');
      node.boardX = parseFloat(card.style.left) || 0;
      node.boardY = parseFloat(card.style.top) || 0;
      node.boardPositionMode = 'manual';
      connectedDragGroup.forEach(({ node: childNode, card: childCard }) => {
        childNode.boardX = parseFloat(childCard.style.left) || 0;
        childNode.boardY = parseFloat(childCard.style.top) || 0;
        childNode.boardPositionMode = 'manual';
        assignActBoardNodeToSceneAtPosition(childNode.actKey, childNode);
      });
      assignActBoardNodeToSceneAtPosition(node.actKey, node);
      expandActBoardScenesToContainNodes(boardLayer, node.actKey);
      const currentMinHeight = parseFloat(boardLayer.style.minHeight) || 0;
      const draggedBottom = connectedDragGroup.reduce((max, { node: childNode, card: childCard }) =>
        Math.max(max, childNode.boardY + childCard.offsetHeight), node.boardY + card.offsetHeight);
      boardLayer.style.minHeight = `${Math.max(currentMinHeight, draggedBottom + 24)}px`;
      refreshActBoardLinkPaths(boardLayer);
      try { card.releasePointerCapture(event.pointerId); } catch (err) { /* optional */ }
      saveDebugSession();
      if (endEvent?.type === 'pointerup'
        && ['footage', 'audio', 'narration'].includes(node.type)) {
        const droppedElements = actBoardDropElementsAt(boardLayer, node,
          endEvent.clientX, endEvent.clientY);
        const droppedPath = droppedElements.map(element =>
          element.closest?.('.storyboard-act-board-link-hit-area')).find(Boolean);
        const linkHover = boardLayer._actBoardLinkDropHover;
        if (droppedPath
          && linkHover?.ready
          && linkHover.source?.id === node.id
          && linkHover.sourceId === droppedPath.dataset.sourceId
          && linkHover.targetId === droppedPath.dataset.targetId) {
          const inserted = insertActBoardNodeOnLinkPath(node.actKey, node,
            droppedPath.dataset.sourceId, droppedPath.dataset.targetId);
          clearActBoardFootageDropHover(boardLayer);
          clearActBoardLinkDropHover(boardLayer);
          if (inserted) return;
        }
        clearActBoardLinkDropHover(boardLayer);
        const droppedCard = droppedElements.map(element =>
          element.closest?.('[data-node-id]')).find(Boolean);
        const droppedId = droppedCard?.dataset.nodeId;
        const droppedNode = droppedId
          ? actBoardNodesForAct(node.actKey).find(item => item.id === droppedId) : null;
        if (droppedNode && droppedNode.type === 'footage' && droppedNode.id !== node.id) {
          const hover = boardLayer._actBoardFootageDropHover;
          clearActBoardFootageDropHover(boardLayer);
          if (hover?.ready && hover.source?.id === node.id && hover.target?.id === droppedNode.id) {
            const sourceCard = boardLayer.querySelector(`[data-node-id="${node.id}"]`);
            const targetCard = boardLayer.querySelector(`[data-node-id="${droppedNode.id}"]`);
            sourceCard?.classList.add('footage-drop-shaking');
            targetCard?.classList.add('footage-drop-shaking');
            setTimeout(() => {
              sourceCard?.classList.remove('footage-drop-shaking');
              targetCard?.classList.remove('footage-drop-shaking');
              if (document.body.contains(boardLayer)) {
                openActBoardFootageDropMenu(node.actKey, node, droppedNode, boardLayer,
                  endEvent.clientX, endEvent.clientY);
              }
            }, 450);
          } else {
            clearActBoardFootageDropHover(boardLayer);
          }
        }
      } else if (node.type === 'footage') {
        clearActBoardFootageDropHover(boardLayer);
        clearActBoardLinkDropHover(boardLayer);
      }
    };
    card.addEventListener('pointermove', move);
    card.addEventListener('pointerup', finish);
    card.addEventListener('pointercancel', finish);
  });
}

function wireActBoardNodeResizing(card, node, boardLayer) {
  if (!boardLayer) return;
  const resizeHandle = document.createElement('span');
  resizeHandle.className = 'storyboard-act-board-node-resize-handle';
  resizeHandle.setAttribute('role', 'button');
  resizeHandle.setAttribute('aria-label', 'Resize board node');
  resizeHandle.title = 'Drag to resize this node';
  card.appendChild(resizeHandle);
  // Keep the resize affordance pinned to the visible bottom-right corner of
  // scrollable nodes while their content is being browsed or resized.
  const syncResizeHandlePosition = () => {
    if (!document.body.contains(card)) return;
    resizeHandle.style.top = `${Math.max(0,
      card.scrollTop + card.clientHeight - resizeHandle.offsetHeight - 3)}px`;
    resizeHandle.style.bottom = 'auto';
  };
  card.addEventListener('scroll', syncResizeHandlePosition, { passive: true });
  if (typeof ResizeObserver === 'function') {
    const handleObserver = new ResizeObserver(() => syncResizeHandlePosition());
    handleObserver.observe(card);
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(syncResizeHandlePosition);
  else syncResizeHandlePosition();
  const savedWidth = Number(node.boardWidth);
  const savedHeight = Number(node.boardHeight);
  const narrationMaxWidth = node.type === 'narration' ? actBoardNarrationMaxWidth(boardLayer) : Infinity;
  if (Number.isFinite(savedWidth) && savedWidth > 0) {
    card.style.width = `${Math.min(savedWidth, narrationMaxWidth)}px`;
  }
  // Audio/music cards need to wrap their full set of controls (player,
  // volume, and source-window editor). Older sessions may have persisted a
  // small boardHeight from when the shared audio class constrained the card
  // itself, so never restore a fixed height for audio nodes.
  if (Number.isFinite(savedHeight) && savedHeight > 0
    && node.type !== 'audio'
    && (node.type !== 'footage' || node.boardHeightMode === 'manual')) {
    card.style.height = `${savedHeight}px`;
  }
  resizeHandle.addEventListener('pointerdown', event => {
    event.preventDefault();
    event.stopPropagation();
    const startWidth = card.offsetWidth;
    const startHeight = card.offsetHeight;
    const canvasMaxWidth = node.type === 'narration' ? actBoardNarrationMaxWidth(boardLayer) : Infinity;
    const minWidth = node.type === 'footage' ? 120 : Math.min(160, canvasMaxWidth);
    const minHeight = node.type === 'footage' ? 120 : 120;
    const maxWidth = node.type === 'footage'
      ? Math.max(620, actBoardNodeDurationWidth(node))
      : canvasMaxWidth;
    const maxHeight = node.type === 'footage' ? 420 : 640;
    // Once the presenter starts resizing, stop the responsive auto-layout from
    // writing its preferred width back over the pointer's live width.
    if (node.type === 'narration') {
      node.boardWidthMode = 'manual';
      node.boardWidth = startWidth;
    }
    if (node.type === 'footage') {
      // Automatic footage cards stay compact, but an explicit user resize
      // must be allowed to exceed that compact default.
      card.classList.add('storyboard-act-board-node-height-manual');
    }
    resizeHandle.classList.add('dragging');
    try { resizeHandle.setPointerCapture(event.pointerId); } catch (err) { /* optional */ }
    const move = moveEvent => {
      const liveMaxWidth = node.type === 'narration'
        ? actBoardNarrationMaxWidth(boardLayer) : maxWidth;
      const liveMinWidth = node.type === 'narration'
        ? Math.min(160, liveMaxWidth) : minWidth;
      const width = Math.max(liveMinWidth,
        Math.min(liveMaxWidth, startWidth + moveEvent.clientX - event.clientX));
      const height = Math.max(minHeight, Math.min(maxHeight, startHeight + moveEvent.clientY - event.clientY));
      card.style.width = `${width}px`;
      card.style.height = `${height}px`;
      syncResizeHandlePosition();
      if (node.type === 'narration') {
        node.boardWidth = width;
        refineActBoardRenderedGeometry(boardLayer, actBoardNodesForAct(node.actKey));
      }
      refreshActBoardLinkPaths(boardLayer);
    };
    const finish = () => {
      resizeHandle.removeEventListener('pointermove', move);
      resizeHandle.removeEventListener('pointerup', finish);
      resizeHandle.removeEventListener('pointercancel', finish);
      resizeHandle.classList.remove('dragging');
      node.boardWidth = card.offsetWidth;
      node.boardHeight = card.offsetHeight;
      node.boardWidthMode = 'manual';
      node.boardHeightMode = 'manual';
      syncResizeHandlePosition();
      const currentMinHeight = parseFloat(boardLayer.style.minHeight) || 0;
      const top = parseFloat(card.style.top) || 0;
      boardLayer.style.minHeight = `${Math.max(currentMinHeight, top + node.boardHeight + 24)}px`;
      refreshActBoardLinkPaths(boardLayer);
      try { resizeHandle.releasePointerCapture(event.pointerId); } catch (err) { /* optional */ }
      saveDebugSession();
    };
    resizeHandle.addEventListener('pointermove', move);
    resizeHandle.addEventListener('pointerup', finish);
    resizeHandle.addEventListener('pointercancel', finish);
  });
}

function actBoardLinkPoint(boardLayer, card, towardCard) {
  const layerRect = boardLayer.getBoundingClientRect();
  const rect = card.getBoundingClientRect();
  const centerX = rect.left - layerRect.left + rect.width / 2;
  const centerY = rect.top - layerRect.top + rect.height / 2;
  const towardRect = towardCard && towardCard.getBoundingClientRect();
  const towardX = towardRect ? towardRect.left - layerRect.left + towardRect.width / 2 : centerX + 1;
  const right = towardX >= centerX;
  return {
    x: right ? rect.right - layerRect.left : rect.left - layerRect.left,
    y: centerY,
  };
}

function actBoardLinkPathD(from, to) {
  const direction = to.x >= from.x ? 1 : -1;
  const bend = Math.min(84, Math.max(28, Math.abs(to.x - from.x) * 0.35));
  return `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} C ${(from.x + bend * direction).toFixed(1)} ${from.y.toFixed(1)}, ${(to.x - bend * direction).toFixed(1)} ${to.y.toFixed(1)}, ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
}

function refreshActBoardLinkPaths(boardLayer, pointer) {
  const state = boardLayer && boardLayer._actBoardLinkState;
  if (!state) return;
  const width = Math.max(boardLayer.clientWidth, 1);
  const height = Math.max(boardLayer.clientHeight, 1);
  state.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  state.svg.setAttribute('width', String(width));
  state.svg.setAttribute('height', String(height));
  const cards = new Map(Array.from(boardLayer.querySelectorAll('[data-node-id]'))
    .map(card => [card.dataset.nodeId, card]));
  state.paths.forEach(link => {
    const sourceCard = cards.get(link.sourceId);
    const targetCard = cards.get(link.targetId);
    if (!sourceCard || !targetCard) return;
    const from = actBoardLinkPoint(boardLayer, sourceCard, targetCard);
    const to = actBoardLinkPoint(boardLayer, targetCard, sourceCard);
    const pathD = actBoardLinkPathD(from, to);
    link.path.setAttribute('d', pathD);
    link.hitPath?.setAttribute('d', pathD);
  });
  if (state.pendingPath && state.sourceId) {
    const sourceCard = cards.get(state.sourceId);
    if (!sourceCard) return;
    const from = actBoardLinkPoint(boardLayer, sourceCard, null);
    const to = pointer || { x: from.x + 80, y: from.y };
    state.pendingPath.setAttribute('d', actBoardLinkPathD(from, to));
  }
}

function clearActBoardPendingLink(boardLayer) {
  const state = boardLayer && boardLayer._actBoardLinkState;
  if (!state || !state.sourceId) return;
  state.sourceId = null;
  state.pendingPath?.remove();
  state.pendingPath = null;
  boardLayer.querySelectorAll('.storyboard-act-board-node.link-source')
    .forEach(card => card.classList.remove('link-source'));
  boardLayer.removeEventListener('pointermove', state.onPointerMove);
}

function removeActBoardLink(actKey, sourceId, targetId) {
  const nodes = actBoardNodesForAct(actKey);
  const target = nodes.find(node => node.id === targetId);
  if (!target) return;
  const source = nodes.find(node => node.id === sourceId);
  if (source?.type === 'footage' && target.type === 'footage'
    && target.previousFootageNodeId === source.id) {
    if (source.nextFootageNodeId === target.id) source.nextFootageNodeId = null;
    target.previousFootageNodeId = null;
    saveDebugSession();
    rerenderActBoard();
    return;
  }
  if (source?.type === 'audio' && target.type === 'audio'
    && target.previousAudioNodeId === source.id) {
    clearActBoardNodeChainLink(nodes, target, {
      previous: 'previousAudioNodeId', next: 'nextAudioNodeId',
    });
    saveDebugSession();
    rerenderActBoard();
    return;
  }
  if (source?.type === 'narration' && target.type === 'narration'
    && target.previousNarrationNodeId === source.id) {
    clearActBoardNodeChainLink(nodes, target, {
      previous: 'previousNarrationNodeId', next: 'nextNarrationNodeId',
    });
    saveDebugSession();
    rerenderActBoard();
    return;
  }
  if (target.type === 'audio' && target.linkedToNodeId === sourceId) {
    clearActBoardAudioLink(target);
    saveDebugSession();
    rerenderActBoard();
    return;
  }
  const parent = nodes.find(node => node.type === 'narration'
    && (node.footageNodeIds || []).includes(target.id));
  if (!parent) return;
  parent.footageNodeIds = parent.footageNodeIds.filter(id => id !== target.id);
  target.narrationNodeId = null;
  target.sequenceIndex = null;
  target.startSeconds = 0;
  target.durationWasSuggested = true;
  target.alignedToNarration = false;
  clearActBoardNarrationAlignment(parent);
  recomputeActBoardTiming(parent);
  saveDebugSession();
  rerenderActBoard();
}

function wireActBoardNodeLinking(card, actKey, node, boardLayer) {
  if (!boardLayer || node.type === 'playback') return;
  let lastPointerUp = 0;
  let suppressNativeDoubleClickUntil = 0;
  const activateLink = event => {
    if (event.target.closest('button, input, audio, a, select, textarea, label, details, summary, .storyboard-act-board-node-resize-handle')) return;
    event.preventDefault();
    event.stopPropagation();
    // The link layer is normally created immediately after the board is
    // appended, but a fast double-click during the first render can arrive
    // before that deferred pass. Create it on demand so linking never depends
    // on render timing.
    if (!boardLayer._actBoardLinkState) {
      buildActBoardLinkLayer(boardLayer, actBoardNodesForAct(actKey));
    }
    const state = boardLayer._actBoardLinkState;
    if (!state) return;
    if (state.sourceId) {
      if (state.sourceId === node.id) {
        clearActBoardPendingLink(boardLayer);
        return;
      }
      const sourceId = state.sourceId;
      clearActBoardPendingLink(boardLayer);
      connectActBoardNodes(actKey, sourceId, node.id);
      return;
    }
    state.sourceId = node.id;
    card.classList.add('link-source');
    state.pendingPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    state.pendingPath.classList.add('storyboard-act-board-link-path', 'pending');
    state.pendingPath.setAttribute('marker-end', `url(#${state.pendingMarkerId})`);
    state.svg.appendChild(state.pendingPath);
    state.onPointerMove = moveEvent => {
      const rect = boardLayer.getBoundingClientRect();
      refreshActBoardLinkPaths(boardLayer, {
        x: moveEvent.clientX - rect.left,
        y: moveEvent.clientY - rect.top,
      });
    };
    boardLayer.addEventListener('pointermove', state.onPointerMove);
    boardLayer.tabIndex = 0;
    boardLayer.focus({ preventScroll: true });
    refreshActBoardLinkPaths(boardLayer);
  };
  // Native dblclick can be suppressed by the node's drag pointer handler in
  // some browsers. Keep the native path for track/menu dispatches, and use a
  // tiny pointer-up fallback for physical double-clicks on a card.
  card.addEventListener('dblclick', event => {
    if (Date.now() < suppressNativeDoubleClickUntil) return;
    activateLink(event);
  });
  card.addEventListener('pointerup', event => {
    if (event.button !== 0
      || event.target.closest('button, input, audio, a, select, textarea, label, details, summary, .storyboard-act-board-node-resize-handle')) return;
    const now = Date.now();
    if (now - lastPointerUp <= 420) {
      lastPointerUp = 0;
      suppressNativeDoubleClickUntil = now + 500;
      activateLink(event);
    } else {
      lastPointerUp = now;
    }
  });
}

function buildActBoardLinkLayer(boardLayer, nodes) {
  const markerId = createActBoardNodeId('link-arrow');
  const pendingMarkerId = `${markerId}-pending`;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('storyboard-act-board-link-layer');
  svg.setAttribute('aria-hidden', 'true');
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  [[markerId, '#3d79a8'], [pendingMarkerId, '#d47700']].forEach(([id, color]) => {
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    marker.setAttribute('id', id);
    marker.setAttribute('markerWidth', '5');
    marker.setAttribute('markerHeight', '5');
    marker.setAttribute('refX', '4.5');
    marker.setAttribute('refY', '2.5');
    marker.setAttribute('orient', 'auto');
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    arrow.setAttribute('d', 'M 0 0 L 5 2.5 L 0 5 z');
    arrow.setAttribute('fill', color);
    marker.appendChild(arrow);
    defs.appendChild(marker);
  });
  svg.appendChild(defs);
  boardLayer.insertBefore(svg, boardLayer.firstChild);
  const byId = new Map(nodes.map(node => [node.id, node]));
  const paths = [];
  const addLinkPath = (sourceId, targetId, kind = '') => {
    if (!byId.has(sourceId) || !byId.has(targetId)) return;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.classList.add('storyboard-act-board-link-path');
    if (kind) path.classList.add(kind);
    path.setAttribute('marker-end', `url(#${markerId})`);
    const selectLink = event => {
      event.preventDefault();
      event.stopPropagation();
      const state = boardLayer._actBoardLinkState;
      if (!state) return;
      state.paths.forEach(item => item.path.classList.remove('selected'));
      const selected = state.paths.find(item => item.path === path);
      if (selected) {
        path.classList.add('selected');
        state.selectedPath = selected;
        boardLayer.tabIndex = 0;
        boardLayer.focus({ preventScroll: true });
      }
    };
    path.addEventListener('click', selectLink);
    const hitPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hitPath.classList.add('storyboard-act-board-link-hit-area');
    hitPath.dataset.sourceId = sourceId;
    hitPath.dataset.targetId = targetId;
    hitPath.addEventListener('click', selectLink);
    svg.append(path, hitPath);
    paths.push({ sourceId, targetId, path, hitPath });
  };
  nodes.filter(node => node.type === 'narration').forEach(narration => {
    let previousId = narration.id;
    (narration.footageNodeIds || []).forEach(targetId => {
      addLinkPath(previousId, targetId,
        previousId === narration.id ? 'narration-link' : 'footage-link');
      previousId = targetId;
    });
  });
  nodes.filter(node => node.type === 'footage' && node.previousFootageNodeId)
    .forEach(node => addLinkPath(node.previousFootageNodeId, node.id, 'footage-link'));
  nodes.filter(node => node.type === 'audio' && node.linkedToNodeId)
    .forEach(node => addLinkPath(node.linkedToNodeId, node.id, 'audio-link'));
  nodes.filter(node => node.type === 'audio' && node.previousAudioNodeId)
    .forEach(node => addLinkPath(node.previousAudioNodeId, node.id, 'audio-link'));
  nodes.filter(node => node.type === 'narration' && node.previousNarrationNodeId)
    .forEach(node => addLinkPath(node.previousNarrationNodeId, node.id, 'narration-chain-link'));
  boardLayer._actBoardLinkState = {
    svg, paths, sourceId: null, pendingPath: null, onPointerMove: null,
    pendingMarkerId, selectedPath: null,
  };
  const handleLinkKeyboard = event => {
    if (event.key === 'Escape') {
      const state = boardLayer._actBoardLinkState;
      if (!state?.sourceId) return;
      event.preventDefault();
      event.stopPropagation();
      clearActBoardPendingLink(boardLayer);
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace')
      && boardLayer._actBoardLinkState?.selectedPath) {
      event.preventDefault();
      const selected = boardLayer._actBoardLinkState.selectedPath;
      removeActBoardLink(boardLayer.closest('.storyboard-act-board-column')?.dataset.actKey,
        selected.sourceId, selected.targetId);
    }
  };
  boardLayer.addEventListener('keydown', handleLinkKeyboard);
  // The board normally receives focus when linking starts, but a double-click
  // can leave focus on the SVG/path or another control. Keep Escape reliable
  // without requiring the presenter to click the board again.
  const handleWindowLinkKeyboard = event => {
    if (!document.body.contains(boardLayer)) {
      window.removeEventListener('keydown', handleWindowLinkKeyboard, true);
      return;
    }
    if (event.key === 'Escape') handleLinkKeyboard(event);
  };
  window.addEventListener('keydown', handleWindowLinkKeyboard, true);
  refreshActBoardLinkPaths(boardLayer);
}

function wireActBoardNodeSpawn(nodeStack, actKey) {
  const closeSpawnMenu = () => {
    nodeStack.querySelector('.storyboard-act-board-node-spawn-menu')?.remove();
  };
  nodeStack.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const menu = nodeStack.querySelector('.storyboard-act-board-node-spawn-menu');
    if (!menu) return;
    event.preventDefault();
    event.stopPropagation();
    menu.remove();
  });
  nodeStack.addEventListener('dblclick', event => {
    if (event.target.closest('.storyboard-act-board-node, .storyboard-act-board-node-spawn-menu, .storyboard-act-board-footage-drop-menu')) return;
    const visibleScenes = actBoardScenesForAct(actKey).filter(scene => scene.hidden !== true);
    if (!visibleScenes.length) {
      const shouldAddScene = typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm('There are no scene boards on this act. Add a new scene before adding nodes?')
        : false;
      if (shouldAddScene) {
        createActBoardEmptyScene(actKey);
        saveDebugSession();
        rerenderActBoard();
      }
      return;
    }
    const rect = nodeStack.getBoundingClientRect();
    const x = Math.max(0, event.clientX - rect.left);
    const y = Math.max(0, event.clientY - rect.top);
    closeSpawnMenu();
    const menu = document.createElement('div');
    menu.className = 'storyboard-act-board-node-spawn-menu';
    menu.tabIndex = -1;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    const label = document.createElement('span');
    label.textContent = 'Add node';
    menu.appendChild(label);
    [['narration', 'Narration node'], ['footage', 'Footage node'], ['audio', 'Sound / music node']].forEach(([type, text]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = text;
      button.addEventListener('click', buttonEvent => {
        buttonEvent.preventDefault();
        buttonEvent.stopPropagation();
        spawnActBoardNodeAt(actKey, type, x, y);
      });
      menu.appendChild(button);
    });
    menu.addEventListener('click', menuEvent => menuEvent.stopPropagation());
    menu.addEventListener('keydown', menuEvent => {
      if (menuEvent.key === 'Escape') {
        menuEvent.preventDefault();
        menuEvent.stopPropagation();
        menu.remove();
      }
    });
    nodeStack.appendChild(menu);
    menu.focus({ preventScroll: true });
  });
  // Focus can move to the canvas, a control, or another panel after the
  // double-click. Keep Escape global to this live board so the spawn menu
  // still closes even when nodeStack is no longer the active event target.
  const handleWindowSpawnKeyboard = event => {
    if (!document.body.contains(nodeStack)) {
      window.removeEventListener('keydown', handleWindowSpawnKeyboard, true);
      return;
    }
    if (event.key !== 'Escape' || !nodeStack.querySelector('.storyboard-act-board-node-spawn-menu')) return;
    event.preventDefault();
    event.stopPropagation();
    closeSpawnMenu();
  };
  window.addEventListener('keydown', handleWindowSpawnKeyboard, true);
}

function actBoardRectsIntersect(a, b) {
  if (!a || !b) return false;
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function wireActBoardSceneMarquee(nodeStack, actKey) {
  if (!nodeStack || nodeStack._actBoardSceneMarqueeWired) return;
  nodeStack._actBoardSceneMarqueeWired = true;
  let gesture = null;

  const clearSelection = () => {
    nodeStack.querySelectorAll('.storyboard-act-board-node.scene-marquee-selected')
      .forEach(card => card.classList.remove('scene-marquee-selected'));
  };
  const updateSelection = (clientX, clientY) => {
    if (!gesture) return;
    const left = Math.min(gesture.startClientX, clientX);
    const right = Math.max(gesture.startClientX, clientX);
    const top = Math.min(gesture.startClientY, clientY);
    const bottom = Math.max(gesture.startClientY, clientY);
    const selectionRect = { left, right, top, bottom };
    const stackRect = nodeStack.getBoundingClientRect();
    const x = Math.max(0, left - stackRect.left + nodeStack.scrollLeft);
    const y = Math.max(0, top - stackRect.top + nodeStack.scrollTop);
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);
    gesture.marquee.style.left = `${x}px`;
    gesture.marquee.style.top = `${y}px`;
    gesture.marquee.style.width = `${width}px`;
    gesture.marquee.style.height = `${height}px`;
    gesture.hasMoved = gesture.hasMoved || width > 6 || height > 6;
    nodeStack.querySelectorAll('.storyboard-act-board-node[data-node-id]')
      .forEach(card => card.classList.toggle(
        'scene-marquee-selected', actBoardRectsIntersect(card.getBoundingClientRect(), selectionRect)));
  };
  const finish = event => {
    if (!gesture) return;
    const current = gesture;
    gesture = null;
    current.marquee.remove();
    clearSelection();
    try { nodeStack.releasePointerCapture(current.pointerId); } catch (err) { /* optional */ }
    if (!current.hasMoved || event?.type === 'pointercancel') return;
    const selected = Array.from(nodeStack.querySelectorAll('.storyboard-act-board-node[data-node-id]'))
      .filter(card => actBoardRectsIntersect(card.getBoundingClientRect(), current.selectionRect))
      .map(card => card.dataset.nodeId)
      .filter(Boolean);
    if (!selected.length) return;
    const actNodes = actBoardNodesForAct(actKey);
    const selectedNodes = selected
      .map(nodeId => actNodes.find(node => node.id === nodeId))
      .filter(Boolean);
    const sceneId = createActBoardSceneId();
    // A defined scene owns the playback node for each narration it contains.
    // Include those nodes in the framed scene and in its restorable snapshot
    // even when the lasso only enclosed the narration/footage cards.
    const scenePlayback = ensureActBoardPlaybackNode(actKey, null, { create: true, sceneId });
    const playbackNodes = scenePlayback ? [scenePlayback] : [];
    const sceneNodes = Array.from(new Map([...selectedNodes, ...playbackNodes]
      .map(node => [node.id, node])).values());
    const sceneNodeIds = sceneNodes.map(node => node.id);
    const stackRect = nodeStack.getBoundingClientRect();
    const selectedSet = new Set(sceneNodeIds);
    const selectedCards = Array.from(nodeStack.querySelectorAll('.storyboard-act-board-node[data-node-id]'))
      .filter(card => selectedSet.has(card.dataset.nodeId));
    const bounds = selectedCards.reduce((result, card) => {
      const rect = card.getBoundingClientRect();
      const left = rect.left - stackRect.left + nodeStack.scrollLeft;
      const top = rect.top - stackRect.top + nodeStack.scrollTop;
      const right = left + rect.width;
      const bottom = top + rect.height;
      return {
        left: Math.min(result.left, left), top: Math.min(result.top, top),
        right: Math.max(result.right, right), bottom: Math.max(result.bottom, bottom),
      };
    }, { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
    // Newly created scene playback nodes do not have a DOM card until the
    // rerender below. Include their persisted geometry in the scene frame so
    // the playback card appears inside the defined scene board.
    const renderedIds = new Set(selectedCards.map(card => card.dataset.nodeId));
    playbackNodes.filter(node => !renderedIds.has(node.id)).forEach(node => {
      const position = actBoardNodePosition(node, 0);
      const width = actBoardNodeDurationWidth(node);
      const height = 220;
      bounds.left = Math.min(bounds.left, position.x);
      bounds.top = Math.min(bounds.top, position.y);
      bounds.right = Math.max(bounds.right, position.x + width);
      bounds.bottom = Math.max(bounds.bottom, position.y + height);
    });
    if (!Number.isFinite(bounds.left)) return;
    const scenes = actBoardScenesForAct(actKey);
    ensureActBoardSceneSnapshots(actKey);
    const inheritedSceneMode = selectedNodes
      .map(node => actBoardSceneForNode(actKey, node)?.documentaryMode)
      .find(mode => DOCUMENTARY_MODES.some(candidate => candidate.key === mode));
    const inheritedSceneModeSource = selectedNodes
      .map(node => actBoardSceneForNode(actKey, node)?.documentaryModeSource)
      .find(source => source === 'user');
    selectedNodes.forEach(node => { node.sceneId = sceneId; });
    playbackNodes.forEach(node => { node.sceneId = sceneId; });
    scenes.push({
      id: sceneId,
      actKey,
      title: nextActBoardSceneTitle(scenes),
      nodeIds: sceneNodeIds,
      nodeSnapshots: sceneNodes.map(snapshotActBoardSceneNode).filter(Boolean),
      nodeLinks: snapshotActBoardSceneLinks(actNodes, sceneNodeIds),
      // Keep every framed scene board on the same left edge as the loadable
      // scene cards below. The board still expands rightward to encompass
      // the selected nodes.
      boardX: 0,
      boardY: Math.max(0, bounds.top - 40),
      boardWidth: Math.max(220, bounds.right + 16),
      boardHeight: Math.max(116, bounds.bottom - Math.max(0, bounds.top - 40) + 16),
      boardPositionMode: 'manual',
      documentaryMode: inheritedSceneMode || actBoardDefaultSceneMode(),
      documentaryModeSource: inheritedSceneModeSource || 'moodboard',
      includeNarration: true,
      sequenceStartNodeId: null,
      committedToStack: true,
    });
    setActBoardOpenScene(actKey, scenes[scenes.length - 1]);
    // Keep the defined nodes visible on the working canvas. The scene card is
    // also added to the act-board stack, but defining a scene must not hide or
    // remove the material unless the user explicitly clears it.
    saveDebugSession();
    rerenderActBoard();
  };

  nodeStack.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target !== nodeStack) return;
    // A short click remains inert so the existing blank-space double-click
    // gesture can still open the node spawn menu.
    const rect = nodeStack.getBoundingClientRect();
    const marquee = document.createElement('div');
    marquee.className = 'storyboard-act-board-scene-marquee';
    nodeStack.appendChild(marquee);
    gesture = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      hasMoved: false,
      marquee,
      selectionRect: { left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY },
    };
    try { nodeStack.setPointerCapture(event.pointerId); } catch (err) { /* optional */ }
    const move = moveEvent => {
      if (!gesture || gesture.pointerId !== moveEvent.pointerId) return;
      const left = Math.min(gesture.startClientX, moveEvent.clientX);
      const right = Math.max(gesture.startClientX, moveEvent.clientX);
      const top = Math.min(gesture.startClientY, moveEvent.clientY);
      const bottom = Math.max(gesture.startClientY, moveEvent.clientY);
      gesture.selectionRect = { left, right, top, bottom };
      updateSelection(moveEvent.clientX, moveEvent.clientY);
    };
    nodeStack.addEventListener('pointermove', move);
    const cleanup = () => {
      nodeStack.removeEventListener('pointermove', move);
      nodeStack.removeEventListener('pointerup', cleanup);
      nodeStack.removeEventListener('pointercancel', cleanup);
    };
    nodeStack.addEventListener('pointerup', eventUp => {
      cleanup();
      finish(eventUp);
    }, { once: true });
    nodeStack.addEventListener('pointercancel', eventCancel => {
      cleanup();
      finish(eventCancel);
    }, { once: true });
  });
}

function actBoardSourceSection(actKey) {
  return actBoardSectionsForAct(actKey)[0] || null;
}

function actBoardGenerationContext(actKey, act, node) {
  const source = actBoardSourceSection(actKey);
  const narrationNode = actBoardNodesForAct(actKey).find(item =>
    item.type === 'narration' && item.id === node.narrationNodeId);
  const linkedFootagePhrases = narrationNode
    ? (narrationNode.footageNodeIds || [])
      .map(id => actBoardNodesForAct(actKey).find(item => item.id === id))
      .filter(Boolean)
      .map(item => item.fragment || '')
      .filter(Boolean)
    : [];
  return {
    documentaryMode: actBoardDocumentaryModeForNode(actKey, node),
    sectionIndex: source && Number.isInteger(source.index) ? source.index : 0,
    title: `${act.label || 'Act'} · ${actBoardImageGenerationPhrase(node) || 'footage'}`,
    // Send the Act Board's visual context as separate API fields. Keep only
    // scene-level notes here so the backend does not receive bundled copies.
    sceneNotes: `${act.description || ''}${node.combinedConceptPrompt ? `\nCombine visual concepts: ${node.combinedConceptPrompt}` : ''}`.trim(),
    specificPhrase: actBoardImageGenerationPhrase(node),
    parentNarration: narrationNode?.transcript || narrationNode?.text || '',
    linkedFootagePhrases,
    techniques: actBoardSuggestedTechniques(actKey, node),
    actTitle: act.label || '',
    source,
  };
}

// Act Board uses the same distilled technique palette as Timeline + Scenes,
// but keeps it local to the node-generation request. This deliberately does
// not mutate timeline scene.techniques or add any of the excluded visual
// reference inputs to the Act Board image prompt.
const ACT_BOARD_VISUAL_PROXY_TECHNIQUES = [
  'Visual metaphor',
  'Data visualization',
  'Animated diagram',
  'Map progression',
  'Juxtaposition',
  'On-screen text',
];

function actBoardMoodboardTechniquePool() {
  const selected = selectedTechniques.size ? Array.from(selectedTechniques) : [];
  const distilled = lastDistillResult && Array.isArray(lastDistillResult.suggested_techniques)
    ? lastDistillResult.suggested_techniques : [];
  return sanitizeDocumentaryTechniques(selected.length ? selected : distilled);
}

function actBoardSuggestedTechniques(actKey, node) {
  if (Array.isArray(node?.imageGenerationTechniques)) {
    return filterActBoardTechniques(
      node.imageGenerationTechniques, ACT_BOARD_IMAGE_TECHNIQUE_CATEGORIES);
  }
  const moodboardTechniques = actBoardMoodboardTechniquePool();
  const candidates = Array.from(new Set(moodboardTechniques));
  const suggested = [];
  const add = technique => {
    if (isDocumentaryTechnique(technique)
      && ACT_BOARD_IMAGE_TECHNIQUE_CATEGORIES.has(TECHNIQUE_CATEGORY[technique])
      && !suggested.includes(technique)) suggested.push(technique);
  };

  // Keep the same category spread as the timeline's auto-population: favor a
  // concrete composition and lighting choice before adding other moodboard
  // directions, so the image prompt always has something filmable to stage.
  ['composition', 'lighting', 'metaphor_dataviz'].forEach(category => {
    add(candidates.find(technique => TECHNIQUE_CATEGORY[technique] === category));
  });
  candidates.forEach(add);

  const isVisualProxy = node?.filmabilityBucket === 'abstract'
    || Boolean(String(node?.filmabilityProxy || '').trim());
  if (isVisualProxy) {
    // A proxy should not be treated as a literal stock subject. Ensure the
    // prompt has at least two concrete metaphor/data-vis devices even when
    // the moodboard distillation did not happen to return that category.
    const proxyCandidates = candidates.filter(technique =>
      TECHNIQUE_CATEGORY[technique] === 'metaphor_dataviz');
    [...proxyCandidates, ...ACT_BOARD_VISUAL_PROXY_TECHNIQUES]
      .slice(0, 2).forEach(add);
  }

  // Keep the prompt compact while retaining category spread and proxy
  // guidance. Six is enough to make composition, lighting, and metaphor
  // visibly distinct without overwhelming the shot-plan LLM.
  return suggested.slice(0, 6);
}

function actBoardImageGenerationPhrase(node) {
  if (node && Object.prototype.hasOwnProperty.call(node, 'imageGenerationPhrase')) {
    return String(node.imageGenerationPhrase || '').trim();
  }
  return String(node?.fragment || '').trim();
}

function closeActBoardTechniquePopup() {
  actBoardTechniquePopupCleanup?.();
  actBoardTechniquePopupCleanup = null;
  actBoardTechniquePopupEl?.remove();
  actBoardTechniquePopupEl = null;
  hideTechniqueMotionPreview();
}

function openActBoardVideoMovementPopup(actKey, node) {
  closeActBoardTechniquePopup();
  const selected = new Set(ensureActBoardVideoGenerationTechniques(node));
  const backdrop = document.createElement('div');
  backdrop.className = 'storyboard-act-board-technique-popup-backdrop';
  const dialog = document.createElement('section');
  dialog.className = 'storyboard-act-board-technique-popup narrative-arc-techniques';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Video camera movement');

  const header = document.createElement('div');
  header.className = 'storyboard-act-board-technique-popup-header';
  const heading = document.createElement('strong');
  heading.textContent = 'Video camera movement';
  const actions = document.createElement('div');
  actions.className = 'storyboard-act-board-technique-popup-actions';
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'btn-secondary';
  cancelButton.textContent = 'Cancel';
  const doneButton = document.createElement('button');
  doneButton.type = 'button';
  doneButton.className = 'btn-primary';
  doneButton.textContent = 'Done';
  actions.append(cancelButton, doneButton);
  header.append(heading, actions);
  dialog.appendChild(header);

  // const categoryLabel = document.createElement('div');
  // categoryLabel.className = 'technique-category-label';
  // categoryLabel.textContent = 'Camera movement';
  const row = document.createElement('div');
  row.className = 'chip-row';
  Object.entries(TECHNIQUE_CATEGORY)
    .filter(([, category]) => category === 'movement')
    .map(([technique]) => technique)
    .forEach(technique => row.appendChild(buildTechniqueChip(technique, {
      selectionSet: selected,
      standard: STANDARD_TECHNIQUE_SET.has(technique),
      moodboardDerived: actBoardMoodboardTechniquePool().includes(technique),
    })));
  dialog.append(row);

  const finish = save => {
    if (save) {
      node.videoGenerationTechniques = filterActBoardTechniques(
        Array.from(selected), ACT_BOARD_VIDEO_TECHNIQUE_CATEGORIES);
      saveDebugSession();
    }
    closeActBoardTechniquePopup();
    if (save) rerenderActBoard();
  };
  cancelButton.addEventListener('click', () => finish(false));
  doneButton.addEventListener('click', () => finish(true));
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) finish(false);
  });
  dialog.addEventListener('click', event => event.stopPropagation());
  const handleKeydown = event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  };
  window.addEventListener('keydown', handleKeydown, true);
  actBoardTechniquePopupCleanup = () => window.removeEventListener('keydown', handleKeydown, true);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);
  actBoardTechniquePopupEl = backdrop;
  doneButton.focus({ preventScroll: true });
}

function openActBoardTechniquePopup(actKey, node, options = {}) {
  if (!node) return;
  if (options.targetField === 'videoGenerationTechniques') {
    openActBoardVideoMovementPopup(actKey, node);
    return;
  }
  closeActBoardTechniquePopup();
  const allowedCategories = options.allowedCategories || ACT_BOARD_IMAGE_TECHNIQUE_CATEGORIES;
  const targetField = options.targetField || 'imageGenerationTechniques';
  const defaultSelection = targetField === 'imageGenerationTechniques'
    ? actBoardSuggestedTechniques(actKey, node) : [];
  const selected = new Set(filterActBoardTechniques(
    Array.isArray(node[targetField]) ? node[targetField] : defaultSelection,
    allowedCategories));
  const moodboardSet = new Set(filterActBoardTechniques(
    actBoardMoodboardTechniquePool(), allowedCategories));
  const standardSet = new Set(filterActBoardTechniques(
    STANDARD_TECHNIQUE_SET, allowedCategories));
  let popupView = techniquePanelView === 'standard' ? 'standard' : 'moodboard';

  const backdrop = document.createElement('div');
  backdrop.className = 'storyboard-act-board-technique-popup-backdrop';
  const dialog = document.createElement('section');
  dialog.className = 'storyboard-act-board-technique-popup narrative-arc-techniques';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  const popupTitle = options.title || 'Image generation techniques';
  dialog.setAttribute('aria-label', popupTitle);
  const header = document.createElement('div');
  header.className = 'storyboard-act-board-technique-popup-header';
  const heading = document.createElement('strong');
  heading.textContent = popupTitle;
  const headerActions = document.createElement('div');
  headerActions.className = 'storyboard-act-board-technique-popup-actions';
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'btn-secondary';
  cancelButton.textContent = 'Cancel';
  const doneButton = document.createElement('button');
  doneButton.type = 'button';
  doneButton.className = 'btn-primary';
  doneButton.textContent = 'Done';
  headerActions.append(cancelButton, doneButton);
  header.append(heading, headerActions);
  dialog.appendChild(header);
  // const hint = document.createElement('p');
  // hint.className = 'storyboard-act-board-technique-popup-hint';
  // hint.textContent = options.hint
  //   || 'Choose shot composition, lighting, or visual metaphor/data-vis techniques for this image.';
  // dialog.appendChild(hint);

  const toggle = document.createElement('div');
  toggle.className = 'technique-view-toggle';
  const moodboardButton = document.createElement('button');
  moodboardButton.type = 'button';
  moodboardButton.className = 'technique-view-toggle-btn';
  moodboardButton.setAttribute('aria-label', 'Show moodboard-distilled techniques');
  moodboardButton.title = 'Moodboard distilled techniques';
  const standardButton = document.createElement('button');
  standardButton.type = 'button';
  standardButton.className = 'technique-view-toggle-btn';
  standardButton.setAttribute('aria-label', 'Show standard filmmaking toolkit');
  standardButton.title = 'Standard filmmaking toolkit';
  toggle.append(moodboardButton, standardButton);
  dialog.appendChild(toggle);
  const moodboardView = document.createElement('div');
  moodboardView.className = 'technique-view technique-view-moodboard';
  const standardView = document.createElement('div');
  standardView.className = 'technique-view technique-view-standard';
  dialog.append(moodboardView, standardView);

  const renderTechniqueViews = () => {
    moodboardView.replaceChildren();
    standardView.replaceChildren();
    const moodboardHeading = document.createElement('div');
    moodboardHeading.className = 'technique-source-label moodboard';
    moodboardHeading.textContent = 'Distilled from your moodboard';
    moodboardView.appendChild(moodboardHeading);
    const moodboardHint = document.createElement('div');
    moodboardHint.className = 'chip-row-caption';
    moodboardHint.textContent = 'Select the moodboard-derived direction for this node.';
    moodboardView.appendChild(moodboardHint);
    const byCategory = new Map();
    Array.from(moodboardSet).forEach(technique => {
      const category = TECHNIQUE_CATEGORY[technique] || 'other';
      if (!byCategory.has(category)) byCategory.set(category, []);
      byCategory.get(category).push(technique);
    });
    [...TECHNIQUE_CATEGORY_ORDER, { key: 'other', label: 'Other' }].forEach(({ key, label }) => {
      const items = byCategory.get(key);
      if (!items?.length) return;
      const categoryLabel = document.createElement('div');
      categoryLabel.className = 'technique-category-label';
      categoryLabel.textContent = label;
      const row = document.createElement('div');
      row.className = 'chip-row';
      items.forEach(technique => row.appendChild(buildTechniqueChip(technique, {
        selectionSet: selected,
        moodboardDerived: true,
      })));
      moodboardView.append(categoryLabel, row);
    });
    if (!moodboardSet.size) {
      const empty = document.createElement('div');
      empty.className = 'technique-source-empty';
      empty.textContent = 'No moodboard techniques have been distilled yet.';
      moodboardView.appendChild(empty);
    }

    const standardHeading = document.createElement('div');
    standardHeading.className = 'technique-source-label standard';
    standardHeading.textContent = 'Standard filmmaking toolkit';
    standardView.appendChild(standardHeading);
    const standardHint = document.createElement('div');
    standardHint.className = 'chip-row-caption';
    standardHint.textContent = 'Common composition, movement, and lighting choices.';
    standardView.appendChild(standardHint);
    STANDARD_TECHNIQUE_GROUPS.forEach(group => {
      const allowedGroupTechniques = group.techniques.filter(technique =>
        !allowedCategories || allowedCategories.has(TECHNIQUE_CATEGORY[technique]));
      if (!allowedGroupTechniques.length) return;
      const categoryLabel = document.createElement('div');
      categoryLabel.className = 'technique-category-label';
      categoryLabel.textContent = group.label;
      const row = document.createElement('div');
      row.className = 'chip-row';
      allowedGroupTechniques.forEach(technique => row.appendChild(buildTechniqueChip(technique, {
        selectionSet: selected,
        standard: true,
        moodboardDerived: moodboardSet.has(technique),
      })));
      standardView.append(categoryLabel, row);
    });

    const activeExtras = Array.from(selected).filter(technique =>
      !moodboardSet.has(technique) && !standardSet.has(technique));
    if (activeExtras.length) {
      const activeLabel = document.createElement('div');
      activeLabel.className = 'technique-source-label moodboard';
      activeLabel.textContent = 'Active for this node';
      const activeRow = document.createElement('div');
      activeRow.className = 'chip-row';
      activeExtras.forEach(technique => activeRow.appendChild(buildTechniqueChip(technique, {
        selectionSet: selected,
      })));
      standardView.append(activeLabel, activeRow);
    }
    const moodboardActive = popupView === 'moodboard';
    moodboardView.style.display = moodboardActive ? '' : 'none';
    standardView.style.display = moodboardActive ? 'none' : '';
    moodboardButton.classList.toggle('active', moodboardActive);
    standardButton.classList.toggle('active', !moodboardActive);
    moodboardButton.setAttribute('aria-pressed', String(moodboardActive));
    standardButton.setAttribute('aria-pressed', String(!moodboardActive));
  };
  moodboardButton.addEventListener('click', () => {
    popupView = 'moodboard';
    renderTechniqueViews();
  });
  standardButton.addEventListener('click', () => {
    popupView = 'standard';
    renderTechniqueViews();
  });
  const finish = save => {
    if (save) {
      node[targetField] = filterActBoardTechniques(Array.from(selected), allowedCategories);
      saveDebugSession();
    }
    closeActBoardTechniquePopup();
    if (save) rerenderActBoard();
  };
  cancelButton.addEventListener('click', () => finish(false));
  doneButton.addEventListener('click', () => finish(true));
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) finish(false);
  });
  dialog.addEventListener('click', event => event.stopPropagation());
  const handleKeydown = event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  };
  window.addEventListener('keydown', handleKeydown, true);
  actBoardTechniquePopupCleanup = () => window.removeEventListener('keydown', handleKeydown, true);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);
  actBoardTechniquePopupEl = backdrop;
  renderTechniqueViews();
  doneButton.focus({ preventScroll: true });
}

// Keep Act Board image generation intentionally narrow. Unlike the
// Timeline + Scenes image path, this path does not pull in paper figures,
// uploaded footage frames, abstract text, moodboard profiles, or a combined
// concept prompt.
function actBoardImageGenerationInputs(actKey, act, node) {
  const nodes = actBoardNodesForAct(actKey);
  const parentNarration = node?.narrationNodeId
    ? nodes.find(item => item.type === 'narration' && item.id === node.narrationNodeId)
    : null;
  const footagePhrases = parentNarration
    ? (parentNarration.footageNodeIds || [])
      .map(id => nodes.find(item => item.type === 'footage' && item.id === id))
      .filter(Boolean)
      .map(item => String(item.fragment || '').trim())
      .filter(Boolean)
    : [];
  return {
    // The image-generation phrase is an Act Board-only override. Keep the
    // original narration fragment intact for linking, while making the value
    // the user entered here the actual subject sent to the shot planner.
    phrase: actBoardImageGenerationPhrase(node),
    narration: parentNarration
      ? String(parentNarration.transcript || parentNarration.text || '').trim()
      : '',
    linkedFootagePhrases: Array.from(new Set(footagePhrases)),
    documentaryMode: actBoardDocumentaryModeForNode(actKey, node),
    techniques: actBoardSuggestedTechniques(actKey, node),
  };
}

function actBoardImageGenerationContext(actKey, act, node) {
  const inputs = actBoardImageGenerationInputs(actKey, act, node);
  return {
    ...inputs,
    // The phrase, parent narration, and linked footage sequence are sent as
    // separate API fields below. Keep sceneNotes free of bundled copies.
    sceneNotes: '',
    title: inputs.phrase || 'footage',
    actTitle: '',
    sectionIndex: (() => {
      const source = actBoardSourceSection(actKey);
      return source && Number.isInteger(source.index) ? source.index : 0;
    })(),
  };
}

async function generateActBoardNodeExamples(actKey, act, node) {
  const jobKey = `${actKey}:${node.id}:images`;
  const jobToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  actBoardGenerationJobs.set(jobKey, jobToken);
  const getLiveNode = () => actBoardNodesForAct(actKey).find(item => item.id === node.id) || node;
  const context = actBoardImageGenerationContext(actKey, act, node);
  node.generationStatus = 'generating-images';
  node.generationError = '';
  saveDebugSession();
  rerenderActBoard();
  try {
    const result = await fetchGenerateShotExamples({
      sectionIndex: context.sectionIndex,
      title: context.title,
      sceneNotes: context.sceneNotes,
      specificPhrase: context.phrase,
      parentNarration: context.narration,
      linkedFootagePhrases: context.linkedFootagePhrases,
      narration: context.narration,
      actTitle: context.actTitle,
      documentaryMode: context.documentaryMode,
      techniques: context.techniques,
      count: 1,
      video: false,
      projectId: premiereProjectId,
    });
    premiereProjectId = result.project_id;
    if (actBoardGenerationJobs.get(jobKey) !== jobToken) return;
    node = getLiveNode();
    const freshGeneratedOptions = (result.examples || []).map(example => ({
      url: example.preview_url,
      thumbnail_url: example.thumbnail_url || example.preview_url,
      kind: example.kind || 'image',
      label: example.label || 'Generated example',
      shot_size: example.shot_size || '',
      movement: example.movement || '',
      // Preserve the exact visual phrase used for this generated image. A
      // later video request should not silently switch to a newly edited node
      // phrase when this image remains selected.
      specificPhrase: context.phrase,
      shotPlan: {
        shot_size: example.shot_size || '',
        movement: example.movement || '',
        narrative_operation: example.narrative_operation || '',
        purpose: example.purpose || '',
        visual_description: example.visual_description || '',
      },
    }));
    const selectedKeyBeforeGeneration = String(node.selectedVisualKey || '');
    const selectedGeneratedBeforeGeneration = selectedKeyBeforeGeneration.startsWith('generated-')
      ? node.generatedOptions?.[Number(selectedKeyBeforeGeneration.slice('generated-'.length))]
      : null;
    node.generatedOptions = mergePinnedActBoardVisuals(node.generatedOptions, freshGeneratedOptions);
    node.shotPlan = result.shot_plan || (node.generatedOptions[0] && node.generatedOptions[0].shotPlan) || {};
    node.generationStatus = 'ready';
    // Generating examples populates the rail only. It must not silently make
    // a new image the selected footage: the upload prompt (or the visual the
    // presenter already chose) remains the active source until clicked.
    let selectedKey = selectedKeyBeforeGeneration;
    if (selectedGeneratedBeforeGeneration) {
      const preservedIndex = node.generatedOptions.findIndex(option =>
        actBoardVisualIdentity(option) === actBoardVisualIdentity(selectedGeneratedBeforeGeneration));
      if (preservedIndex >= 0) {
        selectedKey = `generated-${preservedIndex}`;
        node.selectedVisualKey = selectedKey;
        node.selectedGeneratedIndex = preservedIndex;
      } else {
        selectedKey = 'upload';
        node.selectedVisualKey = selectedKey;
      }
    }
    const selectedGeneratedIndex = selectedKey.startsWith('generated-')
      ? Number(selectedKey.slice('generated-'.length)) : -1;
    const selectedResultIndex = selectedKey.startsWith('result-')
      ? Number(selectedKey.slice('result-'.length)) : -1;
    const selectionStillExists = selectedKey === 'upload' || !selectedKey
      || (selectedKey.startsWith('generated-')
        && Number.isInteger(selectedGeneratedIndex)
        && Boolean(node.generatedOptions[selectedGeneratedIndex]))
      || (selectedKey.startsWith('result-')
        && Number.isInteger(selectedResultIndex)
        && Boolean(node.results?.[selectedResultIndex]));
    if (!selectionStillExists) node.selectedVisualKey = 'upload';
    if (!node.selectedVisualKey || node.selectedVisualKey === 'upload') {
      node.mediaUrl = '';
      node.mediaThumbnailUrl = '';
      node.mediaKind = '';
      node.mediaOrigin = '';
    }
    saveDebugSession();
    rerenderActBoard();
  } catch (err) {
    node = getLiveNode();
    node.generationStatus = 'error';
    node.generationError = err.message;
    saveDebugSession();
    rerenderActBoard();
  } finally {
    if (actBoardGenerationJobs.get(jobKey) === jobToken) actBoardGenerationJobs.delete(jobKey);
  }
}

async function generateActBoardNodeVideo(actKey, act, node) {
  const selectedIndex = String(node.selectedVisualKey || '').startsWith('generated-')
    ? Number(node.selectedVisualKey.slice('generated-'.length)) : -1;
  const selected = selectedIndex >= 0 && node.generatedOptions
    ? node.generatedOptions[selectedIndex] : null;
  const chosenImageUrl = selected && selected.kind !== 'video' ? selected.url : node.mediaKind === 'image' ? node.mediaUrl : '';
  if (!chosenImageUrl) {
    node.error = 'Generate or upload an image before generating a video.';
    saveDebugSession();
    rerenderActBoard();
    return;
  }
  const context = actBoardGenerationContext(actKey, act, node);
  const selectedImagePhrase = selected
    && Object.prototype.hasOwnProperty.call(selected, 'specificPhrase')
    ? String(selected.specificPhrase || '').trim()
    : context.specificPhrase;
  const videoTechniques = ensureActBoardVideoGenerationTechniques(node);
  const cameraMovement = videoTechniques[0] || '';
  if (!cameraMovement) {
    node.error = 'Choose a camera movement in Video generation inputs before generating a video.';
    saveDebugSession();
    rerenderActBoard();
    return;
  }
  const jobKey = `${actKey}:${node.id}:video`;
  const jobToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  actBoardGenerationJobs.set(jobKey, jobToken);
  const getLiveNode = () => actBoardNodesForAct(actKey).find(item => item.id === node.id) || node;
  node.generationStatus = 'generating-video';
  node.generationError = '';
  saveDebugSession();
  rerenderActBoard();
  try {
    // Camera movement is chosen in the Video generation inputs. Generate a
    // fresh shot plan from that choice immediately before animating, rather
    // than reusing the image-generation plan.
    const planResult = await fetchGenerateShotPlan({
      sectionIndex: context.sectionIndex,
      title: context.title,
      sceneNotes: context.sceneNotes,
      specificPhrase: selectedImagePhrase,
      parentNarration: context.parentNarration,
      linkedFootagePhrases: context.linkedFootagePhrases,
      documentaryMode: context.documentaryMode,
      techniques: videoTechniques,
      cameraMovement,
      projectId: premiereProjectId,
    });
    premiereProjectId = planResult.project_id || premiereProjectId;
    if (actBoardGenerationJobs.get(jobKey) !== jobToken) return;
    node = getLiveNode();
    node.shotPlan = planResult.shot_plan || {};
    saveDebugSession();
    const result = await fetchGenerateShotVideo({
      sectionIndex: context.sectionIndex,
      chosenImageUrl,
      sceneNotes: context.sceneNotes,
      specificPhrase: selectedImagePhrase,
      parentNarration: context.parentNarration,
      linkedFootagePhrases: context.linkedFootagePhrases,
      documentaryMode: context.documentaryMode,
      techniques: videoTechniques,
      cameraMovement,
      projectId: premiereProjectId,
      shotPlan: node.shotPlan || {},
    });
    premiereProjectId = result.project_id;
    if (actBoardGenerationJobs.get(jobKey) !== jobToken) return;
    node = getLiveNode();
    const video = {
      url: result.preview_url,
      thumbnail_url: result.thumbnail_url || chosenImageUrl,
      kind: 'video',
      label: 'Generated video',
      shot_size: (result.shot_plan && result.shot_plan.shot_size) || (node.shotPlan && node.shotPlan.shot_size) || '',
      movement: (result.shot_plan && result.shot_plan.movement) || (node.shotPlan && node.shotPlan.movement) || '',
      specificPhrase: selected?.specificPhrase || context.specificPhrase || '',
      shotPlan: result.shot_plan || node.shotPlan || {},
    };
    node.generatedOptions = [...(node.generatedOptions || []), video];
    node.selectedGeneratedIndex = node.generatedOptions.length - 1;
    // A generated video is the output the presenter just asked for, so make
    // that exact option the selected preview. Image generation deliberately
    // leaves the upload/current selection alone, but video generation should
    // immediately show and play the newly-created animation in the node.
    node.selectedVisualKey = `generated-${node.selectedGeneratedIndex}`;
    node.mediaUrl = video.url;
    node.mediaThumbnailUrl = video.thumbnail_url;
    node.mediaKind = 'video';
    node.mediaOrigin = 'generated';
    node.shotPlan = video.shotPlan;
    node.generationStatus = 'ready';
    saveDebugSession();
    rerenderActBoard();
  } catch (err) {
    node = getLiveNode();
    node.generationStatus = 'error';
    node.generationError = err.message;
    saveDebugSession();
    rerenderActBoard();
  } finally {
    if (actBoardGenerationJobs.get(jobKey) === jobToken) actBoardGenerationJobs.delete(jobKey);
  }
}

function actBoardSectionsForAct(actKey) {
  return currentSections.filter(section =>
    isSceneActive(section) && currentAssignments[section.index] === actKey);
}

function actBoardNarrationAudioSource(actKey, narrationNode) {
  if (!narrationNode) return null;
  if (narrationNode.audioPreviewUrl) return narrationNode;
  const section = actBoardSectionsForAct(actKey).find(item =>
    migrateNarrationClips(item).some(clip => clip.previewUrl || clip._nativePreviewUrl));
  if (!section) return null;
  return migrateNarrationClips(section)
    .find(clip => clip.previewUrl || clip._nativePreviewUrl) || null;
}

function actBoardNarrationSegmentDuration(node) {
  if (!node) return 0;
  return Math.max(0, Number(
    node.narrationSegmentDurationSeconds
      || node.audioDurationSeconds
      || node.narrationAudioDurationSeconds
      || node.durationSeconds
      || 0,
  ) || 0);
}

function orderedActBoardNarrationChain(actKey, rootNode, candidates = null) {
  if (!rootNode || rootNode.type !== 'narration') return [];
  const nodes = Array.isArray(candidates) ? candidates : actBoardNodesForAct(actKey);
  const narrations = nodes.filter(node => node.type === 'narration');
  const byId = new Map(narrations.map(node => [node.id, node]));
  let first = byId.get(rootNode.id) || rootNode;
  const seen = new Set();
  while (first?.previousNarrationNodeId && byId.has(first.previousNarrationNodeId)
    && !seen.has(first.id)) {
    seen.add(first.id);
    first = byId.get(first.previousNarrationNodeId);
  }
  const ordered = [];
  seen.clear();
  let cursor = first;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    if (cursor.includeNarration !== false) ordered.push(cursor);
    cursor = byId.get(cursor.nextNarrationNodeId);
  }
  return ordered;
}

function syncActBoardNarrationChainTiming(chain) {
  if (!Array.isArray(chain) || chain.length < 2) return;
  let cursor = Math.max(0, Number(chain[0].startSeconds) || 0);
  chain.forEach((node, index) => {
    if (index > 0 && !node.timingWasManuallyAdjusted) node.startSeconds = Number(cursor.toFixed(2));
    const duration = Math.max(0.5,
      actBoardNarrationSegmentDuration(node)
        || estimateActBoardNarrationSeconds(node.transcript || node.text));
    cursor = Math.max(cursor, (Number(node.startSeconds) || 0) + duration);
  });
}

function actBoardPlaybackTimingLabel(startSeconds, durationSeconds) {
  const start = Math.max(0, Number(startSeconds) || 0);
  const duration = Math.max(0, Number(durationSeconds) || 0);
  const end = start + duration;
  return `${start.toFixed(1)}–${end.toFixed(1)}s`;
}

function setActBoardNodeTimingText(timing, value) {
  if (!timing) return;
  const text = timing.querySelector('.storyboard-act-board-node-timing-text');
  if (text) text.textContent = value;
  else timing.textContent = value;
}

function stopActBoardPlayback() {
  const state = actBoardPlaybackState;
  if (!state) return;
  if (state.clockTimer) {
    clearInterval(state.clockTimer);
    state.clockTimer = null;
  }
  state.audio?.pause();
  if (state.audio) state.audio.currentTime = 0;
  if (actBoardNativeAudioElement === state.audio) actBoardNativeAudioElement = null;
  state.audioLayers?.forEach(layer => {
    layer.element?.pause();
    try { layer.element.currentTime = 0; } catch (err) { /* optional */ }
  });
  state.narrationAudioLayers?.forEach(layer => {
    if (layer.element === state.audio) return;
    layer.element?.pause();
    try { layer.element.currentTime = 0; } catch (err) { /* optional */ }
  });
  state.video?.pause();
  state.playing = false;
  state.audioEnded = false;
  state.clockTime = 0;
  state.updatePlaybackProgress?.();
  state.activeCards?.forEach(card => card.classList.remove('act-board-playback-active'));
  state.scrubCleanup?.();
  state.scrubCleanup = null;
  if (state.playButton) state.playButton.textContent = 'Play back';
  if (state.stopButton) state.stopButton.disabled = true;
  if (state.status && !state.error) state.status.textContent = '';
  if (state.stage) state.stage.classList.remove('playing');
  actBoardPlaybackState = null;
}

function actBoardSelectedFootageMedia(footage) {
  if (!footage) return { url: '', kind: 'image', thumbnailUrl: '' };
  const selectedKey = String(footage.selectedVisualKey || '');
  const generated = selectedKey.startsWith('generated-') && Array.isArray(footage.generatedOptions)
    ? footage.generatedOptions[footage.selectedGeneratedIndex || 0]
    : null;
  const result = selectedKey.startsWith('result-') && Array.isArray(footage.results)
    ? footage.results[footage.selectedResultIndex || 0]
    : null;
  const url = footage.mediaUrl
    || generated?.url
    || result?.localPreviewUrl
    || result?.video_url
    || '';
  const kind = footage.mediaKind || generated?.kind || (result ? 'video' : 'image');
  const thumbnailUrl = footage.mediaThumbnailUrl
    || generated?.thumbnail_url
    || result?.thumbnail_url
    || '';
  return { url, kind, thumbnailUrl };
}

// The timeline start controls where a footage node appears in the scene. The
// source-in control selects the portion of a longer clip that is actually
// used for that node. Keep this derived helper in one place so the node UI,
// browser playback, and MP4 export all apply the same source-duration cap.
function actBoardFootageSourceDuration(footage) {
  if (!footage) return 0;
  const selectedKey = String(footage.selectedVisualKey || '');
  const selectedResult = selectedKey.startsWith('result-') && Array.isArray(footage.results)
    ? footage.results[footage.selectedResultIndex || 0] : null;
  const selectedGenerated = selectedKey.startsWith('generated-') && Array.isArray(footage.generatedOptions)
    ? footage.generatedOptions[footage.selectedGeneratedIndex || 0] : null;
  return Math.max(0, Number(
    footage.sourceDurationSeconds
      || selectedResult?.duration_seconds
      || selectedResult?.duration
      || selectedGenerated?.duration_seconds
      || 0,
  ) || 0);
}

function orderedActBoardLinkedFootage(actKey, narrationNode) {
  if (!narrationNode) return [];
  const nodes = actBoardNodesForAct(actKey);
  const order = new Map((narrationNode.footageNodeIds || []).map((id, index) => [id, index]));
  return (narrationNode.footageNodeIds || [])
    .map(id => nodes.find(item => item.id === id))
    .filter(item => item && item.type === 'footage')
    .sort((a, b) => {
      const aSequence = Number(a.sequenceIndex);
      const bSequence = Number(b.sequenceIndex);
      if (Number.isFinite(aSequence) && Number.isFinite(bSequence)
        && aSequence !== bSequence) {
        return aSequence - bSequence;
      }
      const aStart = Number(a.startSeconds);
      const bStart = Number(b.startSeconds);
      if (Number.isFinite(aStart) && Number.isFinite(bStart) && Math.abs(aStart - bStart) > 0.001) {
        return aStart - bStart;
      }
      return (order.get(a.id) || 0) - (order.get(b.id) || 0);
    });
}

function actBoardAudioSource(node) {
  const selected = node?.selectedAudio || null;
  return {
    url: selected?.localPreviewUrl || selected?.preview_url || node?.audioPreviewUrl || '',
    name: selected?.name || node?.audioName || 'Sound effect',
    trimStartSeconds: Math.max(0, Number(selected?.trimStartSeconds
      ?? node?.trimStartSeconds) || 0),
    durationSeconds: Number(selected?.durationSeconds || node?.durationSeconds) || 0,
    sourceDurationSeconds: Number(selected?.sourceDurationSeconds || selected?.duration
      || node?.sourceDurationSeconds || node?.durationSeconds) || 0,
  };
}

function actBoardNarrationForNode(actKey, node) {
  if (!node) return null;
  const nodes = actBoardNodesForAct(actKey);
  if (node.type === 'narration') return node;
  if (node.type === 'footage' && node.narrationNodeId) {
    return nodes.find(item => item.type === 'narration' && item.id === node.narrationNodeId) || null;
  }
  if (node.type === 'audio' && node.linkedToNodeId) {
    const linked = nodes.find(item => item.id === node.linkedToNodeId);
    return actBoardNarrationForNode(actKey, linked);
  }
  return null;
}

function orderedActBoardLinkedAudio(actKey, narrationNode) {
  if (!narrationNode) return [];
  const nodes = actBoardNodesForAct(actKey);
  const footageIds = new Set(narrationNode.footageNodeIds || []);
  const linked = nodes.filter(node => node.type === 'audio'
    && (node.linkedToNodeId === narrationNode.id || footageIds.has(node.linkedToNodeId)))
    .sort((a, b) => (Number(a.startSeconds) || 0) - (Number(b.startSeconds) || 0));
  linked.forEach(audioNode => {
    if (audioNode.timingWasManuallyAdjusted) return;
    const target = nodes.find(item => item.id === audioNode.linkedToNodeId);
    if (!target) return;
    const start = Math.max(0, Number(target.startSeconds) || 0);
    const duration = target.type === 'footage'
      ? Number(target.durationSeconds) || 1
      : actBoardNarrationSegmentDuration(target) || estimateActBoardNarrationSeconds(target.text);
    audioNode.startSeconds = Math.max(0, start);
    audioNode.durationSeconds = Math.max(0.25, duration);
  });
  return linked.sort((a, b) => (Number(a.startSeconds) || 0) - (Number(b.startSeconds) || 0));
}

function clearActBoardAudioLink(audioNode) {
  if (!audioNode || audioNode.type !== 'audio') return;
  audioNode.linkedToNodeId = null;
  audioNode.linkedToType = null;
  audioNode.startSeconds = 0;
}

function linkActBoardAudioNode(actKey, audioNode, targetNode) {
  if (!audioNode || audioNode.type !== 'audio' || !targetNode
    || !['narration', 'footage'].includes(targetNode.type)) return false;
  audioNode.linkedToNodeId = targetNode.id;
  audioNode.linkedToType = targetNode.type;
  if (!audioNode.query) {
    audioNode.query = targetNode.type === 'footage'
      ? String(targetNode.fragment || 'documentary ambience').trim()
      : 'documentary ambience';
  }
  const start = Math.max(0, Number(targetNode.startSeconds) || 0);
  const duration = targetNode.type === 'footage'
    ? Number(targetNode.durationSeconds) || 1
    : actBoardNarrationSegmentDuration(targetNode) || estimateActBoardNarrationSeconds(targetNode.text);
  audioNode.startSeconds = Math.max(0, start);
  audioNode.durationSeconds = Math.max(0.25, duration);
  audioNode.durationWasSuggested = true;
  audioNode.timingWasManuallyAdjusted = false;
  return true;
}

function orderedActBoardSceneFootage(actKey, scene, nodes = actBoardNodesForAct(actKey)) {
  if (!scene) return [];
  const sceneIds = new Set([...(scene.nodeIds || []),
    ...nodes.filter(node => node.sceneId === scene.id).map(node => node.id)]);
  const footage = nodes.filter(node => node.type === 'footage' && sceneIds.has(node.id));
  if (!footage.length) return [];
  const byId = new Map(footage.map(node => [node.id, node]));
  const startNode = byId.get(scene.sequenceStartNodeId)
    || footage.find(node => !byId.has(node.previousFootageNodeId))
    || footage.slice().sort((a, b) => (Number(a.startSeconds) || 0) - (Number(b.startSeconds) || 0))[0];
  const ordered = [];
  const visited = new Set();
  let cursor = startNode;
  while (cursor && !visited.has(cursor.id)) {
    ordered.push(cursor);
    visited.add(cursor.id);
    cursor = byId.get(cursor.nextFootageNodeId);
  }
  footage.slice().sort((a, b) => {
    const aStart = Number(a.startSeconds);
    const bStart = Number(b.startSeconds);
    if (Number.isFinite(aStart) && Number.isFinite(bStart) && aStart !== bStart) return aStart - bStart;
    return (Number(a.sequenceIndex) || 0) - (Number(b.sequenceIndex) || 0);
  }).forEach(node => {
    if (!visited.has(node.id)) ordered.push(node);
  });
  // A footage-only chain has no narration timestamps to seed its starts. Lay
  // it out sequentially unless the user has manually adjusted a segment.
  let cursorSeconds = 0;
  ordered.forEach((node, index) => {
    const duration = Math.max(0.5, Number(node.durationSeconds) || 1);
    if (!node.timingWasManuallyAdjusted) {
      node.startSeconds = Number(cursorSeconds.toFixed(2));
    } else if ((Number(node.startSeconds) || 0) < cursorSeconds) {
      // Relinking or changing the scene start can leave a manually timed
      // shot carrying its old timestamp. Preserve intentional gaps, but
      // never allow a later linked shot to overlap or fall behind the prior
      // shot on the playback rail.
      node.startSeconds = Number(cursorSeconds.toFixed(2));
    }
    node.sequenceIndex = index;
    cursorSeconds = Math.max(cursorSeconds, (Number(node.startSeconds) || 0) + duration);
  });
  return ordered;
}

async function findActBoardAudioNode(actKey, node, shouldRerender = true) {
  if (!node || node.type !== 'audio') return;
  // Keep search results visible even when this node already has a selected
  // sound. Once a result is chosen, the normal selected-sound view hides the
  // alternatives again.
  node.audioSearchActive = true;
  node.status = 'generating';
  node.error = '';
  if (shouldRerender) {
    saveDebugSession();
    // Update only the clicked control. Rebuilding the whole board here would
    // destroy and recreate every <audio> element, causing visible flicker and
    // transient scrollbars while the request is in flight.
    refreshActBoardAudioSearchDom(actKey, node);
  }
  try {
    const query = String(node.query || '').trim();
    if (!query) throw new Error('Enter a sound-effects query first.');
    const result = await fetchAudioOptions(query);
    node.results = Array.isArray(result.audio) ? result.audio : [];
    node.status = 'ready';
    node.searchSource = 'Freesound';
    if (!node.results.length) node.error = `No sound effects found for “${query}”.`;
  } catch (err) {
    node.status = 'error';
    node.error = err.message;
  }
  saveDebugSession();
  if (!refreshActBoardAudioSearchDom(actKey, node)) rerenderActBoard();
}

function buildActBoardNarrationPlayback(actKey, node, boardLayer, playbackNode = null) {
  const scene = playbackNode?.sceneId
    ? actBoardScenesForAct(actKey).find(item => item.id === playbackNode.sceneId)
    : null;
  const sceneNodeIds = new Set(scene?.nodeIds || []);
  const sceneNodes = playbackNode?.sceneId
    ? actBoardNodesForAct(actKey).filter(item => item.sceneId === playbackNode.sceneId
      || sceneNodeIds.has(item.id))
    : [];
  const sceneNarrations = scene
    ? sceneNodes.filter(item => item.type === 'narration'
      && item.includeNarration !== false
      && (item.audioPreviewUrl || item.transcript || item.text || item.narrationAudioDurationSeconds))
    : [];
  const sceneNarration = sceneNarrations.find(item => !item.previousNarrationNodeId)
    || sceneNarrations[0] || null;
  // A playback node may point at a specific narration node. Respect that
  // node's own include toggle; when it is excluded, retain the footage-only
  // sequence rather than falling back to another narration in the scene.
  const playbackRootNarration = node
    ? (node.includeNarration === false ? null : node)
    : sceneNarration;
  const narrationNodes = playbackRootNarration
    ? orderedActBoardNarrationChain(actKey, playbackRootNarration,
      scene ? sceneNodes : actBoardNodesForAct(actKey)) : [];
  syncActBoardNarrationChainTiming(narrationNodes);
  const playbackNarration = narrationNodes[0] || null;
  const sceneFootage = sceneNodes.filter(item => item.type === 'footage');
  const linkedNarrationFootage = narrationNodes.flatMap(narration =>
    orderedActBoardLinkedFootage(actKey, narration));
  const footageById = new Map();
  [...linkedNarrationFootage, ...sceneFootage].forEach(footage => {
    if (footage && !footageById.has(footage.id)) footageById.set(footage.id, footage);
  });
  // A narration node is an umbrella layer, not a gate on the footage. Keep
  // every footage node in the scene in playback, while preserving the linked
  // narration sequence order for the nodes that have one.
  // A scene-level starting node takes precedence over narration ordering. The
  // Set as start action clears existing links, and this branch then rebuilds
  // the footage rail from that node as the first segment.
  const linked = scene?.sequenceStartNodeId
    ? orderedActBoardSceneFootage(actKey, scene, sceneNodes)
    : playbackNarration
      ? Array.from(footageById.values()).sort((a, b) => {
        const aSequence = Number(a.sequenceIndex);
        const bSequence = Number(b.sequenceIndex);
        if (Number.isFinite(aSequence) && Number.isFinite(bSequence)
          && aSequence !== bSequence) return aSequence - bSequence;
        const startDelta = (Number(a.startSeconds) || 0) - (Number(b.startSeconds) || 0);
        return Math.abs(startDelta) > 0.001
          ? startDelta : (Number(a.sequenceIndex) || 0) - (Number(b.sequenceIndex) || 0);
      })
      : orderedActBoardSceneFootage(actKey, scene, sceneNodes);
  const sceneAudio = sceneNodes.filter(item => item.type === 'audio');
  const linkedNarrationAudio = narrationNodes.flatMap(narration =>
    orderedActBoardLinkedAudio(actKey, narration));
  const narrationTrackEntries = narrationNodes.length
    ? narrationNodes : (playbackNarration ? [playbackNarration] : []);
  const audioById = new Map();
  [...linkedNarrationAudio, ...sceneAudio].forEach(audioNode => {
    if (audioNode && !audioById.has(audioNode.id)) audioById.set(audioNode.id, audioNode);
  });
  // Unlinked sound nodes are independent layers. A linked sound node still
  // keeps the start/length assigned by linkActBoardAudioNode().
  const linkedAudio = Array.from(audioById.values()).sort((a, b) =>
    (Number(a.startSeconds) || 0) - (Number(b.startSeconds) || 0));
  const playbackTimelineOwner = scene || playbackNarration;
  const readPlaybackTimelineDuration = () => Math.max(
    0.1,
    ...narrationTrackEntries.map(narration =>
      Math.max(0, Number(narration.startSeconds) || 0)
        + Math.max(0.5, actBoardNarrationSegmentDuration(narration)
          || estimateActBoardNarrationSeconds(narration.transcript || narration.text))),
    ...linked.map(footage => (Number(footage.startSeconds) || 0)
      + Math.max(0.5, Number(footage.durationSeconds) || 1)),
    ...linkedAudio.map(audioNode => (Number(audioNode.startSeconds) || 0)
      + Math.max(0.25, Number(audioNode.durationSeconds) || 0.25)),
  );
  if (playbackTimelineOwner) {
    playbackTimelineOwner._actBoardTimelineDurationReader = readPlaybackTimelineDuration;
    playbackTimelineOwner.timelineDurationSeconds = readPlaybackTimelineDuration();
  }
  const panel = document.createElement('div');
  panel.className = 'storyboard-act-board-playback';
  const controls = document.createElement('div');
  controls.className = 'storyboard-act-board-playback-controls';
  const playButton = document.createElement('button');
  playButton.type = 'button';
  playButton.className = 'btn-secondary storyboard-act-board-node-action';
  playButton.textContent = 'Play back';
  const stopButton = document.createElement('button');
  stopButton.type = 'button';
  stopButton.className = 'btn-secondary storyboard-act-board-node-action';
  stopButton.textContent = 'Stop';
  stopButton.disabled = true;
  const status = document.createElement('span');
  status.className = 'storyboard-act-board-playback-status';
  controls.append(playButton, stopButton, status);
  panel.appendChild(controls);
  const stage = document.createElement('div');
  stage.className = 'storyboard-act-board-playback-stage';
  const stageLabel = document.createElement('span');
  stageLabel.textContent = 'Linked footage + sound preview';
  stage.appendChild(stageLabel);
  panel.appendChild(stage);
  const footageTrack = buildActBoardFootageTrack(
    actKey,
    playbackNarration,
    boardLayer,
    linked,
    playbackTimelineOwner,
  );
  if (footageTrack) panel.appendChild(footageTrack);
  const narrationTrack = playbackNarration
    ? buildActBoardPlaybackAudioTrack({
      actKey,
      labelText: 'Narration track',
      entries: narrationTrackEntries,
      kind: 'narration',
      narrationNode: playbackNarration,
      boardLayer,
      timelineOwner: playbackTimelineOwner,
    }) : null;
  if (narrationTrack) panel.appendChild(narrationTrack);
  const soundTrack = buildActBoardPlaybackAudioTrack({
    actKey,
    labelText: 'Music / sound effects track',
    entries: linkedAudio,
    kind: 'audio',
    narrationNode: playbackNarration,
    boardLayer,
    timelineOwner: playbackTimelineOwner,
  });
  if (soundTrack) panel.appendChild(soundTrack);
  const audio = document.createElement('audio');
  // Keep the audio element as the real narration source, but use the linked
  // sequence transport below instead of the native audio timeline. Native
  // controls can only represent the narration file's duration, not footage
  // that continues after narration ends.
  audio.controls = false;
  audio.preload = 'metadata';
  audio.className = 'storyboard-act-board-playback-audio';
  audio.setAttribute('aria-label', 'Linked sequence narration audio');
  audio.volume = actBoardNodeVolume(playbackNarration, 1);
  wireActBoardAudioExclusivity(audio);
  audio.addEventListener('click', event => event.stopPropagation());
  panel.appendChild(audio);
  const audioSource = actBoardNarrationAudioSource(actKey, playbackNarration);
  const narrationAudioLayers = narrationTrackEntries.map((narrationNode, index) => {
    // The first narration may use the legacy section-level recording fallback.
    // Later linked narration nodes must have their own recording; otherwise a
    // missing clip would duplicate the first narration's audio.
    const source = index === 0
      ? actBoardNarrationAudioSource(actKey, narrationNode)
      : (narrationNode.audioPreviewUrl || narrationNode._nativePreviewUrl
        || narrationNode._nativeAudioUrl ? narrationNode : null);
    const element = index === 0 ? audio : document.createElement('audio');
    if (index > 0) {
      element.className = 'storyboard-act-board-playback-narration';
      element.controls = false;
      element.preload = 'auto';
      const url = source && (source._nativePreviewUrl || source._nativeAudioUrl
        || source.previewUrl || source.audioPreviewUrl || source.url);
      if (url) attachNativeAudioSource(element, url, source);
      element.setAttribute('aria-label', 'Linked sequence narration segment');
      element.addEventListener('click', event => event.stopPropagation());
      panel.appendChild(element);
    }
    element.volume = actBoardNodeVolume(narrationNode, 1);
    return { node: narrationNode, source, element };
  });
  const audioLayers = linkedAudio.map(audioNode => {
    const source = actBoardAudioSource(audioNode);
    const element = document.createElement('audio');
    element.className = 'storyboard-act-board-playback-sfx';
    element.controls = false;
    element.preload = 'auto';
    element.src = source.url;
    element.volume = actBoardNodeVolume(audioNode);
    element.setAttribute('aria-label', `${source.name} linked sound`);
    element.addEventListener('click', event => event.stopPropagation());
    panel.appendChild(element);
    return { node: audioNode, source, element };
  });
  const refreshPlaybackVolumes = () => {
    audio.volume = actBoardNodeVolume(playbackNarration, 1);
    narrationAudioLayers.forEach(layer => {
      layer.element.volume = actBoardNodeVolume(layer.node, 1);
    });
    audioLayers.forEach(layer => {
      layer.element.volume = actBoardNodeVolume(layer.node);
    });
  };
  panel._actBoardRefreshPlaybackVolumes = refreshPlaybackVolumes;
  const narrationSourceIn = () => Math.max(0, Number(audioSource?.trimStartSeconds) || 0);
  const narrationSegmentDuration = () => Math.max(0,
    Number(audioSource?.narrationSegmentDurationSeconds
      || audioSource?.durationSeconds
      || audioSource?.audioDurationSeconds || 0) || 0);
  const readAudioTime = () => {
    const value = Number(audio.currentTime) - narrationSourceIn();
    return Number.isFinite(value) && value >= 0 ? value : 0;
  };
  const narrationLayerUrl = layer => layer?.source && (layer.source._nativePreviewUrl
    || layer.source._nativeAudioUrl || layer.source.previewUrl
    || layer.source.audioPreviewUrl || layer.source.url || '');
  const hasChainedNarration = narrationTrackEntries.length > 1;
  const readNarrationLayerDuration = layer => Math.max(0.5,
    actBoardNarrationSegmentDuration(layer.node)
      || Number(layer.source?.durationSeconds || layer.source?.audioDurationSeconds || 0)
      || estimateActBoardNarrationSeconds(layer.node.transcript || layer.node.text));
  const hasFootageMedia = linked.some(footage => {
    const media = actBoardSelectedFootageMedia(footage);
    return Boolean(media.url || media.thumbnailUrl);
  });
  const hasNarrationMedia = narrationAudioLayers.some(layer => Boolean(narrationLayerUrl(layer)));
  const hasAudioMedia = audioLayers.some(layer => Boolean(layer.source.url));
  if (audioSource) {
    attachNativeAudioSource(audio, audioSource._nativePreviewUrl || audioSource._nativeAudioUrl
      || audioSource.previewUrl || audioSource.audioPreviewUrl, audioSource);
  } else {
    audio.hidden = true;
    playButton.disabled = !hasNarrationMedia && !hasFootageMedia && !hasAudioMedia;
  }

  const syncVideoToNarration = (footage, nowSeconds, forceSeek = false) => {
    if (!state.video || !footage) return;
    const start = Math.max(0, Number(footage.startSeconds) || 0);
    const localSeconds = Math.max(0, nowSeconds - start);
    if (Number.isFinite(state.video.duration) && state.video.duration > 0) {
      const sourceDuration = Math.max(0.1, Number(footage.sourceDurationSeconds)
        || state.video.duration);
      const sourceIn = Math.min(Math.max(0, Number(footage.trimStartSeconds) || 0),
        Math.max(0, sourceDuration - 0.05));
      const available = Math.max(0.05, sourceDuration - sourceIn);
      const usedLength = Math.max(0.05, Math.min(
        Number(footage.durationSeconds) || available, available,
      ));
      const target = Math.min(state.video.duration - 0.01,
        sourceIn + (localSeconds % usedLength));
      // Seeking on every audio timeupdate makes a CDN clip visibly flicker.
      // Only seek when entering a shot or when the user explicitly scrubs.
      if (forceSeek && Math.abs(state.video.currentTime - target) > 0.08) {
        state.video.currentTime = target;
      }
    }
    if (state.playing) state.video.play().catch(() => { });
  };

  // These durations must stay live. The footage-track handles and the node's
  // Start/Length inputs can change a node after this playback card has been
  // rendered; capturing the old totals here would make playback stop at the
  // previous endpoint even though the track visibly became longer.
  const readTotalFootageDuration = () => linked.reduce((max, footage) => Math.max(
    max,
    (Number(footage.startSeconds) || 0) + Math.max(0.5, Number(footage.durationSeconds) || 1),
    Number(playbackNarration?.timelineDurationSeconds) || 0,
  ), 0);
  const readTotalAudioDuration = () => audioLayers.reduce((max, layer) => Math.max(max,
    (Number(layer.node.startSeconds) || 0) + Math.max(0.25,
      Number(layer.node.durationSeconds) || Number(layer.source.durationSeconds) || 1)), 0);
  const readTotalNarrationDuration = () => narrationAudioLayers.reduce((max, layer) => Math.max(max,
    (Number(layer.node.startSeconds) || 0) + readNarrationLayerDuration(layer)), 0);
  const syncNarrationLayers = (nowSeconds, forceSeek = false) => {
    narrationAudioLayers.forEach(layer => {
      const start = Math.max(0, Number(layer.node.startSeconds) || 0);
      const duration = readNarrationLayerDuration(layer);
      const active = Boolean(narrationLayerUrl(layer))
        && nowSeconds >= start && nowSeconds < start + duration;
      if (!active) {
        layer.element.pause();
        return;
      }
      const sourceIn = Math.max(0, Number(layer.source?.trimStartSeconds) || 0);
      const local = Math.min(sourceIn + Math.max(0, nowSeconds - start),
        sourceIn + duration - 0.01);
      if (forceSeek || Math.abs((Number(layer.element.currentTime) || 0) - local) > 0.2) {
        try { layer.element.currentTime = local; } catch (err) { /* metadata not ready */ }
      }
      if (state.playing && layer.element.paused) layer.element.play().catch(() => { });
    });
  };
  const sourceDuration = narrationSegmentDuration() || [
    playbackNarration?.audioDurationSeconds,
    playbackNarration?.narrationAudioDurationSeconds,
    audioSource?.audioDurationSeconds,
    audioSource?.durationSeconds,
  ].map(value => Number(value)).find(value => Number.isFinite(value) && value > 0) || 0;
  let totalFootageDuration = readTotalFootageDuration();
  let totalAudioDuration = readTotalAudioDuration();
  let totalNarrationDuration = readTotalNarrationDuration();
  const initialPlaybackDuration = Math.max(0.1, totalFootageDuration, totalAudioDuration,
    totalNarrationDuration, sourceDuration);

  const syncAudioLayers = (nowSeconds, forceSeek = false) => {
    audioLayers.forEach(layer => {
      const start = Math.max(0, Number(layer.node.startSeconds) || 0);
      const duration = Math.max(0.25,
        Number(layer.node.durationSeconds) || Number(layer.source.durationSeconds) || 1);
      const active = nowSeconds >= start && nowSeconds < start + duration;
      if (!active) {
        layer.element.pause();
        return;
      }
      const sourceStart = Math.max(0, Number(layer.node.trimStartSeconds
        ?? layer.node.selectedAudio?.trimStartSeconds
        ?? layer.source.trimStartSeconds) || 0);
      const local = Math.min(sourceStart + Math.max(0, nowSeconds - start),
        sourceStart + duration - 0.01);
      if (forceSeek || Math.abs((Number(layer.element.currentTime) || 0) - local) > 0.25) {
        try { layer.element.currentTime = local; } catch (err) { /* metadata not ready */ }
      }
      if (state.playing && layer.element.paused) layer.element.play().catch(() => { });
    });
  };

  const setStage = (footage, nowSeconds = readAudioTime(), forceSeek = false) => {
    if (!footage || (!hasNarrationMedia && !hasFootageMedia && !hasAudioMedia)) {
      stage.replaceChildren();
      state.currentFootageId = null;
      const empty = document.createElement('span');
      empty.textContent = !hasNarrationMedia && !hasFootageMedia && !hasAudioMedia
        ? 'There is no narration or media yet.'
        : linked.length ? 'No footage in this interval.'
          : hasNarrationMedia ? 'Narration only' : 'Sound effects only';
      stage.appendChild(empty);
      return;
    }
    // Do not rebuild the DOM while the narration clock advances within the
    // same shot. Replacing a Pexels <video> on every `timeupdate` restarts its
    // decoder and presents as a visible flicker/black flash.
    if (state.currentFootageId === footage.id) {
      syncVideoToNarration(footage, nowSeconds, forceSeek);
      return;
    }
    stage.replaceChildren();
    stage.style.aspectRatio = '16 / 9';
    state.video?.pause();
    state.currentFootageId = footage.id;
    const { url, kind, thumbnailUrl } = actBoardSelectedFootageMedia(footage);
    if (url && kind === 'video') {
      const video = document.createElement('video');
      video.src = url;
      video.poster = thumbnailUrl;
      video.muted = true;
      video.playsInline = true;
      video.loop = true;
      video.preload = 'auto';
      // The narration can finish before the last footage shot. Use the
      // shared playback clock here instead of the now-stale audio time so a
      // late metadata event cannot seek the new shot back to the narration's
      // final frame.
      video.addEventListener('loadedmetadata', () => {
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          stage.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
        }
        if (state.video === video) syncVideoToNarration(footage, state.clockTime, true);
      });
      video.addEventListener('loadeddata', () => {
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          stage.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
        }
        if (state.video === video) syncVideoToNarration(footage, state.clockTime, true);
      });
      video.addEventListener('error', () => {
        if (state.status) state.status.textContent = 'This footage could not be loaded from its source.';
      });
      stage.appendChild(video);
      state.video = video;
    } else if (url || thumbnailUrl) {
      const image = document.createElement('img');
      image.src = thumbnailUrl || footage.mediaThumbnailUrl || url;
      image.alt = footage.fragment || 'Linked footage';
      image.addEventListener('load', () => {
        if (image.naturalWidth > 0 && image.naturalHeight > 0) {
          stage.style.aspectRatio = `${image.naturalWidth} / ${image.naturalHeight}`;
        }
      }, { once: true });
      stage.appendChild(image);
      state.video = null;
    } else {
      const empty = document.createElement('span');
      empty.textContent = 'This linked shot has no media yet.';
      stage.appendChild(empty);
      state.video = null;
    }
    const caption = document.createElement('small');
    caption.textContent = footage.fragment || 'Linked footage';
    stage.appendChild(caption);
    syncVideoToNarration(footage, nowSeconds, true);
  };

  const state = {
    audio, audioLayers, narrationAudioLayers, video: null, stage, playButton, stopButton, status,
    activeCards: [], currentFootageId: null, playing: false,
    clockTimer: null, clockStartedAt: 0, clockTime: 0, audioEnded: false, abortRetries: 0,
    scrubbing: false, scrubWasPlaying: false, scrubCleanup: null,
    totalPlaybackDuration: initialPlaybackDuration,
    progressInput: null, progressLabel: null, updatePlaybackProgress: null,
    error: false, node, boardLayer, setStage,
  };
  const refreshPlaybackDuration = () => {
    totalFootageDuration = readTotalFootageDuration();
    totalAudioDuration = readTotalAudioDuration();
    totalNarrationDuration = readTotalNarrationDuration();
    const mediaDuration = Number(audio.duration);
    const liveNarrationDuration = narrationSegmentDuration();
    const currentNarrationDuration = liveNarrationDuration || sourceDuration;
    const next = Math.max(0.1, totalFootageDuration, totalAudioDuration,
      totalNarrationDuration,
      currentNarrationDuration,
      Number.isFinite(mediaDuration) && mediaDuration > 0 ? mediaDuration : 0);
    state.totalPlaybackDuration = next;
    if (typeof state.updatePlaybackProgress === 'function') state.updatePlaybackProgress();
    return next;
  };
  panel._actBoardRefreshPlaybackDuration = refreshPlaybackDuration;
  const progressWrap = document.createElement('div');
  progressWrap.className = 'storyboard-act-board-playback-progress';
  progressWrap.hidden = !hasNarrationMedia && !hasFootageMedia && !hasAudioMedia;
  const progressInput = document.createElement('input');
  progressInput.type = 'range';
  progressInput.min = '0';
  progressInput.max = String(initialPlaybackDuration);
  progressInput.step = '0.01';
  progressInput.value = '0';
  progressInput.className = 'storyboard-act-board-playback-progress-input';
  progressInput.setAttribute('aria-label', 'Linked sequence playback position');
  progressInput.title = 'Drag the playhead to seek through the linked sequence';
  const progressLabel = document.createElement('span');
  progressLabel.className = 'storyboard-act-board-playback-progress-label';
  progressWrap.append(progressInput, progressLabel);
  // Keep the transport directly beneath the Play back / Stop controls rather
  // than after the preview stage and footage track.
  controls.appendChild(progressWrap);
  state.progressInput = progressInput;
  state.progressLabel = progressLabel;
  const formatPlaybackTime = seconds => {
    const value = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(value / 60);
    const remainder = value - minutes * 60;
    return `${minutes}:${remainder.toFixed(1).padStart(4, '0')}`;
  };
  state.updatePlaybackProgress = () => {
    const total = Math.max(0.1, Number(state.totalPlaybackDuration) || 0.1);
    const current = Math.max(0, Math.min(total, Number(state.clockTime) || 0));
    progressInput.max = String(total);
    progressInput.value = String(current);
    progressInput.style.setProperty('--playback-progress', `${(current / total) * 100}%`);
    progressLabel.textContent = `${formatPlaybackTime(current)} / ${formatPlaybackTime(total)}`;
  };
  const seekPlaybackProgress = rawValue => {
    refreshPlaybackDuration();
    const next = Math.max(0, Math.min(
      state.totalPlaybackDuration,
      Number(rawValue) || 0,
    ));
    progressInput.value = String(next);
    state.clockTime = next;
    state.clockStartedAt = performance.now() - (next * 1000);
    if (audioSource) {
      const duration = Number(audio.duration);
      if (Number.isFinite(duration) && duration > 0) {
        const sourceIn = narrationSourceIn();
        audio.currentTime = Math.min(sourceIn + next, duration);
        state.audioEnded = next >= Math.max(0.1, narrationSegmentDuration()) - 0.05;
        if (state.playing && !state.audioEnded && audio.paused) {
          audio.play().catch(() => { });
        }
      }
    }
    if (hasChainedNarration) syncNarrationLayers(next, true);
    syncAudioLayers(next, true);
    updateAtTime();
    state.updatePlaybackProgress();
  };
  progressInput.addEventListener('input', event => {
    event.stopPropagation();
    seekPlaybackProgress(progressInput.value);
  });
  // Keep scrubbing isolated from the draggable playback node. The thumb is
  // the sequence playhead: dragging it updates the shared clock and therefore
  // the active footage, narration, and sound layers together.
  const finishPlaybackScrub = () => {
    if (!state.scrubbing) return;
    const resume = state.scrubWasPlaying;
    state.scrubbing = false;
    state.scrubWasPlaying = false;
    if (resume && document.body.contains(playButton)) playButton.click();
  };
  progressInput.addEventListener('pointerdown', event => {
    event.preventDefault();
    event.stopPropagation();
    state.scrubbing = true;
    state.scrubWasPlaying = state.playing;
    state.playing = false;
    playButton.textContent = 'Play back';
    stopButton.disabled = false;
    stage.classList.remove('playing');
    if (state.clockTimer) {
      clearInterval(state.clockTimer);
      state.clockTimer = null;
    }
    audio.pause();
    state.narrationAudioLayers?.forEach(layer => layer.element.pause());
    state.video?.pause();
    state.audioLayers?.forEach(layer => layer.element.pause());
    try { progressInput.setPointerCapture(event.pointerId); } catch (err) { /* optional */ }
    const rect = progressInput.getBoundingClientRect();
    if (rect.width > 0) {
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      seekPlaybackProgress(ratio * state.totalPlaybackDuration);
    }
  });
  progressInput.addEventListener('pointermove', event => {
    if (!state.scrubbing) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = progressInput.getBoundingClientRect();
    if (!(rect.width > 0)) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    seekPlaybackProgress(ratio * state.totalPlaybackDuration);
  });
  progressInput.addEventListener('pointerup', finishPlaybackScrub);
  progressInput.addEventListener('pointercancel', finishPlaybackScrub);
  window.addEventListener('pointerup', finishPlaybackScrub, true);
  state.scrubCleanup = () => window.removeEventListener('pointerup', finishPlaybackScrub, true);
  state.updatePlaybackProgress();
  // Show the first selected shot immediately, even before linked playback
  // begins. The custom transport and the hidden audio element share this state.
  state.clockTime = audioSource ? readAudioTime() : 0;
  setStage(linked[0]);
  const updateAtTime = () => {
    const now = state.clockTime;
    syncAudioLayers(now);
    const current = linked.find(footage => {
      const start = Number(footage.startSeconds) || 0;
      const duration = Number(footage.durationSeconds) || 1;
      return now >= start && now < start + duration;
    });
    state.activeCards.forEach(card => card.classList.remove('act-board-playback-active'));
    state.activeCards = [];
    if (!current) {
      // A completed sequence can land exactly on the final shot's end time
      // before the transport's stop tick runs. Keep the final footage frame
      // visible instead of replacing it with the misleading "No footage in
      // this interval" placeholder. Real gaps between shots still show the
      // placeholder because they have a later clip to play.
      const finalFootage = linked.length ? linked[linked.length - 1] : null;
      const finalEnd = finalFootage
        ? (Number(finalFootage.startSeconds) || 0)
          + Math.max(0.5, Number(finalFootage.durationSeconds) || 1)
        : 0;
      if (finalFootage && now >= finalEnd - 0.05) {
        const finalTime = Math.max(
          Number(finalFootage.startSeconds) || 0,
          finalEnd - 0.01,
        );
        setStage(finalFootage, finalTime, true);
      } else {
        setStage(null, now);
      }
      return;
    }
    const card = boardLayer.querySelector(`[data-node-id="${current.id}"]`);
    if (card) {
      card.classList.add('act-board-playback-active');
      state.activeCards.push(card);
    }
    setStage(current, now);
  };
  const startPlaybackClock = () => {
    if (state.clockTimer) return;
    refreshPlaybackDuration();
    state.clockStartedAt = performance.now() - (state.clockTime * 1000);
    state.clockTimer = setInterval(() => {
      if (!state.playing || actBoardPlaybackState !== state) return;
      if (state.scrubbing) return;
      refreshPlaybackDuration();
      if (hasChainedNarration) {
        state.clockTime = (performance.now() - state.clockStartedAt) / 1000;
        syncNarrationLayers(state.clockTime);
      } else if (audioSource && !state.audioEnded && !audio.paused) {
        const audioTime = readAudioTime();
        // currentTime can briefly remain at zero while a restored/uploaded
        // source is loading. Do not reset a progressing footage sequence to
        // that transient value; resume from the monotonic clock instead.
        if (audioTime > 0.001 || state.clockTime <= 0.001) state.clockTime = audioTime;
        state.clockStartedAt = performance.now() - (state.clockTime * 1000);
        const selectedNarrationDuration = narrationSegmentDuration();
        if (selectedNarrationDuration > 0 && state.clockTime >= selectedNarrationDuration - 0.03) {
          state.clockTime = selectedNarrationDuration;
          state.audioEnded = true;
          audio.pause();
        }
      } else {
        state.clockTime = (performance.now() - state.clockStartedAt) / 1000;
      }
      updateAtTime();
      state.updatePlaybackProgress();
      const footageDone = !linked.length || state.clockTime >= totalFootageDuration;
      const linkedAudioDone = !audioLayers.length || state.clockTime >= totalAudioDuration;
      const narrationDone = hasChainedNarration
        ? !hasNarrationMedia || state.clockTime >= totalNarrationDuration
        : !audioSource || state.audioEnded;
      if (footageDone && linkedAudioDone && narrationDone) stopActBoardPlayback();
    }, 50);
  };
  audio.addEventListener('timeupdate', () => {
    if (state.scrubbing || hasChainedNarration) return;
    if (!state.clockTimer) state.clockTime = readAudioTime();
    updateAtTime();
    state.updatePlaybackProgress();
  });
  audio.addEventListener('seeking', () => {
    if (state.scrubbing || hasChainedNarration) return;
    state.clockTime = readAudioTime();
    state.clockStartedAt = performance.now() - (state.clockTime * 1000);
    updateAtTime();
    state.updatePlaybackProgress();
  });
  audio.addEventListener('seeked', () => {
    if (state.scrubbing || hasChainedNarration) return;
    state.clockTime = readAudioTime();
    state.clockStartedAt = performance.now() - (state.clockTime * 1000);
    const now = state.clockTime;
    const current = linked.find(footage => {
      const start = Number(footage.startSeconds) || 0;
      const duration = Number(footage.durationSeconds) || 1;
      return now >= start && now < start + duration;
    });
    setStage(current, now, true);
    state.updatePlaybackProgress();
  });
  audio.addEventListener('loadedmetadata', () => {
    const duration = Number(audio.duration);
    if (Number.isFinite(duration) && duration > 0) {
      if (audio.currentTime < narrationSourceIn()) audio.currentTime = narrationSourceIn();
      refreshPlaybackDuration();
      state.updatePlaybackProgress();
    }
  });
  audio.addEventListener('durationchange', () => {
    const duration = Number(audio.duration);
    if (Number.isFinite(duration) && duration > 0) {
      if (audio.currentTime < narrationSourceIn()) audio.currentTime = narrationSourceIn();
      refreshPlaybackDuration();
      state.updatePlaybackProgress();
    }
  });
  audio.addEventListener('play', () => {
    if (hasChainedNarration) return;
    // Native audio controls can start playback without the custom button.
    // Adopt the same shared state so the sequence clock and progress bar keep
    // advancing for that interaction too.
    if (actBoardPlaybackState && actBoardPlaybackState !== state) stopActBoardPlayback();
    actBoardPlaybackState = state;
    state.playing = true;
    state.audioEnded = false;
    state.clockTime = readAudioTime();
    state.playButton.textContent = 'Pause';
    state.stopButton.disabled = false;
    state.stage.classList.add('playing');
    startPlaybackClock();
    updateAtTime();
    state.updatePlaybackProgress();
  });
  audio.addEventListener('pause', () => {
    if (hasChainedNarration) return;
    refreshPlaybackDuration();
    const narrationAtEnd = audio.ended
      || (Number(audio.duration) > 0 && audio.currentTime >= audio.duration - 0.05);
    if (state.playing && (state.audioEnded || narrationAtEnd) && (linked.length || audioLayers.length)
      && state.clockTime < Math.max(totalFootageDuration, totalAudioDuration)) return;
    state.playing = false;
    if (state.clockTimer) {
      clearInterval(state.clockTimer);
      state.clockTimer = null;
    }
    state.video?.pause();
    state.audioLayers?.forEach(layer => layer.element.pause());
    state.playButton.textContent = 'Play back';
    state.stopButton.disabled = true;
    state.stage.classList.remove('playing');
  });
  audio.addEventListener('ended', () => {
    if (hasChainedNarration) return;
    refreshPlaybackDuration();
    state.audioEnded = true;
    if ((!linked.length && !audioLayers.length)
      || state.clockTime >= Math.max(totalFootageDuration, totalAudioDuration)) {
      stopActBoardPlayback();
    } else {
      updateAtTime();
    }
  });
  playButton.addEventListener('click', event => {
    event.stopPropagation();
    refreshPlaybackDuration();
    if (actBoardPlaybackState === state && state.playing) {
      // The custom transport is the only visible control now, so make its
      // primary button a real play/pause toggle for both narration and
      // footage-only sequences.
      state.playing = false;
      if (state.clockTimer) {
        clearInterval(state.clockTimer);
        state.clockTimer = null;
      }
      audio.pause();
      state.narrationAudioLayers?.forEach(layer => layer.element.pause());
      state.video?.pause();
      state.audioLayers?.forEach(layer => layer.element.pause());
      state.playButton.textContent = 'Play back';
      state.stopButton.disabled = false;
      state.stage.classList.remove('playing');
      return;
    }
    if (actBoardPlaybackState && actBoardPlaybackState !== state) stopActBoardPlayback();
    actBoardPlaybackState = state;
    state.error = false;
    state.abortRetries = 0;
    state.audioEnded = false;
    state.playing = true;
    state.status.textContent = '';
    state.playButton.textContent = 'Pause';
    state.stopButton.disabled = false;
    state.stage.classList.add('playing');
    updateAtTime();
    state.updatePlaybackProgress();
    const playWhenReady = () => {
      if (!state.playing || actBoardPlaybackState !== state) return null;
      if (hasChainedNarration) {
        syncNarrationLayers(state.clockTime, true);
        startPlaybackClock();
        return Promise.resolve(true);
      }
      if (!audioSource) {
        state.clockTime = 0;
        startPlaybackClock();
        return Promise.resolve(true);
      }
      const duration = Number(audio.duration);
      const selectedDuration = narrationSegmentDuration();
      if (state.audioEnded || (selectedDuration > 0
        && state.clockTime >= selectedDuration - 0.05)
        || (Number.isFinite(duration) && duration > 0
          && state.clockTime >= duration - 0.05)) {
        // The linked sequence may continue beyond the narration file. Once
        // the scrubber is in that footage-only tail, let the master clock
        // continue without trying to restart an ended audio element.
        state.audioEnded = true;
        startPlaybackClock();
        return Promise.resolve(true);
      }
      const sourceIn = narrationSourceIn();
      const current = Number(audio.currentTime) || 0;
      if (current < sourceIn || current > sourceIn + selectedDuration + 0.05) {
        audio.currentTime = sourceIn + Math.max(0, state.clockTime);
      }
      return audio.play();
    };
    Promise.resolve(audio._narrationSourceReady)
      .then(playWhenReady)
      .catch(err => {
        if (!state.playing || actBoardPlaybackState !== state) return null;
        if (err && err.name === 'AbortError' && state.abortRetries < 2) {
          // Source normalization can call load() while the first play() is
          // being scheduled. Retry after that load cycle instead of surfacing
          // the browser's misleading "operation was aborted" message.
          state.abortRetries += 1;
          return new Promise(resolve => setTimeout(resolve, 120)).then(playWhenReady);
        }
        // A restored container can reject with AbortError while the native
        // element is being replaced by the decoded WAV fallback. Retry once
        // after that fallback has finished instead of permanently disabling
        // the linked-sequence player.
        if (err && (err.name === 'AbortError' || err.name === 'NotSupportedError')
          && typeof audio._startNarrationFallback === 'function') {
          return audio._startNarrationFallback().then(playWhenReady);
        }
        throw err;
      })
      .catch(err => {
        if (!state.playing || actBoardPlaybackState !== state) return;
        if (err && err.name === 'AbortError') {
          // Browsers use AbortError for a source swap/load race. It is not a
          // useful playback error, and the pause handler has already reset
          // the controls so the presenter can try again.
          state.status.textContent = '';
          return;
        }
        state.error = true;
        state.status.textContent = `Could not play narration: ${err.message}`;
        stopActBoardPlayback();
      });
  });
  stopButton.addEventListener('click', event => {
    event.stopPropagation();
    if (actBoardPlaybackState === state) stopActBoardPlayback();
    else {
      state.playing = false;
      audio.pause();
      state.narrationAudioLayers?.forEach(layer => layer.element.pause());
      audio.currentTime = 0;
    }
  });
  return panel;
}

function highlightActBoardFootageNode(boardLayer, footageNodeId) {
  if (!boardLayer || !footageNodeId) return;
  boardLayer.querySelectorAll('[data-footage-node-id]').forEach(segment => {
    segment.classList.toggle('selected', segment.dataset.footageNodeId === footageNodeId);
  });
  boardLayer.querySelectorAll('.storyboard-act-board-node-footage').forEach(card => {
    const selected = card.dataset.nodeId === footageNodeId;
    card.classList.toggle('act-board-footage-selected', selected);
    if (selected) {
      const actKey = boardLayer.closest('.storyboard-act-board-column')?.dataset.actKey;
      const node = actKey
        ? actBoardNodesForAct(actKey).find(item => item.id === footageNodeId)
        : null;
      bringActBoardNodeToFront(boardLayer, card, node);
    }
  });
}

function highlightActBoardNarrationTiming(boardLayer, narrationNode, startSeconds, endSeconds) {
  if (!boardLayer || !narrationNode) return [];
  const card = boardLayer.querySelector(`[data-node-id="${narrationNode.id}"]`);
  if (!card) return [];
  const timings = Array.isArray(narrationNode.fragmentTimings)
    ? narrationNode.fragmentTimings : [];
  const source = String(narrationNode.transcript || narrationNode.text || '');
  const sourceWords = normalizedBoardWords(source);
  const totalWords = Math.max(1, sourceWords.length);
  const duration = Math.max(0.1,
    Number(narrationNode.audioDurationSeconds)
      || Number(narrationNode.narrationAudioDurationSeconds)
      || Number(narrationNode.durationSeconds)
      || estimateActBoardNarrationSeconds(source));
  const rangeStart = Math.min(Number(startSeconds) || 0, Number(endSeconds) || 0);
  const rangeEnd = Math.max(Number(startSeconds) || 0, Number(endSeconds) || 0);
  const timedWords = Array.isArray(narrationNode.transcriptWords)
    ? narrationNode.transcriptWords : [];
  const narrationRoot = card.querySelector('.storyboard-act-board-narration-primary') || card;
  const wordElements = narrationRoot.querySelectorAll('[data-narration-word-index]');
  const hasWordElements = wordElements.length > 0;
  wordElements.forEach(wordEl => {
    const index = Number(wordEl.dataset.narrationWordIndex);
    if (!Number.isFinite(index) || index < 0) return;
    const timed = timedWords[index];
    const wordStart = timed && Number.isFinite(Number(timed.start))
      ? Number(timed.start) : duration * index / totalWords;
    const wordEnd = timed && Number.isFinite(Number(timed.end))
      ? Number(timed.end) : duration * Math.min(totalWords, index + 1) / totalWords;
    wordEl.classList.toggle('storyboard-act-board-narration-timing-highlight',
      wordEnd > rangeStart && wordStart < rangeEnd);
  });
  const usedTimings = new Set();
  let searchFrom = 0;
  const labels = [];
  narrationRoot.querySelectorAll('[data-narration-fragment]').forEach(fragmentEl => {
    const fragment = fragmentEl.dataset.narrationFragment || '';
    const normalizedFragment = normalizedBoardWords(fragment).join(' ');
    const timingIndex = timings.findIndex((item, index) => !usedTimings.has(index)
      && normalizedBoardWords(item.fragment || '').join(' ') === normalizedFragment);
    const timing = timingIndex >= 0 ? timings[timingIndex] : null;
    if (timingIndex >= 0) usedTimings.add(timingIndex);
    // Suggested narration often has no transcription timestamps yet. Approximate
    // the phrase's window by its word position so resizing still gives useful
    // visual feedback before the narrator records audio.
    let approximate = null;
    if (!timing && normalizedFragment && source) {
      const sourceIndex = source.toLocaleLowerCase().indexOf(
        fragment.toLocaleLowerCase(), searchFrom);
      const prefixText = sourceIndex >= 0 ? source.slice(0, sourceIndex) : source.slice(0, searchFrom);
      const startWord = normalizedBoardWords(prefixText).length;
      const phraseWordCount = Math.max(1, normalizedBoardWords(fragment).length);
      approximate = {
        startSeconds: duration * startWord / totalWords,
        endSeconds: duration * Math.min(totalWords, startWord + phraseWordCount) / totalWords,
      };
      if (sourceIndex >= 0) searchFrom = sourceIndex + fragment.length;
    }
    const activeTiming = timing || approximate;
    const active = Boolean(timing)
      ? Number(timing.endSeconds) > rangeStart && Number(timing.startSeconds) < rangeEnd
      : Boolean(activeTiming)
        && Number(activeTiming.endSeconds) > rangeStart
        && Number(activeTiming.startSeconds) < rangeEnd;
    // Word spans are more precise than the older phrase-level fallback. Keep
    // the phrase styling only for narration text rendered by an older DOM.
    if (!hasWordElements) {
      fragmentEl.classList.toggle('storyboard-act-board-narration-timing-highlight', active);
    }
    if (active && fragment && !labels.includes(fragment)) labels.push(fragment);
  });
  return labels;
}

function clearActBoardNarrationTimingHighlight(boardLayer, narrationNode) {
  if (!boardLayer || !narrationNode) return;
  const card = boardLayer.querySelector(`[data-node-id="${narrationNode.id}"]`);
  const narrationRoot = card?.querySelector('.storyboard-act-board-narration-primary') || card;
  narrationRoot?.querySelectorAll('[data-narration-fragment], [data-narration-word-index]').forEach(fragmentEl => {
    fragmentEl.classList.remove('storyboard-act-board-narration-timing-highlight');
  });
}

function refreshActBoardPlaybackDurations() {
  // All playback rails share one duration reader. Refresh their geometry
  // together whenever any footage, narration, or audio segment changes so a
  // newly longest rail immediately becomes the common scale.
  document.querySelectorAll('.storyboard-act-board-footage-track').forEach(track => {
    if (typeof track._actBoardRefresh === 'function') track._actBoardRefresh();
  });
  document.querySelectorAll('.storyboard-act-board-playback').forEach(panel => {
    if (typeof panel._actBoardRefreshPlaybackDuration === 'function') {
      panel._actBoardRefreshPlaybackDuration();
    }
  });
}

function refreshActBoardPlaybackVolumes() {
  document.querySelectorAll('.storyboard-act-board-playback').forEach(panel => {
    if (typeof panel._actBoardRefreshPlaybackVolumes === 'function') {
      panel._actBoardRefreshPlaybackVolumes();
    }
  });
}

function refreshActBoardLinkedAudioTimingForTarget(target) {
  if (!target?.id || !target.actKey) return;
  const targetStart = Math.max(0, Number(target.startSeconds) || 0);
  const targetDuration = target.type === 'narration'
    ? Math.max(0.25, actBoardNarrationSegmentDuration(target) || 1)
    : Math.max(0.25, Number(target.durationSeconds) || 1);
  actBoardNodesForAct(target.actKey)
    .filter(node => node.type === 'audio' && node.linkedToNodeId === target.id
      && node.timingWasManuallyAdjusted !== true)
    .forEach(node => {
      node.startSeconds = targetStart;
      node.durationSeconds = targetDuration;
      if (node.selectedAudio) node.selectedAudio.durationSeconds = targetDuration;
    });
}

function refreshActBoardNarrationTimingForNode(node) {
  if (!node?.id) return;
  refreshActBoardLinkedAudioTimingForTarget(node);
  document.querySelectorAll('.storyboard-act-board-narration-timing').forEach(controls => {
    if (controls.dataset.narrationNodeId !== String(node.id)) return;
    const sourceDuration = Math.max(0, Number(
      node.sourceDurationSeconds || node.audioDurationSeconds || 0,
    ));
    const sourceIn = Math.max(0, Number(node.trimStartSeconds) || 0);
    const available = sourceDuration > 0 ? Math.max(0.1, sourceDuration - sourceIn) : 3600;
    controls.querySelectorAll('input').forEach(input => {
      const role = input.dataset.narrationTimingRole;
      if (role === 'start') input.value = (Number(node.startSeconds) || 0).toFixed(1);
      if (role === 'source-in') {
        input.max = String(sourceDuration > 0 ? Math.max(0, sourceDuration - 0.1) : 3600);
        input.value = sourceIn.toFixed(1);
      }
      if (role === 'length') {
        input.max = String(available);
        input.value = (actBoardNarrationSegmentDuration(node) || 0.5).toFixed(1);
      }
    });
    const timing = controls.closest('.storyboard-act-board-node')
      ?.querySelector('.storyboard-act-board-node-timing');
    if (timing) setActBoardNodeTimingText(timing, actBoardPlaybackTimingLabel(
      node.startSeconds, actBoardNarrationSegmentDuration(node) || 0.5,
    ));
  });
  document.querySelectorAll('.storyboard-act-board-narration-source-editor').forEach(editor => {
    if (editor.dataset.narrationNodeId === String(node.id)
      && typeof editor._actBoardRefresh === 'function') editor._actBoardRefresh();
  });
  document.querySelectorAll('.storyboard-act-board-playback-audio-track').forEach(track => {
    const ownsNode = Array.from(track.querySelectorAll('[data-audio-node-id]'))
      .some(segment => segment.dataset.audioNodeId === String(node.id));
    if (ownsNode && typeof track._actBoardRefresh === 'function') track._actBoardRefresh();
  });
  refreshActBoardPlaybackDurations();
}

function refreshActBoardFootageTrackForNode(node) {
  if (!node?.id) return;
  refreshActBoardLinkedAudioTimingForTarget(node);
  document.querySelectorAll('.storyboard-act-board-footage-track').forEach(track => {
    const ownsNode = Array.from(track.querySelectorAll('.storyboard-act-board-footage-track-segment'))
      .some(segment => segment.dataset.footageNodeId === String(node.id));
    if (ownsNode && typeof track._actBoardRefresh === 'function') track._actBoardRefresh();
  });
  // Keep every representation of the same timing window in sync without
  // rebuilding the board: node inputs, source-window editor, and playback
  // transport all read the live footage-node values.
  document.querySelectorAll('.storyboard-act-board-footage-timing-controls').forEach(controls => {
    if (controls.dataset.footageNodeId !== String(node.id)) return;
    const sourceDuration = actBoardFootageSourceDuration(node);
    const sourceIn = Math.max(0, Number(node.trimStartSeconds) || 0);
    const available = sourceDuration > 0 ? Math.max(0.1, sourceDuration - sourceIn) : 3600;
    controls.querySelectorAll('input').forEach(input => {
      const role = input.dataset.footageTimingRole;
      if (role === 'start') input.value = (Number(node.startSeconds) || 0).toFixed(1);
      if (role === 'source-in') {
        input.max = String(sourceDuration > 0 ? Math.max(0, sourceDuration - 0.1) : 3600);
        input.value = sourceIn.toFixed(1);
      }
      if (role === 'length') {
        input.max = String(available);
        input.value = (Number(node.durationSeconds) || 0.5).toFixed(1);
      }
    });
    const timing = controls.parentElement?.querySelector('.storyboard-act-board-node-timing');
    if (timing) setActBoardNodeTimingText(timing, actBoardPlaybackTimingLabel(
      node.startSeconds, node.durationSeconds || 0.5,
    ));
  });
  document.querySelectorAll('.storyboard-act-board-footage-source-editor').forEach(editor => {
    if (editor.dataset.footageNodeId === String(node.id)
      && typeof editor._actBoardRefresh === 'function') editor._actBoardRefresh();
  });
  refreshActBoardPlaybackDurations();
  refreshActBoardFootagePreviewForNode(node);
}

// The selected footage preview is a real <video> element, so its native loop
// would otherwise play the entire source file even when the node is trimmed to
// a shorter timeline segment. Keep the preview window in sync with the node's
// source-in and duration controls without rebuilding the board.
function refreshActBoardFootagePreviewForNode(node) {
  if (!node?.id) return;
  document.querySelectorAll('.storyboard-act-board-footage-featured video').forEach(video => {
    if (video.dataset.nodeId !== String(node.id)
      && video.closest('.storyboard-act-board-node')?.dataset.nodeId !== String(node.id)) return;
    if (typeof video._actBoardSyncTiming === 'function') video._actBoardSyncTiming(true);
  });
}

function buildActBoardFootageTrack(actKey, narrationNode, boardLayer, linkedOverride = null, timelineOwner = narrationNode) {
  const linked = Array.isArray(linkedOverride)
    ? linkedOverride : orderedActBoardLinkedFootage(actKey, narrationNode);
  if (!linked.length) return null;
  // A relinked chain can carry stale timestamps from its previous order.
  // Keep any intentional gap before the first shot, but repair overlaps in
  // sequence order before measuring the track so every linked segment remains
  // visible and the shared duration includes the final shot.
  let linkedCursor = 0;
  let repairedLinkedTiming = false;
  linked.forEach(footage => {
    const duration = Math.max(0.5, Number(footage.durationSeconds) || 1);
    const currentStart = Math.max(0, Number(footage.startSeconds) || 0);
    const start = currentStart < linkedCursor
      ? linkedCursor : currentStart;
    if (Math.abs(start - currentStart) > 0.001) {
      footage.startSeconds = Number(start.toFixed(2));
      repairedLinkedTiming = true;
    }
    linkedCursor = start + duration;
  });
  if (repairedLinkedTiming) saveDebugSession();
  const readTimelineOwnerDuration = () => typeof timelineOwner?._actBoardTimelineDurationReader === 'function'
    ? Math.max(0, Number(timelineOwner._actBoardTimelineDurationReader()) || 0)
    : Math.max(0, Number(timelineOwner?.timelineDurationSeconds) || 0);
  const sharedTimeline = typeof timelineOwner?._actBoardTimelineDurationReader === 'function';
  const track = document.createElement('div');
  track.className = 'storyboard-act-board-footage-track';
  const label = document.createElement('div');
  label.className = 'storyboard-act-board-footage-track-label';
  label.textContent = 'Footage track';
  track.appendChild(label);
  const strip = document.createElement('div');
  strip.className = 'storyboard-act-board-footage-track-strip';
  let total = Math.max(
    0.001,
    sharedTimeline ? 0 : (narrationNode ? 0 : 10),
    readTimelineOwnerDuration(),
    sharedTimeline ? 0 : Number(timelineOwner?.durationSeconds) || 0,
    ...linked.map(node => (Number(node.startSeconds) || 0)
      + Math.max(0.5, Number(node.durationSeconds) || 1)),
  );
  track.dataset.actKey = actKey;
  if (timelineOwner?.id) track.dataset.timelineOwnerId = timelineOwner.id;
  if (timelineOwner) timelineOwner.timelineDurationSeconds = total;
  const segmentEntries = [];
  linked.forEach((footage, index) => {
    const start = Math.max(0, Number(footage.startSeconds) || 0);
    const duration = Math.max(0.5, Number(footage.durationSeconds) || 1);
    const gap = document.createElement('div');
    gap.className = 'storyboard-act-board-footage-track-gap';
    gap.textContent = 'No footage';
    gap.setAttribute('aria-label', 'No footage in this interval');
    strip.appendChild(gap);
    const segment = document.createElement('div');
    segment.className = 'storyboard-act-board-footage-track-segment';
    segment.dataset.footageNodeId = footage.id;
    segment.setAttribute('role', 'button');
    segment.tabIndex = 0;
    segment.title = `${footage.fragment || 'Footage'} · ${Number(footage.durationSeconds || 0).toFixed(1)}s · drag to move · double-click to link`;
    const durationLabel = document.createElement('span');
    durationLabel.className = 'storyboard-act-board-footage-track-duration-label';
    durationLabel.textContent = `${Number(footage.durationSeconds || 0).toFixed(1)}s`;
    const startHandle = document.createElement('span');
    startHandle.className = 'storyboard-act-board-footage-track-handle start';
    startHandle.title = 'Drag to change where this footage starts';
    startHandle.setAttribute('aria-label', 'Adjust footage start');
    const endHandle = document.createElement('span');
    endHandle.className = 'storyboard-act-board-footage-track-handle end';
    endHandle.title = 'Drag to change where this footage ends';
    endHandle.setAttribute('aria-label', 'Adjust footage end');
    segment.append(durationLabel, startHandle, endHandle);
    segment.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (segment.dataset.dragMoved === 'true') {
        delete segment.dataset.dragMoved;
        return;
      }
      highlightActBoardFootageNode(boardLayer, footage.id);
    });
    segment.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        highlightActBoardFootageNode(boardLayer, footage.id);
      }
    });
    segment.addEventListener('dblclick', event => {
      event.preventDefault();
      event.stopPropagation();
      const card = boardLayer.querySelector(`[data-node-id="${footage.id}"]`);
      card?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
    });
    const entry = { footage, gap, segment, durationLabel, startHandle, endHandle, index };
    // Dragging the body of a track segment moves its timeline position while
    // preserving the source window and duration. The boundary handles below
    // remain responsible for changing the start/end of the segment itself.
    segment.addEventListener('pointerdown', event => {
      if (event.target.closest('.storyboard-act-board-footage-track-handle')) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = strip.getBoundingClientRect();
      if (!(rect.width > 0)) return;
      const originX = event.clientX;
      const initialStart = Math.max(0, Number(footage.startSeconds) || 0);
      const duration = Math.max(0.5, Number(footage.durationSeconds) || 1);
      const previousBoundary = index > 0
        ? Math.max(0, (Number(linked[index - 1].startSeconds) || 0)
          + Math.max(0.5, Number(linked[index - 1].durationSeconds) || 1)) : 0;
      const nextBoundary = index < linked.length - 1
        ? Math.max(0, Number(linked[index + 1].startSeconds) || 0) : Infinity;
      const maxStart = Number.isFinite(nextBoundary)
        ? Math.max(previousBoundary, nextBoundary - duration)
        : Math.max(previousBoundary, total - duration);
      let lastClientX = originX;
      let frameId = 0;
      let moved = false;
      try { segment.setPointerCapture(event.pointerId); } catch (err) { /* optional */ }
      segment.classList.add('dragging');
      const applyMove = clientX => {
        const delta = ((clientX - originX) / rect.width) * total;
        if (Math.abs(clientX - originX) > 2) moved = true;
        const nextStart = Math.max(previousBoundary,
          Math.min(maxStart, initialStart + delta));
        footage.startSeconds = Number(nextStart.toFixed(2));
        footage.timingWasManuallyAdjusted = true;
        footage.durationWasSuggested = false;
        footage.alignedToNarration = false;
        if (moved) segment.dataset.dragMoved = 'true';
        if (timelineOwner) timelineOwner.timelineDurationSeconds = Math.max(
          Number(timelineOwner.timelineDurationSeconds) || 0,
          footage.startSeconds + duration,
        );
        updateTrackLayout();
        const coverageStart = footage.startSeconds;
        const coverageEnd = coverageStart + duration;
        const covered = narrationNode
          ? highlightActBoardNarrationTiming(boardLayer, narrationNode, coverageStart, coverageEnd) : [];
        timingCue.textContent = covered.length
          ? `Narration coverage: ${covered.join(' · ')}`
          : narrationNode ? 'Narration coverage: no matched phrase' : 'Footage timing adjusted';
        const timingBanner = boardLayer.querySelector(
          `[data-node-id="${footage.id}"] .storyboard-act-board-node-timing`,
        );
        if (timingBanner) {
            timingBanner.textContent = actBoardPlaybackTimingLabel(
              footage.startSeconds, footage.durationSeconds || duration,
            );
        }
        refreshActBoardFootageTrackForNode(footage);
      };
      const move = moveEvent => {
        lastClientX = moveEvent.clientX;
        if (frameId) return;
        if (typeof requestAnimationFrame !== 'function') {
          applyMove(lastClientX);
          return;
        }
        frameId = requestAnimationFrame(() => {
          frameId = 0;
          applyMove(lastClientX);
        });
      };
      const finish = () => {
        if (frameId) {
          cancelAnimationFrame(frameId);
          frameId = 0;
          applyMove(lastClientX);
        }
        segment.classList.remove('dragging');
        if (narrationNode) clearActBoardNarrationTimingHighlight(boardLayer, narrationNode);
        timingCue.textContent = '';
        saveDebugSession();
        segment.removeEventListener('pointermove', move);
        segment.removeEventListener('pointerup', finish);
        segment.removeEventListener('pointercancel', finish);
        try { segment.releasePointerCapture(event.pointerId); } catch (err) { /* optional */ }
      };
      segment.addEventListener('pointermove', move);
      segment.addEventListener('pointerup', finish, { once: true });
      segment.addEventListener('pointercancel', finish, { once: true });
    });
    const wireBoundaryDrag = (handle, edge) => {
      handle.addEventListener('pointerdown', event => {
        event.preventDefault();
        event.stopPropagation();
        const rect = strip.getBoundingClientRect();
        if (!(rect.width > 0)) return;
        const originX = event.clientX;
        const timelineScale = total;
        const initialStart = Math.max(0, Number(footage.startSeconds) || 0);
        const initialDuration = Math.max(0.5, Number(footage.durationSeconds) || 1);
        const initialEnd = initialStart + initialDuration;
        const sourceDuration = actBoardFootageSourceDuration(footage);
        const sourceIn = Math.max(0, Number(footage.trimStartSeconds) || 0);
        const maxSourceLength = sourceDuration > 0
          ? Math.max(0.5, sourceDuration - sourceIn) : Infinity;
        const previousBoundary = index > 0
          ? Math.max(0, (Number(linked[index - 1].startSeconds) || 0)
            + Math.max(0.5, Number(linked[index - 1].durationSeconds) || 1)) : 0;
        // Keep the original starts so an end resize can ripple later shots
        // from their pre-drag positions on every pointer frame. This avoids
        // compounding rounding error while still preserving their gaps.
        const followingStarts = linked.slice(index + 1).map(item =>
          Math.max(0, Number(item.startSeconds) || 0));
        const minimumDuration = 0.5;
        try { handle.setPointerCapture(event.pointerId); } catch (err) { /* optional */ }
        segment.classList.add('resizing');
        let frameId = 0;
        let lastClientX = originX;
        const applyMove = clientX => {
          const delta = ((clientX - originX) / rect.width) * timelineScale;
          if (edge === 'start') {
            const nextStart = Math.max(previousBoundary,
              Math.min(initialEnd - minimumDuration, initialStart + delta));
            footage.startSeconds = Number(nextStart.toFixed(2));
            footage.durationSeconds = Number(Math.max(minimumDuration,
              Math.min(maxSourceLength, initialEnd - nextStart)).toFixed(2));
          } else {
            const nextEnd = Math.max(initialStart + minimumDuration,
              initialEnd + delta);
            footage.startSeconds = Number(initialStart.toFixed(2));
            footage.durationSeconds = Number(Math.max(minimumDuration,
              Math.min(maxSourceLength, nextEnd - initialStart)).toFixed(2));
            const durationDelta = footage.durationSeconds - initialDuration;
            linked.slice(index + 1).forEach((following, followingIndex) => {
              following.startSeconds = Number(Math.max(0,
                followingStarts[followingIndex] + durationDelta).toFixed(2));
              refreshActBoardLinkedAudioTimingForTarget(following);
            });
          }
          footage.durationWasSuggested = false;
          footage.alignedToNarration = false;
          footage.timingWasManuallyAdjusted = true;
          const currentEnd = (Number(footage.startSeconds) || 0)
            + Math.max(minimumDuration, Number(footage.durationSeconds) || minimumDuration);
          if (timelineOwner) timelineOwner.timelineDurationSeconds = Math.max(total, currentEnd);
          updateTrackLayout();
          const coverageStart = Number(footage.startSeconds) || 0;
          const coverageEnd = currentEnd;
          const covered = narrationNode
            ? highlightActBoardNarrationTiming(boardLayer, narrationNode, coverageStart, coverageEnd) : [];
          timingCue.textContent = covered.length
            ? `Narration coverage: ${covered.join(' · ')}`
            : narrationNode ? 'Narration coverage: no matched phrase' : 'Footage timing adjusted';
          const timingBanner = boardLayer.querySelector(
            `[data-node-id="${footage.id}"] .storyboard-act-board-node-timing`,
          );
          if (timingBanner) {
            timingBanner.textContent = actBoardPlaybackTimingLabel(
              footage.startSeconds, footage.durationSeconds,
            );
          }
          refreshActBoardFootageTrackForNode(footage);
        };
        const move = moveEvent => {
          lastClientX = moveEvent.clientX;
          if (frameId) return;
          if (typeof requestAnimationFrame !== 'function') {
            applyMove(lastClientX);
            return;
          }
          frameId = requestAnimationFrame(() => {
            frameId = 0;
            applyMove(lastClientX);
          });
        };
        const finish = () => {
          if (frameId) {
            cancelAnimationFrame(frameId);
            frameId = 0;
            applyMove(lastClientX);
          }
          segment.classList.remove('resizing');
          if (narrationNode) clearActBoardNarrationTimingHighlight(boardLayer, narrationNode);
          timingCue.textContent = '';
          saveDebugSession();
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', finish);
          handle.removeEventListener('pointercancel', finish);
          try { handle.releasePointerCapture(event.pointerId); } catch (err) { /* optional */ }
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', finish, { once: true });
        handle.addEventListener('pointercancel', finish, { once: true });
      });
    };
    wireBoundaryDrag(startHandle, 'start');
    wireBoundaryDrag(endHandle, 'end');
    segmentEntries.push(entry);
    strip.appendChild(segment);
  });
  track.appendChild(strip);
  const timingCue = document.createElement('small');
  timingCue.className = 'storyboard-act-board-footage-track-timing-cue';
  timingCue.setAttribute('aria-live', 'polite');
  track.appendChild(timingCue);
  const updateTrackLayout = () => {
    // Controls on footage cards can lengthen a segment after this track was
    // rendered. Recompute the scale before laying out every segment so a
    // 30-second shot expands the track rather than overflowing it.
    total = Math.max(
      0.001,
      sharedTimeline ? 0 : (narrationNode ? 0 : 10),
      readTimelineOwnerDuration(),
      sharedTimeline ? 0 : Number(timelineOwner?.durationSeconds) || 0,
      ...linked.map(node => (Number(node.startSeconds) || 0)
        + Math.max(0.5, Number(node.durationSeconds) || 1)),
    );
    if (timelineOwner) timelineOwner.timelineDurationSeconds = total;
    let cursor = 0;
    segmentEntries.forEach(({ footage, gap, segment, durationLabel }) => {
      const start = Math.max(0, Number(footage.startSeconds) || 0);
      const duration = Math.max(0.5, Number(footage.durationSeconds) || 1);
      const gapDuration = Math.max(0, start - cursor);
      gap.style.width = `${(gapDuration / total) * 100}%`;
      gap.classList.toggle('empty', gapDuration < 0.01);
      gap.classList.toggle('compact', gapDuration < total * 0.12);
      segment.style.width = `${(duration / total) * 100}%`;
      durationLabel.textContent = `${duration.toFixed(1)}s`;
      cursor = Math.max(cursor, start + duration);
    });
    const trailingGap = Math.max(0, total - cursor);
    // The final gap is represented by the next layout gap placeholder when a
    // segment is shortened; keep it visible by appending a lightweight tail.
    if (!updateTrackLayout.trailingGap) {
      updateTrackLayout.trailingGap = document.createElement('div');
      updateTrackLayout.trailingGap.className = 'storyboard-act-board-footage-track-gap trailing';
      updateTrackLayout.trailingGap.textContent = 'No footage';
      updateTrackLayout.trailingGap.setAttribute('aria-label', 'No footage in this interval');
      strip.appendChild(updateTrackLayout.trailingGap);
    }
    updateTrackLayout.trailingGap.style.width = `${(trailingGap / total) * 100}%`;
    updateTrackLayout.trailingGap.classList.toggle('empty', trailingGap < 0.01);
    updateTrackLayout.trailingGap.classList.toggle('compact', trailingGap < total * 0.12);
  };
  track._actBoardRefresh = updateTrackLayout;
  updateTrackLayout();
  return track;
}

// Playback-only audio rails. These deliberately edit only timeline start and
// length; source-in/source-window editing remains on the narration or sound
// node itself. The narration rail reuses the same word-coverage highlighter as
// the footage rail while its segment is being adjusted.
function buildActBoardPlaybackAudioTrack({
  actKey,
  labelText,
  entries,
  kind,
  narrationNode = null,
  boardLayer,
  timelineOwner = null,
}) {
  const nodes = (Array.isArray(entries) ? entries : []).filter(Boolean);
  if (!nodes.length) return null;
  const track = document.createElement('div');
  track.className = `storyboard-act-board-footage-track storyboard-act-board-playback-audio-track storyboard-act-board-playback-${kind}-track`;
  const label = document.createElement('div');
  label.className = 'storyboard-act-board-footage-track-label';
  label.textContent = labelText;
  track.appendChild(label);
  const strip = document.createElement('div');
  strip.className = 'storyboard-act-board-footage-track-strip';
  track.appendChild(strip);
  const readStart = node => Math.max(0, Number(node.startSeconds) || 0);
  const readDuration = node => kind === 'narration'
    ? Math.max(0.5, actBoardNarrationSegmentDuration(node)
      || estimateActBoardNarrationSeconds(node.transcript || node.text))
    : Math.max(0.25, Number(node.durationSeconds) || 0.25);
  const readTimelineOwnerDuration = () => typeof timelineOwner?._actBoardTimelineDurationReader === 'function'
    ? Math.max(0, Number(timelineOwner._actBoardTimelineDurationReader()) || 0)
    : Math.max(0, Number(timelineOwner?.timelineDurationSeconds) || 0);
  const sharedTimeline = typeof timelineOwner?._actBoardTimelineDurationReader === 'function';
  let total = Math.max(
    0.1,
    readTimelineOwnerDuration(),
    sharedTimeline ? 0 : Number(timelineOwner?.durationSeconds) || 0,
    ...nodes.map(node => readStart(node) + readDuration(node)),
  );
  if (timelineOwner) timelineOwner.timelineDurationSeconds = sharedTimeline
    ? total : Math.max(Number(timelineOwner.timelineDurationSeconds) || 0, total);
  const segmentEntries = [];
  const timingCue = document.createElement('small');
  timingCue.className = 'storyboard-act-board-footage-track-timing-cue';
  const gapLabel = kind === 'narration' ? 'No narration' : 'No audio';

  const updateTrackLayout = () => {
    total = Math.max(
      0.1,
      readTimelineOwnerDuration(),
      sharedTimeline ? 0 : Number(timelineOwner?.durationSeconds) || 0,
      ...nodes.map(node => readStart(node) + readDuration(node)),
    );
    if (timelineOwner) timelineOwner.timelineDurationSeconds = sharedTimeline
      ? total : Math.max(Number(timelineOwner.timelineDurationSeconds) || 0, total);
    let cursor = 0;
    segmentEntries.forEach(({ node, gap, segment, durationLabel }) => {
      const start = readStart(node);
      const duration = readDuration(node);
      const gapDuration = Math.max(0, start - cursor);
      gap.style.width = `${(gapDuration / total) * 100}%`;
      gap.classList.toggle('empty', gapDuration < 0.01);
      gap.classList.toggle('compact', gapDuration < total * 0.12);
      segment.style.width = `${(duration / total) * 100}%`;
      durationLabel.textContent = `${duration.toFixed(1)}s`;
      cursor = Math.max(cursor, start + duration);
    });
    const trailingGap = Math.max(0, total - cursor);
    if (!updateTrackLayout.trailingGap) {
      updateTrackLayout.trailingGap = document.createElement('div');
      updateTrackLayout.trailingGap.className = 'storyboard-act-board-footage-track-gap trailing';
      updateTrackLayout.trailingGap.textContent = gapLabel;
      updateTrackLayout.trailingGap.setAttribute('aria-label', `${gapLabel} in this interval`);
      strip.appendChild(updateTrackLayout.trailingGap);
    }
    updateTrackLayout.trailingGap.style.width = `${(trailingGap / total) * 100}%`;
    updateTrackLayout.trailingGap.classList.toggle('empty', trailingGap < 0.01);
    updateTrackLayout.trailingGap.classList.toggle('compact', trailingGap < total * 0.12);
  };

  const setTiming = (node, start, duration, { ripple = false } = {}) => {
    const safeStart = Math.max(0, Number(start) || 0);
    const sourceDuration = kind === 'narration'
      ? Math.max(0, Number(node.sourceDurationSeconds || node.audioDurationSeconds
        || node.narrationAudioDurationSeconds || 0)) : 0;
    const sourceIn = Math.max(0, Number(node.trimStartSeconds) || 0);
    const available = sourceDuration > 0
      ? Math.max(0.1, sourceDuration - sourceIn) : Infinity;
    const safeDuration = Math.max(kind === 'narration' ? 0.5 : 0.25,
      Math.min(available, Number(duration) || (kind === 'narration' ? 0.5 : 0.25)));
    // Treat an end-handle resize as a ripple edit.  A longer first segment
    // must make room for every segment that follows it, rather than leaving
    // those segments beyond the visible track or letting them overlap the
    // resized segment.  `setTiming` is also used by the pointer-move loop, so
    // comparing against the node's current duration makes each update apply
    // only the incremental delta.
    const previousDuration = readDuration(node);
    const durationDelta = safeDuration - previousDuration;
    if (ripple && Math.abs(durationDelta) > 0.0001) {
      const entry = segmentEntries.find(item => item.node === node);
      const entryIndex = entry ? entry.index : nodes.indexOf(node);
      if (entryIndex >= 0) {
        nodes.slice(entryIndex + 1).forEach(following => {
          following.startSeconds = Number(Math.max(0,
            readStart(following) + durationDelta).toFixed(2));
          refreshActBoardLinkedAudioTimingForTarget(following);
        });
      }
    }
    node.startSeconds = Number(safeStart.toFixed(2));
    if (kind === 'narration') {
      node.timingWasManuallyAdjusted = true;
      node.narrationSegmentDurationSeconds = Number(safeDuration.toFixed(2));
      if (!(node.footageNodeIds || []).length) node.durationSeconds = node.narrationSegmentDurationSeconds;
      refreshActBoardNarrationTimingForNode(node);
    } else {
      node.durationSeconds = Number(safeDuration.toFixed(2));
      if (node.selectedAudio) node.selectedAudio.durationSeconds = node.durationSeconds;
      refreshActBoardAudioTimingForNode(node);
    }
    const card = boardLayer?.querySelector(`[data-node-id="${node.id}"]`);
    const timing = card?.querySelector('.storyboard-act-board-node-timing');
    if (timing) setActBoardNodeTimingText(timing,
      actBoardPlaybackTimingLabel(safeStart, safeDuration));
    if (timelineOwner) timelineOwner.timelineDurationSeconds = Math.max(
      Number(timelineOwner.timelineDurationSeconds) || 0, safeStart + safeDuration,
    );
    updateTrackLayout();
    refreshActBoardPlaybackDurations();
    return { start: safeStart, duration: safeDuration };
  };

  const showNarrationCoverage = node => {
    if (kind !== 'narration' || !node) return [];
    const start = readStart(node);
    const end = start + readDuration(node);
    // Word/transcript timestamps are relative to the narration file. Convert
    // the track's absolute scene time back to that local narration clock so
    // moving the narration segment still highlights the words it covers.
    const narrationStart = readStart(node);
    const covered = highlightActBoardNarrationTiming(
      boardLayer,
      node,
      Math.max(0, start - narrationStart),
      Math.max(0, end - narrationStart),
    );
    timingCue.textContent = covered.length
      ? `Narration coverage: ${covered.join(' · ')}` : 'Narration coverage: no matched phrase';
    return covered;
  };

  nodes.forEach((node, index) => {
    const gap = document.createElement('div');
    gap.className = 'storyboard-act-board-footage-track-gap';
    gap.textContent = gapLabel;
    gap.setAttribute('aria-label', `${gapLabel} in this interval`);
    strip.appendChild(gap);
    const segment = document.createElement('div');
    segment.className = `storyboard-act-board-footage-track-segment storyboard-act-board-playback-audio-track-segment storyboard-act-board-playback-${kind}-segment`;
    segment.dataset.audioNodeId = node.id;
    segment.setAttribute('role', 'button');
    segment.tabIndex = 0;
    segment.title = `${labelText} · drag to move · drag either edge to change length`;
    const durationLabel = document.createElement('span');
    durationLabel.className = 'storyboard-act-board-footage-track-duration-label';
    durationLabel.textContent = `${readDuration(node).toFixed(1)}s`;
    const startHandle = document.createElement('span');
    startHandle.className = 'storyboard-act-board-footage-track-handle start';
    startHandle.title = 'Drag to change when this segment starts';
    const endHandle = document.createElement('span');
    endHandle.className = 'storyboard-act-board-footage-track-handle end';
    endHandle.title = 'Drag to change this segment length';
    segment.append(durationLabel, startHandle, endHandle);
    segment.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (segment.dataset.dragMoved === 'true') {
        delete segment.dataset.dragMoved;
        return;
      }
      showNarrationCoverage(node);
    });
    segment.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        showNarrationCoverage(node);
      }
    });
    const entry = { node, gap, segment, durationLabel, startHandle, endHandle, index };
    const wireBoundary = (handle, edge) => {
      handle.addEventListener('pointerdown', event => {
        event.preventDefault();
        event.stopPropagation();
        const rect = strip.getBoundingClientRect();
        if (!(rect.width > 0)) return;
        const originX = event.clientX;
        const timelineScale = total;
        const initialStart = readStart(node);
        const initialDuration = readDuration(node);
        const initialEnd = initialStart + initialDuration;
        try { handle.setPointerCapture(event.pointerId); } catch (err) { /* optional */ }
        segment.classList.add('resizing');
        let lastClientX = originX;
        let frameId = 0;
        const apply = clientX => {
          const delta = ((clientX - originX) / rect.width) * timelineScale;
          const nextStart = edge === 'start'
            ? Math.max(0, initialStart + delta) : initialStart;
          const nextDuration = edge === 'start'
            ? Math.max(kind === 'narration' ? 0.5 : 0.25, initialEnd - nextStart)
            : Math.max(kind === 'narration' ? 0.5 : 0.25, initialDuration + delta);
          const timing = setTiming(node, nextStart, nextDuration, { ripple: edge === 'end' });
          if (kind === 'narration') showNarrationCoverage(node);
          segment.dataset.dragMoved = 'true';
          if (timing) durationLabel.textContent = `${timing.duration.toFixed(1)}s`;
        };
        const move = moveEvent => {
          lastClientX = moveEvent.clientX;
          if (frameId) return;
          if (typeof requestAnimationFrame !== 'function') {
            apply(lastClientX);
            return;
          }
          frameId = requestAnimationFrame(() => {
            frameId = 0;
            apply(lastClientX);
          });
        };
        const finish = () => {
          if (frameId) {
            cancelAnimationFrame(frameId);
            frameId = 0;
            apply(lastClientX);
          }
          segment.classList.remove('resizing');
          if (kind === 'narration') clearActBoardNarrationTimingHighlight(boardLayer, narrationNode);
          timingCue.textContent = '';
          saveDebugSession();
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', finish);
          handle.removeEventListener('pointercancel', finish);
          try { handle.releasePointerCapture(event.pointerId); } catch (err) { /* optional */ }
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', finish, { once: true });
        handle.addEventListener('pointercancel', finish, { once: true });
      });
    };
    const wireMove = () => {
      segment.addEventListener('pointerdown', event => {
        if (event.target.closest('.storyboard-act-board-footage-track-handle')) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = strip.getBoundingClientRect();
        if (!(rect.width > 0)) return;
        const originX = event.clientX;
        const initialStart = readStart(node);
        const duration = readDuration(node);
        let lastClientX = originX;
        let frameId = 0;
        let moved = false;
        try { segment.setPointerCapture(event.pointerId); } catch (err) { /* optional */ }
        segment.classList.add('dragging');
        const apply = clientX => {
          const delta = ((clientX - originX) / rect.width) * total;
          moved = moved || Math.abs(clientX - originX) > 2;
          const timing = setTiming(node, initialStart + delta, duration);
          if (kind === 'narration') showNarrationCoverage(node);
          if (moved) segment.dataset.dragMoved = 'true';
          if (timing) durationLabel.textContent = `${timing.duration.toFixed(1)}s`;
        };
        const move = moveEvent => {
          lastClientX = moveEvent.clientX;
          if (frameId) return;
          if (typeof requestAnimationFrame !== 'function') {
            apply(lastClientX);
            return;
          }
          frameId = requestAnimationFrame(() => {
            frameId = 0;
            apply(lastClientX);
          });
        };
        const finish = () => {
          if (frameId) {
            cancelAnimationFrame(frameId);
            frameId = 0;
            apply(lastClientX);
          }
          segment.classList.remove('dragging');
          if (kind === 'narration') clearActBoardNarrationTimingHighlight(boardLayer, narrationNode);
          timingCue.textContent = '';
          saveDebugSession();
          segment.removeEventListener('pointermove', move);
          segment.removeEventListener('pointerup', finish);
          segment.removeEventListener('pointercancel', finish);
          try { segment.releasePointerCapture(event.pointerId); } catch (err) { /* optional */ }
        };
        segment.addEventListener('pointermove', move);
        segment.addEventListener('pointerup', finish, { once: true });
        segment.addEventListener('pointercancel', finish, { once: true });
      });
    };
    wireBoundary(startHandle, 'start');
    wireBoundary(endHandle, 'end');
    wireMove();
    segmentEntries.push(entry);
    strip.appendChild(segment);
  });
  track.appendChild(timingCue);
  track._actBoardRefresh = updateTrackLayout;
  updateTrackLayout();
  return track;
}

function actBoardNarrationContext(actKey, act) {
  const scenes = actBoardSectionsForAct(actKey);
  const source = scenes.map((section, index) => {
    const narration = effectiveSectionNarration(section);
    const notes = sectionCompositionNotes(section);
    return `Scene ${index + 1}: ${section.title || 'Untitled scene'}\n${narration || notes}`;
  }).join('\n\n');
  return source.slice(0, 12000) || `${act.label || 'This act'}: ${act.description || ''}`;
}

function actBoardSourceMaterialContext(actKey, act) {
  const scenes = actBoardSectionsForAct(actKey);
  const source = scenes.map((section, index) =>
    `Scene ${index + 1}: ${section.title || 'Untitled scene'}\n${sectionCompositionNotes(section)}`
  ).filter(block => block.split('\n').slice(1).join('\n').trim()).join('\n\n');
  return source.slice(0, 12000) || `${act.label || 'This act'}: ${act.description || ''}`;
}

// Narration nodes keep an editable copy of the source context only after the
// presenter changes it. Until then, show the current act source material as a
// live fallback. An explicitly emptied field is respected; the first draft
// still uses the established act context, including any existing draft text.
function actBoardNarrationNotesForNode(actKey, act, node) {
  if (node && Object.prototype.hasOwnProperty.call(node, 'sceneNotes')) {
    return String(node.sceneNotes || '').trim();
  }
  return actBoardSourceMaterialContext(actKey, act);
}

function storyboardRenderElementKey(element) {
  if (!element) return '';
  const node = element.closest?.('[data-node-id]');
  const section = element.closest?.('[data-section-index]');
  const act = element.closest?.('[data-act-key]');
  const className = typeof element.className === 'string' ? element.className : '';
  const siblings = element.parentElement
    ? Array.from(element.parentElement.children).filter(item =>
      item.tagName === element.tagName
      && (typeof item.className === 'string' ? item.className : '') === className)
    : [];
  const siblingIndex = Math.max(0, siblings.indexOf(element));
  return [
    element.tagName,
    className,
    node?.dataset.nodeId || '',
    section?.dataset.sectionIndex || '',
    act?.dataset.actKey || '',
    siblingIndex,
  ].join('|');
}

function captureStoryboardRenderState() {
  const active = document.activeElement;
  return {
    windowX: Number(window.scrollX) || 0,
    windowY: Number(window.scrollY) || 0,
    details: Array.from(document.querySelectorAll('details')).map(element => ({
      key: storyboardRenderElementKey(element),
      open: element.open,
    })),
    scroll: Array.from(document.querySelectorAll('*'))
      .filter(element => (element.scrollTop || element.scrollLeft)
        && (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth))
      .map(element => ({
        key: storyboardRenderElementKey(element),
        top: element.scrollTop,
        left: element.scrollLeft,
      })),
    focus: active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)
      ? {
        key: storyboardRenderElementKey(active),
        start: Number.isFinite(active.selectionStart) ? active.selectionStart : null,
        end: Number.isFinite(active.selectionEnd) ? active.selectionEnd : null,
      } : null,
  };
}

function restoreStoryboardRenderState(state) {
  if (!state) return;
  const restore = () => {
    window.scrollTo(state.windowX, state.windowY);
    const elements = Array.from(document.querySelectorAll('*'));
    const byKey = new Map();
    elements.forEach(element => {
      const key = storyboardRenderElementKey(element);
      if (key && !byKey.has(key)) byKey.set(key, element);
    });
    state.details.forEach(item => {
      const element = byKey.get(item.key);
      if (element && element.tagName === 'DETAILS') element.open = item.open;
    });
    state.scroll.forEach(item => {
      const element = byKey.get(item.key);
      if (!element) return;
      element.scrollTop = item.top;
      element.scrollLeft = item.left;
    });
    if (state.focus) {
      const element = byKey.get(state.focus.key);
      if (element && typeof element.focus === 'function') {
        element.focus({ preventScroll: true });
        if (state.focus.start != null && typeof element.setSelectionRange === 'function') {
          try { element.setSelectionRange(state.focus.start, state.focus.end ?? state.focus.start); } catch (err) { /* optional */ }
        }
      }
    }
  };
  restore();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
}

function rerenderActBoard() {
  stopActBoardPlayback();
  stopActBoardNativeAudio();
  const renderState = captureStoryboardRenderState();
  const remaining = currentSections.filter(section => !section.removed);
  renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
  restoreStoryboardRenderState(renderState);
}

function actBoardAssetSectionIndex(node) {
  // The stock-download endpoint keeps its historical integer section_index
  // field; hash the node id into a stable positive integer for per-node files.
  let hash = 2166136261;
  for (const char of String(node?.id || 'act-board-footage')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) || 1;
}

function actBoardVisualIdentity(visual) {
  return String(visual?.id || visual?.video_url || visual?.url || '').trim();
}

function mergePinnedActBoardVisuals(existing, fresh) {
  const pinned = (Array.isArray(existing) ? existing : []).filter(item => item && item.pinned);
  const pinnedIds = new Set(pinned.map(actBoardVisualIdentity).filter(Boolean));
  const additions = (Array.isArray(fresh) ? fresh : []).filter(item => {
    const identity = actBoardVisualIdentity(item);
    return !identity || !pinnedIds.has(identity);
  });
  return [...pinned, ...additions];
}

// The shared /media/search_video route returns provider batches in a stable
// order so Timeline + Scenes can show every result. Act-board rails are capped
// at ten thumbnails, so taking the first ten would often hide the later
// providers entirely. Round-robin the batches here to keep the same provider
// variety in the smaller act-board result set.
function diversifyActBoardVideoResults(videos, limit = 10) {
  const groups = new Map();
  (Array.isArray(videos) ? videos : []).forEach(video => {
    if (!video) return;
    const source = String(video.source || 'Other').trim() || 'Other';
    if (!groups.has(source)) groups.set(source, []);
    groups.get(source).push(video);
  });
  const results = [];
  while (results.length < limit && groups.size) {
    for (const [source, group] of groups) {
      const video = group.shift();
      if (video) results.push(video);
      if (!group.length) groups.delete(source);
      if (results.length >= limit) break;
    }
  }
  return results;
}

function pinActBoardVisual(node, option) {
  if (!node || !option) return;
  const collection = option.generatedIndex != null ? node.generatedOptions : node.results;
  const index = option.generatedIndex != null ? option.generatedIndex : option.resultIndex;
  const visual = Array.isArray(collection) ? collection[index] : null;
  if (!visual) return;
  visual.pinned = !visual.pinned;
  saveDebugSession();
  rerenderActBoard();
}

async function findActBoardFootageNode(
  actKey,
  act,
  narrationNode,
  footageNode,
  shouldRerender = true,
  generateExamplesAfterSearch = false,
) {
  if (!act || !footageNode) return;
  const narrationText = String(narrationNode?.transcript || narrationNode?.text || '').trim();
  footageNode.status = 'generating';
  footageNode.error = '';
  if (shouldRerender) {
    saveDebugSession();
    rerenderActBoard();
  }
  try {
    const explicitQuery = footageNode.manualQuery && footageNode.query
      ? footageNode.query : (footageNode.filmabilityQuery || footageNode.query);
    const result = explicitQuery
      ? { video_query: explicitQuery }
      : await fetchMediaQueries({
        title: `Footage for ${footageNode.fragment}`,
        act: act.label || '',
        scene_notes: `${act.description || ''}\nFilmable narration fragment: ${footageNode.fragment}`.trim(),
        footage_fragment: footageNode.fragment,
        narration: narrationText,
        narration_entities: narrationNode?.narrationSpans || [],
        reference_footage_description: '',
        reference_footage_entities: [],
        abstract: findAbstractText(),
        documentary_mode: actBoardDocumentaryModeForNode(actKey, footageNode),
      });
    footageNode.query = (result.video_query || footageNode.fragment).trim();
    try {
      const minimumDuration = Math.max(1, Number(footageNode.durationSeconds) || 1);
      const cacheKey = `${footageNode.query.toLocaleLowerCase()}|${minimumDuration.toFixed(2)}`;
      let options = actBoardFootageSearchCache.get(cacheKey);
      if (!options) {
        options = await fetchVideoOptions(footageNode.query, minimumDuration);
        if (actBoardFootageSearchCache.size >= 128) {
          actBoardFootageSearchCache.delete(actBoardFootageSearchCache.keys().next().value);
        }
        actBoardFootageSearchCache.set(cacheKey, options);
      }
      const freshResults = diversifyActBoardVideoResults(options.videos, 10).map(video => ({
        id: video.id || '',
        video_url: video.video_url,
        thumbnail_url: video.thumbnail_url || '',
        source_url: video.source_url || '',
        source: video.source || '',
        duration_seconds: Number(video.duration_seconds || video.duration) || 0,
      }));
      const priorSelected = footageNode.selectedVisualKey?.startsWith('result-')
        ? footageNode.results[footageNode.selectedResultIndex || 0] : null;
      footageNode.results = mergePinnedActBoardVisuals(footageNode.results, freshResults);
      const preservedSelected = priorSelected?.pinned
        ? footageNode.results.findIndex(item => actBoardVisualIdentity(item) === actBoardVisualIdentity(priorSelected))
        : -1;
      const first = footageNode.results[0];
      if (preservedSelected >= 0) {
        const selected = footageNode.results[preservedSelected];
        footageNode.selectedVisualKey = `result-${preservedSelected}`;
        footageNode.selectedResultIndex = preservedSelected;
        footageNode.mediaUrl = selected.localPreviewUrl || '';
        footageNode.mediaThumbnailUrl = selected.thumbnail_url || '';
        footageNode.mediaKind = 'video';
        footageNode.mediaOrigin = 'suggested';
        footageNode.sourceDurationSeconds = Number(selected.duration_seconds || selected.duration) || 0;
      } else {
        if (first) {
          // Keep the upload prompt selected until a result is explicitly
          // picked. A remote CDN URL is not stable enough to use as the
          // default playback or export source; the selected result is
          // downloaded and remuxed below.
          footageNode.mediaUrl = '';
          footageNode.mediaThumbnailUrl = '';
          footageNode.mediaKind = '';
          footageNode.mediaOrigin = '';
          footageNode.selectedVisualKey = null;
          footageNode.selectedResultIndex = 0;
        }
      }
    } catch (err) {
      footageNode.error = `Search unavailable: ${err.message}`;
    }
    footageNode.status = 'ready';
  } catch (err) {
    footageNode.query = footageNode.query || footageNode.fragment;
    footageNode.status = 'ready';
    footageNode.error = err.message;
  }
  saveDebugSession();
  if (shouldRerender) rerenderActBoard();
  if (generateExamplesAfterSearch && footageNode.status === 'ready') {
    await generateActBoardNodeExamples(actKey, act, footageNode);
  }
}

function actBoardSelectedPhraseInsertionIndex(sourceText, footageIds, nodes, phrase) {
  const source = String(sourceText || '').toLocaleLowerCase();
  const phraseStart = Number.isFinite(Number(phrase?.start))
    ? Number(phrase.start) : source.indexOf(String(phrase?.text || '').toLocaleLowerCase());
  if (!Number.isFinite(phraseStart) || phraseStart < 0) return footageIds.length;
  for (let index = 0; index < footageIds.length; index += 1) {
    const footage = nodes.find(node => node.id === footageIds[index]);
    const fragment = String(footage?.fragment || '').trim();
    const fragmentStart = fragment ? source.indexOf(fragment.toLocaleLowerCase()) : -1;
    if (fragmentStart >= 0 && fragmentStart > phraseStart) return index;
    // A node created from an earlier free-floating link may not have a phrase
    // in the current narration. Its sequence start is a useful fallback.
    if (fragmentStart < 0 && Number.isFinite(Number(footage?.startSeconds))
      && Number(footage.startSeconds) > phraseStart) return index;
  }
  return footageIds.length;
}

async function suggestActBoardSelectedFootage(actKey, act, narrationNode, sourceText, selections) {
  const selected = (Array.isArray(selections) ? selections : [])
    .map(item => ({
      ...item,
      text: String(item?.text || '').replace(/\s+/g, ' ').trim(),
    }))
    .filter(item => item.text);
  if (!selected.length) return false;
  const nodes = actBoardNodesForAct(actKey);
  const parentScene = actBoardSceneForNode(actKey, narrationNode);
  const footageNodes = [];
  const footageIds = Array.isArray(narrationNode.footageNodeIds)
    ? narrationNode.footageNodeIds.filter(id => nodes.some(node => node.id === id)) : [];
  selected.forEach(phrase => {
    const query = String(phrase.query || phrase.visual_proxy || phrase.text).trim();
    let footageNode = nodes.find(node => node.type === 'footage'
      && node.narrationNodeId === narrationNode.id
      && String(node.fragment || '').toLocaleLowerCase() === phrase.text.toLocaleLowerCase());
    if (!footageNode) {
      footageNode = {
        id: createActBoardNodeId('footage'),
        type: 'footage',
        actKey,
        narrationNodeId: narrationNode.id,
        sceneId: parentScene?.id || narrationNode.sceneId || null,
        fragment: phrase.text,
        query: '',
        filmabilityBucket: phrase.bucket || 'depictable',
        filmabilityQuery: query,
        filmabilityProxy: phrase.visual_proxy || '',
        results: [],
        generatedOptions: [],
        status: 'generating',
        videoGenerationTechniques: [...ACT_BOARD_DEFAULT_VIDEO_TECHNIQUES],
        error: '',
        durationSeconds: 1,
        trimStartSeconds: 0,
        sourceDurationSeconds: 0,
        durationWasSuggested: true,
        previousFootageNodeId: null,
        nextFootageNodeId: null,
      };
      nodes.push(footageNode);
      const insertionIndex = actBoardSelectedPhraseInsertionIndex(
        sourceText, footageIds, nodes, phrase);
      footageIds.splice(insertionIndex, 0, footageNode.id);
      attachActBoardNodeToScene(actKey, footageNode);
    } else {
      footageNode.filmabilityQuery = query;
      footageNode.query = '';
      footageNode.manualQuery = false;
      footageNode.filmabilityBucket = phrase.bucket || footageNode.filmabilityBucket || 'depictable';
      footageNode.filmabilityProxy = phrase.visual_proxy || footageNode.filmabilityProxy || '';
      footageNode.status = 'generating';
      footageNode.error = '';
      if (!footageIds.includes(footageNode.id)) footageIds.push(footageNode.id);
    }
    footageNodes.push(footageNode);
  });
  narrationNode.footageNodeIds = footageIds;
  narrationNode.footageFragments = footageIds
    .map(id => nodes.find(node => node.id === id)?.fragment || '')
    .filter(Boolean);
  if (narrationNode.transcript && sourceText === narrationNode.transcript) {
    alignActBoardNarrationFragments(narrationNode);
  } else {
    recomputeActBoardTiming(narrationNode);
  }
  narrationNode.footageStatus = `Finding footage for ${footageNodes.length} selected phrase${footageNodes.length === 1 ? '' : 's'}...`;
  narrationNode.footageSuggestedPhrases = [
    ...(Array.isArray(narrationNode.footageSuggestedPhrases)
      ? narrationNode.footageSuggestedPhrases : []),
    ...selected.map(item => ({
      text: item.text,
      start: item.start,
      end: item.end,
    })),
  ].filter((item, index, all) => all.findIndex(candidate =>
    String(candidate.text || '').toLocaleLowerCase() === String(item.text || '').toLocaleLowerCase()
      && Number(candidate.start) === Number(item.start)) === index);
  narrationNode.selectedFootagePhrases = [];
  saveDebugSession();
  rerenderActBoard();
  await Promise.all(footageNodes.map(node =>
    findActBoardFootageNode(actKey, act, narrationNode, node, false, true)));
  narrationNode.footageStatus = 'Selected phrase footage added to the linked sequence.';
  saveDebugSession();
  rerenderActBoard();
  return true;
}

async function suggestActBoardFootage(actKey, act, narrationNode, sourceText) {
  const narrationText = String(sourceText || narrationNode.text || '').trim();
  const selectedPhrases = Array.isArray(narrationNode.selectedFootagePhrases)
    ? narrationNode.selectedFootagePhrases : [];
  if (selectedPhrases.length) {
    await suggestActBoardSelectedFootage(actKey, act, narrationNode, narrationText, selectedPhrases);
    return;
  }
  const smartSpans = Array.isArray(narrationNode.narrationSpans)
    ? narrationNode.narrationSpans.filter(span => span && span.bucket !== 'ignore' && span.bucket !== 'pending')
    : [];
  const fragments = smartSpans.length
    ? smartSpans.map(span => span.text).filter(Boolean).slice(0, 5)
    : actBoardNarrationFragments(narrationText);
  if (!fragments.length) {
    const oldIds = new Set((narrationNode.footageNodeIds || []).map(String));
    actBoardNodes[actKey] = actBoardNodesForAct(actKey)
      .filter(node => !oldIds.has(String(node.id)));
    narrationNode.footageNodeIds = [];
    narrationNode.footageFragments = [];
    narrationNode.footageStatus = 'No filmable narration fragments found';
    saveDebugSession();
    rerenderActBoard();
    return;
  }

  const nodes = actBoardNodesForAct(actKey);
  const parentScene = actBoardSceneForNode(actKey, narrationNode);
  const oldIds = new Set((narrationNode.footageNodeIds || []).map(String));
  actBoardNodes[actKey] = nodes.filter(node => !oldIds.has(String(node.id)));
  const footageNodes = fragments.map(fragment => {
    const smartSpan = smartSpans.find(span => span.text === fragment);
    return {
      id: createActBoardNodeId('footage'),
      type: 'footage',
      actKey,
      narrationNodeId: narrationNode.id,
      sceneId: parentScene?.id || narrationNode.sceneId || null,
      fragment,
      query: '',
      results: [],
      status: 'generating',
      videoGenerationTechniques: [...ACT_BOARD_DEFAULT_VIDEO_TECHNIQUES],
      error: '',
      trimStartSeconds: 0,
      sourceDurationSeconds: 0,
      previousFootageNodeId: null,
      nextFootageNodeId: null,
      ...(smartSpan ? {
        filmabilityBucket: smartSpan.bucket,
        filmabilityQuery: smartSpan.query || smartSpan.visual_proxy || fragment,
        filmabilityProxy: smartSpan.visual_proxy || '',
      } : {}),
    };
  });
  actBoardNodes[actKey].push(...footageNodes);
  // Keep the scene container's live membership and restore snapshot aligned
  // with the generated footage cards. Without this, the cards can render on
  // the live canvas but the framed scene only knows about the narration node.
  footageNodes.forEach(node => attachActBoardNodeToScene(actKey, node));
  narrationNode.footageNodeIds = footageNodes.map(node => node.id);
  narrationNode.footageFragments = fragments;
  if (narrationNode.transcript && narrationText === narrationNode.transcript) {
    alignActBoardNarrationFragments(narrationNode);
  } else {
    recomputeActBoardTiming(narrationNode);
  }
  narrationNode.footageStatus = `Finding footage for ${footageNodes.length} narration fragment${footageNodes.length === 1 ? '' : 's'}...`;
  saveDebugSession();
  rerenderActBoard();

  await Promise.all(footageNodes.map(node =>
    findActBoardFootageNode(actKey, act, narrationNode, node, false, true)));
  narrationNode.footageStatus = ``; // Suggested ${footageNodes.length} footage node${footageNodes.length === 1 ? '' : 's'} from narration fragments
  saveDebugSession();
  rerenderActBoard();
}

async function suggestActBoardNarration(actKey, act, button, position) {
  const nodes = actBoardNodesForAct(actKey);
  const node = {
    id: createActBoardNodeId('narration'),
    type: 'narration',
    actKey,
    status: 'generating',
    text: '',
    footageFragments: [],
    footageNodeIds: [],
    footageStatus: '',
    error: '',
    includeNarration: true,
    startSeconds: 0,
    trimStartSeconds: 0,
    sourceDurationSeconds: 0,
    narrationSegmentDurationSeconds: 0,
  };
  if (position) {
    node.boardX = Math.max(0, Number(position.x) || 0);
    node.boardY = Math.max(0, Number(position.y) || 0);
    node.boardPositionMode = 'manual';
  }
  attachActBoardNodeToScene(actKey, node);
  nodes.push(node);
  if (button) button.disabled = true;
  saveDebugSession();
  rerenderActBoard();
  try {
    const result = await fetchSuggestNarration({
      sectionTitle: `${act.label || 'Act'} narration`,
      // Preserve the established first-draft context (existing section
      // narration plus source notes). The editable node notes take over for
      // subsequent “Suggest narration” requests.
      sectionText: actBoardNarrationContext(actKey, act),
      actTitle: act.label || '',
      actDescription: act.description || '',
      abstract: findAbstractText(),
      documentaryMode: actBoardDocumentaryModeForNode(actKey, node),
    });
    node.text = (result.narration || '').trim();
    if (!node.text) throw new Error('The narration suggestion was empty.');
    node.status = 'ready';
    saveDebugSession();
    rerenderActBoard();
  } catch (err) {
    node.status = 'error';
    node.error = err.message;
    saveDebugSession();
    rerenderActBoard();
  } finally {
    if (button) button.disabled = false;
  }
}

async function resuggestActBoardNarration(actKey, act, narrationNode, button) {
  if (!narrationNode || narrationNode.status === 'generating') return;
  narrationNode.status = 'generating';
  narrationNode.error = '';
  if (button) button.disabled = true;
  saveDebugSession();
  rerenderActBoard();
  try {
    const currentNarration = [
      narrationNode.text ? `Suggested draft:\n${narrationNode.text}` : '',
      narrationNode.transcript ? `Recorded transcript:\n${narrationNode.transcript}` : '',
      narrationNode.footageFragments?.length
        ? `Edited filmable phrases:\n${narrationNode.footageFragments.join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
    const sceneNotes = actBoardNarrationNotesForNode(actKey, act, narrationNode);
    const result = await fetchSuggestNarration({
      sectionTitle: `${act.label || 'Act'} narration`,
      // Put the editable material first: the backend applies a hard
      // section-text limit, so appending it after a long current draft could
      // silently truncate the notes the presenter just changed.
      sectionText: `Editable scene notes / source material:\n${sceneNotes}\n\nCurrent narration and edited phrases:\n${currentNarration}`.trim(),
      actTitle: act.label || '',
      actDescription: act.description || '',
      abstract: findAbstractText(),
      documentaryMode: actBoardDocumentaryModeForNode(actKey, narrationNode),
    });
    narrationNode.text = (result.narration || '').trim();
    if (!narrationNode.text) throw new Error('The narration suggestion was empty.');
    narrationNode.status = 'ready';
    narrationNode.selectedFootagePhrases = [];
    narrationNode.footageSuggestedPhrases = [];
    narrationNode.footageFragments = actBoardNarrationFragments(
      narrationNode.transcript || narrationNode.text || '');
    narrationNode.footageStatus = ''; // Narration updated — press Suggest footage to refresh the linked footage.
    saveDebugSession();
    rerenderActBoard();
  } catch (err) {
    narrationNode.status = 'error';
    narrationNode.error = err.message;
    saveDebugSession();
    rerenderActBoard();
  } finally {
    if (button) button.disabled = false;
  }
}

function buildActBoardAudioResults(actKey, node) {
  const results = document.createElement('div');
  results.className = 'storyboard-act-board-audio-results';
  (node.results || []).forEach((sound, index) => {
    const result = document.createElement('div');
    result.className = 'storyboard-act-board-audio-result';
    const label = document.createElement('span');
    const duration = Number(sound.duration);
    label.textContent = `${sound.name || 'Untitled sound'}${Number.isFinite(duration) && duration > 0
      ? ` · ${duration.toFixed(1)}s` : ''}`;
    result.appendChild(label);
    const preview = document.createElement('audio');
    preview.controls = true;
    preview.preload = 'none';
    preview.src = sound.preview_url || '';
    wireActBoardAudioExclusivity(preview);
    preview.addEventListener('click', event => event.stopPropagation());
    result.appendChild(preview);
    const useButton = document.createElement('button');
    useButton.type = 'button';
    useButton.className = 'btn-secondary storyboard-act-board-node-action';
    useButton.textContent = 'Use sound';
    useButton.addEventListener('click', async event => {
      event.stopPropagation();
      useButton.disabled = true;
      node.status = 'downloading';
      node.error = '';
      node.audioSearchActive = false;
      saveDebugSession();
      rerenderActBoard();
      try {
        const downloaded = await fetchDownloadStockMedia(
          actBoardAssetSectionIndex(node), 'audio', sound.preview_url, premiereProjectId,
          Math.max(0.25, Number(node.durationSeconds) || Number(sound.duration) || 1),
          sound.id || node.id,
        );
        premiereProjectId = downloaded.project_id || premiereProjectId;
        const natural = Number(downloaded.duration_seconds) || Number(sound.duration) || 0;
        node.selectedAudio = {
          ...sound,
          localPreviewUrl: downloaded.preview_url || sound.preview_url,
          localFilePath: downloaded.file_path || null,
          sourceDurationSeconds: natural,
          trimStartSeconds: 0,
          durationSeconds: natural || Number(node.durationSeconds) || 1,
        };
        node.audioName = sound.name || 'Sound effect';
        node.audioPreviewUrl = downloaded.preview_url || sound.preview_url;
        node.sourceDurationSeconds = natural;
        if (node.linkedToNodeId) {
          const target = actBoardNodesForAct(actKey).find(item => item.id === node.linkedToNodeId);
          if (target) linkActBoardAudioNode(actKey, node, target);
        }
        node.status = 'ready';
      } catch (err) {
        node.status = 'error';
        node.error = `Could not use sound: ${err.message}`;
      }
      saveDebugSession();
      rerenderActBoard();
    });
    result.appendChild(useButton);
    results.appendChild(result);
  });
  return results;
}

function refreshActBoardAudioSearchDom(actKey, node) {
  const card = document.querySelector(`[data-node-id="${node.id}"]`);
  if (!card) return false;
  const oldResults = card.querySelector('.storyboard-act-board-audio-results');
  oldResults?.remove();
  const oldError = card.querySelector('.storyboard-act-board-node-error');
  oldError?.remove();
  const results = buildActBoardAudioResults(actKey, node);
  if (results.childElementCount
    && (!actBoardAudioSource(node).url || node.audioSearchActive)) card.appendChild(results);
  if (node.error) {
    const error = document.createElement('div');
    error.className = 'storyboard-act-board-node-error';
    error.textContent = node.error;
    card.appendChild(error);
  }
  const button = card.querySelector('.storyboard-act-board-audio-query-row .storyboard-act-board-node-action');
  if (button) {
    button.textContent = node.status === 'generating' ? 'Finding sound…' : 'Find sound';
    button.disabled = node.status === 'generating';
  }
  const stack = card.closest('.storyboard-act-board-node-stack');
  if (stack) {
    const nodes = orderedActBoardNodes(actKey, actBoardNodesForAct(actKey));
    refineActBoardRenderedGeometry(stack, nodes);
    expandActBoardScenesToContainNodes(stack, actKey, nodes);
    if (stack._actBoardLinkState) refreshActBoardLinkPaths(stack);
  }
  return true;
}

function refreshActBoardAudioTimingForNode(node) {
  if (!node?.id) return;
  document.querySelectorAll('.storyboard-act-board-audio-timing').forEach(controls => {
    if (controls.dataset.audioNodeId !== String(node.id)) return;
    const sourceDuration = Math.max(0, Number(
      node.sourceDurationSeconds || node.selectedAudio?.sourceDurationSeconds
        || node.selectedAudio?.duration || 0,
    ));
    const sourceIn = Math.max(0, Number(node.trimStartSeconds
      ?? node.selectedAudio?.trimStartSeconds) || 0);
    const available = sourceDuration > 0 ? Math.max(0.1, sourceDuration - sourceIn) : 3600;
    controls.querySelectorAll('input').forEach(input => {
      const role = input.dataset.audioTimingRole;
      if (role === 'start') input.value = (Number(node.startSeconds) || 0).toFixed(1);
      if (role === 'source-in') {
        input.max = String(sourceDuration > 0 ? Math.max(0, sourceDuration - 0.1) : 3600);
        input.value = sourceIn.toFixed(1);
      }
      if (role === 'length') {
        input.max = String(available);
        input.value = (Number(node.durationSeconds) || 0.1).toFixed(1);
      }
    });
    const card = controls.closest('.storyboard-act-board-node');
    const timing = card?.querySelector('.storyboard-act-board-node-timing');
    if (timing) setActBoardNodeTimingText(timing, actBoardPlaybackTimingLabel(
      node.startSeconds, node.durationSeconds || 0.1,
    ));
  });
  document.querySelectorAll('.storyboard-act-board-audio-source-editor').forEach(editor => {
    if (editor.dataset.audioNodeId === String(node.id)
      && typeof editor._actBoardRefresh === 'function') editor._actBoardRefresh();
  });
  document.querySelectorAll('.storyboard-act-board-playback-audio-track').forEach(track => {
    const ownsNode = Array.from(track.querySelectorAll('[data-audio-node-id]'))
      .some(segment => segment.dataset.audioNodeId === String(node.id));
    if (ownsNode && typeof track._actBoardRefresh === 'function') track._actBoardRefresh();
  });
  refreshActBoardPlaybackDurations();
}

function buildActBoardAudioNodeContent(actKey, act, node, card, stickyBanner = null) {
  const timing = document.createElement('div');
  timing.className = 'storyboard-act-board-node-timing';
  setActBoardNodeTimingText(timing,
    actBoardPlaybackTimingLabel(node.startSeconds, node.durationSeconds || 1));
  if (stickyBanner) stickyBanner.prepend(timing);
  else card.appendChild(timing);

  // const linkedTarget = node.linkedToNodeId
  //   ? actBoardNodesForAct(actKey).find(item => item.id === node.linkedToNodeId)
  //   : null;
  // const linkStatus = document.createElement('div');
  // linkStatus.className = `storyboard-act-board-audio-link-status${linkedTarget ? ' linked' : ''}`;
  // linkStatus.textContent = linkedTarget
  //   ? `Plays underneath ${linkedTarget.type === 'footage'
  //     ? (linkedTarget.fragment || 'linked footage') : 'linked narration'}`
  //   : 'Not linked — double-click this node, then a narration or footage node';
  // card.appendChild(linkStatus);

  const audioTiming = document.createElement('div');
  audioTiming.className = 'storyboard-act-board-audio-timing';
  audioTiming.dataset.audioNodeId = node.id;
  const makeTimingInput = (labelText, value, role, min, max) => {
    const label = document.createElement('label');
    label.textContent = labelText;
    label.title = role === 'start'
      ? 'Timeline start: when this sound begins in the scene'
      : role === 'source-in'
        ? 'Source in: where playback begins inside the sound file'
        : 'Length: how long this sound segment plays';
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.1';
    input.min = String(min);
    input.max = String(max);
    input.value = String(Number(value || 0).toFixed(1));
    input.dataset.audioTimingRole = role;
    input.addEventListener('pointerdown', event => event.stopPropagation());
    input.addEventListener('click', event => event.stopPropagation());
    label.appendChild(input);
    return { label, input };
  };
  const sourceDuration = Math.max(0, Number(
    node.sourceDurationSeconds || node.selectedAudio?.sourceDurationSeconds
      || node.selectedAudio?.duration || 0,
  ));
  const startControl = makeTimingInput('Start', node.startSeconds, 'start', 0, 3600);
  const sourceIn = Math.max(0, Number(node.trimStartSeconds
    ?? node.selectedAudio?.trimStartSeconds) || 0);
  const maxSourceIn = sourceDuration > 0 ? Math.max(0, sourceDuration - 0.1) : 3600;
  const sourceInControl = makeTimingInput('Source in', sourceIn, 'source-in', 0, maxSourceIn);
  const durationMax = sourceDuration > 0
    ? Math.max(0.1, sourceDuration - sourceIn)
    : 3600;
  const durationControl = makeTimingInput('Length', node.durationSeconds || 1, 'length', 0.1, durationMax);
  const updateAudioTiming = () => {
    const start = Math.max(0, Number(startControl.input.value) || 0);
    node.trimStartSeconds = Number(Math.min(maxSourceIn,
      Math.max(0, Number(sourceInControl.input.value) || 0)).toFixed(2));
    const available = sourceDuration > 0
      ? Math.max(0.1, sourceDuration - node.trimStartSeconds) : 3600;
    const duration = Math.max(0.1, Math.min(available,
      Number(durationControl.input.value) || 0.1));
    node.startSeconds = Number(start.toFixed(2));
    node.durationSeconds = Number(duration.toFixed(2));
    node.timingWasManuallyAdjusted = true;
    if (node.selectedAudio) {
      node.selectedAudio.trimStartSeconds = node.trimStartSeconds;
      node.selectedAudio.durationSeconds = node.durationSeconds;
    }
    sourceInControl.input.value = node.trimStartSeconds.toFixed(1);
    durationControl.input.max = String(available);
    durationControl.input.value = node.durationSeconds.toFixed(1);
    setActBoardNodeTimingText(timing,
      actBoardPlaybackTimingLabel(node.startSeconds, node.durationSeconds));
    refreshActBoardAudioTimingForNode(node);
    saveDebugSession();
  };
  startControl.input.addEventListener('input', updateAudioTiming);
  sourceInControl.input.addEventListener('input', updateAudioTiming);
  durationControl.input.addEventListener('input', updateAudioTiming);
  audioTiming.append(startControl.label, sourceInControl.label, durationControl.label);
  const timingHint = document.createElement('small');
  timingHint.className = 'storyboard-act-board-footage-timing-hint';
  timingHint.textContent = 'Start = timeline position · Source in = offset inside the sound file · Length = selected sound duration';
  audioTiming.appendChild(timingHint);
  card.appendChild(audioTiming);

  const queryRow = document.createElement('div');
  queryRow.className = 'storyboard-act-board-audio-query-row';
  const queryInput = document.createElement('input');
  queryInput.type = 'text';
  queryInput.className = 'storyboard-act-board-audio-query';
  queryInput.value = node.query || '';
  queryInput.placeholder = 'Sound effects or music query';
  queryInput.setAttribute('aria-label', 'Sound effects or music search query');
  queryInput.addEventListener('click', event => event.stopPropagation());
  queryInput.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      findButton.click();
    }
  });
  queryInput.addEventListener('input', () => {
    node.query = queryInput.value.trim();
    saveDebugSession();
  });
  queryRow.appendChild(queryInput);
  const kindSelect = document.createElement('select');
  kindSelect.className = 'storyboard-act-board-audio-kind';
  [['sound-effects', 'SFX'], ['music', 'Music']].forEach(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    kindSelect.appendChild(option);
  });
  kindSelect.value = node.audioKind === 'music' ? 'music' : 'sound-effects';
  kindSelect.title = 'Choose whether this audio node is sound effects or music';
  kindSelect.addEventListener('change', event => {
    event.stopPropagation();
    node.audioKind = kindSelect.value;
    saveDebugSession();
    rerenderActBoard();
  });
  queryRow.appendChild(kindSelect);
  const findButton = document.createElement('button');
  findButton.type = 'button';
  findButton.className = 'btn-secondary storyboard-act-board-node-action';
  findButton.textContent = node.status === 'generating' ? 'Finding sound…' : 'Find sound';
  findButton.disabled = node.status === 'generating';
  findButton.addEventListener('click', event => {
    event.stopPropagation();
    node.query = queryInput.value.trim();
    findActBoardAudioNode(actKey, node);
  });
  queryRow.appendChild(findButton);
  card.appendChild(queryRow);

  const uploadRow = document.createElement('div');
  uploadRow.className = 'storyboard-act-board-audio-upload-row';
  const uploadButton = document.createElement('button');
  uploadButton.type = 'button';
  uploadButton.className = 'btn-secondary storyboard-act-board-node-action';
  uploadButton.textContent = 'Upload sound';
  const uploadInput = document.createElement('input');
  uploadInput.type = 'file';
  uploadInput.accept = 'audio/*,.wav,.mp3,.m4a,.mp4,.webm,.ogg,.aac,.flac';
  uploadInput.hidden = true;
  uploadInput.addEventListener('click', event => event.stopPropagation());
  uploadButton.addEventListener('click', event => {
    event.stopPropagation();
    uploadInput.value = '';
    uploadInput.click();
  });
  uploadInput.addEventListener('change', async () => {
    const file = uploadInput.files?.[0];
    if (!file) return;
    node.audioSearchActive = false;
    node.status = 'uploading';
    node.error = '';
    saveDebugSession();
    rerenderActBoard();
    try {
      const uploaded = await fetchUploadMediaBankItem(file, premiereProjectId);
      premiereProjectId = uploaded.project_id;
      const duration = Number(uploaded.duration_seconds) || 0;
      node.selectedAudio = {
        name: file.name,
        source: 'user-upload',
        preview_url: uploaded.preview_url,
        localPreviewUrl: uploaded.preview_url,
        localFilePath: uploaded.file_path || null,
        sourceDurationSeconds: duration,
        trimStartSeconds: 0,
        durationSeconds: duration || Number(node.durationSeconds) || 1,
      };
      node.audioName = file.name;
      node.audioPreviewUrl = uploaded.preview_url;
      node.sourceDurationSeconds = duration;
      if (node.linkedToNodeId) {
        const target = actBoardNodesForAct(actKey).find(item => item.id === node.linkedToNodeId);
        if (target) linkActBoardAudioNode(actKey, node, target);
      }
      node.status = 'ready';
    } catch (err) {
      node.status = 'error';
      node.error = `Could not upload sound: ${err.message}`;
    }
    saveDebugSession();
    rerenderActBoard();
  });
  uploadRow.append(uploadButton, uploadInput);
  card.appendChild(uploadRow);

  const selected = actBoardAudioSource(node);
  if (selected.url) {
    const selectedLabel = document.createElement('div');
    selectedLabel.className = 'storyboard-act-board-audio-selected-label';
    selectedLabel.textContent = `Selected: ${selected.name}`;
    card.appendChild(selectedLabel);
    const player = document.createElement('audio');
    player.controls = true;
    player.preload = 'metadata';
    player.src = selected.url;
    player.volume = actBoardNodeVolume(node);
    player.className = 'storyboard-act-board-audio-player';
    wireActBoardAudioExclusivity(player);
    player.addEventListener('click', event => event.stopPropagation());
    player.addEventListener('loadedmetadata', () => {
      if (!(Number(player.duration) > 0)) return;
      selected.sourceDurationSeconds = player.duration;
      node.sourceDurationSeconds = player.duration;
      if (!(Number(node.durationSeconds) > 0) || !node.linkedToNodeId) node.durationSeconds = player.duration;
      refreshActBoardAudioTimingForNode(node);
      saveDebugSession();
    });
    card.appendChild(player);
    const volumeRow = document.createElement('label');
    volumeRow.className = 'storyboard-act-board-audio-volume-row';
    volumeRow.textContent = 'Volume';
    const volumeInput = document.createElement('input');
    volumeInput.type = 'range';
    volumeInput.min = '0';
    volumeInput.max = '1';
    volumeInput.step = '0.01';
    volumeInput.value = String(actBoardNodeVolume(node));
    volumeInput.addEventListener('pointerdown', event => event.stopPropagation());
    volumeInput.addEventListener('input', () => {
      node.volume = Number(volumeInput.value);
      player.volume = node.volume;
      refreshActBoardPlaybackVolumes();
      saveDebugSession();
    });
    volumeRow.appendChild(volumeInput);
    card.appendChild(volumeRow);
  }

  const audioSourceDuration = Math.max(0, Number(
    node.sourceDurationSeconds || node.selectedAudio?.sourceDurationSeconds
      || node.selectedAudio?.duration || 0,
  ));
  if (selected.url && audioSourceDuration > 0) {
    const editor = document.createElement('div');
    editor.className = 'storyboard-act-board-footage-source-editor storyboard-act-board-audio-source-editor';
    editor.dataset.audioNodeId = node.id;
    const readout = document.createElement('div');
    readout.className = 'sfx-segment-readout';
    const strip = document.createElement('div');
    strip.className = 'sfx-source-strip storyboard-act-board-footage-source-strip storyboard-act-board-audio-source-strip';
    strip.title = 'Drag the window or either edge to choose the sound source segment';
    const selection = document.createElement('div');
    selection.className = 'sfx-source-selection';
    const selectionLabel = document.createElement('span');
    selectionLabel.className = 'sfx-source-selection-label';
    const startHandle = document.createElement('span');
    startHandle.className = 'sfx-source-handle start';
    startHandle.title = 'Drag sound source in-point';
    const endHandle = document.createElement('span');
    endHandle.className = 'sfx-source-handle end';
    endHandle.title = 'Drag sound source out-point';
    selection.append(selectionLabel, startHandle, endHandle);
    strip.appendChild(selection);
    editor.append(readout, strip);
    card.appendChild(editor);
    const redraw = () => {
      const start = Math.max(0, Math.min(audioSourceDuration - 0.1,
        Number(node.trimStartSeconds ?? node.selectedAudio?.trimStartSeconds) || 0));
      const length = Math.max(0.1, Math.min(audioSourceDuration - start,
        Number(node.durationSeconds) || 1));
      selection.style.left = `${(start / audioSourceDuration) * 100}%`;
      selection.style.width = `${(length / audioSourceDuration) * 100}%`;
      selectionLabel.textContent = `${length.toFixed(1)}s`;
      readout.textContent = `Using ${start.toFixed(1)}s–${(start + length).toFixed(1)}s · ${length.toFixed(1)}s`;
    };
    editor._actBoardRefresh = redraw;
    const wire = (target, mode) => target.addEventListener('pointerdown', event => {
      event.preventDefault();
      event.stopPropagation();
      const width = strip.getBoundingClientRect().width || 1;
      const originX = event.clientX;
      const initialStart = Math.max(0, Number(node.trimStartSeconds
        ?? node.selectedAudio?.trimStartSeconds) || 0);
      const initialLength = Math.max(0.1, Math.min(audioSourceDuration - initialStart,
        Number(node.durationSeconds) || 1));
      const initialEnd = initialStart + initialLength;
      try { target.setPointerCapture(event.pointerId); } catch (err) { /* optional */ }
      const move = moveEvent => {
        const delta = ((moveEvent.clientX - originX) / width) * audioSourceDuration;
        if (mode === 'start') {
          node.trimStartSeconds = Math.max(0, Math.min(initialStart + delta, initialEnd - 0.1));
          node.durationSeconds = initialEnd - node.trimStartSeconds;
        } else if (mode === 'end') {
          node.durationSeconds = Math.max(0.1, Math.min(initialLength + delta,
            audioSourceDuration - initialStart));
        } else {
          node.trimStartSeconds = Math.max(0, Math.min(initialStart + delta,
            audioSourceDuration - initialLength));
        }
        node.trimStartSeconds = Number(node.trimStartSeconds.toFixed(2));
        node.durationSeconds = Number(node.durationSeconds.toFixed(2));
        if (node.selectedAudio) {
          node.selectedAudio.trimStartSeconds = node.trimStartSeconds;
          node.selectedAudio.durationSeconds = node.durationSeconds;
        }
        node.timingWasManuallyAdjusted = true;
        refreshActBoardAudioTimingForNode(node);
        redraw();
      };
      const up = () => {
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', up);
        target.removeEventListener('pointercancel', up);
        try { target.releasePointerCapture(event.pointerId); } catch (err) { /* optional */ }
        refreshActBoardAudioTimingForNode(node);
        saveDebugSession();
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', up, { once: true });
      target.addEventListener('pointercancel', up, { once: true });
    });
    wire(startHandle, 'start');
    wire(endHandle, 'end');
    wire(selection, 'window');
    redraw();
  }

  const results = buildActBoardAudioResults(actKey, node);
  if (results.childElementCount
    && (!actBoardAudioSource(node).url || node.audioSearchActive)) card.appendChild(results);
  if (node.error) {
    const error = document.createElement('div');
    error.className = 'storyboard-act-board-node-error';
    error.textContent = node.error;
    card.appendChild(error);
  }
}

function buildActBoardNarrationTimingControls(actKey, node, card, mount = card) {
  const controls = document.createElement('div');
  controls.className = 'storyboard-act-board-footage-timing-controls storyboard-act-board-narration-timing';
  controls.dataset.narrationNodeId = node.id;
  const sourceDuration = Math.max(0, Number(
    node.sourceDurationSeconds || node.audioDurationSeconds || 0,
  ));
  const makeInput = (labelText, value, role, min = 0, max = 3600) => {
    const label = document.createElement('label');
    label.textContent = labelText;
    label.title = role === 'start'
      ? 'Timeline start: when this narration begins in the scene'
      : role === 'source-in'
        ? 'Source in: where playback begins inside the narration file'
        : 'Length: how long this narration segment plays';
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.1';
    input.min = String(min);
    input.max = String(max);
    input.value = Number(value || 0).toFixed(1);
    input.dataset.narrationTimingRole = role;
    input.addEventListener('pointerdown', event => event.stopPropagation());
    input.addEventListener('click', event => event.stopPropagation());
    label.appendChild(input);
    return { label, input };
  };
  const maxSourceIn = sourceDuration > 0 ? Math.max(0, sourceDuration - 0.1) : 3600;
  const sourceIn = Math.max(0, Number(node.trimStartSeconds) || 0);
  const maxLength = sourceDuration > 0 ? Math.max(0.1, sourceDuration - sourceIn) : 3600;
  const startControl = makeInput('Start', node.startSeconds, 'start');
  const sourceInControl = makeInput('Source in', sourceIn, 'source-in', 0, maxSourceIn);
  const lengthControl = makeInput('Length', actBoardNarrationSegmentDuration(node)
    || estimateActBoardNarrationSeconds(node.text), 'length', 0.5, maxLength);
  const timing = card.querySelector('.storyboard-act-board-node-timing');
  const update = () => {
    node.startSeconds = Number(Math.max(0, Number(startControl.input.value) || 0).toFixed(2));
    node.trimStartSeconds = Number(Math.min(maxSourceIn,
      Math.max(0, Number(sourceInControl.input.value) || 0)).toFixed(2));
    const available = sourceDuration > 0
      ? Math.max(0.1, sourceDuration - node.trimStartSeconds) : 3600;
    node.narrationSegmentDurationSeconds = Number(Math.max(0.5, Math.min(available,
      Number(lengthControl.input.value) || 0.5)).toFixed(2));
    if (!(node.footageNodeIds || []).length) node.durationSeconds = node.narrationSegmentDurationSeconds;
    sourceInControl.input.value = node.trimStartSeconds.toFixed(1);
    lengthControl.input.max = String(available);
    lengthControl.input.value = node.narrationSegmentDurationSeconds.toFixed(1);
    node.timingWasManuallyAdjusted = true;
    if (timing) setActBoardNodeTimingText(timing, actBoardPlaybackTimingLabel(
      node.startSeconds, node.narrationSegmentDurationSeconds,
    ));
    refreshActBoardNarrationTimingForNode(node);
    saveDebugSession();
  };
  startControl.input.addEventListener('input', update);
  sourceInControl.input.addEventListener('input', update);
  lengthControl.input.addEventListener('input', update);
  controls.append(startControl.label, sourceInControl.label, lengthControl.label);
  const hint = document.createElement('small');
  hint.className = 'storyboard-act-board-footage-timing-hint';
  // hint.textContent = 'Start = timeline position · Source in = offset inside the narration file · Length = selected narration duration';
  controls.appendChild(hint);
  mount.appendChild(controls);

  if (sourceDuration > 0 && (node.audioPreviewUrl || node._nativePreviewUrl)) {
    const editor = document.createElement('div');
    editor.className = 'storyboard-act-board-footage-source-editor storyboard-act-board-narration-source-editor';
    editor.dataset.narrationNodeId = node.id;
    const readout = document.createElement('div');
    readout.className = 'sfx-segment-readout';
    const strip = document.createElement('div');
    strip.className = 'sfx-source-strip storyboard-act-board-footage-source-strip storyboard-act-board-narration-source-strip';
    strip.title = 'Drag the window or either edge to choose the narration source segment';
    const selection = document.createElement('div');
    selection.className = 'sfx-source-selection';
    const selectionLabel = document.createElement('span');
    selectionLabel.className = 'sfx-source-selection-label';
    const startHandle = document.createElement('span');
    startHandle.className = 'sfx-source-handle start';
    startHandle.title = 'Drag narration source in-point';
    const endHandle = document.createElement('span');
    endHandle.className = 'sfx-source-handle end';
    endHandle.title = 'Drag narration source out-point';
    selection.append(selectionLabel, startHandle, endHandle);
    strip.appendChild(selection);
    editor.append(readout, strip);
    mount.appendChild(editor);
    const redraw = () => {
      const start = Math.max(0, Math.min(sourceDuration - 0.1, Number(node.trimStartSeconds) || 0));
      const length = Math.max(0.5, Math.min(sourceDuration - start,
        actBoardNarrationSegmentDuration(node) || 1));
      selection.style.left = `${(start / sourceDuration) * 100}%`;
      selection.style.width = `${(length / sourceDuration) * 100}%`;
      selectionLabel.textContent = `${length.toFixed(1)}s`;
      readout.textContent = `Using ${start.toFixed(1)}s–${(start + length).toFixed(1)}s · ${length.toFixed(1)}s`;
    };
    editor._actBoardRefresh = redraw;
    const wire = (target, mode) => target.addEventListener('pointerdown', event => {
      event.preventDefault();
      event.stopPropagation();
      const width = strip.getBoundingClientRect().width || 1;
      const originX = event.clientX;
      const initialStart = Math.max(0, Number(node.trimStartSeconds) || 0);
      const initialLength = Math.max(0.5, Math.min(sourceDuration - initialStart,
        actBoardNarrationSegmentDuration(node) || 1));
      const initialEnd = initialStart + initialLength;
      try { target.setPointerCapture(event.pointerId); } catch (err) { /* optional */ }
      const move = moveEvent => {
        const delta = ((moveEvent.clientX - originX) / width) * sourceDuration;
        if (mode === 'start') {
          node.trimStartSeconds = Math.max(0, Math.min(initialStart + delta, initialEnd - 0.5));
          node.narrationSegmentDurationSeconds = initialEnd - node.trimStartSeconds;
        } else if (mode === 'end') {
          node.narrationSegmentDurationSeconds = Math.max(0.5,
            Math.min(initialLength + delta, sourceDuration - initialStart));
        } else {
          node.trimStartSeconds = Math.max(0, Math.min(initialStart + delta, sourceDuration - initialLength));
        }
        node.trimStartSeconds = Number(node.trimStartSeconds.toFixed(2));
        node.narrationSegmentDurationSeconds = Number(node.narrationSegmentDurationSeconds
          ? node.narrationSegmentDurationSeconds.toFixed(2) : actBoardNarrationSegmentDuration(node).toFixed(2));
        if (!(node.footageNodeIds || []).length) node.durationSeconds = node.narrationSegmentDurationSeconds;
        node.timingWasManuallyAdjusted = true;
        refreshActBoardNarrationTimingForNode(node);
        redraw();
      };
      const up = () => {
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', up);
        target.removeEventListener('pointercancel', up);
        try { target.releasePointerCapture(event.pointerId); } catch (err) { /* optional */ }
        refreshActBoardNarrationTimingForNode(node);
        saveDebugSession();
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', up, { once: true });
      target.addEventListener('pointercancel', up, { once: true });
    });
    wire(startHandle, 'start');
    wire(endHandle, 'end');
    wire(selection, 'window');
    redraw();
  }
}

function buildActBoardNode(actKey, act, node, boardLayer, nodeIndex = 0) {
  const card = document.createElement('article');
  const filmabilityClass = node.type === 'footage' && node.filmabilityBucket
    ? ` storyboard-act-board-node-filmability-${node.filmabilityBucket}` : '';
  card.className = `storyboard-act-board-node storyboard-act-board-node-${node.type}${filmabilityClass}`;
  if (node.type === 'footage' && node.boardHeightMode === 'manual') {
    card.classList.add('storyboard-act-board-node-height-manual');
  }
  card.dataset.nodeId = node.id;
  wireActBoardNodeDragging(card, node, boardLayer, nodeIndex);
  card.style.width = `${actBoardAutoWidth(node, boardLayer)}px`;
  if (Number.isFinite(Number(node.boardZIndex))) {
    card.style.zIndex = String(node.boardZIndex);
  }
  wireActBoardNodeLinking(card, actKey, node, boardLayer);

  // Any node that receives focus becomes the active top layer. Use capture on
  // pointerdown so clicks on embedded controls (which intentionally stop
  // bubbling) also bring their node forward before the control handles them.
  card.addEventListener('pointerdown', () => bringActBoardNodeToFront(boardLayer, card, node), true);

  const top = document.createElement('div');
  top.className = 'storyboard-act-board-node-top';
  const type = document.createElement('span');
  type.className = 'storyboard-act-board-node-type';
  type.textContent = node.type === 'narration' ? 'Narration'
    : node.type === 'playback' ? 'Playback'
      : node.type === 'audio' ? (node.audioKind === 'music' ? 'Music' : 'Sound effects')
        : 'Footage';
  const topActions = document.createElement('span');
  topActions.className = 'storyboard-act-board-node-header-actions';
  const footageScene = node.type === 'footage' ? actBoardSceneForNode(actKey, node) : null;
  let footageStartButton = null;

  if (footageScene) {
    const startButton = document.createElement('button');
    footageStartButton = startButton;
    startButton.type = 'button';
    startButton.className = 'btn-secondary storyboard-act-board-node-action storyboard-act-board-footage-start-btn';
    const isStart = footageScene.sequenceStartNodeId === node.id;
    startButton.textContent = isStart ? 'Start' : 'Set as start';
    startButton.classList.toggle('selected', isStart);
    startButton.title = isStart
      ? 'This footage starts the scene playback sequence'
      : 'Make this the first footage clip in the scene playback sequence. Existing board links will be cleared.';
    startButton.addEventListener('click', event => {
      event.stopPropagation();
      if (!isStart) {
        clearActBoardLinks(actKey, act?.label || 'this act', {
          confirm: false,
          rerender: false,
        });
        // A newly selected start node begins a fresh footage sequence. Reset
        // its stale timestamp from the previous chain so the next relink
        // starts at the beginning of the playback rail.
        node.startSeconds = 0;
        node.sequenceIndex = 0;
        node.timingWasManuallyAdjusted = false;
      }
      footageScene.sequenceStartNodeId = isStart ? null : node.id;
      saveDebugSession();
      rerenderActBoard();
    });
  }

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'storyboard-act-board-node-remove';
  remove.textContent = '×';
  remove.title = 'Remove this board node';
  remove.addEventListener('click', event => {
    event.stopPropagation();
    const removeIds = new Set([node.id, ...(node.footageNodeIds || [])]);
    actBoardNodes[actKey] = actBoardNodesForAct(actKey)
      .filter(item => !removeIds.has(item.id));
    if (Array.isArray(actBoardScenes[actKey])) {
      actBoardScenes[actKey] = actBoardScenes[actKey]
        .map(scene => ({
          ...scene,
          nodeIds: (scene.nodeIds || []).filter(id => !removeIds.has(id)),
          nodeSnapshots: (scene.nodeSnapshots || []).filter(snapshot => !removeIds.has(snapshot.id)),
        }));
    }
    saveDebugSession();
    rerenderActBoard();
  });
  if (node.type !== 'narration') topActions.appendChild(remove);
  top.append(type, topActions);
  const nodeStickyBanner = ['narration', 'footage', 'audio'].includes(node.type)
    ? document.createElement('div') : null;
  if (nodeStickyBanner) {
    nodeStickyBanner.className = `storyboard-act-board-node-sticky-banner storyboard-act-board-${node.type}-sticky-banner`;
    card.appendChild(nodeStickyBanner);
    nodeStickyBanner.appendChild(top);
    if (footageStartButton) {
      const startRow = document.createElement('div');
      startRow.className = 'storyboard-act-board-footage-start-row';
      startRow.appendChild(footageStartButton);
      nodeStickyBanner.appendChild(startRow);
    }
  } else {
    card.appendChild(top);
  }

  if (node.type === 'playback') {
    const narrationNode = actBoardNodesForAct(actKey)
      .find(item => item.type === 'narration' && item.id === node.narrationNodeId);
    card.appendChild(buildActBoardNarrationPlayback(actKey, narrationNode, boardLayer, node));
  } else if (node.type === 'narration') {
    const narrationTimingBanner = document.createElement('div');
    narrationTimingBanner.className = 'storyboard-act-board-node-timing';
    const narrationTimingText = document.createElement('span');
    narrationTimingText.className = 'storyboard-act-board-node-timing-text';
    narrationTimingText.textContent = actBoardPlaybackTimingLabel(
      node.startSeconds,
      actBoardNarrationSegmentDuration(node) || estimateActBoardNarrationSeconds(node.text) || 1,
    );
    narrationTimingBanner.append(narrationTimingText, remove);
    nodeStickyBanner.prepend(narrationTimingBanner);
    const suggestedView = document.createElement('div');
    suggestedView.className = 'storyboard-act-board-node-view storyboard-act-board-node-view-suggested';
    if (node.transcript) suggestedView.classList.add('has-recorded-narration');
    card.appendChild(suggestedView);
    requestActBoardNarrationAnalysis(node);
    const narrationSource = actBoardNarrationSourceText(node);
    const analysisPending = node.narrationSpanStatus === 'extracting'
      || node.narrationSpanStatus === 'classifying';
    const smartSpans = Array.isArray(node.narrationSpans) && node.narrationSpans.length
      ? node.narrationSpans
      : [];
    const fragments = analysisPending
      ? []
      : (smartSpans.length
        ? smartSpans
        : (node.narrationSpanStatus === 'ready' || node.narrationSpanStatus === 'error'
          ? []
          : (Array.isArray(node.footageFragments) && node.footageFragments.length
            ? node.footageFragments
            : actBoardNarrationFragments(narrationSource))));
    const suggestedReferenceFragments = node.transcript
      ? []
      : fragments;
    const onFilmableSpanSelect = (metadata, renderedText) =>
      handleActBoardNarrationSpanSelect(node, metadata, renderedText);
    const recordControls = document.createElement('div');
    recordControls.className = 'storyboard-act-board-node-record-controls';
    const recordActionRow = document.createElement('div');
    recordActionRow.className = 'storyboard-act-board-node-action-row';
    const recordButton = document.createElement('button');
    recordButton.type = 'button';
    recordButton.className = 'btn-secondary storyboard-act-board-node-action storyboard-act-board-record-narration-btn';
    const uploadNarrationButton = document.createElement('button');
    uploadNarrationButton.type = 'button';
    uploadNarrationButton.className = 'btn-secondary storyboard-act-board-node-action storyboard-act-board-upload-narration-btn';
    uploadNarrationButton.textContent = 'Upload narration';
    uploadNarrationButton.title = 'Upload an audio file to transcribe as narration';
    const uploadNarrationInput = document.createElement('input');
    uploadNarrationInput.type = 'file';
    uploadNarrationInput.accept = 'audio/*,.wav,.mp3,.m4a,.mp4,.webm,.ogg,.aac,.flac';
    uploadNarrationInput.hidden = true;
    uploadNarrationInput.className = 'storyboard-act-board-upload-narration-input';
    uploadNarrationInput.addEventListener('click', event => event.stopPropagation());
    uploadNarrationButton.addEventListener('click', event => {
      event.stopPropagation();
      uploadNarrationInput.value = '';
      uploadNarrationInput.click();
    });
    const resuggestButton = document.createElement('button');
    resuggestButton.type = 'button';
    resuggestButton.className = 'btn-secondary storyboard-act-board-node-action storyboard-act-board-resuggest-narration-btn';
    resuggestButton.textContent = 'Suggest narration';
    resuggestButton.disabled = node.status === 'generating'
      || !(node.transcript || node.text || fragments.length
        || actBoardNarrationNotesForNode(actKey, act, node).trim());
    resuggestButton.addEventListener('click', event => {
      event.stopPropagation();
      resuggestActBoardNarration(actKey, act, node, resuggestButton);
    });
    const suggestFootageBtn = document.createElement('button');
    suggestFootageBtn.type = 'button';
    suggestFootageBtn.className = 'btn-secondary storyboard-act-board-node-action';
    suggestFootageBtn.textContent = 'Suggest footage';
    suggestFootageBtn.disabled = node.status !== 'ready'
      || !(fragments.length || narrationSource.trim() || node.selectedFootagePhrases?.length);
    suggestFootageBtn.addEventListener('click', event => {
      event.stopPropagation();
      suggestActBoardFootage(actKey, act, node, node.transcript || node.text);
    });
    const narrationPlaybackLabel = document.createElement('label');
    narrationPlaybackLabel.className = 'storyboard-act-board-narration-playback-toggle';
    narrationPlaybackLabel.title = 'Include this narration node in linked playback and MP4 export';
    const narrationPlaybackInput = document.createElement('input');
    narrationPlaybackInput.type = 'checkbox';
    narrationPlaybackInput.checked = node.includeNarration !== false;
    narrationPlaybackInput.addEventListener('click', event => event.stopPropagation());
    narrationPlaybackInput.addEventListener('change', event => {
      event.stopPropagation();
      node.includeNarration = narrationPlaybackInput.checked;
      saveDebugSession();
      rerenderActBoard();
    });
    narrationPlaybackLabel.append(narrationPlaybackInput,
      document.createTextNode(' Include narration'));
    recordActionRow.append(
      recordButton, uploadNarrationButton, narrationPlaybackLabel, suggestFootageBtn,
    );
    const idleRecordLabel = () => node.audioPreviewUrl ? 'Record again' : 'Record narration';
    const setRecordButtonStatus = (message = '', isError = false) => {
      const status = String(message || '').trim();
      const label = node.recordingStatus === 'recording'
        ? (status ? 'Recording… (Stop)' : 'Stop recording')
        : status || (node.recordingStatus === 'processing'
          ? 'Processing narration…'
          : node.recordingStatus === 'error' ? 'Recording failed' : idleRecordLabel());
      recordButton.textContent = label;
      recordButton.title = status || label;
      recordButton.setAttribute('aria-label', label);
      recordButton.classList.toggle('storyboard-act-board-record-narration-btn-error', Boolean(isError));
    };
    const recordStatusController = { _setStatus: setRecordButtonStatus };
    setRecordButtonStatus(
      node.recordingStatus === 'recording' ? 'Recording…'
        : node.recordingStatus === 'processing' ? 'Processing narration…'
          : node.recordingStatus === 'error' ? (node.recordingError || 'Recording failed') : '',
      node.recordingStatus === 'error',
    );
    recordControls.append(recordActionRow, uploadNarrationInput);
    nodeStickyBanner.appendChild(recordControls);
    const sourceNotesPanel = document.createElement('details');
    sourceNotesPanel.className = 'storyboard-act-board-narration-source-notes';
    sourceNotesPanel.open = false;
    sourceNotesPanel.addEventListener('click', event => event.stopPropagation());
    const sourceNotesSummary = document.createElement('summary');
    sourceNotesSummary.textContent = 'Source material / scene notes';
    sourceNotesPanel.appendChild(sourceNotesSummary);
    const sourceNotesHint = document.createElement('small');
    sourceNotesHint.className = 'storyboard-act-board-narration-source-notes-hint';
    sourceNotesHint.textContent = 'Edit this context before suggesting narration again.';
    sourceNotesPanel.appendChild(sourceNotesHint);
    const sourceNotesInput = document.createElement('textarea');
    sourceNotesInput.className = 'storyboard-act-board-narration-source-notes-input';
    sourceNotesInput.rows = 5;
    sourceNotesInput.placeholder = 'Add or edit the source material for this narration node…';
    sourceNotesInput.value = actBoardNarrationNotesForNode(actKey, act, node);
    sourceNotesInput.setAttribute('aria-label', 'Editable source material and scene notes');
    let sourceNotesSaveTimer = null;
    sourceNotesInput.addEventListener('input', () => {
      // Keep the edit live in the node so Suggest narration can immediately
      // use it without requiring a rerender or a separate Apply button.
      node.sceneNotes = sourceNotesInput.value;
      clearTimeout(sourceNotesSaveTimer);
      sourceNotesSaveTimer = setTimeout(() => saveDebugSession(), 250);
    });
    sourceNotesInput.addEventListener('change', () => {
      node.sceneNotes = sourceNotesInput.value;
      saveDebugSession();
    });
    sourceNotesInput.addEventListener('pointerdown', event => event.stopPropagation());
    sourceNotesPanel.appendChild(sourceNotesInput);
    if (node.footageStatus) {
      const footageStatus = document.createElement('div');
      footageStatus.className = 'storyboard-act-board-node-footage-status';
      footageStatus.textContent = node.footageStatus;
      suggestedView.appendChild(footageStatus);
    }
    uploadNarrationInput.addEventListener('change', () => {
      const file = uploadNarrationInput.files?.[0];
      if (!file) return;
      const looksLikeAudio = (file.type && file.type.startsWith('audio/'))
        || /\.(wav|mp3|m4a|mp4|webm|ogg|aac|flac)$/i.test(file.name || '');
      if (!looksLikeAudio) {
        setActBoardNarrationRecordStatus(recordStatusController,
          'Choose an audio narration file.', true);
        return;
      }
      stopActBoardNativeAudio();
      node.recordingStatus = 'processing';
      uploadNarrationButton.disabled = true;
      recordButton.disabled = true;
      setActBoardNarrationRecordStatus(recordStatusController, 'Preparing uploaded narration…');
      saveDebugSession();
      recordActBoardNarration(node, file, file.name, recordStatusController)
        .finally(() => {
          uploadNarrationButton.disabled = false;
          recordButton.disabled = false;
        });
    });
    // if (smartSpans.length) {
    //   const spanLegend = document.createElement('small');
    //   spanLegend.className = 'storyboard-act-board-narration-span-legend';
    //   spanLegend.textContent = 'Solid underline: find footage · dashed underline: visual proxy';
    //   suggestedView.appendChild(spanLegend);
    // }
    const recordedNarrationGrid = node.transcript ? document.createElement('div') : null;
    if (recordedNarrationGrid) {
      recordedNarrationGrid.className = 'storyboard-act-board-recorded-grid';
      suggestedView.appendChild(recordedNarrationGrid);
    }
    let recordingAudio = null;
    let recordingTimings = null;
    let recordingAlignment = null;
    if (node.transcript) {
      const primaryNarration = buildActBoardSuggestedNarrationText(
        node.transcript, fragments,
        null,
        'Recorded narration: ', onFilmableSpanSelect, !analysisPending && smartSpans.length > 0);
      primaryNarration.classList.add('storyboard-act-board-narration-primary');
      applyActBoardNarrationPhraseSelection(primaryNarration, node);
      recordedNarrationGrid.appendChild(primaryNarration);
    } else if (node.text) {
      const primaryNarration = buildActBoardSuggestedNarrationText(
        node.text, fragments,
        null,
        'Suggested narration: ', onFilmableSpanSelect, !analysisPending && smartSpans.length > 0);
      primaryNarration.classList.add('storyboard-act-board-narration-primary');
      applyActBoardNarrationPhraseSelection(primaryNarration, node);
      suggestedView.appendChild(primaryNarration);
      suggestedView.append(sourceNotesPanel, resuggestButton);
    } else {
      const text = document.createElement('p');
      text.className = 'storyboard-act-board-node-text';
      const label = document.createElement('strong');
      label.textContent = 'Suggested narration: ';
      text.appendChild(label);
      text.appendChild(document.createTextNode(node.status === 'generating'
        ? 'Drafting suggested narration…' : 'No narration draft yet.'));
      suggestedView.appendChild(text);
      suggestedView.append(sourceNotesPanel, resuggestButton);
    }
    if (node.error) {
      const error = document.createElement('div');
      error.className = 'storyboard-act-board-node-error';
      error.textContent = node.error;
      suggestedView.appendChild(error);
    }
    if (node.audioPreviewUrl) {
      const audio = document.createElement('audio');
      audio.className = 'storyboard-act-board-node-audio';
      audio.controls = true;
      audio.preload = 'metadata';
      wireActBoardAudioExclusivity(audio);
      attachNativeAudioSource(audio, node._nativePreviewUrl || node.audioPreviewUrl, node);
      audio.addEventListener('click', event => event.stopPropagation());
      audio.addEventListener('loadedmetadata', () => {
        if (!(Number(audio.duration) > 0)
          || Math.abs(Number(node.audioDurationSeconds || 0) - audio.duration) < 0.05) return;
        node.audioDurationSeconds = audio.duration;
        alignActBoardNarrationFragments(node);
        saveDebugSession();
      });
      recordingAudio = audio;
    }

    if (node.transcript) {
      if (node.alignmentSource) {
        const alignment = document.createElement('div');
        alignment.className = 'storyboard-act-board-node-alignment-source';
        alignment.textContent = `Footage timing: ${node.alignmentSource}`;
        recordingAlignment = alignment;
      }
      if (Array.isArray(node.fragmentTimings) && node.fragmentTimings.length) {
        const timings = document.createElement('div');
        timings.className = 'storyboard-act-board-node-fragment-timings';
        node.fragmentTimings.forEach(timing => {
          const row = document.createElement('div');
          row.className = 'storyboard-act-board-node-fragment-timing';
          const phrase = document.createElement('span');
          phrase.textContent = timing.fragment;
          const range = document.createElement('span');
          range.textContent = `${Number(timing.startSeconds || 0).toFixed(1)}–${Number(timing.endSeconds || 0).toFixed(1)}s`;
          row.appendChild(phrase);
          row.appendChild(range);
          timings.appendChild(row);
        });
        recordingTimings = timings;
      }
      if (node.text) {
        const suggestedAside = document.createElement('details');
        suggestedAside.className = 'storyboard-act-board-suggested-side-panel';
        suggestedAside.open = false;
        const asideSummary = document.createElement('summary');
        asideSummary.textContent = 'Suggested narration';
        asideSummary.addEventListener('click', event => event.stopPropagation());
        suggestedAside.addEventListener('click', event => event.stopPropagation());
        suggestedAside.addEventListener('toggle', () => {
          const stack = card.closest('.storyboard-act-board-node-stack');
          if (!stack) return;
          refineActBoardRenderedGeometry(stack, actBoardNodesForAct(actKey));
          refreshActBoardLinkPaths(stack);
        });
        suggestedAside.appendChild(asideSummary);
        suggestedAside.appendChild(buildActBoardSuggestedNarrationText(
          node.text, suggestedReferenceFragments,
          null,
          'Suggested narration: ', null, false));
        suggestedAside.append(sourceNotesPanel, resuggestButton);
        recordedNarrationGrid.appendChild(suggestedAside);
      } else {
        recordedNarrationGrid.append(sourceNotesPanel, resuggestButton);
      }
    }
    if (recordingAudio) {
      // Keep the recorded audio and its timing/source-window controls outside
      // the two-column narration/reference grid so they span the full node.
      suggestedView.appendChild(recordingAudio);
      recordingAudio.volume = actBoardNodeVolume(node, 1);
      const narrationVolumeRow = document.createElement('label');
      narrationVolumeRow.className = 'storyboard-act-board-narration-volume-row storyboard-act-board-audio-volume-row';
      narrationVolumeRow.textContent = 'Volume';
      const narrationVolumeInput = document.createElement('input');
      narrationVolumeInput.type = 'range';
      narrationVolumeInput.min = '0';
      narrationVolumeInput.max = '1';
      narrationVolumeInput.step = '0.01';
      narrationVolumeInput.value = String(actBoardNodeVolume(node, 1));
      narrationVolumeInput.setAttribute('aria-label', 'Narration volume');
      narrationVolumeInput.addEventListener('pointerdown', event => event.stopPropagation());
      narrationVolumeInput.addEventListener('input', event => {
        event.stopPropagation();
        node.volume = Number(narrationVolumeInput.value);
        recordingAudio.volume = actBoardNodeVolume(node, 1);
        refreshActBoardPlaybackVolumes();
        saveDebugSession();
      });
      narrationVolumeRow.appendChild(narrationVolumeInput);
      suggestedView.appendChild(narrationVolumeRow);
    }
    const narrationTimingMount = recordingAudio?.parentElement || card;
    buildActBoardNarrationTimingControls(actKey, node, card, narrationTimingMount);
    if (recordingAlignment) suggestedView.appendChild(recordingAlignment);

    let recorder = null;
    let recorderStream = null;
    recordButton.addEventListener('click', async event => {
      event.stopPropagation();
      if (recorder && recorder.state === 'recording') {
        recorder.stop();
        return;
      }
      stopActBoardNativeAudio();
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
        setActBoardNarrationRecordStatus(recordStatusController,
          'This browser does not support microphone recording.', true);
        return;
      }
      try {
        try {
          recorderStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              channelCount: { ideal: 1 },
              echoCancellation: { ideal: true },
              noiseSuppression: { ideal: true },
              autoGainControl: { ideal: true },
            },
          });
        } catch (constraintError) {
          // Older browsers may reject one of the optional audio constraints;
          // retain recording support with the browser's default mic profile.
          recorderStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
        const preferredMime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
          .find(type => typeof MediaRecorder.isTypeSupported !== 'function'
            || MediaRecorder.isTypeSupported(type)) || '';
        recorder = preferredMime ? new MediaRecorder(recorderStream, { mimeType: preferredMime })
          : new MediaRecorder(recorderStream);
        const chunks = [];
        recorder.addEventListener('dataavailable', recordingEvent => {
          if (recordingEvent.data && recordingEvent.data.size) chunks.push(recordingEvent.data);
        });
        recorder.addEventListener('stop', () => {
          recorderStream?.getTracks().forEach(track => track.stop());
          recorderStream = null;
          const mime = recorder.mimeType || preferredMime || 'audio/webm';
          const extension = mime.includes('mp4') ? 'm4a' : 'webm';
          const blob = new Blob(chunks, { type: mime });
          node.recordingStatus = 'processing';
          recordButton.disabled = true;
          setActBoardNarrationRecordStatus(recordStatusController, 'Preparing recording…');
          recordActBoardNarration(node, blob, `act-board-${actKey}-${Date.now()}.${extension}`, recordStatusController)
            .finally(() => { recordButton.disabled = false; });
        }, { once: true });
        node.recordingStatus = 'recording';
        setActBoardNarrationRecordStatus(recordStatusController, 'Recording…');
        recorder.start();
      } catch (err) {
        recorderStream?.getTracks().forEach(track => track.stop());
        recorderStream = null;
        setActBoardNarrationRecordStatus(recordStatusController,
          `Could not start recording: ${err.message}`, true);
      }
    });
    if (recordingTimings) suggestedView.appendChild(recordingTimings);
    if (node.footageNodeIds && node.footageNodeIds.length) {
      const umbrella = document.createElement('div');
      umbrella.className = 'storyboard-act-board-node-umbrella';
      umbrella.textContent = `Umbrella narration over ${node.footageNodeIds.length} linked shot${node.footageNodeIds.length === 1 ? '' : 's'} · ${Number(node.durationSeconds || 0).toFixed(1)}s`;
      suggestedView.appendChild(umbrella);
    }
  } else if (node.type === 'audio') {
    buildActBoardAudioNodeContent(actKey, act, node, card, nodeStickyBanner);
  } else {
    const sequence = document.createElement('div');
    // sequence.className = 'storyboard-act-board-node-sequence';
    // sequence.textContent = node.narrationNodeId
    //   ? `Linked to narration · shot ${Number(node.sequenceIndex || 0) + 1}`
    //   : 'Unlinked footage';
    // card.appendChild(sequence);
    const timing = document.createElement('div');
    timing.className = 'storyboard-act-board-node-timing';
    timing.textContent = actBoardPlaybackTimingLabel(node.startSeconds, node.durationSeconds || 1);
    if (nodeStickyBanner) nodeStickyBanner.prepend(timing);
    else card.appendChild(timing);
    const footageTiming = document.createElement('div');
    footageTiming.className = 'storyboard-act-board-footage-timing-controls storyboard-act-board-footage-node-timing';
    footageTiming.dataset.footageNodeId = node.id;
    const sourceDuration = actBoardFootageSourceDuration(node);
    const makeFootageTimingInput = (labelText, value, min = 0, max = 3600) => {
      const label = document.createElement('label');
      label.textContent = labelText;
      const input = document.createElement('input');
      input.type = 'number';
      input.min = String(min);
      input.max = String(max);
      input.step = '0.1';
      input.value = Number(value || 0).toFixed(1);
      input.addEventListener('pointerdown', event => event.stopPropagation());
      input.addEventListener('click', event => event.stopPropagation());
      label.appendChild(input);
      return input;
    };
    const maxSourceIn = sourceDuration > 0 ? Math.max(0, sourceDuration - 0.1) : 3600;
    const footageSourceInInput = makeFootageTimingInput(
      'Source in', node.trimStartSeconds || 0, 0, maxSourceIn,
    );
    footageSourceInInput.dataset.footageTimingRole = 'source-in';
    const maxLength = sourceDuration > 0
      ? Math.max(0.1, sourceDuration - Math.max(0, Number(node.trimStartSeconds) || 0))
      : 3600;
    const footageLengthInput = makeFootageTimingInput(
      'Length', node.durationSeconds || 1, 0.5, maxLength,
    );
    footageLengthInput.dataset.footageTimingRole = 'length';
    const updateFootageTiming = () => {
      const sourceIn = Math.max(0, Number(footageSourceInInput.value) || 0);
      node.trimStartSeconds = Number(Math.min(maxSourceIn, sourceIn).toFixed(2));
      const available = sourceDuration > 0
        ? Math.max(0.1, sourceDuration - node.trimStartSeconds) : 3600;
      node.durationSeconds = Number(Math.max(0.5, Math.min(available,
        Number(footageLengthInput.value) || 0.5)).toFixed(2));
      footageSourceInInput.value = node.trimStartSeconds.toFixed(1);
      footageLengthInput.max = String(available);
      footageLengthInput.value = node.durationSeconds.toFixed(1);
      node.timingWasManuallyAdjusted = true;
      const parent = node.narrationNodeId
        ? actBoardNodesForAct(actKey).find(item => item.type === 'narration' && item.id === node.narrationNodeId)
        : null;
      if (parent) parent.timelineDurationSeconds = Math.max(
        Number(parent.timelineDurationSeconds) || 0,
        node.startSeconds + node.durationSeconds,
      );
      const scene = actBoardSceneForNode(actKey, node);
      if (scene) scene.timelineDurationSeconds = Math.max(
        Number(scene.timelineDurationSeconds) || 0,
        node.startSeconds + node.durationSeconds,
      );
      setActBoardNodeTimingText(timing,
        actBoardPlaybackTimingLabel(node.startSeconds, node.durationSeconds));
      refreshActBoardFootageTrackForNode(node);
      saveDebugSession();
    };
    footageSourceInInput.addEventListener('input', updateFootageTiming);
    footageLengthInput.addEventListener('input', updateFootageTiming);
    footageTiming.append(
      // Object.assign(document.createElement('span'), { textContent: 'Timing' }),
      footageSourceInInput.parentElement,
      footageLengthInput.parentElement,
    );
    const timingHint = document.createElement('small');
    timingHint.className = 'storyboard-act-board-footage-timing-hint';
    // timingHint.textContent = 'Drag the footage track segment to set when it appears · Source in = where to begin inside the file · Length = how long it plays';
    footageTiming.appendChild(timingHint);
    card.appendChild(footageTiming);
    // When the selected visual has a known natural duration, expose the same
    // draggable source-window affordance used by sound nodes. This edits the
    // source in/out portion without changing the node's timeline start.
    if (sourceDuration > 0 && node.selectedVisualKey) {
      const sourceEditor = document.createElement('div');
      sourceEditor.className = 'storyboard-act-board-footage-source-editor';
      sourceEditor.dataset.footageNodeId = node.id;
      const sourceReadout = document.createElement('div');
      sourceReadout.className = 'sfx-segment-readout';
      const sourceStrip = document.createElement('div');
      sourceStrip.className = 'sfx-source-strip storyboard-act-board-footage-source-strip';
      sourceStrip.title = 'Drag the selected window or either edge to choose the footage source segment';
      const sourceSelection = document.createElement('div');
      sourceSelection.className = 'sfx-source-selection';
      const sourceLabel = document.createElement('span');
      sourceLabel.className = 'sfx-source-selection-label';
      sourceSelection.appendChild(sourceLabel);
      const sourceStartHandle = document.createElement('span');
      sourceStartHandle.className = 'sfx-source-handle start';
      sourceStartHandle.title = 'Drag source in-point';
      const sourceEndHandle = document.createElement('span');
      sourceEndHandle.className = 'sfx-source-handle end';
      sourceEndHandle.title = 'Drag source out-point';
      sourceSelection.append(sourceStartHandle, sourceEndHandle);
      sourceStrip.appendChild(sourceSelection);
      sourceEditor.append(sourceReadout, sourceStrip);
      card.appendChild(sourceEditor);
      const redrawSourceWindow = () => {
        const start = Math.max(0, Number(node.trimStartSeconds) || 0);
        const length = Math.max(0.5, Math.min(sourceDuration - start,
          Number(node.durationSeconds) || 1));
        sourceSelection.style.left = `${(start / sourceDuration) * 100}%`;
        sourceSelection.style.width = `${(length / sourceDuration) * 100}%`;
        sourceLabel.textContent = `${length.toFixed(1)}s`;
        sourceReadout.textContent = `Using ${start.toFixed(1)}s–${(start + length).toFixed(1)}s · ${length.toFixed(1)}s`;
      };
      sourceEditor._actBoardRefresh = redrawSourceWindow;
      const wireSourceWindow = (target, mode) => target.addEventListener('pointerdown', event => {
        event.preventDefault();
        event.stopPropagation();
        const stripWidth = sourceStrip.getBoundingClientRect().width || 1;
        const originX = event.clientX;
        const initialStart = Math.max(0, Number(node.trimStartSeconds) || 0);
        const initialLength = Math.max(0.5, Math.min(sourceDuration - initialStart,
          Number(node.durationSeconds) || 1));
        const initialEnd = initialStart + initialLength;
        try { target.setPointerCapture(event.pointerId); } catch (err) { /* optional */ }
        const move = moveEvent => {
          const delta = ((moveEvent.clientX - originX) / stripWidth) * sourceDuration;
          if (mode === 'start') {
            node.trimStartSeconds = Math.max(0, Math.min(initialStart + delta,
              initialEnd - 0.5));
            node.durationSeconds = initialEnd - node.trimStartSeconds;
          } else if (mode === 'end') {
            node.durationSeconds = Math.max(0.5, Math.min(initialLength + delta,
              sourceDuration - initialStart));
          } else {
            node.trimStartSeconds = Math.max(0, Math.min(initialStart + delta,
              sourceDuration - initialLength));
          }
          node.trimStartSeconds = Number(node.trimStartSeconds.toFixed(2));
          node.durationSeconds = Number(node.durationSeconds.toFixed(2));
          footageSourceInInput.value = node.trimStartSeconds.toFixed(1);
          footageLengthInput.value = node.durationSeconds.toFixed(1);
          footageLengthInput.max = String(Math.max(0.1,
            sourceDuration - node.trimStartSeconds));
          node.timingWasManuallyAdjusted = true;
          setActBoardNodeTimingText(timing,
            actBoardPlaybackTimingLabel(node.startSeconds, node.durationSeconds));
          const scene = actBoardSceneForNode(actKey, node);
          if (scene) scene.timelineDurationSeconds = Math.max(
            Number(scene.timelineDurationSeconds) || 0,
            (Number(node.startSeconds) || 0) + node.durationSeconds,
          );
          refreshActBoardFootageTrackForNode(node);
          redrawSourceWindow();
        };
        const up = () => {
          target.removeEventListener('pointermove', move);
          target.removeEventListener('pointerup', up);
          target.removeEventListener('pointercancel', up);
          try { target.releasePointerCapture(event.pointerId); } catch (err) { /* optional */ }
          refreshActBoardFootageTrackForNode(node);
          saveDebugSession();
        };
        target.addEventListener('pointermove', move);
        target.addEventListener('pointerup', up, { once: true });
        target.addEventListener('pointercancel', up, { once: true });
      });
      wireSourceWindow(sourceStartHandle, 'start');
      wireSourceWindow(sourceEndHandle, 'end');
      wireSourceWindow(sourceSelection, 'window');
      redrawSourceWindow();
    }
    const visualOptions = [
      ...(Array.isArray(node.generatedOptions) ? node.generatedOptions.map((option, index) => ({
        key: `generated-${index}`,
        kind: option.kind || 'image',
        url: option.url || '',
        thumbnailUrl: option.thumbnail_url || option.url || '',
        hasThumbnail: Boolean(option.thumbnail_url),
        label: option.label || `Generated option ${index + 1}`,
        generatedIndex: index,
        source: 'AI-generated',
        pinned: Boolean(option.pinned),
        shotSize: option.shot_size || '',
        movement: option.movement || '',
        shotPlan: option.shotPlan || {},
      })) : []),
      ...(Array.isArray(node.results) ? node.results.map((video, index) => ({
        key: `result-${index}`,
        kind: 'video',
        url: video.localPreviewUrl || video.video_url || '',
        thumbnailUrl: video.thumbnail_url || video.localPreviewUrl || video.video_url || '',
        hasThumbnail: Boolean(video.thumbnail_url),
        label: `${video.source ? `${video.source} · ` : ''}${node.fragment || 'Suggested footage'} ${index + 1}`,
        resultIndex: index,
        pinned: Boolean(video.pinned),
        source: video.source || '',
        sourceUrl: video.source_url || '',
        durationSeconds: Number(video.duration_seconds) || 0,
      })) : []),
    ].filter(option => option.url || option.thumbnailUrl);
    const selectedGeneratedIndex = String(node.selectedVisualKey || '').startsWith('generated-')
      ? Number(node.selectedVisualKey.slice('generated-'.length)) : -1;
    const selectedGenerated = selectedGeneratedIndex >= 0 && node.generatedOptions
      ? node.generatedOptions[selectedGeneratedIndex] : null;
    const uploadedVisual = node.selectedVisualKey === 'upload' && (node.mediaUrl || node.mediaThumbnailUrl)
      ? {
        key: 'upload',
        kind: node.mediaKind || 'video',
        url: node.mediaUrl || '',
        thumbnailUrl: node.mediaThumbnailUrl || node.mediaUrl || '',
        label: node.mediaKind === 'image' ? 'Uploaded image' : 'Uploaded footage',
        source: 'Uploaded by user',
      } : null;
    const selectedVisual = uploadedVisual || (node.selectedVisualKey
      ? visualOptions.find(option => option.key === node.selectedVisualKey) || null
      : null);

    // A footage-only chain has no narration phrase to label. Keep the card
    // focused on its visual and timing controls; narration-linked footage
    // retains the fragment title as its anchor.
    const narrationAnchor = actBoardNarrationForNode(actKey, node);
    const fragmentText = String(node.fragment || '').trim();
    const narrationText = String(narrationAnchor?.transcript || narrationAnchor?.text || '');
    const normalizedFragment = fragmentText.toLocaleLowerCase();
    const hasNarrationPhraseAnchor = Boolean(
      narrationAnchor
      && fragmentText
      && normalizedFragment !== 'new footage idea'
      && narrationText.toLocaleLowerCase().includes(normalizedFragment),
    );
    if (hasNarrationPhraseAnchor) {
      const fragment = document.createElement('div');
      fragment.className = 'storyboard-act-board-node-fragment-title';
      const fragmentLabel = document.createElement('span');
      fragmentLabel.className = 'storyboard-act-board-node-fragment-label';
      fragmentLabel.textContent = 'Narration phrase:';
      const fragmentPhrase = document.createElement('span');
      fragmentPhrase.className = 'storyboard-act-board-node-fragment-text';
      fragmentPhrase.textContent = ` ${node.fragment || 'Unnamed narration fragment'}`;
      fragment.append(fragmentLabel, fragmentPhrase);
      card.appendChild(fragment);
    }

    const visualGallery = document.createElement('div');
    visualGallery.className = 'storyboard-act-board-footage-gallery';
    const featured = document.createElement('div');
    featured.className = 'storyboard-act-board-footage-featured';
    const appendFeaturedVisual = (container, visual, label) => {
      if (visual && (visual.url || visual.thumbnailUrl)) {
        if (visual.kind === 'video' && visual.url) {
          const video = document.createElement('video');
          video.dataset.nodeId = node.id;
          video.src = visual.url;
          video.poster = visual.thumbnailUrl || '';
          video.controls = true;
          // Let an explicit click on the native play control start audible
          // playback. Autoplaying a muted preview made generated videos (and
          // downloaded stock footage) appear to have no sound at all.
          video.autoplay = false;
          // Loop only the node's selected source window, not the entire source
          // video. The timing controls below update this window live.
          video.loop = false;
          video.muted = false;
          video.playsInline = true;
          video.preload = 'metadata';
          video.setAttribute('aria-label', `${visual.label || label || node.fragment || 'Selected footage'} preview`);
          video.addEventListener('loadedmetadata', () => {
            const naturalDuration = Number(video.duration);
            if (Number.isFinite(naturalDuration) && naturalDuration > 0
              && node.mediaKind === 'video'
              && (!Number(node.sourceDurationSeconds) || node.selectedVisualKey === 'upload')) {
              node.sourceDurationSeconds = Number(naturalDuration.toFixed(2));
              node.trimStartSeconds = Math.min(
                Math.max(0, Number(node.trimStartSeconds) || 0),
                Math.max(0, naturalDuration - 0.1),
              );
              node.durationSeconds = Math.min(
                Math.max(0.5, Number(node.durationSeconds) || 1),
                Math.max(0.1, naturalDuration - node.trimStartSeconds),
              );
              saveDebugSession();
            }
            if (typeof video._actBoardSyncTiming === 'function') video._actBoardSyncTiming(true);
          }, { once: true });
          const syncPreviewTiming = forceSeek => {
            const naturalDuration = Number(video.duration);
            if (!Number.isFinite(naturalDuration) || naturalDuration <= 0) return;
            const sourceIn = Math.min(
              Math.max(0, Number(node.trimStartSeconds) || 0),
              Math.max(0, naturalDuration - 0.05),
            );
            const selectedLength = Math.max(0.1, Math.min(
              Number(node.durationSeconds) || naturalDuration - sourceIn,
              Math.max(0.1, naturalDuration - sourceIn),
            ));
            const end = Math.min(naturalDuration, sourceIn + selectedLength);
            const current = Number(video.currentTime) || 0;
            if (forceSeek || current < sourceIn - 0.05 || current >= end - 0.04) {
              try { video.currentTime = sourceIn; } catch (err) { /* metadata race */ }
            }
          };
          video._actBoardSyncTiming = syncPreviewTiming;
          video.addEventListener('timeupdate', () => {
            if (video.paused) return;
            const naturalDuration = Number(video.duration);
            if (!Number.isFinite(naturalDuration) || naturalDuration <= 0) return;
            const sourceIn = Math.min(
              Math.max(0, Number(node.trimStartSeconds) || 0),
              Math.max(0, naturalDuration - 0.05),
            );
            const selectedLength = Math.max(0.1, Math.min(
              Number(node.durationSeconds) || naturalDuration - sourceIn,
              Math.max(0.1, naturalDuration - sourceIn),
            ));
            if (video.currentTime >= Math.min(naturalDuration, sourceIn + selectedLength) - 0.04) {
              try { video.currentTime = sourceIn; } catch (err) { /* metadata race */ }
              video.play().catch(() => { });
            }
          });
          video.addEventListener('play', () => {
            if (typeof video._actBoardSyncTiming === 'function') video._actBoardSyncTiming(false);
          });
          // The featured player sits inside a draggable board card. Keep
          // native video controls from being interpreted as card gestures.
          video.addEventListener('click', event => event.stopPropagation());
          video.addEventListener('pointerdown', event => event.stopPropagation());
          // A remote result can occasionally expire before its local preview
          // is available. Keep the selected box useful by falling back to its
          // thumbnail instead of leaving a broken video element visible.
          video.addEventListener('error', () => {
            if (!video.parentNode || video.dataset.thumbnailFallback === 'true') return;
            video.dataset.thumbnailFallback = 'true';
            if (!visual.thumbnailUrl) return;
            const image = document.createElement('img');
            image.src = visual.thumbnailUrl;
            image.alt = visual.label || label || node.fragment || 'Selected footage';
            image.loading = 'lazy';
            video.replaceWith(image);
          }, { once: true });
          container.appendChild(video);
        } else {
          const image = document.createElement('img');
          image.src = visual.thumbnailUrl || visual.url;
          image.alt = visual.label || label || node.fragment || 'Selected footage';
          image.loading = 'lazy';
          container.appendChild(image);
        }
      } else {
        const empty = document.createElement('div');
        empty.className = 'storyboard-act-board-footage-empty';
        empty.textContent = 'No footage thumbnail yet.';
        container.appendChild(empty);
      }
    };
    const createPinButton = option => {
      if (!option || (option.generatedIndex == null && option.resultIndex == null)) return null;
      const pinButton = document.createElement('button');
      pinButton.type = 'button';
      pinButton.className = 'storyboard-act-board-footage-pin-btn';
      pinButton.textContent = option.pinned ? '★' : '☆';
      pinButton.title = option.pinned ? 'Unpin this footage' : 'Pin this footage';
      pinButton.setAttribute('aria-label', pinButton.title);
      pinButton.classList.toggle('pinned', option.pinned);
      pinButton.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        pinActBoardVisual(node, option);
      });
      return pinButton;
    };
    const splitSourceNode = node.compositionMode === 'split-screen'
      ? actBoardNodesForAct(actKey).find(item => item.type === 'footage'
        && (node.splitScreenNodeIds || []).includes(item.id) && item.id !== node.id)
      : null;
    // An act can temporarily have no assigned scene while the board is being
    // edited. Keep the picker usable in that state by falling back to the
    // first active scene as the upload anchor.
    const sourceSection = actBoardSourceSection(actKey)
      || currentSections.find(section => isSceneActive(section))
      || null;
    const createUploadPicker = () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.mp4,video/mp4,video/quicktime,video/webm,image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';
      input.className = 'storyboard-act-board-footage-upload-input';
      input.disabled = !sourceSection;
      input.addEventListener('click', event => event.stopPropagation());
      const status = document.createElement('small');
      status.className = 'storyboard-act-board-footage-upload-status';
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file || !sourceSection) return;
        node.selectedVisualKey = 'upload';
        uploadActBoardNodeMedia(actKey, node, sourceSection, file, status, input);
      });
      const openPicker = event => {
        event?.preventDefault();
        event?.stopPropagation();
        if (input.disabled) return;
        input.value = '';
        input.click();
      };
      return { input, status, openPicker };
    };
    const appendUploadPrompt = container => {
      const slot = document.createElement('div');
      slot.className = 'paper-section-open-slot';
      slot.setAttribute('role', 'button');
      slot.tabIndex = sourceSection ? 0 : -1;
      slot.setAttribute('aria-label', 'Upload a sketch or footage');
      const icon = document.createElement('div');
      icon.className = 'paper-section-open-slot-icon';
      icon.textContent = '🎥';
      slot.appendChild(icon);

      const prompt = document.createElement('div');
      prompt.className = 'open-slot-text';
      prompt.textContent = 'Upload your footage';
      slot.appendChild(prompt);

      const picker = createUploadPicker();
      slot.appendChild(picker.input);
      slot.addEventListener('click', picker.openPicker);
      slot.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') picker.openPicker(event);
      });
      slot.appendChild(picker.status);
      container.appendChild(slot);
    };
    if (splitSourceNode) {
      featured.classList.add('split-screen');
      const splitVisuals = [
        { node: node, visual: selectedVisual },
        {
          node: splitSourceNode,
          visual: {
            kind: splitSourceNode.mediaKind || 'image',
            url: splitSourceNode.mediaUrl || splitSourceNode.results?.[0]?.video_url || '',
            thumbnailUrl: splitSourceNode.mediaThumbnailUrl || splitSourceNode.results?.[0]?.thumbnail_url || splitSourceNode.mediaUrl || '',
            hasThumbnail: Boolean(splitSourceNode.mediaThumbnailUrl || splitSourceNode.results?.[0]?.thumbnail_url),
            label: footageNodeVisualSummary(splitSourceNode),
          },
        },
      ];
      splitVisuals.forEach(({ node: splitNode, visual }) => {
        const pane = document.createElement('div');
        pane.className = 'storyboard-act-board-footage-split-pane';
        appendFeaturedVisual(pane, visual, footageNodeVisualSummary(splitNode));
        const paneLabel = document.createElement('small');
        paneLabel.textContent = footageNodeVisualSummary(splitNode);
        pane.appendChild(paneLabel);
        featured.appendChild(pane);
      });
    } else if (selectedVisual && (selectedVisual.url || selectedVisual.thumbnailUrl)) {
      appendFeaturedVisual(featured, selectedVisual, node.fragment);
      const selectedPinButton = createPinButton(selectedVisual);
      if (selectedPinButton) featured.appendChild(selectedPinButton);
      const replacePicker = createUploadPicker();
      const replaceButton = document.createElement('button');
      replaceButton.type = 'button';
      replaceButton.className = 'btn-secondary storyboard-act-board-footage-replace-btn';
      replaceButton.textContent = 'Upload your own';
      replaceButton.title = 'Replace the selected image or footage with your own upload';
      replaceButton.disabled = replacePicker.input.disabled;
      replaceButton.addEventListener('click', replacePicker.openPicker);
      featured.appendChild(replacePicker.input);
      featured.appendChild(replacePicker.status);
      featured.appendChild(replaceButton);
    } else {
      appendUploadPrompt(featured);
    }
    const selectedSource = selectedVisual?.source
      || (selectedVisual?.generatedIndex != null ? 'AI-generated' : '');
    if (selectedSource) {
      const sourceBadge = document.createElement('small');
      sourceBadge.className = 'storyboard-act-board-footage-featured-source';
      sourceBadge.textContent = selectedSource;
      sourceBadge.title = `Source: ${selectedSource}`;
      featured.appendChild(sourceBadge);
    }
    const selectedLabel = document.createElement('span');
    selectedLabel.className = 'storyboard-act-board-footage-featured-label';
    selectedLabel.textContent = 'Selected';
    featured.appendChild(selectedLabel);
    visualGallery.appendChild(featured);
    const thumbRail = document.createElement('div');
    thumbRail.className = 'storyboard-act-board-footage-thumb-rail';
    if (node.status === 'generating') {
      const stockPlaceholder = document.createElement('div');
      stockPlaceholder.className = 'storyboard-act-board-footage-generating-placeholder stock-footage';
      stockPlaceholder.setAttribute('aria-live', 'polite');
      stockPlaceholder.textContent = 'Stock footage searching…';
      thumbRail.appendChild(stockPlaceholder);
    }
    if (node.generationStatus === 'generating-images') {
      const generatingPlaceholder = document.createElement('div');
      generatingPlaceholder.className = 'storyboard-act-board-footage-generating-placeholder';
      generatingPlaceholder.setAttribute('aria-live', 'polite');
      generatingPlaceholder.textContent = 'Image generating…';
      thumbRail.appendChild(generatingPlaceholder);
    }
    const alternateVisualOptions = visualOptions.filter(option =>
      !selectedVisual || option.key !== selectedVisual.key);
    alternateVisualOptions.forEach(option => {
      const thumbWrap = document.createElement('div');
      thumbWrap.className = 'storyboard-act-board-footage-thumb-wrap';
      const optionButton = document.createElement('button');
      optionButton.type = 'button';
      optionButton.className = 'storyboard-act-board-footage-thumb';
      optionButton.disabled = node.downloadStatus === 'downloading';
      optionButton.classList.toggle('selected', selectedVisual && option.key === selectedVisual.key);
      optionButton.title = option.label;
      if (option.kind === 'video' && option.url && !option.hasThumbnail) {
        const video = document.createElement('video');
        video.src = option.url;
        video.muted = true;
        video.playsInline = true;
        video.preload = 'metadata';
        optionButton.appendChild(video);
      } else if (option.thumbnailUrl || option.url) {
        const image = document.createElement('img');
        image.src = option.thumbnailUrl || option.url;
        image.alt = option.label;
        image.loading = 'lazy';
        optionButton.appendChild(image);
      }
      optionButton.addEventListener('click', async event => {
        event.stopPropagation();
        if (option.generatedIndex != null) {
          const generated = node.generatedOptions[option.generatedIndex];
          node.selectedVisualKey = option.key;
          node.selectedGeneratedIndex = option.generatedIndex;
          node.mediaUrl = generated.url || '';
          node.mediaThumbnailUrl = generated.thumbnail_url || generated.url || '';
          node.mediaKind = generated.kind || 'image';
          node.mediaOrigin = 'generated';
          node.shotPlan = generated.shotPlan || node.shotPlan || {};
          node.sourceDurationSeconds = Number(generated.duration_seconds || generated.duration) || 0;
          node.trimStartSeconds = 0;
        } else if (option.resultIndex != null) {
          const result = node.results[option.resultIndex];
          if (!result?.video_url) return;
          optionButton.disabled = true;
          // Downloading a selected result is not a new stock search. Keep the
          // ready state so the stock-search placeholder does not reappear.
          node.downloadStatus = 'downloading';
          node.error = '';
          saveDebugSession();
          rerenderActBoard();
          try {
            const downloaded = await fetchDownloadStockMedia(
              actBoardAssetSectionIndex(node),
              'video',
              result.video_url,
              premiereProjectId,
              Math.max(1, Number(node.durationSeconds) || 1),
              result.id || node.id,
            );
            premiereProjectId = downloaded.project_id || premiereProjectId;
            result.localPreviewUrl = downloaded.preview_url || '';
            result.thumbnail_url = downloaded.thumbnail_url || result.thumbnail_url || '';
            node.selectedVisualKey = option.key;
            node.selectedResultIndex = option.resultIndex;
            node.mediaUrl = result.localPreviewUrl;
            node.mediaThumbnailUrl = result.thumbnail_url || result.localPreviewUrl;
            node.mediaKind = 'video';
            node.mediaOrigin = 'suggested';
            node.sourceDurationSeconds = Number(downloaded.duration_seconds)
              || Number(result.duration_seconds || result.duration) || 0;
            node.trimStartSeconds = Math.min(
              Number(node.trimStartSeconds) || 0,
              Math.max(0, node.sourceDurationSeconds - 0.1),
            );
            if (node.sourceDurationSeconds > 0) {
              node.durationSeconds = Math.min(
                Math.max(0.5, Number(node.durationSeconds) || 1),
                Math.max(0.1, node.sourceDurationSeconds - node.trimStartSeconds),
              );
            }
          } catch (err) {
            node.error = `Could not download footage: ${err.message}`;
          }
          node.downloadStatus = '';
        }
        saveDebugSession();
        rerenderActBoard();
      });
      thumbWrap.appendChild(optionButton);
      if (option.source) {
        const sourceBadge = document.createElement('small');
        sourceBadge.className = 'storyboard-act-board-footage-source';
        sourceBadge.textContent = option.source;
        sourceBadge.title = `Source: ${option.source}`;
        thumbWrap.appendChild(sourceBadge);
      }
      const pinButton = createPinButton(option);
      if (pinButton) thumbWrap.appendChild(pinButton);
      thumbRail.appendChild(thumbWrap);
    });
    if (alternateVisualOptions.length || node.status === 'generating'
      || node.generationStatus === 'generating-images') {
      visualGallery.appendChild(thumbRail);
    }
    card.appendChild(visualGallery);

    const footageSearchPanel = document.createElement('details');
    footageSearchPanel.className = 'storyboard-act-board-suggested-side-panel storyboard-act-board-footage-search-panel';
    footageSearchPanel.open = node.status === 'generating'
      || node.generationStatus === 'generating-images'
      || node.generationStatus === 'generating-video';
    footageSearchPanel.addEventListener('click', event => event.stopPropagation());
    const footageSearchSummary = document.createElement('summary');
    footageSearchSummary.textContent = node.status === 'generating' ? 'Finding footage…'
      : node.generationStatus === 'generating-images' ? 'Generating image…'
        : node.generationStatus === 'generating-video' ? 'Generating video…' : 'Find footage';
    footageSearchPanel.appendChild(footageSearchSummary);
    const generationControls = document.createElement('div');
    generationControls.className = 'storyboard-act-board-node-generation-controls';
    const footageSearchLabel = document.createElement('input');
    footageSearchLabel.type = 'text';
    footageSearchLabel.className = 'storyboard-act-board-footage-search-label storyboard-act-board-footage-search-input';
    footageSearchLabel.value = node.query || '';
    footageSearchLabel.placeholder = 'Search stock footage query';
    footageSearchLabel.title = 'Edit the stock footage search query';
    footageSearchLabel.setAttribute('aria-label', 'Stock footage search query');
    footageSearchLabel.addEventListener('click', event => event.stopPropagation());
    footageSearchLabel.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        findFootageButton.click();
      }
    });
    footageSearchLabel.addEventListener('input', () => {
      node.query = footageSearchLabel.value.trim();
      saveDebugSession();
    });
    generationControls.appendChild(footageSearchLabel);
    const findFootageButton = document.createElement('button');
    findFootageButton.type = 'button';
    findFootageButton.className = 'btn-secondary storyboard-act-board-node-action storyboard-act-board-find-footage-btn';
    findFootageButton.textContent = node.status === 'generating' ? 'Finding footage…' : 'Find footage';
    findFootageButton.disabled = node.status === 'generating';
    findFootageButton.addEventListener('click', event => {
      event.stopPropagation();
      const query = footageSearchLabel.value.trim();
      if (!query) {
        node.error = 'Enter a stock footage query first.';
        saveDebugSession();
        rerenderActBoard();
        return;
      }
      node.query = query;
      node.manualQuery = true;
      node.filmabilityQuery = '';
      const narrationNode = actBoardNodesForAct(actKey)
        .find(item => item.type === 'narration' && item.id === node.narrationNodeId);
      findActBoardFootageNode(actKey, act, narrationNode, node);
    });
    const findFootageRow = document.createElement('div');
    findFootageRow.className = 'storyboard-act-board-footage-find-row';
    findFootageRow.appendChild(findFootageButton);
    generationControls.appendChild(findFootageRow);
    // Keep the Find footage dropdown directly under the Footage header. The
    // gallery and generation controls remain below it in the node body.
    card.insertBefore(footageSearchPanel, card.children[1] || null);
    if (node.compositionMode) {
      const composition = document.createElement('div');
      composition.className = 'storyboard-act-board-node-composition-mode';
      composition.textContent = node.compositionMode === 'split-screen'
        ? 'Split screen · full shot duration'
        : 'Merged generative concept';
      card.appendChild(composition);
    }
    const generateExamplesBtn = document.createElement('button');
    generateExamplesBtn.type = 'button';
    generateExamplesBtn.className = 'btn-secondary storyboard-act-board-node-action';
    generateExamplesBtn.textContent = node.generationStatus === 'generating-images'
      ? 'Generating image…' : 'Generate image';
    generateExamplesBtn.disabled = node.generationStatus === 'generating-images' || node.generationStatus === 'generating-video';
    generateExamplesBtn.addEventListener('click', event => {
      event.stopPropagation();
      // Read the field at click time as well as on `input`. This covers paste,
      // autofill, and any last keystroke before the user presses Generate.
      const phraseInput = imageInputsPanel.querySelector(
        '.storyboard-act-board-image-generation-input-editable');
      if (phraseInput) {
        node.imageGenerationPhrase = phraseInput.value;
        saveDebugSession();
      }
      generateActBoardNodeExamples(actKey, act, node);
    });
    const generateVideoBtn = document.createElement('button');
    generateVideoBtn.type = 'button';
    generateVideoBtn.className = 'btn-secondary storyboard-act-board-node-action';
    generateVideoBtn.textContent = node.generationStatus === 'generating-video'
      ? 'Generating video…' : 'Generate video';
    const hasSelectedImage = Boolean(
      (selectedGenerated && selectedGenerated.kind !== 'video' && selectedGenerated.url)
      || (node.mediaKind === 'image' && (node.mediaUrl || node.mediaThumbnailUrl)),
    );
    generateVideoBtn.disabled = !hasSelectedImage
      || node.generationStatus === 'generating-images' || node.generationStatus === 'generating-video';
    generateVideoBtn.addEventListener('click', event => {
      event.stopPropagation();
      generateActBoardNodeVideo(actKey, act, node);
    });
    const generationActionRow = document.createElement('div');
    generationActionRow.className = 'storyboard-act-board-footage-generation-action-row';
    generationActionRow.append(generateExamplesBtn, generateVideoBtn);
    generationControls.appendChild(generationActionRow);

    const imageInputs = actBoardImageGenerationInputs(actKey, act, node);
    const imageInputsPanel = document.createElement('details');
    imageInputsPanel.className = 'storyboard-act-board-image-generation-inputs';
    imageInputsPanel.open = node.imageGenerationInputsOpen === true
      || node.generationStatus === 'generating-images';
    imageInputsPanel.addEventListener('toggle', () => {
      node.imageGenerationInputsOpen = imageInputsPanel.open;
      saveDebugSession();
    });
    const imageInputsSummary = document.createElement('summary');
    imageInputsSummary.textContent = 'Image generation inputs';
    imageInputsPanel.appendChild(imageInputsSummary);
    const inputRows = [
      ['Specific phrase', imageInputs.phrase],
      ['Parent narration', imageInputs.narration],
      ['Linked footage phrases', imageInputs.linkedFootagePhrases.join(' · ')],
      ['Documentary mode', imageInputs.documentaryMode],
      ['Scene techniques', imageInputs.techniques.join(' · ')],
    ];
    inputRows.forEach(([label, value]) => {
      const row = document.createElement('div');
      row.className = 'storyboard-act-board-image-generation-input-row';
      const name = document.createElement('span');
      name.className = 'storyboard-act-board-image-generation-input-label';
      name.textContent = label;
      let content;
      if (label === 'Specific phrase') {
        const phraseInput = document.createElement('input');
        phraseInput.type = 'text';
        phraseInput.className = 'storyboard-act-board-image-generation-input-editable';
        phraseInput.value = value || '';
        phraseInput.placeholder = 'Add a specific visual phrase';
        phraseInput.setAttribute('aria-label', 'Specific phrase for image generation');
        phraseInput.addEventListener('click', event => event.stopPropagation());
        phraseInput.addEventListener('pointerdown', event => event.stopPropagation());
        phraseInput.addEventListener('input', () => {
          node.imageGenerationPhrase = phraseInput.value;
          saveDebugSession();
        });
        phraseInput.addEventListener('change', () => {
          node.imageGenerationPhrase = phraseInput.value;
          saveDebugSession();
        });
        phraseInput.addEventListener('blur', () => {
          node.imageGenerationPhrase = phraseInput.value;
          saveDebugSession();
        });
        content = phraseInput;
      } else {
        content = document.createElement('span');
        content.className = 'storyboard-act-board-image-generation-input-value';
        content.textContent = value || 'None';
      }
      row.append(name, content);
      imageInputsPanel.appendChild(row);
    });
    const editTechniquesRow = document.createElement('div');
    editTechniquesRow.className = 'storyboard-act-board-image-generation-input-actions';
    const editTechniquesButton = document.createElement('button');
    editTechniquesButton.type = 'button';
    editTechniquesButton.className = 'btn-secondary storyboard-act-board-image-generation-edit-techniques';
    editTechniquesButton.textContent = 'Edit scene techniques';
    editTechniquesButton.addEventListener('click', event => {
      event.stopPropagation();
      openActBoardTechniquePopup(actKey, node, {
        allowedCategories: ACT_BOARD_IMAGE_TECHNIQUE_CATEGORIES,
        targetField: 'imageGenerationTechniques',
        title: 'Image generation techniques',
        hint: 'Choose only shot composition, lighting, or visual metaphor/data-vis techniques for this image.',
      });
    });
    editTechniquesRow.appendChild(editTechniquesButton);
    imageInputsPanel.appendChild(editTechniquesRow);
    const excludedInputs = document.createElement('div');
    excludedInputs.className = 'storyboard-act-board-image-generation-inputs-note';
    excludedInputs.textContent = 'Combined-concept prompts are not used for this Act Board image.';
    imageInputsPanel.appendChild(excludedInputs);
    generationControls.appendChild(imageInputsPanel);

    const videoInputs = actBoardGenerationContext(actKey, act, node);
    const selectedImagePhrase = selectedGenerated
      && Object.prototype.hasOwnProperty.call(selectedGenerated, 'specificPhrase')
      ? String(selectedGenerated.specificPhrase || '').trim()
      : '';
    const videoInputsPanel = document.createElement('details');
    videoInputsPanel.className = 'storyboard-act-board-image-generation-inputs storyboard-act-board-video-generation-inputs';
    videoInputsPanel.open = node.videoGenerationInputsOpen === true
      || node.generationStatus === 'generating-video';
    videoInputsPanel.addEventListener('toggle', () => {
      node.videoGenerationInputsOpen = videoInputsPanel.open;
      saveDebugSession();
    });
    const videoInputsSummary = document.createElement('summary');
    videoInputsSummary.textContent = 'Video generation inputs';
    videoInputsPanel.appendChild(videoInputsSummary);
    const selectedImageLabel = hasSelectedImage
      ? (selectedVisual?.label || 'Selected image')
      : 'None selected — generate or upload an image first';
    const shotPlan = selectedGenerated?.shotPlan || node.shotPlan || {};
    const shotPlanLabel = [
      shotPlan.shot_size && `Shot size: ${shotPlan.shot_size}`,
      shotPlan.movement && `Movement: ${shotPlan.movement}`,
      shotPlan.narrative_operation && `Operation: ${shotPlan.narrative_operation}`,
      shotPlan.purpose && `Purpose: ${shotPlan.purpose}`,
      shotPlan.visual_description && `Visual: ${shotPlan.visual_description}`,
    ].filter(Boolean).join(' · ');
    const videoMovementTechniques = ensureActBoardVideoGenerationTechniques(node);
    [
      ['Selected image', selectedImageLabel],
      ['Shot plan / movement', shotPlanLabel || 'No shot plan yet'],
      ['Specific phrase', selectedImagePhrase || 'None — this image was uploaded or has no saved phrase'],
      ['Parent narration', videoInputs.parentNarration],
      ['Linked footage phrases', videoInputs.linkedFootagePhrases.join(' · ')],
      ['Documentary mode', videoInputs.documentaryMode],
      ['Camera movement', videoMovementTechniques.join(' · ')],
    ].forEach(([label, value]) => {
      const row = document.createElement('div');
      row.className = 'storyboard-act-board-image-generation-input-row';
      const name = document.createElement('span');
      name.className = 'storyboard-act-board-image-generation-input-label';
      name.textContent = label;
      const content = document.createElement('span');
      content.className = 'storyboard-act-board-image-generation-input-value';
      content.textContent = value || 'None';
      if (label === 'Camera movement') {
        content.textContent = value || 'Choose a camera movement';
      }
      row.append(name, content);
      videoInputsPanel.appendChild(row);
    });
    const editMovementRow = document.createElement('div');
    editMovementRow.className = 'storyboard-act-board-image-generation-input-actions';
    const editMovementButton = document.createElement('button');
    editMovementButton.type = 'button';
    editMovementButton.className = 'btn-secondary storyboard-act-board-image-generation-edit-techniques';
    editMovementButton.textContent = 'Edit camera movement';
    editMovementButton.addEventListener('click', event => {
      event.stopPropagation();
      openActBoardTechniquePopup(actKey, node, {
        allowedCategories: ACT_BOARD_VIDEO_TECHNIQUE_CATEGORIES,
        targetField: 'videoGenerationTechniques',
        title: 'Video camera movement',
        hint: 'Choose the camera movement that will drive the video shot plan.',
      });
    });
    editMovementRow.appendChild(editMovementButton);
    videoInputsPanel.appendChild(editMovementRow);
    const videoInputsNote = document.createElement('div');
    videoInputsNote.className = 'storyboard-act-board-image-generation-inputs-note';
    videoInputsNote.textContent = 'Only the selected image is used as the animation input. Uploaded video references are not used.';
    videoInputsPanel.appendChild(videoInputsNote);
    generationControls.appendChild(videoInputsPanel);
    footageSearchPanel.appendChild(generationControls);
    if (node.generationError) {
      const generationError = document.createElement('div');
      generationError.className = 'storyboard-act-board-node-error';
      generationError.textContent = node.generationError;
      footageSearchPanel.appendChild(generationError);
    }
    if (node.error) {
      const error = document.createElement('div');
      error.className = 'storyboard-act-board-node-error';
      error.textContent = node.error;
      card.appendChild(error);
    }
  }
  if (node.type === 'footage') {
    card.addEventListener('click', event => {
      if (event.target.closest('button, input, audio, a, select, textarea, label, details, summary, .storyboard-act-board-node-resize-handle')) return;
      highlightActBoardFootageNode(boardLayer, node.id);
    });
  }
  wireActBoardNodeResizing(card, node, boardLayer);
  return card;
}

function bringActBoardNodeToFront(boardLayer, card, node = null) {
  if (!boardLayer || !card) return;
  const cards = Array.from(boardLayer.querySelectorAll('.storyboard-act-board-node'));
  const currentZ = Number(card.style.zIndex) || Number(node?.boardZIndex) || 1;
  const highest = cards.reduce((max, item) => Math.max(max, Number(item.style.zIndex) || 1), 1);
  const topCards = cards.filter(item => (Number(item.style.zIndex) || 1) === highest);
  if (currentZ >= highest && topCards.length === 1 && Number.isFinite(Number(node?.boardZIndex))) return;
  const nextZ = highest + 1;
  card.style.zIndex = String(nextZ);
  if (node) node.boardZIndex = nextZ;
  saveDebugSession();
}

function buildActBoardBoardSceneCard(scene, nodes, nodeStack) {
  const card = document.createElement('article');
  const inSceneStack = nodeStack?.classList?.contains('storyboard-act-board-stack');
  card.className = `storyboard-act-board-card storyboard-act-board-board-scene${inSceneStack
    ? ' storyboard-act-board-board-scene-in-stack' : ''}`;
  card.dataset.boardSceneId = scene.id;
  card.title = inSceneStack
    ? 'Click to load this scene’s nodes back onto the act board. Double-click the scene name to rename.'
    : scene.committedToStack
      ? 'Defined scene board. Use × to remove it from the board. Double-click the scene name to rename.'
      : 'Board-only scene. Drag its header to reposition it. Double-click the scene name to rename.';
  if (!inSceneStack) {
    card.style.position = 'absolute';
    card.style.left = `${Math.max(0, Number(scene.boardX) || 0)}px`;
    card.style.top = `${Math.max(0, Number(scene.boardY) || 0)}px`;
    // The framed board is a full-width scene surface, matching the loadable
    // scene-card stack below rather than tightly wrapping its current nodes.
    card.style.width = '100%';
    card.style.boxSizing = 'border-box';
    card.style.height = `${Math.max(116, Number(scene.boardHeight) || 116)}px`;
  }

  const header = document.createElement('div');
  header.className = 'storyboard-act-board-board-scene-header';
  const top = document.createElement('div');
  top.className = 'storyboard-act-board-card-top';
  const title = document.createElement('h5');
  title.textContent = scene.title || 'Board scene';
  const count = document.createElement('span');
  const sceneItems = Array.isArray(scene.nodeSnapshots) && scene.nodeSnapshots.length
    ? scene.nodeSnapshots
    : (scene.nodeIds || []).map(nodeId => nodes.find(item => item.id === nodeId)).filter(Boolean);
  const selectedCount = sceneItems.length;
  count.textContent = `${selectedCount} node${selectedCount === 1 ? '' : 's'}`;
  top.append(title, count);
  const meta = document.createElement('div');
  meta.className = 'storyboard-act-board-card-meta';
  const sceneMode = normalizeActBoardSceneMode(scene);
  const sceneModeLabel = DOCUMENTARY_MODES.find(mode => mode.key === sceneMode)?.label || sceneMode;
  meta.appendChild(document.createTextNode(inSceneStack || scene.committedToStack
    ? 'Scene Mode '
    : 'Board-only scene · '));
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'storyboard-act-board-board-scene-remove';
  remove.textContent = '×';
  remove.title = scene.committedToStack
    ? 'Remove this defined scene from the act board'
    : 'Remove this board-only scene';
  remove.setAttribute('aria-label', scene.committedToStack
    ? 'Remove defined scene from act board' : 'Remove board-only scene');
  remove.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    const scenes = actBoardScenesForAct(scene.actKey);
    const index = scenes.findIndex(item => item.id === scene.id);
    if (index !== -1) scenes.splice(index, 1);
    saveDebugSession();
    rerenderActBoard();
  });
  let clearNodes = null;
  let organizeNodes = null;
  if (!inSceneStack && scene.committedToStack) {
    organizeNodes = document.createElement('button');
    organizeNodes.type = 'button';
    organizeNodes.className = 'btn-secondary storyboard-act-board-board-scene-organize';
    organizeNodes.textContent = 'Organize';
    organizeNodes.title = 'Arrange narration first, linked footage underneath, and audio below without overlap';
    organizeNodes.setAttribute('aria-label', 'Organize scene nodes');
    const liveNodes = nodes.filter(node => (scene.nodeIds || []).includes(node.id)
      || node.sceneId === scene.id);
    organizeNodes.disabled = !liveNodes.some(node => ['narration', 'footage', 'audio'].includes(node.type));
    organizeNodes.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      organizeActBoardSceneNodes(scene, nodes, nodeStack);
    });
    clearNodes = document.createElement('button');
    clearNodes.type = 'button';
    clearNodes.className = 'storyboard-act-board-board-scene-clear-nodes';
    clearNodes.textContent = '−';
    clearNodes.title = 'Remove this scene’s nodes but leave an empty board for new nodes; keep the loadable scene card';
    clearNodes.setAttribute('aria-label', 'Remove scene nodes from board');
    clearNodes.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      const nodeIds = new Set(scene.nodeIds || []);
      if (nodeIds.size) {
        actBoardNodes[scene.actKey] = actBoardNodesForAct(scene.actKey)
          .filter(node => !nodeIds.has(node.id));
      }
      // Keep the committed card as a restore point, hide its framed board,
      // and start the next empty scene in the same place. This makes the
      // collapse action a clean handoff from Scene 1 to Scene 2 (and onward)
      // without losing Scene 1's nodes or links.
      scene.hidden = true;
      scene.liveNodesCleared = true;
      const scenes = actBoardScenesForAct(scene.actKey);
      const mode = normalizeActBoardSceneMode(scene);
      const nextScene = {
        id: createActBoardSceneId(),
        actKey: scene.actKey,
        title: nextActBoardSceneTitle(scenes),
        nodeIds: [],
        nodeSnapshots: [],
        nodeLinks: [],
        documentaryMode: mode,
        documentaryModeSource: scene.documentaryModeSource === 'user' ? 'user' : 'moodboard',
        includeNarration: scene.includeNarration !== false,
        sequenceStartNodeId: null,
        boardX: Number(scene.boardX) || 0,
        boardY: Number(scene.boardY) || 0,
        boardWidth: Number(scene.boardWidth) || 560,
        boardHeight: Number(scene.boardHeight) || 360,
        boardPositionMode: 'manual',
        committedToStack: true,
      };
      scenes.push(nextScene);
      ensureActBoardPlaybackNode(scene.actKey, null, { create: true, sceneId: nextScene.id });
      setActBoardOpenScene(scene.actKey, nextScene);
      saveDebugSession();
      rerenderActBoard();
    });
  }
  if (organizeNodes) top.append(organizeNodes);
  if (clearNodes) top.append(clearNodes);
  // The framed defined-scene board uses the minus control to remove its live
  // nodes while preserving an empty drop-target board and loadable card. Keep the × control on
  // stack cards (and ordinary board-only scenes) for deleting the scene.
  if (inSceneStack || !scene.committedToStack) top.append(remove);
  if (!inSceneStack) {
    const modeControls = document.createElement('span');
    modeControls.className = 'storyboard-act-board-scene-mode-inline';
    DOCUMENTARY_MODES.forEach(mode => {
      const modeButton = document.createElement('button');
      modeButton.type = 'button';
      modeButton.className = 'storyboard-act-board-scene-mode-btn';
      modeButton.textContent = mode.label;
      modeButton.title = `${mode.description} Use this mode when suggesting narration for this scene.`;
      modeButton.classList.toggle('selected', sceneMode === mode.key);
      modeButton.setAttribute('aria-pressed', String(sceneMode === mode.key));
      modeButton.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        scene.documentaryMode = mode.key;
        scene.documentaryModeSource = 'user';
        saveDebugSession();
        rerenderActBoard();
      });
      modeControls.appendChild(modeButton);
    });
    meta.appendChild(modeControls);
  } else {
    const modeBadge = document.createElement('span');
    modeBadge.className = 'storyboard-act-board-scene-mode-badge selected';
    modeBadge.textContent = sceneModeLabel;
    modeBadge.title = 'Mode used for this Act Board scene';
    meta.appendChild(modeBadge);
  }
  header.append(top, meta);
  card.appendChild(header);

  // if (!inSceneStack) {
  //   const modeHint = document.createElement('div');
  //   modeHint.className = 'storyboard-act-board-scene-mode-hint';
  //   modeHint.textContent = 'Double-click blank space to add narration, footage, or sound.';
  //   card.appendChild(modeHint);
  // }

  // Double-clicking the scene name (rather than the whole card) opens the
  // rename prompt. This keeps the card's normal restore/select behavior.
  let restoreClickTimer = null;
  // title.title = 'Double-click to rename scene';
  title.addEventListener('dblclick', event => {
    if (restoreClickTimer) {
      clearTimeout(restoreClickTimer);
      restoreClickTimer = null;
    }
    event.preventDefault();
    event.stopPropagation();
    const prompt = typeof window !== 'undefined' && typeof window.prompt === 'function'
      ? window.prompt('Rename this scene:', scene.title || 'Board scene') : null;
    if (prompt == null) return;
    const nextTitle = String(prompt).trim();
    if (!nextTitle) return;
    scene.title = nextTitle;
    saveDebugSession();
    rerenderActBoard();
  });

  const nodeList = document.createElement('div');
  nodeList.className = 'storyboard-act-board-board-scene-node-list';
  sceneItems.forEach(node => {
    const chip = document.createElement('span');
    chip.className = 'storyboard-act-board-board-scene-node';
    chip.textContent = node.type === 'narration'
      ? 'Narration'
      : node.type === 'audio'
        ? (node.audioKind === 'music' ? 'Music' : 'Sound effects')
        : String(node.fragment || node.query || 'Footage').slice(0, 42);
    chip.title = node.type === 'narration'
      ? String(node.transcript || node.text || 'Narration node')
      : String(node.fragment || node.query || 'Footage node');
    nodeList.appendChild(chip);
  });
  if (nodeList.childElementCount && (inSceneStack || scene.liveNodesCleared !== true)) {
    card.appendChild(nodeList);
  }

  if (inSceneStack) {
    card.addEventListener('click', event => {
      if (event.target.closest('button, input, textarea, select, a')) return;
      // A double-click on the title is reserved for renaming; do not restore
      // twice before the rename prompt opens.
      if (event.detail > 1) return;
      if (restoreClickTimer) clearTimeout(restoreClickTimer);
      restoreClickTimer = setTimeout(() => {
        restoreClickTimer = null;
        restoreActBoardSceneToCanvas(scene);
      }, 350);
    });
    return card;
  }

  header.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button, input, textarea, select, label, a')) return;
    event.preventDefault();
    event.stopPropagation();
    const boardRect = nodeStack.getBoundingClientRect();
    const startX = Number(scene.boardX) || 0;
    const startY = Number(scene.boardY) || 0;
    const offsetX = event.clientX - boardRect.left - nodeStack.scrollLeft - startX;
    const offsetY = event.clientY - boardRect.top - nodeStack.scrollTop - startY;
    const sceneNodeIds = new Set(scene.nodeIds || []);
    const includedNodes = nodes.filter(node => sceneNodeIds.has(node.id));
    const initialNodePositions = new Map(includedNodes.map(node => [node.id, {
      x: Number(node.boardX) || 0,
      y: Number(node.boardY) || 0,
    }]));
    const expandCanvasForScene = () => {
      const sceneHeight = card.offsetHeight || Math.max(116, Number(scene.boardHeight) || 116);
      const sceneBottom = (Number(scene.boardY) || 0) + sceneHeight;
      const currentMinHeight = parseFloat(nodeStack.style.minHeight) || 0;
      nodeStack.style.minHeight = `${Math.max(360, currentMinHeight, sceneBottom + 24)}px`;
    };
    card.classList.add('dragging');
    try { header.setPointerCapture(event.pointerId); } catch (err) { /* optional */ }
    const move = moveEvent => {
      const nextX = Math.max(0, moveEvent.clientX - boardRect.left - nodeStack.scrollLeft - offsetX);
      const nextY = Math.max(0, moveEvent.clientY - boardRect.top - nodeStack.scrollTop - offsetY);
      const deltaX = nextX - startX;
      const deltaY = nextY - startY;
      scene.boardX = nextX;
      scene.boardY = nextY;
      card.style.left = `${nextX}px`;
      card.style.top = `${nextY}px`;
      includedNodes.forEach(node => {
        const initial = initialNodePositions.get(node.id);
        if (!initial) return;
        node.boardX = Math.max(0, initial.x + deltaX);
        node.boardY = Math.max(0, initial.y + deltaY);
        node.boardPositionMode = 'manual';
        const nodeCard = nodeStack.querySelector(`[data-node-id="${node.id}"]`);
        if (nodeCard) {
          nodeCard.style.left = `${node.boardX}px`;
          nodeCard.style.top = `${node.boardY}px`;
        }
      });
      expandCanvasForScene();
      if (nodeStack._actBoardLinkState) refreshActBoardLinkPaths(nodeStack);
    };
    const finish = () => {
      header.removeEventListener('pointermove', move);
      header.removeEventListener('pointerup', finish);
      header.removeEventListener('pointercancel', finish);
      card.classList.remove('dragging');
      try { header.releasePointerCapture(event.pointerId); } catch (err) { /* optional */ }
      // Keep the saved scene snapshot aligned with the live nodes after a
      // grouped drag, so loading the scene later preserves the new layout.
      scene.nodeSnapshots = (scene.nodeSnapshots || []).map(snapshot => {
        const node = includedNodes.find(item => item.id === snapshot.id);
        return node ? snapshotActBoardSceneNode(node) : snapshot;
      });
      expandCanvasForScene();
      saveDebugSession();
    };
    header.addEventListener('pointermove', move);
    header.addEventListener('pointerup', finish);
    header.addEventListener('pointercancel', finish);
  });
  return card;
}

function buildActBoardView(sections, assignmentsByIndex) {
  if (ensureActBoardInitialScenes()) saveDebugSession();
  const board = document.createElement('div');
  board.className = 'storyboard-act-board-view';

  const clearBoardBtn = document.createElement('button');
  clearBoardBtn.type = 'button';
  clearBoardBtn.className = 'btn-secondary storyboard-act-board-clear-board-btn';
  clearBoardBtn.textContent = 'Clear act';
  clearBoardBtn.title = 'Remove all act-board nodes, links, and board-only scenes while keeping Timeline + Scenes and source material';
  const hasBoardNodes = Object.values(actBoardNodes || {})
    .some(nodes => Array.isArray(nodes) && nodes.length)
    || Object.values(actBoardScenes || {})
      .some(scenes => Array.isArray(scenes) && scenes.length);
  clearBoardBtn.disabled = !hasBoardNodes;
  clearBoardBtn.addEventListener('click', event => {
    event.stopPropagation();
    clearActBoard();
  });

  const canvas = document.createElement('div');
  canvas.className = 'storyboard-act-board-canvas';
  const boardLinkLayers = [];
  const actTargets = new Map();

  currentArcSections.forEach((act, actIndex) => {
    const column = document.createElement('section');
    column.className = 'storyboard-act-board-column';
    column.dataset.actKey = act.key;
    column.id = `storyboard-act-board-act-${actIndex + 1}`;
    actTargets.set(act.key, column);

    const columnHeader = document.createElement('div');
    columnHeader.className = 'storyboard-act-board-column-header';
    const columnTitle = document.createElement('h4');
    columnTitle.textContent = `Act ${actIndex + 1}: ${act.label}`;
    const count = document.createElement('span');
    const boardSceneCount = actBoardScenesForAct(act.key).length;
    count.textContent = `${boardSceneCount} board scene${boardSceneCount === 1 ? '' : 's'}`;
    const columnHeaderActions = document.createElement('div');
    columnHeaderActions.className = 'storyboard-act-board-column-header-actions';
    columnHeaderActions.appendChild(count);
    if (actIndex === 0) columnHeaderActions.appendChild(clearBoardBtn);
    const clearLinksBtn = document.createElement('button');
    clearLinksBtn.type = 'button';
    clearLinksBtn.className = 'btn-secondary storyboard-act-board-clear-links-btn';
    clearLinksBtn.textContent = 'Clear links';
    clearLinksBtn.title = 'Disconnect narration, footage, and sound links in the currently open scene';
    const openScene = actBoardOpenSceneForAct(act.key);
    const openSceneIds = new Set([...(openScene?.nodeIds || []),
      ...actBoardNodesForAct(act.key)
        .filter(node => node.sceneId === openScene?.id).map(node => node.id)]);
    const hasLinks = actBoardNodesForAct(act.key)
      .filter(node => openSceneIds.has(node.id))
      .some(node => (node.type === 'narration'
        && (node.footageNodeIds || []).some(id => openSceneIds.has(id)))
        || (node.type === 'footage' && openSceneIds.has(node.narrationNodeId))
        || (node.type === 'footage' && [node.previousFootageNodeId, node.nextFootageNodeId]
          .some(id => openSceneIds.has(id)))
        || (node.type === 'audio' && (openSceneIds.has(node.linkedToNodeId)
          || openSceneIds.has(node.previousAudioNodeId) || openSceneIds.has(node.nextAudioNodeId)))
        || (node.type === 'narration' && (openSceneIds.has(node.previousNarrationNodeId)
          || openSceneIds.has(node.nextNarrationNodeId))));
    clearLinksBtn.disabled = !hasLinks;
    clearLinksBtn.addEventListener('click', event => {
      event.stopPropagation();
      clearActBoardLinks(act.key, `Act ${actIndex + 1}`, {
        sceneId: openScene?.id,
      });
    });
    columnHeaderActions.appendChild(clearLinksBtn);
    columnHeader.appendChild(columnTitle);
    columnHeader.appendChild(columnHeaderActions);
    column.appendChild(columnHeader);

    const nodeHeader = document.createElement('div');
    nodeHeader.className = 'storyboard-act-board-node-header';
    const nodeHeaderLabel = document.createElement('div');
    nodeHeaderLabel.className = 'storyboard-act-board-node-header-label';
    // const nodeTitle = document.createElement('strong');
    // nodeTitle.textContent = 'Act nodes';
    // nodeHeaderLabel.appendChild(nodeTitle);
    const actDescription = String(act.description || '').trim();
    if (actDescription) {
      const description = document.createElement('span');
      description.className = 'storyboard-act-board-node-header-description';
      description.textContent = actDescription;
      nodeHeaderLabel.appendChild(description);
    }
    nodeHeader.appendChild(nodeHeaderLabel);
    // const sceneHint = document.createElement('span');
    // sceneHint.className = 'storyboard-act-board-scene-hint';
    // sceneHint.textContent = 'Drag around nodes to define a scene; a framed board and loadable card are added';
    // nodeHeader.appendChild(sceneHint);
    column.appendChild(nodeHeader);

    // const linkingGuide = document.createElement('div');
    // linkingGuide.className = 'storyboard-act-board-linking-guide';
    // linkingGuide.innerHTML = '<b>Board:</b> double-click blank space to add a narration or footage node. Double-click a source node, follow the temporary path, then double-click a destination node. Narration → footage attaches a shot; footage → footage changes shot order. Click a link path, then press Delete/Backspace to remove it. Drop one footage card onto another to split time, create a split screen, or merge the concepts generatively. Move cards by their blank area; drag the striped corner to resize. Press Esc to cancel.';
    // column.appendChild(linkingGuide);

    const nodeStack = document.createElement('div');
    nodeStack.className = 'storyboard-act-board-node-stack';
    const boardScenes = actBoardScenesForAct(act.key);
    // Migrate older scene boards that were saved before playback belonged to
    // the scene itself. New and restored scene boards always show a playback
    // node immediately, even before narration or footage is added.
    let migratedScenePlayback = false;
    boardScenes.filter(scene => scene.hidden !== true).forEach(scene => {
      const before = actBoardNodesForAct(act.key).some(node =>
        node.type === 'playback' && node.sceneId === scene.id);
      ensureActBoardPlaybackNode(act.key, null, { create: true, sceneId: scene.id });
      if (!before) migratedScenePlayback = true;
    });
    const nodes = actBoardNodesForAct(act.key);
    if (migratedScenePlayback) saveDebugSession();
    ensureActBoardSceneSnapshots(act.key);
    // Defined scenes remain visible as framed boards behind their live nodes;
    // the matching committed card below remains the loadable scene snapshot.
    const canvasScenes = boardScenes.filter(scene => scene.hidden !== true);
    const committedScenes = boardScenes.filter(scene => scene.committedToStack);
    if (!nodes.length) {
      const nodeEmpty = document.createElement('div');
      nodeEmpty.className = 'storyboard-act-board-node-empty';
      nodeEmpty.textContent = boardScenes.length
        ? 'Scene defined — add narration, footage, or sound effects to continue'
        : 'Add a scene to start';
      nodeStack.appendChild(nodeEmpty);
    } else {
      const ordered = orderedActBoardNodes(act.key, nodes);
      layoutActBoardNodeGeometry(act.key, ordered);
      ordered.forEach((node, nodeIndex) => {
        nodeStack.appendChild(buildActBoardNode(act.key, act, node, nodeStack, nodeIndex));
      });
      refineActBoardRenderedGeometry(nodeStack, ordered);
      const maxNodeY = ordered.reduce((max, node, nodeIndex) =>
        Math.max(max, actBoardNodePosition(node, nodeIndex).y
          + (Number(node.boardHeight) > 0 ? Number(node.boardHeight) : (node.type === 'footage' ? 154 : 180))), 0);
      nodeStack.style.minHeight = `${Math.max(360, maxNodeY + 24)}px`;
    }
    const maxSceneBottom = canvasScenes.reduce((max, scene) => Math.max(max,
      (Number(scene.boardY) || 0) + Math.max(116, Number(scene.boardHeight) || 116)), 0);
    nodeStack.style.minHeight = `${Math.max(360, parseFloat(nodeStack.style.minHeight) || 0,
      maxSceneBottom + 24)}px`;
    column.appendChild(nodeStack);
    wireActBoardNodeSpawn(nodeStack, act.key);
    wireActBoardSceneMarquee(nodeStack, act.key);

    const stack = document.createElement('div');
    stack.className = 'storyboard-act-board-stack';
    stack.dataset.actKey = act.key;
    const allowDrop = event => {
      if (!event.dataTransfer.types.includes('application/x-storyboard-board-scene')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      column.classList.add('drop-over');
    };
    const clearDrop = () => column.classList.remove('drop-over');
    const dropOnAct = event => {
      if (!event.dataTransfer.types.includes('application/x-storyboard-board-scene')) return;
      event.preventDefault();
      event.stopPropagation();
      clearDrop();
      const sourceIndex = parseInt(event.dataTransfer.getData('application/x-storyboard-board-scene'), 10);
      if (!Number.isNaN(sourceIndex)) moveSceneOnActBoard(sourceIndex, null, act.key);
    };
    column.addEventListener('dragover', allowDrop);
    column.addEventListener('dragleave', clearDrop);
    column.addEventListener('drop', dropOnAct);

    if (committedScenes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'storyboard-act-board-empty';
      empty.textContent = 'No defined scenes yet';
      stack.appendChild(empty);
    }

    // Defined board scenes are also committed to the act-board card stack.
    // Their node snapshots keep the scene loadable independently of the live
    // canvas nodes.
    canvasScenes.forEach(scene => {
      nodeStack.appendChild(buildActBoardBoardSceneCard(scene, nodes, nodeStack));
    });
    expandActBoardScenesToContainNodes(nodeStack, act.key, nodes);
    // Media/search cards may settle their intrinsic height after the initial
    // append. Re-run once after layout so a spawned footage chain is fully
    // enclosed by its scene board on the first render as well as on resize.
    const expandAfterLayout = () => {
      if (!document.body.contains(nodeStack)) return;
      expandActBoardScenesToContainNodes(nodeStack, act.key, nodes);
      saveDebugSession();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(expandAfterLayout);
    else setTimeout(expandAfterLayout, 0);
    committedScenes.forEach(scene => {
      stack.appendChild(buildActBoardBoardSceneCard(scene, nodes, stack));
    });

    column.appendChild(stack);
    canvas.appendChild(column);
    if (nodes.length) boardLinkLayers.push({ nodeStack, nodes });
  });
  const actJumpNav = document.createElement('nav');
  actJumpNav.className = 'storyboard-act-board-act-jump-nav';
  actJumpNav.setAttribute('aria-label', 'Jump to documentary act');
  const actJumpLabel = document.createElement('span');
  actJumpLabel.className = 'storyboard-act-board-act-jump-label';
  actJumpLabel.textContent = 'Jump to act';
  actJumpNav.appendChild(actJumpLabel);
  currentArcSections.forEach((act, actIndex) => {
    const target = actTargets.get(act.key);
    if (!target) return;
    const jumpButton = document.createElement('button');
    jumpButton.type = 'button';
    jumpButton.className = 'btn-secondary storyboard-act-board-act-jump-btn';
    jumpButton.textContent = `Act ${actIndex + 1}`;
    jumpButton.title = `Jump to Act ${actIndex + 1}: ${act.label || 'Untitled act'}`;
    jumpButton.setAttribute('aria-controls', target.id);
    jumpButton.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      target.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'center' });
    });
    actJumpNav.appendChild(jumpButton);
  });
  board.appendChild(actJumpNav);
  board.appendChild(canvas);
  const renderBoardLinks = () => boardLinkLayers.forEach(({ nodeStack, nodes }) => {
    if (!nodeStack._actBoardLinkState) buildActBoardLinkLayer(nodeStack, nodes);
  });
  const refreshBoardGeometry = () => board.querySelectorAll('.storyboard-act-board-node-stack')
    .forEach(nodeStack => {
      const actKey = nodeStack.closest('.storyboard-act-board-column')?.dataset.actKey;
      if (!actKey) return;
      const nodes = orderedActBoardNodes(actKey, actBoardNodesForAct(actKey));
      layoutActBoardNodeGeometry(actKey, nodes);
      refineActBoardRenderedGeometry(nodeStack, nodes);
      expandActBoardScenesToContainNodes(nodeStack, actKey, nodes);
      if (nodeStack._actBoardLinkState) refreshActBoardLinkPaths(nodeStack);
    });
  if (typeof ResizeObserver === 'function') {
    const resizeObserver = new ResizeObserver(refreshBoardGeometry);
    resizeObserver.observe(canvas);
    board._actBoardResizeObserver = resizeObserver;
  }
  if (typeof window !== 'undefined') {
    if (activeActBoardResizeHandler) {
      window.removeEventListener('resize', activeActBoardResizeHandler);
    }
    activeActBoardResizeHandler = () => {
      if (document.body.contains(board)) refreshBoardGeometry();
    };
    window.addEventListener('resize', activeActBoardResizeHandler);
  }
  // Build the link layer immediately so a fast double-click after the board
  // appears can start a connection. The deferred pass still recalculates
  // paths after the browser has completed layout.
  renderBoardLinks();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(renderBoardLinks);
  else setTimeout(renderBoardLinks, 0);
  return board;
}

// The current render's window scroll listener for highlighting the
// narrative-arc outline entry the presenter's scrolled past - module-level
// so the next renderMovieEditor call can remove it before attaching its
// own (each render tears down and rebuilds every row/outline element, so
// leaving a previous render's listener attached would reference stale,
// already-detached DOM going forward).
let activeOutlineScrollHandler = null;

// storyboard.html's "Source material" sidebar module
// (#source-material-module) - a read-only reference listing of the
// extracted paper sections, kept in sync with currentSections (see the
// call at the end of renderMovieEditor below, and the page-2 branch of
// restoreDebugSession for the first render). Excludes narrativeOnly
// sections (see insertSection) - blank placeholders added for the arc's
// structure, not derived from the paper, shouldn't read as if they were.
// Deliberately not built from buildSectionBlock/renderSectionFeed like
// index.html's own editable feed - every one of those cards' edit/remove/
// upload handlers hardcodes its re-render target to the single shared
// #paper-sections container (the movie editor here), so reusing them in
// this second, simultaneous location would clobber it instead of
// updating this list.
function renderSourceMaterialList() {
  if (!sourceMaterialListEl) return;
  sourceMaterialListEl.innerHTML = '';
  currentSections.filter(section => !section.removed && !section.narrativeOnly).forEach(section => {
    const item = document.createElement('div');
    item.className = 'source-material-item';

    // Draggable onto a section's text field (see buildSectionBlock's drop
    // handler) - a quick way to pull this excerpt into a shot's own
    // working text without retyping it. Carries the section's own stable
    // index, not its text directly - the drop handler looks the current
    // text up fresh from currentSections at drop time, in case it's since
    // been edited.
    item.draggable = true;
    item.addEventListener('dragstart', event => {
      event.dataTransfer.setData('application/x-source-material-index', String(section.index));
      event.dataTransfer.effectAllowed = 'copy';
    });

    const title = document.createElement('div');
    title.className = 'source-material-item-title';
    title.textContent = section.title;
    item.appendChild(title);

    // Delete this source section (moves it to the "Deleted source and scenes"
    // module, where it can be restored). Same removed-flag mechanism scenes use.
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'source-material-item-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Delete this source section (move to Deleted source and scenes)';
    removeBtn.addEventListener('click', event => {
      event.stopPropagation();
      section.removed = true;
      saveDebugSession();
      // renderMovieEditor's tail re-renders both the source and deleted lists.
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      updateComposeStoryboardVisibility();
    });
    item.appendChild(removeBtn);

    if (section.text) {
      const excerpt = document.createElement('div');
      excerpt.className = 'source-material-item-excerpt';
      excerpt.textContent = section.text.length > 140 ? `${section.text.slice(0, 140)}…` : section.text;
      item.appendChild(excerpt);
    }

    sourceMaterialListEl.appendChild(item);
  });
}

// storyboard.html's "Deleted scenes" sidebar module (#deleted-scenes-module)
// - the scenes deleted from the arranged view (see buildSectionBlock's remove
// button, which in the arranged view drops a scene from the timeline and its
// arc row entirely rather than dimming it in place). Each lists a Restore
// button that puts the item back. Source deletion (`removed`) is deliberately
// distinct from timeline deletion (`sceneRemoved`) so clearing the storyboard
// never empties the source-material library. The whole module hides itself
// when nothing is deleted, so it doesn't sit empty in the sidebar. A no-op on
// index.html, which has no such module.
function renderDeletedScenesList() {
  if (!deletedScenesListEl) return;
  deletedScenesListEl.innerHTML = '';
  const deleted = currentSections.filter(section => section.removed || section.sceneRemoved);
  if (deletedScenesModuleEl) deletedScenesModuleEl.style.display = deleted.length ? '' : 'none';

  deleted.forEach(section => {
    const item = document.createElement('div');
    item.className = 'deleted-scene-item';

    const title = document.createElement('div');
    title.className = 'deleted-scene-item-title';
    title.textContent = section.title || '(untitled scene)';
    item.appendChild(title);

    const restoreBtn = document.createElement('button');
    restoreBtn.type = 'button';
    restoreBtn.className = 'btn-secondary deleted-scene-restore-btn';
    restoreBtn.textContent = 'Restore';
    restoreBtn.addEventListener('click', () => {
      section.removed = false;
      section.sceneRemoved = false;
      saveDebugSession();
      // renderMovieEditor re-renders this list from its own tail call, so the
      // restored scene reappears in its arc row/timeline and leaves here.
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      updateComposeStoryboardVisibility();
    });
    item.appendChild(restoreBtn);

    deletedScenesListEl.appendChild(item);
  });
}

function renderMovieEditor(container, label, sections, assignmentsByIndex) {
  // Rebuilding scene timing invalidates every scheduled Web Audio source.
  // Stop the transport before replacing its layout so no old mix continues
  // invisibly against the newly-rendered timeline.
  stopSfxPreview(true);
  activeSfxLayout = null;
  activeSfxSectionIndex = null;
  container.innerHTML = '';

  // Prune any selected index no longer present (excluded/removed) - no more
  // default "select the first section" fallback, since there's no preview
  // left to seed; an empty selection is a perfectly normal starting state.
  selectedSectionIndices.forEach(index => {
    if (!sections.some(s => s.index === index && !s.sceneRemoved)) selectedSectionIndices.delete(index);
  });

  const selectionCount = selectedSectionIndices.size;
  const arranged = sections.filter(s => !s.sceneRemoved && assignmentsByIndex[s.index]);
  const target = selectionCount > 0 ? arranged.filter(s => selectedSectionIndices.has(s.index)) : arranged;

  // Heading row: action buttons pinned to the far right (see
  // .storyboard-heading-row / .storyboard-heading-actions) - "Clear
  // all scenes" then one combined export. Keep the action row mounted for an
  // accepted storyboard even when its timeline is empty: clearing scenes must
  // not make the surrounding controls disappear. Actions that require an
  // active scene are disabled until one is restored or added.
  renderMovieBtn = null;
  renderMovieStatusEl = null;
  renderMovieDownloadEl = null;
  renderMovieOutputUrl = '';
  const headingRow = document.createElement('div');
  headingRow.className = 'storyboard-heading-row';
  let previewAllBtn = null;
  let previewAllStatus = null;
  let clearAllBtn = null;
  if (currentArcSections.length > 0) {
    const actions = document.createElement('div');
    actions.className = 'storyboard-heading-actions';

    // "Preview All" - generate bold shot examples for every arranged scene
    // that doesn't have a visual yet (see runPreviewAllShots). Sits to the LEFT
    // of Clear all scenes.
    previewAllBtn = document.createElement('button');
    previewAllBtn.type = 'button';
    previewAllBtn.id = 'preview-all-btn';
    previewAllBtn.className = 'btn-secondary preview-all-btn';
    previewAllBtn.textContent = 'Generate All';
    previewAllBtn.title = 'Generate shot examples for every arranged scene that has no visual yet';
    previewAllBtn.addEventListener('click', runPreviewAllShots);
    previewAllBtn.disabled = generatingAllShots || arranged.length === 0;
    if (arranged.length === 0) previewAllBtn.title = 'Restore or add a scene before generating previews';
    actions.appendChild(previewAllBtn);
    previewAllStatus = document.createElement('span');
    previewAllStatus.className = 'status-line preview-all-status';
    actions.appendChild(previewAllStatus);

    clearAllBtn = document.createElement('button');
    clearAllBtn.type = 'button';
    clearAllBtn.className = 'btn-secondary clear-all-scenes-btn';
    clearAllBtn.textContent = 'Clear all scenes';
    clearAllBtn.title = 'Move every scene to Deleted scenes while keeping source material';
    clearAllBtn.disabled = arranged.length === 0;
    clearAllBtn.addEventListener('click', () => {
      if (!window.confirm("Clear all scenes from the timeline? They'll move to Deleted scenes, where you can restore them. Your source material will stay available.")) return;
      currentSections.forEach(s => {
        if (currentAssignments[s.index] && !s.removed) {
          cancelSceneGeneration(s);
          s.sceneRemoved = true;
        }
      });
      selectedSectionIndices.clear();
      saveDebugSession();
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
    });
    actions.appendChild(clearAllBtn);

    const renderMovieActionGroup = document.createElement('div');
    renderMovieActionGroup.className = 'render-movie-action-group';
    renderMovieBtn = document.createElement('button');
    renderMovieBtn.type = 'button';
    renderMovieBtn.className = 'btn-primary render-movie-btn';
    renderMovieBtn.textContent = 'Export Premiere + MP4';
    renderMovieBtn.title = 'Write a Premiere edit plan and render the documentary as an MP4, including linked act-board sequences';
    renderMovieBtn.disabled = arranged.length === 0 && !hasActBoardLinkedSequence();
    renderMovieBtn.addEventListener('click', runCombinedExport);
    renderMovieActionGroup.appendChild(renderMovieBtn);

    renderMovieStatusEl = document.createElement('span');
    renderMovieStatusEl.className = 'status-line render-movie-status';
    renderMovieActionGroup.appendChild(renderMovieStatusEl);

    // The MP4 is produced asynchronously. Keep a real download control next
    // to the status instead of making the user copy a server path out of the
    // status text once the render is finished.
    renderMovieDownloadEl = document.createElement('a');
    renderMovieDownloadEl.className = 'render-movie-download';
    renderMovieDownloadEl.textContent = 'Download MP4';
    renderMovieDownloadEl.setAttribute('download', 'documentary.mp4');
    renderMovieDownloadEl.target = '_blank';
    renderMovieDownloadEl.rel = 'noopener';
    renderMovieDownloadEl.hidden = true;
    renderMovieActionGroup.appendChild(renderMovieDownloadEl);
    actions.appendChild(renderMovieActionGroup);

    headingRow.appendChild(actions);
  }
  container.appendChild(headingRow);

  const actionBar = document.createElement('div');
  actionBar.className = 'action-bar';

  const topRow = document.createElement('div');
  topRow.className = 'action-bar-row';

  const countLabel = document.createElement('span');
  countLabel.textContent = selectionCount > 0
    ? `${selectionCount} section${selectionCount === 1 ? '' : 's'} selected`
    : `${arranged.length} section${arranged.length === 1 ? '' : 's'} in the arc`;
  topRow.appendChild(countLabel);

  const storyboardBtn = document.createElement('button');
  storyboardBtn.type = 'button';
  storyboardBtn.className = 'btn-secondary';
  storyboardBtn.textContent = selectionCount > 0 ? 'Generate Storyboard for Selected' : 'Generate Storyboard for All';
  storyboardBtn.addEventListener('click', () => {
    runGenerateStoryboardForSections(target, storyboardBtn);
  });
  topRow.appendChild(storyboardBtn);

  // Inline right next to its button (not stacked below, full-width) so the
  // sticky bar stays thin regardless of status text length.
  const storyboardStatusEl = document.createElement('span');
  storyboardStatusEl.className = 'status-line storyboard-status-line';
  storyboardStatusEl.textContent = storyboardBarStatus.message;
  storyboardStatusEl.classList.toggle('error', storyboardBarStatus.isError);
  topRow.appendChild(storyboardStatusEl);

  const editPlanBtn = document.createElement('button');
  editPlanBtn.type = 'button';
  editPlanBtn.className = 'btn-secondary';
  editPlanBtn.textContent = selectionCount > 0 ? 'Generate Edit Plan for Selected' : 'Generate Edit Plan for All';
  editPlanBtn.addEventListener('click', () => {
    runGenerateEditPlanForSections(target, editPlanBtn);
  });
  topRow.appendChild(editPlanBtn);

  const editPlanStatusEl = document.createElement('span');
  editPlanStatusEl.className = 'status-line edit-plan-status-line';
  editPlanStatusEl.textContent = editPlanBarStatus.message;
  editPlanStatusEl.classList.toggle('error', editPlanBarStatus.isError);
  topRow.appendChild(editPlanStatusEl);

  if (selectionCount > 0) {
    const clearSelectionBtn = document.createElement('button');
    clearSelectionBtn.type = 'button';
    clearSelectionBtn.className = 'btn-secondary';
    clearSelectionBtn.textContent = 'Clear Selection';
    clearSelectionBtn.addEventListener('click', () => {
      selectedSectionIndices.clear();
      renderMovieEditor(resultsEl, currentLabel, sections, assignmentsByIndex);
    });
    topRow.appendChild(clearSelectionBtn);
  }

  actionBar.appendChild(topRow);
  container.appendChild(actionBar);

  const storyboardViewToggle = document.createElement('div');
  storyboardViewToggle.className = 'storyboard-view-toggle';
  const timelineViewBtn = document.createElement('button');
  timelineViewBtn.type = 'button';
  timelineViewBtn.className = 'storyboard-view-toggle-btn';
  timelineViewBtn.dataset.view = 'timeline';
  timelineViewBtn.textContent = 'Timeline + scenes';
  const boardViewBtn = document.createElement('button');
  boardViewBtn.type = 'button';
  boardViewBtn.className = 'storyboard-view-toggle-btn';
  boardViewBtn.dataset.view = 'board';
  boardViewBtn.textContent = 'Act board';
  storyboardViewToggle.appendChild(timelineViewBtn);
  storyboardViewToggle.appendChild(boardViewBtn);
  container.appendChild(storyboardViewToggle);

  // Premiere-style A-roll/B-roll timeline (see buildNarrativeTimeline) -
  // sits above the rows, one act-sized group per arc part with individual
  // clips per section - replaces the old vertical .narrative-arc-outline
  // sidebar as the "jump to a part of the arc" affordance. Built AFTER the
  // row loop below (not interleaved with it), since that loop is what
  // auto-populates any still-empty act with a blank placeholder section -
  // the timeline needs that final, post-auto-populate section list, not
  // the possibly-incomplete one from before the loop runs.
  const arcLayout = document.createElement('div');
  arcLayout.className = 'narrative-arc-layout';
  const boardView = document.createElement('div');
  boardView.className = 'storyboard-act-board-container';

  const timelineEl = document.createElement('div');
  timelineEl.className = 'premiere-timeline';
  arcLayout.appendChild(timelineEl);

  const updateHeight = () => {
    document.documentElement.style.setProperty(
      '--header-height',
      `${timelineEl.offsetHeight}px`
    );
  };

  updateHeight();
  new ResizeObserver(updateHeight).observe(timelineEl);

  // Below the timeline: a sidebar (Documentary techniques) beside the rows.
  const innerLayout = document.createElement('div');
  innerLayout.className = 'narrative-arc-inner-layout';
  arcLayout.appendChild(innerLayout);

  const sidePanel = document.createElement('div');
  sidePanel.className = 'narrative-side-panel';
  innerLayout.appendChild(sidePanel);

  // Documentary modes - a thin, dark strip that lives INSIDE the premiere
  // timeline, above its tracks (inserted after buildNarrativeTimeline builds
  // the timeline - see below). Label, chips, and a hint all sit on one row so
  // the strip stays short. Each chip both clicks (sets the global stylistic
  // mode for storyboard/edit-plan generation) AND drags onto a timeline act
  // to scaffold that act's scenes (see makeActModeDropTarget / scaffoldModeOntoAct).
  const modesBlock = document.createElement('div');
  modesBlock.className = 'documentary-modes-bar';

  const modesTitle = document.createElement('span');
  modesTitle.className = 'documentary-modes-bar-title';
  modesTitle.textContent = 'Documentary layouts';
  modesBlock.appendChild(modesTitle);

  const modesRow = document.createElement('div');
  modesRow.className = 'chip-row documentary-modes-bar-row';
  modesBlock.appendChild(modesRow);

  DOCUMENTARY_MODES.forEach(mode => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip suggested chip-draggable';
    chip.classList.toggle('selected', selectedDocumentaryMode === mode.key);
    chip.textContent = mode.label;
    chip.title = `${mode.description} — drag onto a timeline act to scaffold its scenes`;
    chip.addEventListener('click', () => {
      // Toggle, same as the technique chips below - clicking the
      // already-active mode clears back to "no mode chosen."
      selectedDocumentaryMode = selectedDocumentaryMode === mode.key ? null : mode.key;
      modesRow.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
      chip.classList.toggle('selected', selectedDocumentaryMode === mode.key);
      // Picking a mode is the other half of triggerFindFootageSweep's
      // precondition (alongside a drafted storyboard) - a no-op here if
      // there's no storyboard yet.
      triggerFindFootageSweep();
      // selectedDocumentaryMode is deliberately not persisted (see its own
      // comment) - no saveDebugSession call here, same as the arc-template/
      // arc-suggestion picks it's grouped with.
    });
    // Draggable onto a timeline act (see buildNarrativeTimeline's
    // makeActModeDropTarget) to scaffold that act's scenes from this mode.
    chip.draggable = true;
    chip.addEventListener('dragstart', event => {
      event.dataTransfer.setData('application/x-documentary-mode', mode.key);
      event.dataTransfer.effectAllowed = 'copy';
    });
    modesRow.appendChild(chip);
  });

  const modesHint = document.createElement('span');
  modesHint.className = 'documentary-modes-bar-hint';
  modesHint.textContent = 'Drag onto an act to scaffold its scenes.';
  modesBlock.appendChild(modesHint);

  // Standard filmmaking techniques and moodboard-distilled suggestions are
  // separate toggleable views so the provenance of a technique is always
  // clear. The moodboard view is intentionally first/default.
  const techniquesBlock = document.createElement('div');
  techniquesBlock.className = 'narrative-arc-techniques';

  const techniquesTitle = document.createElement('span');
  techniquesTitle.textContent = 'Documentary techniques';
  techniquesBlock.appendChild(techniquesTitle);

  const techniqueViewToggle = document.createElement('div');
  techniqueViewToggle.className = 'technique-view-toggle';
  const moodboardViewBtn = document.createElement('button');
  moodboardViewBtn.type = 'button';
  moodboardViewBtn.className = 'technique-view-toggle-btn';
  moodboardViewBtn.setAttribute('aria-label', 'Show moodboard-distilled techniques');
  moodboardViewBtn.title = 'Moodboard distilled techniques';
  const standardViewBtn = document.createElement('button');
  standardViewBtn.type = 'button';
  standardViewBtn.className = 'technique-view-toggle-btn';
  standardViewBtn.setAttribute('aria-label', 'Show standard filmmaking toolkit');
  standardViewBtn.title = 'Standard filmmaking toolkit';
  techniqueViewToggle.appendChild(moodboardViewBtn);
  techniqueViewToggle.appendChild(standardViewBtn);
  techniquesBlock.appendChild(techniqueViewToggle);

  const moodboardView = document.createElement('div');
  moodboardView.className = 'technique-view technique-view-moodboard';
  const standardView = document.createElement('div');
  standardView.className = 'technique-view technique-view-standard';
  // Moodboard distilled is appended first so it remains the first view for
  // keyboard navigation and for narrow layouts.
  techniquesBlock.appendChild(moodboardView);
  techniquesBlock.appendChild(standardView);

  const updateTechniqueView = () => {
    const moodboardActive = techniquePanelView === 'moodboard';
    moodboardView.style.display = moodboardActive ? '' : 'none';
    standardView.style.display = moodboardActive ? 'none' : '';
    moodboardViewBtn.classList.toggle('active', moodboardActive);
    standardViewBtn.classList.toggle('active', !moodboardActive);
    moodboardViewBtn.setAttribute('aria-selected', String(moodboardActive));
    standardViewBtn.setAttribute('aria-selected', String(!moodboardActive));
    moodboardViewBtn.setAttribute('aria-pressed', String(moodboardActive));
    standardViewBtn.setAttribute('aria-pressed', String(!moodboardActive));
  };
  moodboardViewBtn.addEventListener('click', () => {
    techniquePanelView = 'moodboard';
    updateTechniqueView();
  });
  standardViewBtn.addEventListener('click', () => {
    techniquePanelView = 'standard';
    updateTechniqueView();
  });

  const standardHeading = document.createElement('div');
  standardHeading.className = 'technique-source-label standard';
  standardHeading.textContent = 'Standard filmmaking toolkit';
  standardView.appendChild(standardHeading);
  const standardHint = document.createElement('div');
  standardHint.className = 'chip-row-caption';
  standardHint.textContent = 'Common composition, movement, and lighting choices. Drag onto scenes to apply.';
  standardView.appendChild(standardHint);

  STANDARD_TECHNIQUE_GROUPS.forEach(group => {
    const catLabel = document.createElement('div');
    catLabel.className = 'technique-category-label';
    catLabel.textContent = group.label;
    standardView.appendChild(catLabel);
    const row = document.createElement('div');
    row.className = 'chip-row';
    group.techniques.forEach(technique => row.appendChild(buildTechniqueChip(technique, {
      selectable: false,
      standard: true,
      moodboardDerived: selectedTechniques.has(technique),
    })));
    standardView.appendChild(row);
  });

  const moodboardHeading = document.createElement('div');
  moodboardHeading.className = 'technique-source-label moodboard';
  moodboardHeading.textContent = 'Distilled from your moodboard';
  moodboardView.appendChild(moodboardHeading);
  const techniquesHint = document.createElement('div');
  techniquesHint.className = 'chip-row-caption';
  techniquesHint.textContent = 'Moodboard-specific suggestions. Click to include/exclude, or drag onto scenes.';
  moodboardView.appendChild(techniquesHint);

  // Keep the complete distilled set in its own view, including techniques that
  // also appear in the standard toolkit. The standard view separately marks
  // those overlaps so their provenance remains visible in either view.
  const selectedByCategory = new Map();
  Array.from(selectedTechniques)
    .forEach(technique => {
      const cat = TECHNIQUE_CATEGORY[technique] || 'other';
      if (!selectedByCategory.has(cat)) selectedByCategory.set(cat, []);
      selectedByCategory.get(cat).push(technique);
    });
  [...TECHNIQUE_CATEGORY_ORDER, { key: 'other', label: 'Other' }].forEach(({ key, label }) => {
    const items = selectedByCategory.get(key);
    if (!items || !items.length) return;
    const catLabel = document.createElement('div');
    catLabel.className = 'technique-category-label';
    catLabel.textContent = label;
    moodboardView.appendChild(catLabel);
    const row = document.createElement('div');
    row.className = 'chip-row';
    items.forEach(technique => row.appendChild(buildTechniqueChip(technique)));
    moodboardView.appendChild(row);
  });
  if (!selectedTechniques.size) {
    const emptyMoodboard = document.createElement('div');
    emptyMoodboard.className = 'technique-source-empty';
    emptyMoodboard.textContent = 'Add a moodboard reference to see distilled techniques here.';
    moodboardView.appendChild(emptyMoodboard);
  }
  // Keep the distilled moodboard rationale with the techniques it explains,
  // rather than placing it in the timeline's layout strip.
  if (distilledStyleRationale) {
    const rationaleEl = document.createElement('div');
    rationaleEl.className = 'distilled-style-rationale llm-generated';
    const rationaleLabel = document.createElement('strong');
    rationaleLabel.textContent = 'Moodboard styles:';
    rationaleEl.appendChild(rationaleLabel);
    rationaleEl.appendChild(document.createTextNode(` ${distilledStyleRationale}`));
    moodboardView.appendChild(rationaleEl);
  }
  updateTechniqueView();
  sidePanel.appendChild(techniquesBlock);

  // "Preview All" (generates shot examples for every empty scene) lives in the
  // storyboard heading actions now - see the heading row above.

  const arcRows = document.createElement('div');
  arcRows.className = 'narrative-arc-rows';
  innerLayout.appendChild(arcRows);

  currentArcSections.forEach((act, actIdx) => {
    let rowSections = sections.filter(s => !s.sceneRemoved && assignmentsByIndex[s.index] === act.key);
    const actHasDeletedScenes = currentSections.some(s =>
      assignmentsByIndex[s.index] === act.key && (s.removed || s.sceneRemoved));

    // A never-populated act gets one functional starter scene. If the act is
    // empty because its scenes were deliberately deleted, leave it empty;
    // recreating a blank here would make Clear all scenes undo itself and
    // would trigger narration autofill again after a refresh.
    if (rowSections.length === 0 && !actHasDeletedScenes) {
      const blank = insertSection(-1, 'New Scene', '', act.key, true);
      sections.push(blank);
      rowSections = [blank];
      saveDebugSession();
    }

    // A heading (title + short description of what this part should
    // illustrate) sits above the row, rather than as a side label running
    // the row's full height - reads more like a section heading than a
    // vertical label column.
    const rowGroup = document.createElement('div');
    rowGroup.className = 'narrative-act-row-group';

    const heading = document.createElement('div');
    heading.className = 'narrative-act-heading';
    const actTitle = document.createElement('div');
    actTitle.className = 'narrative-act-title';
    actTitle.textContent = `Act ${actIdx + 1}: ${act.label}`;
    heading.appendChild(actTitle);
    // The arc part's description moved into each scene's narration line (the
    // narration instructions - see buildSectionBlock), so it's no longer
    // shown here in the act heading.
    rowGroup.appendChild(heading);

    const row = document.createElement('div');
    row.className = 'narrative-act-row';
    // preventDefault so a drop is allowed, but deliberately NO drag-over
    // outline on the row itself (the presenter found the row-level highlight
    // noisy - the scene cards / notes still highlight on their own).
    row.addEventListener('dragover', event => { event.preventDefault(); });
    row.addEventListener('drop', event => {
      // A paper section dragged from the Source material module onto an act
      // feeds its text into that act's FIRST scene's Scene Notes, rather than
      // becoming its own scene (see appendSectionTextToFirstScene). Everything
      // else (a scene chip being reordered/reassigned) goes to handleChipDrop.
      const sourceIdxRaw = event.dataTransfer.getData('application/x-source-material-index');
      if (sourceIdxRaw !== '') {
        event.preventDefault();
        const src = currentSections.find(s => s.index === parseInt(sourceIdxRaw, 10));
        if (src && appendSectionTextToFirstScene(act.key, src)) {
          saveDebugSession();
          const remaining = currentSections.filter(s => !s.removed);
          renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
        }
        return;
      }
      handleChipDrop(event, act.key);
    });
    rowGroup.appendChild(row);

    const rowCards = document.createElement('div');
    rowCards.className = 'narrative-act-row-cards';

    // Compact chip strip - a smaller, quicker click target alongside each
    // section's full card below, both funneling into the same
    // handleSectionClick selection (see buildArcRowChip).
    const chips = document.createElement('div');
    chips.className = 'narrative-act-row-chips';
    rowSections.forEach(section => chips.appendChild(buildArcRowChip(section)));
    rowCards.appendChild(chips);

    rowSections.forEach(section => rowCards.appendChild(buildSectionBlock(section, true)));

    const addSectionBtn = document.createElement('button');
    addSectionBtn.type = 'button';
    addSectionBtn.className = 'add-section-btn';
    addSectionBtn.textContent = '+ Add Scene';
    addSectionBtn.addEventListener('click', () => {
      const lastInRow = rowSections[rowSections.length - 1];
      insertSection(lastInRow ? lastInRow.index : -1, 'New Scene', '', act.key, true);
      const remaining = currentSections.filter(section => !section.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      saveDebugSession();
    });
    rowCards.appendChild(addSectionBtn);

    row.appendChild(rowCards);

    arcRows.appendChild(rowGroup);
  });

  // Now that every act's row has its final section list (including any
  // just-auto-populated blanks above), build the timeline against it.
  const timelineBuild = buildNarrativeTimeline(
    timelineEl,
    sections.filter(section => !section.sceneRemoved),
    assignmentsByIndex
  );
  const clipsBySectionIndex = timelineBuild.clipsBySectionIndex;
  const timelineLayout = timelineBuild.layout;

  boardView.appendChild(buildActBoardView(
    sections.filter(section => !section.sceneRemoved),
    assignmentsByIndex
  ));

  const updateStoryboardView = () => {
    const boardActive = storyboardView === 'board';
    arcLayout.style.display = boardActive ? 'none' : '';
    boardView.style.display = boardActive ? '' : 'none';
    // Generate All and Clear all scenes belong to Timeline + scenes. Keep
    // them out of the Act Board header without hiding the export controls.
    if (previewAllBtn) previewAllBtn.style.display = boardActive ? 'none' : '';
    if (previewAllStatus) previewAllStatus.style.display = boardActive ? 'none' : '';
    if (clearAllBtn) clearAllBtn.style.display = boardActive ? 'none' : '';
    timelineViewBtn.classList.toggle('active', !boardActive);
    boardViewBtn.classList.toggle('active', boardActive);
    timelineViewBtn.setAttribute('aria-pressed', String(!boardActive));
    boardViewBtn.setAttribute('aria-pressed', String(boardActive));
    if (boardActive) {
      const refreshVisibleBoardLinks = () => boardView.querySelectorAll('.storyboard-act-board-node-stack')
        .forEach(stack => {
          const actKey = stack.closest('.storyboard-act-board-column')?.dataset.actKey;
          if (actKey) {
            const nodes = orderedActBoardNodes(actKey, actBoardNodesForAct(actKey));
            layoutActBoardNodeGeometry(actKey, nodes);
            refineActBoardRenderedGeometry(stack, nodes);
          }
          if (stack._actBoardLinkState) refreshActBoardLinkPaths(stack);
        });
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(refreshVisibleBoardLinks);
      else setTimeout(refreshVisibleBoardLinks, 0);
    }
  };
  timelineViewBtn.addEventListener('click', () => {
    storyboardView = 'timeline';
    updateStoryboardView();
  });
  boardViewBtn.addEventListener('click', () => {
    storyboardView = 'board';
    updateStoryboardView();
  });
  updateStoryboardView();

  // The Documentary modes strip lives INSIDE the timeline, above its ruler/
  // tracks - inserted here (not earlier) because buildNarrativeTimeline clears
  // timelineEl's contents when it (re)builds the ruler and tracks.
  const timelineHeader = timelineEl.querySelector('.premiere-timeline-header');
  timelineEl.insertBefore(modesBlock, timelineHeader ? timelineHeader.nextSibling : timelineEl.firstChild);

  container.appendChild(arcLayout);
  container.appendChild(boardView);

  const selectedCard = container.querySelector('.narrative-act-row-cards .paper-section-block.selected');
  if (selectedCard) selectedCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Highlights whichever section's timeline clips the presenter's
  // currently scrolled past - the last section block whose top has
  // crossed above OUTLINE_ACTIVE_THRESHOLD_PX (roughly where
  // .premiere-timeline's own sticky top sits, just below the sticky
  // .action-bar above it), same idea as a typical scrollspy table of
  // contents - just keyed per section now instead of per act, so the
  // timeline can highlight the specific shot scrolled past rather than
  // just its whole act. A fresh render tears down and rebuilds every row/
  // timeline element, so the previous render's listener (still closed
  // over its now-detached elements) is removed first.
  if (activeOutlineScrollHandler) {
    window.removeEventListener('scroll', activeOutlineScrollHandler);
    activeOutlineScrollHandler = null;
  }
  const sectionScrollEntries = Array.from(arcRows.querySelectorAll('.paper-section-block[data-section-index]'))
    .map(block => {
      const clips = clipsBySectionIndex.get(parseInt(block.dataset.sectionIndex, 10));
      return clips ? { block, clips } : null;
    })
    .filter(Boolean);
  if (sectionScrollEntries.length > 0) {
    const updateActiveTimelineClip = () => {
      let activeEntry = sectionScrollEntries[0];
      sectionScrollEntries.forEach(entry => {
        if (entry.block.getBoundingClientRect().top <= OUTLINE_ACTIVE_THRESHOLD_PX) activeEntry = entry;
      });
      sectionScrollEntries.forEach(entry => {
        const isActive = entry === activeEntry;
        entry.clips.forEach(clip => clip.classList.toggle('active', isActive));
      });
      const activeIndex = parseInt(activeEntry.block.dataset.sectionIndex, 10);
      if (activeSfxSectionIndex !== activeIndex) {
        activeSfxSectionIndex = activeIndex;
        if (!sfxPreviewEnabled) {
          timelinePreviewPausedTime = null;
          timelinePreviewPausedSectionIndex = null;
        }
        const start = timelineLayout.sceneStartSeconds.get(activeIndex);
        const autoFollowing = performance.now() < timelinePreviewProgrammaticScrollUntil;
        if (sfxPreviewEnabled && start != null && !autoFollowing) startSfxPreviewAt(start);
        else if (start != null) updateSfxPlayhead(start);
      }
    };
    let ticking = false;
    activeOutlineScrollHandler = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        updateActiveTimelineClip();
        ticking = false;
      });
    };
    window.addEventListener('scroll', activeOutlineScrollHandler, { passive: true });
    updateActiveTimelineClip();
  }

  // Keeps the sidebar's read-only listing in sync with every change that
  // lands here too (a section added/reassigned from within this page, an
  // exclude toggled, text edited, ...) - a no-op on index.html, which never
  // calls renderMovieEditor in the first place.
  renderSourceMaterialList();
  renderDeletedScenesList();
}

// --- Rendering: a section block is the same clickable unit whether it's
// sitting in the flat feed or inside one of the narrative-arc columns -
// its removability doesn't depend on which container it's in. Once a
// storyboard has been generated, it also grows a Visual/Narration sub-block.
function appendStoryboardLine(container, label, text) {
  const line = document.createElement('div');
  line.className = 'paper-section-storyboard-line';
  const labelEl = document.createElement('span');
  labelEl.className = 'paper-section-storyboard-label';
  labelEl.textContent = `${label}: `;
  line.appendChild(labelEl);
  line.appendChild(document.createTextNode(text));
  container.appendChild(line);
}

// --- Stock media ("Find Footage"): fetched on demand per section, not
// cached - re-clicking the button re-fetches rather than restoring a saved
// result set. The *selection* (section.selectedVideo/selectedAudio) does
// persist on the section object, same as visual/narration/entities, so it
// survives the results row disappearing on the next unrelated re-render.
// Turns a scene's title/notes/narration into filmable stock-search phrases
// (video_query/audio_query) when it doesn't have them yet - the storyboard
// LLM step (storyboard_llm.py) exists precisely to translate academic content
// into something a camera could capture (never jargon/entity names). Resolves
// once section.videoQuery/audioQuery are populated. Falls back to the scene
// title if there's nothing to derive from or the LLM call fails, so Find
// Footage always has *something* to search.
function ensureFootageQueries(section) {
  if (section.videoQuery && section.audioQuery) return Promise.resolve();

  const applyFallback = () => {
    section.videoQuery = section.videoQuery || (section.title || '').trim() || 'documentary b-roll';
    section.audioQuery = section.audioQuery || (section.title || '').trim() || 'ambience';
  };

  const content = [section.text, effectiveSectionNarration(section), section.footageSubject, findAbstractText()]
    .filter(part => part && part.trim()).join('\n\n').trim();
  if (!content) {
    applyFallback();
    return Promise.resolve();
  }

  const act = currentArcSections.find(a => a.key === currentAssignments[section.index]);
  return fetchMediaQueries({
    title: section.title || 'Documentary scene',
    act: act ? act.label : '',
    scene_notes: sectionCompositionNotes(section),
    techniques: sceneTechniques(section),
    narration: effectiveSectionNarration(section),
    narration_entities: section.entities || [],
    reference_footage_description: section.footageSubject || '',
    reference_footage_entities: section.footageEntities || [],
    abstract: findAbstractText(),
    documentary_mode: selectedDocumentaryMode,
  })
    .then(result => {
      section.videoQuery = section.videoQuery || result.video_query;
      section.audioQuery = section.audioQuery || result.audio_query;
      applyFallback();
      saveDebugSession();
    })
    .catch(() => { applyFallback(); }); // LLM down - still search on the title
}

// Freesound audio search is paused for now (per request) - Find Footage only
// searches video. Flip back to true to re-enable the audio (sound-effect)
// options row; the backend /media/search_audio route + fetchAudioOptions are
// left in place.
const FIND_FOOTAGE_INCLUDE_AUDIO = false;

function runFindFootage(section, resultsEl, statusEl, btn, queryInput, pairedQueryInput) {
  btn.disabled = true;
  statusEl.textContent = section.videoQuery
    ? 'Searching for video options...'
    : 'Finding searchable terms, then searching...';
  statusEl.classList.remove('error');

  // Returned (not fire-and-forget) so triggerFindFootageSweep can throttle
  // how many of these run at once across a whole sweep. Derives search phrases
  // first if the scene doesn't have them yet (see ensureFootageQueries).
  return ensureFootageQueries(section).then(() => {
    if (queryInput) queryInput.value = section.videoQuery || '';
    if (pairedQueryInput) pairedQueryInput.value = section.audioQuery || '';
    const fetches = [fetchVideoOptions(section.videoQuery, getSceneDuration(section))];
    if (FIND_FOOTAGE_INCLUDE_AUDIO) fetches.push(fetchAudioOptions(section.audioQuery));
    return Promise.allSettled(fetches);
  }).then((results) => {
    const [videoResult, audioResult] = results;
    resultsEl.innerHTML = '';

    if (videoResult.status === 'fulfilled') {
      const videoRow = document.createElement('div');
      videoRow.className = 'media-video-options';
      videoResult.value.videos.forEach(video => videoRow.appendChild(buildMediaVideoOption(section, video)));
      resultsEl.appendChild(videoRow);
    }

    if (audioResult && audioResult.status === 'fulfilled') {
      const audioRow = document.createElement('div');
      audioRow.className = 'media-audio-options';
      audioResult.value.audio.forEach(audio => audioRow.appendChild(buildMediaAudioOption(section, audio)));
      resultsEl.appendChild(audioRow);
    }

    const errors = results
      .filter(result => result.status === 'rejected')
      .map(result => result.reason.message);
    if (errors.length) {
      statusEl.textContent = errors.join(' ');
      statusEl.classList.add('error');
    } else {
      statusEl.textContent = '';
    }

    btn.disabled = false;
  });
}

// A picked documentary mode plus a drafted storyboard is enough context to
// go looking for B-roll automatically, rather than making the
// presenter click "Find footage" on every section by hand - fires from
// both the mode-chip handler and runGenerateStoryboardForSections' success
// callback (see their own call sites), since either one might complete
// second; a no-op here if the other precondition isn't met yet.
//
// Locates each qualifying section's already-rendered Find Footage button/
// status/results elements by selector rather than duplicating
// buildSectionBlock's closures - runFindFootage already needs exactly
// those three DOM nodes, this just finds the ones "Find footage" itself
// would have used.
const FIND_FOOTAGE_SWEEP_CONCURRENCY = 3;

function triggerFindFootageSweep() {
  if (!selectedDocumentaryMode) return;

  const queue = currentSections.filter(section =>
    isSceneActive(section) &&
    currentAssignments[section.index] &&
    section.videoQuery &&
    !section.selectedVideo
  );
  if (queue.length === 0) return;

  const runNext = () => {
    const section = queue.shift();
    if (!section) return Promise.resolve();

    const block = resultsEl.querySelector(`.paper-section-block[data-section-index="${section.index}"]`);
    const btn = block && block.querySelector('.find-footage-btn');
    const mediaResults = block && block.querySelector('.paper-section-media');
    const statusEl = block && block.querySelector('.find-footage-status');
    // Already mid-search (a manual click raced this sweep) or the block
    // isn't on screen (e.g. scrolled out and not yet built) - either way,
    // nothing to do for this section; move on rather than stall the queue.
    if (!btn || btn.disabled || !mediaResults || !statusEl) return runNext();

    return runFindFootage(section, mediaResults, statusEl, btn).then(runNext);
  };

  for (let i = 0; i < FIND_FOOTAGE_SWEEP_CONCURRENCY; i++) runNext();
}

// Uploading a visual reference is itself a request for shot possibilities.
// Re-find the freshly rendered controls because the upload success path
// rebuilds the scene card and the old button/status elements are detached.
function autoGenerateExamplesAfterUpload(section) {
  if (!isSceneActive(section) || !currentAssignments[section.index]) return;
  const block = resultsEl && resultsEl.querySelector(
    `.paper-section-block[data-section-index="${section.index}"]`);
  const btn = block && block.querySelector('.generate-shot-examples-btn');
  const statusEl = block && block.querySelector('.find-footage-status');
  if (!btn || !statusEl || btn.disabled) return;
  runGenerateShotExamples(section, btn, statusEl);
}

function resetGeneratedVisualsForReferenceUpload(section) {
  // A new reference should not be masked by a previously selected example,
  // shot frame, sketch, or animated preview. The next examples batch becomes
  // the scene's visual-box content.
  section.exampleShots = null;
  section.selectedExample = null;
  section.shots = null;
  section.startFramePreviewUrl = null;
  section.endFramePreviewUrl = null;
  section.animatedSketchPreviewUrl = null;
  section.animatedSketchThumbnailUrl = null;
  section.sketchPreviewUrl = null;
  section.visualSource = null;
}

// Modern examples/video selections replace the old generated start/end-frame
// shot. Keep the legacy fields for genuinely legacy `runGenerateShot` output,
// but clear them whenever the user enters the examples workflow so exports
// and the visual-box fallback cannot accidentally resurrect shotFrames().
function clearLegacyShotFrames(section) {
  section.shots = null;
  section.startFramePreviewUrl = null;
  section.endFramePreviewUrl = null;
  section.shotFramesGeneratedAt = null;
}

// --- Premiere Pro (UXP) file-based bridge: uploading a researcher's own
// footage for a shot, and exporting the whole arc's edit plan - see
// backend/premiere_bridge.py for why this is file-based rather than a
// network call in both directions (macOS restricts plain http:// for a UXP
// plugin's own outbound requests; local file access has no such restriction).
function runUploadFootage(section, file, labelEl, inputEl) {
  cancelSceneGeneration(section);
  inputEl.disabled = true;
  labelEl.textContent = `Uploading "${file.name}"...`;
  labelEl.classList.remove('error');

  fetchUploadFootage(file, section.index, premiereProjectId)
    .then(({ project_id, footage_path, preview_url, thumbnail_url, footage_subject }) => {
      premiereProjectId = project_id;
      section.uploadedFootagePath = footage_path;
      // A one-sentence read of what the presenter filmed, so future generated
      // shot examples/videos for this scene match that subject (see
      // runGenerateShotExamples / runGenerateShot / runGenerateShotVideo).
      // Always replace the cached anchor as well. Keeping the old description
      // when analysis of replacement footage fails would make future previews
      // depict the previous upload—the exact opposite of footage priority.
      section.footageSubject = (footage_subject || '').trim();
      // Servable by the static file server (see backend/server.py's
      // /premiere/upload_footage) - lets buildVisualBox actually play back
      // whatever was just uploaded/recorded, not just show its filename.
      section.uploadedFootagePreviewUrl = preview_url || null;
      section.uploadedFootageThumbnailUrl = thumbnail_url || null;
      section.footageOrigin = 'upload';
      // The shared upload box represents one active user reference. Replacing
      // a sketch with footage removes the previous sketch reference.
      section.uploadedSketchPath = null;
      section.uploadedSketchPreviewUrl = null;
      section.uploadedSketchUploadedAt = null;
      resetGeneratedVisualsForReferenceUpload(section);
      // Recording/uploading footage is a deliberate choice - it should
      // always be what the visual box shows next, regardless of whatever
      // was picked/generated before it (see buildVisualBox's visualSource
      // lookup).
      section.visualSource = 'video';
      saveDebugSession();
      // Full re-render (rather than just updating labelEl in place) so the
      // visual box picks up the upload immediately - see buildVisualBox.
      if (currentAssignments[section.index]) {
        const remaining = currentSections.filter(s => !s.removed);
        renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      } else {
        renderSectionFeed(resultsEl, currentLabel, currentSections);
      }
      autoGenerateExamplesAfterUpload(section);
    })
    .catch(err => {
      labelEl.textContent = err.message;
      labelEl.classList.add('error');
      inputEl.disabled = false;
    });
}

function runUploadSketch(section, file, labelEl, inputEl) {
  cancelSceneGeneration(section);
  inputEl.disabled = true;
  labelEl.textContent = `Uploading sketch "${file.name}"...`;
  labelEl.classList.remove('error');
  fetchUploadSketch(file, section.index, premiereProjectId)
    .then(({ project_id, sketch_path, preview_url, sketch_subject, footage_subject }) => {
      premiereProjectId = project_id;
      section.uploadedSketchPath = sketch_path;
      section.uploadedSketchPreviewUrl = preview_url;
      section.uploadedSketchUploadedAt = Date.now();
      // The shared upload box represents one active user reference. Replacing
      // footage with a sketch removes the previous footage reference.
      section.uploadedFootagePath = null;
      section.uploadedFootagePreviewUrl = null;
      section.uploadedFootageThumbnailUrl = null;
      section.footageOrigin = 'upload';
      // The sketch upload route now runs the same best-effort vision subject
      // description as footage uploads. Keep it editable in the open slot.
      section.footageSubject = (sketch_subject || footage_subject || '').trim();
      resetGeneratedVisualsForReferenceUpload(section);
      section.visualSource = 'uploadedSketch';
      saveDebugSession();
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      autoGenerateExamplesAfterUpload(section);
    })
    .catch(err => {
      labelEl.textContent = err.message;
      labelEl.classList.add('error');
      inputEl.disabled = false;
    });
}

function readActBoardVideoDuration(previewUrl) {
  return new Promise(resolve => {
    if (!previewUrl) { resolve(0); return; }
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.addEventListener('loadedmetadata', () => {
      const duration = Number(video.duration);
      resolve(Number.isFinite(duration) && duration > 0 ? duration : 0);
      video.removeAttribute('src');
      video.load();
    }, { once: true });
    video.addEventListener('error', () => resolve(0), { once: true });
    video.src = previewUrl;
  });
}

async function uploadActBoardNodeMedia(actKey, node, section, file, statusEl, inputEl) {
  if (!node || !section || !file) return;
  inputEl.disabled = true;
  statusEl.textContent = `Uploading "${file.name}"…`;
  statusEl.classList.remove('error');
  node.status = 'uploading';
  node.error = '';
  saveDebugSession();
  try {
    const looksLikeImage = (file.type && file.type.startsWith('image/'))
      || /\.(png|jpe?g|webp)$/i.test(file.name || '');
    if (looksLikeImage) {
      const uploaded = await fetchUploadSketch(file, section.index, premiereProjectId);
      premiereProjectId = uploaded.project_id || premiereProjectId;
      node.uploadedFilePath = uploaded.sketch_path || null;
      node.mediaUrl = uploaded.preview_url || '';
      node.mediaThumbnailUrl = uploaded.preview_url || '';
      node.mediaKind = 'image';
      node.mediaOrigin = 'upload';
      node.selectedVisualKey = 'upload';
      node.selectedGeneratedIndex = null;
      node.selectedResultIndex = null;
    } else {
      const uploaded = await fetchUploadFootage(file, section.index, premiereProjectId);
      premiereProjectId = uploaded.project_id || premiereProjectId;
      node.uploadedFilePath = uploaded.footage_path || null;
      node.mediaUrl = uploaded.preview_url || '';
      node.mediaThumbnailUrl = uploaded.thumbnail_url || uploaded.preview_url || '';
      node.mediaKind = 'video';
      node.mediaOrigin = 'upload';
      node.selectedVisualKey = 'upload';
      node.selectedGeneratedIndex = null;
      node.selectedResultIndex = null;
      node.footageSubject = (uploaded.footage_subject || '').trim();
      const duration = await readActBoardVideoDuration(node.mediaUrl);
      if (duration > 0) {
        node.sourceDurationSeconds = Number(duration.toFixed(2));
        node.trimStartSeconds = 0;
        node.durationSeconds = Number(duration.toFixed(2));
        node.durationWasSuggested = false;
        // Preserve the uploaded clip's real length until the presenter edits
        // the track manually; narration alignment can still be changed later.
        node.timingWasManuallyAdjusted = true;
      }
    }
    node.status = 'ready';
    node.error = '';
    statusEl.textContent = '';
    saveDebugSession();
    rerenderActBoard();
  } catch (err) {
    node.status = 'error';
    node.error = `Could not upload footage: ${err.message}`;
    statusEl.textContent = node.error;
    statusEl.classList.add('error');
    saveDebugSession();
    rerenderActBoard();
  } finally {
    inputEl.disabled = false;
  }
}
//#endregion

//#region --- YOUR MEDIA (storyboard.html only)
// a running collection of
// supplementary reference audio/video the presenter records or uploads in
// #media-bank-module, separate from (in addition to) the one documentary-
// intent narration recorded on index.html. Each item just holds enough to
// play it back (a disk-served preview_url, same convention as footage/
// narration elsewhere in this file) - never re-fetched/decoded through the
// Web Audio API the way the intent narration is, since a plain <audio>/
// <video src> already handles arbitrary-length playback natively and none
// of this needs a waveform or proportional timing. Starts pre-populated
// with MEDIA_BANK_ASSET_DEFAULTS above rather than restored from a saved
// session (see restoreDebugSession, which doesn't touch this) - a
// deliberate reset ("for now"), not persisted per-session state.
let mediaBankItems = MEDIA_BANK_ASSET_DEFAULTS.slice();

function renderMediaBankItems() {
  if (!mediaBankListEl) return;
  mediaBankListEl.innerHTML = '';
  mediaBankItems.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'media-bank-item';

    const label = document.createElement('div');
    label.className = 'media-bank-item-label';
    label.textContent = item.label;

    // Audio items only - dragged onto a section's narration area (see
    // buildSectionBlock's drop handler) to use as that shot's narration.
    // The index (not the item itself) is what's carried across the drag,
    // since dataTransfer can only hold strings. draggable lives on the
    // label specifically, not the whole row (which also contains the
    // player below) - a draggable ancestor is a known way to break normal
    // clicks on native <audio>/<video> controls in some browsers (the
    // browser's drag-detection on mousedown can swallow the click meant
    // for the player instead), so this keeps the two areas separate.
    if (item.kind === 'audio') {
      row.classList.add('draggable');
      label.draggable = true;
      label.addEventListener('dragstart', event => {
        event.dataTransfer.setData('application/x-media-bank-index', String(index));
        event.dataTransfer.effectAllowed = 'copy';
      });
    }
    row.appendChild(label);

    const player = document.createElement(item.kind === 'video' ? 'video' : 'audio');
    player.controls = true;
    player.src = item.previewUrl;
    row.appendChild(player);

    mediaBankListEl.appendChild(row);
  });
}

// Uploads a freshly recorded/picked audio or video file, then adds it to
// the list once saved - project_id is shared with footage/narration
// uploads (see fetchUploadFootage/fetchUploadNarration), so everything for
// one documentary lands under the same premiere_exports/<project_id>/.
function addMediaBankItem(kind, label, file) {
  mediaBankStatusEl.textContent = `Uploading "${label}" ...`;
  mediaBankStatusEl.classList.remove('error');
  fetchUploadMediaBankItem(file, premiereProjectId)
    .then(({ project_id, preview_url, file_path }) => {
      premiereProjectId = project_id;
      mediaBankItems.push({ kind, label, previewUrl: preview_url, filePath: file_path || null });
      mediaBankStatusEl.textContent = '';
      renderMediaBankItems();
      saveDebugSession();
    })
    .catch(err => {
      mediaBankStatusEl.textContent = err.message;
      mediaBankStatusEl.classList.add('error');
    });
}

//#endregion

//#region --- AI-GENERATED MATERIAL FOR STORYBOARD
// Drafts (redrafts, every time) this section's visual/narration/entities/
// video_query/audio_query - the same LLM call the sticky action bar's
// "Generate Storyboard for All/Selected" makes in bulk (see
// runGenerateStoryboardForSections) - then hands off to generateStep for
// whichever concrete visual/video generation actually triggered it (see
// runGenerateSketch/runGenerateVideoFromText/runGenerateSketchSequence
// below, its 3 callers). Shared here rather than in each caller since all
// 3 need the exact same fresh visual description to work from before doing
// their own (quite different) generation step, and none should silently
// reuse a stale one.
//
// Deliberately not just runGenerateStoryboardForSections([section], ...)
// followed by a separate generation call - that function's own success
// handler already does a full renderMovieEditor re-render, which would
// detach btn/statusEl from the DOM before the generation step could use
// them (writes to a status line no longer on screen, a button no longer
// clickable) - so this inlines both LLM calls in sequence instead,
// re-rendering only once, at the very end.
//
// Considers section.text (which, via drag-and-drop, may now hold anything
// from documentary-technique reminders to dragged-in source-material
// excerpts to freeform notes - see buildSectionBlock's drop handler)
// together with section.narration, not either/or - both are meaningful
// context for what the shot should show.
//
// generateStep: () => Promise, called once section.visual is fresh - does
// the specific generation call and sets whatever fields/visualSource it
// needs; any rejection is caught here and shown alongside the (still kept)
// draft, same as the original single-purpose version of this function did.
function runDraftVisualThenGenerate(section, btn, statusEl, draftedMessage, generateStep) {
  // Defensive, not just cosmetic - the button itself is disabled without
  // this (see buildSectionBlock), but re-checked here too in case that
  // ever gets bypassed (e.g. section.text edited down to empty between
  // render and click).
  const hasBasis = !!(section.text && section.text.trim()) || !!effectiveSectionNarration(section);
  if (!hasBasis) {
    statusEl.textContent = 'Add section text or narration first - there\'s nothing to base a visual on yet.';
    statusEl.classList.add('error');
    return;
  }

  btn.disabled = true;
  statusEl.textContent = 'Drafting a visual (~5-10s)...';
  statusEl.classList.remove('error');

  statusEl.textContent = draftedMessage;
  Promise.resolve().then(generateStep).catch(err => {
    // The draft above (visual/narration/entities/videoQuery/
    // audioQuery) already succeeded and is still worth keeping/
    // showing - Find Footage only needs videoQuery, for instance, not
    // a generated visual - so only the generation step itself failed;
    // don't let that also hide the draft (the re-render still happens
    // in the .then below either way).
    statusEl.textContent = `Drafted a visual, but generation failed: ${err.message}`;
    statusEl.classList.add('error');
  })
    .then(() => {
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
    })
    .catch(err => {
      statusEl.textContent = err.message;
      statusEl.classList.add('error');
      btn.disabled = false;
    });
}

// Generates a shot for every arranged scene that doesn't have one yet (a
// start/end-frame shot, or - for expository scenes - cutaways). Image requests
// run in parallel, matching Apply this arc/Generate all. Each request still
// re-renders the whole editor on success, so the progress line + button are
// re-found by class/id from the current DOM while the stable section objects
// carry the work across those re-renders.
let generatingAllShots = false;
function runPreviewAllShots() {
  if (generatingAllShots) return;
  const setStatus = txt => { const el = document.querySelector('.preview-all-status'); if (el) el.textContent = txt; };
  generatingAllShots = true;
  const getPreviewBtn = () => document.getElementById('preview-all-btn');
  const initialBtn = getPreviewBtn();
  if (initialBtn) initialBtn.disabled = true;

  // Mirror the first storyboard-generation pass: every active scene gets a
  // stable subset of moodboard techniques, and its media-search inputs are
  // filled before visual examples are requested. This applies to scenes that
  // already have a visual too, so a later Preview All can complete missing
  // scene metadata without regenerating an existing visual.
  const arrangedScenes = () => currentSections.filter(s =>
    isSceneActive(s) && currentAssignments[s.index]);
  const scenes = arrangedScenes();
  scenes.forEach(autoPopulateSceneTechniques);
  if (scenes.length) {
    const remaining = currentSections.filter(s => !s.removed);
    renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
    saveDebugSession();
  }

  setStatus('Preparing scene techniques and narration …');
  Promise.resolve(autoSuggestNarrationForStoryboard())
    .then(() => {
      const currentScenes = arrangedScenes();
      // Ensure the same query context used by storyboard generation is ready,
      // including narration drafts produced by the preceding step.
      return Promise.all(currentScenes.map(scene => ensureFootageQueries(scene)))
        .then(() => {
          // Rebuild the controls from the newly generated query suggestions
          // before the shot buttons are looked up below.
          const remaining = currentSections.filter(s => !s.removed);
          renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
          return currentScenes;
        });
    })
    .then(currentScenes => {
      const queue = currentScenes.filter(s =>
        !(s.exampleShots && s.exampleShots.length)
        && !s.startFramePreviewUrl && !(s.cutaways && s.cutaways.length)
        && !s.uploadedFootagePreviewUrl && !s.selectedVideo);
      const total = queue.length;
      if (!total) {
        generatingAllShots = false;
        setStatus('Scene techniques and narration are ready. Every scene already has a preview.');
        const activeBtn = getPreviewBtn();
        if (activeBtn) activeBtn.disabled = false;
        saveDebugSession();
        return;
      }

      let completed = 0;
      const jobs = queue.map(section => {
        const block = resultsEl.querySelector(`.paper-section-block[data-section-index="${section.index}"]`);
        const sBtn = (block && block.querySelector('.generate-shot-examples-btn')) || { disabled: false };
        const sStatus = (block && block.querySelector('.find-footage-status'))
          || { textContent: '', classList: { add() { }, remove() { } } };
        setStatus(`Generating suggested shots in parallel … ${completed}/${total}`);
        const request = runGenerateShotExamples(section, sBtn, sStatus);
        return Promise.resolve(request).then(() => {
          completed += 1;
          setStatus(`Generating suggested shots in parallel … ${completed}/${total}`);
        });
      });
      return Promise.all(jobs).then(() => {
        generatingAllShots = false;
        setStatus(`Prepared scenes and generated previews for ${completed}/${total} scenes.`);
        const activeBtn = getPreviewBtn();
        if (activeBtn) activeBtn.disabled = false;
        saveDebugSession();
      });
    })
    .catch(err => {
      generatingAllShots = false;
      setStatus(`Could not prepare previews: ${err.message}`);
      const activeBtn = getPreviewBtn();
      if (activeBtn) activeBtn.disabled = false;
    });
}

// Seed an arranged scene with a small, varied subset of the moodboard's
// distilled technique palette when the presenter runs storyboard generation.
// Explicitly dragged techniques always win and are never overwritten.
function autoPopulateSceneTechniques(section) {
  if (Array.isArray(section.techniques) && section.techniques.length) return;
  const distilled = selectedTechniques.size
    ? Array.from(selectedTechniques)
    : (lastDistillResult && lastDistillResult.suggested_techniques) || [];
  const pool = sanitizeDocumentaryTechniques(distilled);
  if (!pool.length) return;
  const offset = Math.abs(Number(section.index) || 0) % pool.length;
  const rotated = pool.slice(offset).concat(pool.slice(0, offset));
  const picked = [];
  const categories = new Set();
  for (const technique of rotated) {
    const category = TECHNIQUE_CATEGORY[technique] || technique;
    if (categories.has(category) && picked.length < 2) continue;
    picked.push(technique);
    categories.add(category);
    if (picked.length >= Math.min(3, pool.length)) break;
  }
  section.techniques = picked;
}

// Scene-level techniques are now the generation inputs. Before storyboard
// generation, selectedTechniques is only the moodboard-derived suggestion
// palette shown in the side panel.
function sceneTechniques(section) {
  return sanitizeDocumentaryTechniques(section.techniques);
}

// Apply a documentary technique to one scene (dragged onto its Scene Notes).
// This updates the scene's generation inputs and re-renders the card, but does
// not launch image/video generation. Generation remains an explicit action.
function applyTechniqueToScene(section, technique) {
  if (!isDocumentaryTechnique(technique)) return;
  if (!Array.isArray(section.techniques)) section.techniques = [];
  if (!section.techniques.includes(technique)) section.techniques.push(technique);
  saveDebugSession();
  const remaining = currentSections.filter(s => !s.removed);
  renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
}

// A row of the per-scene techniques (section.techniques - applied by dragging a
// technique onto the scene notes/paper-section block, see
// applyTechniqueToScene), each a chip with an ✕ to remove it. Returns null when
// the scene has none. Removing a technique updates the scene for future
// generations; it doesn't re-generate on its own.
function buildSceneTechniquesRow(section) {
  const techs = Array.isArray(section.techniques) ? section.techniques : [];
  if (!techs.length) return null;

  const row = document.createElement('div');
  row.className = 'paper-section-techniques';
  // const label = document.createElement('span');
  // label.className = 'paper-section-techniques-label';
  // label.textContent = 'Techniques:';
  // row.appendChild(label);

  techs.forEach(technique => {
    const chip = document.createElement('span');
    chip.className = 'paper-section-technique-chip';
    const text = document.createElement('span');
    text.textContent = technique;
    chip.appendChild(text);
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'paper-section-technique-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = `Remove "${technique}" from this scene`;
    removeBtn.addEventListener('click', event => {
      event.stopPropagation();
      section.techniques = (section.techniques || []).filter(t => t !== technique);
      saveDebugSession();
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
    });
    chip.appendChild(removeBtn);
    row.appendChild(chip);
  });
  return row;
}

// Narration-driven shot design (backend/shot_plan_llm.py + /paper/generate_shot):
// infers one shot (size/movement/purpose) and generates its start frame + end
// frame from whatever's available - the scene's narration, scene notes, scene
// title, the arc part (act) the scene sits in, and the paper's abstract. None
// are required; with nothing at all the backend invents a plausible shot. The
// frames show as the artboard in buildVisualBox and hard-cut into the rendered
// MP4. This is the primary way a scene's visual is created (it replaced the
// old Generate-sketch / sketch-sequence buttons); re-clicking redesigns from
// scratch, same pattern as re-running Find Footage.
function runGenerateShot(section, btn, statusEl) {
  // An expository voice-of-god scene generates B-roll cutaways (inline in its
  // visual box) instead of a start/end-frame shot - see runGenerateCutaways.
  // Returned so callers that sweep scenes (runPreviewAllShots) can chain.

  // One start/end shot PER dragged technique, in the order they were dropped
  // (section.techniques) - so a scene with two techniques produces two shots,
  // the first showing technique #1, the second showing technique #2. With no
  // per-scene techniques, generate one shot with no technique constraint.
  const perScene = Array.isArray(section.techniques) ? section.techniques : [];
  const sequence = perScene.length ? perScene : [null];
  const moodboard = moodboardProfilesForGeneration();
  const act = currentArcSections.find(a => a.key === currentAssignments[section.index]);
  const generationController = beginSceneGeneration(section);

  btn.disabled = true;
  statusEl.classList.remove('error');
  const shots = [];

  const runOne = i => {
    if (i >= sequence.length) {
      section.shots = shots;
      // Legacy single-frame fields point at the first shot so the timeline and
      // the MP4 render (which currently use one start/end pair per scene) keep
      // working; section.shots holds the full sequence for the preview.
      section.shotPlan = shots[0].shotPlan;
      section.startFramePreviewUrl = shots[0].startFramePreviewUrl;
      section.endFramePreviewUrl = shots[0].endFramePreviewUrl;
      section.shotFramesGeneratedAt = Date.now();
      section.visualSource = 'shotFrames';
      // Scene duration = sum of the sequence's shot durations.
      const total = shots.reduce((sum, sh) => sum + ((sh.shotPlan && sh.shotPlan.duration_seconds) || DEFAULT_SCENE_SECONDS), 0);
      section.editPlan = {
        transitionIn: (section.editPlan && section.editPlan.transitionIn) || 'hard_cut',
        durationSeconds: total,
        kenBurns: (section.editPlan && section.editPlan.kenBurns) || { enabled: false, pan: null },
        textOverlay: (section.editPlan && section.editPlan.textOverlay) || null,
      };
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      saveDebugSession();
      finishSceneGeneration(section, generationController);
      return Promise.resolve();
    }

    const technique = sequence[i];
    const techniques = technique ? [technique] : [];
    statusEl.textContent = sequence.length > 1
      ? `Designing shot ${i + 1}/${sequence.length}${technique ? ` — ${technique}` : ''} …`
      : 'Designing this shot (~30s: shot plan + start/end frames)...';

    return fetchGenerateShot({
      sectionIndex: section.index,
      title: section.title,
      sceneNotes: sectionCompositionNotes(section),
      narration: effectiveSectionNarration(section),
      actTitle: act ? act.label : '',
      abstract: findAbstractText(),
      role: SCENE_ROLE_LABELS[getSceneRole(section)] || '',
      referenceSubject: section.footageSubject || '',
      referenceSketchUrl: section.uploadedSketchPreviewUrl || '',
      referenceFigureDataUrl: section.image || '',
      referenceVideoUrl: section.uploadedFootagePreviewUrl || '',
      referenceVideoThumbnailUrl: section.uploadedFootageThumbnailUrl || '',
      documentaryMode: selectedDocumentaryMode,
      techniques,
      moodboard,
      shotIndex: i,
      projectId: premiereProjectId,
      signal: generationController.signal,
    }).then(({ project_id, shot_plan, start_preview_url, end_preview_url }) => {
      premiereProjectId = project_id;
      shots.push({
        technique,
        shotPlan: shot_plan,
        startFramePreviewUrl: start_preview_url,
        endFramePreviewUrl: end_preview_url,
      });
      return runOne(i + 1);  // sequential - respects the image model's rate limit
    });
  };

  return runOne(0).catch(err => {
    finishSceneGeneration(section, generationController);
    if (isGenerationAbort(err)) return;
    statusEl.textContent = err.message;
    statusEl.classList.add('error');
    btn.disabled = false;
  });
}

// The VIDEO counterpart of runGenerateShot (see fetchGenerateShotVideo /
// /paper/generate_shot_video) - animates the exact image the presenter chose
// from the examples gallery, using that option's saved plan plus this scene's
// notes and explicitly dragged techniques.
function runGenerateShotVideo(section, btn, statusEl) {
  const selectedExampleImageUrl = section.selectedExample && section.selectedExample.kind === 'video'
    ? (section.selectedExample.source_image_url || section.selectedExample.thumbnail_url)
    : (section.selectedExample && section.selectedExample.url);
  const chosenImageUrl = selectedExampleImageUrl
    || section.startFramePreviewUrl
    || section.uploadedSketchPreviewUrl
    || section.uploadedFootageThumbnailUrl;
  if (!chosenImageUrl) {
    statusEl.textContent = 'Generate or upload an image, or choose an example image, before previewing it as a video.';
    statusEl.classList.add('error');
    return Promise.resolve();
  }

  btn.disabled = true;
  const generationController = beginSceneGeneration(section);
  statusEl.textContent = 'Animating the chosen image (~60s)...';
  statusEl.classList.remove('error');

  return fetchGenerateShotVideo({
    sectionIndex: section.index,
    chosenImageUrl,
    sceneNotes: sectionCompositionNotes(section),
    documentaryMode: selectedDocumentaryMode,
    techniques: sceneTechniques(section),
    shotPlan: section.shotPlan || {},
    projectId: premiereProjectId,
    signal: generationController.signal,
  })
    .then(({ project_id, shot_plan, preview_url, thumbnail_url }) => {
      premiereProjectId = project_id;
      section.shotPlan = shot_plan;
      // Reuse the animatedSketch renderer (plays an MP4) for the shot video.
      section.animatedSketchPreviewUrl = preview_url;
      section.animatedSketchThumbnailUrl = thumbnail_url || null;
      section.animatedSketchGeneratedAt = Date.now();
      section.animatedSketchIsGif = false;
      const sourceShot = (section.exampleShots || []).find(shot => shot.url === chosenImageUrl)
        || section.selectedExample || {};
      const videoShot = {
        url: preview_url,
        thumbnail_url: thumbnail_url || chosenImageUrl,
        kind: 'video',
        label: sourceShot && sourceShot.label ? sourceShot.label : 'Generated video',
        shot_size: sourceShot && sourceShot.shot_size,
        movement: sourceShot.movement || (shot_plan && shot_plan.movement),
        narrative_operation: shot_plan && shot_plan.narrative_operation,
        purpose: shot_plan && shot_plan.purpose,
        visual_description: shot_plan && shot_plan.visual_description,
        source_image_url: chosenImageUrl,
      };
      clearLegacyShotFrames(section);
      const selectedWasPinned = section.selectedExample && Array.isArray(section.pinnedExamples)
        && section.pinnedExamples.some(item => item && item.url === section.selectedExample.url);
      section.exampleShots = [...(section.exampleShots || []), videoShot];
      // A pinned source remains the selected/featured card when a preview
      // video is generated from it; the new video is added beside it instead
      // of replacing the pinned choice.
      if (!selectedWasPinned) {
        section.selectedExample = {
          url: preview_url,
          kind: 'video',
          thumbnail_url: thumbnail_url || chosenImageUrl,
          source_image_url: chosenImageUrl,
          label: videoShot.label,
          shot_size: videoShot.shot_size,
          movement: videoShot.movement,
        };
      }
      section.visualSource = 'examples';
      section.editPlan = {
        transitionIn: (section.editPlan && section.editPlan.transitionIn) || 'hard_cut',
        durationSeconds: 8,  // Veo 3.1's maximum supported clip length.
        kenBurns: (section.editPlan && section.editPlan.kenBurns) || { enabled: false, pan: null },
        textOverlay: (section.editPlan && section.editPlan.textOverlay) || null,
      };
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      saveDebugSession();
      finishSceneGeneration(section, generationController);
    })
    .catch(err => {
      finishSceneGeneration(section, generationController);
      if (isGenerationAbort(err)) return;
      statusEl.textContent = err.message;
      statusEl.classList.add('error');
      // In a parallel batch this scene's status element may already have been
      // detached by another completed request, so also surface the failure in
      // the live storyboard status line.
      setStoryboardStatus(`Could not generate examples for "${section.title}": ${err.message}`, true);
      btn.disabled = false;
    });
}

// Batch of example options for a shot (see fetchGenerateShotExamples /
// /paper/generate_shot_examples): two cheap still frames, shown as
// a selectable gallery (the `examples` renderer). Picking one commits it.
function runGenerateShotExamples(section, btn, statusEl) {
  btn.disabled = true;
  statusEl.textContent = 'Generating two shot examples…';
  statusEl.classList.remove('error');
  const generationController = beginSceneGeneration(section);

  const act = currentArcSections.find(a => a.key === currentAssignments[section.index]);
  return fetchGenerateShotExamples({
    sectionIndex: section.index,

    sceneNotes: sectionCompositionNotes(section),
    title: section.title,
    actTitle: act ? act.label : '',

    role: SCENE_ROLE_LABELS[getSceneRole(section)] || '', // Primary / Cutaway
    documentaryMode: selectedDocumentaryMode,
    techniques: sceneTechniques(section),

    narration: effectiveSectionNarration(section),
    abstract: findAbstractText(),                       // paper subject/content
    referenceSubject: section.footageSubject || '',     // uploaded-footage subject
    referenceSketchUrl: section.uploadedSketchPreviewUrl || '',
    referenceFigureDataUrl: section.image || '',         // attached paper figure
    referenceVideoUrl: section.uploadedFootagePreviewUrl || '',
    referenceVideoThumbnailUrl: section.uploadedFootageThumbnailUrl || '',

    moodboard: moodboardProfilesForGeneration(),
    count: 2,
    video: false,  // images-only batch (use "Generate video" once a frame is picked)
    projectId: premiereProjectId,
    signal: generationController.signal,
  })
    .then(({ project_id, shot_plan, examples }) => {
      premiereProjectId = project_id;
      section.shotPlan = shot_plan;
      clearLegacyShotFrames(section);
      // Each example carries its independently planned narrative operation,
      // shot-size/movement pairing, purpose, and image description.
      const generatedExamples = (examples || []).map(e => ({
        url: e.preview_url, thumbnail_url: e.thumbnail_url || e.preview_url,
        kind: e.kind || 'image', label: e.label,
        shot_size: e.shot_size, movement: e.movement,
        narrative_operation: e.narrative_operation, purpose: e.purpose,
        visual_description: e.visual_description,
      }));
      const pinned = Array.isArray(section.pinnedExamples) ? section.pinnedExamples : [];
      const generatedUrls = new Set(generatedExamples.map(shot => shot.url));
      section.exampleShots = [
        ...pinned.filter(shot => shot && shot.url && !generatedUrls.has(shot.url)),
        ...generatedExamples,
      ];
      // A prior selection points at the old generation's URL and should not
      // make the new gallery claim that an option is already selected, unless
      // it was deliberately pinned and therefore remains in the merged rail.
      const selectedWasPinned = section.selectedExample && Array.isArray(section.pinnedExamples)
        && section.pinnedExamples.some(item => item && item.url === section.selectedExample.url);
      if (!selectedWasPinned) section.selectedExample = null;
      section.examplesGeneratedAt = Date.now();
      section.visualSource = 'examples';
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      saveDebugSession();
      finishSceneGeneration(section, generationController);
    })
    .catch(err => {
      finishSceneGeneration(section, generationController);
      if (isGenerationAbort(err)) return;
      statusEl.textContent = err.message;
      statusEl.classList.add('error');
      btn.disabled = false;
    });
}

// Expository scenes: infer B-roll cutaways from the narration (+ notes/title/
// abstract) and generate a background still per cutaway (backend/cutaway_llm.py
// + /paper/generate_cutaways). Stored on the scene and shown inline in its
// visual box as a horizontal scroll of directional motion sketches (an AI
// background with an animated camera-frame overlay - see the cutaways
// renderer). Planning-only; re-clicking regenerates.
function runGenerateCutaways(section, btn, statusEl) {
  btn.disabled = true;
  statusEl.textContent = 'Finding cutaways from the narration + generating stills (~30-60s)...';
  statusEl.classList.remove('error');

  const act = currentArcSections.find(a => a.key === currentAssignments[section.index]);
  return fetchGenerateCutaways({
    sectionIndex: section.index,
    narration: effectiveSectionNarration(section),
    title: section.title,
    sceneNotes: sectionCompositionNotes(section),
    actTitle: act ? act.label : '',
    abstract: findAbstractText(),
    referenceSubject: section.footageSubject || '',
    documentaryMode: selectedDocumentaryMode,
    techniques: sceneTechniques(section),
    projectId: premiereProjectId,
  })
    .then(({ project_id, cutaways }) => {
      premiereProjectId = project_id;
      section.cutaways = cutaways || [];
      // Fresh cache-buster so re-generated stills (same filenames on the
      // backend) aren't served from the browser cache - see the renderer.
      section.cutawaysGeneratedAt = Date.now();
      section.visualSource = 'cutaways';
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      saveDebugSession();
    })
    .catch(err => {
      statusEl.textContent = err.message;
      statusEl.classList.add('error');
      btn.disabled = false;
    });
}

// AI-generated storyboard reference image (backend/sketch_llm.py) - a rough
// planning aid, not real footage, so re-clicking this just regenerates/
// replaces it (same pattern as re-clicking "Find Footage" re-searches).
// Retained for older saved sessions' visuals; no button creates one now (the
// Generate-shot flow above replaced it).
function runGenerateSketch(section, btn, statusEl) {
  runDraftVisualThenGenerate(section, btn, statusEl, 'Generating a sketch (~10-15s)...', () =>
    fetchGenerateSketch(section.index, section.visual, premiereProjectId, selectedDocumentaryMode)
      .then(({ project_id, preview_url }) => {
        premiereProjectId = project_id;
        section.sketchPreviewUrl = preview_url;
        // The backend saves every sketch for this section to the same
        // filename (see server.py's /paper/generate_sketch) - without a
        // fresh cache-busting key each time, buildVisualBox's <img src>
        // would be byte-identical to the previous request and the browser
        // would just show its cached copy of the old image.
        section.sketchGeneratedAt = Date.now();
        // Generating a sketch is a deliberate choice - see
        // buildVisualBox's visualSource lookup (same reasoning as
        // runUploadFootage's own).
        section.visualSource = 'sketch';
        saveDebugSession();
      })
  );
}

// Text-to-video (backend/animate_llm.py's generate_text_to_video) - same
// Veo model as runGenerateAnimatedSketch below, but built straight from
// this shot's own visual description rather than an existing sketch image,
// so (unlike that one) this doesn't need a sketch to already exist.
function runGenerateVideoFromText(section, technique, btn, statusEl) {
  runDraftVisualThenGenerate(section, btn, statusEl, 'Generating a video from text (~45-60s)...', () =>
    fetchGenerateVideoFromText(section.index, section.visual, technique, premiereProjectId, selectedDocumentaryMode)
      .then(({ project_id, preview_url }) => {
        premiereProjectId = project_id;
        section.animatedSketchPreviewUrl = preview_url;
        section.animatedSketchTechnique = technique;
        // See runGenerateSketch's own sketchGeneratedAt comment - same
        // cache-busting reasoning, needed since re-generating the same
        // technique reuses that technique's filename (see server.py).
        section.animatedSketchGeneratedAt = Date.now();
        // Clears a stale true left behind by a previous sketch-sequence
        // generation on this same section (see the animatedSketch
        // renderer's own check) - this method's output is an .mp4, not a
        // .gif like runGenerateSketchSequence's below.
        section.animatedSketchIsGif = false;
        section.visualSource = 'animatedSketch';
        saveDebugSession();
      })
  );
}

// Cheaper, non-video-model alternative (backend/animate_llm.py's
// build_sequence_prompts/compose_gif) - 2-3 sketch_llm.py stills stitched
// into a hard-cut, looping animated GIF locally (no video model, no
// crossfade/blend), noticeably faster/cheaper than the two Veo-based
// methods above.
function runGenerateSketchSequence(section, technique, btn, statusEl) {
  runDraftVisualThenGenerate(section, btn, statusEl, 'Generating a sketch sequence (~30-45s)...', () =>
    fetchGenerateSketchSequence(section.index, section.visual, technique, premiereProjectId, selectedDocumentaryMode)
      .then(({ project_id, preview_url }) => {
        premiereProjectId = project_id;
        section.animatedSketchPreviewUrl = preview_url;
        section.animatedSketchTechnique = technique;
        section.animatedSketchGeneratedAt = Date.now();
        // See the animatedSketch renderer's own check - this is what
        // routes this method's output through <img> instead of <video>.
        section.animatedSketchIsGif = true;
        section.visualSource = 'animatedSketch';
        saveDebugSession();
      })
  );
}

// Animates an already-generated sketch (see runGenerateSketch above) into a
// short clip demonstrating one camera technique - a real image-to-video
// model (backend/animate_llm.py, Veo), not a CSS effect, so this is a
// genuine ~45-60s generation, not instant.
function runGenerateAnimatedSketch(section, technique, btn, statusEl) {
  // Defensive, not just cosmetic - the button itself is disabled without
  // this (see buildSectionBlock), but re-checked here too in case a sketch
  // gets cleared between render and click.
  if (!section.sketchPreviewUrl) {
    statusEl.textContent = 'Generate a sketch first - this animates that exact image.';
    statusEl.classList.add('error');
    return;
  }

  btn.disabled = true;
  statusEl.textContent = 'Animating (~45-60s) ...';
  statusEl.classList.remove('error');

  fetchGenerateAnimatedSketch(section.index, technique, premiereProjectId, selectedDocumentaryMode)
    .then(({ project_id, preview_url }) => {
      premiereProjectId = project_id;
      section.animatedSketchPreviewUrl = preview_url;
      section.animatedSketchTechnique = technique;
      // Each technique is its own file (see server.py's
      // /paper/generate_animated_sketch), but re-generating the SAME
      // technique again reuses that filename - see the animatedSketch
      // renderer's own cache-busting comment.
      section.animatedSketchGeneratedAt = Date.now();
      // See runGenerateVideoFromText's own comment - clears a stale true
      // from a previous sketch-sequence generation; this method's output
      // is an .mp4, not a .gif.
      section.animatedSketchIsGif = false;
      // Animating a sketch is a deliberate choice - see buildVisualBox's
      // visualSource lookup (same reasoning as runGenerateSketch's own).
      section.visualSource = 'animatedSketch';
      saveDebugSession();

      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
    })
    .catch(err => {
      statusEl.textContent = err.message;
      statusEl.classList.add('error');
      btn.disabled = false;
    });
}

// sectionsToUse is whatever the sticky action bar decided to target - the
// current selection if non-empty, otherwise the whole arc (see
// renderMovieEditor) - the movie editor always re-renders the full
// remaining set regardless, so a subset regeneration doesn't hide every
// other already-arranged card.
function runGenerateStoryboardForSections(sectionsToUse, triggerBtn) {
  if (sectionsToUse.length === 0) {
    setStoryboardStatus('No arranged sections to build a storyboard from - arrange into a narrative arc first.', true);
    return Promise.resolve();
  }

  if (triggerBtn) triggerBtn.disabled = true;
  setStoryboardStatus(sectionsToUse.length === 1
    ? `Generating a storyboard for "${sectionsToUse[0].title}" ...`
    : 'Generating a loose storyboard ...');

  // Turn the moodboard distillation into scene-level direction at the moment
  // the storyboard is created. This keeps the technique side panel as a
  // palette, while every scene gets a few concrete techniques in its notes.
  sectionsToUse.forEach(autoPopulateSceneTechniques);

  return Promise.all(sectionsToUse.map(section => {
    section.videoQuery = '';
    section.audioQuery = '';
    return ensureFootageQueries(section);
  })).then(() => {
    const remaining = currentSections.filter(section => isSceneActive(section) && currentAssignments[section.index]);
    renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
    setStoryboardStatus(`Generating preview examples for ${sectionsToUse.length} scene${sectionsToUse.length === 1 ? '' : 's'} ...`);

    // The cards must exist before we look up each scene's status line. Each
    // scene generates independently; a result is kept even if another one
    // fails, and pinned examples remain protected by the normal rail merge.
    const exampleJobs = sectionsToUse.map(section => {
      const block = resultsEl.querySelector(`.paper-section-block[data-section-index="${section.index}"]`);
      const btn = (block && block.querySelector('.generate-shot-examples-btn')) || { disabled: false };
      const status = (block && block.querySelector('.find-footage-status'))
        || { textContent: '', classList: { add() { }, remove() { } } };
      return Promise.resolve(runGenerateShotExamples(section, btn, status)).then(() => {
        // Show this scene's gallery as soon as its request settles rather
        // than waiting for the other parallel scenes to finish.
        const progressiveRemaining = currentSections.filter(s => !s.removed);
        renderMovieEditor(resultsEl, currentLabel, progressiveRemaining, currentAssignments);
      });
    });
    return Promise.all(exampleJobs);
  }).then(() => {
    // Every example request re-renders independently. Render once more after
    // the batch so the final galleries are guaranteed to be visible even if
    // the last request completed while another render was replacing the DOM.
    const finalRemaining = currentSections.filter(s => !s.removed);
    renderMovieEditor(resultsEl, currentLabel, finalRemaining, currentAssignments);
    setStoryboardStatus(`Done. Added techniques and preview examples for ${sectionsToUse.length} scene${sectionsToUse.length === 1 ? '' : 's'}.`);
    // The other half of triggerFindFootageSweep's precondition (alongside
    // a picked mode) - a no-op if no mode is selected yet. Needs to run
    // after the render above, since it locates each section's Find Footage
    // button/status/results by selector in the freshly-built DOM.
    triggerFindFootageSweep();
    if (triggerBtn) triggerBtn.disabled = false;
    saveDebugSession();
  })
    .catch(err => {
      setStoryboardStatus(err.message, true);
      if (triggerBtn) triggerBtn.disabled = false;
    });
}

// --- Edit plan: transitions/pacing/Ken-Burns/text-overlay suggestions over
// an already-storyboarded (sub)set of the arc (backend/edit_plan_llm.py).
// Only sections with a storyboard shot (visual+narration) are worth sending
// - one the model never touches would have nothing to base editing choices
// on. sectionsToUse follows the same convention as
// runGenerateStoryboardForSections above. ---
function runGenerateEditPlanForSections(sectionsToUse, triggerBtn) {
  const storyboarded = sectionsToUse.filter(section => section.visual);
  if (storyboarded.length === 0) {
    setEditPlanStatus('No storyboarded sections yet - generate a storyboard first.', true);
    return;
  }

  if (triggerBtn) triggerBtn.disabled = true;
  setEditPlanStatus(storyboarded.length === 1
    ? `Generating an edit plan for "${storyboarded[0].title}" ...`
    : 'Generating an edit plan ...');
  const documentaryGoal = (documentaryIntentInput ? documentaryIntentInput.value : recordedTranscript).trim();

  fetchEditPlan(storyboarded.map(({ index, title, text, visual, narration, image }) => ({
    index, title, text, visual, narration,
    act: currentAssignments[index],
    has_figure_image: !!image,
  })), documentaryGoal, currentArcSections.map(s => s.label), selectedDocumentaryMode)
    .then(({ shots, overall_notes }) => {
      shots.forEach(({ index, transition_in, duration_seconds, ken_burns, text_overlay }) => {
        const section = currentSections.find(s => s.index === index);
        if (section) {
          section.editPlan = { transitionIn: transition_in, durationSeconds: duration_seconds, kenBurns: ken_burns, textOverlay: text_overlay };
        }
      });
      overallEditNotes = overall_notes || '';

      setEditPlanStatus(
        `Done. Generated an edit plan for ${shots.length} shot${shots.length === 1 ? '' : 's'}.` +
        (overallEditNotes ? ` Overall notes: ${overallEditNotes}` : '')
      );
      const remaining = currentSections.filter(section => isSceneActive(section) && currentAssignments[section.index]);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      if (triggerBtn) triggerBtn.disabled = false;
      saveDebugSession();
    })
    .catch(err => {
      setEditPlanStatus(err.message, true);
      if (triggerBtn) triggerBtn.disabled = false;
    });
}
//#endregion

//#region --- EXPORT TO VIDEO
function buildSoundEffectsExportPayload() {
  if (!activeSfxLayout) return [];
  return activeSfxLayout.sfxEvents.map(event => ({
    section_index: event.sectionIndex,
    name: event.name,
    preview_url: event.previewUrl,
    file_path: event.filePath,
    start_seconds: event.startSeconds,
    source_start_seconds: event.sourceStartSeconds || 0,
    duration_seconds: event.durationSeconds,
    lane: event.lane,
  }));
}

function buildNarrationsExportPayload() {
  if (!activeSfxLayout) return [];
  return activeSfxLayout.narrationEvents.map(event => ({
    section_index: event.sectionIndex,
    name: event.name,
    preview_url: event.previewUrl,
    file_path: event.filePath,
    start_seconds: event.startSeconds,
    source_start_seconds: event.sourceStartSeconds || 0,
    duration_seconds: event.durationSeconds,
    lane: event.lane,
  }));
}

function runExportForPremiere() {
  const storyboarded = currentSections.filter(section =>
    isSceneActive(section) && currentAssignments[section.index] && sectionHasRenderableVisual(section));
  if (storyboarded.length === 0) {
    return Promise.resolve({ ok: false, error: 'No storyboarded sections yet.' });
  }

  const payload = storyboarded.flatMap(section => {
    const baseStart = activeSfxLayout && activeSfxLayout.sceneStartSeconds.get(section.index);
    const base = {
      index: section.index,
      title: section.title,
      act: currentAssignments[section.index],
      role: getSceneRole(section),
      start_seconds: Number.isFinite(baseStart) ? baseStart : null,
      narration: effectiveSectionNarration(section),
      narration_audio_path: null,
      narration_duration_seconds: Number(section.narrationDurationSeconds) || getSceneDuration(section),
      uploaded_footage_path: section.uploadedFootagePath || null,
      selected_video: section.selectedVideo || null,
      selected_audio: section.selectedAudio || null,
    };

    // Generated expository cutaways are real sequential picture edits in the
    // web timeline, so expose each still as its own Premiere shot instead of
    // flattening the scene back into an overlapping Primary clip.
    if (section.cutaways && section.cutaways.length && section.visualSource === 'cutaways') {
      let offset = 0;
      return section.cutaways.map((cutaway, cutawayIndex) => {
        const duration = getCutawayDuration(cutaway);
        const shot = {
          ...base,
          index: section.index,
          cutaway_index: cutawayIndex,
          title: cutaway.caption || `${section.title} cutaway ${cutawayIndex + 1}`,
          role: 'bRoll',
          start_seconds: Number.isFinite(baseStart) ? baseStart + offset : null,
          narration_audio_path: cutawayIndex === 0 ? base.narration_audio_path : null,
          uploaded_footage_path: null,
          visual_preview_url: cutaway.preview_url || null,
          edit_plan: {
            transition_in: 'hard_cut', duration_seconds: duration,
            ken_burns: { enabled: false, pan: null }, text_overlay: null,
          },
        };
        offset += duration;
        return shot;
      });
    }

    const hasShotFrames = hasLegacyShotFrames(section);
    const resolved = hasShotFrames
      ? { previewUrl: section.startFramePreviewUrl, figureDataUrl: null }
      : resolveSectionVisualForRender(section);
    return [{
      ...base,
      visual_preview_url: resolved.previewUrl,
      figure_image_data_url: resolved.figureDataUrl,
      edit_plan: section.editPlan
        ? {
          transition_in: section.editPlan.transitionIn,
          duration_seconds: section.editPlan.durationSeconds,
          ken_burns: section.editPlan.kenBurns,
          text_overlay: section.editPlan.textOverlay,
        }
        : null,
    }];
  });

  return fetchPremiereExport(payload, premiereProjectId, buildSoundEffectsExportPayload(), buildNarrationsExportPayload())
    .then(({ project_id, folder_path }) => {
      premiereProjectId = project_id;
      saveDebugSession();
      return { ok: true, folderPath: folder_path, shotCount: payload.length };
    })
    .catch(err => {
      return { ok: false, error: err.message };
    });
}

// --- Automated MP4 render (backend/movie_render.py via /render/start): the
// counterpart to runExportForPremiere above, producing a real documentary.mp4
// server-side with no Premiere or manual steps. ---

// Which single visual to render for a section, following buildVisualBox's
// exact priority (the most-recently-chosen source first, then the shared
// fallback order) - returns a resolvable local preview URL for any
// file-backed visual, or the paper figure as a data URL if that's all
// there is, or neither.
function resolveSectionVisualForRender(section) {
  const selectedExample = section.selectedExample && section.selectedExample.url;
  const previewBySource = {
    // Expository cutaways are planning-only, but the scene still needs a
    // still under its narration - use the first cutaway's background image.
    cutaways: section.cutaways && section.cutaways.length && section.cutaways[0].preview_url,
    stockVideo: section.selectedVideo && section.selectedVideo.localPreviewUrl,
    video: section.uploadedFootagePreviewUrl,
    uploadedSketch: section.uploadedSketchPreviewUrl,
    // Modern example selections are the scene visual. Images and generated
    // videos both arrive here as a URL; the video branch also keeps the
    // animated preview fallback for older saved sessions without `kind`.
    examples: selectedExample || null,
    animatedSketch: section.animatedSketchPreviewUrl,
    sketch: section.sketchPreviewUrl,
  };
  for (const key of [section.visualSource, 'uploadedSketch', 'cutaways', 'stockVideo', 'video', 'examples', 'animatedSketch', 'sketch']) {
    if (key && previewBySource[key]) return { previewUrl: previewBySource[key], figureDataUrl: null };
  }
  if (section.image) return { previewUrl: null, figureDataUrl: section.image };
  return { previewUrl: null, figureDataUrl: null };
}

function hasLegacyShotFrames(section) {
  // A modern examples selection (including a generated video card) owns the
  // scene visual even if an older saved session still has frame fields.
  const modernExampleActive = section.visualSource === 'examples'
    || !!(section.selectedExample && section.selectedExample.url);
  return !modernExampleActive
    && !!(section.startFramePreviewUrl && section.endFramePreviewUrl);
}

function sectionHasRenderableVisual(section) {
  if (hasLegacyShotFrames(section)) return true;
  const resolved = resolveSectionVisualForRender(section);
  return !!(resolved.previewUrl || resolved.figureDataUrl);
}

let renderPollTimer = null;
let combinedPremiereExportResult = null;
let renderMovieDownloadEl = null;
let renderMovieOutputUrl = '';

function runCombinedExport() {
  if (renderMovieBtn) renderMovieBtn.disabled = true;
  combinedPremiereExportResult = null;
  setRenderMovieStatus('Writing Premiere plan ...');
  return runExportForPremiere().then(result => {
    combinedPremiereExportResult = result;
    setRenderMovieStatus(result.ok
      ? 'Premiere plan saved. Starting MP4 render ...'
      : `Premiere plan failed (${result.error}). Trying MP4 render ...`, !result.ok);
    return runRenderMovie();
  });
}

function actBoardRenderMediaUrl(node) {
  if (!node) return '';
  const selectedKey = String(node.selectedVisualKey || '');
  const selectedGenerated = selectedKey.startsWith('generated-') && Array.isArray(node.generatedOptions)
    ? node.generatedOptions[node.selectedGeneratedIndex || 0]
    : null;
  const selectedResult = selectedKey.startsWith('result-') && Array.isArray(node.results)
    ? node.results[node.selectedResultIndex || 0]
    : null;
  const url = selectedResult?.localPreviewUrl
    || node.mediaUrl
    || selectedGenerated?.url
    || selectedResult?.video_url
    || selectedResult?.url
    || '';
  // Browser-only object URLs cannot be read by the server-side ffmpeg
  // process. Uploaded/generated media normally has a persisted preview URL;
  // treating a stale blob URL as missing produces a useful render error.
  return String(url).startsWith('blob:') ? '' : url;
}

function actBoardRenderAudioUrl(node) {
  const source = actBoardAudioSource(node);
  return String(source.url || '').startsWith('blob:') ? '' : source.url;
}

function hasActBoardLinkedSequence() {
  return currentArcSections.some(act => {
    const nodes = actBoardNodesForAct(act.key);
    const hasNarrationSequence = nodes.some(node => node.type === 'narration'
      && (node.footageNodeIds || []).some(id =>
        nodes.some(candidate => candidate.id === id && candidate.type === 'footage')));
    const hasSceneSequence = actBoardScenesForAct(act.key).some(scene =>
      orderedActBoardSceneFootage(act.key, scene, nodes).length > 0);
    return hasNarrationSequence || hasSceneSequence;
  });
}

function buildActBoardRenderPlan() {
  const sequences = [];
  const narrations = [];
  const soundEffects = [];
  let cursor = 0;
  currentArcSections.forEach(act => {
    const nodes = actBoardNodesForAct(act.key);
    const narrationNodes = nodes.filter(node => node.type === 'narration');
    const sequencedFootageIds = new Set();
    // A fallback scene narration can represent the whole act when the user
    // has not recorded an act-board narration. Use it once; separately
    // recorded narration nodes each get their own timed umbrella track.
    let fallbackNarrationUsed = false;
    narrationNodes.forEach(narrationNode => {
      const linked = orderedActBoardLinkedFootage(act.key, narrationNode);
      if (!linked.length) return;
      const scene = actBoardSceneForNode(act.key, narrationNode);
      const includeNarration = narrationNode.includeNarration !== false;
      let umbrellaClip = null;
      if (includeNarration && narrationNode.audioPreviewUrl) {
        umbrellaClip = {
          previewUrl: narrationNode.audioPreviewUrl,
          _nativePreviewUrl: narrationNode._nativeAudioUrl || null,
          trimStartSeconds: 0,
          durationSeconds: Number(narrationNode.audioDurationSeconds) || 0,
        };
        narrationNode.narrationAudioDurationSeconds = Number(narrationNode.audioDurationSeconds) || 0;
      } else if (includeNarration && !fallbackNarrationUsed) {
        const audioSection = actBoardSectionsForAct(act.key).find(section => {
          const clips = migrateNarrationClips(section);
          return clips.some(clip => clip.previewUrl || clip._nativePreviewUrl);
        });
        if (!umbrellaClip && audioSection) {
          umbrellaClip = migrateNarrationClips(audioSection)
            .find(item => item.previewUrl || item._nativePreviewUrl) || null;
          if (umbrellaClip) {
            narrationNode.narrationAudioDurationSeconds = Number(umbrellaClip.durationSeconds) || 0;
            fallbackNarrationUsed = true;
          }
        }
      }
      recomputeActBoardTiming(narrationNode);
      const linkedAudio = orderedActBoardLinkedAudio(act.key, narrationNode);
      const footage = linked.map(node => ({
        node_id: node.id,
        fragment: node.fragment || '',
        media_url: actBoardRenderMediaUrl(node),
        duration_seconds: Number(node.durationSeconds) > 0 ? Number(node.durationSeconds) : 1,
        start_seconds: Number(node.startSeconds) || 0,
        source_start_seconds: Math.max(0, Number(node.trimStartSeconds) || 0),
      }));
      if (!footage.length) return;
      const sequenceDuration = Math.max(
        footage.reduce((sum, item) => sum + item.duration_seconds, 0),
        ...footage.map(item => (Number(item.start_seconds) || 0) + item.duration_seconds),
        ...linkedAudio.map(audioNode => (Number(audioNode.startSeconds) || 0)
          + Math.max(0.25, Number(audioNode.durationSeconds) || 1)),
        Number(umbrellaClip?.durationSeconds) || 0,
      );
      const sequence = {
        act_key: act.key,
        scene_id: scene?.id || null,
        narration_node_id: narrationNode.id,
        start_seconds: cursor,
        duration_seconds: sequenceDuration,
        footage,
      };
      sequences.push(sequence);
      linked.forEach(node => sequencedFootageIds.add(node.id));

      linkedAudio.forEach(audioNode => {
        const previewUrl = actBoardRenderAudioUrl(audioNode);
        if (!previewUrl) return;
        const source = actBoardAudioSource(audioNode);
        soundEffects.push({
          preview_url: previewUrl,
          start_seconds: cursor + Math.max(0, Number(audioNode.startSeconds) || 0),
          source_start_seconds: source.trimStartSeconds,
          duration_seconds: Math.max(0.25, Number(audioNode.durationSeconds)
            || source.durationSeconds || 1),
          kind: audioNode.audioKind === 'music' ? 'music' : 'sfx',
          gain: Math.max(0, Math.min(2, actBoardNodeVolume(audioNode))),
        });
      });

      // Use one recorded narration clip from the act as the umbrella voice
      // track when one exists. The suggested text itself remains planning
      // metadata until the presenter records it.
      if (includeNarration && umbrellaClip) {
        const previewUrl = umbrellaClip.previewUrl || umbrellaClip._nativePreviewUrl;
        // blob: URLs only exist in this browser and cannot be resolved by the
        // render server. The persisted preview_url is the server-renderable
        // source; skip the event if an older session has only a blob URL.
        if (previewUrl && !String(previewUrl).startsWith('blob:')) {
          narrations.push({
            preview_url: previewUrl,
            start_seconds: cursor,
            source_start_seconds: Number(umbrellaClip.trimStartSeconds) || 0,
            duration_seconds: sequenceDuration,
          });
        }
      }
      cursor += sequenceDuration;
    });

    // A scene can be deliberately built as a footage-only sequence. Follow
    // its direct footage links (or its selected starting node) and render it
    // without requiring a narration node.
    actBoardScenesForAct(act.key).forEach(scene => {
      const linked = orderedActBoardSceneFootage(act.key, scene, nodes)
        .filter(node => !sequencedFootageIds.has(node.id));
      if (!linked.length) return;
      const sceneNodeIds = new Set(scene.nodeIds || []);
      const linkedAudio = nodes.filter(audioNode => audioNode.type === 'audio'
        && audioNode.linkedToNodeId
        && (sceneNodeIds.has(audioNode.linkedToNodeId)
          || linked.some(footage => footage.id === audioNode.linkedToNodeId)));
      const footage = linked.map(node => ({
        node_id: node.id,
        fragment: node.fragment || '',
        media_url: actBoardRenderMediaUrl(node),
        duration_seconds: Number(node.durationSeconds) > 0 ? Number(node.durationSeconds) : 1,
        start_seconds: Number(node.startSeconds) || 0,
        source_start_seconds: Math.max(0, Number(node.trimStartSeconds) || 0),
      }));
      const sequenceDuration = Math.max(
        footage.reduce((sum, item) => sum + item.duration_seconds, 0),
        ...footage.map(item => (Number(item.start_seconds) || 0) + item.duration_seconds),
        ...linkedAudio.map(audioNode => (Number(audioNode.startSeconds) || 0)
          + Math.max(0.25, Number(audioNode.durationSeconds) || 1)),
      );
      sequences.push({
        act_key: act.key,
        scene_id: scene.id,
        narration_node_id: null,
        start_seconds: cursor,
        duration_seconds: sequenceDuration,
        footage,
      });
      linked.forEach(node => sequencedFootageIds.add(node.id));
      linkedAudio.forEach(audioNode => {
        const previewUrl = actBoardRenderAudioUrl(audioNode);
        if (!previewUrl) return;
        const source = actBoardAudioSource(audioNode);
        soundEffects.push({
          preview_url: previewUrl,
          start_seconds: cursor + Math.max(0, Number(audioNode.startSeconds) || 0),
          source_start_seconds: source.trimStartSeconds,
          duration_seconds: Math.max(0.25, Number(audioNode.durationSeconds)
            || source.durationSeconds || 1),
          kind: audioNode.audioKind === 'music' ? 'music' : 'sfx',
          gain: Math.max(0, Math.min(2, actBoardNodeVolume(audioNode))),
        });
      });
      cursor += sequenceDuration;
    });
  });
  return { sequences, narrations, soundEffects };
}

function runRenderMovie() {
  // Renderable = arranged and has some visual: a narration-driven shot (start
  // + end frames), a generated storyboard visual, a stock/uploaded clip, or
  // the paper figure. (Shot-frame scenes don't set section.visual, so this
  // can't just check that.)
  const boardPlan = buildActBoardRenderPlan();
  // Keep the established timeline + scenes export intact. The linked act
  // board becomes the render source only when its separate Board view is
  // active; switching back to Timeline renders the regular scene storyboard.
  const useBoardPlan = storyboardView === 'board' && boardPlan.sequences.length > 0;
  const storyboarded = currentSections.filter(section =>
    isSceneActive(section) && currentAssignments[section.index] && sectionHasRenderableVisual(section));
  if (!useBoardPlan && storyboarded.length === 0) {
    setRenderMovieStatus('No shots yet - generate a shot (or pick footage) for a scene first.', true);
    if (renderMovieBtn) renderMovieBtn.disabled = false;
    return Promise.resolve(false);
  }

  if (useBoardPlan) {
    const missing = boardPlan.sequences.flatMap(sequence =>
      sequence.footage.filter(item => !item.media_url)
        .map(item => item.fragment || item.node_id || 'an unlabelled footage node'));
    if (missing.length) {
      setRenderMovieStatus(
        `The linked act-board sequence is missing media for: ${missing.join(', ')}. Upload or generate that footage, then try again.`,
        true,
      );
      if (renderMovieBtn) renderMovieBtn.disabled = false;
      return Promise.resolve(false);
    }
  }

  // Build the payload up front, bailing (before touching the server) if any
  // shot has no resolvable visual - the render route rejects that anyway,
  // but naming the offending section here is friendlier than a generic
  // server error mid-render.
  const payload = [];
  for (const section of (useBoardPlan ? [] : storyboarded)) {
    // A narration-driven shot (start + end frames) takes priority - it
    // hard-cuts between the two frames in the render. Otherwise fall back to
    // the single resolved visual (stock/uploaded/sketch) or the paper figure.
    const hasShotFrames = hasLegacyShotFrames(section);
    let previewUrl = null;
    let figureDataUrl = null;
    if (!hasShotFrames) {
      ({ previewUrl, figureDataUrl } = resolveSectionVisualForRender(section));
      if (!previewUrl && !figureDataUrl) {
        setRenderMovieStatus(`"${section.title}" has no usable visual yet - generate a shot, pick footage, or use its figure image, then try again.`, true);
        if (renderMovieBtn) renderMovieBtn.disabled = false;
        return Promise.resolve(false);
      }
    }
    // Expository scenes render EVERY cutaway still in sequence under the
    // narration (see movie_render.render_shot's cutaway branch), not just the
    // first - send them all when cutaways are the scene's active visual.
    const usingCutaways = !hasShotFrames && previewUrl && section.cutaways && section.cutaways.length
      && previewUrl === section.cutaways[0].preview_url;
    payload.push({
      title: section.title,
      start_frame_preview_url: hasShotFrames ? section.startFramePreviewUrl : null,
      end_frame_preview_url: hasShotFrames ? section.endFramePreviewUrl : null,
      visual_preview_url: previewUrl,
      cutaway_preview_urls: usingCutaways ? section.cutaways.map(c => c.preview_url).filter(Boolean) : null,
      figure_image_data_url: (previewUrl || hasShotFrames) ? null : figureDataUrl,
      narration_audio_path: null,
      edit_plan: section.editPlan
        ? {
          transition_in: section.editPlan.transitionIn,
          duration_seconds: section.editPlan.durationSeconds,
          ken_burns: section.editPlan.kenBurns,
          text_overlay: section.editPlan.textOverlay,
        }
        : null,
    });
  }

  if (renderMovieBtn) renderMovieBtn.disabled = true;
  if (renderMovieDownloadEl) {
    renderMovieDownloadEl.hidden = true;
    renderMovieDownloadEl.removeAttribute('href');
  }
  renderMovieOutputUrl = '';
  setRenderMovieStatus('Starting render ...');
  if (renderPollTimer) { clearInterval(renderPollTimer); renderPollTimer = null; }

  const narrations = useBoardPlan ? boardPlan.narrations : buildNarrationsExportPayload();
  return fetchRenderStart(payload, premiereProjectId,
    [...buildSoundEffectsExportPayload(), ...(useBoardPlan ? boardPlan.soundEffects : [])],
    narrations, boardPlan.sequences)
    .then(({ project_id, preview_url }) => {
      premiereProjectId = project_id;
      renderMovieOutputUrl = preview_url || `/premiere_exports/${encodeURIComponent(project_id)}/documentary.mp4`;
      saveDebugSession();
      setRenderMovieStatus(useBoardPlan
        ? `Rendering ${boardPlan.sequences.length} linked sequence${boardPlan.sequences.length === 1 ? '' : 's'} across the act board ...`
        : 'Rendering ...');
      pollRenderStatus();
      return true;
    })
    .catch(err => {
      const planNote = combinedPremiereExportResult && combinedPremiereExportResult.ok
        ? ` Premiere plan was saved at ${combinedPremiereExportResult.folderPath}/edit_plan.json.` : '';
      setRenderMovieStatus(`${err.message}${planNote}`, true);
      if (renderMovieBtn) renderMovieBtn.disabled = false;
      return false;
    });
}

function setRenderMovieDownload(projectId) {
  if (!renderMovieDownloadEl || !projectId) return;
  const baseUrl = renderMovieOutputUrl
    || `/premiere_exports/${encodeURIComponent(projectId)}/documentary.mp4`;
  const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}download=${Date.now()}`;
  renderMovieDownloadEl.href = url;
  renderMovieDownloadEl.hidden = false;
}

// Self-clearing poll of /render/status to completion. The backend performs and
// knows the render's state, so an owned poll can report progress and completion.
// On done, the status names both the MP4 and Premiere-plan outputs.
function pollRenderStatus() {
  renderPollTimer = setInterval(() => {
    fetchRenderStatus(premiereProjectId)
      .then(({ state, message }) => {
        if (state === 'rendering') {
          setRenderMovieStatus(message || 'Rendering ...');
          return;
        }
        clearInterval(renderPollTimer);
        renderPollTimer = null;
        if (renderMovieBtn) renderMovieBtn.disabled = false;
        if (state === 'done') {
          const mp4Path = `premiere_exports/${premiereProjectId}/documentary.mp4`;
          setRenderMovieDownload(premiereProjectId);
          if (combinedPremiereExportResult && combinedPremiereExportResult.ok) {
            setRenderMovieStatus(
              `Done — MP4: ${mp4Path} · Premiere plan: ${combinedPremiereExportResult.folderPath}/edit_plan.json`);
          } else if (combinedPremiereExportResult && !combinedPremiereExportResult.ok) {
            setRenderMovieStatus(`MP4 done: ${mp4Path} · Premiere plan failed: ${combinedPremiereExportResult.error}`, true);
          } else {
            setRenderMovieStatus(`Done - ${mp4Path}`);
          }
        } else {
          setRenderMovieStatus(message || 'Render failed.', true);
        }
      })
      .catch(err => {
        clearInterval(renderPollTimer);
        renderPollTimer = null;
        if (renderMovieBtn) renderMovieBtn.disabled = false;
        setRenderMovieStatus(err.message, true);
      });
  }, 2000);
}
//#endregion

//#region --- WIRING / LAYOUT REARRANGEMENT
const fileInput = document.getElementById('paper-file-input');
const extractBtn = document.getElementById('extract-paper-btn');
const statusEl = document.getElementById('paper-status');
const resultsEl = document.getElementById('paper-sections');
const storyboardArcModuleEl = document.getElementById('storyboard-arc-module');
const mediaBankModuleEl = document.getElementById('media-bank-module');
const sourceMaterialModuleEl = document.getElementById('source-material-module');
const deletedScenesModuleEl = document.getElementById('deleted-scenes-module');
const moodboardSummaryModuleEl = document.getElementById('moodboard-summary-module');
const moodboardSummaryListEl = document.getElementById('moodboard-summary-list');
const deletedScenesListEl = document.getElementById('deleted-scenes-list');
const sidebarStackEl = document.getElementById('storyboard-sidebar');
const togglePanelsBtn = document.getElementById('toggle-panels-btn');
const recordMediaAudioBtn = document.getElementById('record-media-audio-btn');
const recordMediaVideoBtn = document.getElementById('record-media-video-btn');
const mediaBankVideoPreviewEl = document.getElementById('media-bank-video-preview');
const uploadMediaInput = document.getElementById('upload-media-input');
const mediaBankStatusEl = document.getElementById('media-bank-status');
const mediaBankListEl = document.getElementById('media-bank-list');
const sourceMaterialListEl = document.getElementById('source-material-list');
// The "Render MP4" button + its status live in the storyboard heading row now
// (built per-render in renderMovieEditor, next to "Clear all scenes"), not in
// a fixed panel - so these are reassigned each render rather than queried once.
// The finished file is served from premiere_exports/<id>/documentary.mp4 and
// exposed as a Download MP4 link after the background render completes.
let renderMovieBtn = null;
let renderMovieStatusEl = null;

// Record Audio - same getUserMedia/MediaRecorder toggle pattern as
// index.html's Record Your Intent button (see recordIntentBtn above), but
// uploads into the open-ended media-bank list instead of the one fixed
// intent-narration slot.
let mediaAudioStream = null;
let mediaAudioRecorder = null;
if (recordMediaAudioBtn) {
  recordMediaAudioBtn.addEventListener('click', async () => {
    if (mediaAudioRecorder && mediaAudioRecorder.state === 'recording') {
      mediaAudioRecorder.stop();
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      mediaBankStatusEl.textContent = `Could not access microphone: ${err.message}`;
      mediaBankStatusEl.classList.add('error');
      return;
    }
    mediaAudioStream = stream;
    const chunks = [];
    mediaAudioRecorder = new MediaRecorder(stream);
    const mimeType = mediaAudioRecorder.mimeType || 'audio/webm';
    mediaAudioRecorder.addEventListener('dataavailable', event => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    mediaAudioRecorder.addEventListener('stop', () => {
      mediaAudioStream.getTracks().forEach(track => track.stop());
      recordMediaAudioBtn.textContent = 'Record audio';
      const extensionMatch = /audio\/([a-z0-9]+)/i.exec(mimeType);
      const extension = extensionMatch ? extensionMatch[1] : 'webm';
      const blob = new Blob(chunks, { type: mimeType });
      const file = new File([blob], `media-audio-${Date.now()}.${extension}`, { type: mimeType });
      addMediaBankItem('audio', `Audio recording - ${new Date().toLocaleTimeString()}`, file);
    });
    mediaAudioRecorder.start();
    recordMediaAudioBtn.textContent = 'Stop Recording';
    mediaBankStatusEl.textContent = 'Recording audio - click again to stop.';
    mediaBankStatusEl.classList.remove('error');
  });
}

// Record Video - same webcam-recording pattern as buildSectionBlock's own
// "Record Webcam" button (see recordBtn there), but with a standalone live
// preview element (#media-bank-video-preview) instead of taking over a
// shot card's visual box, since this isn't tied to any one shot.
let mediaVideoStream = null;
let mediaVideoRecorder = null;
if (recordMediaVideoBtn) {
  recordMediaVideoBtn.addEventListener('click', async () => {
    if (mediaVideoRecorder && mediaVideoRecorder.state === 'recording') {
      mediaVideoRecorder.stop();
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (err) {
      mediaBankStatusEl.textContent = `Could not access camera: ${err.message}`;
      mediaBankStatusEl.classList.add('error');
      return;
    }
    mediaVideoStream = stream;
    mediaBankVideoPreviewEl.srcObject = stream;
    mediaBankVideoPreviewEl.style.display = '';

    const chunks = [];
    mediaVideoRecorder = new MediaRecorder(stream);
    // See buildSectionBlock's own webcamMimeType comment - not necessarily
    // webm (e.g. Safari produces video/mp4), so this has to be read back
    // rather than assumed, or the saved file gets labeled with the wrong
    // extension and silently fails to play back later.
    const mediaVideoMimeType = mediaVideoRecorder.mimeType || 'video/webm';
    mediaVideoRecorder.addEventListener('dataavailable', event => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    mediaVideoRecorder.addEventListener('stop', () => {
      mediaVideoStream.getTracks().forEach(track => track.stop());
      mediaBankVideoPreviewEl.style.display = 'none';
      mediaBankVideoPreviewEl.srcObject = null;
      recordMediaVideoBtn.textContent = 'Record Video';
      const extensionMatch = /video\/([a-z0-9]+)/i.exec(mediaVideoMimeType);
      const extension = extensionMatch ? extensionMatch[1] : 'webm';
      const blob = new Blob(chunks, { type: mediaVideoMimeType });
      const file = new File([blob], `media-video-${Date.now()}.${extension}`, { type: mediaVideoMimeType });
      addMediaBankItem('video', `Video recording - ${new Date().toLocaleTimeString()}`, file);
    });
    mediaVideoRecorder.start();
    recordMediaVideoBtn.textContent = 'Stop Recording';
    mediaBankStatusEl.textContent = 'Recording video - click again to stop.';
    mediaBankStatusEl.classList.remove('error');
  });
}

// Upload File - either an audio or video file from disk, kind inferred
// from its own MIME type rather than a separate audio/video picker.
if (uploadMediaInput) {
  uploadMediaInput.addEventListener('change', () => {
    const file = uploadMediaInput.files[0];
    if (!file) return;
    const kind = file.type.startsWith('video/') ? 'video' : 'audio';
    addMediaBankItem(kind, file.name, file);
    uploadMediaInput.value = '';
  });
}

function setStatus(message, isError) {
  statusEl.textContent = message || '';
  statusEl.classList.toggle('error', !!isError);
}

// Both write into the sticky action bar (see renderMovieEditor) - kept as
// state, not just a live DOM write, because a successful generation
// re-renders that whole bar (fresh status-line elements) before the "Done"
// message is set; renderMovieEditor reads this state to populate them.
function setStoryboardStatus(message, isError) {
  storyboardBarStatus = { message: message || '', isError: !!isError };
  const el = document.querySelector('.action-bar .storyboard-status-line');
  if (el) {
    el.textContent = storyboardBarStatus.message;
    el.classList.toggle('error', storyboardBarStatus.isError);
  }
}

function setEditPlanStatus(message, isError) {
  editPlanBarStatus = { message: message || '', isError: !!isError };
  const el = document.querySelector('.action-bar .edit-plan-status-line');
  if (el) {
    el.textContent = editPlanBarStatus.message;
    el.classList.toggle('error', editPlanBarStatus.isError);
  }
}

function setRenderMovieStatus(message, isError) {
  if (!renderMovieStatusEl) return; // heading row not built (e.g. index.html)
  renderMovieStatusEl.textContent = message || '';
  renderMovieStatusEl.classList.toggle('error', !!isError);
}

// extractBtn only exists on index.html, while both pages load this shared
// script, so its wiring is guarded on storyboard.html.
if (extractBtn) extractBtn.addEventListener('click', runExtraction);
// The "Render MP4" button is built + wired per-render in the storyboard
// heading row (see renderMovieEditor), so there's no fixed element to wire here.

// Moves the "Suggested narrative arc" module (#storyboard-arc-module) into
// the dedicated left sidebar once an arc's been accepted (see
// runAcceptArc/restoreDebugSession), freeing the main column for the
// arranged view - stays interactive there (see renderArcSuggestion) so the
// presenter can still switch arcs afterward. Always inserted first (see
// relocateMediaBankToSidebar/relocateSourceMaterialToSidebar below, which
// always appendChild - i.e. add last) so this stays above them regardless
// of relocation order. insertBefore(el, null) (an empty sidebar) degrades
// to appendChild anyway, and moving a node to right before itself is a
// harmless no-op, so this is safe to call again on every subsequent
// accept/restore.
function setupSidebarModuleCollapse(moduleEl) {
  if (!moduleEl || moduleEl.dataset.sidebarCollapseReady === 'true') return;
  // Use direct children rather than a selector rooted at :scope so this also
  // works in the embedded browser used by the desktop app.
  const heading = Array.from(moduleEl.children).find(child => child.tagName === 'H2');
  if (!heading) return;

  const moduleId = moduleEl.id || `sidebar-module-${Date.now()}`;
  const header = document.createElement('div');
  header.className = 'sidebar-module-header';
  header.setAttribute('role', 'heading');
  header.setAttribute('aria-level', '2');

  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'premiere-timeline-collapse-btn sidebar-module-collapse-btn';
  collapseBtn.addEventListener('click', () => {
    sidebarModuleCollapsed[moduleId] = !sidebarModuleCollapsed[moduleId];
    updateSidebarModuleCollapse(moduleEl, collapseBtn, heading);
    saveDebugSession();
    collapseBtn.blur();
  });

  heading.parentNode.insertBefore(header, heading);
  header.appendChild(heading);
  header.appendChild(collapseBtn);
  // Put every other module child behind one explicit body element. Using the
  // native `hidden` property makes collapse reliable even when a module's
  // list renderer applies its own display/flex styles (as Source material and
  // Deleted source and scenes do).
  const body = document.createElement('div');
  body.className = 'sidebar-module-body';
  while (header.nextSibling) body.appendChild(header.nextSibling);
  moduleEl.appendChild(body);
  moduleEl._sidebarModuleBodyEl = body;
  moduleEl.dataset.sidebarCollapseReady = 'true';
  moduleEl.dataset.sidebarModuleId = moduleId;
  updateSidebarModuleCollapse(moduleEl, collapseBtn, heading);
}

function setupAllSidebarModuleCollapses() {
  if (!sidebarStackEl) return;
  sidebarStackEl.querySelectorAll('.module-card--in-sidebar').forEach(setupSidebarModuleCollapse);
}

function updateSidebarModuleCollapse(moduleEl, collapseBtn, heading) {
  if (!moduleEl || !collapseBtn) return;
  const moduleId = moduleEl.dataset.sidebarModuleId || moduleEl.id;
  const collapsed = !!sidebarModuleCollapsed[moduleId];
  moduleEl.classList.toggle('sidebar-module-collapsed', collapsed);
  if (moduleEl._sidebarModuleBodyEl) moduleEl._sidebarModuleBodyEl.hidden = collapsed;
  const action = collapsed ? 'Expand' : 'Collapse';
  const label = heading ? heading.textContent.trim() : 'panel';
  collapseBtn.textContent = collapsed ? '▾' : '▴';
  collapseBtn.title = `${action} ${label}`;
  collapseBtn.setAttribute('aria-label', `${action} ${label}`);
  collapseBtn.setAttribute('aria-expanded', String(!collapsed));
}

function relocateArcSuggestionToSidebar() {
  if (!sidebarStackEl || !storyboardArcModuleEl) return;
  storyboardArcModuleEl.classList.add('module-card--in-sidebar');
  setupSidebarModuleCollapse(storyboardArcModuleEl);
  sidebarStackEl.insertBefore(storyboardArcModuleEl, sidebarStackEl.firstChild);
}

// Moves "Your media" (#media-bank-module) and "Source material"
// (#source-material-module) into the same sidebar, underneath
// #storyboard-arc-module - both start hidden in .main-column (see
// html/storyboard.html) and only ever appear once an arc's been accepted,
// not before (there was nothing arranged yet to record media for or
// compare against source material). Called alongside
// relocateArcSuggestionToSidebar at both its call sites.
function relocateMediaBankToSidebar() {
  if (!sidebarStackEl || !mediaBankModuleEl) return;
  mediaBankModuleEl.classList.add('module-card--in-sidebar');
  setupSidebarModuleCollapse(mediaBankModuleEl);
  mediaBankModuleEl.style.display = '';
  sidebarStackEl.appendChild(mediaBankModuleEl);
}

function relocateSourceMaterialToSidebar() {
  if (!sidebarStackEl || !sourceMaterialModuleEl) return;
  sourceMaterialModuleEl.classList.add('module-card--in-sidebar');
  setupSidebarModuleCollapse(sourceMaterialModuleEl);
  sourceMaterialModuleEl.style.display = '';
  sidebarStackEl.appendChild(sourceMaterialModuleEl);
}

// Deleted scenes module (see renderDeletedScenesList) - moved into the same
// sidebar, but its visibility is left to renderDeletedScenesList (hidden when
// nothing's deleted), unlike the others which are always shown once relocated.
function relocateDeletedScenesToSidebar() {
  if (!sidebarStackEl || !deletedScenesModuleEl) return;
  deletedScenesModuleEl.classList.add('module-card--in-sidebar');
  setupSidebarModuleCollapse(deletedScenesModuleEl);
  sidebarStackEl.appendChild(deletedScenesModuleEl);
  renderDeletedScenesList();
}

// Read-only moodboard recap (see renderMoodboardSummaryList) - pinned to the
// TOP of the sidebar stack (inserted before the first child, so it sits above
// the arc panel and the other modules). Its own render toggles visibility
// (hidden when nothing analyzed).
function relocateMoodboardSummaryToSidebar() {
  if (!sidebarStackEl || !moodboardSummaryModuleEl) return;
  moodboardSummaryModuleEl.classList.add('module-card--in-sidebar');
  setupSidebarModuleCollapse(moodboardSummaryModuleEl);
  sidebarStackEl.insertBefore(moodboardSummaryModuleEl, sidebarStackEl.firstChild);
  // Editable moodboard (add/remove references re-distills - see
  // refreshSuggestionsFromMoodboard); renders the same cards index.html uses.
  renderMoodboardList();
  refreshMoodboardStatusLine();
}

// Runs all relocations together (both call sites always wanted them all
// anyway) and reveals #toggle-panels-btn - there's nothing worth
// collapsing before the sidebar actually has content.
function relocateAllSidebarModules() {
  relocateArcSuggestionToSidebar();
  // "Your media" (#media-bank-module) is hidden for now - not relocated/
  // revealed (see storyboard.html). The one recorded-intent clip it held
  // moved into #storyboard-arc-module.
  relocateSourceMaterialToSidebar();
  relocateMoodboardSummaryToSidebar();
  relocateDeletedScenesToSidebar();
  // Final scan keeps cards such as Source material and Deleted source and
  // scenes wired even when their content was initially hidden or rendered
  // after the first relocation pass.
  setupAllSidebarModuleCollapses();
  if (sidebarStackEl) sidebarStackEl.classList.toggle('collapsed', sidebarPanelsCollapsed);
  if (togglePanelsBtn) {
    togglePanelsBtn.style.display = '';
    togglePanelsBtn.textContent = sidebarPanelsCollapsed ? 'Show panels' : 'Hide panels';
  }
}

// Collapses/expands #storyboard-arc-module + #media-bank-module +
// #source-material-module together, by hiding the one shared container
// they've all relocated into (see relocateAllSidebarModules) rather than
// each individually - #main-column (the same flex row's other child)
// naturally expands to fill the freed width, no extra rule needed for that
// side (see styles-index.css's .sidebar-stack.collapsed).
if (togglePanelsBtn) {
  togglePanelsBtn.addEventListener('click', () => {
    sidebarPanelsCollapsed = !sidebarPanelsCollapsed;
    sidebarStackEl.classList.toggle('collapsed', sidebarPanelsCollapsed);
    togglePanelsBtn.textContent = sidebarPanelsCollapsed ? 'Show panels' : 'Hide panels';
    saveDebugSession();
  });
}

// Collapsible left-side upload panel - purely a display toggle, no state
// beyond the CSS class (same pattern as presenter-view.js's upload sidebar).
const uploadSidebar = document.getElementById('upload-sidebar');
const uploadSidebarToggle = document.getElementById('upload-sidebar-toggle');

// Guarded - the toggle button is currently commented out in html/index.html;
// without this check, calling addEventListener on null here would throw
// and silently stop every top-level statement after it from running,
// including debug-session save/restore below.
if (uploadSidebarToggle) {
  uploadSidebarToggle.addEventListener('click', () => {
    const collapsed = uploadSidebar.classList.toggle('collapsed');
    uploadSidebarToggle.textContent = collapsed ? '«' : '»';
    uploadSidebarToggle.title = collapsed ? 'Expand' : 'Collapse';
  });
}
//#endregion

//#region SESSION CACHE
// --- Cross-page session persistence ---
// index.html and storyboard.html are two separate pages (see html/
// storyboard.html), so a real navigation between them clears all in-memory
// JS state. This is the bridge: saves the state either page might need to
// localStorage on every meaningful change, and restores it on every page
// load (see restoreDebugSession, called unconditionally at the bottom of
// this file on both pages) - not just a "reload to resume" dev convenience
// anymore, though it still doubles as that too (no server round-trip, no
// attempt to reconcile with a paper re-uploaded in another tab).
const DEBUG_SESSION_STORAGE_KEY = 'paperExtractDebugSession';
const PAPER_SNAPSHOT_ID_STORAGE_KEY = 'paperExtractSnapshotId';

// Set once "Clear saved session" is clicked, so the beforeunload handler
// below doesn't immediately re-save the (still in-memory) old state right
// back to localStorage on the very reload meant to clear it - that was the
// bug: clearDebugSession() removed the key, but saveDebugSession() ran
// again a moment later on unload and put it right back.
let debugSessionCleared = false;

function createPaperSnapshotId() {
  const raw = (window.crypto && typeof window.crypto.randomUUID === 'function')
    ? window.crypto.randomUUID().replaceAll('-', '')
    : `paper${Date.now()}${Math.random().toString(36).slice(2, 12)}`;
  return raw.slice(0, 100);
}

function ensurePaperSnapshotId() {
  if (paperSnapshotId) return paperSnapshotId;
  try {
    paperSnapshotId = localStorage.getItem(PAPER_SNAPSHOT_ID_STORAGE_KEY) || null;
  } catch (err) { /* private browsing/localStorage unavailable */ }
  if (!paperSnapshotId) paperSnapshotId = createPaperSnapshotId();
  try { localStorage.setItem(PAPER_SNAPSHOT_ID_STORAGE_KEY, paperSnapshotId); } catch (err) { }
  return paperSnapshotId;
}

function rotatePaperSnapshotId() {
  paperSnapshotId = createPaperSnapshotId();
  try { localStorage.setItem(PAPER_SNAPSHOT_ID_STORAGE_KEY, paperSnapshotId); } catch (err) { }
}

function queuePaperSnapshotSave() {
  if (debugSessionCleared) return;
  const hasSource = currentSections.length > 0 || moodboardReferences.some(ref => ref.sourceUrl);
  if (!hasSource) return;
  clearTimeout(paperSnapshotSaveTimer);
  paperSnapshotSaveTimer = setTimeout(() => {
    const payload = {
      snapshot_id: ensurePaperSnapshotId(),
      label: currentLabel,
      sections: currentSections.map(section => ({
        index: section.index,
        title: section.title,
        text: section.text,
        removed: !!section.removed,
      })),
      youtube_references: moodboardReferences
        .filter(ref => ref.sourceKind === 'youtube' && ref.sourceUrl)
        .map(ref => ({ title: ref.title, url: ref.sourceUrl })),
    };
    fetchSavePaperSnapshot(payload).catch(() => {
      // LocalStorage remains the immediate fallback when the backend is down.
    });
  }, 350);
}

function saveDebugSession() {
  if (debugSessionCleared) return;
  try {
    syncActBoardLiveSceneSnapshots();
    localStorage.setItem(DEBUG_SESSION_STORAGE_KEY, JSON.stringify({
      currentLabel,
      currentSections,
      currentAssignments,
      currentArcSections,
      actBoardNodes,
      actBoardScenes,
      actBoardOpenSceneByAct,
      actBoardInitialScenesInitialized,
      actBoardInitialSceneActKeys: Array.from(actBoardInitialSceneActKeys),
      sceneRemovalStateVersion: 1,
      recordedTranscript,
      // Moodboard references (plain data only - no DOM); the disk-backed
      // thumbnail_url/profile survive the index->storyboard navigation.
      moodboardReferences: moodboardReferences.map(r => ({
        refId: r.refId, sourceKind: r.sourceKind, title: r.title, sourceUrl: r.sourceUrl,
        note: r.note, state: r.state, profile: r.profile, thumbnailUrl: r.thumbnailUrl,
      })),
      distilledStyleRationale,
      lastDistillResult,
      actBoardSetupMode,
      selectedFocusStatements: Array.from(selectedFocusStatements),
      selectedTechniques: Array.from(selectedTechniques),
      selectedNarrationArc,
      recordedNarrationDurationSeconds,
      recordedNarrationExtension,
      persistedNarrationPreviewUrl,
      premiereProjectId,
      premiereTimelineCollapsed,
      sidebarModuleCollapsed: { ...sidebarModuleCollapsed },
      sidebarPanelsCollapsed,
      paperSnapshotId,
      // mediaBankItems deliberately not persisted - see its own comment,
      // just above where it's declared.
    }));
  } catch (err) {
    // Quota exceeded (large embedded figure images) or localStorage
    // unavailable (private browsing) - not worth failing the UI over.
  }
  queuePaperSnapshotSave();
}

function clearDebugSession() {
  debugSessionCleared = true;
  localStorage.removeItem(DEBUG_SESSION_STORAGE_KEY);
}

// Hydrates every plain (non-DOM) piece of state both pages might need -
// page-specific follow-up (which view to render, which controls to reveal)
// happens separately below, once for each page.
function restoreDebugSession() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(DEBUG_SESSION_STORAGE_KEY) || 'null');
  } catch (err) {
    return null;
  }
  if (!saved || !Array.isArray(saved.currentSections) || saved.currentSections.length === 0) return null;

  currentLabel = saved.currentLabel || '';
  currentSections = saved.currentSections;
  paperSnapshotId = saved.paperSnapshotId || null;
  premiereTimelineCollapsed = !!saved.premiereTimelineCollapsed;
  // One-time migration: blank placeholders created before the default
  // title changed from "New Section" to "New Scene" (see renderMovieEditor/
  // its "+ Add Section" button) are still sitting in old saved sessions
  // with the old title - narrativeOnly (see insertSection) safely scopes
  // this to just those, not a real paper section a researcher happened to
  // title "New Section" themselves.
  currentSections.forEach(section => {
    // Normalize the independently persisted storyboard-deletion state.
    section.sceneRemoved = !!section.sceneRemoved;
    if (section.narrativeOnly && section.title === 'New Section') section.title = 'New Scene';
    // Sound effects used to be modeled as a mutually-exclusive scene role.
    // They now underlay either visual role, so retain the selected audio but
    // return legacy SFX-only scenes to the default Primary lane.
    if (section.role === 'soundEffects') section.role = 'aRoll';
    if (section.selectedAudio) {
      const legacyDuration = Number(section.selectedAudio.durationSeconds || section.selectedAudio.duration);
      if (!section.selectedAudio.sourceDurationSeconds && legacyDuration > 0) {
        section.selectedAudio.sourceDurationSeconds = Number(section.selectedAudio.duration) || legacyDuration;
      }
      if (!section.selectedAudio.durationSeconds && legacyDuration > 0) {
        section.selectedAudio.durationSeconds = legacyDuration;
      }
      if (!Number.isFinite(Number(section.selectedAudio.trimStartSeconds))) {
        section.selectedAudio.trimStartSeconds = 0;
      }
      normalizeSelectedAudioSegment(section.selectedAudio);
    }
  });
  currentAssignments = saved.currentAssignments || {};
  currentArcSections = Array.isArray(saved.currentArcSections) ? saved.currentArcSections : [];
  actBoardNodes = (saved.actBoardNodes && typeof saved.actBoardNodes === 'object')
    ? saved.actBoardNodes
    : Object.create(null);
  actBoardScenes = (saved.actBoardScenes && typeof saved.actBoardScenes === 'object')
    ? saved.actBoardScenes
    : Object.create(null);
  actBoardOpenSceneByAct = (saved.actBoardOpenSceneByAct
    && typeof saved.actBoardOpenSceneByAct === 'object')
    ? saved.actBoardOpenSceneByAct
    : Object.create(null);
  actBoardInitialScenesInitialized = saved.actBoardInitialScenesInitialized != null
    ? !!saved.actBoardInitialScenesInitialized
    : Object.values(actBoardScenes).some(scenes => Array.isArray(scenes) && scenes.length > 0);
  actBoardInitialSceneActKeys = new Set(Array.isArray(saved.actBoardInitialSceneActKeys)
    ? saved.actBoardInitialSceneActKeys : []);
  Object.entries(actBoardScenes).forEach(([actKey, scenes]) => {
    if (!Array.isArray(scenes)) {
      actBoardScenes[actKey] = [];
      return;
    }
    scenes.forEach(scene => {
      if (!scene || typeof scene !== 'object') return;
      if (!scene.id) scene.id = createActBoardSceneId();
      scene.actKey = scene.actKey || actKey;
      if (!Array.isArray(scene.nodeIds)) scene.nodeIds = [];
      if (!scene.title) scene.title = 'Board scene';
      if (scene.includeNarration == null) scene.includeNarration = true;
      if (scene.sequenceStartNodeId === undefined) scene.sequenceStartNodeId = null;
      if (!Number.isFinite(Number(scene.boardX))) scene.boardX = 0;
      if (!Number.isFinite(Number(scene.boardY))) scene.boardY = 0;
      if (!Number.isFinite(Number(scene.boardWidth))) scene.boardWidth = 220;
      if (!Number.isFinite(Number(scene.boardHeight))) scene.boardHeight = 116;
      // Older sessions hid the framed board after clearing its live nodes.
      // Empty scene boards are now intentional drop targets, so migrate them
      // back to the canvas while retaining their snapshots for restoration.
      if (scene.hidden === true) scene.hidden = false;
      normalizeActBoardSceneMode(scene);
      actBoardInitialSceneActKeys.add(scene.actKey);
    });
  });
  // Migrate the first act-board prototype, which keyed footage cards by
  // entity name. The board now keeps the original narration fragment visible
  // on each footage card instead.
  Object.entries(actBoardNodes).forEach(([actKey, nodes]) => {
    if (!Array.isArray(nodes)) return;
    nodes.forEach(node => {
      if (node && !node.actKey) node.actKey = actKey;
      if (node && node.type === 'footage' && !node.fragment && node.entity) {
        node.fragment = node.entity;
      }
      if (node && node.type === 'footage') {
        // A stock download is a transient request; never restore a stale
        // in-progress marker after a refresh.
        delete node.downloadStatus;
        node.previousFootageNodeId = node.previousFootageNodeId || null;
        node.nextFootageNodeId = node.nextFootageNodeId || null;
        node.trimStartSeconds = Math.max(0, Number(node.trimStartSeconds) || 0);
        const selectedKey = String(node.selectedVisualKey || '');
        const selectedResult = selectedKey.startsWith('result-') && Array.isArray(node.results)
          ? node.results[node.selectedResultIndex || 0] : null;
        node.sourceDurationSeconds = Math.max(0, Number(node.sourceDurationSeconds)
          || Number(selectedResult?.duration_seconds || selectedResult?.duration)
          || (node.mediaKind === 'video' ? Number(node.durationSeconds) || 0 : 0));
      }
      if (node && node.type === 'narration') {
        if (node.includeNarration == null) {
          const nodeScene = actBoardScenesForAct(actKey).find(scene =>
            scene?.id === node.sceneId || (scene?.nodeIds || []).includes(node.id));
          // Preserve the old scene-level choice once, then keep the setting
          // on the individual narration node from this point forward.
          node.includeNarration = nodeScene?.includeNarration !== false;
        }
        delete node.entities;
        // Object URLs are page-local and become invalid on refresh. Never let
        // an old serialized blob: URL win over the persisted server preview.
        delete node._nativePreviewUrl;
        delete node._nativeAudioUrl;
        delete node.audioBuffer;
        if (typeof node.audioPreviewUrl === 'string' && node.audioPreviewUrl.startsWith('blob:')) {
          delete node.audioPreviewUrl;
        }
      }
      if (node && node.type === 'audio') {
        node.audioKind = node.audioKind === 'music' ? 'music' : 'sound-effects';
        node.linkedToNodeId = node.linkedToNodeId || null;
        node.linkedToType = node.linkedToType || null;
        delete node._nativePreviewUrl;
        delete node._nativeAudioUrl;
        if (node.selectedAudio && typeof node.selectedAudio === 'object') {
          if (typeof node.selectedAudio.localPreviewUrl === 'string'
            && node.selectedAudio.localPreviewUrl.startsWith('blob:')) {
            delete node.selectedAudio.localPreviewUrl;
          }
          if (typeof node.selectedAudio.preview_url === 'string'
            && node.selectedAudio.preview_url.startsWith('blob:')) {
            delete node.selectedAudio.preview_url;
          }
        }
        if (typeof node.audioPreviewUrl === 'string' && node.audioPreviewUrl.startsWith('blob:')) {
          delete node.audioPreviewUrl;
        }
      }
    });
  });
  // Before sceneRemoved existed, "Clear all scenes" marked the shared source
  // objects as removed. Repair that legacy all-scenes-cleared shape once so a
  // refresh restores the paper library while keeping the storyboard empty.
  if (!saved.sceneRemovalStateVersion) {
    const legacyArranged = currentSections.filter(section => currentAssignments[section.index]);
    if (legacyArranged.length > 0 && legacyArranged.every(section => section.removed)) {
      legacyArranged.forEach(section => {
        section.removed = false;
        section.sceneRemoved = true;
      });
    }
  }
  recordedTranscript = saved.recordedTranscript || '';
  moodboardReferences = Array.isArray(saved.moodboardReferences) ? saved.moodboardReferences : [];
  distilledStyleRationale = saved.distilledStyleRationale || '';
  lastDistillResult = saved.lastDistillResult || null;
  actBoardSetupMode = DOCUMENTARY_MODES.some(mode => mode.key === saved.actBoardSetupMode)
    ? saved.actBoardSetupMode
    : (DOCUMENTARY_MODES.some(mode => mode.key === lastDistillResult?.suggested_mode)
      ? lastDistillResult.suggested_mode : null);
  selectedFocusStatements = new Set(Array.isArray(saved.selectedFocusStatements) ? saved.selectedFocusStatements : []);
  selectedTechniques = new Set(sanitizeDocumentaryTechniques(saved.selectedTechniques));
  // Also migrate per-scene technique lists from older sessions where a track
  // role could be stored as though it were a technique.
  currentSections.forEach(section => {
    section.techniques = sanitizeDocumentaryTechniques(section.techniques);
    // Runtime-only request state must never survive a saved session.
    delete section._generating;
    // Runtime audio decodes/object URLs must be rebuilt from the persisted
    // preview URL on refresh; older sessions may contain a serialized `{}`
    // where an AudioBuffer used to be.
    delete section.narrationAudioBuffer;
    if (Array.isArray(section.narrationClips)) {
      section.narrationClips.forEach(clip => {
        delete clip.audioBuffer;
        delete clip._nativePreviewUrl;
      });
    }
  });
  selectedNarrationArc = saved.selectedNarrationArc || null;
  syncAcceptedArcNarrationDrafts();
  recordedNarrationDurationSeconds = saved.recordedNarrationDurationSeconds || null;
  recordedNarrationExtension = saved.recordedNarrationExtension || 'webm';
  persistedNarrationPreviewUrl = saved.persistedNarrationPreviewUrl || null;
  premiereProjectId = saved.premiereProjectId || null;
  sidebarModuleCollapsed = (saved.sidebarModuleCollapsed && typeof saved.sidebarModuleCollapsed === 'object')
    ? { ...saved.sidebarModuleCollapsed }
    : Object.create(null);
  sidebarPanelsCollapsed = typeof saved.sidebarPanelsCollapsed === 'boolean'
    ? saved.sidebarPanelsCollapsed : true;
  // mediaBankItems deliberately left at its MEDIA_BANK_ASSET_DEFAULTS
  // initial value here - not restored from a saved session (see its own
  // comment, just above where it's declared).

  // A session saved before dynamic arcs existed has assignments but no
  // currentArcSections - reconstruct a best-effort arc from the distinct
  // act values present (order isn't guaranteed to match the original arc,
  // but this is a convenience fallback, not something worth failing over).
  if (currentArcSections.length === 0 && Object.keys(currentAssignments).length > 0) {
    const seen = new Set();
    Object.values(currentAssignments).forEach(act => seen.add(act));
    currentArcSections = Array.from(seen).map(name => ({ key: name, label: name, description: '' }));
  }

  return saved;
}

window.addEventListener('beforeunload', saveDebugSession);

// Guarded - .upload-sidebar-body only exists on index.html.
const uploadSidebarBodyEl = document.querySelector('.upload-sidebar-body');
if (uploadSidebarBodyEl) {
  const clearSessionBtn = document.createElement('button');
  clearSessionBtn.type = 'button';
  clearSessionBtn.className = 'clear-debug-session-btn';
  clearSessionBtn.textContent = 'Clear saved session';
  clearSessionBtn.title = 'Forget the locally-saved session (see localStorage) so the next reload/navigation starts fresh';
  clearSessionBtn.addEventListener('click', () => {
    clearDebugSession();
    clearSessionBtn.disabled = true;
    clearSessionBtn.textContent = 'Cleared - reload to start fresh';
  });
  uploadSidebarBodyEl.appendChild(clearSessionBtn);
}

const restoredSession = restoreDebugSession();

if (restoredSession) {
  if (extractBtn) {
    // --- index.html: restore the editable source-material feed and the
    // moodboard of reference documentaries (re-polling any that were still
    // analyzing when the page was left).
    if (currentSections.length) renderSectionFeed(resultsEl, currentLabel, currentSections);
    renderMoodboardList();
    refreshMoodboardStatusLine();
    moodboardReferences.forEach(r => {
      if (r.state === 'analyzing' && r.refId) pollMoodboardReference(r.refId);
    });
    updateComposeStoryboardVisibility();
    if (currentLabel) setStatus(`Restored "${currentLabel}" from your last session.`);
  } else if (suggestArcsRowEl) {
    // --- storyboard.html: render the movie editor if an arc's already been
    // accepted (relocating the suggestion module into the sidebar to match).
    // The distillation is NOT re-run on reload - its result is cached in
    // lastDistillResult (persisted), so a refresh re-renders the suggestion
    // from cache rather than firing a fresh LLM call. A brand-new arrival with
    // ready references but no cache distills once.
    restorePersistedNarrationPlayback();
    renderMediaBankItems();
    // Populates the underlying content even before an arc's accepted, so
    // it's ready the moment relocateSourceMaterialToSidebar reveals it
    // below (renderMovieEditor, called just below once an arc has been
    // accepted, refreshes it again from then on - see its own tail call).
    renderSourceMaterialList();
    const remaining = currentSections.filter(section => !section.removed);
    if (currentArcSections.length > 0) {
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      // Setup inputs are Act Board-first. The timeline's existing autofill
      // path remains available when its view is intentionally used, but a
      // refresh on the default Act Board must not start new timeline LLM work.
      if (storyboardView === 'timeline') autoSuggestNarrationForStoryboard();
      relocateAllSidebarModules();
    }
    if (lastDistillResult) {
      // Re-render the cached suggestion (no LLM call). mode/techniques were
      // restored from the session, so don't re-apply them here.
      suggestArcsRowEl.style.display = '';
      renderArcSuggestion(lastDistillResult.recommended, lastDistillResult.alternatives);
    } else if (moodboardReferences.some(r => r.state === 'ready')) {
      suggestArcsRowEl.style.display = '';
      runDistillMoodboard();
    } else if (currentArcSections.length === 0) {
      suggestArcsRowEl.style.display = '';
      suggestArcsStatusEl.textContent = 'Go back to setup and add a reference documentary to your moodboard first.';
    }
    // The moodboard module on storyboard is editable (add/remove references to
    // re-suggest the arc/mode/techniques). Show + render it whether or not an
    // arc's been accepted; it relocates into the sidebar once one has.
    if (moodboardSummaryModuleEl && moodboardListEl) {
      moodboardSummaryModuleEl.style.display = '';
      renderMoodboardList();
      refreshMoodboardStatusLine();
    }
  }
}
// Mirror an already-restored browser session into the quiet file-backed
// snapshot too, so an existing paper/YouTube reference is captured without
// requiring the presenter to make another edit first.
if (restoredSession) queuePaperSnapshotSave();
//#endregion
