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

function orderedActBoardNarrationChain(actKey, rootNode, candidates = null,
  includeExcluded = false) {
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
    if (includeExcluded || cursor.includeNarration !== false) ordered.push(cursor);
    cursor = byId.get(cursor.nextNarrationNodeId);
  }
  return ordered;
}

function syncActBoardNarrationChainTiming(chain) {
  if (!Array.isArray(chain) || chain.length < 2) return;
  let cursor = Math.max(0, Number(chain[0].startSeconds) || 0);
  chain.forEach((node, index) => {
    if (index > 0) {
      // A dragged segment keeps its own place, but only forward of the
      // previous segment's end - letting it sit earlier would give this
      // node's audio window a head start into the previous node's own
      // window, so both play at once instead of one after the other.
      const manualStart = Math.max(0, Number(node.startSeconds) || 0);
      node.startSeconds = Number((node.timingWasManuallyAdjusted
        ? Math.max(manualStart, cursor) : cursor).toFixed(2));
    }
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

function setActBoardPlaybackPlayButton(button, playing) {
  if (!button) return;
  button.textContent = playing ? '⏸' : '▶';
  button.title = playing ? 'Pause playback' : 'Play playback';
  button.setAttribute('aria-label', playing ? 'Pause playback' : 'Play playback');
}

// A scene can render the same timeline in more than one place (the canvas
// rail and the scene playback panel). Keep a small owner-level registry so a
// single sequence time updates every connected rail without allowing an old
// rerendered rail to keep receiving updates.
function registerActBoardScenePlayheadTrack(timelineOwner, track, {
  narrationVisual = null,
  footageVisual = null,
  audioVisual = null,
  toggleNarration = null,
} = {}) {
  if (!timelineOwner || !track) return;
  // Older renders/session restores may leave this runtime-only field as a
  // plain object (JSON serializes a Set as `{}`). Never call `.add` until it
  // has been normalized back to a real Set.
  let registry = timelineOwner._actBoardScenePlayheadTracks;
  if (!(registry instanceof Set)) {
    const restoredEntries = Array.isArray(registry)
      ? registry.filter(item => item && typeof item === 'object') : [];
    registry = new Set(restoredEntries);
    timelineOwner._actBoardScenePlayheadTracks = registry;
  }
  const entry = {
    track, narrationVisual, footageVisual, audioVisual, toggleNarration, mounted: false,
  };
  registry.add(entry);
  timelineOwner._actBoardSetScenePlayheadTime = seconds => {
    const safe = Math.max(0, Number(seconds) || 0);
    timelineOwner._actBoardScenePlayheadSeconds = safe;
    registry.forEach(item => {
      if (!item.track?.isConnected) {
        // A rail is commonly registered before its parent scene is attached
        // to the document. Keep that initial entry; remove only rails that
        // were mounted previously and later detached by a rerender.
        if (item.mounted) registry.delete(item);
        return;
      }
      item.mounted = true;
      item.narrationVisual?.(safe);
      item.footageVisual?.(safe);
      item.audioVisual?.(safe);
    });
  };
  timelineOwner._actBoardToggleNarrationPlayback = () => {
    for (const item of registry) {
      if (!item.track?.isConnected) {
        if (item.mounted) registry.delete(item);
        continue;
      }
      item.mounted = true;
      if (item.toggleNarration?.()) return true;
    }
    return false;
  };
  track._actBoardScenePlayheadRegistration = entry;
  return entry;
}

// Add the draggable sequence-position rule shared by the scene's narration,
// footage, and audio rails. The rail supplies the current duration because it
// can change as segments are resized; all updates go through the owner-level
// registry so every copy of the playhead moves together.
function buildActBoardScenePlayheadControl(strip, track, timelineOwner, getTotal, label) {
  if (!strip || !track) return null;
  // Every rail with a shared playhead should expose the same horizontal
  // slider affordance as narration. Segment controls may still override this
  // cursor for their own select/drag interactions.
  strip.classList.add('storyboard-act-board-playhead-strip');
  const playhead = document.createElement('span');
  playhead.className = 'storyboard-act-board-narration-track-playhead';
  playhead.setAttribute('aria-hidden', 'true');
  const hitArea = document.createElement('span');
  hitArea.className = 'storyboard-act-board-narration-track-playhead-hit-area';
  hitArea.setAttribute('aria-label', label || 'Sequence playhead');
  hitArea.title = 'Drag to choose where playback starts';
  hitArea.setAttribute('role', 'slider');
  hitArea.tabIndex = 0;
  strip.append(playhead, hitArea);

  const readTotal = () => Math.max(0.1, Number(getTotal?.()) || 0.1);
  const setVisual = seconds => {
    const total = readTotal();
    const safe = Math.max(0, Math.min(total, Number(seconds) || 0));
    const percent = `${((safe / total) * 100).toFixed(3)}%`;
    playhead.style.left = percent;
    hitArea.style.left = percent;
    hitArea.setAttribute('aria-valuemin', '0');
    hitArea.setAttribute('aria-valuemax', String(total));
    hitArea.setAttribute('aria-valuenow', String(Number(safe.toFixed(2))));
  };
  const setTime = seconds => {
    const total = readTotal();
    const safe = Math.max(0, Math.min(total, Number(seconds) || 0));
    if (timelineOwner?._actBoardSetScenePlayheadTime) {
      timelineOwner._actBoardSetScenePlayheadTime(safe);
    } else if (timelineOwner) {
      timelineOwner._actBoardScenePlayheadSeconds = safe;
      setVisual(safe);
    } else {
      setVisual(safe);
    }
    track._actBoardScenePlayheadSeconds = safe;
  };
  const moveToClientX = clientX => {
    const rect = strip.getBoundingClientRect();
    if (!(rect.width > 0)) return;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    setTime(ratio * readTotal());
  };
  const startDrag = event => {
    event.preventDefault();
    event.stopPropagation();
    track.focus?.({ preventScroll: true });
    hitArea.focus({ preventScroll: true });
    moveToClientX(event.clientX);
    try { hitArea.setPointerCapture(event.pointerId); } catch (err) { /* optional */ }
    const move = moveEvent => {
      moveEvent.preventDefault();
      moveToClientX(moveEvent.clientX);
    };
    const finish = () => {
      hitArea.removeEventListener('pointermove', move);
      hitArea.removeEventListener('pointerup', finish);
      hitArea.removeEventListener('pointercancel', finish);
      try { hitArea.releasePointerCapture(event.pointerId); } catch (err) { /* optional */ }
      saveDebugSession();
    };
    hitArea.addEventListener('pointermove', move);
    hitArea.addEventListener('pointerup', finish, { once: true });
    hitArea.addEventListener('pointercancel', finish, { once: true });
  };
  hitArea.addEventListener('pointerdown', startDrag);
  // Clicking or dragging an empty part of a rail also repositions the shared
  // playhead. Segment controls stop propagation, so selecting a segment still
  // keeps its normal selection/coverage behavior.
  strip.addEventListener('pointerdown', event => {
    if (event.target.closest?.('.storyboard-act-board-footage-track-segment, '
      + '.storyboard-act-board-footage-track-handle, '
      + '.storyboard-act-board-narration-track-playhead-hit-area, '
      + '.sfx-source-strip, audio')) return;
    startDrag(event);
  });
  hitArea.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const total = readTotal();
    const current = Number(timelineOwner?._actBoardScenePlayheadSeconds) || 0;
    const step = event.shiftKey ? 1 : .1;
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? total
        : current + (event.key === 'ArrowLeft' ? -step : step);
    setTime(next);
  });
  setVisual(timelineOwner?._actBoardScenePlayheadSeconds || 0);
  return { playhead, hitArea, setVisual, setTime };
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
  pauseActBoardSplitVideos(state, true);
  state.playing = false;
  state.audioEnded = false;
  state.clockTime = 0;
  state.playbackTimelineOwner?._actBoardSetScenePlayheadTime?.(0);
  state.updatePlaybackProgress?.();
  state.activeCards?.forEach(card => card.classList.remove('act-board-playback-active'));
  state.scrubCleanup?.();
  state.scrubCleanup = null;
  setActBoardPlaybackPlayButton(state.playButton, false);
  if (state.stopButton) state.stopButton.disabled = true;
  if (state.status && !state.error) state.status.textContent = '';
  if (state.stage) state.stage.classList.remove('playing');
  actBoardPlaybackState = null;
}

// Native media elements can leave `paused === true` briefly while their
// source is buffering. Calling play() again on every playback-clock tick
// aborts the previous request and sounds like chopped audio. Keep one pending
// play request per layer until the browser resolves it.
function requestActBoardMediaPlay(element) {
  if (!element || !element.paused || element._actBoardPlayPending) return;
  element._actBoardPlayPending = true;
  let result = null;
  try { result = element.play(); } catch (err) {
    element._actBoardPlayPending = false;
    return;
  }
  const clearPending = () => { element._actBoardPlayPending = false; };
  if (result && typeof result.then === 'function') result.then(clearPending, clearPending);
  else clearPending();
}

function pauseActBoardSplitVideos(state, reset = false) {
  state?.splitVideos?.forEach(item => {
    item.element?.pause();
    if (reset) {
      try { item.element.currentTime = 0; } catch (err) { /* metadata race */ }
    }
  });
}

function actBoardSelectedFootageMedia(footage, sourceNodes = null) {
  if (!footage) return { url: '', kind: 'image', thumbnailUrl: '', muteAudio: false };
  if (footage.compositionMode === 'split-screen') {
    // A split-screen node stores references to the two source footage nodes.
    // During scene playback those sources can live in saved scene snapshots
    // rather than the currently mounted live node array, so prefer the
    // playback scene's node pool and fall back to the act's live nodes.
    const liveNodes = actBoardNodesForAct(footage.actKey);
    // Include saved snapshots from every scene as a final fallback. This is
    // important for full playback after switching scenes: the split node can
    // be live while one of its source cards is only present in a saved scene
    // snapshot, and omitting that source would make the composition collapse
    // to a single pane (or an empty stage).
    const savedNodes = typeof actBoardRenderNodesForAct === 'function'
      ? actBoardRenderNodesForAct(footage.actKey) : [];
    const pools = [
      ...(Array.isArray(sourceNodes) ? sourceNodes : []),
      ...liveNodes,
      ...savedNodes,
    ];
    const nodes = Array.from(new Map(pools
      .filter(item => item?.id)
      .map(item => [item.id, item])).values());
    const splitVisuals = (footage.splitScreenNodeIds || [])
      .map(id => nodes.find(node => node.type === 'footage' && node.id === id))
      .filter(Boolean)
      .map(node => {
        const visual = actBoardVisualForKey(node, node.selectedVisualKey);
        return {
          node,
          url: visual?.url || node.mediaUrl || node.results?.[0]?.video_url || '',
          kind: visual?.kind || node.mediaKind || 'image',
          thumbnailUrl: visual?.thumbnailUrl || node.mediaThumbnailUrl
            || node.results?.[0]?.thumbnail_url || node.mediaUrl || '',
        };
      })
      .filter(visual => visual.url || visual.thumbnailUrl);
    return {
      url: splitVisuals[0]?.url || '',
      kind: 'split-screen',
      thumbnailUrl: splitVisuals[0]?.thumbnailUrl || '',
      splitVisuals,
      muteAudio: true,
    };
  }
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
  // Generated and stock video keep their audio - the generation prompt now
  // forbids speech and asks for ambient sound only, so what comes back is room
  // tone and weather rather than an invented voice competing with the
  // presenter's narration. Level is the node's own volume, so a clip that is
  // too loud is turned down rather than silenced wholesale. An explicit
  // per-node mute still wins.
  const muteAudio = footage.muteAudio === true
    || actBoardNodeVolume(footage, 0.5) <= 0;
  return { url, kind, thumbnailUrl, muteAudio };
}

// Whichever visual is currently selected/featured on the node: new images are
// generated as an edit OF it (the backend's images.edit path, reached via
// `reference_sketch_url`), and a generated video is seeded from it. Selecting
// an image already means "use this", so there is no separate pinning step.
//
// Only a still qualifies. The image models take an image, and a video would
// need a frame extracted first - the backend can do that for an open slot, but
// keeping this to stills makes what the reference does obvious in the UI.
function actBoardReferenceVisual(node) {
  const key = String(node?.selectedVisualKey || '');
  if (!key) return null;
  const visual = actBoardVisualForKey(node, key);
  if (!visual || visual.kind === 'video') return null;
  return (visual.url || visual.thumbnailUrl) ? visual : null;
}

// The URL to hand the generator. Prefer the full-size image over a thumbnail:
// the backend reads these bytes as the edit source, so resolution matters.
function actBoardReferenceImageUrl(node) {
  const visual = actBoardReferenceVisual(node);
  return visual ? (visual.url || visual.thumbnailUrl || '') : '';
}

// Resolve an Act Board footage visual by the stable gallery key used by the
// selected-visual rail. Two-frame video generation uses this helper instead
// of relying on whichever image happens to be selected in the featured box,
// so the presenter can explicitly choose independent start and end frames.
function actBoardVisualForKey(node, key) {
  if (!node) return null;
  const visualKey = String(key || '');
  if (visualKey === 'upload') {
    if (!node.mediaUrl && !node.mediaThumbnailUrl) return null;
    return {
      key: 'upload',
      kind: node.mediaKind || 'image',
      url: node.mediaUrl || node.mediaThumbnailUrl || '',
      thumbnailUrl: node.mediaThumbnailUrl || node.mediaUrl || '',
      label: node.mediaKind === 'video' ? 'Uploaded footage' : 'Uploaded image',
      source: 'Uploaded by user',
    };
  }
  if (visualKey.startsWith('upload-')) {
    const index = Number(visualKey.slice('upload-'.length));
    const upload = Number.isInteger(index) ? node.uploadedVisuals?.[index] : null;
    if (!upload || !(upload.url || upload.thumbnailUrl)) return null;
    return {
      key: visualKey,
      kind: upload.kind || 'video',
      url: upload.url || upload.thumbnailUrl || '',
      thumbnailUrl: upload.thumbnailUrl || upload.url || '',
      label: upload.label || (upload.kind === 'image' ? 'Uploaded image' : 'Uploaded footage'),
      source: 'Uploaded by user',
      uploadedIndex: index,
    };
  }
  if (visualKey.startsWith('generated-')) {
    const index = Number(visualKey.slice('generated-'.length));
    const option = Number.isInteger(index) ? node.generatedOptions?.[index] : null;
    if (!option) return null;
    return {
      key: visualKey,
      kind: option.kind || 'image',
      url: option.url || option.thumbnail_url || '',
      thumbnailUrl: option.thumbnail_url || option.url || '',
      label: option.label || `Generated option ${index + 1}`,
      source: 'AI-generated',
      generatedIndex: index,
      specificPhrase: option.specificPhrase || '',
      techniques: Array.isArray(option.techniques)
        ? option.techniques
        : (Array.isArray((option.shotPlan || option.shot_plan)?.techniques)
          ? (option.shotPlan || option.shot_plan).techniques : []),
      shotPlan: option.shotPlan || option.shot_plan || {},
    };
  }
  if (visualKey.startsWith('result-')) {
    const index = Number(visualKey.slice('result-'.length));
    const result = Number.isInteger(index) ? node.results?.[index] : null;
    if (!result) return null;
    return {
      key: visualKey,
      kind: 'video',
      url: result.localPreviewUrl || result.video_url || '',
      thumbnailUrl: result.thumbnail_url || result.localPreviewUrl || '',
      label: result.source || 'Found footage',
      source: result.source || '',
      resultIndex: index,
      portrait: actBoardResultIsPortrait(result),
    };
  }
  return null;
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

// The longest a shot can honestly stay on screen.
//
// A video has exactly as much material as remains after its source in-point.
// Asking for more does not hold the last frame - playback wraps with
// `localSeconds % usedLength` and the export loops the file, so the clip
// visibly restarts. Generated clips are the common casualty: the model caps
// them at ACT_BOARD_GENERATED_VIDEO_MAX_SECONDS, well short of most narration
// phrases. A still image has no such limit; holding one longer is just a
// longer hold.
//
// Returns Infinity when there is no limit to apply, so callers can clamp
// unconditionally with Math.min.
function actBoardFootageMaxDurationSeconds(footage) {
  if (!footage) return Infinity;
  const media = actBoardSelectedFootageMedia(footage);
  if (media?.kind !== 'video') return Infinity;
  const source = actBoardFootageSourceDuration(footage);
  const available = source > 0
    ? source - Math.max(0, Number(footage.trimStartSeconds) || 0)
    : ACT_BOARD_GENERATED_VIDEO_MAX_SECONDS;
  return Math.max(ACT_BOARD_MIN_SHOT_SECONDS, available);
}

// A track deletion is intentionally non-destructive: the node stays on the
// board and in the scene, but its segment is hidden until the presenter drops
// the node back onto a compatible track. Keeping this as a small predicate
// makes the behavior consistent across canvas rails, scene playback, and MP4
// render planning.
function actBoardTrackNodeVisible(node) {
  return Boolean(node && node.trackHidden !== true);
}

// A segment removed from one rail is hidden in the data (trackHidden), but
// the playback panel's rail and the scene/full playback are separate DOM
// built from that data. Rebuild the scene so every view drops it at once.
function syncActBoardTrackRemoval(actKey, node) {
  if (!node?.id) return;
  // The content panel was showing the removed segment's editor. Leave it on
  // that segment and the panel keeps describing something no longer on the
  // rails; return to the outline instead.
  if (String(actBoardSelectedNodeId || '') === String(node.id)) {
    actBoardSelectedNodeId = '';
    actBoardFullPlaybackView = 'overview';
    document.querySelector('.storyboard-act-board-full-playback-panel')
      ?._actBoardFullPlayback?.showOverview?.();
  }
  const scene = actBoardSceneForNode(actKey, node);
  if (scene) {
    syncActBoardLiveSceneSnapshots(scene);
    queueActBoardScenePatch(actKey, scene.id, { persist: true });
  } else {
    rerenderActBoard({ preservePlayback: true });
  }
}

function persistActBoardTrackNode(node) {
  if (!node?.id) return;
  const scene = actBoardSceneForNode(node.actKey, node);
  if (!scene || typeof snapshotActBoardSceneNode !== 'function') return;
  const snapshot = snapshotActBoardSceneNode(node);
  if (!snapshot) return;
  scene.nodeSnapshots = (scene.nodeSnapshots || []).filter(item => item.id !== node.id);
  scene.nodeSnapshots.push(snapshot);
}

function orderedActBoardLinkedFootage(actKey, narrationNode, sourceNodes = null) {
  if (!narrationNode) return [];
  const nodes = Array.isArray(sourceNodes) ? sourceNodes : actBoardNodesForAct(actKey);
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
  if (node.type === 'footage') {
    if (node.narrationNodeId) {
      const direct = nodes.find(item => item.type === 'narration' && item.id === node.narrationNodeId);
      if (direct) return direct;
    }
    // Some restored/relinked footage nodes are represented only in the
    // narration's ordered footage list. Resolve that reverse relationship too
    // so track dragging still highlights the narration beside the node.
    return nodes.find(item => item.type === 'narration'
      && Array.isArray(item.footageNodeIds)
      && item.footageNodeIds.includes(node.id)) || null;
  }
  if (node.type === 'audio' && node.linkedToNodeId) {
    const linked = nodes.find(item => item.id === node.linkedToNodeId);
    return actBoardNarrationForNode(actKey, linked);
  }
  return null;
}

function orderedActBoardLinkedAudio(actKey, narrationNode, sourceNodes = null) {
  if (!narrationNode) return [];
  const nodes = Array.isArray(sourceNodes) ? sourceNodes : actBoardNodesForAct(actKey);
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
    // Hidden track segments remain in the scene so they can be restored by
    // dropping the node back onto a rail, but they should not consume time or
    // shift the visible shots while the track is laid out.
    if (!actBoardTrackNodeVisible(node)) return;
    // The floor is a property of every footage shot, not only arranged ones.
    if ((Number(node.durationSeconds) || 0) < ACT_BOARD_MIN_SHOT_SECONDS) {
      node.durationSeconds = ACT_BOARD_MIN_SHOT_SECONDS;
    }
    const duration = Math.max(ACT_BOARD_MIN_SHOT_SECONDS, Number(node.durationSeconds) || 1);
    if (!node.timingWasManuallyAdjusted) {
      node.startSeconds = Number(cursorSeconds.toFixed(2));
    } else if ((Number(node.startSeconds) || 0)
      < cursorSeconds - ACT_BOARD_TRACK_SEAM_TOLERANCE_SECONDS) {
      // Relinking or changing the scene start can leave a manually timed
      // shot carrying its old timestamp. Preserve intentional gaps, but
      // never allow a later linked shot to overlap or fall behind the prior
      // shot on the playback rail. The tolerance keeps a seam that is only
      // rounding-distance early from being treated as an overlap.
      node.startSeconds = Number(cursorSeconds.toFixed(2));
      // This pass is the last word on where a shot sits, and it has just
      // undone whatever offset an anticipate cut applied. Retract the cut
      // rather than leaving a rail marker advertising a transition that no
      // longer exists - the layout is the source of truth, not the record of
      // what was once planned.
      if (node.narrationCutKind === 'anticipate') {
        node.narrationCutKind = '';
        node.narrationCutSeconds = 0;
        node.narrationCutWasSuggested = false;
        delete node.narrationCutNeighbourId;
        delete node.hardCutStartSeconds;
        delete node.hardCutDurationSeconds;
      }
    }
    node.sequenceIndex = index;
    cursorSeconds = Math.max(cursorSeconds, (Number(node.startSeconds) || 0) + duration);
  });
  return ordered;
}

