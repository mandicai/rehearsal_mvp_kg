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
  if (node.type === 'footage') return ACT_BOARD_FOOTAGE_STANDARD_WIDTH;
  const minimum = node.type === 'narration' ? 300 : 120;
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
  return Math.max(120, Math.floor(actBoardCanvasWidth(boardLayer) * 0.6));
}

function actBoardNarrationWidth(node, boardLayer) {
  // Narration is a compact SVG-shaped card, not a duration- or viewport-sized
  // canvas node. Keep one predictable footprint so dragging and linking never
  // cause the shape or its waveform to jump between sizes.
  return ACT_BOARD_NARRATION_STANDARD_WIDTH;
}

function actBoardAutoWidth(node, boardLayer) {
  const width = node.type === 'narration'
    ? actBoardNarrationWidth(node, boardLayer)
    : node.type === 'audio'
      ? Math.max(220, actBoardNodeDurationWidth(node))
      : actBoardNodeDurationWidth(node);
  // Existing explicit widths are user work. Narration cards follow their
  // stable shell size; footage cards keep their dimensions while their
  // positions remain free-form inside the scene Footage section.
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

// The narration SVG has a fixed height, but its adjacent script preview can
// grow taller as the suggested/recorded narration wraps. Use that preview's
// actual extent when available so linked footage is always placed beneath the
// complete narration readout rather than beneath only the SVG shell.
function actBoardNarrationContentHeight(narration, narrationCard = null) {
  const shellHeight = Number(narration?.boardHeight) > 0
    ? Number(narration.boardHeight) : ACT_BOARD_NARRATION_STANDARD_HEIGHT;
  const preview = narrationCard?.querySelector?.(
    '.storyboard-act-board-narration-side-preview',
  );
  if (preview) {
    const computedTop = typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
      ? Number.parseFloat(window.getComputedStyle(preview).top)
      : NaN;
    const previewTop = Number.isFinite(computedTop)
      ? computedTop : (Number(preview.offsetTop) || 0);
    return Math.max(shellHeight, previewTop + (Number(preview.offsetHeight) || 0));
  }
  // Before cards are mounted, estimate the wrapped preview conservatively.
  // The rendered pass below replaces this estimate with offsetHeight.
  const text = String(narration?.transcript || narration?.text || '').trim();
  const estimatedLines = Math.max(1, Math.ceil(text.length / 72));
  return Math.max(shellHeight, 120 + 18 + estimatedLines * 15);
}

function layoutActBoardNodeGeometry(actKey, nodes, options = {}) {
  const source = Array.isArray(nodes) ? nodes : actBoardNodesForAct(actKey);
  const preserveFootageNodeIds = options.preserveFootageNodeIds instanceof Set
    ? options.preserveFootageNodeIds : new Set(options.preserveFootageNodeIds || []);
  // Keep every persisted node on the board's single standard footprint. This
  // also prevents the first layout pass from using stale dimensions before
  // the DOM cards are rebuilt.
  source.forEach(node => {
    if (!node) return;
    node.boardHeight = ACT_BOARD_NODE_STANDARD_HEIGHT;
    node.boardHeightMode = 'auto';
  });
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
      ? Number(narration.boardHeight) : ACT_BOARD_NODE_STANDARD_HEIGHT;
    let cursorX = Number(narration.boardX) || 0;
    const childY = (Number(narration.boardY) || 0)
      + Math.max(parentHeight, actBoardNarrationContentHeight(narration))
      + ACT_BOARD_NODE_GAP;
    (narration.footageNodeIds || []).forEach(id => {
      const footage = source.find(node => node.id === id);
      if (!footage) return;
      // Visualize marks only newly created cards as pending placement. Give
      // them a temporary narration-relative fallback coordinate without
      // converting that marker to the general responsive `auto` mode; the
      // scene Footage-lane placer needs to see the pending marker after this
      // geometry pass so it can place just those cards.
      const pendingFootagePlacement = footage.boardPositionMode === 'footage-section-auto';
      const preserveFootagePosition = preserveFootageNodeIds.has(footage.id);
      if (!preserveFootagePosition && !Number.isFinite(Number(footage.boardX))) {
        footage.boardX = cursorX;
        if (!pendingFootagePlacement) footage.boardPositionMode = 'auto';
      }
      if (!preserveFootagePosition && !Number.isFinite(Number(footage.boardY))) {
        footage.boardY = childY;
        if (!pendingFootagePlacement) footage.boardPositionMode = 'auto';
      }
      const width = actBoardAutoWidth(footage);
      if (!Number.isFinite(Number(footage.boardHeight)) || footage.boardHeightMode === 'auto') {
        footage.boardHeight = ACT_BOARD_FOOTAGE_STANDARD_HEIGHT;
        footage.boardHeightMode = 'auto';
      }
      cursorX += width + ACT_BOARD_FOOTAGE_GAP;
    });
  });
}

