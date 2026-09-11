function actBoardNarrationContext(actKey, act) {
  const scenes = actBoardSectionsForAct(actKey);
  const source = scenes.map((section, index) => {
    const narration = effectiveSectionNarration(section);
    const notes = sectionCompositionNotes(section);
    return `Scene ${index + 1}: ${section.title || 'Untitled scene'}\n${narration || notes}`;
  }).join('\n\n');
  return source.slice(0, 12000) || `${act.label || 'This act'}: ${act.description || ''}`;
}

function actBoardSourceMaterialContext(actKey, act) {
  const scenes = actBoardSectionsForAct(actKey);
  const source = scenes.map((section, index) =>
    `Scene ${index + 1}: ${section.title || 'Untitled scene'}\n${sectionCompositionNotes(section)}`
  ).filter(block => block.split('\n').slice(1).join('\n').trim()).join('\n\n');
  return source.slice(0, 12000) || `${act.label || 'This act'}: ${act.description || ''}`;
}

// Narration nodes keep an editable copy of the source context only after the
// presenter changes it. Until then, show the current act source material as a
// live fallback. An explicitly emptied field is respected; the first draft
// still uses the established act context, including any existing draft text.
function actBoardNarrationNotesForNode(actKey, act, node) {
  if (node && Object.prototype.hasOwnProperty.call(node, 'sceneNotes')) {
    return String(node.sceneNotes || '').trim();
  }
  return actBoardSourceMaterialContext(actKey, act);
}

function storyboardRenderElementKey(element) {
  if (!element) return '';
  const node = element.closest?.('[data-node-id]');
  const section = element.closest?.('[data-section-index]');
  const act = element.closest?.('[data-act-key]');
  const className = typeof element.className === 'string' ? element.className : '';
  const siblings = element.parentElement
    ? Array.from(element.parentElement.children).filter(item =>
      item.tagName === element.tagName
      && (typeof item.className === 'string' ? item.className : '') === className)
    : [];
  const siblingIndex = Math.max(0, siblings.indexOf(element));
  return [
    element.tagName,
    className,
    node?.dataset.nodeId || '',
    section?.dataset.sectionIndex || '',
    act?.dataset.actKey || '',
    siblingIndex,
  ].join('|');
}

function captureStoryboardRenderState(root = document) {
  const active = document.activeElement;
  const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
  return {
    windowX: Number(window.scrollX) || 0,
    windowY: Number(window.scrollY) || 0,
    details: Array.from(scope.querySelectorAll('details')).map(element => ({
      key: storyboardRenderElementKey(element),
      open: element.open,
    })),
    scroll: Array.from(scope.querySelectorAll('*'))
      .filter(element => (element.scrollTop || element.scrollLeft)
        && (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth))
      .map(element => ({
        key: storyboardRenderElementKey(element),
        top: element.scrollTop,
        left: element.scrollLeft,
      })),
    focus: active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)
      ? {
        key: storyboardRenderElementKey(active),
        start: Number.isFinite(active.selectionStart) ? active.selectionStart : null,
        end: Number.isFinite(active.selectionEnd) ? active.selectionEnd : null,
      } : null,
  };
}

function restoreStoryboardRenderState(state, root = document) {
  if (!state) return;
  const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
  const restore = () => {
    window.scrollTo(state.windowX, state.windowY);
    const elements = Array.from(scope.querySelectorAll('*'));
    const byKey = new Map();
    elements.forEach(element => {
      const key = storyboardRenderElementKey(element);
      if (key && !byKey.has(key)) byKey.set(key, element);
    });
    state.details.forEach(item => {
      const element = byKey.get(item.key);
      if (element && element.tagName === 'DETAILS') element.open = item.open;
    });
    state.scroll.forEach(item => {
      const element = byKey.get(item.key);
      if (!element) return;
      element.scrollTop = item.top;
      element.scrollLeft = item.left;
    });
    if (state.focus) {
      const element = byKey.get(state.focus.key);
      if (element && typeof element.focus === 'function') {
        element.focus({ preventScroll: true });
        if (state.focus.start != null && typeof element.setSelectionRange === 'function') {
          try { element.setSelectionRange(state.focus.start, state.focus.end ?? state.focus.start); } catch (err) { /* optional */ }
        }
      }
    }
  };
  restore();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
}

function rerenderActBoard(options = {}) {
  // Media-generation status updates normally rebuild the Act Board. Preserve
  // any active scene transport across that rebuild so an async image/video
  // request cannot pause narration, music, or sound effects. Other callers
  // retain the historical stop-and-reset behavior by omitting this option.
  const activePlayback = options.preservePlayback
    ? (actBoardPlaybackState
      || document.querySelector('.storyboard-act-board-selected-scene-playback-panel .storyboard-act-board-playback')
        ?._actBoardPlaybackState || null)
    : null;
  const playbackResume = activePlayback && (activePlayback.playing
    || Number(activePlayback.clockTime) > 0)
    ? {
      actKey: String(activePlayback.actKey || ''),
      sceneId: String(activePlayback.sceneId || ''),
      time: Math.max(0, Number(activePlayback.clockTime) || 0),
      playing: activePlayback.playing === true,
      audio: activePlayback.audio,
    } : null;
  const activeNativeAudio = options.preservePlayback
    ? actBoardNativeAudioElement : null;
  const nativeResume = activeNativeAudio && activeNativeAudio !== playbackResume?.audio
    && !activeNativeAudio.paused
    ? {
      currentTime: Math.max(0, Number(activeNativeAudio.currentTime) || 0),
      src: String(activeNativeAudio.currentSrc || activeNativeAudio.src || ''),
      className: String(activeNativeAudio.className || ''),
    } : null;
  // The Space-bar transport used by Timeline + Scenes is a Web Audio mix,
  // separate from the Act Board playback state above. `renderMovieEditor`
  // rebuilds that layout and normally stops it, so carry its current scene
  // time across a generation-only rerender as well.
  const sfxResume = options.preservePlayback && sfxPreviewEnabled && activeSfxLayout
    ? {
      time: Math.max(0, sfxPreviewAnchorTimelineTime
        + ((playbackAudioCtx?.currentTime || sfxPreviewAnchorCtxTime)
          - sfxPreviewAnchorCtxTime)),
      sectionIndex: activeSfxSectionIndex,
    } : null;
  stopActBoardPlayback();
  stopActBoardNativeAudio();
  // Keep the selected node stable across data-driven rerenders. Entity
  // deletion rebuilds the whole Act Board; without remembering this card, the
  // initial-node bootstrap in buildActBoardView selects the first narration
  // node and makes the panel appear to jump to a different narration.
  const selectedCard = document.querySelector(
    '.storyboard-act-board-node.storyboard-act-board-node--focused[data-node-id]',
  );
  const selectedPanel = document.querySelector('.storyboard-act-board-full-playback-panel');
  const selectedNodeId = selectedPanel?.dataset.selectedNodeId
    || actBoardSelectedNodeId || selectedCard?.dataset.nodeId || '';
  const selectedActKey = selectedPanel?.dataset.selectedActKey
    || actBoardSelectedNodeActKey
    || selectedCard?.closest('.storyboard-act-board-column')?.dataset.actKey || '';
  const renderState = captureStoryboardRenderState(resultsEl);
  teardownActBoardView(resultsEl?.querySelector('.storyboard-act-board-view'));
  const remaining = currentSections.filter(section => !section.removed);
  renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
  restoreStoryboardRenderState(renderState, resultsEl);
  if (selectedNodeId) {
    const board = resultsEl?.querySelector('.storyboard-act-board-view');
    const nextCard = board
      ? Array.from(board.querySelectorAll('.storyboard-act-board-node[data-node-id]'))
        .find(card => card.dataset.nodeId === selectedNodeId)
      : null;
    const nextActKey = nextCard?.closest('.storyboard-act-board-column')?.dataset.actKey
      || selectedActKey;
    const nextNode = nextActKey
      ? actBoardNodesForAct(nextActKey).find(node => node.id === selectedNodeId)
      : null;
    const nextAct = currentArcSections.find(act => act.key === nextActKey) || null;
    // Narration and some audio entries are track-only and therefore do not
    // have a visible canvas card. showNodeDetails can create their hidden live
    // content host, so restore the panel for either a visible or track-only
    // selection after rerender.
    if (nextNode && nextAct) {
      board._actBoardFullPlaybackPanel?._actBoardFullPlayback
        ?.showNodeDetails?.(nextActKey, nextAct, nextNode);
      const nextLayer = nextCard?.closest('.storyboard-act-board-node-stack');
      if (nextLayer) focusActBoardNode(nextLayer, nextCard, nextNode);
    }
  }
  if (!playbackResume && !nativeResume && !sfxResume) return;
  const resume = () => {
    if (playbackResume) {
      const playbackPanels = Array.from(
        resultsEl?.querySelectorAll('.storyboard-act-board-playback') || [],
      );
      const matchingPanel = playbackPanels.find(panel => {
        const state = panel._actBoardPlaybackState;
        if (!state || String(state.actKey || '') !== playbackResume.actKey) return false;
        return !playbackResume.sceneId || String(state.sceneId || '') === playbackResume.sceneId;
      }) || playbackPanels.find(panel => {
        const state = panel._actBoardPlaybackState;
        return state && String(state.actKey || '') === playbackResume.actKey;
      });
      const nextState = matchingPanel?._actBoardPlaybackState;
      if (nextState) {
        nextState.seekPlaybackProgress?.(playbackResume.time);
        if (playbackResume.playing && !nextState.playing) {
          nextState.playButton?.click();
        }
        return;
      }
    }
    if (sfxResume && activeSfxLayout) {
      activeSfxSectionIndex = sfxResume.sectionIndex;
      sfxPreviewEnabled = true;
      startSfxPreviewAt(sfxResume.time);
      return;
    }
    if (nativeResume) {
      const candidates = Array.from(resultsEl?.querySelectorAll('audio') || []);
      const replacement = candidates.find(audio => {
        const classMatches = !nativeResume.className
          || String(audio.className || '') === nativeResume.className;
        const source = String(audio.currentSrc || audio.src || '');
        return classMatches && (!nativeResume.src || source === nativeResume.src);
      }) || candidates.find(audio => String(audio.className || '') === nativeResume.className);
      if (!replacement) return;
      try { replacement.currentTime = nativeResume.currentTime; } catch (err) { /* metadata race */ }
      replacement.play?.().catch?.(() => {});
    }
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(resume));
  } else {
    setTimeout(resume, 0);
  }
}

