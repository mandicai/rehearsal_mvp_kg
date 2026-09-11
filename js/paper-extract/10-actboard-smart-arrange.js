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
  const included = actBoardSceneNodes(scene, nodes);
  if (!included.length) return false;

  const cards = new Map(Array.from(nodeStack.querySelectorAll('.storyboard-act-board-node[data-node-id]'))
    .map(card => [card.dataset.nodeId, card]));
  const byId = new Map(included.map(node => [node.id, node]));
  const narrations = included.filter(node => node.type === 'narration');
  const footage = included.filter(node => node.type === 'footage');
  const audio = included.filter(node => node.type === 'audio');

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
  // The mini playback rails occupy the top of the framed scene. Reserve their
  // actual rendered height before laying out nodes so Organize never puts a
  // narration/footage/audio card underneath or on top of the tracks.
  const canvasTracks = sceneCard?.querySelector('.storyboard-act-board-canvas-playback-tracks');
  canvasTracks?._actBoardPosition?.();
  const tracksTop = Number.parseFloat(canvasTracks?.style?.top);
  const tracksBottom = canvasTracks
    ? (Number.isFinite(tracksTop) ? tracksTop : headerHeight + 2)
      + (Number(canvasTracks.offsetHeight) || 0)
    : 0;
  const paddingX = 24;
  const paddingTop = Math.max(headerHeight + 18, tracksBottom + 18);
  const rowGap = 24;
  const columnGap = 16;
  const sceneX = Math.max(0, Number(scene.boardX) || 0);
  const sceneY = Math.max(0, Number(scene.boardY) || 0);
  const dimensions = node => {
    const card = cards.get(node.id);
    const fallbackWidth = node.type === 'narration'
      ? actBoardNodeDurationWidth(node)
      : node.type === 'audio' ? Math.max(220, actBoardNodeDurationWidth(node)) : 154;
    const fallbackHeight = ACT_BOARD_NODE_STANDARD_HEIGHT;
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
  // The side narration preview is positioned outside the SVG shell. Use its
  // full rendered extent, rather than only the 140px shell height, before
  // placing footage. This mirrors the spawn layout and keeps every footage
  // card beneath the complete narration/preview readout.
  const narrationPreviewBottom = narrations.reduce((max, narration) => {
    const card = cards.get(narration.id);
    const position = actBoardNodePosition(narration, 0);
    return Math.max(max, position.y + actBoardNarrationContentHeight(narration, card));
  }, narrationRow.bottom);
  cursorY = Math.max(narrationRow.bottom, narrationPreviewBottom) + rowGap;
  // Keep the footage lane readable as the scene grows: footage cards wrap
  // into rows instead of extending one very wide strip across the board.
  const placeFootageRows = (row, y) => {
    const footageSection = sceneCard?.querySelector('.storyboard-act-board-scene-section-footage');
    const sectionWidth = Number(footageSection?.getBoundingClientRect?.().width)
      || Number(nodeStack.clientWidth) || 960;
    const rowOriginX = sceneX + paddingX;
    const rowRight = rowOriginX + Math.max(220, sectionWidth - paddingX * 2);
    let cursorX = rowOriginX;
    let cursorY = y;
    let rowHeight = 0;
    row.forEach(node => {
      const size = dimensions(node);
      if (cursorX > rowOriginX && cursorX + size.width > rowRight) {
        cursorX = rowOriginX;
        cursorY += rowHeight + rowGap;
        rowHeight = 0;
      }
      setPosition(node, cursorX, cursorY);
      cursorX += size.width + columnGap;
      rowHeight = Math.max(rowHeight, size.height);
    });
    return row.length
      ? { bottom: cursorY + rowHeight, right: cursorX - columnGap }
      : { bottom: y, right: sceneX + paddingX };
  };
  const footageRow = placeFootageRows(orderedFootage, cursorY);
  cursorY = footageRow.bottom + rowGap;
  const audioRow = placeRow(audio, cursorY);
  cursorY = audioRow.bottom + (audio.length ? rowGap : 0);
  const bottom = Math.max(narrationRow.bottom, footageRow.bottom, audioRow.bottom,
    sceneY + paddingTop) + 24;
  scene.boardHeight = Math.max(ACT_BOARD_DEFAULT_SCENE_HEIGHT,
    Number(scene.boardHeight) || 0, Math.round(bottom - sceneY));
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
  expandActBoardScenesToContainNodes(nodeStack, scene.actKey, included);
  saveDebugSession();
  return true;
}

// Arrange only the footage cards for the scene-board footage lane. This is
// intentionally independent from the general scene organizer: narration and
// audio nodes keep their current positions, timing, and relationships.
function organizeActBoardFootageNodes(scene, nodes, nodeStack) {
  if (!scene || !nodeStack) return false;
  const footage = actBoardSceneNodes(scene, nodes).filter(node => node.type === 'footage');
  if (!footage.length) return false;

  const layer = mountActBoardFootageCardsInLayer(nodeStack, scene);
  if (!layer) return false;

  const cards = new Map(Array.from(nodeStack.querySelectorAll('.storyboard-act-board-node[data-node-id]'))
    .map(card => [card.dataset.nodeId, card]));
  const padding = 12;
  const gap = 16;
  const layerRect = layer.getBoundingClientRect();
  const originX = padding;
  const originY = padding;
  const availableWidth = Math.max(220, layerRect.width - padding * 2);

  const dimensions = node => {
    const card = cards.get(node.id);
    return {
      width: Math.max(120, Number(card?.offsetWidth) || Number(node.boardWidth) || 220),
      height: Math.max(80, Number(card?.offsetHeight) || Number(node.boardHeight)
        || ACT_BOARD_NODE_STANDARD_HEIGHT),
    };
  };
  // Pack cards by their actual widths instead of imposing a fixed number of
  // columns. This keeps one continuous row as long as the next card fits in
  // the footage lane, then starts a new row at the lane's left edge.
  const rowRight = originX + availableWidth;
  let cursorX = originX;
  let cursorY = originY;
  let rowHeight = 0;
  footage.forEach((node, index) => {
    const size = dimensions(node);
    if (index > 0 && cursorX > originX && cursorX + size.width > rowRight) {
      cursorX = originX;
      cursorY += rowHeight + gap;
      rowHeight = 0;
    }
    node.boardX = Math.round(cursorX);
    node.boardY = Math.round(cursorY);
    node.boardPositionMode = 'manual';
    node.boardPositionSpace = 'footage-section';
    const card = cards.get(node.id);
    if (card) {
      card.style.left = `${node.boardX}px`;
      card.style.top = `${node.boardY}px`;
    }
    cursorX += size.width + gap;
    rowHeight = Math.max(rowHeight, size.height);
  });

  // Expand the containing frame for the moved footage only. Passing just the
  // footage set prevents the shared helper from shifting narration/audio.
  expandActBoardScenesToContainNodes(nodeStack, scene.actKey, footage);
  if (nodeStack._actBoardLinkState) refreshActBoardLinkPaths(nodeStack);
  // Keep the saved scene restore point in the same row layout as the live
  // canvas; otherwise loading the scene later could restore stale coordinates.
  syncActBoardLiveSceneSnapshots(scene);
  saveDebugSession();
  return true;
}

