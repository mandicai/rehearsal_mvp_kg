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
  // Replace only the conflicting sides of the edge. Keep source.previous and
  // target.next intact so extending A → B with B → C preserves A → B. The old
  // implementation detached both sides of both endpoints, which silently
  // broke the first link whenever a third footage node was added.
  const oldNext = nodes.find(node => node.id === source.nextFootageNodeId);
  const oldPrevious = nodes.find(node => node.id === target.previousFootageNodeId);
  if (oldNext && oldNext.id !== target.id && oldNext.previousFootageNodeId === source.id) {
    oldNext.previousFootageNodeId = null;
  }
  if (oldPrevious && oldPrevious.id !== source.id && oldPrevious.nextFootageNodeId === target.id) {
    oldPrevious.nextFootageNodeId = null;
  }
  source.nextFootageNodeId = target.id;
  target.previousFootageNodeId = source.id;
  return true;
}

function unlinkActBoardFootageNode(actKey, footageNode) {
  const nodes = actBoardNodesForAct(actKey);
  clearActBoardDirectFootageLink(nodes, footageNode);
  const parent = nodes.find(item => item.type === 'narration'
    && Array.isArray(item.footageNodeIds)
    && item.footageNodeIds.includes(footageNode.id));
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
  const selectedKey = String(node.selectedVisualKey || '');
  const generatedIndex = selectedKey.startsWith('generated-')
    ? Number(selectedKey.slice('generated-'.length))
    : selectedKey ? -1 : Number(node.selectedGeneratedIndex);
  const resultIndex = selectedKey.startsWith('result-')
    ? Number(selectedKey.slice('result-'.length))
    : selectedKey ? -1 : Number(node.selectedResultIndex);
  const generated = Number.isInteger(generatedIndex) && Array.isArray(node.generatedOptions)
    ? node.generatedOptions[generatedIndex] : null;
  const result = Number.isInteger(resultIndex) && Array.isArray(node.results)
    ? node.results[resultIndex] : null;
  // Generated visuals retain the exact specific phrase that created them. Use
  // that phrase for captions and drop/merge labels, even if the node's
  // editable phrase has since changed. Stock results, on the other hand,
  // should be identified by the query that produced them rather than by the
  // narration fragment that happened to seed the search.
  if (generated) {
    return String(generated.specificPhrase || node.imageGenerationPhrase
      || node.specificPhrase || node.fragment || generated.label || 'footage').trim();
  }
  if (result) {
    return String(result.searchPhrase || result.search_phrase || result.query
      || node.query || node.filmabilityQuery || node.fragment
      || result.source || 'footage').trim();
  }
  // An uploaded visual is neither a stock search result nor an AI-generated
  // visual. Do not leak a stale search query into its banner after the user
  // switches the node back to their own upload.
  if (selectedKey === 'upload') {
    return String(node.uploadLabel || node.fragment || 'footage').trim();
  }
  // A search can be in flight before its first result is selected. Showing
  // the current query keeps the card/node label truthful during that state;
  // otherwise retain the original fragment for an unsearched/upload card.
  return String(node.query || node.filmabilityQuery || node.fragment
    || node.imageGenerationPhrase || 'footage').trim();
}

// Build the two compact rows shown over a footage node's preview. The first
// row is the narration phrase that anchored the card; the second row names
// the selected visual by its specific AI phrase or the stock-search query.
// Uploaded media is presenter-owned, so its upload label is shown by itself.
function actBoardFootageNodeTitleParts(actKey, node) {
  if (!node) return { hasTitle: false, uploaded: false, narration: '', detail: '' };
  const visual = actBoardVisualForKey(node, node.selectedVisualKey);
  const selectedKey = String(node.selectedVisualKey || '');
  const isUploaded = visual?.key === 'upload'
    || selectedKey === 'upload'
    || (node.mediaOrigin === 'upload' && node.mediaUrl);
  if (isUploaded) {
    const uploadLabel = String(node.uploadLabel || '').trim();
    return {
      hasTitle: Boolean(uploadLabel),
      uploaded: true,
      narration: '',
      detail: uploadLabel,
    };
  }
  const narrationAnchor = actBoardNarrationForNode(actKey, node);
  const fragment = String(node.fragment || '').trim();
  // 'new footage idea' is the placeholder a blank card carries, not a phrase.
  const phrase = fragment.toLocaleLowerCase() === 'new footage idea' ? '' : fragment;
  const detail = actBoardVisualDisplayPhrase(node, visual)
    || String(node.query || node.filmabilityQuery || phrase).trim();
  // A pasted card, or one spawned by double-clicking the canvas, has no
  // narration parent - but it still carries the phrase it depicts. Gating the
  // whole title on the anchor hid that phrase entirely on those cards. The
  // anchor governs the "Narration:" row, not whether there is a label at all.
  if (!narrationAnchor || !phrase) {
    return {
      hasTitle: Boolean(detail || phrase),
      uploaded: false,
      narration: '',
      detail: detail || phrase,
    };
  }
  return {
    hasTitle: true,
    uploaded: false,
    narration: phrase,
    detail,
  };
}

