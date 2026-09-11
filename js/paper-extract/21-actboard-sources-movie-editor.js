// storyboard.html's "Source material" sidebar module
// (#source-material-module) - a read-only reference listing of the
// extracted paper sections, kept in sync with currentSections (see the
// call at the end of renderMovieEditor below, and the page-2 branch of
// restoreDebugSession for the first render). Excludes narrativeOnly
// sections (see insertSection) - blank placeholders added for the arc's
// structure, not derived from the paper, shouldn't read as if they were.
// Deliberately not built from buildSectionBlock/renderSectionFeed like
// index.html's own editable feed - every one of those cards' edit/remove/
// upload handlers hardcodes its re-render target to the single shared
// #paper-sections container (the movie editor here), so reusing them in
// this second, simultaneous location would clobber it instead of
// updating this list.
function renderSourceMaterialList() {
  if (!sourceMaterialListEl) return;
  sourceMaterialListEl.innerHTML = '';
  currentSections.filter(section => !section.removed && !section.narrativeOnly).forEach(section => {
    const item = document.createElement('div');
    item.className = 'source-material-item';

    // Draggable onto a section's text field (see buildSectionBlock's drop
    // handler) - a quick way to pull this excerpt into a shot's own
    // working text without retyping it. Carries the section's own stable
    // index, not its text directly - the drop handler looks the current
    // text up fresh from currentSections at drop time, in case it's since
    // been edited.
    item.draggable = true;
    item.addEventListener('dragstart', event => {
      event.dataTransfer.setData('application/x-source-material-index', String(section.index));
      event.dataTransfer.effectAllowed = 'copy';
    });

    const title = document.createElement('div');
    title.className = 'source-material-item-title';
    title.textContent = section.title;
    item.appendChild(title);

    // Delete this source section (moves it to the "Deleted source and scenes"
    // module, where it can be restored). Same removed-flag mechanism scenes use.
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'source-material-item-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Delete this source section (move to Deleted source and scenes)';
    removeBtn.addEventListener('click', event => {
      event.stopPropagation();
      section.removed = true;
      saveDebugSession();
      // renderMovieEditor's tail re-renders both the source and deleted lists.
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      updateComposeStoryboardVisibility();
    });
    item.appendChild(removeBtn);

    if (section.text) {
      const excerpt = document.createElement('div');
      excerpt.className = 'source-material-item-excerpt';
      excerpt.textContent = section.text.length > 140 ? `${section.text.slice(0, 140)}…` : section.text;
      item.appendChild(excerpt);
    }

    sourceMaterialListEl.appendChild(item);
  });
}

// storyboard.html's "Deleted scenes" sidebar module (#deleted-scenes-module)
// - the scenes deleted from the arranged view (see buildSectionBlock's remove
// button, which in the arranged view drops a scene from the timeline and its
// arc row entirely rather than dimming it in place). Each lists a Restore
// button that puts the item back. Source deletion (`removed`) is deliberately
// distinct from timeline deletion (`sceneRemoved`) so clearing the storyboard
// never empties the source-material library. The whole module hides itself
// when nothing is deleted, so it doesn't sit empty in the sidebar. A no-op on
// index.html, which has no such module.
function renderDeletedScenesList() {
  if (!deletedScenesListEl) return;
  deletedScenesListEl.innerHTML = '';
  const deleted = currentSections.filter(section => section.removed || section.sceneRemoved);
  if (deletedScenesModuleEl) deletedScenesModuleEl.style.display = deleted.length ? '' : 'none';

  deleted.forEach(section => {
    const item = document.createElement('div');
    item.className = 'deleted-scene-item';

    const title = document.createElement('div');
    title.className = 'deleted-scene-item-title';
    title.textContent = section.title || '(untitled scene)';
    item.appendChild(title);

    const restoreBtn = document.createElement('button');
    restoreBtn.type = 'button';
    restoreBtn.className = 'btn-secondary deleted-scene-restore-btn';
    restoreBtn.textContent = 'Restore';
    restoreBtn.addEventListener('click', () => {
      section.removed = false;
      section.sceneRemoved = false;
      saveDebugSession();
      // renderMovieEditor re-renders this list from its own tail call, so the
      // restored scene reappears in its arc row/timeline and leaves here.
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      updateComposeStoryboardVisibility();
    });
    item.appendChild(restoreBtn);

    deletedScenesListEl.appendChild(item);
  });
}

