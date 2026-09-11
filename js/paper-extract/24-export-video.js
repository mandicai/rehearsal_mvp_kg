//#region --- EXPORT TO VIDEO
function buildSoundEffectsExportPayload() {
  if (!activeSfxLayout) return [];
  return activeSfxLayout.sfxEvents.map(event => ({
    section_index: event.sectionIndex,
    name: event.name,
    preview_url: event.previewUrl,
    file_path: event.filePath,
    start_seconds: event.startSeconds,
    source_start_seconds: event.sourceStartSeconds || 0,
    duration_seconds: event.durationSeconds,
    lane: event.lane,
  }));
}

function buildNarrationsExportPayload() {
  if (!activeSfxLayout) return [];
  return activeSfxLayout.narrationEvents.map(event => ({
    section_index: event.sectionIndex,
    name: event.name,
    preview_url: event.previewUrl,
    file_path: event.filePath,
    start_seconds: event.startSeconds,
    source_start_seconds: event.sourceStartSeconds || 0,
    duration_seconds: event.durationSeconds,
    lane: event.lane,
  }));
}

// Keep a conventional `sections` payload alongside the Act Board graph. The
// current backend flattens board_sequences itself, but sending this fallback
// also keeps exports compatible with an older/restarting backend that validates
// sections before it knows about board_sequences.
function buildActBoardPremiereSections(boardPlan) {
  const sequences = Array.isArray(boardPlan?.sequences) ? boardPlan.sequences : [];
  return sequences.flatMap((sequence, sequenceIndex) => {
    const footage = Array.isArray(sequence?.footage) ? sequence.footage : [];
    return footage.map((item, footageIndex) => ({
      index: sequenceIndex * 1000 + footageIndex,
      title: String(item?.fragment || `Footage ${footageIndex + 1}`).trim()
        || `Footage ${footageIndex + 1}`,
      act: String(sequence?.act_key || `Act ${sequenceIndex + 1}`).trim()
        || `Act ${sequenceIndex + 1}`,
      start_seconds: (Number(sequence?.start_seconds) || 0)
        + (Number(item?.start_seconds) || 0),
      visual_preview_url: item?.media_url || '',
      edit_plan: { duration_seconds: item?.duration_seconds },
      _board_mode: true,
      _board_composition: item?.composition_mode || '',
      _board_split_visuals: item?.split_visuals || [],
      _board_source_volume: Number.isFinite(Number(item?.source_volume))
        ? Number(item.source_volume) : 1,
      _board_mute_audio: item?.mute_audio === true
        || (Number(item?.audio_lead_seconds) || 0) > 0
        || (Number(item?.audio_tail_seconds) || 0) > 0,
      _board_audio_lead_seconds: Number(item?.audio_lead_seconds) || 0,
      _board_audio_tail_seconds: Number(item?.audio_tail_seconds) || 0,
      _board_audio_source_start_seconds: Number(item?.source_start_seconds) || 0,
      _board_audio_duration_seconds: Number(item?.duration_seconds) || 0,
    }));
  });
}