// Resolve the phrase for any gallery visual, not just the currently selected
// one. Source banners use this so stock thumbnails show their actual search
// query while AI thumbnails show the specific phrase that birthed them.
function actBoardVisualDisplayPhrase(node, visual) {
  if (!node || !visual) return '';
  if (visual.key === 'upload' || visual.source === 'Uploaded by user') {
    return String(node.uploadLabel || node.fragment || '').trim();
  }
  if (visual.generatedIndex != null || visual.source === 'AI-generated') {
    const generated = Number.isInteger(Number(visual.generatedIndex))
      ? node.generatedOptions?.[Number(visual.generatedIndex)] : null;
    return String(visual.specificPhrase || generated?.specificPhrase
      || node.imageGenerationPhrase || node.fragment || '').trim();
  }
  if (visual.resultIndex != null || visual.source) {
    const result = Number.isInteger(Number(visual.resultIndex))
      ? node.results?.[Number(visual.resultIndex)] : null;
    return String(visual.searchPhrase || visual.search_phrase || visual.query
      || result?.searchPhrase || result?.search_phrase || result?.query
      || node.query || node.filmabilityQuery || node.fragment || '').trim();
  }
  return footageNodeVisualSummary(node);
}

function actBoardFootageOriginLabels(node) {
  const saved = Array.isArray(node?.combinedConceptLabels)
    ? node.combinedConceptLabels.map(label => String(label || '').trim()).filter(Boolean)
    : [];
  if (saved.length) return saved;
  const label = footageNodeVisualSummary(node);
  return label && label !== 'footage' ? [label] : [];
}

// Keep the hover-to-action delay long enough to distinguish an intentional
// drop/link insertion from briefly passing over another card or link.
const ACT_BOARD_DROP_HOVER_DELAY_MS = 750;
// Track segments can move immediately; a deliberate press-and-hold lifts the
// segment into its elevated/free-placement state for longer moves.
const ACT_BOARD_TRACK_LIFT_DELAY_MS = 1000;

// Breathing room left of a narration slide when clicking a segment scrolls it
// into view. At 0 the slide sits flush against the viewport's left edge and
// its first words read as clipped. Raise for more space before the transcript.
const ACT_BOARD_NARRATION_SCROLL_GUTTER_PX = 24;

// How long the "double-click to add a node" hint stays on the canvas. It is a
// first-run affordance, not a persistent label, so it shows once per board

// J-cut: the incoming clip's audio starts before its picture does.
// L-cut: the outgoing clip's audio keeps running after its picture is gone.
// Both are audio-only shifts - a clip's startSeconds/durationSeconds still
// describe its VISUAL, so the rail, the ordering pass and manual timing all
// keep their existing meaning.
// A cut runs 2-3s when the shots around it are long enough to carry that,
// and scales down with the shorter shot otherwise - three interspersed clause
// shots of ~1.3s cannot host a 2s transition, and a hard 2s minimum meant no
// cut was ever suggested on a clause-mode rail. The audio that crosses the
// cut fades in over a J lead and out over an L tail - see syncFootageCutLayers
// (preview) and mix_global_sound_effects (export).
const ACT_BOARD_AUDIO_CUT_MIN_SECONDS = 0.5;
const ACT_BOARD_AUDIO_CUT_MAX_SECONDS = 3.0;
// A cut may never eat more than this share of either neighbouring shot, so a
// short shot cannot be swallowed by its own transition.
const ACT_BOARD_AUDIO_CUT_MAX_SHOT_SHARE = 0.6;
// Sprinkle, don't smother: at most one shaped cut in this many boundaries.
const ACT_BOARD_AUDIO_CUT_SPACING = 2;