// Smart arrange can be superseded by a second click. One controller per scene,
// with the same identity-checked cleanup the narration analysis uses, so a
// stale run can never write a half-finished arrangement.
const actBoardArrangeAbortControllers = new Map();

// Scenes with a Smart arrange in flight. Tearing the board down clears every
// scene's loading count, which is correct only when nothing owns that veil;
// Smart arrange rerenders mid-run, so it has to declare itself the owner the
// same way a Visualize batch does or its own rerender erases its veil.
const actBoardSceneArrangeKeys = new Set();

// Ask the backend which transcript span each still-unplaced clip depicts.
// Returns a Map of nodeId -> {start, end} character offsets, or an empty Map on
// any failure: an unresolved clip is parked, which is a far better outcome than
// a clip cut to the wrong words.
async function requestActBoardFootageMatches(narrationNode, clips, signal) {
  const transcript = String(narrationNode?.transcript || '').trim();
  const empty = new Map();
  if (!transcript || !clips.length) return empty;
  const clipPayload = clips.map(node => ({
    id: node.id,
    label: String(node.fragment || '').trim(),
    query: String(node.filmabilityQuery || node.query || '').trim(),
  })).filter(clip => clip.label || clip.query);
  if (!clipPayload.length) return empty;

  // Reuse the existing 'narration' cache bucket rather than adding a kind: the
  // three bucket names are hardcoded in loadActBoardPersistentCache, and an
  // unknown kind silently no-ops.
  const cacheKey = `match|${actBoardNarrationTextHash(transcript)}|${actBoardCacheKey(
    JSON.stringify(clipPayload.map(clip => [clip.id, clip.label, clip.query])))}`;
  const cached = readActBoardPersistentCache('narration', cacheKey);
  const toMap = matches => new Map((matches || [])
    .filter(match => match && match.id)
    .map(match => [String(match.id), { start: Number(match.start), end: Number(match.end) }]));
  if (cached?.matches) return toMap(cached.matches);

  // The LLM behind this call can be slow or unreachable, and the server
  // waits out a 30s timeout and a retry before answering. An arrange must
  // not hang on that: after ACT_BOARD_FOOTAGE_MATCH_TIMEOUT_MS the clips the
  // local matcher could not place are parked and the arrange goes ahead
  // (measured: 40s per Smart arrange with the proxy down, ~1s with this).
  const localController = typeof AbortController === 'function' ? new AbortController() : null;
  const onOuterAbort = () => localController?.abort();
  signal?.addEventListener?.('abort', onOuterAbort, { once: true });
  const timer = setTimeout(() => localController?.abort(), ACT_BOARD_FOOTAGE_MATCH_TIMEOUT_MS);
  try {
    const result = await fetchFootageMatches({
      transcript,
      clips: clipPayload,
      documentaryMode: actBoardDocumentaryModeForNode(narrationNode.actKey, narrationNode),
    }, localController?.signal || signal);
    const matches = Array.isArray(result?.matches) ? result.matches : [];
    writeActBoardPersistentCache('narration', cacheKey, { matches, source: result?.source || '' });
    return toMap(matches);
  } catch (error) {
    // Only the presenter's own abort (a superseding arrange) propagates; the
    // timeout is a degraded result, not a cancelled one.
    if (error?.name === 'AbortError' && signal?.aborted) throw error;
    return empty;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onOuterAbort);
  }
}
const ACT_BOARD_FOOTAGE_MATCH_TIMEOUT_MS = 8000;

// Resolve every clip attached to one narration to a word range in its
// transcript, without touching the timeline yet. Tier 1 is an exact
// word-sequence match; tier 2 is the phrase offsets the narration already
// stores. Anything still unresolved is handed back for the backend to place.
function planActBoardFootageAlignment(narration, associated) {
  const { words, duration, timed } = actBoardTimedWordsFor(narration);
  const transcript = String(narration.transcript || '').trim();
  const offsets = actBoardPhraseOffsetsFor(narration);
  const resolved = new Map();
  const unresolved = [];
  // Each phrase is searched from the start of the transcript, not from a cursor
  // that advances with the clip list. A cursor would make the result depend on
  // the order the clips happen to be in: a clip whose phrase comes late in the
  // narration would push the cursor past an earlier phrase, and the earlier
  // clip could then never be found - which is precisely the mis-ordering Smart
  // arrange exists to repair. Occurrences already taken by another clip are
  // skipped, so a phrase repeated in the narration still gets successive ones.
  const claimed = [];
  const overlapsClaimed = hit => claimed.some(range =>
    hit.index < range.index + range.length && range.index < hit.index + hit.length);
  associated.forEach(node => {
    const phrase = String(node.fragment || '').trim();
    const phraseKey = normalizedBoardWords(phrase).join(' ');
    let range = null;
    // A montage beat spawns several shots that all carry the SAME fragment and
    // are meant to SUBDIVIDE one clause window into quick cuts. So if a sibling
    // already claimed this exact fragment's range, reuse it (share the window)
    // rather than hunting for another occurrence that does not exist - that
    // hunt would fail and park the sibling as its own full-length shot instead
    // of a quick cut. Only a genuinely different fragment skips to the next
    // occurrence to avoid stacking two different beats on one span.
    const sibling = phraseKey && claimed.find(item => item.fragment === phraseKey);
    if (sibling) {
      range = { index: sibling.index, length: sibling.length };
    } else if (words.length && phrase) {
      let hit = matchActBoardPhraseInTimedWords(words, phrase, 0);
      while (hit && overlapsClaimed(hit)) {
        hit = matchActBoardPhraseInTimedWords(words, phrase, hit.index + 1);
      }
      if (hit) {
        range = { index: hit.index, length: hit.length };
        claimed.push({ ...range, fragment: phraseKey });
      }
    }
    if (!range && transcript && phrase) {
      const saved = offsets.get(phraseKey);
      if (saved) range = actBoardWordRangeForCharRange(transcript, saved.start, saved.end);
    }
    if (range) resolved.set(node.id, range);
    else unresolved.push(node);
  });
  return { narration, associated, words, duration, timed, transcript, resolved, unresolved };
}