function renderMovieEditor(container, label, sections, assignmentsByIndex) {
  // Rebuilding scene timing invalidates every scheduled Web Audio source.
  // Stop the transport before replacing its layout so no old mix continues
  // invisibly against the newly-rendered timeline.
  stopSfxPreview(true);
  activeSfxLayout = null;
  activeSfxSectionIndex = null;
  // The board view is rebuilt below; detach the old all-acts panel reference
  // so background render completion updates only the current panel instance.
  actBoardFullPlaybackPanel = null;
  // The Act Board temporarily moves the page-level controls into its sticky
  // jump bar. Restore them before replacing the render tree so a rerender
  // cannot remove the controls from the document entirely.
  container.querySelectorAll('.storyboard-act-board-view').forEach(view => {
    view._actBoardStickyControls?.restore?.();
  });
  container.innerHTML = '';

  // Prune any selected index no longer present (excluded/removed) - no more
  // default "select the first section" fallback, since there's no preview
  // left to seed; an empty selection is a perfectly normal starting state.
  selectedSectionIndices.forEach(index => {
    if (!sections.some(s => s.index === index && !s.sceneRemoved)) selectedSectionIndices.delete(index);
  });

  const selectionCount = selectedSectionIndices.size;
  const arranged = sections.filter(s => !s.sceneRemoved && assignmentsByIndex[s.index]);
  const target = selectionCount > 0 ? arranged.filter(s => selectedSectionIndices.has(s.index)) : arranged;

  // Heading row: action buttons pinned to the far right (see
  // .storyboard-heading-row / .storyboard-heading-actions) - "Clear
  // all scenes" then one combined export. Keep the action row mounted for an
  // accepted storyboard even when its timeline is empty: clearing scenes must
  // not make the surrounding controls disappear. Actions that require an
  // active scene are disabled until one is restored or added.
  renderMovieBtn = null;
  renderMovieStatusEl = null;
  renderMovieDownloadEl = null;
  renderMovieOutputUrl = '';
  const headingRow = document.createElement('div');
  headingRow.className = 'storyboard-heading-row';
  let previewAllBtn = null;
  let previewAllStatus = null;
  let clearAllBtn = null;
  if (currentArcSections.length > 0) {
    const actions = document.createElement('div');
    actions.className = 'storyboard-heading-actions';

    // "Preview All" - generate bold shot examples for every arranged scene
    // that doesn't have a visual yet (see runPreviewAllShots). Sits to the LEFT
    // of Clear all scenes.
    previewAllBtn = document.createElement('button');
    previewAllBtn.type = 'button';
    previewAllBtn.id = 'preview-all-btn';
    previewAllBtn.className = 'btn-secondary preview-all-btn';
    previewAllBtn.textContent = 'Generate All';
    previewAllBtn.title = 'Generate shot examples for every arranged scene that has no visual yet';
    previewAllBtn.addEventListener('click', runPreviewAllShots);
    previewAllBtn.disabled = generatingAllShots || arranged.length === 0;
    if (arranged.length === 0) previewAllBtn.title = 'Restore or add a scene before generating previews';
    actions.appendChild(previewAllBtn);
    previewAllStatus = document.createElement('span');
    previewAllStatus.className = 'status-line preview-all-status';
    actions.appendChild(previewAllStatus);

    clearAllBtn = document.createElement('button');
    clearAllBtn.type = 'button';
    clearAllBtn.className = 'btn-secondary clear-all-scenes-btn';
    clearAllBtn.textContent = 'Clear all scenes';
    clearAllBtn.title = 'Move every scene to Deleted scenes while keeping source material';
    clearAllBtn.disabled = arranged.length === 0;
    clearAllBtn.addEventListener('click', () => {
      if (!window.confirm("Clear all scenes from the timeline? They'll move to Deleted scenes, where you can restore them. Your source material will stay available.")) return;
      currentSections.forEach(s => {
        if (currentAssignments[s.index] && !s.removed) {
          cancelSceneGeneration(s);
          s.sceneRemoved = true;
        }
      });
      selectedSectionIndices.clear();
      saveDebugSession();
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
    });
    actions.appendChild(clearAllBtn);

    const renderMovieActionGroup = document.createElement('div');
    renderMovieActionGroup.className = 'render-movie-action-group';
    renderMovieBtn = document.createElement('button');
    renderMovieBtn.type = 'button';
    renderMovieBtn.className = 'btn-primary render-movie-btn';
    renderMovieBtn.textContent = 'Export premiere + MP4';
    renderMovieBtn.title = 'Write a Premiere edit plan and render the documentary as an MP4, including linked act-board sequences';
    renderMovieBtn.disabled = arranged.length === 0 && !hasActBoardLinkedSequence();
    renderMovieBtn.addEventListener('click', runCombinedExport);
    renderMovieActionGroup.appendChild(renderMovieBtn);

    renderMovieStatusEl = document.createElement('span');
    renderMovieStatusEl.className = 'status-line render-movie-status';
    renderMovieActionGroup.appendChild(renderMovieStatusEl);

    // The MP4 is produced asynchronously. Keep a real download control next
    // to the status instead of making the user copy a server path out of the
    // status text once the render is finished.
    renderMovieDownloadEl = document.createElement('a');
    renderMovieDownloadEl.className = 'render-movie-download';
    renderMovieDownloadEl.textContent = 'Download MP4';
    renderMovieDownloadEl.setAttribute('download', 'documentary.mp4');
    renderMovieDownloadEl.target = '_blank';
    renderMovieDownloadEl.rel = 'noopener';
    renderMovieDownloadEl.hidden = true;
    renderMovieActionGroup.appendChild(renderMovieDownloadEl);
    actions.appendChild(renderMovieActionGroup);

    headingRow.appendChild(actions);
  }
  container.appendChild(headingRow);

  const actionBar = document.createElement('div');
  actionBar.className = 'action-bar';

  const topRow = document.createElement('div');
  topRow.className = 'action-bar-row';

  const countLabel = document.createElement('span');
  countLabel.textContent = selectionCount > 0
    ? `${selectionCount} section${selectionCount === 1 ? '' : 's'} selected`
    : `${arranged.length} section${arranged.length === 1 ? '' : 's'} in the arc`;
  topRow.appendChild(countLabel);

  const storyboardBtn = document.createElement('button');
  storyboardBtn.type = 'button';
  storyboardBtn.className = 'btn-secondary';
  storyboardBtn.textContent = selectionCount > 0 ? 'Generate Storyboard for Selected' : 'Generate Storyboard for All';
  storyboardBtn.addEventListener('click', () => {
    runGenerateStoryboardForSections(target, storyboardBtn);
  });
  topRow.appendChild(storyboardBtn);

  // Inline right next to its button (not stacked below, full-width) so the
  // sticky bar stays thin regardless of status text length.
  const storyboardStatusEl = document.createElement('span');
  storyboardStatusEl.className = 'status-line storyboard-status-line';
  storyboardStatusEl.textContent = storyboardBarStatus.message;
  storyboardStatusEl.classList.toggle('error', storyboardBarStatus.isError);
  topRow.appendChild(storyboardStatusEl);

  const editPlanBtn = document.createElement('button');
  editPlanBtn.type = 'button';
  editPlanBtn.className = 'btn-secondary';
  editPlanBtn.textContent = selectionCount > 0 ? 'Generate Edit Plan for Selected' : 'Generate Edit Plan for All';
  editPlanBtn.addEventListener('click', () => {
    runGenerateEditPlanForSections(target, editPlanBtn);
  });
  topRow.appendChild(editPlanBtn);

  const editPlanStatusEl = document.createElement('span');
  editPlanStatusEl.className = 'status-line edit-plan-status-line';
  editPlanStatusEl.textContent = editPlanBarStatus.message;
  editPlanStatusEl.classList.toggle('error', editPlanBarStatus.isError);
  topRow.appendChild(editPlanStatusEl);

  if (selectionCount > 0) {
    const clearSelectionBtn = document.createElement('button');
    clearSelectionBtn.type = 'button';
    clearSelectionBtn.className = 'btn-secondary';
    clearSelectionBtn.textContent = 'Clear Selection';
    clearSelectionBtn.addEventListener('click', () => {
      selectedSectionIndices.clear();
      renderMovieEditor(resultsEl, currentLabel, sections, assignmentsByIndex);
    });
    topRow.appendChild(clearSelectionBtn);
  }

  actionBar.appendChild(topRow);
  container.appendChild(actionBar);

  const storyboardViewToggle = document.createElement('div');
  storyboardViewToggle.className = 'storyboard-view-toggle';
  const timelineViewBtn = document.createElement('button');
  timelineViewBtn.type = 'button';
  timelineViewBtn.className = 'storyboard-view-toggle-btn';
  timelineViewBtn.dataset.view = 'timeline';
  timelineViewBtn.textContent = 'Timeline + scenes';
  const boardViewBtn = document.createElement('button');
  boardViewBtn.type = 'button';
  boardViewBtn.className = 'storyboard-view-toggle-btn';
  boardViewBtn.dataset.view = 'board';
  boardViewBtn.textContent = 'Act board';
  storyboardViewToggle.appendChild(timelineViewBtn);
  storyboardViewToggle.appendChild(boardViewBtn);
  container.appendChild(storyboardViewToggle);

  // Premiere-style A-roll/B-roll timeline (see buildNarrativeTimeline) -
  // sits above the rows, one act-sized group per arc part with individual
  // clips per section - replaces the old vertical .narrative-arc-outline
  // sidebar as the "jump to a part of the arc" affordance. Built AFTER the
  // row loop below (not interleaved with it), since that loop is what
  // auto-populates any still-empty act with a blank placeholder section -
  // the timeline needs that final, post-auto-populate section list, not
  // the possibly-incomplete one from before the loop runs.
  const arcLayout = document.createElement('div');
  arcLayout.className = 'narrative-arc-layout';
  const boardView = document.createElement('div');
  boardView.className = 'storyboard-act-board-container';

  const timelineEl = document.createElement('div');
  timelineEl.className = 'premiere-timeline';
  arcLayout.appendChild(timelineEl);

  const updateHeight = () => {
    document.documentElement.style.setProperty(
      '--header-height',
      `${timelineEl.offsetHeight}px`
    );
  };

  updateHeight();
  new ResizeObserver(updateHeight).observe(timelineEl);

  // Below the timeline: a sidebar (Documentary techniques) beside the rows.
  const innerLayout = document.createElement('div');
  innerLayout.className = 'narrative-arc-inner-layout';
  arcLayout.appendChild(innerLayout);

  const sidePanel = document.createElement('div');
  sidePanel.className = 'narrative-side-panel';
  innerLayout.appendChild(sidePanel);

  // Documentary modes - a thin, dark strip that lives INSIDE the premiere
  // timeline, above its tracks (inserted after buildNarrativeTimeline builds
  // the timeline - see below). Label, chips, and a hint all sit on one row so
  // the strip stays short. Each chip both clicks (sets the global stylistic
  // mode for storyboard/edit-plan generation) AND drags onto a timeline act
  // to scaffold that act's scenes (see makeActModeDropTarget / scaffoldModeOntoAct).
  const modesBlock = document.createElement('div');
  modesBlock.className = 'documentary-modes-bar';

  const modesTitle = document.createElement('span');
  modesTitle.className = 'documentary-modes-bar-title';
  modesTitle.textContent = 'Documentary layouts';
  modesBlock.appendChild(modesTitle);

  const modesRow = document.createElement('div');
  modesRow.className = 'chip-row documentary-modes-bar-row';
  modesBlock.appendChild(modesRow);

  DOCUMENTARY_MODES.forEach(mode => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip suggested chip-draggable';
    chip.classList.toggle('selected', selectedDocumentaryMode === mode.key);
    chip.textContent = mode.label;
    chip.title = `${mode.description} — drag onto a timeline act to scaffold its scenes`;
    chip.addEventListener('click', () => {
      // Toggle, same as the technique chips below - clicking the
      // already-active mode clears back to "no mode chosen."
      selectedDocumentaryMode = selectedDocumentaryMode === mode.key ? null : mode.key;
      modesRow.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
      chip.classList.toggle('selected', selectedDocumentaryMode === mode.key);
      // Picking a mode is the other half of triggerFindFootageSweep's
      // precondition (alongside a drafted storyboard) - a no-op here if
      // there's no storyboard yet.
      triggerFindFootageSweep();
      // selectedDocumentaryMode is deliberately not persisted (see its own
      // comment) - no saveDebugSession call here, same as the arc-template/
      // arc-suggestion picks it's grouped with.
    });
    // Draggable onto a timeline act (see buildNarrativeTimeline's
    // makeActModeDropTarget) to scaffold that act's scenes from this mode.
    chip.draggable = true;
    chip.addEventListener('dragstart', event => {
      event.dataTransfer.setData('application/x-documentary-mode', mode.key);
      event.dataTransfer.effectAllowed = 'copy';
    });
    modesRow.appendChild(chip);
  });

  const modesHint = document.createElement('span');
  modesHint.className = 'documentary-modes-bar-hint';
  modesHint.textContent = 'Drag onto an act to scaffold its scenes.';
  modesBlock.appendChild(modesHint);

  const insertModesIntoTimeline = () => {
    if (!timelineBuilt || modesBlock.parentElement === timelineEl) return;
    const timelineHeader = timelineEl.querySelector('.premiere-timeline-header');
    timelineEl.insertBefore(modesBlock,
      timelineHeader ? timelineHeader.nextSibling : timelineEl.firstChild);
  };

  // Standard filmmaking techniques and moodboard-distilled suggestions are
  // separate toggleable views so the provenance of a technique is always
  // clear. The moodboard view is intentionally first/default.
  const techniquesBlock = document.createElement('div');
  techniquesBlock.className = 'narrative-arc-techniques';

  const techniquesTitle = document.createElement('span');
  techniquesTitle.textContent = 'Documentary techniques';
  techniquesBlock.appendChild(techniquesTitle);

  const techniqueViewToggle = document.createElement('div');
  techniqueViewToggle.className = 'technique-view-toggle';
  const moodboardViewBtn = document.createElement('button');
  moodboardViewBtn.type = 'button';
  moodboardViewBtn.className = 'technique-view-toggle-btn';
  moodboardViewBtn.setAttribute('aria-label', 'Show moodboard-distilled techniques');
  moodboardViewBtn.title = 'Moodboard distilled techniques';
  const standardViewBtn = document.createElement('button');
  standardViewBtn.type = 'button';
  standardViewBtn.className = 'technique-view-toggle-btn';
  standardViewBtn.setAttribute('aria-label', 'Show standard filmmaking toolkit');
  standardViewBtn.title = 'Standard filmmaking toolkit';
  techniqueViewToggle.appendChild(moodboardViewBtn);
  techniqueViewToggle.appendChild(standardViewBtn);
  techniquesBlock.appendChild(techniqueViewToggle);

  const moodboardView = document.createElement('div');
  moodboardView.className = 'technique-view technique-view-moodboard';
  const standardView = document.createElement('div');
  standardView.className = 'technique-view technique-view-standard';
  // Moodboard distilled is appended first so it remains the first view for
  // keyboard navigation and for narrow layouts.
  techniquesBlock.appendChild(moodboardView);
  techniquesBlock.appendChild(standardView);

  const updateTechniqueView = () => {
    const moodboardActive = techniquePanelView === 'moodboard';
    moodboardView.style.display = moodboardActive ? '' : 'none';
    standardView.style.display = moodboardActive ? 'none' : '';
    moodboardViewBtn.classList.toggle('active', moodboardActive);
    standardViewBtn.classList.toggle('active', !moodboardActive);
    moodboardViewBtn.setAttribute('aria-selected', String(moodboardActive));
    standardViewBtn.setAttribute('aria-selected', String(!moodboardActive));
    moodboardViewBtn.setAttribute('aria-pressed', String(moodboardActive));
    standardViewBtn.setAttribute('aria-pressed', String(!moodboardActive));
  };
  moodboardViewBtn.addEventListener('click', () => {
    techniquePanelView = 'moodboard';
    updateTechniqueView();
  });
  standardViewBtn.addEventListener('click', () => {
    techniquePanelView = 'standard';
    updateTechniqueView();
  });

  const standardHeading = document.createElement('div');
  standardHeading.className = 'technique-source-label standard';
  standardHeading.textContent = 'Standard filmmaking toolkit';
  standardView.appendChild(standardHeading);
  const standardHint = document.createElement('div');
  standardHint.className = 'chip-row-caption';
  standardHint.textContent = 'Common composition and lighting choices. Drag onto scenes to apply.';
  standardView.appendChild(standardHint);

  STANDARD_TECHNIQUE_GROUPS.forEach(group => {
    const catLabel = document.createElement('div');
    catLabel.className = 'technique-category-label';
    catLabel.textContent = group.label;
    standardView.appendChild(catLabel);
    const row = document.createElement('div');
    row.className = 'chip-row';
    group.techniques.forEach(technique => row.appendChild(buildTechniqueChip(technique, {
      selectable: false,
      standard: true,
      moodboardDerived: selectedTechniques.has(technique),
    })));
    standardView.appendChild(row);
  });

  const moodboardHeading = document.createElement('div');
  moodboardHeading.className = 'technique-source-label moodboard';
  moodboardHeading.textContent = 'Distilled from your moodboard';
  moodboardView.appendChild(moodboardHeading);
  const techniquesHint = document.createElement('div');
  techniquesHint.className = 'chip-row-caption';
  techniquesHint.textContent = 'Moodboard-specific suggestions. Click to include/exclude, or drag onto scenes.';
  moodboardView.appendChild(techniquesHint);

  // Keep the complete distilled set in its own view, including techniques that
  // also appear in the standard toolkit. The standard view separately marks
  // those overlaps so their provenance remains visible in either view.
  const selectedByCategory = new Map();
  Array.from(selectedTechniques)
    .forEach(technique => {
      const cat = TECHNIQUE_CATEGORY[technique] || 'other';
      if (!selectedByCategory.has(cat)) selectedByCategory.set(cat, []);
      selectedByCategory.get(cat).push(technique);
    });
  [...TECHNIQUE_CATEGORY_ORDER, { key: 'other', label: 'Other' }].forEach(({ key, label }) => {
    const items = selectedByCategory.get(key);
    if (!items || !items.length) return;
    const catLabel = document.createElement('div');
    catLabel.className = 'technique-category-label';
    catLabel.textContent = label;
    moodboardView.appendChild(catLabel);
    const row = document.createElement('div');
    row.className = 'chip-row';
    items.forEach(technique => row.appendChild(buildTechniqueChip(technique)));
    moodboardView.appendChild(row);
  });
  if (!selectedTechniques.size) {
    const emptyMoodboard = document.createElement('div');
    emptyMoodboard.className = 'technique-source-empty';
    emptyMoodboard.textContent = 'Add a moodboard reference to see distilled techniques here.';
    moodboardView.appendChild(emptyMoodboard);
  }
  // Keep the distilled moodboard rationale with the techniques it explains,
  // rather than placing it in the timeline's layout strip.
  if (distilledStyleRationale) {
    const rationaleEl = document.createElement('div');
    rationaleEl.className = 'distilled-style-rationale llm-generated';
    const rationaleLabel = document.createElement('strong');
    rationaleLabel.textContent = 'Moodboard styles:';
    rationaleEl.appendChild(rationaleLabel);
    rationaleEl.appendChild(document.createTextNode(` ${distilledStyleRationale}`));
    moodboardView.appendChild(rationaleEl);
  }
  updateTechniqueView();
  sidePanel.appendChild(techniquesBlock);

  // "Preview All" (generates shot examples for every empty scene) lives in the
  // storyboard heading actions now - see the heading row above.

  const arcRows = document.createElement('div');
  arcRows.className = 'narrative-arc-rows';
  innerLayout.appendChild(arcRows);

  currentArcSections.forEach((act, actIdx) => {
    let rowSections = sections.filter(s => !s.sceneRemoved && assignmentsByIndex[s.index] === act.key);
    const actHasDeletedScenes = currentSections.some(s =>
      assignmentsByIndex[s.index] === act.key && (s.removed || s.sceneRemoved));

    // A never-populated act gets one functional starter scene. If the act is
    // empty because its scenes were deliberately deleted, leave it empty;
    // recreating a blank here would make Clear all scenes undo itself and
    // would trigger narration autofill again after a refresh.
    if (rowSections.length === 0 && !actHasDeletedScenes) {
      const blank = insertSection(-1, 'New Scene', '', act.key, true);
      sections.push(blank);
      rowSections = [blank];
      saveDebugSession();
    }

    // A heading (title + short description of what this part should
    // illustrate) sits above the row, rather than as a side label running
    // the row's full height - reads more like a section heading than a
    // vertical label column.
    const rowGroup = document.createElement('div');
    rowGroup.className = 'narrative-act-row-group';

    const heading = document.createElement('div');
    heading.className = 'narrative-act-heading';
    const actTitle = document.createElement('div');
    actTitle.className = 'narrative-act-title';
    actTitle.textContent = `Act ${actIdx + 1}: ${act.label}`;
    heading.appendChild(actTitle);
    // The arc part's description moved into each scene's narration line (the
    // narration instructions - see buildSectionBlock), so it's no longer
    // shown here in the act heading.
    rowGroup.appendChild(heading);

    const row = document.createElement('div');
    row.className = 'narrative-act-row';
    // preventDefault so a drop is allowed, but deliberately NO drag-over
    // outline on the row itself (the presenter found the row-level highlight
    // noisy - the scene cards / notes still highlight on their own).
    row.addEventListener('dragover', event => { event.preventDefault(); });
    row.addEventListener('drop', event => {
      // A paper section dragged from the Source material module onto an act
      // feeds its text into that act's FIRST scene's Scene Notes, rather than
      // becoming its own scene (see appendSectionTextToFirstScene). Everything
      // else (a scene chip being reordered/reassigned) goes to handleChipDrop.
      const sourceIdxRaw = event.dataTransfer.getData('application/x-source-material-index');
      if (sourceIdxRaw !== '') {
        event.preventDefault();
        const src = currentSections.find(s => s.index === parseInt(sourceIdxRaw, 10));
        if (src && appendSectionTextToFirstScene(act.key, src)) {
          saveDebugSession();
          const remaining = currentSections.filter(s => !s.removed);
          renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
        }
        return;
      }
      handleChipDrop(event, act.key);
    });
    rowGroup.appendChild(row);

    const rowCards = document.createElement('div');
    rowCards.className = 'narrative-act-row-cards';

    // Compact chip strip - a smaller, quicker click target alongside each
    // section's full card below, both funneling into the same
    // handleSectionClick selection (see buildArcRowChip).
    const chips = document.createElement('div');
    chips.className = 'narrative-act-row-chips';
    rowSections.forEach(section => chips.appendChild(buildArcRowChip(section)));
    rowCards.appendChild(chips);

    rowSections.forEach(section => rowCards.appendChild(buildSectionBlock(section, true)));

    const addSectionBtn = document.createElement('button');
    addSectionBtn.type = 'button';
    addSectionBtn.className = 'add-section-btn';
    addSectionBtn.textContent = '+ Add Scene';
    addSectionBtn.addEventListener('click', () => {
      const lastInRow = rowSections[rowSections.length - 1];
      insertSection(lastInRow ? lastInRow.index : -1, 'New Scene', '', act.key, true);
      const remaining = currentSections.filter(section => !section.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      saveDebugSession();
    });
    rowCards.appendChild(addSectionBtn);

    row.appendChild(rowCards);

    arcRows.appendChild(rowGroup);
  });

  // The Act Board is the default view. Defer the comparatively expensive
  // Premiere timeline construction until the presenter actually opens that
  // view; the timeline's DOM/listeners are not needed while the board is
  // active. The closure is intentionally local to this render so a later
  // board rebuild gets a fresh, consistent timeline.
  let timelineBuild = null;
  let clipsBySectionIndex = new Map();
  let timelineLayout = { sceneStartSeconds: new Map() };
  let timelineBuilt = false;
  const ensureTimelineBuilt = () => {
    if (timelineBuilt) return;
    timelineBuild = buildNarrativeTimeline(
      timelineEl,
      sections.filter(section => !section.sceneRemoved),
      assignmentsByIndex,
    );
    clipsBySectionIndex = timelineBuild.clipsBySectionIndex;
    timelineLayout = timelineBuild.layout;
    timelineBuilt = true;
    if (typeof insertModesIntoTimeline === 'function') insertModesIntoTimeline();
    setupTimelineScrollSpy();
  };

  const actBoardView = buildActBoardView(
    sections.filter(section => !section.sceneRemoved),
    assignmentsByIndex,
    container,
  );
  boardView.appendChild(actBoardView);

  const updateStoryboardView = () => {
    const boardActive = storyboardView === 'board';
    // The Act Board is a full-window workspace. Keep a body-level hook so its
    // viewport layer and the page-level controls can be styled together,
    // without changing the established Timeline + Scenes layout.
    document.body.classList.toggle('act-board-active', boardActive);
    arcLayout.style.display = boardActive ? 'none' : '';
    boardView.style.display = boardActive ? '' : 'none';
    // Generate All and Clear all scenes belong to Timeline + scenes. Export is
    // moved into the Act Board's sticky jump bar while that view is active.
    if (previewAllBtn) previewAllBtn.style.display = boardActive ? 'none' : '';
    if (previewAllStatus) previewAllStatus.style.display = boardActive ? 'none' : '';
    if (clearAllBtn) clearAllBtn.style.display = boardActive ? 'none' : '';
    if (boardActive) actBoardView._actBoardStickyControls?.place?.();
    else actBoardView._actBoardStickyControls?.restore?.();
    timelineViewBtn.classList.toggle('active', !boardActive);
    boardViewBtn.classList.toggle('active', boardActive);
    timelineViewBtn.setAttribute('aria-pressed', String(!boardActive));
    boardViewBtn.setAttribute('aria-pressed', String(boardActive));
    if (boardActive) {
      const refreshVisibleBoardLinks = () => boardView.querySelectorAll('.storyboard-act-board-node-stack')
        .forEach(stack => {
          const actKey = stack.closest('.storyboard-act-board-column')?.dataset.actKey;
          if (actKey) {
            const nodes = orderedActBoardNodes(actKey,
              actBoardNodesForAct(actKey).filter(item => item.type !== 'playback'));
            layoutActBoardNodeGeometry(actKey, nodes);
            refineActBoardRenderedGeometry(stack, nodes);
          }
          if (stack._actBoardLinkState) refreshActBoardLinkPaths(stack);
        });
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(refreshVisibleBoardLinks);
      else setTimeout(refreshVisibleBoardLinks, 0);
    }
  };
  timelineViewBtn.addEventListener('click', () => {
    ensureTimelineBuilt();
    storyboardView = 'timeline';
    updateStoryboardView();
  });
  boardViewBtn.addEventListener('click', () => {
    storyboardView = 'board';
    updateStoryboardView();
  });
  // The Documentary modes strip lives INSIDE the timeline, above its ruler/
  // tracks - inserted here (not earlier) because buildNarrativeTimeline clears
  // timelineEl's contents when it (re)builds the ruler and tracks.
  // Build the active view after all controls exist. The default Act Board path
  // does not build the hidden Premiere timeline; a restored timeline view is
  // still built immediately so its behavior remains unchanged.
  updateStoryboardView();
  if (storyboardView === 'timeline') ensureTimelineBuilt();

  container.appendChild(arcLayout);
  container.appendChild(boardView);

  const selectedCard = container.querySelector('.narrative-act-row-cards .paper-section-block.selected');
  if (selectedCard) selectedCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  function setupTimelineScrollSpy() {
    // Highlights whichever section's timeline clips the presenter has scrolled
    // past. This listener is attached only after the timeline is built, rather
    // than on every Act Board render.
    if (activeOutlineScrollHandler) {
      window.removeEventListener('scroll', activeOutlineScrollHandler);
      activeOutlineScrollHandler = null;
    }
    const sectionScrollEntries = Array.from(
      arcRows.querySelectorAll('.paper-section-block[data-section-index]'),
    ).map(block => {
      const clips = clipsBySectionIndex.get(parseInt(block.dataset.sectionIndex, 10));
      return clips ? { block, clips } : null;
    }).filter(Boolean);
    if (!sectionScrollEntries.length) return;
    const updateActiveTimelineClip = () => {
      let activeEntry = sectionScrollEntries[0];
      sectionScrollEntries.forEach(entry => {
        if (entry.block.getBoundingClientRect().top <= OUTLINE_ACTIVE_THRESHOLD_PX) activeEntry = entry;
      });
      sectionScrollEntries.forEach(entry => {
        const isActive = entry === activeEntry;
        entry.clips.forEach(clip => clip.classList.toggle('active', isActive));
      });
      const activeIndex = parseInt(activeEntry.block.dataset.sectionIndex, 10);
      if (activeSfxSectionIndex !== activeIndex) {
        activeSfxSectionIndex = activeIndex;
        if (!sfxPreviewEnabled) {
          timelinePreviewPausedTime = null;
          timelinePreviewPausedSectionIndex = null;
        }
        const start = timelineLayout.sceneStartSeconds.get(activeIndex);
        const autoFollowing = performance.now() < timelinePreviewProgrammaticScrollUntil;
        if (sfxPreviewEnabled && start != null && !autoFollowing) startSfxPreviewAt(start);
        else if (start != null) updateSfxPlayhead(start);
      }
    };
    let ticking = false;
    activeOutlineScrollHandler = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        updateActiveTimelineClip();
        ticking = false;
      });
    };
    window.addEventListener('scroll', activeOutlineScrollHandler, { passive: true });
    updateActiveTimelineClip();
  }

  // Keeps the sidebar's read-only listing in sync with every change that
  // lands here too (a section added/reassigned from within this page, an
  // exclude toggled, text edited, ...) - a no-op on index.html, which never
  // calls renderMovieEditor in the first place.
  renderSourceMaterialList();
  renderDeletedScenesList();
}