// Narration-relative cuts. These move the PICTURE against a fixed spoken
// track, which is the opposite of the J/L cuts above (those move audio against
// a fixed picture). Both can apply to the same run, so they are named apart on
// the rail: A/H here, J/L there.
//   anticipate - the shot arrives before its entity is spoken
//   linger     - the shot stays on screen after its entity is spoken
// Each is a single boundary between two adjacent shots sliding earlier or
// later, so the rail stays contiguous: no overlap, no gap.
const ACT_BOARD_NARRATION_CUT_MIN_SECONDS = 0.5;
const ACT_BOARD_NARRATION_CUT_MAX_SECONDS = 3.0;
// Neither neighbour may be pushed below this, or a shot vanishes to make room
// for the transition on top of it.
// Same value as the shot floor (declared below; a const cannot be read before
// its line): a picture edit may not push a shot under the floor either.
const ACT_BOARD_NARRATION_CUT_MIN_SHOT_SECONDS = 3.0;
const ACT_BOARD_NARRATION_CUT_SPACING = 2;

// Generated video is capped by the model. When a clip's real duration is not
// known yet, this is the assumption to plan against - stretching past it makes
// the clip repeat rather than hold.
const ACT_BOARD_GENERATED_VIDEO_MAX_SECONDS = 8;
// A shot shorter than this is a flash, not a shot. Every footage shot holds at
// least this long even when the phrase that suggested it is spoken faster: the
// shot then runs past its phrase and bumps the next shot later (see
// applyActBoardFootageAlignment), where an L-cut is suggested to carry the
// outgoing sound across the delayed picture.
const ACT_BOARD_MIN_SHOT_SECONDS = 3.0;
// Quick-cut floor for a montage beat (footageRhythm === 'montage' from the
// documentary footage plan). A montage is deliberately a burst of shorter
// shots, so its cuts are allowed below the general held-shot floor above.
const ACT_BOARD_MONTAGE_MIN_SHOT_SECONDS = 1.5;
// Deliberate silence between two spoken narration segments (see
// smartArrangeActBoardScene's narration-packing pass) - a beat for the
// presenter's own pacing, not a mistake to close up. The rail fills it by
// holding the first segment's last shot through it (see the cross-segment
// footage-extension pass), so the picture never goes black during the pause.
const ACT_BOARD_NARRATION_SEGMENT_GAP_SECONDS = 5.0;
// How far the second segment's own first shot is delayed past where its
// narration actually starts speaking - its voice leads its own picture in
// by this much, reading as a deliberate transition; cutting the picture
// exactly on the silence-to-speech boundary reads as mechanical. Not a J-cut
// in this file's sense (see ACT_BOARD_AUDIO_CUT_MIN_SECONDS above): no clip's
// own audio moves here, only picture timing - the narration that leads is
// already playing independently on its own track regardless of what any
// footage node does.
const ACT_BOARD_SEGMENT_GAP_OVERLAP_SECONDS = 1.0;
// Two shots meeting exactly are not overlapping. Timings are rounded to 2dp
// independently on each side of a seam, so an exact join can land a hair below
// the running cursor; without a tolerance the overlap repair below snaps it
// forward and silently erases a deliberate anticipate cut. Well under a frame
// at 30fps (0.033s), so nothing visible survives inside it.
const ACT_BOARD_TRACK_SEAM_TOLERANCE_SECONDS = 0.02;
// How long the final shot stays on screen after its own duration ends, so a
// sequence landing exactly on that boundary does not flash the placeholder
// before the transport's stop tick. Past this the stage goes to "No footage
// selected" while narration or music keeps running.
const ACT_BOARD_PLAYBACK_FINAL_HOLD_SECONDS = 0.25;