// Turn resolved word ranges into rail timing. Clips are ordered by where their
// phrase actually falls in the narration, then handed to the shared window rule
// so a shot runs until the next one starts - the same behaviour the narration
// aligner produces, rather than a second definition of it.
function applyActBoardFootageAlignment(plan, llmMatches) {
  const { narration, associated, words, duration, transcript, resolved } = plan;
  (llmMatches || new Map()).forEach((offsets, nodeId) => {
    if (resolved.has(nodeId)) return;
    const range = actBoardWordRangeForCharRange(transcript, offsets.start, offsets.end);
    if (range) resolved.set(nodeId, range);
  });

  const placed = associated
    .filter(node => resolved.has(node.id))
    .map(node => {
      const range = resolved.get(node.id);
      const first = words[range.index];
      const last = words[Math.min(words.length - 1, range.index + range.length - 1)];
      return {
        node,
        startSeconds: Number(first?.start) || 0,
        endSeconds: Number(last?.end) || Number(first?.start) || 0,
      };
    })
    .sort((a, b) => a.startSeconds - b.startSeconds);
  const parked = associated.filter(node => !resolved.has(node.id));

  // Several shots can illustrate one clause. They share one range, so the
  // beat windows are computed over DISTINCT ranges (otherwise the first shot
  // would take the whole clause and push its siblings into the next one), and
  // the shots sharing a window are laid consecutively across it.
  const rangeKey = item => `${item.startSeconds}:${item.endSeconds}`;
  const distinct = [];
  placed.forEach(item => {
    if (!distinct.some(row => rangeKey(row) === rangeKey(item))) {
      distinct.push({ fragment: String(item.node.fragment || ''),
        startSeconds: item.startSeconds, endSeconds: item.endSeconds });
    }
  });
  const rows = distinct;

  // Merge consecutive clause rows whose COMBINED natural span is still under
  // the floor into one shared held shot, instead of stretching each one to
  // the floor individually - that compounds fast (verified live: four ~2s
  // clauses in an 8s recording, each independently floor-stretched to 5s,
  // overran the recording by 150% by the last one - every stretch pushes the
  // next clause's own natural start later, shrinking ITS natural length,
  // demanding more stretch in turn). Only clause-kind rows merge; a
  // phrase-level beat (ACT_BOARD_HIGHLIGHT_UNIT='phrase') never merges with a
  // neighbour, since that unit predates this and has different expectations.
  const rowIsClauseKind = rows.map(row => {
    const key = `${row.startSeconds}:${row.endSeconds}`;
    const representative = placed.find(item => rangeKey(item) === key);
    return representative?.node?.footageBeatKind === 'clause';
  });
  // A montage beat is a deliberate burst of quick cuts across its OWN window;
  // it must never be folded into a neighbouring held shot by the merge below,
  // or its cuts would vanish. (A hold beat is a single sustained shot and
  // merges normally with adjacent short holds.)
  const rowIsMontage = rows.map(row => {
    const key = `${row.startSeconds}:${row.endSeconds}`;
    const representative = placed.find(item => rangeKey(item) === key);
    return representative?.node?.footageRhythm === 'montage';
  });
  const mergeGroupStart = new Array(rows.length);
  const mergeGroupEnd = new Array(rows.length);
  {
    let groupStart = 0;
    while (groupStart < rows.length) {
      let groupEnd = groupStart;
      if (rowIsClauseKind[groupStart] && !rowIsMontage[groupStart]) {
        while (
          rows[groupEnd].endSeconds - rows[groupStart].startSeconds < ACT_BOARD_MIN_SHOT_SECONDS
          && groupEnd + 1 < rows.length
          && rowIsClauseKind[groupEnd + 1]
          && !rowIsMontage[groupEnd + 1]
        ) {
          groupEnd += 1;
        }
      }
      for (let i = groupStart; i <= groupEnd; i += 1) {
        mergeGroupStart[i] = groupStart;
        mergeGroupEnd[i] = groupEnd;
      }
      groupStart = groupEnd + 1;
    }
  }

  const groupSize = new Map();
  placed.forEach(item => groupSize.set(rangeKey(item), (groupSize.get(rangeKey(item)) || 0) + 1));
  const groupSeen = new Map();
  const groupWindow = new Map();
  const narrationStart = Number(narration.startSeconds) || 0;
  let previousStart = 0;
  let cursor = 0;
  let previousFloorExtended = 0;
  // Timing of each merge group's representative shot, so a merged-away row's
  // OWN footage node - still a real alternate the presenter might prefer -
  // can share its slot instead of vanishing or keeping stale timing. It is
  // parked (hidden) there rather than shown as a second, overlapping shot.
  const representativeTiming = new Map();
  placed.forEach((item, index) => {
    const key = rangeKey(item);
    const rowIndex = distinct.findIndex(row => rangeKey(row) === key);
    const groupStartIndex = mergeGroupStart[rowIndex];
    if (groupStartIndex !== rowIndex) {
      const timing = representativeTiming.get(groupStartIndex);
      if (timing) {
        item.node.startSeconds = timing.startSeconds;
        item.node.durationSeconds = timing.durationSeconds;
      }
      item.node.trackHidden = true;
      item.node.floorExtendedSeconds = 0;
      item.node.pushedByFloorSeconds = 0;
      item.node.durationWasSuggested = false;
      item.node.alignedToNarration = true;
      item.node.timingWasManuallyAdjusted = true;
      return;
    }
    const position = groupSeen.get(key) || 0;
    groupSeen.set(key, position + 1);
    // The window is computed once per group, at its first member. previousStart
    // advances with every placed shot, so recomputing it for later members
    // would start their window at their sibling's start and re-split what was
    // left - the third of three shots landed at 7.07 instead of 6.64.
    if (!groupWindow.has(key)) {
      groupWindow.set(key,
        actBoardNarrationFootageWindow(rows, rowIndex, duration, previousStart, mergeGroupEnd[rowIndex]));
    }
    const window = groupWindow.get(key);
    const members = groupSize.get(key) || 1;
    // One shot holds until the next beat (or the end of the narration), as it
    // always has. Several shots illustrating one clause are interspersed
    // THROUGH that clause - the window closes where the clause stops being
    // spoken, not where the next beat begins - so the last clause's three
    // shots do not fan out over the rest of the recording.
    // A clause's shots end where the clause stops being spoken - one shot or
    // three. A shot that ran on until the next beat began (or, for the last
    // clause, to the end of the recording) read as far longer than the words
    // it illustrated. The gap that follows is deliberate. A MERGED group's
    // "clause" is the whole group, so this uses the group's own combined end,
    // not just this row's - otherwise the merge above would be undone here.
    const mergedEndSeconds = rows[mergeGroupEnd[rowIndex]].endSeconds;
    const endsWithSpokenSpan = members > 1 || item.node.footageBeatKind === 'clause';
    const windowEnd = endsWithSpokenSpan
      ? Math.min(window.endSeconds, Math.max(window.startSeconds, mergedEndSeconds))
      : window.endSeconds;
    // Where the words put this shot: its share of the spoken span, however
    // short. The floor is applied to the LENGTH only, so a shot that must hold
    // longer than its phrase runs on past it and bumps the next shot later
    // through `cursor` - the phrase-true start is what the next shot wants,
    // the cursor is what the previous shot's floor lets it have.
    const share = Math.max(0, (windowEnd - window.startSeconds) / members);
    const naturalStart = window.startSeconds + position * share;
    const start = Math.max(cursor, naturalStart);
    const naturalLength = Math.max(0, Math.min(share, windowEnd - naturalStart));
    // The phrase window says how long this shot COULD hold; the clip says how
    // long it actually has. Taking the shorter leaves a gap before the next
    // shot rather than looping the clip to fill it - a visible gap reads as an
    // editing decision, a repeating clip reads as a broken player. A montage
    // cut uses the shorter quick-cut floor so a burst of them fits its window.
    const shotFloor = item.node.footageRhythm === 'montage'
      ? ACT_BOARD_MONTAGE_MIN_SHOT_SECONDS : ACT_BOARD_MIN_SHOT_SECONDS;
    const length = Math.min(
      Math.max(shotFloor, naturalLength),
      actBoardFootageMaxDurationSeconds(item.node),
    );
    // Record the two sides of a floor collision so the cut planner can shape
    // it: how far this shot holds past its phrase, and how far it was pushed
    // off its phrase by the previous shot doing the same.
    item.node.floorExtendedSeconds = Number(Math.max(0, length - naturalLength).toFixed(2));
    // The whole delay from the phrase-true start: pushes accumulate down a
    // run of floored shots, so capping this at the previous shot's own
    // extension under-reported it from the third shot on.
    item.node.pushedByFloorSeconds = previousFloorExtended > 0
      && start - naturalStart > ACT_BOARD_TRACK_SEAM_TOLERANCE_SECONDS
      ? Number((start - naturalStart).toFixed(2)) : 0;
    previousFloorExtended = item.node.floorExtendedSeconds;
    item.node.sequenceIndex = index;
    item.node.startSeconds = Number((narrationStart + start).toFixed(2));
    item.node.durationSeconds = Number(length.toFixed(2));
    item.node.durationWasSuggested = false;
    item.node.alignedToNarration = true;
    // Preserve the phrase-aligned start when the scene rail is rebuilt.
    // `orderedActBoardSceneFootage` otherwise treats a non-manual shot as a
    // footage-only chain and packs it from 0, undoing the alignment.
    item.node.timingWasManuallyAdjusted = true;
    if (!representativeTiming.has(rowIndex)) {
      representativeTiming.set(rowIndex,
        { startSeconds: item.node.startSeconds, durationSeconds: item.node.durationSeconds });
    }
    previousStart = start;
    cursor = start + length;
  });
  // A clip whose phrase is nowhere in the transcript still belongs to the
  // scene - an uploaded shot, or one whose wording changed on a re-record.
  // Park it after the aligned clips in its existing order rather than dropping
  // it or cutting it to words it does not name.
  parked.forEach((node, offset) => {
    const length = Math.min(
      Math.max(ACT_BOARD_MIN_SHOT_SECONDS, Number(node.durationSeconds) || ACT_BOARD_MIN_SHOT_SECONDS),
      actBoardFootageMaxDurationSeconds(node),
    );
    node.sequenceIndex = placed.length + offset;
    node.startSeconds = Number((narrationStart + cursor).toFixed(2));
    node.durationSeconds = Number(length.toFixed(2));
    node.durationWasSuggested = false;
    node.alignedToNarration = false;
    node.floorExtendedSeconds = 0;
    node.pushedByFloorSeconds = 0;
    node.timingWasManuallyAdjusted = true;
    cursor += length;
  });
  // Shape the boundaries once every shot has its final visual timing. Parked
  // clips join the run so a cut can also land on the tail of the scene. A
  // merged-away row's node is excluded - it shares its representative's exact
  // timing (see the merge pass above), so treating it as a real neighbour
  // would corrupt the adjacency this planning assumes.
  const run = [...placed.map(item => item.node), ...parked].filter(node => !node.trackHidden);
  // Narration-relative cuts first: they move picture boundaries, and the
  // clip-audio planner below sizes its spill against the resulting durations.
  const narrationCuts = planActBoardNarrationCuts(run);
  const cuts = planActBoardAudioCuts(run, node => actBoardSelectedFootageMedia(node));
  return {
    rows, duration, placed: placed.length, parked: parked.length, cuts, narrationCuts,
  };
}

