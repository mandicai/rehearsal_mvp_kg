// The first accepted arc should open with a usable Act Board rather than a
// collection of empty scene frames. Scaffold every currently defined board
// scene with one suggested narration node. Filmable footage is derived only
// after the presenter records narration. Sound nodes remain an explicit presenter action rather than
// an automatic part of arc acceptance. This is deliberately separate from the
// Timeline + Scenes autofill path: Act Board nodes are independent working
// material and must be persisted in their scene snapshots for both scene and
// full playback.
async function autoPopulateActBoardScenesForFirstArc() {
  if (!currentArcSections.length) {
    actBoardFirstArcAutoPopulationActive = false;
    return;
  }
  ensureActBoardInitialScenes();

  const entries = [];
  currentArcSections.forEach(act => {
    let scenes = actBoardScenesForAct(act.key).filter(scene => scene.hidden !== true);
    if (!scenes.length) {
      scenes = [createActBoardEmptyScene(act.key)];
    }
    const arcPart = (selectedNarrationArc?.sections || []).find(part =>
      part && (part.name || part.key) === act.key);
    const draft = compactArcSuggestedNarration(arcPart?.suggested_narration || '');
    const sourceText = actBoardSectionsForAct(act.key)
      .map(section => String(section.text || '').trim())
      .filter(Boolean)
      .join('\n\n');

    scenes.forEach((scene, sceneIndex) => {
      const nodes = actBoardNodesForAct(act.key);
      const sceneIds = new Set([...(scene.nodeIds || []),
        ...nodes.filter(node => node.sceneId === scene.id).map(node => node.id)]);
      let narrationNode = nodes.find(node => node.type === 'narration'
        && sceneIds.has(node.id));
      if (!narrationNode) {
        narrationNode = {
          id: createActBoardNodeId('narration'),
          type: 'narration',
          actKey: act.key,
          sceneId: scene.id,
          status: draft ? 'ready' : 'draft',
          text: '',
          sceneNotes: sourceText,
          footageFragments: [],
          footageNodeIds: [],
          footageStatus: '',
          error: '',
          includeNarration: true,
          startSeconds: 0,
          trimStartSeconds: 0,
          sourceDurationSeconds: 0,
          narrationSegmentDurationSeconds: 0,
          previousNarrationNodeId: null,
          nextNarrationNodeId: null,
          selectedFootagePhrases: [],
          footageSuggestedPhrases: [],
          userFilmablePhrases: [],
          boardX: Math.max(100, (Number(scene.boardX) || 0) + 100),
          boardY: Math.max(56, (Number(scene.boardY) || 0) + 56),
          boardPositionMode: 'manual',
        };
        nodes.push(narrationNode);
        attachActBoardNodeToScene(act.key, narrationNode, scene);
        if (draft) applyActBoardNarrationSuggestion(act.key, narrationNode, draft);
      } else if (!narrationNode.transcript && !narrationNode.text && draft) {
        // A pre-existing empty starter narration is safe to fill on this
        // first bootstrap, but never overwrite recorded or edited work.
        narrationNode.status = 'ready';
        if (!narrationNode.sceneNotes) narrationNode.sceneNotes = sourceText;
        attachActBoardNodeToScene(act.key, narrationNode, scene);
        applyActBoardNarrationSuggestion(act.key, narrationNode, draft);
      }

      // A freshly accepted arc should not create empty sound nodes. Audio is
      // still available as a scene-level track when the presenter adds it;
      // any existing user-created audio is preserved and reattached normally.
      const audioNode = nodes.find(node => node.type === 'audio'
        && sceneIds.has(node.id));
      if (audioNode) attachActBoardNodeToScene(act.key, audioNode, scene);

      // Every defined scene owns exactly one playback node. It remains a
      // scene-level playback surface and is included in the saved snapshot,
      // while narration/footage/audio remain the visible working nodes.
      ensureActBoardPlaybackNode(act.key, null, { create: true, sceneId: scene.id });
      entries.push({ act, scene, narrationNode, sourceText, sceneIndex });
    });
  });

  syncActBoardLiveSceneSnapshots();
  saveDebugSession();
  rerenderActBoard();

  // Analyze each suggested narration first so the same filmability spans used
  // for blue highlights are also used to create the linked footage nodes. A
  // suggested draft is intentionally not analyzed or visualized: entities
  // become eligible only after the presenter records narration.
  await Promise.all(entries.map(async ({ act, scene, narrationNode, sourceText }) => {
    if (!String(narrationNode.transcript || '').trim()) return;
    const analysis = requestActBoardNarrationAnalysis(narrationNode);
    const analysisHash = actBoardNarrationTextHash(
      actBoardNarrationSourceText(narrationNode),
    );
    const pendingAnalysis = analysis
      || actBoardNarrationAnalysisPromises.get(`${narrationNode.id}:${analysisHash}`);
    if (pendingAnalysis) await pendingAnalysis;
    if (!actBoardNodesForAct(act.key).some(node => node.id === narrationNode.id)) return;
    // Phrase extraction/search must be anchored to the suggested narration
    // itself, not the longer attached paper notes. The notes remain on the
    // node as editable context, while the narration text determines which
    // words become highlighted footage beats.
    await suggestActBoardFootage(act.key, act, narrationNode,
      narrationNode.text || sourceText || '');
    const generatedFootage = (narrationNode.footageNodeIds || [])
      .map(id => actBoardNodesForAct(act.key).find(node => node.id === id))
      .filter(node => node?.type === 'footage');
    await Promise.all(generatedFootage.map(async footageNode => {
      // Keep an explicitly selected/persisted visual intact. Newly suggested
      // cards normally have the upload prompt selected, so those are the ones
      // that receive the random stock-vs-AI starter preview.
      if (footageNode.selectedVisualKey && footageNode.selectedVisualKey !== 'upload') return;
      if (footageNode.mediaUrl || footageNode.mediaThumbnailUrl) return;
      await selectRandomActBoardFootageVisual(act.key, footageNode);
    }));
    // Keep the playback node and restorable scene snapshot current after the
    // async footage search/image-generation pass completes.
    ensureActBoardPlaybackNode(act.key, null, { create: true, sceneId: scene.id });
    syncActBoardLiveSceneSnapshots(scene);
  }));

  syncActBoardLiveSceneSnapshots();
  saveDebugSession();
  actBoardFirstArcAutoPopulationActive = false;
  rerenderActBoard();
}