// --- Rendering: a section block is the same clickable unit whether it's
// sitting in the flat feed or inside one of the narrative-arc columns -
// its removability doesn't depend on which container it's in. Once a
// storyboard has been generated, it also grows a Visual/Narration sub-block.
function appendStoryboardLine(container, label, text) {
  const line = document.createElement('div');
  line.className = 'paper-section-storyboard-line';
  const labelEl = document.createElement('span');
  labelEl.className = 'paper-section-storyboard-label';
  labelEl.textContent = `${label}: `;
  line.appendChild(labelEl);
  line.appendChild(document.createTextNode(text));
  container.appendChild(line);
}

// --- Stock media ("Find Footage"): fetched on demand per section, not
// cached - re-clicking the button re-fetches rather than restoring a saved
// result set. The *selection* (section.selectedVideo/selectedAudio) does
// persist on the section object, same as visual/narration/entities, so it
// survives the results row disappearing on the next unrelated re-render.
// Turns a scene's title/notes/narration into filmable stock-search phrases
// (video_query/audio_query) when it doesn't have them yet - the storyboard
// LLM step (storyboard_llm.py) exists precisely to translate academic content
// into something a camera could capture (never jargon/entity names). Resolves
// once section.videoQuery/audioQuery are populated. Falls back to the scene
// title if there's nothing to derive from or the LLM call fails, so Find
// Footage always has *something* to search.
function ensureFootageQueries(section) {
  if (section.videoQuery && section.audioQuery) return Promise.resolve();

  const applyFallback = () => {
    section.videoQuery = section.videoQuery || (section.title || '').trim() || 'documentary b-roll';
    section.audioQuery = section.audioQuery || (section.title || '').trim() || 'ambience';
  };

  const content = [section.text, effectiveSectionNarration(section), section.footageSubject, findAbstractText()]
    .filter(part => part && part.trim()).join('\n\n').trim();
  if (!content) {
    applyFallback();
    return Promise.resolve();
  }

  return fetchMediaQueries({
    highlight: section.footageSubject || section.text || section.title || 'Documentary scene',
    narration: effectiveSectionNarration(section),
    documentary_mode: selectedDocumentaryMode,
  })
    .then(result => {
      section.videoQuery = section.videoQuery || result.video_query;
      section.audioQuery = section.audioQuery || result.audio_query;
      applyFallback();
      saveDebugSession();
    })
    .catch(() => { applyFallback(); }); // LLM down - still search on the title
}

