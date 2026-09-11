//#region --- EXTRACT SOURCE MATERIAL
// Click-to-edit in place: turns `el` into a contenteditable field on click
// (without letting that click also bubble up to the section block's own
// click-to-exclude handler), saves back through `setValue` on blur/Enter,
// and reverts on Escape. Leaves `el` untouched if nothing actually changed,
// so a click-then-blur with no edit can't clobber real content with
// whatever placeholder text happened to be showing (e.g. "(no text
// captured for this section)" for an empty section).
function makeEditable(el, getValue, setValue, { multiline, allowEmpty } = {}) {
  el.classList.add('editable-field');

  el.addEventListener('click', event => {
    event.stopPropagation();
    if (el.isContentEditable) return;

    el.contentEditable = 'true';
    el.classList.add('editing');
    el.focus();

    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });

  el.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      el.textContent = getValue();
      el.blur();
    } else if (event.key === 'Enter' && !multiline) {
      event.preventDefault();
      el.blur();
    }
  });

  el.addEventListener('blur', () => {
    el.contentEditable = 'false';
    el.classList.remove('editing');

    const oldValue = getValue();
    const newValue = el.textContent.trim();
    if (!newValue) {
      if (allowEmpty) {
        // Clear the underlying value; getValue() then returns the placeholder,
        // so the field shows that (e.g. Scene Notes emptied out).
        setValue('');
        el.textContent = getValue();
      } else {
        el.textContent = oldValue; // don't allow clearing a field (e.g. titles)
      }
      return;
    }
    if (newValue !== oldValue) {
      setValue(newValue);
    }
  });
}

// Indices are assigned once and never reused (see the state comment near
// currentSections), so a manually-created section - via "+ Add Section" -
// needs a genuinely new one rather than reusing/incrementing off
// currentSections.length (which drifts once any section is added/removed).
function nextSectionIndex() {
  return Math.max(-1, ...currentSections.map(s => s.index)) + 1;
}

// Inserts a brand-new section right after `afterIndex` (or at the end, if
// afterIndex isn't found - e.g. the flat pre-arrangement feed has nothing to
// insert "after" in arc terms). `act`, when given, is one of
// currentArcSections' keys, so the new section immediately appears in that
// row; omitted when there's no arrangement yet to place it into.
// `narrativeOnly`, when true, marks this as a blank placeholder created for
// the arc's structure rather than derived from the paper (an empty act row,
// an accepted arc, or a mode scaffold - see renderMovieEditor). These scene
// placeholders never belong in the index.html source-material feed.
function insertSection(afterIndex, title, text, act, narrativeOnly) {
  const section = { index: nextSectionIndex(), title, text, image: null, removed: false };
  if (narrativeOnly) section.narrativeOnly = true;
  const pos = currentSections.findIndex(s => s.index === afterIndex);
  currentSections.splice(pos === -1 ? currentSections.length : pos + 1, 0, section);
  if (act) currentAssignments[section.index] = act;
  return section;
}

// The visual box (black, top-left of an arranged card - see buildSectionBlock)
// shows whichever media is currently the best candidate for this shot, in
// priority order: a picked stock video, uploaded/recorded footage, the
// paper's own figure image, or (nothing concrete yet) the storyboard's
// suggested visual direction as plain text.
// Each of these mirrors one concrete visual a section could have - built
// as a lookup (rather than an if/else chain) so buildVisualBox below can
// try section.visualSource (whichever one the presenter most recently
// recorded/generated/picked - see runUploadFootage/runGenerateSketch/
// buildMediaVideoOption, all of which set it) first, falling through to
// the rest only if that one's own data is missing (e.g. a stale session).
// Without visualSource, a *fixed* priority order would mean whichever of
// these got set first (say, clicking a Find Footage frame) permanently
// shadows anything done after it (recording new webcam footage, say) -
// each returns null when its own section field isn't set, so the caller
// can just move on to the next candidate.
// Human-readable movement labels for the shot-frames artboard header (see
// the shotFrames renderer) - keys are shot_plan_llm.py's movement vocabulary.
const SHOT_MOVEMENT_LABELS = {
  static: 'STATIC', pan: 'PAN', tilt: 'TILT', push_in: 'PUSH IN',
  pull_out: 'PULL OUT', tracking: 'TRACKING', handheld: 'HANDHELD',
};

// Maps a shot's inferred camera movement (shot_plan_llm.py's 7-value
// vocabulary) onto one of the cutaway motion types, so a narration-driven
// shot's frames animate with the SAME orange camera-frame overlay the
// expository cutaways use (see the cutaways renderer + .cutaway-stage.motion-*
// CSS). 'static' still gets a gentle move so every generated shot animates.
const SHOT_MOVEMENT_TO_MOTION = {
  static: 'approach', pan: 'reveal', tilt: 'ascend', push_in: 'approach',
  pull_out: 'retreat', tracking: 'orbit', handheld: 'countermotion',
};

// Display labels for a cutaway's camera motion (see the cutaways renderer /
// cutaway_llm.py's _MOTION_TYPES / directional_motion_sketches.html).
const CUTAWAY_MOTION_LABELS = {
  reveal: 'Reveal →', return: 'Return ←', approach: 'Approach', retreat: 'Retreat',
  ascend: 'Ascend ↑', descend: 'Descend ↓', orbit: 'Orbit ↻',
  countermotion: 'Countermotion', enterexit: 'Enter / Exit',
};

function configureUploadedFootagePreview(player, section) {
  if (section.uploadedFootageThumbnailUrl) {
    player.poster = section.uploadedFootageThumbnailUrl;
    player.preload = 'metadata';
    return;
  }
  // Migration fallback for uploads saved before thumbnail_url existed: make
  // the browser decode an early frame instead of leaving a black rectangle.
  player.preload = 'auto';
  player.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(player.duration) && player.duration > 0) {
      player.currentTime = Math.min(0.05, player.duration / 2);
    }
  }, { once: true });
}

function configureGeneratedVideoPreview(player, section) {
  // Prefer the exact frame used to seed the video. Older responses/sessions
  // may not have animatedSketchThumbnailUrl, so fall back through the selected
  // example, generated shot frame, and first example instead of showing black.
  const firstExample = section.exampleShots && section.exampleShots[0];
  const posterUrl = section.animatedSketchThumbnailUrl
    || (section.selectedExample && section.selectedExample.url)
    || section.startFramePreviewUrl
    || (firstExample && (firstExample.thumbnail_url || firstExample.url));
  if (posterUrl) {
    const separator = posterUrl.includes('?') ? '&' : '?';
    const version = section.animatedSketchGeneratedAt || section.examplesGeneratedAt || Date.now();
    player.poster = `${posterUrl}${separator}t=${version}`;
    player.preload = 'metadata';
    return;
  }
  // Last-resort migration path when no generated still was persisted.
  player.preload = 'auto';
  player.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(player.duration) && player.duration > 0) {
      player.currentTime = Math.min(0.05, player.duration / 2);
    }
  }, { once: true });
}