function actBoardAssetSectionIndex(node) {
  // The stock-download endpoint keeps its historical integer section_index
  // field; hash the node id into a stable positive integer for per-node files.
  let hash = 2166136261;
  for (const char of String(node?.id || 'act-board-footage')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) || 1;
}

function actBoardVisualIdentity(visual) {
  return String(visual?.id || visual?.video_url || visual?.url || '').trim();
}

// A Visualize pass may discover another narration phrase, but it must not
// turn an existing footage card that already has a presenter-selected visual
// back into a fresh search/upload prompt. Treat a keyed gallery visual as a
// selection even when its local preview has not finished downloading yet.
function actBoardFootageNodeHasSelectedVisual(node) {
  if (!node) return false;
  const key = String(node.selectedVisualKey || '');
  if (key === 'upload' || key === 'split-screen') {
    return Boolean(node.mediaUrl || node.mediaThumbnailUrl
      || (key === 'split-screen' && (node.splitScreenNodeIds || []).length));
  }
  if (key.startsWith('generated-')) {
    const index = Number(key.slice('generated-'.length));
    return Number.isInteger(index) && Boolean(node.generatedOptions?.[index]);
  }
  if (key.startsWith('result-')) {
    const index = Number(key.slice('result-'.length));
    return Number.isInteger(index) && Boolean(node.results?.[index]);
  }
  return Boolean(node.mediaUrl || node.mediaThumbnailUrl);
}

function mergePinnedActBoardVisuals(existing, fresh) {
  const pinned = (Array.isArray(existing) ? existing : []).filter(item => item && item.pinned);
  const pinnedIds = new Set(pinned.map(actBoardVisualIdentity).filter(Boolean));
  const additions = (Array.isArray(fresh) ? fresh : []).filter(item => {
    const identity = actBoardVisualIdentity(item);
    return !identity || !pinnedIds.has(identity);
  });
  return [...pinned, ...additions];
}

// The shared /media/search_video route returns provider batches in a stable
// order so Timeline + Scenes can show every result. Act-board rails are capped
// at ten thumbnails, so taking the first ten would often hide the later
// providers entirely. Round-robin the batches here to keep the same provider
// variety in the smaller act-board result set.
// Suggested stock footage keeps one shape. A clip counts as portrait when its
// known dimensions (from the provider, or measured from its thumbnail once
// drawn) are not clearly wider than tall; it is then dropped from the results
// and skipped by the automatic pick.
const ACT_BOARD_STOCK_MIN_ASPECT = 1.2;
function actBoardResultIsPortrait(result) {
  if (!result) return false;
  if (result.portrait === true) return true;
  const width = Number(result.width) || 0;
  const height = Number(result.height) || 0;
  return width > 0 && height > 0 && width < height * ACT_BOARD_STOCK_MIN_ASPECT;
}

function diversifyActBoardVideoResults(videos, limit = 10) {
  const groups = new Map();
  (Array.isArray(videos) ? videos : []).forEach(video => {
    if (!video) return;
    const source = String(video.source || 'Other').trim() || 'Other';
    if (!groups.has(source)) groups.set(source, []);
    groups.get(source).push(video);
  });
  const results = [];
  while (results.length < limit && groups.size) {
    for (const [source, group] of groups) {
      const video = group.shift();
      if (video) results.push(video);
      if (!group.length) groups.delete(source);
      if (results.length >= limit) break;
    }
  }
  return results;
}

function pinActBoardVisual(node, option) {
  if (!node || !option) return;
  const collection = option.generatedIndex != null ? node.generatedOptions : node.results;
  const index = option.generatedIndex != null ? option.generatedIndex : option.resultIndex;
  const visual = Array.isArray(collection) ? collection[index] : null;
  if (!visual) return;
  visual.pinned = !visual.pinned;
  saveDebugSession();
  rerenderActBoard();
}