// Shared pointer interaction for narration, footage, and audio rails. A
// normal drag edits the segment's time immediately; holding for the lift
// delay switches to a visual reorder mode without continuously mutating
// persisted timing while the presenter is deciding where to drop it.
function wireActBoardTrackSegmentDrag({
  segment,
  track,
  strip,
  entry,
  entries,
  getNode,
  getStart,
  getDuration,
  getTotal,
  applyTiming,
  updateLayout,
  onCoverage,
  clearCoverage,
  onCommitReorder,
  onCommitTiming,
}) {
  if (!segment || !track || !strip || !entry || !Array.isArray(entries)) return;
  const node = getNode(entry);
  const ensureMarker = () => {
    let marker = strip.querySelector('.storyboard-act-board-track-reorder-marker');
    if (!marker) {
      marker = document.createElement('span');
      marker.className = 'storyboard-act-board-track-reorder-marker';
      marker.setAttribute('aria-hidden', 'true');
      strip.appendChild(marker);
    }
    return marker;
  };
  const clearPreview = (marker, ghost, transforms = []) => {
    marker && (marker.hidden = true);
    transforms.forEach(item => item.segment.style.removeProperty('transform'));
    ghost?.remove();
      track.classList.remove('reordering', 'reorder-valid-drop');
  };
  segment.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('.storyboard-act-board-footage-track-handle')) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = strip.getBoundingClientRect();
    if (!(rect.width > 0)) return;
    const originX = event.clientX;
    const originY = event.clientY;
    const initialStart = Math.max(0, Number(getStart(node)) || 0);
    const duration = Math.max(0.25, Number(getDuration(node)) || 1);
    let lastClientX = originX;
    let lastClientY = originY;
    let frameId = 0;
    let moved = false;
    let lifted = false;
    let liftTimer = null;
    let marker = null;
    let ghost = null;
    let transforms = [];
    let insertionIndex = entries.indexOf(entry);
    const segmentRect = segment.getBoundingClientRect();
    const grabOffsetX = Math.max(0, originX - segmentRect.left);
    const grabOffsetY = Math.max(0, originY - segmentRect.top);
    const originalState = entries.map(item => ({
      node: getNode(item), start: Number(getStart(getNode(item))) || 0,
    }));
    const removeEscape = () => document.removeEventListener('keydown', escape);
    const restoreOriginal = () => {
      originalState.forEach(snapshot => {
        const itemNode = snapshot.node;
        if (itemNode) itemNode.startSeconds = snapshot.start;
      });
      updateLayout?.();
    };
    const cleanup = (cancelled = false) => {
      if (liftTimer) clearTimeout(liftTimer);
      liftTimer = null;
      if (frameId) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameId);
        else clearTimeout(frameId);
      }
      frameId = 0;
      removeEscape();
      segment.classList.remove('pressing', 'dragging', 'lifted', 'reorder-placeholder');
      segment.style.removeProperty('transform');
      if (cancelled && lifted) restoreOriginal();
      clearCoverage?.(node);
      clearPreview(marker, ghost, transforms);
      marker = null;
      ghost = null;
      transforms = [];
      try { segment.releasePointerCapture(event.pointerId); } catch (err) { /* optional */ }
      segment.removeEventListener('pointermove', move);
      segment.removeEventListener('pointerup', finish);
      segment.removeEventListener('pointercancel', cancel);
    };
    // Where a segment sits in the rail's layout, underneath any preview
    // shift. A shift is a transitioned transform, so clearing it and measuring
    // in the same frame reports a mid-animation rect: the segment appears far
    // from its slot, the pointer lands on the wrong side of its midpoint, and
    // a drop back across it computes the segment's own index (no reorder).
    const layoutRect = element => {
      const bounds = element.getBoundingClientRect();
      const transform = getComputedStyle(element).transform;
      const shift = transform && transform !== 'none' ? new DOMMatrixReadOnly(transform).e : 0;
      return { left: bounds.left - shift, right: bounds.right - shift, width: bounds.width };
    };
    const updateInsertionPreview = clientX => {
      const others = entries.filter(item => item !== entry);
      transforms = [];
      insertionIndex = 0;
      for (const item of others) {
        const itemRect = layoutRect(item.segment);
        if (clientX > itemRect.left + itemRect.width / 2) insertionIndex += 1;
      }
      const fromIndex = entries.indexOf(entry);
      const markerX = insertionIndex >= others.length
        ? (others.length ? layoutRect(others[others.length - 1].segment).right : rect.left)
        : layoutRect(others[insertionIndex].segment).left;
      marker.style.left = `${Math.max(0, markerX - rect.left - 2)}px`;
      marker.style.height = `${Math.max(18, segmentRect.height)}px`;
      marker.hidden = false;
      const delta = Math.max(8, segmentRect.width + 4);
      others.forEach((item, index) => {
        const shouldShiftLeft = fromIndex < insertionIndex
          && index >= fromIndex && index < insertionIndex;
        const shouldShiftRight = fromIndex > insertionIndex
          && index >= insertionIndex && index < fromIndex;
        if (shouldShiftLeft || shouldShiftRight) {
          const amount = shouldShiftLeft ? -delta : delta;
          item.segment.style.transform = `translateX(${amount}px)`;
          transforms.push({ segment: item.segment });
        } else {
          item.segment.style.removeProperty('transform');
        }
      });
    };
    const lift = () => {
      if (lifted) return;
      lifted = true;
      marker = ensureMarker();
      ghost = segment.cloneNode(true);
      ghost.classList.add('storyboard-act-board-track-floating-ghost');
      ghost.style.width = `${Math.max(12, segmentRect.width)}px`;
      ghost.style.height = `${Math.max(18, segmentRect.height)}px`;
      ghost.style.left = `${originX - grabOffsetX}px`;
      ghost.style.top = `${originY - grabOffsetY}px`;
      document.body.appendChild(ghost);
      segment.classList.remove('pressing');
      segment.classList.add('lifted', 'reorder-placeholder');
      track.classList.add('reordering', 'reorder-valid-drop');
      updateInsertionPreview(lastClientX);
      removeEscape();
      document.addEventListener('keydown', escape);
    };
    const apply = (clientX, clientY) => {
      if (lifted) {
        ghost.style.left = `${clientX - grabOffsetX}px`;
        ghost.style.top = `${clientY - grabOffsetY}px`;
        updateInsertionPreview(clientX);
        moved = moved || Math.abs(clientX - originX) > 2 || Math.abs(clientY - originY) > 2;
        segment.dataset.dragMoved = moved ? 'true' : segment.dataset.dragMoved || '';
        return;
      }
      const total = Math.max(0.1, Number(getTotal?.()) || 0.1);
      const nextStart = Math.max(0, initialStart + ((clientX - originX) / rect.width) * total);
      moved = moved || Math.abs(clientX - originX) > 2;
      if (moved) segment.dataset.dragMoved = 'true';
      applyTiming?.(node, nextStart, duration);
      onCoverage?.(node, nextStart, nextStart + duration);
      updateLayout?.();
    };
    const move = moveEvent => {
      lastClientX = moveEvent.clientX;
      lastClientY = moveEvent.clientY;
      if (frameId) return;
      frameId = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(() => { frameId = 0; apply(lastClientX, lastClientY); })
        : setTimeout(() => { frameId = 0; apply(lastClientX, lastClientY); }, 0);
    };
    const escape = keyEvent => {
      if (keyEvent.key !== 'Escape' || !lifted) return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      cleanup(true);
    };
    const finish = () => {
      if (frameId) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameId);
        else clearTimeout(frameId);
        frameId = 0;
        apply(lastClientX, lastClientY);
      }
      if (lifted && moved) {
        const ordered = entries.map(item => item);
        ordered.splice(ordered.indexOf(entry), 1);
        ordered.splice(Math.max(0, Math.min(ordered.length, insertionIndex)), 0, entry);
        const changed = ordered.some((item, index) => item !== entries[index]);
        cleanup(false);
        if (changed) onCommitReorder?.(ordered, node);
        else onCommitTiming?.(node);
        return;
      }
      cleanup(false);
      onCommitTiming?.(node);
    };
    const cancel = () => cleanup(true);
    try { segment.setPointerCapture(event.pointerId); } catch (err) { /* optional */ }
    segment.classList.add('pressing', 'dragging');
    liftTimer = setTimeout(lift, ACT_BOARD_TRACK_LIFT_DELAY_MS);
    segment.addEventListener('pointermove', move);
    segment.addEventListener('pointerup', finish, { once: true });
    segment.addEventListener('pointercancel', cancel, { once: true });
  });
  segment.addEventListener('keydown', event => {
    if (!event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = entries.indexOf(entry);
    const nextIndex = event.key === 'ArrowLeft' ? currentIndex - 1 : currentIndex + 1;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= entries.length) return;
    const ordered = entries.map(item => item);
    ordered.splice(currentIndex, 1);
    ordered.splice(nextIndex, 0, entry);
    onCommitReorder?.(ordered, node);
  });
}