const VISUAL_BOX_RENDERERS = {
  uploadedSketch(section) {
    if (!section.uploadedSketchPreviewUrl) return null;
    const img = document.createElement('img');
    img.className = 'paper-section-visual-media user-sketch-preview';
    img.src = `${section.uploadedSketchPreviewUrl}?t=${section.uploadedSketchUploadedAt || ''}`;
    img.alt = 'Uploaded scene sketch';
    return img;
  },
  // Expository B-roll cutaways (see runGenerateCutaways / /paper/generate_cutaways):
  // a horizontal scroll of cards, each an AI background still with an animated
  // orange camera-frame overlay (motion-<type>, ported from
  // directional_motion_sketches.html) and a caption. Planning-only previews.
  cutaways(section) {
    if (!section.cutaways || !section.cutaways.length) return null;
    const bust = section.cutawaysGeneratedAt ? `?t=${section.cutawaysGeneratedAt}` : '';
    const row = document.createElement('div');
    row.className = 'cutaways-row';
    section.cutaways.forEach(cut => {
      const card = document.createElement('div');
      card.className = 'cutaway-card';

      const stage = document.createElement('div');
      stage.className = `cutaway-stage motion-${cut.motion_type || 'approach'}`;
      const img = document.createElement('img');
      img.className = 'cutaway-bg';
      img.src = `${cut.preview_url}${bust}`;
      img.alt = cut.caption || 'cutaway';
      stage.appendChild(img);
      const cam = document.createElement('div'); // the animated camera frame
      cam.className = 'cutaway-camera';
      stage.appendChild(cam);
      card.appendChild(stage);

      const cap = document.createElement('div');
      cap.className = 'cutaway-caption';
      const motionLabel = CUTAWAY_MOTION_LABELS[cut.motion_type] || cut.motion_type || '';
      cap.textContent = motionLabel ? `${cut.caption} · ${motionLabel}` : (cut.caption || '');
      card.appendChild(cap);

      row.appendChild(card);
    });
    return row;
  },
  // The narration-driven shot(s): a start frame → end frame artboard per shot
  // (see /paper/generate_shot). A scene has one shot per dragged technique (see
  // runGenerateShot), so this renders section.shots as a vertical sequence of
  // boards, each labeled with its technique + shot-size/movement + purpose.
  // Falls back to the legacy single start/end pair for older sessions.
  shotFrames(section) {
    const shots = (section.shots && section.shots.length)
      ? section.shots
      : ((section.startFramePreviewUrl && section.endFramePreviewUrl)
        ? [{ technique: null, shotPlan: section.shotPlan || {}, startFramePreviewUrl: section.startFramePreviewUrl, endFramePreviewUrl: section.endFramePreviewUrl }]
        : null);
    if (!shots) return null;
    const bust = section.shotFramesGeneratedAt ? `?t=${section.shotFramesGeneratedAt}` : '';

    const sequence = document.createElement('div');
    sequence.className = 'shot-sequence';

    shots.forEach((shot, idx) => {
      const plan = shot.shotPlan || {};
      const board = document.createElement('div');
      board.className = 'shot-frames';

      const move = SHOT_MOVEMENT_LABELS[plan.movement] || (plan.movement || '').toUpperCase();
      const header = document.createElement('div');
      header.className = 'shot-frames-header';
      const headerBits = [];
      if (shots.length > 1) headerBits.push(`SHOT ${idx + 1}`);
      if (shot.technique) headerBits.push(shot.technique);
      if (move) headerBits.push(move);
      if (plan.shot_size) headerBits.push(plan.shot_size);
      header.textContent = headerBits.join(' · ');
      board.appendChild(header);

      // ONE box that cycles between the start and end frame (a hard-cut loop),
      // rather than two side-by-side frames - both stacked in the same
      // .cutaway-stage (with the animated camera overlay), cross-cut via CSS
      // (.shot-cycle-start / .shot-cycle-end). The camera move is mapped onto a
      // cutaway motion so it animates like the expository cutaways do.
      const motion = SHOT_MOVEMENT_TO_MOTION[plan.movement] || 'approach';
      const stage = document.createElement('div');
      stage.className = `cutaway-stage motion-${motion} shot-frame-stage shot-cycle-stage`;
      const startImg = document.createElement('img');
      startImg.className = 'cutaway-bg shot-cycle-frame shot-cycle-start';
      startImg.src = `${shot.startFramePreviewUrl}${bust}`;
      startImg.alt = 'start frame';
      const endImg = document.createElement('img');
      endImg.className = 'cutaway-bg shot-cycle-frame shot-cycle-end';
      endImg.src = `${shot.endFramePreviewUrl}${bust}`;
      endImg.alt = 'end frame';
      stage.appendChild(startImg);
      stage.appendChild(endImg);
      const cam = document.createElement('div');
      cam.className = 'cutaway-camera';
      stage.appendChild(cam);
      board.appendChild(stage);

      const cap = document.createElement('div');
      cap.className = 'shot-frame-caption';
      cap.textContent = 'START ⇄ END';
      board.appendChild(cap);

      if (plan.purpose) {
        const purpose = document.createElement('div');
        purpose.className = 'shot-frames-purpose';
        purpose.textContent = `Purpose: ${plan.purpose}`;
        board.appendChild(purpose);
      }
      sequence.appendChild(board);
    });
    return sequence;
  },
  // A batch of generated options (see runGenerateShotExamples) - a horizontal
  // rail of cheap still frames + videos, each clickable to COMMIT it as the
  // shot's visual (image -> modern example; video -> animated preview).
  examples(section) {
    // exampleShots: [{url, label, shot_size, movement}] - deliberately
    // contrasting camera treatments of the same scene. Pinned cards are
    // merged first so a later examples/video generation cannot discard them.
    const generatedShots = (section.exampleShots && section.exampleShots.length)
      ? section.exampleShots
      : (section.exampleImages || []).map(url => ({ url, label: '', shot_size: '', movement: '' }));
    const pinnedShots = Array.isArray(section.pinnedExamples) ? section.pinnedExamples : [];
    const shotByUrl = new Map();
    pinnedShots.forEach(shot => {
      if (shot && shot.url) shotByUrl.set(shot.url, { ...shot, pinned: true });
    });
    generatedShots.forEach(shot => {
      if (shot && shot.url && !shotByUrl.has(shot.url)) shotByUrl.set(shot.url, shot);
    });
    const shots = Array.from(shotByUrl.values());
    if (!shots.length) return null;
    const bust = section.examplesGeneratedAt ? `?t=${section.examplesGeneratedAt}` : '';

    const wrap = document.createElement('div');
    wrap.className = 'shot-examples';

    const hint = document.createElement('div');
    hint.className = 'shot-examples-hint';
    hint.textContent = 'Drag an image to your footage or sketch  · double-click to pin for future generation';
    wrap.appendChild(hint);

    const grid = document.createElement('div');
    // Kept under the historical class name for CSS compatibility; visually
    // this is a horizontal scroll rail, not a multi-row grid.
    grid.className = 'shot-examples-grid';
    grid.setAttribute('role', 'list');
    grid.setAttribute('aria-label', 'Generated shot examples');

    const rerender = () => {
      saveDebugSession();
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      // Rendering rebuilds the rail DOM. Restore the selected card's
      // horizontal position without scrolling the whole page vertically.
      const selectedUrl = section.selectedExample && section.selectedExample.url;
      if (!selectedUrl) return;
      requestAnimationFrame(() => {
        const block = resultsEl.querySelector(
          `.paper-section-block[data-section-index="${section.index}"]`);
        const rail = block && block.querySelector('.shot-examples-grid');
        const selected = rail && Array.from(rail.querySelectorAll('.shot-example-option'))
          .find(option => option.dataset.exampleUrl === selectedUrl);
        if (!rail || !selected) return;
        const target = selected.offsetLeft - (rail.clientWidth - selected.offsetWidth) / 2;
        rail.scrollLeft = Math.max(0, target);
      });
    };

    const commitExampleSelection = shot => {
      if (shot.kind === 'video') {
        clearLegacyShotFrames(section);
        section.animatedSketchPreviewUrl = shot.url;
        section.animatedSketchThumbnailUrl = shot.thumbnail_url || null;
        section.selectedExample = {
          url: shot.url, label: shot.label,
          kind: 'video', shot_size: shot.shot_size, movement: shot.movement,
          generated: shot.generated === true,
        };
        section.visualSource = 'examples';
        rerender();
        return;
      }
      // Do not copy this modern example into startFrame/endFrame or
      // section.shots: those are the legacy shotFrames() data model and
      // would make the old START ⇄ END artboard reappear after a click.
      clearLegacyShotFrames(section);
      const pickedPlan = Object.assign({}, section.shotPlan || {},
        shot.shot_size ? { shot_size: shot.shot_size } : {},
        shot.movement ? { movement: shot.movement } : {},
        shot.narrative_operation ? { narrative_operation: shot.narrative_operation } : {},
        shot.purpose ? { purpose: shot.purpose } : {},
        shot.visual_description ? { visual_description: shot.visual_description } : {});
      section.shotPlan = pickedPlan;
      section.animatedSketchPreviewUrl = null;
      section.selectedExample = {
        url: shot.url, label: shot.label,
        kind: 'image', shot_size: shot.shot_size, movement: shot.movement,
      };
      section.visualSource = 'examples';
      rerender();
    };

    const togglePinnedExample = shot => {
      if (!shot || !shot.url) return;
      if (!Array.isArray(section.pinnedExamples)) section.pinnedExamples = [];
      const index = section.pinnedExamples.findIndex(item => item && item.url === shot.url);
      if (index >= 0) {
        section.pinnedExamples.splice(index, 1);
      } else {
        section.pinnedExamples.push({ ...shot, pinned: true, pinnedAt: Date.now() });
      }
      // A double-click both pins and selects the card, so it remains the
      // featured preview while new results are generated around it.
      commitExampleSelection(shot);
    };

    // Which option is currently in use (picking one commits it for the render
    // but KEEPS the gallery visible so the others can still be compared/picked).
    const sel = section.selectedExample || null;

    // A large, immediate still above the option grid—matching the uploaded-
    // footage poster treatment. Before anything is selected, the first result
    // is the representative preview; selecting another promotes that one.
    const featuredShot = (sel && shots.find(shot => shot.url === sel.url)) || shots[0];
    const featured = document.createElement('div');
    featured.className = 'shot-examples-featured';
    const featuredLabel = document.createElement('div');
    featuredLabel.className = 'shot-examples-featured-label';
    featuredLabel.textContent = sel ? 'Selected generated example' : 'Generated example preview';
    featured.appendChild(featuredLabel);
    if (featuredShot.kind === 'video') {
      const featuredVideo = document.createElement('video');
      featuredVideo.className = 'shot-examples-featured-video';
      featuredVideo.src = `${featuredShot.url}${bust}`;
      featuredVideo.poster = `${featuredShot.thumbnail_url || ''}${bust}`;
      featuredVideo.autoplay = true;
      featuredVideo.muted = true;
      featuredVideo.loop = true;
      featuredVideo.playsInline = true;
      featured.appendChild(featuredVideo);
    } else {
      const featuredImg = document.createElement('img');
      featuredImg.src = `${featuredShot.thumbnail_url || featuredShot.url}${bust}`;
      featuredImg.alt = featuredShot.label || 'Generated example preview';
      featured.appendChild(featuredImg);
    }
    wrap.appendChild(featured);

    shots.forEach((shot, i) => {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'shot-example-option';
      opt.setAttribute('role', 'listitem');
      opt.draggable = true;
      opt.dataset.exampleUrl = shot.url;
      if (shot.pinned) opt.classList.add('pinned');
      if (sel && sel.url === shot.url) opt.classList.add('selected');
      opt.title = shot.pinned
        ? 'Pinned example — double-click to unpin; click to select'
        : 'Click to select; double-click to pin';
      opt.addEventListener('dragstart', event => {
        event.stopPropagation();
        event.dataTransfer.effectAllowed = 'copy';
        event.dataTransfer.setData('application/x-generated-shot', JSON.stringify({
          url: shot.url,
          thumbnail_url: shot.thumbnail_url || shot.url,
          kind: shot.kind || 'image',
          label: shot.label || '',
          visual_description: shot.visual_description || '',
          shot_size: shot.shot_size || '',
          movement: shot.movement || '',
        }));
      });
      if (shot.kind === 'video') {
        const video = document.createElement('video');
        video.className = 'shot-example-video';
        video.src = `${shot.url}${bust}`;
        video.poster = `${shot.thumbnail_url || ''}${bust}`;
        video.muted = true;
        video.autoplay = true;
        video.loop = true;
        video.playsInline = true;
        opt.appendChild(video);
      } else {
        const img = document.createElement('img');
        img.src = `${shot.thumbnail_url || shot.url}${bust}`;
        img.alt = shot.label || `example ${i + 1}`;
        img.loading = 'lazy';
        opt.appendChild(img);
      }
      if (shot.label) {
        const lbl = document.createElement('div');
        lbl.className = 'shot-example-label';
        const movementLabel = SHOT_MOVEMENT_LABELS[shot.movement]
          || (shot.movement || '').replaceAll('_', ' ').toUpperCase();
        lbl.textContent = [shot.label, shot.shot_size, movementLabel].filter(Boolean).join(' · ');
        opt.appendChild(lbl);
      }
      let clickTimer = null;
      opt.addEventListener('click', event => {
        event.stopPropagation();
        // Defer a single-click commit briefly so a double-click can pin the
        // card without the first click rebuilding its DOM underneath us.
        if (event.detail > 1) return;
        clickTimer = setTimeout(() => commitExampleSelection(shot), 220);
      });
      opt.addEventListener('dblclick', event => {
        event.stopPropagation();
        if (clickTimer) clearTimeout(clickTimer);
        togglePinnedExample(shot);
      });
      grid.appendChild(opt);
    });

    wrap.appendChild(grid);

    return wrap;
  },
  stockVideo(section) {
    if (!section.selectedVideo) return null;
    const player = document.createElement('video');
    player.className = 'paper-section-visual-media';
    player.src = section.selectedVideo.video_url;
    player.poster = section.selectedVideo.thumbnail_url || '';
    player.controls = true;
    player.preload = 'metadata';
    // Without this, a click anywhere on the player (including its native
    // play button) bubbles up to the card's own click-to-select handler
    // (see handleSectionClick), which re-renders the whole card - tearing
    // down and rebuilding this exact element mid-interaction, so pressing
    // play visibly never seems to do anything. Same fix already applied
    // to this same player inside buildMediaVideoOption.
    player.addEventListener('click', event => event.stopPropagation());
    return player;
  },
  video(section) {
    // A generated video dragged into the footage/sketch slot has a preview
    // URL but no local upload path. It is still valid scene-reference media,
    // so render it exactly like an uploaded clip; only hide the renderer when
    // neither a path nor a preview exists.
    if (!section.uploadedFootagePath && !section.uploadedFootagePreviewUrl) return null;
    if (!section.uploadedFootagePreviewUrl) {
      // Uploaded before preview_url existed (an older saved session) - no
      // URL to play back, just say so.
      const label = document.createElement('div');
      label.className = 'paper-section-visual-placeholder';
      label.textContent = `Footage uploaded ✓ (${section.uploadedFootagePath.split('/').pop()})`;
      return label;
    }
    const player = document.createElement('video');
    player.className = 'paper-section-visual-media';
    player.src = section.uploadedFootagePreviewUrl;
    configureUploadedFootagePreview(player, section);
    player.controls = true;
    // See stockVideo's own comment above - same reasoning.
    player.addEventListener('click', event => event.stopPropagation());
    return player;
  },
  sketch(section) {
    if (!section.sketchPreviewUrl) return null;
    const img = document.createElement('img');
    img.className = 'paper-section-visual-media';
    // Cache-busts the request so re-generating a sketch (see
    // runGenerateSketch) is actually visible - the backend saves every
    // sketch for this section to the same filename, so an unchanged URL
    // would otherwise just show the browser's cached copy of the old one.
    img.src = section.sketchGeneratedAt ? `${section.sketchPreviewUrl}?t=${section.sketchGeneratedAt}` : section.sketchPreviewUrl;
    img.alt = 'Generated storyboard sketch';
    return img;
  },
  image(section) {
    if (!section.image) return null;
    const img = document.createElement('img');
    img.className = 'paper-section-visual-media';
    img.src = section.image;
    img.alt = section.title;
    return img;
  },
  animatedSketch(section) {
    if (!section.animatedSketchPreviewUrl) return null;
    // Cache-busts the request so re-generating the same technique (see
    // runGenerateAnimatedSketch/runGenerateVideoFromText/
    // runGenerateSketchSequence) is actually visible - same reasoning as
    // the sketch renderer's own sketchGeneratedAt above.
    const src = section.animatedSketchGeneratedAt
      ? `${section.animatedSketchPreviewUrl}?t=${section.animatedSketchGeneratedAt}`
      : section.animatedSketchPreviewUrl;
    // The sketch-sequence method (see runGenerateSketchSequence) produces
    // an actual looping .gif, not a video file - a plain <img> already
    // autoplays/loops a GIF natively, so there's no reason to route it
    // through <video> like the other two (Veo-based) methods' .mp4 output.
    if (section.animatedSketchIsGif) {
      const img = document.createElement('img');
      img.className = 'paper-section-visual-media';
      img.src = src;
      img.alt = 'Animated storyboard sketch sequence';
      return img;
    }
    const player = document.createElement('video');
    player.className = 'paper-section-visual-media';
    player.src = src;
    configureGeneratedVideoPreview(player, section);
    player.controls = true;
    // Generated video sound is not part of the documentary mix; narration
    // and sound effects are managed on their own tracks.
    player.muted = true;
    player.volume = 0;
    player.loop = true;
    player.preload = 'metadata';
    // See stockVideo's own comment above - same reasoning.
    player.addEventListener('click', event => event.stopPropagation());
    return player;
  },
};

function buildVisualBox(section, options) {
  options = options || {};
  const box = document.createElement('div');
  box.className = 'paper-section-visual-box';

  let rendered = null;
  let renderedKey = null;
  // User footage remains the visual preview priority when present. An
  // uploaded sketch is a generation/content reference, not a reason to hide
  // footage the presenter has supplied for the scene.
  const preferredSource = section.uploadedFootagePreviewUrl ? 'video' : section.visualSource;
  // A generated examples gallery is the active preview after Preview
  // examples/video. Prefer it over legacy shotFrames fields that are retained
  // only for export compatibility; otherwise an image click can fall through
  // to the old START ⇄ END artboard and its Purpose caption. `exampleImages`
  // is included for older saved sessions that predate `exampleShots`.
  const hasExamples = (Array.isArray(section.exampleShots) && section.exampleShots.length > 0)
    || (Array.isArray(section.exampleImages) && section.exampleImages.length > 0)
    || (Array.isArray(section.pinnedExamples) && section.pinnedExamples.length > 0);
  const examplesModeActive = section.visualSource === 'examples' || hasExamples;
  const candidates = [
    hasExamples ? 'examples' : null,
    preferredSource, 'uploadedSketch', 'cutaways',
    // Once the modern examples/video workflow is active, never render the
    // legacy start/end-frame artboard. It is the source of the misleading
    // Purpose + START ⇄ END captions users see after choosing an example.
    !examplesModeActive ? 'shotFrames' : null,
    'stockVideo',
    'video', 'animatedSketch', 'sketch', 'image',
  ]
    .filter(key => !(options.excludeUploadedFootage
      && (key === 'video' || key === 'uploadedSketch' || key === 'stockVideo')))
    .filter(key => !(options.excludePaperFigure && key === 'image'));
  for (const key of candidates) {
    if (!key) continue;
    rendered = VISUAL_BOX_RENDERERS[key](section);
    if (rendered) { renderedKey = key; break; }
  }

  // Distinguish AI-generated visuals from the presenter's own picked/uploaded
  // footage (see the user-vs-LLM visual language in styles-index.css). A
  // stock/uploaded clip is the presenter's choice; frames/cutaways/sketches
  // are model output.
  const LLM_VISUAL_KEYS = ['cutaways', 'shotFrames', 'examples', 'video', 'animatedSketch', 'sketch', 'image'];
  if (renderedKey && LLM_VISUAL_KEYS.includes(renderedKey)) box.classList.add('llm-generated');
  else if (renderedKey) box.classList.add('user-content');

  if (rendered) {
    box.appendChild(rendered);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'paper-section-visual-placeholder';
    placeholder.textContent = section.visual || '(suggested shots and video)';
    box.appendChild(placeholder);
  }

  return box;
}