async function findActBoardFootageNode(
  actKey,
  act,
  narrationNode,
  footageNode,
  shouldRerender = true,
  generateExamplesAfterSearch = false,
  requestToken = null,
) {
  if (!act || !footageNode) return;
  const requestTokenValue = requestToken && typeof requestToken === 'object'
    ? requestToken.token : requestToken;
  const requestSignalOverride = requestToken && typeof requestToken === 'object'
    ? requestToken.signal : null;
  let directController = null;
  if (!requestTokenValue) {
    footageNode._footageSearchAbortController?.abort?.();
    directController = typeof AbortController === 'function' ? new AbortController() : null;
    try {
      Object.defineProperty(footageNode, '_footageSearchAbortController', {
        value: directController, configurable: true, writable: true, enumerable: false,
      });
    } catch (error) {
      footageNode._footageSearchAbortController = directController;
    }
  }
  if (!requestTokenValue && narrationNode?._footageSuggestionAbortController) {
    // A direct Find footage action supersedes any background suggestion pass.
    narrationNode._footageSuggestionAbortController.abort();
    narrationNode._footageSuggestionAbortController = null;
  }
  const requestIsCurrent = () => !requestTokenValue
    || footageNode.footageRequestToken === requestTokenValue;
  const requestSignal = requestTokenValue
    ? (requestSignalOverride || narrationNode?._footageSuggestionAbortController?.signal)
    : directController?.signal;
  const notifyMediaUpdate = () => {
    if (!shouldRerender) refreshActBoardFootageLoadingDom(footageNode);
  };
  if (requestTokenValue) {
    Object.defineProperty(footageNode, 'footageRequestToken', {
      value: requestTokenValue, writable: true, configurable: true, enumerable: false,
    });
  } else if (Object.prototype.hasOwnProperty.call(footageNode, 'footageRequestToken')) {
    // A direct Find footage action is itself the newest request for this
    // card, so invalidate any older Suggest footage pass.
    delete footageNode.footageRequestToken;
  }
  const narrationText = String(narrationNode?.transcript || narrationNode?.text || '').trim();
  footageNode.status = 'generating';
  footageNode.error = '';
  if (shouldRerender) {
    saveDebugSession();
    rerenderActBoard();
  }
  let backgroundImagePromise = null;
  try {
    const explicitQuery = normalizeActBoardFootagePhrase(
      footageNode.manualQuery && footageNode.query
        ? footageNode.query : (footageNode.filmabilityQuery || footageNode.query),
    );
    const result = explicitQuery
      ? { video_query: explicitQuery }
      : await fetchMediaQueries({
        highlight: footageNode.fragment,
        narration: narrationText,
        documentary_mode: actBoardDocumentaryModeForNode(actKey, footageNode),
        abstract: findAbstractText(),
      }, requestSignal);
    if (!requestIsCurrent()) return;
    footageNode.query = normalizeActBoardFootagePhrase(
      result.video_query || footageNode.fragment,
    );
    if (generateExamplesAfterSearch && ACT_BOARD_AUTO_GENERATE_FOOTAGE_IMAGES && requestIsCurrent()) {
      // AI image generation only needs the narration/phrase context, so it
      // can start as soon as the filmability query is known instead of
      // waiting for the stock provider response.
      backgroundImagePromise = generateActBoardNodeExamples(
        actKey, act, footageNode, ACT_BOARD_SUGGESTED_FOOTAGE_IMAGE_SAMPLE_COUNT,
        {
          rerender: false,
          persist: false,
          cache: true,
          suggestionToken: requestTokenValue,
          onUpdate: notifyMediaUpdate,
        },
      );
    }
    try {
      const minimumDuration = Math.max(1, Number(footageNode.durationSeconds) || 1);
      const cacheKey = `${footageNode.query.toLocaleLowerCase()}|${minimumDuration.toFixed(2)}`;
      let options = actBoardFootageSearchCache.get(cacheKey)
        || readActBoardPersistentCache('footage', cacheKey);
      // Searching again refreshes the gallery, but it must not silently turn a
      // presenter's selected visual back into the upload prompt. Keep the
      // selected visual's stable identity and playback fields before replacing
      // the unpinned result list below. This matters for both stock results and
      // generated/uploaded visuals selected in the same footage node.
      const previousSelectedKey = String(footageNode.selectedVisualKey || '');
      const previousResultIndex = previousSelectedKey.startsWith('result-')
        ? Number(previousSelectedKey.slice('result-'.length))
        : Number(footageNode.selectedResultIndex);
      const previousGeneratedIndex = previousSelectedKey.startsWith('generated-')
        ? Number(previousSelectedKey.slice('generated-'.length))
        : Number(footageNode.selectedGeneratedIndex);
      const previousSelectedResult = Number.isInteger(previousResultIndex)
        ? footageNode.results?.[previousResultIndex] : null;
      const previousSelectedGenerated = Number.isInteger(previousGeneratedIndex)
        ? footageNode.generatedOptions?.[previousGeneratedIndex] : null;
      const previousSelectedVisual = previousSelectedKey.startsWith('result-')
        ? previousSelectedResult
        : previousSelectedKey.startsWith('generated-')
          ? previousSelectedGenerated
          : null;
      const previousMedia = {
        mediaUrl: footageNode.mediaUrl || '',
        mediaThumbnailUrl: footageNode.mediaThumbnailUrl || '',
        mediaKind: footageNode.mediaKind || '',
        mediaOrigin: footageNode.mediaOrigin || '',
        sourceDurationSeconds: Number(footageNode.sourceDurationSeconds) || 0,
        trimStartSeconds: Number(footageNode.trimStartSeconds) || 0,
      };
      if (!options) {
        options = await fetchVideoOptions(footageNode.query, minimumDuration, requestSignal);
        if (!requestIsCurrent()) return;
        if (actBoardFootageSearchCache.size >= 128) {
          actBoardFootageSearchCache.delete(actBoardFootageSearchCache.keys().next().value);
        }
        actBoardFootageSearchCache.set(cacheKey, options);
        writeActBoardPersistentCache('footage', cacheKey, options);
      }
      if (!requestIsCurrent()) return;
      // Only landscape clips: the stage is 16:9 and a tall clip sat as a
      // pillar between wide ones. Providers that report dimensions are
      // filtered here; the rest are measured from their thumbnail as the
      // gallery draws them (see actBoardResultIsPortrait).
      const freshResults = diversifyActBoardVideoResults(
        (Array.isArray(options.videos) ? options.videos : []).filter(video => !actBoardResultIsPortrait(video)), 10,
      ).map(video => ({
        id: video.id || '',
        video_url: video.video_url,
        thumbnail_url: video.thumbnail_url || '',
        source_url: video.source_url || '',
        source: video.source || '',
        width: Number(video.width) || 0,
        height: Number(video.height) || 0,
        duration_seconds: Number(video.duration_seconds || video.duration) || 0,
      }));
      footageNode.results = mergePinnedActBoardVisuals(footageNode.results, freshResults);
      // mergePinnedActBoardVisuals intentionally discards unpinned old search
      // results. Reinsert the currently selected one if it was unpinned so a
      // repeat Visualize/search operation preserves the user's chosen clip.
      const previousIdentity = actBoardVisualIdentity(previousSelectedVisual);
      if (previousSelectedResult && previousIdentity
        && !footageNode.results.some(item => actBoardVisualIdentity(item) === previousIdentity)) {
        footageNode.results.unshift(previousSelectedResult);
      }
      const preservedSelected = previousIdentity
        ? footageNode.results.findIndex(item => actBoardVisualIdentity(item) === previousIdentity)
        : -1;
      const first = footageNode.results[0];
      if (preservedSelected >= 0) {
        const selected = footageNode.results[preservedSelected];
        footageNode.selectedVisualKey = `result-${preservedSelected}`;
        footageNode.selectedResultIndex = preservedSelected;
        footageNode.mediaUrl = selected.localPreviewUrl || previousMedia.mediaUrl || '';
        footageNode.mediaThumbnailUrl = selected.thumbnail_url
          || previousMedia.mediaThumbnailUrl || '';
        footageNode.mediaKind = 'video';
        footageNode.mediaOrigin = 'suggested';
        footageNode.sourceDurationSeconds = Number(selected.duration_seconds || selected.duration)
          || previousMedia.sourceDurationSeconds || 0;
        footageNode.trimStartSeconds = previousMedia.trimStartSeconds;
      } else if (previousSelectedKey.startsWith('generated-') && previousSelectedGenerated) {
        // Image selections live in generatedOptions, which a stock search does
        // not replace. Restore the key and local preview fields explicitly so
        // the fallback branch below cannot clear the selected image.
        const generatedIndex = footageNode.generatedOptions.findIndex(option =>
          actBoardVisualIdentity(option) === actBoardVisualIdentity(previousSelectedGenerated));
        if (generatedIndex >= 0) {
          footageNode.selectedVisualKey = `generated-${generatedIndex}`;
          footageNode.selectedGeneratedIndex = generatedIndex;
          footageNode.mediaUrl = previousMedia.mediaUrl || previousSelectedGenerated.url || '';
          footageNode.mediaThumbnailUrl = previousMedia.mediaThumbnailUrl
            || previousSelectedGenerated.thumbnail_url || previousSelectedGenerated.url || '';
          footageNode.mediaKind = previousMedia.mediaKind || previousSelectedGenerated.kind || 'image';
          footageNode.mediaOrigin = previousMedia.mediaOrigin || 'generated';
          footageNode.sourceDurationSeconds = previousMedia.sourceDurationSeconds
            || Number(previousSelectedGenerated.duration_seconds || previousSelectedGenerated.duration) || 0;
          footageNode.trimStartSeconds = previousMedia.trimStartSeconds;
        }
      } else if (previousSelectedKey === 'upload' && (previousMedia.mediaUrl || previousMedia.mediaThumbnailUrl)) {
        // A user upload is independent of the search results and should remain
        // selected while the presenter looks for alternative stock footage.
        footageNode.selectedVisualKey = 'upload';
        footageNode.mediaUrl = previousMedia.mediaUrl;
        footageNode.mediaThumbnailUrl = previousMedia.mediaThumbnailUrl;
        footageNode.mediaKind = previousMedia.mediaKind;
        footageNode.mediaOrigin = previousMedia.mediaOrigin || 'upload';
        footageNode.sourceDurationSeconds = previousMedia.sourceDurationSeconds;
        footageNode.trimStartSeconds = previousMedia.trimStartSeconds;
      } else if ((previousMedia.mediaUrl || previousMedia.mediaThumbnailUrl)
        && previousSelectedKey) {
        // Older persisted cards can retain playable media while their gallery
        // key is stale after a provider refresh. Keep that media visible
        // instead of falling back to the empty upload prompt.
        footageNode.selectedVisualKey = 'upload';
        footageNode.mediaUrl = previousMedia.mediaUrl;
        footageNode.mediaThumbnailUrl = previousMedia.mediaThumbnailUrl;
        footageNode.mediaKind = previousMedia.mediaKind;
        footageNode.mediaOrigin = previousMedia.mediaOrigin || 'upload';
        footageNode.sourceDurationSeconds = previousMedia.sourceDurationSeconds;
        footageNode.trimStartSeconds = previousMedia.trimStartSeconds;
      } else {
        if (first) {
          // Keep the upload prompt selected until a result is explicitly
          // picked. A remote CDN URL is not stable enough to use as the
          // default playback or export source; the selected result is
          // downloaded and remuxed below.
          footageNode.mediaUrl = '';
          footageNode.mediaThumbnailUrl = '';
          footageNode.mediaKind = '';
          footageNode.mediaOrigin = '';
          footageNode.selectedVisualKey = null;
          footageNode.selectedResultIndex = 0;
        }
      }
    } catch (err) {
      if (err?.name === 'AbortError') return;
      if (!requestIsCurrent()) return;
      footageNode.error = `Search unavailable: ${err.message}`;
    }
    if (!requestIsCurrent()) return;
    footageNode.status = 'ready';
    notifyMediaUpdate();
  } catch (err) {
    if (err?.name === 'AbortError') return;
    if (!requestIsCurrent()) return;
    footageNode.query = footageNode.query || footageNode.fragment;
    footageNode.status = 'ready';
    footageNode.error = err.message;
  }
  if (!requestIsCurrent()) return;
  saveDebugSession();
  if (shouldRerender) rerenderActBoard();
  if (backgroundImagePromise && requestIsCurrent()) await backgroundImagePromise;
}