function runExportForPremiere() {
  if (storyboardView === 'board') {
    const boardPlan = buildActBoardRenderPlan();
    if (boardPlan.sequences.length) {
      const boardSections = buildActBoardPremiereSections(boardPlan);
      const boardSoundEffects = (boardPlan.soundEffects || []).map((effect, index) => ({
        ...effect,
        lane: Number.isInteger(effect.lane) ? effect.lane : index,
      }));
      const boardNarrations = (boardPlan.narrations || []).map((narration, index) => ({
        ...narration,
        lane: Number.isInteger(narration.lane) ? narration.lane : index,
      }));
      return fetchPremiereExport(boardSections, premiereProjectId, boardSoundEffects,
        boardNarrations, boardPlan.sequences)
        .then(({ project_id, folder_path }) => {
          premiereProjectId = project_id;
          saveDebugSession();
          return { ok: true, folderPath: folder_path, shotCount: boardPlan.sequences.reduce(
            (sum, sequence) => sum + (sequence.footage || []).length, 0),
          };
        })
        .catch(err => ({ ok: false, error: err.message }));
    }
  }
  const storyboarded = currentSections.filter(section =>
    isSceneActive(section) && currentAssignments[section.index] && sectionHasRenderableVisual(section));
  if (storyboarded.length === 0) {
    return Promise.resolve({ ok: false, error: 'No storyboarded sections yet.' });
  }

  const payload = storyboarded.flatMap(section => {
    const baseStart = activeSfxLayout && activeSfxLayout.sceneStartSeconds.get(section.index);
    const base = {
      index: section.index,
      title: section.title,
      act: currentAssignments[section.index],
      role: getSceneRole(section),
      start_seconds: Number.isFinite(baseStart) ? baseStart : null,
      narration: effectiveSectionNarration(section),
      narration_audio_path: null,
      narration_duration_seconds: Number(section.narrationDurationSeconds) || getSceneDuration(section),
      uploaded_footage_path: section.uploadedFootagePath || null,
      selected_video: section.selectedVideo || null,
      selected_audio: section.selectedAudio || null,
    };

    // Generated expository cutaways are real sequential picture edits in the
    // web timeline, so expose each still as its own Premiere shot instead of
    // flattening the scene back into an overlapping Primary clip.
    if (section.cutaways && section.cutaways.length && section.visualSource === 'cutaways') {
      let offset = 0;
      return section.cutaways.map((cutaway, cutawayIndex) => {
        const duration = getCutawayDuration(cutaway);
        const shot = {
          ...base,
          index: section.index,
          cutaway_index: cutawayIndex,
          title: cutaway.caption || `${section.title} cutaway ${cutawayIndex + 1}`,
          role: 'bRoll',
          start_seconds: Number.isFinite(baseStart) ? baseStart + offset : null,
          narration_audio_path: cutawayIndex === 0 ? base.narration_audio_path : null,
          uploaded_footage_path: null,
          visual_preview_url: cutaway.preview_url || null,
          edit_plan: {
            transition_in: 'hard_cut', duration_seconds: duration,
            ken_burns: { enabled: false, pan: null }, text_overlay: null,
          },
        };
        offset += duration;
        return shot;
      });
    }

    const hasShotFrames = hasLegacyShotFrames(section);
    const resolved = hasShotFrames
      ? { previewUrl: section.startFramePreviewUrl, figureDataUrl: null }
      : resolveSectionVisualForRender(section);
    return [{
      ...base,
      visual_preview_url: resolved.previewUrl,
      figure_image_data_url: resolved.figureDataUrl,
      edit_plan: section.editPlan
        ? {
          transition_in: section.editPlan.transitionIn,
          duration_seconds: section.editPlan.durationSeconds,
          ken_burns: section.editPlan.kenBurns,
          text_overlay: section.editPlan.textOverlay,
        }
        : null,
    }];
  });

  return fetchPremiereExport(payload, premiereProjectId, buildSoundEffectsExportPayload(), buildNarrationsExportPayload())
    .then(({ project_id, folder_path }) => {
      premiereProjectId = project_id;
      saveDebugSession();
      return { ok: true, folderPath: folder_path, shotCount: payload.length };
    })
    .catch(err => {
      return { ok: false, error: err.message };
    });
}

// --- Automated MP4 render (backend/movie_render.py via /render/start): the
// counterpart to runExportForPremiere above, producing a real documentary.mp4
// server-side with no Premiere or manual steps. ---

// Which single visual to render for a section, following buildVisualBox's
// exact priority (the most-recently-chosen source first, then the shared
// fallback order) - returns a resolvable local preview URL for any
// file-backed visual, or the paper figure as a data URL if that's all
// there is, or neither.
function resolveSectionVisualForRender(section) {
  const selectedExampleRecord = section.selectedExample || null;
  const selectedExample = selectedExampleRecord && selectedExampleRecord.url;
  const previewBySource = {
    // Expository cutaways are planning-only, but the scene still needs a
    // still under its narration - use the first cutaway's background image.
    cutaways: section.cutaways && section.cutaways.length && section.cutaways[0].preview_url,
    stockVideo: section.selectedVideo && section.selectedVideo.localPreviewUrl,
    video: section.uploadedFootagePreviewUrl,
    uploadedSketch: section.uploadedSketchPreviewUrl,
    // Modern example selections are the scene visual. Images and generated
    // videos both arrive here as a URL; the video branch also keeps the
    // animated preview fallback for older saved sessions without `kind`.
    examples: selectedExample || null,
    animatedSketch: section.animatedSketchPreviewUrl,
    sketch: section.sketchPreviewUrl,
  };
  for (const key of [section.visualSource, 'uploadedSketch', 'cutaways', 'stockVideo', 'video', 'examples', 'animatedSketch', 'sketch']) {
    if (key && previewBySource[key]) {
      return {
        previewUrl: previewBySource[key],
        figureDataUrl: null,
        // Generated image-to-video clips can carry model audio that should
        // not enter the documentary mix. Keep this metadata with the visual
        // so the MP4 renderer can mute only generated clips.
        muteSourceAudio: Boolean(
          selectedExampleRecord?.generated === true
          || (selectedExampleRecord?.kind === 'video' && selectedExampleRecord?.source_image_url)
          || (key === 'animatedSketch' && section.animatedSketchIsGif !== true)
        ),
      };
    }
  }
  if (section.image) return { previewUrl: null, figureDataUrl: section.image, muteSourceAudio: false };
  return { previewUrl: null, figureDataUrl: null, muteSourceAudio: false };
}

function hasLegacyShotFrames(section) {
  // A modern examples selection (including a generated video card) owns the
  // scene visual even if an older saved session still has frame fields.
  const modernExampleActive = section.visualSource === 'examples'
    || !!(section.selectedExample && section.selectedExample.url);
  return !modernExampleActive
    && !!(section.startFramePreviewUrl && section.endFramePreviewUrl);
}