// Apply a visual reorder from the scene footage cards/rail to the same saved
// sequence data used by scene and full playback. Starts are laid out
// sequentially so moving one shot cannot leave the following shots stacked on
// top of one another; durations and source windows remain unchanged.
function reorderActBoardFootageSequence(actKey, ordered, scene = null) {
  const nodes = actBoardNodesForAct(actKey);
  const byId = new Map(nodes.map(node => [node.id, node]));
  const footage = (Array.isArray(ordered) ? ordered : [])
    .map(item => typeof item === 'string' ? byId.get(item) : item)
    .filter(node => node?.type === 'footage' && byId.has(node.id));
  if (!footage.length) return false;
  const unique = [];
  const seen = new Set();
  footage.forEach(node => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    unique.push(node);
  });
  const currentOrder = unique.map(node => node.id);
  let cursor = 0;
  unique.forEach((node, index) => {
    node.previousFootageNodeId = unique[index - 1]?.id || null;
    node.nextFootageNodeId = unique[index + 1]?.id || null;
    node.sequenceIndex = index;
    node.startSeconds = Number(cursor.toFixed(2));
    node.timingWasManuallyAdjusted = true;
    node.durationWasSuggested = false;
    cursor += Math.max(0.5, Number(node.durationSeconds) || 1);
  });
  const affectedScene = scene || actBoardSceneForNode(actKey, unique[0]);
  if (affectedScene) {
    affectedScene.sequenceStartNodeId = unique[0].id;
    const sceneIds = new Set([...(affectedScene.nodeIds || []), ...unique.map(node => node.id)]);
    const sceneFootageIds = new Set(unique.map(node => node.id));
    nodes.filter(node => node.type === 'narration'
      && (node.footageNodeIds || []).some(id => sceneFootageIds.has(id)))
      .forEach(narration => {
        narration.footageNodeIds = (narration.footageNodeIds || [])
          .filter(id => sceneIds.has(id))
          .sort((a, b) => currentOrder.indexOf(a) - currentOrder.indexOf(b));
      });
  }
  if (affectedScene) affectedScene.timelineDurationSeconds = Math.max(
    Number(affectedScene.timelineDurationSeconds) || 0, cursor,
  );
  syncActBoardLiveSceneSnapshots(affectedScene || null);
  return true;
}