// Freesound audio search is paused for now (per request) - Find Footage only
// searches video. Flip back to true to re-enable the audio (sound-effect)
// options row; the backend /media/search_audio route + fetchAudioOptions are
// left in place.
const FIND_FOOTAGE_INCLUDE_AUDIO = false;

function runFindFootage(section, resultsEl, statusEl, btn, queryInput, pairedQueryInput) {
  btn.disabled = true;
  statusEl.textContent = section.videoQuery
    ? 'Searching for video options...'
    : 'Finding searchable terms, then searching...';
  statusEl.classList.remove('error');

  // Returned (not fire-and-forget) so triggerFindFootageSweep can throttle
  // how many of these run at once across a whole sweep. Derives search phrases
  // first if the scene doesn't have them yet (see ensureFootageQueries).
  return ensureFootageQueries(section).then(() => {
    if (queryInput) queryInput.value = section.videoQuery || '';
    if (pairedQueryInput) pairedQueryInput.value = section.audioQuery || '';
    const fetches = [fetchVideoOptions(section.videoQuery, getSceneDuration(section))];
    if (FIND_FOOTAGE_INCLUDE_AUDIO) fetches.push(fetchAudioOptions(section.audioQuery));
    return Promise.allSettled(fetches);
  }).then((results) => {
    const [videoResult, audioResult] = results;
    resultsEl.innerHTML = '';

    if (videoResult.status === 'fulfilled') {
      const videoRow = document.createElement('div');
      videoRow.className = 'media-video-options';
      videoResult.value.videos.forEach(video => videoRow.appendChild(buildMediaVideoOption(section, video)));
      resultsEl.appendChild(videoRow);
    }

    if (audioResult && audioResult.status === 'fulfilled') {
      const audioRow = document.createElement('div');
      audioRow.className = 'media-audio-options';
      audioResult.value.audio.forEach(audio => audioRow.appendChild(buildMediaAudioOption(section, audio)));
      resultsEl.appendChild(audioRow);
    }

    const errors = results
      .filter(result => result.status === 'rejected')
      .map(result => result.reason.message);
    if (errors.length) {
      statusEl.textContent = errors.join(' ');
      statusEl.classList.add('error');
    } else {
      statusEl.textContent = '';
    }

    btn.disabled = false;
  });
}

