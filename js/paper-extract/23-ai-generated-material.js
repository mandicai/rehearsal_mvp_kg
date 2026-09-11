//#region --- AI-GENERATED MATERIAL FOR STORYBOARD
// Drafts (redrafts, every time) this section's visual/narration/entities/
// video_query/audio_query - the same LLM call the sticky action bar's
// "Generate Storyboard for All/Selected" makes in bulk (see
// runGenerateStoryboardForSections) - then hands off to generateStep for
// whichever concrete visual/video generation actually triggered it (see
// runGenerateSketch/runGenerateVideoFromText/runGenerateSketchSequence
// below, its 3 callers). Shared here rather than in each caller since all
// 3 need the exact same fresh visual description to work from before doing
// their own (quite different) generation step, and none should silently
// reuse a stale one.
//
// Deliberately not just runGenerateStoryboardForSections([section], ...)
// followed by a separate generation call - that function's own success
// handler already does a full renderMovieEditor re-render, which would
// detach btn/statusEl from the DOM before the generation step could use
// them (writes to a status line no longer on screen, a button no longer
// clickable) - so this inlines both LLM calls in sequence instead,
// re-rendering only once, at the very end.
//
// Considers section.text (which, via drag-and-drop, may now hold anything
// from documentary-technique reminders to dragged-in source-material
// excerpts to freeform notes - see buildSectionBlock's drop handler)
// together with section.narration, not either/or - both are meaningful
// context for what the shot should show.
//
// generateStep: () => Promise, called once section.visual is fresh - does
// the specific generation call and sets whatever fields/visualSource it
// needs; any rejection is caught here and shown alongside the (still kept)
// draft, same as the original single-purpose version of this function did.
function runDraftVisualThenGenerate(section, btn, statusEl, draftedMessage, generateStep) {
  // Defensive, not just cosmetic - the button itself is disabled without
  // this (see buildSectionBlock), but re-checked here too in case that
  // ever gets bypassed (e.g. section.text edited down to empty between
  // render and click).
  const hasBasis = !!(section.text && section.text.trim()) || !!effectiveSectionNarration(section);
  if (!hasBasis) {
    statusEl.textContent = 'Add section text or narration first - there\'s nothing to base a visual on yet.';
    statusEl.classList.add('error');
    return;
  }

  btn.disabled = true;
  statusEl.textContent = 'Drafting a visual (~5-10s)...';
  statusEl.classList.remove('error');

  statusEl.textContent = draftedMessage;
  Promise.resolve().then(generateStep).catch(err => {
    // The draft above (visual/narration/entities/videoQuery/
    // audioQuery) already succeeded and is still worth keeping/
    // showing - Find Footage only needs videoQuery, for instance, not
    // a generated visual - so only the generation step itself failed;
    // don't let that also hide the draft (the re-render still happens
    // in the .then below either way).
    statusEl.textContent = `Drafted a visual, but generation failed: ${err.message}`;
    statusEl.classList.add('error');
  })
    .then(() => {
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
    })
    .catch(err => {
      statusEl.textContent = err.message;
      statusEl.classList.add('error');
      btn.disabled = false;
    });
}

