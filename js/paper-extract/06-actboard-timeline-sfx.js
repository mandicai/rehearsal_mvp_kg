//#region --- NARRATIVE ARC
// --- SETUP STEP NAVIGATION - navigates from index.html (paper upload) to
// moodboard.html (documentary references), then to storyboard.html (arc
// suggestion + movie editor) as real page loads, not same-page view swaps -
// all state either page needs
// (recordedTranscript, selectedFocusStatements, currentSections, ...) is
// persisted to localStorage first (see saveDebugSession) and restored on
// the next page's load (see restoreDebugSession, further below).
// #compose-storyboard-row/#compose-storyboard-btn exist on index.html, while
// #moodboard-next-row/#moodboard-next-btn exist on moodboard.html. Both page
// transitions are guarded here because this shared script also runs on
// storyboard.html.
const composeStoryboardRowEl = document.getElementById('compose-storyboard-row');
const composeStoryboardBtn = document.getElementById('compose-storyboard-btn');
const moodboardNextRowEl = document.getElementById('moodboard-next-row');
const moodboardNextBtn = document.getElementById('moodboard-next-btn');
if (moodboardNextRowEl) moodboardNextRowEl.style.display = '';

// The paper page always offers the documentary-reference step. References
// and paper sections are deliberately optional here: a presenter may start
// building a moodboard before uploading a paper, or upload the paper later.
function updateComposeStoryboardVisibility() {
  if (!composeStoryboardRowEl) return;
  composeStoryboardRowEl.style.display = '';
}

if (composeStoryboardBtn) {
  composeStoryboardBtn.addEventListener('click', () => {
    saveDebugSession();
    window.location.href = 'moodboard.html';
  });
}
if (moodboardNextBtn && moodboardNextBtn.dataset.navigationWired !== 'true') {
  moodboardNextBtn.dataset.navigationWired = 'true';
  moodboardNextBtn.addEventListener('click', () => {
    // If a page-specific save encounters an unexpected error, still navigate
    // to the next step rather than trapping the presenter on this page.
    try { saveDebugSession(); } finally { window.location.href = 'storyboard.html?distill=1'; }
  });
}
// --- END COMPOSE STORYBOARD

function buildMediaVideoOption(section, video) {
  const option = document.createElement('div');
  option.className = 'media-video-option';
  option.classList.toggle('selected', !!section.selectedVideo && section.selectedVideo.id === video.id);

  const player = document.createElement('video');
  player.src = video.video_url;
  player.poster = video.thumbnail_url || '';
  player.controls = true;
  player.preload = 'metadata';
  player.addEventListener('click', event => event.stopPropagation()); // let play/pause/scrub work without also selecting this option
  option.appendChild(player);

  // Which provider this came from (see server.py's /media/search_video,
  // which tags every result before returning it) - Pexels (modern stock
  // footage) vs. Internet Archive/Library of Congress (real archival
  // footage) isn't obvious from the thumbnail alone.
  if (video.source) {
    const sourceLabel = document.createElement('div');
    sourceLabel.className = 'media-video-option-source';
    sourceLabel.textContent = video.source;
    option.appendChild(sourceLabel);
  }

  const link = document.createElement('a');
  link.className = 'media-option-link';
  link.href = video.source_url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = '↗';
  link.title = video.source ? `Open on ${video.source}` : 'Open source';
  link.addEventListener('click', event => event.stopPropagation());
  option.appendChild(link);

  // The video fills this whole option (see .media-video-option's CSS), so
  // clicking it just plays/pauses (see the player's own stopPropagation
  // above) rather than ever reaching an option-level click-to-select -
  // there's no exposed area left to click for that. This overlay button is
  // the actual, discoverable way to pick a clip.
  const isSelected = !!section.selectedVideo && section.selectedVideo.id === video.id;
  const selectBtn = document.createElement('button');
  selectBtn.type = 'button';
  selectBtn.className = 'media-video-option-select-btn';
  selectBtn.textContent = isSelected ? '✓ Selected' : 'Use this clip';
  selectBtn.addEventListener('click', event => {
    event.stopPropagation();
    if (selectBtn.disabled) return;
    selectBtn.disabled = true;
    selectBtn.textContent = 'Downloading ...';
    // A pick is a bare remote URL until it's actually downloaded to disk -
    // neither export path (the Premiere plugin or the ffmpeg render) can
    // use a URL directly. See fetchDownloadStockMedia's own comment.
    fetchDownloadStockMedia(
      section.index,
      'video',
      video.video_url,
      premiereProjectId,
      // Search results are duration-filtered, but a presenter may still
      // intentionally choose a shorter clip (or lengthen the scene after the
      // search). User-selected downloads should not be rejected by the
      // minimum-duration playback safeguard; the actual duration is recorded
      // and playback can trim/adjust to it afterward.
      0,
      video.id || `scene-${section.index}`,
    )
      .then(({ project_id, preview_url, file_path, thumbnail_url }) => {
        premiereProjectId = project_id;
        section.selectedVideo = { ...video, localPreviewUrl: preview_url };
        // A found-footage pick is the scene's open-slot reference, not a
        // generated visual-box result. Keep a local copy + extracted poster so
        // the same slot renders it like uploaded footage and future shot/image
        // generation can use its frame as an anchor.
        section.uploadedFootagePath = file_path || null;
        section.uploadedFootagePreviewUrl = preview_url || null;
        section.uploadedFootageThumbnailUrl = thumbnail_url || video.thumbnail_url || null;
        section.uploadedSketchPath = null;
        section.uploadedSketchPreviewUrl = null;
        section.uploadedSketchUploadedAt = null;
        section.footageOrigin = 'foundFootage';
        section.visualSource = 'video';
        // Full re-render so the open slot picks up the selected clip immediately.
        const remaining = currentSections.filter(s => !s.removed);
        renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
        saveDebugSession();
      })
      .catch(err => {
        selectBtn.disabled = false;
        selectBtn.textContent = 'Use this clip';
        window.alert(`Could not use this clip: ${err.message}`);
      });
  });
  option.appendChild(selectBtn);

  return option;
}

function buildMediaAudioOption(section, audio) {
  const option = document.createElement('div');
  option.className = 'media-audio-option';
  option.classList.toggle('selected', !!section.selectedAudio && section.selectedAudio.id === audio.id);

  const label = document.createElement('div');
  label.className = 'media-audio-option-label';
  const licenseSuffix = audio.license ? `, ${audio.license}` : '';
  const duration = Number(audio.duration);
  const durationSuffix = Number.isFinite(duration) && duration > 0 ? ` · ${duration.toFixed(1)}s` : '';
  label.textContent = `${audio.name || 'Untitled'} — ${audio.creator || 'unknown'}${licenseSuffix}${durationSuffix}`;
  option.appendChild(label);

  const player = document.createElement('audio');
  player.controls = true;
  player.src = audio.preview_url;
  player.addEventListener('click', event => event.stopPropagation());
  option.appendChild(player);

  if (audio.source_url) {
    const sourceLink = document.createElement('a');
    sourceLink.className = 'media-option-link';
    sourceLink.href = audio.source_url;
    sourceLink.target = '_blank';
    sourceLink.rel = 'noopener noreferrer';
    sourceLink.textContent = '↗';
    sourceLink.title = 'Open this sound on Freesound';
    sourceLink.addEventListener('click', event => event.stopPropagation());
    option.appendChild(sourceLink);
  }

  option.addEventListener('click', event => {
    event.stopPropagation(); // don't let this bubble to the card's own click-to-select handler
    if (option.classList.contains('downloading')) return;
    option.classList.add('downloading');
    // A pick is a bare remote URL until it's actually downloaded to disk -
    // neither export path (the Premiere plugin or the ffmpeg render) can
    // use a URL directly. See fetchDownloadStockMedia's own comment.
    fetchDownloadStockMedia(section.index, 'audio', audio.preview_url, premiereProjectId)
      .then(({ project_id, preview_url, file_path, duration_seconds }) => {
        premiereProjectId = project_id;
        const naturalDuration = Number(duration_seconds) > 0 ? Number(duration_seconds) : duration;
        section.selectedAudio = {
          ...audio,
          localPreviewUrl: preview_url,
          localFilePath: file_path || null,
          sourceDurationSeconds: naturalDuration,
          trimStartSeconds: 0,
          durationSeconds: naturalDuration,
        };
        // Full re-render so the audio placeholder under the visual box (see
        // buildSectionBlock) picks up the new player immediately.
        const remaining = currentSections.filter(s => !s.removed);
        renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
        saveDebugSession();
      })
      .catch(err => {
        option.classList.remove('downloading');
        window.alert(`Could not use this sound: ${err.message}`);
      });
  });

  return option;
}