function sectionHasRenderableVisual(section) {
  if (hasLegacyShotFrames(section)) return true;
  const resolved = resolveSectionVisualForRender(section);
  return !!(resolved.previewUrl || resolved.figureDataUrl);
}

let renderPollTimer = null;
let combinedPremiereExportResult = null;
let renderMovieDownloadEl = null;
let renderMovieOutputUrl = '';

function setActBoardFullPlaybackState(state, message = '', url = '') {
  actBoardFullPlaybackStatus = { state, message, url };
  if (state === 'rendering') actBoardFullPlaybackPanel?._actBoardFullPlayback?.setRendering?.();
  else if (state === 'ready') actBoardFullPlaybackPanel?._actBoardFullPlayback?.setReady?.(url);
  else if (state === 'error') actBoardFullPlaybackPanel?._actBoardFullPlayback?.setError?.(message);
}

function runCombinedExport() {
  if (renderMovieBtn) renderMovieBtn.disabled = true;
  combinedPremiereExportResult = null;
  setRenderMovieStatus('Writing Premiere plan ...');
  return runExportForPremiere().then(result => {
    combinedPremiereExportResult = result;
    setRenderMovieStatus(result.ok
      ? 'Premiere plan saved. Starting MP4 render ...'
      : `Premiere plan failed (${result.error}). Trying MP4 render ...`, !result.ok);
    return runRenderMovie();
  });
}

function actBoardRenderMediaUrl(node) {
  if (!node) return '';
  const selectedKey = String(node.selectedVisualKey || '');
  const selectedGenerated = selectedKey.startsWith('generated-') && Array.isArray(node.generatedOptions)
    ? node.generatedOptions[node.selectedGeneratedIndex || 0]
    : null;
  const selectedResult = selectedKey.startsWith('result-') && Array.isArray(node.results)
    ? node.results[node.selectedResultIndex || 0]
    : null;
  const url = selectedResult?.localPreviewUrl
    || node.mediaUrl
    || selectedGenerated?.url
    || selectedResult?.video_url
    || selectedResult?.url
    // A still's thumbnail is a valid renderable image. Keep it as a final
    // fallback for split-screen sources whose selected visual only retained
    // a thumbnail in an older saved session.
    || node.mediaThumbnailUrl
    || selectedGenerated?.thumbnail_url
    || selectedResult?.thumbnail_url
    || '';
  // Browser-only object URLs cannot be read by the server-side ffmpeg
  // process. Uploaded/generated media normally has a persisted preview URL;
  // treating a stale blob URL as missing produces a useful render error.
  return String(url).startsWith('blob:') ? '' : url;
}

function actBoardRenderAudioUrl(node) {
  const source = actBoardAudioSource(node);
  return String(source.url || '').startsWith('blob:') ? '' : source.url;
}

function actBoardRenderFootageSpec(node, nodes) {
  const splitVisuals = node?.compositionMode === 'split-screen'
    ? (node.splitScreenNodeIds || [])
      .map(id => nodes.find(item => item.type === 'footage' && item.id === id))
      .filter(Boolean)
      .map(splitNode => ({
        media_url: actBoardRenderMediaUrl(splitNode),
        source_start_seconds: Math.max(0, Number(splitNode.trimStartSeconds) || 0),
      }))
      .filter(item => item.media_url)
    : [];
  const mediaUrl = actBoardRenderMediaUrl(node) || splitVisuals[0]?.media_url || '';
  return {
    node_id: node.id,
    fragment: node.fragment || '',
    media_url: mediaUrl,
    mute_audio: node.compositionMode === 'split-screen'
      ? true : actBoardSelectedFootageMedia(node).muteAudio === true,
    duration_seconds: Number(node.durationSeconds) > 0 ? Number(node.durationSeconds) : 1,
    start_seconds: Number(node.startSeconds) || 0,
    source_start_seconds: Math.max(0, Number(node.trimStartSeconds) || 0),
    // The node's own level, so footage audio is mixed like a sound effect or
    // narration rather than being fixed at whatever the renderer assumes.
    // Ducking under narration is still applied on top, in the renderer.
    source_volume: actBoardNodeVolume(node, 0.5),
    // J/L-cut. The shot's own audio is muted in the per-shot render and the
    // clip's sound is re-emitted as one timeline-absolute event spanning the
    // lead, the shot and the tail - shot audio cannot cross a concat boundary,
    // but the global mix pass runs over the already-joined video and can.
    audio_lead_seconds: Math.max(0, Number(node.audioLeadSeconds) || 0),
    audio_tail_seconds: Math.max(0, Number(node.audioTailSeconds) || 0),
    ...(splitVisuals.length >= 2 ? {
      composition_mode: 'split-screen',
      split_visuals: splitVisuals,
    } : {}),
  };
}