// Migrate audio shells created by the first-arc scaffold before the side-by-
// side layout was introduced. Only move an empty audio node that still has
// the exact old scaffold coordinates; an audio node the presenter has moved
// or populated is left untouched.
function migrateActBoardScaffoldAudioPositions() {
  if (!actBoardFirstArcAutoPopulationDone) return false;
  let changed = false;
  currentArcSections.forEach(act => {
    actBoardScenesForAct(act.key).forEach(scene => {
      const sceneX = Number(scene.boardX) || 0;
      const sceneY = Number(scene.boardY) || 0;
      const oldX = sceneX + 24;
      const oldY = sceneY + 220;
      const nextX = sceneX + 24 + ACT_BOARD_NARRATION_STANDARD_WIDTH + ACT_BOARD_NODE_GAP;
      const nextY = sceneY + 56;
      const sceneIds = new Set([...(scene.nodeIds || [])]);
      actBoardNodesForAct(act.key)
        .filter(node => node.type === 'audio'
          && (node.sceneId === scene.id || sceneIds.has(node.id))
          && !node.selectedAudio && !node.audioPreviewUrl)
        .forEach(node => {
          if (Math.abs((Number(node.boardX) || 0) - oldX) > 1
            || Math.abs((Number(node.boardY) || 0) - oldY) > 1) return;
          node.boardX = nextX;
          node.boardY = nextY;
          node.boardPositionMode = 'manual';
          changed = true;
        });
    });
  });
  return changed;
}

