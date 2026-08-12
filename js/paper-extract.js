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

// The three timeline tracks a scene can belong to - a scene IS one of these
// (its role/label, shown per-scene in buildSectionBlock and used as the track
// it lands in on the timeline). Keys match buildNarrativeTimeline's TRACK_DEFS.
const SCENE_ROLES = [
  { key: 'aRoll', label: 'A-roll' },
  { key: 'bRoll', label: 'B-roll' },
  { key: 'soundEffects', label: 'Sound effects' },
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
    { role: 'aRoll', title: 'Voice-of-god narration', durationSeconds: 24 },
    { role: 'bRoll', title: 'Cutaway', durationSeconds: 6 },
    { role: 'bRoll', title: 'Cutaway', durationSeconds: 6 },
    { role: 'bRoll', title: 'Cutaway', durationSeconds: 6 },
    { role: 'bRoll', title: 'Cutaway', durationSeconds: 6 },
  ],
  // Observational & participatory are A-roll only - no B-roll cutaways (fly-
  // on-the-wall takes / interview segments carry the whole act themselves).
  observational: [
    { role: 'aRoll', title: 'Continuous take', durationSeconds: 12 },
    { role: 'aRoll', title: 'Continuous take', durationSeconds: 12 },
  ],
  participatory: [
    { role: 'aRoll', title: 'Interview', durationSeconds: 12 },
    { role: 'aRoll', title: 'Interview', durationSeconds: 12 },
  ],
  poetic: [
    { role: 'aRoll', title: 'Narration fragment', durationSeconds: 24 },
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

const documentaryIntentInput = document.getElementById('documentary-intent-input');
const intentSuggestedChipsEl = document.getElementById('intent-suggested-chips');
//#endregion

//#region --- KEEP TRACK OF STATE
// --- State: populated once per successful extraction, then mutated in
// place as sections are excluded/restored or arranged into a narrative arc.
// `index` is assigned once here and never reused, even once a section is
// filtered out of a request - it's the stable id both the removal toggle
// and the narrative-arc response key off of.

let currentLabel = '';
let currentSections = [];

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

// Set on an arc-template chip click, cleared the moment the presenter types
// in the textarea afterward (see the ARC_TEMPLATES wiring below) - tracks
// whether the textarea's current content is still exactly a known template
// (so its exact section names can be sent deterministically) or has become
// custom free text (so the backend must invent-or-match instead).
let selectedArcTemplate = null;

// Set/cleared by a documentary-mode chip click (see the mode-picker built
// in renderArcSuggestion below) - one of DOCUMENTARY_MODE keys or null. A
// stylistic axis independent of the arc/goal, sent only with
// fetchStoryboard/fetchEditPlan. Not persisted via saveDebugSession, same
// as selectedArcTemplate - an ephemeral "current pick," not saved session
// data.
let selectedDocumentaryMode = null;

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
const suggestArcsBtn = document.getElementById('suggest-arcs-btn');
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
// both omitted) through Web Audio - deliberately not a plain
// <audio src> - see decodeRecordedNarration's own comment on why: Safari
// can't reliably play a MediaRecorder-produced clip back that way, even
// from a real disk-served file, but decodeAudioData/an
// AudioBufferSourceNode does. owner is whatever UI element the caller
// wants to identify as currently holding playback (see currentPlaybackOwner
// above); onStop() is called once playback stops or ends, for the caller
// to reset its own button's label. See playNarrationRange (the intent
// recording, below) and buildSectionBlock's own narration player for the
// two current callers.
function playAudioBuffer(audioBuffer, owner, onStop, startSeconds, endSeconds) {
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
function makeEditable(el, getValue, setValue, { multiline } = {}) {
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
      el.textContent = oldValue; // don't allow clearing a field to empty
      return;
    }
    if (newValue !== oldValue) {
      setValue(newValue);
    }
  });
}

// Indices are assigned once and never reused (see the state comment near
// currentSections), so a manually-created section - via "+ Add Section" or
// a split - needs a genuinely new one rather than reusing/incrementing off
// currentSections.length (which drifts once any section is added/removed).
function nextSectionIndex() {
  return Math.max(-1, ...currentSections.map(s => s.index)) + 1;
}

// Inserts a brand-new section right after `afterIndex` (or at the end, if
// afterIndex isn't found - e.g. the flat pre-arrangement feed has nothing to
// insert "after" in arc terms). `act`, when given, is one of
// currentArcSections' keys, so the new section immediately appears in that
// row; omitted when there's no arrangement yet to place it into.
// `narrativeOnly`, when true, marks this as a blank placeholder created
// for the arc's structure rather than derived from the paper (a manual
// "+ Add Section" click, or an empty act row auto-populating itself with
// one - see renderMovieEditor) - excluded from storyboard.html's "Source
// material" sidebar list (see renderSourceMaterialList) so that list stays
// a true reflection of the paper's own extracted sections. A split (see
// runSplitSectionAt) doesn't set this - its "new" second half is still
// real excerpted text, not a blank stand-in.
function insertSection(afterIndex, title, text, act, narrativeOnly) {
  const section = { index: nextSectionIndex(), title, text, image: null, removed: false };
  if (narrativeOnly) section.narrativeOnly = true;
  const pos = currentSections.findIndex(s => s.index === afterIndex);
  currentSections.splice(pos === -1 ? currentSections.length : pos + 1, 0, section);
  if (act) currentAssignments[section.index] = act;
  return section;
}