function refineActBoardRenderedGeometry(nodeStack, nodes, options = {}) {
  if (!nodeStack || !Array.isArray(nodes)) return;
  // Playback is a panel-only scene transport now; excluding its saved node
  // keeps hidden playback geometry from affecting the canvas layout.
  nodes = nodes.filter(node => node?.type !== 'playback');
  const preserveFootageNodeIds = options.preserveFootageNodeIds instanceof Set
    ? options.preserveFootageNodeIds
    : new Set(options.preserveFootageNodeIds || []);
  const cards = new Map(Array.from(nodeStack.querySelectorAll('[data-node-id]'))
    .map(card => [card.dataset.nodeId, card]));
  const narrationNodes = nodes.filter(node => node.type === 'narration');
  const canvasWidth = actBoardCanvasWidth(nodeStack);
  // Adding footage must not resize the narration card. Narration cards keep
  // one stable SVG-friendly size while linked footage is laid out underneath.
  narrationNodes.forEach(narration => {
    const narrationCard = cards.get(narration.id);
    if (!narrationCard) return;
    // Narration cards use one stable SVG-friendly size. They do not track
    // narration duration, viewport width, or saved resize dimensions.
    const narrationWidth = actBoardNarrationWidth(narration, nodeStack);
    narrationCard.style.width = `${narrationWidth}px`;
    narrationCard.style.height = `${ACT_BOARD_NARRATION_STANDARD_HEIGHT}px`;
    narration.boardWidth = narrationWidth;
    narration.boardWidthMode = 'auto';
    narration.boardHeight = ACT_BOARD_NARRATION_STANDARD_HEIGHT;
    narration.boardHeightMode = 'auto';
    narration.boardWidthCanvasWidth = canvasWidth;
    const linked = (narration.footageNodeIds || []).map(id => ({
      node: nodes.find(item => item.id === id), card: cards.get(id),
    })).filter(item => item.node && item.card);
    // Footage cards are free-form within their scene-local Footage layer.
    // This geometry pass may normalize their width, but it must never assign
    // row-based left/top coordinates; only explicit Organize does that.
    linked.forEach(({ node: footage, card: footageCard }) => {
      const width = footage.boardWidthMode === 'manual' && Number(footage.boardWidth) > 0
        ? Number(footage.boardWidth) : ACT_BOARD_FOOTAGE_STANDARD_WIDTH;
      if (footage.boardWidthMode !== 'manual') footage.boardWidth = width;
      footageCard.style.width = `${width}px`;
    });
  });
  const maxBottom = nodes.reduce((max, node, index) => {
    const card = cards.get(node.id);
    const position = actBoardNodePosition(node, index);
    const fallbackHeight = ACT_BOARD_NODE_STANDARD_HEIGHT;
    const height = card?.offsetHeight || Number(node.boardHeight) || fallbackHeight;
    return Math.max(max, position.y + height);
  }, 0);
  const actKey = nodeStack.closest('.storyboard-act-board-column')?.dataset.actKey;
  const maxSceneBottom = actKey
    ? actBoardScenesForAct(actKey)
      .filter(scene => scene.hidden !== true)
      .reduce((max, scene) => Math.max(max,
        (Number(scene.boardY) || 0) + Math.max(116,
          Number(scene.boardHeight) || ACT_BOARD_DEFAULT_SCENE_HEIGHT)), 0)
    : 0;
  nodeStack.style.minHeight = `${Math.max(ACT_BOARD_DEFAULT_CANVAS_HEIGHT, maxBottom + 24, maxSceneBottom + 24)}px`;
}

// Move footage cards into the scene-local Footage layer and migrate legacy
// node-stack coordinates once.  The rest of the board can continue to use the
// node objects for timing/relationships while the cards themselves live in a
// stable local coordinate space.
function mountActBoardFootageCardsInLayer(nodeStack, scene) {
  if (!nodeStack || !scene) return null;
  // Scene-scoped incremental patches temporarily keep the old scene card in
  // the stack while the replacement is mounted. Use the newest matching card
  // so footage cards are never moved into the soon-to-be-removed old scene.
  const sceneCards = Array.from(nodeStack.querySelectorAll(
    `[data-board-scene-id="${String(scene.id).replace(/"/g, '\\"')}"]`,
  ));
  const sceneCard = sceneCards[sceneCards.length - 1] || null;
  const layer = sceneCard?.querySelector('.storyboard-act-board-scene-footage-node-layer');
  if (!layer) return null;
  const stackRect = nodeStack.getBoundingClientRect();
  const layerRect = layer.getBoundingClientRect();
  const layerOriginX = layerRect.left - stackRect.left + (Number(nodeStack.scrollLeft) || 0);
  const layerOriginY = layerRect.top - stackRect.top + (Number(nodeStack.scrollTop) || 0);
  const sceneNodeIds = new Set([...(scene.nodeIds || []),
    ...actBoardNodesForAct(scene.actKey)
      .filter(node => node.sceneId === scene.id).map(node => node.id)]);
  const cards = Array.from(nodeStack.querySelectorAll(
    '.storyboard-act-board-node-footage[data-node-id]',
  ));
  cards.forEach(card => {
    const node = actBoardNodesForAct(scene.actKey)
      .find(item => item.id === card.dataset.nodeId);
    if (!node || !sceneNodeIds.has(node.id) || card.parentElement === layer) return;
    const wasLocal = node.boardPositionSpace === 'footage-section';
    const x = Number.parseFloat(card.style.left);
    const y = Number.parseFloat(card.style.top);
    const legacyX = Number.isFinite(x) ? x : Number(node.boardX) || 0;
    const legacyY = Number.isFinite(y) ? y : Number(node.boardY) || 0;
    const localX = wasLocal ? legacyX : legacyX - layerOriginX;
    const localY = wasLocal ? legacyY : legacyY - layerOriginY;
    // A card arriving from canvas space - a legacy session, or any node built
    // before this lane existed - can convert to a point outside the lane,
    // where the Footage section's overflow clip simply swallows it. Pull those
    // inside the measured lane. Cards already in lane space keep their saved
    // position: the lane grows to contain them instead.
    const clampable = !wasLocal && layerRect.width > 0 && layerRect.height > 0;
    const maxLocalX = Math.max(0, layerRect.width - (card.offsetWidth || 0));
    const maxLocalY = Math.max(0, layerRect.height - (card.offsetHeight || 0));
    node.boardX = Math.max(0, Math.round(clampable ? Math.min(localX, maxLocalX) : localX));
    node.boardY = Math.max(0, Math.round(clampable ? Math.min(localY, maxLocalY) : localY));
    node.boardPositionSpace = 'footage-section';
    card.style.left = `${node.boardX}px`;
    card.style.top = `${node.boardY}px`;
    layer.appendChild(card);
  });
  return layer;
}