// A generated example can be promoted to the scene's content/reference slot
// by dragging it onto "Your footage or sketches". The selected example's
// visual description becomes the editable subject description used by future
// generation requests.
function applyDraggedGeneratedReference(section, shot) {
  if (!section || !shot || !shot.url) return;
  cancelSceneGeneration(section);
  const description = (shot.visual_description || '').trim();
  if (shot.kind === 'video') {
    section.uploadedFootagePath = null;
    section.uploadedFootagePreviewUrl = shot.url;
    section.uploadedFootageThumbnailUrl = shot.thumbnail_url || shot.url;
    section.uploadedSketchPath = null;
    section.uploadedSketchPreviewUrl = null;
    section.visualSource = 'video';
    section.footageOrigin = 'generatedReference';
  } else {
    section.uploadedSketchPath = null;
    section.uploadedSketchPreviewUrl = shot.url;
    section.uploadedSketchUploadedAt = Date.now();
    section.uploadedFootagePath = null;
    section.uploadedFootagePreviewUrl = null;
    section.uploadedFootageThumbnailUrl = null;
    section.visualSource = 'uploadedSketch';
    section.footageOrigin = 'generatedReference';
  }
  if (description) section.footageSubject = description;
  section.generatedReferenceDescription = description || section.generatedReferenceDescription || '';
  saveDebugSession();
  const remaining = currentSections.filter(s => !s.removed);
  renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
}

function audioBufferToWavBlob(audioBuffer) {
  if (!audioBuffer || typeof audioBuffer.getChannelData !== 'function'
    || !(Number(audioBuffer.length) > 0) || !(Number(audioBuffer.sampleRate) > 0)) {
    throw new Error('Decoded narration audio is not a valid AudioBuffer.');
  }
  const channels = Math.min(audioBuffer.numberOfChannels || 1, 2);
  const frames = audioBuffer.length;
  const bytesPerSample = 2;
  const dataSize = frames * channels * bytesPerSample;
  const output = new ArrayBuffer(44 + dataSize);
  const view = new DataView(output);
  const writeString = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, audioBuffer.sampleRate, true);
  view.setUint32(28, audioBuffer.sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);
  const channelData = Array.from({ length: channels }, (_, index) => audioBuffer.getChannelData(index));
  // One typed-array write per sample instead of a DataView call: a minute of
  // narration is a few million samples, and this runs on the main thread
  // while the board is being rebuilt. WAV is little-endian; so is every
  // platform this runs on, which the guard below confirms before relying on it.
  const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  if (littleEndian) {
    const samples = new Int16Array(output, 44, frames * channels);
    let offset = 0;
    for (let frame = 0; frame < frames; frame += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        const sample = Math.max(-1, Math.min(1, channelData[channel][frame] || 0));
        samples[offset] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        offset += 1;
      }
    }
  } else {
    let offset = 44;
    for (let frame = 0; frame < frames; frame += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        const sample = Math.max(-1, Math.min(1, channelData[channel][frame] || 0));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
    }
  }
  return new Blob([output], { type: 'audio/wav' });
}

// The PCM/WAV copy of a narration clip, produced once. Every rail, slide and
// card that shows the clip builds its own <audio>, and each of those used to
// decode and re-encode the whole recording on the main thread - the single
// largest hitch in the board (~150ms per rebuild for a short clip). Object
// URLs stay per element (they are revoked per element); the blob is shared.
function narrationClipWavBlob(clip) {
  if (!clip) return Promise.reject(new Error('Narration fallback is unavailable.'));
  if (clip._nativeWavBlobPromise) return clip._nativeWavBlobPromise;
  const promise = ensureNarrationClipDecoded(clip).then(audioBufferToWavBlob);
  try {
    Object.defineProperty(clip, '_nativeWavBlobPromise', {
      value: promise, configurable: true, enumerable: false, writable: true,
    });
  } catch (err) { /* the conversion still works, just uncached */ }
  promise.catch(() => {
    // A failed decode must not poison later attempts (the source may be
    // reachable next time).
    if (clip._nativeWavBlobPromise === promise) {
      try { delete clip._nativeWavBlobPromise; } catch (err) { clip._nativeWavBlobPromise = null; }
    }
  });
  return promise;
}