// Generates a shot for every arranged scene that doesn't have one yet (a
// start/end-frame shot, or - for expository scenes - cutaways). Image requests
// run in parallel, matching Apply this arc/Generate all. Each request still
// re-renders the whole editor on success, so the progress line + button are
// re-found by class/id from the current DOM while the stable section objects
// carry the work across those re-renders.
let generatingAllShots = false;
function runPreviewAllShots() {
  if (generatingAllShots) return;
  const setStatus = txt => { const el = document.querySelector('.preview-all-status'); if (el) el.textContent = txt; };
  generatingAllShots = true;
  const getPreviewBtn = () => document.getElementById('preview-all-btn');
  const initialBtn = getPreviewBtn();
  if (initialBtn) initialBtn.disabled = true;

  // Mirror the first storyboard-generation pass: every active scene gets a
  // stable subset of moodboard techniques, and its media-search inputs are
  // filled before visual examples are requested. This applies to scenes that
  // already have a visual too, so a later Preview All can complete missing
  // scene metadata without regenerating an existing visual.
  const arrangedScenes = () => currentSections.filter(s =>
    isSceneActive(s) && currentAssignments[s.index]);
  const scenes = arrangedScenes();
  scenes.forEach(autoPopulateSceneTechniques);
  if (scenes.length) {
    const remaining = currentSections.filter(s => !s.removed);
    renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
    saveDebugSession();
  }

  setStatus('Preparing scene techniques and narration …');
  Promise.resolve(autoSuggestNarrationForStoryboard())
    .then(() => {
      const currentScenes = arrangedScenes();
      // Ensure the same query context used by storyboard generation is ready,
      // including narration drafts produced by the preceding step.
      return Promise.all(currentScenes.map(scene => ensureFootageQueries(scene)))
        .then(() => {
          // Rebuild the controls from the newly generated query suggestions
          // before the shot buttons are looked up below.
          const remaining = currentSections.filter(s => !s.removed);
          renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
          return currentScenes;
        });
    })
    .then(currentScenes => {
      const queue = currentScenes.filter(s =>
        !(s.exampleShots && s.exampleShots.length)
        && !s.startFramePreviewUrl && !(s.cutaways && s.cutaways.length)
        && !s.uploadedFootagePreviewUrl && !s.selectedVideo);
      const total = queue.length;
      if (!total) {
        generatingAllShots = false;
        setStatus('Scene techniques and narration are ready. Every scene already has a preview.');
        const activeBtn = getPreviewBtn();
        if (activeBtn) activeBtn.disabled = false;
        saveDebugSession();
        return;
      }

      let completed = 0;
      const jobs = queue.map(section => {
        const block = resultsEl.querySelector(`.paper-section-block[data-section-index="${section.index}"]`);
        const sBtn = (block && block.querySelector('.generate-shot-examples-btn')) || { disabled: false };
        const sStatus = (block && block.querySelector('.find-footage-status'))
          || { textContent: '', classList: { add() { }, remove() { } } };
        setStatus(`Generating suggested shots in parallel … ${completed}/${total}`);
        const request = runGenerateShotExamples(section, sBtn, sStatus);
        return Promise.resolve(request).then(() => {
          completed += 1;
          setStatus(`Generating suggested shots in parallel … ${completed}/${total}`);
        });
      });
      return Promise.all(jobs).then(() => {
        generatingAllShots = false;
        setStatus(`Prepared scenes and generated previews for ${completed}/${total} scenes.`);
        const activeBtn = getPreviewBtn();
        if (activeBtn) activeBtn.disabled = false;
        saveDebugSession();
      });
    })
    .catch(err => {
      generatingAllShots = false;
      setStatus(`Could not prepare previews: ${err.message}`);
      const activeBtn = getPreviewBtn();
      if (activeBtn) activeBtn.disabled = false;
    });
}

// Seed an arranged scene with a small, varied subset of the moodboard's
// distilled technique palette when the presenter runs storyboard generation.
// Explicitly dragged techniques always win and are never overwritten.
function autoPopulateSceneTechniques(section) {
  if (Array.isArray(section.techniques) && section.techniques.length) return;
  const distilled = selectedTechniques.size
    ? Array.from(selectedTechniques)
    : (lastDistillResult && lastDistillResult.suggested_techniques) || [];
  const pool = sanitizeDocumentaryTechniques(distilled);
  if (!pool.length) return;
  const offset = Math.abs(Number(section.index) || 0) % pool.length;
  const rotated = pool.slice(offset).concat(pool.slice(0, offset));
  const picked = [];
  const categories = new Set();
  for (const technique of rotated) {
    const category = TECHNIQUE_CATEGORY[technique] || technique;
    if (categories.has(category) && picked.length < 2) continue;
    picked.push(technique);
    categories.add(category);
    if (picked.length >= Math.min(3, pool.length)) break;
  }
  section.techniques = picked;
}

// Scene-level techniques are now the generation inputs. Before storyboard
// generation, selectedTechniques is only the moodboard-derived suggestion
// palette shown in the side panel.
function sceneTechniques(section) {
  return sanitizeDocumentaryTechniques(section.techniques);
}

// Apply a documentary technique to one scene (dragged onto its Scene Notes).
// This updates the scene's generation inputs and re-renders the card, but does
// not launch image/video generation. Generation remains an explicit action.
function applyTechniqueToScene(section, technique) {
  if (!isDocumentaryTechnique(technique)) return;
  if (!Array.isArray(section.techniques)) section.techniques = [];
  if (!section.techniques.includes(technique)) section.techniques.push(technique);
  saveDebugSession();
  const remaining = currentSections.filter(s => !s.removed);
  renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
}