// Sound effects use their own search action rather than piggy-backing on
// Find footage. The storyboard's audio_query is still shared, but the result
// area and request lifecycle are independent so video and SFX searches can be
// used/retried without replacing one another's UI.
function runUploadSoundEffect(section, file, statusEl, inputEl) {
  inputEl.disabled = true;
  statusEl.textContent = `Uploading “${file.name}”...`;
  statusEl.classList.remove('error');

  return fetchUploadMediaBankItem(file, premiereProjectId)
    .then(({ project_id, preview_url, file_path, duration_seconds }) => {
      premiereProjectId = project_id;
      const naturalDuration = Number(duration_seconds);
      section.selectedAudio = {
        name: file.name,
        source: 'user-upload',
        preview_url: preview_url,
        localPreviewUrl: preview_url,
        localFilePath: file_path || null,
        sourceDurationSeconds: naturalDuration > 0 ? naturalDuration : null,
        trimStartSeconds: 0,
        durationSeconds: naturalDuration > 0 ? naturalDuration : null,
      };
      normalizeSelectedAudioSegment(section.selectedAudio);
      saveDebugSession();
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
    })
    .catch(err => {
      statusEl.textContent = `Could not upload sound effect: ${err.message}`;
      statusEl.classList.add('error');
      inputEl.disabled = false;
    });
}

function runSuggestSoundEffects(section, resultsEl, statusEl, btn, queryInput, pairedQueryInput) {
  btn.disabled = true;
  statusEl.textContent = section.audioQuery
    ? 'Searching for sound effects...'
    : 'Finding a sound-effects search phrase, then searching...';
  statusEl.classList.remove('error');

  return ensureFootageQueries(section)
    .then(() => {
      if (queryInput) queryInput.value = section.audioQuery || '';
      if (pairedQueryInput) pairedQueryInput.value = section.videoQuery || '';
      statusEl.textContent = `Searching Freesound for “${section.audioQuery}”...`;
      return fetchAudioOptions(section.audioQuery);
    })
    .then(({ audio }) => {
      resultsEl.innerHTML = '';
      const queryLabel = document.createElement('div');
      queryLabel.className = 'sfx-search-query';
      queryLabel.textContent = `Freesound query: “${section.audioQuery}”`;
      resultsEl.appendChild(queryLabel);
      const row = document.createElement('div');
      row.className = 'media-audio-options';
      (audio || []).forEach(sound => row.appendChild(buildMediaAudioOption(section, sound)));
      resultsEl.appendChild(row);
      statusEl.textContent = audio && audio.length
        ? ''
        : `No sound effects found for “${section.audioQuery}”.`;
    })
    .catch(err => {
      statusEl.textContent = err.message;
      statusEl.classList.add('error');
    })
    .finally(() => { btn.disabled = false; });
}

// --- Narrative arc: a named, dynamically-sized documentary structure (see
// backend/narrative_arc_llm.py for the prompt; currentArcSections holds the
// resolved parts), presented as one full-width row per arc part, stacked
// top-to-bottom in arc order - each row's label sits to the left, its
// section cards listed to the right of that label, one on top of the other.

// A plain click replaces the selection with just this index; a shift-click
// toggles it into/out of the current selection - drives both the .selected
// highlight (cards and their compact chips alike) and, in renderMovieEditor,
// which section(s) the top "Generate Storyboard"/"Generate Edit Plan"
// buttons target.
function handleSectionClick(index, event) {
  if (event.shiftKey) {
    if (selectedSectionIndices.has(index)) selectedSectionIndices.delete(index);
    else selectedSectionIndices.add(index);
  } else {
    selectedSectionIndices = new Set([index]);
  }
  const remaining = currentSections.filter(section => !section.removed);
  renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
}

// Dropping a chip onto a different arc-part row reorders currentSections
// (the single array every render already derives display order from) and,
// if the drop landed on a different act than the chip's section's current
// one, reassigns it - a full manual override of the LLM's arrangement. Drop
// position is "immediately before whichever chip your cursor lands on" (or
// appended to the end of that row if dropped elsewhere in it) - not
// pixel-precise before/after based on cursor position, but enough for a
// rough rearrange. Full .paper-section-blocks are deliberately not
// draggable - dragging a big two-column card around felt too easy to
// trigger by accident while editing its text/using its buttons; the
// compact chip strip is the only drag handle now.
// Split an array into n balanced, CONTIGUOUS chunks (preserving order) - used
// when an arc response leaves some paper sections unmapped. Some chunks may be
// empty when there are fewer sources than acts.
function splitContiguous(arr, n) {
  const chunks = [];
  const len = arr.length;
  for (let i = 0; i < n; i++) {
    chunks.push(arr.slice(Math.floor(i * len / n), Math.floor((i + 1) * len / n)));
  }
  return chunks;
}

// The first scene (in reading order) assigned to an act - the target for
// paper-section content dragged onto the act (see appendSectionTextToFirstScene)
// and the merge target when a mode is scaffolded (see runAcceptArc).
function firstSceneOfAct(actKey) {
  return currentSections.find(s => isSceneActive(s) && currentAssignments[s.index] === actKey) || null;
}

// Append a source paper section's text to the first scene's Scene Notes in an
// act (rather than adding the section as its own scene). Returns whether it did
// anything (there was a first scene and some text to add).
function appendSectionTextToFirstScene(actKey, sourceSection) {
  const scene = firstSceneOfAct(actKey);
  if (!scene) return false;
  const addition = (sourceSection.text || '').trim();
  if (!addition) return false;
  scene.text = scene.text ? `${scene.text}\n\n${addition}` : addition;
  return true;
}

function handleChipDrop(event, actKey) {
  event.preventDefault();
  const draggedIndex = parseInt(event.dataTransfer.getData('text/plain'), 10);
  if (Number.isNaN(draggedIndex)) return;

  const draggedPos = currentSections.findIndex(s => s.index === draggedIndex);
  if (draggedPos === -1) return;
  const [draggedSection] = currentSections.splice(draggedPos, 1);

  const targetChipEl = event.target.closest('.narrative-act-row-chip:not(.dragging)');
  const targetIndex = targetChipEl ? parseInt(targetChipEl.dataset.sectionIndex, 10) : null;
  if (targetIndex !== null && !Number.isNaN(targetIndex) && targetIndex !== draggedIndex) {
    const targetPos = currentSections.findIndex(s => s.index === targetIndex);
    currentSections.splice(targetPos === -1 ? currentSections.length : targetPos, 0, draggedSection);
  } else {
    currentSections.push(draggedSection);
  }

  if (currentAssignments[draggedIndex] !== actKey) {
    // Moved to a different act - its storyboard shot (if any) was written
    // for the old act's tone, same reasoning runAcceptArc already applies
    // when a different arc is accepted.
    delete draggedSection.visual;
    delete draggedSection.narration;
    currentAssignments[draggedIndex] = actKey;
  }

  const remaining = currentSections.filter(section => !section.removed);
  renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
}

// Scroll a scene card below the sticky action bar + timeline. Native
// scrollIntoView({block:'start'}) leaves the card underneath the timeline when
// the timeline is expanded, so calculate the live chrome height instead.
function scrollSceneBelowStickyChrome(target) {
  if (!target) return;
  const chromeBottom = ['.action-bar', '.premiere-timeline']
    .map(selector => document.querySelector(selector))
    .filter(Boolean)
    .map(el => el.getBoundingClientRect())
    .filter(rect => rect.height > 0)
    .reduce((bottom, rect) => Math.max(bottom, rect.bottom), 0);
  const gap = 14;
  const targetY = window.scrollY + target.getBoundingClientRect().top - chromeBottom - gap;
  window.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
}

function scrollTimelineClipToScene(sectionIndex) {
  const target = document.querySelector(
    `.paper-section-block[data-section-index="${sectionIndex}"]`);
  if (!target) return;
  activeSfxSectionIndex = sectionIndex;
  timelinePreviewProgrammaticScrollUntil = performance.now() + 1200;
  scrollSceneBelowStickyChrome(target);
}

// A single click selects (like a card click - see handleSectionClick); a
// double-click instead scrolls the section's full card into view without
// changing the selection, for jumping to a section spotted in the chip
// strip without having to scroll and hunt for its card.
function buildArcRowChip(section) {
  const chip = document.createElement('div');
  chip.className = 'narrative-act-row-chip';
  chip.classList.toggle('selected', selectedSectionIndices.has(section.index));
  chip.textContent = section.title;
  chip.title = section.title;
  chip.dataset.sectionIndex = String(section.index);
  chip.draggable = true;
  chip.addEventListener('dragstart', event => {
    event.dataTransfer.setData('text/plain', String(section.index));
    event.dataTransfer.effectAllowed = 'move';
    chip.classList.add('dragging');
  });
  chip.addEventListener('dragend', () => {
    chip.classList.remove('dragging');
  });
  chip.addEventListener('click', event => handleSectionClick(section.index, event));
  chip.addEventListener('dblclick', event => {
    event.stopPropagation();
    const card = document.querySelector(`.paper-section-block[data-section-index="${section.index}"]`);
    scrollSceneBelowStickyChrome(card);
  });
  return chip;
}

