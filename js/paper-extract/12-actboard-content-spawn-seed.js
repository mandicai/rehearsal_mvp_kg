// Music/sound additions from the canvas are track-only clips. They retain the
// same persisted timing shape as audio nodes so the existing rail, playback,
// and export code can consume them, but they are never rendered as a canvas
// node card.
function createActBoardAudioTrackSegment(actKey, scene = null) {
  const targetScene = scene || actBoardOpenSceneForAct(actKey)
    || actBoardScenesForAct(actKey).find(item => item.hidden !== true) || null;
  if (!targetScene) return null;
  const nodes = actBoardNodesForAct(actKey);
  const sceneAudio = nodes.filter(node => node.type === 'audio'
    && node.sceneId === targetScene.id && actBoardTrackNodeVisible(node));
  const startSeconds = sceneAudio.reduce((max, node) => Math.max(max,
    (Number(node.startSeconds) || 0) + Math.max(0.25, Number(node.durationSeconds) || 2)), 0);
  const node = {
    id: createActBoardNodeId('audio'),
    type: 'audio',
    trackOnly: true,
    actKey,
    sceneId: targetScene.id,
    audioKind: 'sound-effects',
    status: 'ready',
    query: '',
    results: [],
    selectedAudio: null,
    linkedToNodeId: null,
    linkedToType: null,
    startSeconds: Number(startSeconds.toFixed(2)),
    durationSeconds: 2,
    durationWasSuggested: true,
    trimStartSeconds: 0,
    sourceDurationSeconds: 0,
    volume: 0.8,
    previousAudioNodeId: null,
    nextAudioNodeId: null,
  };
  nodes.push(node);
  attachActBoardNodeToScene(actKey, node, targetScene);
  return node;
}

// Add/remove/refresh the reference row inside the open generation-inputs
// panels, so pinning or clearing a reference is reflected immediately.
// The reference's thumbnail on the inputs' summary line, so it is visible
// while the panel is collapsed - the row inside is only seen once expanded.
function applyActBoardReferenceSummaryThumb(summary, node) {
  if (!summary) return;
  const visual = actBoardReferenceVisual(node);
  let thumb = summary.querySelector(':scope > .storyboard-act-board-reference-summary-thumb');
  if (!visual) {
    thumb?.remove();
    return;
  }
  if (!thumb) {
    thumb = document.createElement('img');
    thumb.className = 'storyboard-act-board-reference-summary-thumb';
    thumb.loading = 'lazy';
    thumb.decoding = 'async';
    // After the label text, before the action button the summary carries.
    const button = summary.querySelector(':scope > button');
    if (button) summary.insertBefore(thumb, button);
    else summary.appendChild(thumb);
  }
  thumb.src = visual.thumbnailUrl || visual.url;
  thumb.alt = visual.label ? `Reference: ${visual.label}` : 'Reference image';
  thumb.title = thumb.alt;
}

function syncActBoardReferenceInputRows(node) {
  document.querySelectorAll('.storyboard-act-board-generation-inputs').forEach(panel => {
    // Both generation panels take the reference: images are edited from it,
    // videos are seeded from it. The stock-search panel does not.
    const isGenerationPanel = panel.classList.contains('storyboard-act-board-image-generation-inputs')
      || panel.classList.contains('storyboard-act-board-video-generation-inputs');
    panel.querySelectorAll(':scope > .storyboard-act-board-reference-input-row')
      .forEach(row => row.remove());
    if (!isGenerationPanel) return;
    const summary = panel.querySelector(':scope > summary');
    applyActBoardReferenceSummaryThumb(summary, node);
    const row = buildActBoardReferenceInputRow(node);
    if (!row) return;
    if (summary?.nextSibling) panel.insertBefore(row, summary.nextSibling);
    else panel.appendChild(row);
  });
}