// Slide a shot boundary off the word it was aligned to, so a shot either
// anticipates its entity or lingers past it instead of landing squarely on it.
//
// This is purely a picture edit against the fixed narration: an "anticipate"
// pulls the boundary BEFORE this shot earlier, a "linger" pushes the boundary
// AFTER it later. Both neighbours are adjusted together, so the run stays
// contiguous and no clip overlaps another.
//
// The pre-cut timing is recorded on the node so removing one cut restores the
// hard cut without re-running the whole arrange.
function planActBoardNarrationCuts(placedNodes) {
  const shots = placedNodes.map(node => ({
    node,
    start: Number(node.startSeconds) || 0,
    duration: Math.max(0, Number(node.durationSeconds) || 0),
  }));
  shots.forEach(shot => {
    shot.node.narrationCutKind = '';
    shot.node.narrationCutSeconds = 0;
    shot.node.narrationCutWasSuggested = false;
    delete shot.node.hardCutStartSeconds;
    delete shot.node.hardCutDurationSeconds;
  });
  if (shots.length < 2) return [];

  const room = (a, b, seconds) =>
    a.duration - seconds >= ACT_BOARD_NARRATION_CUT_MIN_SHOT_SECONDS
    && b.duration + seconds > 0 && seconds >= ACT_BOARD_NARRATION_CUT_MIN_SECONDS;

  // Remember the hard-cut timing of every shot a boundary move touches, once.
  const remember = shot => {
    if (shot.node.hardCutStartSeconds === undefined) {
      shot.node.hardCutStartSeconds = shot.node.startSeconds;
      shot.node.hardCutDurationSeconds = shot.node.durationSeconds;
    }
  };

  const cuts = [];
  let lastIndex = -Infinity;
  let preferLinger = false;
  for (let index = 1; index < shots.length; index += 1) {
    if (index - lastIndex < ACT_BOARD_NARRATION_CUT_SPACING) continue;
    const previous = shots[index - 1];
    const shot = shots[index];
    // These shots are ordered by when their phrase is spoken, but
    // orderedActBoardSceneFootage re-enforces contiguity in CHAIN order and
    // snaps back anything that starts before its chain predecessor's end.
    // When the two orders disagree, the neighbour whose duration this cut
    // shortens is not the one the repack measures against, and the cut is
    // silently undone while its rail marker survives - a marker claiming a
    // transition that is not there. Only shape a boundary both passes agree on.
    const chainAdjacent = String(previous.node.nextFootageNodeId || '') === String(shot.node.id)
      || String(shot.node.previousFootageNodeId || '') === String(previous.node.id)
      // An unlinked run has no chain to disagree with.
      || (!previous.node.nextFootageNodeId && !shot.node.previousFootageNodeId);
    if (!chainAdjacent) continue;
    const seconds = Number(Math.min(
      ACT_BOARD_NARRATION_CUT_MAX_SECONDS,
      Math.min(previous.duration, shot.duration) * 0.5,
    ).toFixed(2));

    // Alternate so a run does not read as all-anticipation or all-linger.
    if (!preferLinger && room(previous, shot, seconds)
      && shot.duration + seconds <= actBoardFootageMaxDurationSeconds(shot.node)) {
      // Anticipate: this shot arrives early, so the boundary before it moves
      // earlier - the previous shot gives up exactly what this one gains.
      remember(previous);
      remember(shot);
      previous.duration -= seconds;
      shot.start -= seconds;
      shot.duration += seconds;
      previous.node.durationSeconds = Number(previous.duration.toFixed(2));
      shot.node.startSeconds = Number(shot.start.toFixed(2));
      shot.node.durationSeconds = Number(shot.duration.toFixed(2));
      shot.node.narrationCutKind = 'anticipate';
      shot.node.narrationCutSeconds = seconds;
      shot.node.narrationCutWasSuggested = true;
      shot.node.narrationCutNeighbourId = previous.node.id;
      cuts.push({ kind: 'anticipate', nodeId: shot.node.id, seconds });
      lastIndex = index;
      preferLinger = true;
    } else if (room(shot, previous, seconds)
      && previous.duration + seconds <= actBoardFootageMaxDurationSeconds(previous.node)) {
      // Linger: the PREVIOUS shot holds past its own entity, so the boundary
      // moves later and this shot starts late and is correspondingly shorter.
      remember(previous);
      remember(shot);
      previous.duration += seconds;
      shot.start += seconds;
      shot.duration -= seconds;
      previous.node.durationSeconds = Number(previous.duration.toFixed(2));
      shot.node.startSeconds = Number(shot.start.toFixed(2));
      shot.node.durationSeconds = Number(shot.duration.toFixed(2));
      previous.node.narrationCutKind = 'linger';
      previous.node.narrationCutSeconds = seconds;
      previous.node.narrationCutWasSuggested = true;
      previous.node.narrationCutNeighbourId = shot.node.id;
      cuts.push({ kind: 'linger', nodeId: previous.node.id, seconds });
      lastIndex = index;
      preferLinger = false;
    }
  }
  return cuts;
}