function actBoardFootageSceneTechniques(node) {
  if (!node) return [];
  const selectedKey = String(node.selectedVisualKey || '');
  const generatedIndex = selectedKey.startsWith('generated-')
    ? Number(selectedKey.slice('generated-'.length))
    : selectedKey ? -1 : Number(node.selectedGeneratedIndex);
  const generated = Number.isInteger(generatedIndex) && Array.isArray(node.generatedOptions)
    ? node.generatedOptions[generatedIndex] : null;
  const generatedTechniques = Array.isArray(generated?.techniques) && generated.techniques.length
    ? generated.techniques
    : generated?.shotPlan?.techniques;
  const techniques = generatedTechniques?.length
    ? generatedTechniques : (node.imageGenerationTechniques || []);
  const values = Array.isArray(techniques) ? techniques : [techniques];
  return Array.from(new Set([
    ...(Array.isArray(node.combinedConceptTechniques) ? node.combinedConceptTechniques : []),
    ...values,
  ].map(technique => String(technique || '').trim()).filter(Boolean)));
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

// `data-node-id` is carried by BOTH a node's canvas card and the scene's
// node-list chips, and the chips sit earlier in the scene card than the Footage
// lane the cards were moved into. A bare attribute query therefore returns a
// 102x17 chip rather than the card - which is what silently broke the footage
// drop menu: the source card it suppressed for hit-testing was never the card
// actually under the pointer, so a drop target always resolved to the source
// itself and the hover was cleared on every move.
function actBoardNodeCard(root, nodeId) {
  if (!root || !nodeId) return null;
  return root.querySelector(
    `.storyboard-act-board-node[data-node-id="${String(nodeId).replace(/"/g, '\\"')}"]`) || null;
}

function actBoardDropElementsAt(boardLayer, source, clientX, clientY) {
  const sourceCard = actBoardNodeCard(boardLayer, source?.id);
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
    hover.sourceCard = actBoardNodeCard(boardLayer, source.id);
    hover.sourceCard?.classList.add('footage-drop-hover');
    targetCard.classList.add('footage-drop-hover');
    hover.timer = setTimeout(() => {
      if (boardLayer._actBoardFootageDropHover !== hover) return;
      hover.ready = true;
      hover.sourceCard?.classList.add('footage-drop-shaking');
      hover.targetCard?.classList.add('footage-drop-shaking');
    }, ACT_BOARD_DROP_HOVER_DELAY_MS);
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
  const sourceCard = actBoardNodeCard(boardLayer, source.id);
  const targetCards = [sourceId, targetId]
    .map(id => actBoardNodeCard(boardLayer, id))
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
  }, ACT_BOARD_DROP_HOVER_DELAY_MS);
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
  const previousMenu = boardLayer.querySelector('.storyboard-act-board-footage-drop-menu');
  previousMenu?._actBoardClose?.();
  previousMenu?.remove();
  const menu = document.createElement('div');
  menu.className = 'storyboard-act-board-footage-drop-menu';
  const closeMenu = () => {
    menu.remove();
    document.removeEventListener('keydown', onKeydown, true);
  };
  const onKeydown = event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeMenu();
  };
  menu._actBoardClose = closeMenu;
  document.addEventListener('keydown', onKeydown, true);
  const hint = document.createElement('span');
  hint.textContent = `“${footageNodeVisualSummary(source)}” dropped on “${footageNodeVisualSummary(target)}”`;
  menu.appendChild(hint);
  const choices = [
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
      closeMenu();
      await applyActBoardFootageDropChoice(actKey, source, target, choice);
    });
    menu.appendChild(button);
  });
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
  const sourceLabels = actBoardFootageOriginLabels(source);
  const targetLabels = actBoardFootageOriginLabels(target);
  const sourceTechniques = actBoardFootageSceneTechniques(source);
  const targetTechniques = actBoardFootageSceneTechniques(target);
  const parent = nodes.find(item => item.type === 'narration'
    && (item.id === target.narrationNodeId || item.id === source.narrationNodeId)) || null;
  if (choice === 'merge-generative') {
    // A merge is a new visual idea, not a destructive edit of either source
    // card. Keep both originals (and their links/timing) intact, then spawn a
    // third footage node carrying the combined labels and techniques.
    const combinedLabels = Array.from(new Set([...targetLabels, ...sourceLabels]));
    const combinedPrompt = combinedLabels.join('; ') || `${targetLabel}; ${sourceLabel}`;
    const combinedTechniques = filterActBoardTechniques(
      Array.from(new Set([...targetTechniques, ...sourceTechniques])),
      ACT_BOARD_IMAGE_TECHNIQUE_CATEGORIES,
    );
    const mergedNode = {
      id: createActBoardNodeId('footage'),
      type: 'footage',
      actKey,
      sceneId: target.sceneId || source.sceneId || parent?.sceneId || null,
      // Composite cards are independent visual concepts. Do not attach the
      // new card to the narration chain or either source footage card; the
      // scene still owns it, but the link layer should render no edge to it.
      narrationNodeId: null,
      fragment: combinedPrompt,
      filmabilityQuery: combinedPrompt,
      query: combinedPrompt,
      results: [],
      generatedOptions: [],
      selectedVisualKey: 'upload',
      selectedResultIndex: null,
      selectedGeneratedIndex: null,
      mediaUrl: '',
      mediaThumbnailUrl: '',
      mediaKind: '',
      mediaOrigin: '',
      sourceDurationSeconds: 0,
      trimStartSeconds: 0,
      durationSeconds: targetDuration,
      durationWasSuggested: false,
      startSeconds: Math.max(0, (Number(target.startSeconds) || 0) + targetDuration),
      previousFootageNodeId: null,
      nextFootageNodeId: null,
      sequenceIndex: Math.max(
        Number(target.sequenceIndex) || 0, Number(source.sequenceIndex) || 0,
      ) + 1,
      status: 'ready',
      generationStatus: 'generating-images',
      generationError: '',
      compositionMode: 'merged',
      combinedConceptLabels: combinedLabels,
      combinedConceptPrompt: combinedPrompt,
      combinedConceptTechniques: combinedTechniques,
      imageGenerationPhrase: combinedPrompt,
      imageGenerationTechniques: combinedTechniques,
      videoGenerationTechniques: [...ACT_BOARD_DEFAULT_VIDEO_TECHNIQUES],
      boardX: Math.max(0, (Number(target.boardX) || 0)
        + Math.max(220, Number(target.boardWidth) || 220) + ACT_BOARD_FOOTAGE_GAP),
      boardY: Number(target.boardY) || 0,
      boardWidth: Number(target.boardWidth) || ACT_BOARD_FOOTAGE_STANDARD_WIDTH,
      boardHeight: Number(target.boardHeight) || ACT_BOARD_FOOTAGE_STANDARD_HEIGHT,
      // Let the first post-render scene-lane pass choose a position inside
      // the framed Footage section rather than placing the new composite at
      // an offset from the drop target (which can be outside the scene).
      boardPositionMode: 'footage-section-auto',
    };
    nodes.push(mergedNode);
    attachActBoardNodeToScene(actKey, mergedNode,
      actBoardSceneForNode(actKey, target) || actBoardSceneForNode(actKey, source));
    syncActBoardLiveSceneSnapshots();
    saveDebugSession();
    rerenderActBoard();
    const act = currentArcSections.find(item => item.key === actKey);
    if (act && ACT_BOARD_AUTO_GENERATE_FOOTAGE_IMAGES) await generateActBoardNodeExamples(actKey, act, mergedNode);
    return;
  }

  if (choice === 'split-screen') {
    // Split screen is also non-destructive: keep both source cards and their
    // existing links/timing intact, then add a third card that composes their
    // selected visuals side by side for the target shot's full duration.
    const combinedLabels = Array.from(new Set([targetLabel, sourceLabel]));
    const combinedPrompt = combinedLabels.join('; ') || `${targetLabel}; ${sourceLabel}`;
    const combinedTechniques = filterActBoardTechniques(
      Array.from(new Set([...targetTechniques, ...sourceTechniques])),
      ACT_BOARD_IMAGE_TECHNIQUE_CATEGORIES,
    );
    const splitNode = {
      id: createActBoardNodeId('footage'),
      type: 'footage',
      actKey,
      sceneId: target.sceneId || source.sceneId || parent?.sceneId || null,
      // Keep split-screen output free-standing as well. Its source ids are
      // composition references, not graph links, so no path is drawn to it.
      narrationNodeId: null,
      fragment: combinedPrompt,
      filmabilityQuery: combinedPrompt,
      query: combinedPrompt,
      results: [],
      generatedOptions: [],
      selectedVisualKey: 'split-screen',
      selectedResultIndex: null,
      selectedGeneratedIndex: null,
      mediaUrl: '',
      mediaThumbnailUrl: '',
      mediaKind: '',
      mediaOrigin: 'composed',
      sourceDurationSeconds: 0,
      trimStartSeconds: 0,
      durationSeconds: targetDuration,
      durationWasSuggested: false,
      startSeconds: Math.max(0, (Number(target.startSeconds) || 0) + targetDuration),
      previousFootageNodeId: null,
      nextFootageNodeId: null,
      sequenceIndex: Math.max(
        Number(target.sequenceIndex) || 0, Number(source.sequenceIndex) || 0,
      ) + 1,
      status: 'ready',
      generationStatus: '',
      generationError: '',
      compositionMode: 'split-screen',
      splitScreenNodeIds: [target.id, source.id],
      splitScreenLabels: combinedLabels,
      combinedConceptLabels: combinedLabels,
      combinedConceptPrompt: combinedPrompt,
      combinedConceptTechniques: combinedTechniques,
      imageGenerationPhrase: combinedPrompt,
      imageGenerationTechniques: combinedTechniques,
      videoGenerationTechniques: [...ACT_BOARD_DEFAULT_VIDEO_TECHNIQUES],
      boardX: Math.max(0, (Number(target.boardX) || 0)
        + Math.max(220, Number(target.boardWidth) || 220) + ACT_BOARD_FOOTAGE_GAP),
      boardY: Number(target.boardY) || 0,
      boardWidth: Number(target.boardWidth) || ACT_BOARD_FOOTAGE_STANDARD_WIDTH,
      boardHeight: Number(target.boardHeight) || ACT_BOARD_FOOTAGE_STANDARD_HEIGHT,
      // Composite footage cards are scene-owned but free-standing. Position
      // them through the same Footage-lane grid used by Visualize highlights.
      boardPositionMode: 'footage-section-auto',
    };
    nodes.push(splitNode);
    attachActBoardNodeToScene(actKey, splitNode,
      actBoardSceneForNode(actKey, target) || actBoardSceneForNode(actKey, source));
    syncActBoardLiveSceneSnapshots();
    saveDebugSession();
    rerenderActBoard();
    return;
  }

  unlinkActBoardFootageNode(actKey, source);
  target.durationSeconds = targetDuration;
  target.durationWasSuggested = false;
  target.alignedToNarration = false;
  target.compositionMode = 'merged';
  target.combinedConceptPrompt = `${targetLabel}; ${sourceLabel}`;
  target.splitScreenNodeIds = [];
  target.splitScreenLabels = [];
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
  // Keep the non-conflicting sides of each node intact. This lets a chain be
  // extended (Audio A → B, then B → C) without removing A → B.
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

  // Keep the two sides of a narration/footage relationship normalized even
  // when a card was restored from an older scene snapshot. In particular,
  // spreading a legacy string/undefined footageNodeIds value can silently
  // create a broken relationship that looks like a successful link but never
  // renders a path.
  const attachFootageToNarration = (narration, footage) => {
    if (!narration || narration.type !== 'narration'
      || !footage || footage.type !== 'footage') return false;
    unlinkActBoardFootageNode(actKey, footage);
    const footageIds = Array.isArray(narration.footageNodeIds)
      ? narration.footageNodeIds : [];
    narration.footageNodeIds = Array.from(new Set([...footageIds, footage.id]));
    footage.narrationNodeId = narration.id;
    narration.actKey = actKey;
    footage.actKey = actKey;
    footage.durationWasSuggested = true;
    footage.alignedToNarration = false;
    const narrationScene = actBoardSceneForNode(actKey, narration);
    const footageScene = actBoardSceneForNode(actKey, footage);
    const scene = narrationScene || footageScene;
    if (scene) {
      attachActBoardNodeToScene(actKey, narration, scene);
      attachActBoardNodeToScene(actKey, footage, scene);
    }
    clearActBoardNarrationAlignment(narration);
    recomputeActBoardTiming(narration);
    return true;
  };

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
    if (!attachFootageToNarration(source, target)) return;
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
    if (!attachFootageToNarration(target, source)) return;
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
    && !window.confirm('Clear all scenes?')) return;
  actBoardNodes = Object.create(null);
  actBoardScenes = Object.create(null);
  actBoardOpenSceneByAct = Object.create(null);
  actBoardInitialScenesInitialized = true;
  currentArcSections.forEach(act => actBoardInitialSceneActKeys.add(act.key));
  saveDebugSession();
  rerenderActBoard();
}

function bringNewActBoardNodeToFront(actKey, node) {
  if (!node || node.type === 'playback') return;
  const highest = actBoardNodesForAct(actKey).reduce((max, item) => Math.max(
    max, Number(item?.boardZIndex) || 1,
  ), 1);
  // New working nodes should sit above the playback surface even when the
  // playback node was previously brought to the front by a click.
  node.boardZIndex = highest + 1;
}

