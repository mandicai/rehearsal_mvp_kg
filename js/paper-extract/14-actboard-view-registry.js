// renderMovieEditor replaces the entire Act Board DOM for many state changes.
// Explicitly release observers/listeners owned by the old board first so
// repeated highlighting, selection, and generation cannot accumulate work on
// detached cards.
// A rebuilt board discards its old cards, but a removed <video>/<audio> keeps
// its decoded media alive until GC happens to collect it. With a Footage lane
// full of clips that is tens of megabytes per rebuild, and rearranging or
// spawning nodes rebuilds constantly - which is what made a long editing
// session climb in memory even though the DOM node count stayed flat. Detach
// the source explicitly so the media pipeline goes with the element.
function releaseActBoardMediaElements(root) {
  if (!root?.querySelectorAll) return;
  root.querySelectorAll('video, audio').forEach(media => {
    // Playback deliberately carried across a rebuild still owns its element.
    // The two references cover the transports this module tracks; `paused` is
    // the catch-all for anything else that is genuinely mid-playback, so a
    // rebuild can never cut off audio or video that is actually running.
    if (media === actBoardNativeAudioElement
      || media === actBoardPlaybackState?.audio
      || media.paused === false) return;
    try {
      media.pause();
      media.removeAttribute('src');
      media.srcObject = null;
      // Drop any <source> children too, or load() just re-selects one of them.
      media.querySelectorAll('source').forEach(source => source.remove());
      media.load();
    } catch (err) { /* a detached element can refuse; nothing to recover */ }
  });
}

function teardownActBoardView(board) {
  if (!board) return;
  releaseActBoardMediaElements(board);
  actBoardSceneMediaPatchTimers.forEach(timer => clearTimeout(timer));
  actBoardSceneMediaPatchTimers.clear();
  if (actBoardDomRegistry?.board === board) {
    actBoardDomRegistry = null;
    if (!actBoardSceneVisualizeTokens.size && !actBoardSceneArrangeKeys.size) {
      actBoardSceneLoadingCounts.clear();
    }
    actBoardPendingPatch = null;
    if (actBoardPatchFrame != null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(actBoardPatchFrame);
      else clearTimeout(actBoardPatchFrame);
      actBoardPatchFrame = null;
    }
  }
  board._actBoardDestroyed = true;
  board._actBoardResizeObserver?.disconnect?.();
  board._actBoardResizeObserver = null;
  if (activeActBoardResizeHandler) {
    window.removeEventListener('resize', activeActBoardResizeHandler);
    activeActBoardResizeHandler = null;
  }
  board.querySelectorAll('*').forEach(element => {
    element._actBoardResizeHandleObserver?.disconnect?.();
    element._actBoardResizeHandleObserver = null;
    const scrollHandler = element._actBoardResizeHandleScrollHandler;
    if (scrollHandler) element.removeEventListener('scroll', scrollHandler);
    element._actBoardResizeHandleScrollHandler = null;
  });
}

function buildActBoardDomRegistry(board) {
  const registry = {
    board,
    acts: new Map(),
    scenes: new Map(),
    nodes: new Map(),
    tracks: new Map(),
    selectedNodePanel: board?.querySelector?.('.storyboard-act-board-full-playback-node-details-content') || null,
  };
  board?.querySelectorAll?.('.storyboard-act-board-column').forEach(column => {
    const actKey = column.dataset.actKey || '';
    const nodeStack = column.querySelector('.storyboard-act-board-node-stack');
    registry.acts.set(actKey, { actKey, column, nodeStack });
    nodeStack?.querySelectorAll('.storyboard-act-board-board-scene').forEach(card => {
      const sceneId = card.dataset.boardSceneId || '';
      if (!sceneId) return;
      const scene = { actKey, sceneId, card, nodeStack,
        footageSection: card.querySelector('.storyboard-act-board-scene-section-footage'),
        footageLayer: card.querySelector('.storyboard-act-board-scene-footage-node-layer'),
      };
      registry.scenes.set(sceneId, scene);
      const tracks = card.querySelector('.storyboard-act-board-canvas-playback-tracks')
        || nodeStack.querySelector('.storyboard-act-board-canvas-playback-tracks');
      if (tracks) registry.tracks.set(`${actKey}:${sceneId}`, {
        root: tracks,
        footageTrack: tracks.querySelector('.storyboard-act-board-footage-track'),
        narrationTrack: tracks.querySelector('.storyboard-act-board-narration-track'),
        audioTrack: tracks.querySelector('.storyboard-act-board-audio-track'),
      });
    });
    nodeStack?.querySelectorAll('.storyboard-act-board-node[data-node-id]').forEach(card => {
      const nodeId = card.dataset.nodeId || '';
      if (!nodeId) return;
      const liveNode = actBoardNodesForAct(actKey).find(node => node.id === nodeId);
      registry.nodes.set(nodeId, {
        actKey,
        sceneId: card.dataset.sceneId || card.closest('[data-board-scene-id]')?.dataset.boardSceneId
          || actBoardSceneForNode(actKey, liveNode)?.id || '',
        card,
        nodeStack,
        footageLayer: card.closest('.storyboard-act-board-scene-footage-node-layer') || null,
      });
    });
  });
  return registry;
}

