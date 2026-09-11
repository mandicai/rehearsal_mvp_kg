function actBoardNodesForAct(actKey) {
  if (!Array.isArray(actBoardNodes[actKey])) actBoardNodes[actKey] = [];
  return actBoardNodes[actKey];
}

function actBoardScenesForAct(actKey) {
  if (!Array.isArray(actBoardScenes[actKey])) actBoardScenes[actKey] = [];
  return actBoardScenes[actKey];
}

// Resolve the nodes that belong to a saved scene from both the live canvas
// and its snapshots. Scene cards are sometimes built from the currently open
// node list while the scene itself has newer members in its saved snapshot
// (for example after loading another scene or adding a new phrase). Keeping
// this lookup in one place prevents scene actions such as Smart arrange from
// silently becoming a no-op because they were handed a stale node array.
function actBoardSceneNodes(scene, nodes = null) {
  if (!scene) return [];
  const candidates = [];
  if (Array.isArray(nodes)) candidates.push(...nodes);
  if (scene.actKey) candidates.push(...actBoardRenderNodesForAct(scene.actKey));
  const byId = new Map();
  candidates.forEach(node => {
    if (!node?.id || byId.has(node.id)) return;
    byId.set(node.id, node);
  });
  const sceneIds = new Set([
    ...(scene.nodeIds || []),
    ...(Array.isArray(scene.nodeSnapshots) ? scene.nodeSnapshots.map(snapshot => snapshot?.id) : []),
  ].filter(Boolean));
  return Array.from(byId.values()).filter(node => node.type !== 'playback'
    && (sceneIds.has(node.id) || node.sceneId === scene.id));
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
      // Earlier starter scenes used a 360px default. Treat that untouched
      // legacy value as the old default and expand it to the current spacious
      // canvas size; genuinely larger/user-expanded boards are preserved.
      if (Number(scene.boardHeight) === 360) {
        scene.boardHeight = ACT_BOARD_DEFAULT_SCENE_HEIGHT;
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
      boardHeight: ACT_BOARD_DEFAULT_SCENE_HEIGHT,
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
    && position.y <= (Number(scene.boardY) || 0) + Math.max(116,
      Number(scene.boardHeight) || ACT_BOARD_DEFAULT_SCENE_HEIGHT)) || null;
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
    && position.y <= (Number(scene.boardY) || 0) + Math.max(116,
      Number(scene.boardHeight) || ACT_BOARD_DEFAULT_SCENE_HEIGHT));
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