// A small preview of the image a generation will be based on, shown inside the
// image/video generation inputs. The reference IS whichever image is
// currently selected (see actBoardReferenceVisual) - there is no separate
// pinning step, so this also doubles as the "what's selected" row for both
// the image and video generation panels.
function buildActBoardReferenceInputRow(node) {
  const row = document.createElement('div');
  row.className = 'storyboard-act-board-generation-input-row storyboard-act-board-reference-input-row';
  const label = document.createElement('strong');
  label.textContent = 'Reference image';
  const value = document.createElement('span');
  value.className = 'storyboard-act-board-reference-input-value';
  const visual = actBoardReferenceVisual(node);
  if (!visual) {
    value.classList.add('is-empty');
    value.textContent = 'None selected — generate or upload an image first';
    row.append(label, value);
    return row;
  }
  const thumb = document.createElement('img');
  thumb.className = 'storyboard-act-board-reference-input-thumb';
  thumb.src = visual.thumbnailUrl || visual.url;
  thumb.alt = visual.label || 'Reference image';
  thumb.loading = 'lazy';
  thumb.decoding = 'async';
  const caption = document.createElement('span');
  caption.textContent = visual.label || 'Selected image';
  value.append(thumb, caption);
  row.append(label, value);
  return row;
}

// Refresh the content panel for a node whose async work just finished.
//
// A scene patch rebuilds the scene card and its rails, NOT the selected-node
// body, so a draft that arrives after its node was opened would leave the panel
// sitting on "Drafting suggested narration..." indefinitely. Runs on the next
// frame so it lands after any patch queued alongside it, and does nothing
// unless the panel is actually showing this node.
function refreshActBoardNodeContentPanel(actKey, node) {
  const panel = actBoardFullPlaybackPanel;
  if (!panel || !node?.id || panel.dataset.selectedNodeId !== node.id) return false;
  const act = currentArcSections.find(item => item.key === actKey)
    || { key: actKey, label: actKey, description: '' };
  const run = () => {
    if (actBoardFullPlaybackPanel !== panel
      || panel.dataset.selectedNodeId !== node.id) return;
    panel._actBoardShowNodeDetails?.(actKey, act, node);
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 0);
  return true;
}

// Open a node in the selected-node content panel. A node is created empty, so
// the presenter's next move is always to choose its media - showing it straight
// away saves hunting for the new card and clicking it. The panel restores
// whatever `actBoardSelectedNodeId` / `actBoardFullPlaybackView` say when it is
// rebuilt, so setting them before the rerender is all this needs to do.
// The narration slide is either being read/highlighted or being corrected -
// never both. Combining the two put a caret and an entity-selection gesture on
// the same click, which felt unresponsive and could leave a stale highlight
// visible next to a new one. An explicit mode keeps each interaction simple and
// makes the current one obvious.
// Edit is the default: correcting the transcript is the first thing a
// presenter does after recording, and highlighting is the follow-up step.
let actBoardNarrationSlideMode = 'edit';   // 'highlight' | 'edit'

function actBoardNarrationSlideEditing() {
  return actBoardNarrationSlideMode === 'edit';
}