// Only the currently open scene is live on the canvas. Saved scenes keep
// their nodes in nodeSnapshots, so an all-acts render must merge those saved
// nodes back in instead of looking exclusively at the live node array.
function actBoardRenderNodesForAct(actKey) {
  const byId = new Map(actBoardNodesForAct(actKey).map(node => [node.id, node]));
  actBoardScenesForAct(actKey).forEach(scene => {
    (Array.isArray(scene.nodeSnapshots) ? scene.nodeSnapshots : []).forEach(snapshot => {
      if (!snapshot?.id || byId.has(snapshot.id)) return;
      byId.set(snapshot.id, {
        ...snapshot,
        actKey,
        sceneId: snapshot.sceneId || scene.id,
      });
    });
  });
  return Array.from(byId.values());
}

function hasActBoardLinkedSequence() {
  return currentArcSections.some(act => {
    const nodes = actBoardRenderNodesForAct(act.key);
    const hasNarrationSequence = nodes.some(node => node.type === 'narration'
      && (node.footageNodeIds || []).some(id =>
        nodes.some(candidate => candidate.id === id && candidate.type === 'footage'
          && actBoardTrackNodeVisible(candidate))));
    const hasSceneSequence = actBoardScenesForAct(act.key).some(scene =>
      orderedActBoardSceneFootage(act.key, scene, nodes)
        .some(actBoardTrackNodeVisible));
    return hasNarrationSequence || hasSceneSequence;
  });
}