// A row of the per-scene techniques (section.techniques - applied by dragging a
// technique onto the scene notes/paper-section block, see
// applyTechniqueToScene), each a chip with an ✕ to remove it. Returns null when
// the scene has none. Removing a technique updates the scene for future
// generations; it doesn't re-generate on its own.
function buildSceneTechniquesRow(section) {
  const techs = Array.isArray(section.techniques) ? section.techniques : [];
  if (!techs.length) return null;

  const row = document.createElement('div');
  row.className = 'paper-section-techniques';
  // const label = document.createElement('span');
  // label.className = 'paper-section-techniques-label';
  // label.textContent = 'Techniques:';
  // row.appendChild(label);

  techs.forEach(technique => {
    const chip = document.createElement('span');
    chip.className = 'paper-section-technique-chip';
    const text = document.createElement('span');
    text.textContent = technique;
    chip.appendChild(text);
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'paper-section-technique-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = `Remove "${technique}" from this scene`;
    removeBtn.addEventListener('click', event => {
      event.stopPropagation();
      section.techniques = (section.techniques || []).filter(t => t !== technique);
      saveDebugSession();
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
    });
    chip.appendChild(removeBtn);
    row.appendChild(chip);
  });
  return row;
}

// Narration-driven shot design (backend/shot_plan_llm.py + /paper/generate_shot):
// infers one shot (size/movement/purpose) and generates its start frame + end
// frame from whatever's available - the scene's narration, scene notes, scene
// title, the arc part (act) the scene sits in, and the paper's abstract. None
// are required; with nothing at all the backend invents a plausible shot. The
// frames show as the artboard in buildVisualBox and hard-cut into the rendered
// MP4. This is the primary way a scene's visual is created (it replaced the
// old Generate-sketch / sketch-sequence buttons); re-clicking redesigns from
// scratch, same pattern as re-running Find Footage.
function runGenerateShot(section, btn, statusEl) {
  // An expository voice-of-god scene generates B-roll cutaways (inline in its
  // visual box) instead of a start/end-frame shot - see runGenerateCutaways.
  // Returned so callers that sweep scenes (runPreviewAllShots) can chain.

  // One start/end shot PER dragged technique, in the order they were dropped
  // (section.techniques) - so a scene with two techniques produces two shots,
  // the first showing technique #1, the second showing technique #2. With no
  // per-scene techniques, generate one shot with no technique constraint.
  const perScene = Array.isArray(section.techniques) ? section.techniques : [];
  const sequence = perScene.length ? perScene : [null];
  const moodboard = moodboardProfilesForGeneration();
  const act = currentArcSections.find(a => a.key === currentAssignments[section.index]);
  const generationController = beginSceneGeneration(section);

  btn.disabled = true;
  statusEl.classList.remove('error');
  const shots = [];

  const runOne = i => {
    if (i >= sequence.length) {
      section.shots = shots;
      // Legacy single-frame fields point at the first shot so the timeline and
      // the MP4 render (which currently use one start/end pair per scene) keep
      // working; section.shots holds the full sequence for the preview.
      section.shotPlan = shots[0].shotPlan;
      section.startFramePreviewUrl = shots[0].startFramePreviewUrl;
      section.endFramePreviewUrl = shots[0].endFramePreviewUrl;
      section.shotFramesGeneratedAt = Date.now();
      section.visualSource = 'shotFrames';
      // Scene duration = sum of the sequence's shot durations.
      const total = shots.reduce((sum, sh) => sum + ((sh.shotPlan && sh.shotPlan.duration_seconds) || DEFAULT_SCENE_SECONDS), 0);
      section.editPlan = {
        transitionIn: (section.editPlan && section.editPlan.transitionIn) || 'hard_cut',
        durationSeconds: total,
        kenBurns: (section.editPlan && section.editPlan.kenBurns) || { enabled: false, pan: null },
        textOverlay: (section.editPlan && section.editPlan.textOverlay) || null,
      };
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      saveDebugSession();
      finishSceneGeneration(section, generationController);
      return Promise.resolve();
    }

    const technique = sequence[i];
    const techniques = technique ? [technique] : [];
    statusEl.textContent = sequence.length > 1
      ? `Designing shot ${i + 1}/${sequence.length}${technique ? ` — ${technique}` : ''} …`
      : 'Designing this shot (~30s: shot plan + start/end frames)...';

    return fetchGenerateShot({
      sectionIndex: section.index,
      title: section.title,
      sceneNotes: sectionCompositionNotes(section),
      narration: effectiveSectionNarration(section),
      actTitle: act ? act.label : '',
      abstract: findAbstractText(),
      role: SCENE_ROLE_LABELS[getSceneRole(section)] || '',
      referenceSubject: section.footageSubject || '',
      referenceSketchUrl: section.uploadedSketchPreviewUrl || '',
      referenceFigureDataUrl: section.image || '',
      referenceVideoUrl: section.uploadedFootagePreviewUrl || '',
      referenceVideoThumbnailUrl: section.uploadedFootageThumbnailUrl || '',
      documentaryMode: selectedDocumentaryMode,
      techniques,
      moodboard,
      shotIndex: i,
      projectId: premiereProjectId,
      signal: generationController.signal,
    }).then(({ project_id, shot_plan, start_preview_url, end_preview_url }) => {
      premiereProjectId = project_id;
      shots.push({
        technique,
        shotPlan: shot_plan,
        startFramePreviewUrl: start_preview_url,
        endFramePreviewUrl: end_preview_url,
      });
      return runOne(i + 1);  // sequential - respects the image model's rate limit
    });
  };

  return runOne(0).catch(err => {
    finishSceneGeneration(section, generationController);
    if (isGenerationAbort(err)) return;
    statusEl.textContent = err.message;
    statusEl.classList.add('error');
    btn.disabled = false;
  });
}