// A picked documentary mode plus a drafted storyboard is enough context to
// go looking for B-roll automatically, rather than making the
// presenter click "Find footage" on every section by hand - fires from
// both the mode-chip handler and runGenerateStoryboardForSections' success
// callback (see their own call sites), since either one might complete
// second; a no-op here if the other precondition isn't met yet.
//
// Locates each qualifying section's already-rendered Find Footage button/
// status/results elements by selector rather than duplicating
// buildSectionBlock's closures - runFindFootage already needs exactly
// those three DOM nodes, this just finds the ones "Find footage" itself
// would have used.
const FIND_FOOTAGE_SWEEP_CONCURRENCY = 3;

function triggerFindFootageSweep() {
  if (!selectedDocumentaryMode) return;

  const queue = currentSections.filter(section =>
    isSceneActive(section) &&
    currentAssignments[section.index] &&
    section.videoQuery &&
    !section.selectedVideo
  );
  if (queue.length === 0) return;

  const runNext = () => {
    const section = queue.shift();
    if (!section) return Promise.resolve();

    const block = resultsEl.querySelector(`.paper-section-block[data-section-index="${section.index}"]`);
    const btn = block && block.querySelector('.find-footage-btn');
    const mediaResults = block && block.querySelector('.paper-section-media');
    const statusEl = block && block.querySelector('.find-footage-status');
    // Already mid-search (a manual click raced this sweep) or the block
    // isn't on screen (e.g. scrolled out and not yet built) - either way,
    // nothing to do for this section; move on rather than stall the queue.
    if (!btn || btn.disabled || !mediaResults || !statusEl) return runNext();

    return runFindFootage(section, mediaResults, statusEl, btn).then(runNext);
  };

  for (let i = 0; i < FIND_FOOTAGE_SWEEP_CONCURRENCY; i++) runNext();
}