// Roughly where .premiere-timeline's own sticky top sits (see
// renderMovieEditor's scroll listener below) - just below the sticky
// .action-bar above it.
const OUTLINE_ACTIVE_THRESHOLD_PX = 90;

// Premiere-style A-roll/B-roll timeline, replacing the old vertical
// .narrative-arc-outline sidebar (a jump-list of acts) - one act-sized
// group per arc part, one equal-width clip per section within it. There's
// no real per-shot duration data to size clips by (this is a storyboard,
// not an edited timeline yet), so clip width is proportional to shot
// COUNT per act, not time - still gives the "how much of the film is this
// act" read a real timeline gives, just on a coarser axis.
//
// Each track has its own 3-step ladder (see buildVisualBox /
// VISUAL_BOX_RENDERERS and finishAssigningNarrationAudio for the same
// "real asset > drafted text only > nothing" distinction made elsewhere):
// unfilled (dashed, nothing yet) -> .drafted (an LLM suggestion, no real
// asset attached) -> .filled (a real asset for THAT lane). A narration asset
// therefore cannot color footage, and an SFX asset cannot color narration.
//
// Returns a Map from section.index to that section's [aRollClip, bRollClip]
// pair - renderMovieEditor's scroll listener uses this to highlight
// whichever's currently scrolled past.
// One track builder shared by all 4 rows below - same label/body/group
// structure every time, just a different label and a different per-section
// fill/draft predicate (see the TRACK_DEFS array in buildNarrativeTimeline).
function buildTimelineTrack(timelineEl, label) {
  const track = document.createElement('div');
  track.className = 'premiere-timeline-track';
  const trackLabel = document.createElement('div');
  trackLabel.className = 'premiere-timeline-track-label';
  trackLabel.textContent = label;
  track.appendChild(trackLabel);
  const body = document.createElement('div');
  body.className = 'premiere-timeline-track-body';
  track.appendChild(body);
  timelineEl.appendChild(track);
  return body;
}

// A scene's timeline track role: an explicit user override (section.role, set
// via buildSectionBlock's role picker or a scaffolded mode template) if
// present, else inferred from whatever's attached - a picked stock clip reads
// as B-roll, a generated/uploaded primary visual as A-roll, otherwise A-roll
// by default (the narrative spine). Sound effects are attached independently.
function getSceneRole(section) {
  if (section.role && SCENE_ROLE_LABELS[section.role]) return section.role;
  if (section.visualSource === 'stockVideo') return 'bRoll';
  if (['sketch', 'animatedSketch', 'video'].includes(section.visualSource)) return 'aRoll';
  return 'aRoll';
}

// A scene's on-screen duration in seconds - from its (auto- or hand-)
// generated edit plan, falling back to a flat default so the timeline can
// still size it before an edit plan exists.
function getSceneDuration(section) {
  const d = section.editPlan && section.editPlan.durationSeconds;
  return (typeof d === 'number' && d > 0) ? d : DEFAULT_SCENE_SECONDS;
}

// A single expository cutaway's on-screen duration - each cutaway surfaces as
// its own B-roll segment on the timeline (see buildNarrativeTimeline). Uses a
// per-cutaway duration_seconds if the generator supplied one, else a flat
// default.
const DEFAULT_CUTAWAY_SECONDS = 4;
function getCutawayDuration(cutaway) {
  const d = cutaway && cutaway.duration_seconds;
  return (typeof d === 'number' && d > 0) ? d : DEFAULT_CUTAWAY_SECONDS;
}

// Timeline fill is lane-specific: narration audio must not color the footage
// lane, a selected SFX clip must not color either visual lane, and a visual
// preview must not color narration. Keep these predicates separate even though
// every scene is represented by one shared visual clip spec below.
function hasSceneNarrationAudio(section) {
  return !!(section && (
    (Array.isArray(section.narrationClips) && section.narrationClips.length) ||
    section.narrationAudioPreviewUrl
  ));
}

// The blue FOOTAGE timeline fill represents media that is actually in the
// paper-section-open-slot, not merely a suggestion or a preview in the visual
// box. Uploaded/recorded footage and sketches live here, as do generated
// image/video references after the presenter deliberately drags them into the
// slot (applyDraggedGeneratedReference uses the same fields).
function hasSceneOpenSlotMedia(section) {
  return !!(section && (
    section.uploadedFootagePreviewUrl || section.uploadedSketchPreviewUrl
  ));
}

function hasSceneSoundEffect(section) {
  return getSelectedSfxDuration(section) > 0;
}

function isSceneFilledForRole(section, roleKey) {
  if (roleKey === 'soundEffects') return hasSceneSoundEffect(section);
  if (roleKey === 'narration') return hasSceneNarrationAudio(section);
  return hasSceneOpenSlotMedia(section);
}

function isSceneDraftedForRole(section, roleKey) {
  if (roleKey === 'narration') return !!effectiveSectionNarration(section);
  if (roleKey === 'soundEffects') return !!(section && section.audioQuery);
  if (roleKey === 'bRoll') return !!(section && section.videoQuery);
  return !!(section && section.visual && section.visual.trim());
}

// Dragging a documentary mode onto a timeline act scaffolds that act with the
// mode's scene template (see MODE_SCENE_TEMPLATES) - one A-roll/B-roll scene
// per entry, each a blank narrativeOnly scene the presenter then fills, with
// its role and an auto-generated edit plan (duration in seconds) already set.
// Content-preserving, like runAcceptArc: only the act's EMPTY scaffold scenes
// (narrativeOnly with no generated shot/cutaways/footage/narration) are cleared
// first, so re-dragging a mode resets the blank placeholders without piling on
// duplicates. A scaffold scene the presenter has already invested work in is
// kept (it stays in the act alongside the new template scenes), and any real
// (non-narrativeOnly) scene is kept too.
function scaffoldModeOntoAct(actKey, modeKey) {
  const template = MODE_SCENE_TEMPLATES[modeKey];
  if (!template) return;

  // "Worth keeping" = actual generated/added work, not just auto-populated
  // scene notes (which every scaffold scene gets), so an untouched scaffold
  // still clears on a mode change.
  const hasGeneratedContent = s => !!(
    s.startFramePreviewUrl || (s.cutaways && s.cutaways.length) ||
    s.narration || s.narrationAudioPreviewUrl || s.visualSource ||
    s.selectedVideo || s.selectedAudio || s.uploadedFootagePreviewUrl || s.uploadedSketchPreviewUrl
  );

  currentSections = currentSections.filter(section => {
    const isEmptyActScaffold = section.narrativeOnly
      && currentAssignments[section.index] === actKey
      && !hasGeneratedContent(section);
    if (isEmptyActScaffold) delete currentAssignments[section.index];
    return !isEmptyActScaffold;
  });

  template.forEach(spec => {
    // Title is the generic "New Scene"; the mode's descriptive label goes into
    // the scene notes instead (see the runAcceptArc scaffold for the same).
    const scene = insertSection(-1, 'New Scene', spec.title, actKey, true);
    scene.role = 'bRoll';
    delete scene.shotKind;
    // The edit plan is auto-generated here from the mode spec itself (not an
    // LLM call) - just the duration for now, with the same neutral defaults
    // /premiere/export and the ffmpeg render already tolerate.
    scene.editPlan = {
      transitionIn: 'hard_cut',
      durationSeconds: spec.durationSeconds,
      kenBurns: { enabled: false, pan: null },
      textOverlay: null,
    };
  });
  saveDebugSession();
  const remaining = currentSections.filter(s => !s.removed);
  renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
}

// Keep the accepted arc's serialized section order in lockstep with the
// timeline order. `currentArcSections` is the render-friendly form; the
// accepted arc keeps the original section_indices and any other metadata.
function persistCurrentArcOrder() {
  if (!selectedNarrationArc) return;
  const original = new Map((selectedNarrationArc.sections || []).map(part => [part.name || part.key, part]));
  selectedNarrationArc.sections = currentArcSections.map(act => original.get(act.key) || ({
    name: act.key,
    description: act.description || '',
    section_indices: [],
  }));
}

