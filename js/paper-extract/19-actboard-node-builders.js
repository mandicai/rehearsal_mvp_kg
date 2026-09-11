function buildActBoardAudioNodeContent(actKey, act, node, card, stickyBanner = null) {
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
  const boardLayer = card.closest?.('.storyboard-act-board-node-stack');
  const audioCoverageNarration = () => {
    const linkedNarration = actBoardNarrationForNode(actKey, node);
    if (linkedNarration) return linkedNarration;
    // An unlinked sound effect is still mixed with the scene's narration. Use
    // that scene narration as the coverage reference while its timing is
    // edited, without changing the sound's independent link state.
    return actBoardNodesForAct(actKey).find(item => item.type === 'narration'
      && item.sceneId && node.sceneId && item.sceneId === node.sceneId) || null;
  };
  const showAudioCoverage = () => {
    const coverageNarration = audioCoverageNarration();
    if (!boardLayer || !coverageNarration) return;
    const narrationStart = Math.max(0, Number(coverageNarration.startSeconds) || 0);
    const start = Math.max(0, Number(node.startSeconds) || 0);
    const end = start + Math.max(0.1, Number(node.durationSeconds) || 0.1);
    highlightActBoardNarrationTiming(
      boardLayer,
      coverageNarration,
      Math.max(0, start - narrationStart),
      Math.max(0, end - narrationStart),
    );
  };
  const clearAudioCoverage = () => {
    const coverageNarration = audioCoverageNarration();
    if (boardLayer && coverageNarration) {
      clearActBoardNarrationTimingHighlight(boardLayer, coverageNarration);
    }
  };
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
    refreshActBoardAudioTimingForNode(node);
    showAudioCoverage();
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
  // Use the native file picker here so the control matches the other uploads
  // in the app and clearly shows “Choose File” / “No file selected”.
  const uploadInput = document.createElement('input');
  uploadInput.type = 'file';
  uploadInput.accept = 'audio/*,.wav,.mp3,.m4a,.mp4,.webm,.ogg,.aac,.flac';
  uploadInput.className = 'storyboard-act-board-audio-upload-input';
  uploadInput.setAttribute('aria-label', 'Upload sound');
  uploadInput.addEventListener('click', event => event.stopPropagation());
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
  uploadRow.appendChild(uploadInput);
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
    wireActBoardAudioPreviewSegment(player, node);
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
        showAudioCoverage();
        redraw();
      };
      const up = () => {
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', up);
        target.removeEventListener('pointercancel', up);
        try { target.releasePointerCapture(event.pointerId); } catch (err) { /* optional */ }
        refreshActBoardAudioTimingForNode(node);
        clearAudioCoverage();
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

function buildActBoardNarrationTimingControls(
  actKey, node, card, mount = card, sourceEditorMount = mount,
) {
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
  const boardLayer = card.closest?.('.storyboard-act-board-node-stack');
  const showNarrationCoverage = () => {
    if (!boardLayer) return;
    const start = Math.max(0, Number(node.trimStartSeconds) || 0);
    const length = Math.max(0.5, Number(node.narrationSegmentDurationSeconds)
      || actBoardNarrationSegmentDuration(node)
      || estimateActBoardNarrationSeconds(node.transcript || node.text));
    highlightActBoardNarrationTiming(boardLayer, node, start, start + length);
  };
  const clearNarrationCoverage = () => {
    if (boardLayer) clearActBoardNarrationTimingHighlight(boardLayer, node);
  };
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
    showNarrationCoverage();
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
    // Keep the source-window editor with the narration controls in the
    // selected-node content panel. The caller can place it immediately after
    // the volume row while leaving the hidden timing inputs on their existing
    // mount for backwards-compatible synchronization.
    (sourceEditorMount || mount).appendChild(editor);
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
        showNarrationCoverage();
        redraw();
      };
      const up = () => {
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', up);
        target.removeEventListener('pointercancel', up);
        try { target.releasePointerCapture(event.pointerId); } catch (err) { /* optional */ }
        refreshActBoardNarrationTimingForNode(node);
        clearNarrationCoverage();
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
  card.dataset.nodeType = node.type;
  if (actBoardNodeIsNewlyCreated(node.id)) {
    playActBoardAppearAnimation(card, 'act-board-node-appearing');
  }
  if (node.type === 'narration') card.setAttribute('aria-hidden', 'true');
  wireActBoardNodeDragging(card, node, boardLayer, nodeIndex);
  card.style.width = `${actBoardAutoWidth(node, boardLayer)}px`;
  // Every canvas node uses the same compact vertical footprint. Normalize
  // persisted dimensions before the type-specific shell setup so an older
  // saved height cannot make one node taller than the others.
  card.style.height = `${ACT_BOARD_NODE_STANDARD_HEIGHT}px`;
  node.boardHeight = ACT_BOARD_NODE_STANDARD_HEIGHT;
  node.boardHeightMode = 'auto';
  if (node.type === 'narration') {
    card.style.width = `${actBoardNarrationWidth(node, boardLayer)}px`;
    card.style.height = `${ACT_BOARD_NARRATION_STANDARD_HEIGHT}px`;
  } else if (node.type === 'audio') {
    // Audio shells use the same compact footprint as narration shells. Their
    // detailed controls live in the panel, so audio nodes are not resizable.
    card.style.width = `${ACT_BOARD_AUDIO_STANDARD_WIDTH}px`;
    card.style.height = `${ACT_BOARD_AUDIO_STANDARD_HEIGHT}px`;
    node.boardWidth = ACT_BOARD_AUDIO_STANDARD_WIDTH;
    node.boardHeight = ACT_BOARD_AUDIO_STANDARD_HEIGHT;
    node.boardWidthMode = 'auto';
    node.boardHeightMode = 'auto';
  } else if (node.type === 'footage') {
    // Footage nodes use a fixed compact SVG shell. Their detailed gallery and
    // controls live in the full-playback panel, so old persisted resize values
    // should not change the canvas footprint.
    node.boardWidth = ACT_BOARD_FOOTAGE_STANDARD_WIDTH;
    node.boardWidthMode = 'auto';
    card.style.width = `${ACT_BOARD_FOOTAGE_STANDARD_WIDTH}px`;
    node.boardHeight = ACT_BOARD_FOOTAGE_STANDARD_HEIGHT;
    node.boardHeightMode = 'auto';
    card.style.height = `${ACT_BOARD_FOOTAGE_STANDARD_HEIGHT}px`;
  }
  // Newly visualized cards do not have meaningful canvas coordinates until
  // the scene Footage lane has been measured. Keep the shell out of view so
  // the narration-relative fallback position cannot flash while placement is
  // waiting for layout (or while the scene expands for another row).
  if (node.type === 'footage' && node.boardPositionMode === 'footage-section-auto') {
    card.classList.add('storyboard-act-board-footage-pending-placement');
    card.style.visibility = 'hidden';
  }
  if (Number.isFinite(Number(node.boardZIndex))) {
    card.style.zIndex = String(node.boardZIndex);
  }
  if (ACT_BOARD_LINKING_ENABLED) wireActBoardNodeLinking(card, actKey, node, boardLayer);

  // Any node that receives focus becomes the active top layer. Use capture on
  // pointerdown so clicks on embedded controls (which intentionally stop
  // bubbling) also bring their node forward before the control handles them.
  card.addEventListener('pointerdown', event => {
    // Apply the same visual focus transition immediately, including when the
    // presenter clicks a control inside the node (those clicks intentionally do
    // not bubble to the surface click handler). This prevents a previously
    // active footage card from retaining its blue glow while another node is
    // being edited.
    const activeBoard = boardLayer.closest('.storyboard-act-board-view') || boardLayer;
    activeBoard.querySelectorAll('.storyboard-act-board-node--focused')
      .forEach(item => {
        if (item !== card) item.classList.remove('storyboard-act-board-node--focused');
      });
    activeBoard.querySelectorAll('.storyboard-act-board-node-footage.act-board-footage-selected')
      .forEach(item => {
        if (item !== card) item.classList.remove('act-board-footage-selected');
      });
    activeBoard.querySelectorAll('.storyboard-act-board-footage-track-segment.selected')
      .forEach(item => {
        if (item.dataset.footageNodeId !== node.id) item.classList.remove('selected');
      });
    card.classList.add('storyboard-act-board-node--focused');
    highlightActBoardPlaybackTrackNode(boardLayer, node);
    bringActBoardNodeToFront(boardLayer, card, node);
    boardLayer._actBoardActiveNodeId = node.id;
    // Keep text/media controls usable: only focus the board itself when the
    // presenter clicked the card surface, not an editable control.
    if (!event.target.closest('button, input, audio, video, a, select, textarea, label, details, summary, [contenteditable="true"]')) {
      boardLayer.focus({ preventScroll: true });
    }
  }, true);
  // A click on the node surface selects it and mirrors its content in the
  // always-available full-playback panel. Do not scroll or zoom the canvas;
  // embedded controls keep their own behavior and do not trigger this view.
  card.addEventListener('click', event => {
    const target = event.target;
    if (target?.closest?.('button, input, audio, video, a, select, textarea, label, details, summary, .storyboard-act-board-node-resize-handle')) return;
    focusActBoardNode(boardLayer, card, node);
    const boardView = boardLayer.closest('.storyboard-act-board-view');
    boardView?._actBoardFullPlaybackPanel?._actBoardFullPlayback
      ?.showNodeDetails?.(actKey, act, node);
  });

  const top = document.createElement('div');
  top.className = 'storyboard-act-board-node-top';
  if (node.type === 'narration') top.classList.add('storyboard-act-board-narration-node-top');
  if (node.type === 'audio') top.classList.add('storyboard-act-board-audio-node-top');
  const type = document.createElement('span');
  type.className = 'storyboard-act-board-node-type';
  type.textContent = node.type === 'narration' ? 'Narration'
    : node.type === 'playback' ? 'Playback'
      : node.type === 'audio' ? (node.audioKind === 'music' ? 'Music' : 'Sound effects')
        : 'Footage';
  const topActions = document.createElement('span');
  topActions.className = 'storyboard-act-board-node-header-actions';
  if (node.type === 'footage') {
    const selectedVisual = actBoardVisualForKey(node, node.selectedVisualKey);
    const aiSelected = selectedVisual?.generatedIndex != null
      || selectedVisual?.source === 'AI-generated'
      || (node.mediaOrigin === 'generated' && node.mediaUrl);
    // Use the node's pseudo-element for provenance so the marker never
    // participates in header layout or overlaps the node actions.
    card.classList.toggle('storyboard-act-board-node-ai-selected', Boolean(aiSelected));
  }
  const footageScene = node.type === 'footage' ? actBoardSceneForNode(actKey, node) : null;
  let footageStartButton = null;

  if (footageScene) {
    const startButton = document.createElement('button');
    footageStartButton = startButton;
    startButton.type = 'button';
    startButton.className = 'btn-secondary storyboard-act-board-node-action storyboard-act-board-footage-start-btn';
    const isStart = footageScene.sequenceStartNodeId === node.id;
    startButton.textContent = '⚑';
    startButton.setAttribute('aria-label', isStart ? 'Starting node' : 'Set as start node');
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
  // remove.title = 'Remove this board node';
  remove.addEventListener('click', event => {
    event.stopPropagation();
    const removeIds = new Set([node.id, ...(node.footageNodeIds || [])]);
    const removalScene = node.type === 'footage'
      ? actBoardScenesForAct(actKey).find(scene => scene.id === node.sceneId
        || (scene.nodeIds || []).includes(node.id)) || null
      : null;
    removeIds.forEach(id => cancelActBoardFootageMediaJob(actKey, id));
    // Deleting one footage card must not cause the remaining cards to be
    // re-packed into the vacant slot on the next structural render. Treat
    // their current coordinates as explicit presenter work before removing
    // the card; newly pending cards retain their auto-placement marker.
    if (node.type === 'footage') {
      actBoardNodesForAct(actKey).forEach(item => {
        if (item.type !== 'footage' || removeIds.has(item.id)
          || item.boardPositionMode === 'footage-section-auto') return;
        if (Number.isFinite(Number(item.boardX))
          && Number.isFinite(Number(item.boardY))) {
          item.boardPositionMode = 'manual';
        }
      });
    }
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
    if (node.type === 'footage') {
      // Remove reciprocal relationships without touching the positions of any
      // surviving footage cards.  The card and its rail segments can be
      // removed in place because playback/export consume the shared state.
      actBoardNodesForAct(actKey).forEach(item => {
        if (item.type === 'narration' && Array.isArray(item.footageNodeIds)) {
          item.footageNodeIds = item.footageNodeIds.filter(id => !removeIds.has(id));
        }
        if (item.previousFootageNodeId && removeIds.has(item.previousFootageNodeId)) {
          item.previousFootageNodeId = null;
        }
        if (item.nextFootageNodeId && removeIds.has(item.nextFootageNodeId)) {
          item.nextFootageNodeId = null;
        }
      });
      removeIds.forEach(id => {
        boardLayer.querySelector(`.storyboard-act-board-node[data-node-id="${String(id).replace(/"/g, '\\"')}"]`)?.remove();
        boardLayer.querySelector(`.storyboard-act-board-board-scene-node[data-node-id="${String(id).replace(/"/g, '\\"')}"]`)?.remove();
        document.querySelectorAll(`[data-footage-node-id="${String(id).replace(/"/g, '\\"')}"]`)
          .forEach(segment => segment.remove());
      });
      if (removalScene) syncActBoardLiveSceneSnapshots(removalScene);
      refreshActBoardLinkPaths(boardLayer);
      refreshActBoardDomRegistry();
      saveDebugSession();
      return;
    }
    saveDebugSession();
    rerenderActBoard();
  });
  // Keep every node's delete affordance on the compact canvas shell. The
  // detailed body is moved to the full-playback panel, but the remove button
  // must remain available on the node itself.
  topActions.appendChild(remove);
  if (node.type === 'footage' && footageStartButton) {
    // Keep the start-node icon directly beneath the delete affordance in the
    // node's upper-right control stack.
    topActions.appendChild(footageStartButton);
  }
  top.appendChild(type);
  if (node.type === 'narration') {
    const narrationPreview = document.createElement('div');
    narrationPreview.className = 'storyboard-act-board-narration-node-preview';
    const narrationAudioUrl = node._nativePreviewUrl || node.audioPreviewUrl || '';
    // Keep the transcription's original spacing. Normalizing all whitespace
    // here made line breaks/multiple spaces disappear before the node preview
    // was rendered (and made it look as though words had been run together).
    const transcriptText = String(node.transcript || '').trim();
    if (narrationAudioUrl) {
      const narrationAudio = document.createElement('audio');
      narrationAudio.className = 'storyboard-act-board-narration-node-preview-audio';
      narrationAudio.preload = 'metadata';
      narrationAudio.setAttribute('aria-label', 'Recorded narration preview');
      attachNativeAudioSource(narrationAudio, narrationAudioUrl, node);
      wireActBoardAudioPreviewSegment(narrationAudio, node);
      narrationAudio.volume = actBoardNodeVolume(node, 1);
      wireActBoardAudioExclusivity(narrationAudio);
      const waveformButton = document.createElement('button');
      waveformButton.type = 'button';
      waveformButton.className = 'storyboard-act-board-narration-node-waveform';
      waveformButton.title = 'Play recorded narration';
      waveformButton.setAttribute('aria-label', 'Play recorded narration');
      const waveformSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      waveformSvg.setAttribute('viewBox', '0 0 240 64');
      waveformSvg.setAttribute('role', 'img');
      waveformSvg.setAttribute('aria-hidden', 'true');
      const waveformPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const waveformPoints = [];
      for (let index = 0; index <= 96; index += 1) {
        const x = index * 2.5;
        const edge = Math.min(1, index / 10, (96 - index) / 10);
        const envelope = Math.max(0, edge) * (0.42 + 0.58 * Math.abs(Math.sin(index * 0.63)));
        const y = 32 + Math.sin(index * 1.42) * 27 * envelope;
        waveformPoints.push(`${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
      }
      waveformPath.setAttribute('d', waveformPoints.join(' '));
      const setWaveformPath = path => {
        if (path) waveformPath.setAttribute('d', path);
      };
      if (node._actBoardNarrationWaveformPath) {
        setWaveformPath(node._actBoardNarrationWaveformPath);
      } else {
        // Decode the same recording used by the audio element and replace the
        // placeholder path with amplitude samples from the actual narration.
        // This is intentionally best-effort: a browser that cannot decode the
        // persisted container still gets the readable fallback waveform.
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
          .catch(() => { /* keep the deterministic placeholder waveform */ });
      }
      waveformSvg.appendChild(waveformPath);
      waveformButton.appendChild(waveformSvg);
      const waveformStatus = document.createElement('span');
      waveformStatus.className = 'storyboard-act-board-narration-node-waveform-status';
      waveformStatus.setAttribute('aria-hidden', 'true');
      waveformStatus.textContent = '▶';
      waveformButton.appendChild(waveformStatus);
      const updateWaveformState = () => {
        const playing = !narrationAudio.paused && !narrationAudio.ended;
        waveformButton.classList.toggle('is-playing', playing);
        waveformStatus.textContent = playing ? '⏸' : '▶';
        waveformButton.title = `${playing ? 'Pause' : 'Play'} recorded narration`;
        waveformButton.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} recorded narration`);
      };
      waveformButton.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (narrationAudio.paused || narrationAudio.ended) {
          const playPromise = narrationAudio.play();
          if (playPromise?.catch) playPromise.catch(() => updateWaveformState());
        } else {
          narrationAudio.pause();
        }
        updateWaveformState();
      });
      ['play', 'pause', 'ended', 'emptied'].forEach(eventName =>
        narrationAudio.addEventListener(eventName, updateWaveformState));
      narrationPreview.append(waveformButton, narrationAudio);
    } else if (!transcriptText) {
      narrationPreview.classList.add('is-empty');
      const emptyLabel = document.createElement('span');
      emptyLabel.textContent = 'No narration yet';
      narrationPreview.appendChild(emptyLabel);
    }
    top.appendChild(narrationPreview);
  } else if (node.type === 'audio') {
    const audioPreview = document.createElement('div');
    audioPreview.className = 'storyboard-act-board-audio-node-preview';
    const audioSource = actBoardAudioSource(node);
    if (audioSource.url) {
      const waveformSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      waveformSvg.setAttribute('viewBox', '0 0 240 64');
      waveformSvg.setAttribute('role', 'img');
      waveformSvg.setAttribute('aria-label', 'Sound selected');
      const waveformPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const waveformPoints = [];
      for (let index = 0; index <= 96; index += 1) {
        const x = index * 2.5;
        const edge = Math.min(1, index / 10, (96 - index) / 10);
        const envelope = Math.max(0, edge)
          * (0.4 + 0.6 * Math.abs(Math.sin(index * 0.57 + 0.8)));
        const y = 32 + Math.sin(index * 1.3 + 0.35) * 25 * envelope;
        waveformPoints.push(`${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
      }
      waveformPath.setAttribute('d', waveformPoints.join(' '));
      waveformSvg.appendChild(waveformPath);
      const soundAudio = document.createElement('audio');
      soundAudio.className = 'storyboard-act-board-audio-node-preview-audio';
      soundAudio.preload = 'metadata';
      soundAudio.setAttribute('aria-label', 'Sound effects preview');
      soundAudio.src = audioSource.url;
      soundAudio.volume = actBoardNodeVolume(node, 1);
      wireActBoardAudioExclusivity(soundAudio);
      soundAudio.addEventListener('click', event => event.stopPropagation());
      const waveformButton = document.createElement('button');
      waveformButton.type = 'button';
      waveformButton.className = 'storyboard-act-board-audio-node-waveform';
      waveformButton.title = 'Play sound effect';
      waveformButton.setAttribute('aria-label', 'Play sound effect');
      waveformButton.appendChild(waveformSvg);
      const waveformStatus = document.createElement('span');
      waveformStatus.className = 'storyboard-act-board-audio-node-waveform-status';
      waveformStatus.setAttribute('aria-hidden', 'true');
      waveformStatus.textContent = '▶';
      waveformButton.appendChild(waveformStatus);
      const updateWaveformState = () => {
        const playing = !soundAudio.paused && !soundAudio.ended;
        waveformButton.classList.toggle('is-playing', playing);
        waveformStatus.textContent = playing ? '⏸' : '▶';
        waveformButton.title = `${playing ? 'Pause' : 'Play'} sound effect`;
        waveformButton.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} sound effect`);
      };
      waveformButton.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (soundAudio.paused || soundAudio.ended) {
          const playPromise = soundAudio.play();
          if (playPromise?.catch) playPromise.catch(() => updateWaveformState());
        } else {
          soundAudio.pause();
        }
        updateWaveformState();
      });
      ['play', 'pause', 'ended', 'emptied'].forEach(eventName =>
        soundAudio.addEventListener(eventName, updateWaveformState));
      audioPreview.append(waveformButton, soundAudio);
      const soundName = document.createElement('span');
      soundName.className = 'storyboard-act-board-audio-node-name';
      soundName.textContent = audioSource.name;
      soundName.title = audioSource.name;
      audioPreview.appendChild(soundName);
    } else {
      audioPreview.textContent = 'No sound yet';
      audioPreview.classList.add('is-empty');
    }
    top.appendChild(audioPreview);
  }
  top.appendChild(topActions);
  const nodeStickyBanner = ['footage', 'audio'].includes(node.type)
    ? document.createElement('div') : null;
  if (nodeStickyBanner) {
    nodeStickyBanner.className = `storyboard-act-board-node-sticky-banner storyboard-act-board-${node.type}-sticky-banner`;
    card.appendChild(nodeStickyBanner);
    nodeStickyBanner.appendChild(top);
  } else {
    card.appendChild(top);
  }

  // Keep the adjacent narration readout outside the node body so the SVG
  // shell can remain compact while the readout stays independently readable.
  let narrationSidePreview = null;

  if (node.type === 'playback') {
    const narrationNode = actBoardNodesForAct(actKey)
      .find(item => item.type === 'narration' && item.id === node.narrationNodeId);
    card.appendChild(buildActBoardNarrationPlayback(actKey, narrationNode, boardLayer, node));
  } else if (node.type === 'narration') {
    const suggestedView = document.createElement('div');
    suggestedView.className = 'storyboard-act-board-node-view storyboard-act-board-node-view-suggested';
    if (node.transcript) suggestedView.classList.add('has-recorded-narration');
    card.appendChild(suggestedView);
    const hasRecordedNarration = Boolean(String(node.transcript || '').trim());
    if (hasRecordedNarration) requestActBoardNarrationAnalysis(node);
    const narrationSource = hasRecordedNarration
      ? String(node.transcript || '').trim() : '';
    const analysisPending = hasRecordedNarration && (node.narrationSpanStatus === 'extracting'
      || node.narrationSpanStatus === 'classifying');
    const smartSpans = hasRecordedNarration
      && Array.isArray(node.narrationSpans) && node.narrationSpans.length
      ? node.narrationSpans.filter(span => !actBoardNarrationSpanExcluded(node, span))
      : [];
    const fragments = !hasRecordedNarration
      ? []
      : analysisPending
      ? []
      : (smartSpans.length
        ? smartSpans
        : (node.narrationSpanStatus === 'ready' || node.narrationSpanStatus === 'error'
          ? []
          : (Array.isArray(node.footageFragments) && node.footageFragments.length
            ? node.footageFragments
            : actBoardNarrationFragments(narrationSource))));
    const suggestedReferenceFragments = [];
    const onFilmableSpanSelect = (metadata, renderedText, appendSelection = false) =>
      handleActBoardNarrationSpanSelect(node, metadata, renderedText, appendSelection);
    const onFilmableSpanRemove = (metadata, renderedText) =>
      removeActBoardNarrationHighlight(node, metadata, renderedText);
    // Mirror the narration next to its SVG shell. Reuse the same word/phrase
    // rendering primitive as the panel so timing highlights stay in sync.
    narrationSidePreview = document.createElement('div');
    narrationSidePreview.className = 'storyboard-act-board-narration-side-preview';
    // Do not collapse transcription whitespace before rendering the
    // highlightable text; the source offsets for filmable spans are based on
    // the original transcript string.
    const sideNarrationText = String(node.transcript || node.text || '').trim();
    const sideNarrationLabel = node.transcript
      ? 'Recorded narration: '
      : 'Suggested narration: ';
    // Filmable-phrase detection is transcript-only (see
    // requestActBoardNarrationAnalysis): a suggested draft is reference copy,
    // not spoken narration, so it carries no entity highlights and no
    // selection affordances - its spans would not correspond to anything that
    // was actually said.
    const sideIsRecorded = Boolean(node.transcript);
    const sideText = buildActBoardSuggestedNarrationText(
      sideNarrationText,
      sideIsRecorded ? fragments : [],
      null,
      sideNarrationLabel,
      sideIsRecorded ? onFilmableSpanSelect : null,
      sideIsRecorded && !analysisPending && smartSpans.length > 0,
      sideIsRecorded ? onFilmableSpanRemove : null,
      // pauseWordIndices are only meaningful while sideNarrationText is
      // actually node.text (the draft), never once it has switched over to
      // node.transcript.
      sideIsRecorded ? null : node.pauseWordIndices,
    );
    sideText.classList.add('storyboard-act-board-narration-side-preview-text');
    sideText.dataset.actBoardNarrationNodeId = node.id;
    if (!sideIsRecorded) sideText.dataset.actBoardNarrationSuggested = 'true';
    if (hasRecordedNarration) {
      applyActBoardNarrationPhraseSelection(sideText, node, onFilmableSpanRemove);
    }
    if (!sideNarrationText) {
      sideText.textContent = node.status === 'generating'
        ? 'Drafting suggested narration…'
        : 'No narration yet';
    }
    narrationSidePreview.appendChild(sideText);
    narrationSidePreview.title = sideNarrationText || sideText.textContent;
    card.appendChild(narrationSidePreview);
    const recordActionRow = document.createElement('div');
    recordActionRow.className = 'storyboard-act-board-node-action-row';
    const recordButton = document.createElement('button');
    recordButton.type = 'button';
    recordButton.className = 'btn-secondary storyboard-act-board-node-action storyboard-act-board-record-narration-btn';
    recordButton.dataset.narrationNodeId = node.id;
    const uploadNarrationButton = document.createElement('button');
    uploadNarrationButton.type = 'button';
    uploadNarrationButton.className = 'btn-secondary storyboard-act-board-node-action storyboard-act-board-upload-narration-btn';
    uploadNarrationButton.textContent = '↑';
    uploadNarrationButton.setAttribute('aria-label', 'Upload narration');
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
      event.preventDefault();
      event.stopPropagation();
      resuggestActBoardNarration(actKey, act, node, resuggestButton);
    });
    const suggestFootageBtn = document.createElement('button');
    suggestFootageBtn.type = 'button';
    suggestFootageBtn.className = 'btn-secondary storyboard-act-board-node-action storyboard-act-board-suggest-footage-btn';
    suggestFootageBtn.textContent = 'Visualize highlights';
    suggestFootageBtn.disabled = node.status !== 'ready' || !hasRecordedNarration
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
      document.createTextNode(' Include in playback'));
    recordActionRow.append(
      recordButton, uploadNarrationButton, narrationPlaybackLabel,
    );
    // Keep footage generation directly beneath the adjacent narration readout
    // rather than mixing it into the recording controls in the node header.
    narrationSidePreview.appendChild(suggestFootageBtn);
    // Keep recording and upload actions in the narration node top so CSS can
    // place them immediately below its preview; footage suggestion stays with
    // the adjacent narration readout.
    top.insertBefore(recordActionRow, topActions);
    card._actBoardNodeActionRow = recordActionRow;
    card._actBoardNodeActionRowParent = top;
    card._actBoardNodeActionRowAnchor = topActions;
    const idleRecordIcon = () => node.audioPreviewUrl ? '↻' : '⏺';
    const setRecordButtonStatus = (message = '', isError = false) => {
      const status = String(message || '').trim();
      const recorderState = actBoardNarrationRecorderStates.get(String(node.id));
      const recording = node.recordingStatus === 'recording'
        || recorderState?.recorder?.state === 'recording';
      const processing = node.recordingStatus === 'processing';
      const failed = node.recordingStatus === 'error' || isError;
      const icon = recording ? '●' : processing ? '…' : failed ? '!' : idleRecordIcon();
      const accessibleLabel = recording ? 'Stop recording narration'
        : processing ? 'Processing narration'
          : failed ? 'Narration recording failed'
            : node.audioPreviewUrl ? 'Record narration again' : 'Record narration';
      recordButton.textContent = icon;
      recordButton.title = status || accessibleLabel;
      recordButton.setAttribute('aria-label', accessibleLabel);
      recordButton.setAttribute('aria-pressed', String(recording));
      recordButton.classList.toggle('storyboard-act-board-record-narration-btn-error', Boolean(isError));
      recordButton.classList.toggle('is-recording', recording);
      recordButton.classList.toggle('is-processing', processing);
      // Give an untouched narration node the same gentle nudge as the setup
      // page's Next step action. Once a recording exists (or while recording /
      // processing), the record-state styling takes over instead.
      const hasNarration = Boolean(String(node.transcript || '').trim()
        || node.audioPreviewUrl || node._nativePreviewUrl);
      recordButton.classList.toggle('is-empty', !hasNarration && !recording && !processing);
      // A rebuilt source button must preserve the processing lock as well;
      // otherwise its scene-rail proxy could start a second recording while
      // the first blob is uploading/transcribing.
      recordButton.disabled = processing;
      // The visible scene-rail button proxies this control because narration
      // shells no longer render their full body on the canvas. Mirror the
      // state immediately so recording feedback is visible at the point of
      // interaction instead of waiting for the eventual rerender.
      // The per-slide status label follows the same state as the button.
      document.querySelectorAll('.storyboard-act-board-record-status').forEach(label => {
        if (label.dataset.narrationNodeId !== String(node.id)) return;
        const text = (recording || processing || failed) ? (status || accessibleLabel) : '';
        label.textContent = text;
        label.hidden = !text;
        label.classList.toggle('is-recording', recording);
        label.classList.toggle('is-processing', processing);
        label.classList.toggle('is-error', failed);
      });
      document.querySelectorAll('.storyboard-act-board-scene-record-narration-btn')
        .forEach(proxy => {
          if (proxy.dataset.narrationNodeId !== String(node.id)) return;
          proxy.textContent = recordButton.textContent;
          proxy.title = recordButton.title;
          proxy.setAttribute('aria-label', recordButton.getAttribute('aria-label') || 'Record narration');
          proxy.setAttribute('aria-pressed', String(recording));
          proxy.disabled = Boolean(recordButton.disabled);
          ['is-empty', 'is-recording', 'is-processing', 'storyboard-act-board-record-narration-btn-error']
            .forEach(stateClass => proxy.classList.toggle(
              stateClass, recordButton.classList.contains(stateClass),
            ));
        });
    };
    const recordStatusController = { _setStatus: setRecordButtonStatus };
    setRecordButtonStatus(
      node.recordingStatus === 'recording' ? 'Recording…'
        : node.recordingStatus === 'processing' ? 'Processing narration…'
          : node.recordingStatus === 'error' ? (node.recordingError || 'Recording failed') : '',
      node.recordingStatus === 'error',
    );
    // The file input stays mounted in the sticky area but remains hidden; the
    // visible Upload narration button above opens it.
    // Keep the hidden file input with the panel-only narration body so the
    // Upload narration button remains wired after the canvas shell is reduced.
    suggestedView.appendChild(uploadNarrationInput);
    const sourceNotesPanel = document.createElement('details');
    sourceNotesPanel.className = 'storyboard-act-board-narration-source-notes';
    sourceNotesPanel.open = false;
    sourceNotesPanel.addEventListener('click', event => event.stopPropagation());
    const sourceNotesSummary = document.createElement('summary');
    sourceNotesSummary.textContent = 'Source material';
    sourceNotesSummary.appendChild(resuggestButton);
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
    // Recorded narration is rendered in the adjacent side preview. Keep the
    // node-content layout available for the audio/source controls followed by
    // the suggested draft and source material.
    let recordedSuggestedNarration = null;
    let recordingAudio = null;
    let recordingTimings = null;
    let recordingAlignment = null;
    if (!node.transcript && node.text) {
      // No highlights on a suggested draft - see the side-preview note above.
      const primaryNarration = buildActBoardSuggestedNarrationText(
        node.text, [],
        null,
        'Suggested narration: ', null, false,
        null, node.pauseWordIndices);
      primaryNarration.classList.add('storyboard-act-board-narration-primary');
      primaryNarration.dataset.actBoardNarrationNodeId = node.id;
      // Suggested copy is a draft, not the spoken track. Entity offsets are
      // measured against the TRANSCRIPT, so painting them here highlights
      // whatever happens to sit at those character positions in different
      // words entirely. Mark it so no highlight pass treats it as a root.
      primaryNarration.dataset.actBoardNarrationSuggested = 'true';
      suggestedView.appendChild(primaryNarration);
      suggestedView.append(sourceNotesPanel);
    } else if (!node.transcript) {
      const text = document.createElement('p');
      text.className = 'storyboard-act-board-node-text';
      const label = document.createElement('strong');
      label.textContent = 'Suggested narration: ';
      text.appendChild(label);
      text.appendChild(document.createTextNode(node.status === 'generating'
        ? 'Drafting suggested narration…' : 'No narration draft yet.'));
      suggestedView.appendChild(text);
      suggestedView.append(sourceNotesPanel);
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
      wireActBoardAudioPreviewSegment(audio, node);
      audio.addEventListener('click', event => event.stopPropagation());
      audio.addEventListener('loadedmetadata', () => {
        if (!(Number(audio.duration) > 0)
          || Math.abs(Number(node.audioDurationSeconds || 0) - audio.duration) < 0.05) return;
        node.audioDurationSeconds = audio.duration;
        packActBoardSceneNarrationStarts(node.actKey, node.sceneId);
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
        // The draft sits next to the real transcript, which is where the
        // highlights belong. Duplicating them here made the same phrase look
        // selectable in copy that was never spoken.
        recordedSuggestedNarration = buildActBoardSuggestedNarrationText(
          node.text, [],
          null,
          'Suggested narration: ', null,
          false,
          null);
        recordedSuggestedNarration.classList.add('storyboard-act-board-narration-primary');
        recordedSuggestedNarration.dataset.actBoardNarrationNodeId = node.id;
        recordedSuggestedNarration.dataset.actBoardNarrationSuggested = 'true';
      }
    }
    if (recordingAudio) {
      // The selected narration node's content panel intentionally does not
      // render a second audio player. Playback belongs to the scene
      // narration section/track, which is the single authoritative player.
      // Keep this element detached so its metadata/source wiring can still be
      // used by the node's timing and recording lifecycle without exposing a
      // duplicate player in node content.
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
    buildActBoardNarrationTimingControls(
      actKey, node, card, narrationTimingMount, suggestedView,
    );
    // Track-segment selection opens this same live body in the persistent
    // content panel. Include the complete transcribed narration there (with
    // the same filmable-phrase highlighting callbacks used by the side
    // preview), followed by the suggested draft below it.
    if (node.transcript) {
      const recordedTranscript = buildActBoardSuggestedNarrationText(
        node.transcript,
        fragments,
        null,
        'Recorded narration: ',
        onFilmableSpanSelect,
        !analysisPending && smartSpans.length > 0,
        onFilmableSpanRemove,
      );
      recordedTranscript.classList.add('storyboard-act-board-node-recorded-transcript');
      recordedTranscript.dataset.actBoardNarrationNodeId = node.id;
      applyActBoardNarrationPhraseSelection(
        recordedTranscript, node, onFilmableSpanRemove,
      );
      suggestedView.appendChild(recordedTranscript);
    }
    if (node.transcript) {
      if (recordedSuggestedNarration) suggestedView.appendChild(recordedSuggestedNarration);
      suggestedView.appendChild(sourceNotesPanel);
    }
    // Keep the alignment source available for diagnostics, but hide it from
    // the narration node-content panel for now.

    // The recorder lives in a segment-keyed runtime registry rather than in
    // this button's closure.  The visible scene-rail button proxies this
    // control, and incremental/full board updates may replace either DOM
    // button while the microphone remains active.
    const existingRecorderState = actBoardNarrationRecorderStates.get(String(node.id));
    if (existingRecorderState) existingRecorderState.button = recordButton;
    recordButton.addEventListener('click', async event => {
      event.stopPropagation();
      const currentState = actBoardNarrationRecorderStates.get(String(node.id));
      if (currentState?.recorder?.state === 'recording') {
        currentState.recorder.stop();
        return;
      }
      // Avoid starting a second getUserMedia request when the presenter
      // clicks again during the short permission/setup window.
      if (currentState?.starting) {
        return;
      }
      stopActBoardNativeAudio();
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
        setActBoardNarrationRecordStatus(recordStatusController,
          'This browser does not support microphone recording.', true);
        return;
      }
      const recorderState = {
        recorder: null,
        stream: null,
        chunks: [],
        starting: true,
        button: recordButton,
      };
      actBoardNarrationRecorderStates.set(String(node.id), recorderState);
      try {
        try {
          recorderState.stream = await navigator.mediaDevices.getUserMedia({
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
          recorderState.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
        // The segment may have been removed or replaced while the permission
        // prompt was open. Do not attach a late recorder to that old node.
        if (actBoardNarrationRecorderStates.get(String(node.id)) !== recorderState) {
          recorderState.stream?.getTracks().forEach(track => track.stop());
          return;
        }
        const preferredMime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
          .find(type => typeof MediaRecorder.isTypeSupported !== 'function'
            || MediaRecorder.isTypeSupported(type)) || '';
        const recorder = preferredMime ? new MediaRecorder(recorderState.stream, { mimeType: preferredMime })
          : new MediaRecorder(recorderState.stream);
        recorderState.recorder = recorder;
        recorder.addEventListener('dataavailable', recordingEvent => {
          if (recordingEvent.data && recordingEvent.data.size) recorderState.chunks.push(recordingEvent.data);
        });
        recorder.addEventListener('stop', () => {
          recorderState.stream?.getTracks().forEach(track => track.stop());
          recorderState.stream = null;
          const mime = recorder.mimeType || preferredMime || 'audio/webm';
          const extension = mime.includes('mp4') ? 'm4a' : 'webm';
          const blob = new Blob(recorderState.chunks, { type: mime });
          node.recordingStatus = 'processing';
          recordButton.disabled = true;
          setActBoardNarrationRecordStatus(recordStatusController, 'Preparing recording…');
          recordActBoardNarration(node, blob, `act-board-${actKey}-${Date.now()}.${extension}`, recordStatusController)
            .finally(() => {
              recordButton.disabled = false;
              if (actBoardNarrationRecorderStates.get(String(node.id)) === recorderState) {
                actBoardNarrationRecorderStates.delete(String(node.id));
              }
            });
        }, { once: true });
        node.recordingStatus = 'recording';
        recorderState.starting = false;
        setActBoardNarrationRecordStatus(recordStatusController, 'Recording…');
        recorder.start();
      } catch (err) {
        recorderState.stream?.getTracks().forEach(track => track.stop());
        recorderState.stream = null;
        if (actBoardNarrationRecorderStates.get(String(node.id)) === recorderState) {
          actBoardNarrationRecorderStates.delete(String(node.id));
        }
        setActBoardNarrationRecordStatus(recordStatusController,
          `Could not start recording: ${err.message}`, true);
      }
    });
    // Fragment words/timestamps remain on the node for synchronization, but
    // are intentionally not rendered in the narration node-content panel.
    if (node.footageNodeIds && node.footageNodeIds.length) {
      const umbrella = document.createElement('div');
      umbrella.className = 'storyboard-act-board-node-umbrella';
      umbrella.textContent = `Umbrella narration over ${node.footageNodeIds.length} linked shot${node.footageNodeIds.length === 1 ? '' : 's'} · ${Number(node.durationSeconds || 0).toFixed(1)}s`;
      // Umbrella narration is still represented by the linked footage graph;
      // keep this summary hidden from the node-content panel for now.
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
    const showFootageInputCoverage = () => {
      const coverageNarration = actBoardNarrationForNode(actKey, node)
        || actBoardNodesForAct(actKey).find(item => item.type === 'narration'
          && item.sceneId && node.sceneId && item.sceneId === node.sceneId) || null;
      const boardLayer = card.closest?.('.storyboard-act-board-node-stack');
      if (!coverageNarration || !boardLayer) return;
      const narrationStart = Math.max(0, Number(coverageNarration.startSeconds) || 0);
      const start = Math.max(0, Number(node.startSeconds) || 0);
      highlightActBoardNarrationTiming(
        boardLayer,
        coverageNarration,
        Math.max(0, start - narrationStart),
        Math.max(0, start - narrationStart + Math.max(0.5, Number(node.durationSeconds) || 0.5)),
      );
    };
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
      refreshActBoardFootageTrackForNode(node);
      showFootageInputCoverage();
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
    let clipVolumeRow = null;
    // When the selected visual has a known natural duration, expose the same
    // draggable source-window affordance used by sound nodes. This edits the
    // source in/out portion without changing the node's timeline start.
    let selectedSourceEditor = null;
    if (sourceDuration > 0 && node.selectedVisualKey) {
      const sourceEditor = document.createElement('div');
      selectedSourceEditor = sourceEditor;
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
          const scene = actBoardSceneForNode(actKey, node);
          if (scene) scene.timelineDurationSeconds = Math.max(
            Number(scene.timelineDurationSeconds) || 0,
            (Number(node.startSeconds) || 0) + node.durationSeconds,
          );
          refreshActBoardFootageTrackForNode(node);
          showFootageInputCoverage();
          redrawSourceWindow();
        };
        const up = () => {
          target.removeEventListener('pointermove', move);
          target.removeEventListener('pointerup', up);
          target.removeEventListener('pointercancel', up);
          try { target.releasePointerCapture(event.pointerId); } catch (err) { /* optional */ }
          refreshActBoardFootageTrackForNode(node);
          const coverageNarration = actBoardNarrationForNode(actKey, node)
            || actBoardNodesForAct(actKey).find(item => item.type === 'narration'
              && item.sceneId && node.sceneId && item.sceneId === node.sceneId) || null;
          const boardLayer = card.closest?.('.storyboard-act-board-node-stack');
          if (coverageNarration && boardLayer) {
            clearActBoardNarrationTimingHighlight(boardLayer, coverageNarration);
          }
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
      // Uploads stay in the gallery as cards of their own. Before this, an
      // upload lived only in mediaUrl and vanished from the gallery the moment
      // another option was chosen, so there was no way back to it.
      ...(Array.isArray(node.uploadedVisuals) ? node.uploadedVisuals.map((upload, index) => ({
        key: `upload-${index}`,
        kind: upload.kind || 'video',
        url: upload.url || '',
        thumbnailUrl: upload.thumbnailUrl || upload.url || '',
        hasThumbnail: Boolean(upload.thumbnailUrl),
        label: upload.label || (upload.kind === 'image' ? `Uploaded image ${index + 1}` : `Uploaded footage ${index + 1}`),
        uploadedIndex: index,
        source: 'Uploaded by user',
        durationSeconds: Number(upload.sourceDurationSeconds) || 0,
      })) : []),
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
        durationSeconds: Number(option.duration_seconds) || 0,
        shotSize: option.shot_size || '',
        movement: option.movement || '',
        techniques: Array.isArray(option.techniques)
          ? option.techniques
          : (Array.isArray((option.shotPlan || option.shot_plan)?.techniques)
            ? (option.shotPlan || option.shot_plan).techniques : []),
        shotPlan: option.shotPlan || option.shot_plan || {},
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
    const splitCompositionVisual = node.compositionMode === 'split-screen'
      && node.selectedVisualKey === 'split-screen'
      ? {
        key: 'split-screen',
        kind: 'split-screen',
        label: 'Split screen',
        source: 'Split screen',
      } : null;
    const selectedVisual = uploadedVisual || (node.selectedVisualKey
      ? visualOptions.find(option => option.key === node.selectedVisualKey) || splitCompositionVisual
      : splitCompositionVisual);

    // Keep the canvas shell useful even though the detailed gallery lives in
    // the selected-node panel. Show the currently selected visual (or a clear
    // empty state) directly inside the footage shape so users can identify a
    // node at a glance without opening its panel.
    const nodePreview = document.createElement('div');
    nodePreview.className = 'storyboard-act-board-footage-node-preview';
    if (splitCompositionVisual) {
      nodePreview.classList.add('split-screen');
      const splitPreviewNodes = (node.splitScreenNodeIds || [])
        .map(id => actBoardNodesForAct(actKey)
          .find(item => item.type === 'footage' && item.id === id))
        .filter(Boolean);
      splitPreviewNodes.forEach(splitNode => {
        const splitVisual = actBoardVisualForKey(splitNode, splitNode.selectedVisualKey);
        const pane = document.createElement('div');
        pane.className = 'storyboard-act-board-footage-split-pane';
        if (splitVisual && (splitVisual.url || splitVisual.thumbnailUrl)) {
          const image = document.createElement('img');
          image.src = splitVisual.thumbnailUrl || splitVisual.url;
          image.alt = footageNodeVisualSummary(splitNode) || 'Split-screen source';
          image.loading = 'lazy';
          image.decoding = 'async';
          pane.appendChild(image);
        }
        nodePreview.appendChild(pane);
      });
      nodePreview.setAttribute('aria-label', 'Selected split-screen footage preview');
    } else if (selectedVisual && (selectedVisual.url || selectedVisual.thumbnailUrl)) {
      const previewSource = selectedVisual.thumbnailUrl || selectedVisual.url;
      if (selectedVisual.kind === 'video' && selectedVisual.url) {
        const previewVideo = document.createElement('video');
        previewVideo.src = selectedVisual.url;
        previewVideo.poster = selectedVisual.thumbnailUrl || '';
        previewVideo.muted = true;
        previewVideo.playsInline = true;
        // The canvas preview is a visual marker, not a transport. Keep the
        // poster cheap and defer video decoding until the presenter opens the
        // selected node/player, rather than decoding every footage card after
        // each Act Board render.
        previewVideo.autoplay = false;
        previewVideo.loop = false;
        previewVideo.preload = 'none';
        previewVideo.setAttribute('aria-hidden', 'true');
        nodePreview.appendChild(previewVideo);
      } else {
        const previewImage = document.createElement('img');
        previewImage.src = previewSource;
        previewImage.alt = selectedVisual.label || node.fragment || 'Selected footage';
        previewImage.loading = 'lazy';
        previewImage.decoding = 'async';
        previewImage.fetchPriority = 'low';
        nodePreview.appendChild(previewImage);
      }
      nodePreview.setAttribute('aria-label', selectedVisual.label || 'Selected footage preview');
    } else {
      nodePreview.classList.add('is-empty');
      nodePreview.textContent = 'No footage selected yet';
    }
    top.insertBefore(nodePreview, topActions);

    // Keep the compact title in the canvas shell, directly over the selected
    // preview. Linked footage gets two rows (the narration anchor, then the
    // selected visual's specific phrase/query); presenter uploads get their
    // own label even when they are not linked to narration. Mount a hidden
    // shell for every footage card so targeted media/label updates can reveal
    // it without rebuilding the scene.
    const titleParts = actBoardFootageNodeTitleParts(actKey, node);
    const compactFragment = document.createElement('div');
    compactFragment.className = 'storyboard-act-board-node-fragment-title storyboard-act-board-footage-node-fragment-title';
    compactFragment.hidden = !titleParts.hasTitle;
    const narrationRow = document.createElement('div');
    narrationRow.className = 'storyboard-act-board-footage-node-fragment-narration';
    narrationRow.hidden = !titleParts.narration;
    const compactFragmentLabel = document.createElement('span');
    compactFragmentLabel.className = 'storyboard-act-board-node-fragment-label';
    compactFragmentLabel.textContent = 'Narration:';
    const compactFragmentNarration = document.createElement('span');
    compactFragmentNarration.className = 'storyboard-act-board-node-fragment-text';
    compactFragmentNarration.textContent = titleParts.narration;
    narrationRow.append(compactFragmentLabel, compactFragmentNarration);
    const detailRow = document.createElement('div');
    detailRow.className = 'storyboard-act-board-footage-node-fragment-detail';
    detailRow.textContent = titleParts.detail;
    compactFragment.append(narrationRow, detailRow);
    top.insertBefore(compactFragment, topActions);

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
          // Let an explicit click on the native play control start preview
          // playback. Generated videos are muted below so their incidental
          // model soundtrack is never treated as the documentary mix.
          video.autoplay = false;
          // Loop only the node's selected source window, not the entire source
          // video. The timing controls below update this window live.
          video.loop = false;
          const muteGeneratedAudio = visual.source === 'AI-generated'
            || visual.generatedIndex != null;
          video.muted = muteGeneratedAudio;
          video.volume = muteGeneratedAudio ? 0 : actBoardNodeVolume(node, 0.5);
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
            image.decoding = 'async';
            video.replaceWith(image);
          }, { once: true });
          container.appendChild(video);
        } else {
          const image = document.createElement('img');
          image.src = visual.thumbnailUrl || visual.url;
          image.alt = visual.label || label || node.fragment || 'Selected footage';
          image.loading = 'lazy';
          image.decoding = 'async';
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
      pinButton.textContent = option.pinned ? '◉' : '◎';
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
    const splitVisualNodes = node.compositionMode === 'split-screen'
      ? (node.splitScreenNodeIds || [])
        .map(id => actBoardNodesForAct(actKey).find(item => item.type === 'footage' && item.id === id))
        .filter(Boolean)
      : [];
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
    if (splitVisualNodes.length >= 2) {
      featured.classList.add('split-screen');
      const splitVisuals = splitVisualNodes.map(splitNode => ({
        node: splitNode,
        visual: actBoardVisualForKey(splitNode, splitNode.selectedVisualKey) || {
          kind: splitNode.mediaKind || 'image',
          url: splitNode.mediaUrl || splitNode.results?.[0]?.video_url || '',
          thumbnailUrl: splitNode.mediaThumbnailUrl
            || splitNode.results?.[0]?.thumbnail_url || splitNode.mediaUrl || '',
          label: footageNodeVisualSummary(splitNode),
        },
      }));
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
      const selectedTechniques = Array.isArray(selectedVisual?.techniques)
        ? selectedVisual.techniques.filter(Boolean) : [];
      const selectedPhrase = actBoardVisualDisplayPhrase(node, selectedVisual);
      const selectedSourceLabel = [
        selectedSource,
        selectedPhrase,
        ...(selectedSource === 'AI-generated' && selectedTechniques.length
          ? [selectedTechniques.join(', ')] : []),
      ].filter(Boolean).join(' · ');
      sourceBadge.textContent = selectedSourceLabel;
      sourceBadge.title = selectedSourceLabel;
      featured.appendChild(sourceBadge);
    }
    const selectedLabel = document.createElement('span');
    selectedLabel.className = 'storyboard-act-board-footage-featured-label';
    selectedLabel.textContent = 'Selected';
    featured.appendChild(selectedLabel);
    visualGallery.appendChild(featured);
    // User uploads can carry a presenter-defined label. Keep it outside the
    // media frame so it remains easy to edit without obscuring the preview;
    // the same value is reused by the node/card banners and scene captions.
    if (selectedVisual?.key === 'upload') {
      const uploadLabelEditor = document.createElement('label');
      uploadLabelEditor.className = 'storyboard-act-board-footage-upload-label-editor';
      const uploadLabelText = document.createElement('span');
      uploadLabelText.textContent = 'Upload label';
      const uploadLabelInput = document.createElement('input');
      uploadLabelInput.type = 'text';
      uploadLabelInput.className = 'storyboard-act-board-footage-upload-label';
      uploadLabelInput.value = node.uploadLabel || '';
      uploadLabelInput.placeholder = 'Label this uploaded footage';
      uploadLabelInput.setAttribute('aria-label', 'Label uploaded footage');
      uploadLabelInput.addEventListener('click', event => event.stopPropagation());
      uploadLabelInput.addEventListener('keydown', event => event.stopPropagation());
      uploadLabelInput.addEventListener('input', () => {
        node.uploadLabel = uploadLabelInput.value.trim();
        refreshActBoardSelectedVisualDom(actKey, node);
        saveDebugSession();
      });
      uploadLabelEditor.append(uploadLabelText, uploadLabelInput);
      visualGallery.appendChild(uploadLabelEditor);
    }
    // Keep source-window editing immediately beneath the selected preview,
    // before the alternate thumbnail gallery. The entire gallery is mounted
    // in the selected node-content panel, so this keeps the editor adjacent to
    // the media it controls instead of below unrelated search/generation UI.
    // Clip volume sits directly under the featured footage, above the source
    // editor, with the media it controls.
    // Footage audio is now part of the mix (generated clips are prompted for
    // ambient sound only, never speech), so it needs the same level control
    // sound and narration nodes already have. 0 mutes the clip outright.
    if (actBoardSelectedFootageMedia(node).kind === 'video') {
      const volumeRow = document.createElement('label');
      clipVolumeRow = volumeRow;
      volumeRow.className = 'storyboard-act-board-audio-volume-row'
        + ' storyboard-act-board-footage-volume-row';
      volumeRow.textContent = 'Clip volume';
      const volumeInput = document.createElement('input');
      volumeInput.type = 'range';
      volumeInput.min = '0';
      volumeInput.max = '1';
      volumeInput.step = '0.01';
      volumeInput.value = String(actBoardNodeVolume(node, 0.5));
      volumeInput.title = 'Level of this clip\u2019s own audio in playback and export';
      volumeInput.addEventListener('pointerdown', event => event.stopPropagation());
      volumeInput.addEventListener('input', () => {
        node.volume = Number(volumeInput.value);
        // Reach the element that is actually playing rather than rerendering
        // the board mid-drag.
        const live = card.querySelector('video');
        if (live) {
          live.muted = node.volume <= 0;
          live.volume = node.volume;
        }
        refreshActBoardPlaybackVolumes();
        saveDebugSession();
      });
      volumeRow.appendChild(volumeInput);
    }
    if (clipVolumeRow) visualGallery.appendChild(clipVolumeRow);
    if (selectedSourceEditor) visualGallery.appendChild(selectedSourceEditor);
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
      generatingPlaceholder.className = 'storyboard-act-board-footage-generating-placeholder image-generation';
      generatingPlaceholder.setAttribute('aria-live', 'polite');
      generatingPlaceholder.textContent = 'Image generating…';
      thumbRail.appendChild(generatingPlaceholder);
    }
    const alternateVisualOptions = visualOptions.filter(option =>
      (!selectedVisual || option.key !== selectedVisual.key)
      // The upload currently selected is featured under the 'upload' key; its
      // gallery card would be a duplicate.
      && !(option.uploadedIndex != null && selectedVisual?.key === 'upload'
        && option.url && option.url === (node.mediaUrl || '')));
    // Keep a newly generated single-image result discoverable in the rail
    // even though it is automatically selected. This preserves the normal
    // thumbnail workflow (and lets presenters pick/review the generated
    // option) without duplicating selected stock footage cards.
    if (selectedVisual?.generatedIndex != null
      && !alternateVisualOptions.some(option => option.key === selectedVisual.key)) {
      alternateVisualOptions.push(selectedVisual);
    }
    alternateVisualOptions.forEach(option => {
      // A stock clip already known to be portrait never gets a card.
      if (option.portrait) return;
      const thumbWrap = document.createElement('div');
      thumbWrap.className = 'storyboard-act-board-footage-thumb-wrap';
      const optionButton = document.createElement('button');
      optionButton.type = 'button';
      optionButton.className = 'storyboard-act-board-footage-thumb';
      optionButton.dataset.visualKey = option.key;
      optionButton.disabled = node.downloadStatus === 'downloading';
      optionButton.classList.toggle('selected', selectedVisual && option.key === selectedVisual.key);
      optionButton.title = option.label;
      // Gallery alternatives are navigation thumbnails, not playback
      // surfaces. Do not instantiate a video (and trigger metadata/decode
      // work) for every result; the selected preview is the only place that
      // creates a playable <video>. A result without a poster gets a cheap
      // placeholder and still becomes playable when selected.
      if (option.thumbnailUrl) {
        const image = document.createElement('img');
        image.src = option.thumbnailUrl;
        image.alt = option.label;
        image.loading = 'lazy';
        image.decoding = 'async';
        // Providers without dimensions are measured here, from the poster:
        // a tall one is hidden and its result flagged so the automatic pick
        // and later gallery builds skip it too.
        if (option.resultIndex != null) {
          image.addEventListener('load', () => {
            if (!(image.naturalWidth > 0 && image.naturalHeight > 0)) return;
            if (image.naturalWidth >= image.naturalHeight * ACT_BOARD_STOCK_MIN_ASPECT) return;
            const result = node.results?.[option.resultIndex];
            if (result) result.portrait = true;
            thumbWrap.hidden = true;
          }, { once: true });
        }
        optionButton.appendChild(image);
      } else if (option.url) {
        const placeholder = document.createElement('span');
        placeholder.className = 'storyboard-act-board-footage-thumb-placeholder';
        placeholder.textContent = option.kind === 'video' ? 'Video' : 'Preview';
        optionButton.appendChild(placeholder);
      }
      optionButton.addEventListener('click', async event => {
        event.stopPropagation();
        if (option.uploadedIndex != null) {
          const upload = node.uploadedVisuals?.[option.uploadedIndex];
          if (!upload) return;
          // Becomes the current upload under the same 'upload' key the rest
          // of the board already understands (export path, upload prompt,
          // split panes), so nothing downstream needs a new case.
          node.mediaUrl = upload.url || '';
          node.mediaThumbnailUrl = upload.thumbnailUrl || upload.url || '';
          node.mediaKind = upload.kind || 'video';
          node.mediaOrigin = 'upload';
          node.uploadedFilePath = upload.filePath || null;
          node.selectedVisualKey = 'upload';
          node.selectedGeneratedIndex = null;
          node.selectedResultIndex = null;
          node.sourceDurationSeconds = Number(upload.sourceDurationSeconds) || 0;
          node.trimStartSeconds = 0;
          if (node.mediaKind === 'video' && node.timingWasManuallyAdjusted !== true
            && node.sourceDurationSeconds > 0) {
            node.durationSeconds = node.sourceDurationSeconds;
            node.durationWasSuggested = false;
          }
          // The rail changes shape here (the previous upload returns to it,
          // this one leaves it), which the in-place refresh does not do.
          saveDebugSession();
          rerenderActBoard({ preservePlayback: true });
          return;
        }
        if (option.generatedIndex != null) {
          const generated = node.generatedOptions[option.generatedIndex];
          node.selectedVisualKey = option.key;
          node.selectedGeneratedIndex = option.generatedIndex;
          node.mediaUrl = generated.url || '';
          node.mediaThumbnailUrl = generated.thumbnail_url || generated.url || '';
          node.mediaKind = generated.kind || 'image';
          node.mediaOrigin = 'generated';
          node.shotPlan = generated.shotPlan || node.shotPlan || {};
          syncActBoardImageTechniquesForVisual(node, generated);
          node.sourceDurationSeconds = Number(generated.duration_seconds || generated.duration) || 0;
          node.trimStartSeconds = 0;
          if (generated.kind === 'video' && node.timingWasManuallyAdjusted !== true
            && node.sourceDurationSeconds > 0) {
            node.durationSeconds = node.sourceDurationSeconds;
            node.durationWasSuggested = false;
          }
          // Selecting an already-loaded generated visual is synchronous. Keep
          // the gallery and featured preview in place instead of rebuilding
          // the whole board.
          if (!refreshActBoardSelectedVisualDom(actKey, node)) rerenderActBoard();
          saveDebugSession();
          return;
        } else if (option.resultIndex != null) {
          const result = node.results[option.resultIndex];
          if (!result?.video_url) return;
          optionButton.disabled = true;
          const downloadJobKey = `${actKey}:${node.id}`;
          const previousDownload = actBoardFootageDownloadJobs.get(downloadJobKey);
          if (previousDownload?.controller) {
            try { previousDownload.controller.abort(); } catch (err) { /* already finished */ }
          }
          const downloadController = typeof AbortController === 'function'
            ? new AbortController() : null;
          const downloadToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
          let downloadWasCurrent = false;
          actBoardFootageDownloadJobs.set(downloadJobKey, {
            controller: downloadController,
            token: downloadToken,
          });
          // Downloading a selected result is not a new stock search. Keep the
          // ready state so the stock-search placeholder does not reappear.
          node.downloadStatus = 'downloading';
          node.error = '';
          saveDebugSession();
          let downloadNeedsRender = false;
          try {
            const downloaded = await fetchDownloadStockMedia(
              actBoardAssetSectionIndex(node),
              'video',
              result.video_url,
              premiereProjectId,
              // The minimum duration is a search/playback safeguard, not a
              // permission check. Let the presenter download a selected clip
              // even when it is shorter than the node's requested duration;
              // the response's real duration is then used to bound playback.
              0,
              result.id || node.id,
              downloadController?.signal,
            );
            if (actBoardFootageDownloadJobs.get(downloadJobKey)?.token !== downloadToken) return;
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
            if (actBoardFootageDownloadJobs.get(downloadJobKey)?.token === downloadToken
              && !isGenerationAbort(err)) {
              node.error = `Could not download footage: ${err.message}`;
              downloadNeedsRender = true;
            }
          } finally {
            if (actBoardFootageDownloadJobs.get(downloadJobKey)?.token === downloadToken) {
              downloadWasCurrent = true;
              actBoardFootageDownloadJobs.delete(downloadJobKey);
              node.downloadStatus = '';
            }
          }
          if (!downloadWasCurrent) return;
          if (downloadNeedsRender || !refreshActBoardSelectedVisualDom(actKey, node)) {
            rerenderActBoard();
          }
        }
        saveDebugSession();
      });
      thumbWrap.appendChild(optionButton);
      if (option.source) {
        const sourceBadge = document.createElement('small');
        sourceBadge.className = 'storyboard-act-board-footage-source';
        const optionTechniques = Array.isArray(option.techniques)
          ? option.techniques.filter(Boolean) : [];
        const optionPhrase = actBoardVisualDisplayPhrase(node, option);
        const optionSourceLabel = [
          option.source,
          optionPhrase,
          ...(option.source === 'AI-generated' && optionTechniques.length
            ? [optionTechniques.join(', ')] : []),
        ].filter(Boolean).join(' · ');
        sourceBadge.textContent = optionSourceLabel;
        sourceBadge.title = optionSourceLabel;
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

    const footageSearchPanel = document.createElement('div');
    footageSearchPanel.className = 'storyboard-act-board-suggested-side-panel storyboard-act-board-footage-search-panel';
    footageSearchPanel.addEventListener('click', event => event.stopPropagation());
    const generationControls = document.createElement('div');
    generationControls.className = 'storyboard-act-board-node-generation-controls';
    const footageSearchInputs = document.createElement('details');
    footageSearchInputs.className = 'storyboard-act-board-generation-inputs storyboard-act-board-footage-search-inputs';
    footageSearchInputs.open = node.footageSearchInputsOpen === true
      || node.status === 'generating';
    footageSearchInputs.addEventListener('toggle', () => {
      node.footageSearchInputsOpen = footageSearchInputs.open;
      saveDebugSession();
    });
    const footageSearchInputsSummary = document.createElement('summary');
    footageSearchInputsSummary.textContent = 'Stock footage search inputs';
    footageSearchInputs.appendChild(footageSearchInputsSummary);
    const footageSearchLabel = document.createElement('input');
    footageSearchLabel.type = 'text';
    footageSearchLabel.className = 'storyboard-act-board-footage-search-label storyboard-act-board-footage-search-input';
    // Visualize supplies a filmability query before stock search returns its
    // concrete provider query. Show the concrete query when available and
    // fall back to that seed so the input is never blank for generated cards.
    footageSearchLabel.value = node.query || node.filmabilityQuery || node.fragment || '';
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
    footageSearchInputs.appendChild(footageSearchLabel);
    const showGenerationInputs = panel => {
      [footageSearchInputs, imageInputsPanel, videoInputsPanel]
        .filter(Boolean)
        .forEach(item => {
          item.open = item === panel;
        });
    };
    const findFootageButton = document.createElement('button');
    findFootageButton.type = 'button';
    findFootageButton.className = 'btn-secondary storyboard-act-board-node-action storyboard-act-board-find-footage-btn';
    findFootageButton.textContent = node.status === 'generating' ? 'Finding footage…' : 'Find footage';
    findFootageButton.disabled = node.status === 'generating';
    findFootageButton.addEventListener('click', event => {
      event.stopPropagation();
      event.preventDefault();
      showGenerationInputs(footageSearchInputs);
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
    footageSearchInputsSummary.appendChild(findFootageButton);
    generationControls.appendChild(footageSearchInputs);
    // Keep the search and generation controls directly under the selected
    // footage gallery; each workflow owns its own collapsible inputs.
    card.appendChild(footageSearchPanel);
    const generateExamplesBtn = document.createElement('button');
    generateExamplesBtn.type = 'button';
    generateExamplesBtn.className = 'btn-secondary storyboard-act-board-node-action storyboard-act-board-generate-images-btn';
    generateExamplesBtn.textContent = node.generationStatus === 'generating-images'
      ? 'Generating image…' : 'Generate image';
    generateExamplesBtn.disabled = node.generationStatus === 'generating-images' || node.generationStatus === 'generating-video';
    generateExamplesBtn.addEventListener('click', event => {
      event.stopPropagation();
      event.preventDefault();
      showGenerationInputs(imageInputsPanel);
      node.imageGenerationInputsOpen = true;
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
    generateVideoBtn.className = 'btn-secondary storyboard-act-board-node-action storyboard-act-board-generate-video-btn';
    generateVideoBtn.textContent = node.generationStatus === 'generating-video'
      ? 'Generating video…' : 'Generate video';
    const configuredStartVisual = node.twoFrameVideoEnabled === true
      ? actBoardVisualForKey(node, node.videoStartFrameKey || node.selectedVisualKey)
      : null;
    const hasSelectedImage = Boolean(
      (selectedGenerated && selectedGenerated.kind !== 'video' && selectedGenerated.url)
      || (node.mediaKind === 'image' && (node.mediaUrl || node.mediaThumbnailUrl))
      || (configuredStartVisual && configuredStartVisual.kind !== 'video'
        && (configuredStartVisual.url || configuredStartVisual.thumbnailUrl)),
    );
    generateVideoBtn.disabled = !hasSelectedImage
      || node.generationStatus === 'generating-images' || node.generationStatus === 'generating-video';
    generateVideoBtn.addEventListener('click', event => {
      event.stopPropagation();
      event.preventDefault();
      showGenerationInputs(videoInputsPanel);
      node.videoGenerationInputsOpen = true;
      // Read both editable shot-plan fields at click time so the latest
      // keystroke is included even if the browser has not dispatched blur yet.
      const visualField = videoInputsPanel.querySelector('.storyboard-act-board-shot-plan-visual-editor');
      if (visualField) {
        node.shotPlan = {
          ...(node.shotPlan || {}),
          visual_description: visualField.value.slice(0, 1000),
          user_visual_field: visualField.value.slice(0, 1000),
          subject_action: visualField.value.slice(0, 1000),
        };
        saveDebugSession();
      }
      generateActBoardNodeVideo(actKey, act, node);
    });
    const imageInputs = actBoardImageGenerationInputs(actKey, act, node);
    const imageInputsPanel = document.createElement('details');
    imageInputsPanel.className = 'storyboard-act-board-generation-inputs storyboard-act-board-image-generation-inputs';
    imageInputsPanel.open = node.imageGenerationInputsOpen === true
      || node.generationStatus === 'generating-images';
    imageInputsPanel.addEventListener('toggle', () => {
      node.imageGenerationInputsOpen = imageInputsPanel.open;
      saveDebugSession();
    });
    const imageInputsSummary = document.createElement('summary');
    imageInputsSummary.textContent = 'Image generation inputs';
    imageInputsSummary.appendChild(generateExamplesBtn);
    applyActBoardReferenceSummaryThumb(imageInputsSummary, node);
    imageInputsPanel.appendChild(imageInputsSummary);
    imageInputsPanel.appendChild(buildActBoardReferenceInputRow(node));
    const inputRows = [
      ['Specific phrase', imageInputs.phrase],
      ['Shot plan', null],
      ['Scene techniques', imageInputs.techniques.join(' · ')],
      ['Documentary mode', imageInputs.documentaryMode],
    ];
    const editTechniquesButton = document.createElement('button');
    editTechniquesButton.type = 'button';
    editTechniquesButton.className = 'btn-secondary storyboard-act-board-image-generation-edit-techniques';
    editTechniquesButton.textContent = 'Edit techniques';
    editTechniquesButton.addEventListener('click', event => {
      event.stopPropagation();
      openActBoardTechniquePopup(actKey, node, {
        allowedCategories: ACT_BOARD_IMAGE_TECHNIQUE_CATEGORIES,
        targetField: 'imageGenerationTechniques',
        title: 'Scene techniques',
        hint: 'Choose only shot composition, lighting, or visual metaphor/data-vis techniques for this image.',
      });
    });
    inputRows.forEach(([label, value]) => {
      const row = document.createElement('div');
      row.className = 'storyboard-act-board-image-generation-input-row';
      const name = document.createElement('span');
      name.className = 'storyboard-act-board-image-generation-input-label';
      name.textContent = label;
      let content;
      if (label === 'Specific phrase') {
        const phraseInput = document.createElement('textarea');
        phraseInput.rows = 3;
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
      } else if (label === 'Shot plan') {
        // A div, not a span: renderActBoardImageShotPlanRows fills it with one
        // block-level row per field, label bolded, rather than one flat string.
        content = document.createElement('div');
        content.className = 'storyboard-act-board-image-generation-input-value'
          + ' storyboard-act-board-image-generation-shot-plan-value';
        content.dataset.nodeId = node.id;
        content.title = 'Shot plan saved with the selected generated image';
        row.classList.add('storyboard-act-board-shot-plan-context-row');
        renderActBoardImageShotPlanRows(content, node, selectedVisual);
      } else {
        content = document.createElement('span');
        content.className = 'storyboard-act-board-image-generation-input-value';
        content.textContent = value || 'None';
      }
      if (label === 'Scene techniques') {
        row.classList.add('storyboard-act-board-image-generation-techniques-row');
        const contentCell = document.createElement('div');
        contentCell.className = 'storyboard-act-board-image-generation-input-value-with-action';
        contentCell.append(content, editTechniquesButton);
        row.append(name, contentCell);
      } else {
        row.append(name, content);
      }
      imageInputsPanel.appendChild(row);
    });
    const excludedInputs = document.createElement('div');
    excludedInputs.className = 'storyboard-act-board-image-generation-inputs-note';
    // excludedInputs.textContent = 'Combined-concept prompts are not used for this Act Board image.';
    imageInputsPanel.appendChild(excludedInputs);
    generationControls.appendChild(imageInputsPanel);

    const videoInputs = actBoardGenerationContext(actKey, act, node);
    const videoStartVisual = node.twoFrameVideoEnabled === true
      ? actBoardVisualForKey(node, node.videoStartFrameKey || node.selectedVisualKey)
      : selectedVisual;
    const videoInputsPanel = document.createElement('details');
    videoInputsPanel.className = 'storyboard-act-board-generation-inputs storyboard-act-board-image-generation-inputs storyboard-act-board-video-generation-inputs';
    videoInputsPanel.open = node.videoGenerationInputsOpen === true
      || node.generationStatus === 'generating-video';
    videoInputsPanel.addEventListener('toggle', () => {
      node.videoGenerationInputsOpen = videoInputsPanel.open;
      saveDebugSession();
    });
    const videoInputsSummary = document.createElement('summary');
    videoInputsSummary.textContent = 'Video generation inputs';
    videoInputsSummary.appendChild(generateVideoBtn);
    applyActBoardReferenceSummaryThumb(videoInputsSummary, node);
    videoInputsPanel.appendChild(videoInputsSummary);
    const videoReferenceRow = buildActBoardReferenceInputRow(node);
    videoInputsPanel.appendChild(videoReferenceRow);
    const shotPlan = {
      ...(videoStartVisual?.shotPlan || selectedGenerated?.shotPlan || node.shotPlan || {}),
    };
    // Camera motion is intentionally read-only for now. Derive one clear
    // direction from the shot plan's narrative operation (falling back to
    // the planner's structured movement) so users do not have to manage this
    // advanced control themselves.
    const animationDirection = actBoardSuggestedCameraDirection(shotPlan);
    node.animationDirection = animationDirection;
    shotPlan.animation_direction = animationDirection;
    const editableGenerated = videoStartVisual?.generatedIndex != null
      ? node.generatedOptions?.[videoStartVisual.generatedIndex]
      : selectedGenerated;
    const videoInputRows = new Map();
    [
      ['Documentary mode', videoInputs.documentaryMode],
    ].forEach(([label, value]) => {
      const row = document.createElement('div');
      row.className = 'storyboard-act-board-image-generation-input-row';
      const name = document.createElement('span');
      name.className = 'storyboard-act-board-image-generation-input-label';
      name.textContent = label;
      const content = document.createElement('span');
      content.className = 'storyboard-act-board-image-generation-input-value';
      content.textContent = value || 'None';
      row.append(name, content);
      videoInputsPanel.appendChild(row);
      videoInputRows.set(label, row);
    });
    const visualFieldRow = document.createElement('div');
    visualFieldRow.className = 'storyboard-act-board-image-generation-input-row storyboard-act-board-shot-plan-visual-row';
    const visualFieldLabel = document.createElement('span');
    visualFieldLabel.className = 'storyboard-act-board-image-generation-input-label';
    visualFieldLabel.textContent = 'Visual field';
    const visualFieldEditor = document.createElement('textarea');
    visualFieldEditor.className = 'storyboard-act-board-image-generation-input-editable storyboard-act-board-shot-plan-visual-editor';
    visualFieldEditor.rows = 3;
    visualFieldEditor.maxLength = 1000;
    visualFieldEditor.value = String(
      shotPlan.user_visual_field || shotPlan.visual_description || '',
    );
    visualFieldEditor.placeholder = 'Describe the visible subject, setting, action, staging, and composition.';
    visualFieldEditor.setAttribute('aria-label', 'Editable visual field for the shot plan');
    visualFieldEditor.addEventListener('click', event => event.stopPropagation());
    visualFieldEditor.addEventListener('pointerdown', event => event.stopPropagation());
    const persistVisualField = () => {
      const editedVisual = visualFieldEditor.value.slice(0, 1000);
      node.shotPlan = {
        ...(node.shotPlan || {}),
        visual_description: editedVisual,
        user_visual_field: editedVisual,
        subject_action: editedVisual,
      };
      if (editableGenerated) {
        editableGenerated.shotPlan = {
          ...(editableGenerated.shotPlan || {}),
          visual_description: editedVisual,
          user_visual_field: editedVisual,
          subject_action: editedVisual,
        };
      }
    };
    visualFieldEditor.addEventListener('input', persistVisualField);
    visualFieldEditor.addEventListener('change', () => {
      persistVisualField();
      saveDebugSession();
    });
    visualFieldEditor.addEventListener('blur', () => {
      persistVisualField();
      saveDebugSession();
    });
    visualFieldRow.append(visualFieldLabel, visualFieldEditor);
    videoInputsPanel.appendChild(visualFieldRow);
    const animationDirectionBlock = document.createElement('div');
    animationDirectionBlock.className = 'storyboard-act-board-animation-direction';
    const animationDirectionHeading = document.createElement('strong');
    animationDirectionHeading.textContent = 'Suggested camera motion';
    animationDirectionBlock.appendChild(animationDirectionHeading);
    const animationDirectionHint = document.createElement('small');
    const operationLabel = String(shotPlan.narrative_operation || '').trim().replaceAll('_', ' ');
    animationDirectionHint.textContent = operationLabel
      ? `Derived from the narrative operation “${operationLabel}”.`
      : 'Derived from the shot plan; it will guide the animation automatically.';
    animationDirectionBlock.appendChild(animationDirectionHint);
    const animationDirectionValue = document.createElement('div');
    animationDirectionValue.className = 'storyboard-act-board-animation-direction-value';
    animationDirectionValue.textContent = animationDirection;
    animationDirectionValue.setAttribute('aria-label', 'Suggested camera motion direction');
    animationDirectionBlock.appendChild(animationDirectionValue);
    // Keep the visible video inputs focused: selected image, editable visual
    // field, derived camera motion, and documentary mode. The remaining
    // narration/phrase context is still sent to the generation API, but is not
    // repeated in this compact panel.
    const documentaryModeRow = videoInputRows.get('Documentary mode');
    if (documentaryModeRow) {
      videoInputsPanel.insertBefore(visualFieldRow, documentaryModeRow);
      videoInputsPanel.insertBefore(animationDirectionBlock, documentaryModeRow);
    } else {
      videoInputsPanel.append(visualFieldRow, animationDirectionBlock);
    }
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
  // Keep all of a node's live content in one body wrapper. The selected-node
  // view can temporarily move this wrapper into the right panel without
  // cloning or re-wiring any inputs, so controls remain bound to the same
  // node object while the card itself stays as a header-only canvas marker.
  const nodeBody = document.createElement('div');
  nodeBody.className = 'storyboard-act-board-node-body';
  Array.from(card.children).forEach(child => {
    if (child === nodeStickyBanner || child === top || child === narrationSidePreview) return;
    nodeBody.appendChild(child);
  });
  card.appendChild(nodeBody);
  card._actBoardNodeBody = nodeBody;
  // Source-window editors live in the selected-node content panel only; keep
  // the canvas nodes focused on their visual/audio representation.
  if (node.type === 'footage') {
    card.addEventListener('click', event => {
      if (event.target.closest('button, input, audio, a, select, textarea, label, details, summary, .storyboard-act-board-node-resize-handle')) return;
      highlightActBoardFootageNode(boardLayer, node.id);
    });
    // The selected visual can replace the upload prompt after this card is
    // built. Recalculate link geometry whenever an image/video finishes
    // loading (including cached media that is already complete).
    card.querySelectorAll('img, video').forEach(media => {
      ['load', 'loadedmetadata', 'loadeddata', 'canplay'].forEach(eventName => {
        media.addEventListener(eventName, () => scheduleActBoardLinkPathRefresh(boardLayer));
      });
      if (media.complete || Number(media.readyState) >= 1) {
        scheduleActBoardLinkPathRefresh(boardLayer);
      }
    });
  }
  wireActBoardNodeResizing(card, node, boardLayer);
  return card;
}

function focusActBoardNode(boardLayer, card, node) {
  if (!boardLayer || !card) return;
  const stack = boardLayer.closest('.storyboard-act-board-node-stack') || boardLayer;
  const board = stack.closest('.storyboard-act-board-view') || stack;
  board.querySelectorAll('.storyboard-act-board-node--focused').forEach(item => {
    item.classList.remove('storyboard-act-board-node--focused');
  });
  // Focus and footage-track selection are separate states (the latter is
  // also used when a segment is clicked). Remove the stale footage treatment
  // whenever focus moves to narration, audio, playback, or another footage
  // card. The selected card/segment is re-applied by
  // highlightActBoardFootageNode when the new node is footage.
  board.querySelectorAll('.storyboard-act-board-node-footage.act-board-footage-selected')
    .forEach(item => item.classList.remove('act-board-footage-selected'));
  board.querySelectorAll('.storyboard-act-board-footage-track-segment.selected')
    .forEach(item => item.classList.remove('selected'));
  card.classList.add('storyboard-act-board-node--focused');
  bringActBoardNodeToFront(boardLayer, card, node);
  highlightActBoardPlaybackTrackNode(boardLayer, node);
  boardLayer._actBoardActiveNodeId = node?.id || '';
  actBoardSelectedNodeId = node?.id || '';
  actBoardSelectedNodeActKey = boardLayer
    .closest('.storyboard-act-board-column')?.dataset.actKey || '';
}

function appendActBoardNodeDetailField(container, label, value, className = '') {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const row = document.createElement('div');
  row.className = `storyboard-act-board-full-playback-node-detail-field${className ? ` ${className}` : ''}`;
  const labelEl = document.createElement('strong');
  labelEl.textContent = label;
  const valueEl = document.createElement('span');
  valueEl.textContent = text;
  row.append(labelEl, valueEl);
  container.appendChild(row);
  return row;
}

function buildActBoardNodeDetailView(actKey, act, node) {
  const content = document.createElement('div');
  content.className = 'storyboard-act-board-full-playback-node-detail-content';
  if (!node) {
    const empty = document.createElement('p');
    empty.className = 'storyboard-act-board-full-playback-node-detail-empty';
    empty.textContent = 'Select a node on the Act Board to inspect its content.';
    content.appendChild(empty);
    return content;
  }

  appendActBoardNodeDetailField(content, 'Timing', actBoardPlaybackTimingLabel(
    node.startSeconds,
    node.durationSeconds || (node.type === 'narration' ? estimateActBoardNarrationSeconds(node.text) : 1),
  ));

  if (node.type === 'narration') {
    // Narration text is rendered in the canvas-side preview so it has one
    // authoritative, highlightable presentation. Do not duplicate a recorded
    // transcript in this fallback node-content view.
    appendActBoardNodeDetailField(content, 'Source material', node.sceneNotes
      ?? actBoardNarrationNotesForNode(actKey, act, node));
    if (node.transcript && Array.isArray(node.footageFragments) && node.footageFragments.length) {
      appendActBoardNodeDetailField(content, 'Filmable phrases', node.footageFragments.join(' · '));
    }
    // Phrase words/timestamps remain in node.fragmentTimings for playback
    // alignment, but are intentionally hidden from node-content display.
    // Narration playback lives in the scene narration section/track. Keep the
    // selected-node content panel focused on the editable narration context
    // and phrase metadata instead of duplicating its audio player here.
  } else if (node.type === 'footage') {
    appendActBoardNodeDetailField(content, 'Narration phrase', node.fragment || '');
    appendActBoardNodeDetailField(content, 'Search query', node.query || node.videoQuery || node.footageQuery || '');
    appendActBoardNodeDetailField(content, 'Filmability', node.filmabilityQuery || node.filmabilityBucket || '');
    const selectedKey = String(node.selectedVisualKey || '');
    const selected = selectedKey === 'upload'
      ? { url: node.mediaUrl || '', thumbnailUrl: node.mediaThumbnailUrl || node.mediaUrl || '', label: 'Uploaded footage', kind: node.mediaKind || 'video' }
      : selectedKey === 'split-screen'
        ? { label: 'Split screen', source: 'Split screen', kind: 'split-screen' }
      : selectedKey.startsWith('generated-')
        ? node.generatedOptions?.[Number(selectedKey.slice('generated-'.length))]
        : selectedKey.startsWith('result-')
          ? node.results?.[Number(selectedKey.slice('result-'.length))]
          : node.mediaUrl
            ? { url: node.mediaUrl, thumbnailUrl: node.mediaThumbnailUrl || node.mediaUrl, label: 'Uploaded footage', kind: node.mediaKind || 'video' }
            : null;
    if (selected) {
      appendActBoardNodeDetailField(content, 'Selected visual', selected.label || selected.name || selected.source || 'Selected footage');
      if (selected.kind === 'split-screen') {
        const splitPreview = document.createElement('div');
        splitPreview.className = 'storyboard-act-board-footage-featured split-screen';
        (node.splitScreenNodeIds || []).forEach(id => {
          const splitNode = actBoardNodesForAct(actKey)
            .find(item => item.type === 'footage' && item.id === id);
          if (!splitNode) return;
          const visual = actBoardVisualForKey(splitNode, splitNode.selectedVisualKey);
          const pane = document.createElement('div');
          pane.className = 'storyboard-act-board-footage-split-pane';
          const mediaUrl = visual?.url || splitNode.mediaUrl || '';
          const thumbnail = visual?.thumbnailUrl || splitNode.mediaThumbnailUrl || mediaUrl;
          if (visual?.kind === 'video' && mediaUrl) {
            const video = document.createElement('video');
            video.src = mediaUrl;
            video.poster = thumbnail || '';
            video.controls = true;
            video.playsInline = true;
            video.preload = 'metadata';
            video.muted = true;
            video.addEventListener('click', event => event.stopPropagation());
            pane.appendChild(video);
          } else if (thumbnail) {
            const image = document.createElement('img');
            image.src = thumbnail;
            image.alt = footageNodeVisualSummary(splitNode) || 'Split-screen source';
            image.loading = 'lazy';
            image.decoding = 'async';
            pane.appendChild(image);
          }
          splitPreview.appendChild(pane);
        });
        content.appendChild(splitPreview);
      } else {
        const mediaUrl = selected.url || selected.localPreviewUrl || selected.video_url || selected.preview_url || node.mediaUrl || '';
        const thumbnail = selected.thumbnailUrl || selected.thumbnail_url || mediaUrl;
        if (mediaUrl && (selected.kind === 'video' || selected.video_url || node.mediaKind === 'video')) {
          const video = document.createElement('video');
          video.src = mediaUrl;
          video.poster = thumbnail || '';
          video.controls = true;
          video.playsInline = true;
          video.preload = 'metadata';
          video.muted = selected.source === 'AI-generated' || selected.generatedIndex != null;
          video.addEventListener('click', event => event.stopPropagation());
          content.appendChild(video);
        } else if (thumbnail) {
          const image = document.createElement('img');
          image.src = thumbnail;
          image.alt = selected.label || 'Selected footage';
          image.loading = 'lazy';
          image.decoding = 'async';
          content.appendChild(image);
        }
      }
    }
    const shotPlan = selected?.shotPlan || node.shotPlan || null;
    if (shotPlan && typeof shotPlan === 'object') {
      const visual = shotPlan.visual || shotPlan.visualField || '';
      const movement = shotPlan.movement || shotPlan.cameraMovement || '';
      appendActBoardNodeDetailField(content, 'Shot plan', [visual, movement].filter(Boolean).join(' · '));
    }
    const available = (Array.isArray(node.generatedOptions) ? node.generatedOptions.length : 0)
      + (Array.isArray(node.results) ? node.results.length : 0);
    if (available) appendActBoardNodeDetailField(content, 'Available visuals', `${available} generated or found option${available === 1 ? '' : 's'}`);
  } else if (node.type === 'audio') {
    appendActBoardNodeDetailField(content, 'Audio type', node.audioKind === 'music' ? 'Music' : 'Sound effects');
    appendActBoardNodeDetailField(content, 'Search query', node.query || '');
    const source = actBoardAudioSource(node);
    appendActBoardNodeDetailField(content, 'Selected sound', source.name || '');
    if (source.url) {
      const audio = document.createElement('audio');
      audio.className = 'storyboard-act-board-full-playback-node-detail-audio';
      audio.controls = true;
      audio.preload = 'metadata';
      audio.dataset.audioNodeId = node.id;
      audio.src = source.url;
      wireActBoardAudioPreviewSegment(audio, node);
      audio.volume = actBoardNodeVolume(node, 1);
      audio.addEventListener('click', event => event.stopPropagation());
      content.appendChild(audio);
    }
  } else if (node.type === 'playback') {
    appendActBoardNodeDetailField(content, 'Playback', 'Scene playback node');
    appendActBoardNodeDetailField(content, 'Scene', node.sceneId || '');
  }
  if (node.error) appendActBoardNodeDetailField(content, 'Status', node.error, 'error');
  return content;
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
  // card.title = inSceneStack
  //   ? 'Click to load this scene’s nodes back onto the act board. Double-click the scene name to rename.'
  //   : scene.committedToStack
  //     ? 'Defined scene board. Use the Story outline to reload it. Double-click the scene name to rename.'
  //     : 'Board-only scene. Drag its header to reposition it. Double-click the scene name to rename.';
  if (!inSceneStack) {
    card.style.position = 'absolute';
    card.style.left = `${Math.max(0, Number(scene.boardX) || 0)}px`;
    card.style.top = `${Math.max(0, Number(scene.boardY) || 0)}px`;
    // The framed board is a full-width scene surface rather than a card that
    // is duplicated in a second, per-act scene stack.
    card.style.width = '100%';
    card.style.boxSizing = 'border-box';
    card.style.height = `${Math.max(116,
      Number(scene.boardHeight) || ACT_BOARD_DEFAULT_SCENE_HEIGHT)}px`;
  }

  const header = document.createElement('div');
  header.className = 'storyboard-act-board-board-scene-header';
  const top = document.createElement('div');
  top.className = 'storyboard-act-board-card-top';
  const title = document.createElement('h5');
  title.textContent = scene.title || 'Board scene';
  // Prefer the live node object over the saved snapshot when both exist. A
  // generated/selected visual can finish asynchronously after the scene
  // snapshot was written; using the stale snapshot here could make the scene
  // node list lag behind a completed split/merged visual.
  const liveById = new Map((Array.isArray(nodes) ? nodes : [])
    .filter(item => item?.id).map(item => [item.id, item]));
  const snapshotById = new Map((Array.isArray(scene.nodeSnapshots)
    ? scene.nodeSnapshots : []).filter(item => item?.id)
    .map(item => [item.id, item]));
  const sceneItemIds = Array.from(new Set([
    ...(scene.nodeIds || []),
    ...snapshotById.keys(),
  ]));
  const sceneItems = sceneItemIds
    .map(nodeId => liveById.get(nodeId) || snapshotById.get(nodeId))
    .filter(item => item && item.type !== 'playback' && item.trackOnly !== true);
  // Keep the scene header focused on the scene name. Node counts are useful
  // diagnostics but add visual noise beside the title.
  top.appendChild(title);
  const meta = document.createElement('div');
  meta.className = 'storyboard-act-board-card-meta';
  const sceneMode = normalizeActBoardSceneMode(scene);
  const sceneModeLabel = DOCUMENTARY_MODES.find(mode => mode.key === sceneMode)?.label || sceneMode;
  const sceneModePrefix = document.createElement('span');
  sceneModePrefix.className = 'storyboard-act-board-scene-mode-label';
  sceneModePrefix.textContent = inSceneStack || scene.committedToStack
    ? 'Scene Mode'
    : 'Board-only scene ·';
  meta.appendChild(sceneModePrefix);
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
  // Smart arrange lives beside Visualize highlights in the Narration heading
  // (see buildActBoardCanvasPlaybackTracks); only the minus control stays here.
  if (!inSceneStack && scene.committedToStack) {
    clearNodes = document.createElement('button');
    clearNodes.type = 'button';
    clearNodes.className = 'storyboard-act-board-board-scene-clear-nodes';
    clearNodes.textContent = '−';
    clearNodes.title = 'Remove this scene’s nodes and open the next saved scene, or create the next scene if this is the last one';
    clearNodes.setAttribute('aria-label', 'Remove scene nodes from board');
    clearNodes.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      const nodeIds = new Set(scene.nodeIds || []);
      if (nodeIds.size) {
        actBoardNodes[scene.actKey] = actBoardNodesForAct(scene.actKey)
          .filter(node => !nodeIds.has(node.id));
      }
      // Keep the committed card as a restore point and hide its framed board.
      // If a following scene already exists, hand off to it rather than
      // creating an unnecessary Scene 3. Only create a new scene at the end
      // of the existing list.
      scene.hidden = true;
      scene.liveNodesCleared = true;
      const scenes = actBoardScenesForAct(scene.actKey);
      const sceneIndex = scenes.findIndex(item => item.id === scene.id);
      const nextScene = sceneIndex >= 0 ? scenes[sceneIndex + 1] : null;
      if (nextScene) {
        // Restore the existing next scene (including its saved nodes/links),
        // or show its empty board if it has not been populated yet.
        restoreActBoardSceneToCanvas(nextScene);
        return;
      }
      createActBoardEmptyScene(scene.actKey, scene);
      saveDebugSession();
      rerenderActBoard();
    });
  }
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
  // Keep the per-scene documentary-mode value and controls wired for later,
  // but temporarily hide this selector from the scene board UI.
  meta.hidden = true;
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
    chip.dataset.nodeId = node.id || '';
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
    const initialNodePositions = new Map(includedNodes
      .filter(node => !(node.type === 'footage'
        && node.boardPositionSpace === 'footage-section'))
      .map(node => [node.id, {
      x: Number(node.boardX) || 0,
      y: Number(node.boardY) || 0,
      }]));
    const expandCanvasForScene = () => {
      const sceneHeight = card.offsetHeight || Math.max(116,
        Number(scene.boardHeight) || ACT_BOARD_DEFAULT_SCENE_HEIGHT);
      const sceneBottom = (Number(scene.boardY) || 0) + sceneHeight;
      const currentMinHeight = parseFloat(nodeStack.style.minHeight) || 0;
      nodeStack.style.minHeight = `${Math.max(ACT_BOARD_DEFAULT_CANVAS_HEIGHT, currentMinHeight, sceneBottom + 24)}px`;
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
        if (node.type === 'footage' && node.boardPositionSpace === 'footage-section') return;
        const initial = initialNodePositions.get(node.id);
        if (!initial) return;
        node.boardX = Math.max(0, initial.x + deltaX);
        node.boardY = Math.max(0, initial.y + deltaY);
        node.boardPositionMode = 'manual';
        const nodeCard = actBoardNodeCard(nodeStack, node.id);
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