// Give newly auto-suggested footage cards a useful selected preview without
// changing the normal manual-generation rule (which intentionally leaves the
// upload prompt selected). If both sources are available, choose stock or AI
// imagery at random; a stock result is downloaded first so the selected box
// has a stable local preview for scene/full playback.
async function selectRandomActBoardFootageVisual(actKey, node) {
  if (!node || node.type !== 'footage') return false;
  const generated = (Array.isArray(node.generatedOptions) ? node.generatedOptions : [])
    .map((option, index) => ({ option, index }))
    .filter(item => item.option?.url && item.option.kind !== 'video');
  const stock = (Array.isArray(node.results) ? node.results : [])
    .map((result, index) => ({ result, index }))
    .filter(item => item.result?.video_url && !actBoardResultIsPortrait(item.result));
  if (!generated.length && !stock.length) return false;

  const chooseStock = stock.length && generated.length
    ? Math.random() < 0.5 : stock.length > 0;
  if (!chooseStock) {
    const selected = generated[Math.floor(Math.random() * generated.length)];
    const option = selected.option;
    node.selectedVisualKey = `generated-${selected.index}`;
    node.selectedGeneratedIndex = selected.index;
    node.mediaUrl = option.url || '';
    node.mediaThumbnailUrl = option.thumbnail_url || option.url || '';
    node.mediaKind = option.kind || 'image';
    node.mediaOrigin = 'generated';
    node.shotPlan = option.shotPlan || node.shotPlan || {};
    syncActBoardImageTechniquesForVisual(node, option);
    node.trimStartSeconds = 0;
    node.sourceDurationSeconds = Number(option.duration_seconds || option.duration) || 0;
    return true;
  }

  // Try the stock results in random order until one downloads. A single CDN
  // failure used to end the attempt, and with automatic image generation off
  // there was no AI image to fall back on - so the card stayed empty.
  const shuffled = stock.slice().sort(() => Math.random() - 0.5);
  let selected = null;
  let downloaded = null;
  for (const candidate of shuffled) {
    try {
      downloaded = await fetchDownloadStockMedia(
        actBoardAssetSectionIndex(node),
        'video',
        candidate.result.video_url,
        premiereProjectId,
        // Auto-selecting a search result must use the same permissive download
        // path as an explicit "Use this clip" click. Search/playback can still
        // prefer clips long enough for the requested segment, but a shorter
        // result should not be rejected while assigning a starter visual.
        0,
        candidate.result.id || node.id,
      );
      selected = candidate;
      break;
    } catch (error) {
      downloaded = null;
    }
  }
  if (!selected) {
    // Nothing downloaded. Rather than leave the card empty, point it at the
    // first result's remote URL: it plays in the browser, and the export path
    // resolves board media on its own.
    const remote = shuffled[0];
    if (remote?.result?.video_url) {
      const result = remote.result;
      node.selectedVisualKey = `result-${remote.index}`;
      node.selectedResultIndex = remote.index;
      node.mediaUrl = result.video_url;
      node.mediaThumbnailUrl = result.thumbnail_url || result.video_url;
      node.mediaKind = 'video';
      node.mediaOrigin = 'suggested';
      node.sourceDurationSeconds = Number(result.duration_seconds || result.duration) || 0;
      node.trimStartSeconds = 0;
      return true;
    }
    if (!generated.length) return false;
    selected = null;
  }
  const result = selected ? selected.result : null;
  try {
    if (!result) throw new Error('no stock result could be downloaded');
    premiereProjectId = downloaded.project_id || premiereProjectId;
    result.localPreviewUrl = downloaded.preview_url || '';
    result.thumbnail_url = downloaded.thumbnail_url || result.thumbnail_url || '';
    node.selectedVisualKey = `result-${selected.index}`;
    node.selectedResultIndex = selected.index;
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
    return true;
  } catch (error) {
    // A stock CDN download can fail even when the search result is valid. If
    // an AI image exists, use it as the other half of the random choice rather
    // than leaving the first-arc card on an empty upload prompt.
    if (!generated.length) return false;
    const fallback = generated[Math.floor(Math.random() * generated.length)];
    const option = fallback.option;
    node.selectedVisualKey = `generated-${fallback.index}`;
    node.selectedGeneratedIndex = fallback.index;
    node.mediaUrl = option.url || '';
    node.mediaThumbnailUrl = option.thumbnail_url || option.url || '';
    node.mediaKind = option.kind || 'image';
    node.mediaOrigin = 'generated';
    node.shotPlan = option.shotPlan || node.shotPlan || {};
    syncActBoardImageTechniquesForVisual(node, option);
    node.trimStartSeconds = 0;
    node.sourceDurationSeconds = Number(option.duration_seconds || option.duration) || 0;
    return true;
  }
}