function refreshActBoardDomRegistry(board = actBoardDomRegistry?.board) {
  if (!board || board._actBoardDestroyed) return null;
  actBoardDomRegistry = buildActBoardDomRegistry(board);
  board._actBoardDomRegistry = actBoardDomRegistry;
  // Structural/analysis rerenders replace scene cards. Reattach any active
  // scene-scoped loading veil to the new card so Visualize remains covered
  // until its owning async batch reaches finally.
  actBoardSceneLoadingCounts.forEach((count, key) => {
    if (!count) return;
    const sceneId = String(key).slice(String(key).indexOf(':') + 1);
    const entry = actBoardDomRegistry.scenes.get(sceneId);
    if (!entry?.card || entry.card.querySelector(':scope > .storyboard-act-board-scene-loading')) return;
    const veil = document.createElement('div');
    veil.className = 'storyboard-act-board-scene-loading';
    veil.setAttribute('role', 'status');
    veil.setAttribute('aria-live', 'polite');
    veil.style.pointerEvents = 'none';
    const label = document.createElement('span');
    label.className = 'storyboard-act-board-scene-loading-label';
    label.textContent = 'Analyzing narration and generating previews…';
    veil.appendChild(label);
    entry.card.appendChild(veil);
  });
  return actBoardDomRegistry;
}

function setActBoardSceneLoading(actKey, sceneId, active, message = '') {
  const key = `${actKey}:${sceneId || ''}`;
  const entry = actBoardDomRegistry?.scenes?.get(sceneId);
  if (!entry?.card) return false;
  const count = Math.max(0, (actBoardSceneLoadingCounts.get(key) || 0) + (active ? 1 : -1));
  if (count) actBoardSceneLoadingCounts.set(key, count);
  else actBoardSceneLoadingCounts.delete(key);
  let veil = entry.card.querySelector(':scope > .storyboard-act-board-scene-loading');
  if (count && !veil) {
    veil = document.createElement('div');
    veil.className = 'storyboard-act-board-scene-loading';
    veil.setAttribute('role', 'status');
    veil.setAttribute('aria-live', 'polite');
    veil.style.pointerEvents = 'none';
    const label = document.createElement('span');
    label.className = 'storyboard-act-board-scene-loading-label';
    veil.appendChild(label);
    entry.card.appendChild(veil);
  }
  if (veil) {
    veil.querySelector('.storyboard-act-board-scene-loading-label').textContent =
      message || 'Updating this scene…';
    veil.hidden = !count;
    if (!count) veil.remove();
  }
  return true;
}

// The Visualize veil was created and removed inside a single frame whenever
// the narration already had classified spans, so the click produced no visible
// loading state at all. Hold it on screen long enough to actually read.
const ACT_BOARD_SCENE_LOADING_MIN_MS = 550;

function waitForActBoardSceneLoadingFloor(shownAt) {
  const elapsed = Date.now() - Number(shownAt);
  const remaining = ACT_BOARD_SCENE_LOADING_MIN_MS
    - (Number.isFinite(elapsed) ? elapsed : 0);
  if (!(remaining > 0)) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, remaining));
}

// Re-label a veil that is already up, without touching its reference count.
function setActBoardSceneLoadingMessage(sceneId, message) {
  if (!message) return false;
  const label = actBoardDomRegistry?.scenes?.get(sceneId)?.card?.querySelector(
    ':scope > .storyboard-act-board-scene-loading .storyboard-act-board-scene-loading-label',
  );
  if (!label) return false;
  label.textContent = message;
  return true;
}