// Place newly created footage cards inside the framed scene's Footage lane.
// Existing cards keep their saved positions; pending cards use the first open
// collision-free edge positions so adding a new highlighted phrase does not
// stack it on top of the other footage or move narration/audio nodes.
function positionActBoardFootageNodesInSceneSection(nodeStack, scene, nodes) {
  if (!nodeStack || !scene) return false;
  const pending = actBoardSceneNodes(scene, nodes).filter(node =>
    node.type === 'footage' && node.boardPositionMode === 'footage-section-auto');
  const retryWhenMeasurable = () => {
    if (!nodeStack.isConnected || nodeStack._actBoardFootagePlacementRetryScheduled) return;
    nodeStack._actBoardFootagePlacementRetryScheduled = true;
    const schedule = callback => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback);
      else setTimeout(callback, 0);
    };
    schedule(() => {
      nodeStack._actBoardFootagePlacementRetryScheduled = false;
      const stillPending = actBoardSceneNodes(scene, nodes).some(node =>
        node.type === 'footage' && node.boardPositionMode === 'footage-section-auto');
      if (stillPending) positionActBoardFootageNodesInSceneSection(nodeStack, scene, nodes);
    });
  };
  if (!pending.length) return false;
  const sceneCard = nodeStack.querySelector(
    `[data-board-scene-id="${String(scene.id).replace(/"/g, '\\"')}"]`,
  );
  const section = sceneCard?.querySelector('.storyboard-act-board-scene-section-footage');
  const layer = section?.querySelector('.storyboard-act-board-scene-footage-node-layer');
  if (!section) {
    retryWhenMeasurable();
    return false;
  }
  if (!layer) {
    retryWhenMeasurable();
    return false;
  }
  let sectionRect = section.getBoundingClientRect();
  let layerRect = layer.getBoundingClientRect();
  // During the first frame of an async Visualize/merge render the grid may
  // still report zero width/height even though the scene is in the DOM. Do
  // not commit fallback coordinates in that frame; retry after layout.
  if (!(sectionRect.width > 0 && sectionRect.height > 0
    && layerRect.width > 0 && layerRect.height > 0)) {
    retryWhenMeasurable();
    return false;
  }
  const cards = new Map(Array.from(layer.querySelectorAll('.storyboard-act-board-node[data-node-id]'))
    .map(card => [card.dataset.nodeId, card]));
  const dimensions = node => {
    const card = cards.get(node.id);
    return {
      width: Math.max(120, Number(card?.offsetWidth) || Number(node.boardWidth) || 220),
      height: Math.max(80, Number(card?.offsetHeight) || Number(node.boardHeight)
        || ACT_BOARD_NODE_STANDARD_HEIGHT),
    };
  };
  const padding = 12;
  const gap = 14;
  const dimensionsById = new Map(pending.map(node => [node.id, dimensions(node)]));
  const scrollX = () => Number(nodeStack.scrollLeft) || 0;
  const scrollY = () => Number(nodeStack.scrollTop) || 0;
  const measureLane = () => {
    layerRect = layer.getBoundingClientRect();
    const width = Math.max(1, layerRect.width);
    const height = Math.max(1, layerRect.height);
    // Coordinates in this routine are local to the dedicated Footage layer.
    // The track and heading are siblings above it, so the layer's top edge is
    // already the correct content origin for footage cards.
    return {
      left: padding,
      right: Math.max(padding + 1, width - padding),
      sectionTop: 0,
      sectionBottom: height,
      contentTop: padding,
    };
  };
  // Capture the placement origin before collecting obstacles. The origin is
  // intentionally stable for this batch; scene growth below may only extend
  // the available bottom edge.
  let initialLane = measureLane();
  // A restored scene can carry an old narrow board width. In that case every
  // standard footage card would legitimately fit only one-at-a-time, which
  // looks like a forced vertical staircase. Give the lane enough horizontal
  // room for at least two cards before falling back to another row. This does
  // not alter any existing node coordinates; it only widens the scene surface
  // when the measured lane is genuinely too narrow.
  const largestPendingWidth = Math.max(...pending.map(node => dimensions(node).width), 120);
  const minimumTwoCardWidth = largestPendingWidth * 2 + gap;
  if (initialLane.right - initialLane.left < minimumTwoCardWidth) {
    const sceneWidth = Math.max(
      Number(sceneCard.offsetWidth) || 0,
      minimumTwoCardWidth + padding * 2,
      Number(nodeStack.clientWidth) || 0,
    );
    sceneCard.style.minWidth = `${Math.ceil(sceneWidth)}px`;
    nodeStack.style.minWidth = `${Math.ceil(sceneWidth)}px`;
    initialLane = measureLane();
  }
  const placementOrigin = {
    left: initialLane.left,
    right: initialLane.right,
    contentTop: initialLane.contentTop,
  };
  const occupied = [];
  const intersects = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x
    && a.y < b.y + b.height && a.y + a.height > b.y;
  const footage = actBoardSceneNodes(scene, nodes).filter(node => node.type === 'footage');
  footage.filter(node => !pending.includes(node)).forEach(node => {
    const size = dimensions(node);
    const card = cards.get(node.id);
    // Prefer the rendered rectangle when available. It is in the same
    // coordinate space as the measured lane after converting through the
    // node-stack origin, and remains correct if a card was positioned through
    // a drag/transform rather than an inline left/top assignment.
    const cardRect = card?.getBoundingClientRect?.();
    const x = Number.parseFloat(card?.style?.left);
    const y = Number.parseFloat(card?.style?.top);
    const rect = {
      x: Number.isFinite(x) ? x : Number(node.boardX) || 0,
      y: Number.isFinite(y) ? y : Number(node.boardY) || 0,
      width: size.width,
      height: size.height,
    };
    // Cards that are outside the active Footage lane must not reserve slots in
    // it. They are legacy/freely arranged cards and are deliberately left in
    // place; only a rectangle that actually intersects the lane can block a
    // new pending card.
    if (rect.x + rect.width > initialLane.left
      && rect.x < initialLane.right
      && rect.y + rect.height > initialLane.contentTop
      && rect.y < initialLane.sectionBottom) {
      occupied.push(rect);
    }
  });
  // Existing cards are intentionally never moved. Search candidate positions
  // at the edges of occupied rectangles instead of fixed row/column slots.
  // Each candidate row is scanned left-to-right before moving down, so a
  // batch cannot devolve into the old bottom-right-to-top-left diagonal.
  const placementCandidates = (size, laneBottom, occupiedRects) => {
    // Candidate rows: the lane top, the top of every row a card has already
    // started, and the row below every card - so a half-filled row is filled
    // before a new one opens. The previous first-row / later-rows split
    // classified a card sitting exactly one row down as first-row, offered
    // only its BOTTOM as the next candidate, and skipped the free space
    // beside it: the cards that followed opened a new row under a lone one
    // until Organize recomputed the layout. Values within a few pixels are
    // merged to their maximum so slightly different card heights still form
    // one compact row rather than a staircase.
    const rawYs = [placementOrigin.contentTop];
    occupiedRects.forEach(rect => {
      [rect.y, rect.y + rect.height + gap].forEach(value => {
        if (Number.isFinite(value) && value >= placementOrigin.contentTop - 0.5) rawYs.push(value);
      });
    });
    rawYs.sort((a, b) => a - b);
    const yValues = [];
    rawYs.forEach(value => {
      const last = yValues.length - 1;
      if (last >= 0 && value - yValues[last] <= 12) yValues[last] = Math.max(yValues[last], value);
      else yValues.push(value);
    });
    const ys = yValues;
    for (const y of ys) {
      if (y + size.height > laneBottom - padding + 0.5) continue;
      let x = placementOrigin.left;
      while (x + size.width <= placementOrigin.right + 0.5) {
        const rect = { x, y, width: size.width, height: size.height };
        const colliding = occupiedRects.filter(item => intersects(rect, item));
        if (!colliding.length) return { x, y };
        const nextX = Math.max(...colliding.map(item => item.x + item.width + gap));
        if (!(nextX > x)) break;
        x = nextX;
      }
    }
    return null;
  };
  let lane = initialLane;
  const placements = new Map();
  const occupiedForPlacement = occupied.slice();
  for (let attempt = 0; attempt < 8 && placements.size < pending.length; attempt += 1) {
    // A failed candidate can occur in the middle of the batch. Iterate every
    // unresolved node rather than slicing by count, otherwise a later card
    // could be skipped permanently when an earlier card needs more room.
    pending.filter(node => !placements.has(node.id)).forEach(node => {
      const rawSize = dimensionsById.get(node.id) || dimensions(node);
      const size = {
        width: Math.min(rawSize.width, Math.max(120, placementOrigin.right - placementOrigin.left)),
        height: rawSize.height,
      };
      const chosen = placementCandidates(size, lane.sectionBottom, occupiedForPlacement);
      if (!chosen) return;
      const placement = { ...chosen, width: size.width, height: size.height };
      placements.set(node.id, placement);
      occupiedForPlacement.push(placement);
    });
    if (placements.size === pending.length) break;

    // Grow only the scene's bottom edge. Re-measure the bottom after growth,
    // but keep placementOrigin fixed so retrying cannot shift existing rows.
    const remaining = pending.filter(node => !placements.has(node.id));
    const largestRemainingHeight = Math.max(...remaining.map(node =>
      dimensionsById.get(node.id)?.height || ACT_BOARD_NODE_STANDARD_HEIGHT),
    ACT_BOARD_NODE_STANDARD_HEIGHT);
    const lowestOccupiedBottom = occupiedForPlacement.reduce((max, rect) =>
      Math.max(max, rect.y + rect.height), placementOrigin.contentTop);
    const desiredBottom = lowestOccupiedBottom + gap + largestRemainingHeight + padding;
    const previousBottom = lane.sectionBottom;
    const deficit = desiredBottom - previousBottom;
    const currentHeight = Math.max(116,
      Number(scene.boardHeight) || ACT_BOARD_DEFAULT_SCENE_HEIGHT);
    // If the candidate set is blocked by an occupied shape even though the
    // lowest occupied edge still fits, grow the bottom by one card height as
    // well. This gives the next pass a fresh row without moving the origin.
    const growth = deficit > 0
      ? Math.max(24, deficit) * 1.5
      : largestRemainingHeight + gap + padding;
    if (growth > 0) {
      scene.boardHeight = Math.max(currentHeight,
        Math.round(currentHeight + growth));
      const resizedSceneCard = nodeStack.querySelector(
        `[data-board-scene-id="${String(scene.id).replace(/"/g, '\\"')}"]`,
      );
      if (resizedSceneCard) resizedSceneCard.style.height = `${scene.boardHeight}px`;
    }
    const refreshedLane = measureLane();
    lane = {
      ...refreshedLane,
      left: placementOrigin.left,
      right: placementOrigin.right,
      contentTop: placementOrigin.contentTop,
    };
    if (refreshedLane.sectionBottom <= previousBottom + 0.5) break;
  }

  pending.forEach(node => {
    const chosen = placements.get(node.id);
    if (!chosen) return;
    node.boardX = Math.round(chosen.x);
    node.boardY = Math.round(chosen.y);
    node.boardPositionSpace = 'footage-section';
    node.boardPositionMode = 'manual';
    const card = cards.get(node.id);
    if (card) {
      card.style.left = `${node.boardX}px`;
      card.style.top = `${node.boardY}px`;
      card.style.width = `${Math.round(chosen.width)}px`;
      card.style.visibility = 'visible';
      card.classList.remove('storyboard-act-board-footage-pending-placement');
    }
  });
  // Any unresolved shell remains hidden rather than exposing its temporary
  // narration-relative fallback. A measurable lane has already had the
  // maximum bottom-growth retries above; a zero-sized lane is retried at the
  // early guard, so this path cannot spin an endless animation-frame loop.
  expandActBoardScenesToContainNodes(nodeStack, scene.actKey, pending, {
    preserveNodePositions: true,
  });
  if (nodeStack._actBoardLinkState) refreshActBoardLinkPaths(nodeStack);
  syncActBoardLiveSceneSnapshots(scene);
  saveDebugSession();
  return true;
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