// Identity of a media search: WHAT is being looked for, never WHEN it plays.
// Timing used to be part of this hash, so any retiming - and Smart arrange now
// runs automatically after Visualize - made the next Visualize see a "new"
// input for every card, abort its in-flight search and start it again. The
// rapid-repeat stress simulation caught it as 10 stock searches for 5 cards.
function actBoardFootageMediaInputHash(actKey, narrationNode, footageNode) {
  return JSON.stringify({
    phrase: footageNode?.fragment || '',
    query: footageNode?.filmabilityQuery || footageNode?.query || '',
    narration: actBoardNarrationSourceText(narrationNode),
    documentaryMode: actBoardDocumentaryModeForNode(actKey, footageNode),
  });
}

// Start stock search and AI-image generation for one footage card without
// making the scene batch wait for this card or allowing another card to cancel
// it. A repeated request with the same inputs reuses the existing promise.
function startActBoardFootageMediaJob(actKey, act, narrationNode, footageNode) {
  if (!act || !narrationNode || !footageNode?.id) return null;
  const sceneId = footageNode.sceneId || narrationNode.sceneId || '';
  const jobKey = `${actKey}:${sceneId}:${footageNode.id}`;
  const isLive = () => actBoardNodesForAct(actKey).some(node => node === footageNode)
    && (!sceneId || actBoardScenesForAct(actKey).some(scene => scene?.id === sceneId));
  const inputHash = actBoardFootageMediaInputHash(actKey, narrationNode, footageNode);
  const existing = actBoardFootageMediaJobs.get(jobKey);
  if (existing?.inputHash === inputHash) return existing.promise;
  existing?.controller?.abort?.();
  const imageJobKey = `${actKey}:${footageNode.id}:images`;
  actBoardGenerationAbortControllers.get(imageJobKey)?.controller?.abort?.();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const request = { token, signal: controller?.signal };
  Object.defineProperty(footageNode, 'footageRequestToken', {
    value: token, writable: true, configurable: true, enumerable: false,
  });
  footageNode.status = 'generating';
  footageNode.error = '';
  const promise = findActBoardFootageNode(
    actKey, act, narrationNode, footageNode, false, true, request,
  ).then(async () => {
    if (!isLive() || footageNode.footageRequestToken !== token) return false;
    if (!actBoardFootageNodeHasSelectedVisual(footageNode)) {
      await selectRandomActBoardFootageVisual(actKey, footageNode);
    }
    if (!isLive() || footageNode.footageRequestToken !== token) return false;
    saveDebugSession();
    scheduleActBoardSceneMediaPatch(actKey, sceneId);
    return true;
  }).catch(error => {
    if (error?.name === 'AbortError' || !isLive()
      || footageNode.footageRequestToken !== token) return false;
    footageNode.status = 'ready';
    footageNode.error = error.message || 'Media search failed.';
    saveDebugSession();
    scheduleActBoardSceneMediaPatch(actKey, sceneId);
    return false;
  }).finally(() => {
    if (actBoardFootageMediaJobs.get(jobKey)?.promise === promise) {
      actBoardFootageMediaJobs.delete(jobKey);
    }
  });
  actBoardFootageMediaJobs.set(jobKey, { inputHash, controller, token, promise });
  return promise;
}

function cancelActBoardFootageMediaJob(actKey, footageNodeId) {
  const prefix = `${actKey}:`;
  actBoardFootageMediaJobs.forEach((job, key) => {
    if (!key.startsWith(prefix) || !key.endsWith(`:${footageNodeId}`)) return;
    job.controller?.abort?.();
    actBoardFootageMediaJobs.delete(key);
  });
  actBoardGenerationAbortControllers.get(`${actKey}:${footageNodeId}:images`)
    ?.controller?.abort?.();
}

function scheduleActBoardSceneMediaPatch(actKey, sceneId) {
  const key = `${actKey}:${sceneId || ''}`;
  if (actBoardSceneMediaPatchTimers.has(key)) return;
  const timer = setTimeout(() => {
    actBoardSceneMediaPatchTimers.delete(key);
    queueActBoardScenePatch(actKey, sceneId, { persist: true });
  }, 80);
  actBoardSceneMediaPatchTimers.set(key, timer);
}

function actBoardSelectedPhraseInsertionIndex(sourceText, footageIds, nodes, phrase) {
  const source = String(sourceText || '').toLocaleLowerCase();
  const phraseStart = Number.isFinite(Number(phrase?.start))
    ? Number(phrase.start) : source.indexOf(String(phrase?.text || '').toLocaleLowerCase());
  if (!Number.isFinite(phraseStart) || phraseStart < 0) return footageIds.length;
  for (let index = 0; index < footageIds.length; index += 1) {
    const footage = nodes.find(node => node.id === footageIds[index]);
    const fragment = String(footage?.fragment || '').trim();
    const fragmentStart = fragment ? source.indexOf(fragment.toLocaleLowerCase()) : -1;
    if (fragmentStart >= 0 && fragmentStart > phraseStart) return index;
    // A node created from an earlier narration (for example, before a
    // rerecord) may not have a phrase in the current text.  Its old playback
    // timestamp is not a reliable insertion point and used to put new nodes
    // in the middle of an existing linked list.  Keep those legacy nodes in
    // their existing order and append the new phrase after them instead.
  }
  return footageIds.length;
}

