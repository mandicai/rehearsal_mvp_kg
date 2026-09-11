function setActBoardNarrationRecordStatus(statusEl, message, isError = false) {
  if (statusEl && typeof statusEl._setStatus === 'function') {
    statusEl._setStatus(message, isError);
    return;
  }
  if (!statusEl) return;
  statusEl.textContent = message || '';
  statusEl.classList.toggle('error', Boolean(isError));
}

async function recordActBoardNarration(node, blob, filename, statusEl) {
  setActBoardNarrationRecordStatus(statusEl, 'Uploading narration ...');
  try {
    // Persist a browser-independent PCM/WAV copy for refreshes. The live page
    // can use its original MediaRecorder blob, but WebM/MP4 container support
    // varies across browsers and was producing distorted or aborted playback
    // when the saved URL was loaded later.
    let uploadBlob = blob;
    let uploadFilename = filename;
    try {
      setActBoardNarrationRecordStatus(statusEl, 'Normalizing narration ...');
      const normalizedBuffer = await blob.arrayBuffer()
        .then(bytes => ensurePlaybackAudioCtx().decodeAudioData(bytes));
      uploadBlob = audioBufferToWavBlob(normalizedBuffer);
      uploadFilename = filename.replace(/\.[^.]+$/, '.wav');
    } catch (normalizeError) {
      // Keep recording support if a browser cannot decode its own container;
      // the server still receives the original file as a fallback.
      uploadBlob = blob;
      uploadFilename = filename;
    }
    const uploaded = await fetchUploadMediaBankItem(
      new File([uploadBlob], uploadFilename, { type: uploadBlob.type || 'audio/wav' }), premiereProjectId);
    premiereProjectId = uploaded.project_id;
    delete node._actBoardNarrationWaveformPath;
    delete node.audioBuffer;
    node.audioPreviewUrl = uploaded.preview_url;
    node.audioFilePath = uploaded.file_path || null;
    node.audioDurationSeconds = Number(uploaded.duration_seconds) || 0;
    if (node.audioDurationSeconds > 0) node.sourceDurationSeconds = node.audioDurationSeconds;
    if (node.audioDurationSeconds > 0) node.narrationSegmentDurationSeconds = node.audioDurationSeconds;
    packActBoardSceneNarrationStarts(node.actKey, node.sceneId);
    try {
      if (typeof node._nativePreviewUrl === 'string' && node._nativePreviewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(node._nativePreviewUrl);
      }
      const nativeUrl = URL.createObjectURL(blob);
      Object.defineProperty(node, '_nativeAudioUrl', {
        value: nativeUrl, configurable: true, enumerable: false,
      });
      Object.defineProperty(node, '_nativePreviewUrl', {
        value: nativeUrl, configurable: true, enumerable: false,
      });
    } catch (err) { /* native playback is optional */ }
    if (!(node.audioDurationSeconds > 0)) {
      try {
        const audioBuffer = await blob.arrayBuffer()
          .then(bytes => ensurePlaybackAudioCtx().decodeAudioData(bytes));
        node.audioDurationSeconds = Number(audioBuffer.duration) || 0;
        if (node.audioDurationSeconds > 0) node.sourceDurationSeconds = node.audioDurationSeconds;
        if (node.audioDurationSeconds > 0) node.narrationSegmentDurationSeconds = node.audioDurationSeconds;
      } catch (err) { /* duration can still be estimated from the transcript */ }
    }
    setActBoardNarrationRecordStatus(statusEl, 'Transcribing narration ...');
    const transcript = await fetchTranscription(blob, filename);
    node.transcript = actBoardTranscriptionText(transcript);
    node.transcriptWords = Array.isArray(transcript.words) ? transcript.words : [];
    // Real silence intervals detected directly from the audio waveform (see
    // backend/ingest/transcription.py's detect_silences) - used instead of
    // Whisper's own word-to-word gaps, which are an approximate internal
    // alignment and were confirmed to report a flat 0s gap across a real
    // recording that had a genuine, audible 1-2s pause.
    node.silences = Array.isArray(transcript.silences) ? transcript.silences : [];
    // The uploaded transcript is a new analysis input. Discard the previous
    // phrase/entity ranges so the timing rows are rebuilt from this recording
    // rather than trying to align stale phrases against the new words.
    node.narrationSpanHash = '';
    node.narrationSpanStatus = 'stale';
    node.narrationCandidateSpans = [];
    node.narrationSpans = [];
    node.narrationSpanExclusions = [];
    node.selectedFootagePhrases = [];
    node.footageSuggestedPhrases = [];
    node.userFilmablePhrases = [];
    node.recordingStatus = 'ready';
    node.recordingError = '';
    // Start the new transcript's local extraction/classification immediately.
    // Visualize Highlights can now await this exact promise instead of
    // falling through to the previous narration spans while classification is
    // still in flight.  The request remains asynchronous so recording UI and
    // the rest of the board stay interactive.
    requestActBoardNarrationAnalysis(node);
    const act = currentArcSections.find(item => item.key === node.actKey);
    if (act && node.transcript) {
      // Recording changes the narration reference only. Keep any existing
      // footage nodes intact until the presenter explicitly asks to refresh
      // them with Suggest footage.
      node.footageStatus = ''; // Narration updated — press Suggest footage to refresh the linked footage.
      node.footageFragments = actBoardNarrationFragments(node.transcript);
    }
    // Align after replacing the phrase list so the first rendered timing rows
    // already belong to the newly uploaded transcript. A new recording is a
    // new timeline, so previously placed shots are re-timed as well.
    alignActBoardNarrationFragments(node, null, { resetPinned: true });
    setActBoardNarrationRecordStatus(statusEl, '');
    saveDebugSession();
    rerenderActBoard();
  } catch (err) {
    node.recordingStatus = 'error';
    node.recordingError = err.message;
    setActBoardNarrationRecordStatus(statusEl,
      `Narration recording failed: ${err.message}`, true);
    saveDebugSession();
    rerenderActBoard();
  }
}