// The VIDEO counterpart of runGenerateShot (see fetchGenerateShotVideo /
// /paper/generate_shot_video) - animates the exact image the presenter chose
// from the examples gallery, using that option's saved plan plus this scene's
// notes and explicitly dragged techniques.
function runGenerateShotVideo(section, btn, statusEl) {
  const selectedExampleImageUrl = section.selectedExample && section.selectedExample.kind === 'video'
    ? (section.selectedExample.source_image_url || section.selectedExample.thumbnail_url)
    : (section.selectedExample && section.selectedExample.url);
  const chosenImageUrl = selectedExampleImageUrl
    || section.startFramePreviewUrl
    || section.uploadedSketchPreviewUrl
    || section.uploadedFootageThumbnailUrl;
  if (!chosenImageUrl) {
    statusEl.textContent = 'Generate or upload an image, or choose an example image, before previewing it as a video.';
    statusEl.classList.add('error');
    return Promise.resolve();
  }

  btn.disabled = true;
  const generationController = beginSceneGeneration(section);
  statusEl.textContent = 'Animating the chosen image (~60s)...';
  statusEl.classList.remove('error');

  return fetchGenerateShotVideo({
    sectionIndex: section.index,
    chosenImageUrl,
    sceneNotes: sectionCompositionNotes(section),
    documentaryMode: selectedDocumentaryMode,
    techniques: sceneTechniques(section),
    shotPlan: section.shotPlan || {},
    projectId: premiereProjectId,
    signal: generationController.signal,
  })
    .then(({ project_id, shot_plan, preview_url, thumbnail_url }) => {
      premiereProjectId = project_id;
      section.shotPlan = shot_plan;
      // Reuse the animatedSketch renderer (plays an MP4) for the shot video.
      section.animatedSketchPreviewUrl = preview_url;
      section.animatedSketchThumbnailUrl = thumbnail_url || null;
      section.animatedSketchGeneratedAt = Date.now();
      section.animatedSketchIsGif = false;
      const sourceShot = (section.exampleShots || []).find(shot => shot.url === chosenImageUrl)
        || section.selectedExample || {};
      const videoShot = {
        url: preview_url,
        thumbnail_url: thumbnail_url || chosenImageUrl,
        kind: 'video',
        generated: true,
        label: sourceShot && sourceShot.label ? sourceShot.label : 'Generated video',
        shot_size: sourceShot && sourceShot.shot_size,
        movement: sourceShot.movement || (shot_plan && shot_plan.movement),
        narrative_operation: shot_plan && shot_plan.narrative_operation,
        purpose: shot_plan && shot_plan.purpose,
        visual_description: shot_plan && shot_plan.visual_description,
        source_image_url: chosenImageUrl,
      };
      clearLegacyShotFrames(section);
      const selectedWasPinned = section.selectedExample && Array.isArray(section.pinnedExamples)
        && section.pinnedExamples.some(item => item && item.url === section.selectedExample.url);
      section.exampleShots = [...(section.exampleShots || []), videoShot];
      // A pinned source remains the selected/featured card when a preview
      // video is generated from it; the new video is added beside it instead
      // of replacing the pinned choice.
      if (!selectedWasPinned) {
        section.selectedExample = {
          url: preview_url,
          kind: 'video',
          thumbnail_url: thumbnail_url || chosenImageUrl,
          source_image_url: chosenImageUrl,
          generated: true,
          label: videoShot.label,
          shot_size: videoShot.shot_size,
          movement: videoShot.movement,
        };
      }
      section.visualSource = 'examples';
      section.editPlan = {
        transitionIn: (section.editPlan && section.editPlan.transitionIn) || 'hard_cut',
        durationSeconds: 8,  // Veo 3.1's maximum supported clip length.
        kenBurns: (section.editPlan && section.editPlan.kenBurns) || { enabled: false, pan: null },
        textOverlay: (section.editPlan && section.editPlan.textOverlay) || null,
      };
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      saveDebugSession();
      finishSceneGeneration(section, generationController);
    })
    .catch(err => {
      finishSceneGeneration(section, generationController);
      if (isGenerationAbort(err)) return;
      statusEl.textContent = err.message;
      statusEl.classList.add('error');
      // In a parallel batch this scene's status element may already have been
      // detached by another completed request, so also surface the failure in
      // the live storyboard status line.
      setStoryboardStatus(`Could not generate examples for "${section.title}": ${err.message}`, true);
      btn.disabled = false;
    });
}