// Apply the current mode to already-rendered slides. Switching used to call
// rerenderActBoard, which rebuilt every node card and every <video> on the
// board - tens of milliseconds of blocking work and a visible flash for what is
// only a change of which gesture is live.
function applyActBoardNarrationSlideMode(root = document) {
  const editing = actBoardNarrationSlideEditing();
  root.querySelectorAll('[data-act-board-transcript-editable]').forEach(element => {
    element.contentEditable = editing ? 'true' : 'false';
    element.dataset.narrationMode = editing ? 'edit' : 'highlight';
  });
  root.querySelectorAll('.storyboard-act-board-narration-mode-btn').forEach(button => {
    const active = button.dataset.narrationMode === actBoardNarrationSlideMode;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function buildActBoardNarrationModeToggle() {
  const toggle = document.createElement('div');
  toggle.className = 'storyboard-act-board-narration-mode-toggle';
  toggle.setAttribute('role', 'group');
  toggle.setAttribute('aria-label', 'Narration slide mode');
  [
    ['edit', 'Edit narration', 'Correct what the transcription heard'],
    ['highlight', 'Highlight entities', 'Click or drag words to mark them; drag an entity edge to resize it'],
  ].forEach(([mode, label, title]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn-secondary storyboard-act-board-narration-mode-btn';
    button.textContent = label;
    button.title = title;
    button.dataset.narrationMode = mode;
    const active = actBoardNarrationSlideMode === mode;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', String(active));
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (actBoardNarrationSlideMode === mode) return;
      actBoardNarrationSlideMode = mode;
      applyActBoardNarrationSlideMode();
    });
    toggle.appendChild(button);
  });
  return toggle;
}

// Nodes created in the last moment, so their first rendered card or track
// segment can ease in. Time-boxed rather than a one-shot flag: a node can be
// drawn as both a canvas card and a rail segment, and both should animate.
const actBoardRecentlyCreatedNodes = new Map();
const ACT_BOARD_APPEAR_WINDOW_MS = 1200;

function actBoardNodeIsNewlyCreated(nodeId) {
  const createdAt = actBoardRecentlyCreatedNodes.get(nodeId);
  if (!createdAt) return false;
  if (Date.now() - createdAt > ACT_BOARD_APPEAR_WINDOW_MS) {
    actBoardRecentlyCreatedNodes.delete(nodeId);
    return false;
  }
  return true;
}

// Play a one-shot appear animation, cleaning the class up so a later rerender
// does not replay it.
function playActBoardAppearAnimation(element, className) {
  if (!element) return;
  element.classList.add(className);
  element.addEventListener('animationend',
    () => element.classList.remove(className), { once: true });
}

function openActBoardNodeInContentPanel(actKey, node) {
  if (!node?.id) return;
  // This is the single hook every node-creation path already calls, so it is
  // also where a new node is registered for its appear animation.
  actBoardRecentlyCreatedNodes.set(node.id, Date.now());
  actBoardSelectedNodeId = node.id;
  actBoardSelectedNodeActKey = String(actKey || '');
  actBoardFullPlaybackView = 'node';
  // rerenderActBoard reads the panel's dataset BEFORE these variables when it
  // decides which node to restore, so leaving the dataset on the previously
  // selected node would silently win and the new node would never open.
  const panel = document.querySelector('.storyboard-act-board-full-playback-panel');
  if (panel) {
    panel.dataset.selectedNodeId = actBoardSelectedNodeId;
    panel.dataset.selectedActKey = actBoardSelectedNodeActKey;
  }
}

function spawnActBoardNodeAt(actKey, type, x, y) {
  if (type === 'narration') {
    // Narration is now managed by the scene's narration section. Keep the
    // underlying narration record (it is still the shared source for
    // playback/export), start its draft in the background, and do not place
    // another visible canvas card when the presenter double-clicks to add it.
    const scene = actBoardOpenSceneForAct(actKey)
      || actBoardScenesForAct(actKey).find(item => item.hidden !== true)
      || null;
    if (scene) {
      const node = createActBoardNarrationSegmentNode(actKey, scene);
      openActBoardNodeInContentPanel(actKey, node);
      saveDebugSession();
      rerenderActBoard();
      const act = currentArcSections.find(item => item.key === actKey)
        || { key: actKey, label: actKey, description: '' };
      // Start after the initial mount so the scene slide can show its drafting
      // state immediately and the request never blocks the canvas interaction.
      suggestInitialActBoardNarration(actKey, act, node);
    }
    return;
  }
  if (type === 'audio') {
    // Music/sound is edited directly on its scene rail now. Add a blank
    // segment without creating another visible canvas node.
    const audioNode = createActBoardAudioTrackSegment(actKey);
    if (audioNode) {
      openActBoardNodeInContentPanel(actKey, audioNode);
      saveDebugSession();
      rerenderActBoard();
    }
    return;
  }
    const node = type === 'narration'
    ? {
      id: createActBoardNodeId('narration'), type, actKey, status: 'draft', text: '',
      footageFragments: [], footageNodeIds: [], footageStatus: '', error: '',
      includeNarration: true, startSeconds: 0, trimStartSeconds: 0,
      sourceDurationSeconds: 0, narrationSegmentDurationSeconds: 0,
      previousNarrationNodeId: null, nextNarrationNodeId: null,
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
  node.boardPositionMode = type === 'footage' ? 'footage-section-auto' : 'manual';
  // New nodes belong to the currently open scene, even when the chosen
  // canvas point is temporarily outside the scene frame while it is
  // expanding. Position-based scene detection can otherwise leave the node
  // unassigned, making it disappear on the next render and preventing the
  // presenter from adding a second node.
  attachActBoardNodeToScene(actKey, node, actBoardOpenSceneForAct(actKey));
  bringNewActBoardNodeToFront(actKey, node);
  actBoardNodesForAct(actKey).push(node);
  openActBoardNodeInContentPanel(actKey, node);
  saveDebugSession();
  rerenderActBoard();
}

// Create a narration shell for an additional independently recorded segment.
// The caller starts an initial suggested-narration request after mounting it;
// the recording itself remains the authoritative transcript once available.
// Lay a scene's narration segments end to end in the data, exactly as the
// rail already draws them.
//
// Every segment is created at the end of the narration that exists at that
// moment - which is 0 when the earlier segments have not been recorded yet,
// the normal order of work. The rail papered over that by drawing segments
// back-to-back regardless of startSeconds, but playback and the scrubber read
// the raw values, so two recorded segments at 0 played on top of each other.
// Packing on every duration change keeps data and display the same thing.
//
// A segment the presenter dragged on the track (timingWasManuallyAdjusted)
// keeps its place; the others flow around it.
function packActBoardSceneNarrationStarts(actKey, sceneId = null) {
  const segments = actBoardNodesForAct(actKey)
    .filter(node => node.type === 'narration' && (!sceneId || node.sceneId === sceneId));
  if (segments.length < 2) return false;
  const ordered = segments.map((node, index) => ({ node, index }))
    .sort((a, b) => (Number(a.node.startSeconds) || 0) - (Number(b.node.startSeconds) || 0)
      || a.index - b.index);
  let cursor = 0;
  let changed = false;
  ordered.forEach(({ node }) => {
    const duration = Math.max(0.5, actBoardNarrationSegmentDuration(node)
      || estimateActBoardNarrationSeconds(node.transcript || node.text) || 0.5);
    const current = Math.max(0, Number(node.startSeconds) || 0);
    if (node.timingWasManuallyAdjusted) {
      // Keeps its place, but never earlier than the previous segment's end -
      // otherwise its audio window starts inside that segment's own window
      // and both play at once instead of one after the other.
      const adjusted = Math.max(current, cursor);
      if (Math.abs(adjusted - current) > 0.01) {
        node.startSeconds = Number(adjusted.toFixed(2));
        changed = true;
      }
      cursor = adjusted + duration;
      return;
    }
    if (Math.abs(current - cursor) > 0.01) {
      node.startSeconds = Number(cursor.toFixed(2));
      changed = true;
    }
    cursor += duration;
  });
  return changed;
}

function createActBoardNarrationSegmentNode(actKey, scene = null) {
  const nodes = actBoardNodesForAct(actKey);
  const sceneNodes = scene
    ? nodes.filter(node => node.sceneId === scene.id)
    : nodes;
  const rightmost = sceneNodes.reduce((max, node) => Math.max(
    max, Number(node.boardX) || 0,
  ), 80);
  const lowest = sceneNodes.reduce((max, node) => Math.max(
    max, Number(node.boardY) || 0,
  ), 80);
  const narrationEnd = sceneNodes
    .filter(node => node.type === 'narration')
    .reduce((max, node) => Math.max(max,
      (Number(node.startSeconds) || 0) + actBoardNarrationSegmentDuration(node)), 0);
  const node = {
    id: createActBoardNodeId('narration'),
    type: 'narration',
    actKey,
    sceneId: scene?.id || null,
    // The segment is immediately eligible for a background draft request.
    // Recording controls remain usable while this status is active.
    status: 'generating',
    text: '',
    transcript: '',
    transcriptWords: [],
    footageFragments: [],
    footageNodeIds: [],
    footageStatus: '',
    error: '',
    includeNarration: true,
    startSeconds: Number(narrationEnd.toFixed(2)),
    trimStartSeconds: 0,
    sourceDurationSeconds: 0,
    narrationSegmentDurationSeconds: 0,
    previousNarrationNodeId: null,
    nextNarrationNodeId: null,
    boardX: rightmost + 36,
    boardY: lowest + 36,
    boardPositionMode: 'manual',
  };
  attachActBoardNodeToScene(actKey, node, scene || actBoardOpenSceneForAct(actKey));
  bringNewActBoardNodeToFront(actKey, node);
  nodes.push(node);
  packActBoardSceneNarrationStarts(actKey, node.sceneId);
  return node;
}

// Common title/abbreviation words whose period is never a sentence boundary
// (checked case-insensitively, without the period) - see
// actBoardNarrationSentences.
const ACT_BOARD_SENTENCE_ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc',
  'approx', 'inc', 'ltd', 'co', 'corp', 'gen', 'rev', 'capt', 'sgt', 'no', 'fig', 'dept',
]);