function actBoardTrackAtPoint(clientX, clientY, node = null) {
  const canDrop = track => !node || typeof track?._actBoardCanDropNode !== 'function'
    || track._actBoardCanDropNode(node);
  const elements = typeof document.elementsFromPoint === 'function'
    ? document.elementsFromPoint(clientX, clientY) : [];
  const direct = elements.map(element =>
    element?.closest?.('.storyboard-act-board-footage-track'))
    .find(track => track && canDrop(track));
  if (direct) return direct;
  // Safari can omit an element that is underneath a captured pointer. Fall
  // back to a lightweight rectangle check so custom pointer dragging can still
  // drop a node onto a rail.
  return Array.from(document.querySelectorAll('.storyboard-act-board-footage-track'))
    .find(track => {
      if (!canDrop(track)) return false;
      const strip = track.querySelector('.storyboard-act-board-footage-track-strip');
      const rect = strip?.getBoundingClientRect?.() || track.getBoundingClientRect();
      return clientX >= rect.left && clientX <= rect.right
        && clientY >= rect.top && clientY <= rect.bottom;
    }) || null;
}

function clearActBoardTrackDropPreviews() {
  document.querySelectorAll('.storyboard-act-board-footage-track').forEach(track => {
    if (typeof track._actBoardClearDropPreview === 'function') {
      track._actBoardClearDropPreview();
    }
    track.classList.remove('drop-target');
  });
}

