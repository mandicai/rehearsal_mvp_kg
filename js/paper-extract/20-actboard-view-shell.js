// Right-side overview for the Act Board. This deliberately uses the same
// combined render plan as the MP4 export, so “Play all acts” includes every
// saved act-board sequence (narration-driven and footage-only) in arc order.
// The panel's two view switchers (Story outline / Media content, Scene play /
// Full play) share the narration slides' Edit / Highlight pill treatment. The
// pill wraps only the two choice buttons, so the collapse control that shares
// the scene/full row stays outside the bordered group.
function buildActBoardViewPill(...buttons) {
  const pill = document.createElement('span');
  pill.className = 'storyboard-act-board-view-pill';
  pill.append(...buttons);
  return pill;
}

function buildActBoardFullPlaybackPanel(board, exportActionGroup = null) {
  // Preserve the presenter's current panel view across lightweight board
  // rerenders. Recreating the panel used to silently jump back to Story
  // outline/Scene play even when the user was working in node content or Full
  // play, making the active button state appear to be lost.
  const previousPanelView = actBoardFullPlaybackView === 'node' ? 'node' : 'overview';
  const previousPlaybackView = actBoardSelectedPlaybackView === 'full' ? 'full' : 'scene';
  const panel = document.createElement('aside');
  panel.className = 'storyboard-act-board-full-playback-panel';

  const header = document.createElement('div');
  header.className = 'sidebar-module-header storyboard-act-board-full-playback-header';
  const viewToggle = document.createElement('div');
  viewToggle.className = 'storyboard-act-board-full-playback-view-toggle';
  const overviewViewButton = document.createElement('button');
  overviewViewButton.type = 'button';
  overviewViewButton.className = 'storyboard-act-board-full-playback-view-btn btn-primary';
  overviewViewButton.textContent = 'Story outline';
  overviewViewButton.dataset.view = 'overview';
  overviewViewButton.classList.add('selected');
  overviewViewButton.classList.add('active');
  overviewViewButton.setAttribute('aria-selected', 'true');
  overviewViewButton.setAttribute('aria-pressed', 'true');
  overviewViewButton.title = 'Show acts and scenes overview';
  const nodeViewButton = document.createElement('button');
  nodeViewButton.type = 'button';
  nodeViewButton.className = 'storyboard-act-board-full-playback-view-btn btn-primary';
  nodeViewButton.textContent = 'Media content';
  nodeViewButton.dataset.view = 'node';
  nodeViewButton.setAttribute('aria-selected', 'false');
  nodeViewButton.setAttribute('aria-pressed', 'false');
  nodeViewButton.title = 'Show selected media content';
  viewToggle.append(buildActBoardViewPill(overviewViewButton, nodeViewButton));
  const collapseButton = document.createElement('button');
  collapseButton.type = 'button';
  collapseButton.className = 'premiere-timeline-collapse-btn sidebar-module-collapse-btn';
  collapseButton.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    panel.classList.toggle('collapsed');
    actBoardFullPlaybackPanelCollapsed = panel.classList.contains('collapsed');
    const expanded = !panel.classList.contains('collapsed');
    collapseButton.setAttribute('aria-expanded', String(expanded));
    collapseButton.title = `${expanded ? 'Collapse' : 'Expand'} all acts playback`;
    collapseButton.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} all acts playback`);
  });
  // The view toggle identifies this panel; the redundant “All acts” heading
  // is intentionally omitted from the act-outline header.
  header.append(viewToggle, collapseButton);
  panel.appendChild(header);

  const body = document.createElement('div');
  body.className = 'storyboard-act-board-full-playback-body';
  const overviewView = document.createElement('div');
  overviewView.className = 'storyboard-act-board-full-playback-view storyboard-act-board-full-playback-view-overview';

  const outline = document.createElement('div');
  outline.className = 'storyboard-act-board-full-playback-outline';
  // const outlineHeading = document.createElement('strong');
  // outlineHeading.textContent = 'Acts and scenes';
  // outline.appendChild(outlineHeading);
  if (!currentArcSections.length) {
    const emptyActs = document.createElement('div');
    emptyActs.className = 'storyboard-act-board-full-playback-empty';
    emptyActs.textContent = 'No acts yet';
    outline.appendChild(emptyActs);
  }
  currentArcSections.forEach((act, actIndex) => {
    const actDetails = document.createElement('details');
    actDetails.className = 'storyboard-act-board-full-playback-act';
    actDetails.open = true;
    const actSummary = document.createElement('summary');
    actSummary.textContent = `Act ${actIndex + 1}: ${act.label || 'Untitled act'}`;
    actDetails.appendChild(actSummary);
    const scenes = actBoardScenesForAct(act.key);
    if (!scenes.length) {
      const empty = document.createElement('div');
      empty.className = 'storyboard-act-board-full-playback-empty';
      empty.textContent = 'No saved scenes yet';
      actDetails.appendChild(empty);
    } else {
      scenes.forEach((scene, sceneIndex) => {
        const sceneButton = document.createElement('button');
        sceneButton.type = 'button';
        sceneButton.className = 'storyboard-act-board-full-playback-scene';
        const sceneTitle = document.createElement('span');
        sceneTitle.textContent = scene.title || `Scene ${sceneIndex + 1}`;
        sceneButton.appendChild(sceneTitle);
        sceneTitle.title = 'Double-click to rename this scene';
        let sceneClickTimer = null;
        sceneTitle.addEventListener('dblclick', event => {
          event.preventDefault();
          event.stopPropagation();
          if (sceneClickTimer) {
            clearTimeout(sceneClickTimer);
            sceneClickTimer = null;
          }
          const prompt = typeof window !== 'undefined' && typeof window.prompt === 'function'
            ? window.prompt('Rename this scene:', scene.title || `Scene ${sceneIndex + 1}`) : null;
          if (prompt == null) return;
          const nextTitle = String(prompt).trim();
          if (!nextTitle) return;
          scene.title = nextTitle;
          saveDebugSession();
          rerenderActBoard();
        });
        sceneButton.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          if (event.detail > 1) return;
          if (sceneClickTimer) clearTimeout(sceneClickTimer);
          sceneClickTimer = setTimeout(() => {
            sceneClickTimer = null;
          // The outline is now the sole scene restore affordance. Loading a
          // different scene replaces the live canvas scene (including its
          // nodes and links) and rerenders the board; the current scene only
          // needs the usual scroll-to behavior.
          if (actBoardOpenSceneForAct(act.key)?.id !== scene.id) {
            restoreActBoardSceneToCanvas(scene);
            scrollActBoardToScene(scene);
            return;
          }
          scrollActBoardToScene(scene);
          }, 250);
        });
        actDetails.appendChild(sceneButton);
      });
    }
    outline.appendChild(actDetails);
  });
  overviewView.appendChild(outline);

  const nodeDetails = document.createElement('section');
  nodeDetails.className = 'storyboard-act-board-full-playback-node-details';
  const nodeDetailsHeading = document.createElement('h3');
  nodeDetailsHeading.textContent = 'Selected node';
  nodeDetails.appendChild(nodeDetailsHeading);
  const nodeDetailsContent = document.createElement('div');
  nodeDetailsContent.className = 'storyboard-act-board-full-playback-node-details-content';
  const nodeDetailsEmpty = document.createElement('p');
  nodeDetailsEmpty.className = 'storyboard-act-board-full-playback-node-detail-empty';
  nodeDetailsEmpty.textContent = 'Click on scene content to inspect its details here.';
  nodeDetailsContent.appendChild(nodeDetailsEmpty);
  nodeDetails.appendChild(nodeDetailsContent);
  body.appendChild(nodeDetails);

  // Keep a dedicated scene playback surface beneath the selected node's live
  // controls. It is intentionally separate from the all-acts renderer above:
  // selecting a node should always make this player represent that node's
  // containing scene, even when the node itself is narration, footage, or
  // sound.
  const selectedScenePlayback = document.createElement('section');
  selectedScenePlayback.className = 'storyboard-act-board-selected-scene-playback-panel';
  selectedScenePlayback.hidden = true;
  const selectedPlaybackViewToggle = document.createElement('div');
  selectedPlaybackViewToggle.className = 'storyboard-act-board-full-playback-view-toggle storyboard-act-board-selected-playback-view-toggle';
  const scenePlaybackViewButton = document.createElement('button');
  scenePlaybackViewButton.type = 'button';
  scenePlaybackViewButton.className = 'storyboard-act-board-full-playback-view-btn btn-primary';
  scenePlaybackViewButton.textContent = 'Scene play';
  scenePlaybackViewButton.dataset.view = 'scene';
  scenePlaybackViewButton.classList.add('selected');
  scenePlaybackViewButton.classList.add('active');
  scenePlaybackViewButton.setAttribute('aria-selected', 'true');
  scenePlaybackViewButton.setAttribute('aria-pressed', 'true');
  scenePlaybackViewButton.title = 'Play the currently selected scene';
  const fullPlaybackViewButton = document.createElement('button');
  fullPlaybackViewButton.type = 'button';
  fullPlaybackViewButton.className = 'storyboard-act-board-full-playback-view-btn btn-primary';
  fullPlaybackViewButton.textContent = 'Full play';
  fullPlaybackViewButton.dataset.view = 'full';
  fullPlaybackViewButton.setAttribute('aria-selected', 'false');
  fullPlaybackViewButton.setAttribute('aria-pressed', 'false');
  fullPlaybackViewButton.title = 'Play the complete documentary playback';
  selectedPlaybackViewToggle.append(buildActBoardViewPill(scenePlaybackViewButton, fullPlaybackViewButton));
  const selectedPlaybackCollapseButton = document.createElement('button');
  selectedPlaybackCollapseButton.type = 'button';
  selectedPlaybackCollapseButton.className = 'premiere-timeline-collapse-btn sidebar-module-collapse-btn storyboard-act-board-selected-playback-collapse-btn';
  selectedPlaybackCollapseButton.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    actBoardSelectedScenePlaybackPanelCollapsed = !actBoardSelectedScenePlaybackPanelCollapsed;
    selectedScenePlayback.classList.toggle(
      'collapsed', actBoardSelectedScenePlaybackPanelCollapsed,
    );
    const expanded = !actBoardSelectedScenePlaybackPanelCollapsed;
    selectedPlaybackCollapseButton.setAttribute('aria-expanded', String(expanded));
    selectedPlaybackCollapseButton.title = `${expanded ? 'Collapse' : 'Expand'} scene playback`;
    selectedPlaybackCollapseButton.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} scene playback`);
  });
  selectedPlaybackViewToggle.appendChild(selectedPlaybackCollapseButton);
  selectedScenePlayback.appendChild(selectedPlaybackViewToggle);
  const selectedScenePlaybackMount = document.createElement('div');
  selectedScenePlaybackMount.className = 'storyboard-act-board-selected-scene-playback-mount';
  selectedScenePlayback.appendChild(selectedScenePlaybackMount);

  const playback = document.createElement('div');
  playback.className = 'storyboard-act-board-full-playback-player';
  const video = document.createElement('video');
  video.controls = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.hidden = true;
  video.setAttribute('aria-label', 'Playback of all Act Board sequences');
  playback.appendChild(video);
  // const emptyStage = document.createElement('div');
  // emptyStage.className = 'storyboard-act-board-full-playback-stage';
  // emptyStage.textContent = 'Build a full playback to review all acts and scenes in sequence.';
  // playback.appendChild(emptyStage);
  const actions = document.createElement('div');
  actions.className = 'storyboard-act-board-full-playback-actions';
  const playAllButton = document.createElement('button');
  playAllButton.type = 'button';
  playAllButton.className = 'btn-primary storyboard-act-board-full-playback-btn';
  playAllButton.textContent = 'Build full playback';
  const initialPlaybackPlan = buildActBoardRenderPlan();
  playAllButton.disabled = initialPlaybackPlan.sequences.length === 0;
  if (playAllButton.disabled) {
    playAllButton.title = 'Add linked footage to an Act Board scene before building playback';
  }
  playAllButton.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    runActBoardFullPlaybackRender();
  });
  actions.appendChild(playAllButton);
  playback.appendChild(actions);
  const status = document.createElement('div');
  status.className = 'status-line storyboard-act-board-full-playback-status';
  playback.appendChild(status);
  const exportButton = exportActionGroup?.querySelector('.render-movie-btn') || null;
  const exportStatus = exportActionGroup?.querySelector('.render-movie-status') || null;
  const exportDownload = exportActionGroup?.querySelector('.render-movie-download') || null;

  const setSelectedPlaybackView = view => {
    const showingFull = view === 'full';
    actBoardSelectedPlaybackView = showingFull ? 'full' : 'scene';
    selectedScenePlaybackMount.hidden = showingFull;
    playback.hidden = !showingFull;
    scenePlaybackViewButton.classList.toggle('selected', !showingFull);
    fullPlaybackViewButton.classList.toggle('selected', showingFull);
    scenePlaybackViewButton.classList.toggle('active', !showingFull);
    fullPlaybackViewButton.classList.toggle('active', showingFull);
    scenePlaybackViewButton.setAttribute('aria-selected', String(!showingFull));
    fullPlaybackViewButton.setAttribute('aria-selected', String(showingFull));
    scenePlaybackViewButton.setAttribute('aria-pressed', String(!showingFull));
    fullPlaybackViewButton.setAttribute('aria-pressed', String(showingFull));
  };
  selectedScenePlayback._actBoardSetView = setSelectedPlaybackView;
  // A rebuilt panel starts on Scene play; put it back on the view the
  // presenter had chosen so a patch or rerender does not flip Full play off.
  setSelectedPlaybackView(actBoardSelectedPlaybackView);
  scenePlaybackViewButton.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedPlaybackView('scene');
  });
  fullPlaybackViewButton.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedPlaybackView('full');
  });

  // Timeline + Scenes owns the export wrapper, but while the Act Board is
  // active its controls live directly under the full-playback transport. The
  // status element is shared so MP4/Premiere progress and background playback
  // progress appear in one place.
  const mountExportControls = () => {
    if (!exportActionGroup) return;
    exportButton?.remove();
    exportStatus?.remove();
    exportDownload?.remove();
    if (exportButton) actions.appendChild(exportButton);
    if (exportDownload) playback.appendChild(exportDownload);
    renderMovieStatusEl = status;
    renderMovieDownloadEl = exportDownload;
  };
  const restoreExportControls = () => {
    if (!exportActionGroup) return;
    if (exportStatus) {
      exportStatus.textContent = status.textContent || '';
      exportStatus.classList.toggle('error', status.classList.contains('error'));
    }
    exportActionGroup.append(...[exportButton, exportStatus, exportDownload].filter(Boolean));
    renderMovieStatusEl = exportStatus;
    renderMovieDownloadEl = exportDownload;
  };
  body.appendChild(overviewView);
  panel.appendChild(body);
  // The full player belongs with the selected-scene transport, not inside
  // the Story outline view. The two small view buttons above this mount let
  // the presenter switch between the current scene player and the all-acts
  // player without changing the outline/node-content view.
  selectedScenePlayback.appendChild(playback);
  selectedScenePlayback.classList.toggle(
    'collapsed', actBoardSelectedScenePlaybackPanelCollapsed,
  );
  selectedPlaybackCollapseButton.setAttribute(
    'aria-expanded', String(!actBoardSelectedScenePlaybackPanelCollapsed),
  );
  selectedPlaybackCollapseButton.title = `${actBoardSelectedScenePlaybackPanelCollapsed ? 'Expand' : 'Collapse'} scene playback`;
  selectedPlaybackCollapseButton.setAttribute('aria-label', selectedPlaybackCollapseButton.title);
  setSelectedPlaybackView(previousPlaybackView);

  const setRendering = () => {
    playAllButton.disabled = true;
    playAllButton.textContent = 'Building playback…';
    status.textContent = 'Rendering all acts and scenes…';
    status.classList.remove('error');
    video.hidden = true;
    // A previous render may have left a usable-looking link in the panel.
    // Hide and invalidate it immediately so it cannot be mistaken for the
    // file currently being generated (or download an older MP4).
    if (exportDownload) {
      exportDownload.hidden = true;
      exportDownload.removeAttribute('href');
    }
  };
  const setReady = url => {
    playAllButton.disabled = false;
    playAllButton.textContent = 'Rebuild full playback';
    status.textContent = 'Full playback ready.';
    status.classList.remove('error');
    if (!url) return;
    video.src = `${url}${url.includes('?') ? '&' : '?'}fullPlayback=${Date.now()}`;
    video.hidden = false;
    video.load();
  };
  const setError = message => {
    playAllButton.disabled = false;
    playAllButton.textContent = 'Build full playback';
    status.textContent = message || 'Could not build the full playback.';
    status.classList.add('error');
    if (exportDownload) {
      exportDownload.hidden = true;
      exportDownload.removeAttribute('href');
    }
  };
  let activeNodeBody = null;
  let activeNodeCard = null;
  let activeNode = null;
  let activeNodeActionRow = null;
  let activeScenePlaybackId = null;
  const findActBoardLayer = actKey => {
    const column = Array.from(board.querySelectorAll('.storyboard-act-board-column'))
      .find(item => item.dataset.actKey === String(actKey));
    return column?.querySelector('.storyboard-act-board-node-stack') || null;
  };
  const ensureNodeContentCard = (actKey, act, node) => {
    if (!node?.id) return null;
    const selector = `[data-node-id="${String(node.id).replace(/"/g, '\\"')}"]`;
    const existing = Array.from(board.querySelectorAll('.storyboard-act-board-node'))
      .find(card => card.matches(selector));
    if (existing) return existing;
    if (node.type !== 'narration' && node.type !== 'audio') return null;
    const boardLayer = findActBoardLayer(actKey);
    if (!boardLayer || typeof buildActBoardNode !== 'function') return null;
    const cache = boardLayer._actBoardTrackContentCards
      || (boardLayer._actBoardTrackContentCards = new Map());
    let detachedCard = cache.get(String(node.id));
    if (!detachedCard || !detachedCard.isConnected) {
      detachedCard = buildActBoardNode(
        actKey,
        act || currentArcSections.find(item => item.key === actKey)
          || { key: actKey, label: actKey },
        node,
        boardLayer,
        0,
      );
      detachedCard.hidden = true;
      detachedCard.setAttribute('aria-hidden', 'true');
      detachedCard.classList.add('storyboard-act-board-track-content-host');
      boardLayer.appendChild(detachedCard);
      cache.set(String(node.id), detachedCard);
    }
    return detachedCard;
  };
  const mountSelectedScenePlayback = (actKey, node, { force = false } = {}) => {
    const scene = node ? actBoardSceneForNode(actKey, node) : null;
    const sceneId = scene?.id || node?.sceneId || null;
    if (!sceneId) {
      activeScenePlaybackId = null;
      selectedScenePlayback._actBoardSceneActKey = null;
      selectedScenePlayback.hidden = true;
      selectedScenePlaybackMount.replaceChildren();
      return;
    }
    const playbackNode = actBoardNodesForAct(actKey)
      .find(item => item.type === 'playback' && item.sceneId === sceneId)
      || ensureActBoardPlaybackNode(actKey, null, { create: true, sceneId });
    const boardLayer = findActBoardLayer(actKey);
    if (!playbackNode || !boardLayer) {
      activeScenePlaybackId = sceneId;
      selectedScenePlayback.hidden = false;
      selectedScenePlaybackMount.replaceChildren();
      setSelectedPlaybackView('scene');
      const empty = document.createElement('div');
      empty.className = 'storyboard-act-board-selected-scene-playback-empty';
      empty.textContent = 'Scene playback will appear when this scene is loaded.';
      selectedScenePlaybackMount.appendChild(empty);
      return;
    }
    if (!force && activeScenePlaybackId === sceneId
      && selectedScenePlaybackMount.querySelector('.storyboard-act-board-playback')) {
      selectedScenePlayback.hidden = false;
      return;
    }
    stopActBoardPlayback();
    // The outgoing transport's preloaded shots are detached elements; drop
    // their decoders now rather than waiting on garbage collection.
    selectedScenePlaybackMount.querySelector('.storyboard-act-board-playback')
      ?._actBoardPlaybackState?.releaseVideoPool?.();
    activeScenePlaybackId = sceneId;
    selectedScenePlayback._actBoardSceneActKey = String(actKey || '');
    selectedScenePlayback._actBoardSceneId = String(sceneId || '');
    selectedScenePlayback.hidden = false;
    selectedScenePlaybackMount.replaceChildren();
    setSelectedPlaybackView('scene');
    const playbackContent = buildActBoardNarrationPlayback(
      actKey, null, boardLayer, playbackNode,
    );
    selectedScenePlaybackMount.appendChild(playbackContent);
  };
  // Scene-scoped incremental patches call this after a track reorder/timing
  // update. Rebuild only the selected scene transport, preserving the panel's
  // collapsed state and the user's Scene play/Full play choice.
  selectedScenePlayback._actBoardRefresh = (actKey = null, sceneId = null) => {
    const currentActKey = String(actKey || selectedScenePlayback._actBoardSceneActKey || '');
    const currentSceneId = String(sceneId || selectedScenePlayback._actBoardSceneId || '');
    if (!currentActKey || !currentSceneId
      || String(activeScenePlaybackId || '') !== currentSceneId) return false;
    const scene = actBoardScenesForAct(currentActKey).find(item => item.id === currentSceneId);
    if (!scene) return false;
    // Rebuilding the transport stops it and starts a fresh one on Scene play.
    // Capture the clock, the play state and the Scene/Full choice first, and
    // put them back after the rebuild, so a segment dropped on the rail
    // updates playback without throwing away where the presenter was.
    const previous = selectedScenePlaybackMount
      .querySelector('.storyboard-act-board-playback')?._actBoardPlaybackState || null;
    const resume = previous && (previous.playing || Number(previous.clockTime) > 0)
      ? { time: Math.max(0, Number(previous.clockTime) || 0), playing: previous.playing === true }
      : null;
    const view = actBoardSelectedPlaybackView;
    mountSelectedScenePlayback(currentActKey, { sceneId: currentSceneId }, { force: true });
    setSelectedPlaybackView(view);
    if (resume) {
      const next = selectedScenePlaybackMount
        .querySelector('.storyboard-act-board-playback')?._actBoardPlaybackState;
      if (next) {
        next.seekPlaybackProgress?.(resume.time);
        if (resume.playing && !next.playing) next.playButton?.click();
      }
    }
    selectedScenePlayback.classList.toggle(
      'collapsed', actBoardSelectedScenePlaybackPanelCollapsed,
    );
    return true;
  };
  const mountActiveNodeBody = () => {
    const nodeType = activeNode?.type || '';
    nodeDetailsContent.className = 'storyboard-act-board-full-playback-node-details-content storyboard-act-board-node-panel-host storyboard-act-board-node';
    if (nodeType) nodeDetailsContent.classList.add(`storyboard-act-board-node-${nodeType}`);
    nodeDetailsContent.replaceChildren();
    if (activeNodeBody) {
      // Narration playback is owned by the scene narration rail. Remove any
      // stale player left on a cached/older node body before mounting it into
      // the selected-node panel, so the panel never shows a duplicate audio
      // control after a rerender or session restore.
      if (nodeType === 'narration') {
        activeNodeBody.querySelectorAll(
          '.storyboard-act-board-node-audio, .storyboard-act-board-full-playback-node-detail-audio',
        ).forEach(player => player.remove());
      }
      nodeDetailsContent.appendChild(activeNodeBody);
    }
    else nodeDetailsContent.appendChild(nodeDetailsEmpty);
  };
  const setPanelView = view => {
    actBoardFullPlaybackView = view === 'node' ? 'node' : 'overview';
    const showingNode = actBoardFullPlaybackView === 'node';
    if (showingNode) mountActiveNodeBody();
    else {
      nodeDetailsContent.className = 'storyboard-act-board-full-playback-node-details-content';
    nodeDetailsContent.replaceChildren(nodeDetailsEmpty);
    }
    overviewView.hidden = showingNode;
    nodeDetails.hidden = !showingNode;
    selectedScenePlayback.hidden = !activeScenePlaybackId;
    nodeDetailsHeading.hidden = showingNode;
    overviewViewButton.classList.toggle('selected', !showingNode);
    nodeViewButton.classList.toggle('selected', showingNode);
    overviewViewButton.classList.toggle('active', !showingNode);
    nodeViewButton.classList.toggle('active', showingNode);
    overviewViewButton.setAttribute('aria-selected', String(!showingNode));
    nodeViewButton.setAttribute('aria-selected', String(showingNode));
    overviewViewButton.setAttribute('aria-pressed', String(!showingNode));
    nodeViewButton.setAttribute('aria-pressed', String(showingNode));
  };
  overviewViewButton.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    setPanelView('overview');
  });
  nodeViewButton.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    setPanelView('node');
  });
  // Exposed so async work that finishes while its node is open can refresh the
  // panel; see refreshActBoardNodeContentPanel.
  const showNodeDetails = (actKey, act, node) => {
    actBoardSelectedNodeId = node?.id || '';
    actBoardSelectedNodeActKey = String(actKey || '');
    panel.dataset.selectedNodeId = actBoardSelectedNodeId;
    panel.dataset.selectedActKey = actBoardSelectedNodeActKey;
    // Selecting a node updates the panel's content/view, but must not change
    // the presenter's explicit collapsed preference. The panel is rebuilt by
    // Act Board rerenders, so `actBoardFullPlaybackPanelCollapsed` remains the
    // source of truth until the collapse button is clicked again.
    // Move the newly selected node's live body/action row into the panel. The
    // previously selected card is intentionally left contentless; node body
    // and action content remains panel-only for the rest of the session.
    const nextCard = ensureNodeContentCard(actKey, act, node);
    const nextBody = nextCard?._actBoardNodeBody || null;
    activeNodeCard = nextCard;
    activeNodeBody = nextBody;
    activeNodeActionRow = nextCard?._actBoardNodeActionRow || null;
    if (!nextBody) {
      nodeDetailsContent.replaceChildren(buildActBoardNodeDetailView(actKey, act, node));
    }
    activeNode = node || null;
    mountSelectedScenePlayback(actKey, node);
    nodeDetailsHeading.textContent = `Selected ${node?.type === 'narration' ? 'narration'
      : node?.type === 'footage' ? 'footage'
        : node?.type === 'audio' ? (node.audioKind === 'music' ? 'music' : 'sound effects')
          : node?.type === 'playback' ? 'playback' : 'node'}`;
    setPanelView('node');
    const expanded = !panel.classList.contains('collapsed');
    collapseButton.setAttribute('aria-expanded', String(expanded));
    collapseButton.title = `${expanded ? 'Collapse' : 'Expand'} all acts playback`;
    collapseButton.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} all acts playback`);
  };
  panel._actBoardFullPlayback = {
    showOverview: () => setPanelView('overview'),
    setRendering,
    setReady,
    setError,
    showNodeDetails,
    mountExportControls,
    restoreExportControls,
  };
  // The selected-scene transport is mounted by buildActBoardView next to the
  // All Acts panel, rather than inside its scrolling/fixed-height surface.
  // Keeping the live element here preserves all of its event wiring while
  // allowing the transport to anchor independently to the viewport corner.
  panel._actBoardSelectedScenePlayback = selectedScenePlayback;
  actBoardFullPlaybackPanel = panel;
  // Keep a scene transport available even before the presenter clicks a
  // particular node. It will switch to the selected node's scene later, but
  // the persistent playback panel should never require a node-content view
  // just to become visible.
  if (!activeScenePlaybackId) {
    const firstSceneContext = currentArcSections.map(act => ({
      act,
      scene: actBoardOpenSceneForAct(act.key)
        || actBoardScenesForAct(act.key).find(item => item.hidden !== true),
    })).find(item => item.scene);
    if (firstSceneContext) {
      mountSelectedScenePlayback(firstSceneContext.act.key, {
        sceneId: firstSceneContext.scene.id,
      });
      // Mounting the scene transport defaults to Scene play for a newly
      // selected scene, but a rebuild must restore the presenter's prior Full
      // play choice so the playback toggle remains truthful.
      setSelectedPlaybackView(previousPlaybackView);
    }
  }
  panel.classList.toggle('collapsed', actBoardFullPlaybackPanelCollapsed);
  const expanded = !panel.classList.contains('collapsed');
  collapseButton.setAttribute('aria-expanded', String(expanded));
  collapseButton.title = `${expanded ? 'Collapse' : 'Expand'} all acts playback`;
  collapseButton.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} all acts playback`);
  panel._actBoardShowNodeDetails = showNodeDetails;
  const previousNode = actBoardSelectedNodeId && actBoardSelectedNodeActKey
    ? actBoardNodesForAct(actBoardSelectedNodeActKey)
      .find(node => node.id === actBoardSelectedNodeId) : null;
  if (previousPanelView === 'node' && previousNode) {
    const previousAct = currentArcSections.find(item => item.key === actBoardSelectedNodeActKey)
      || { key: actBoardSelectedNodeActKey, label: actBoardSelectedNodeActKey };
    showNodeDetails(actBoardSelectedNodeActKey, previousAct, previousNode);
  } else {
    setPanelView('overview');
  }
  if (actBoardFullPlaybackStatus.state === 'rendering') setRendering();
  else if (actBoardFullPlaybackStatus.state === 'ready' && actBoardFullPlaybackStatus.url) {
    setReady(actBoardFullPlaybackStatus.url);
  } else if (actBoardFullPlaybackStatus.state === 'error') {
    setError(actBoardFullPlaybackStatus.message);
  }
  return panel;
}