// New narration segments get a useful draft immediately, but the request is
// deliberately fire-and-forget so recording/uploading can begin at once.
// Keep the request token runtime-only: it prevents a late response from
// restoring text to a segment that was deleted or replaced while the request
// was in flight.
// The accepted arc's draft for an act, compacted the way the arc view shows it.
function actBoardAcceptedArcNarrationForAct(actKey) {
  const part = (selectedNarrationArc?.sections || []).find(candidate =>
    candidate && (candidate.name || candidate.key) === actKey);
  return compactArcSuggestedNarration(part?.suggested_narration || '');
}

// The act's first narration segment: first visible scene, earliest start,
// creation order as the tie-break. That segment shows the arc's narration; any
// segment added after it gets a fresh draft of its own.
function actBoardIsFirstNarrationOfAct(actKey, node) {
  const scenes = actBoardScenesForAct(actKey).filter(scene => scene && scene.hidden !== true);
  const sceneOrder = new Map(scenes.map((scene, index) => [scene.id, index]));
  const ordered = actBoardNodesForAct(actKey)
    .map((item, index) => ({ item, index }))
    .filter(entry => entry.item.type === 'narration')
    .sort((a, b) => (sceneOrder.get(a.item.sceneId) ?? 999) - (sceneOrder.get(b.item.sceneId) ?? 999)
      || (Number(a.item.startSeconds) || 0) - (Number(b.item.startSeconds) || 0)
      || a.index - b.index);
  return ordered[0]?.item === node;
}

async function suggestInitialActBoardNarration(actKey, act, narrationNode) {
  if (!narrationNode || narrationNode.type !== 'narration') return false;
  if (narrationNode.initialNarrationSuggestionInFlight) return false;
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  Object.defineProperty(narrationNode, 'initialNarrationSuggestionInFlight', {
    value: token, configurable: true, writable: true, enumerable: false,
  });
  const scene = actBoardSceneForNode(actKey, narrationNode);
  const sceneId = scene?.id || narrationNode.sceneId || '';
  // The act's first segment carries the narration the presenter already read
  // and accepted in the arc view - the same text, not a new draft of it. Only
  // segments added after that one are drafted here.
  const arcDraft = actBoardIsFirstNarrationOfAct(actKey, narrationNode)
    ? actBoardAcceptedArcNarrationForAct(actKey) : '';
  if (arcDraft) {
    // Accepted verbatim from the arc preview, which never requests pause
    // markers (see fetchSuggestNarration callers) - nothing to show here.
    applyActBoardNarrationSuggestion(actKey, narrationNode, arcDraft);
    narrationNode.status = 'ready';
    narrationNode.error = '';
    narrationNode.narrationSpanHash = '';
    narrationNode.narrationSpanStatus = 'stale';
    narrationNode.narrationCandidateSpans = [];
    narrationNode.narrationSpans = [];
    narrationNode.initialNarrationSuggestionInFlight = '';
    queueActBoardScenePatch(actKey, sceneId, { persist: true });
    refreshActBoardNodeContentPanel(actKey, narrationNode);
    return true;
  }
  narrationNode.status = 'generating';
  narrationNode.error = '';
  const sceneStillPresent = () => !sceneId
    || actBoardScenesForAct(actKey).some(item => item && item.id === sceneId);
  queueActBoardScenePatch(actKey, sceneId, { persist: true });
  try {
    const notes = actBoardNarrationNotesForNode(actKey, act, narrationNode)
      || actBoardNarrationContext(actKey, act);
    const result = await fetchSuggestNarration({
      sectionTitle: `${act?.label || 'Act'} narration`,
      sectionText: `Source material / scene notes:\n${notes}`.trim(),
      actTitle: act?.label || '',
      actDescription: act?.description || '',
      abstract: findAbstractText(),
      documentaryMode: actBoardDocumentaryModeForNode(actKey, narrationNode),
    });
    const stillPresent = actBoardNodesForAct(actKey).some(node => node === narrationNode);
    if (!stillPresent || !sceneStillPresent()
      || narrationNode.initialNarrationSuggestionInFlight !== token) return false;
    const narration = String(result.narration || '').trim();
    if (!narration) throw new Error('The narration suggestion was empty.');
    applyActBoardNarrationSuggestion(actKey, narrationNode, narration);
    narrationNode.status = 'ready';
    narrationNode.narrationSpanHash = '';
    narrationNode.narrationSpanStatus = 'stale';
    narrationNode.narrationCandidateSpans = [];
    narrationNode.narrationSpans = [];
    // The draft remains plain reference copy until narration is recorded.
    // Filmable fragments/highlights are derived from the recorded transcript,
    // never from this suggested text.
    narrationNode.footageFragments = [];
    saveDebugSession();
    queueActBoardScenePatch(actKey, sceneId, { persist: true });
    refreshActBoardNodeContentPanel(actKey, narrationNode);
    return true;
  } catch (error) {
    const stillPresent = actBoardNodesForAct(actKey).some(node => node === narrationNode);
    if (!stillPresent || !sceneStillPresent()
      || narrationNode.initialNarrationSuggestionInFlight !== token) return false;
    narrationNode.status = 'error';
    narrationNode.error = error.message || 'Could not generate suggested narration.';
    saveDebugSession();
    queueActBoardScenePatch(actKey, sceneId, { persist: true });
    refreshActBoardNodeContentPanel(actKey, narrationNode);
    return false;
  } finally {
    if (narrationNode.initialNarrationSuggestionInFlight === token) {
      delete narrationNode.initialNarrationSuggestionInFlight;
    }
  }
}