function buildActBoardRenderPlan() {
  const sequences = [];
  const narrations = [];
  const soundEffects = [];
  // Scenes whose rail audio has already been emitted, so a scene with several
  // narration segments contributes its music/sound exactly once.
  const sceneRailAudioEmitted = new Set();
  let cursor = 0;
  currentArcSections.forEach(act => {
    const nodes = actBoardRenderNodesForAct(act.key);
    const sceneOrder = new Map(actBoardScenesForAct(act.key).map((scene, index) => [scene.id, index]));
    const nodeOrder = new Map(nodes.map((node, index) => [node.id, index]));
    // The live node array represents whichever scene is currently open. Sort
    // the merged live+snapshot nodes by saved scene order so the full render
    // follows Scene 1, Scene 2, … even when Scene 2 is the one on the canvas.
    const narrationNodes = nodes.filter(node => node.type === 'narration'
      && actBoardTrackNodeVisible(node)).sort((a, b) => {
      const aScene = sceneOrder.has(a.sceneId) ? sceneOrder.get(a.sceneId) : Infinity;
      const bScene = sceneOrder.has(b.sceneId) ? sceneOrder.get(b.sceneId) : Infinity;
      if (aScene !== bScene) return aScene - bScene;
      const aStart = Number(a.startSeconds);
      const bStart = Number(b.startSeconds);
      if (Number.isFinite(aStart) && Number.isFinite(bStart) && aStart !== bStart) return aStart - bStart;
      return (nodeOrder.get(a.id) || 0) - (nodeOrder.get(b.id) || 0);
    });
    const sequencedFootageIds = new Set();
    // Scenes whose unowned footage has already been folded into a narration
    // sequence, so a scene with several narration segments contributes it once.
    const sceneOrphanFootageEmitted = new Set();
    // A fallback scene narration can represent the whole act when the user
    // has not recorded an act-board narration. Use it once; separately
    // recorded narration nodes each get their own timed umbrella track.
    let fallbackNarrationUsed = false;
    narrationNodes.forEach(narrationNode => {
      // Normally the narration's footageNodeIds are the authoritative visual
      // sequence. A split-screen composition is a scene-level node, though,
      // and older/saved scenes can have it attached to the scene without its
      // id making it into that narration list. Include those split nodes here
      // so the all-acts/full-playback render cannot silently omit the
      // composition even though scene playback can still see it.
      let linked = orderedActBoardLinkedFootage(act.key, narrationNode, nodes)
        .filter(actBoardTrackNodeVisible);
      const narrationScene = actBoardSceneForNode(act.key, narrationNode);
      const byRailOrder = (a, b) => {
        const aSequence = Number(a.sequenceIndex);
        const bSequence = Number(b.sequenceIndex);
        if (Number.isFinite(aSequence) && Number.isFinite(bSequence)
          && aSequence !== bSequence) return aSequence - bSequence;
        return (Number(a.startSeconds) || 0) - (Number(b.startSeconds) || 0);
      };
      // Resolve the scene's footage once and reuse it below. This call is not
      // a pure read - it re-packs any shot that is not manually timed - so
      // calling it a second time for the orphan pass would silently shift
      // timings that Smart arrange had just committed.
      const sceneFootage = narrationScene
        ? orderedActBoardSceneFootage(act.key, narrationScene, nodes) : [];
      if (narrationScene) {
        const linkedIds = new Set(linked.map(item => item.id));
        sceneFootage
          .filter(item => item.compositionMode === 'split-screen'
            && actBoardTrackNodeVisible(item) && !linkedIds.has(item.id))
          .forEach(item => {
            linked.push(item);
            linkedIds.add(item.id);
          });
        linked.sort(byRailOrder);
      }
      if (!linked.length) return;
      // Footage can sit on a scene's timeline without being in any narration's
      // footageNodeIds - anything the presenter made on the canvas themselves,
      // a double-click spawn or an upload, then arranged on the track. Those
      // used to fall through to the footage-only scene sweep further below,
      // which appends its sequence after every narration sequence, so the clip
      // played at the very end of the export instead of where it was arranged.
      //
      // This runs AFTER the guard above on purpose: folding orphans in earlier
      // would let a narration that renders nothing of its own start producing a
      // sequence, which changes timing for unrelated scenes. Footage owned by
      // another narration is left alone - that narration renders it itself.
      if (narrationScene && !sceneOrphanFootageEmitted.has(narrationScene.id)) {
        sceneOrphanFootageEmitted.add(narrationScene.id);
        const linkedIds = new Set(linked.map(item => item.id));
        const orphans = sceneFootage
          .filter(item => actBoardTrackNodeVisible(item) && !linkedIds.has(item.id)
            && !actBoardNarrationForNode(act.key, item));
        if (orphans.length) {
          linked.push(...orphans);
          linked.sort(byRailOrder);
        }
      }
      const scene = actBoardSceneForNode(act.key, narrationNode);
      const includeNarration = narrationNode.includeNarration !== false;
      let umbrellaClip = null;
      if (includeNarration && narrationNode.audioPreviewUrl) {
        umbrellaClip = {
          previewUrl: narrationNode.audioPreviewUrl,
          _nativePreviewUrl: narrationNode._nativeAudioUrl || null,
          trimStartSeconds: 0,
          durationSeconds: Number(narrationNode.audioDurationSeconds) || 0,
        };
        narrationNode.narrationAudioDurationSeconds = Number(narrationNode.audioDurationSeconds) || 0;
      } else if (includeNarration && !fallbackNarrationUsed) {
        const audioSection = actBoardSectionsForAct(act.key).find(section => {
          const clips = migrateNarrationClips(section);
          return clips.some(clip => clip.previewUrl || clip._nativePreviewUrl);
        });
        if (!umbrellaClip && audioSection) {
          umbrellaClip = migrateNarrationClips(audioSection)
            .find(item => item.previewUrl || item._nativePreviewUrl) || null;
          if (umbrellaClip) {
            narrationNode.narrationAudioDurationSeconds = Number(umbrellaClip.durationSeconds) || 0;
            fallbackNarrationUsed = true;
          }
        }
      }
      recomputeActBoardTiming(narrationNode);
      // Scene-rail music/sound is not hung off a narration segment, so
      // collecting audio purely by `linkedToNodeId` left it out of the render
      // payload entirely - the exported mp4 came back silent underneath.
      // Emit a scene's rail audio with the first of its narration sequences,
      // so several narration segments in one scene cannot duplicate it.
      const sceneRailAudio = scene && !sceneRailAudioEmitted.has(scene.id)
        ? nodes.filter(item => item.type === 'audio'
          && !item.linkedToNodeId
          && item.sceneId === scene.id)
        : [];
      if (scene) sceneRailAudioEmitted.add(scene.id);
      const linkedAudio = [
        ...orderedActBoardLinkedAudio(act.key, narrationNode, nodes),
        ...sceneRailAudio,
      ]
        .filter(actBoardTrackNodeVisible)
        .sort((a, b) => (Number(a.startSeconds) || 0) - (Number(b.startSeconds) || 0));
      const footage = linked.map(node => actBoardRenderFootageSpec(node, nodes));
      if (!footage.length) return;
      const sequenceDuration = Math.max(
        footage.reduce((sum, item) => sum + item.duration_seconds, 0),
        ...footage.map(item => (Number(item.start_seconds) || 0) + item.duration_seconds),
        ...linkedAudio.map(audioNode => (Number(audioNode.startSeconds) || 0)
          + Math.max(0.25, Number(audioNode.durationSeconds) || 1)),
        Number(umbrellaClip?.durationSeconds) || 0,
      );
      const sequence = {
        act_key: act.key,
        scene_id: scene?.id || null,
        narration_node_id: narrationNode.id,
        start_seconds: cursor,
        duration_seconds: sequenceDuration,
        footage,
      };
      sequences.push(sequence);
      linked.forEach(node => sequencedFootageIds.add(node.id));

      linkedAudio.forEach(audioNode => {
        const previewUrl = actBoardRenderAudioUrl(audioNode);
        if (!previewUrl) return;
        const source = actBoardAudioSource(audioNode);
        soundEffects.push({
          preview_url: previewUrl,
          start_seconds: cursor + Math.max(0, Number(audioNode.startSeconds) || 0),
          source_start_seconds: source.trimStartSeconds,
          duration_seconds: Math.max(0.25, Number(audioNode.durationSeconds)
            || source.durationSeconds || 1),
          kind: audioNode.audioKind === 'music' ? 'music' : 'sfx',
          gain: Math.max(0, Math.min(2, actBoardNodeVolume(audioNode))),
        });
      });

      // Use one recorded narration clip from the act as the umbrella voice
      // track when one exists. The suggested text itself remains planning
      // metadata until the presenter records it.
      if (includeNarration && umbrellaClip) {
        const previewUrl = umbrellaClip.previewUrl || umbrellaClip._nativePreviewUrl;
        // blob: URLs only exist in this browser and cannot be resolved by the
        // render server. The persisted preview_url is the server-renderable
        // source; skip the event if an older session has only a blob URL.
        if (previewUrl && !String(previewUrl).startsWith('blob:')) {
          narrations.push({
            preview_url: previewUrl,
            start_seconds: cursor,
            source_start_seconds: Number(umbrellaClip.trimStartSeconds) || 0,
            duration_seconds: sequenceDuration,
          });
        }
      }
      cursor += sequenceDuration;
    });

    // A scene can be deliberately built as a footage-only sequence. Follow
    // its direct footage links (or its selected starting node) and render it
    // without requiring a narration node.
    actBoardScenesForAct(act.key).forEach(scene => {
      const linked = orderedActBoardSceneFootage(act.key, scene, nodes)
        .filter(node => actBoardTrackNodeVisible(node) && !sequencedFootageIds.has(node.id));
      if (!linked.length) return;
      const sceneNodeIds = new Set(scene.nodeIds || []);
      const linkedAudio = nodes.filter(audioNode => audioNode.type === 'audio'
        && actBoardTrackNodeVisible(audioNode)
        && audioNode.linkedToNodeId
        && (sceneNodeIds.has(audioNode.linkedToNodeId)
          || linked.some(footage => footage.id === audioNode.linkedToNodeId)));
      const footage = linked.map(node => actBoardRenderFootageSpec(node, nodes));
      const sequenceDuration = Math.max(
        footage.reduce((sum, item) => sum + item.duration_seconds, 0),
        ...footage.map(item => (Number(item.start_seconds) || 0) + item.duration_seconds),
        ...linkedAudio.map(audioNode => (Number(audioNode.startSeconds) || 0)
          + Math.max(0.25, Number(audioNode.durationSeconds) || 1)),
      );
      sequences.push({
        act_key: act.key,
        scene_id: scene.id,
        narration_node_id: null,
        start_seconds: cursor,
        duration_seconds: sequenceDuration,
        footage,
      });
      linked.forEach(node => sequencedFootageIds.add(node.id));
      linkedAudio.forEach(audioNode => {
        const previewUrl = actBoardRenderAudioUrl(audioNode);
        if (!previewUrl) return;
        const source = actBoardAudioSource(audioNode);
        soundEffects.push({
          preview_url: previewUrl,
          start_seconds: cursor + Math.max(0, Number(audioNode.startSeconds) || 0),
          source_start_seconds: source.trimStartSeconds,
          duration_seconds: Math.max(0.25, Number(audioNode.durationSeconds)
            || source.durationSeconds || 1),
          kind: audioNode.audioKind === 'music' ? 'music' : 'sfx',
          gain: Math.max(0, Math.min(2, actBoardNodeVolume(audioNode))),
        });
      });
      cursor += sequenceDuration;
    });
  });
  return { sequences, narrations, soundEffects };
}