function patchActBoardSceneDom(actKey, sceneId, options = {}) {
  const registry = actBoardDomRegistry;
  const entry = registry?.scenes?.get(sceneId);
  const act = currentArcSections.find(item => item.key === actKey);
  const scene = actBoardScenesForAct(actKey).find(item => item.id === sceneId);
  if (!registry || !entry || !act || !scene || entry.nodeStack?.isConnected !== true) return false;
  const nodeStack = entry.nodeStack;
  const allNodes = actBoardNodesForAct(actKey);
  const activeIds = new Set([...(scene.nodeIds || []), ...(scene.nodeSnapshots || []).map(item => item?.id)]);
  const sceneNodes = allNodes.filter(node => activeIds.has(node.id) || node.sceneId === scene.id);
  const visibleNodes = sceneNodes.filter(node => node.type !== 'playback' && node.type !== 'narration' && node.trackOnly !== true);
  const trackNodes = sceneNodes.filter(node => node.type !== 'playback');
  clearActBoardPendingLink(nodeStack);
  nodeStack.querySelector('.storyboard-act-board-link-layer')?.remove();
  const oldNodeCards = Array.from(nodeStack.querySelectorAll('.storyboard-act-board-node'));
  const oldTracks = Array.from(nodeStack.querySelectorAll('.storyboard-act-board-canvas-playback-tracks'));
  const oldSceneCard = entry.card;
  // A scene-scoped Visualize patch rebuilds the lightweight card DOM, but it
  // must not turn that rebuild into an implicit layout pass. Preserve every
  // existing footage card's saved position; only cards explicitly marked
  // `footage-section-auto` are eligible for the pending-slot placer below.
  const preserveFootageNodeIds = new Set(options.preserveFootageNodeIds || []);
  sceneNodes.filter(node => node.type === 'footage'
    && node.boardPositionMode !== 'footage-section-auto')
    .forEach(node => preserveFootageNodeIds.add(node.id));
  nodeStack.querySelectorAll('.storyboard-act-board-node-empty').forEach(empty => empty.remove());
  const ordered = orderedActBoardNodes(actKey, visibleNodes);
  layoutActBoardNodeGeometry(actKey, ordered, {
    preserveFootageNodeIds,
  });
  const fragment = document.createDocumentFragment();
  ordered.forEach((node, index) => {
    const card = buildActBoardNode(actKey, act, node, nodeStack, index);
    card._actBoardNodeBody?.remove();
    fragment.appendChild(card);
  });
  nodeStack.appendChild(fragment);
  const sceneCard = buildActBoardBoardSceneCard(scene, visibleNodes, nodeStack);
  nodeStack.appendChild(sceneCard);
  const tracks = buildActBoardCanvasPlaybackTracks(actKey, scene, nodeStack, trackNodes);
  if (tracks) sceneCard.appendChild(tracks);
  mountActBoardFootageCardsInLayer(nodeStack, scene);
  // Mount the replacement DOM before removing the old scene. This keeps the
  // canvas painted continuously and avoids the black flash users saw when a
  // new footage batch arrived.
  oldNodeCards.forEach(card => {
    releaseActBoardMediaElements(card);
    card.remove();
  });
  oldTracks.forEach(track => track.remove());
  if (oldSceneCard && oldSceneCard !== sceneCard) {
    releaseActBoardMediaElements(oldSceneCard);
    oldSceneCard.remove();
  }
  // Stretch the sections rail to the card's bottom NOW, not on the next
  // frame. The footage placement below measures the footage lane, and before
  // the rail is positioned that lane is only its 380px minimum: with more
  // cards than fit, the rest stayed hidden until some later pass happened to
  // place them (the "cards pop in much later" report). This must run after
  // the old card is gone: the positioner finds its scene card by id, and
  // while both cards exist it matches the old one and treats the rail as
  // unmounted.
  tracks?._actBoardPosition?.();
  refineActBoardRenderedGeometry(nodeStack, ordered, {
    ...options,
    preserveFootageNodeIds,
  });
  positionActBoardFootageNodesInSceneSection(nodeStack, scene, visibleNodes);
  expandActBoardScenesToContainNodes(nodeStack, actKey, visibleNodes, {
    preserveNodePositions: true,
  });
  if (ACT_BOARD_LINKING_ENABLED && visibleNodes.length) buildActBoardLinkLayer(nodeStack, visibleNodes);
  refreshActBoardDomRegistry(registry.board);
  refreshActBoardPlaybackDurations();
  // The selected-scene transport is mounted outside this scene's canvas
  // subtree. Refresh just that transport when it is showing the patched
  // scene, so canvas and playback-panel rails remain identical without a full
  // Act Board teardown/rebuild.
  actBoardFullPlaybackPanel?._actBoardSelectedScenePlayback?._actBoardRefresh?.(actKey, sceneId);
  return true;
}