// Restore the hard cut for one narration-relative transition, leaving every
// other shot's timing alone.
function removeActBoardNarrationCut(node, neighbour) {
  [node, neighbour].forEach(item => {
    if (!item || item.hardCutStartSeconds === undefined) return;
    item.startSeconds = item.hardCutStartSeconds;
    item.durationSeconds = item.hardCutDurationSeconds;
    delete item.hardCutStartSeconds;
    delete item.hardCutDurationSeconds;
  });
  if (!node) return;
  node.narrationCutKind = '';
  node.narrationCutSeconds = 0;
  node.narrationCutWasSuggested = false;
  delete node.narrationCutNeighbourId;
}

// Decide where a J- or L-cut earns its place along an already-timed run of
// shots, and write the audio lead/tail onto the nodes.
//
// Every cut is marked `transitionWasSuggested` so the rail can show it and the
// presenter can drop an individual one without re-running the whole arrange.
// Clearing first matters: a second arrange must not inherit cuts whose
// neighbours have since moved.
function planActBoardAudioCuts(placedNodes, mediaFor) {
  const shots = placedNodes.map(node => ({
    node,
    start: Number(node.startSeconds) || 0,
    duration: Math.max(0, Number(node.durationSeconds) || 0),
    // A cut built on silence is indistinguishable from a bug, so a clip only
    // qualifies if it genuinely carries sound. That means a real video track:
    // a still image has none, `muteAudio` only guards GENERATED video (an
    // image reports muteAudio:false while being silent), and split-screens are
    // force-muted downstream.
    hasAudio: (mediaVisual => Boolean(mediaVisual?.url)
      && mediaVisual.kind === 'video'
      && mediaVisual.muteAudio !== true)(mediaFor(node))
      && node.compositionMode !== 'split-screen',
  }));
  shots.forEach(shot => {
    shot.node.audioLeadSeconds = 0;
    shot.node.audioTailSeconds = 0;
    shot.node.transitionWasSuggested = false;
    shot.node.transitionKind = '';
    shot.node.transitionReason = '';
  });

  // Find every boundary that COULD carry a cut first, then choose among them.
  // Deciding inline biased the result badly: in the common alternating pattern
  // (sound, still, sound, still) every J-cut boundary sits immediately after
  // an L-cut boundary, so a running spacing counter silently produced L-cuts
  // only and no J-cuts at all.
  const eligible = [];
  for (let index = 0; index < shots.length - 1; index += 1) {
    const outgoing = shots[index];
    const incoming = shots[index + 1];
    // Silence on both sides has nothing to carry across. Sound on both sides
    // is a crossfade: the outgoing tail fades out while the incoming lead
    // fades in, which the fades make safe (before them, two ambiences at full
    // level on top of each other was the reason both-loud was skipped - and
    // since stock clips all carry audio, that skip meant no J/L at all).
    if (!outgoing.hasAudio && !incoming.hasAudio) continue;
    const room = Math.min(outgoing.duration, incoming.duration)
      * ACT_BOARD_AUDIO_CUT_MAX_SHOT_SHARE;
    const seconds = Math.min(ACT_BOARD_AUDIO_CUT_MAX_SECONDS, room);
    if (seconds < ACT_BOARD_AUDIO_CUT_MIN_SECONDS) continue;
    eligible.push({
      index,
      outgoing,
      incoming,
      seconds: Number(seconds.toFixed(2)),
      kind: outgoing.hasAudio && incoming.hasAudio ? 'crossfade'
        : (incoming.hasAudio ? 'j-cut' : 'l-cut'),
    });
  }

  const cuts = [];
  let lastIndex = -Infinity;
  let lastKind = '';
  // A boundary where the outgoing shot held its floor and pushed the incoming
  // picture off its phrase is not a place to sprinkle: the delay wants
  // covering. Carry the outgoing sound across it as an L-cut whenever that
  // shot has sound to carry; these are chosen before the spacing rules and
  // count towards them. A silent outgoing shot (a still) has nothing to
  // bleed, so its boundary is left to the ordinary selection below.
  const forced = new Set();
  for (let index = 0; index < shots.length - 1; index += 1) {
    const outgoing = shots[index];
    const incoming = shots[index + 1];
    if (!(Number(incoming.node.pushedByFloorSeconds) > 0) || !outgoing.hasAudio) continue;
    const room = Math.min(outgoing.duration, incoming.duration)
      * ACT_BOARD_AUDIO_CUT_MAX_SHOT_SHARE;
    // Cover at least the delay, within the usual bounds.
    const seconds = Number(Math.max(ACT_BOARD_AUDIO_CUT_MIN_SECONDS,
      Math.min(ACT_BOARD_AUDIO_CUT_MAX_SECONDS, room,
        Math.max(ACT_BOARD_AUDIO_CUT_MIN_SECONDS, Number(incoming.node.pushedByFloorSeconds)))).toFixed(2));
    outgoing.node.audioTailSeconds = seconds;
    outgoing.node.transitionWasSuggested = true;
    outgoing.node.transitionKind = 'l-cut';
    outgoing.node.transitionReason = 'floor';
    cuts.push({ kind: 'l-cut', nodeId: outgoing.node.id, seconds, reason: 'floor' });
    forced.add(index);
  }
  eligible.forEach((candidate, position) => {
    if (forced.has(candidate.index)) return;
    const nearestForced = [...forced].reduce((best, index) =>
      Math.min(best, Math.abs(index - candidate.index)), Infinity);
    if (nearestForced < ACT_BOARD_AUDIO_CUT_SPACING) return;
    if (candidate.index - lastIndex < ACT_BOARD_AUDIO_CUT_SPACING) return;
    // Two of the same cut in a row reads as a tic rather than a choice. When
    // the very next candidate offers the other kind at no real cost, let it
    // have this slot instead.
    const next = eligible[position + 1];
    if (candidate.kind === lastKind && next && next.kind !== lastKind
      && next.index - lastIndex >= ACT_BOARD_AUDIO_CUT_SPACING) return;

    if (candidate.kind === 'crossfade') {
      // Both sides: an L tail on the outgoing clip and a J lead on the
      // incoming one over the same span; the two layers ramp against each
      // other. Each node carries its half, so the rail shows both markers and
      // either can be removed on its own.
      candidate.outgoing.node.audioTailSeconds = candidate.seconds;
      candidate.outgoing.node.transitionWasSuggested = true;
      candidate.outgoing.node.transitionKind = 'l-cut';
      candidate.incoming.node.audioLeadSeconds = candidate.seconds;
      candidate.incoming.node.transitionWasSuggested = true;
      candidate.incoming.node.transitionKind = candidate.incoming.node.transitionKind === 'l-cut'
        ? 'l-cut' : 'j-cut';
      cuts.push({ kind: 'crossfade', nodeId: candidate.incoming.node.id, seconds: candidate.seconds });
    } else if (candidate.kind === 'j-cut') {
      // J-cut: pull the incoming clip's sound back under the outgoing picture.
      candidate.incoming.node.audioLeadSeconds = candidate.seconds;
      candidate.incoming.node.transitionWasSuggested = true;
      candidate.incoming.node.transitionKind = 'j-cut';
      cuts.push({ kind: 'j-cut', nodeId: candidate.incoming.node.id, seconds: candidate.seconds });
    } else {
      // L-cut: let the outgoing clip's sound run under the incoming picture.
      candidate.outgoing.node.audioTailSeconds = candidate.seconds;
      candidate.outgoing.node.transitionWasSuggested = true;
      candidate.outgoing.node.transitionKind = 'l-cut';
      cuts.push({ kind: 'l-cut', nodeId: candidate.outgoing.node.id, seconds: candidate.seconds });
    }
    lastIndex = candidate.index;
    lastKind = candidate.kind;
  });
  return cuts;
}