// Uploading a visual reference is itself a request for shot possibilities.
// Re-find the freshly rendered controls because the upload success path
// rebuilds the scene card and the old button/status elements are detached.
function autoGenerateExamplesAfterUpload(section) {
  if (!isSceneActive(section) || !currentAssignments[section.index]) return;
  const block = resultsEl && resultsEl.querySelector(
    `.paper-section-block[data-section-index="${section.index}"]`);
  const btn = block && block.querySelector('.generate-shot-examples-btn');
  const statusEl = block && block.querySelector('.find-footage-status');
  if (!btn || !statusEl || btn.disabled) return;
  runGenerateShotExamples(section, btn, statusEl);
}

function resetGeneratedVisualsForReferenceUpload(section) {
  // A new reference should not be masked by a previously selected example,
  // shot frame, sketch, or animated preview. The next examples batch becomes
  // the scene's visual-box content.
  section.exampleShots = null;
  section.selectedExample = null;
  section.shots = null;
  section.startFramePreviewUrl = null;
  section.endFramePreviewUrl = null;
  section.animatedSketchPreviewUrl = null;
  section.animatedSketchThumbnailUrl = null;
  section.sketchPreviewUrl = null;
  section.visualSource = null;
}

// Modern examples/video selections replace the old generated start/end-frame
// shot. Keep the legacy fields for genuinely legacy `runGenerateShot` output,
// but clear them whenever the user enters the examples workflow so exports
// and the visual-box fallback cannot accidentally resurrect shotFrames().
function clearLegacyShotFrames(section) {
  section.shots = null;
  section.startFramePreviewUrl = null;
  section.endFramePreviewUrl = null;
  section.shotFramesGeneratedAt = null;
}