function pollActBoardFullPlaybackRender(projectId, outputUrl) {
  if (actBoardFullPlaybackRenderTimer) {
    clearInterval(actBoardFullPlaybackRenderTimer);
    actBoardFullPlaybackRenderTimer = null;
  }
  actBoardFullPlaybackRenderTimer = setInterval(() => {
    fetchRenderStatus(projectId)
      .then(({ state, message }) => {
        if (state === 'rendering') return;
        clearInterval(actBoardFullPlaybackRenderTimer);
        actBoardFullPlaybackRenderTimer = null;
        if (state === 'done') {
          setActBoardFullPlaybackState('ready', 'Full playback ready.', outputUrl);
        } else {
          setActBoardFullPlaybackState('error', message || 'Full playback render failed.');
        }
      })
      .catch(err => {
        clearInterval(actBoardFullPlaybackRenderTimer);
        actBoardFullPlaybackRenderTimer = null;
        setActBoardFullPlaybackState('error', err.message);
      });
  }, 2000);
}

function runActBoardFullPlaybackRender() {
  if (storyboardView !== 'board') return Promise.resolve(false);
  const plan = buildActBoardRenderPlan();
  if (!plan.sequences.length) {
    setActBoardFullPlaybackState('error', 'No linked act-board sequences are ready for playback.');
    return Promise.resolve(false);
  }
  const missing = plan.sequences.flatMap(sequence =>
    sequence.footage.filter(item => !item.media_url)
      .map(item => item.fragment || item.node_id || 'an unlabelled footage node'));
  if (missing.length) {
    setActBoardFullPlaybackState(
      'error',
      `Missing media for: ${missing.join(', ')}. Upload or generate that footage first.`,
    );
    return Promise.resolve(false);
  }
  if (actBoardFullPlaybackRenderTimer) {
    clearInterval(actBoardFullPlaybackRenderTimer);
    actBoardFullPlaybackRenderTimer = null;
  }
  setActBoardFullPlaybackState('rendering', 'Rendering all acts and scenes…');
  // This request has its own project/status poll. It deliberately does not
  // touch renderMovieBtn, renderMovieStatusEl, renderMovieDownloadEl, or the
  // Timeline + Scenes render poll, so background updates cannot interrupt
  // other editing and export controls.
  // Leave project_id blank so the server allocates a fresh export directory;
  // reusing the active Premiere project would overwrite its render status and
  // MP4 if Timeline + Scenes is exporting at the same time.
  return fetchRenderStart([], '', plan.soundEffects, plan.narrations, plan.sequences)
    .then(({ project_id, preview_url }) => {
      const outputUrl = preview_url
        || `/premiere_exports/${encodeURIComponent(project_id)}/documentary.mp4`;
      pollActBoardFullPlaybackRender(project_id, outputUrl);
      return true;
    })
    .catch(err => {
      setActBoardFullPlaybackState('error', err.message);
      return false;
    });
}

