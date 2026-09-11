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
// const suggestArcsBtn = document.getElementById('suggest-arcs-btn');
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
// both omitted) through Web Audio for the intent-recording player. Per-scene
// narration uses its native <audio> element instead. This remains deliberately
// not a plain
// <audio src> - see decodeRecordedNarration's own comment on why: Safari
// can't reliably play a MediaRecorder-produced clip back that way, even
// from a real disk-served file, but decodeAudioData/an
// AudioBufferSourceNode does. owner is whatever UI element the caller
// wants to identify as currently holding playback (see currentPlaybackOwner
// above); onStop() is called once playback stops or ends, for the caller
// to reset its own button's label. See playNarrationRange below.
function playAudioBuffer(audioBuffer, owner, onStop, startSeconds, endSeconds) {
  stopSfxPreview(true);
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

// Peak extraction is inexpensive for short clips but can monopolize the main
// thread for long recordings. Let the browser paint and handle input first;
// the fallback keeps this compatible with Safari/older browsers.
function runActBoardWhenIdle(task, timeout = 500) {
  return new Promise((resolve, reject) => {
    const run = () => {
      try { resolve(task()); } catch (error) { reject(error); }
    };
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(run, { timeout });
    } else {
      setTimeout(run, 0);
    }
  });
}

function decodeRecordedNarration(blob, bucketCount) {
  return runActBoardWhenIdle(() => blob.arrayBuffer().then(arrayBuffer => {
    return ensurePlaybackAudioCtx().decodeAudioData(arrayBuffer).then(audioBuffer => {
      return runActBoardWhenIdle(() => {
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
  }));
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
    .then(result => {
      const transcript = actBoardTranscriptionText(result);
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