// Run Smart arrange with its veil, abort handling and floor. Shared by the
// scene's Smart arrange button and by Visualize highlights, which arranges
// automatically once its cards are mounted so a presenter does not have to
// press two buttons to get footage onto the rail in the right places.
// `shownAt`: when chained behind another veil (Visualize highlights), reuse
// that veil's start so the readable-floor is shared rather than served twice.
function runActBoardSmartArrange(scene, liveNodes, nodeStack, { shownAt = null } = {}) {
  if (!scene || !nodeStack) return Promise.resolve(false);
  const actKey = scene.actKey;
  const sceneId = scene.id;
  // A second run supersedes the first. Same identity-checked cleanup as the
  // narration analysis, so the older run cannot clear the veil or write a
  // partial arrangement after the newer one has started.
  actBoardArrangeAbortControllers.get(sceneId)?.abort?.();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  actBoardArrangeAbortControllers.set(sceneId, controller);
  const floorStart = Number(shownAt) || Date.now();
  const loadingKey = `${actKey}:${sceneId}`;
  actBoardSceneArrangeKeys.add(loadingKey);
  setActBoardSceneLoading(actKey, sceneId, true, 'Syncing footage to the narration…');
  return smartArrangeActBoardScene(scene, liveNodes, nodeStack, controller?.signal)
    .catch(error => {
      if (error?.name !== 'AbortError') {
        setActBoardSceneLoadingMessage(sceneId, 'Could not sync footage to the narration.');
      }
      return false;
    })
    .finally(async () => {
      // The veil is reference-counted, and this run took exactly one hold on
      // it, so it must always release exactly one - a superseded run that
      // simply returned here would leave the veil up forever.
      if (actBoardArrangeAbortControllers.get(sceneId) !== controller) {
        setActBoardSceneLoading(actKey, sceneId, false);
        return;
      }
      actBoardArrangeAbortControllers.delete(sceneId);
      // The arrange rerenders the board mid-run; the loading count survives
      // that (see teardownActBoardView) and refreshActBoardDomRegistry
      // re-attaches the veil to the new scene card, so there is nothing to
      // re-assert here - only the floor to wait out.
      await waitForActBoardSceneLoadingFloor(floorStart);
      actBoardSceneArrangeKeys.delete(loadingKey);
      setActBoardSceneLoading(actKey, sceneId, false);
    });
}