function runRenderMovie() {
  // Renderable = arranged and has some visual: a narration-driven shot (start
  // + end frames), a generated storyboard visual, a stock/uploaded clip, or
  // the paper figure. (Shot-frame scenes don't set section.visual, so this
  // can't just check that.)
  const boardPlan = buildActBoardRenderPlan();
  // Keep the established timeline + scenes export intact. The linked act
  // board becomes the render source only when its separate Board view is
  // active; switching back to Timeline renders the regular scene storyboard.
  const useBoardPlan = storyboardView === 'board' && boardPlan.sequences.length > 0;
  const storyboarded = currentSections.filter(section =>
    isSceneActive(section) && currentAssignments[section.index] && sectionHasRenderableVisual(section));
  if (!useBoardPlan && storyboarded.length === 0) {
    if (storyboardView === 'board') {
      setActBoardFullPlaybackState('error', 'No linked act-board sequences are ready for playback.');
    }
    setRenderMovieStatus('No shots yet - generate a shot (or pick footage) for a scene first.', true);
    if (renderMovieBtn) renderMovieBtn.disabled = false;
    return Promise.resolve(false);
  }

  if (useBoardPlan) {
    const missing = boardPlan.sequences.flatMap(sequence =>
      sequence.footage.filter(item => !item.media_url)
        .map(item => item.fragment || item.node_id || 'an unlabelled footage node'));
    if (missing.length) {
      setActBoardFullPlaybackState(
        'error',
        `Missing media for: ${missing.join(', ')}. Upload or generate that footage first.`,
      );
      setRenderMovieStatus(
        `The linked act-board sequence is missing media for: ${missing.join(', ')}. Upload or generate that footage, then try again.`,
        true,
      );
      if (renderMovieBtn) renderMovieBtn.disabled = false;
      return Promise.resolve(false);
    }
    setActBoardFullPlaybackState('rendering', 'Rendering all acts and scenes…');
  }

  // Build the payload up front, bailing (before touching the server) if any
  // shot has no resolvable visual - the render route rejects that anyway,
  // but naming the offending section here is friendlier than a generic
  // server error mid-render.
  const payload = [];
  for (const section of (useBoardPlan ? [] : storyboarded)) {
    // A narration-driven shot (start + end frames) takes priority - it
    // hard-cuts between the two frames in the render. Otherwise fall back to
    // the single resolved visual (stock/uploaded/sketch) or the paper figure.
    const hasShotFrames = hasLegacyShotFrames(section);
    let previewUrl = null;
    let figureDataUrl = null;
    let muteSourceAudio = false;
    if (!hasShotFrames) {
      ({ previewUrl, figureDataUrl, muteSourceAudio } = resolveSectionVisualForRender(section));
      if (!previewUrl && !figureDataUrl) {
        setRenderMovieStatus(`"${section.title}" has no usable visual yet - generate a shot, pick footage, or use its figure image, then try again.`, true);
        if (renderMovieBtn) renderMovieBtn.disabled = false;
        return Promise.resolve(false);
      }
    }
    // Expository scenes render EVERY cutaway still in sequence under the
    // narration (see movie_render.render_shot's cutaway branch), not just the
    // first - send them all when cutaways are the scene's active visual.
    const usingCutaways = !hasShotFrames && previewUrl && section.cutaways && section.cutaways.length
      && previewUrl === section.cutaways[0].preview_url;
    payload.push({
      title: section.title,
      start_frame_preview_url: hasShotFrames ? section.startFramePreviewUrl : null,
      end_frame_preview_url: hasShotFrames ? section.endFramePreviewUrl : null,
      visual_preview_url: previewUrl,
      mute_source_audio: Boolean(muteSourceAudio),
      cutaway_preview_urls: usingCutaways ? section.cutaways.map(c => c.preview_url).filter(Boolean) : null,
      figure_image_data_url: (previewUrl || hasShotFrames) ? null : figureDataUrl,
      narration_audio_path: null,
      edit_plan: section.editPlan
        ? {
          transition_in: section.editPlan.transitionIn,
          duration_seconds: section.editPlan.durationSeconds,
          ken_burns: section.editPlan.kenBurns,
          text_overlay: section.editPlan.textOverlay,
        }
        : null,
    });
  }

  if (renderMovieBtn) renderMovieBtn.disabled = true;
  if (renderMovieDownloadEl) {
    renderMovieDownloadEl.hidden = true;
    renderMovieDownloadEl.removeAttribute('href');
  }
  renderMovieOutputUrl = '';
  setRenderMovieStatus('Starting render ...');
  if (renderPollTimer) { clearInterval(renderPollTimer); renderPollTimer = null; }

  const narrations = useBoardPlan ? boardPlan.narrations : buildNarrationsExportPayload();
  return fetchRenderStart(payload, premiereProjectId,
    [...buildSoundEffectsExportPayload(), ...(useBoardPlan ? boardPlan.soundEffects : [])],
    narrations, boardPlan.sequences)
    .then(({ project_id, preview_url }) => {
      premiereProjectId = project_id;
      renderMovieOutputUrl = preview_url || `/premiere_exports/${encodeURIComponent(project_id)}/documentary.mp4`;
      saveDebugSession();
      setRenderMovieStatus(useBoardPlan
        ? `Rendering ${boardPlan.sequences.length} linked sequence${boardPlan.sequences.length === 1 ? '' : 's'} across the act board ...`
        : 'Rendering ...');
      pollRenderStatus();
      return true;
    })
    .catch(err => {
      if (useBoardPlan) setActBoardFullPlaybackState('error', err.message);
      const planNote = combinedPremiereExportResult && combinedPremiereExportResult.ok
        ? ` Premiere plan was saved at ${combinedPremiereExportResult.folderPath}/edit_plan.json.` : '';
      setRenderMovieStatus(`${err.message}${planNote}`, true);
      if (renderMovieBtn) renderMovieBtn.disabled = false;
      return false;
    });
}