// Mirror the selected scene's playback rails on the canvas. These are built
// from the same live node objects as the persistent playback panel, so either
// copy can be edited and the other refreshes through the shared rail refresh
// hooks.
function buildActBoardCanvasPlaybackTracks(actKey, scene, boardLayer, nodes) {
  const act = currentArcSections.find(item => item.key === actKey)
    || { key: actKey, label: actKey };
  const sceneNodes = (Array.isArray(nodes) ? nodes : []).filter(Boolean);
  // Keep every narration segment on the editing rail. `includeNarration` is
  // a playback/export switch, not a track-membership switch.
  const narrationNodes = sceneNodes.filter(node => node.type === 'narration'
    && actBoardTrackNodeVisible(node));
  const narrationNode = narrationNodes.find(node => !node.previousNarrationNodeId)
    || narrationNodes[0] || null;
  const chainedNarrationEntries = narrationNode
    ? orderedActBoardNarrationChain(actKey, narrationNode, sceneNodes, true)
    : [];
  const chainedNarrationIds = new Set(chainedNarrationEntries.map(node => node.id));
  // Smart arrange is also useful for independently recorded narration nodes.
  // Include those nodes after the explicit chain so every eligible narration
  // segment has a visible rail entry without inventing a link relationship.
  const narrationEntries = [
    ...chainedNarrationEntries,
    ...narrationNodes
      .filter(node => !chainedNarrationIds.has(node.id))
      .sort((a, b) => (Number(a.startSeconds) || 0) - (Number(b.startSeconds) || 0)),
  ];
  const footageEntries = scene
    ? orderedActBoardSceneFootage(actKey, scene, sceneNodes)
    : sceneNodes.filter(node => node.type === 'footage')
      .slice().sort((a, b) => (Number(a.startSeconds) || 0) - (Number(b.startSeconds) || 0));
  const audioEntries = sceneNodes.filter(node => node.type === 'audio')
    .slice().sort((a, b) => (Number(a.startSeconds) || 0) - (Number(b.startSeconds) || 0));
  // A framed scene board keeps all three lanes visible even when the scene is
  // empty, so presenters can see where narration, footage, and sound will go.
  // The compact fallback rail used without a scene still avoids rendering
  // when there is no content at all.
  if (!scene && !narrationEntries.length && !footageEntries.length && !audioEntries.length) return null;

  const timelineOwner = scene || narrationNode || footageEntries[0] || audioEntries[0] || null;
  const rail = document.createElement('div');
  rail.className = 'storyboard-act-board-canvas-playback-tracks storyboard-act-board-scene-sections';
  rail.setAttribute('aria-label', 'Canvas playback tracks');
  // Narration is edited in the scene lane now, so its canvas shell is not
  // rendered. Keep a detached action source for the lane's record/upload
  // proxies; it is never attached to the board and therefore cannot appear as
  // an invisible `storyboard-act-board-node-narration` card.
  const detachedNarrationActionCards = new Map();
  const makeEmptyTrack = (labelText, kind, emptyText) => {
    const track = document.createElement('div');
    track.className = `storyboard-act-board-footage-track storyboard-act-board-scene-empty-track storyboard-act-board-playback-${kind}-track`;
    track.dataset.actKey = actKey;
    track.dataset.trackKind = kind;
    const label = document.createElement('div');
    label.className = 'storyboard-act-board-footage-track-label';
    label.textContent = labelText;
    const strip = document.createElement('div');
    strip.className = 'storyboard-act-board-footage-track-strip';
    const gap = document.createElement('div');
    gap.className = 'storyboard-act-board-footage-track-gap empty';
    gap.textContent = emptyText;
    gap.style.width = '100%';
    strip.appendChild(gap);
    if (labelText) track.append(label);
    track.append(strip);
    return track;
  };
  const makeSection = (kind, labelText, className = '') => {
    const section = document.createElement('section');
    section.className = `storyboard-act-board-scene-section storyboard-act-board-scene-section-${kind}${className ? ` ${className}` : ''}`;
    section.dataset.section = kind;
    const headingRow = document.createElement('div');
    headingRow.className = 'storyboard-act-board-scene-section-heading-row';
    const heading = document.createElement('h6');
    heading.className = 'storyboard-act-board-scene-section-heading';
    heading.textContent = labelText;
    headingRow.appendChild(heading);
    section.appendChild(headingRow);
    return section;
  };
  // Called by every slide's proxy buttons on every selection change, so it
  // must be a single selector lookup - it used to build an array of every
  // card on the board per call, which made selecting a narration segment a
  // half-second stall on a full board.
  const findNodeCard = node => node?.id
    ? boardLayer.querySelector(
      `.storyboard-act-board-node[data-node-id="${String(node.id).replace(/"/g, '\\"')}"]`)
      || detachedNarrationActionCards.get(String(node.id)) || null : null;
  narrationEntries.forEach((node, nodeIndex) => {
    if (!node?.id || findNodeCard(node)) return;
    const detachedCard = buildActBoardNode(actKey, act, node, boardLayer, nodeIndex);
    detachedCard.hidden = true;
    detachedCard.setAttribute('aria-hidden', 'true');
    detachedNarrationActionCards.set(String(node.id), detachedCard);
  });
  const proxyButton = (sourceButton, labelText, className = '') => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `btn-secondary storyboard-act-board-scene-narration-action${className ? ` ${className}` : ''}`;
    const fallbackIcon = className.includes('upload-narration-btn') ? '↑'
      : className.includes('record-narration-btn') ? '⏺' : labelText;
    button.textContent = sourceButton?.textContent?.trim() || fallbackIcon;
    button.disabled = !sourceButton;
    if (sourceButton) {
      button.title = sourceButton.title || labelText;
      button.setAttribute('aria-label', sourceButton.getAttribute('aria-label') || labelText);
      ['is-empty', 'is-recording', 'is-processing', 'storyboard-act-board-record-narration-btn-error']
        .forEach(stateClass => button.classList.toggle(stateClass,
          sourceButton.classList.contains(stateClass)));
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        sourceButton.click();
      });
    }
    return button;
  };
  const sceneNarrationSelectionKey = scene?.id || `${actKey}:narration`;
  const selectedNarrationId = () => actBoardSelectedNarrationSegmentByScene.get(sceneNarrationSelectionKey) || '';
  // A segment is always selected, so its control bar is always on screen and
  // the record/upload/include controls are reachable without first clicking
  // a segment. Fall back to the first segment whenever the remembered one is
  // missing (fresh scene, or the selected segment was deleted).
  if (narrationEntries.length
    && !narrationEntries.some(node => node.id === selectedNarrationId())) {
    actBoardSelectedNarrationSegmentByScene.set(sceneNarrationSelectionKey, narrationEntries[0].id);
  }
  const selectedNarration = () => narrationEntries.find(node => node.id === selectedNarrationId()) || null;
  const recordingNarration = () => narrationEntries.find(node => {
    const recorderState = actBoardNarrationRecorderStates.get(String(node.id));
    return node.recordingStatus === 'recording'
      || Boolean(recorderState?.starting)
      || recorderState?.recorder?.state === 'recording';
  }) || null;
  const firstUnrecordedNarration = () => narrationEntries.find(node =>
    // A segment with an existing preview but no transcript is still a valid
    // recording target while it is being replaced. Do not use an old preview
    // to manufacture a second segment.
    !String(node.transcript || '').trim()
      && node.recordingStatus !== 'processing') || null;
  const startSceneNarrationAction = (node, actionClass, createIfMissing = false) => {
    let target = node || recordingNarration() || selectedNarration() || firstUnrecordedNarration();
    if (!target && createIfMissing) {
      target = createActBoardNarrationSegmentNode(actKey, scene);
      saveDebugSession();
      rerenderActBoard();
      const act = currentArcSections.find(item => item.key === actKey)
        || { key: actKey, label: actKey, description: '' };
      suggestInitialActBoardNarration(actKey, act, target);
      setTimeout(() => {
        const card = Array.from(document.querySelectorAll('.storyboard-act-board-node[data-node-id]'))
          .find(item => item.dataset.nodeId === String(target.id));
        card?.querySelector(actionClass)?.click();
      }, 0);
      return;
    }
    const source = findNodeCard(target)?.querySelector(actionClass)
      || (actionClass.includes('record-narration-btn')
        ? actBoardNarrationRecorderStates.get(String(target?.id))?.button : null);
    if (source) source.click();
  };
  // `explicitTarget` binds the control to one narration segment (the per-slide
  // bar). Without it the control follows the scene's selected segment, which is
  // the older scene-level behaviour.
  const makeSceneNarrationRecordButton = (explicitTarget = null) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn-secondary storyboard-act-board-scene-narration-action storyboard-act-board-node-action storyboard-act-board-record-narration-btn storyboard-act-board-scene-record-narration-btn';
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      const recording = recordingNarration();
      const selected = selectedNarration();
      // A second press while recording must always target the active segment,
      // even if a board refresh changed the selected-slide state.
      const target = explicitTarget || recording || selected || firstUnrecordedNarration();
      // Recording is a start/stop control for the current segment. It must not
      // create a new narration segment as a side effect of a click; new
      // segments are created explicitly through the canvas's Narration action.
      startSceneNarrationAction(target, '.storyboard-act-board-record-narration-btn', false);
    });
    const refresh = () => {
      const recording = recordingNarration();
      const selected = selectedNarration();
      const target = explicitTarget || recording || selected || firstUnrecordedNarration();
      button.dataset.narrationNodeId = target?.id || '';
      const source = findNodeCard(target)?.querySelector('.storyboard-act-board-record-narration-btn')
        || actBoardNarrationRecorderStates.get(String(target?.id))?.button;
      button.textContent = source?.textContent?.trim() || (recording ? '●' : selected ? '↻' : '⏺');
      button.title = source?.title || (recording ? 'Stop recording narration' : selected ? 'Record this narration segment again' : 'Start recording narration');
      button.setAttribute('aria-label', button.title);
      button.setAttribute('aria-pressed', String(Boolean(source?.classList.contains('is-recording'))));
      // The Record control only starts/stops an existing segment. New
      // segments are created explicitly from the canvas, so keep the control
      // disabled when this scene has no narration segment yet.
      button.disabled = !target || Boolean(source?.disabled);
      ['is-empty', 'is-recording', 'is-processing', 'storyboard-act-board-record-narration-btn-error']
        .forEach(stateClass => button.classList.toggle(stateClass, Boolean(source?.classList.contains(stateClass))));
    };
    refresh();
    button._actBoardRefresh = refresh;
    return button;
  };
  const makeSceneNarrationUploadButton = (explicitTarget = null) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn-secondary storyboard-act-board-scene-narration-action storyboard-act-board-node-action storyboard-act-board-upload-narration-btn';
    const refresh = () => {
      const target = explicitTarget || selectedNarration() || primaryNarration || null;
      const source = findNodeCard(target)?.querySelector('.storyboard-act-board-upload-narration-btn');
      button.textContent = source?.textContent?.trim() || '↑';
      button.title = source?.title || 'Upload narration for this segment';
      button.setAttribute('aria-label', button.title);
      button.disabled = !source;
    };
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      const target = explicitTarget || selectedNarration() || primaryNarration || null;
      findNodeCard(target)?.querySelector('.storyboard-act-board-upload-narration-btn')?.click();
    });
    refresh();
    button._actBoardRefresh = refresh;
    return button;
  };
  // Per-slide narration controls. Record / upload / download / include act on
  // THIS segment rather than on whichever one the scene happens to have
  // selected, so the bar above a slide always does what it looks like it does.
  // Visualize is deliberately not here: it stays scene-wide, because running it
  // per slide silently skips highlights on the other segments.
  const makeNarrationSlideControls = entry => {
    const group = document.createElement('div');
    group.className = 'storyboard-act-board-narration-slide-actions';
    const record = makeSceneNarrationRecordButton(entry);
    // What the recording is doing right now - "Transcribing narration…" and
    // the steps before it - as visible text next to the button. The button's
    // own processing state was a dimmed glyph and a tooltip, easy to miss.
    const recordStatus = document.createElement('span');
    recordStatus.className = 'storyboard-act-board-record-status';
    recordStatus.dataset.narrationNodeId = entry.id || '';
    recordStatus.setAttribute('role', 'status');
    recordStatus.setAttribute('aria-live', 'polite');
    // The slide bar is built after the narration card's own status pass, so
    // seed the label from the node's current state; later changes arrive
    // through setRecordButtonStatus.
    const initialState = entry.recordingStatus === 'recording' ? 'Recording…'
      : entry.recordingStatus === 'processing' ? 'Transcribing narration…'
        : entry.recordingStatus === 'error' ? 'Narration recording failed' : '';
    recordStatus.textContent = initialState;
    recordStatus.hidden = !initialState;
    recordStatus.classList.toggle('is-recording', entry.recordingStatus === 'recording');
    recordStatus.classList.toggle('is-processing', entry.recordingStatus === 'processing');
    recordStatus.classList.toggle('is-error', entry.recordingStatus === 'error');
    const upload = makeSceneNarrationUploadButton(entry);

    const download = document.createElement('button');
    download.type = 'button';
    download.className = 'btn-secondary storyboard-act-board-scene-narration-action storyboard-act-board-node-action storyboard-act-board-download-narration-btn';
    download.textContent = '↓';
    download.title = 'Download this narration segment';
    download.setAttribute('aria-label', download.title);
    download.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      const url = download.dataset.downloadUrl || '';
      if (!url) return;
      const link = document.createElement('a');
      link.href = url;
      link.download = download.dataset.downloadFilename || 'narration.wav';
      document.body.appendChild(link);
      link.click();
      link.remove();
    });

    const includeLabel = document.createElement('label');
    includeLabel.className = 'storyboard-act-board-narration-slide-include';
    const includeInput = document.createElement('input');
    includeInput.type = 'checkbox';
    includeInput.addEventListener('click', event => event.stopPropagation());
    includeInput.addEventListener('change', event => {
      event.stopPropagation();
      entry.includeNarration = includeInput.checked;
      saveDebugSession();
      // A scene patch, not a board rerender: this changes one segment's
      // participation in playback, not the board's structure.
      queueActBoardScenePatch(actKey, entry.sceneId || scene?.id || '', { persist: true });
    });
    includeLabel.append(includeInput, document.createTextNode(' In playback'));

    const refresh = () => {
      const url = entry?._nativePreviewUrl || entry?._nativeAudioUrl
        || entry?.audioPreviewUrl || '';
      download.hidden = !url;
      download.disabled = !url;
      download.dataset.downloadUrl = url;
      download.dataset.downloadFilename = `narration-${entry?.id || 'segment'}.wav`;
      includeInput.checked = entry?.includeNarration !== false;
      record._actBoardRefresh?.();
      upload._actBoardRefresh?.();
    };
    refresh();
    group._actBoardRefresh = refresh;
    group.append(record, recordStatus, upload, download, includeLabel);
    return group;
  };

  // Narration section: controls sit above a horizontally scrollable,
  // Playfair-styled recorded transcript. Arrows use scrollBy rather than
  // changing the underlying narration node, so track timing/highlighting stays
  // shared with the existing node and playback panel.
  const narrationSection = makeSection('narration', 'Narration');
  // Visualize highlights is the narration section's scene-wide action, so it
  // sits in the heading row's right slot like Footage's Organize - the heading
  // row is `justify-content: space-between`, so appending after the <h6> is
  // what pins it to the top-right corner.
  const narrationHeadingRow = narrationSection.querySelector(
    '.storyboard-act-board-scene-section-heading-row',
  );
  const primaryNarration = narrationEntries[0] || narrationNode;
  const primaryCard = findNodeCard(primaryNarration);
  const sceneRecordButton = makeSceneNarrationRecordButton();
  const sceneUploadButton = makeSceneNarrationUploadButton();
  const sceneVisualizeButton = document.createElement('button');
  sceneVisualizeButton.type = 'button';
  // Same class family as Footage's Organize and the scene's Smart arrange so
  // the three heading-row actions read as one control set.
  sceneVisualizeButton.className = 'btn-secondary storyboard-act-board-board-scene-organize storyboard-act-board-scene-visualize-highlights-btn';
  sceneVisualizeButton.textContent = 'Visualize highlights';
  sceneVisualizeButton.title = 'Find footage for highlighted phrases across all narration segments';
  sceneVisualizeButton.setAttribute('aria-label', 'Visualize highlights');
  sceneVisualizeButton.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    // Each narration segment owns its filmable phrase selections. Running only
    // the currently selected slide silently skipped highlights on the other
    // slides. Mount all of the current scene's missing cards first; media
    // retrieval starts afterward and is owned independently by each card.
    const targets = narrationEntries.filter(node =>
      node && node.type === 'narration'
      && String(node.transcript || '').trim());
    if (!targets.length) return;
    const sceneId = scene?.id || targets.find(node => node.sceneId)?.sceneId || '';
    const loadingKey = `${actKey}:${sceneId}`;
    const visualizeToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const hadActiveBatch = actBoardSceneVisualizeTokens.has(loadingKey);
    actBoardSceneVisualizeTokens.set(loadingKey, visualizeToken);
    const loadingShownAt = Date.now();
    const loadingStarted = hadActiveBatch || setActBoardSceneLoading(
      actKey, sceneId, true, 'Analyzing narration and generating previews…',
    );
    if (!loadingStarted) {
      rerenderActBoard({ preservePlayback: true });
      // The first render may have been in the middle of a structural patch;
      // attach the veil to the freshly mounted scene when it is available.
      setActBoardSceneLoading(
        actKey, sceneId, true, 'Analyzing narration and generating previews…',
      );
    }
    (async () => {
      const isCurrentBatch = () =>
        actBoardSceneVisualizeTokens.get(loadingKey) === visualizeToken;
      let scenePatchNeeded = false;
      const mountCurrentHighlights = async () => {
        // `narrationSpans` and the explicit/user phrase arrays are already
        // usable at click time. Mount those cards synchronously before
        // waiting for any classifier or media request to finish.
        const pendingMounts = targets.map(async target => {
          // Manual selections have their own phrase-level classifier request.
          // Do not mount a card from the provisional raw phrase when the user
          // clicked Visualize immediately after highlighting it.
          await waitForActBoardManualFilmability(target);
          if (!isCurrentBatch()) return null;
          const source = actBoardNarrationSourceText(target)
            || String(target.transcript || target.text || '').trim();
          const spans = Array.isArray(target.narrationSpans)
            ? target.narrationSpans.filter(span => span
              && span.bucket !== 'ignore' && span.bucket !== 'pending'
              && !actBoardNarrationSpanExcluded(target, span)) : [];
          let phrases = collectActBoardVisualizePhrases(
            actKey, target, source, spans,
          );
          // Preserve the existing broad-fragment fallback for narration that
          // has no classified highlights yet. It is still mounted immediately
          // and its media is handled by the same per-node pipeline.
          if (!phrases.length && (!target.narrationSpanStatus
            || target.narrationSpanStatus === 'error')) {
            phrases = actBoardNarrationFragments(source).map(text => ({ text }));
          }
          if (!phrases.length) return Promise.resolve(null);
          return suggestActBoardSelectedFootage(
            actKey, act, target, source, phrases, null,
            { deferMedia: true, patch: false, persist: false },
          );
        });
        const batches = (await Promise.all(pendingMounts)).filter(Boolean);
        const addedCards = batches.some(batch =>
          (batch.newlyCreatedFootageNodes || []).length > 0);
        if (addedCards) {
          scenePatchNeeded = true;
          saveDebugSession();
          queueActBoardScenePatch(actKey, sceneId, { persist: true });
        }
        return batches;
      };
      const startMedia = batches => batches.flatMap(batch =>
        batch.footageNodesToSearch.map(footageNode => startActBoardFootageMediaJob(
          actKey, act, batch.narrationNode, footageNode,
        )).filter(Boolean));
      try {
        const immediate = await mountCurrentHighlights();
        if (!isCurrentBatch()) return;
        // Let the incremental patch paint the new shells before removing the
        // veil and starting media work. The placeholders are now visible and
        // every media request can proceed independently.
        await new Promise(resolve => {
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(resolve);
          else setTimeout(resolve, 0);
        });
        if (!isCurrentBatch()) return;
        // Only drop the veil once this click has put something new on screen.
        // When shells were mounted they are painted by now, so the scene is
        // handed back and each card reports its own media progress. When
        // nothing was mounted the scene still looks untouched and the span
        // analysis below is the only work in flight - dismissing there left
        // the click with no feedback for as long as that request took.
        if (scenePatchNeeded) {
          await waitForActBoardSceneLoadingFloor(loadingShownAt);
          if (!isCurrentBatch()) return;
          setActBoardSceneLoading(actKey, sceneId, false);
        } else {
          setActBoardSceneLoadingMessage(sceneId,
            'Finding filmable moments in the narration…');
        }
        startMedia(immediate);

        // Start/await analysis for each narration segment concurrently. Any
        // newly classified spans are mounted as a second incremental batch;
        // they never hold up cards that were already highlighted.
        const analyses = targets.map(target =>
          requestActBoardNarrationAnalysis(target, { force: true })
            || actBoardNarrationAnalysisPromises.get(
              `${target.id}:${actBoardNarrationTextHash(actBoardNarrationSourceText(target))}`,
            )).filter(Boolean);
        if (analyses.length) {
          await Promise.allSettled(analyses);
          if (!isCurrentBatch()) return;
          const late = await mountCurrentHighlights();
          startMedia(late);
        }
      } catch (error) {
        if (isCurrentBatch()) {
          await waitForActBoardSceneLoadingFloor(loadingShownAt);
          setActBoardSceneLoading(actKey, sceneId, false);
          if (scenePatchNeeded) queueActBoardScenePatch(actKey, sceneId, { persist: true });
        }
      } finally {
        if (isCurrentBatch()) {
          actBoardSceneVisualizeTokens.delete(loadingKey);
          if (scenePatchNeeded) queueActBoardScenePatch(actKey, sceneId, { persist: true });
          // New cards are on the board; put them on the rail where their
          // phrases are spoken without a second click. Media is still
          // arriving, but placement only needs the phrase text and the word
          // timings, both of which exist now. It runs under this same veil
          // with a shared floor, so the presenter sees one continuous wait
          // rather than the veil dropping and immediately coming back. Nothing
          // mounted means nothing to move, so it is skipped.
          if (scenePatchNeeded && scene) {
            await runActBoardSmartArrange(
              scene, actBoardSceneNodes(scene, actBoardNodesForAct(actKey)), boardLayer,
              { shownAt: loadingShownAt },
            );
          }
          await waitForActBoardSceneLoadingFloor(loadingShownAt);
          setActBoardSceneLoading(actKey, sceneId, false);
        }
      }
    })();
  });
  const sceneDownload = document.createElement('button');
  sceneDownload.type = 'button';
  sceneDownload.className = 'btn-secondary storyboard-act-board-scene-narration-action storyboard-act-board-node-action storyboard-act-board-download-narration-btn';
  sceneDownload.textContent = '↓';
  sceneDownload.title = 'Download this narration segment';
  sceneDownload.setAttribute('aria-label', 'Download this narration segment');
  sceneDownload.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    const url = sceneDownload.dataset.downloadUrl || '';
    if (!url) return;
    // Keep the visible control a semantic button while using a short-lived
    // native anchor to invoke the browser's download handling for blob and
    // server-provided narration URLs.
    const downloadLink = document.createElement('a');
    downloadLink.href = url;
    downloadLink.download = sceneDownload.dataset.downloadFilename || 'narration.wav';
    downloadLink.hidden = true;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    downloadLink.remove();
  });
  const sceneIncludeLabel = document.createElement('label');
  sceneIncludeLabel.className = 'storyboard-act-board-scene-narration-include';
  const sceneIncludeInput = document.createElement('input');
  sceneIncludeInput.type = 'checkbox';
  sceneIncludeLabel.append(sceneIncludeInput, document.createTextNode(' Include in playback'));
  const refreshSceneNarrationControls = () => {
    const target = selectedNarration() || primaryNarration || null;
    const url = target?._nativePreviewUrl || target?._nativeAudioUrl || target?.audioPreviewUrl || '';
    sceneDownload.hidden = !url;
    sceneDownload.disabled = !url;
    sceneDownload.dataset.downloadUrl = url;
    sceneDownload.dataset.downloadFilename = `narration-${target?.id || 'scene'}.wav`;
    sceneIncludeInput.disabled = !target;
    sceneIncludeInput.checked = Boolean(target && target.includeNarration !== false);
    // Visualize is a scene-level action. Do not disable it while a draft is
    // generating: a recorded transcript and its current highlights are
    // already valid inputs, and the media work can proceed independently.
    const visualizeTargets = narrationEntries.filter(node =>
      node && node.type === 'narration'
      && String(node.transcript || '').trim());
    const hasFilmableInput = visualizeTargets.some(node =>
      String(node.transcript || node.text || '').trim()
      || node.selectedFootagePhrases?.length
      || node.userFilmablePhrases?.length
      || node.footageSuggestedPhrases?.length);
    sceneVisualizeButton.disabled = !visualizeTargets.length || !hasFilmableInput;
    sceneVisualizeButton.classList.toggle('is-processing', visualizeTargets.some(node =>
      Boolean(node.footageSuggestionInFlight)));
  };
  sceneIncludeInput.addEventListener('click', event => event.stopPropagation());
  sceneIncludeInput.addEventListener('change', event => {
    event.stopPropagation();
    const target = selectedNarration() || primaryNarration || null;
    if (!target) return;
    target.includeNarration = sceneIncludeInput.checked;
    saveDebugSession();
    rerenderActBoard();
  });
  refreshSceneNarrationControls();
  // Record / upload / download / include now live in each slide's own bar (see
  // makeNarrationSlideControls). The scene-wide action goes to the heading row.
  narrationHeadingRow?.appendChild(sceneVisualizeButton);
  // Smart arrange sits with Visualize highlights: both act on the whole
  // scene's narration, and Visualize now runs an arrange itself, so the
  // manual button belongs next to it rather than up by the scene title.
  if (scene?.committedToStack) {
    const sceneArrangeButton = document.createElement('button');
    sceneArrangeButton.type = 'button';
    sceneArrangeButton.className = 'btn-secondary storyboard-act-board-board-scene-smart-arrange';
    sceneArrangeButton.textContent = 'Smart arrange';
    sceneArrangeButton.title = 'Arrange narration, footage, and sound segments on their tracks using narration timing';
    sceneArrangeButton.setAttribute('aria-label', 'Smart arrange scene nodes to narration');
    // Arranging lays footage against the narration; with no footage on the
    // rail there is nothing to lay, so the button is not offered.
    sceneArrangeButton.disabled = !actBoardSceneNodes(scene, nodes)
      .some(node => node.type === 'footage' && actBoardTrackNodeVisible(node));
    sceneArrangeButton.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      runActBoardSmartArrange(scene, actBoardSceneNodes(scene, actBoardNodesForAct(actKey)), boardLayer);
    });
    narrationHeadingRow?.appendChild(sceneArrangeButton);
  }
  sceneVisualizeButton._actBoardRefresh = refreshSceneNarrationControls;
  const narrationScroller = document.createElement('div');
  narrationScroller.className = 'storyboard-act-board-scene-narration-scroller';
  const scrollButton = (direction, labelText) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'storyboard-act-board-scene-narration-scroll-btn';
    button.textContent = direction < 0 ? '‹' : '›';
    button.title = labelText;
    button.setAttribute('aria-label', labelText);
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      narrationViewport.scrollBy({ left: direction * Math.max(220, narrationViewport.clientWidth * .72), behavior: 'smooth' });
    });
    return button;
  };
  const narrationViewport = document.createElement('div');
  narrationViewport.className = 'storyboard-act-board-scene-narration-viewport';
  const narrationSlides = document.createElement('div');
  narrationSlides.className = 'storyboard-act-board-scene-narration-slides';
  const narrationSlideFor = nodeId => narrationSlides.querySelector(
    `.storyboard-act-board-scene-narration-slide[data-narration-node-id="${String(nodeId).replace(/"/g, '\\"')}"]`,
  );
  // offsetLeft is measured against the slide's offsetParent, which is the
  // scene-sections wrapper rather than this scroller - using it overshoots by
  // that wrapper's own offset and clips the first words. Measure the slide's
  // real distance from the viewport instead.
  const scrollNarrationSlideIntoView = (slide, smooth = true) => {
    if (!slide?.isConnected) return;
    const slideLeft = slide.getBoundingClientRect().left;
    const viewportLeft = narrationViewport.getBoundingClientRect().left;
    const target = narrationViewport.scrollLeft + (slideLeft - viewportLeft)
      - ACT_BOARD_NARRATION_SCROLL_GUTTER_PX;
    // A smooth scroll is an animation, and Chrome does not run animations in a
    // hidden document - the request is simply dropped, and the slides never
    // move. Nobody can see the glide in a hidden tab anyway, so jump instead;
    // the smooth version is kept for the visible case where it matters.
    const animate = smooth && document.visibilityState === 'visible';
    narrationViewport.scrollTo({
      left: Math.max(0, target),
      behavior: animate ? 'smooth' : 'auto',
    });
  };
  // Selecting a narration segment is reachable two ways - a segment on the
  // narration track, and the slide itself - so the behaviour lives in one
  // place rather than being duplicated per entry point. Selection is applied
  // in place (classes plus each bar's own refresh); rerendering the board here
  // would throw away the transcript caret and cost ~35x as much.
  // See highlightPlaybackTrackNode in the rail builder: the two selection
  // paths notify each other, so each runs at most once per gesture.
  let selectingNarration = false;
  const selectNarrationSegment = (node, { scroll = true } = {}) => {
    if (!node?.id || selectingNarration) return;
    selectingNarration = true;
    try { selectNarrationSegmentOnce(node, { scroll }); } finally { selectingNarration = false; }
  };
  const selectNarrationSegmentOnce = (node, { scroll = true } = {}) => {
    actBoardSelectedNarrationSegmentByScene.set(sceneNarrationSelectionKey, node.id);
    sceneRecordButton._actBoardRefresh?.();
    sceneUploadButton._actBoardRefresh?.();
    sceneVisualizeButton._actBoardRefresh?.();
    refreshSceneNarrationControls();
    narrationScroller.dataset.activeNarrationNodeId = node.id || '';
    narrationSlides.querySelectorAll('.storyboard-act-board-scene-narration-slide')
      .forEach(slide => {
        slide.classList.toggle('selected',
          slide.dataset.narrationNodeId === String(node.id));
        slide._actBoardRefreshControls?.();
      });
    // The narration track is the other entry point for the same selection
    // (see buildActBoardPlaybackAudioTrack's own comment on
    // _actBoardHighlightNarrationNode) - keep its selected segment in sync
    // when the slide side is what changed it.
    narrationTrack?._actBoardHighlightNarrationNode?.(node);
    const selectedSlide = narrationSlides.querySelector(
      `.storyboard-act-board-scene-narration-slide[data-narration-node-id="${String(node.id).replace(/"/g, '\\"')}"]`,
    );
    if (scroll && selectedSlide) scrollNarrationSlideIntoView(selectedSlide);
  };
  // Scrolling the slides - wheel, trackpad or the arrow buttons - selects the
  // slide that has come into view, so its control bar is always the one on
  // screen rather than staying on a slide that has scrolled away. Selection
  // here must not scroll back, or it would fight the gesture that caused it.
  let narrationScrollSelectTimer = null;
  narrationViewport.addEventListener('scroll', () => {
    clearTimeout(narrationScrollSelectTimer);
    narrationScrollSelectTimer = setTimeout(() => {
      const viewportLeft = narrationViewport.getBoundingClientRect().left
        + ACT_BOARD_NARRATION_SCROLL_GUTTER_PX;
      let best = null;
      let bestDistance = Infinity;
      narrationSlides.querySelectorAll('.storyboard-act-board-scene-narration-slide').forEach(slide => {
        const distance = Math.abs(slide.getBoundingClientRect().left - viewportLeft);
        if (distance < bestDistance) { bestDistance = distance; best = slide; }
      });
      if (!best || best.classList.contains('selected')) return;
      const entry = entriesForDisplay.find(item => String(item.id) === best.dataset.narrationNodeId);
      if (entry) selectNarrationSegment(entry, { scroll: false });
    }, 140);
  }, { passive: true });
  const entriesForDisplay = narrationEntries.length ? narrationEntries : [primaryNarration].filter(Boolean);
  entriesForDisplay.forEach((entry, index) => {
    const slide = document.createElement('article');
    slide.className = 'storyboard-act-board-scene-narration-slide';
    slide.dataset.narrationNodeId = entry.id || '';
    // Keep the active segment visually selected when deleting a phrase causes
    // the narration slide text to rerender.
    if (String(entry.id || '') === String(selectedNarrationId() || '')) {
      slide.classList.add('selected');
    }
    // Keep the transcript's original character offsets so classifier spans
    // line up with the same phrases highlighted in the narration node.
    const recordedText = String(entry.transcript || '').trim();
    const entryFilmableFragments = recordedText ? [
      ...(Array.isArray(entry.narrationSpans) ? entry.narrationSpans : []),
      ...(Array.isArray(entry.footageSuggestedPhrases) ? entry.footageSuggestedPhrases : []),
      ...(Array.isArray(entry.userFilmablePhrases) ? entry.userFilmablePhrases : []),
    ].filter(fragment => fragment && fragment.bucket !== 'ignore') : [];
    // Gated at event time rather than by rebuilding the slide: switching mode
    // then costs nothing but a class and an attribute.
    const onSceneNarrationSpanSelect = (metadata, renderedText, appendSelection = false) =>
      (actBoardNarrationSlideEditing() ? undefined
        : handleActBoardNarrationSpanSelect(entry, metadata, renderedText, appendSelection));
    const onSceneNarrationSpanRemove = (metadata, renderedText) =>
      (actBoardNarrationSlideEditing() ? undefined
        : removeActBoardNarrationHighlight(entry, metadata, renderedText));
    const recorded = recordedText
      ? buildActBoardSuggestedNarrationText(
        recordedText,
        entryFilmableFragments,
        null,
        '',
        onSceneNarrationSpanSelect,
        false,
        onSceneNarrationSpanRemove,
      )
      : document.createElement('div');
    recorded.classList.add('storyboard-act-board-scene-recorded-narration');
    // The placeholder is UI copy, not speech - the quote marks and italics
    // belong only to an actual transcript.
    recorded.classList.toggle('is-empty', !recordedText);
    recorded.dataset.actBoardNarrationNodeId = entry.id || '';
    if (recordedText) {
      recorded.querySelector('strong')?.remove();
      // Highlights are painted in both modes so the presenter can always see
      // what they have marked. What changes is whether anything responds: in
      // edit mode there is a caret and no selection gesture, so a click can
      // only ever do one thing.
      applyActBoardNarrationPhraseSelection(recorded, entry);
      enableActBoardInlineTranscriptEditing(recorded, actKey, entry);
    } else {
      recorded.textContent = 'No recorded narration yet';
    }
    const suggestedText = String(entry.text || '').replace(/\s+/g, ' ').trim();
    const suggested = suggestedText
      ? buildActBoardSuggestedNarrationText(
        suggestedText,
        [],
        null,
        'Suggested narration: ',
        null,
        false,
        null,
        entry.pauseWordIndices,
      )
      : document.createElement('div');
    suggested.classList.add('storyboard-act-board-scene-suggested-narration');
    if (!suggestedText) {
      const suggestedLabel = document.createElement('strong');
      suggestedLabel.textContent = 'Suggested narration: ';
      suggested.append(
        suggestedLabel,
        document.createTextNode(entry.status === 'generating'
          ? 'Drafting suggested narration…'
          : 'No suggested narration yet'),
      );
    }
    const slideBar = document.createElement('div');
    slideBar.className = 'storyboard-act-board-narration-slide-bar';
    // One inner row so `grid-template-rows: 0fr` can collapse the whole bar.
    // With the controls as direct children each would open its own implicit
    // row, and the bar would never fully close.
    const slideBarInner = document.createElement('div');
    slideBarInner.className = 'storyboard-act-board-narration-slide-bar-inner';
    if (recordedText) slideBarInner.appendChild(buildActBoardNarrationModeToggle());
    const slideControls = makeNarrationSlideControls(entry);
    slideBarInner.appendChild(slideControls);
    slideBar.appendChild(slideBarInner);
    slide._actBoardRefreshControls = slideControls._actBoardRefresh;
    slide.appendChild(slideBar);
    // Clicking anywhere in the slide's own chrome selects that segment, so the
    // per-slide bar is reachable without first finding the segment on the
    // narration track. Interactive descendants keep their own behaviour: the
    // bar's own buttons, the entity resize grips, and the contenteditable
    // transcript must not be hijacked into a re-selection.
    slide.addEventListener('click', event => {
      if (slide.classList.contains('selected')) return;
      if (event.target.closest(
        'button, input, select, textarea, a, label,'
        + ' [contenteditable="true"]')) return;
      selectNarrationSegment(entry);
    });
    slide.append(recorded, suggested);
    narrationSlides.appendChild(slide);
    if (index === 0) narrationScroller.dataset.activeNarrationNodeId = entry.id || '';
  });
  narrationViewport.appendChild(narrationSlides);
  narrationScroller.append(
    scrollButton(-1, 'Scroll narration left'),
    narrationViewport,
    scrollButton(1, 'Scroll narration right'),
  );
  narrationSection.appendChild(narrationScroller);


  const narrationTrack = narrationEntries.length
    ? buildActBoardPlaybackAudioTrack({
      actKey,
      labelText: '',
      entries: narrationEntries,
      kind: 'narration',
      narrationNode,
      boardLayer,
      timelineOwner,
      showSourceEditor: true,
      onSelect: node => selectNarrationSegment(node),
    })
    : makeEmptyTrack('', 'narration', 'No narration');
  narrationSection.appendChild(narrationTrack);
  rail.appendChild(narrationSection);

  // Footage section deliberately receives the largest grid row. Footage is
  // represented by the canvas nodes and this track; the former scene-level
  // preview-tile layer is intentionally not mounted. Keeping media previews
  // out of this section avoids duplicate image/video elements and background
  // loading work while preserving the editable footage nodes and track.
  const footageSection = makeSection('footage', 'Footage');
  const footageHeadingRow = footageSection.querySelector(
    '.storyboard-act-board-scene-section-heading-row',
  );
  if (scene?.committedToStack) {
    const organizeFootage = document.createElement('button');
    organizeFootage.type = 'button';
    organizeFootage.className = 'btn-secondary storyboard-act-board-board-scene-organize';
    organizeFootage.textContent = 'Organize';
    organizeFootage.title = 'Arrange footage nodes into a grid';
    organizeFootage.setAttribute('aria-label', 'Organize footage nodes into a grid');
    organizeFootage.disabled = !footageEntries.length;
    organizeFootage.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      organizeActBoardFootageNodes(scene, footageEntries, boardLayer);
    });
    footageHeadingRow?.appendChild(organizeFootage);
  }
  const footageTrack = footageEntries.length
    ? buildActBoardFootageTrack(actKey, narrationNode, boardLayer, footageEntries, timelineOwner)
    : makeEmptyTrack('Footage track', 'footage', 'No footage');
  // Footage can extend beyond the narration. Re-read the shared duration once
  // both rails exist so their playhead percentages use the same scene scale
  // from the first paint, rather than the narration-only duration.
  footageTrack?._actBoardRefresh?.();
  narrationTrack?._actBoardRefresh?.();
  // Keep the track directly below the section heading. The canvas footage
  // nodes remain the visual/editable media representation.
  footageSection.appendChild(footageHeadingRow);
  footageSection.appendChild(footageTrack);
  const footageNodeLayer = document.createElement('div');
  footageNodeLayer.className = 'storyboard-act-board-scene-footage-node-layer';
  footageNodeLayer.dataset.actKey = actKey;
  footageNodeLayer.dataset.sceneId = scene?.id || '';
  footageSection.appendChild(footageNodeLayer);
  rail.appendChild(footageSection);

  const soundSection = makeSection('sound', 'Music / sound');
  const soundTrack = audioEntries.length
    ? buildActBoardPlaybackAudioTrack({
      actKey,
      labelText: 'Music / sound effects track',
      entries: audioEntries,
      kind: 'audio',
      narrationNode,
      boardLayer,
      timelineOwner,
    })
    : makeEmptyTrack('Music / sound effects track', 'audio', 'No sound');
  soundSection.appendChild(soundTrack);
  rail.appendChild(soundSection);
  // Keep the compact music/sound lane above narration in the scene board.
  // The footage lane remains the large middle/lower lane.
  rail.insertBefore(soundSection, narrationSection);

  rail._actBoardPosition = () => {
    // This runs once below, before the caller has mounted the rail. A detached
    // element measures 0 x 0 and has no parent to identify its host, so every
    // decision here would be made against a phantom rail: the branch that
    // reserves a band at the top of the canvas would read the scene as sitting
    // under the rails and push it (and every node) down a few pixels on each
    // render, which is why a scene crept down the page as footage loaded.
    // Wait for the mounted pass scheduled on the next frame, where the
    // measurement is real; it still lands before the browser paints.
    if (!rail.isConnected) return;
    // Keep the compact rails in a reserved band at the top of the canvas.
    // Older versions placed them below every node, which made the canvas
    // tracks easy to miss. If existing content occupies that band, move it
    // down once (preserving the saved node/scene coordinates) so the rails do
    // not cover headers or links.
    const sceneCard = scene
      ? Array.from(boardLayer.querySelectorAll('.storyboard-act-board-board-scene'))
        .find(card => card.dataset.boardSceneId === scene.id)
      : null;
    const mountedOnScene = Boolean(sceneCard && rail.parentElement === sceneCard);
    const sceneLayout = mountedOnScene && rail.classList.contains('storyboard-act-board-scene-sections');
    // When mounted inside the framed scene card, leave the card header at the
    // top and put the mini rails just below it. Otherwise use the top of the
    // overall canvas as the fallback host.
    const top = mountedOnScene
      ? Math.max(36, sceneCard.querySelector('.storyboard-act-board-board-scene-header')?.offsetHeight || 0) + 2
      : 4;
    rail.style.top = `${top}px`;
    rail.style.left = '0px';
    rail.style.right = '0px';
    if (sceneLayout) {
      // The redesigned scene board owns the full space beneath its header.
      // Do not push node cards based on this rail's height; Organize can place
      // nodes beneath it explicitly, while free-form dragging remains intact.
      rail.style.bottom = '12px';
      rail.style.height = 'auto';
      const currentHeight = Math.max(116,
        Number(scene.boardHeight) || ACT_BOARD_DEFAULT_SCENE_HEIGHT);
      const requiredHeight = top + (rail.offsetHeight || 0) + 12;
      if (requiredHeight > currentHeight) {
        scene.boardHeight = Math.ceil(requiredHeight);
        sceneCard.style.height = `${scene.boardHeight}px`;
      }
      const sceneBottom = (Number(scene.boardY) || 0) + Math.max(116,
        Number(scene.boardHeight) || ACT_BOARD_DEFAULT_SCENE_HEIGHT);
      boardLayer.style.minHeight = `${Math.max(
        parseFloat(boardLayer.style.minHeight) || ACT_BOARD_DEFAULT_CANVAS_HEIGHT,
        sceneBottom + 24,
      )}px`;
      return;
    }
    const railCanvasTop = mountedOnScene ? (Number(scene.boardY) || 0) + top : top;
    const railBottom = railCanvasTop + (rail.offsetHeight || 0) + 12;
    const contentItems = Array.from(boardLayer.querySelectorAll(mountedOnScene
      ? '.storyboard-act-board-node:not(.storyboard-act-board-node-link)'
      : '.storyboard-act-board-node:not(.storyboard-act-board-node-link), .storyboard-act-board-board-scene'));
    const contentTop = contentItems.reduce((min, item) => {
      const itemTop = Number.parseFloat(item.style.top);
      return Number.isFinite(itemTop) ? Math.min(min, itemTop) : min;
    }, Infinity);
    if (Number.isFinite(contentTop) && contentTop < railBottom) {
      const delta = railBottom - contentTop;
      const sceneById = new Map(actBoardScenesForAct(actKey).map(item => [item.id, item]));
      contentItems.forEach(item => {
        const itemTop = Number.parseFloat(item.style.top);
        if (!Number.isFinite(itemTop)) return;
        const nextTop = itemTop + delta;
        item.style.top = `${nextTop}px`;
        const node = sceneNodes.find(candidate => candidate.id === item.dataset.nodeId);
        if (node) node.boardY = Math.max(0, Math.round(nextTop));
        const boardScene = sceneById.get(item.dataset.boardSceneId);
        if (boardScene) boardScene.boardY = Math.max(0, Math.round(nextTop));
      });
      saveDebugSession();
    }
    const maxNodeBottom = sceneNodes.reduce((max, node, index) => {
      const position = actBoardNodePosition(node, index);
      const height = Number(node.boardHeight) > 0
        ? Number(node.boardHeight) : ACT_BOARD_NODE_STANDARD_HEIGHT;
      return Math.max(max, position.y + height);
    }, 0);
    if (mountedOnScene && sceneCard && scene) {
      const requiredHeight = top + (rail.offsetHeight || 0) + 12;
      const currentHeight = Math.max(116,
        Number(scene.boardHeight) || ACT_BOARD_DEFAULT_SCENE_HEIGHT);
      if (requiredHeight > currentHeight) {
        scene.boardHeight = Math.ceil(requiredHeight);
        sceneCard.style.height = `${scene.boardHeight}px`;
      }
    }
    const sceneBottom = scene
      ? (Number(scene.boardY) || 0) + Math.max(116,
        Number(scene.boardHeight) || ACT_BOARD_DEFAULT_SCENE_HEIGHT)
      : 0;
    const currentMinHeight = parseFloat(boardLayer.style.minHeight) || ACT_BOARD_DEFAULT_CANVAS_HEIGHT;
    boardLayer.style.minHeight = `${Math.max(currentMinHeight,
      maxNodeBottom + 24, sceneBottom + 24, top + rail.offsetHeight + 20)}px`;
    if (boardLayer._actBoardLinkState) refreshActBoardLinkPaths(boardLayer);
  };
  rail._actBoardPosition();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(rail._actBoardPosition);
  return rail;
}