function expandActBoardScenesToContainNodes(nodeStack, actKey, nodes, options = {}) {
  if (!nodeStack) return;
  const preserveNodePositions = options.preserveNodePositions === true;
  // Playback is rendered in the persistent scene playback panel rather than
  // as a canvas card, so it must not add invisible space to scene frames.
  const source = (Array.isArray(nodes) ? nodes : actBoardNodesForAct(actKey))
    .filter(node => node?.type !== 'playback');
  const scenes = actBoardScenesForAct(actKey);
  const cards = new Map(Array.from(nodeStack.querySelectorAll('.storyboard-act-board-node[data-node-id]'))
    .map(card => [card.dataset.nodeId, card]));
  scenes.filter(scene => scene.hidden !== true).forEach(scene => {
    const included = source.filter(node => (scene.nodeIds || []).includes(node.id)
      || node.sceneId === scene.id)
      // A pending Visualize shell has only a temporary narration-relative
      // fallback coordinate. Do not let that hidden coordinate expand the
      // scene (or create the downward drift this placer is meant to avoid).
      .filter(node => !(preserveNodePositions
        && node.type === 'footage'
        && node.boardPositionMode === 'footage-section-auto'));
    if (!included.length) return;
    const sceneCard = nodeStack.querySelector(`[data-board-scene-id="${scene.id}"]`);
    const footageLayer = sceneCard?.querySelector(
      '.storyboard-act-board-scene-footage-node-layer',
    );
    const stackRect = nodeStack.getBoundingClientRect?.();
    const layerRect = footageLayer?.getBoundingClientRect?.();
    const layerOrigin = footageLayer && stackRect && layerRect
      ? {
        x: layerRect.left - stackRect.left + (Number(nodeStack.scrollLeft) || 0),
        y: layerRect.top - stackRect.top + (Number(nodeStack.scrollTop) || 0),
      } : null;
    const canvasPosition = node => {
      if (node?.type === 'footage' && node.boardPositionSpace === 'footage-section'
        && layerOrigin) {
        return {
          x: layerOrigin.x + (Number(node.boardX) || 0),
          y: layerOrigin.y + (Number(node.boardY) || 0),
        };
      }
      return actBoardNodePosition(node, 0);
    };
    const sceneTopBefore = Number(scene.boardY) || 0;
    const sceneHeader = sceneCard?.querySelector('.storyboard-act-board-board-scene-header');
    const sceneNodeList = sceneCard?.querySelector('.storyboard-act-board-board-scene-node-list');
    const headerHeight = Math.max(32, Number(sceneHeader?.offsetHeight) || 0);
    const nodeListHeight = Math.max(0, Number(sceneNodeList?.offsetHeight) || 0);
    // The framed board header is absolutely positioned. Reserve a band below
    // it so the first narration/footage card cannot render underneath the
    // header when a scene is initially created or expanded.
    if (sceneCard && headerHeight > 0 && !preserveNodePositions) {
      const firstTop = Math.min(...included.map(node => {
        const card = cards.get(node.id);
        const position = canvasPosition(node);
        return Number.isFinite(Number(card?.style?.top))
          ? Number.parseFloat(card.style.top) : position.y;
      }));
      const minimumNodeTop = sceneTopBefore + headerHeight + 10;
      if (firstTop < minimumNodeTop) {
        const delta = minimumNodeTop - firstTop;
        included.forEach(node => {
          const card = cards.get(node.id);
          if (node.type === 'footage' && node.boardPositionSpace === 'footage-section') return;
          const position = canvasPosition(node);
          node.boardY = position.y + delta;
          if (card) card.style.top = `${node.boardY}px`;
        });
      }
    }
    const positions = included.map(node => {
      const card = cards.get(node.id);
      const position = canvasPosition(node);
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
        node.type === 'footage' ? ACT_BOARD_FOOTAGE_STANDARD_HEIGHT
          : ACT_BOARD_NODE_STANDARD_HEIGHT,
      );
      return {
        top: cardTop,
        bottom: cardTop + renderedHeight,
      };
    });
    const minTop = Math.min(...positions.map(position => position.top));
    const maxBottom = Math.max(...positions.map(position => position.bottom));
    // Incremental Visualize patches may add cards below an existing manual
    // layout. Keep the scene's origin fixed in that path; only its bottom
    // edge is allowed to grow. Structural renders retain the legacy behavior
    // of nudging a scene upward when its first node would sit above the frame.
    const sceneTop = preserveNodePositions
      ? Math.max(0, Number(scene.boardY) || 0)
      : Math.max(0, Math.min(Number(scene.boardY) || 0, minTop - 24));
    // The node summary is anchored to the bottom of the framed scene. Reserve
    // room for it and the header together so a wrapped list cannot be hidden
    // underneath the header or clipped by the scene surface.
    const headerAndListHeight = headerHeight + nodeListHeight + 28;
    const sceneHeight = Math.max(116, maxBottom - sceneTop + 32, headerAndListHeight);
    if (sceneTop !== (Number(scene.boardY) || 0)) {
      scene.boardY = sceneTop;
      if (sceneCard) sceneCard.style.top = `${sceneTop}px`;
    }
    if (sceneHeight > (Number(scene.boardHeight) || ACT_BOARD_DEFAULT_SCENE_HEIGHT)) {
      scene.boardHeight = sceneHeight;
      if (sceneCard) sceneCard.style.height = `${sceneHeight}px`;
    }
    const currentMinHeight = parseFloat(nodeStack.style.minHeight) || 0;
    nodeStack.style.minHeight = `${Math.max(ACT_BOARD_DEFAULT_CANVAS_HEIGHT, currentMinHeight, sceneTop + sceneHeight + 24)}px`;
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
      documentaryModeSource: sourceScene?.documentaryModeSource === 'user' ? 'user' : 'moodboard',
      includeNarration: sourceScene?.includeNarration !== false,
      sequenceStartNodeId: null,
    boardX: sourceScene ? Number(sourceScene.boardX) || 0 : 0,
    boardY: sourceScene ? Number(sourceScene.boardY) || 0 : 0,
    boardWidth: sourceScene ? Number(sourceScene.boardWidth) || 560 : 560,
    boardHeight: sourceScene
      ? Number(sourceScene.boardHeight) || ACT_BOARD_DEFAULT_SCENE_HEIGHT
      : ACT_BOARD_DEFAULT_SCENE_HEIGHT,
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
    // Keep forward-only audio chains restorable as well. Older sessions (or
    // an interrupted relink) can have the reciprocal previous pointer
    // missing even though the source still points at its next node.
    if (node.type === 'audio' && node.nextAudioNodeId
      && selected.has(node.id) && selected.has(node.nextAudioNodeId)) {
      links.push({ sourceId: node.id, targetId: node.nextAudioNodeId, type: 'audio-chain' });
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

function syncActBoardLiveSceneSnapshots(targetScene = null) {
  Object.entries(actBoardScenes || {}).forEach(([actKey, scenes]) => {
    if (!Array.isArray(scenes)) return;
    if (targetScene && (String(targetScene.actKey) !== String(actKey))) return;
    const liveNodes = actBoardNodesForAct(actKey);
    scenes.forEach(scene => {
      if (targetScene && scene.id !== targetScene.id) return;
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

// Persist the currently open scene immediately before another scene replaces
// the live node array. This is intentionally scoped to the selected scene:
// an empty destination scene must never cause the source scene's saved
// snapshots to be rebuilt from the destination's (usually empty) live array.
function persistActBoardSceneBeforeSwitch(scene) {
  if (!scene?.actKey || scene.liveNodesCleared === true) return;
  const liveNodes = actBoardNodesForAct(scene.actKey);
  const listed = new Set(scene.nodeIds || []);
  const members = liveNodes.filter(node => listed.has(node.id) || node.sceneId === scene.id);
  if (!members.length) return;
  scene.nodeIds = members.map(node => node.id);
  scene.nodeSnapshots = members.map(snapshotActBoardSceneNode).filter(Boolean);
  scene.nodeLinks = snapshotActBoardSceneLinks(members, scene.nodeIds);
  scene.liveNodesCleared = false;
}

function restoreActBoardSceneToCanvas(scene) {
  if (!scene || !scene.actKey) return;
  // Loading the scene that is already open should be a no-op. In particular,
  // repeated clicks on a card must not rebuild the live canvas repeatedly or
  // make it appear as though several scenes are active at once.
  if (actBoardOpenSceneForAct(scene.actKey)?.id === scene.id) {
    const expectedIds = new Set([
      ...(scene.nodeIds || []),
      ...(scene.nodeSnapshots || []).map(snapshot => snapshot?.id),
    ].filter(Boolean));
    const liveNodes = actBoardNodesForAct(scene.actKey);
    const liveIds = new Set(liveNodes.map(node => node.id));
    const onlyThisScene = liveNodes.every(node =>
      node.sceneId === scene.id || expectedIds.has(node.id));
    const hasExpectedNodes = [...expectedIds].every(id => liveIds.has(id));
    if (onlyThisScene && hasExpectedNodes) return;
  }
  // Save the currently live scene's latest node/link state before replacing
  // the canvas with another scene. Do this before changing the open-scene
  // pointer so the snapshot cannot be attributed to the destination scene.
  const previousScene = actBoardOpenSceneForAct(scene.actKey);
  if (previousScene && previousScene.id !== scene.id) {
    persistActBoardSceneBeforeSwitch(previousScene);
  }
  setActBoardOpenScene(scene.actKey, scene);
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
    if (!savedPlayback) ensureActBoardPlaybackNode(actKey, null, {
      create: true, sceneId: scene.id,
    });
    const playback = actBoardNodesForAct(actKey).find(node =>
      node.type === 'playback' && node.sceneId === scene.id);
    if (playback && !(scene.nodeIds || []).includes(playback.id)) {
      scene.nodeIds = [...(scene.nodeIds || []), playback.id];
      scene.nodeSnapshots = [...(scene.nodeSnapshots || []), snapshotActBoardSceneNode(playback)]
        .filter(Boolean);
    }
    scene.nodeLinks = [];
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

// The Story outline lives outside the canvas. After a scene is restored, the
// board is rebuilt and the previous page scroll is restored as well, so a
// plain scrollIntoView in the outline click handler can be overwritten on the
// next animation frame. Defer the jump until the rebuilt act column exists and
// the render-state restoration has completed.
function scrollActBoardToScene(scene) {
  if (!scene?.actKey) return;
  const jump = () => {
    const board = document.querySelector('.storyboard-act-board-view');
    if (!board) return;
    const column = Array.from(board.querySelectorAll('.storyboard-act-board-column'))
      .find(item => String(item.dataset.actKey) === String(scene.actKey));
    if (!column) return;
    const sceneCard = Array.from(column.querySelectorAll('[data-board-scene-id]'))
      .find(item => String(item.dataset.boardSceneId) === String(scene.id));
    (sceneCard || column).scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(jump));
  } else {
    setTimeout(jump, 0);
  }
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