function recomputeActBoardTiming(narrationNode) {
  if (!narrationNode || narrationNode.type !== 'narration') return;
  const fragments = Array.isArray(narrationNode.footageFragments) && narrationNode.footageFragments.length
    ? narrationNode.footageFragments
    : actBoardNarrationFragments(narrationNode.text);
  const nodesById = new Map((actBoardNodesForAct(narrationNode.actKey) || [])
    .filter(node => node.type === 'footage' && node.narrationNodeId === narrationNode.id)
    .map(node => [node.id, node]));
  const linked = (narrationNode.footageNodeIds || [])
    .map(id => nodesById.get(id)).filter(Boolean);
  if (!linked.length) return;
  const narrationSeconds = Number(narrationNode.narrationAudioDurationSeconds) > 0
    ? Number(narrationNode.narrationAudioDurationSeconds)
    : estimateActBoardNarrationSeconds(narrationNode.text);
  const totalWords = Math.max(1, fragments.reduce((sum, fragment) =>
    sum + fragment.split(/\s+/).filter(Boolean).length, 0));
  const timingByFragment = new Map((narrationNode.fragmentTimings || [])
    .filter(timing => timing && timing.fragment)
    .map(timing => [timing.fragment, timing]));
  let cursor = 0;
  linked.forEach((node, index) => {
    const fragment = node.fragment || fragments[index] || '';
    const alignedTiming = node.alignedToNarration && timingByFragment.get(fragment);
    if (node.timingWasManuallyAdjusted) {
      node.sequenceIndex = index;
      node.startSeconds = Math.max(0, Number(node.startSeconds) || 0);
      node.durationSeconds = Math.max(0.5, Number(node.durationSeconds) || 0.5);
      cursor = Math.max(cursor, node.startSeconds + node.durationSeconds);
      return;
    }
    if (alignedTiming) {
      const timingIndex = (narrationNode.fragmentTimings || []).findIndex(item => item === alignedTiming);
      const window = actBoardNarrationFootageWindow(
        narrationNode.fragmentTimings,
        timingIndex >= 0 ? timingIndex : index,
        narrationSeconds,
        cursor,
      );
      node.startSeconds = window.startSeconds;
      node.durationSeconds = window.durationSeconds;
      node.durationWasSuggested = false;
      node.sequenceIndex = index;
      cursor = node.startSeconds + node.durationSeconds;
      return;
    }
    const words = fragment.split(/\s+/).filter(Boolean).length;
    const suggested = Math.max(1, narrationSeconds * words / totalWords);
    if (!(Number(node.durationSeconds) > 0) || node.durationWasSuggested !== false) {
      node.durationSeconds = suggested;
      node.durationWasSuggested = true;
    }
    node.startSeconds = cursor;
    cursor += Number(node.durationSeconds) > 0 ? Number(node.durationSeconds) : suggested;
    node.sequenceIndex = index;
  });
  narrationNode.durationSeconds = cursor;
}

function clearActBoardNarrationAlignment(narrationNode) {
  if (!narrationNode) return;
  actBoardNodesForAct(narrationNode.actKey)
    .filter(node => node.type === 'footage' && node.narrationNodeId === narrationNode.id)
    .forEach(node => { node.alignedToNarration = false; });
}