// --- Premiere Pro (UXP) file-based bridge: uploading a researcher's own
// footage for a shot, and exporting the whole arc's edit plan - see
// backend/premiere_bridge.py for why this is file-based rather than a
// network call in both directions (macOS restricts plain http:// for a UXP
// plugin's own outbound requests; local file access has no such restriction).
function runUploadFootage(section, file, labelEl, inputEl) {
  cancelSceneGeneration(section);
  inputEl.disabled = true;
  labelEl.textContent = `Uploading "${file.name}"...`;
  labelEl.classList.remove('error');

  fetchUploadFootage(file, section.index, premiereProjectId)
    .then(({ project_id, footage_path, preview_url, thumbnail_url, footage_subject }) => {
      premiereProjectId = project_id;
      section.uploadedFootagePath = footage_path;
      // A one-sentence read of what the presenter filmed, so future generated
      // shot examples/videos for this scene match that subject (see
      // runGenerateShotExamples / runGenerateShot / runGenerateShotVideo).
      // Always replace the cached anchor as well. Keeping the old description
      // when analysis of replacement footage fails would make future previews
      // depict the previous upload—the exact opposite of footage priority.
      section.footageSubject = (footage_subject || '').trim();
      // Servable by the static file server (see backend/server.py's
      // /premiere/upload_footage) - lets buildVisualBox actually play back
      // whatever was just uploaded/recorded, not just show its filename.
      section.uploadedFootagePreviewUrl = preview_url || null;
      section.uploadedFootageThumbnailUrl = thumbnail_url || null;
      section.footageOrigin = 'upload';
      // The shared upload box represents one active user reference. Replacing
      // a sketch with footage removes the previous sketch reference.
      section.uploadedSketchPath = null;
      section.uploadedSketchPreviewUrl = null;
      section.uploadedSketchUploadedAt = null;
      resetGeneratedVisualsForReferenceUpload(section);
      // Recording/uploading footage is a deliberate choice - it should
      // always be what the visual box shows next, regardless of whatever
      // was picked/generated before it (see buildVisualBox's visualSource
      // lookup).
      section.visualSource = 'video';
      saveDebugSession();
      // Full re-render (rather than just updating labelEl in place) so the
      // visual box picks up the upload immediately - see buildVisualBox.
      if (currentAssignments[section.index]) {
        const remaining = currentSections.filter(s => !s.removed);
        renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      } else {
        renderSectionFeed(resultsEl, currentLabel, currentSections);
      }
      autoGenerateExamplesAfterUpload(section);
    })
    .catch(err => {
      labelEl.textContent = err.message;
      labelEl.classList.add('error');
      inputEl.disabled = false;
    });
}