// Repack narration or music/sound segments after a lifted reorder. Durations,
// source windows, media, volume, and inclusion flags remain untouched; only
// sequence order, starts, and the corresponding relationship fields change.
function reorderActBoardTrackSequence(kind, actKey, ordered, timelineOwner = null, narrationNode = null) {
  if (kind === 'footage') return reorderActBoardFootageSequence(actKey, ordered,
    actBoardSceneForNode(actKey, ordered?.[0]));
  const nodes = actBoardNodesForAct(actKey);
  const byId = new Map(nodes.map(node => [node.id, node]));
  const trackNodes = (Array.isArray(ordered) ? ordered : [])
    .map(item => typeof item === 'string' ? byId.get(item) : item)
    .filter(node => node && node.type === kind && byId.has(node.id));
  const unique = [];
  const seen = new Set();
  trackNodes.forEach(node => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    unique.push(node);
  });
  if (!unique.length) return false;
  let cursor = 0;
  unique.forEach((node, index) => {
    const duration = Math.max(kind === 'narration' ? 0.5 : 0.25,
      Number(node.durationSeconds || node.narrationSegmentDurationSeconds) || 1);
    node.sequenceIndex = index;
    node.startSeconds = Number(cursor.toFixed(2));
    node.timingWasManuallyAdjusted = true;
    if (kind === 'narration') {
      node.narrationSegmentDurationSeconds = Number(duration.toFixed(2));
      node.previousNarrationNodeId = unique[index - 1]?.id || null;
      node.nextNarrationNodeId = unique[index + 1]?.id || null;
    } else if (kind === 'audio') {
      node.previousAudioNodeId = unique[index - 1]?.id || null;
      node.nextAudioNodeId = unique[index + 1]?.id || null;
    }
    cursor += duration;
  });
  if (timelineOwner) timelineOwner.timelineDurationSeconds = Math.max(
    Number(timelineOwner.timelineDurationSeconds) || 0, cursor,
  );
  const scene = (narrationNode && actBoardSceneForNode(actKey, narrationNode))
    || actBoardSceneForNode(actKey, unique[0]);
  if (scene) {
    scene.timelineDurationSeconds = Math.max(Number(scene.timelineDurationSeconds) || 0, cursor);
    syncActBoardLiveSceneSnapshots(scene);
  }
  return true;
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
    // Include saved scene snapshots as well as live nodes. A split-screen
    // composition points at its source node ids; when a scene is reloaded,
    // those sources may only exist in the saved snapshot until the canvas is
    // mounted again.
    ? actBoardRenderNodesForAct(playbackNode.actKey || actKey).filter(item =>
      item.sceneId === playbackNode.sceneId || sceneNodeIds.has(item.id))
    : [];
  const sceneNarrations = scene
    ? sceneNodes.filter(item => item.type === 'narration'
      && actBoardTrackNodeVisible(item)
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
  const narrationCandidates = playbackRootNarration
    ? (scene
      ? sceneNodes.filter(item => item.type === 'narration'
        && item.includeNarration !== false)
      : actBoardNodesForAct(actKey).filter(item => item.type === 'narration'
        && item.includeNarration !== false))
    : [];
  const chainedNarrationNodes = playbackRootNarration
    ? orderedActBoardNarrationChain(actKey, playbackRootNarration,
      scene ? sceneNodes : actBoardNodesForAct(actKey)) : [];
  const chainedNarrationIds = new Set(chainedNarrationNodes.map(item => item.id));
  const narrationNodesAll = [
    ...chainedNarrationNodes,
    ...narrationCandidates
      .filter(item => !chainedNarrationIds.has(item.id))
      .sort((a, b) => (Number(a.startSeconds) || 0) - (Number(b.startSeconds) || 0)),
  ];
  syncActBoardNarrationChainTiming(narrationNodesAll);
  const narrationNodes = narrationNodesAll.filter(actBoardTrackNodeVisible);
  const playbackNarration = narrationNodes[0] || null;
  const sceneFootage = sceneNodes.filter(item => item.type === 'footage');
  const linkedNarrationFootage = narrationNodesAll.flatMap(narration =>
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
  const linkedAll = scene?.sequenceStartNodeId
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
  const linked = linkedAll.filter(actBoardTrackNodeVisible);
  // Full playback spans every scene, so `playbackNode.sceneId` is unset and
  // `sceneNodes` above is empty. Music/sound that lives on a scene's own rail
  // carries no `linkedToNodeId`, so the linked-audio pass below cannot see it
  // either - which silently dropped every scene-rail track from the full mix.
  const sceneAudio = playbackNode?.sceneId
    ? sceneNodes.filter(item => item.type === 'audio')
    : actBoardRenderNodesForAct(actKey).filter(item => item.type === 'audio');
  const linkedNarrationAudio = narrationNodesAll.flatMap(narration =>
    orderedActBoardLinkedAudio(actKey, narration));
  // Track membership is independent from the playback toggle. Keep excluded
  // segments visible/editable on the rail, but only feed included segments to
  // the playback clock/audio layers below.
  const narrationTrackEntriesAll = (scene
    ? sceneNodes.filter(item => item.type === 'narration')
    : actBoardNodesForAct(actKey).filter(item => item.type === 'narration'))
    .filter(actBoardTrackNodeVisible);
  const narrationTrackEntries = narrationTrackEntriesAll
    .filter(item => item.includeNarration !== false);
  const audioById = new Map();
  [...linkedNarrationAudio, ...sceneAudio].forEach(audioNode => {
    if (audioNode && !audioById.has(audioNode.id)) audioById.set(audioNode.id, audioNode);
  });
  // Unlinked sound nodes are independent layers. A linked sound node still
  // keeps the start/length assigned by linkActBoardAudioNode().
  const linkedAudioAll = Array.from(audioById.values()).sort((a, b) =>
    (Number(a.startSeconds) || 0) - (Number(b.startSeconds) || 0));
  const linkedAudio = linkedAudioAll.filter(actBoardTrackNodeVisible);
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
  setActBoardPlaybackPlayButton(playButton, false);
  const stopButton = document.createElement('button');
  stopButton.type = 'button';
  stopButton.className = 'btn-secondary storyboard-act-board-node-action';
  stopButton.textContent = '⏹';
  stopButton.title = 'Stop playback';
  stopButton.setAttribute('aria-label', 'Stop playback');
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
  const narrationTrack = narrationTrackEntriesAll.length
    ? buildActBoardPlaybackAudioTrack({
      actKey,
      labelText: 'Narration',
      entries: narrationTrackEntriesAll,
      kind: 'narration',
      narrationNode: playbackNarration,
      boardLayer,
      timelineOwner: playbackTimelineOwner,
    }) : null;
  if (narrationTrack) panel.appendChild(narrationTrack);
  const footageTrack = linkedAll.length ? buildActBoardFootageTrack(
    actKey,
    playbackNarration,
    boardLayer,
    linkedAll,
    playbackTimelineOwner,
  ) : null;
  if (footageTrack) panel.appendChild(footageTrack);
  footageTrack?._actBoardRefresh?.();
  narrationTrack?._actBoardRefresh?.();
  const soundTrack = buildActBoardPlaybackAudioTrack({
    actKey,
    labelText: 'Music / sound',
      entries: linkedAudioAll,
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
  // J/L-cut audio. The stage only ever holds the CURRENT shot's media, so a
  // clip whose sound crosses its own picture boundary needs a second element
  // that is not torn down with the stage. An <audio> element decodes the audio
  // track of a video URL, so the same source serves both.
  const footageCutLayers = linked
    .filter(node => (Number(node.audioLeadSeconds) || 0) > 0
      || (Number(node.audioTailSeconds) || 0) > 0)
    .map(node => {
      // No playbackNodes here: it is declared further down, and the only
      // thing it resolves is split-screen visuals, which are force-muted
      // and so can never carry a cut.
      const media = actBoardSelectedFootageMedia(node);
      if (!media?.url || media.muteAudio === true) return null;
      const element = document.createElement('audio');
      element.className = 'storyboard-act-board-playback-cut-audio';
      element.controls = false;
      element.preload = 'auto';
      element.src = media.url;
      element.volume = actBoardNodeVolume(node, 0.5);
      element.setAttribute('aria-label', `${node.fragment || 'Footage'} transition audio`);
      element.addEventListener('click', event => event.stopPropagation());
      panel.appendChild(element);
      return { node, element };
    })
    .filter(Boolean);

  const refreshPlaybackVolumes = () => {
    audio.volume = actBoardNodeVolume(playbackNarration, 1);
    footageCutLayers.forEach(layer => {
      layer.element.volume = actBoardNodeVolume(layer.node, 0.5);
    });
    // The stage's own clip, so dragging a footage volume slider is audible
    // immediately instead of only after the next shot change.
    if (state.video && state.currentFootageId) {
      const current = linked.find(node => node.id === state.currentFootageId);
      if (current) {
        const media = actBoardSelectedFootageMedia(current);
        state.video.muted = media.muteAudio === true;
        state.video.volume = state.video.muted ? 0 : actBoardNodeVolume(current, 0.5);
      }
    }
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
  const playbackNodes = sceneNodes.length
    ? sceneNodes
    : actBoardNodesForAct(actKey);
  const hasFootageMedia = linked.some(footage => {
    const media = actBoardSelectedFootageMedia(footage, playbackNodes);
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
    if (!footage) return;
    const selectedMedia = actBoardSelectedFootageMedia(footage, playbackNodes);
    if (selectedMedia.kind === 'split-screen') {
      selectedMedia.splitVisuals?.forEach(splitVisual => {
        const item = state.splitVideos?.find(entry => entry.node.id === splitVisual.node.id);
        const video = item?.element;
        if (!video) return;
        const start = Math.max(0, Number(footage.startSeconds) || 0);
        const localSeconds = Math.max(0, nowSeconds - start);
        const sourceDuration = Math.max(0.1,
          Number(splitVisual.node.sourceDurationSeconds) || Number(video.duration) || 0.1);
        const sourceIn = Math.min(Math.max(0, Number(splitVisual.node.trimStartSeconds) || 0),
          Math.max(0, sourceDuration - 0.05));
        const usedLength = Math.max(0.05, Math.min(
          Number(footage.durationSeconds) || sourceDuration - sourceIn,
          Math.max(0.05, sourceDuration - sourceIn),
        ));
        const target = Math.min(Number(video.duration) - 0.01,
          // Clamp, not wrap - see the single-clip stage below. A split pane
          // that outlives its material holds rather than restarting.
          sourceIn + Math.min(localSeconds, Math.max(0, usedLength - 0.05)));
        if (forceSeek && Number.isFinite(target)
          && Math.abs(video.currentTime - target) > 0.08) {
          try { video.currentTime = target; } catch (err) { /* metadata race */ }
        }
        if (state.playing) requestActBoardMediaPlay(video);
      });
      return;
    }
    if (!state.video) return;
    // Narration and sound-effect nodes are the authoritative soundtrack for
    // the Act Board. Generated videos can carry an incidental model audio
    // track, so mute only that embedded track while leaving uploaded/stock
    // footage audio behavior unchanged.
    state.video.muted = selectedMedia.muteAudio === true;
    state.video.volume = state.video.muted ? 0 : actBoardNodeVolume(footage, 0.5);
    const start = Math.max(0, Number(footage.startSeconds) || 0);
    // A J-cut clip started sounding audioLeadSeconds before its picture, so by
    // the time it is on screen it is already that far into its source.
    // Without this its opening moments would replay under the new picture.
    const localSeconds = Math.max(0,
      nowSeconds - (start - (Number(footage.audioLeadSeconds) || 0)));
    if (Number.isFinite(state.video.duration) && state.video.duration > 0) {
      const sourceDuration = Math.max(0.1, Number(footage.sourceDurationSeconds)
        || state.video.duration);
      const sourceIn = Math.min(Math.max(0, Number(footage.trimStartSeconds) || 0),
        Math.max(0, sourceDuration - 0.05));
      const available = Math.max(0.05, sourceDuration - sourceIn);
      const usedLength = Math.max(0.05, Math.min(
        Number(footage.durationSeconds) || available, available,
      ));
      // Clamp rather than wrap. `localSeconds % usedLength` restarted the clip
      // every time a shot outlived its material, which is the repeat-playing
      // glitch; holding the last frame is the honest thing for a clip that has
      // simply run out.
      const target = Math.min(state.video.duration - 0.01,
        sourceIn + Math.min(localSeconds, Math.max(0, usedLength - 0.05)));
      // Seeking on every audio timeupdate makes a CDN clip visibly flicker.
      // Only seek when entering a shot or when the user explicitly scrubs.
      if (forceSeek && Math.abs(state.video.currentTime - target) > 0.08) {
        state.video.currentTime = target;
      }
    }
    if (state.playing) requestActBoardMediaPlay(state.video);
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
      if (forceSeek || Math.abs((Number(layer.element.currentTime) || 0) - local) > 0.75) {
        try { layer.element.currentTime = local; } catch (err) { /* metadata not ready */ }
      }
      if (state.playing) requestActBoardMediaPlay(layer.element);
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
      if (forceSeek || Math.abs((Number(layer.element.currentTime) || 0) - local) > 0.75) {
        try { layer.element.currentTime = local; } catch (err) { /* metadata not ready */ }
      }
      if (state.playing) requestActBoardMediaPlay(layer.element);
    });
  };

  // Each layer sounds ONLY in the window where its audio is outside its own
  // picture: before the shot for a J-cut, after it for an L-cut. Inside the
  // shot the stage's own <video> is the sound source, so playing here too
  // would double it.
  const syncFootageCutLayers = (nowSeconds, forceSeek = false) => {
    footageCutLayers.forEach(layer => {
      const start = Math.max(0, Number(layer.node.startSeconds) || 0);
      const duration = Math.max(0.5, Number(layer.node.durationSeconds) || 1);
      const lead = Math.max(0, Number(layer.node.audioLeadSeconds) || 0);
      const tail = Math.max(0, Number(layer.node.audioTailSeconds) || 0);
      const sourceIn = Math.max(0, Number(layer.node.trimStartSeconds) || 0);
      let local = null;
      // Fade the crossing audio: in over the lead (so the incoming sound rises
      // under the outgoing picture), out over the tail (so the outgoing sound
      // dies under the incoming picture). At the picture cut itself the level
      // is the clip's own, which is where the stage video takes over.
      let ramp = 1;
      if (lead > 0 && nowSeconds >= start - lead && nowSeconds < start) {
        // The shot is already running when it comes into view, which is what
        // makes a J-cut sound continuous rather than restarted.
        local = sourceIn + (nowSeconds - (start - lead));
        ramp = (nowSeconds - (start - lead)) / lead;
      } else if (tail > 0 && nowSeconds >= start + duration
        && nowSeconds < start + duration + tail) {
        local = sourceIn + duration + (nowSeconds - (start + duration));
        ramp = 1 - (nowSeconds - (start + duration)) / tail;
      }
      if (local === null) {
        layer.element.pause();
        return;
      }
      layer.element.volume = Math.max(0, Math.min(1,
        actBoardNodeVolume(layer.node, 0.5) * Math.max(0, Math.min(1, ramp))));
      if (forceSeek || Math.abs((Number(layer.element.currentTime) || 0) - local) > 0.35) {
        try { layer.element.currentTime = local; } catch (err) { /* metadata not ready */ }
      }
      if (state.playing) requestActBoardMediaPlay(layer.element);
    });
  };

  const lastFootageEndSeconds = () => linked.reduce((end, node) => Math.max(end,
    (Number(node.startSeconds) || 0) + Math.max(0.5, Number(node.durationSeconds) || 1)), 0);

  // Caption under the picture: the narration being heard right now, so the
  // words on screen are the words in the ear. Segments are laid out the way
  // the rail draws them (end to end), and when a segment carries Whisper word
  // timings the word being spoken is emphasised. Rebuilt only when the
  // segment or the word changes - the clock ticks many times a second.
  const captionState = { segmentId: null, wordIndex: -2 };
  const narrationCaptionAt = nowSeconds => {
    const now = Math.max(0, Number(nowSeconds) || 0);
    let cursor = 0;
    for (const segment of narrationTrackEntries) {
      const start = Math.max(cursor, Math.max(0, Number(segment.startSeconds) || 0));
      const length = readNarrationLayerDuration({ node: segment, source: null });
      cursor = start + length;
      if (now < start || now >= start + length) continue;
      const text = String(segment.transcript || '').trim();
      if (!text) return null;
      // Whisper word timings when the segment has them; otherwise spread the
      // words evenly over the segment so the caption can still move with the
      // voice. Either way `words` is timed and `wordIndex` is the spoken one.
      let words = Array.isArray(segment.transcriptWords) && segment.transcriptWords.length
        ? segment.transcriptWords : null;
      let local = now - start + Math.max(0, Number(segment.trimStartSeconds) || 0);
      if (!words) {
        const tokens = text.split(/\s+/).filter(Boolean);
        const step = tokens.length ? length / tokens.length : 0;
        words = tokens.map((token, index) => ({ word: token, start: index * step, end: (index + 1) * step }));
        local = now - start;
      }
      let wordIndex = -1;
      words.forEach((word, index) => { if (Number(word?.start) <= local) wordIndex = index; });
      return { segment, text, words, wordIndex, segmentStart: start };
    }
    return null;
  };
  const renderPlaybackCaption = (nowSeconds, force = false) => {
    const caption = stage.querySelector('.storyboard-act-board-playback-caption');
    if (!caption) return;
    const info = narrationCaptionAt(nowSeconds);
    if (!info) {
      if (force || captionState.segmentId !== null) {
        captionState.segmentId = null;
        captionState.wordIndex = -2;
        caption.textContent = caption.dataset.fallback || '';
        caption.classList.remove('is-narration');
      }
      return;
    }
    if (!force && info.segment.id === captionState.segmentId
      && info.wordIndex === captionState.wordIndex) return;
    captionState.segmentId = info.segment.id;
    captionState.wordIndex = info.wordIndex;
    caption.classList.add('is-narration');
    // Only the words being said right now, not the whole segment: a short
    // window around the current word, like a live caption. Without Whisper
    // timings the words are spread evenly over the segment so the window can
    // still move with the voice.
    const windowBefore = 2;
    const windowAfter = 3;
    const timed = info.words;
    const current = info.wordIndex;
    const from = Math.max(0, current - windowBefore);
    const to = Math.min(timed.length, Math.max(current, 0) + windowAfter + 1);
    caption.replaceChildren();
    timed.slice(from, to).forEach((word, offset) => {
      const index = from + offset;
      const span = document.createElement('span');
      span.textContent = String(word?.word || '');
      if (index === current) span.className = 'is-current';
      caption.appendChild(span);
      if (index < to - 1) caption.appendChild(document.createTextNode(' '));
    });
  };
  const mountPlaybackCaption = (nowSeconds, fallback = '') => {
    const caption = document.createElement('small');
    caption.className = 'storyboard-act-board-playback-caption';
    caption.dataset.fallback = fallback;
    caption.textContent = fallback;
    stage.appendChild(caption);
    renderPlaybackCaption(nowSeconds, true);
  };
  // Upcoming shots are decoded ahead of the cut. Creating the <video> at the
  // moment of the switch meant every cut waited on the network - with the
  // one-second shots Smart arrange lays down, playback was a run of stalls.
  // The pool keeps the next shots (and the previous one, for a scrub back)
  // ready; a shot's element is reused across switches and released when it
  // falls out of that window.
  const ACT_BOARD_PLAYBACK_PRELOAD_AHEAD = 2;
  const videoPool = new Map();
  const releasePooledVideo = entry => {
    try {
      entry.video.pause();
      entry.video.removeAttribute('src');
      entry.video.load();
    } catch (err) { /* already released */ }
    entry.video.remove();
    videoPool.delete(entry.footage.id);
  };
  const pooledFootageVideo = footage => {
    const media = actBoardSelectedFootageMedia(footage, playbackNodes);
    if (!media.url || media.kind !== 'video') return null;
    const existing = videoPool.get(footage.id);
    if (existing && existing.url === media.url) return existing.video;
    if (existing) releasePooledVideo(existing);
    const video = document.createElement('video');
    video.src = media.url;
    video.poster = media.thumbnailUrl || '';
    video.playsInline = true;
    // Never loop a shot. A clip that ends before its slot holds its last
    // frame; restarting reads as a broken player rather than an edit.
    video.loop = false;
    video.preload = 'auto';
    // Use the shared playback clock rather than the audio time so a late
    // metadata event cannot seek a new shot back to the narration's last frame.
    ['loadedmetadata', 'loadeddata'].forEach(eventName => video.addEventListener(eventName, () => {
      if (state.video === video) syncVideoToNarration(footage, state.clockTime, true);
    }));
    video.addEventListener('error', () => {
      if (state.video === video && state.status) {
        state.status.textContent = 'This footage could not be loaded from its source.';
      }
    });
    videoPool.set(footage.id, { video, url: media.url, footage });
    return video;
  };
  const preloadUpcomingFootage = current => {
    const currentId = current?.id || null;
    if (state.lastPreloadedFor === currentId) return;
    state.lastPreloadedFor = currentId;
    const order = linked.slice().sort((a, b) =>
      (Number(a.startSeconds) || 0) - (Number(b.startSeconds) || 0));
    const index = currentId ? order.findIndex(item => item.id === currentId) : -1;
    const keep = new Set(currentId ? [currentId] : []);
    order.slice(index + 1, index + 1 + ACT_BOARD_PLAYBACK_PRELOAD_AHEAD).forEach(item => {
      if (pooledFootageVideo(item)) keep.add(item.id);
    });
    if (index > 0) keep.add(order[index - 1].id);
    videoPool.forEach(entry => { if (!keep.has(entry.footage.id)) releasePooledVideo(entry); });
  };
  const setStage = (footage, nowSeconds = readAudioTime(), forceSeek = false) => {
    if (!footage || (!hasNarrationMedia && !hasFootageMedia && !hasAudioMedia)) {
      stage.replaceChildren();
      // Removing the element from the DOM does not stop it: a detached <video>
      // keeps playing, and uploaded/stock footage audio is not muted, so the
      // outgoing clip would keep sounding over the placeholder.
      state.video?.pause();
      state.video = null;
      pauseActBoardSplitVideos(state);
      state.splitVideos = [];
      state.currentFootageId = null;
      const empty = document.createElement('span');
      empty.textContent = !hasNarrationMedia && !hasFootageMedia && !hasAudioMedia
        ? 'There is no narration or media yet.'
        : linked.length
          // Past the final clip is a different situation from a gap between two
          // clips: nothing further is coming, the narration or music is simply
          // still running.
          ? (nowSeconds >= lastFootageEndSeconds() ? 'No footage selected'
            : 'No footage in this interval.')
          : hasNarrationMedia ? 'Narration only' : 'Sound effects only';
      stage.appendChild(empty);
      mountPlaybackCaption(nowSeconds);
      return;
    }
    // Do not rebuild the DOM while the narration clock advances within the
    // same shot. Replacing a Pexels <video> on every `timeupdate` restarts its
    // decoder and presents as a visible flicker/black flash.
    if (state.currentFootageId === footage.id) {
      syncVideoToNarration(footage, nowSeconds, forceSeek);
      return;
    }
    // The stage keeps its 16:9 box whatever the clip's own shape (the CSS
    // letterboxes with object-fit: contain). Following each clip's aspect
    // reflowed the whole panel at every cut, which read as jumpy playback.
    stage.replaceChildren();
    state.video?.pause();
    pauseActBoardSplitVideos(state);
    state.splitVideos = [];
    state.currentFootageId = footage.id;
    const { url, kind, thumbnailUrl, muteAudio } = actBoardSelectedFootageMedia(footage, playbackNodes);
    if (kind === 'split-screen') {
      const splitStage = document.createElement('div');
      splitStage.className = 'storyboard-act-board-playback-split-stage';
      (actBoardSelectedFootageMedia(footage, playbackNodes).splitVisuals || []).forEach(splitVisual => {
        const pane = document.createElement('div');
        pane.className = 'storyboard-act-board-footage-split-pane';
        if (splitVisual.kind === 'video' && splitVisual.url) {
          const video = document.createElement('video');
          video.src = splitVisual.url;
          video.poster = splitVisual.thumbnailUrl || '';
          video.muted = true;
          video.playsInline = true;
          // Same rule as the single-clip stage: a pane that runs out holds its
          // last frame instead of restarting under the others.
          video.loop = false;
          video.preload = 'auto';
          video.addEventListener('click', event => event.stopPropagation());
          video.addEventListener('loadedmetadata', () => {
            if (state.currentFootageId === footage.id) {
              syncVideoToNarration(footage, state.clockTime, true);
            }
          });
          pane.appendChild(video);
          state.splitVideos.push({ node: splitVisual.node, element: video });
        } else if (splitVisual.thumbnailUrl || splitVisual.url) {
          const image = document.createElement('img');
          image.src = splitVisual.thumbnailUrl || splitVisual.url;
          image.alt = footageNodeVisualSummary(splitVisual.node) || 'Split-screen footage';
          pane.appendChild(image);
        }
        splitStage.appendChild(pane);
      });
      stage.appendChild(splitStage);
      state.video = null;
    } else if (url && kind === 'video') {
      const video = pooledFootageVideo(footage);
      // Keep generated model audio out of the linked playback mix. Uploaded
      // and stock footage retain their native audio, subject to node volume.
      video.muted = muteAudio === true;
      video.volume = video.muted ? 0 : actBoardNodeVolume(footage, 0.5);
      stage.appendChild(video);
      state.video = video;
    } else if (url || thumbnailUrl) {
      const image = document.createElement('img');
      image.src = thumbnailUrl || footage.mediaThumbnailUrl || url;
      image.alt = footage.fragment || 'Linked footage';
      stage.appendChild(image);
      state.video = null;
    } else {
      const empty = document.createElement('span');
      empty.textContent = 'This scene has no footage yet.';
      stage.appendChild(empty);
      state.video = null;
    }
    mountPlaybackCaption(nowSeconds, footageNodeVisualSummary(footage) || 'Linked footage');
    syncVideoToNarration(footage, nowSeconds, true);
  };

  const state = {
    audio, audioLayers, narrationAudioLayers, video: null, splitVideos: [], stage, playButton, stopButton, status,
    activeCards: [], currentFootageId: null, playing: false,
    clockTimer: null, clockStartedAt: 0, clockTime: 0, audioEnded: false, abortRetries: 0,
    scrubbing: false, scrubWasPlaying: false, scrubCleanup: null,
    totalPlaybackDuration: initialPlaybackDuration,
    progressInput: null, progressLabel: null, updatePlaybackProgress: null,
    error: false, node, boardLayer, setStage, playbackTimelineOwner,
    lastPreloadedFor: undefined,
    releaseVideoPool: () => videoPool.forEach(releasePooledVideo),
    actKey: String(actKey),
    sceneId: String(playbackNode?.sceneId || node?.sceneId || ''),
  };
  panel._actBoardPlaybackState = state;
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
  // Keep the transport beside the Play/Pause and Stop controls, rather than
  // after the preview stage and footage track. Move the status after the
  // progress control so the transport reads as one compact inline row.
  controls.appendChild(progressWrap);
  controls.appendChild(status);
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
    renderPlaybackCaption(next);
    syncAudioLayers(next, true);
    syncFootageCutLayers(next, true);
    updateAtTime();
    state.updatePlaybackProgress();
  };
  // Rerenders triggered by background media generation can replace this
  // playback panel. Expose the seek method so the replacement can resume at
  // the exact shared scene-clock position instead of restarting at zero.
  state.seekPlaybackProgress = seekPlaybackProgress;
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
    setActBoardPlaybackPlayButton(playButton, false);
    stopButton.disabled = false;
    stage.classList.remove('playing');
    if (state.clockTimer) {
      clearInterval(state.clockTimer);
      state.clockTimer = null;
    }
    audio.pause();
    state.narrationAudioLayers?.forEach(layer => layer.element.pause());
    state.video?.pause();
    pauseActBoardSplitVideos(state);
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
    // Keep the canvas rails and this playback panel on the same scene clock.
    // The owner fans this update out to every currently connected narration
    // and footage rail, so the marker moves continuously while playing and
    // also follows scrubbing/seek events.
    playbackTimelineOwner?._actBoardSetScenePlayheadTime?.(now);
    syncAudioLayers(now);
    syncFootageCutLayers(now);
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
      // Hold the last frame only across the tick that lands on the end of the
      // sequence. This used to have no upper bound, so whenever narration or
      // music ran past the final clip it re-seeked that clip on every tick for
      // the remainder of the track - which is what made the last shot stutter
      // and appear to loop instead of ending.
      if (finalFootage && now >= finalEnd - 0.05
        && now < finalEnd + ACT_BOARD_PLAYBACK_FINAL_HOLD_SECONDS) {
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
    const card = actBoardNodeCard(boardLayer, current.id);
    if (card) {
      card.classList.add('act-board-playback-active');
      state.activeCards.push(card);
    }
    setStage(current, now);
    preloadUpcomingFootage(current);
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
      // Whichever branch advanced the clock, the caption follows it. It used
      // to render only in the chained-narration branch, so a single-segment
      // scene - the common case - froze on the first words.
      renderPlaybackCaption(state.clockTime);
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
    setActBoardPlaybackPlayButton(state.playButton, true);
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
    pauseActBoardSplitVideos(state);
    state.audioLayers?.forEach(layer => layer.element.pause());
    setActBoardPlaybackPlayButton(state.playButton, false);
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
    // The scene rails and playback panel share one clock. When Space starts
    // a paused scene, honor the current rail playhead rather than the stale
    // audio element position from the previous pause.
    if (!(actBoardPlaybackState === state && state.playing)) {
      const sharedSeconds = Number(playbackTimelineOwner?._actBoardScenePlayheadSeconds);
      if (Number.isFinite(sharedSeconds)) {
        state.clockTime = Math.max(0, Math.min(
          state.totalPlaybackDuration, sharedSeconds,
        ));
      }
    }
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
      pauseActBoardSplitVideos(state);
      state.audioLayers?.forEach(layer => layer.element.pause());
      setActBoardPlaybackPlayButton(state.playButton, false);
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
    setActBoardPlaybackPlayButton(state.playButton, true);
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
      const available = Math.max(0, Number.isFinite(duration) && duration > 0
        ? duration - sourceIn : selectedDuration);
      const target = sourceIn + Math.min(
        Math.max(0, state.clockTime), Math.max(0, available - 0.01),
      );
      if (Number.isFinite(duration) && duration > 0
        && Math.abs(current - target) > 0.08) {
        audio.currentTime = target;
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
  // A footage card can be selected from its timeline segment while another
  // node is still focused. Clear the old visual selection across the whole
  // Act Board first so the blue active treatment never lingers on a card after
  // the presenter moves to a different node.
  const board = boardLayer.closest('.storyboard-act-board-view') || boardLayer;
  board.querySelectorAll('.storyboard-act-board-node-footage.act-board-footage-selected')
    .forEach(card => card.classList.remove('act-board-footage-selected'));
  board.querySelectorAll('.storyboard-act-board-footage-track-segment.selected')
    .forEach(segment => segment.classList.remove('selected'));
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

function refreshActBoardSelectedVisualDom(actKey, node) {
  if (!node?.id) return false;
  const visual = actBoardVisualForKey(node, node.selectedVisualKey);
  if (!visual || !(visual.url || visual.thumbnailUrl)) return false;
  const board = document.querySelector('.storyboard-act-board-view');
  if (!board) return false;
  const visualKey = String(node.selectedVisualKey || '');
  const titleParts = actBoardFootageNodeTitleParts(actKey, node);
  // Gallery selection is intentionally a targeted DOM update. Keep the
  // caption in the canvas node in lockstep with the newly selected visual
  // without forcing a full board rerender. Scene-level duplicate previews are
  // no longer mounted, so there is no second caption/media DOM to refresh.
  board.querySelectorAll(
    `.storyboard-act-board-node-footage[data-node-id="${String(node.id).replace(/"/g, '\\"')}"] .storyboard-act-board-footage-node-fragment-title`,
  ).forEach(title => {
    const narrationRow = title.querySelector('.storyboard-act-board-footage-node-fragment-narration');
    const detailRow = title.querySelector('.storyboard-act-board-footage-node-fragment-detail');
    const narrationLabel = narrationRow?.querySelector('.storyboard-act-board-node-fragment-label');
    const narrationText = narrationRow?.querySelector('.storyboard-act-board-node-fragment-text');
    if (narrationRow) {
      narrationRow.hidden = !titleParts.narration;
      if (narrationLabel) narrationLabel.textContent = 'Narration:';
      if (narrationText) narrationText.textContent = titleParts.narration;
    }
    if (detailRow) detailRow.textContent = titleParts.detail;
    title.hidden = !titleParts.hasTitle;
  });
  board.querySelectorAll('.storyboard-act-board-footage-thumb').forEach(button => {
    button.classList.toggle('selected', button.dataset.visualKey === visualKey);
  });
  const updateMedia = container => {
    const existing = container.querySelector('video, img');
    if (!existing) return false;
    const wantsVideo = visual.kind === 'video';
    const isVideo = existing.tagName === 'VIDEO';
    if (wantsVideo !== isVideo) return false;
    const source = visual.url || visual.thumbnailUrl;
    if (wantsVideo) {
      if (existing.src !== source) {
        existing.src = source;
        existing.load?.();
      }
      existing.poster = visual.thumbnailUrl || '';
    } else if (existing.src !== source) {
      existing.src = source;
    }
    return true;
  };
  const preview = board.querySelector(
    `.storyboard-act-board-node[data-node-id="${String(node.id).replace(/"/g, '\\"')}"] .storyboard-act-board-footage-node-preview`,
  );
  let updated = Boolean(preview && updateMedia(preview));
  board.querySelectorAll('.storyboard-act-board-footage-featured').forEach(featured => {
    updated = updateMedia(featured) || updated;
    const sourceBadge = featured.querySelector('.storyboard-act-board-footage-featured-source');
    if (sourceBadge) {
      const source = visual.source || (visual.generatedIndex != null ? 'AI-generated' : '');
      if (source) {
        const techniques = Array.isArray(visual.techniques) ? visual.techniques.filter(Boolean) : [];
        const phrase = actBoardVisualDisplayPhrase(node, visual);
        sourceBadge.textContent = [
          source,
          phrase,
          ...(source === 'AI-generated' && techniques.length
            ? [techniques.join(', ')] : []),
        ].filter(Boolean).join(' · ');
      }
    }
  });
  board.querySelectorAll('.storyboard-act-board-image-generation-shot-plan-value')
    .forEach(value => {
      if (value.dataset.nodeId === String(node.id)) renderActBoardImageShotPlanRows(value, node, visual);
    });
  // The selected visual IS the reference now (see actBoardReferenceVisual),
  // so a selection made through this in-place path needs the reference row/
  // summary thumb refreshed too, same as the full rerender path already does.
  syncActBoardReferenceInputRows(node);
  const aiSelected = visual.generatedIndex != null || visual.source === 'AI-generated'
    || (node.mediaOrigin === 'generated' && node.mediaUrl);
  board.querySelectorAll('.storyboard-act-board-node-footage[data-node-id]')
    .forEach(card => {
      if (card.dataset.nodeId !== String(node.id)) return;
      card.classList.toggle('storyboard-act-board-node-ai-selected', Boolean(aiSelected));
    });
  return updated;
}

function refreshActBoardFootageLoadingDom(node) {
  if (!node?.id) return false;
  const selector = `.storyboard-act-board-node-footage[data-node-id="${String(node.id).replace(/"/g, '\\"')}"]`;
  const cards = document.querySelectorAll(selector);
  if (!cards.length) return false;
  cards.forEach(card => {
    // Background stock searches resolve their concrete query after the card
    // has already mounted. Mirror that query into the editable panel input,
    // but never replace text while the presenter is actively editing it.
    const queryInput = card.querySelector('.storyboard-act-board-footage-search-input');
    if (queryInput && document.activeElement !== queryInput) {
      queryInput.value = node.query || node.filmabilityQuery || node.fragment || '';
    }
    const rail = card.querySelector('.storyboard-act-board-footage-thumb-rail');
    if (!rail) return;
    let placeholderCreated = false;
    const syncPlaceholder = (className, text, active) => {
      let placeholder = rail.querySelector(`.${className.replace(/ /g, '.')}`);
      if (active && !placeholder) {
        placeholder = document.createElement('div');
        placeholder.className = className;
        placeholder.setAttribute('aria-live', 'polite');
        placeholder.textContent = text;
        rail.prepend(placeholder);
        placeholderCreated = true;
      } else if (!active) {
        placeholder?.remove();
      }
    };
    syncPlaceholder(
      'storyboard-act-board-footage-generating-placeholder stock-footage',
      'Stock footage searching…', node.status === 'generating',
    );
    syncPlaceholder(
      'storyboard-act-board-footage-generating-placeholder image-generation',
      'Image generating…', node.generationStatus === 'generating-images',
    );
    // The footage content panel stacks the search/generation inputs below the
    // gallery, and the featured box is tall, so a freshly-appearing thumb rail
    // of pulsing placeholders can start life below the panel's fold. When the
    // placeholders first appear inside the selected-node/scene panels (never
    // the canvas card), bring the rail into that panel's own scroll viewport
    // once so the presenter can see generation is under way.
    if (placeholderCreated) {
      const scrollHost = card.closest(
        '.storyboard-act-board-full-playback-node-details-content,'
        + ' .storyboard-act-board-selected-scene-playback-mount',
      );
      if (scrollHost) {
        try { rail.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (err) { /* optional */ }
      }
    }
  });
  return true;
}

// Keep canvas playback-rail selection in sync with node selection. Footage
// already uses its own helper above; narration and audio rails identify their
// segments with data-audio-node-id, so handle all three node types here.
function highlightActBoardPlaybackTrackNode(boardLayer, node) {
  if (!boardLayer || !node?.id) return;
  const board = boardLayer.closest('.storyboard-act-board-view') || boardLayer;
  board.querySelectorAll('.storyboard-act-board-footage-track-segment.selected')
    .forEach(segment => segment.classList.remove('selected'));
  let selector = '';
  if (node.type === 'footage') selector = `[data-footage-node-id="${node.id}"]`;
  if (node.type === 'narration' || node.type === 'audio') {
    selector = `[data-audio-node-id="${node.id}"]`;
  }
  if (!selector) return;
  boardLayer.querySelectorAll(selector).forEach(segment => segment.classList.add('selected'));
}

// A narration transcript is rendered in more than one place on the Act
// Board: inside the node's side preview and, for an open scene, in the scene
// narration slides above the canvas narration track.  Keep the timing
// highlighter pointed at all of those live renderings so dragging a footage
// segment gives the same word-level feedback wherever the transcript is
// visible.  The data attribute is intentionally used instead of a global
// first-match selector because multiple narration nodes/scenes can coexist.
function actBoardNarrationTimingRoots(boardLayer, narrationNode) {
  if (!boardLayer || !narrationNode?.id) return [];
  const id = String(narrationNode.id);
  const card = Array.from(boardLayer.querySelectorAll(
    '.storyboard-act-board-node[data-node-id]',
  )).find(item => item.dataset.nodeId === id) || null;
  const roots = [];
  if (card) {
    roots.push(
      card.querySelector('.storyboard-act-board-narration-primary'),
      card.querySelector('.storyboard-act-board-narration-side-preview-text'),
    );
  }
  // Scene narration slides carry the same node id, and may be the only
  // transcript rendering available when node bodies are hidden.
  boardLayer.querySelectorAll(
    '[data-act-board-narration-node-id]:not([data-act-board-narration-suggested])',
  ).forEach(root => {
    if (root.dataset.actBoardNarrationNodeId === id) roots.push(root);
  });
  return Array.from(new Set(roots.filter(Boolean)));
}

function highlightActBoardNarrationTiming(boardLayer, narrationNode, startSeconds, endSeconds) {
  if (!boardLayer || !narrationNode) return [];
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
  const narrationRoots = actBoardNarrationTimingRoots(boardLayer, narrationNode);
  if (!narrationRoots.length) return [];
  const labels = [];
  narrationRoots.forEach(narrationRoot => {
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
  });
  return labels;
}

function clearActBoardNarrationTimingHighlight(boardLayer, narrationNode) {
  if (!boardLayer || !narrationNode) return;
  const narrationRoots = actBoardNarrationTimingRoots(boardLayer, narrationNode);
  narrationRoots.forEach(narrationRoot => narrationRoot.querySelectorAll(
    '[data-narration-fragment], [data-narration-word-index]').forEach(fragmentEl => {
    fragmentEl.classList.remove('storyboard-act-board-narration-timing-highlight');
  }));
}

// Return the filmable phrases/entities currently highlighted for one
// narration segment. Prefer the rendered slide so this summary exactly
// matches what the presenter sees; fall back to the persisted phrase lists
// when the scene slide is not mounted yet.
function actBoardHighlightedNarrationEntities(boardLayer, narrationNode) {
  if (!narrationNode?.id) return [];
  const id = String(narrationNode.id);
  const labels = [];
  const seen = new Set();
  const add = value => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    const key = actBoardNarrationSpanTextKey(text);
    if (!key || seen.has(key)) return;
    seen.add(key);
    labels.push(text);
  };
  const roots = boardLayer
    ? Array.from(boardLayer.querySelectorAll(
      '[data-act-board-narration-node-id]:not([data-act-board-narration-suggested])'))
      .filter(root => root.dataset.actBoardNarrationNodeId === id)
    : [];
  roots.forEach(root => {
    root.querySelectorAll(
      '[data-narration-fragment].storyboard-act-board-narration-phrase-has-footage,'
        + '[data-narration-fragment].storyboard-act-board-narration-span-depictable,'
        + '[data-narration-fragment].storyboard-act-board-narration-span-abstract,'
        + '[data-narration-fragment].storyboard-act-board-narration-phrase-selected',
    ).forEach(fragment => add(fragment.dataset.narrationFragment || fragment.textContent));
  });
  if (labels.length) return labels;
  [
    narrationNode.footageSuggestedPhrases,
    narrationNode.userFilmablePhrases,
    narrationNode.selectedFootagePhrases,
    narrationNode.narrationSpans,
  ].forEach(values => (Array.isArray(values) ? values : []).forEach(item => {
    if (item?.bucket === 'ignore' || item?.bucket === 'pending') return;
    add(typeof item === 'string' ? item : item?.text || item?.fragment);
  }));
  return labels;
}

function refreshActBoardPlaybackDurations() {
  // All playback rails share one duration reader. Refresh their geometry
  // together whenever any footage, narration, or audio segment changes so a
  // newly longest rail immediately becomes the common scale.
  const tracks = Array.from(document.querySelectorAll('.storyboard-act-board-footage-track'));
  tracks.forEach(track => {
    if (typeof track._actBoardRefresh === 'function') track._actBoardRefresh();
  });
  // The footage rail can extend the shared owner duration after the narration
  // rail has already refreshed (the DOM order is narration, then footage).
  // A second lightweight pass makes both rails converge immediately.
  tracks.forEach(track => {
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
  // Keep every visible narration player aligned with the same source window
  // edited by the timing/source controls. This includes the compact canvas
  // preview and the full node-content panel audio element.
  document.querySelectorAll('.storyboard-act-board-narration-node-preview-audio, .storyboard-act-board-node-audio, .storyboard-act-board-full-playback-node-detail-audio').forEach(player => {
    if (player.dataset.audioNodeId === String(node.id)
      || player.closest('[data-node-id]')?.dataset.nodeId === String(node.id)) {
      if (typeof player._actBoardSyncTiming === 'function') {
        syncActBoardAudioPreviewSegment(player, node, true);
      }
    }
  });
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
  const allLinked = Array.isArray(linkedOverride)
    ? linkedOverride : orderedActBoardLinkedFootage(actKey, narrationNode);
  // An explicitly supplied list represents an existing track, even when all
  // of its segments have been hidden with Delete. Keep the empty rail mounted
  // so the user can drag a node back onto it later.
  if (!allLinked.length && linkedOverride === null) return null;
  const linked = allLinked.filter(actBoardTrackNodeVisible);
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
  label.textContent = 'Footage';
  track.appendChild(label);
  const strip = document.createElement('div');
  strip.className = 'storyboard-act-board-footage-track-strip';
  let total = Math.max(
    0.001,
    sharedTimeline ? 0 : (narrationNode ? 0 : 10),
    readTimelineOwnerDuration(),
    sharedTimeline ? 0 : Number(timelineOwner?.durationSeconds) || 0,
    ...linked.filter(actBoardTrackNodeVisible).map(node => (Number(node.startSeconds) || 0)
      + Math.max(0.5, Number(node.durationSeconds) || 1)),
  );
  track.dataset.actKey = actKey;
  track.dataset.trackKind = 'footage';
  const trackSceneId = timelineOwner?.sceneId
    || (timelineOwner && !timelineOwner.type ? timelineOwner.id : '')
    || narrationNode?.sceneId || '';
  track.dataset.sceneId = String(trackSceneId);
  if (timelineOwner?.id) track.dataset.timelineOwnerId = timelineOwner.id;
  if (timelineOwner) timelineOwner.timelineDurationSeconds = total;
  // Footage has the same draggable shared playhead as narration. Clicking or
  // dragging the rule (or an empty part of this rail) changes the scene time.
  const footagePlayheadControl = buildActBoardScenePlayheadControl(
    strip,
    track,
    timelineOwner,
    () => total,
    'Footage sequence playhead',
  );
  const setFootagePlayheadVisual = footagePlayheadControl?.setVisual || (() => {});
  track._actBoardSetFootagePlayheadTime = setFootagePlayheadVisual;
  if (timelineOwner) {
    registerActBoardScenePlayheadTrack(timelineOwner, track, {
      footageVisual: setFootagePlayheadVisual,
    });
    setFootagePlayheadVisual(timelineOwner._actBoardScenePlayheadSeconds || 0);
  }
  // While a segment is lifted, show the exact time window that will be used
  // when it is released.  This is separate from the node-drop preview below:
  // the lifted segment follows the pointer, while this outline remains in the
  // rail and makes its eventual drop position easy to read.
  const liftDropPreview = document.createElement('span');
  liftDropPreview.className = 'storyboard-act-board-track-lift-drop-indicator';
  liftDropPreview.hidden = true;
  liftDropPreview.setAttribute('aria-hidden', 'true');
  strip.appendChild(liftDropPreview);
  const setLiftDropPreview = (start, duration) => {
    const safeDuration = Math.max(0.5, Number(duration) || 1);
    const maxStart = Math.max(0, total - safeDuration);
    const safeStart = Math.max(0, Math.min(maxStart, Number(start) || 0));
    const scale = Math.max(0.001, total);
    liftDropPreview.style.left = `${(safeStart / scale) * 100}%`;
    liftDropPreview.style.width = `${Math.min(100, (safeDuration / scale) * 100)}%`;
    liftDropPreview.hidden = false;
  };
  const clearLiftDropPreview = () => { liftDropPreview.hidden = true; };
  const segmentEntries = [];
  let selectedTrackNode = null;
  // Selecting a footage segment should select the same footage node in the
  // persistent node-content panel. Track segments are rendered separately
  // from the canvas cards, so explicitly mirror the selection here instead of
  // relying on a card click proxy.
  const showSelectedFootageNodeDetails = footage => {
    if (!footage) return;
    const act = currentArcSections.find(item => item.key === actKey)
      || { key: actKey, label: actKey };
    const boardView = boardLayer?.closest('.storyboard-act-board-view');
    boardView?._actBoardFullPlaybackPanel?._actBoardFullPlayback
      ?.showNodeDetails?.(actKey, act, footage);
  };
  const removeSelectedTrackSegment = () => {
    const entry = segmentEntries.find(item => item.footage === selectedTrackNode);
    if (!entry) return false;
    const footage = entry.footage;
    footage.trackHidden = true;
    persistActBoardTrackNode(footage);
    clearFootageCoverage(footage);
    entry.segment.remove();
    entry.gap.remove();
    segmentEntries.splice(segmentEntries.indexOf(entry), 1);
    selectedTrackNode = null;
    track.classList.remove('has-selected-segment');
    updateTrackLayout();
    refreshActBoardPlaybackDurations();
    saveDebugSession();
    // This rail is one of several views of the same data: the playback panel
    // mirrors it and the scene/full playback read the nodes. Editing this DOM
    // alone left the segment on every other view until an unrelated rebuild.
    syncActBoardTrackRemoval(actKey, footage);
    return true;
  };
  track.tabIndex = 0;
  track.addEventListener('keydown', event => {
    if ((event.code === 'Space' || event.key === ' ')
      && !event.target.closest('input, textarea, select, button, a')) {
      if (timelineOwner?._actBoardToggleNarrationPlayback) {
        event.preventDefault();
        event.stopPropagation();
        timelineOwner._actBoardToggleNarrationPlayback();
      }
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace')
      && removeSelectedTrackSegment()) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
  track._actBoardDropNode = (node, clientX) => {
    if (!node || node.type !== 'footage' || node.actKey !== actKey
      || (track.dataset.sceneId && node.sceneId !== track.dataset.sceneId)) return false;
    const rect = strip.getBoundingClientRect();
    if (!(rect.width > 0)) return false;
    const ratio = Math.max(0, Math.min(1, (Number(clientX) - rect.left) / rect.width));
    const duration = Math.max(0.5, Number(node.durationSeconds) || 1);
    const start = Math.max(0, ratio * total);
    node.startSeconds = Number(start.toFixed(2));
    node.trackHidden = false;
    node.timingWasManuallyAdjusted = true;
    node.durationWasSuggested = false;
    persistActBoardTrackNode(node);
    if (timelineOwner) timelineOwner.timelineDurationSeconds = Math.max(
      Number(timelineOwner.timelineDurationSeconds) || 0, start + duration,
    );
    refreshActBoardLinkedAudioTimingForTarget(node);
    // Dropping a free footage node onto the rail is also a positioning edit;
    // give the presenter the same word-coverage feedback as a drag/resize.
    showFootageCoverage(node, start, start + duration);
    return true;
  };
  track._actBoardCanDropNode = node => Boolean(node && node.type === 'footage'
    && node.actKey === actKey
    && (!track.dataset.sceneId || node.sceneId === track.dataset.sceneId));
  const dropPreview = document.createElement('div');
  dropPreview.className = 'storyboard-act-board-footage-track-drop-preview';
  dropPreview.hidden = true;
  dropPreview.setAttribute('aria-hidden', 'true');
  strip.appendChild(dropPreview);
  track._actBoardClearDropPreview = () => {
    dropPreview.hidden = true;
  };
  track._actBoardShowDropPreview = (node, clientX) => {
    if (!track._actBoardCanDropNode(node)) {
      track._actBoardClearDropPreview();
      return false;
    }
    const rect = strip.getBoundingClientRect();
    if (!(rect.width > 0)) return false;
    const duration = Math.max(0.5, Number(node.durationSeconds) || 1);
    const widthPercent = Math.min(100, (duration / Math.max(0.001, total)) * 100);
    const startPercent = Math.max(0, Math.min(100 - widthPercent,
      ((Number(clientX) - rect.left) / rect.width) * 100));
    dropPreview.style.left = `${startPercent}%`;
    dropPreview.style.width = `${widthPercent}%`;
    dropPreview.title = `Drop ${duration.toFixed(1)}s footage segment here`;
    dropPreview.hidden = false;
    // Return the ghost itself (still truthy for existing callers) so the drag
    // can line the card up with where the segment will actually land.
    return dropPreview;
  };
  const footageCoverageNarration = footage =>
    actBoardNarrationForNode(actKey, footage)
      || (narrationNode?.sceneId && footage?.sceneId
        && narrationNode.sceneId !== footage.sceneId
        ? null : narrationNode)
      || actBoardNodesForAct(actKey).find(node => node.type === 'narration'
        && (!footage?.sceneId || node.sceneId === footage.sceneId))
      || null;
  const footageCoverageNarrations = footage => {
    const direct = footageCoverageNarration(footage);
    const sceneId = footage?.sceneId || direct?.sceneId || narrationNode?.sceneId || '';
    const sceneNarrations = actBoardNodesForAct(actKey)
      .filter(node => node.type === 'narration'
        && (!sceneId || node.sceneId === sceneId))
      .sort((a, b) => (Number(a.startSeconds) || 0) - (Number(b.startSeconds) || 0));
    const ordered = direct ? [direct, ...sceneNarrations] : sceneNarrations;
    return Array.from(new Map(ordered.filter(Boolean).map(node => [node.id, node])).values());
  };
  const showFootageCoverage = (footage, start, end) => {
    const coverageNarrations = footageCoverageNarrations(footage);
    if (!coverageNarrations.length) {
      timingCue.textContent = 'Narration coverage: no matched phrase';
      return [];
    }
    const covered = [];
    coverageNarrations.forEach(coverageNarration => {
      const narrationStart = Math.max(0, Number(coverageNarration.startSeconds) || 0);
      const narrationDuration = Math.max(0.5,
        actBoardNarrationSegmentDuration(coverageNarration)
          || estimateActBoardNarrationSeconds(
            coverageNarration.transcript || coverageNarration.text,
          ));
      const narrationEnd = narrationStart + narrationDuration;
      if (end <= narrationStart || start >= narrationEnd) return;
      const labels = highlightActBoardNarrationTiming(
        boardLayer,
        coverageNarration,
        Math.max(0, start - narrationStart),
        Math.max(0, end - narrationStart),
      );
      labels.forEach(label => {
        if (!covered.includes(label)) covered.push(label);
      });
    });
    timingCue.textContent = covered.length
      ? `Narration coverage: ${covered.join(' · ')}`
      : 'Narration coverage: no matched phrase';
    return covered;
  };
  const clearFootageCoverage = footage => {
    footageCoverageNarrations(footage).forEach(coverageNarration =>
      clearActBoardNarrationTimingHighlight(boardLayer, coverageNarration));
  };
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
    if (actBoardNodeIsNewlyCreated(footage.id)) {
      playActBoardAppearAnimation(segment, 'act-board-segment-appearing');
    }
    segment.setAttribute('role', 'button');
    segment.tabIndex = 0;
    segment.title = `${footage.fragment || 'Footage'} · ${Number(footage.durationSeconds || 0).toFixed(1)}s · drag to move · press Delete to remove from track`;
    const applyFootageTrackPreview = () => {
      const selectedMedia = actBoardSelectedFootageMedia(footage);
      const previewUrl = selectedMedia?.thumbnailUrl
        || (selectedMedia?.kind === 'image' ? selectedMedia?.url : '')
        || footage.mediaThumbnailUrl || '';
      if (previewUrl) {
        const safeUrl = String(previewUrl).replace(/"/g, '\\"');
        segment.style.setProperty('--footage-track-preview-image', `url("${safeUrl}")`);
        segment.classList.add('has-preview');
      } else {
        segment.style.removeProperty('--footage-track-preview-image');
        segment.classList.remove('has-preview');
      }
    };
    applyFootageTrackPreview();
    // A shaped cut is audio spilling past this segment's picture, so it is
    // drawn as a tab hanging off the edge the sound crosses: a J-cut reaches
    // back before the segment starts, an L-cut runs on past its end. Clicking
    // the tab drops that one cut without touching the rest of the arrange.
    // One marker per side: a J tab at the head when this clip's audio leads
    // its picture, an L tab at the tail when it runs on past it. A crossfade
    // gives the outgoing clip a tail and the incoming clip a lead, so a clip
    // in the middle of two crossfades legitimately carries both. Each tab
    // removes only its own side.
    [['j-cut', Number(footage.audioLeadSeconds) || 0, 'audioLeadSeconds'],
      ['l-cut', Number(footage.audioTailSeconds) || 0, 'audioTailSeconds']].forEach(([kind, seconds, field]) => {
      if (!footage.transitionWasSuggested || !(seconds > 0)) return;
      const isLead = kind === 'j-cut';
      const marker = document.createElement('button');
      marker.type = 'button';
      marker.className = `storyboard-act-board-footage-track-audio-cut ${kind}`;
      marker.dataset.cutKind = kind;
      marker.textContent = isLead ? 'J' : 'L';
      marker.title = isLead
        ? `J-cut · this clip's audio starts ${seconds.toFixed(2)}s before its picture · click to remove`
        : `L-cut · this clip's audio runs ${seconds.toFixed(2)}s past its picture${
          footage.transitionReason === 'floor'
            ? ' · covers the next shot arriving after its phrase because this one holds its 1s minimum'
            : ''} · click to remove`;
      marker.setAttribute('aria-label', marker.title);
      // The segment itself is draggable and Delete-able; neither belongs to
      // the marker.
      marker.addEventListener('pointerdown', event => event.stopPropagation());
      marker.addEventListener('keydown', event => event.stopPropagation());
      marker.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        footage[field] = 0;
        if (!(Number(footage.audioLeadSeconds) || 0) && !(Number(footage.audioTailSeconds) || 0)) {
          footage.transitionWasSuggested = false;
          footage.transitionKind = '';
          footage.transitionReason = '';
        }
        saveDebugSession();
        marker.remove();
      });
      segment.appendChild(marker);
    });
    // Narration-relative cut. Distinct glyphs from the J/L audio cuts, because
    // both systems can shape the same run: A = arrives before its entity is
    // spoken, H = holds on screen after it. Clicking restores the hard cut for
    // this boundary only.
    // Derived from the shot's ACTUAL offset from its hard cut, never from the
    // stored intent. orderedActBoardSceneFootage re-enforces contiguity in
    // chain order and can legitimately undo an anticipate; four attempts at
    // keeping a stored flag in sync with that all leaked, leaving a marker
    // advertising a transition the timeline no longer had. Reading the offset
    // makes the marker true by construction: no offset, no marker.
    const hardStart = Number(footage.hardCutStartSeconds);
    const hardDuration = Number(footage.hardCutDurationSeconds);
    const startOffset = Number.isFinite(hardStart)
      ? (Number(footage.startSeconds) || 0) - hardStart : 0;
    const durationOffset = Number.isFinite(hardDuration)
      ? (Number(footage.durationSeconds) || 0) - hardDuration : 0;
    const realCutSeconds = footage.narrationCutKind === 'anticipate'
      ? Math.abs(startOffset) : Math.abs(durationOffset);
    if (footage.narrationCutKind
      && realCutSeconds > ACT_BOARD_TRACK_SEAM_TOLERANCE_SECONDS) {
      const anticipate = footage.narrationCutKind === 'anticipate';
      const seconds = realCutSeconds;
      const narrationMarker = document.createElement('button');
      narrationMarker.type = 'button';
      narrationMarker.className = 'storyboard-act-board-footage-track-narration-cut '
        + (anticipate ? 'anticipate' : 'linger');
      narrationMarker.dataset.cutKind = footage.narrationCutKind;
      narrationMarker.textContent = anticipate ? 'A' : 'H';
      narrationMarker.title = anticipate
        ? `Anticipate \u00b7 this shot arrives ${seconds.toFixed(2)}s before its entity is spoken \u00b7 click to restore the hard cut`
        : `Hold \u00b7 this shot stays ${seconds.toFixed(2)}s after its entity is spoken \u00b7 click to restore the hard cut`;
      narrationMarker.setAttribute('aria-label', narrationMarker.title);
      narrationMarker.addEventListener('pointerdown', event => event.stopPropagation());
      narrationMarker.addEventListener('keydown', event => event.stopPropagation());
      narrationMarker.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const neighbour = actBoardNodesForAct(actKey)
          .find(item => item.id === footage.narrationCutNeighbourId) || null;
        removeActBoardNarrationCut(footage, neighbour);
        saveDebugSession();
        rerenderActBoard({ preservePlayback: true });
      });
      segment.appendChild(narrationMarker);
    }
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
      if (selectedTrackNode && selectedTrackNode !== footage) clearFootageCoverage(selectedTrackNode);
      selectedTrackNode = footage;
      track.classList.add('has-selected-segment');
      segmentEntries.forEach(item => item.segment.classList.toggle('selected', item.footage === footage));
      timelineOwner?._actBoardSetScenePlayheadTime?.(Math.max(0, Number(footage.startSeconds) || 0));
      highlightActBoardFootageNode(boardLayer, footage.id);
      showSelectedFootageNodeDetails(footage);
      segment.focus({ preventScroll: true });
      showFootageCoverage(
        footage,
        Math.max(0, Number(footage.startSeconds) || 0),
        Math.max(0, Number(footage.startSeconds) || 0)
          + Math.max(0.5, Number(footage.durationSeconds) || 1),
      );
    });
    segment.addEventListener('keydown', event => {
      if (event.code === 'Space' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        timelineOwner?._actBoardToggleNarrationPlayback?.();
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        event.stopPropagation();
        selectedTrackNode = footage;
        removeSelectedTrackSegment();
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectedTrackNode = footage;
        segmentEntries.forEach(item => item.segment.classList.toggle('selected', item.footage === footage));
        highlightActBoardFootageNode(boardLayer, footage.id);
        showSelectedFootageNodeDetails(footage);
        showFootageCoverage(
          footage,
          Math.max(0, Number(footage.startSeconds) || 0),
          Math.max(0, Number(footage.startSeconds) || 0)
            + Math.max(0.5, Number(footage.durationSeconds) || 1),
        );
      }
    });
    segment.addEventListener('dblclick', event => {
      event.preventDefault();
      event.stopPropagation();
      const card = actBoardNodeCard(boardLayer, footage.id);
      card?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
    });
    const entry = {
      footage, gap, segment, durationLabel, startHandle, endHandle, index,
      applyFootageTrackPreview,
    };
    wireActBoardTrackSegmentDrag({
      segment,
      track,
      strip,
      entry,
      entries: segmentEntries,
      getNode: item => item.footage,
      getStart: item => item.startSeconds,
      getDuration: item => item.durationSeconds,
      getTotal: () => total,
      applyTiming: (item, start, duration) => {
        item.startSeconds = Number(start.toFixed(2));
        item.timingWasManuallyAdjusted = true;
        item.durationWasSuggested = false;
        item.alignedToNarration = false;
        if (timelineOwner) timelineOwner.timelineDurationSeconds = Math.max(
          Number(timelineOwner.timelineDurationSeconds) || 0, item.startSeconds + duration,
        );
        refreshActBoardFootageTrackForNode(item);
      },
      // The footage rail declares updateTrackLayout after its segment loop;
      // defer lookup until the pointer event runs so construction is safe.
      updateLayout: (...args) => updateTrackLayout(...args),
      onCoverage: (item, start, end) => showFootageCoverage(item, start, end),
      clearCoverage: clearFootageCoverage,
      onCommitReorder: (ordered, item) => {
        const scene = actBoardSceneForNode(actKey, item);
        if (!reorderActBoardFootageSequence(actKey, ordered.map(value => value.footage), scene)) return;
        saveDebugSession();
        queueActBoardScenePatch(actKey, scene?.id || item.sceneId, { persist: true });
      },
      onCommitTiming: item => {
        saveDebugSession();
        updateTrackLayout();
      },
    });
    const wireBoundaryDrag = (handle, edge) => {
      handle.addEventListener('pointerdown', event => {
        event.preventDefault();
        event.stopPropagation();
        if (selectedTrackNode && selectedTrackNode !== footage) clearFootageCoverage(selectedTrackNode);
        selectedTrackNode = footage;
        segmentEntries.forEach(item => item.segment.classList.toggle('selected', item.footage === footage));
        showFootageCoverage(
          footage,
          Math.max(0, Number(footage.startSeconds) || 0),
          Math.max(0, Number(footage.startSeconds) || 0)
            + Math.max(0.5, Number(footage.durationSeconds) || 1),
        );
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
        const minimumDuration = ACT_BOARD_MIN_SHOT_SECONDS;
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
          const covered = showFootageCoverage(footage, coverageStart, coverageEnd);
          if (!footageCoverageNarration(footage)) timingCue.textContent = 'Footage timing adjusted';
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
      ...linked.filter(actBoardTrackNodeVisible).map(node => (Number(node.startSeconds) || 0)
        + Math.max(0.5, Number(node.durationSeconds) || 1)),
    );
    if (timelineOwner) timelineOwner.timelineDurationSeconds = total;
    let cursor = 0;
    segmentEntries.forEach(({ footage, gap, segment, durationLabel }) => {
      const start = Math.max(0, Number(footage.startSeconds) || 0);
      const duration = Math.max(0.5, Number(footage.durationSeconds) || 1);
      const entry = segmentEntries.find(item => item.segment === segment);
      entry?.applyFootageTrackPreview?.();
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
    const sharedSeconds = timelineOwner
      ? Number(timelineOwner._actBoardScenePlayheadSeconds) : 0;
    setFootagePlayheadVisual(Number.isFinite(sharedSeconds) ? sharedSeconds : 0);
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
  onSelect = null,
  showSourceEditor = false,
}) {
  const allNodes = (Array.isArray(entries) ? entries : []).filter(Boolean);
  if (!allNodes.length) return null;
  const nodes = allNodes.filter(actBoardTrackNodeVisible);
  const track = document.createElement('div');
  track.className = `storyboard-act-board-footage-track storyboard-act-board-playback-audio-track storyboard-act-board-playback-${kind}-track`;
  track.dataset.trackKind = kind === 'narration' ? 'narration' : 'audio';
  track.dataset.actKey = actKey;
  const trackSceneId = timelineOwner?.sceneId
    || (timelineOwner && !timelineOwner.type ? timelineOwner.id : '')
    || narrationNode?.sceneId || '';
  track.dataset.sceneId = String(trackSceneId);
  const label = document.createElement('div');
  label.className = 'storyboard-act-board-footage-track-label';
  label.textContent = labelText;
  if (labelText) track.appendChild(label);
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
    ...nodes.filter(actBoardTrackNodeVisible).map(node => readStart(node) + readDuration(node)),
  );
  if (timelineOwner) timelineOwner.timelineDurationSeconds = sharedTimeline
    ? total : Math.max(Number(timelineOwner.timelineDurationSeconds) || 0, total);
  const segmentEntries = [];
  // Audio/music gets the same scene playhead as narration and footage. It is
  // a shared time marker, not an audio-source scrubber, so moving it here
  // changes where Space starts the scene playback without changing trims.
  let setAudioPlayheadVisual = () => {};
  if (kind !== 'narration') {
    const audioPlayheadControl = buildActBoardScenePlayheadControl(
      strip,
      track,
      timelineOwner,
      () => total,
      'Audio sequence playhead',
    );
    setAudioPlayheadVisual = audioPlayheadControl?.setVisual || (() => {});
    track._actBoardSetAudioPlayheadTime = setAudioPlayheadVisual;
    if (timelineOwner) {
      registerActBoardScenePlayheadTrack(timelineOwner, track, {
        audioVisual: setAudioPlayheadVisual,
      });
      setAudioPlayheadVisual(timelineOwner._actBoardScenePlayheadSeconds || 0);
    }
  }
  const timingCue = document.createElement('small');
  timingCue.className = 'storyboard-act-board-footage-track-timing-cue';
  timingCue.setAttribute('aria-live', 'polite');
  const gapLabel = kind === 'narration' ? 'No narration' : 'No audio';
  const expectedTrackNodeType = kind === 'narration' ? 'narration' : 'audio';
  const rememberedNarrationId = kind === 'narration' && trackSceneId
    ? actBoardSelectedNarrationSegmentByScene.get(String(trackSceneId)) : '';
  let selectedTrackNode = nodes.find(node => node.id === rememberedNarrationId) || null;
  const updateNarrationEntityCue = () => {
    if (kind !== 'narration') return;
    const current = selectedTrackNode || nodes[0] || null;
    const entities = current
      ? actBoardHighlightedNarrationEntities(boardLayer, current) : [];
    timingCue.textContent = entities.length
      ? `Narration entities: ${entities.join(' · ')}`
      : 'Narration entities: no entities highlighted';
  };
  let narrationTrackPlayhead = null;
  let narrationTrackPlayheadHitArea = null;
  let narrationTrackPlayheadSeconds = 0;
  if (kind === 'narration') {
    // There is one sequence playhead for the whole narration rail. Individual
    // source editors show only their waveform; this shared rule indicates the
    // absolute position across all narration segments.
    narrationTrackPlayhead = document.createElement('span');
    narrationTrackPlayhead.className = 'storyboard-act-board-narration-track-playhead';
    narrationTrackPlayhead.setAttribute('aria-hidden', 'true');
    narrationTrackPlayheadHitArea = document.createElement('span');
    narrationTrackPlayheadHitArea.className = 'storyboard-act-board-narration-track-playhead-hit-area';
    narrationTrackPlayheadHitArea.setAttribute('aria-label', 'Narration sequence playhead');
    narrationTrackPlayheadHitArea.title = 'Drag to choose where narration playback starts';
    narrationTrackPlayheadHitArea.setAttribute('role', 'slider');
    narrationTrackPlayheadHitArea.tabIndex = 0;
    strip.append(narrationTrackPlayhead, narrationTrackPlayheadHitArea);
  }
  const setNarrationTrackPlayheadVisual = seconds => {
    if (kind !== 'narration' || !narrationTrackPlayhead || !narrationTrackPlayheadHitArea) return;
    const safe = Math.max(0, Math.min(total, Number(seconds) || 0));
    narrationTrackPlayheadSeconds = safe;
    const ratio = total > 0 ? safe / total : 0;
    const percent = `${(ratio * 100).toFixed(3)}%`;
    narrationTrackPlayhead.style.left = percent;
    narrationTrackPlayheadHitArea.style.left = percent;
    narrationTrackPlayheadHitArea.setAttribute('aria-valuemin', '0');
    narrationTrackPlayheadHitArea.setAttribute('aria-valuemax', String(total));
    narrationTrackPlayheadHitArea.setAttribute('aria-valuenow', String(Number(safe.toFixed(2))));
  };
  const setScenePlayheadTime = seconds => {
    const safe = Math.max(0, Math.min(total, Number(seconds) || 0));
    if (timelineOwner) timelineOwner._actBoardScenePlayheadSeconds = safe;
    if (timelineOwner?._actBoardSetScenePlayheadTime) {
      timelineOwner._actBoardSetScenePlayheadTime(safe);
    } else {
      setNarrationTrackPlayheadVisual(safe);
    }
  };
  track._actBoardSetNarrationPlayheadTime = setScenePlayheadTime;
  track._actBoardSetScenePlayheadTime = setScenePlayheadTime;
  let playheadRegistration = null;
  if (timelineOwner && kind === 'narration') {
    playheadRegistration = registerActBoardScenePlayheadTrack(timelineOwner, track, {
      narrationVisual: setNarrationTrackPlayheadVisual,
    });
    timelineOwner._actBoardScenePlayheadSeconds = Math.max(
      0, Number(timelineOwner._actBoardScenePlayheadSeconds) || 0,
    );
    setNarrationTrackPlayheadVisual(timelineOwner._actBoardScenePlayheadSeconds);
  }
  // Keep a visible drop-window on the rail while a segment is lifted.  The
  // window is calculated from the pointer's grab point, so its left edge is
  // exactly where the segment will land rather than snapping to the cursor's
  // position as if the segment had been grabbed at its edge.
  const liftDropPreview = document.createElement('span');
  liftDropPreview.className = 'storyboard-act-board-track-lift-drop-indicator';
  liftDropPreview.hidden = true;
  liftDropPreview.setAttribute('aria-hidden', 'true');
  strip.appendChild(liftDropPreview);
  const setLiftDropPreview = (start, duration) => {
    const safeDuration = Math.max(kind === 'narration' ? 0.5 : 0.25,
      Number(duration) || (kind === 'narration' ? 0.5 : 0.25));
    const maxStart = Math.max(0, total - safeDuration);
    const safeStart = Math.max(0, Math.min(maxStart, Number(start) || 0));
    const scale = Math.max(0.001, total);
    liftDropPreview.style.left = `${(safeStart / scale) * 100}%`;
    liftDropPreview.style.width = `${Math.min(100, (safeDuration / scale) * 100)}%`;
    liftDropPreview.hidden = false;
  };
  const clearLiftDropPreview = () => { liftDropPreview.hidden = true; };
  // Scrubbing the shared playhead is a preview/seek operation, not a
  // selection operation.  Keep the two paths separate so moving the vertical
  // slider never adds the selected outline to a narration segment (or moves
  // focus to another node).  Callers that are intentionally selecting a
  // segment can opt in with `{ highlight: true }`.
  const selectNarrationAtTime = (seconds, { highlight = false } = {}) => {
    if (kind !== 'narration') return null;
    const entry = segmentEntries.find(item => {
      const start = readStart(item.node);
      return seconds >= start && seconds <= start + readDuration(item.node);
    });
    if (!entry) {
      // Mark an intentional scrub into a gap.  Do not fall back to the last
      // selected segment when Space is pressed there.
      track._actBoardPlayheadNarrationNode = null;
      return null;
    }
    track._actBoardPlayheadNarrationNode = entry.node;
    if (highlight) {
      selectedTrackNode = entry.node;
      highlightPlaybackTrackNode(entry.node);
      track.classList.add('has-selected-segment');
    }
    if (entry.sourceEditor?._actBoardAudio) {
      track._actBoardActiveNarrationAudio = entry.sourceEditor._actBoardAudio;
      const sourceIn = Math.max(0, Number(entry.node.trimStartSeconds) || 0);
      const offset = Math.max(0, seconds - readStart(entry.node));
      try { entry.sourceEditor._actBoardAudio.currentTime = sourceIn + offset; } catch (err) { /* metadata race */ }
    }
    return entry;
  };
  if (narrationTrackPlayheadHitArea) {
    const movePlayhead = event => {
      const rect = strip.getBoundingClientRect();
      if (!(rect.width > 0)) return;
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const seconds = ratio * total;
      setScenePlayheadTime(seconds);
      selectNarrationAtTime(seconds);
    };
    narrationTrackPlayheadHitArea.addEventListener('pointerdown', event => {
      event.preventDefault();
      event.stopPropagation();
      // Keep keyboard transport attached to the slider the user just moved.
      // A span with a tabindex is not consistently focused by pointer input
      // across browsers, so focus it explicitly before Space is pressed.
      narrationTrackPlayheadHitArea.focus({ preventScroll: true });
      narrationTrackPlayheadHitArea.setPointerCapture?.(event.pointerId);
      movePlayhead(event);
      const move = moveEvent => {
        moveEvent.preventDefault();
        movePlayhead(moveEvent);
      };
      const finish = () => {
        narrationTrackPlayheadHitArea.removeEventListener('pointermove', move);
        narrationTrackPlayheadHitArea.removeEventListener('pointerup', finish);
        narrationTrackPlayheadHitArea.removeEventListener('pointercancel', finish);
        try { narrationTrackPlayheadHitArea.releasePointerCapture?.(event.pointerId); } catch (err) { /* optional */ }
        saveDebugSession();
      };
      narrationTrackPlayheadHitArea.addEventListener('pointermove', move);
      narrationTrackPlayheadHitArea.addEventListener('pointerup', finish, { once: true });
      narrationTrackPlayheadHitArea.addEventListener('pointercancel', finish, { once: true });
    });
    narrationTrackPlayheadHitArea.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const step = event.shiftKey ? 1 : .1;
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? total
          : narrationTrackPlayheadSeconds + (event.key === 'ArrowLeft' ? -step : step);
      setScenePlayheadTime(next);
      selectNarrationAtTime(next);
    });
  }
  // Selecting a segment here notifies the scene (onSelect), and the scene's
  // own selection path highlights this rail back through
  // _actBoardHighlightNarrationNode. Without a re-entry guard the two called
  // each other until the call stack overflowed - every click on a narration
  // segment threw "Maximum call stack size exceeded" (swallowed) after some
  // 2,300 nested rounds, and took half a second to a second to do so.
  let highlightingNode = false;
  const highlightPlaybackTrackNode = node => {
    if (highlightingNode) return;
    highlightingNode = true;
    try { highlightPlaybackTrackNodeOnce(node); } finally { highlightingNode = false; }
  };
  const highlightPlaybackTrackNodeOnce = node => {
    segmentEntries.forEach(entry => {
      entry.segment.classList.toggle('selected', entry.node === node);
    });
    const card = boardLayer?.querySelector?.(`[data-node-id="${node?.id || ''}"]`);
    if (card) focusActBoardNode(boardLayer, card, node);
    // Narration segments are rendered in the scene rail rather than as
    // visible canvas cards. Open their full content in the persistent node
    // panel explicitly when a presenter clicks a track segment (and do the
    // same for audio segments for consistent track behavior).
    const boardView = boardLayer?.closest('.storyboard-act-board-view');
    const act = currentArcSections.find(item => item.key === actKey)
      || { key: actKey, label: actKey };
    boardView?._actBoardFullPlaybackPanel?._actBoardFullPlayback
      ?.showNodeDetails?.(actKey, act, node);
    if (typeof onSelect === 'function') onSelect(node);
    updateNarrationEntityCue();
  };
  // Exposed so selecting a segment from the OTHER entry point (a scene's
  // narration slide - see selectNarrationSegment) can paint this track's
  // selected segment to match, without duplicating the highlight/focus/panel
  // logic above.
  if (kind === 'narration') track._actBoardHighlightNarrationNode = highlightPlaybackTrackNode;

  const removeSelectedTrackSegment = () => {
    const entry = segmentEntries.find(item => item.node === selectedTrackNode);
    if (!entry) return false;
    const node = entry.node;
    node.trackHidden = true;
    persistActBoardTrackNode(node);
    clearNarrationCoverage(node);
    if (kind === 'narration' && node.id) {
      // The scene narration slides are the section-level representation of
      // track segments. Remove the matching slide immediately, rather than
      // waiting for a full board rerender.
      boardLayer?.querySelectorAll?.(
        `.storyboard-act-board-scene-narration-slide[data-narration-node-id="${String(node.id).replace(/"/g, '\\"')}"]`,
      ).forEach(slide => slide.remove());
    }
    entry.segment.remove();
    entry.gap.remove();
    segmentEntries.splice(segmentEntries.indexOf(entry), 1);
    selectedTrackNode = null;
    track.classList.remove('has-selected-segment');
    updateNarrationEntityCue();
    updateTrackLayout();
    refreshActBoardPlaybackDurations();
    saveDebugSession();
    // See the footage rail: the other views of this segment must go too.
    syncActBoardTrackRemoval(actKey, node);
    return true;
  };
  const toggleNarrationTrackPlayback = () => {
    if (kind !== 'narration') return false;
    const playheadSeconds = timelineOwner
      ? Math.max(0, Number(timelineOwner._actBoardScenePlayheadSeconds) || 0)
      : Math.max(0, Number(narrationTrackPlayheadSeconds) || 0);
    let activeAudio = track._actBoardActiveNarrationAudio;
    // Prefer the segment under the shared playhead.  This matters when the
    // user scrubs while the track is paused: Space should start the audio at
    // that exact sequence position, rather than at the last clicked segment's
    // source-in boundary.
    let node = segmentEntries.find(entry =>
      entry.node === track._actBoardPlayheadNarrationNode)?.node;
    if (!node && track._actBoardPlayheadNarrationNode !== null) {
      node = segmentEntries.find(entry => {
        const start = readStart(entry.node);
        return playheadSeconds >= start
          && playheadSeconds <= start + readDuration(entry.node);
      })?.node;
    }
    if (!node && track._actBoardPlayheadNarrationNode !== null) {
      node = segmentEntries.find(entry =>
        entry.segment.contains(activeAudio) || entry.node === selectedTrackNode)?.node;
    }
    if (!node && track._actBoardPlayheadNarrationNode === null) return false;
    const entry = segmentEntries.find(item => item.node === node);
    if (entry?.sourceEditor?._actBoardAudio) {
      activeAudio = entry.sourceEditor._actBoardAudio;
      track._actBoardActiveNarrationAudio = activeAudio;
    } else if (entry) {
      // Do not reuse an audio element from a previously selected segment when
      // the current narration segment has no recording of its own.
      activeAudio = null;
    }
    if (!activeAudio) return false;
    const sourceIn = Math.max(0, Number(node?.trimStartSeconds) || 0);
    const duration = Math.max(.5,
      Number(node ? actBoardNarrationSegmentDuration(node) : 0)
        || (Number(activeAudio.duration) > 0 ? Number(activeAudio.duration) - sourceIn : .5));
    const segmentStart = Math.max(0, Number(node ? readStart(node) : 0) || 0);
    const offset = Math.max(0, Math.min(duration, playheadSeconds - segmentStart));
    const targetTime = sourceIn + offset;
    if (activeAudio.paused || activeAudio.ended) {
      // Always seek from the visible sequence playhead when starting.  The
      // source editor remains the actual audio element, while this shared
      // scene time determines where playback begins.
      try { activeAudio.currentTime = targetTime; } catch (err) { /* metadata race */ }
      const promise = activeAudio.play();
      promise?.catch?.(() => {});
      return true;
    }
    activeAudio.pause();
    return true;
  };
  track._actBoardToggleNarrationPlayback = toggleNarrationTrackPlayback;
  if (playheadRegistration) playheadRegistration.toggleNarration = toggleNarrationTrackPlayback;
  track.tabIndex = 0;
  track.addEventListener('keydown', event => {
    if (kind === 'narration' && (event.code === 'Space' || event.key === ' ')
      && !event.target.closest('input, textarea, select, button, a')) {
      event.preventDefault();
      event.stopPropagation();
      toggleNarrationTrackPlayback();
      return;
    }
    if (kind === 'audio' && (event.code === 'Space' || event.key === ' ')
      && !event.target.closest('input, textarea, select, button, a')) {
      event.preventDefault();
      event.stopPropagation();
      timelineOwner?._actBoardToggleNarrationPlayback?.();
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace')
      && removeSelectedTrackSegment()) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
  track._actBoardDropNode = (node, clientX) => {
    if (!node || node.type !== expectedTrackNodeType || node.actKey !== actKey
      || (track.dataset.sceneId && node.sceneId !== track.dataset.sceneId)) return false;
    const rect = strip.getBoundingClientRect();
    if (!(rect.width > 0)) return false;
    const ratio = Math.max(0, Math.min(1, (Number(clientX) - rect.left) / rect.width));
    const duration = readDuration(node);
    const start = Math.max(0, ratio * total);
    node.startSeconds = Number(start.toFixed(2));
    node.trackHidden = false;
    node.timingWasManuallyAdjusted = true;
    if (kind === 'narration') node.narrationSegmentDurationSeconds = duration;
    else if (node.selectedAudio) node.selectedAudio.durationSeconds = duration;
    persistActBoardTrackNode(node);
    if (timelineOwner) timelineOwner.timelineDurationSeconds = Math.max(
      Number(timelineOwner.timelineDurationSeconds) || 0, start + duration,
    );
    refreshActBoardLinkedAudioTimingForTarget(node);
    return true;
  };
  track._actBoardCanDropNode = node => Boolean(node && node.type === expectedTrackNodeType
    && node.actKey === actKey
    && (!track.dataset.sceneId || node.sceneId === track.dataset.sceneId));
  const dropPreview = document.createElement('div');
  dropPreview.className = 'storyboard-act-board-footage-track-drop-preview';
  dropPreview.hidden = true;
  dropPreview.setAttribute('aria-hidden', 'true');
  strip.appendChild(dropPreview);
  track._actBoardClearDropPreview = () => {
    dropPreview.hidden = true;
  };
  track._actBoardShowDropPreview = (node, clientX) => {
    if (!track._actBoardCanDropNode(node)) {
      track._actBoardClearDropPreview();
      return false;
    }
    const rect = strip.getBoundingClientRect();
    if (!(rect.width > 0)) return false;
    const duration = readDuration(node);
    const widthPercent = Math.min(100, (duration / Math.max(0.001, total)) * 100);
    const startPercent = Math.max(0, Math.min(100 - widthPercent,
      ((Number(clientX) - rect.left) / rect.width) * 100));
    dropPreview.style.left = `${startPercent}%`;
    dropPreview.style.width = `${widthPercent}%`;
    dropPreview.title = `Drop ${duration.toFixed(1)}s ${kind} segment here`;
    dropPreview.hidden = false;
    return dropPreview;
  };

  const updateTrackLayout = () => {
    total = Math.max(
      0.1,
      readTimelineOwnerDuration(),
      sharedTimeline ? 0 : Number(timelineOwner?.durationSeconds) || 0,
      ...nodes.filter(actBoardTrackNodeVisible).map(node => readStart(node) + readDuration(node)),
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
    if (kind === 'narration') {
      const sharedSeconds = timelineOwner
        ? Number(timelineOwner._actBoardScenePlayheadSeconds)
        : narrationTrackPlayheadSeconds;
      setScenePlayheadTime(Number.isFinite(sharedSeconds)
        ? sharedSeconds : narrationTrackPlayheadSeconds);
    } else if (kind === 'audio') {
      const sharedSeconds = timelineOwner
        ? Number(timelineOwner._actBoardScenePlayheadSeconds) : 0;
      setAudioPlayheadVisual(Number.isFinite(sharedSeconds) ? sharedSeconds : 0);
    }
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
    const card = actBoardNodeCard(boardLayer, node.id);
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

  const narrationCoverageNode = node => {
    if (!node) return narrationNode || null;
    // Audio can be linked directly to narration, or indirectly through a
    // footage node that belongs to a narration.  Resolve that relationship so
    // moving either rail can highlight the same words in the side preview.
    return kind === 'narration'
      ? node
      : (actBoardNarrationForNode(actKey, node) || narrationNode || null);
  };
  const showNarrationCoverage = node => {
    if (!node) return [];
    const coverageNarration = narrationCoverageNode(node);
    if (!coverageNarration) return [];
    const start = readStart(node);
    const end = start + readDuration(node);
    // Word/transcript timestamps are relative to the narration file. Convert
    // the track's absolute scene time back to that local narration clock so
    // moving the narration segment still highlights the words it covers.
    const narrationStart = readStart(coverageNarration);
    const covered = highlightActBoardNarrationTiming(
      boardLayer,
      coverageNarration,
      Math.max(0, start - narrationStart),
      Math.max(0, end - narrationStart),
    );
    if (kind === 'narration') {
      // The narration rail's readout is a persistent entity summary, not a
      // transient timing message. Timing highlights still update while the
      // segment is being dragged, but the label remains tied to the selected
      // narration slide.
      updateNarrationEntityCue();
    } else {
      // Preserve the existing timing readout for the music/sound rail.
      timingCue.textContent = covered.length
        ? `Narration coverage: ${covered.join(' · ')}` : 'Narration coverage: no matched phrase';
    }
    return covered;
  };
  const clearNarrationCoverage = node => {
    const coverageNarration = narrationCoverageNode(node);
    if (coverageNarration) {
      clearActBoardNarrationTimingHighlight(boardLayer, coverageNarration);
    }
    updateNarrationEntityCue();
  };

  const makeNarrationTrackSourceEditor = node => {
    const editor = document.createElement('div');
    editor.className = 'storyboard-act-board-scene-narration-source-editor';
    const strip = document.createElement('div');
    strip.className = 'storyboard-act-board-scene-narration-source-strip';
    strip.title = 'Drag the waveform to choose the source start; drag the narration-track playhead to choose sequence position; press Space to play or pause';
    // Use the same audio-derived SVG waveform as the narration node rather
    // than a decorative CSS bar pattern.  The path is populated from the
    // decoded recording below, so the source editor reflects this segment's
    // actual audio instead of a generic placeholder.
    const waveform = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    waveform.classList.add('storyboard-act-board-scene-narration-source-waveform');
    waveform.setAttribute('viewBox', '0 0 240 64');
    waveform.setAttribute('preserveAspectRatio', 'none');
    waveform.setAttribute('role', 'img');
    waveform.setAttribute('aria-label', 'Narration waveform');
    const waveformPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const setWaveformPath = path => {
      if (path) waveformPath.setAttribute('d', path);
    };
    waveform.appendChild(waveformPath);
    strip.append(waveform);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.hidden = true;
    audio.setAttribute('aria-hidden', 'true');
    const url = node._nativePreviewUrl || node._nativeAudioUrl || node.audioPreviewUrl || '';
    if (url) attachNativeAudioSource(audio, url, node);
    if (node._actBoardNarrationWaveformPath) {
      setWaveformPath(node._actBoardNarrationWaveformPath);
    } else if (url) {
      // Decode in the idle queue so opening/scrolling the board stays
      // responsive.  This is the same cache/path used by the narration node,
      // keeping both waveform renderings in sync after refresh.
      ensureNarrationClipDecodedWhenIdle(node)
        .then(buffer => runActBoardWhenIdle(() => actBoardNarrationWaveformPath(buffer)))
        .then(path => {
          if (!path) return;
          try {
            Object.defineProperty(node, '_actBoardNarrationWaveformPath', {
              value: path, configurable: true, writable: true, enumerable: false,
            });
          } catch (err) { node._actBoardNarrationWaveformPath = path; }
          setWaveformPath(path);
        })
        .catch(() => { /* leave the neutral SVG baseline if decoding fails */ });
    }
    const sourceIn = () => Math.max(0, Number(node.trimStartSeconds) || 0);
    const sourceWindowLength = () => {
      const natural = Number(audio.duration) > 0
        ? Math.max(0, Number(audio.duration) - sourceIn()) : 0;
      const segment = Math.max(0, actBoardNarrationSegmentDuration(node));
      return Math.max(.5, segment || natural || .5);
    };
    const sourceEnd = () => sourceIn() + sourceWindowLength();
    const update = () => {
      const duration = sourceWindowLength();
      const ratio = duration > 0
        ? Math.max(0, Math.min(1,
          (Number(audio.currentTime || 0) - sourceIn()) / duration)) : 0;
      // Only the active/playing segment drives the shared sequence playhead;
      // otherwise each source editor's metadata event would move the one
      // playhead as the track is initially rendered.
      if (track._actBoardActiveNarrationAudio === audio
        || (!audio.paused && !audio.ended)) {
        track._actBoardSetNarrationPlayheadTime?.(
          readStart(node) + Math.max(0, Number(audio.currentTime || 0) - sourceIn()),
        );
      }
      editor.classList.toggle('is-playing', !audio.paused && !audio.ended);
      editor.dataset.playheadSeconds = String(Math.max(0,
        Number(audio.currentTime || 0) - sourceIn()));
    };
    const togglePlayback = () => {
      if (!url) return;
      track._actBoardActiveNarrationAudio = audio;
      // Space resumes from the visible playhead. Once the selected source
      // window has finished, the next press starts it again at its source-in
      // boundary instead of silently remaining at the end of the file.
      if (audio.ended || Number(audio.currentTime) >= sourceEnd() - .02) {
        try { audio.currentTime = sourceIn(); } catch (err) { /* metadata race */ }
      }
      const promise = audio.paused || audio.ended ? audio.play() : audio.pause();
      promise?.catch?.(() => {});
      update();
    };
    strip.addEventListener('pointerdown', event => {
      event.preventDefault();
      event.stopPropagation();
      track.focus({ preventScroll: true });
      track._actBoardActiveNarrationAudio = audio;
      if (!url) return;
      const rect = strip.getBoundingClientRect();
      const setPosition = clientX => {
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
        const duration = Number(audio.duration) > 0
          ? Math.max(0, Number(audio.duration) - sourceIn())
          : Math.max(.5, actBoardNarrationSegmentDuration(node));
        try { audio.currentTime = sourceIn() + ratio * duration; } catch (err) { /* metadata race */ }
        update();
      };
      setPosition(event.clientX);
      const move = moveEvent => setPosition(moveEvent.clientX);
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up, { once: true });
    });
    strip.addEventListener('dblclick', event => {
      event.preventDefault();
      event.stopPropagation();
      togglePlayback();
    });
    audio.addEventListener('timeupdate', () => {
      if (!audio.paused && Number(audio.currentTime) >= sourceEnd() - .02) {
        audio.pause();
        try { audio.currentTime = sourceEnd(); } catch (err) { /* optional */ }
      }
      update();
    });
    ['loadedmetadata', 'play', 'pause', 'ended'].forEach(eventName =>
      audio.addEventListener(eventName, update));
    editor.append(strip, audio);
    editor._actBoardRefresh = update;
    editor._actBoardAudio = audio;
    return editor;
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
    segment.title = kind === 'narration'
      ? labelText + ' · drag left/right to move in time · drag onto another segment to reorder · drag either edge to change length · press Delete to remove from track'
      : `${labelText} · drag to move · drag either edge to change length · press Delete to remove from track`;
    const durationLabel = document.createElement('span');
    durationLabel.className = 'storyboard-act-board-footage-track-duration-label';
    durationLabel.textContent = `${readDuration(node).toFixed(1)}s`;
    const startHandle = document.createElement('span');
    startHandle.className = 'storyboard-act-board-footage-track-handle start';
    startHandle.title = 'Drag to change when this segment starts';
    const endHandle = document.createElement('span');
    endHandle.className = 'storyboard-act-board-footage-track-handle end';
    endHandle.title = 'Drag to change this segment length';
    const sourceEditor = kind === 'narration' && showSourceEditor
      ? makeNarrationTrackSourceEditor(node) : null;
    if (sourceEditor) {
      segment.classList.add('has-source-editor');
      segment.appendChild(sourceEditor);
    }
    segment.append(durationLabel, startHandle, endHandle);
    segment.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (segment.dataset.dragMoved === 'true') {
        delete segment.dataset.dragMoved;
        return;
      }
      highlightPlaybackTrackNode(node);
      selectedTrackNode = node;
      if (sourceEditor) track._actBoardActiveNarrationAudio = sourceEditor._actBoardAudio;
      if (kind === 'narration' || kind === 'audio') setScenePlayheadTime(readStart(node));
      track.classList.add('has-selected-segment');
      segmentEntries.forEach(item => item.segment.classList.toggle('selected', item.node === node));
      segment.focus({ preventScroll: true });
      showNarrationCoverage(node);
    });
    segment.addEventListener('keydown', event => {
      if (event.code === 'Space' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        if (kind === 'narration') toggleNarrationTrackPlayback();
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        event.stopPropagation();
        selectedTrackNode = node;
        removeSelectedTrackSegment();
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectedTrackNode = node;
        if (sourceEditor) track._actBoardActiveNarrationAudio = sourceEditor._actBoardAudio;
        highlightPlaybackTrackNode(node);
        showNarrationCoverage(node);
      }
    });
    const entry = {
      node, gap, segment, durationLabel, startHandle, endHandle, sourceEditor, index,
    };
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
          if (kind === 'narration' || kind === 'audio') showNarrationCoverage(node);
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
          if (kind === 'narration' || kind === 'audio') clearNarrationCoverage(node);
          if (kind !== 'narration') timingCue.textContent = '';
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
    wireBoundary(startHandle, 'start');
    wireBoundary(endHandle, 'end');
    // Use the shared lifted-reorder controller for every track kind.
    wireActBoardTrackSegmentDrag({
      segment,
      track,
      strip,
      entry,
      entries: segmentEntries,
      getNode: item => item.node,
      getStart: item => readStart(item),
      getDuration: item => readDuration(item),
      getTotal: () => total,
      applyTiming: (item, start, duration) => {
        setTiming(item, start, duration);
      },
      updateLayout: updateTrackLayout,
      onCoverage: (item, start, end) => {
        if (kind === 'narration' || kind === 'audio') showNarrationCoverage(item);
        else timingCue.textContent = '';
      },
      clearCoverage: item => {
        if (kind === 'narration' || kind === 'audio') clearNarrationCoverage(item);
      },
      onCommitReorder: (ordered, item) => {
        const orderedNodes = ordered.map(value => value.node);
        const committed = reorderActBoardTrackSequence(kind, actKey, orderedNodes, timelineOwner, narrationNode);
        if (!committed) return;
        // Commit one complete reorder snapshot immediately. The regular
        // debounced serializer still handles subsequent edits, but an atomic
        // drop should never be lost if the scene rail is patched immediately.
        saveDebugSessionNow();
        const scene = actBoardSceneForNode(actKey, item.node) ||
          (timelineOwner?.sceneId ? actBoardScenesForAct(actKey).find(value => value.id === timelineOwner.sceneId) : null);
        queueActBoardScenePatch(actKey, scene?.id || item.node.sceneId, { persist: true });
      },
      onCommitTiming: () => {
        saveDebugSession();
        updateTrackLayout();
      },
    });
    segmentEntries.push(entry);
    strip.appendChild(segment);
  });
  track.appendChild(timingCue);
  track._actBoardRefresh = updateTrackLayout;
  updateTrackLayout();
  updateNarrationEntityCue();
  return track;
}