function reorderTimelineActs(sourceKey, targetKey, before) {
  if (!sourceKey || !targetKey || sourceKey === targetKey) return;
  const sourceIndex = currentArcSections.findIndex(act => act.key === sourceKey);
  const targetIndex = currentArcSections.findIndex(act => act.key === targetKey);
  if (sourceIndex === -1 || targetIndex === -1) return;
  const [source] = currentArcSections.splice(sourceIndex, 1);
  const adjustedTarget = currentArcSections.findIndex(act => act.key === targetKey);
  currentArcSections.splice(adjustedTarget + (before ? 0 : 1), 0, source);
  persistCurrentArcOrder();
  saveDebugSession();
  const remaining = currentSections.filter(section => !section.removed);
  renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
}

// Resize a visual timeline clip by dragging its right edge. The clip width is
// frozen during the gesture so neighboring clips do not reflow underneath the
// pointer; the proportional layout returns on the next render.
function wireClipResize(handle, clip, spec) {
  handle.addEventListener('pointerdown', event => {
    event.preventDefault();
    event.stopPropagation();
    const group = clip.parentElement;
    const siblings = group ? Array.from(group.children) : [clip];
    siblings.forEach(el => { el.style.flex = `0 0 ${el.getBoundingClientRect().width}px`; });
    const startX = event.clientX;
    const startWidth = clip.getBoundingClientRect().width;
    const startSeconds = Math.max(spec.seconds, 0.5);
    const pxPerSecond = startWidth / startSeconds || 1;
    let newSeconds = spec.seconds;
    try { handle.setPointerCapture(event.pointerId); } catch (err) { /* optional */ }
    const onMove = moveEvent => {
      const width = Math.max(6, startWidth + moveEvent.clientX - startX);
      clip.style.flex = `0 0 ${width}px`;
      newSeconds = Math.max(0.5, Math.round((width / pxPerSecond) * 2) / 2);
      clip.title = `${spec.title} · ${newSeconds}s`;
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      try { handle.releasePointerCapture(event.pointerId); } catch (err) { /* optional */ }
      newSeconds = Math.max(1, newSeconds);
      if (spec.kind === 'cutaway' && spec.cutaway) spec.cutaway.duration_seconds = newSeconds;
      else if (spec.section) {
        spec.section.editPlan = Object.assign(
          { transitionIn: 'hard_cut', kenBurns: { enabled: false, pan: null }, textOverlay: null },
          spec.section.editPlan || {}, { durationSeconds: newSeconds });
      }
      saveDebugSession();
      renderMovieEditor(resultsEl, currentLabel, currentSections.filter(section => !section.removed), currentAssignments);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}

// Drag a visual scene clip to reorder it within the current arc or move it to
// another act. Only the FOOTAGE lane is a scene-reordering surface; narration
// and sound-effects clips have their own audio timing controls.
function wireClipDrag(clip, section) {
  clip.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    if (event.target.closest('.premiere-timeline-clip-handle')) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    let ghost = null;
    let drop = null;
    const onMove = moveEvent => {
      if (!dragging) {
        if (Math.abs(moveEvent.clientX - startX) < 4 && Math.abs(moveEvent.clientY - startY) < 4) return;
        dragging = true;
        clip.classList.add('dragging');
        ghost = clip.cloneNode(true);
        ghost.classList.add('premiere-timeline-clip-ghost');
        ghost.classList.remove('dragging');
        ghost.style.width = `${clip.getBoundingClientRect().width}px`;
        document.body.appendChild(ghost);
      }
      ghost.style.left = `${moveEvent.clientX + 8}px`;
      ghost.style.top = `${moveEvent.clientY - 10}px`;
      const el = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
      const group = el && el.closest('.premiere-timeline-act-group[data-role="visual"]');
      if (!group) { drop = null; if (clipDropIndicatorEl) clipDropIndicatorEl.style.display = 'none'; return; }
      const neighbor = el.closest('.premiere-timeline-clip:not(.spacer)');
      const rect = group.getBoundingClientRect();
      let neighborIndex = null;
      let before = true;
      let indicatorX = rect.left;
      if (neighbor && neighbor !== clip) {
        const neighborRect = neighbor.getBoundingClientRect();
        before = moveEvent.clientX < neighborRect.left + neighborRect.width / 2;
        neighborIndex = parseInt(neighbor.dataset.sectionIndex, 10);
        indicatorX = before ? neighborRect.left : neighborRect.right;
      }
      drop = { actKey: group.dataset.actKey, neighborIndex, before };
      const indicator = ensureClipDropIndicator();
      indicator.style.display = 'block';
      indicator.style.left = `${indicatorX}px`;
      indicator.style.top = `${rect.top}px`;
      indicator.style.height = `${rect.height}px`;
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (clipDropIndicatorEl) clipDropIndicatorEl.style.display = 'none';
      if (ghost) ghost.remove();
      clip.classList.remove('dragging');
      if (dragging && drop) moveSectionInTimeline(section, drop.actKey, drop.neighborIndex, drop.before);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
}

let clipDropIndicatorEl = null;
function ensureClipDropIndicator() {
  if (!clipDropIndicatorEl) {
    clipDropIndicatorEl = document.createElement('div');
    clipDropIndicatorEl.className = 'premiere-timeline-drop-indicator';
    document.body.appendChild(clipDropIndicatorEl);
  }
  return clipDropIndicatorEl;
}

function moveSectionInTimeline(section, actKey, neighborIndex, before) {
  currentAssignments[section.index] = actKey;
  const position = currentSections.indexOf(section);
  if (position !== -1) currentSections.splice(position, 1);
  let insertAt = currentSections.length;
  if (neighborIndex != null && neighborIndex !== section.index) {
    const neighborPosition = currentSections.findIndex(item => item.index === neighborIndex);
    insertAt = neighborPosition === -1 ? currentSections.length : neighborPosition + (before ? 0 : 1);
  } else {
    const actPositions = currentSections
      .map((item, index) => currentAssignments[item.index] === actKey ? index : -1)
      .filter(index => index >= 0);
    if (actPositions.length) insertAt = actPositions[actPositions.length - 1] + 1;
  }
  currentSections.splice(insertAt, 0, section);
  saveDebugSession();
  renderMovieEditor(resultsEl, currentLabel, currentSections.filter(item => !item.removed), currentAssignments);
}

function wireTimelineActDrag(rulerGroup, actKey) {
  rulerGroup.draggable = true;
  rulerGroup.dataset.actKey = actKey;
  rulerGroup.addEventListener('dragstart', event => {
    event.dataTransfer.setData('application/x-timeline-act', actKey);
    event.dataTransfer.effectAllowed = 'move';
    rulerGroup.classList.add('dragging');
  });
  rulerGroup.addEventListener('dragend', () => rulerGroup.classList.remove('dragging'));
  rulerGroup.addEventListener('dragover', event => {
    if (!event.dataTransfer.types.includes('application/x-timeline-act')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    rulerGroup.classList.add('act-drop-over');
  });
  rulerGroup.addEventListener('dragleave', event => {
    if (!rulerGroup.contains(event.relatedTarget)) rulerGroup.classList.remove('act-drop-over');
  });
  rulerGroup.addEventListener('drop', event => {
    if (!event.dataTransfer.types.includes('application/x-timeline-act')) return;
    event.preventDefault();
    event.stopPropagation();
    rulerGroup.classList.remove('act-drop-over');
    const sourceKey = event.dataTransfer.getData('application/x-timeline-act');
    const before = event.clientX < rulerGroup.getBoundingClientRect().left
      + rulerGroup.getBoundingClientRect().width / 2;
    reorderTimelineActs(sourceKey, actKey, before);
  });
}

const MIN_SFX_SEGMENT_SECONDS = 0.25;

function normalizeSelectedAudioSegment(audio) {
  if (!audio) return null;
  const natural = Number(audio.sourceDurationSeconds || audio.duration || audio.durationSeconds);
  if (!(natural > 0)) return null;
  const trimStart = Math.max(0, Math.min(Number(audio.trimStartSeconds) || 0,
    Math.max(0, natural - MIN_SFX_SEGMENT_SECONDS)));
  const requestedDuration = Number(audio.durationSeconds);
  const duration = Math.max(MIN_SFX_SEGMENT_SECONDS, Math.min(
    requestedDuration > 0 ? requestedDuration : natural - trimStart,
    natural - trimStart));
  audio.sourceDurationSeconds = natural;
  audio.trimStartSeconds = trimStart;
  audio.durationSeconds = duration;
  if (!Number.isFinite(Number(audio.timelineOffsetSeconds))) audio.timelineOffsetSeconds = 0;
  return { naturalDurationSeconds: natural, trimStartSeconds: trimStart, durationSeconds: duration };
}

function getSelectedSfxDuration(section) {
  const segment = normalizeSelectedAudioSegment(section && section.selectedAudio);
  return segment ? segment.durationSeconds : 0;
}

// Greedy interval packing: each event goes in the first lane whose previous
// clip has ended. The same lane number is exported to Premiere, so the browser
// timeline and the real sequence represent overlaps identically.
function allocateSfxLanes(events) {
  const laneEnds = [];
  events.slice().sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds).forEach(event => {
    let lane = laneEnds.findIndex(end => end <= event.startSeconds + 0.001);
    if (lane === -1) lane = laneEnds.length;
    event.lane = lane;
    laneEnds[lane] = event.endSeconds;
  });
  return Math.max(1, laneEnds.length);
}

function wireSfxClipTrim(handle, clip, label, sfxEvent, edge, timelineDuration) {
  handle.addEventListener('pointerdown', pointerEvent => {
    pointerEvent.preventDefault();
    pointerEvent.stopPropagation();
    const trackWidth = clip.parentElement.getBoundingClientRect().width || 1;
    const secondsPerPixel = Math.max(timelineDuration, 0.001) / trackWidth;
    const startX = pointerEvent.clientX;
    const initialTrim = sfxEvent.sourceStartSeconds;
    const initialDuration = sfxEvent.selectedDurationSeconds;
    const initialSourceEnd = initialTrim + initialDuration;
    const timelineRoom = Math.max(MIN_SFX_SEGMENT_SECONDS,
      timelineDuration - sfxEvent.startSeconds);
    let nextTrim = initialTrim;
    let nextDuration = initialDuration;
    try { handle.setPointerCapture(pointerEvent.pointerId); } catch (err) { /* optional */ }

    const redraw = () => {
      const visibleDuration = Math.min(nextDuration, timelineRoom);
      clip.style.width = `${(visibleDuration / Math.max(timelineDuration, 0.001)) * 100}%`;
      label.textContent = `${sfxEvent.name} · ${nextTrim.toFixed(1)}–${(nextTrim + nextDuration).toFixed(1)}s`;
      clip.title = `${sfxEvent.name} · source ${nextTrim.toFixed(1)}–${(nextTrim + nextDuration).toFixed(1)}s · ${nextDuration.toFixed(1)}s`;
    };
    const onMove = moveEvent => {
      const delta = Math.round((moveEvent.clientX - startX) * secondsPerPixel * 10) / 10;
      if (edge === 'start') {
        nextTrim = Math.max(0, Math.min(initialTrim + delta,
          initialSourceEnd - MIN_SFX_SEGMENT_SECONDS));
        nextDuration = initialSourceEnd - nextTrim;
      } else {
        nextDuration = Math.max(MIN_SFX_SEGMENT_SECONDS, Math.min(
          initialDuration + delta,
          sfxEvent.sourceDurationSeconds - initialTrim,
          timelineRoom));
      }
      redraw();
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      try { handle.releasePointerCapture(pointerEvent.pointerId); } catch (err) { /* optional */ }
      sfxEvent.audioClip.trimStartSeconds = nextTrim;
      sfxEvent.audioClip.durationSeconds = nextDuration;
      normalizeSelectedAudioSegment(sfxEvent.audioClip);
      saveDebugSession();
      const remaining = currentSections.filter(section => !section.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}

function wireSfxClipMove(clip, label, sfxEvent, timelineDuration) {
  clip.addEventListener('pointerdown', pointerEvent => {
    if (pointerEvent.target.closest('.premiere-sfx-trim-handle')) return;
    pointerEvent.preventDefault();
    pointerEvent.stopPropagation();
    const trackWidth = clip.parentElement.getBoundingClientRect().width || 1;
    const secondsPerPixel = Math.max(timelineDuration, 0.001) / trackWidth;
    const startX = pointerEvent.clientX;
    const initialStart = sfxEvent.startSeconds;
    const maxStart = Math.max(0,
      timelineDuration - Math.min(sfxEvent.selectedDurationSeconds, timelineDuration));
    let nextStart = initialStart;
    let moved = false;
    clip.classList.add('dragging');
    try { clip.setPointerCapture(pointerEvent.pointerId); } catch (err) { /* optional */ }

    const onMove = moveEvent => {
      const delta = Math.round((moveEvent.clientX - startX) * secondsPerPixel * 10) / 10;
      if (Math.abs(moveEvent.clientX - startX) > 2) moved = true;
      nextStart = Math.max(0, Math.min(initialStart + delta, maxStart));
      clip.style.left = `${(nextStart / Math.max(timelineDuration, 0.001)) * 100}%`;
      label.textContent = `${sfxEvent.name} · @ ${nextStart.toFixed(1)}s`;
      clip.title = `${sfxEvent.name} · timeline ${nextStart.toFixed(1)}s · drag to move`;
    };
    const onUp = () => {
      clip.removeEventListener('pointermove', onMove);
      clip.removeEventListener('pointerup', onUp);
      try { clip.releasePointerCapture(pointerEvent.pointerId); } catch (err) { /* optional */ }
      clip.classList.remove('dragging');
      if (!moved) return;
      // Once deliberately moved, the SFX is an independent absolute-time
      // timeline clip rather than following the scene where it was chosen.
      sfxEvent.audioClip.timelineStartSeconds = nextStart;
      delete sfxEvent.audioClip.timelineOffsetSeconds;
      saveDebugSession();
      const remaining = currentSections.filter(section => !section.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
    };
    clip.addEventListener('pointermove', onMove);
    clip.addEventListener('pointerup', onUp);
  });
}

let activeSfxLayout = null;
let sfxPreviewEnabled = false;
let sfxPreviewSources = [];
let sfxPreviewAnimationId = null;
let sfxPreviewAnchorCtxTime = 0;
let sfxPreviewAnchorTimelineTime = 0;
let sfxPreviewRequestId = 0;
let sfxPlayheadEl = null;
let activeSfxSectionIndex = null;
let timelinePreviewScrolledSectionIndex = null;
let timelinePreviewProgrammaticScrollUntil = 0;
let timelinePreviewPausedTime = null;
let timelinePreviewPausedSectionIndex = null;
let premiereTimelineCollapsed = false;

// Each module relocated into storyboard.html's left sidebar keeps its own
// open/closed state.  This mirrors the Premiere timeline's collapse affordance
// without hiding the other sidebar modules when one is tucked away.
let sidebarModuleCollapsed = Object.create(null);
// Keep the optional storyboard sidebar out of the way on a fresh load. The
// existing Show panels toggle can reveal it, and the choice is persisted for
// subsequent refreshes once the presenter changes it.
let sidebarPanelsCollapsed = true;
const sfxAudioBufferCache = new Map();

function stopSfxPreview(disable) {
  sfxPreviewRequestId += 1;
  sfxPreviewSources.forEach(source => {
    try { source.stop(); } catch (err) { /* already stopped */ }
    try { source.disconnect(); } catch (err) { /* already disconnected */ }
  });
  sfxPreviewSources = [];
  if (sfxPreviewAnimationId) cancelAnimationFrame(sfxPreviewAnimationId);
  sfxPreviewAnimationId = null;
  if (disable) {
    sfxPreviewEnabled = false;
    timelinePreviewPausedTime = null;
    timelinePreviewPausedSectionIndex = null;
  }
  if (disable) document.querySelectorAll('.premiere-sfx-playhead').forEach(el => { el.style.display = 'none'; });
  if (disable) timelinePreviewScrolledSectionIndex = null;
}

function ensureSfxAudioBuffer(event) {
  if (event.kind === 'narration') {
    return ensureNarrationClipDecoded(event.audioClip).then(buffer => {
      if (activeSfxLayout) {
        event.endSeconds = Math.min(
          activeSfxLayout.durationSeconds, event.startSeconds + buffer.duration);
        event.durationSeconds = Math.max(0, event.endSeconds - event.startSeconds);
      }
      return buffer;
    });
  }
  const url = event.previewUrl;
  if (!url) return Promise.reject(new Error('Sound effect has no local preview URL.'));
  if (sfxAudioBufferCache.has(url)) return sfxAudioBufferCache.get(url);
  const promise = fetch(url)
    .then(response => {
      if (!response.ok) throw new Error(`Could not load sound effect (${response.status}).`);
      return response.arrayBuffer();
    })
    .then(bytes => ensurePlaybackAudioCtx().decodeAudioData(bytes))
    .catch(err => {
      sfxAudioBufferCache.delete(url);
      throw err;
    });
  sfxAudioBufferCache.set(url, promise);
  return promise;
}

function updateSfxPlayhead(timelineTime) {
  if (!activeSfxLayout || !sfxPlayheadEl) return;
  const duration = Math.max(activeSfxLayout.durationSeconds, 0.001);
  const bounded = Math.max(0, Math.min(timelineTime, duration));
  sfxPlayheadEl.style.display = '';
  sfxPlayheadEl.style.left = `${(bounded / duration) * 100}%`;
  document.querySelectorAll('.premiere-sfx-playhead').forEach(playhead => {
    playhead.style.display = '';
    playhead.style.left = `${(bounded / duration) * 100}%`;
  });
  activeSfxLayout.audioEvents.forEach(event => {
    if (!event.clipEl) return;
    const progress = Math.max(0, Math.min(1, (bounded - event.startSeconds) / Math.max(event.durationSeconds, 0.001)));
    event.clipEl.style.setProperty('--sfx-progress', `${progress * 100}%`);
    event.clipEl.classList.toggle('playing', bounded >= event.startSeconds && bounded < event.endSeconds);
  });
}

function startSfxPreviewAt(timelineTime) {
  if (!sfxPreviewEnabled || !activeSfxLayout) return;
  stopNarrationPlayback();
  stopSfxPreview(false);
  const requestId = sfxPreviewRequestId;
  const layoutAtStart = activeSfxLayout;
  const time = Math.max(0, Math.min(timelineTime, layoutAtStart.durationSeconds));
  // Narration duration may only become authoritative after decoding (notably
  // on a restored session), so load narration even when its provisional scene
  // duration says it ended; the decoded duration below decides spillover.
  const playable = layoutAtStart.audioEvents.filter(event =>
    event.previewUrl && (event.kind === 'narration' || event.endSeconds > time));
  const ctx = ensurePlaybackAudioCtx();
  if (ctx.state === 'suspended') ctx.resume();

  Promise.all(playable.map(event => ensureSfxAudioBuffer(event).then(buffer => ({ event, buffer })).catch(() => null)))
    .then(loaded => {
      if (!sfxPreviewEnabled || activeSfxLayout !== layoutAtStart || requestId !== sfxPreviewRequestId) return;
      sfxPreviewAnchorCtxTime = ctx.currentTime;
      sfxPreviewAnchorTimelineTime = time;
      loaded.filter(Boolean).forEach(({ event, buffer }) => {
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        const gain = ctx.createGain();
        gain.gain.value = event.kind === 'narration' ? 1.0 : 0.5;
        source.connect(gain);
        gain.connect(ctx.destination);
        const delay = Math.max(0, event.startSeconds - time);
        const timelineOffset = Math.max(0, time - event.startSeconds);
        const offset = Math.max(0, Number(event.sourceStartSeconds) || 0) + timelineOffset;
        const remaining = Math.min(buffer.duration - offset, event.endSeconds - Math.max(time, event.startSeconds));
        if (remaining > 0.001) {
          source.start(ctx.currentTime + delay, offset, remaining);
          sfxPreviewSources.push(source);
        }
      });
      const draw = () => {
        if (!sfxPreviewEnabled || activeSfxLayout !== layoutAtStart) return;
        const now = sfxPreviewAnchorTimelineTime + (ctx.currentTime - sfxPreviewAnchorCtxTime);
        updateSfxPlayhead(now);
        const sceneWindow = layoutAtStart.sceneWindows.find(
          windowSpec => now >= windowSpec.startSeconds && now < windowSpec.endSeconds);
        if (sceneWindow && timelinePreviewScrolledSectionIndex !== sceneWindow.sectionIndex) {
          timelinePreviewScrolledSectionIndex = sceneWindow.sectionIndex;
          activeSfxSectionIndex = sceneWindow.sectionIndex;
          const target = document.querySelector(
            `.paper-section-block[data-section-index="${sceneWindow.sectionIndex}"]`);
          if (target) {
            timelinePreviewProgrammaticScrollUntil = performance.now() + 1200;
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }
        if (now >= layoutAtStart.durationSeconds) {
          stopSfxPreview(true);
          return;
        }
        sfxPreviewAnimationId = requestAnimationFrame(draw);
      };
      draw();
    });
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopSfxPreview(true);
});

// Spacebar is the single timeline transport. It starts from the scene currently
// active in the scrollspy, mixes narration + all overlapping SFX, advances the
// global playhead, and follows subsequent scene cards as time passes.
document.addEventListener('keydown', event => {
  if (event.code !== 'Space' || event.repeat || !activeSfxLayout) return;
  const target = event.target;
  if (target && (target.matches('input, textarea, select, button') || target.isContentEditable)) return;
  event.preventDefault();
  if (sfxPreviewEnabled) {
    const pausedAt = sfxPreviewAnchorTimelineTime
      + (ensurePlaybackAudioCtx().currentTime - sfxPreviewAnchorCtxTime);
    const pausedSection = activeSfxSectionIndex;
    stopSfxPreview(true);
    timelinePreviewPausedTime = pausedAt;
    timelinePreviewPausedSectionIndex = pausedSection;
    return;
  }
  if (!activeSfxLayout.audioEvents.length) return;
  sfxPreviewEnabled = true;
  timelinePreviewScrolledSectionIndex = null;
  const resumeHere = timelinePreviewPausedSectionIndex === activeSfxSectionIndex
    && Number.isFinite(timelinePreviewPausedTime);
  const start = resumeHere
    ? timelinePreviewPausedTime
    : (activeSfxLayout.sceneStartSeconds.get(activeSfxSectionIndex) || 0);
  timelinePreviewPausedTime = null;
  timelinePreviewPausedSectionIndex = null;
  startSfxPreviewAt(start);
});

// The Act Board has its own scene transport (with the same narration,
// footage, and music/sound layers), so Space should control it even when the
// presenter has not focused a particular rail. Use capture phase to claim the
// key before the page-level Timeline + Scenes transport, but leave editable
// fields and buttons alone so typing/activating controls remains unaffected.
document.addEventListener('keydown', event => {
  if (event.code !== 'Space' || event.repeat) return;
  const target = event.target;
  if (target && (target.matches?.('input, textarea, select, button, a')
    || target.isContentEditable)) return;
  const board = document.querySelector('.storyboard-act-board-view');
  if (!board) return;
  const playback = board.querySelector(
    '.storyboard-act-board-selected-scene-playback-panel:not([hidden]) '
      + '.storyboard-act-board-selected-scene-playback-mount:not([hidden]) '
      + '.storyboard-act-board-playback',
  );
  const state = playback?._actBoardPlaybackState;
  if (!state?.playButton) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  state.playButton.click();
}, true);

function buildNarrativeTimeline(timelineEl, sections, assignmentsByIndex) {
  timelineEl.innerHTML = '';
  timelineEl.classList.toggle('collapsed', premiereTimelineCollapsed);

  const timelineHeader = document.createElement('div');
  timelineHeader.className = 'premiere-timeline-header';
  const timelineTitle = document.createElement('span');
  timelineTitle.textContent = 'Timeline';
  timelineHeader.appendChild(timelineTitle);
  // const timelineHint = document.createElement('span');
  // timelineHint.className = 'premiere-timeline-header-hint';
  // timelineHint.textContent = 'Drag Act headers to reorder · drag scene clips to rearrange or resize';
  // timelineHeader.appendChild(timelineHint);
  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'premiere-timeline-collapse-btn';
  const updateCollapseButton = () => {
    const action = premiereTimelineCollapsed ? 'Expand' : 'Collapse';
    collapseBtn.textContent = premiereTimelineCollapsed ? '▾' : '▴';
    collapseBtn.title = `${action} Timeline`;
    collapseBtn.setAttribute('aria-label', `${action} Timeline`);
    collapseBtn.setAttribute('aria-expanded', String(!premiereTimelineCollapsed));
  };
  updateCollapseButton();
  collapseBtn.addEventListener('click', () => {
    premiereTimelineCollapsed = !premiereTimelineCollapsed;
    timelineEl.classList.toggle('collapsed', premiereTimelineCollapsed);
    updateCollapseButton();
    saveDebugSession();
    collapseBtn.blur(); // next Space press remains the global audio transport
  });
  timelineHeader.appendChild(collapseBtn);
  timelineEl.appendChild(timelineHeader);

  // The ruler mirrors a track's structure (a label-width spacer + a body)
  // so its act labels line up exactly with the clip groups in the track
  // bodies below - see the .premiere-timeline-ruler* CSS. Acts go into
  // rulerBody, not the ruler directly.
  const ruler = document.createElement('div');
  ruler.className = 'premiere-timeline-ruler';
  const rulerSpacer = document.createElement('div');
  rulerSpacer.className = 'premiere-timeline-ruler-spacer';
  ruler.appendChild(rulerSpacer);
  const rulerBody = document.createElement('div');
  rulerBody.className = 'premiere-timeline-ruler-body';
  ruler.appendChild(rulerBody);
  timelineEl.appendChild(ruler);

  // Primary and Cutaway are mutually-exclusive visual scene roles. Sound
  // effects form an independent parallel track populated from selectedAudio,
  // so any visual scene can have one without moving visual lanes.
  const TRACK_DEFS = [
    { key: 'narration', label: 'NARRATION' },
    { key: 'footage', label: 'FOOTAGE' },
    { key: 'soundEffects', label: 'SOUND EFFECTS' },
  ];
  const trackBodies = TRACK_DEFS.map(def => buildTimelineTrack(timelineEl, def.label));

  // Dropping a mode onto an act scaffolds scenes there (see
  // scaffoldModeOntoAct). The whole act column - the ruler label plus every
  // track group - is ONE drop unit (actEls): hovering any of them highlights
  // them all together, so it reads as dropping onto the act, not a single
  // track. The highlight persists while the pointer moves between the act's
  // own rows and only clears when it leaves the act entirely.
  const makeActModeDropTarget = (el, actKey, actEls) => {
    const setHighlight = on => actEls.forEach(e => e.classList.toggle('mode-drop-over', on));
    el.addEventListener('dragover', event => {
      if (!event.dataTransfer.types.includes('application/x-documentary-mode')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setHighlight(true);
    });
    el.addEventListener('dragleave', event => {
      const to = event.relatedTarget;
      if (to && actEls.some(e => e === to || e.contains(to))) return; // still within this act
      setHighlight(false);
    });
    el.addEventListener('drop', event => {
      setHighlight(false);
      const modeKey = event.dataTransfer.getData('application/x-documentary-mode');
      if (!modeKey || !MODE_SCENE_TEMPLATES[modeKey]) return;
      event.preventDefault();
      scaffoldModeOntoAct(actKey, modeKey);
    });
  };

  const clipsBySectionIndex = new Map();
  const sceneStartSeconds = new Map();
  const actLayouts = [];
  let globalActStart = 0;

  currentArcSections.forEach((act, actIndex) => {
    const rowSections = sections.filter(s => assignmentsByIndex[s.index] === act.key);
    if (rowSections.length === 0) return; // renderMovieEditor auto-populates blank rows before this runs

    // Each scene sits in its own role's track as one clip spec, sized by its
    // duration in seconds. An expository scene additionally contributes one
    // B-roll clip spec PER cutaway. `combinedAB` keeps the A-roll/B-roll clips
    // in reading order (for the interspersed layout below).
    const clipsByTrack = { aRoll: [], bRoll: [], soundEffects: [] };
    const combinedAB = [];
    rowSections.forEach(section => {
      const role = getSceneRole(section);
      const spec = {
        kind: 'section', section, seconds: getSceneDuration(section),
        filled: isSceneFilledForRole(section, role),
        drafted: !isSceneFilledForRole(section, role) && isSceneDraftedForRole(section, role),
        title: section.title,
      };
      // Once an expository primary scene has generated cutaways, those
      // cutaways ARE its picture edit. Keep narration in the parallel audio
      // mix, but do not also draw a primary visual underneath them.
      const cutawaysReplacePrimary = role === 'aRoll' && section.cutaways && section.cutaways.length;
      if (!cutawaysReplacePrimary) {
        clipsByTrack[role].push(spec);
        if (role === 'aRoll' || role === 'bRoll') combinedAB.push({ roleKey: role, spec });
      }
      if (section.cutaways && section.cutaways.length) {
        section.cutaways.forEach((cut, ci) => {
          const cutawaySpec = {
            kind: 'cutaway', section, cutaway: cut, cutawayIndex: ci,
            seconds: getCutawayDuration(cut),
            // Cutaways are generated visual suggestions, not open-slot media;
            // only an uploaded or deliberately dragged-in reference should
            // turn the FOOTAGE lane blue for this scene.
            filled: hasSceneOpenSlotMedia(section),
            drafted: false,
            title: `${cut.caption || 'Cutaway'} · Cutaway`,
          };
          clipsByTrack.bRoll.push(cutawaySpec);
          combinedAB.push({ roleKey: 'bRoll', spec: cutawaySpec });
        });
      }
    });

    // Primary and Cutaway are one sequential visual edit: every clip receives
    // a unique time range and the opposite lane gets a spacer. This invariant
    // also applies to generated expository cutaways—visual tracks never overlap.
    // Narration and SFX remain independent audio layers and may span these cuts.
    let t = 0;
    combinedAB.forEach(c => {
      c.start = t;
      if (!sceneStartSeconds.has(c.spec.section.index)) {
        sceneStartSeconds.set(c.spec.section.index, globalActStart + t);
      }
      t += c.spec.seconds;
    });
    const actTotal = Math.max(1, t);
    actLayouts.push({ key: act.key, startSeconds: globalActStart, durationSeconds: actTotal });

    // flex-basis pinned to 0 (not the shorthand's implied auto) so the ruler
    // label's own text width doesn't compete with its flex-grow share and
    // misalign the ruler against the content-less clips below it.
    const actFlex = `${actTotal} 1 0`;

    const rulerGroup = document.createElement('div');
    rulerGroup.className = 'premiere-timeline-act';
    rulerGroup.style.flex = actFlex;
    rulerGroup.textContent = `Act ${actIndex + 1}: ${act.label}`;
    rulerGroup.title = 'Drag this act to reorder it; drag a documentary mode here to scaffold scenes';
    rulerBody.appendChild(rulerGroup);
    wireTimelineActDrag(rulerGroup, act.key);

    const trackGroups = trackBodies.map((body, trackIndex) => {
      const group = document.createElement('div');
      group.className = 'premiere-timeline-act-group';
      group.style.flex = actFlex;
      group.dataset.actKey = act.key;
      group.dataset.role = trackIndex === 1 ? 'visual' : TRACK_DEFS[trackIndex].key;
      body.appendChild(group);
      return group;
    });

    // Ruler label + all track groups are one drop unit (highlight together).
    const actDropEls = [rulerGroup, ...trackGroups];
    actDropEls.forEach(el => makeActModeDropTarget(el, act.key, actDropEls));

    const buildClip = spec => {
      const { section, seconds } = spec;
      const clip = document.createElement('div');
      clip.className = 'premiere-timeline-clip';
      if (spec.kind === 'cutaway') clip.classList.add('cutaway-clip');
      clip.style.flex = `${seconds} 1 0`; // width proportional to duration
      clip.dataset.sectionIndex = String(section.index);
      clip.classList.toggle('filled', spec.filled);
      clip.classList.toggle('drafted', spec.drafted);
      // clip.title = `${spec.title} · ${Math.round(seconds)}s · Drag to rearrange; drag the right edge to resize`;
      clip.addEventListener('click', event => {
        if (event.detail > 1 || event.target.closest('.premiere-timeline-clip-handle')) return;
        scrollTimelineClipToScene(section.index);
      });
      const handle = document.createElement('div');
      handle.className = 'premiere-timeline-clip-handle';
      handle.title = 'Drag to change this scene duration';
      clip.appendChild(handle);
      wireClipResize(handle, clip, spec);
      if (spec.kind !== 'cutaway') wireClipDrag(clip, section);
      if (!clipsBySectionIndex.has(section.index)) clipsBySectionIndex.set(section.index, []);
      clipsBySectionIndex.get(section.index).push(clip);
      return clip;
    };
    const addSpacer = (group, seconds) => {
      if (seconds <= 0.001) return;
      const spacer = document.createElement('div');
      spacer.className = 'premiere-timeline-clip spacer';
      spacer.style.flex = `${seconds} 1 0`;
      group.appendChild(spacer);
    };

    TRACK_DEFS.forEach((def, ti) => {
      const group = trackGroups[ti];
      if (def.key === 'footage') {
        combinedAB.forEach(c => group.appendChild(buildClip(c.spec)));
      } else addSpacer(group, actTotal);
    });
    globalActStart += actTotal;
  });

  // Replace the per-act placeholder groups with one absolute-time SFX canvas.
  // This lets a natural-duration sound cross act boundaries, while lane packing
  // keeps overlapping effects visible and mirrors the Premiere export.
  const sfxBody = trackBodies[2];
  sfxBody.innerHTML = '';
  sfxBody.classList.add('premiere-sfx-track-body');
  const sfxEvents = sections.map(section => {
    const segment = normalizeSelectedAudioSegment(section.selectedAudio);
    const selectedDuration = segment && segment.durationSeconds;
    const sceneStart = sceneStartSeconds.get(section.index);
    if (!(selectedDuration > 0) || sceneStart == null || sceneStart >= globalActStart) return null;
    const storedTimelineStart = Number(section.selectedAudio.timelineStartSeconds);
    const requestedStart = Number.isFinite(storedTimelineStart)
      ? storedTimelineStart
      : sceneStart + (Number(section.selectedAudio.timelineOffsetSeconds) || 0);
    const latestStart = Math.max(0, globalActStart - Math.min(selectedDuration, globalActStart));
    const start = Math.max(0, Math.min(requestedStart, latestStart));
    const end = Math.min(globalActStart, start + selectedDuration);
    return {
      sectionIndex: section.index,
      section,
      audioClip: section.selectedAudio,
      name: section.selectedAudio.name || section.title || 'Sound effect',
      previewUrl: section.selectedAudio.localPreviewUrl || section.selectedAudio.preview_url || '',
      filePath: section.selectedAudio.localFilePath || null,
      sceneStartSeconds: sceneStart,
      startSeconds: start,
      endSeconds: end,
      durationSeconds: end - start,
      selectedDurationSeconds: selectedDuration,
      sourceStartSeconds: segment.trimStartSeconds,
      sourceDurationSeconds: segment.naturalDurationSeconds,
    };
  }).filter(Boolean);
  const narrationEvents = sections.flatMap(section => {
    const sceneStart = sceneStartSeconds.get(section.index);
    if (sceneStart == null) return [];
    return migrateNarrationClips(section).map(audioClip => {
      const segment = normalizeSelectedAudioSegment(audioClip);
      if (!segment) return null;
      const stored = Number(audioClip.timelineStartSeconds);
      const requested = Number.isFinite(stored)
        ? stored : sceneStart + (Number(audioClip.timelineOffsetSeconds) || 0);
      const start = Math.max(0, Math.min(requested, Math.max(0, globalActStart - MIN_SFX_SEGMENT_SECONDS)));
      const end = Math.min(globalActStart, start + segment.durationSeconds);
      return {
        kind: 'narration', sectionIndex: section.index, section, audioClip,
        name: 'Narration',
        previewUrl: audioClip.previewUrl, filePath: audioClip.filePath || null,
        startSeconds: start, endSeconds: end, durationSeconds: end - start,
        selectedDurationSeconds: segment.durationSeconds,
        sourceStartSeconds: segment.trimStartSeconds,
        sourceDurationSeconds: segment.naturalDurationSeconds,
      };
    }).filter(Boolean);
  });
  allocateSfxLanes(narrationEvents);
  const laneCount = allocateSfxLanes(sfxEvents);
  sfxBody.style.height = `${laneCount * 25}px`;

  actLayouts.forEach(act => {
    const zone = document.createElement('div');
    zone.className = 'premiere-sfx-act-zone';
    zone.style.left = `${(act.startSeconds / Math.max(globalActStart, 1)) * 100}%`;
    zone.style.width = `${(act.durationSeconds / Math.max(globalActStart, 1)) * 100}%`;
    sfxBody.appendChild(zone);
  });
  sfxEvents.forEach(event => {
    const clip = document.createElement('div');
    clip.className = 'premiere-sfx-clip filled';
    clip.dataset.sectionIndex = String(event.sectionIndex);
    clip.style.left = `${(event.startSeconds / Math.max(globalActStart, 1)) * 100}%`;
    clip.style.width = `${(event.durationSeconds / Math.max(globalActStart, 1)) * 100}%`;
    clip.style.top = `${event.lane * 25}px`;
    clip.title = `${event.name} · timeline ${event.startSeconds.toFixed(1)}s · source ${event.sourceStartSeconds.toFixed(1)}–${(event.sourceStartSeconds + event.selectedDurationSeconds).toFixed(1)}s · drag clip to move`;
    const label = document.createElement('span');
    label.textContent = `${event.name} · ${event.sourceStartSeconds.toFixed(1)}–${(event.sourceStartSeconds + event.selectedDurationSeconds).toFixed(1)}s`;
    clip.appendChild(label);
    const trimInHandle = document.createElement('span');
    trimInHandle.className = 'premiere-sfx-trim-handle start';
    trimInHandle.title = 'Drag to choose where the selected source segment begins';
    clip.appendChild(trimInHandle);
    const trimOutHandle = document.createElement('span');
    trimOutHandle.className = 'premiere-sfx-trim-handle end';
    trimOutHandle.title = 'Drag to change the selected sound duration';
    clip.appendChild(trimOutHandle);
    wireSfxClipTrim(trimInHandle, clip, label, event, 'start', globalActStart);
    wireSfxClipTrim(trimOutHandle, clip, label, event, 'end', globalActStart);
    wireSfxClipMove(clip, label, event, globalActStart);
    clip.addEventListener('click', clickEvent => {
      if (clickEvent.target.closest('.premiere-sfx-trim-handle')) return;
      scrollTimelineClipToScene(event.sectionIndex);
    });
    sfxBody.appendChild(clip);
    event.clipEl = clip;
    if (!clipsBySectionIndex.has(event.sectionIndex)) clipsBySectionIndex.set(event.sectionIndex, []);
    clipsBySectionIndex.get(event.sectionIndex).push(clip);
  });

  // Narration is a second independently timed, multi-lane audio canvas. It
  // uses the same clip mover/trimmers as SFX, including source-in selection.
  const narrationBody = trackBodies[0];
  narrationBody.innerHTML = '';
  narrationBody.classList.add('premiere-sfx-track-body');
  const narrationLaneCount = allocateSfxLanes(narrationEvents);
  narrationBody.style.height = `${narrationLaneCount * 25}px`;
  actLayouts.forEach(act => {
    const zone = document.createElement('div');
    zone.className = 'premiere-sfx-act-zone';
    zone.style.left = `${(act.startSeconds / Math.max(globalActStart, 1)) * 100}%`;
    zone.style.width = `${(act.durationSeconds / Math.max(globalActStart, 1)) * 100}%`;
    narrationBody.appendChild(zone);
  });
  narrationEvents.forEach(event => {
    const clip = document.createElement('div');
    clip.className = 'premiere-sfx-clip premiere-narration-clip filled';
    clip.dataset.sectionIndex = String(event.sectionIndex);
    clip.style.left = `${(event.startSeconds / Math.max(globalActStart, 1)) * 100}%`;
    clip.style.width = `${(event.durationSeconds / Math.max(globalActStart, 1)) * 100}%`;
    clip.style.top = `${event.lane * 25}px`;
    const label = document.createElement('span');
    label.textContent = `${event.name} · ${event.sourceStartSeconds.toFixed(1)}–${(event.sourceStartSeconds + event.selectedDurationSeconds).toFixed(1)}s`;
    clip.appendChild(label);
    ['start', 'end'].forEach(edge => {
      const handle = document.createElement('span');
      handle.className = `premiere-sfx-trim-handle ${edge}`;
      clip.appendChild(handle);
      wireSfxClipTrim(handle, clip, label, event, edge, globalActStart);
    });
    wireSfxClipMove(clip, label, event, globalActStart);
    clip.addEventListener('click', clickEvent => {
      if (clickEvent.target.closest('.premiere-sfx-trim-handle')) return;
      scrollTimelineClipToScene(event.sectionIndex);
    });
    narrationBody.appendChild(clip);
    event.clipEl = clip;
    ensureSfxAudioBuffer(event).catch(() => { });
  });
  const narrationPlayhead = document.createElement('div');
  narrationPlayhead.className = 'premiere-sfx-playhead';
  narrationPlayhead.style.display = 'none';
  narrationBody.appendChild(narrationPlayhead);
  const playhead = document.createElement('div');
  playhead.className = 'premiere-sfx-playhead';
  playhead.style.display = 'none';
  sfxBody.appendChild(playhead);

  // const sfxTrackLabel = sfxBody.parentElement.querySelector('.premiere-timeline-track-label');
  // const previewHint = document.createElement('span');
  // previewHint.className = 'premiere-audio-preview-hint';
  // previewHint.textContent = 'SPACE · AUDIO';
  // previewHint.title = 'Press Space to play or pause narration and sound effects from the active scene';
  // sfxTrackLabel.appendChild(previewHint);

  const sceneWindows = Array.from(sceneStartSeconds.entries())
    .map(([sectionIndex, startSeconds]) => ({ sectionIndex, startSeconds }))
    .sort((a, b) => a.startSeconds - b.startSeconds);
  sceneWindows.forEach((windowSpec, index) => {
    windowSpec.endSeconds = index + 1 < sceneWindows.length
      ? sceneWindows[index + 1].startSeconds : globalActStart;
  });
  activeSfxLayout = {
    durationSeconds: globalActStart, sceneStartSeconds, actLayouts, sfxEvents,
    narrationEvents, audioEvents: [...narrationEvents, ...sfxEvents], sceneWindows,
  };
  sfxPlayheadEl = playhead;
  sfxEvents.forEach(event => ensureSfxAudioBuffer(event).catch(() => { }));

  return { clipsBySectionIndex, layout: activeSfxLayout };
}