// Keep the visible narration player on a native <audio> element. If the
// browser rejects the original MediaRecorder container, decode the same clip
// through Web Audio and retry the visible player with a universal PCM/WAV
// object URL. The controls remain native in both cases.
function attachNativeAudioSource(audio, url, narrationClip) {
  if (!audio || !url) return;
  let fallbackStarted = false;
  let fallbackPromise = null;
  let objectUrl = null;
  audio.preload = 'auto';
  const startFallback = () => {
    if (fallbackPromise) return fallbackPromise;
    if (fallbackStarted || !narrationClip) {
      return Promise.reject(new Error('Narration fallback is unavailable.'));
    }
    fallbackStarted = true;
    fallbackPromise = narrationClipWavBlob(narrationClip)
      .then(blob => {
        const previousObjectUrl = objectUrl;
        const nextObjectUrl = URL.createObjectURL(blob);
        objectUrl = nextObjectUrl;
        audio.src = nextObjectUrl;
        audio.load();
        if (previousObjectUrl) URL.revokeObjectURL(previousObjectUrl);
        return true;
      });
    return fallbackPromise;
  };
  // Expose recovery to the linked-sequence button. Calling play() while the
  // error handler is asynchronously replacing src/load produces the browser's
  // misleading "The operation was aborted" rejection.
  try {
    Object.defineProperty(audio, '_startNarrationFallback', {
      value: startFallback, configurable: true, enumerable: false,
    });
  } catch (err) { audio._startNarrationFallback = startFallback; }
  audio.addEventListener('error', () => {
    startFallback().catch(() => { /* keep the native error state visible */ });
  });
  audio.addEventListener('emptied', () => {
    if (objectUrl && audio.src !== objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  });
  audio.src = url;
  audio.load();

  // A restored act-board recording has no in-memory blob URL. Decode it once
  // up front and use a PCM/WAV object URL when possible, which avoids browser
  // differences in persisted WebM/MP4 MediaRecorder containers. Keep the
  // original source active if the presenter starts the native controls before
  // normalization finishes; swapping an already-playing element would abort
  // that playback.
  let sourceReady = Promise.resolve();
  const restoredSource = narrationClip
    && !narrationClip._nativePreviewUrl
    && !String(url).startsWith('blob:');
  if (restoredSource) {
    sourceReady = narrationClipWavBlob(narrationClip)
      .then(blob => {
        if (!audio.paused) return false;
        const previousObjectUrl = objectUrl;
        objectUrl = URL.createObjectURL(blob);
        audio.src = objectUrl;
        audio.load();
        if (previousObjectUrl) URL.revokeObjectURL(previousObjectUrl);
        return true;
      })
      .catch(() => false);
  }
  try {
    Object.defineProperty(audio, '_narrationSourceReady', {
      value: sourceReady, configurable: true, enumerable: false,
    });
  } catch (err) { audio._narrationSourceReady = sourceReady; }
}

// The timeline transport still mixes narration through Web Audio. Keep that
// decode path independent from the visible native player above.
function narrationPreviewCandidates(clip) {
  const raw = clip && (clip._nativePreviewUrl || clip.previewUrl || clip.audioPreviewUrl);
  if (!raw) return [];
  const candidates = [raw];
  // Disk previews are normally served by the same static server as the page,
  // but a deployed/forwarded page may need to fetch the identical path from
  // the API host instead. Try both before surfacing the native-player error.
  if (raw.startsWith('/') && typeof API_BASE_URL === 'string') {
    candidates.push(`${API_BASE_URL}${raw}`);
  }
  return Array.from(new Set(candidates));
}

function isDecodedNarrationAudioBuffer(value) {
  return !!value && typeof value.getChannelData === 'function'
    && Number(value.length) > 0 && Number(value.sampleRate) > 0;
}

function cacheNarrationAudioBuffer(clip, buffer) {
  // AudioBuffer is runtime-only. Keep it non-enumerable so saveDebugSession
  // never serializes a stale `{}` placeholder that later masquerades as a
  // decoded buffer after refresh.
  try {
    Object.defineProperty(clip, 'audioBuffer', {
      value: buffer, configurable: true, writable: true, enumerable: false,
    });
  } catch (err) {
    clip.audioBuffer = buffer;
  }
}

function ensureNarrationClipDecoded(clip) {
  if (isDecodedNarrationAudioBuffer(clip.audioBuffer)) return Promise.resolve(clip.audioBuffer);
  if (clip.audioBuffer) delete clip.audioBuffer;
  const candidates = narrationPreviewCandidates(clip);
  if (!candidates.length) return Promise.reject(new Error('Narration clip has no preview URL.'));
  const loadAndDecode = (index) => fetch(candidates[index]).then(response => {
    if (!response.ok) throw new Error(`Could not load narration audio (${response.status}).`);
    return response.arrayBuffer();
  }).then(bytes => ensurePlaybackAudioCtx().decodeAudioData(bytes)).catch(error => {
    if (index >= candidates.length - 1) throw error;
    return loadAndDecode(index + 1);
  });
  return loadAndDecode(0)
    .then(buffer => {
      cacheNarrationAudioBuffer(clip, buffer);
      clip.sourceDurationSeconds = buffer.duration;
      if (!(Number(clip.durationSeconds) > 0)) clip.durationSeconds = buffer.duration;
      return buffer;
    });
}

function ensureNarrationClipDecodedWhenIdle(clip) {
  return runActBoardWhenIdle(() => ensureNarrationClipDecoded(clip));
}

function actBoardNarrationWaveformPath(audioBuffer, pointCount = 96) {
  if (!isDecodedNarrationAudioBuffer(audioBuffer)) return '';
  const channelData = audioBuffer.getChannelData(0);
  const points = [];
  for (let index = 0; index <= pointCount; index += 1) {
    const start = Math.floor((index / pointCount) * channelData.length);
    const end = Math.max(start + 1, Math.floor(((index + 1) / (pointCount + 1)) * channelData.length));
    let signedPeak = 0;
    for (let sampleIndex = start; sampleIndex < end && sampleIndex < channelData.length; sampleIndex += 1) {
      const sample = Number(channelData[sampleIndex]) || 0;
      if (Math.abs(sample) > Math.abs(signedPeak)) signedPeak = sample;
    }
    const x = (index / pointCount) * 240;
    const y = 32 - Math.max(-1, Math.min(1, signedPeak)) * 28;
    points.push(`${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return points.join(' ');
}

function migrateNarrationClips(section) {
  if (!Array.isArray(section.narrationClips)) section.narrationClips = [];
  if (section.narrationAudioPreviewUrl && !section.narrationClips.some(c => c.previewUrl === section.narrationAudioPreviewUrl)) {
    section.narrationClips.push({
      id: `legacy-${section.index}`,
      name: 'Narration', previewUrl: section.narrationAudioPreviewUrl,
      sourceDurationSeconds: Number(section.narrationDurationSeconds) || getSceneDuration(section),
      trimStartSeconds: 0,
      durationSeconds: Number(section.narrationDurationSeconds) || getSceneDuration(section),
      timelineOffsetSeconds: 0,
    });
  }
  return section.narrationClips;
}

function buildNarrationClipEditor(section, narrationClip) {
  // Render the native player immediately, even before Web Audio or metadata
  // has decoded a freshly uploaded clip. The metadata listener below replaces
  // this temporary duration with the file's real duration when available.
  let segment = normalizeSelectedAudioSegment(narrationClip);
  if (!segment) {
    const fallbackDuration = Math.max(
      MIN_SFX_SEGMENT_SECONDS,
      Number(section.narrationDurationSeconds) || getSceneDuration(section) || DEFAULT_SCENE_SECONDS);
    narrationClip.sourceDurationSeconds = fallbackDuration;
    narrationClip.durationSeconds = fallbackDuration;
    segment = normalizeSelectedAudioSegment(narrationClip);
  }
  if (!segment) return document.createTextNode('Loading narration…');
  const editor = document.createElement('div');
  editor.className = 'selected-sfx-summary narration-clip-editor';
  const narrationSummary = document.createElement('span');
  const clipDuration = Number(narrationClip.durationSeconds) || segment.durationSeconds;
  narrationSummary.textContent = `Narration · ${clipDuration.toFixed(1)}s selected`;
  editor.appendChild(narrationSummary);
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.addEventListener('click', event => event.stopPropagation());
  const keepPreviewInsideSelection = () => {
    const start = Number(narrationClip.trimStartSeconds) || 0;
    const end = start + (Number(narrationClip.durationSeconds) || segment.durationSeconds);
    if (audio.currentTime < start - 0.05 || audio.currentTime >= end - 0.02) audio.currentTime = start;
  };
  audio.addEventListener('play', keepPreviewInsideSelection);
  audio.addEventListener('timeupdate', () => {
    const start = Number(narrationClip.trimStartSeconds) || 0;
    const end = start + (Number(narrationClip.durationSeconds) || segment.durationSeconds);
    if (audio.currentTime >= end - 0.02) {
      audio.pause();
      audio.currentTime = start;
    }
  });
  audio.addEventListener('loadedmetadata', () => {
    if (!(Number(audio.duration) > 0)) return;
    const previousNatural = Number(narrationClip.sourceDurationSeconds) || 0;
    narrationClip.sourceDurationSeconds = audio.duration;
    if (!(Number(narrationClip.durationSeconds) > 0) ||
      narrationClip.durationSeconds >= previousNatural - 0.01) {
      narrationClip.durationSeconds = audio.duration;
    }
    segment = normalizeSelectedAudioSegment(narrationClip) || segment;
    narrationSummary.textContent = `Narration · ${Number(narrationClip.durationSeconds).toFixed(1)}s selected`;
    redraw();
  });
  editor.appendChild(audio);
  const trimEditor = document.createElement('div');
  trimEditor.className = 'sfx-segment-editor';
  trimEditor.addEventListener('click', event => event.stopPropagation());
  const readout = document.createElement('div');
  readout.className = 'sfx-segment-readout';
  trimEditor.appendChild(readout);
  const strip = document.createElement('div'); strip.className = 'sfx-source-strip';
  // strip.title = 'Drag the selected window or either edge to choose the narration source';
  const selection = document.createElement('div'); selection.className = 'sfx-source-selection';
  const label = document.createElement('span'); label.className = 'sfx-source-selection-label'; selection.appendChild(label);
  const handles = ['start', 'end'].map(edge => {
    const h = document.createElement('span');
    h.className = `sfx-source-handle ${edge}`;
    h.title = edge === 'start' ? 'Drag narration in-point' : 'Drag narration out-point';
    selection.appendChild(h);
    return [h, edge];
  });
  strip.appendChild(selection); trimEditor.appendChild(strip); editor.appendChild(trimEditor);
  function redraw() {
    const start = Number(narrationClip.trimStartSeconds) || 0;
    const duration = Number(narrationClip.durationSeconds) || segment.naturalDurationSeconds;
    selection.style.left = `${start / segment.naturalDurationSeconds * 100}%`;
    selection.style.width = `${duration / segment.naturalDurationSeconds * 100}%`;
    label.textContent = `${duration.toFixed(1)}s`;
    readout.textContent = `Using ${start.toFixed(1)}s–${(start + duration).toFixed(1)}s · ${duration.toFixed(1)}s`;
  }
  const wire = (target, mode) => target.addEventListener('pointerdown', event => {
    event.preventDefault(); event.stopPropagation();
    const width = strip.getBoundingClientRect().width || 1;
    const x = event.clientX;
    const start = Number(narrationClip.trimStartSeconds) || 0;
    const duration = Number(narrationClip.durationSeconds) || segment.naturalDurationSeconds;
    const end = start + duration;
    try { target.setPointerCapture(event.pointerId); } catch (err) { /* optional */ }
    const move = e => {
      const delta = Math.round(((e.clientX - x) / width) * segment.naturalDurationSeconds * 10) / 10;
      if (mode === 'start') {
        narrationClip.trimStartSeconds = Math.max(0, Math.min(start + delta, end - MIN_SFX_SEGMENT_SECONDS));
        narrationClip.durationSeconds = end - narrationClip.trimStartSeconds;
      } else if (mode === 'end') {
        narrationClip.durationSeconds = Math.max(MIN_SFX_SEGMENT_SECONDS, Math.min(duration + delta, segment.naturalDurationSeconds - start));
      } else narrationClip.trimStartSeconds = Math.max(0, Math.min(start + delta, segment.naturalDurationSeconds - duration));
      redraw();
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      try { target.releasePointerCapture(event.pointerId); } catch (err) { /* optional */ }
      normalizeSelectedAudioSegment(narrationClip);
      saveDebugSession();
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
    };
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  });
  handles.forEach(([h, edge]) => wire(h, edge)); wire(selection, 'window'); redraw();
  // Attach only after all playback/metadata listeners are in place.
  attachNativeAudioSource(audio, narrationClip._nativePreviewUrl || narrationClip.previewUrl, narrationClip);
  const remove = document.createElement('button');
  remove.type = 'button'; remove.className = 'btn-secondary remove-narration-btn'; remove.textContent = 'Remove';
  remove.title = 'Remove narration clip';
  remove.addEventListener('click', event => {
    event.stopPropagation();
    section.narrationClips = migrateNarrationClips(section).filter(c => c.id !== narrationClip.id);
    if (section.narrationAudioPreviewUrl === narrationClip.previewUrl) {
      const replacement = section.narrationClips[section.narrationClips.length - 1];
      section.narrationAudioPreviewUrl = replacement ? replacement.previewUrl : null;
      section.narrationDurationSeconds = replacement ? replacement.durationSeconds : null;
    }
    saveDebugSession();
    renderMovieEditor(resultsEl, currentLabel, currentSections.filter(s => !s.removed), currentAssignments);
  });
  editor.appendChild(remove);
  return editor;
}

// Shared tail of both ways to attach real spoken narration audio to a
// section (see runRecordSectionNarration/runAssignDraggedNarration below) -
// saves the disk URL, decodes it for in-browser playback (see
// playAudioBuffer's own comment on why not a plain <audio src>), and
// transcribes it into section.narration, overwriting whatever an LLM
// storyboard call had put there - narration is required to come from an
// actual voice recording now, not generated text. filename must carry the
// clip's real extension (backend/ingest/transcription.py derives the audio
// format purely from it) - each caller below passes its own actual
// filename, not a hardcoded guess, since a dragged clip could be any
// format it was originally recorded/uploaded as.
function finishAssigningNarrationAudio(section, previewUrl, blob, filename, statusEl, filePath) {
  const clip = {
    id: `narration-${section.index}-${Date.now()}`,
    name: filename || 'Narration', previewUrl, filePath: filePath || null,
    trimStartSeconds: 0, timelineOffsetSeconds: 0,
  };
  // Keep a page-local Blob URL for the native player. The server URL remains
  // the persisted/exportable source; this transient URL avoids codec/container
  // quirks during the current recording session and is non-enumerable so it
  // can never overwrite saved session data.
  try {
    Object.defineProperty(clip, '_nativePreviewUrl', {
      value: URL.createObjectURL(blob), configurable: true, enumerable: false,
    });
  } catch (err) { /* object URLs are an optional playback enhancement */ }
  migrateNarrationClips(section).push(clip);
  // Legacy fields continue to point at the newest clip for old saved data and
  // older consumers; the timeline/export use narrationClips.
  section.narrationAudioPreviewUrl = previewUrl;
  delete section.narrationAudioBuffer; // stale until the decode below resolves
  saveDebugSession();

  blob.arrayBuffer()
    .then(arrayBuffer => ensurePlaybackAudioCtx().decodeAudioData(arrayBuffer))
    .then(audioBuffer => {
      cacheNarrationAudioBuffer(clip, audioBuffer);
      clip.sourceDurationSeconds = audioBuffer.duration;
      clip.durationSeconds = audioBuffer.duration;
      section.narrationDurationSeconds = audioBuffer.duration;
    })
    .catch(() => { }); // no in-browser playback for this clip - not fatal, still saved to disk

  statusEl.textContent = 'Transcribing narration ...';
  fetchTranscription(blob, filename)
    .then(result => {
      const transcript = actBoardTranscriptionText(result);
      // A fresh recording is the authoritative narration for this scene;
      // don't prepend an older generated draft to the new transcription.
      if (transcript) section.narration = transcript;
      statusEl.textContent = '';
    })
    .catch(err => {
      statusEl.textContent = `Saved, but transcription failed: ${err.message}`;
      statusEl.classList.add('error');
    })
    .then(() => {
      saveDebugSession();
      if (currentAssignments[section.index]) {
        const remaining = currentSections.filter(s => !s.removed);
        renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      }
    });
}

// Record Narration (and its "Re-record" state once one exists) - uploads
// the freshly recorded clip through the same /premiere/upload_media_bank_item
// bridge "Your Media"'s own recordings use, without adding it to that
// general list - this one's scoped to just this section.
function runRecordSectionNarration(section, file, statusEl) {
  statusEl.textContent = 'Uploading narration ...';
  statusEl.classList.remove('error');
  return fetchUploadMediaBankItem(file, premiereProjectId)
    .then(({ project_id, preview_url, file_path }) => {
      premiereProjectId = project_id;
      finishAssigningNarrationAudio(section, preview_url, file, file.name, statusEl, file_path);
    })
    .catch(err => {
      statusEl.textContent = err.message;
      statusEl.classList.add('error');
    });
}

// Dragging an audio clip in from "Your Media" (see renderMediaBankItems'
// draggable audio items and buildSectionBlock's drop handler below) - the
// clip's already on disk there, so this re-fetches its bytes (needed to
// transcribe it) rather than re-uploading a duplicate copy. The dropped
// blob itself carries no filename of its own (a fetch() response isn't a
// File), so the real extension is read back off previewUrl instead - it's
// whatever the clip was actually saved as, which may not be .webm (an
// uploaded file, or a Safari recording, saves as something else).
function runAssignDraggedNarration(section, mediaItem, statusEl) {
  statusEl.textContent = 'Using dropped audio ...';
  statusEl.classList.remove('error');
  const filename = mediaItem.previewUrl.split('/').pop() || 'narration.webm';
  fetch(mediaItem.previewUrl)
    .then(response => response.blob())
    .then(blob => finishAssigningNarrationAudio(section, mediaItem.previewUrl, blob, filename, statusEl, mediaItem.filePath))
    .catch(err => {
      statusEl.textContent = `Could not use that clip: ${err.message}`;
      statusEl.classList.add('error');
    });
}

// The draggables that drop into a scene's Scene Notes: documentary techniques,
// documentary modes, and Source material excerpts (see wireNotesDrop). Used to
// tell these apart from other drags (media-bank audio, section reordering) so
// only these highlight/drop into the notes.
const NOTES_DRAG_TYPES = ['application/x-technique', 'application/x-documentary-mode', 'application/x-source-material-index'];
function dataTransferHasType(dataTransfer, type) {
  return !!dataTransfer && Array.from(dataTransfer.types || []).includes(type);
}
function isNotesDrag(dataTransfer) {
  return NOTES_DRAG_TYPES.some(type => dataTransferHasType(dataTransfer, type));
}

function buildSectionBlock(section, selectable) {
  const block = document.createElement('div');
  block.className = 'paper-section-block';
  block.classList.toggle('paper-section-block-shot', !!selectable);
  block.classList.toggle('removed', selectable ? !!section.sceneRemoved : !!section.removed);
  block.classList.toggle('selected', selectedSectionIndices.has(section.index));
  block.dataset.sectionIndex = String(section.index);

  // Not draggable - reordering/reassigning between arc-part rows happens via
  // the compact chip strip instead (see buildArcRowChip/handleChipDrop);
  // dragging this much bigger two-column card felt too easy to trigger by
  // accident while editing its text or using its buttons.

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'paper-section-remove-btn';

  const title = document.createElement('div');
  title.className = 'paper-section-title';
  title.textContent = section.title;

  const body = document.createElement('div');
  body.className = 'paper-section-text';
  // Arranged storyboard cards have a separate editable composition-notes
  // field; the flat index.html paper feed must continue showing/editing the
  // extracted paper text itself.
  const bodyValue = selectable ? section.sceneNotes : section.text;
  body.textContent = bodyValue || '(add notes)';

  makeEditable(title, () => section.title, value => {
    section.title = value;
    // The arc row's compact chip strip (see buildArcRowChip) shows this
    // same title on its own separate element, built once at render time -
    // a plain state write here wouldn't reach it without this direct
    // update too (title edits happen often enough not to warrant a full
    // renderMovieEditor re-render just for this).
    const chip = document.querySelector(`.narrative-act-row-chip[data-section-index="${section.index}"]`);
    if (chip) {
      chip.textContent = value;
      chip.title = value;
    }
    saveDebugSession();
  });
  makeEditable(body, () => (selectable ? section.sceneNotes : section.text) || '(add notes)', value => {
    if (selectable) section.sceneNotes = value;
    else section.text = value;
    saveDebugSession();
  }, { multiline: true, allowEmpty: true });

  // Which visual timeline track this scene is (Primary or Cutaway).
  // Auto-inferred (see getSceneRole), overridable here;
  // changing it moves the scene's clip to the matching track on the timeline
  // (see buildNarrativeTimeline), so a full re-render follows. Only shown on
  // the arranged-view shot cards (selectable), not the flat pre-arrangement
  // feed - there's no track/timeline concept before an arrangement exists.
  const roleRow = document.createElement('div');
  roleRow.className = 'paper-section-role';
  const roleLabelEl = document.createElement('span');
  roleLabelEl.className = 'paper-section-role-label';
  roleLabelEl.textContent = 'Track';
  const roleSelect = document.createElement('select');
  roleSelect.className = 'paper-section-role-select';
  SCENE_ROLES.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r.key;
    opt.textContent = r.label;
    roleSelect.appendChild(opt);
  });
  roleSelect.value = getSceneRole(section);
  roleSelect.addEventListener('click', event => event.stopPropagation()); // don't select the card
  roleSelect.addEventListener('change', () => {
    section.role = roleSelect.value;
    saveDebugSession();
    const remaining = currentSections.filter(s => !s.removed);
    renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
  });
  roleRow.appendChild(roleLabelEl);
  roleRow.appendChild(roleSelect);
  const durationLabelEl = document.createElement('span');
  durationLabelEl.className = 'paper-section-role-label paper-section-duration-label';
  durationLabelEl.textContent = 'Seconds';
  const durationInput = document.createElement('input');
  durationInput.type = 'number';
  durationInput.className = 'paper-section-duration-input';
  durationInput.min = '0.5';
  durationInput.step = '0.5';
  durationInput.value = String(getSceneDuration(section));
  durationInput.title = 'Set this scene’s timeline duration in seconds';
  durationInput.setAttribute('aria-label', 'Scene duration in seconds');
  durationInput.addEventListener('click', event => event.stopPropagation());
  durationInput.addEventListener('change', () => {
    const seconds = Math.max(0.5, Number(durationInput.value) || DEFAULT_SCENE_SECONDS);
    section.editPlan = Object.assign(
      { transitionIn: 'hard_cut', kenBurns: { enabled: false, pan: null }, textOverlay: null },
      section.editPlan || {}, { durationSeconds: seconds });
    durationInput.value = String(seconds);
    saveDebugSession();
    const remaining = currentSections.filter(s => !s.removed);
    renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
  });
  roleRow.appendChild(durationLabelEl);
  roleRow.appendChild(durationInput);

  // Drop target for documentary techniques/modes and Source material excerpts.
  // Arranged cards use separate targets: techniques/modes go to Scene Notes,
  // while a Source material excerpt can only be dropped onto the dedicated
  // paper-section-source-material-text field. Flat index.html fields retain
  // the legacy all-purpose behavior.
  const wireNotesDrop = (dropEl, highlightEl, options) => {
    highlightEl = highlightEl || dropEl;
    options = options || {};
    const sourceOnly = !!options.sourceOnly;
    const notesOnly = !!options.notesOnly;
    const accepts = dataTransfer => {
      const hasSource = dataTransferHasType(dataTransfer, 'application/x-source-material-index');
      if (sourceOnly) return hasSource;
      if (notesOnly) return isNotesDrag(dataTransfer) && !hasSource;
      return isNotesDrag(dataTransfer);
    };
    dropEl.addEventListener('dragover', event => {
      if (!accepts(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      highlightEl.classList.add('drag-over');
    });
    dropEl.addEventListener('dragleave', event => {
      // Keep the outline while moving between the drop surface's own children;
      // only clear when the pointer actually leaves it.
      if (event.relatedTarget && dropEl.contains(event.relatedTarget)) return;
      highlightEl.classList.remove('drag-over');
    });
    dropEl.addEventListener('drop', event => {
      if (!accepts(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      highlightEl.classList.remove('drag-over');

      const technique = event.dataTransfer.getData('application/x-technique');
      const modeKey = event.dataTransfer.getData('application/x-documentary-mode');
      const sourceIndexRaw = event.dataTransfer.getData('application/x-source-material-index');

      if (sourceOnly) {
        const source = currentSections.find(s => s.index === parseInt(sourceIndexRaw, 10));
        const addition = source ? (source.text || '') : '';
        if (!addition) return;
        section.text = section.text ? `${section.text}\n\n${addition}` : addition;
        // A source excerpt can also carry the paper's extracted figure. Keep
        // that visual attached to the scene's open slot instead of copying
        // only the text and leaving the figure behind in the source library.
        const gainedFigure = !section.image && source && source.image;
        if (gainedFigure) section.image = source.image;
        const sourceField = document.querySelector(
          `.paper-section-block[data-section-index="${section.index}"] .paper-section-source-material-text`);
        if (sourceField) sourceField.textContent = section.text;
        saveDebugSession();
        if (gainedFigure) {
          const remaining = currentSections.filter(s => !s.removed);
          renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
        }
        return;
      }

      // A dropped technique applies to THIS scene's technique list. It does
      // not start an image/video request; the presenter can explicitly press
      // Generate examples or Generate video after editing the scene.
      if (technique) {
        applyTechniqueToScene(section, technique);
        return;
      }

      let addition = '';
      if (modeKey) {
        const mode = DOCUMENTARY_MODES.find(m => m.key === modeKey);
        addition = mode ? mode.label : modeKey;
      } else if (sourceIndexRaw !== '') {
        const source = currentSections.find(s => s.index === parseInt(sourceIndexRaw, 10));
        if (source) addition = source.text || '';
      }
      if (!addition) return;

      if (selectable) {
        section.sceneNotes = section.sceneNotes ? `${section.sceneNotes}\n\n${addition}` : addition;
        body.textContent = section.sceneNotes;
      } else {
        section.text = section.text ? `${section.text}\n\n${addition}` : addition;
        body.textContent = section.text;
      }
      saveDebugSession();
    });
  };

  if (selectable) {
    // Built here, appended in reading order at the bottom of this branch:
    // title -> narration -> the paper's own text (labeled "Scene Notes"
    // there) -> the visual box/footage actions (see buildVisualBox) - a
    // presenter reads what the shot's about and what to say before acting
    // on how to actually shoot/find it.
    // Uploaded footage previews in the dedicated "Your footage" slot beside
    // this box. Excluding it here preserves the generated/planned reference on
    // the left instead of showing the same uploaded video twice.
    const visualBox = buildVisualBox(section, {
      excludeUploadedFootage: true,
      // Attached paper figures are shown in the open slot at left as the
      // source visual, so do not duplicate them in the generated-preview box.
      excludePaperFigure: !!section.image,
    });

    const footageActions = document.createElement('div');
    footageActions.className = 'paper-section-footage-actions';

    // The single status line for the whole shot card - every operation
    // (find footage, sketch/animate generation, webcam/upload, narration
    // recording/assignment) writes here, and it sits at the very bottom of
    // the block (see the append order below). The find-footage-status class
    // (alongside the shared status-line styling) lets triggerFindFootageSweep
    // locate it by selector inside a re-rendered block.
    const sectionStatus = document.createElement('div');
    sectionStatus.className = 'status-line find-footage-status';

    // The scene's primary visual: a narration-driven shot - a start frame →
    // end frame + camera move designed from whatever's available (narration,
    // scene notes, scene title, the arc part, the paper abstract), inventing
    // a plausible shot if there's nothing at all (see runGenerateShot /
    // /paper/generate_shot). Never disabled - it always has *something* to go
    // on (at minimum the scene title / arc part), and even with nothing the
    // backend generates a shot rather than refusing. Clicking again redesigns.
    // const generateShotBtn = document.createElement('button');
    // generateShotBtn.type = 'button';
    // generateShotBtn.className = 'btn-secondary generate-shot-btn';
    // generateShotBtn.textContent = section.startFramePreviewUrl ? 'Re-preview shot' : 'Preview shot';
    // generateShotBtn.title = "Design this scene's shot (start frame → end frame) from its narration, notes, and title";
    // generateShotBtn.addEventListener('click', event => {
    //   event.stopPropagation();
    //   runGenerateShot(section, generateShotBtn, sectionStatus);
    // });
    // footageActions.appendChild(generateShotBtn);

    // A batch of two cheap image frames to pick from (see
    // runGenerateShotExamples). Cheaper model, more variety.
    const generateExamplesBtn = document.createElement('button');
    generateExamplesBtn.type = 'button';
    generateExamplesBtn.className = 'btn-secondary generate-shot-examples-btn';
    generateExamplesBtn.textContent = 'Generate examples';
    generateExamplesBtn.title = 'Generate two image options to pick from (cheaper model)';
    generateExamplesBtn.addEventListener('click', event => {
      event.stopPropagation();
      runGenerateShotExamples(section, generateExamplesBtn, sectionStatus);
    });
    footageActions.appendChild(generateExamplesBtn);

    // Video counterpart: same inputs, generates a short animated clip instead
    // of the stills (see runGenerateShotVideo). Slower; stills stay the default.
    const generateVideoBtn = document.createElement('button');
    generateVideoBtn.type = 'button';
    generateVideoBtn.className = 'btn-secondary generate-shot-video-btn';
    generateVideoBtn.textContent = 'Generate video';
    generateVideoBtn.title = 'Animate the chosen example image using this scene’s notes, techniques, and narrative operation (~60s)';
    generateVideoBtn.addEventListener('click', event => {
      event.stopPropagation();
      runGenerateShotVideo(section, generateVideoBtn, sectionStatus);
    });
    footageActions.appendChild(generateVideoBtn);

    // Captures video+audio via getUserMedia/MediaRecorder, then uploads the
    // recorded clip through the same /premiere/upload_footage bridge as a
    // manually-picked file (see runUploadFootage) - Premiere doesn't care
    // how the footage originated.
    const recordBtn = document.createElement('button');
    recordBtn.type = 'button';
    recordBtn.className = 'btn-secondary record-webcam-btn';
    recordBtn.textContent = 'Record webcam';
    let activeStream = null;
    let activeRecorder = null;
    recordBtn.addEventListener('click', async event => {
      event.stopPropagation();
      if (activeRecorder && activeRecorder.state === 'recording') {
        activeRecorder.stop();
        return;
      }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      } catch (err) {
        sectionStatus.textContent = `Could not access webcam: ${err.message}`;
        sectionStatus.classList.add('error');
        return;
      }
      activeStream = stream;
      visualBox.innerHTML = '';
      const livePreview = document.createElement('video');
      livePreview.className = 'paper-section-visual-media';
      livePreview.autoplay = true;
      livePreview.muted = true;
      livePreview.srcObject = stream;
      visualBox.appendChild(livePreview);

      const chunks = [];
      activeRecorder = new MediaRecorder(stream);
      // The actual container/codec MediaRecorder settled on - NOT
      // necessarily webm (e.g. Safari's MediaRecorder produces
      // video/mp4). Hardcoding 'video/webm' here regardless would label
      // the file with the wrong extension - served back and played
      // through a plain <video src> (see buildVisualBox), a browser
      // trying to decode the wrong container just fails silently (no
      // playback, no error shown) - same lesson as runTranscribeIntent's
      // own intentMimeType, just for video instead of audio.
      const webcamMimeType = activeRecorder.mimeType || 'video/webm';
      activeRecorder.addEventListener('dataavailable', dataEvent => {
        if (dataEvent.data.size > 0) chunks.push(dataEvent.data);
      });
      activeRecorder.addEventListener('stop', () => {
        activeStream.getTracks().forEach(track => track.stop());
        const extensionMatch = /video\/([a-z0-9]+)/i.exec(webcamMimeType);
        const extension = extensionMatch ? extensionMatch[1] : 'webm';
        const blob = new Blob(chunks, { type: webcamMimeType });
        const file = new File([blob], `webcam-section-${section.index}-${Date.now()}.${extension}`, { type: webcamMimeType });
        recordBtn.textContent = 'Record webcam';
        runUploadFootage(section, file, sectionStatus, recordBtn);
      });
      activeRecorder.start();
      recordBtn.textContent = 'Stop Recording';
      sectionStatus.textContent = 'Recording - click again to stop.';
      sectionStatus.classList.remove('error');
    });
    footageActions.appendChild(recordBtn);

    const mediaResults = document.createElement('div');
    mediaResults.className = 'paper-section-media';
    const sfxBlock = document.createElement('div');
    sfxBlock.className = 'paper-section-sfx-block';
    const sfxLabel = document.createElement('div');
    sfxLabel.className = 'paper-section-text-label';
    sfxLabel.textContent = 'Sound effects';
    sfxBlock.appendChild(sfxLabel);
    const sfxActions = document.createElement('div');
    sfxActions.className = 'paper-section-sfx-actions';
    sfxBlock.appendChild(sfxActions);
    const sfxResults = document.createElement('div');
    sfxResults.className = 'paper-section-media paper-section-sfx-results';

    // Always available. If the scene doesn't yet have LLM-suggested search
    // phrases (video_query/audio_query), runFindFootage derives them from the
    // scene's title/notes/narration on the fly (see ensureFootageQueries).
    const findFootageBtn = document.createElement('button');
    findFootageBtn.type = 'button';
    findFootageBtn.className = 'btn-secondary find-footage-btn';
    findFootageBtn.textContent = 'Find footage';
    const footageSearchGroup = document.createElement('div');
    footageSearchGroup.className = 'media-query-action-group footage-search-group';
    const videoQueryInput = document.createElement('input');
    videoQueryInput.type = 'text';
    videoQueryInput.className = 'media-query-input footage-query-input';
    videoQueryInput.placeholder = 'Video search query';
    videoQueryInput.value = section.videoQuery || '';
    videoQueryInput.title = 'Edit the suggested video search query';
    videoQueryInput.addEventListener('click', event => event.stopPropagation());
    videoQueryInput.addEventListener('keydown', event => event.stopPropagation());
    videoQueryInput.addEventListener('input', () => {
      section.videoQuery = videoQueryInput.value.trim();
      saveDebugSession();
    });
    findFootageBtn.addEventListener('click', event => {
      event.stopPropagation();
      runFindFootage(section, mediaResults, sectionStatus, findFootageBtn, videoQueryInput, audioQueryInput);
    });
    footageSearchGroup.appendChild(videoQueryInput);
    footageSearchGroup.appendChild(findFootageBtn);
    footageActions.appendChild(footageSearchGroup);

    // A presenter-supplied sound takes priority over search results and is
    // stored as the scene's selected SFX immediately after upload. Keep this
    // picker beside (and to the left of) Find Sound so the two choices are
    // equally discoverable.
    const uploadSfxInput = document.createElement('input');
    uploadSfxInput.type = 'file';
    uploadSfxInput.accept = 'audio/*,.mp3,.wav,.m4a,.aac,.ogg,.oga,.flac,.webm';
    uploadSfxInput.className = 'paper-section-sfx-input upload-file-input';
    uploadSfxInput.title = 'Upload your own sound effect';
    uploadSfxInput.addEventListener('click', event => event.stopPropagation());
    uploadSfxInput.addEventListener('change', () => {
      const file = uploadSfxInput.files && uploadSfxInput.files[0];
      if (file) runUploadSoundEffect(section, file, sectionStatus, uploadSfxInput);
    });
    sfxActions.appendChild(uploadSfxInput);

    const sfxSearchGroup = document.createElement('div');
    sfxSearchGroup.className = 'media-query-action-group sfx-search-group';
    const audioQueryInput = document.createElement('input');
    audioQueryInput.type = 'text';
    audioQueryInput.className = 'media-query-input sfx-query-input';
    audioQueryInput.placeholder = 'Sound search query';
    audioQueryInput.value = section.audioQuery || '';
    audioQueryInput.title = 'Edit the suggested sound search query';
    audioQueryInput.addEventListener('click', event => event.stopPropagation());
    audioQueryInput.addEventListener('keydown', event => event.stopPropagation());
    audioQueryInput.addEventListener('input', () => {
      section.audioQuery = audioQueryInput.value.trim();
      saveDebugSession();
    });
    const suggestSfxBtn = document.createElement('button');
    suggestSfxBtn.type = 'button';
    suggestSfxBtn.className = 'btn-secondary suggest-sfx-btn';
    suggestSfxBtn.textContent = 'Find Sound';
    suggestSfxBtn.addEventListener('click', event => {
      event.stopPropagation();
      runSuggestSoundEffects(section, sfxResults, sectionStatus, suggestSfxBtn, audioQueryInput, videoQueryInput);
    });
    sfxSearchGroup.appendChild(audioQueryInput);
    sfxSearchGroup.appendChild(suggestSfxBtn);
    sfxActions.appendChild(sfxSearchGroup);

    if (section.selectedAudio) {
      const segment = normalizeSelectedAudioSegment(section.selectedAudio);
      const selectedSfx = document.createElement('div');
      selectedSfx.className = 'selected-sfx-summary';
      const selectedSfxText = document.createElement('span');
      const selectedDuration = segment ? segment.durationSeconds : 0;
      selectedSfxText.textContent = `SFX: ${section.selectedAudio.name || 'Selected sound'}${selectedDuration > 0 ? ` · ${selectedDuration.toFixed(1)}s selected` : ''}`;
      selectedSfx.appendChild(selectedSfxText);
      const preview = document.createElement('audio');
      preview.controls = true;
      preview.preload = 'metadata';
      preview.src = section.selectedAudio.localPreviewUrl || section.selectedAudio.preview_url;
      preview.addEventListener('click', event => event.stopPropagation());
      if (segment) {
        const keepPreviewInsideSelection = () => {
          const start = section.selectedAudio.trimStartSeconds;
          const end = start + section.selectedAudio.durationSeconds;
          if (preview.currentTime < start - 0.05 || preview.currentTime >= end - 0.02) preview.currentTime = start;
        };
        preview.addEventListener('play', keepPreviewInsideSelection);
        preview.addEventListener('timeupdate', () => {
          const end = section.selectedAudio.trimStartSeconds + section.selectedAudio.durationSeconds;
          if (preview.currentTime >= end - 0.02) {
            preview.pause();
            preview.currentTime = section.selectedAudio.trimStartSeconds;
          }
        });
      }
      selectedSfx.appendChild(preview);

      if (segment) {
        const editor = document.createElement('div');
        editor.className = 'sfx-segment-editor';
        editor.addEventListener('click', event => event.stopPropagation());

        const selectionReadout = document.createElement('div');
        selectionReadout.className = 'sfx-segment-readout';
        const refreshSelectionReadout = () => {
          const start = section.selectedAudio.trimStartSeconds;
          const duration = section.selectedAudio.durationSeconds;
          selectionReadout.textContent = `Using ${start.toFixed(1)}s–${(start + duration).toFixed(1)}s · ${duration.toFixed(1)}s`;
          selectedSfxText.textContent = `SFX: ${section.selectedAudio.name || 'Selected sound'} · ${duration.toFixed(1)}s selected`;
        };
        editor.appendChild(selectionReadout);

        const sourceStrip = document.createElement('div');
        sourceStrip.className = 'sfx-source-strip';
        sourceStrip.title = 'Drag the selected window or either edge to choose the source sound';
        const sourceSelection = document.createElement('div');
        sourceSelection.className = 'sfx-source-selection';
        const selectionLabel = document.createElement('span');
        selectionLabel.className = 'sfx-source-selection-label';
        sourceSelection.appendChild(selectionLabel);
        const sourceInHandle = document.createElement('span');
        sourceInHandle.className = 'sfx-source-handle start';
        sourceInHandle.title = 'Drag source in-point';
        sourceSelection.appendChild(sourceInHandle);
        const sourceOutHandle = document.createElement('span');
        sourceOutHandle.className = 'sfx-source-handle end';
        sourceOutHandle.title = 'Drag source out-point';
        sourceSelection.appendChild(sourceOutHandle);
        sourceStrip.appendChild(sourceSelection);
        editor.appendChild(sourceStrip);

        const redrawSourceSelection = () => {
          const start = section.selectedAudio.trimStartSeconds;
          const duration = section.selectedAudio.durationSeconds;
          sourceSelection.style.left = `${(start / segment.naturalDurationSeconds) * 100}%`;
          sourceSelection.style.width = `${(duration / segment.naturalDurationSeconds) * 100}%`;
          selectionLabel.textContent = `${duration.toFixed(1)}s`;
          refreshSelectionReadout();
        };
        const wireSourceWindowDrag = (target, mode) => {
          target.addEventListener('pointerdown', pointerEvent => {
            pointerEvent.preventDefault();
            pointerEvent.stopPropagation();
            const stripWidth = sourceStrip.getBoundingClientRect().width || 1;
            const startX = pointerEvent.clientX;
            const initialStart = section.selectedAudio.trimStartSeconds;
            const initialDuration = section.selectedAudio.durationSeconds;
            const initialEnd = initialStart + initialDuration;
            try { target.setPointerCapture(pointerEvent.pointerId); } catch (err) { /* optional */ }
            const onMove = moveEvent => {
              const delta = Math.round(
                ((moveEvent.clientX - startX) / stripWidth) * segment.naturalDurationSeconds * 10) / 10;
              if (mode === 'start') {
                const nextStart = Math.max(0, Math.min(
                  initialStart + delta, initialEnd - MIN_SFX_SEGMENT_SECONDS));
                section.selectedAudio.trimStartSeconds = nextStart;
                section.selectedAudio.durationSeconds = initialEnd - nextStart;
              } else if (mode === 'end') {
                section.selectedAudio.durationSeconds = Math.max(MIN_SFX_SEGMENT_SECONDS, Math.min(
                  initialDuration + delta, segment.naturalDurationSeconds - initialStart));
              } else {
                section.selectedAudio.trimStartSeconds = Math.max(0, Math.min(
                  initialStart + delta, segment.naturalDurationSeconds - initialDuration));
              }
              try { preview.currentTime = section.selectedAudio.trimStartSeconds; } catch (err) { /* metadata not ready */ }
              redrawSourceSelection();
            };
            const onUp = () => {
              target.removeEventListener('pointermove', onMove);
              target.removeEventListener('pointerup', onUp);
              try { target.releasePointerCapture(pointerEvent.pointerId); } catch (err) { /* optional */ }
              normalizeSelectedAudioSegment(section.selectedAudio);
              saveDebugSession();
              const remaining = currentSections.filter(s => !s.removed);
              renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
            };
            target.addEventListener('pointermove', onMove);
            target.addEventListener('pointerup', onUp);
          });
        };
        wireSourceWindowDrag(sourceInHandle, 'start');
        wireSourceWindowDrag(sourceOutHandle, 'end');
        wireSourceWindowDrag(sourceSelection, 'window');
        redrawSourceSelection();
        refreshSelectionReadout();
        selectedSfx.appendChild(editor);
      }
      const removeSfxBtn = document.createElement('button');
      removeSfxBtn.type = 'button';
      removeSfxBtn.className = 'btn-secondary remove-sfx-btn';
      removeSfxBtn.textContent = 'Remove';
      removeSfxBtn.addEventListener('click', event => {
        event.stopPropagation();
        delete section.selectedAudio;
        saveDebugSession();
        const remaining = currentSections.filter(s => !s.removed);
        renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      });
      selectedSfx.appendChild(removeSfxBtn);
      sfxResults.appendChild(selectedSfx);
    }
    sfxBlock.appendChild(sfxResults);

    // Hidden picker opened by the large "Your footage" slot below. This input
    // had previously been commented out while the slot's click handler still
    // tried to find it, leaving that control as a silent no-op.
    const uploadFootageInput = document.createElement('input');
    uploadFootageInput.type = 'file';
    uploadFootageInput.accept = '.mp4,video/mp4,video/quicktime,video/webm,image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';
    uploadFootageInput.className = 'paper-section-footage-input';
    uploadFootageInput.title = 'Upload video footage or an image sketch for this scene';
    uploadFootageInput.addEventListener('click', event => event.stopPropagation());
    uploadFootageInput.addEventListener('change', () => {
      const file = uploadFootageInput.files && uploadFootageInput.files[0];
      if (!file) return;
      const looksLikeImage = (file.type && file.type.startsWith('image/'))
        || /\.(png|jpe?g|webp)$/i.test(file.name || '');
      if (looksLikeImage) {
        runUploadSketch(section, file, sectionStatus, uploadFootageInput);
      } else {
        runUploadFootage(section, file, sectionStatus, uploadFootageInput);
      }
    });
    footageActions.appendChild(uploadFootageInput);
    const openFootagePicker = () => {
      if (uploadFootageInput.disabled) return;
      // Reset first so choosing the same MP4 again after a failed upload still
      // emits a change event.
      uploadFootageInput.value = '';
      uploadFootageInput.click();
    };


    // Underneath the visual box: narration + audio.
    const narrationAudio = document.createElement('div');
    narrationAudio.className = 'paper-section-narration-audio';

    const narrationSuggestionLine = document.createElement('div');
    narrationSuggestionLine.className = 'paper-section-narration suggested-narration llm-generated';
    const narrationTranscriptLine = document.createElement('div');
    narrationTranscriptLine.className = 'paper-section-narration recorded-narration-transcript';
    // An accepted arc's draft is authoritative: it is the exact text shown in
    // .arc-suggestion-part-narration. Keep the ordinary per-scene field as a
    // fallback for scenes drafted later from their own Suggest narration
    // button.
    const suggestedNarration = (
      section.arcSuggestedNarration
      || acceptedArcNarrationForSection(section)
      || section.narrationSuggestion
      || ''
    ).trim();
    if (suggestedNarration) {
      const suggestedLabel = document.createElement('strong');
      suggestedLabel.textContent = 'Suggested narration:';
      narrationSuggestionLine.appendChild(suggestedLabel);
      narrationSuggestionLine.appendChild(document.createTextNode(` ${suggestedNarration}`));
    }
    if (section.narration) narrationTranscriptLine.textContent = section.narration;
    const narrationClips = migrateNarrationClips(section);

    // --- The section's actual spoken narration audio - required to come
    // from a human voice, not generated text: either recorded directly
    // here, or dragged in from an already-recorded/uploaded clip in
    // storyboard.html's "Your Media" module (see renderMediaBankItems'
    // draggable audio items, and the drop handlers on narrationAudio
    // itself, just below). Either way it's transcribed into
    // the narration text below and played from the native audio element in
    // each narration clip editor.
    // Distinct from section.selectedAudio further down - that's
    // stock/found ambience from Find Footage, not the presenter's voice.
    //
    const narrationAudioControls = document.createElement('div');
    narrationAudioControls.className = 'paper-section-narration-audio-controls';

    // Draft a voice-over from the attached paper section and the act this
    // scene belongs to. Keep the draft separate from section.narration so a
    // later microphone recording remains the authoritative transcript.
    const suggestNarrationBtn = document.createElement('button');
    suggestNarrationBtn.type = 'button';
    suggestNarrationBtn.className = 'btn-secondary suggest-narration-btn';
    suggestNarrationBtn.textContent = suggestedNarration ? 'Suggest again' : 'Suggest narration';
    suggestNarrationBtn.title = 'Draft a short voice-over from this paper section and its narrative act';
    suggestNarrationBtn.addEventListener('click', event => {
      event.stopPropagation();
      suggestNarrationBtn.disabled = true;
      sectionStatus.textContent = 'Drafting narration from this section and act...';
      sectionStatus.classList.remove('error');
      const act = currentArcSections.find(a => a.key === currentAssignments[section.index]);
      fetchSuggestNarration({
        sectionTitle: section.title,
        sectionText: section.text,
        actTitle: act ? act.label : '',
        actDescription: act ? act.description : '',
        abstract: findAbstractText(),
        documentaryMode: selectedDocumentaryMode,
      })
        .then(({ narration }) => {
          // A manual re-suggestion intentionally replaces the arc draft for
          // this scene; future renders should show the new text, not the old
          // arc-authoritative copy.
          section.arcSuggestedNarration = null;
          section.narrationSuggestion = (narration || '').trim();
          saveDebugSession();
          const remaining = currentSections.filter(s => !s.removed);
          renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
        })
        .catch(err => {
          sectionStatus.textContent = err.message;
          sectionStatus.classList.add('error');
          suggestNarrationBtn.disabled = false;
      });
    });

    const uploadNarrationBtn = document.createElement('button');
    uploadNarrationBtn.type = 'button';
    uploadNarrationBtn.className = 'btn-secondary upload-narration-btn';
    uploadNarrationBtn.textContent = 'Upload narration';
    uploadNarrationBtn.title = 'Upload an audio file to transcribe as this scene’s narration';
    const uploadNarrationInput = document.createElement('input');
    uploadNarrationInput.type = 'file';
    uploadNarrationInput.accept = 'audio/*,.wav,.mp3,.m4a,.mp4,.webm,.ogg,.aac,.flac';
    uploadNarrationInput.className = 'paper-section-narration-upload-input';
    uploadNarrationInput.hidden = true;
    uploadNarrationInput.addEventListener('click', event => event.stopPropagation());
    uploadNarrationBtn.addEventListener('click', event => {
      event.stopPropagation();
      uploadNarrationInput.value = '';
      uploadNarrationInput.click();
    });
    uploadNarrationInput.addEventListener('change', () => {
      const file = uploadNarrationInput.files?.[0];
      if (!file) return;
      const looksLikeAudio = (file.type && file.type.startsWith('audio/'))
        || /\.(wav|mp3|m4a|mp4|webm|ogg|aac|flac)$/i.test(file.name || '');
      if (!looksLikeAudio) {
        sectionStatus.textContent = 'Choose an audio narration file.';
        sectionStatus.classList.add('error');
        return;
      }
      uploadNarrationBtn.disabled = true;
      recordNarrationBtn.disabled = true;
      sectionStatus.textContent = 'Uploading narration ...';
      sectionStatus.classList.remove('error');
      runRecordSectionNarration(section, file, sectionStatus)
        .finally(() => {
        uploadNarrationBtn.disabled = false;
        recordNarrationBtn.disabled = false;
        });
    });
    narrationAudioControls.append(uploadNarrationBtn, uploadNarrationInput);

    const recordNarrationBtn = document.createElement('button');
    recordNarrationBtn.type = 'button';
    recordNarrationBtn.className = 'btn-secondary';
    const recordNarrationRestingLabel = narrationClips.length ? 'Record another narration' : 'Record narration';
    recordNarrationBtn.textContent = recordNarrationRestingLabel;
    let narrationRecordStream = null;
    let narrationRecorder = null;
    recordNarrationBtn.addEventListener('click', async event => {
      event.stopPropagation();
      if (narrationRecorder && narrationRecorder.state === 'recording') {
        narrationRecorder.stop();
        return;
      }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        sectionStatus.textContent = `Could not access microphone: ${err.message}`;
        sectionStatus.classList.add('error');
        return;
      }
      narrationRecordStream = stream;
      const chunks = [];
      narrationRecorder = new MediaRecorder(stream);
      const mimeType = narrationRecorder.mimeType || 'audio/webm';
      narrationRecorder.addEventListener('dataavailable', dataEvent => {
        if (dataEvent.data.size > 0) chunks.push(dataEvent.data);
      });
      narrationRecorder.addEventListener('stop', () => {
        narrationRecordStream.getTracks().forEach(track => track.stop());
        recordNarrationBtn.textContent = recordNarrationRestingLabel;
        const extensionMatch = /audio\/([a-z0-9]+)/i.exec(mimeType);
        const extension = extensionMatch ? extensionMatch[1] : 'webm';
        const blob = new Blob(chunks, { type: mimeType });
        const file = new File([blob], `narration-section-${section.index}-${Date.now()}.${extension}`, { type: mimeType });
        runRecordSectionNarration(section, file, sectionStatus);
      });
      narrationRecorder.start();
      recordNarrationBtn.textContent = 'Stop Recording';
      sectionStatus.textContent = 'Recording - click again to stop.';
      sectionStatus.classList.remove('error');
    });
    narrationAudioControls.appendChild(recordNarrationBtn);

    // Keep the suggested draft independent from recorded transcripts: it
    // stays above the controls while each fresh transcript is shown below
    // those controls and immediately above its clip editor.
    if (suggestedNarration) narrationAudio.appendChild(narrationSuggestionLine);
    narrationAudio.appendChild(suggestNarrationBtn);
    narrationAudio.appendChild(narrationAudioControls);
    if (section.narration) narrationAudio.appendChild(narrationTranscriptLine);
    narrationClips.forEach(clip => {
      narrationAudio.appendChild(buildNarrationClipEditor(section, clip));
    });

    // Drop target for dragging an audio clip in from "Your Media" (see
    // renderMediaBankItems) - a quicker alternative to recording fresh
    // when a clip that already fits exists there. stopPropagation on all
    // three so this doesn't also bubble up into .narrative-act-row's own
    // drop handler (handleChipDrop, for reordering/reassigning sections
    // between arc rows) - that one only ever expects a section-index drag,
    // not a media-bank one, so it'd just no-op, but there's no reason for
    // both handlers (and both drag-over highlights) to fire at once.
    narrationAudio.addEventListener('dragover', event => {
      // Only a media-bank audio clip can drop onto narration - a technique/
      // mode/source drag gets no outline here (it belongs in Scene Notes).
      if (!event.dataTransfer.types.includes('application/x-media-bank-index')) return;
      event.preventDefault();
      event.stopPropagation();
      narrationAudio.classList.add('drag-over');
    });
    narrationAudio.addEventListener('dragleave', event => {
      event.stopPropagation();
      narrationAudio.classList.remove('drag-over');
    });
    narrationAudio.addEventListener('drop', event => {
      event.preventDefault();
      event.stopPropagation();
      narrationAudio.classList.remove('drag-over');
      const indexRaw = event.dataTransfer.getData('application/x-media-bank-index');
      if (indexRaw === '') return;
      const item = mediaBankItems[parseInt(indexRaw, 10)];
      if (!item) return;
      if (item.kind !== 'audio') {
        sectionStatus.textContent = 'Only audio clips can be used as narration.';
        sectionStatus.classList.add('error');
        return;
      }
      runAssignDraggedNarration(section, item, sectionStatus);
    });

    // Stock/found ambience (see Find Footage above) - not the presenter's
    // own voice, so kept separate from the narration controls above.
    // if (section.selectedAudio) {
    //   const player = document.createElement('audio');
    //   player.controls = true;
    //   player.src = section.selectedAudio.preview_url;
    //   player.addEventListener('click', event => event.stopPropagation());
    //   narrationAudio.appendChild(player);
    // } else {
    //   const audioPlaceholder = document.createElement('div');
    //   audioPlaceholder.className = 'paper-section-audio-placeholder';
    //   audioPlaceholder.textContent = '(no ambience selected - use Find Footage above)';
    //   narrationAudio.appendChild(audioPlaceholder);
    // }

    // if (section.editPlan) {
    //   const plan = section.editPlan;
    //   const kenBurns = plan.kenBurns && plan.kenBurns.enabled ? `Ken Burns (${plan.kenBurns.pan})` : 'none';
    //   appendStoryboardLine(narrationAudio, 'Edit', `${plan.transitionIn}, ~${plan.durationSeconds}s, ${kenBurns}`);
    //   if (plan.textOverlay) appendStoryboardLine(narrationAudio, 'Overlay', plan.textOverlay);
    // }

    // Reading order: title, narration, then the visual-production unit. The
    // attached paper text is placed inside that unit below the visual row as
    // Source Material, keeping the visual reference and its grounding text
    // together.
    block.classList.add(`role-${getSceneRole(section)}`);
    block.appendChild(removeBtn);

    // Title on the left, the Track (role) picker pinned to the far right -
    // just left of the absolutely-positioned delete button in the corner
    // (the card's 44px right padding keeps this row clear of it). See
    // .paper-section-title-row.
    const titleRow = document.createElement('div');
    titleRow.className = 'paper-section-title-row';
    titleRow.appendChild(title);
    titleRow.appendChild(roleRow);
    block.appendChild(titleRow);

    // The "Narration" label + the narration/audio, wrapped as one unit that
    // gently wiggles (.needs-narration) until a narration is recorded - a
    // nudge to record the documentary's voiceover for this scene.
    const narrationBlock = document.createElement('div');
    narrationBlock.className = 'paper-section-narration-block';
    if (!narrationClips.length) narrationBlock.classList.add('needs-narration');
    const narrationLabel = document.createElement('div');
    narrationLabel.className = 'paper-section-text-label';
    narrationLabel.textContent = 'Your narration';
    narrationBlock.appendChild(narrationLabel);
    narrationBlock.appendChild(narrationAudio);
    block.appendChild(narrationBlock);

    // Scene direction, picture preview, and footage controls form one visual-
    // production unit. Keeping these three blocks under a shared parent also
    // gives layout changes a stable hook without affecting narration/SFX.
    const visualProductionBlock = document.createElement('div');
    visualProductionBlock.className = 'paper-section-visual-production-block';
    const footageNotesLabel = document.createElement('div');
    footageNotesLabel.className = 'paper-section-text-label';
    footageNotesLabel.textContent = 'Your footage';
    visualProductionBlock.appendChild(footageNotesLabel);

    block.appendChild(visualProductionBlock);

    const notesBlock = document.createElement('div');
    notesBlock.className = 'paper-section-notes-block';
    const sceneNotesLabel = document.createElement('div');
    sceneNotesLabel.className = 'paper-section-text-label';
    sceneNotesLabel.textContent = 'Scene composition & camera techniques';
    notesBlock.appendChild(sceneNotesLabel);
    notesBlock.appendChild(body);
    // The per-scene technique chips (dragged onto this scene) live right under
    // the notes now, each removable - see buildSceneTechniquesRow.
    const techRow = buildSceneTechniquesRow(section);
    if (techRow) notesBlock.appendChild(techRow);
    visualProductionBlock.appendChild(notesBlock);

    // Scene Notes accepts only technique/mode drags. Source excerpts have a
    // separate target below the visual row; the narration block remains a
    // dead zone for these drags (only media-bank audio can land there).
    wireNotesDrop(notesBlock, notesBlock, { notesOnly: true });
    // The whole paper-section block is also a valid technique target. Nested
    // media/source drop zones stop propagation, so the timeline is not needed
    // as a second technique target.
    wireNotesDrop(block, block, { notesOnly: true });
    narrationBlock.addEventListener('dragover', event => {
      if (!isNotesDrag(event.dataTransfer)) return; // let audio drags reach narrationAudio
      event.stopPropagation();                       // don't bubble to the block's notes-drop
      notesBlock.classList.remove('drag-over');       // and don't leave the notes highlighted
    });

    if (section.entities && section.entities.length) {
      const entitiesLine = document.createElement('div');
      entitiesLine.className = 'paper-section-storyboard';
      appendStoryboardLine(entitiesLine, 'Entities', section.entities.map(e => e.name).join(', '));
      block.appendChild(entitiesLine);
    }

    // The generated visual sits beside an "open slot" that invites the
    // presenter to go capture / upload their OWN footage for this scene (real
    // footage always beats a generated stand-in) - clicking it opens the same
    // footage file picker the footage actions use.
    const visualRow = document.createElement('div');
    visualRow.className = 'paper-section-visual-row';

    const openSlot = document.createElement('div');
    openSlot.className = 'paper-section-open-slot';
    // Generated example cards are draggable references. Accept only that
    // payload here, so ordinary scene/timeline drags do not turn the upload
    // slot into a generic drop target.
    openSlot.addEventListener('dragover', event => {
      if (!dataTransferHasType(event.dataTransfer, 'application/x-generated-shot')) return;
      event.preventDefault();
      event.stopPropagation();
      openSlot.classList.add('generated-reference-drag-over');
    });
    openSlot.addEventListener('dragleave', event => {
      if (event.relatedTarget && openSlot.contains(event.relatedTarget)) return;
      openSlot.classList.remove('generated-reference-drag-over');
    });
    openSlot.addEventListener('drop', event => {
      if (!dataTransferHasType(event.dataTransfer, 'application/x-generated-shot')) return;
      event.preventDefault();
      event.stopPropagation();
      openSlot.classList.remove('generated-reference-drag-over');
      try {
        const shot = JSON.parse(event.dataTransfer.getData('application/x-generated-shot'));
        applyDraggedGeneratedReference(section, shot);
      } catch (err) {
        // Ignore malformed external drag payloads.
      }
    });
    if (section.uploadedFootagePreviewUrl || section.uploadedSketchPreviewUrl || section.image) {
      openSlot.classList.add('has-footage');
      const openSlotOverlay = document.createElement('div');
      openSlotOverlay.className = 'open-slot-overlay';
      const ownFootageLabel = document.createElement('div');
      ownFootageLabel.className = 'open-slot-footage-label';
      ownFootageLabel.textContent = section.uploadedFootagePreviewUrl
        ? (section.footageOrigin === 'foundFootage' ? 'Found footage' : 'Your footage')
        : section.uploadedSketchPreviewUrl ? 'Your sketch' : 'Paper figure';
      openSlotOverlay.appendChild(ownFootageLabel);
      if (section.uploadedFootagePreviewUrl) {
        const ownFootageVideo = document.createElement('video');
        ownFootageVideo.className = 'paper-section-open-slot-video';
        ownFootageVideo.src = section.uploadedFootagePreviewUrl;
        configureUploadedFootagePreview(ownFootageVideo, section);
        ownFootageVideo.controls = true;
        ownFootageVideo.addEventListener('click', event => event.stopPropagation());
        openSlot.appendChild(ownFootageVideo);
      } else if (section.uploadedSketchPreviewUrl) {
        const ownSketchImage = document.createElement('img');
        ownSketchImage.className = 'paper-section-open-slot-image';
        ownSketchImage.src = section.uploadedSketchPreviewUrl;
        ownSketchImage.alt = 'Uploaded scene sketch';
        openSlot.appendChild(ownSketchImage);
      } else {
        const figureImage = document.createElement('img');
        figureImage.className = 'paper-section-open-slot-image paper-section-paper-figure';
        figureImage.src = section.image;
        figureImage.alt = `${section.title || 'Attached paper'} figure`;
        openSlot.appendChild(figureImage);
      }
      // Let the presenter explicitly identify the uploaded subject. The
      // server's footage analysis is only a starting guess; this field is the
      // authoritative content anchor sent with future example/video prompts.
      const subjectEditor = document.createElement('div');
      subjectEditor.className = 'open-slot-subject-editor';
      const subjectLabel = document.createElement('label');
      subjectLabel.className = 'open-slot-subject-label';
      subjectLabel.textContent = 'What does this footage/sketch show?';
      subjectEditor.appendChild(subjectLabel);
      const subjectInput = document.createElement('textarea');
      subjectInput.className = 'open-slot-subject-input';
      subjectInput.rows = 2;
      subjectInput.maxLength = 500;
      subjectInput.placeholder = 'e.g. A red boat crossing a foggy harbor';
      subjectInput.value = section.footageSubject || '';
      subjectInput.title = 'Describe the subject/content so generated shots stay anchored to your upload';
      subjectInput.addEventListener('click', event => event.stopPropagation());
      subjectInput.addEventListener('keydown', event => event.stopPropagation());
      subjectInput.addEventListener('input', () => {
        section.footageSubject = subjectInput.value.trim();
        saveDebugSession();
      });
      subjectEditor.appendChild(subjectInput);
      const subjectHint = document.createElement('div');
      subjectHint.className = 'open-slot-subject-hint';
      subjectHint.textContent = 'Used as the content reference for generated examples and video. Click Preview examples after editing.';
      subjectEditor.appendChild(subjectHint);
      openSlotOverlay.appendChild(subjectEditor);
      const replaceFootageBtn = document.createElement('button');
      replaceFootageBtn.type = 'button';
      replaceFootageBtn.className = 'btn-secondary replace-footage-btn';
      replaceFootageBtn.textContent = 'Upload';
      replaceFootageBtn.addEventListener('click', event => {
        event.stopPropagation();
        openFootagePicker();
      });
      openSlotOverlay.appendChild(replaceFootageBtn);
      openSlot.appendChild(openSlotOverlay);
      openSlot.title = 'Preview or replace your footage or sketch for this scene';
    } else {
      const slotIcon = document.createElement('div');
      slotIcon.className = 'open-slot-icon';
      slotIcon.textContent = '🎥';
      const slotText = document.createElement('div');
      slotText.className = 'open-slot-text';
      slotText.textContent = 'Your footage or sketch — go capture and upload your own for this scene';
      openSlot.appendChild(slotIcon);
      openSlot.appendChild(slotText);
      openSlot.title = 'Upload your own footage or sketch for this scene';
      openSlot.setAttribute('role', 'button');
      openSlot.tabIndex = 0;
      openSlot.addEventListener('click', event => {
        event.stopPropagation();
        openFootagePicker();
      });
      openSlot.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        openFootagePicker();
      });
    }
    // The user's reference stays on the left; generated examples/visuals are
    // shown on the right in the adjacent visual box.
    visualRow.appendChild(openSlot);
    visualRow.appendChild(visualBox);
    visualProductionBlock.appendChild(visualRow);

    // Keep the attached paper passage below the visual row, where it acts as
    // source material for the footage/sketch choices rather than competing
    // with the scene-direction controls above.
    const sourceMaterialBlock = document.createElement('div');
    sourceMaterialBlock.className = 'paper-section-source-material-block';
    const sourceMaterialLabel = document.createElement('div');
    sourceMaterialLabel.className = 'paper-section-text-label';
    sourceMaterialLabel.textContent = 'Source Material';
    sourceMaterialBlock.appendChild(sourceMaterialLabel);
    const sourceMaterialBody = document.createElement('div');
    sourceMaterialBody.className = 'paper-section-text paper-section-source-material-text';
    sourceMaterialBody.textContent = section.text || '(no attached paper text)';
    makeEditable(sourceMaterialBody, () => section.text || '(no attached paper text)', value => {
      section.text = value;
      saveDebugSession();
    }, { multiline: true, allowEmpty: true });
    wireNotesDrop(sourceMaterialBody, sourceMaterialBody, { sourceOnly: true });
    sourceMaterialBlock.appendChild(sourceMaterialBody);
    visualProductionBlock.appendChild(sourceMaterialBlock);

    // Keep shot-generation/search actions attached to the visual itself, at
    // its bottom edge, so the controls stay with the examples/video preview.
    visualBox.appendChild(footageActions);
    visualProductionBlock.appendChild(mediaResults);
    block.appendChild(sfxBlock);
    // The status line sits at the very bottom of the block, under all the
    // rest of the content (visual box, footage actions, media results),
    // rather than wedged between the actions and their results.
    block.appendChild(sectionStatus);
  } else {
    // Pre-arrangement flat feed - just the source material, no shot
    // production details yet (there's no act/shot concept before an
    // arrangement exists).
    block.appendChild(removeBtn);
    block.appendChild(title);
    if (section.image) {
      const image = document.createElement('img');
      image.className = 'paper-section-image';
      image.src = section.image;
      image.alt = section.title;
      block.appendChild(image);
    }
    wireNotesDrop(body); // flat feed: the field itself is the drop target
    block.appendChild(body);
  }

  function updateRemoveBtn() {
    const isRemoved = selectable ? !!section.sceneRemoved : !!section.removed;
    removeBtn.textContent = isRemoved ? '↺' : '×';
    removeBtn.title = isRemoved ? 'Restore this section' : 'Exclude this section';
  }
  updateRemoveBtn();

  removeBtn.addEventListener('click', event => {
    event.stopPropagation();
    if (selectable) {
      section.sceneRemoved = !section.sceneRemoved;
      // Arranged view: a deleted scene leaves the timeline and its arc row
      // entirely (renderMovieEditor is only ever fed non-removed sections)
      // and shows up in the "Deleted scenes" sidebar module, restorable
      // there (see renderDeletedScenesList) - rather than lingering in place
      // dimmed, which is the flat feed's behavior below.
      saveDebugSession();
      const remaining = currentSections.filter(s => !s.removed);
      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
    } else {
      section.removed = !section.removed;
      block.classList.toggle('removed', section.removed);
      updateRemoveBtn();
    }
    updateComposeStoryboardVisibility();
  });

  // Clicking the card (anywhere that isn't the remove button or an
  // editable field, all of which already stopPropagation their own clicks)
  // selects it, honoring shift-click for multi-select - see
  // handleSectionClick. Only wired in the arranged view - renderSectionFeed's
  // pre-arrangement flat feed passes selectable=false, since selection only
  // matters for generating a storyboard/edit plan, which needs an act.
  if (selectable) {
    block.addEventListener('click', event => handleSectionClick(section.index, event));
  }

  return block;
}

// A thin, low-opacity-until-hovered "+ Add Section" link sitting in the gap
// between two adjacent section cards (see renderSectionFeed) - clicking it
// inserts a new section right after `afterIndex`, same as the trailing
// "+ Add Section" button below the whole feed, just anywhere in the list
// instead of only at the end.
function buildInsertSectionDivider(afterIndex) {
  const divider = document.createElement('button');
  divider.type = 'button';
  divider.className = 'insert-section-divider';
  divider.textContent = '+ Add Section';
  divider.title = 'Insert a new section here';
  divider.addEventListener('click', () => {
    // A section added from the paper feed is source material, not a storyboard
    // scene, so keep it visible on index.html and out of the narrativeOnly
    // scaffold set.
    insertSection(afterIndex, 'New Section', '', null, false);
    renderSectionFeed(resultsEl, currentLabel, currentSections);
    updateComposeStoryboardVisibility();
    saveDebugSession();
  });
  return divider;
}

function renderSectionFeed(container, label, sections) {
  container.innerHTML = '';

  // The paper's own source material only - never the narrativeOnly scaffold
  // scenes added while arranging/storyboarding on storyboard.html. Those ride
  // along in the shared saved session but are not source material and must not
  // swell this feed.
  const sourceSections = sections.filter(section => !section.narrativeOnly);

  const title = document.createElement('h2');
  title.textContent = 'Source material';
  container.appendChild(title);

  const header = document.createElement('div');
  header.className = 'paper-source-label';
  header.textContent = `${sourceSections.length} section${sourceSections.length === 1 ? '' : 's'} extracted. You can edit section headers and content, click a section to exclude, or add new sections. These
  serve as source material for you to base scenes and narration on in the documentary.`;
  container.appendChild(header);

  const feed = document.createElement('div');
  feed.className = 'paper-sections-feed';
  // A subtle "+ Add Section" divider between each pair of adjacent
  // sections (not just at the very end, below) - inserts right after the
  // section above it, so a new section can land anywhere in the list, not
  // only appended last.
  sourceSections.forEach((section, i) => {
    feed.appendChild(buildSectionBlock(section));
    if (i < sourceSections.length - 1) feed.appendChild(buildInsertSectionDivider(section.index));
  });
  // Keep an insertion control after the final extracted section too. The
  // between-section dividers above intentionally stop before the last card,
  // which previously left a one-section PDF with no way to add source
  // material underneath it.
  feed.appendChild(buildInsertSectionDivider(
    sourceSections.length ? sourceSections[sourceSections.length - 1].index : -1,
  ));
  container.appendChild(feed);
}

// helper functions in helpers.js (isPdfFile, readTextFile,
// fetchPaperExtraction, fetchSuggestArcs) loaded before this.

// --- PDF: real structural parse, not a heuristic - handled server-side by
// Docling (backend/paper_extraction.py's /paper/extract route). See
// fetchPaperExtraction in helpers.js.

// --- Plain text / Markdown: Docling only handles PDFs, so these still use a
// client-side heuristic: headings come from literal "#" Markdown syntax, a
// common academic section name (Abstract, Introduction, ...), or a numbered
// heading pattern ("1. Introduction", "3.2 Analysis").

const KNOWN_SECTION_NAMES = new Set([
  'abstract', 'introduction', 'related work', 'related works', 'background',
  'method', 'methods', 'methodology', 'materials and methods', 'approach',
  'model', 'experiments', 'experimental setup', 'experimental results',
  'results', 'results and discussion', 'evaluation', 'discussion',
  'conclusion', 'conclusions', 'limitations', 'future work',
  'acknowledgments', 'acknowledgements', 'references', 'appendix',
]);

function normalizeHeadingCandidate(text) {
  return text.replace(/^(\d+(\.\d+)*\.?|[ivxlc]+\.)\s*/i, '').trim();
}

function matchesHeadingPattern(text) {
  if (!text || text.length > 100) return false;
  const stripped = normalizeHeadingCandidate(text);
  if (KNOWN_SECTION_NAMES.has(stripped.toLowerCase())) return true;
  return /^\d+(\.\d+)*\.?\s+[A-Z]/.test(text) && text.length < 90;
}

const PREAMBLE_TITLE = 'Title / Preamble';

function buildSections(lines, isHeadingFn) {
  const sections = [];
  let current = { title: PREAMBLE_TITLE, text: '' };
  lines.forEach(line => {
    if (isHeadingFn(line)) {
      const heading = line.text.trim();
      let newTitle;
      if (current.text.trim()) {
        sections.push(current);
        newTitle = heading;
      } else if (current.title !== PREAMBLE_TITLE) {
        // current was itself an empty heading (an "umbrella" with no body
        // text of its own) - carry it forward as a prefix instead of
        // discarding it, same as backend/paper_extraction.py.
        newTitle = `${current.title}: ${heading}`;
      } else {
        newTitle = heading;
      }
      current = { title: newTitle, text: '' };
    } else if (line.text.trim()) {
      current.text += (current.text ? ' ' : '') + line.text.trim();
    }
  });
  if (current.text.trim()) sections.push(current);
  return sections;
}

function extractPlainTextSections(label, text) {
  const rawLines = text.split(/\r?\n/);
  const lines = [];
  rawLines.forEach(raw => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const mdHeading = /^#{1,6}\s+(.*)/.exec(trimmed);
    lines.push(mdHeading ? { text: mdHeading[1].trim(), fontSize: 0, forceHeading: true } : { text: trimmed, fontSize: 0 });
  });
  const sections = buildSections(lines, line => line.forceHeading || matchesHeadingPattern(line.text));
  return { label, sections };
}

function runExtraction() {
  const file = fileInput.files[0];
  if (!file) {
    setStatus('Please choose a PDF file.', true);
    return;
  }

  if (extractBtn) extractBtn.disabled = true;
  setStatus(isPdfFile(file)
    ? 'Extracting sections...'
    : 'Reading and extracting sections...');

  const task = isPdfFile(file) // check if it's a PDF file
    ? fetchPaperExtraction(file).then(result => ({ label: file.name, sections: result.sections }))
    : readTextFile(file).then(({ label, text }) => extractPlainTextSections(label, text)); // if not do the text/markdown process

  task
    .then(({ label, sections }) => {
      // A new paper gets its own durable source snapshot; later edits to this
      // paper continue updating that file rather than overwriting a previous
      // extraction with the same browser session.
      rotatePaperSnapshotId();
      currentLabel = label;
      currentSections = sections.map((section, index) => ({
        index,
        title: section.title,
        text: section.text,
        image: section.image || null,
        removed: false,
      }));

      // restart everything - a new extraction invalidates any arc/
      // storyboard/edit-plan/export work built on the previous paper.
      // storyboard.html's own DOM (edit-plan/premiere-export panels,
      // narrative/preview status lines, ...) isn't reachable from here -
      // it's a separate page (see html/storyboard.html) that starts fresh
      // from this now-cleared state next time it loads, so there's
      // nothing to reset on it directly.
      currentAssignments = {};
      currentArcSections = [];
      selectedSectionIndices = new Set();
      selectedNarrationArc = null;
      storyboardBarStatus = { message: '', isError: false };
      editPlanBarStatus = { message: '', isError: false };
      overallEditNotes = '';
      premiereProjectId = null;

      renderSectionFeed(resultsEl, currentLabel, currentSections);
      updateComposeStoryboardVisibility();
      setStatus(`Done. Extracted ${sections.length} section${sections.length === 1 ? '' : 's'} from "${label}".`);
      if (extractBtn) extractBtn.disabled = false;
      // A deliberate new extraction always resumes saving, even if the
      // session had been cleared earlier without a reload in between.
      debugSessionCleared = false;
      saveDebugSession();
    })
    .catch(err => {
      setStatus(err.message, true);
      if (extractBtn) extractBtn.disabled = false;
    });
}
//#endregion