// Batch of example options for a shot (see fetchGenerateShotExamples /
// /paper/generate_shot_examples): two cheap still frames, shown as
// a selectable gallery (the `examples` renderer). Picking one commits it.
function runGenerateShotExamples(section, btn, statusEl) {
  btn.disabled = true;
  statusEl.textContent = 'Generating two shot examples…';
  statusEl.classList.remove('error');
  const generationController = beginSceneGeneration(section);

  const act = currentArcSections.find(a => a.key === currentAssignments[section.index]);
  return fetchGenerateShotExamples({
    sectionIndex: section.index,

    sceneNotes: sectionCompositionNotes(section),
    title: section.title,
    actTitle: act ? act.label : '',

    role: SCENE_ROLE_LABELS[getSceneRole(section)] || '', // Primary / Cutaway
    documentaryMode: selectedDocumentaryMode,
    techniques: sceneTechniques(section),

    narration: effectiveSectionNarration(section),
    abstract: findAbstractText(),                       // paper subject/content
    referenceSubject: section.footageSubject || '',     // uploaded-footage subject
    referenceSketchUrl: section.uploadedSketchPreviewUrl || '',
    referenceFigureDataUrl: section.image || '',         // attached paper figure
    referenceVideoUrl: section.uploadedFootagePreviewUrl || '',
    referenceVideoThumbnailUrl: section.uploadedFootageThumbnailUrl || '',

    moodboard: moodboardProfilesForGeneration(),
    count: 2,
    video: false,  // images-only batch (use "Generate video" once a frame is picked)
    projectId: premiereProjectId,
    signal: generationController.signal,
  })
    .then(({ project_id, shot_plan, examples }) => {
      premiereProjectId = project_id;
      section.shotPlan = shot_plan;
      clearLegacyShotFrames(section);
      // Each example carries its independently planned narrative operation,
      // shot-size/movement pairing, purpose, and image description.
      const generatedExamples = (examples || []).map(e => ({
        url: e.preview_url, thumbnail_url: e.thumbnail_url || e.preview_url,
        kind: e.kind || 'image', label: e.label,
        shot_size: e.shot_size, movement: e.movement,
        narrative_operation: e.narrative_operation, purpose: e.purpose,
        visual_description: e.visual_description,
      }));
      const pinned = Array.isArray(section.pinnedExamples) ? section.pinnedExamples : [];
      const generatedUrls = new Set(generatedExamples.map(shot => shot.url));
      section.exampleShots = [
        ...pinned.filter(shot => shot && shot.url && !generatedUrls.has(shot.url)),
        ...generatedExamples,
      ];
      // A prior selection points at the old generation's URL and should not
      // make the new gallery claim that an option is already selected, unless
      // it was deliberately pinned and therefore remains in the merged rail.
      const selectedWasPinned = section.selectedExample && Array.isArray(section.pinnedExamples)
        && section.pinnedExamples.some(item => item && item.url === section.selectedExample.url);
      if (!selectedWasPinned) section.selectedExample = null;
      section.examplesGeneratedAt = Date.now();
      section.visualSource = 'examples';
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      saveDebugSession();
      finishSceneGeneration(section, generationController);
    })
    .catch(err => {
      finishSceneGeneration(section, generationController);
      if (isGenerationAbort(err)) return;
      statusEl.textContent = err.message;
      statusEl.classList.add('error');
      btn.disabled = false;
    });
}