async function resuggestActBoardNarration(actKey, act, narrationNode, button) {
  if (!narrationNode || narrationNode.status === 'generating') return;
  narrationNode.status = 'generating';
  narrationNode.error = '';
  if (button) button.disabled = true;
  saveDebugSession();
  rerenderActBoard();
  try {
    const currentNarration = [
      narrationNode.text ? `Suggested draft:\n${narrationNode.text}` : '',
      narrationNode.transcript ? `Recorded transcript:\n${narrationNode.transcript}` : '',
      narrationNode.footageFragments?.length
        ? `Edited filmable phrases:\n${narrationNode.footageFragments.join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
    const sceneNotes = actBoardNarrationNotesForNode(actKey, act, narrationNode);
    const result = await fetchSuggestNarration({
      sectionTitle: `${act.label || 'Act'} narration`,
      // Put the editable material first: the backend applies a hard
      // section-text limit, so appending it after a long current draft could
      // silently truncate the notes the presenter just changed.
      sectionText: `Editable scene notes / source material:\n${sceneNotes}\n\nCurrent narration and edited phrases:\n${currentNarration}`.trim(),
      actTitle: act.label || '',
      actDescription: act.description || '',
      abstract: findAbstractText(),
      documentaryMode: actBoardDocumentaryModeForNode(actKey, narrationNode),
    });
    const narration = (result.narration || '').trim();
    if (!narration) throw new Error('The narration suggestion was empty.');
    applyActBoardNarrationSuggestion(actKey, narrationNode, narration);
    narrationNode.status = 'ready';
    narrationNode.narrationSpanExclusions = [];
    narrationNode.selectedFootagePhrases = [];
    narrationNode.footageSuggestedPhrases = [];
    narrationNode.userFilmablePhrases = [];
    narrationNode.footageFragments = narrationNode.transcript
      ? actBoardNarrationFragments(narrationNode.transcript) : [];
    narrationNode.footageStatus = ''; // Narration updated — press Suggest footage to refresh the linked footage.
    saveDebugSession();
    rerenderActBoard();
  } catch (err) {
    narrationNode.status = 'error';
    narrationNode.error = err.message;
    saveDebugSession();
    rerenderActBoard();
  } finally {
    if (button) button.disabled = false;
  }
}

function buildActBoardAudioResults(actKey, node) {
  const results = document.createElement('div');
  results.className = 'storyboard-act-board-audio-results';
  (node.results || []).forEach((sound, index) => {
    const result = document.createElement('div');
    result.className = 'storyboard-act-board-audio-result';
    const label = document.createElement('span');
    const duration = Number(sound.duration);
    label.textContent = `${sound.name || 'Untitled sound'}${Number.isFinite(duration) && duration > 0
      ? ` · ${duration.toFixed(1)}s` : ''}`;
    result.appendChild(label);
    const preview = document.createElement('audio');
    preview.controls = true;
    preview.preload = 'none';
    preview.src = sound.preview_url || '';
    wireActBoardAudioExclusivity(preview);
    preview.addEventListener('click', event => event.stopPropagation());
    result.appendChild(preview);
    const useButton = document.createElement('button');
    useButton.type = 'button';
    useButton.className = 'btn-secondary storyboard-act-board-node-action';
    useButton.textContent = 'Use sound';
    useButton.addEventListener('click', async event => {
      event.stopPropagation();
      useButton.disabled = true;
      node.status = 'downloading';
      node.error = '';
      node.audioSearchActive = false;
      saveDebugSession();
      rerenderActBoard();
      try {
        const downloaded = await fetchDownloadStockMedia(
          actBoardAssetSectionIndex(node), 'audio', sound.preview_url, premiereProjectId,
          Math.max(0.25, Number(node.durationSeconds) || Number(sound.duration) || 1),
          sound.id || node.id,
        );
        premiereProjectId = downloaded.project_id || premiereProjectId;
        const natural = Number(downloaded.duration_seconds) || Number(sound.duration) || 0;
        node.selectedAudio = {
          ...sound,
          localPreviewUrl: downloaded.preview_url || sound.preview_url,
          localFilePath: downloaded.file_path || null,
          sourceDurationSeconds: natural,
          trimStartSeconds: 0,
          durationSeconds: natural || Number(node.durationSeconds) || 1,
        };
        node.audioName = sound.name || 'Sound effect';
        node.audioPreviewUrl = downloaded.preview_url || sound.preview_url;
        node.sourceDurationSeconds = natural;
        if (node.linkedToNodeId) {
          const target = actBoardNodesForAct(actKey).find(item => item.id === node.linkedToNodeId);
          if (target) linkActBoardAudioNode(actKey, node, target);
        }
        node.status = 'ready';
      } catch (err) {
        node.status = 'error';
        node.error = `Could not use sound: ${err.message}`;
      }
      saveDebugSession();
      rerenderActBoard();
    });
    result.appendChild(useButton);
    results.appendChild(result);
  });
  return results;
}

function refreshActBoardAudioSearchDom(actKey, node) {
  const card = actBoardNodeCard(document, node.id);
  if (!card) return false;
  // Detailed audio content is mounted in the selected-node panel, while the
  // canvas card intentionally keeps only its compact SVG shell. Always update
  // the live body wrapper so search results do not appear underneath the
  // sound node on the board.
  const contentRoot = card._actBoardNodeBody || card;
  const oldResults = contentRoot.querySelector('.storyboard-act-board-audio-results');
  oldResults?.remove();
  const oldError = contentRoot.querySelector('.storyboard-act-board-node-error');
  oldError?.remove();
  const results = buildActBoardAudioResults(actKey, node);
  if (results.childElementCount
    && (!actBoardAudioSource(node).url || node.audioSearchActive)) contentRoot.appendChild(results);
  if (node.error) {
    const error = document.createElement('div');
    error.className = 'storyboard-act-board-node-error';
    error.textContent = node.error;
    contentRoot.appendChild(error);
  }
  const button = contentRoot.querySelector('.storyboard-act-board-audio-query-row .storyboard-act-board-node-action');
  if (button) {
    button.textContent = node.status === 'generating' ? 'Finding sound…' : 'Find sound';
    button.disabled = node.status === 'generating';
  }
  const stack = card.closest('.storyboard-act-board-node-stack');
  if (stack) {
    const nodes = orderedActBoardNodes(actKey,
      actBoardNodesForAct(actKey).filter(item => item.type !== 'playback'));
    refineActBoardRenderedGeometry(stack, nodes);
    expandActBoardScenesToContainNodes(stack, actKey, nodes);
    if (stack._actBoardLinkState) refreshActBoardLinkPaths(stack);
  }
  return true;
}

function syncActBoardAudioPreviewSegment(player, node, seekToStart = false) {
  if (!player || !node) return;
  const playerDuration = Number(player.duration);
  const naturalDuration = Math.max(0,
    (Number.isFinite(playerDuration) && playerDuration > 0 ? playerDuration : 0)
      || Number(node.sourceDurationSeconds)
      || Number(node.selectedAudio?.sourceDurationSeconds)
      || Number(node.selectedAudio?.duration) || 0);
  if (!(naturalDuration > 0)) return;
  const start = Math.max(0, Math.min(
    naturalDuration - 0.1,
    Number(node.trimStartSeconds ?? node.selectedAudio?.trimStartSeconds) || 0,
  ));
  const length = Math.max(0.1, Math.min(
    naturalDuration - start,
    Number(node.durationSeconds) || naturalDuration - start,
  ));
  const end = Math.min(naturalDuration, start + length);
  player._actBoardAudioPreviewSegment = { start, end };
  const current = Number(player.currentTime) || 0;
  if (seekToStart || current < start - 0.05 || current >= end - 0.02) {
    try { player.currentTime = start; } catch (err) { /* metadata may not be ready */ }
  }
}

function wireActBoardAudioPreviewSegment(player, node) {
  if (!player || !node || player._actBoardAudioPreviewSegmentWired) return;
  player._actBoardAudioPreviewSegmentWired = true;
  player.dataset.audioNodeId = node.id;
  player.addEventListener('loadedmetadata', () => {
    syncActBoardAudioPreviewSegment(player, node);
  });
  player.addEventListener('play', () => {
    syncActBoardAudioPreviewSegment(player, node);
  });
  player.addEventListener('timeupdate', () => {
    const segment = player._actBoardAudioPreviewSegment;
    if (!segment || player.paused) return;
    if (Number(player.currentTime) >= segment.end - 0.03) {
      player.pause();
      try { player.currentTime = segment.start; } catch (err) { /* optional */ }
    }
  });
}

function refreshActBoardAudioTimingForNode(node) {
  if (!node?.id) return;
  document.querySelectorAll('.storyboard-act-board-audio-player').forEach(player => {
    if (player.dataset.audioNodeId === String(node.id)) {
      // A source-editor drag is an explicit preview edit: move the native
      // player to the new in-point so the next play uses the selected window.
      syncActBoardAudioPreviewSegment(player, node, true);
    }
  });
  document.querySelectorAll('.storyboard-act-board-audio-timing').forEach(controls => {
    if (controls.dataset.audioNodeId !== String(node.id)) return;
    const sourceDuration = Math.max(0, Number(
      node.sourceDurationSeconds || node.selectedAudio?.sourceDurationSeconds
        || node.selectedAudio?.duration || 0,
    ));
    const sourceIn = Math.max(0, Number(node.trimStartSeconds
      ?? node.selectedAudio?.trimStartSeconds) || 0);
    const available = sourceDuration > 0 ? Math.max(0.1, sourceDuration - sourceIn) : 3600;
    controls.querySelectorAll('input').forEach(input => {
      const role = input.dataset.audioTimingRole;
      if (role === 'start') input.value = (Number(node.startSeconds) || 0).toFixed(1);
      if (role === 'source-in') {
        input.max = String(sourceDuration > 0 ? Math.max(0, sourceDuration - 0.1) : 3600);
        input.value = sourceIn.toFixed(1);
      }
      if (role === 'length') {
        input.max = String(available);
        input.value = (Number(node.durationSeconds) || 0.1).toFixed(1);
      }
    });
    const card = controls.closest('.storyboard-act-board-node');
    const timing = card?.querySelector('.storyboard-act-board-node-timing');
    if (timing) setActBoardNodeTimingText(timing, actBoardPlaybackTimingLabel(
      node.startSeconds, node.durationSeconds || 0.1,
    ));
  });
  document.querySelectorAll('.storyboard-act-board-audio-source-editor').forEach(editor => {
    if (editor.dataset.audioNodeId === String(node.id)
      && typeof editor._actBoardRefresh === 'function') editor._actBoardRefresh();
  });
  document.querySelectorAll('.storyboard-act-board-playback-audio-track').forEach(track => {
    const ownsNode = Array.from(track.querySelectorAll('[data-audio-node-id]'))
      .some(segment => segment.dataset.audioNodeId === String(node.id));
    if (ownsNode && typeof track._actBoardRefresh === 'function') track._actBoardRefresh();
  });
  refreshActBoardPlaybackDurations();
}