// A scene's Footage lane is a grid row inside the framed scene card, so the
// only way to make it taller is to grow the scene itself. Dragging a footage
// card toward the bottom of the lane extends the scene rather than stopping
// the card, which is what keeps free placement from being capped at whatever
// height the lane happened to have when the drag began. The automatic placer
// grows a scene the same way when it runs out of rows.
function growActBoardFootageLaneToFit(layer, requiredBottom) {
  if (!layer) return false;
  const deficit = requiredBottom + ACT_BOARD_FOOTAGE_LANE_DRAG_PADDING
    - layer.getBoundingClientRect().height;
  if (!(deficit > 0)) return false;
  const sceneCard = layer.closest('.storyboard-act-board-board-scene');
  const actKey = layer.dataset.actKey
    || sceneCard?.closest('.storyboard-act-board-column')?.dataset.actKey || '';
  const sceneId = layer.dataset.sceneId || sceneCard?.dataset.boardSceneId || '';
  const scene = actBoardScenesForAct(actKey).find(item => item.id === sceneId);
  if (!scene || !sceneCard) return false;
  const currentHeight = Math.max(116,
    Number(scene.boardHeight) || ACT_BOARD_DEFAULT_SCENE_HEIGHT);
  scene.boardHeight = Math.ceil(currentHeight + deficit);
  sceneCard.style.height = `${scene.boardHeight}px`;
  return true;
}

// The lane grows while a card is dragged toward its bottom edge. Once the
// cards move back up that extra height is dead space, so give it back: trim
// the scene by whatever surplus sits below the lowest card, and stop as soon
// as the lane stops shrinking - that point is the grid's own minimum row
// height, and taking more would only clip the scene's other lanes.
function shrinkActBoardFootageLaneToFit(layer) {
  if (!layer) return false;
  const sceneCard = layer.closest('.storyboard-act-board-board-scene');
  const actKey = layer.dataset.actKey
    || sceneCard?.closest('.storyboard-act-board-column')?.dataset.actKey || '';
  const sceneId = layer.dataset.sceneId || sceneCard?.dataset.boardSceneId || '';
  const scene = actBoardScenesForAct(actKey).find(item => item.id === sceneId);
  if (!scene || !sceneCard) return false;
  const contentBottom = Array.from(layer.children).reduce((max, child) =>
    Math.max(max, (Number.parseFloat(child.style.top) || 0) + (child.offsetHeight || 0)), 0);
  const required = contentBottom + ACT_BOARD_FOOTAGE_LANE_DRAG_PADDING;
  let changed = false;
  for (let pass = 0; pass < 8; pass += 1) {
    const laneHeight = layer.getBoundingClientRect().height;
    const surplus = laneHeight - required;
    if (!(surplus > 1)) break;
    const current = Math.max(116,
      Number(scene.boardHeight) || ACT_BOARD_DEFAULT_SCENE_HEIGHT);
    // Never shrink past the height a scene is born with. The grid's own
    // minimum row is far shorter than that, so trimming all the way down left
    // the lane a fraction of the size it had when the scene was first spawned.
    // A scene deliberately resized below the default keeps that size: `next`
    // cannot then beat `current`, and the guard below stops the pass.
    const next = Math.max(ACT_BOARD_DEFAULT_SCENE_HEIGHT,
      Math.round(current - surplus));
    if (next >= current) break;
    scene.boardHeight = next;
    sceneCard.style.height = `${next}px`;
    if (layer.getBoundingClientRect().height >= laneHeight - 0.5) {
      // The lane is already at its minimum row height; the scene card has
      // nothing left to give back.
      scene.boardHeight = current;
      sceneCard.style.height = `${current}px`;
      break;
    }
    changed = true;
  }
  return changed;
}