// Splits `section`'s text into two sections at `offset` (a character offset
// into section.text - see the floating split-button wiring below, which
// computes this from where the presenter highlighted text) - falls back to
// the text's midpoint if `offset` is missing/degenerate. Prompts for the new
// section's title; returns false (no-op) if cancelled. The original section
// keeps the first half and has its now-stale storyboard/edit-plan fields
// cleared, same reasoning handleChipDrop/runAcceptArc already apply when a
// section's content/placement changes.
function runSplitSectionAt(section, offset) {
  const text = section.text || '';
  let splitOffset = offset;
  if (!Number.isFinite(splitOffset) || splitOffset <= 0 || splitOffset >= text.length) {
    splitOffset = Math.floor(text.length / 2);
  }

  const newTitle = window.prompt('Title for the new section:', `${section.title} (continued)`);
  if (!newTitle || !newTitle.trim()) return false;

  const firstHalf = text.slice(0, splitOffset).trim();
  const secondHalf = text.slice(splitOffset).trim();

  section.text = firstHalf;
  delete section.visual;
  delete section.narration;
  delete section.entities;
  delete section.editPlan;

  insertSection(section.index, newTitle.trim(), secondHalf, currentAssignments[section.index]);
  return true;
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

const VISUAL_BOX_RENDERERS = {
  // The narration-driven shot: a start frame → end frame artboard (see
  // /paper/generate_shot and artboard-example.png) - solid-bordered start
  // frame, an arrow, dashed-bordered end frame, with a shot-size/movement
  // label and the shot's purpose. Both frames hard-cut together in the
  // rendered MP4 (movie_render.render_shot's two-still branch).
  shotFrames(section) {
    if (!section.startFramePreviewUrl || !section.endFramePreviewUrl) return null;
    const plan = section.shotPlan || {};
    const bust = section.shotFramesGeneratedAt ? `?t=${section.shotFramesGeneratedAt}` : '';

    const board = document.createElement('div');
    board.className = 'shot-frames';

    const move = SHOT_MOVEMENT_LABELS[plan.movement] || (plan.movement || '').toUpperCase();
    const header = document.createElement('div');
    header.className = 'shot-frames-header';
    header.textContent = [move, plan.shot_size].filter(Boolean).join(' · ');
    board.appendChild(header);

    const row = document.createElement('div');
    row.className = 'shot-frames-row';
    const makeFrame = (cls, url, caption) => {
      const wrap = document.createElement('div');
      wrap.className = `shot-frame ${cls}`;
      const img = document.createElement('img');
      img.className = 'shot-frame-img';
      img.src = `${url}${bust}`;
      img.alt = caption;
      wrap.appendChild(img);
      const cap = document.createElement('div');
      cap.className = 'shot-frame-caption';
      cap.textContent = caption;
      wrap.appendChild(cap);
      return wrap;
    };
    row.appendChild(makeFrame('shot-frame-start', section.startFramePreviewUrl, 'START FRAME'));
    const arrow = document.createElement('div');
    arrow.className = 'shot-frames-arrow';
    arrow.textContent = '→';
    row.appendChild(arrow);
    row.appendChild(makeFrame('shot-frame-end', section.endFramePreviewUrl, 'END FRAME'));
    board.appendChild(row);

    if (plan.purpose) {
      const purpose = document.createElement('div');
      purpose.className = 'shot-frames-purpose';
      purpose.textContent = `Purpose: ${plan.purpose}`;
      board.appendChild(purpose);
    }
    return board;
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
    if (!section.uploadedFootagePath) return null;
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
    player.controls = true;
    player.preload = 'metadata';
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
    player.controls = true;
    player.loop = true;
    player.preload = 'metadata';
    // See stockVideo's own comment above - same reasoning.
    player.addEventListener('click', event => event.stopPropagation());
    return player;
  },
};

function buildVisualBox(section) {
  const box = document.createElement('div');
  box.className = 'paper-section-visual-box';

  let rendered = null;
  for (const key of [section.visualSource, 'shotFrames', 'stockVideo', 'video', 'animatedSketch', 'sketch', 'image']) {
    if (!key) continue;
    rendered = VISUAL_BOX_RENDERERS[key](section);
    if (rendered) break;
  }

  if (rendered) {
    box.appendChild(rendered);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'paper-section-visual-placeholder';
    placeholder.textContent = section.visual || '(no visual yet - generate a storyboard)';
    box.appendChild(placeholder);
  }

  return box;
}

// Decodes a section's disk-persisted narration audio into a playable
// AudioBuffer (a fresh recording/drag decodes immediately instead - see
// finishAssigningNarrationAudio below) - returns a promise resolving to
// that buffer, so the Play Narration button (see buildSectionBlock) can
// actively wait on it rather than only relying on the background prefetch
// this same function is also called with at render time (see
// buildSectionBlock) having already finished by the time it's clicked -
// clicking immediately after a reload, before that fetch/decode resolves,
// would otherwise silently do nothing.
function ensureSectionNarrationAudioDecoded(section) {
  if (section.narrationAudioBuffer) return Promise.resolve(section.narrationAudioBuffer);
  if (!section.narrationAudioPreviewUrl) return Promise.reject(new Error('No narration audio for this section yet.'));
  return fetch(section.narrationAudioPreviewUrl)
    .then(response => response.arrayBuffer())
    .then(arrayBuffer => ensurePlaybackAudioCtx().decodeAudioData(arrayBuffer))
    .then(audioBuffer => {
      section.narrationAudioBuffer = audioBuffer;
      return audioBuffer;
    });
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
function finishAssigningNarrationAudio(section, previewUrl, blob, filename, statusEl) {
  section.narrationAudioPreviewUrl = previewUrl;
  delete section.narrationAudioBuffer; // stale until the decode below resolves
  saveDebugSession();

  blob.arrayBuffer()
    .then(arrayBuffer => ensurePlaybackAudioCtx().decodeAudioData(arrayBuffer))
    .then(audioBuffer => { section.narrationAudioBuffer = audioBuffer; })
    .catch(() => { }); // no in-browser playback for this clip - not fatal, still saved to disk

  statusEl.textContent = 'Transcribing narration ...';
  fetchTranscription(blob, filename)
    .then(({ text }) => {
      section.narration = (text || '').trim() || section.narration;
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
  fetchUploadMediaBankItem(file, premiereProjectId)
    .then(({ project_id, preview_url }) => {
      premiereProjectId = project_id;
      finishAssigningNarrationAudio(section, preview_url, file, file.name, statusEl);
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
    .then(blob => finishAssigningNarrationAudio(section, mediaItem.previewUrl, blob, filename, statusEl))
    .catch(err => {
      statusEl.textContent = `Could not use that clip: ${err.message}`;
      statusEl.classList.add('error');
    });
}

function buildSectionBlock(section, selectable) {
  const block = document.createElement('div');
  block.className = 'paper-section-block';
  block.classList.toggle('paper-section-block-shot', !!selectable);
  block.classList.toggle('removed', section.removed);
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
  body.textContent = section.text || '(no text captured for this section)';

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
  makeEditable(body, () => section.text || '(no text captured for this section)', value => {
    section.text = value;
    saveDebugSession();
  }, { multiline: true });

  // Which timeline track this scene is (its role/label) - A-roll, B-roll, or
  // Sound effects. Auto-inferred (see getSceneRole), overridable here;
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

  // Drop target for dragging in either a documentary-technique chip (see
  // renderMovieEditor) or a Source material excerpt (see
  // renderSourceMaterialList) - appends rather than replacing, so
  // dropping in a few things builds up this section's working text.
  // stopPropagation on all three so this doesn't also bubble up into
  // .narrative-act-row's own drop handler (handleChipDrop, for
  // reordering/reassigning sections between arc rows).
  body.addEventListener('dragover', event => {
    event.preventDefault();
    event.stopPropagation();
    body.classList.add('drag-over');
  });
  body.addEventListener('dragleave', event => {
    event.stopPropagation();
    body.classList.remove('drag-over');
  });
  body.addEventListener('drop', event => {
    event.preventDefault();
    event.stopPropagation();
    body.classList.remove('drag-over');

    const technique = event.dataTransfer.getData('application/x-technique');
    const sourceIndexRaw = event.dataTransfer.getData('application/x-source-material-index');

    let addition = '';
    if (technique) {
      addition = technique;
    } else if (sourceIndexRaw !== '') {
      const source = currentSections.find(s => s.index === parseInt(sourceIndexRaw, 10));
      if (source) addition = source.text || '';
    }
    if (!addition) return;

    section.text = section.text ? `${section.text}\n\n${addition}` : addition;
    body.textContent = section.text;
    saveDebugSession();
  });

  if (selectable) {
    // Built here, appended in reading order at the bottom of this branch:
    // title -> narration -> the paper's own text (labeled "Scene Notes"
    // there) -> the visual box/footage actions (see buildVisualBox) - a
    // presenter reads what the shot's about and what to say before acting
    // on how to actually shoot/find it.
    const visualBox = buildVisualBox(section);

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
    const generateShotBtn = document.createElement('button');
    generateShotBtn.type = 'button';
    generateShotBtn.className = 'btn-secondary';
    generateShotBtn.textContent = section.startFramePreviewUrl ? 'Re-generate shot' : 'Generate shot';
    generateShotBtn.title = "Design this scene's shot (start frame → end frame) from its narration, notes, and title";
    generateShotBtn.addEventListener('click', event => {
      event.stopPropagation();
      runGenerateShot(section, generateShotBtn, sectionStatus);
    });
    footageActions.appendChild(generateShotBtn);

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

    // Always available. If the scene doesn't yet have LLM-suggested search
    // phrases (video_query/audio_query), runFindFootage derives them from the
    // scene's title/notes/narration on the fly (see ensureFootageQueries).
    const findFootageBtn = document.createElement('button');
    findFootageBtn.type = 'button';
    findFootageBtn.className = 'btn-secondary find-footage-btn';
    findFootageBtn.textContent = 'Find footage';
    findFootageBtn.addEventListener('click', event => {
      event.stopPropagation();
      runFindFootage(section, mediaResults, sectionStatus, findFootageBtn);
    });
    footageActions.appendChild(findFootageBtn);

    // Alternative to Record/Find: the researcher's own footage file from
    // disk, uploaded to premiere_exports/ (see backend/premiere_bridge.py)
    // for the Premiere Pro UXP plugin to import directly - takes priority
    // over a selected stock clip in /premiere/export's shot list.
    const uploadFootageInput = document.createElement('input');
    uploadFootageInput.type = 'file';
    uploadFootageInput.accept = 'video/*';
    uploadFootageInput.title = 'Upload your own footage for this shot';
    uploadFootageInput.addEventListener('click', event => event.stopPropagation());
    uploadFootageInput.addEventListener('change', () => {
      const file = uploadFootageInput.files[0];
      if (file) runUploadFootage(section, file, sectionStatus, uploadFootageInput);
    });
    footageActions.appendChild(uploadFootageInput);

    // Underneath the visual box: narration + audio.
    const narrationAudio = document.createElement('div');
    narrationAudio.className = 'paper-section-narration-audio';

    const narrationLine = document.createElement('div');
    narrationLine.className = 'paper-section-narration';
    // With no recorded narration yet, this reads as instructions for what to
    // say - the arc part's own description (moved here from the act heading),
    // which is the guidance for what this scene's voiceover should cover.
    // Falls back to a generic prompt if the arc part has no description. Once
    // narration is recorded, it shows that transcript instead.
    const narrationAct = currentArcSections.find(a => a.key === currentAssignments[section.index]);
    const narrationPrompt = (narrationAct && narrationAct.description && narrationAct.description.trim())
      ? narrationAct.description.trim()
      : "Record what you'd want to say over this scene.";
    narrationLine.textContent = section.narration || narrationPrompt;
    narrationAudio.appendChild(narrationLine);

    // --- The section's actual spoken narration audio - required to come
    // from a human voice, not generated text: either recorded directly
    // here, or dragged in from an already-recorded/uploaded clip in
    // storyboard.html's "Your Media" module (see renderMediaBankItems'
    // draggable audio items, and the drop handlers on narrationAudio
    // itself, just below). Either way it's transcribed into
    // narrationLine's text above and decoded for in-browser playback (see
    // playAudioBuffer's own comment on why not a plain <audio src>).
    // Distinct from section.selectedAudio further down - that's
    // stock/found ambience from Find Footage, not the presenter's voice.
    //
    // Best-effort prefetch so playback is instant once clicked - a
    // rejection here is silent (degraded, not fatal); the button's own
    // click handler below awaits this same call directly, so a click that
    // arrives before this prefetch finishes (or one that arrives after it
    // failed, e.g. a transient network error) still works/retries rather
    // than silently doing nothing.
    ensureSectionNarrationAudioDecoded(section).catch(() => { });

    const narrationAudioControls = document.createElement('div');
    narrationAudioControls.className = 'paper-section-narration-audio-controls';

    if (section.narrationAudioPreviewUrl) {
      const playNarrationBtn = document.createElement('button');
      playNarrationBtn.type = 'button';
      playNarrationBtn.className = 'btn-secondary';
      playNarrationBtn.textContent = '▶ Play narration';
      playNarrationBtn.addEventListener('click', event => {
        event.stopPropagation();
        if (currentPlaybackOwner === playNarrationBtn) {
          stopNarrationPlayback();
          return;
        }
        playNarrationBtn.disabled = true;
        ensureSectionNarrationAudioDecoded(section)
          .then(audioBuffer => {
            playNarrationBtn.disabled = false;
            playAudioBuffer(audioBuffer, playNarrationBtn, () => {
              playNarrationBtn.textContent = '▶ Play narration';
            });
            playNarrationBtn.textContent = '⏸ Pause';
          })
          .catch(err => {
            playNarrationBtn.disabled = false;
            sectionStatus.textContent = `Could not play narration: ${err.message}`;
            sectionStatus.classList.add('error');
          });
      });
      narrationAudioControls.appendChild(playNarrationBtn);
    }

    const recordNarrationBtn = document.createElement('button');
    recordNarrationBtn.type = 'button';
    recordNarrationBtn.className = 'btn-secondary';
    const recordNarrationRestingLabel = section.narrationAudioPreviewUrl ? 'Re-record narration' : 'Record narration';
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

    narrationAudio.appendChild(narrationAudioControls);

    // Drop target for dragging an audio clip in from "Your Media" (see
    // renderMediaBankItems) - a quicker alternative to recording fresh
    // when a clip that already fits exists there. stopPropagation on all
    // three so this doesn't also bubble up into .narrative-act-row's own
    // drop handler (handleChipDrop, for reordering/reassigning sections
    // between arc rows) - that one only ever expects a section-index drag,
    // not a media-bank one, so it'd just no-op, but there's no reason for
    // both handlers (and both drag-over highlights) to fire at once.
    narrationAudio.addEventListener('dragover', event => {
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

    // Reading order: title, then a labeled "Narration" block (what to say),
    // then the paper's own text under a "Scene Notes" label - reference
    // material the shot is grounded in, not shot direction - then the visual
    // box/footage actions last, once the presenter knows what the shot's
    // about and what they're saying over it.
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
    if (!section.narrationAudioPreviewUrl) narrationBlock.classList.add('needs-narration');
    const narrationLabel = document.createElement('div');
    narrationLabel.className = 'paper-section-text-label';
    narrationLabel.textContent = 'Narration';
    narrationBlock.appendChild(narrationLabel);
    narrationBlock.appendChild(narrationAudio);
    block.appendChild(narrationBlock);

    const sceneNotesLabel = document.createElement('div');
    sceneNotesLabel.className = 'paper-section-text-label';
    sceneNotesLabel.textContent = 'Scene Notes';
    block.appendChild(sceneNotesLabel);
    block.appendChild(body);

    if (section.entities && section.entities.length) {
      const entitiesLine = document.createElement('div');
      entitiesLine.className = 'paper-section-storyboard';
      appendStoryboardLine(entitiesLine, 'Entities', section.entities.map(e => e.name).join(', '));
      block.appendChild(entitiesLine);
    }

    block.appendChild(visualBox);
    block.appendChild(footageActions);
    block.appendChild(mediaResults);
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
    block.appendChild(body);
  }

  function updateRemoveBtn() {
    removeBtn.textContent = section.removed ? '↺' : '×';
    removeBtn.title = section.removed ? 'Restore this section' : 'Exclude this section';
  }
  updateRemoveBtn();

  removeBtn.addEventListener('click', event => {
    event.stopPropagation();
    section.removed = !section.removed;
    if (selectable) {
      // Arranged view: a deleted scene leaves the timeline and its arc row
      // entirely (renderMovieEditor is only ever fed non-removed sections)
      // and shows up in the "Deleted scenes" sidebar module, restorable
      // there (see renderDeletedScenesList) - rather than lingering in place
      // dimmed, which is the flat feed's behavior below.
      saveDebugSession();
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
    } else {
      block.classList.toggle('removed', section.removed);
      updateRemoveBtn();
    }
    updateComposeStoryboardVisibility();
  });

  // Clicking the card (anywhere that isn't the remove/split buttons or an
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
    insertSection(afterIndex, 'New Section', '', null, true);
    renderSectionFeed(resultsEl, currentLabel, currentSections);
    updateComposeStoryboardVisibility();
    saveDebugSession();
  });
  return divider;
}

function renderSectionFeed(container, label, sections) {
  container.innerHTML = '';
  hideSplitFloatingBtn(); // avoid a stale reference to a card this re-render just replaced

  // The paper's own source material only - never the scaffold scenes added
  // while arranging/storyboarding on storyboard.html (narrativeOnly AND
  // assigned to an arc act - see insertSection / the arranged view's
  // "+ Add Scene" and mode scaffolding). Those ride along in the shared saved
  // session (see saveDebugSession) but aren't source material and mustn't
  // swell this feed. A narrativeOnly section with no act is one added right
  // here on the flat feed (see buildInsertSectionDivider), which does belong.
  const sourceSections = sections.filter(section => !(section.narrativeOnly && currentAssignments[section.index]));

  const title = document.createElement('h2');
  title.textContent = 'Source material';
  container.appendChild(title);

  const header = document.createElement('div');
  header.className = 'paper-source-label';
  header.textContent = `${sourceSections.length} section${sourceSections.length === 1 ? '' : 's'} extracted. You can edit section headers and content, click a section to exclude, and split or add new sections. These
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

function runSuggestArcs() {
  suggestArcsBtn.disabled = true;
  suggestArcsStatusEl.textContent = 'Suggesting narrative arcs ...';
  suggestArcsStatusEl.classList.remove('error');
  arcSuggestionPanelEl.style.display = 'none';

  fetchSuggestArcs(recordedTranscript, Array.from(selectedFocusStatements), findAbstractText())
    .then(({ recommended, alternatives }) => {
      suggestArcsStatusEl.textContent = '';
      suggestArcsBtn.disabled = false;
      renderArcSuggestion(recommended, alternatives);
    })
    .catch(err => {
      suggestArcsStatusEl.textContent = err.message;
      suggestArcsStatusEl.classList.add('error');
      suggestArcsBtn.disabled = false;
    });
}

// suggestArcsBtn only exists on storyboard.html - guarded so this is a
// no-op on index.html (which loads the same shared script).
if (suggestArcsBtn) suggestArcsBtn.addEventListener('click', runSuggestArcs);

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
  card.className = 'arc-suggestion-card';

  const title = document.createElement('div');
  title.className = 'arc-suggestion-title';
  title.textContent = current.arc_name;
  card.appendChild(title);

  const partsList = document.createElement('div');
  partsList.className = 'arc-suggestion-parts';
  current.sections.forEach(part => {
    const partEl = document.createElement('div');
    partEl.className = 'arc-suggestion-part';
    partEl.textContent = part.description ? `${part.name} - ${part.description}` : part.name;
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
  acceptBtn.textContent = 'Apply this arc';
  acceptBtn.addEventListener('click', () => runAcceptArc(current));
  card.appendChild(acceptBtn);

  arcSuggestionPanelEl.appendChild(card);

  if (others.length > 0) {
    const otherLabel = document.createElement('p');
    otherLabel.className = 'chip-row-caption';
    otherLabel.style.marginTop = '14px';
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
        renderArcSuggestion(
          { arc_name: alt.arc_name, sections: alt.sections, reasoning: null },
          remaining.concat([{ arc_name: current.arc_name, sections: current.sections }])
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
    fetchSuggestArcs(recordedTranscript, Array.from(selectedFocusStatements).concat([customText]), findAbstractText())
      .then(({ recommended, alternatives }) => {
        suggestArcsStatusEl.textContent = '';
        renderArcSuggestion(recommended, alternatives);
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
// groups (renderMovieEditor) - each starting with one auto-created "New
// Section" to work with (see renderMovieEditor's own empty-row handling),
// not sections auto-assigned by an LLM. The presenter fills each act in
// from here (editing that starting section directly, the "+ Add Section"
// button per row, or dragging an already-placed section's chip into a
// different row). The suggestion panel (see renderArcSuggestion) is left
// open rather than hidden, so a different arc can still be accepted
// afterward; relocateArcSuggestionToSidebar then moves it out of the main
// column so it doesn't compete with the arranged view for space.
function runAcceptArc(arc) {
  selectedNarrationArc = { sections: arc.sections, arc_name: arc.arc_name };
  currentArcSections = arc.sections.map(s => ({ key: s.name, label: s.name, description: s.description || '' }));
  currentAssignments = {};
  selectedSectionIndices = new Set();

  // A previously accepted arc's storyboard/edit-plan work was written for
  // acts that may no longer exist once a different arc is accepted - stale
  // either way, so clear it and let the presenter regenerate fresh.
  currentSections.forEach(section => {
    delete section.visual;
    delete section.narration;
    delete section.editPlan;
  });

  const remaining = currentSections.filter(section => !section.removed);
  renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
  paperActionsEl.style.display = '';
  setStoryboardStatus('');
  editPlanActionEl.style.display = 'none';
  overallEditNotes = '';
  setEditPlanStatus('');
  editPlanOverallNotesEl.textContent = '';
  premiereExportActionEl.style.display = 'none';
  setPremiereExportStatus('');
  premiereExportFolderEl.textContent = '';
  setPreviewStatus('');
  previewVideoEl.style.display = 'none';
  previewVideoEl.removeAttribute('src');

  relocateAllSidebarModules();
  saveDebugSession();
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
  const hasIntent = !!recordedTranscript || selectedFocusStatements.size > 0;
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
    fetchDownloadStockMedia(section.index, 'video', video.video_url, premiereProjectId)
      .then(({ project_id, preview_url }) => {
        premiereProjectId = project_id;
        section.selectedVideo = { ...video, localPreviewUrl: preview_url };
        // Picking a found-footage frame is a deliberate choice - see
        // buildVisualBox's visualSource lookup (same reasoning as
        // runUploadFootage/runGenerateSketch's own).
        section.visualSource = 'stockVideo';
        // Full re-render (rather than just toggling .selected in place) so the
        // visual box picks up the new selection immediately - see buildVisualBox.
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
  label.textContent = `${audio.name || 'Untitled'} — ${audio.creator || 'unknown'}${licenseSuffix}`;
  option.appendChild(label);

  const player = document.createElement('audio');
  player.controls = true;
  player.src = audio.preview_url;
  player.addEventListener('click', event => event.stopPropagation());
  option.appendChild(player);

  option.addEventListener('click', event => {
    event.stopPropagation(); // don't let this bubble to the card's own click-to-select handler
    if (option.classList.contains('downloading')) return;
    option.classList.add('downloading');
    // A pick is a bare remote URL until it's actually downloaded to disk -
    // neither export path (the Premiere plugin or the ffmpeg render) can
    // use a URL directly. See fetchDownloadStockMedia's own comment.
    fetchDownloadStockMedia(section.index, 'audio', audio.preview_url, premiereProjectId)
      .then(({ project_id, preview_url }) => {
        premiereProjectId = project_id;
        section.selectedAudio = { ...audio, localPreviewUrl: preview_url };
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
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
// A-roll reflects narration state, B-roll reflects visual state, each on
// its own 3-step ladder (see buildVisualBox/VISUAL_BOX_RENDERERS and
// finishAssigningNarrationAudio for the same "real asset > drafted text
// only > nothing" distinction made elsewhere): unfilled (dashed, nothing
// yet) -> .drafted (an LLM-suggested line/description, no real asset
// attached) -> .filled (real recorded/dragged audio, or a real assigned
// visual). Both tracks share the same section ordering/widths, so a
// vertical slice through both tracks is one shot - same idea as a real
// timeline's synced audio/video tracks.
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
// by default (the narrative spine). Sound effects is only ever an explicit
// choice (a supplementary sound pick doesn't, on its own, make a whole scene
// a sound-effects scene).
function getSceneRole(section) {
  if (section.role && SCENE_ROLE_LABELS[section.role]) return section.role;
  if (section.visualSource === 'stockVideo') return 'bRoll';
  if (['sketch', 'animatedSketch', 'video'].includes(section.visualSource)) return 'aRoll';
  return 'aRoll';
}

// A scene's on-screen duration in seconds - from its (auto- or hand-)
// generated edit plan, falling back to a flat default so the timeline can
// still size it before an edit plan exists.
function getSceneDuration(section) {
  const d = section.editPlan && section.editPlan.durationSeconds;
  return (typeof d === 'number' && d > 0) ? d : DEFAULT_SCENE_SECONDS;
}

// Whether a scene's clip reads as filled / drafted for its own track role -
// A-roll on primary-visual state, B-roll on stock-pick state, sound effects
// on the sound-pick state (each on the same "real asset > drafted text only >
// nothing" ladder used elsewhere).
function isSceneFilledForRole(section, roleKey) {
  if (roleKey === 'bRoll') return section.visualSource === 'stockVideo';
  if (roleKey === 'soundEffects') return !!section.selectedAudio;
  return ['sketch', 'animatedSketch', 'video'].includes(section.visualSource);
}
function isSceneDraftedForRole(section, roleKey) {
  if (roleKey === 'bRoll') return !!section.videoQuery;
  if (roleKey === 'soundEffects') return !!section.audioQuery;
  return !!(section.visual && section.visual.trim());
}

// Dragging a documentary mode onto a timeline act scaffolds that act with the
// mode's scene template (see MODE_SCENE_TEMPLATES) - one A-roll/B-roll scene
// per entry, each a blank narrativeOnly scene the presenter then fills, with
// its role and an auto-generated edit plan (duration in seconds) already set.
// Replaces, not accumulates: the act's existing scaffold scenes (the previous
// mode's, plus any auto-blank/manually-added placeholders - all narrativeOnly)
// are cleared first, so re-dragging a mode resets the act rather than piling
// more scenes on. Real paper sections arranged into the act are kept as the
// source content the scaffold is built around.
function scaffoldModeOntoAct(actKey, modeKey) {
  const template = MODE_SCENE_TEMPLATES[modeKey];
  if (!template) return;

  currentSections = currentSections.filter(section => {
    const isActScaffold = section.narrativeOnly && currentAssignments[section.index] === actKey;
    if (isActScaffold) delete currentAssignments[section.index];
    return !isActScaffold;
  });

  template.forEach(spec => {
    const scene = insertSection(-1, spec.title, '', actKey, true);
    scene.role = spec.role;
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

function buildNarrativeTimeline(timelineEl, sections, assignmentsByIndex) {
  timelineEl.innerHTML = '';

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

  // A-roll (the shot's own primary visual - a generated sketch/animated
  // sketch, or real uploaded footage), B-roll (externally-sourced
  // supplementary footage - a Find Footage/stock pick), then Sound effects.
  // Each scene belongs to exactly ONE of these (its role - see getSceneRole),
  // and appears as a single clip in that track sized by its duration in
  // seconds (see getSceneDuration). The old standalone NARRATION track was
  // removed - A-roll now carries the narrative spine.
  const TRACK_DEFS = [
    { key: 'aRoll', label: 'A-ROLL' },
    { key: 'bRoll', label: 'B-ROLL' },
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

  currentArcSections.forEach(act => {
    const rowSections = sections.filter(s => assignmentsByIndex[s.index] === act.key);
    if (rowSections.length === 0) return; // renderMovieEditor auto-populates blank rows before this runs

    // Each scene sits in its own role's track, its clip sized by its
    // duration in seconds. An act's on-screen width is its longest track's
    // total seconds (max across tracks), so the tracks line up and a
    // 30s-of-A-roll act is visibly wider than a 10s one.
    const scenesByTrack = { aRoll: [], bRoll: [], soundEffects: [] };
    rowSections.forEach(section => { scenesByTrack[getSceneRole(section)].push(section); });
    const trackTotals = TRACK_DEFS.map(def => scenesByTrack[def.key].reduce((sum, s) => sum + getSceneDuration(s), 0));
    const actTotal = Math.max(1, ...trackTotals);

    // flex-basis pinned to 0 (not the shorthand's implied auto) so the ruler
    // label's own text width doesn't compete with its flex-grow share and
    // misalign the ruler against the content-less clips below it.
    const actFlex = `${actTotal} 1 0`;

    const rulerGroup = document.createElement('div');
    rulerGroup.className = 'premiere-timeline-act';
    rulerGroup.style.flex = actFlex;
    rulerGroup.textContent = act.label;
    rulerGroup.title = 'Drag a documentary mode here to scaffold scenes for this act';
    rulerBody.appendChild(rulerGroup);

    const trackGroups = trackBodies.map(body => {
      const group = document.createElement('div');
      group.className = 'premiere-timeline-act-group';
      group.style.flex = actFlex;
      body.appendChild(group);
      return group;
    });

    // Ruler label + all track groups are one drop unit (highlight together).
    const actDropEls = [rulerGroup, ...trackGroups];
    actDropEls.forEach(el => makeActModeDropTarget(el, act.key, actDropEls));

    TRACK_DEFS.forEach((def, ti) => {
      scenesByTrack[def.key].forEach(section => {
        const seconds = getSceneDuration(section);
        const clip = document.createElement('div');
        clip.className = 'premiere-timeline-clip';
        clip.style.flex = `${seconds} 1 0`; // width proportional to duration
        clip.classList.toggle('filled', isSceneFilledForRole(section, def.key));
        clip.classList.toggle('drafted', !isSceneFilledForRole(section, def.key) && isSceneDraftedForRole(section, def.key));
        clip.title = `${section.title} · ${Math.round(seconds)}s`;
        // Double-click (not single) so a click doesn't fight with the
        // hover/scale affordance - scrolls to the real section card.
        clip.addEventListener('dblclick', () => {
          const target = document.querySelector(`.paper-section-block[data-section-index="${section.index}"]`);
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        trackGroups[ti].appendChild(clip);
        if (!clipsBySectionIndex.has(section.index)) clipsBySectionIndex.set(section.index, []);
        clipsBySectionIndex.get(section.index).push(clip);
      });

      // A trailing spacer fills the rest of a track shorter than the act's
      // longest, so all three tracks stay aligned under the same act width
      // (and a short B-roll track visibly leaves the act's tail uncovered).
      const remainder = actTotal - trackTotals[ti];
      if (remainder > 0.001) {
        const spacer = document.createElement('div');
        spacer.className = 'premiere-timeline-clip spacer';
        spacer.style.flex = `${remainder} 1 0`;
        trackGroups[ti].appendChild(spacer);
      }
    });
  });

  return clipsBySectionIndex;
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
// button that puts the scene back. The whole module hides itself when nothing
// is deleted, so it doesn't sit empty in the sidebar. A no-op on index.html,
// which has no such module.
function renderDeletedScenesList() {
  if (!deletedScenesListEl) return;
  deletedScenesListEl.innerHTML = '';
  const deleted = currentSections.filter(section => section.removed);
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
  container.innerHTML = '';
  hideSplitFloatingBtn(); // avoid a stale reference to a card this re-render just replaced

  // Prune any selected index no longer present (excluded/removed) - no more
  // default "select the first section" fallback, since there's no preview
  // left to seed; an empty selection is a perfectly normal starting state.
  selectedSectionIndices.forEach(index => {
    if (!sections.some(s => s.index === index)) selectedSectionIndices.delete(index);
  });

  const selectionCount = selectedSectionIndices.size;
  const arranged = sections.filter(s => assignmentsByIndex[s.index]);
  const target = selectionCount > 0 ? arranged.filter(s => selectedSectionIndices.has(s.index)) : arranged;

  // Heading row: the title on the left, action buttons pinned to the far
  // right (see .storyboard-heading-row / .storyboard-heading-actions) - "Clear
  // all scenes" then "Render MP4", shown only when something's arranged. The
  // h2 reuses #paper-sections h2's existing styling. Clear all empties the
  // whole timeline in one go (every arranged scene moves to the "Deleted
  // scenes" sidebar module, restorable there, so it's reversible - confirmed
  // first). Render MP4 (built here now, not a fixed panel) kicks off the
  // ffmpeg render; its status shows inline and the result is opened directly
  // from premiere_exports/<id>/documentary.mp4 (no in-app preview).
  renderMovieBtn = null;
  renderMovieStatusEl = null;
  const headingRow = document.createElement('div');
  headingRow.className = 'storyboard-heading-row';
  const heading = document.createElement('h2');
  heading.textContent = 'Your documentary storyboard';
  headingRow.appendChild(heading);
  if (arranged.length > 0) {
    const actions = document.createElement('div');
    actions.className = 'storyboard-heading-actions';

    const clearAllBtn = document.createElement('button');
    clearAllBtn.type = 'button';
    clearAllBtn.className = 'btn-secondary clear-all-scenes-btn';
    clearAllBtn.textContent = 'Clear all scenes';
    clearAllBtn.title = 'Move every scene to Deleted scenes (restorable there)';
    clearAllBtn.addEventListener('click', () => {
      if (!window.confirm("Clear all scenes from the timeline? They'll move to Deleted scenes, where you can restore them.")) return;
      currentSections.forEach(s => {
        if (currentAssignments[s.index] && !s.removed) s.removed = true;
      });
      selectedSectionIndices.clear();
      saveDebugSession();
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
    });
    actions.appendChild(clearAllBtn);

    renderMovieBtn = document.createElement('button');
    renderMovieBtn.type = 'button';
    renderMovieBtn.className = 'btn-primary render-movie-btn';
    renderMovieBtn.textContent = 'Render MP4';
    renderMovieBtn.title = 'Assemble the scenes into an MP4 with narration and sound effects';
    renderMovieBtn.addEventListener('click', runRenderMovie);
    actions.appendChild(renderMovieBtn);

    renderMovieStatusEl = document.createElement('span');
    renderMovieStatusEl.className = 'status-line render-movie-status';
    actions.appendChild(renderMovieStatusEl);

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

  const timelineEl = document.createElement('div');
  timelineEl.className = 'premiere-timeline';
  arcLayout.appendChild(timelineEl);

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
  modesTitle.textContent = 'Documentary modes';
  modesBlock.appendChild(modesTitle);

  const modesRow = document.createElement('div');
  modesRow.className = 'chip-row documentary-modes-bar-row';
  modesBlock.appendChild(modesRow);

  DOCUMENTARY_MODES.forEach(mode => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip suggested';
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
  modesHint.textContent = 'Drag onto an act to scaffold its scenes, or click to set the overall mode.';
  modesBlock.appendChild(modesHint);

  // Toggleable technique chips - see DOCUMENTARY_TECHNIQUES above for what
  // these are/aren't. Back in its own sidebar (see innerLayout above),
  // same .narrative-arc-techniques styling as when it lived in the old
  // .narrative-arc-outline sidebar.
  const techniquesBlock = document.createElement('div');
  techniquesBlock.className = 'narrative-arc-techniques';

  const techniquesTitle = document.createElement('h3');
  techniquesTitle.textContent = 'Documentary techniques';
  techniquesBlock.appendChild(techniquesTitle);

  // Same kind of instruction the Documentary modes strip carries - tells the
  // presenter these chips are draggable (see the chip dragstart / the
  // scene-notes drop handler in buildSectionBlock).
  const techniquesHint = document.createElement('div');
  techniquesHint.className = 'chip-row-caption';
  techniquesHint.textContent = 'Drag a technique onto a scene\'s Scene Notes to give the shot more direction.';
  techniquesBlock.appendChild(techniquesHint);

  const techniquesRow = document.createElement('div');
  techniquesRow.className = 'chip-row';
  DOCUMENTARY_TECHNIQUES.forEach(technique => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip suggested';
    chip.classList.toggle('selected', selectedTechniques.has(technique));
    chip.textContent = technique;
    chip.addEventListener('click', () => {
      if (selectedTechniques.has(technique)) selectedTechniques.delete(technique);
      else selectedTechniques.add(technique);
      chip.classList.toggle('selected', selectedTechniques.has(technique));
      saveDebugSession();
    });
    // Also draggable onto a section's text field (see buildSectionBlock's
    // drop handler) - a quick way to drop a reminder of this technique
    // right into the shot's own working text.
    chip.draggable = true;
    chip.addEventListener('dragstart', event => {
      event.dataTransfer.setData('application/x-technique', technique);
      event.dataTransfer.effectAllowed = 'copy';
    });
    techniquesRow.appendChild(chip);
  });
  techniquesBlock.appendChild(techniquesRow);
  sidePanel.appendChild(techniquesBlock);

  const arcRows = document.createElement('div');
  arcRows.className = 'narrative-arc-rows';
  innerLayout.appendChild(arcRows);

  currentArcSections.forEach(act => {
    let rowSections = sections.filter(s => assignmentsByIndex[s.index] === act.key);

    // Every act always has at least one real, fully-functional section to
    // work with - Record Webcam/Record Narration/Find Footage/etc. only
    // ever render for a real section object (see buildSectionBlock), not a
    // decorative stand-in - so an empty row gets one auto-created here
    // (same shape "+ Add Section" below creates manually) rather than
    // showing a placeholder with no controls at all. Runs at most once per
    // row per render, since rowSections is never empty again afterward.
    if (rowSections.length === 0) {
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
    actTitle.textContent = act.label;
    heading.appendChild(actTitle);
    // The arc part's description moved into each scene's narration line (the
    // narration instructions - see buildSectionBlock), so it's no longer
    // shown here in the act heading.
    rowGroup.appendChild(heading);

    const row = document.createElement('div');
    row.className = 'narrative-act-row';
    row.addEventListener('dragover', event => {
      event.preventDefault();
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => {
      row.classList.remove('drag-over');
    });
    row.addEventListener('drop', event => {
      row.classList.remove('drag-over');
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
  const clipsBySectionIndex = buildNarrativeTimeline(timelineEl, sections, assignmentsByIndex);

  // The Documentary modes strip lives INSIDE the timeline, above its ruler/
  // tracks - inserted here (not earlier) because buildNarrativeTimeline clears
  // timelineEl's contents when it (re)builds the ruler and tracks.
  timelineEl.insertBefore(modesBlock, timelineEl.firstChild);

  container.appendChild(arcLayout);

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

  const content = [section.text, section.narration].filter(part => part && part.trim()).join('\n\n').trim();
  if (!content) {
    applyFallback();
    return Promise.resolve();
  }

  const documentaryGoal = (documentaryIntentInput ? documentaryIntentInput.value : recordedTranscript).trim();
  return fetchStoryboard(
    [{ index: section.index, title: section.title, text: content, act: currentAssignments[section.index] }],
    documentaryGoal, currentArcSections.map(s => s.label), selectedDocumentaryMode
  )
    .then(({ storyboard }) => {
      const result = (storyboard || []).find(s => s.index === section.index);
      if (result) {
        section.videoQuery = section.videoQuery || result.video_query;
        section.audioQuery = section.audioQuery || result.audio_query;
        if (!(section.entities && section.entities.length)) section.entities = result.entities || [];
      }
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

function runFindFootage(section, resultsEl, statusEl, btn) {
  btn.disabled = true;
  statusEl.textContent = section.videoQuery
    ? 'Searching for video options...'
    : 'Finding searchable terms, then searching...';
  statusEl.classList.remove('error');

  // Returned (not fire-and-forget) so triggerFindFootageSweep can throttle
  // how many of these run at once across a whole sweep. Derives search phrases
  // first if the scene doesn't have them yet (see ensureFootageQueries).
  return ensureFootageQueries(section).then(() => {
    const fetches = [fetchVideoOptions(section.videoQuery)];
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
// go looking for B-roll/SFX automatically, rather than making the
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
    !section.removed &&
    currentAssignments[section.index] &&
    section.videoQuery &&
    !section.selectedVideo &&
    !section.selectedAudio
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

// --- Premiere Pro (UXP) file-based bridge: uploading a researcher's own
// footage for a shot, and exporting the whole arc's edit plan - see
// backend/premiere_bridge.py for why this is file-based rather than a
// network call in both directions (macOS restricts plain http:// for a UXP
// plugin's own outbound requests; local file access has no such restriction).
function runUploadFootage(section, file, labelEl, inputEl) {
  inputEl.disabled = true;
  labelEl.textContent = `Uploading "${file.name}"...`;
  labelEl.classList.remove('error');

  fetchUploadFootage(file, section.index, premiereProjectId)
    .then(({ project_id, footage_path, preview_url }) => {
      premiereProjectId = project_id;
      section.uploadedFootagePath = footage_path;
      // Servable by the static file server (see backend/server.py's
      // /premiere/upload_footage) - lets buildVisualBox actually play back
      // whatever was just uploaded/recorded, not just show its filename.
      section.uploadedFootagePreviewUrl = preview_url || null;
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
    })
    .catch(err => {
      labelEl.textContent = err.message;
      labelEl.classList.add('error');
      inputEl.disabled = false;
    });
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
    .then(({ project_id, preview_url }) => {
      premiereProjectId = project_id;
      mediaBankItems.push({ kind, label, previewUrl: preview_url });
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
  const hasBasis = !!(section.text && section.text.trim()) || !!(section.narration && section.narration.trim());
  if (!hasBasis) {
    statusEl.textContent = 'Add section text or narration first - there\'s nothing to base a visual on yet.';
    statusEl.classList.add('error');
    return;
  }

  btn.disabled = true;
  statusEl.textContent = 'Drafting a visual (~5-10s)...';
  statusEl.classList.remove('error');

  const documentaryGoal = (documentaryIntentInput ? documentaryIntentInput.value : recordedTranscript).trim();
  const content = [section.text, section.narration].filter(part => part && part.trim()).join('\n\n');

  fetchStoryboard(
    [{ index: section.index, title: section.title, text: content, act: currentAssignments[section.index] }],
    documentaryGoal, currentArcSections.map(s => s.label), selectedDocumentaryMode
  )
    .then(({ storyboard }) => {
      const result = storyboard.find(s => s.index === section.index);
      if (!result) throw new Error('No visual came back for this section - try again.');
      section.visual = result.visual;
      // Don't overwrite a real recorded/dragged narration (see
      // finishAssigningNarrationAudio) with an LLM-invented line that no
      // longer matches the actual audio.
      if (!section.narrationAudioPreviewUrl) section.narration = result.narration;
      section.entities = result.entities || [];
      section.videoQuery = result.video_query;
      section.audioQuery = result.audio_query;
      saveDebugSession();

      statusEl.textContent = draftedMessage;
      return generateStep().catch(err => {
        // The draft above (visual/narration/entities/videoQuery/
        // audioQuery) already succeeded and is still worth keeping/
        // showing - Find Footage only needs videoQuery, for instance, not
        // a generated visual - so only the generation step itself failed;
        // don't let that also hide the draft (the re-render still happens
        // in the .then below either way).
        statusEl.textContent = `Drafted a visual, but generation failed: ${err.message}`;
        statusEl.classList.add('error');
      });
    })
    .then(() => {
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      editPlanActionEl.style.display = '';
      premiereExportActionEl.style.display = '';
    })
    .catch(err => {
      statusEl.textContent = err.message;
      statusEl.classList.add('error');
      btn.disabled = false;
    });
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
  btn.disabled = true;
  statusEl.textContent = 'Designing this shot (~30s: shot plan + start/end frames)...';
  statusEl.classList.remove('error');

  const act = currentArcSections.find(a => a.key === currentAssignments[section.index]);
  fetchGenerateShot({
    sectionIndex: section.index,
    title: section.title,
    sceneNotes: section.text,
    narration: section.narration,
    actTitle: act ? act.label : '',
    abstract: findAbstractText(),
    documentaryMode: selectedDocumentaryMode,
    projectId: premiereProjectId,
  })
    .then(({ project_id, shot_plan, start_preview_url, end_preview_url }) => {
      premiereProjectId = project_id;
      section.shotPlan = shot_plan;
      section.startFramePreviewUrl = start_preview_url;
      section.endFramePreviewUrl = end_preview_url;
      // The backend saves both frames for this section to the same filenames
      // (see /paper/generate_shot) - a fresh cache-busting key each time so
      // buildVisualBox's <img src> isn't served the browser's cached copy.
      section.shotFramesGeneratedAt = Date.now();
      // Generating a shot is a deliberate choice - it wins the visualSource
      // lookup in buildVisualBox (same reasoning as runUploadFootage's own).
      section.visualSource = 'shotFrames';
      // The shot plan's duration drives both the timeline clip width
      // (getSceneDuration) and the render (movie_render) - fold it into the
      // section's edit plan, keeping any other edit-plan fields already set.
      section.editPlan = {
        transitionIn: (section.editPlan && section.editPlan.transitionIn) || 'hard_cut',
        durationSeconds: shot_plan.duration_seconds,
        kenBurns: (section.editPlan && section.editPlan.kenBurns) || { enabled: false, pan: null },
        textOverlay: (section.editPlan && section.editPlan.textOverlay) || null,
      };
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      editPlanActionEl.style.display = '';
      premiereExportActionEl.style.display = '';
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
    return;
  }

  if (triggerBtn) triggerBtn.disabled = true;
  setStoryboardStatus(sectionsToUse.length === 1
    ? `Generating a storyboard for "${sectionsToUse[0].title}" ...`
    : 'Generating a loose storyboard ...');

  const documentaryGoal = (documentaryIntentInput ? documentaryIntentInput.value : recordedTranscript).trim();

  // Combines text and narration rather than favoring one - see
  // buildSectionBlock's Generate Sketch button/runGenerateSketch, which
  // does the same for a single section; text may now hold anything from
  // dragged-in technique reminders to source-material excerpts (see
  // buildSectionBlock's drop handler), and narration is the actual spoken
  // script, so both are meaningful context for what the shot should show.
  // The backend only ever sees one "content" field per section either way.
  fetchStoryboard(sectionsToUse.map(({ index, title, text, narration }) => ({
    index, title, text: [text, narration].filter(part => part && part.trim()).join('\n\n'), act: currentAssignments[index],
  })), documentaryGoal, currentArcSections.map(s => s.label), selectedDocumentaryMode)
    .then(({ storyboard }) => {
      storyboard.forEach(({ index, visual, narration, entities, video_query, audio_query }) => {
        const section = currentSections.find(s => s.index === index);
        if (section) {
          section.visual = visual;
          // Don't overwrite a real recorded/dragged narration (see
          // finishAssigningNarrationAudio) with an LLM-invented line that
          // no longer matches the actual audio - only fill narration in
          // when there's no voice recording backing it yet.
          if (!section.narrationAudioPreviewUrl) section.narration = narration;
          section.entities = entities || [];
          section.videoQuery = video_query;
          section.audioQuery = audio_query;
        }
      });

      setStoryboardStatus(`Done. Generated a storyboard for ${sectionsToUse.length} section${sectionsToUse.length === 1 ? '' : 's'}.`);
      const remaining = currentSections.filter(section => !section.removed && currentAssignments[section.index]);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      // The other half of triggerFindFootageSweep's precondition (alongside
      // a picked mode) - a no-op if no mode is selected yet. Needs to run
      // after the render above, since it locates each section's Find
      // Footage button/status/results by selector in the freshly-built DOM.
      triggerFindFootageSweep();
      if (triggerBtn) triggerBtn.disabled = false;
      editPlanActionEl.style.display = '';
      premiereExportActionEl.style.display = '';
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
  editPlanOverallNotesEl.textContent = '';

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

      setEditPlanStatus(`Done. Generated an edit plan for ${shots.length} shot${shots.length === 1 ? '' : 's'}.`);
      if (overallEditNotes) editPlanOverallNotesEl.textContent = `Overall notes: ${overallEditNotes}`;
      const remaining = currentSections.filter(section => !section.removed && currentAssignments[section.index]);
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
function runExportForPremiere() {
  const storyboarded = currentSections.filter(section => !section.removed && currentAssignments[section.index] && section.visual);
  if (storyboarded.length === 0) {
    setPremiereExportStatus('No storyboarded sections yet - generate a storyboard first.', true);
    return;
  }

  exportPremiereBtn.disabled = true;
  setPremiereExportStatus('Writing edit plan for Premiere ...');
  premiereExportFolderEl.textContent = '';

  const payload = storyboarded.map(section => ({
    index: section.index,
    title: section.title,
    act: currentAssignments[section.index],
    narration: section.narration,
    narration_audio_path: section.narrationAudioPreviewUrl || null,
    uploaded_footage_path: section.uploadedFootagePath || null,
    selected_video: section.selectedVideo || null,
    selected_audio: section.selectedAudio || null,
    // snake_case to match every other key in this payload (and what
    // premiere-plugin/main.js reads back out of edit_plan.json) - only
    // section.editPlan itself is camelCase, for consistency with the rest
    // of this file's JS state.
    edit_plan: section.editPlan
      ? {
        transition_in: section.editPlan.transitionIn,
        duration_seconds: section.editPlan.durationSeconds,
        ken_burns: section.editPlan.kenBurns,
        text_overlay: section.editPlan.textOverlay,
      }
      : null,
  }));

  fetchPremiereExport(payload, premiereProjectId)
    .then(({ project_id, folder_path }) => {
      premiereProjectId = project_id;
      setPremiereExportStatus(`Done. Wrote an edit plan for ${storyboarded.length} shot${storyboarded.length === 1 ? '' : 's'}.`);
      premiereExportFolderEl.textContent = `Load this from the Premiere plugin: ${folder_path}`;
      exportPremiereBtn.disabled = false;
      saveDebugSession();
    })
    .catch(err => {
      setPremiereExportStatus(err.message, true);
      exportPremiereBtn.disabled = false;
    });
}

function runCheckForPreview() {
  if (!premiereProjectId) {
    setPreviewStatus('Export for Premiere first, then load/apply/export the plan in the Premiere plugin.', true);
    return;
  }

  checkPreviewBtn.disabled = true;
  setPreviewStatus('Checking ...');
  previewVideoEl.style.display = 'none';

  const previewUrl = `/premiere_exports/${premiereProjectId}/rough_cut.mp4?t=${Date.now()}`;
  fetch(previewUrl, { method: 'HEAD' })
    .then(response => {
      if (!response.ok) throw new Error('not found');
      previewVideoEl.src = previewUrl;
      previewVideoEl.style.display = '';
      setPreviewStatus('Loaded rough_cut.mp4.');
    })
    .catch(() => {
      setPreviewStatus('No rough_cut.mp4 yet - export it from the Premiere plugin first.', true);
    })
    .finally(() => {
      checkPreviewBtn.disabled = false;
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
  const previewBySource = {
    stockVideo: section.selectedVideo && section.selectedVideo.localPreviewUrl,
    video: section.uploadedFootagePreviewUrl,
    animatedSketch: section.animatedSketchPreviewUrl,
    sketch: section.sketchPreviewUrl,
  };
  for (const key of [section.visualSource, 'stockVideo', 'video', 'animatedSketch', 'sketch']) {
    if (key && previewBySource[key]) return { previewUrl: previewBySource[key], figureDataUrl: null };
  }
  if (section.image) return { previewUrl: null, figureDataUrl: section.image };
  return { previewUrl: null, figureDataUrl: null };
}

let renderPollTimer = null;

function runRenderMovie() {
  // Renderable = arranged and has some visual: a narration-driven shot (start
  // + end frames), a generated storyboard visual, a stock/uploaded clip, or
  // the paper figure. (Shot-frame scenes don't set section.visual, so this
  // can't just check that.)
  const storyboarded = currentSections.filter(section =>
    !section.removed && currentAssignments[section.index] && (
      (section.startFramePreviewUrl && section.endFramePreviewUrl) ||
      section.visual || section.selectedVideo || section.uploadedFootagePreviewUrl || section.image
    ));
  if (storyboarded.length === 0) {
    setRenderMovieStatus('No shots yet - generate a shot (or pick footage) for a scene first.', true);
    return;
  }

  // Build the payload up front, bailing (before touching the server) if any
  // shot has no resolvable visual - the render route rejects that anyway,
  // but naming the offending section here is friendlier than a generic
  // server error mid-render.
  const payload = [];
  for (const section of storyboarded) {
    // A narration-driven shot (start + end frames) takes priority - it
    // hard-cuts between the two frames in the render. Otherwise fall back to
    // the single resolved visual (stock/uploaded/sketch) or the paper figure.
    const hasShotFrames = !!(section.startFramePreviewUrl && section.endFramePreviewUrl);
    let previewUrl = null;
    let figureDataUrl = null;
    if (!hasShotFrames) {
      ({ previewUrl, figureDataUrl } = resolveSectionVisualForRender(section));
      if (!previewUrl && !figureDataUrl) {
        setRenderMovieStatus(`"${section.title}" has no usable visual yet - generate a shot, pick footage, or use its figure image, then try again.`, true);
        return;
      }
    }
    payload.push({
      title: section.title,
      start_frame_preview_url: hasShotFrames ? section.startFramePreviewUrl : null,
      end_frame_preview_url: hasShotFrames ? section.endFramePreviewUrl : null,
      visual_preview_url: previewUrl,
      figure_image_data_url: (previewUrl || hasShotFrames) ? null : figureDataUrl,
      narration_audio_path: section.narrationAudioPreviewUrl || null,
      stock_audio_preview_url: (section.selectedAudio && section.selectedAudio.localPreviewUrl) || null,
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
  setRenderMovieStatus('Starting render ...');
  if (renderPollTimer) { clearInterval(renderPollTimer); renderPollTimer = null; }

  fetchRenderStart(payload, premiereProjectId)
    .then(({ project_id }) => {
      premiereProjectId = project_id;
      saveDebugSession();
      setRenderMovieStatus('Rendering ...');
      pollRenderStatus();
    })
    .catch(err => {
      setRenderMovieStatus(err.message, true);
      renderMovieBtn.disabled = false;
    });
}

// Self-clearing poll of /render/status to completion - justified here (over
// the manual-click runCheckForPreview pattern) because, unlike the Premiere
// round-trip, the backend itself performs and knows the render's state, so an
// owned poll is strictly better. On done, the status just names the output
// file; there's no in-app preview - the presenter opens the MP4 directly.
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
          setRenderMovieStatus(`Done - premiere_exports/${premiereProjectId}/documentary.mp4`);
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
const paperActionsEl = document.getElementById('paper-actions');
const storyboardArcModuleEl = document.getElementById('storyboard-arc-module');
const mediaBankModuleEl = document.getElementById('media-bank-module');
const sourceMaterialModuleEl = document.getElementById('source-material-module');
const deletedScenesModuleEl = document.getElementById('deleted-scenes-module');
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
const editPlanActionEl = document.getElementById('edit-plan-action');
const editPlanOverallNotesEl = document.getElementById('edit-plan-overall-notes');
const premiereExportActionEl = document.getElementById('premiere-export-action');
const exportPremiereBtn = document.getElementById('export-premiere-btn');
const premiereExportStatusEl = document.getElementById('premiere-export-status');
const premiereExportFolderEl = document.getElementById('premiere-export-folder');
const checkPreviewBtn = document.getElementById('check-preview-btn');
const previewStatusEl = document.getElementById('preview-status');
const previewVideoEl = document.getElementById('preview-video');
// The "Render MP4" button + its status live in the storyboard heading row now
// (built per-render in renderMovieEditor, next to "Clear all scenes"), not in
// a fixed panel - so these are reassigned each render rather than queried once.
// There's no in-app preview; the result is opened directly from
// premiere_exports/<id>/documentary.mp4.
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

// --- Floating "Split into new section" button: appears near the cursor
// when the presenter highlights text inside a section's body (works whether
// or not that text is currently in edit mode - see makeEditable) - a
// quicker, more discoverable way to choose a split point than a dedicated
// button sitting on every card. Only responds to mouse-drag selections;
// keyboard-only (shift+arrow) text selection isn't covered.
const splitFloatingBtn = document.createElement('button');
splitFloatingBtn.type = 'button';
splitFloatingBtn.className = 'split-floating-btn';
splitFloatingBtn.textContent = 'Split into new section';
splitFloatingBtn.style.display = 'none';
document.body.appendChild(splitFloatingBtn);

let splitFloatingContext = null; // { section, offset }

function hideSplitFloatingBtn() {
  splitFloatingBtn.style.display = 'none';
  splitFloatingContext = null;
}

// Character offset of a Range boundary (node/nodeOffset) within
// containerEl's full text content - translates a browser Selection back
// into a plain-string split point in section.text.
function textOffsetWithin(containerEl, node, nodeOffset) {
  const measuring = document.createRange();
  measuring.selectNodeContents(containerEl);
  measuring.setEnd(node, nodeOffset);
  return measuring.toString().length;
}

document.addEventListener('mouseup', event => {
  if (event.target === splitFloatingBtn) return; // let its own click handler run instead
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    hideSplitFloatingBtn();
    return;
  }

  const range = selection.getRangeAt(0);
  const startEl = range.startContainer.nodeType === Node.TEXT_NODE
    ? range.startContainer.parentElement
    : range.startContainer;
  const bodyEl = startEl && startEl.closest && startEl.closest('.paper-section-text');
  const block = bodyEl && bodyEl.closest('.paper-section-block');
  const index = block ? parseInt(block.dataset.sectionIndex, 10) : NaN;
  const section = currentSections.find(s => s.index === index);
  if (!bodyEl || !section) {
    hideSplitFloatingBtn();
    return;
  }

  const offset = textOffsetWithin(bodyEl, range.startContainer, range.startOffset);
  const rect = range.getBoundingClientRect();
  splitFloatingBtn.style.left = `${window.scrollX + rect.left}px`;
  splitFloatingBtn.style.top = `${window.scrollY + rect.top - 36}px`;
  splitFloatingBtn.style.display = '';
  splitFloatingContext = { section, offset };
});

// Without this, the button losing focus/the selection collapsing on
// mousedown would fire before our click handler gets to read splitFloatingContext.
splitFloatingBtn.addEventListener('mousedown', event => event.preventDefault());

splitFloatingBtn.addEventListener('click', () => {
  if (!splitFloatingContext) return;
  const { section, offset } = splitFloatingContext;
  hideSplitFloatingBtn();
  if (!runSplitSectionAt(section, offset)) return;
  if (currentAssignments[section.index]) {
    const remaining = currentSections.filter(s => !s.removed);
    renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
  } else {
    renderSectionFeed(resultsEl, currentLabel, currentSections);
  }
  saveDebugSession();
});

document.addEventListener('mousedown', event => {
  if (event.target !== splitFloatingBtn) hideSplitFloatingBtn();
});

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

function setPremiereExportStatus(message, isError) {
  premiereExportStatusEl.textContent = message || '';
  premiereExportStatusEl.classList.toggle('error', !!isError);
}

function setPreviewStatus(message, isError) {
  previewStatusEl.textContent = message || '';
  previewStatusEl.classList.toggle('error', !!isError);
}

function setRenderMovieStatus(message, isError) {
  if (!renderMovieStatusEl) return; // heading row not built (e.g. index.html)
  renderMovieStatusEl.textContent = message || '';
  renderMovieStatusEl.classList.toggle('error', !!isError);
}

// extractBtn only exists on index.html; exportPremiereBtn/checkPreviewBtn
// only exist on storyboard.html - both index.html and storyboard.html load
// this same shared script, so each wiring is guarded to be a no-op on the
// page where its target doesn't exist.
if (extractBtn) extractBtn.addEventListener('click', runExtraction);
if (exportPremiereBtn) exportPremiereBtn.addEventListener('click', runExportForPremiere);
if (checkPreviewBtn) checkPreviewBtn.addEventListener('click', runCheckForPreview);
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
function relocateArcSuggestionToSidebar() {
  if (!sidebarStackEl || !storyboardArcModuleEl) return;
  storyboardArcModuleEl.classList.add('module-card--in-sidebar');
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
  mediaBankModuleEl.style.display = '';
  sidebarStackEl.appendChild(mediaBankModuleEl);
}

function relocateSourceMaterialToSidebar() {
  if (!sidebarStackEl || !sourceMaterialModuleEl) return;
  sourceMaterialModuleEl.classList.add('module-card--in-sidebar');
  sourceMaterialModuleEl.style.display = '';
  sidebarStackEl.appendChild(sourceMaterialModuleEl);
}

// Deleted scenes module (see renderDeletedScenesList) - moved into the same
// sidebar, but its visibility is left to renderDeletedScenesList (hidden when
// nothing's deleted), unlike the others which are always shown once relocated.
function relocateDeletedScenesToSidebar() {
  if (!sidebarStackEl || !deletedScenesModuleEl) return;
  deletedScenesModuleEl.classList.add('module-card--in-sidebar');
  sidebarStackEl.appendChild(deletedScenesModuleEl);
  renderDeletedScenesList();
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
  relocateDeletedScenesToSidebar();
  if (togglePanelsBtn) togglePanelsBtn.style.display = '';
}

// Collapses/expands #storyboard-arc-module + #media-bank-module +
// #source-material-module together, by hiding the one shared container
// they've all relocated into (see relocateAllSidebarModules) rather than
// each individually - #main-column (the same flex row's other child)
// naturally expands to fill the freed width, no extra rule needed for that
// side (see styles-index.css's .sidebar-stack.collapsed).
if (togglePanelsBtn) {
  togglePanelsBtn.addEventListener('click', () => {
    const collapsed = sidebarStackEl.classList.toggle('collapsed');
    togglePanelsBtn.textContent = collapsed ? 'Show panels' : 'Hide panels';
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

// Set once "Clear saved session" is clicked, so the beforeunload handler
// below doesn't immediately re-save the (still in-memory) old state right
// back to localStorage on the very reload meant to clear it - that was the
// bug: clearDebugSession() removed the key, but saveDebugSession() ran
// again a moment later on unload and put it right back.
let debugSessionCleared = false;

function saveDebugSession() {
  if (debugSessionCleared) return;
  try {
    localStorage.setItem(DEBUG_SESSION_STORAGE_KEY, JSON.stringify({
      currentLabel,
      currentSections,
      currentAssignments,
      currentArcSections,
      recordedTranscript,
      selectedFocusStatements: Array.from(selectedFocusStatements),
      selectedTechniques: Array.from(selectedTechniques),
      selectedNarrationArc,
      recordedNarrationDurationSeconds,
      recordedNarrationExtension,
      persistedNarrationPreviewUrl,
      premiereProjectId,
      // mediaBankItems deliberately not persisted - see its own comment,
      // just above where it's declared.
    }));
  } catch (err) {
    // Quota exceeded (large embedded figure images) or localStorage
    // unavailable (private browsing) - not worth failing the UI over.
  }
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
  // One-time migration: blank placeholders created before the default
  // title changed from "New Section" to "New Scene" (see renderMovieEditor/
  // its "+ Add Section" button) are still sitting in old saved sessions
  // with the old title - narrativeOnly (see insertSection) safely scopes
  // this to just those, not a real paper section a researcher happened to
  // title "New Section" themselves.
  currentSections.forEach(section => {
    if (section.narrativeOnly && section.title === 'New Section') section.title = 'New Scene';
  });
  currentAssignments = saved.currentAssignments || {};
  currentArcSections = Array.isArray(saved.currentArcSections) ? saved.currentArcSections : [];
  recordedTranscript = saved.recordedTranscript || '';
  selectedFocusStatements = new Set(Array.isArray(saved.selectedFocusStatements) ? saved.selectedFocusStatements : []);
  selectedTechniques = new Set(Array.isArray(saved.selectedTechniques) ? saved.selectedTechniques : []);
  selectedNarrationArc = saved.selectedNarrationArc || null;
  recordedNarrationDurationSeconds = saved.recordedNarrationDurationSeconds || null;
  recordedNarrationExtension = saved.recordedNarrationExtension || 'webm';
  persistedNarrationPreviewUrl = saved.persistedNarrationPreviewUrl || null;
  premiereProjectId = saved.premiereProjectId || null;
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
    // --- index.html: restore the editable source-material feed, the
    // transcript display, focus-chip selections, and (best-effort)
    // in-browser playback of the last recording.
    if (currentSections.length) renderSectionFeed(resultsEl, currentLabel, currentSections);
    if (intentSuggestedChipsEl) {
      Array.from(intentSuggestedChipsEl.children).forEach(chip => {
        chip.classList.toggle('selected', selectedFocusStatements.has(chip.textContent));
      });
    }
    if (recordedTranscript) {
      intentTranscriptTextEl.textContent = recordedTranscript;
      intentTranscriptDisplayEl.style.display = '';
    }
    restorePersistedNarrationPlayback();
    updateComposeStoryboardVisibility();
    if (currentLabel) setStatus(`Restored "${currentLabel}" from your last session.`);
  } else if (suggestArcsRowEl) {
    // --- storyboard.html: render the movie editor if an arc's already
    // been accepted (relocating the suggestion module into the sidebar to
    // match); otherwise pick up wherever setup left off - a stated intent
    // ready for fresh suggestions, or (arrived here directly, with
    // neither) a nudge back to setup. Re-fires suggestions whenever intent
    // is known, even with an arc already accepted, so switching arcs stays
    // available after a reload (the LLM's recommendation/alternatives
    // aren't themselves persisted, only the one accepted).
    if (recordedTranscript) {
      intentTranscriptTextEl.textContent = recordedTranscript;
      intentTranscriptDisplayEl.style.display = '';
    }
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
      paperActionsEl.style.display = '';
      relocateAllSidebarModules();
    }
    if (recordedTranscript || selectedFocusStatements.size > 0) {
      suggestArcsRowEl.style.display = '';
      runSuggestArcs();
    } else if (currentArcSections.length === 0) {
      suggestArcsRowEl.style.display = '';
      suggestArcsStatusEl.textContent = 'Go back to setup and record your intent or pick a focus first.';
    }
  }
}
//#endregion