// Expository scenes: infer B-roll cutaways from the narration (+ notes/title/
// abstract) and generate a background still per cutaway (backend/cutaway_llm.py
// + /paper/generate_cutaways). Stored on the scene and shown inline in its
// visual box as a horizontal scroll of directional motion sketches (an AI
// background with an animated camera-frame overlay - see the cutaways
// renderer). Planning-only; re-clicking regenerates.
function runGenerateCutaways(section, btn, statusEl) {
  btn.disabled = true;
  statusEl.textContent = 'Finding cutaways from the narration + generating stills (~30-60s)...';
  statusEl.classList.remove('error');

  const act = currentArcSections.find(a => a.key === currentAssignments[section.index]);
  return fetchGenerateCutaways({
    sectionIndex: section.index,
    narration: effectiveSectionNarration(section),
    title: section.title,
    sceneNotes: sectionCompositionNotes(section),
    actTitle: act ? act.label : '',
    abstract: findAbstractText(),
    referenceSubject: section.footageSubject || '',
    documentaryMode: selectedDocumentaryMode,
    techniques: sceneTechniques(section),
    projectId: premiereProjectId,
  })
    .then(({ project_id, cutaways }) => {
      premiereProjectId = project_id;
      section.cutaways = cutaways || [];
      // Fresh cache-buster so re-generated stills (same filenames on the
      // backend) aren't served from the browser cache - see the renderer.
      section.cutawaysGeneratedAt = Date.now();
      section.visualSource = 'cutaways';
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      saveDebugSession();
    })
    .catch(err => {
      statusEl.textContent = err.message;
      statusEl.classList.add('error');
      btn.disabled = false;
    });
}

// AI-generated storyboard reference image (backend/sketch_llm.py) - a rough
// planning aid, not real footage, so re-clicking this just regenerates/
// replaces it (same pattern as re-clicking "Find Footage" re-searches).
// Retained for older saved sessions' visuals; no button creates one now (the
// Generate-shot flow above replaced it).
function runGenerateSketch(section, btn, statusEl) {
  runDraftVisualThenGenerate(section, btn, statusEl, 'Generating a sketch (~10-15s)...', () =>
    fetchGenerateSketch(section.index, section.visual, premiereProjectId, selectedDocumentaryMode)
      .then(({ project_id, preview_url }) => {
        premiereProjectId = project_id;
        section.sketchPreviewUrl = preview_url;
        // The backend saves every sketch for this section to the same
        // filename (see server.py's /paper/generate_sketch) - without a
        // fresh cache-busting key each time, buildVisualBox's <img src>
        // would be byte-identical to the previous request and the browser
        // would just show its cached copy of the old image.
        section.sketchGeneratedAt = Date.now();
        // Generating a sketch is a deliberate choice - see
        // buildVisualBox's visualSource lookup (same reasoning as
        // runUploadFootage's own).
        section.visualSource = 'sketch';
        saveDebugSession();
      })
  );
}

// Text-to-video (backend/animate_llm.py's generate_text_to_video) - same
// Veo model as runGenerateAnimatedSketch below, but built straight from
// this shot's own visual description rather than an existing sketch image,
// so (unlike that one) this doesn't need a sketch to already exist.
function runGenerateVideoFromText(section, technique, btn, statusEl) {
  runDraftVisualThenGenerate(section, btn, statusEl, 'Generating a video from text (~45-60s)...', () =>
    fetchGenerateVideoFromText(section.index, section.visual, technique, premiereProjectId, selectedDocumentaryMode)
      .then(({ project_id, preview_url }) => {
        premiereProjectId = project_id;
        section.animatedSketchPreviewUrl = preview_url;
        section.animatedSketchTechnique = technique;
        // See runGenerateSketch's own sketchGeneratedAt comment - same
        // cache-busting reasoning, needed since re-generating the same
        // technique reuses that technique's filename (see server.py).
        section.animatedSketchGeneratedAt = Date.now();
        // Clears a stale true left behind by a previous sketch-sequence
        // generation on this same section (see the animatedSketch
        // renderer's own check) - this method's output is an .mp4, not a
        // .gif like runGenerateSketchSequence's below.
        section.animatedSketchIsGif = false;
        section.visualSource = 'animatedSketch';
        saveDebugSession();
      })
  );
}