function wireActBoardNodeDragging(card, node, boardLayer, index) {
  if (!boardLayer) return;
  const startPosition = actBoardNodePosition(node, index);
  card.style.left = `${startPosition.x}px`;
  card.style.top = `${startPosition.y}px`;
  // card.title = 'Drag to reposition; double-click a node + drag + double-click another to link them.';
  card.addEventListener('pointerdown', event => {
    if (event.target.closest('button, input, audio, a, select, textarea, label, details, summary, .storyboard-act-board-node-text, .storyboard-act-board-node-fragment, .storyboard-act-board-node-fragment-title, .storyboard-act-board-narration-side-preview, .paper-section-open-slot')) return;
    // Once a double-click has armed link drawing, the following pointer
    // movement belongs to the temporary link path—not to node repositioning.
    // Suppressing the drag handler here keeps the source card anchored while
    // the presenter moves toward the destination node.
    if (boardLayer._actBoardLinkState?.sourceId) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    // Footage cards are positioned relative to their scene-local layer. All
    // other cards retain the act-wide canvas as their containing block.
    const dragRoot = node.type === 'footage'
      ? card.closest('.storyboard-act-board-scene-footage-node-layer') || boardLayer
      : boardLayer;
    const boardRect = dragRoot.getBoundingClientRect();
    // Claim the card for manual placement as soon as the presenter presses
    // it. If an async media result patches this scene during the drag, the
    // incremental renderer will preserve the live coordinates instead of
    // treating the card as an auto-placement candidate and snapping it back.
    if (node.type === 'footage') {
      node.boardPositionMode = 'manual';
      node.boardPositionSpace = 'footage-section';
    }
    // Footage cards may be arranged on multiple rows, but their drag region
    // is the entire Footage section—not the row where they were initially
    // packed. Use the section's bottom/right edges when available so a card
    // can move freely through all open space in that lane.
    // Use the card's rendered local position rather than the model's saved
    // position. A footage card is migrated into the scene-local layer after
    // it is built, and its local coordinates can differ from the legacy
    // node-stack coordinates that were used while the pointer was pressed.
    // Reading the inline position here keeps the pointer attached to the
    // exact point grabbed, even after a card has been manually moved.
    const origin = {
      x: Number.parseFloat(card.style.left) || 0,
      y: Number.parseFloat(card.style.top) || 0,
    };
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
          const childCard = childNode && actBoardNodeCard(boardLayer, id);
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
    // A marquee selection moves as one group. Keep the existing behavior that
    // dragging a narration also carries its connected footage/audio, and
    // merge the two groups without duplicating the node under the pointer.
    const selectedIds = boardLayer._actBoardSelectedNodeIds instanceof Set
      ? boardLayer._actBoardSelectedNodeIds : new Set();
    if (selectedIds.size && !selectedIds.has(node.id)) {
      // Starting a drag on an unselected card switches back to ordinary
      // single-node dragging, just like a fresh selection in a desktop canvas.
      boardLayer._actBoardSelectedNodeIds = new Set();
      boardLayer.querySelectorAll('.storyboard-act-board-node.act-board-node-marquee-selected')
        .forEach(selectedCard => selectedCard.classList.remove('act-board-node-marquee-selected'));
    }
    const selectedDragGroup = selectedIds.has(node.id)
      ? Array.from(selectedIds)
        .filter(id => id !== node.id)
        .map(id => {
          const selectedNode = actBoardNodesForAct(node.actKey)
            .find(item => item.id === id);
          const selectedCard = selectedNode
            && actBoardNodeCard(boardLayer, id);
          if (!selectedNode || !selectedCard) return null;
          return {
            node: selectedNode,
            card: selectedCard,
            x: parseFloat(selectedCard.style.left) || Number(selectedNode.boardX) || 0,
            y: parseFloat(selectedCard.style.top) || Number(selectedNode.boardY) || 0,
          };
        })
        .filter(Boolean)
      : [];
    const dragGroupById = new Map();
    [...connectedDragGroup, ...selectedDragGroup].forEach(item => {
      if (item?.node?.id && item.node.id !== node.id) dragGroupById.set(item.node.id, item);
    });
    const dragGroup = Array.from(dragGroupById.values());
    card.classList.add('dragging');
    try { card.setPointerCapture(event.pointerId); } catch (err) { /* optional */ }
    let geometryFrame = 0;
    const refreshDragGeometry = () => {
      geometryFrame = 0;
      if (!document.body.contains(card)) return;
      expandActBoardScenesToContainNodes(boardLayer, node.actKey);
      refreshActBoardLinkPaths(boardLayer);
    };
    const scheduleDragGeometry = () => {
      if (geometryFrame || typeof requestAnimationFrame !== 'function') {
        if (typeof requestAnimationFrame !== 'function') refreshDragGeometry();
        return;
      }
      geometryFrame = requestAnimationFrame(refreshDragGeometry);
    };
    const move = moveEvent => {
      const rawX = moveEvent.clientX - boardRect.left - offsetX;
      const rawY = moveEvent.clientY - boardRect.top - offsetY;
      // A footage card mounted in its scene-local layer owns that whole layer:
      // its own box is the only bound. Deriving bounds from the surrounding
      // Footage section instead used to cost the card the section's padding
      // plus an extra inset, and a section edge measured against the layer
      // could clamp the card well inside the lane it is supposed to roam.
      const footageLayerDrag = node.type === 'footage'
        && dragRoot.classList.contains('storyboard-act-board-scene-footage-node-layer');
      // Dragging past the bottom of the lane extends it instead of stopping
      // the card, so the reachable area is not capped at the lane height the
      // drag started with.
      if (footageLayerDrag) growActBoardFootageLaneToFit(dragRoot, rawY + card.offsetHeight);
      // Re-measure the active Footage lane on every move. Scene expansion can
      // grow the lane while a card is being dragged; a bound captured at
      // pointerdown would leave the card trapped in its original row.
      const currentRootRect = dragRoot.getBoundingClientRect();
      const footageSectionRect = node.type === 'footage' && !footageLayerDrag
        ? card.closest('.storyboard-act-board-scene-section-footage')?.getBoundingClientRect?.()
        : null;
      const footageBounds = footageSectionRect ? (() => {
        const rootWidth = currentRootRect.width || footageSectionRect.width;
        const rootHeight = currentRootRect.height || footageSectionRect.height;
        const minX = Math.max(0, footageSectionRect.left - currentRootRect.left);
        const minY = Math.max(0, footageSectionRect.top - currentRootRect.top);
        const maxX = Math.max(minX, Math.min(rootWidth,
          footageSectionRect.right - currentRootRect.left) - card.offsetWidth - 8);
        const maxY = Math.max(minY, Math.min(rootHeight,
          footageSectionRect.bottom - currentRootRect.top) - card.offsetHeight - 8);
        return { minX, minY, maxX, maxY };
      })() : {
        minX: 0,
        minY: 0,
        maxX: Math.max(0, currentRootRect.width - card.offsetWidth),
        maxY: Math.max(0, currentRootRect.height - card.offsetHeight),
      };
      const nextX = node.type === 'footage'
        ? Math.max(footageBounds.minX, Math.min(rawX, footageBounds.maxX))
        : Math.max(0, rawX);
      const nextY = node.type === 'footage'
        ? Math.max(footageBounds.minY, Math.min(rawY, footageBounds.maxY))
        : Math.max(0, rawY);
      card.style.left = `${nextX}px`;
      card.style.top = `${nextY}px`;
      // Marquee-selected nodes move together regardless of node type. The
      // existing connected narration/footage grouping is folded into the same
      // drag group, so audio nodes can participate without special cases.
      if (dragGroup.length) {
        const deltaX = nextX - origin.x;
        const deltaY = nextY - origin.y;
        dragGroup.forEach(({ node: childNode, card: childCard, x, y }) => {
          const childRoot = childCard.parentElement || boardLayer;
          const childX = Math.max(0, x + deltaX);
          const childY = Math.max(0, y + deltaY);
          if (childNode.type === 'footage') {
            // Same rule as the dragged card: a footage card living in its
            // scene-local layer is bounded by that layer alone.
            const childInLayer = childRoot.classList
              ?.contains('storyboard-act-board-scene-footage-node-layer');
            if (childInLayer) {
              growActBoardFootageLaneToFit(childRoot, childY + childCard.offsetHeight);
            }
            const childRect = childRoot.getBoundingClientRect();
            const childSection = childInLayer ? null
              : childCard.closest('.storyboard-act-board-scene-section-footage')
                ?.getBoundingClientRect?.();
            const childMinX = childSection
              ? Math.max(0, childSection.left - childRect.left) : 0;
            const childMinY = childSection
              ? Math.max(0, childSection.top - childRect.top) : 0;
            const childMaxX = childSection
              ? Math.max(childMinX, Math.min(childRect.width || childSection.width,
                childSection.right - childRect.left) - childCard.offsetWidth - 8)
              : Math.max(0, childRect.width - childCard.offsetWidth);
            const childMaxY = childSection
              ? Math.max(childMinY, Math.min(childRect.height || childSection.height,
                childSection.bottom - childRect.top) - childCard.offsetHeight - 8)
              : Math.max(0, childRect.height - childCard.offsetHeight);
            childCard.style.left = `${Math.max(childMinX, Math.min(childX, childMaxX))}px`;
            childCard.style.top = `${Math.max(childMinY, Math.min(childY, childMaxY))}px`;
          } else {
            childCard.style.left = `${childX}px`;
            childCard.style.top = `${childY}px`;
          }
        });
      }
      if (['footage', 'audio', 'narration'].includes(node.type)) {
        updateActBoardFootageDropHover(boardLayer, node, moveEvent.clientX, moveEvent.clientY);
        clearActBoardTrackDropPreviews();
        const trackUnderPointer = actBoardTrackAtPoint(
          moveEvent.clientX, moveEvent.clientY, node,
        );
        if (trackUnderPointer && typeof trackUnderPointer._actBoardCanDropNode === 'function'
          && trackUnderPointer._actBoardCanDropNode(node)) {
          trackUnderPointer.classList.add('drop-target');
          const ghost = trackUnderPointer._actBoardShowDropPreview?.(node, moveEvent.clientX);
          // Line the dragged card up with the ghost while the pointer is over a
          // rail, so the card reads as the segment being placed rather than
          // floating wherever it happened to be grabbed. Horizontal only - the
          // card stays in its own lane vertically.
          const ghostRect = ghost?.getBoundingClientRect?.();
          if (ghostRect?.width) {
            const centered = ghostRect.left + ghostRect.width / 2
              - currentRootRect.left - card.offsetWidth / 2;
            card.style.left = `${node.type === 'footage'
              ? Math.max(footageBounds.minX, Math.min(centered, footageBounds.maxX))
              : Math.max(0, centered)}px`;
          }
        }
      }
      // Pointer events can arrive much faster than layout can be measured.
      // Keep card movement/hover feedback immediate, but coalesce scene-bound
      // and SVG-link geometry work to one pass per animation frame.
      scheduleDragGeometry();
    };
    const finish = endEvent => {
      card.removeEventListener('pointermove', move);
      card.removeEventListener('pointerup', finish);
      card.removeEventListener('pointercancel', finish);
      card.classList.remove('dragging');
      clearActBoardTrackDropPreviews();
      if (geometryFrame && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(geometryFrame);
        geometryFrame = 0;
      }
      node.boardX = parseFloat(card.style.left) || 0;
      node.boardY = parseFloat(card.style.top) || 0;
      node.boardPositionMode = 'manual';
      if (node.type === 'footage') node.boardPositionSpace = 'footage-section';
      dragGroup.forEach(({ node: childNode, card: childCard }) => {
        childNode.boardX = parseFloat(childCard.style.left) || 0;
        childNode.boardY = parseFloat(childCard.style.top) || 0;
        childNode.boardPositionMode = 'manual';
        if (childNode.type === 'footage') childNode.boardPositionSpace = 'footage-section';
        else assignActBoardNodeToSceneAtPosition(childNode.actKey, childNode);
      });
      if (node.type !== 'footage') assignActBoardNodeToSceneAtPosition(node.actKey, node);
      else shrinkActBoardFootageLaneToFit(
        card.closest('.storyboard-act-board-scene-footage-node-layer'),
      );
      expandActBoardScenesToContainNodes(boardLayer, node.actKey);
      const currentMinHeight = parseFloat(boardLayer.style.minHeight) || 0;
      const draggedBottom = dragGroup.reduce((max, { node: childNode, card: childCard }) =>
        Math.max(max, childNode.boardY + childCard.offsetHeight), node.boardY + card.offsetHeight);
      boardLayer.style.minHeight = `${Math.max(currentMinHeight, draggedBottom + 24)}px`;
      refreshActBoardLinkPaths(boardLayer);
      try { card.releasePointerCapture(endEvent?.pointerId ?? event.pointerId); } catch (err) { /* optional */ }
      // Track placement is a timeline edit rather than a canvas-position edit.
      // Resolve it before the existing node-over-node/link drop menus, then
      // rebuild once so a previously hidden segment is mounted again.
      if (endEvent?.type === 'pointerup') {
        const droppedTrack = actBoardTrackAtPoint(
          endEvent.clientX, endEvent.clientY, node,
        );
        if (droppedTrack && typeof droppedTrack._actBoardDropNode === 'function'
          && droppedTrack._actBoardDropNode(node, endEvent.clientX)) {
          clearActBoardTrackDropPreviews();
          clearActBoardFootageDropHover(boardLayer);
          clearActBoardLinkDropHover(boardLayer);
          saveDebugSession();
          rerenderActBoard();
          return;
        }
        clearActBoardTrackDropPreviews();
      }
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
            const sourceCard = actBoardNodeCard(boardLayer, node.id);
            const targetCard = actBoardNodeCard(boardLayer, droppedNode.id);
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
  // Narration, footage, and audio cards are fixed-size/shape shells; their
  // detailed content and controls live in the full-playback panel, so there
  // is no resize affordance on these canvas shapes.
  if (node.type === 'narration' || node.type === 'audio' || node.type === 'footage') return;
  const resizeHandle = document.createElement('span');
  resizeHandle.className = 'storyboard-act-board-node-resize-handle';
  resizeHandle.setAttribute('role', 'button');
  resizeHandle.setAttribute('aria-label', 'Resize board node');
  // resizeHandle.title = 'Drag to resize this node';
  card.appendChild(resizeHandle);
  // Keep the resize affordance pinned to the visible bottom-right corner of
  // scrollable nodes while their content is being browsed or resized.
  const syncResizeHandlePosition = () => {
    if (!document.body.contains(card)) return;
    resizeHandle.style.top = `${Math.max(0,
      card.scrollTop + card.clientHeight - resizeHandle.offsetHeight - 3)}px`;
    resizeHandle.style.bottom = 'auto';
  };
  card._actBoardResizeHandleScrollHandler = syncResizeHandlePosition;
  card.addEventListener('scroll', syncResizeHandlePosition, { passive: true });
  if (typeof ResizeObserver === 'function') {
    const handleObserver = new ResizeObserver(() => {
      syncResizeHandlePosition();
      // Selecting footage can replace the upload prompt with a video/image
      // whose intrinsic dimensions settle one or more frames later. Refresh
      // the SVG endpoints after that resize so links stay anchored at the
      // actual center of the rendered cards.
      scheduleActBoardLinkPathRefresh(boardLayer);
    });
    handleObserver.observe(card);
    card._actBoardResizeHandleObserver = handleObserver;
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(syncResizeHandlePosition);
  else syncResizeHandlePosition();
  const savedWidth = Number(node.boardWidth);
  const savedHeight = Number(node.boardHeight);
  const narrationMaxWidth = node.type === 'narration' ? actBoardNarrationMaxWidth(boardLayer) : Infinity;
  if (Number.isFinite(savedWidth) && savedWidth > 0
    && (node.type !== 'audio' || node.boardWidthMode === 'manual')) {
    card.style.width = `${Math.min(savedWidth, narrationMaxWidth)}px`;
  }
  // Audio/music cards need to wrap their full set of controls (player,
  // volume, and source-window editor). Older sessions may have persisted a
  // small boardHeight from when the shared audio class constrained the card
  // itself, so never restore a fixed height for audio nodes.
  if (Number.isFinite(savedHeight) && savedHeight > 0
    && (node.type !== 'audio' || node.boardHeightMode === 'manual')
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
    // Footage cards can contain a full visual/search workflow; do not impose a
    // fixed resize ceiling on them. Other node types retain their existing
    // safety cap.
    const maxHeight = node.type === 'footage' ? Infinity : 640;
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
  // Resolve the *rendered* center first. Media can change a footage card's
  // intrinsic box (and CSS transforms can be applied while it is selected or
  // dragged), so using only the persisted left/top values can leave a path
  // behind at the card's old center. Subtracting the board rect converts the
  // viewport geometry back into the SVG's content coordinate space; include
  // the board's own scroll offset in case the stack is horizontally scrolled.
  const boardRect = boardLayer?.getBoundingClientRect?.();
  const cardRect = card?.getBoundingClientRect?.();
  if (boardRect && cardRect && Number.isFinite(cardRect.left)
    && Number.isFinite(cardRect.top)) {
    return {
      x: cardRect.left - boardRect.left + (boardLayer.scrollLeft || 0) + cardRect.width / 2,
      y: cardRect.top - boardRect.top + (boardLayer.scrollTop || 0) + cardRect.height / 2,
    };
  }
  // Before the card has a layout box (during the first synchronous render),
  // fall back to its absolute content coordinates.
  const cardX = Number.parseFloat(card.style.left);
  const cardY = Number.parseFloat(card.style.top);
  const x = Number.isFinite(cardX) ? cardX : card.offsetLeft;
  const y = Number.isFinite(cardY) ? cardY : card.offsetTop;
  const width = card.offsetWidth;
  const height = card.offsetHeight;
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  return { x: centerX, y: centerY };
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

// Media often settles over more than one layout pass (metadata, poster/image
// decode, then controls). Coalesce those notifications and refresh after a
// couple of animation frames so link endpoints follow the final rendered
// footage card rather than the transient upload-prompt dimensions.
function scheduleActBoardLinkPathRefresh(boardLayer) {
  if (!boardLayer?._actBoardLinkState || boardLayer._actBoardDestroyed
    || boardLayer._actBoardLinkRefreshScheduled) return;
  boardLayer._actBoardLinkRefreshScheduled = true;
  let frame = 0;
  const refresh = () => {
    if (boardLayer._actBoardDestroyed || !document.body.contains(boardLayer)) return;
    refreshActBoardLinkPaths(boardLayer);
    if (frame < 2 && typeof requestAnimationFrame === 'function') {
      frame += 1;
      requestAnimationFrame(refresh);
      return;
    }
    boardLayer._actBoardLinkRefreshScheduled = false;
    // A remote video can report its final dimensions just after the first
    // decode pass. One delayed pass catches that without a continuous loop.
    setTimeout(() => {
      if (!boardLayer._actBoardDestroyed && document.body.contains(boardLayer)) {
        refreshActBoardLinkPaths(boardLayer);
      }
    }, 80);
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(refresh);
  else refresh();
}