// A crude but dependency-free sentence split - same idea as
// backend/server.py's narration_clauses regex fallback (no spaCy needed here
// since this only ever runs on a short, already-generated draft, never a full
// transcript), but also guards the two abbreviation shapes an AI-drafted
// sentence commonly contains: initials/acronyms ("U.S.", "a.m.", "U.S.A.")
// and title/abbreviation words ("Dr.", "etc."). ["one."] -> ["one."];
// multiple sentences come back in order, each trimmed and non-empty. Prefers
// under-splitting a genuinely ambiguous case (e.g. a sentence that both ends
// in "U.S." AND is immediately followed by a new one) over ever mangling an
// abbreviation mid-word.
function actBoardNarrationSentences(text) {
  const source = String(text || '').trim();
  if (!source) return [];
  const protectedPeriods = new Set();
  const initialRe = /\b[A-Za-z]\.(?=[A-Za-z]\.|\s|$)/g;
  let match;
  while ((match = initialRe.exec(source))) protectedPeriods.add(match.index + match[0].length - 1);
  const abbrevRe = /\b([A-Za-z]{2,6})\.(?=\s|$)/g;
  while ((match = abbrevRe.exec(source))) {
    if (ACT_BOARD_SENTENCE_ABBREVIATIONS.has(match[1].toLowerCase())) {
      protectedPeriods.add(match.index + match[0].length - 1);
    }
  }
  const sentences = [];
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    if (!'.!?'.includes(source[i]) || protectedPeriods.has(i)) continue;
    let end = i + 1;
    while (end < source.length && '.!?'.includes(source[end])) end += 1;
    sentences.push(source.slice(start, end).trim());
    start = end;
  }
  if (start < source.length) sentences.push(source.slice(start).trim());
  return sentences.filter(Boolean);
}