// Cheaper, non-video-model alternative (backend/animate_llm.py's
// build_sequence_prompts/compose_gif) - 2-3 sketch_llm.py stills stitched
// into a hard-cut, looping animated GIF locally (no video model, no
// crossfade/blend), noticeably faster/cheaper than the two Veo-based
// methods above.
function runGenerateSketchSequence(section, technique, btn, statusEl) {
  runDraftVisualThenGenerate(section, btn, statusEl, 'Generating a sketch sequence (~30-45s)...', () =>
    fetchGenerateSketchSequence(section.index, section.visual, technique, premiereProjectId, selectedDocumentaryMode)
      .then(({ project_id, preview_url }) => {
        premiereProjectId = project_id;
        section.animatedSketchPreviewUrl = preview_url;
        section.animatedSketchTechnique = technique;
        section.animatedSketchGeneratedAt = Date.now();
        // See the animatedSketch renderer's own check - this is what
        // routes this method's output through <img> instead of <video>.
        section.animatedSketchIsGif = true;
        section.visualSource = 'animatedSketch';
        saveDebugSession();
      })
  );
}

// Animates an already-generated sketch (see runGenerateSketch above) into a
// short clip demonstrating one camera technique - a real image-to-video
// model (backend/animate_llm.py, Veo), not a CSS effect, so this is a
// genuine ~45-60s generation, not instant.
function runGenerateAnimatedSketch(section, technique, btn, statusEl) {
  // Defensive, not just cosmetic - the button itself is disabled without
  // this (see buildSectionBlock), but re-checked here too in case a sketch
  // gets cleared between render and click.
  if (!section.sketchPreviewUrl) {
    statusEl.textContent = 'Generate a sketch first - this animates that exact image.';
    statusEl.classList.add('error');
    return;
  }

  btn.disabled = true;
  statusEl.textContent = 'Animating (~45-60s) ...';
  statusEl.classList.remove('error');

  fetchGenerateAnimatedSketch(section.index, technique, premiereProjectId, selectedDocumentaryMode)
    .then(({ project_id, preview_url }) => {
      premiereProjectId = project_id;
      section.animatedSketchPreviewUrl = preview_url;
      section.animatedSketchTechnique = technique;
      // Each technique is its own file (see server.py's
      // /paper/generate_animated_sketch), but re-generating the SAME
      // technique again reuses that filename - see the animatedSketch
      // renderer's own cache-busting comment.
      section.animatedSketchGeneratedAt = Date.now();
      // See runGenerateVideoFromText's own comment - clears a stale true
      // from a previous sketch-sequence generation; this method's output
      // is an .mp4, not a .gif.
      section.animatedSketchIsGif = false;
      // Animating a sketch is a deliberate choice - see buildVisualBox's
      // visualSource lookup (same reasoning as runGenerateSketch's own).
      section.visualSource = 'animatedSketch';
      saveDebugSession();

      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
    })
    .catch(err => {
      statusEl.textContent = err.message;
      statusEl.classList.add('error');
      btn.disabled = false;
    });
}