function flushActBoardPatch() {
  actBoardPatchFrame = null;
  const patch = actBoardPendingPatch;
  actBoardPendingPatch = null;
  if (!patch || !ACT_BOARD_INCREMENTAL_RENDERING || !actBoardDomRegistry?.board?.isConnected) return false;
  let patched = true;
  (patch.scenes || []).forEach(key => {
    const [actKey, sceneId] = String(key).split(':');
    if (!patchActBoardSceneDom(actKey, sceneId, {
      preserveFootageNodeIds: new Set(patch.preserveFootageNodeIds || []),
    })) patched = false;
  });
  if (!patched && actBoardDomRegistry?.board?.isConnected) {
    rerenderActBoard({ preservePlayback: true });
    return false;
  }
  if (patched && patch.persist) saveDebugSession();
  return patched;
}

function requestActBoardPatch(update = {}) {
  if (!ACT_BOARD_INCREMENTAL_RENDERING || !actBoardDomRegistry?.board?.isConnected) return false;
  const scenes = Array.isArray(update.scenes) ? update.scenes : [];
  if (!actBoardPendingPatch) {
    actBoardPendingPatch = {
      scenes: [], persist: false, preserveFootageNodeIds: [],
    };
  }
  scenes.forEach(item => {
    const key = typeof item === 'string' ? item : `${item.actKey}:${item.sceneId}`;
    if (key && !actBoardPendingPatch.scenes.includes(key)) actBoardPendingPatch.scenes.push(key);
  });
  actBoardPendingPatch.persist = actBoardPendingPatch.persist || update.persist === true;
  const preserveIds = Array.isArray(update.preserveFootageNodeIds)
    ? update.preserveFootageNodeIds : [];
  preserveIds.forEach(id => {
    if (id && !actBoardPendingPatch.preserveFootageNodeIds.includes(id)) {
      actBoardPendingPatch.preserveFootageNodeIds.push(id);
    }
  });
  if (actBoardPatchFrame == null) {
    actBoardPatchFrame = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(flushActBoardPatch)
      : setTimeout(flushActBoardPatch, 0);
  }
  return true;
}