// How many sentences to fold into one slide when the draft has no paragraph
// breaks to group by. A slide should carry a whole filmable beat (a few
// sentences), not a single line - see applyActBoardNarrationSuggestion.
const ACT_BOARD_NARRATION_SENTENCES_PER_BEAT = 3;

// Group a suggested draft into multi-sentence BEATS, one per narration slide.
// The narration LLM now returns blank-line-separated beats (see
// backend/narration_llm.py); honour those. If a draft arrives without blank
// lines (older cache, a hand-typed draft, or a terse model reply), fall back
// to grouping sentences ~ACT_BOARD_NARRATION_SENTENCES_PER_BEAT at a time so a
// slide still carries several sentences rather than one.
function actBoardNarrationBeats(text) {
  const source = String(text || '').trim();
  if (!source) return [];
  const paragraphs = source.split(/\n\s*\n+/).map(part => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (paragraphs.length > 1) return paragraphs;
  const sentences = actBoardNarrationSentences(source);
  if (sentences.length <= 1) return sentences.length ? [sentences[0]] : [source];
  const beats = [];
  for (let i = 0; i < sentences.length; i += ACT_BOARD_NARRATION_SENTENCES_PER_BEAT) {
    beats.push(sentences.slice(i, i + ACT_BOARD_NARRATION_SENTENCES_PER_BEAT).join(' ').trim());
  }
  return beats.filter(Boolean);
}

// Narration nodes this one has previously split off for its OWN multi-sentence
// suggestion (see applyActBoardNarrationSuggestion) - never a segment the
// presenter added by hand, which carries no splitFromNarrationNodeId.
function actBoardOwnedNarrationSplitChildren(actKey, narrationNode) {
  return actBoardNodesForAct(actKey)
    .filter(node => node.type === 'narration' && node.splitFromNarrationNodeId === narrationNode.id);
}

// Removes one never-recorded auto-split child, splicing the narration chain
// the same way removeActBoardFootageNodesForDeletedPhrases splices a footage
// chain. Callers only ever pass a child with no transcript - see
// applyActBoardNarrationSuggestion's anyChildRecorded guard.
function removeActBoardUnrecordedSplitChild(actKey, child) {
  const nodes = actBoardNodesForAct(actKey);
  const previous = nodes.find(item => item.id === child.previousNarrationNodeId);
  const next = nodes.find(item => item.id === child.nextNarrationNodeId);
  if (previous && previous.nextNarrationNodeId === child.id) previous.nextNarrationNodeId = next?.id || null;
  if (next && next.previousNarrationNodeId === child.id) next.previousNarrationNodeId = previous?.id || null;
  actBoardNodes[actKey] = nodes.filter(node => node.id !== child.id);
  if (Array.isArray(actBoardScenes[actKey])) {
    actBoardScenes[actKey] = actBoardScenes[actKey].map(scene => ({
      ...scene,
      nodeIds: (scene.nodeIds || []).filter(item => item !== child.id),
      nodeSnapshots: (scene.nodeSnapshots || []).filter(snapshot => snapshot?.id !== child.id),
      nodeLinks: (scene.nodeLinks || []).filter(link =>
        link.sourceId !== child.id && link.targetId !== child.id),
    }));
  }
}

// Converts arbitrary character offsets into a text into word indices (the
// same numbering as appendActBoardNarrationWords's
// word.dataset.narrationWordIndex) - so a position survives being rendered
// against a differently-whitespaced copy of the same text (e.g. the
// scene-narration carousel's `.replace(/\s+/g, ' ')` collapse, which never
// changes which word is Nth).
function actBoardCharOffsetsToWordIndices(text, charOffsets) {
  if (!Array.isArray(charOffsets) || !charOffsets.length) return [];
  const wordPattern = /[A-Za-z0-9']+/g;
  const wordEnds = [];
  let match;
  while ((match = wordPattern.exec(String(text || '')))) wordEnds.push(match.index + match[0].length);
  if (!wordEnds.length) return [];
  const indices = new Set();
  charOffsets.forEach(raw => {
    const offset = Number(raw);
    if (!Number.isFinite(offset) || offset <= 0) return;
    let nearest = -1;
    for (let i = 0; i < wordEnds.length; i += 1) {
      if (wordEnds[i] > offset) break;
      nearest = i;
    }
    if (nearest >= 0) indices.add(nearest);
  });
  return Array.from(indices);
}

// Visual-only breath cues for a suggested draft, BEFORE recording. Reuses the
// exact same deterministic, LLM-free boundary logic that already splits a
// RECORDED transcript into footage-worthy clauses (backend/server.py's
// narration_clauses/_split_clause_text - no LLM call, pure punctuation/
// conjunction/length rules), just applied to the draft text instead of the
// transcript. Fire-and-forget: never blocks the suggestion flow, and a
// failed/superseded fetch just leaves the draft with no cues rather than
// stale or wrong ones. Once the presenter actually records, real filmability
// highlights take over instead (see requestActBoardNarrationAnalysis) - this
// never runs against a recorded transcript.
function refreshActBoardNarrationDraftPauseCues(actKey, narrationNode) {
  if (!narrationNode || narrationNode.type !== 'narration') return;
  const text = String(narrationNode.text || '').trim();
  if (!text || narrationNode.transcript) {
    if (narrationNode.pauseWordIndices?.length) narrationNode.pauseWordIndices = [];
    return;
  }
  fetchNarrationClauses(text).then(local => {
    if (narrationNode.text !== text || narrationNode.transcript) return; // stale, edited, or since recorded
    const spans = Array.isArray(local?.spans) ? local.spans : [];
    // A breath belongs at the end of every clause EXCEPT the last one - there
    // is nothing left to read after that.
    const charOffsets = spans.slice(0, -1).map(span => Number(span.end)).filter(Number.isFinite);
    narrationNode.pauseWordIndices = actBoardCharOffsetsToWordIndices(text, charOffsets);
    const scene = actBoardSceneForNode(actKey, narrationNode);
    queueActBoardScenePatch(actKey, scene?.id || narrationNode.sceneId, { persist: true });
  }).catch(() => {
    // Best-effort visual cue only - never surface an error for something
    // this cosmetic.
  });
}

// Every narration node already requires its own recording before it counts as
// spoken (see requestActBoardNarrationAnalysis's transcript-only gate) - so
// turning a multi-sentence draft into several independently recordable
// segments needs no new state, just more chained nodes. Called by every
// Suggest/re-suggest narration site right after a fresh suggestion comes back
// (see fetchSuggestNarration callers). A single-sentence result is a no-op
// beyond setting node.text exactly as before this existed.
function applyActBoardNarrationSuggestion(actKey, narrationNode, narration) {
  // One slide per multi-sentence BEAT (see actBoardNarrationBeats), not per
  // sentence - each slide should prompt the presenter to say a fuller thought.
  const beats = actBoardNarrationBeats(narration);
  const existingChildren = actBoardOwnedNarrationSplitChildren(actKey, narrationNode)
    .sort((a, b) => (Number(a.startSeconds) || 0) - (Number(b.startSeconds) || 0));
  if (existingChildren.some(child => child.transcript)) {
    // Never destructively re-split over a segment the presenter already
    // recorded - leave that whole chain exactly as it is, and fall back to a
    // single merged draft on THIS node only, same as before this feature
    // existed.
    narrationNode.text = narration;
    refreshActBoardNarrationDraftPauseCues(actKey, narrationNode);
    return;
  }
  narrationNode.text = beats[0] || narration;
  refreshActBoardNarrationDraftPauseCues(actKey, narrationNode);
  if (beats.length <= 1) {
    // A previous, longer suggestion may have left unrecorded split children
    // behind - this shorter one no longer needs any of them.
    existingChildren.forEach(child => removeActBoardUnrecordedSplitChild(actKey, child));
    syncActBoardLiveSceneSnapshots(actBoardSceneForNode(actKey, narrationNode) || null);
    return;
  }
  const scene = actBoardSceneForNode(actKey, narrationNode);
  let previous = narrationNode;
  for (let i = 1; i < beats.length; i += 1) {
    const child = existingChildren[i - 1] || createActBoardNarrationSegmentNode(actKey, scene);
    child.text = beats[i];
    child.status = 'ready';
    child.splitFromNarrationNodeId = narrationNode.id;
    child.previousNarrationNodeId = previous.id;
    previous.nextNarrationNodeId = child.id;
    previous = child;
    refreshActBoardNarrationDraftPauseCues(actKey, child);
  }
  previous.nextNarrationNodeId = null;
  // Drop any extra previously-split children beyond what this suggestion needs.
  existingChildren.slice(beats.length - 1)
    .forEach(child => removeActBoardUnrecordedSplitChild(actKey, child));
  packActBoardSceneNarrationStarts(actKey, narrationNode.sceneId);
  syncActBoardLiveSceneSnapshots(actBoardSceneForNode(actKey, narrationNode) || null);
}

// --- DEV/TEST seeding (not a shipped feature) -----------------------------
// Fill a narration node with a fake recording so Visualize highlights / Smart
// arrange (which read only transcript + transcriptWords) can be tested without
// actually recording audio. No audio file is attached, so playback is silent -
// that is fine for exercising the arrange pipeline. Word timings are synthesized
// at a steady pace so clause windows compute. Never clobbers a real recording.
const ACT_BOARD_SEED_WORD_SECONDS = 0.4;

function fakeRecordActBoardNarration(node) {
  if (!node) return;
  const text = String(node.text || '').replace(/\s+/g, ' ').trim();
  if (!text) return;
  const words = text.split(' ').filter(Boolean);
  const transcriptWords = words.map((word, index) => ({
    word,
    start: Number((index * ACT_BOARD_SEED_WORD_SECONDS).toFixed(2)),
    end: Number(((index + 1) * ACT_BOARD_SEED_WORD_SECONDS).toFixed(2)),
  }));
  const duration = Number((words.length * ACT_BOARD_SEED_WORD_SECONDS).toFixed(2));
  node.transcript = text;
  node.transcriptWords = transcriptWords;
  node.silences = [];
  node.audioDurationSeconds = duration;
  node.sourceDurationSeconds = duration;
  node.narrationSegmentDurationSeconds = duration;
  node.recordingStatus = 'ready';
  node.status = 'ready';
  // Force a fresh filmable-clause analysis against the new transcript.
  node.narrationSpanHash = '';
  node.narrationSpanStatus = 'stale';
  node.narrationCandidateSpans = [];
  node.narrationSpans = [];
}

function seedCannedNarration(topic) {
  const subject = String(topic || 'this research').trim() || 'this research';
  return [
    `For years, researchers wondered how ${subject} really worked. The question mattered because the answers could reshape everyday decisions. But the data was scattered, and no one had put it together.`,
    `So a team set out to measure it directly. They gathered evidence from the field, ran it through their models, and looked for a pattern. What they found surprised even them.`,
    `The results pointed to a clear effect, though not without caveats. Some cases behaved exactly as predicted. Others hinted the story is more complicated than a single number can capture.`,
  ].join('\n\n');
}

// Seed every scene in an act with a multi-beat suggested draft AND a fake
// recording of it, so the presenter can jump straight to testing Visualize
// highlights / Smart arrange. Console-callable: seedActBoardTestNarration().
async function seedActBoardTestNarration(actKey) {
  const resolvedActKey = actKey
    || (currentArcSections[0] && currentArcSections[0].key);
  if (!resolvedActKey) { console.warn('[seed] no act to seed'); return 0; }
  const scenes = actBoardScenesForAct(resolvedActKey);
  if (!scenes.length) { console.warn('[seed] no scenes for', resolvedActKey); return 0; }
  const act = currentArcSections.find(item => item.key === resolvedActKey)
    || { key: resolvedActKey, label: resolvedActKey };
  const source = actBoardSourceSection(resolvedActKey);
  const abstract = findAbstractText();
  let seeded = 0;
  for (const scene of scenes) {
    const sceneNarrations = actBoardNodesForAct(resolvedActKey)
      .filter(node => node.type === 'narration' && node.sceneId === scene.id);
    const root = sceneNarrations.find(node => !node.previousNarrationNodeId)
      || sceneNarrations[0]
      || createActBoardNarrationSegmentNode(resolvedActKey, scene);
    // Never overwrite a real (or already-seeded) recording.
    if (String(root.transcript || '').trim()) continue;
    let draft = String(root.text || '').trim() || String(scene.arcSuggestedNarration || '').trim();
    if (!draft) {
      try {
        const res = await fetchSuggestNarration({
          sectionTitle: scene.title || (source && source.title) || 'Scene',
          sectionText: (source && source.text) || '',
          actTitle: act.label || '',
          actDescription: act.description || '',
          abstract,
          documentaryMode: actBoardDocumentaryModeForNode(resolvedActKey, root),
        });
        draft = String((res && res.narration) || '').trim();
      } catch (error) { /* fall back to canned below */ }
    }
    if (!draft) draft = seedCannedNarration(scene.title || act.label);
    applyActBoardNarrationSuggestion(resolvedActKey, root, draft);
    const chain = orderedActBoardNarrationChain(resolvedActKey, root, null, true);
    (chain.length ? chain : [root]).forEach(fakeRecordActBoardNarration);
    seeded += 1;
  }
  saveDebugSession();
  rerenderActBoard();
  console.log(`[seed] seeded ${seeded} scene(s) for ${resolvedActKey}`);
  return seeded;
}
if (typeof window !== 'undefined') window.seedActBoardTestNarration = seedActBoardTestNarration;

const ACT_BOARD_PIXELS_PER_SECOND = 34;
const ACT_BOARD_NODE_GAP = 24;
const ACT_BOARD_FOOTAGE_GAP = 12;
const ACT_BOARD_NARRATION_STANDARD_WIDTH = 190;
// Spacious defaults for the free-form Act Board canvas and its framed scene
// boards. These are intentionally separate from the fixed node footprint.
const ACT_BOARD_DEFAULT_CANVAS_HEIGHT = 1080;
const ACT_BOARD_DEFAULT_SCENE_HEIGHT = 1080;
// Give the shaped narration/audio shells enough vertical room for their
// header plus the recorded/empty waveform illustration without clipping the
// lower edge of the supplied SVG.
const ACT_BOARD_NODE_STANDARD_HEIGHT = 120;
const ACT_BOARD_NARRATION_STANDARD_HEIGHT = ACT_BOARD_NODE_STANDARD_HEIGHT;
const ACT_BOARD_AUDIO_STANDARD_WIDTH = ACT_BOARD_NARRATION_STANDARD_WIDTH;
const ACT_BOARD_AUDIO_STANDARD_HEIGHT = ACT_BOARD_NARRATION_STANDARD_HEIGHT;
const ACT_BOARD_FOOTAGE_STANDARD_WIDTH = 190;
const ACT_BOARD_FOOTAGE_STANDARD_HEIGHT = ACT_BOARD_NODE_STANDARD_HEIGHT;
// Breathing room kept below a footage card when a drag extends its scene's
// Footage lane, so the card never lands flush against the lane's bottom edge.
const ACT_BOARD_FOOTAGE_LANE_DRAG_PADDING = 12;