// sectionsToUse is whatever the sticky action bar decided to target - the
// current selection if non-empty, otherwise the whole arc (see
// renderMovieEditor) - the movie editor always re-renders the full
// remaining set regardless, so a subset regeneration doesn't hide every
// other already-arranged card.
function runGenerateStoryboardForSections(sectionsToUse, triggerBtn) {
  if (sectionsToUse.length === 0) {
    setStoryboardStatus('No arranged sections to build a storyboard from - arrange into a narrative arc first.', true);
    return Promise.resolve();
  }

  if (triggerBtn) triggerBtn.disabled = true;
  setStoryboardStatus(sectionsToUse.length === 1
    ? `Generating a storyboard for "${sectionsToUse[0].title}" ...`
    : 'Generating a loose storyboard ...');

  // Turn the moodboard distillation into scene-level direction at the moment
  // the storyboard is created. This keeps the technique side panel as a
  // palette, while every scene gets a few concrete techniques in its notes.
  sectionsToUse.forEach(autoPopulateSceneTechniques);

  return Promise.all(sectionsToUse.map(section => {
    section.videoQuery = '';
    section.audioQuery = '';
    return ensureFootageQueries(section);
  })).then(() => {
    const remaining = currentSections.filter(section => isSceneActive(section) && currentAssignments[section.index]);
    renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
    setStoryboardStatus(`Generating preview examples for ${sectionsToUse.length} scene${sectionsToUse.length === 1 ? '' : 's'} ...`);

    // The cards must exist before we look up each scene's status line. Each
    // scene generates independently; a result is kept even if another one
    // fails, and pinned examples remain protected by the normal rail merge.
    const exampleJobs = sectionsToUse.map(section => {
      const block = resultsEl.querySelector(`.paper-section-block[data-section-index="${section.index}"]`);
      const btn = (block && block.querySelector('.generate-shot-examples-btn')) || { disabled: false };
      const status = (block && block.querySelector('.find-footage-status'))
        || { textContent: '', classList: { add() { }, remove() { } } };
      return Promise.resolve(runGenerateShotExamples(section, btn, status)).then(() => {
        // Show this scene's gallery as soon as its request settles rather
        // than waiting for the other parallel scenes to finish.
        const progressiveRemaining = currentSections.filter(s => !s.removed);
        renderMovieEditor(resultsEl, currentLabel, progressiveRemaining, currentAssignments);
      });
    });
    return Promise.all(exampleJobs);
  }).then(() => {
    // Every example request re-renders independently. Render once more after
    // the batch so the final galleries are guaranteed to be visible even if
    // the last request completed while another render was replacing the DOM.
    const finalRemaining = currentSections.filter(s => !s.removed);
    renderMovieEditor(resultsEl, currentLabel, finalRemaining, currentAssignments);
    setStoryboardStatus(`Done. Added techniques and preview examples for ${sectionsToUse.length} scene${sectionsToUse.length === 1 ? '' : 's'}.`);
    // The other half of triggerFindFootageSweep's precondition (alongside
    // a picked mode) - a no-op if no mode is selected yet. Needs to run
    // after the render above, since it locates each section's Find Footage
    // button/status/results by selector in the freshly-built DOM.
    triggerFindFootageSweep();
    if (triggerBtn) triggerBtn.disabled = false;
    saveDebugSession();
  })
    .catch(err => {
      setStoryboardStatus(err.message, true);
      if (triggerBtn) triggerBtn.disabled = false;
    });
}

// --- Edit plan: transitions/pacing/Ken-Burns/text-overlay suggestions over
// an already-storyboarded (sub)set of the arc (backend/edit_plan_llm.py).
// Only sections with a storyboard shot (visual+narration) are worth sending
// - one the model never touches would have nothing to base editing choices
// on. sectionsToUse follows the same convention as
// runGenerateStoryboardForSections above. ---
function runGenerateEditPlanForSections(sectionsToUse, triggerBtn) {
  const storyboarded = sectionsToUse.filter(section => section.visual);
  if (storyboarded.length === 0) {
    setEditPlanStatus('No storyboarded sections yet - generate a storyboard first.', true);
    return;
  }

  if (triggerBtn) triggerBtn.disabled = true;
  setEditPlanStatus(storyboarded.length === 1
    ? `Generating an edit plan for "${storyboarded[0].title}" ...`
    : 'Generating an edit plan ...');
  const documentaryGoal = (documentaryIntentInput ? documentaryIntentInput.value : recordedTranscript).trim();

  fetchEditPlan(storyboarded.map(({ index, title, text, visual, narration, image }) => ({
    index, title, text, visual, narration,
    act: currentAssignments[index],
    has_figure_image: !!image,
  })), documentaryGoal, currentArcSections.map(s => s.label), selectedDocumentaryMode)
    .then(({ shots, overall_notes }) => {
      shots.forEach(({ index, transition_in, duration_seconds, ken_burns, text_overlay }) => {
        const section = currentSections.find(s => s.index === index);
        if (section) {
          section.editPlan = { transitionIn: transition_in, durationSeconds: duration_seconds, kenBurns: ken_burns, textOverlay: text_overlay };
        }
      });
      overallEditNotes = overall_notes || '';

      setEditPlanStatus(
        `Done. Generated an edit plan for ${shots.length} shot${shots.length === 1 ? '' : 's'}.` +
        (overallEditNotes ? ` Overall notes: ${overallEditNotes}` : '')
      );
      const remaining = currentSections.filter(section => isSceneActive(section) && currentAssignments[section.index]);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      if (triggerBtn) triggerBtn.disabled = false;
      saveDebugSession();
    })
    .catch(err => {
      setEditPlanStatus(err.message, true);
      if (triggerBtn) triggerBtn.disabled = false;
    });
}
//#endregion