// Return the phrases that are currently eligible for Visualize for one
// narration segment. This is deliberately side-effect free so a scene-wide
// Visualize click can collect every segment before mutating the board.
function collectActBoardVisualizePhrases(actKey, narrationNode, narrationText, smartSpans = []) {
  // Visualize is driven only by words that were actually recorded. Never
  // turn a suggested draft into filmable entities or footage nodes.
  const source = String(narrationNode?.transcript || '').trim();
  if (!narrationNode || !source) return [];
  const existingFootagePhrases = actBoardNodesForAct(actKey)
    .filter(node => node.type === 'footage' && node.narrationNodeId === narrationNode.id)
    .map(node => {
      const text = normalizeActBoardFootagePhrase(node.fragment);
      if (!text || text.toLocaleLowerCase() === 'new footage idea') return null;
      const sourceStart = source.toLocaleLowerCase().indexOf(text.toLocaleLowerCase());
      return {
        text,
        start: sourceStart >= 0 ? sourceStart : undefined,
        end: sourceStart >= 0 ? sourceStart + text.length : undefined,
        query: normalizeActBoardFootagePhrase(node.filmabilityQuery || node.query || text),
        bucket: node.filmabilityBucket || 'depictable',
        visual_proxy: node.filmabilityProxy || '',
      };
    })
    .filter(item => item && Number.isFinite(Number(item.start)) && Number(item.start) >= 0);
  const phraseOccursInCurrentNarration = item => {
    const text = normalizeActBoardFootagePhrase(item?.text || item?.fragment);
    if (!text) return false;
    const explicitStart = Number(item?.start);
    const normalizedText = source.toLocaleLowerCase();
    const normalizedPhrase = text.toLocaleLowerCase();
    if (Number.isFinite(explicitStart) && explicitStart >= 0) {
      const atOffset = normalizeActBoardFootagePhrase(
        source.slice(explicitStart, explicitStart + text.length),
      ).toLocaleLowerCase();
      if (atOffset === normalizedPhrase) return true;
    }
    return normalizedText.indexOf(normalizedPhrase) >= 0;
  };
  return [
    ...(Array.isArray(narrationNode.selectedFootagePhrases)
      ? narrationNode.selectedFootagePhrases : []),
    ...(Array.isArray(narrationNode.userFilmablePhrases)
      ? narrationNode.userFilmablePhrases : []),
    ...(Array.isArray(narrationNode.footageSuggestedPhrases)
      ? narrationNode.footageSuggestedPhrases : []),
    ...existingFootagePhrases,
    ...smartSpans.slice(0, 5),
  ].map(item => ({
    ...item,
    text: normalizeActBoardFootagePhrase(item?.text || item?.fragment),
  })).filter(item => item.text)
    .filter(phraseOccursInCurrentNarration)
    .filter((item, index, all) => all.findIndex(candidate =>
      actBoardNarrationSpanTextKey(candidate.text) === actBoardNarrationSpanTextKey(item.text)
      && Number(candidate.start) === Number(item.start)) === index)
    // A manually highlighted phrase is an explicit, specific choice. An
    // automatic clause candidate that merely contains it (most often the
    // entire narration, when a short recording has no punctuation left to
    // split into more than one clause) adds nothing over the manual pick and
    // would otherwise spawn a second, redundant "entire narration" footage
    // node right alongside it - see buildActBoardSuggestedNarrationText's
    // matching containment filter for the highlight-rendering side of this.
    .filter((item, index, all) => {
      const isManual = item.kind === 'user_selection' || item.origin === 'manual';
      if (isManual) return true;
      const start = Number(item.start);
      const end = Number(item.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return true;
      return !all.some((other, otherIndex) => {
        if (otherIndex === index) return false;
        const otherIsManual = other.kind === 'user_selection' || other.origin === 'manual';
        if (!otherIsManual) return false;
        const otherStart = Number(other.start);
        const otherEnd = Number(other.end);
        if (!Number.isFinite(otherStart) || !Number.isFinite(otherEnd)) return false;
        return start <= otherStart && end >= otherEnd && (start < otherStart || end > otherEnd);
      });
    });
}

async function suggestActBoardSelectedFootage(
  actKey, act, narrationNode, sourceText, selections, requestToken = null,
  options = {},
) {
  const requestIsCurrent = () => !requestToken
    || narrationNode.footageSuggestionInFlight === requestToken;
  const selected = (Array.isArray(selections) ? selections : [])
    .map(item => ({
      ...item,
      text: normalizeActBoardFootagePhrase(item?.text),
    }))
    .filter(item => item.text);
  if (!selected.length) return false;
  const nodes = actBoardNodesForAct(actKey);
  const parentScene = actBoardSceneForNode(actKey, narrationNode);
  const footageNodes = [];
  const newlyCreatedFootageNodes = [];
  const footageIds = Array.isArray(narrationNode.footageNodeIds)
    ? narrationNode.footageNodeIds.filter(id => nodes.some(node => node.id === id)) : [];
  // One documentary footage plan for the whole segment: the LLM decides each
  // beat's cut rhythm (one held shot vs a burst of quick cuts) and the concrete
  // on-topic query for every shot, grounded in the paper abstract (see backend
  // media_query_llm.plan_footage). This drives BOTH how many footage nodes a
  // beat gets and their queries. It degrades gracefully: if the plan is
  // unavailable (LLM down / no offsets), each beat falls back to the local
  // path below - one deferred-query shot plus local-subject alternates.
  const planByBeat = new Map();
  const planKeyFor = item => (Number.isFinite(Number(item?.start)) && Number.isFinite(Number(item?.end))
    ? `${Number(item.start)}:${Number(item.end)}` : '');
  {
    const planClauses = selected
      .filter(item => planKeyFor(item))
      .map(item => ({ text: item.text, start: Number(item.start), end: Number(item.end) }));
    if (planClauses.length) {
      try {
        const planResult = await fetchFootagePlan({
          clauses: planClauses,
          narration: String(narrationNode.transcript || narrationNode.text || '').trim(),
          documentaryMode: actBoardDocumentaryModeForNode(actKey, narrationNode),
          abstract: findAbstractText(),
        }, narrationNode._footageSuggestionAbortController?.signal);
        (planResult?.beats || []).forEach(beat => {
          const key = planKeyFor(beat);
          if (key) planByBeat.set(key, beat);
        });
      } catch (error) {
        if (error?.name === 'AbortError') return false;
        // Plan unavailable - every beat uses the local fallback below.
      }
    }
  }
  if (!requestIsCurrent()) return false;
  selected.forEach(phrase => {
    const clauseSeconds = actBoardClauseSpokenSeconds(narrationNode, phrase);
    const plan = planByBeat.get(planKeyFor(phrase));
    // How many quick cuts of a given floor length fit this beat's spoken window
    // (plus the trailing gap the last shot holds through). Montage cuts use a
    // shorter floor than held shots, so more of them fit.
    const shotsThatFit = floorSeconds => (Number.isFinite(clauseSeconds) && clauseSeconds > 0
      ? Math.max(1, Math.floor((clauseSeconds + ACT_BOARD_NARRATION_SEGMENT_GAP_SECONDS) / floorSeconds))
      : ACT_BOARD_CLAUSE_ALTERNATES_MAX);
    let rhythm;
    let alternateQueries;
    if (plan && Array.isArray(plan.video_queries) && plan.video_queries.length) {
      // Plan path: the LLM already produced real, on-topic queries and a
      // rhythm. A hold beat is one sustained shot; a montage beat is several
      // quick cuts (bounded by what actually fits its window at the montage
      // floor). Each query is used directly - no per-node fetchMediaQueries.
      rhythm = plan.rhythm === 'montage' ? 'montage' : 'hold';
      const cap = rhythm === 'montage'
        ? shotsThatFit(ACT_BOARD_MONTAGE_MIN_SHOT_SECONDS) : 1;
      const count = Math.max(1, Math.min(plan.video_queries.length, cap));
      alternateQueries = plan.video_queries.slice(0, count)
        .map(q => normalizeActBoardFootagePhrase(q));
    } else {
      // Local fallback (LLM plan unavailable): one held shot per beat, its
      // query deferred to findActBoardFootageNode's own fetchMediaQueries.
      // Rhythm is left unset so duration assignment uses the held-shot floor.
      // (Same-fragment shots now share one window - see the matcher - so
      // spawning several here would just subdivide the beat into cuts with no
      // rhythm intelligence behind it; one shot is the safe no-plan default.)
      rhythm = '';
      const firstQuery = normalizeActBoardFootagePhrase(phrase.query || phrase.visual_proxy);
      const phraseTextKey = normalizeActBoardFootagePhrase(phrase.text).toLocaleLowerCase();
      alternateQueries = [firstQuery && firstQuery.toLocaleLowerCase() !== phraseTextKey
        ? firstQuery : ''];
    }
    const sameBeatNodes = nodes.filter(node => node.type === 'footage'
      && node.narrationNodeId === narrationNode.id
      && actBoardNarrationSpanTextKey(node.fragment)
        === actBoardNarrationSpanTextKey(phrase.text));
    alternateQueries.forEach((query, alternateIndex) => {
    let footageNode = sameBeatNodes[alternateIndex] || null;
    if (!footageNode) {
      footageNode = {
        id: createActBoardNodeId('footage'),
        type: 'footage',
        actKey,
        narrationNodeId: narrationNode.id,
        sceneId: parentScene?.id || narrationNode.sceneId || null,
        fragment: phrase.text,
        query: '',
        // 'clause' beats end with their clause on the rail; a phrase beat
        // holds until the next beat as before.
        footageBeatKind: phrase.kind === 'clause' ? 'clause' : '',
        // 'hold' = one sustained shot across the beat; 'montage' = a quick cut
        // in a burst of shots (shorter floor). '' = unknown (local fallback);
        // duration assignment then uses the normal held-shot floor.
        footageRhythm: rhythm,
        filmabilityBucket: phrase.bucket || 'depictable',
        filmabilityQuery: query,
        filmabilityProxy: phrase.visual_proxy || '',
        results: [],
        generatedOptions: [],
        status: 'generating',
        videoGenerationTechniques: [...ACT_BOARD_DEFAULT_VIDEO_TECHNIQUES],
        error: '',
        durationSeconds: 1,
        trimStartSeconds: 0,
        sourceDurationSeconds: 0,
        durationWasSuggested: true,
        previousFootageNodeId: null,
        nextFootageNodeId: null,
        // Every shot for the clause goes on the rail; Smart arrange lays them
        // consecutively across the clause's spoken window (see the shared-range
        // split in applyActBoardFootageAlignment).
        trackHidden: false,
        footageAlternateIndex: alternateIndex,
      };
      bringNewActBoardNodeToFront(actKey, footageNode);
      nodes.push(footageNode);
      newlyCreatedFootageNodes.push(footageNode);
      const insertionIndex = actBoardSelectedPhraseInsertionIndex(
        sourceText, footageIds, nodes, phrase);
      footageIds.splice(insertionIndex, 0, footageNode.id);
      attachActBoardNodeToScene(actKey, footageNode);
    } else {
      footageNode.filmabilityQuery = query;
      footageNode.query = '';
      footageNode.manualQuery = false;
      footageNode.footageRhythm = rhythm;
      footageNode.filmabilityBucket = phrase.bucket || footageNode.filmabilityBucket || 'depictable';
      if (phrase.kind === 'clause') footageNode.footageBeatKind = 'clause';
      footageNode.filmabilityProxy = phrase.visual_proxy || footageNode.filmabilityProxy || '';
      // Keep a selected visual and its ready state intact while another
      // phrase is being added. The new phrase gets its own search; existing
      // cards should not flicker through a generating/upload state or lose
      // their selected media.
      if (!actBoardFootageNodeHasSelectedVisual(footageNode)) {
        footageNode.status = 'generating';
      } else if (footageNode.status === 'generating') {
        footageNode.status = 'ready';
      }
      footageNode.error = '';
      if (!footageIds.includes(footageNode.id)) footageIds.push(footageNode.id);
    }
    footageNodes.push(footageNode);
    });
  });
  narrationNode.footageNodeIds = footageIds;
  // Do not reflow the existing narration-footage chain here. Visualize is an
  // additive action: existing cards keep their saved canvas coordinates and
  // only the newly created cards are handed to the scene-lane placer below.
  newlyCreatedFootageNodes.forEach(node => {
    node.boardPositionMode = 'footage-section-auto';
  });
  syncActBoardLiveSceneSnapshots();
  narrationNode.footageFragments = footageIds
    .map(id => nodes.find(node => node.id === id)?.fragment || '')
    .filter(Boolean);
  if (narrationNode.transcript && sourceText === narrationNode.transcript) {
    alignActBoardNarrationFragments(narrationNode);
  } else {
    recomputeActBoardTiming(narrationNode);
  }
  narrationNode.footageStatus = `Finding footage for ${footageNodes.length} selected phrase${footageNodes.length === 1 ? '' : 's'}...`;
  narrationNode.footageSuggestedPhrases = [
    ...(Array.isArray(narrationNode.footageSuggestedPhrases)
      ? narrationNode.footageSuggestedPhrases : []),
    ...selected.map(item => ({
      text: item.text,
      start: item.start,
      end: item.end,
    })),
  ].filter((item, index, all) => all.findIndex(candidate =>
    String(candidate.text || '').toLocaleLowerCase() === String(item.text || '').toLocaleLowerCase()
      && Number(candidate.start) === Number(item.start)) === index);
  // Migrate the temporary click selection into the durable user phrase list
  // before clearing it. This keeps manually added phrases available if the
  // generated footage cards are later removed and footage is suggested again.
  narrationNode.userFilmablePhrases = [
    ...(Array.isArray(narrationNode.userFilmablePhrases)
      ? narrationNode.userFilmablePhrases : []),
    ...selected,
  ].filter((item, index, all) => all.findIndex(candidate =>
    String(candidate.text || '').toLocaleLowerCase() === String(item.text || '').toLocaleLowerCase()
      && Number(candidate.start) === Number(item.start)) === index);
  narrationNode.selectedFootagePhrases = [];
  if (!requestIsCurrent()) return false;
  const preserveFootageNodeIds = nodes
    .filter(node => node.type === 'footage'
      && node.narrationNodeId === narrationNode.id
      && !newlyCreatedFootageNodes.includes(node))
    .map(node => node.id);
  if (options.deferMedia) {
    if (options.persist !== false) saveDebugSession();
    if (options.patch !== false) {
      queueActBoardScenePatch(actKey, parentScene?.id || narrationNode.sceneId, {
        persist: options.persist !== false, preserveFootageNodeIds,
      });
    }
    return {
      narrationNode,
      footageNodes,
      newlyCreatedFootageNodes,
      footageNodesToSearch: footageNodes.filter(node =>
        newlyCreatedFootageNodes.includes(node) || !actBoardFootageNodeHasSelectedVisual(node)),
      preserveFootageNodeIds,
      parentScene,
    };
  }
  saveDebugSession();
  queueActBoardScenePatch(actKey, parentScene?.id || narrationNode.sceneId, {
    persist: true, preserveFootageNodeIds,
  });
  const footageNodesToSearch = footageNodes.filter(node =>
    newlyCreatedFootageNodes.includes(node) || !actBoardFootageNodeHasSelectedVisual(node));
  await Promise.all(footageNodesToSearch.map(node =>
    findActBoardFootageNode(actKey, act, narrationNode, node, false, true, requestToken)));
  if (!requestIsCurrent()) return false;
  // A newly highlighted phrase should open with a useful visual already
  // selected. Search/generation still populate the full galleries, then pick
  // one random stock result or generated image for each new card. Existing
  // cards keep the presenter's current selection untouched.
  await Promise.all(newlyCreatedFootageNodes.map(node =>
    selectRandomActBoardFootageVisual(actKey, node)));
  if (!requestIsCurrent()) return false;
  narrationNode.footageStatus = 'Selected phrase footage added to the linked sequence.';
  saveDebugSession();
  queueActBoardScenePatch(actKey, parentScene?.id || narrationNode.sceneId, {
    persist: true, preserveFootageNodeIds,
  });
  return true;
}

async function suggestActBoardFootageInternal(actKey, act, narrationNode, sourceText) {
  // A suggested narration draft is not an entity source. Footage can only be
  // visualized after this segment has a recorded transcript.
  if (!narrationNode || !String(narrationNode.transcript || '').trim()) return;
  narrationNode._footageSuggestionAbortController?.abort();
  const suggestionToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // This is a request lock, not session state. Keep it non-enumerable so a
  // refresh during a network request cannot restore a permanently disabled
  // Suggest footage button.
  Object.defineProperty(narrationNode, 'footageSuggestionInFlight', {
    value: suggestionToken, writable: true, configurable: true, enumerable: false,
  });
  const abortController = typeof AbortController === 'function' ? new AbortController() : null;
  Object.defineProperty(narrationNode, '_footageSuggestionAbortController', {
    value: abortController, writable: true, configurable: true, enumerable: false,
  });
  const clearSuggestionToken = () => {
    if (narrationNode.footageSuggestionInFlight === suggestionToken) {
      delete narrationNode.footageSuggestionInFlight;
      if (narrationNode._footageSuggestionAbortController === abortController) {
        narrationNode._footageSuggestionAbortController = null;
      }
    }
  };
  const requestIsCurrent = () => narrationNode.footageSuggestionInFlight === suggestionToken;
  // Once a recording exists, the node's current transcript is authoritative.
  // A stale sourceText supplied by a pre-recording render must never steer
  // Visualize back to the previous phrase set.
  const narrationText = String(narrationNode.transcript || '').trim();
  const analysisHash = actBoardNarrationTextHash(actBoardNarrationSourceText(narrationNode));
  const analysisPromise = requestActBoardNarrationAnalysis(narrationNode)
    || actBoardNarrationAnalysisPromises.get(`${narrationNode.id}:${analysisHash}`);
  if (analysisPromise) {
    try {
      await analysisPromise;
    } catch (error) {
      // Classification has a local fallback. Abort/stale responses are
      // discarded by requestIsCurrent below and should not block the click.
    }
    if (!requestIsCurrent()) {
      clearSuggestionToken();
      return;
    }
  }
  // A presenter-authored phrase is classified separately from the broad
  // transcript pass. If Visualize is clicked before that request completes,
  // wait for the current phrase result so the footage node receives the
  // filmability query rather than the raw highlighted text.
  await waitForActBoardManualFilmability(narrationNode);
  if (!requestIsCurrent()) {
    clearSuggestionToken();
    return;
  }
  // The awaited analysis may have replaced narrationSpans with the current
  // transcript's filmable candidates.
  const smartSpans = Array.isArray(narrationNode.narrationSpans)
    ? narrationNode.narrationSpans.filter(span => span
      && span.bucket !== 'ignore' && span.bucket !== 'pending'
      && !actBoardNarrationSpanExcluded(narrationNode, span))
    : [];
  actBoardNodesForAct(actKey)
    .filter(node => node.type === 'footage' && node.narrationNodeId === narrationNode.id)
    .forEach(footageNode => {
      Object.defineProperty(footageNode, 'footageRequestToken', {
        value: suggestionToken, writable: true, configurable: true, enumerable: false,
      });
    });
  // A selection is written to both the transient list (used by the current
  // click) and the durable user list (so it survives rerenders/deleting a
  // footage card). Merge both lists before the first search; otherwise a
  // rerender between two highlights could leave only the most recent phrase
  // in selectedFootagePhrases and silently drop the earlier one.
  // Older cards and current explicit/classified highlights are merged without
  // treating an old card as a reason to skip newly highlighted phrases.
  const selectedPhrases = collectActBoardVisualizePhrases(
    actKey, narrationNode, narrationText, smartSpans,
  );
  if (selectedPhrases.length) {
    try {
      await suggestActBoardSelectedFootage(
        actKey, act, narrationNode, narrationText, selectedPhrases, suggestionToken,
      );
    } finally {
      clearSuggestionToken();
    }
    return;
  }
  const fallbackFragments = actBoardNarrationFragments(narrationText)
    .map(fragment => stripActBoardNarrationExcludedPhrases(narrationNode, fragment))
    .filter(Boolean);
  // A phrase selected by the presenter is kept in footageSuggestedPhrases even
  // after its footage card is deleted. Include those current, still-present
  // phrases on the next Suggest footage click; otherwise the LLM spans would
  // win every time and a manually added entity would silently disappear from
  // the resuggestion input. Manual phrases get priority, then fill the five
  // visual beats with classified LLM spans.
  const currentTextKey = actBoardNarrationSpanTextKey(narrationText);
  const rememberedUserPhrases = [
    ...(Array.isArray(narrationNode.userFilmablePhrases)
      ? narrationNode.userFilmablePhrases : []),
    ...(Array.isArray(narrationNode.footageSuggestedPhrases)
      ? narrationNode.footageSuggestedPhrases : []),
  ];
  const manualFragments = rememberedUserPhrases
    .map(item => ({
      text: String(item?.text || item?.fragment || '').replace(/\s+/g, ' ').trim(),
      start: Number(item?.start),
    }))
    .filter(item => item.text
      && currentTextKey.includes(actBoardNarrationSpanTextKey(item.text))
      && !actBoardNarrationSpanExcluded(narrationNode, item));
  const llmFragments = smartSpans
    .map(span => ({ text: String(span.text || '').trim(), span }))
    .filter(item => item.text);
  const seenFragmentKeys = new Set();
  const mergedFilmableFragments = [...manualFragments, ...llmFragments]
    .filter(item => {
      const key = item.text.toLocaleLowerCase();
      if (!key || seenFragmentKeys.has(key)) return false;
      seenFragmentKeys.add(key);
      return true;
    })
    .map(item => item.text)
    .slice(0, 5);
  const fragments = mergedFilmableFragments.length
    ? mergedFilmableFragments
    // If the presenter removed every detected entity, keep the action useful
    // by treating the remaining narration as one broad visual beat. This also
    // covers short/irregular narration that the punctuation fallback cannot
    // split into three-word fragments.
    : (fallbackFragments.length
      ? fallbackFragments
      : (() => {
        const remainingNarration = stripActBoardNarrationExcludedPhrases(
          narrationNode, narrationText,
        );
        return remainingNarration ? [remainingNarration] : [];
      })());
  if (!fragments.length) {
    // No new filmable phrases is not a reason to delete the presenter’s
    // existing footage or links. Leave the current chain intact and report
    // that there was nothing additional to suggest.
    narrationNode.footageStatus = 'No new filmable narration fragments found';
    clearSuggestionToken();
    saveDebugSession();
    queueActBoardScenePatch(actKey, narrationNode.sceneId, { persist: true });
    return;
  }

  const nodes = actBoardNodesForAct(actKey);
  const parentScene = actBoardSceneForNode(actKey, narrationNode);
  // Reuse the existing narration-footage nodes wherever their phrase still
  // appears. Replacing the whole array here used to delete the nodes that
  // carried previous/next link fields, so clicking Suggest footage again
  // broke user-created chains. Keep unmatched old nodes too: they represent
  // user work and can remain available until explicitly removed.
  const oldIds = Array.isArray(narrationNode.footageNodeIds)
    ? narrationNode.footageNodeIds.filter(id => nodes.some(item => item.id === id)) : [];
  const oldFootage = oldIds
    .map(id => nodes.find(item => item.id === id))
    .filter(item => item && item.type === 'footage');
  // Invalidate searches from the previous click for every existing card,
  // including stale cards that are being kept on the board but are not part of
  // this narration's newly selected phrase set.
  oldFootage.forEach(footageNode => {
    Object.defineProperty(footageNode, 'footageRequestToken', {
      value: suggestionToken, writable: true, configurable: true, enumerable: false,
    });
  });
  const usedExisting = new Set();
  // Preserve the existing narration list order.  The rendered path uses this
  // list as its chain, so rebuilding it from the new transcript would make
  // existing links appear to jump even when their relationship fields were
  // untouched.  New phrases are inserted by the helper below; stale cards
  // from a rerecord remain where the presenter left them.
  const footageIds = oldIds.slice();
  const footageNodes = [];
  const newlyCreatedFootageNodes = [];
  fragments.forEach(fragment => {
    const smartSpan = smartSpans.find(span => span.text === fragment);
    const normalizedFragment = String(fragment || '').toLocaleLowerCase();
    let footageNode = oldFootage.find(item => !usedExisting.has(item.id)
      && String(item.fragment || '').trim().toLocaleLowerCase() === normalizedFragment);
    if (footageNode) {
      usedExisting.add(footageNode.id);
      footageNode.filmabilityBucket = smartSpan?.bucket || footageNode.filmabilityBucket || 'depictable';
      // No classifier proposes a query anymore (see requestActBoardNarrationAnalysis) -
      // leave filmabilityQuery as whatever it already was rather than fabricating
      // one from the raw fragment, which would short-circuit the real
      // stock-search query generation at search time (see suggestActBoardFootage's
      // explicitQuery check).
      footageNode.filmabilityQuery = smartSpan?.query || smartSpan?.visual_proxy
        || footageNode.filmabilityQuery || '';
      footageNode.filmabilityProxy = smartSpan?.visual_proxy || footageNode.filmabilityProxy || '';
      if (!actBoardFootageNodeHasSelectedVisual(footageNode)) {
        footageNode.status = 'generating';
      } else if (footageNode.status === 'generating') {
        footageNode.status = 'ready';
      }
      footageNode.error = '';
    } else {
      footageNode = {
        id: createActBoardNodeId('footage'),
        type: 'footage',
        actKey,
        narrationNodeId: narrationNode.id,
        sceneId: parentScene?.id || narrationNode.sceneId || null,
        fragment,
        query: '',
        results: [],
        status: 'generating',
        videoGenerationTechniques: [...ACT_BOARD_DEFAULT_VIDEO_TECHNIQUES],
        error: '',
        trimStartSeconds: 0,
        sourceDurationSeconds: 0,
        previousFootageNodeId: null,
        nextFootageNodeId: null,
        ...(smartSpan ? {
          filmabilityBucket: smartSpan.bucket,
          // Left unset rather than defaulting to the raw fragment - see the
          // matching comment on the existing-node branch above.
          filmabilityQuery: smartSpan.query || smartSpan.visual_proxy || '',
          filmabilityProxy: smartSpan.visual_proxy || '',
        } : {}),
      };
      nodes.push(footageNode);
      newlyCreatedFootageNodes.push(footageNode);
      const insertionIndex = actBoardSelectedPhraseInsertionIndex(
        narrationText, footageIds, nodes, { text: fragment });
      footageIds.splice(insertionIndex, 0, footageNode.id);
      attachActBoardNodeToScene(actKey, footageNode, parentScene);
    }
    if (!footageIds.includes(footageNode.id)) footageIds.push(footageNode.id);
    footageNodes.push(footageNode);
  });
  footageNodes.forEach(node => bringNewActBoardNodeToFront(actKey, node));
  // Keep the scene container's live membership and restore snapshot aligned
  // with the generated footage cards. Without this, the cards can render on
  // the live canvas but the framed scene only knows about the narration node.
  footageNodes.forEach(node => attachActBoardNodeToScene(actKey, node));
  narrationNode.footageNodeIds = footageIds;
  // Do not reflow the existing narration-footage chain here. Re-running
  // Visualize must not move cards the presenter already arranged; only the
  // newly created cards are marked for placement in the Footage lane.
  newlyCreatedFootageNodes.forEach(node => {
    node.boardPositionMode = 'footage-section-auto';
  });
  syncActBoardLiveSceneSnapshots();
  narrationNode.footageFragments = fragments;
  // Preserve the phrases that produced this automatic footage pass. Without
  // this record, selecting one new phrase later makes the next Visualize
  // request see only that new selection and silently drop the earlier
  // classifier-highlighted beats.
  const generatedPhraseRecords = fragments.map(fragment => {
    const smartSpan = smartSpans.find(span =>
      actBoardNarrationSpanTextKey(span.text) === actBoardNarrationSpanTextKey(fragment));
    return {
      text: normalizeActBoardFootagePhrase(fragment),
      ...(smartSpan ? {
        start: smartSpan.start,
        end: smartSpan.end,
        query: normalizeActBoardFootagePhrase(
          smartSpan.query || smartSpan.visual_proxy || fragment,
        ),
        bucket: smartSpan.bucket || 'depictable',
        visual_proxy: smartSpan.visual_proxy || '',
      } : {}),
    };
  }).filter(item => item.text);
  narrationNode.footageSuggestedPhrases = [
    ...(Array.isArray(narrationNode.footageSuggestedPhrases)
      ? narrationNode.footageSuggestedPhrases : []),
    ...generatedPhraseRecords,
  ].filter((item, index, all) => all.findIndex(candidate =>
    actBoardNarrationSpanTextKey(candidate.text || candidate.fragment)
      === actBoardNarrationSpanTextKey(item.text || item.fragment)
      && Number(candidate.start) === Number(item.start)) === index);
  if (narrationNode.transcript && narrationText === narrationNode.transcript) {
    alignActBoardNarrationFragments(narrationNode);
  } else {
    recomputeActBoardTiming(narrationNode);
  }
  narrationNode.footageStatus = `Finding footage for ${footageNodes.length} narration fragment${footageNodes.length === 1 ? '' : 's'}...`;
  const preserveFootageNodeIds = oldFootage
    .filter(node => !newlyCreatedFootageNodes.includes(node))
    .map(node => node.id);
  saveDebugSession();
  queueActBoardScenePatch(actKey, parentScene?.id || narrationNode.sceneId, {
    persist: true, preserveFootageNodeIds,
  });

  let wasCurrent = false;
  try {
    const footageNodesToSearch = footageNodes.filter(node =>
      newlyCreatedFootageNodes.includes(node) || !actBoardFootageNodeHasSelectedVisual(node));
    await Promise.all(footageNodesToSearch.map(node =>
      findActBoardFootageNode(
        actKey, act, narrationNode, node, false, true, suggestionToken,
      )));
    wasCurrent = requestIsCurrent();
    if (wasCurrent) {
      await Promise.all(newlyCreatedFootageNodes.map(node =>
        selectRandomActBoardFootageVisual(actKey, node)));
      wasCurrent = requestIsCurrent();
    }
  } finally {
    clearSuggestionToken();
  }
  if (!wasCurrent) return;
  narrationNode.footageStatus = '';
  saveDebugSession();
  queueActBoardScenePatch(actKey, parentScene?.id || narrationNode.sceneId, {
    persist: true, preserveFootageNodeIds,
  });
}

// Keep the Act Board covered while Visualize highlights creates its batch of
// footage nodes and finishes their stock/AI media assignment. The underlying
// operation still runs asynchronously; the veil only prevents interaction
// with a half-built batch and is removed in the finally block even on errors
// or cancelled/stale requests.
async function suggestActBoardFootage(actKey, act, narrationNode, sourceText, options = {}) {
  const manageLoading = options.manageLoading !== false;
  const scene = actBoardSceneForNode(actKey, narrationNode);
  if (manageLoading) {
    if (!setActBoardSceneLoading(actKey, scene?.id || narrationNode?.sceneId, true,
      'Analyzing narration and generating previews…')) {
      rerenderActBoard({ preservePlayback: true });
    }
  }
  try {
    return await suggestActBoardFootageInternal(actKey, act, narrationNode, sourceText);
  } finally {
    if (manageLoading) {
      setActBoardSceneLoading(actKey, scene?.id || narrationNode?.sceneId, false);
      queueActBoardScenePatch(actKey, scene?.id || narrationNode?.sceneId, { persist: true });
    }
  }
}