function buildActBoardView(sections, assignmentsByIndex, controlsRoot = null) {
  if (ensureActBoardInitialScenes()) saveDebugSession();
  if (migrateActBoardScaffoldAudioPositions()) saveDebugSession();
  const board = document.createElement('div');
  board.className = 'storyboard-act-board-view';

  const clearBoardBtn = document.createElement('button');
  clearBoardBtn.type = 'button';
  clearBoardBtn.className = 'btn-secondary storyboard-act-board-clear-board-btn';
  clearBoardBtn.textContent = 'Clear all scenes';
  // clearBoardBtn.title = 'Remove all Act Board scenes, nodes, and links while keeping Timeline + Scenes and source material';
  const hasBoardNodes = Object.values(actBoardNodes || {})
    .some(nodes => Array.isArray(nodes) && nodes.length)
    || Object.values(actBoardScenes || {})
      .some(scenes => Array.isArray(scenes) && scenes.length);
  clearBoardBtn.disabled = !hasBoardNodes;
  clearBoardBtn.addEventListener('click', event => {
    event.stopPropagation();
    clearActBoard();
  });

  const canvas = document.createElement('div');
  canvas.className = 'storyboard-act-board-canvas';
  const boardLinkLayers = [];
  const actTargets = new Map();

  currentArcSections.forEach((act, actIndex) => {
    const column = document.createElement('section');
    column.className = 'storyboard-act-board-column';
    column.dataset.actKey = act.key;
    column.id = `storyboard-act-board-act-${actIndex + 1}`;
    actTargets.set(act.key, column);

    const columnHeader = document.createElement('div');
    columnHeader.className = 'storyboard-act-board-column-header';
    const columnTitle = document.createElement('h4');
    columnTitle.textContent = `Act ${actIndex + 1}: ${act.label}`;
    const count = document.createElement('span');
    const boardSceneCount = actBoardScenesForAct(act.key).length;
    count.textContent = `${boardSceneCount} board scene${boardSceneCount === 1 ? '' : 's'}`;
    const columnHeaderActions = document.createElement('div');
    columnHeaderActions.className = 'storyboard-act-board-column-header-actions';
    columnHeaderActions.appendChild(count);
    columnHeader.appendChild(columnTitle);
    columnHeader.appendChild(columnHeaderActions);
    column.appendChild(columnHeader);

    const nodeHeader = document.createElement('div');
    nodeHeader.className = 'storyboard-act-board-node-header';
    const nodeHeaderLabel = document.createElement('div');
    nodeHeaderLabel.className = 'storyboard-act-board-node-header-label';
    // const nodeTitle = document.createElement('strong');
    // nodeTitle.textContent = 'Act nodes';
    // nodeHeaderLabel.appendChild(nodeTitle);
    const actDescription = String(act.description || '').trim();
    if (actDescription) {
      const description = document.createElement('span');
      description.className = 'storyboard-act-board-node-header-description';
      description.textContent = actDescription;
      // The description belongs to the act title line, so it sits inline after
      // the heading rather than in a row of its own beneath the rule.
      columnHeader.insertBefore(description, columnHeaderActions);
    }
    nodeHeader.appendChild(nodeHeaderLabel);
    // Without the description this header has nothing left to show; appending
    // it anyway would leave an empty row padding the top of the canvas.
    if (nodeHeaderLabel.childElementCount) column.appendChild(nodeHeader);

    // const linkingGuide = document.createElement('div');
    // linkingGuide.className = 'storyboard-act-board-linking-guide';
    // linkingGuide.innerHTML = '<b>Board:</b> double-click blank space to add a narration or footage node. Double-click a source node, follow the temporary path, then double-click a destination node. Narration → footage attaches a shot; footage → footage changes shot order. Click a link path, then press Delete/Backspace to remove it. Drop one footage card onto another to split time, create a split screen, or merge the concepts generatively. Move cards by their blank area; drag the striped corner to resize. Press Esc to cancel.';
    // column.appendChild(linkingGuide);

    const nodeStack = document.createElement('div');
    nodeStack.className = 'storyboard-act-board-node-stack';
    nodeStack.setAttribute('aria-label',
      'Act board canvas. Drag blank space to select multiple nodes, then drag a selected node to move them together.');
    // nodeStack.title = 'Drag blank space to select multiple nodes; drag a selected node to move them together.';
    const boardScenes = actBoardScenesForAct(act.key);
    const openScene = actBoardOpenSceneForAct(act.key);
    // Only the selected scene is live on the canvas. Other defined scenes stay
    // available in the Story outline, but rendering all of their framed boards
    // here makes their headers overlap and makes it look like repeated clicks
    // loaded several scenes at once.
    const canvasScenes = boardScenes.filter(scene =>
      scene.hidden !== true && scene.id === openScene?.id);
    // Migrate older scene boards that were saved before playback belonged to
    // the scene itself. New and restored scene boards always show a playback
    // node immediately, even before narration or footage is added.
    let migratedScenePlayback = false;
    canvasScenes.forEach(scene => {
      const before = actBoardNodesForAct(act.key).some(node =>
        node.type === 'playback' && node.sceneId === scene.id);
      ensureActBoardPlaybackNode(act.key, null, { create: true, sceneId: scene.id });
      if (!before) migratedScenePlayback = true;
    });
    if (migratedScenePlayback) saveDebugSession();
    ensureActBoardSceneSnapshots(act.key);
    // Only the selected scene is rendered as a framed board behind the live
    // nodes. Other saved scenes remain available from the Story outline.
    const allLiveNodes = actBoardNodesForAct(act.key);
    // A legacy refresh could leave nodes from more than one scene in the live
    // array. Keep those nodes in their scene snapshots, but render only the
    // currently open scene so a load is visually and behaviorally exclusive.
    const activeScene = canvasScenes[0] || null;
    const activeNodeIds = new Set([
      ...(activeScene?.nodeIds || []),
      ...(activeScene?.nodeSnapshots || []).map(snapshot => snapshot?.id),
    ].filter(Boolean));
    const nodes = activeScene
      ? allLiveNodes.filter(node => activeNodeIds.has(node.id) || node.sceneId === activeScene.id)
      : allLiveNodes;
    // Playback is represented by the persistent scene playback panel now;
    // retain its saved node for scene ownership/rendering, but do not render a
    // second playback card on the canvas.
    // Narration segments live in the scene's Narration lane. Keep their data
    // in `trackNodes` for timing/playback, but do not create a duplicate
    // canvas node (including an opacity-zero shell).
    const visibleNodes = nodes.filter(node => node.type !== 'playback'
      && node.type !== 'narration' && node.trackOnly !== true);
    const trackNodes = nodes.filter(node => node.type !== 'playback');
    // A scene with only narration/audio track data is not an empty canvas;
    // those segments are intentionally represented by the scene rails rather
    // than canvas node cards. Show the empty-canvas prompt only when there is
    // no track content at all.
    if (!visibleNodes.length && !trackNodes.length) {
      const nodeEmpty = document.createElement('div');
      nodeEmpty.className = 'storyboard-act-board-node-empty';
      nodeEmpty.textContent = boardScenes.length
        ? 'Scene defined — add narration, footage, or sound effects to continue'
        : 'Add a scene to start';
      nodeStack.appendChild(nodeEmpty);
    } else {
      const ordered = orderedActBoardNodes(act.key, visibleNodes);
      // A structural fallback can occur while Visualize is in flight. Keep
      // every already-positioned footage card stable in that full render;
      // only pending shells are eligible for the measured Footage-lane pass.
      const preserveFootageNodeIds = new Set(ordered
        .filter(node => node.type === 'footage'
          && node.boardPositionMode !== 'footage-section-auto')
        .map(node => node.id));
      layoutActBoardNodeGeometry(act.key, ordered, { preserveFootageNodeIds });
      ordered.forEach((node, nodeIndex) => {
        const nodeCard = buildActBoardNode(act.key, act, node, nodeStack, nodeIndex);
        // Detailed node content is panel-only. Keep the action row on the
        // canvas so narration recording/upload controls stay on the node;
        // retain the live body wrapper for the selected-node panel.
        nodeCard._actBoardNodeBody?.remove();
        nodeStack.appendChild(nodeCard);
      });
      refineActBoardRenderedGeometry(nodeStack, ordered, { preserveFootageNodeIds });
      const maxNodeY = ordered.reduce((max, node, nodeIndex) =>
        Math.max(max, actBoardNodePosition(node, nodeIndex).y
          + (Number(node.boardHeight) > 0 ? Number(node.boardHeight)
            : ACT_BOARD_NODE_STANDARD_HEIGHT)), 0);
      nodeStack.style.minHeight = `${Math.max(ACT_BOARD_DEFAULT_CANVAS_HEIGHT, maxNodeY + 24)}px`;
    }
    const maxSceneBottom = canvasScenes.reduce((max, scene) => Math.max(max,
      (Number(scene.boardY) || 0) + Math.max(116,
        Number(scene.boardHeight) || ACT_BOARD_DEFAULT_SCENE_HEIGHT)), 0);
    nodeStack.style.minHeight = `${Math.max(ACT_BOARD_DEFAULT_CANVAS_HEIGHT, parseFloat(nodeStack.style.minHeight) || 0,
      maxSceneBottom + 24)}px`;
    column.appendChild(nodeStack);
    wireActBoardNodeSpawn(nodeStack, act.key);
    wireActBoardNodeClipboard(nodeStack, act.key);
    wireActBoardNodeMarquee(nodeStack);

    // Render the active scene frame directly on the canvas. Other saved scenes
    // are intentionally not rendered as a second card stack; they are loaded
    // from the Story outline in the full-playback panel.
    canvasScenes.forEach(scene => {
      nodeStack.appendChild(buildActBoardBoardSceneCard(scene, visibleNodes, nodeStack));
    });
    expandActBoardScenesToContainNodes(nodeStack, act.key, visibleNodes, {
      preserveNodePositions: true,
    });
    const canvasPlaybackTracks = buildActBoardCanvasPlaybackTracks(
      act.key, activeScene, nodeStack, trackNodes,
    );
    if (canvasPlaybackTracks) {
      // Mount the compact rails inside the framed working scene when one is
      // open. This makes them part of the scene canvas itself rather than a
      // separate overlay below it; empty/legacy canvases still use nodeStack.
      const sceneCanvas = activeScene
        ? Array.from(nodeStack.querySelectorAll('.storyboard-act-board-board-scene'))
          .find(card => card.dataset.boardSceneId === activeScene.id)
        : null;
      (sceneCanvas || nodeStack).appendChild(canvasPlaybackTracks);
    }
    if (activeScene) mountActBoardFootageCardsInLayer(nodeStack, activeScene);
    // Media/search cards may settle their intrinsic height after the initial
    // append. Re-run once after layout so a spawned footage chain is fully
    // enclosed by its scene board on the first render as well as on resize.
    const expandAfterLayout = () => {
      if (!document.body.contains(nodeStack)) return;
      nodeStack.querySelector('.storyboard-act-board-canvas-playback-tracks')
        ?._actBoardPosition?.();
      // Footage created by Visualize highlights or the canvas double-click is
      // marked pending until the scene's Footage lane has real dimensions.
      // Place those cards there now, without disturbing existing nodes.
      positionActBoardFootageNodesInSceneSection(nodeStack, activeScene, visibleNodes);
      expandActBoardScenesToContainNodes(nodeStack, act.key, visibleNodes, {
        preserveNodePositions: true,
      });
      saveDebugSession();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(expandAfterLayout);
    else setTimeout(expandAfterLayout, 0);
    canvas.appendChild(column);
    if (ACT_BOARD_LINKING_ENABLED && visibleNodes.length) {
      boardLinkLayers.push({ nodeStack, nodes: visibleNodes });
    }
  });

  // The first accepted arc performs several asynchronous passes (narration
  // analysis, stock/AI searches, downloads, then random preview assignment).
  // Keep that work from exposing a half-scaffolded canvas: the veil is local
  // to the acts canvas, so the surrounding controls/panels remain intact.
  if (actBoardFirstArcAutoPopulationActive) {
    canvas.setAttribute('aria-busy', 'true');
    const loadingOverlay = document.createElement('div');
    loadingOverlay.className = 'storyboard-act-board-autopopulate-loading';
    // Fallback/global veil is informational only; scene-scoped veils used by
    // incremental visualization are explicitly nonblocking as well.
    loadingOverlay.style.pointerEvents = 'none';
    loadingOverlay.setAttribute('role', 'status');
    loadingOverlay.setAttribute('aria-live', 'polite');
    const loadingCard = document.createElement('div');
    loadingCard.className = 'storyboard-act-board-autopopulate-loading-card';
    const spinner = document.createElement('span');
    spinner.className = 'storyboard-act-board-autopopulate-loading-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    const loadingTitle = document.createElement('strong');
    loadingTitle.textContent = 'Preparing your storyboard…';
    const loadingMessage = document.createElement('span');
    loadingMessage.textContent = 'Generating narration and assigning selected footage to each scene.';
    loadingCard.append(spinner, loadingTitle, loadingMessage);
    loadingOverlay.appendChild(loadingCard);
    canvas.appendChild(loadingOverlay);
  }
  const actJumpNav = document.createElement('nav');
  actJumpNav.className = 'storyboard-act-board-act-jump-nav';
  actJumpNav.setAttribute('aria-label', 'Jump to documentary act');
  const stickyLeft = document.createElement('div');
  stickyLeft.className = 'storyboard-act-board-sticky-left';
  const backToSetupButton = document.getElementById('back-to-setup-btn');
  const togglePanelsButton = document.getElementById('toggle-panels-btn');
  const exportActionGroup = controlsRoot?.querySelector?.('.render-movie-action-group') || null;
  const movableControls = [backToSetupButton, togglePanelsButton, exportActionGroup]
    .filter(Boolean)
    .map(element => {
      const placeholder = document.createComment(`restore ${element.id || element.className}`);
      element.parentNode?.insertBefore(placeholder, element);
      return { element, placeholder };
    });
  const placeControlsInStickyBar = () => {
    const back = movableControls.find(item => item.element === backToSetupButton)?.element;
    const toggle = movableControls.find(item => item.element === togglePanelsButton)?.element;
    if (back) stickyLeft.appendChild(back);
    if (toggle) stickyLeft.appendChild(toggle);
    if (stickyLeft.childElementCount) actJumpNav.insertBefore(stickyLeft, actJumpNav.firstChild);
    if (exportActionGroup) {
      board._actBoardFullPlaybackPanel?._actBoardFullPlayback?.mountExportControls?.();
    }
  };
  const restoreControlsToOriginalLocations = () => {
    board._actBoardFullPlaybackPanel?._actBoardFullPlayback?.restoreExportControls?.();
    movableControls.forEach(({ element, placeholder }) => {
      if (placeholder?.parentNode) placeholder.parentNode.insertBefore(element, placeholder.nextSibling);
    });
  };
  board._actBoardStickyControls = {
    place: placeControlsInStickyBar,
    restore: restoreControlsToOriginalLocations,
  };
  const actJumpLabel = document.createElement('span');
  actJumpLabel.className = 'storyboard-act-board-act-jump-label';
  actJumpLabel.textContent = 'Jump to act';
  actJumpNav.appendChild(actJumpLabel);
  currentArcSections.forEach((act, actIndex) => {
    const target = actTargets.get(act.key);
    if (!target) return;
    const jumpButton = document.createElement('button');
    jumpButton.type = 'button';
    jumpButton.className = 'btn-secondary storyboard-act-board-act-jump-btn';
    jumpButton.textContent = `Act ${actIndex + 1}`;
    jumpButton.title = `Jump to Act ${actIndex + 1}: ${act.label || 'Untitled act'}`;
    jumpButton.setAttribute('aria-controls', target.id);
    jumpButton.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      target.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'center' });
    });
    actJumpNav.appendChild(jumpButton);
  });
  // Keep the destructive board-wide action in the sticky navigation bar,
  // aligned flush to its right edge instead of repeating it in Act 1's
  // column header.
  clearBoardBtn.classList.add('storyboard-act-board-act-jump-clear-btn');
  actJumpNav.appendChild(clearBoardBtn);
  // Place the back/panels controls after the jump controls have been built;
  // the Premiere + MP4 export is mounted in the All acts panel when the
  // board view is active and restored to its Timeline + Scenes heading when
  // the timeline view is active.
  placeControlsInStickyBar();
  board.appendChild(actJumpNav);
  board.appendChild(canvas);
  // Keep the all-acts overview alongside the canvas rather than inside an
  // individual act column, so it remains available while navigating scenes.
  const fullPlaybackPanel = buildActBoardFullPlaybackPanel(board, exportActionGroup);
  board._actBoardFullPlaybackPanel = fullPlaybackPanel;
  board.appendChild(fullPlaybackPanel);
  // The selected scene transport is a separate viewport-anchored surface,
  // independent from the All Acts/node-content panel's scroll and height.
  const selectedScenePlaybackPanel = fullPlaybackPanel._actBoardSelectedScenePlayback;
  if (selectedScenePlaybackPanel) {
    board.appendChild(selectedScenePlaybackPanel);
  }
  // Narration segments no longer have canvas cards; the scene rail is their
  // visible/editorial surface. Initialize panel content from another visible
  // node when one exists, otherwise leave the panel on its empty state.
  const initialNodeCard = board.querySelector('.storyboard-act-board-node');
  if (initialNodeCard) {
    const initialActKey = initialNodeCard.closest('.storyboard-act-board-column')?.dataset.actKey || '';
    const initialNode = actBoardNodesForAct(initialActKey)
      .find(node => node.id === initialNodeCard.dataset.nodeId);
    const initialAct = currentArcSections.find(act => act.key === initialActKey) || null;
    if (initialNode && initialAct) {
      fullPlaybackPanel._actBoardFullPlayback?.showNodeDetails?.(
        initialActKey, initialAct, initialNode,
      );
    }
  }
  const renderBoardLinks = () => {
    if (!ACT_BOARD_LINKING_ENABLED) return;
    boardLinkLayers.forEach(({ nodeStack, nodes }) => {
      if (!nodeStack._actBoardLinkState) buildActBoardLinkLayer(nodeStack, nodes);
      else refreshActBoardLinkPaths(nodeStack);
      // Also run the deferred passes for cards whose media was already cached
      // before the link layer was created (those media events may have fired
      // during the synchronous card build).
      scheduleActBoardLinkPathRefresh(nodeStack);
    });
  };
  let dirtyGeometryActs = null;
  const refreshBoardGeometry = entries => {
    // ResizeObserver can report several descendants in one delivery. Keep a
    // small dirty-act set and perform one read/write pass in the next frame;
    // a change in one act no longer forces every act's bounds and link paths to
    // be measured repeatedly.
    if (entries && entries.length) {
      if (!dirtyGeometryActs) dirtyGeometryActs = new Set();
      entries.forEach(entry => {
        const actKey = entry.target.closest?.('.storyboard-act-board-column')?.dataset.actKey;
        if (actKey) dirtyGeometryActs.add(actKey);
      });
    } else {
      // A viewport resize can affect all columns, so deliberately invalidate
      // the complete set in that case.
      dirtyGeometryActs = null;
    }
    if (board._actBoardGeometryFrame != null) return;
    const flush = () => {
      board._actBoardGeometryFrame = null;
      if (board._actBoardDestroyed || !document.body.contains(board)) return;
      const acts = dirtyGeometryActs;
      dirtyGeometryActs = null;
      board.querySelectorAll('.storyboard-act-board-node-stack').forEach(nodeStack => {
        const actKey = nodeStack.closest('.storyboard-act-board-column')?.dataset.actKey;
        if (!actKey || (acts && !acts.has(actKey))) return;
        const nodes = orderedActBoardNodes(actKey,
          actBoardNodesForAct(actKey).filter(node => node.type !== 'playback'));
        layoutActBoardNodeGeometry(actKey, nodes);
        refineActBoardRenderedGeometry(nodeStack, nodes);
        expandActBoardScenesToContainNodes(nodeStack, actKey, nodes);
        nodeStack.querySelector('.storyboard-act-board-canvas-playback-tracks')
          ?._actBoardPosition?.();
        if (nodeStack._actBoardLinkState) refreshActBoardLinkPaths(nodeStack);
      });
    };
    if (typeof requestAnimationFrame === 'function') {
      board._actBoardGeometryFrame = requestAnimationFrame(flush);
    } else {
      board._actBoardGeometryFrame = setTimeout(flush, 0);
    }
  };
  if (typeof ResizeObserver === 'function') {
    const resizeObserver = new ResizeObserver(refreshBoardGeometry);
    resizeObserver.observe(canvas);
    board.querySelectorAll('.storyboard-act-board-node-stack').forEach(nodeStack => {
      resizeObserver.observe(nodeStack);
    });
    board._actBoardResizeObserver = resizeObserver;
  }
  if (typeof window !== 'undefined') {
    if (activeActBoardResizeHandler) {
      window.removeEventListener('resize', activeActBoardResizeHandler);
    }
    activeActBoardResizeHandler = () => {
      if (document.body.contains(board)) refreshBoardGeometry();
    };
    window.addEventListener('resize', activeActBoardResizeHandler);
  }
  // Build the link layer immediately so a fast double-click after the board
  // appears can start a connection. The deferred pass still recalculates
  // paths after the browser has completed layout.
  renderBoardLinks();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(renderBoardLinks);
  else setTimeout(renderBoardLinks, 0);
  // Index the live board once after its initial construction. Incremental
  // scene patches reuse these stable references until teardown.
  refreshActBoardDomRegistry(board);
  return board;
}

// The current render's window scroll listener for highlighting the
// narrative-arc outline entry the presenter's scrolled past - module-level
// so the next renderMovieEditor call can remove it before attaching its
// own (each render tears down and rebuilds every row/outline element, so
// leaving a previous render's listener attached would reference stale,
// already-detached DOM going forward).
let activeOutlineScrollHandler = null;

