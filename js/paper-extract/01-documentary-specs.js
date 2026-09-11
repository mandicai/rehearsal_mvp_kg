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
// Image-to-video generation uses the provider-supported eight-second clip.
// Keep the footage-node preview window in sync with that output instead of
// inheriting the generic new-footage default of two seconds.
const ACT_BOARD_GENERATED_VIDEO_SECONDS = 8;

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
  'Rack focus': 'movement',
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
// Act Board image generation creates one image per click. Keep this separate
// from the Timeline + Scenes example count so a single-image request does not
// invoke the multi-shot planner.
const ACT_BOARD_IMAGE_SAMPLE_COUNT = 1;
// A newly suggested footage node gets a small gallery so the presenter can
// compare visual directions without waiting for a large batch. This is
// separate from the manual Generate image button, which remains one image.
const ACT_BOARD_SUGGESTED_FOOTAGE_IMAGE_SAMPLE_COUNT = 1;
// Automatic AI image generation for footage nodes: the one sample requested
// right after a card's stock search, and the one for a merged node. Set to
// false to stop spending credits on every card that appears (a node's own
// Generate button keeps working either way).
const ACT_BOARD_AUTO_GENERATE_FOOTAGE_IMAGES = true;
// What a suggested highlight is: 'phrase' (words / noun phrases, the original
// model) or 'clause' (a whole spoken clause, each spawning several footage
// nodes with different footage illustrating it). Flip back to 'phrase' to
// restore the old behaviour; both server routes stay available.
const ACT_BOARD_HIGHLIGHT_UNIT = 'clause';
// Footage nodes spawned per clause. All go on the rail, interspersed across
// the clause's spoken window in order.
const ACT_BOARD_CLAUSE_ALTERNATES_MAX = 3;
// A presenter's own recorded pause is treated as a deliberate beat marker: any
// gap this long or longer between two consecutive (real, Whisper-timed) words
// forces an additional clause cut there, even mid-sentence. This only ever
// ADDS cuts on top of backend/server.py's punctuation-based clause split -
// see splitActBoardClauseSpansAtPauses - never merges clauses back together.
const ACT_BOARD_PAUSE_MIN_SECONDS = 1.0;
const ACT_BOARD_VIDEO_TECHNIQUE_CATEGORIES = new Set(['movement']);
const ACT_BOARD_DEFAULT_VIDEO_TECHNIQUES = ['Pan'];
// Linking is temporarily disabled in the Act Board UI while narration-driven
// smart arrangement becomes the primary sequencing workflow. Persisted link
// fields remain intact so older boards can still be migrated later.
const ACT_BOARD_LINKING_ENABLED = false;
// Camera direction is derived from the shot plan's narrative operation. It is
// intentionally read-only in the Act Board until we have a more advanced
// motion editor. The shot plan no longer carries a camera `movement` field
// (see backend/shot_plan_llm.py - the planner is told not to choose one, and
// ignores any it volunteers), so the operation IS the only signal; an
// unrecognized/absent operation falls back to the neutral 'observe' hold.
const ACT_BOARD_OPERATION_CAMERA_DIRECTIONS = {
  orient: 'Gently pan across the scene to orient the viewer.',
  contextualize: 'Hold the composition, then gently pan to reveal the surrounding context.',
  introduce: 'Hold a steady composition while the subject becomes clear.',
  observe: 'Hold the composition with only subtle environmental motion.',
  accompany: 'Track smoothly alongside the subject as the action unfolds.',
  connect: 'Pan deliberately to connect the subject with the surrounding space.',
  reveal: 'Move slowly to reveal the subject or detail at the right moment.',
  direct_attention: 'Slowly push toward the key subject or detail to focus attention.',
  inspect: 'Slowly push toward the key detail so the viewer can inspect it.',
  humanize: 'Hold close on the subject with gentle, natural movement.',
  react: 'Hold close on the subject, allowing a subtle handheld response.',
  expand: 'Pull back gradually to reveal the wider context around the subject.',
  narrow: 'Slowly push in to narrow the viewer’s attention onto the subject.',
};
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

function actBoardSuggestedCameraDirection(shotPlan = {}) {
  const operation = String(shotPlan.narrative_operation || '').trim().toLowerCase();
  return ACT_BOARD_OPERATION_CAMERA_DIRECTIONS[operation]
    || ACT_BOARD_OPERATION_CAMERA_DIRECTIONS.observe;
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
  chip.dataset.technique = technique;
  if (options.standard) chip.classList.add('standard-technique-chip');
  if (options.moodboardDerived) chip.classList.add('moodboard-derived');
  const selectionSet = options.selectionSet || selectedTechniques;
  chip.classList.toggle('selected', selectable && selectionSet.has(technique));
  chip.textContent = technique;
  if (selectable) {
    chip.addEventListener('click', () => {
      if (selectionSet.has(technique)) {
        selectionSet.delete(technique);
      } else if (options.singleSelect) {
        // Image generation accepts one visual technique at a time. Replacing
        // the prior choice keeps the picker and persisted node state in sync.
        selectionSet.clear();
        selectionSet.add(technique);
      } else {
        selectionSet.add(technique);
      }
      const popup = chip.closest('.storyboard-act-board-technique-popup');
      if (options.singleSelect && popup) {
        popup.querySelectorAll('[data-technique]').forEach(item => {
          item.classList.toggle('selected', selectionSet.has(item.dataset.technique));
        });
      } else {
        chip.classList.toggle('selected', selectionSet.has(technique));
      }
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

// Moodboard entry-point elements (moodboard.html only - null on the other
// pages). Keeping these selectors page-agnostic lets the same shared script
// render and persist the reference-documentary step after navigation.
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