function queueActBoardScenePatch(actKey, sceneId, options = {}) {
  if (sceneId && requestActBoardPatch({
    scenes: [{ actKey, sceneId }], persist: options.persist === true,
    preserveFootageNodeIds: options.preserveFootageNodeIds || [],
  })) return true;
  // A missing scene/registry means the DOM is stale (for example while a
  // structural scene load is completing), so retain the safe full rebuild.
  rerenderActBoard({ preservePlayback: true });
  return false;
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

const ACT_BOARD_NODE_CLIPBOARD_MIME = 'application/x-storyboard-act-board-node';
let actBoardNodeClipboard = null;

function actBoardNodeClipboardPayload(node) {
  if (!node) return null;
  try {
    const copy = JSON.parse(JSON.stringify(node));
    // Relationships belong to the original node's graph. A pasted node starts
    // as an independent card and can be linked normally afterward.
    copy.id = null;
    copy.narrationNodeId = null;
    copy.previousFootageNodeId = null;
    copy.nextFootageNodeId = null;
    copy.previousNarrationNodeId = null;
    copy.nextNarrationNodeId = null;
    copy.previousAudioNodeId = null;
    copy.nextAudioNodeId = null;
    copy.linkedToNodeId = null;
    copy.linkedToType = null;
    if (copy.type === 'narration') copy.footageNodeIds = [];
    return { version: 1, node: copy };
  } catch (error) {
    return null;
  }
}

function actBoardNodeClipboardText(payload) {
  try { return JSON.stringify(payload); } catch (error) { return ''; }
}

function pasteActBoardNodeFromPayload(actKey, boardLayer, payload) {
  const source = payload?.node;
  if (!source || !['narration', 'footage', 'audio', 'playback'].includes(source.type)) return false;
  const scene = actBoardOpenSceneForAct(actKey)
    || actBoardScenesForAct(actKey).find(item => item.hidden !== true);
  if (!scene) return false;
  const nodes = actBoardNodesForAct(actKey);
  const active = nodes.find(node => node.id === boardLayer?._actBoardActiveNodeId);
  const baseX = Number(active?.boardX ?? source.boardX) || 16;
  const baseY = Number(active?.boardY ?? source.boardY) || 16;
  const pasted = {
    ...source,
    id: createActBoardNodeId(source.type),
    actKey,
    sceneId: scene.id,
    boardX: Math.max(0, baseX + 28),
    boardY: Math.max(0, baseY + 28),
    boardPositionMode: 'manual',
    boardZIndex: undefined,
    generationStatus: '',
    generationError: '',
    downloadStatus: '',
    error: '',
  };
  if (pasted.type === 'narration') {
    pasted.footageNodeIds = [];
    pasted.footageStatus = '';
  }
  if (pasted.type === 'footage') {
    pasted.narrationNodeId = null;
    pasted.previousFootageNodeId = null;
    pasted.nextFootageNodeId = null;
    // Footage belongs to its scene's Footage lane, never to canvas space. The
    // paste offset above is a canvas coordinate borrowed from whichever node
    // was active - often a narration card in a different lane - so handing the
    // card to the lane placer is the only way it lands somewhere valid.
    delete pasted.boardX;
    delete pasted.boardY;
    pasted.boardPositionSpace = 'footage-section';
    pasted.boardPositionMode = 'footage-section-auto';
  }
  if (pasted.type === 'audio') {
    pasted.linkedToNodeId = null;
    pasted.linkedToType = null;
    pasted.previousAudioNodeId = null;
    pasted.nextAudioNodeId = null;
  }
  if (pasted.type === 'playback') pasted.narrationNodeId = null;
  nodes.push(pasted);
  attachActBoardNodeToScene(actKey, pasted, scene);
  bringNewActBoardNodeToFront(actKey, pasted);
  boardLayer._actBoardActiveNodeId = pasted.id;
  syncActBoardLiveSceneSnapshots();
  saveDebugSession();
  rerenderActBoard();
  return true;
}

function wireActBoardNodeClipboard(boardLayer, actKey) {
  if (!boardLayer || boardLayer._actBoardClipboardWired) return;
  boardLayer._actBoardClipboardWired = true;
  boardLayer.tabIndex = 0;
  const isEditingTarget = target => target?.closest?.(
    'button, input, audio, video, a, select, textarea, label, details, summary, [contenteditable="true"]');
  const hasTextSelection = () => {
    const selection = window.getSelection?.();
    return Boolean(selection && !selection.isCollapsed && selection.toString());
  };
  const activeNode = () => {
    const nodes = actBoardNodesForAct(actKey);
    const selected = nodes.find(node => node.id === boardLayer._actBoardActiveNodeId);
    if (selected) return selected;
    const cards = Array.from(boardLayer.querySelectorAll('.storyboard-act-board-node'));
    const topCard = cards.sort((a, b) =>
      (Number(b.style.zIndex) || 1) - (Number(a.style.zIndex) || 1))[0];
    return topCard ? nodes.find(node => node.id === topCard.dataset.nodeId) : null;
  };
  boardLayer.addEventListener('keydown', event => {
    if (isEditingTarget(event.target) || hasTextSelection()
      || !(event.metaKey || event.ctrlKey)) return;
    if (String(event.key).toLocaleLowerCase() !== 'c') return;
    const payload = actBoardNodeClipboardPayload(activeNode());
    if (!payload) return;
    actBoardNodeClipboard = payload;
    event.preventDefault();
    const text = actBoardNodeClipboardText(payload);
    // The internal clipboard makes copy/paste reliable even when the browser
    // denies clipboard permissions; this optional system write also permits
    // pasting the node into another tab when permissions are available.
    try {
      if (typeof navigator !== 'undefined') navigator.clipboard?.writeText(text)?.catch(() => { });
    } catch (error) { /* optional */ }
  });
  boardLayer.addEventListener('copy', event => {
    if (isEditingTarget(event.target) || hasTextSelection()) return;
    const payload = actBoardNodeClipboardPayload(activeNode());
    if (!payload) return;
    actBoardNodeClipboard = payload;
    const text = actBoardNodeClipboardText(payload);
    if (event.clipboardData && text) {
      event.clipboardData.setData(ACT_BOARD_NODE_CLIPBOARD_MIME, text);
      event.clipboardData.setData('text/plain', 'Act Board node');
      event.preventDefault();
    }
  });
  boardLayer.addEventListener('paste', event => {
    if (isEditingTarget(event.target) || hasTextSelection()) return;
    const raw = event.clipboardData?.getData(ACT_BOARD_NODE_CLIPBOARD_MIME) || '';
    let payload = null;
    if (raw) {
      try { payload = JSON.parse(raw); } catch (error) { payload = null; }
    }
    payload = payload || actBoardNodeClipboard;
    if (!payload) return;
    event.preventDefault();
    event.stopPropagation();
    pasteActBoardNodeFromPayload(actKey, boardLayer, payload);
  });
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
    // Remove only the selected edge. Keep any predecessor of the source and
    // successor of the target so deleting A → B from A → B → C does not also
    // erase B → C.
    if (source.nextAudioNodeId === target.id) source.nextAudioNodeId = null;
    target.previousAudioNodeId = null;
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
  let lastPointerDown = 0;
  let lastPointerDownX = 0;
  let lastPointerDownY = 0;
  let suppressNativeDoubleClickUntil = 0;
  let lastLinkActivationAt = 0;
  let lastLinkActivationNodeId = '';
  const activateLink = event => {
    const eventTarget = event.target;
    if (eventTarget?.closest?.('button, input, audio, a, select, textarea, label, details, summary, .storyboard-act-board-node-resize-handle')) return;
    // WebKit can deliver the same physical double-click through the pointerup,
    // click(detail=2), and native dblclick paths. Only the first path should
    // mutate the graph; otherwise the second delivery immediately starts a new
    // pending link on the destination and makes it look like the link failed.
    const now = Date.now();
    if (lastLinkActivationNodeId === node.id && now - lastLinkActivationAt < 600) return;
    lastLinkActivationAt = now;
    lastLinkActivationNodeId = node.id;
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
      // Finish the pointer/click event before rebuilding the board. Replacing
      // the nodeStack during a capture-phase pointerup can otherwise detach
      // the card while its drag handler is still unwinding, which makes the
      // newly-created edge appear to vanish intermittently.
      connectActBoardNodes(actKey, sourceId, node.id, { render: false });
      const rerender = () => {
        if (typeof document === 'undefined' || document.body.contains(boardLayer)) {
          rerenderActBoard();
        }
      };
      if (typeof queueMicrotask === 'function') queueMicrotask(rerender);
      else setTimeout(rerender, 0);
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
  }, true);
  // The drag handler is installed before this linking handler and would
  // otherwise claim the second click of a physical double-click. Capture the
  // pointerdown early enough to leave the card in place; pointerup below still
  // completes the link activation.
  card.addEventListener('pointerdown', event => {
    if (event.button !== 0
      || event.target?.closest?.('button, input, audio, a, select, textarea, label, details, summary, .storyboard-act-board-node-resize-handle')) return;
    const now = Date.now();
    const isSecondClick = now - lastPointerDown <= 420
      && Math.hypot(event.clientX - lastPointerDownX,
        event.clientY - lastPointerDownY) <= 12;
    lastPointerDown = now;
    lastPointerDownX = event.clientX;
    lastPointerDownY = event.clientY;
    if (boardLayer._actBoardLinkState?.sourceId || isSecondClick) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);
  // Some Safari/WebKit layouts with selectable narration text do not deliver
  // a native dblclick consistently after pointerdown handlers call
  // preventDefault. The second click still carries detail === 2, so use it as
  // a capture-phase fallback before nested phrase handlers can consume it.
  card.addEventListener('click', event => {
    if (event.detail !== 2 || Date.now() < suppressNativeDoubleClickUntil) return;
    suppressNativeDoubleClickUntil = Date.now() + 500;
    activateLink(event);
  }, true);
  card.addEventListener('pointerup', event => {
    if (event.button !== 0
      || event.target?.closest?.('button, input, audio, a, select, textarea, label, details, summary, .storyboard-act-board-node-resize-handle')) return;
    const now = Date.now();
    if (now - lastPointerUp <= 420) {
      lastPointerUp = 0;
      suppressNativeDoubleClickUntil = now + 500;
      activateLink(event);
    } else {
      lastPointerUp = now;
    }
  }, true);
}

function buildActBoardLinkLayer(boardLayer, nodes) {
  const markerId = createActBoardNodeId('link-arrow');
  const pendingMarkerId = `${markerId}-pending`;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('storyboard-act-board-link-layer');
  svg.setAttribute('aria-hidden', 'true');
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  [[markerId, '#000'], [pendingMarkerId, '#000']].forEach(([id, color]) => {
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
  const pathKeys = new Set();
  const addLinkPath = (sourceId, targetId, kind = '') => {
    if (!byId.has(sourceId) || !byId.has(targetId)) return;
    const pathKey = `${sourceId}->${targetId}`;
    if (pathKeys.has(pathKey)) return;
    pathKeys.add(pathKey);
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
    const footageIds = Array.isArray(narration.footageNodeIds)
      ? narration.footageNodeIds : [];
    footageIds.forEach(targetId => {
      addLinkPath(previousId, targetId,
        previousId === narration.id ? 'narration-link' : 'footage-link');
      previousId = targetId;
    });
  });
  // Also render the reciprocal pointer. Restored/legacy sessions can contain
  // footage.narrationNodeId without the narration's ordered list; showing the
  // edge from either side keeps the canvas truthful and makes the relationship
  // repairable by reconnecting the cards.
  nodes.filter(node => node.type === 'footage' && node.narrationNodeId)
    .forEach(node => addLinkPath(node.narrationNodeId, node.id, 'narration-link'));
  nodes.filter(node => node.type === 'footage' && node.previousFootageNodeId)
    .forEach(node => addLinkPath(node.previousFootageNodeId, node.id, 'footage-link'));
  nodes.filter(node => node.type === 'audio' && node.linkedToNodeId)
    .forEach(node => addLinkPath(node.linkedToNodeId, node.id, 'audio-link'));
  nodes.filter(node => node.type === 'audio' && node.previousAudioNodeId)
    .forEach(node => addLinkPath(node.previousAudioNodeId, node.id, 'audio-link'));
  // Render from the forward pointer as well. Older restored sessions can
  // temporarily have only one reciprocal side of a chain; this keeps A → B →
  // C visible, while pathKeys prevents duplicate overlays when both sides are
  // present.
  nodes.filter(node => node.type === 'audio' && node.nextAudioNodeId)
    .forEach(node => addLinkPath(node.id, node.nextAudioNodeId, 'audio-link'));
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

function openActBoardNodeSpawnMenu(nodeStack, actKey, clientX, clientY) {
  if (!nodeStack) return;
  const closeSpawnMenu = () => {
    nodeStack.querySelector('.storyboard-act-board-node-spawn-menu')?.remove();
  };
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
  const openScene = actBoardOpenSceneForAct(actKey) || visibleScenes[0];
  const rect = nodeStack.getBoundingClientRect();
  const sceneCard = openScene?.id
    ? nodeStack.querySelector(`[data-board-scene-id="${openScene.id}"]`)
    : null;
  const sceneX = Number.isFinite(Number.parseFloat(sceneCard?.style?.left))
    ? Number.parseFloat(sceneCard.style.left) : Math.max(0, Number(openScene?.boardX) || 0);
  const sceneY = Number.isFinite(Number.parseFloat(sceneCard?.style?.top))
    ? Number.parseFloat(sceneCard.style.top) : Math.max(0, Number(openScene?.boardY) || 0);
  const sceneWidth = Math.max(1,
    Number(sceneCard?.offsetWidth) || Number(openScene?.boardWidth) || nodeStack.clientWidth || 1);
  const sceneHeight = Math.max(1,
    Number(sceneCard?.offsetHeight) || Number(openScene?.boardHeight) || nodeStack.clientHeight || 1);
  const rawX = (Number(clientX) || rect.left) - rect.left + nodeStack.scrollLeft;
  const rawY = (Number(clientY) || rect.top) - rect.top + nodeStack.scrollTop;
  // A node must always originate inside the open scene frame. Do not open a
  // spawn menu for double-clicks in the surrounding canvas between scenes.
  if (rawX < sceneX || rawX > sceneX + sceneWidth
    || rawY < sceneY || rawY > sceneY + sceneHeight) return;
  const x = Math.max(sceneX, Math.min(rawX, sceneX + sceneWidth));
  const y = Math.max(sceneY, Math.min(rawY, sceneY + sceneHeight));
  closeSpawnMenu();
  const menu = document.createElement('div');
  menu.className = 'storyboard-act-board-node-spawn-menu';
  menu.tabIndex = -1;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const label = document.createElement('span');
  label.textContent = 'Add';
  menu.appendChild(label);
  [['narration', 'Narration'], ['footage', 'Footage'], ['audio', 'Music / sound']].forEach(([type, text]) => {
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
  // Double-click-to-spawn is the board's main creation gesture and nothing on
  // screen says so. Show a non-interactive hint whenever the act has a scene
  // that still has nothing in it - the hint reads "add to scene", which is
  // meaningless before any scene exists, and once a scene already has nodes
  // the gesture is no longer the first thing a presenter needs pointed out.
  // Recomputed on every mount (rather than a one-time-ever flag) so a freshly
  // added empty scene gets the hint again even after an earlier one taught it.
  if (actBoardScenesForAct(actKey).some(scene => !actBoardSceneNodes(scene).length)) {
    showActBoardSpawnHint(nodeStack);
  }
  nodeStack.addEventListener('dblclick', event => {
    dismissActBoardSpawnHint(nodeStack);
    const nodeTarget = event.target.closest('.storyboard-act-board-node');
    const onPlaybackSurface = nodeTarget?.classList.contains('storyboard-act-board-node-playback');
    // The playback card is a large scene-level surface and often occupies the
    // only visually empty area where a presenter wants to add another sound.
    // Keep its controls/link layer protected, but treat its blank surface as
    // canvas space so multiple audio nodes can be spawned normally.
    if ((nodeTarget && !onPlaybackSurface)
      || event.target.closest('.storyboard-act-board-node-spawn-menu, .storyboard-act-board-footage-drop-menu, .storyboard-act-board-scene-narration-scroll-btn')
      || (onPlaybackSurface
        && event.target.closest('button, input, audio, video, a, select, textarea, label, details, summary, .storyboard-act-board-node-resize-handle'))) return;
    openActBoardNodeSpawnMenu(nodeStack, actKey, event.clientX, event.clientY);
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

function dismissActBoardSpawnHint(nodeStack) {
  const hint = nodeStack?.querySelector?.('.storyboard-act-board-spawn-hint');
  if (!hint) return;
  hint.classList.add('is-leaving');
  // Let the fade finish, but never leave the element behind if the board is
  // torn down mid-transition.
  window.setTimeout(() => hint.remove(), 320);
}

function showActBoardSpawnHint(nodeStack) {
  if (!nodeStack) return;
  if (nodeStack.querySelector('.storyboard-act-board-spawn-hint')) return;
  const hint = document.createElement('div');
  hint.className = 'storyboard-act-board-spawn-hint';
  // Decorative and never focusable: the gesture it describes stays available
  // underneath it, and a screen reader gets the board's own controls instead.
  hint.setAttribute('aria-hidden', 'true');
  const cursor = document.createElement('span');
  cursor.className = 'storyboard-act-board-spawn-hint-cursor';
  const label = document.createElement('span');
  label.className = 'storyboard-act-board-spawn-hint-label';
  label.textContent = 'Double-click to add to scene';
  hint.append(cursor, label);
  nodeStack.appendChild(hint);
}

function actBoardRectsIntersect(a, b) {
  if (!a || !b) return false;
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

// Dragging blank canvas space creates a temporary selection rectangle. The
// selected node ids stay local to this rendered board and are consumed by the
// normal node-drag handler; this gesture never creates, hides, or reassigns a
// scene.
function wireActBoardNodeMarquee(nodeStack) {
  if (!nodeStack || nodeStack._actBoardNodeMarqueeWired) return;
  nodeStack._actBoardNodeMarqueeWired = true;
  let gesture = null;

  const clearSelection = () => {
    nodeStack._actBoardSelectedNodeIds = new Set();
    nodeStack.querySelectorAll('.storyboard-act-board-node.act-board-node-marquee-selected')
      .forEach(card => card.classList.remove('act-board-node-marquee-selected'));
  };
  const setSelection = selectedIds => {
    const ids = new Set((selectedIds || []).filter(Boolean));
    nodeStack._actBoardSelectedNodeIds = ids;
    nodeStack.querySelectorAll('.storyboard-act-board-node[data-node-id]')
      .forEach(card => card.classList.toggle(
        'act-board-node-marquee-selected', ids.has(card.dataset.nodeId)));
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
        'act-board-node-marquee-selected', actBoardRectsIntersect(card.getBoundingClientRect(), selectionRect)));
  };
  const finish = event => {
    if (!gesture) return;
    const current = gesture;
    gesture = null;
    current.marquee.remove();
    nodeStack.classList.remove('act-board-node-marquee-active');
    try { nodeStack.releasePointerCapture(current.pointerId); } catch (err) { /* optional */ }
    if (event?.type === 'pointercancel') {
      // A cancelled marquee must not leave a temporary outline behind or
      // retain a half-updated selection set.
      clearSelection();
      return;
    }
    if (!current.hasMoved) {
      clearSelection();
      return;
    }
    if (Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)) {
      current.selectionRect = {
        left: Math.min(current.startClientX, event.clientX),
        right: Math.max(current.startClientX, event.clientX),
        top: Math.min(current.startClientY, event.clientY),
        bottom: Math.max(current.startClientY, event.clientY),
      };
    }
    const selected = Array.from(nodeStack.querySelectorAll('.storyboard-act-board-node[data-node-id]'))
      .filter(card => actBoardRectsIntersect(card.getBoundingClientRect(), current.selectionRect))
      .map(card => card.dataset.nodeId)
      .filter(Boolean);
    setSelection(selected);
    saveDebugSession();
    // Selection is intentionally local to this canvas. It does not define a
    // scene, move nodes between scenes, or alter the saved scene stack.
  };

  nodeStack.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target !== nodeStack) return;
    // A short click remains inert so the existing blank-space double-click
    // gesture can still open the node spawn menu.
    const marquee = document.createElement('div');
    marquee.className = 'storyboard-act-board-node-marquee';
    nodeStack.appendChild(marquee);
    nodeStack.classList.add('act-board-node-marquee-active');
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