// Arrange a scene's timeline rails against its narration rather than against
// the current canvas positions. Narration phrase timings are the source of
// truth for footage; sound nodes follow their linked target when a legacy link
// exists, otherwise they snap to a matching phrase when one can be found.
// Smart arrange is an explicit timing action, so it may replace stale/manual
// segment positions while leaving every node's spatial canvas coordinates
// untouched.
async function smartArrangeActBoardScene(scene, nodes, nodeStack, signal = null) {
  if (!scene || !nodeStack) return false;
  const included = actBoardSceneNodes(scene, nodes);
  if (!included.length) return false;

  const narrations = included.filter(node => node.type === 'narration');
  const footage = included.filter(node => node.type === 'footage');
  const audio = included.filter(node => node.type === 'audio');
  const byId = new Map(included.map(node => [node.id, node]));

  // Track rails derive their entries from scene membership. A scene restored
  // from an older snapshot can have valid live nodes without those ids being
  // recorded on the scene itself, which made Smart arrange appear to do
  // nothing: timing changed in memory, but there was no rail entry to show it.
  // Canonicalize membership before arranging so the canvas and playback rails
  // consume the exact same node set.
  scene.hidden = false;
  scene.liveNodesCleared = false;
  scene.nodeIds = Array.from(new Set([
    ...(scene.nodeIds || []),
    ...included.map(node => node.id),
  ].filter(Boolean)));
  const liveSceneNodes = actBoardNodesForAct(scene.actKey);
  included.forEach(node => {
    if (!node || liveSceneNodes.some(candidate => candidate.id === node.id)) return;
    // A scene card can be rendered from snapshots while its live node array
    // is empty (for example after switching scenes). Rehydrate that node into
    // the live pool before rebuilding tracks so Smart arrange is visible.
    node.actKey = scene.actKey;
    node.sceneId = scene.id;
    liveSceneNodes.push(node);
  });
  included.forEach(node => {
    if (node.sceneId !== scene.id) node.sceneId = scene.id;
  });
  const existingPlaybackSnapshots = (Array.isArray(scene.nodeSnapshots)
    ? scene.nodeSnapshots : []).filter(snapshot => snapshot?.type === 'playback');
  scene.nodeSnapshots = [
    ...included.map(snapshotActBoardSceneNode).filter(Boolean),
    ...existingPlaybackSnapshots.filter(snapshot =>
      !included.some(node => node.id === snapshot.id)),
  ];
  if (footage.length && !footage.some(node => node.id === scene.sequenceStartNodeId)) {
    scene.sequenceStartNodeId = footage.slice().sort((a, b) =>
      (Number(a.startSeconds) || 0) - (Number(b.startSeconds) || 0))[0].id;
  }
  // Smart arrange is an explicit timeline action, so normalize the existing
  // narration segments into one contiguous sequence. This intentionally
  // changes only track timing/order; node canvas coordinates remain untouched.
  const orderedNarrations = narrations.slice().sort((a, b) => {
    const aSequence = Number(a.sequenceIndex);
    const bSequence = Number(b.sequenceIndex);
    if (Number.isFinite(aSequence) && Number.isFinite(bSequence)
      && aSequence !== bSequence) return aSequence - bSequence;
    return (Number(a.startSeconds) || 0) - (Number(b.startSeconds) || 0);
  });
  const hasNarrationChain = orderedNarrations.some(node =>
    node.previousNarrationNodeId || node.nextNarrationNodeId);
  let narrationCursor = 0;
  orderedNarrations.forEach((node, index) => {
    const duration = Math.max(0.5,
      actBoardNarrationSegmentDuration(node)
        || Number(node.durationSeconds)
        || estimateActBoardNarrationSeconds(node.transcript || node.text));
    node.sequenceIndex = index;
    node.startSeconds = Number(narrationCursor.toFixed(2));
    node.narrationSegmentDurationSeconds = Number(duration.toFixed(2));
    if (!(node.footageNodeIds || []).length) node.durationSeconds = Number(duration.toFixed(2));
    if (hasNarrationChain) {
      node.previousNarrationNodeId = orderedNarrations[index - 1]?.id || null;
      node.nextNarrationNodeId = orderedNarrations[index + 1]?.id || null;
    }
    narrationCursor += duration;
    // A deliberate silence between spoken segments, not a mistake to close up
    // - the cross-segment footage-extension pass below fills it by holding
    // the first segment's last shot, so the picture never goes black.
    if (index < orderedNarrations.length - 1) narrationCursor += ACT_BOARD_NARRATION_SEGMENT_GAP_SECONDS;
  });
  const normalizePhrase = value => normalizedBoardWords(value).join(' ');
  const phraseScore = (query, phrase) => {
    const queryWords = new Set(normalizedBoardWords(query));
    const phraseWords = normalizedBoardWords(phrase);
    if (!queryWords.size || !phraseWords.length) return 0;
    return phraseWords.filter(word => queryWords.has(word)).length / queryWords.size;
  };
  const rowForPhrase = (rows, phrase) => {
    const exact = normalizePhrase(phrase);
    if (!exact) return null;
    return rows.find(row => normalizePhrase(row.fragment) === exact)
      || rows.reduce((best, row) => phraseScore(phrase, row.fragment)
        > (best ? phraseScore(phrase, best.fragment) : 0) ? row : best, null);
  };
  const rowWindow = (rows, index, duration, previousStart = 0) => {
    const current = rows[index];
    const requestedStart = index === 0 ? 0 : Number(current?.startSeconds);
    const start = Math.max(previousStart,
      Number.isFinite(requestedStart) ? requestedStart : previousStart);
    const next = rows.slice(index + 1).find(item =>
      Number.isFinite(Number(item?.startSeconds)));
    const end = Math.max(start,
      Number.isFinite(Number(next?.startSeconds)) ? Number(next.startSeconds) : duration);
    return { start, end: Math.max(start + 0.5, end) };
  };

  // Old-highlight cleanup. A footage node anchored to a narration whose
  // CURRENT transcript no longer contains that node's fragment (the presenter
  // edited or replaced that highlight, so the words it illustrated are gone)
  // leaves the TRACK but stays on the board: its segment is removed, the node
  // itself is not. This is what makes re-Visualizing / re-arranging after a
  // highlight edit refresh the rail - dropping the stale shots and placing the
  // new ones - without discarding footage the presenter may still want to
  // reuse. Independent, merged, and split-screen footage (no narration parent,
  // or a combined prompt rather than a transcript phrase) is never touched;
  // neither is a narration that has no transcript yet, since orphanhood can't
  // be judged without one.
  narrations.forEach(narration => {
    const transcript = String(narration.transcript || '').trim();
    if (!transcript) return;
    const transcriptNormalized = ` ${normalizePhrase(transcript)} `;
    footage.forEach(node => {
      const belongs = node.narrationNodeId === narration.id
        || (narration.footageNodeIds || []).includes(node.id);
      if (!belongs || node.trackHidden) return;
      const fragmentNormalized = normalizePhrase(node.fragment || '');
      if (fragmentNormalized && !transcriptNormalized.includes(` ${fragmentNormalized} `)) {
        node.trackHidden = true;
        persistActBoardTrackNode(node);
      }
    });
  });

  // Resolve every clip to a position in its narration's transcript before
  // touching the timeline, so a clip's start comes from when its phrase is
  // actually spoken rather than from its position in a list.
  const assignedFootage = new Set();
  const associatedByNarration = new Map();
  const plans = narrations.map(narration => {
    // Alternates parked off the rail (trackHidden) keep whatever timing they
    // have; arranging them would stack several shots on one clause.
    const associated = footage.filter(node => actBoardTrackNodeVisible(node)
      && (node.narrationNodeId === narration.id
        || (narration.footageNodeIds || []).includes(node.id)))
      .sort((a, b) => (Number(a.sequenceIndex) || 0) - (Number(b.sequenceIndex) || 0)
        || (Number(a.startSeconds) || 0) - (Number(b.startSeconds) || 0));
    associated.forEach(node => assignedFootage.add(node.id));
    associatedByNarration.set(narration.id, associated);
    return planActBoardFootageAlignment(narration, associated);
  });

  // Only the clips that exact matching could not place reach the backend, so a
  // scene whose footage came from its own highlights makes no request at all.
  // One call per transcript; several narrations resolve concurrently.
  const llmByNarration = new Map();
  await Promise.all(plans
    .filter(plan => plan.unresolved.length && plan.transcript)
    .map(async plan => {
      llmByNarration.set(plan.narration.id,
        await requestActBoardFootageMatches(plan.narration, plan.unresolved, signal));
    }));

  const narrationRows = new Map();
  let alignedClipCount = 0;
  let parkedClipCount = 0;
  // Report on whether the narration actually carried word timings, not on
  // whether clips happened to land. A scene with no recording placed nothing,
  // and calling that result "transcription timestamps" would be a plain
  // falsehood about where its footage came from.
  let anyEstimatedTiming = !plans.length;
  plans.forEach(plan => {
    const applied = applyActBoardFootageAlignment(plan, llmByNarration.get(plan.narration.id));
    narrationRows.set(plan.narration.id, { duration: applied.duration, rows: applied.rows });
    alignedClipCount += applied.placed;
    parkedClipCount += applied.parked;
    if (!plan.timed) anyEstimatedTiming = true;
  });
  // A deliberate gap sits between consecutive narration segments (see the
  // packing loop above) - fill it by holding the first segment's last shot
  // through it, then cut into the second segment's own first shot slightly
  // AFTER its narration has already started speaking, rather than exactly on
  // the silence-to-speech boundary, which reads as a harder, more mechanical
  // cut. This is a picture-only timing shift, not a J-cut in this file's
  // sense (see ACT_BOARD_AUDIO_CUT_MIN_SECONDS above) - no clip's own audio
  // is moved, only startSeconds/durationSeconds.
  // applyActBoardFootageAlignment re-sorts its OWN internal `placed` list by
  // each shot's actual matched-phrase time, but `associated` (what we
  // captured above) keeps its pre-alignment array order - so "last/first
  // element of associated" is not reliably "last/first by final timing".
  // Pick by the real, post-alignment startSeconds/end instead.
  const latestByEnd = list => list.reduce((best, node) => {
    const end = (Number(node.startSeconds) || 0) + (Number(node.durationSeconds) || 0);
    const bestEnd = best ? (Number(best.startSeconds) || 0) + (Number(best.durationSeconds) || 0) : -Infinity;
    return end > bestEnd ? node : best;
  }, null);
  const earliestByStart = list => list.reduce((best, node) =>
    (!best || (Number(node.startSeconds) || 0) < (Number(best.startSeconds) || 0)) ? node : best, null);
  for (let i = 0; i < orderedNarrations.length - 1; i += 1) {
    const narrationA = orderedNarrations[i];
    const narrationB = orderedNarrations[i + 1];
    const footageOfA = associatedByNarration.get(narrationA.id) || [];
    const footageOfB = associatedByNarration.get(narrationB.id) || [];
    const lastOfA = latestByEnd(footageOfA);
    const firstOfB = earliestByStart(footageOfB);
    if (!lastOfA || !firstOfB || lastOfA === firstOfB) continue;
    // Never eat into firstOfB below the shot floor to make room for the
    // overlap - a short second segment simply gets a hard cut instead.
    const overlapSeconds = Math.max(0, Math.min(
      ACT_BOARD_SEGMENT_GAP_OVERLAP_SECONDS,
      (Number(firstOfB.durationSeconds) || 0) - ACT_BOARD_MIN_SHOT_SECONDS,
    ));
    const holdEndSeconds = Number(narrationB.startSeconds) + overlapSeconds;
    const extendedDuration = holdEndSeconds - (Number(lastOfA.startSeconds) || 0);
    if (extendedDuration > (Number(lastOfA.durationSeconds) || 0)) {
      lastOfA.durationSeconds = Number(extendedDuration.toFixed(2));
      lastOfA.durationWasSuggested = false;
    }
    if (overlapSeconds > 0) {
      // firstOfB's own END time is unchanged (start moves later by exactly
      // as much as duration shrinks), so nothing after it on segment B's
      // rail needs re-timing. Picture timing only - no clip's own audio
      // moves, so this intentionally does not touch transitionKind/
      // audioLeadSeconds or anything else the J/L-cut audio system reads.
      firstOfB.startSeconds = Number(holdEndSeconds.toFixed(2));
      firstOfB.durationSeconds = Number((Number(firstOfB.durationSeconds) - overlapSeconds).toFixed(2));
      firstOfB.durationWasSuggested = false;
    }
  }
  narrations.forEach(narration => {
    if (narrationRows.has(narration.id)) return;
    narrationRows.set(narration.id, {
      duration: actBoardTimedWordsFor(narration).duration,
      rows: [],
    });
  });

  // Footage without a narration parent remains independent, but is normalized
  // to a contiguous sequence in its current track order. This gives footage
  // added without a narration anchor a useful rail arrangement too.
  let independentFootageCursor = 0;
  footage.filter(node => !assignedFootage.has(node.id) && actBoardTrackNodeVisible(node))
    .slice().sort((a, b) => (Number(a.sequenceIndex) || 0) - (Number(b.sequenceIndex) || 0)
      || (Number(a.startSeconds) || 0) - (Number(b.startSeconds) || 0))
    .forEach((node, index) => {
      const duration = Math.max(0.5, Number(node.durationSeconds) || 0.5);
      node.sequenceIndex = index;
      node.startSeconds = Number(independentFootageCursor.toFixed(2));
      node.durationSeconds = Number(duration.toFixed(2));
      node.timingWasManuallyAdjusted = false;
      independentFootageCursor += duration;
  });

  const targetForAudio = node => {
    const target = node.linkedToNodeId ? byId.get(node.linkedToNodeId) : null;
    return target || null;
  };
  let audioCursor = 0;
  const orderedAudio = audio.slice().sort((a, b) =>
    (Number(a.sequenceIndex) || 0) - (Number(b.sequenceIndex) || 0)
      || (Number(a.startSeconds) || 0) - (Number(b.startSeconds) || 0));
  orderedAudio.forEach((node, audioIndex) => {
    node.sequenceIndex = audioIndex;
    const target = targetForAudio(node);
    if (target) {
      node.startSeconds = Math.max(0, Number(target.startSeconds) || 0);
      node.durationSeconds = Math.max(0.25,
        Number(target.durationSeconds) || actBoardNarrationSegmentDuration(target) || 0.25);
      node.timingWasManuallyAdjusted = false;
    } else {
      let best = null;
      narrations.forEach(narration => {
        const rowsData = narrationRows.get(narration.id);
        const query = node.query || node.fragment || node.audioName || '';
        const row = rowForPhrase(rowsData.rows, query);
        if (!row) return;
        const score = phraseScore(query, row.fragment);
        if (!best || score > best.score) best = { narration, row, score };
      });
      if (best && best.score >= 0.35) {
        const rows = narrationRows.get(best.narration.id).rows;
        const index = rows.indexOf(best.row);
        const window = rowWindow(rows, index, narrationRows.get(best.narration.id).duration);
        node.startSeconds = Number(((Number(best.narration.startSeconds) || 0) + window.start).toFixed(2));
      } else {
        // An unanchored sound is still useful: place it after the previous
        // unanchored sound instead of leaving it at an arbitrary/stale time.
        node.startSeconds = Number(audioCursor.toFixed(2));
      }
      node.durationSeconds = Math.max(0.25, Number(node.durationSeconds) || 0.25);
      node.timingWasManuallyAdjusted = false;
    }
    audioCursor = Math.max(audioCursor,
      (Number(node.startSeconds) || 0) + Math.max(0.25, Number(node.durationSeconds) || 0.25));
  });

  // Do not call organizeActBoardSceneNodes here. Smart arrange is a timeline
  // operation only; moving canvas cards or expanding the scene frame makes it
  // appear as though the action merely changed the board height.
  // An arrangement built from word timestamps and one built from a word-count
  // estimate look identical on the rail, so record which this was. The scene's
  // narration already carries the same distinction in `alignmentSource`.
  scene.lastArrangeSummary = {
    alignedClips: alignedClipCount,
    parkedClips: parkedClipCount,
    alignmentSource: anyEstimatedTiming
      ? 'estimated from transcript duration' : 'transcription timestamps',
  };
  syncActBoardLiveSceneSnapshots(scene);
  saveDebugSession();
  // A scene patch, not a full-board rebuild: the arrange only changed this
  // scene's timing and membership, and the patch already rebuilds its rails
  // and (via the panel hook) the Scene play transport. The full rerender was
  // most of the stutter the rapid-Visualize stress simulation measured now
  // that Visualize arranges automatically. queueActBoardScenePatch falls back
  // to the full rerender itself when the incremental path is unavailable.
  queueActBoardScenePatch(scene.actKey, scene.id, { persist: true });
  const panelNodeId = actBoardFullPlaybackPanel?.dataset?.selectedNodeId;
  const panelNode = panelNodeId && actBoardSceneNodes(scene, actBoardNodesForAct(scene.actKey))
    .find(node => node.id === panelNodeId);
  if (panelNode) refreshActBoardNodeContentPanel(scene.actKey, panelNode);
  return true;
}