function setRenderMovieDownload(projectId) {
  if (!renderMovieDownloadEl || !projectId) return;
  const baseUrl = renderMovieOutputUrl
    || `/premiere_exports/${encodeURIComponent(projectId)}/documentary.mp4`;
  const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}download=${Date.now()}`;
  renderMovieDownloadEl.href = url;
  renderMovieDownloadEl.hidden = false;
}

// Self-clearing poll of /render/status to completion. The backend performs and
// knows the render's state, so an owned poll can report progress and completion.
// On done, the status names both the MP4 and Premiere-plan outputs.
function pollRenderStatus() {
  renderPollTimer = setInterval(() => {
    fetchRenderStatus(premiereProjectId)
      .then(({ state, message }) => {
        if (state === 'rendering') {
          setRenderMovieStatus(message || 'Rendering ...');
          return;
        }
        clearInterval(renderPollTimer);
        renderPollTimer = null;
        if (renderMovieBtn) renderMovieBtn.disabled = false;
        if (state === 'done') {
          const mp4Path = `premiere_exports/${premiereProjectId}/documentary.mp4`;
          setRenderMovieDownload(premiereProjectId);
          if (actBoardFullPlaybackStatus.state === 'rendering') {
            setActBoardFullPlaybackState('ready', 'Full playback ready.', renderMovieOutputUrl);
          }
          if (combinedPremiereExportResult && combinedPremiereExportResult.ok) {
            setRenderMovieStatus(
              `Done — MP4: ${mp4Path} · Premiere plan: ${combinedPremiereExportResult.folderPath}/edit_plan.json`);
          } else if (combinedPremiereExportResult && !combinedPremiereExportResult.ok) {
            setRenderMovieStatus(`MP4 done: ${mp4Path} · Premiere plan failed: ${combinedPremiereExportResult.error}`, true);
          } else {
            setRenderMovieStatus(`Done - ${mp4Path}`);
          }
        } else {
          if (actBoardFullPlaybackStatus.state === 'rendering') {
            setActBoardFullPlaybackState('error', message || 'Full playback render failed.');
          }
          setRenderMovieStatus(message || 'Render failed.', true);
        }
      })
      .catch(err => {
        clearInterval(renderPollTimer);
        renderPollTimer = null;
        if (renderMovieBtn) renderMovieBtn.disabled = false;
        if (actBoardFullPlaybackStatus.state === 'rendering') {
          setActBoardFullPlaybackState('error', err.message);
        }
        setRenderMovieStatus(err.message, true);
      });
  }, 2000);
}
//#endregion