function runUploadSketch(section, file, labelEl, inputEl) {
  cancelSceneGeneration(section);
  inputEl.disabled = true;
  labelEl.textContent = `Uploading sketch "${file.name}"...`;
  labelEl.classList.remove('error');
  fetchUploadSketch(file, section.index, premiereProjectId)
    .then(({ project_id, sketch_path, preview_url, sketch_subject, footage_subject }) => {
      premiereProjectId = project_id;
      section.uploadedSketchPath = sketch_path;
      section.uploadedSketchPreviewUrl = preview_url;
      section.uploadedSketchUploadedAt = Date.now();
      // The shared upload box represents one active user reference. Replacing
      // footage with a sketch removes the previous footage reference.
      section.uploadedFootagePath = null;
      section.uploadedFootagePreviewUrl = null;
      section.uploadedFootageThumbnailUrl = null;
      section.footageOrigin = 'upload';
      // The sketch upload route now runs the same best-effort vision subject
      // description as footage uploads. Keep it editable in the open slot.
      section.footageSubject = (sketch_subject || footage_subject || '').trim();
      resetGeneratedVisualsForReferenceUpload(section);
      section.visualSource = 'uploadedSketch';
      saveDebugSession();
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      autoGenerateExamplesAfterUpload(section);
    })
    .catch(err => {
      labelEl.textContent = err.message;
      labelEl.classList.add('error');
      inputEl.disabled = false;
    });
}

function readActBoardVideoDuration(previewUrl) {
  return new Promise(resolve => {
    if (!previewUrl) { resolve(0); return; }
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.addEventListener('loadedmetadata', () => {
      const duration = Number(video.duration);
      resolve(Number.isFinite(duration) && duration > 0 ? duration : 0);
      video.removeAttribute('src');
      video.load();
    }, { once: true });
    video.addEventListener('error', () => resolve(0), { once: true });
    video.src = previewUrl;
  });
}

// Keep every upload the node has taken as a gallery card. Deduped by URL so a
// re-upload of the same file does not stack.
function rememberActBoardUploadedVisual(node) {
  if (!node || !(node.mediaUrl || node.mediaThumbnailUrl)) return;
  if (!Array.isArray(node.uploadedVisuals)) node.uploadedVisuals = [];
  const url = node.mediaUrl || node.mediaThumbnailUrl;
  if (node.uploadedVisuals.some(item => item && item.url === url)) return;
  node.uploadedVisuals.push({
    kind: node.mediaKind || 'video',
    url,
    thumbnailUrl: node.mediaThumbnailUrl || url,
    filePath: node.uploadedFilePath || null,
    label: node.mediaKind === 'image'
      ? `Uploaded image ${node.uploadedVisuals.length + 1}`
      : `Uploaded footage ${node.uploadedVisuals.length + 1}`,
    sourceDurationSeconds: Number(node.sourceDurationSeconds) || 0,
  });
}

async function uploadActBoardNodeMedia(actKey, node, section, file, statusEl, inputEl) {
  if (!node || !section || !file) return;
  inputEl.disabled = true;
  statusEl.textContent = `Uploading "${file.name}"…`;
  statusEl.classList.remove('error');
  node.status = 'uploading';
  node.error = '';
  saveDebugSession();
  try {
    const looksLikeImage = (file.type && file.type.startsWith('image/'))
      || /\.(png|jpe?g|webp)$/i.test(file.name || '');
    if (looksLikeImage) {
      const uploaded = await fetchUploadSketch(file, section.index, premiereProjectId);
      premiereProjectId = uploaded.project_id || premiereProjectId;
      node.uploadedFilePath = uploaded.sketch_path || null;
      node.mediaUrl = uploaded.preview_url || '';
      node.mediaThumbnailUrl = uploaded.preview_url || '';
      node.mediaKind = 'image';
      node.mediaOrigin = 'upload';
      node.selectedVisualKey = 'upload';
      node.selectedGeneratedIndex = null;
      node.selectedResultIndex = null;
    } else {
      const uploaded = await fetchUploadFootage(file, section.index, premiereProjectId);
      premiereProjectId = uploaded.project_id || premiereProjectId;
      node.uploadedFilePath = uploaded.footage_path || null;
      node.mediaUrl = uploaded.preview_url || '';
      node.mediaThumbnailUrl = uploaded.thumbnail_url || uploaded.preview_url || '';
      node.mediaKind = 'video';
      node.mediaOrigin = 'upload';
      node.selectedVisualKey = 'upload';
      node.selectedGeneratedIndex = null;
      node.selectedResultIndex = null;
      node.footageSubject = (uploaded.footage_subject || '').trim();
      const duration = await readActBoardVideoDuration(node.mediaUrl);
      if (duration > 0) {
        node.sourceDurationSeconds = Number(duration.toFixed(2));
        node.trimStartSeconds = 0;
        node.durationSeconds = Number(duration.toFixed(2));
        node.durationWasSuggested = false;
        // Preserve the uploaded clip's real length until the presenter edits
        // the track manually; narration alignment can still be changed later.
        node.timingWasManuallyAdjusted = true;
      }
    }
    rememberActBoardUploadedVisual(node);
    node.status = 'ready';
    node.error = '';
    statusEl.textContent = '';
    saveDebugSession();
    rerenderActBoard();
  } catch (err) {
    node.status = 'error';
    node.error = `Could not upload footage: ${err.message}`;
    statusEl.textContent = node.error;
    statusEl.classList.add('error');
    saveDebugSession();
    rerenderActBoard();
  } finally {
    inputEl.disabled = false;
  }
}
//#endregion

