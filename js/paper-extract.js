// helper functions in helpers.js (isPdfFile, readTextFile,
// fetchPaperExtraction, fetchNarrativeArc) loaded before this.

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

// --- State: populated once per successful extraction, then mutated in
// place as sections are excluded/restored or arranged into a narrative arc.
// `index` is assigned once here and never reused, even once a section is
// filtered out of a request - it's the stable id both the removal toggle
// and the narrative-arc response key off of.

let currentLabel = '';
let currentSections = [];

// index -> 'beginning'|'middle'|'end', set once /paper/narrative_arc
// succeeds; which clip's visual/narration is showing in the editor preview.
let currentAssignments = {};
let selectedSectionIndex = null;

// Set true the first time a narrative arc is generated, when the
// documentary-intent module relocates into the sidebar - see
// runArrangeNarrative.
let intentModuleRelocated = false;

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

function buildMediaVideoOption(section, video) {
  const option = document.createElement('div');
  option.className = 'media-video-option';
  option.classList.toggle('selected', !!section.selectedVideo && section.selectedVideo.id === video.id);

  const img = document.createElement('img');
  img.src = video.thumbnail_url || '';
  img.alt = 'Video option';
  option.appendChild(img);

  const link = document.createElement('a');
  link.className = 'media-option-link';
  link.href = video.source_url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = '↗';
  link.title = 'Open on Pexels';
  link.addEventListener('click', event => event.stopPropagation());
  option.appendChild(link);

  option.addEventListener('click', event => {
    event.stopPropagation(); // don't let this bubble to the card's own click-to-select handler
    section.selectedVideo = video;
    option.parentElement.querySelectorAll('.media-video-option').forEach(el => el.classList.remove('selected'));
    option.classList.add('selected');
  });

  return option;
}

function buildMediaAudioOption(section, audio) {
  const option = document.createElement('div');
  option.className = 'media-audio-option';
  option.classList.toggle('selected', !!section.selectedAudio && section.selectedAudio.id === audio.id);

  const label = document.createElement('div');
  label.className = 'media-audio-option-label';
  const licenseSuffix = audio.license ? `, ${audio.license}` : '';
  label.textContent = `${audio.name || 'Untitled'} — ${audio.creator || 'unknown'}${licenseSuffix}`;
  option.appendChild(label);

  const player = document.createElement('audio');
  player.controls = true;
  player.src = audio.preview_url;
  player.addEventListener('click', event => event.stopPropagation());
  option.appendChild(player);

  option.addEventListener('click', event => {
    event.stopPropagation(); // don't let this bubble to the card's own click-to-select handler
    section.selectedAudio = audio;
    option.parentElement.querySelectorAll('.media-audio-option').forEach(el => el.classList.remove('selected'));
    option.classList.add('selected');
  });

  return option;
}

function runFindFootage(section, resultsEl, statusEl, btn) {
  btn.disabled = true;
  statusEl.textContent = 'Searching for video and audio options...';
  statusEl.classList.remove('error');

  Promise.allSettled([
    fetchVideoOptions(section.videoQuery),
    fetchAudioOptions(section.audioQuery),
  ]).then(([videoResult, audioResult]) => {
    resultsEl.innerHTML = '';

    if (videoResult.status === 'fulfilled') {
      const videoRow = document.createElement('div');
      videoRow.className = 'media-video-options';
      videoResult.value.videos.forEach(video => videoRow.appendChild(buildMediaVideoOption(section, video)));
      resultsEl.appendChild(videoRow);
    }

    if (audioResult.status === 'fulfilled') {
      const audioRow = document.createElement('div');
      audioRow.className = 'media-audio-options';
      audioResult.value.audio.forEach(audio => audioRow.appendChild(buildMediaAudioOption(section, audio)));
      resultsEl.appendChild(audioRow);
    }

    const errors = [videoResult, audioResult]
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

// Click-to-edit in place: turns `el` into a contenteditable field on click
// (without letting that click also bubble up to the section block's own
// click-to-exclude handler), saves back through `setValue` on blur/Enter,
// and reverts on Escape. Leaves `el` untouched if nothing actually changed,
// so a click-then-blur with no edit can't clobber real content with
// whatever placeholder text happened to be showing (e.g. "(no text
// captured for this section)" for an empty section).
function makeEditable(el, getValue, setValue, { multiline } = {}) {
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
      el.textContent = oldValue; // don't allow clearing a field to empty
      return;
    }
    if (newValue !== oldValue) {
      setValue(newValue);
    }
  });
}

function buildSectionBlock(section, selectable) {
  const block = document.createElement('div');
  block.className = 'paper-section-block';
  block.classList.toggle('removed', section.removed);
  block.classList.toggle('selected', section.index === selectedSectionIndex);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'paper-section-remove-btn';
  block.appendChild(removeBtn);

  const title = document.createElement('div');
  title.className = 'paper-section-title';
  title.textContent = section.title;
  block.appendChild(title);

  if (section.image) {
    const image = document.createElement('img');
    image.className = 'paper-section-image';
    image.src = section.image;
    image.alt = section.title;
    block.appendChild(image);
  }

  const meta = document.createElement('div');
  meta.className = 'paper-section-meta';
  block.appendChild(meta);

  const body = document.createElement('div');
  body.className = 'paper-section-text';
  body.textContent = section.text || '(no text captured for this section)';
  block.appendChild(body);

  makeEditable(title, () => section.title, value => { section.title = value; });
  makeEditable(body, () => section.text || '(no text captured for this section)', value => {
    section.text = value;
    updateMeta();
  }, { multiline: true });

  if (section.visual || section.narration || (section.entities && section.entities.length)) {
    const storyboard = document.createElement('div');
    storyboard.className = 'paper-section-storyboard';
    if (section.visual) appendStoryboardLine(storyboard, 'Visual', section.visual);
    if (section.narration) appendStoryboardLine(storyboard, 'Narration', section.narration);
    if (section.entities && section.entities.length) {
      appendStoryboardLine(storyboard, 'Entities', section.entities.map(e => e.name).join(', '));
    }

    if (section.videoQuery) {
      const findFootageBtn = document.createElement('button');
      findFootageBtn.type = 'button';
      findFootageBtn.className = 'btn-secondary find-footage-btn';
      findFootageBtn.textContent = 'Find Footage';

      const mediaStatus = document.createElement('div');
      mediaStatus.className = 'status-line';

      const mediaResults = document.createElement('div');
      mediaResults.className = 'paper-section-media';

      findFootageBtn.addEventListener('click', event => {
        event.stopPropagation();
        runFindFootage(section, mediaResults, mediaStatus, findFootageBtn);
      });

      storyboard.appendChild(findFootageBtn);
      storyboard.appendChild(mediaStatus);
      storyboard.appendChild(mediaResults);
    }

    block.appendChild(storyboard);
  }

  function updateMeta() {
    const charCount = section.text.length.toLocaleString();
    meta.textContent = `${charCount} characters`;
  }
  updateMeta();

  function updateRemoveBtn() {
    removeBtn.textContent = section.removed ? '↺' : '×';
    removeBtn.title = section.removed ? 'Restore this section' : 'Exclude this section';
  }
  updateRemoveBtn();

  removeBtn.addEventListener('click', event => {
    event.stopPropagation();
    section.removed = !section.removed;
    block.classList.toggle('removed', section.removed);
    updateRemoveBtn();
  });

  // Clicking the card (anywhere that isn't the remove button or an
  // editable field, both of which already stopPropagation their own
  // clicks) surfaces the matching clip in the timeline - see selectSection
  // and renderMovieEditor's scrollIntoView calls. Only wired once there's a
  // timeline to surface anything in - renderSectionFeed's pre-arrangement
  // flat feed passes selectable=false, since selectSection always renders
  // the movie editor.
  if (selectable) {
    block.addEventListener('click', () => selectSection(section.index));
  }

  return block;
}

function renderSectionFeed(container, label, sections) {
  container.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'paper-source-label';
  header.textContent = `${sections.length} section${sections.length === 1 ? '' : 's'} extracted from "${label}". You can edit section headers and text, or click a section to exclude it from the documentary.`;
  container.appendChild(header);

  const feed = document.createElement('div');
  feed.className = 'paper-sections-feed';
  sections.forEach(section => feed.appendChild(buildSectionBlock(section)));
  container.appendChild(feed);
}

// --- Narrative arc: three-act documentary structure (see
// backend/narrative_arc_llm.py for the prompt), presented as a movie-editor
// style view once arranged - a preview pane, a segmented clip timeline
// (video + audio tracks), and the full section content underneath, grouped
// by act in the order Docling/the heuristic originally extracted them.

const NARRATIVE_ACTS = [
  { key: 'beginning', label: 'Beginning', hint: 'Frame of reference' },
  { key: 'middle', label: 'Middle', hint: 'Change or issue to resolve' },
  { key: 'end', label: 'End', hint: 'Resolution / implications' },
];

function selectSection(index) {
  selectedSectionIndex = index;
  const remaining = currentSections.filter(section => !section.removed);
  renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
}

function buildEmptyClip(trackType) {
  const clip = document.createElement('div');
  clip.className = `editor-clip editor-clip-${trackType} editor-clip-empty`;
  return clip;
}

function buildTimelineClip(section, trackType) {
  const clip = document.createElement('div');
  clip.className = `editor-clip editor-clip-${trackType}`;
  clip.classList.toggle('selected', section.index === selectedSectionIndex);
  clip.classList.toggle('removed', section.removed);
  clip.dataset.sectionIndex = String(section.index);
  // Rough stand-in for "clip length" - proportional to how much the section
  // actually has to say, not a real duration.
  clip.style.flexGrow = String(Math.max(1, Math.round(section.text.length / 200)));

  const label = document.createElement('span');
  label.className = 'editor-clip-label';
  label.textContent = trackType === 'video' ? section.title : (section.narration ? '♪' : '');
  clip.appendChild(label);

  clip.addEventListener('click', () => selectSection(section.index));

  // Only the video clip is draggable - the audio clip is just that same
  // section's second visual representation, and reorders for free once
  // currentSections' order changes and the view re-renders (see
  // handleSegmentDrop below).
  if (trackType === 'video') {
    clip.draggable = true;
    clip.addEventListener('dragstart', event => {
      event.dataTransfer.setData('text/plain', String(section.index));
      event.dataTransfer.effectAllowed = 'move';
      clip.classList.add('dragging');
    });
    clip.addEventListener('dragend', () => {
      clip.classList.remove('dragging');
    });
  }

  return clip;
}

// Dropping a clip onto an act's segment reorders currentSections (the
// single array every render already derives display order from) and, if
// the drop landed on a different act than the section's current one,
// reassigns it - a full manual override of the LLM's arrangement. Drop
// position is "immediately before whichever clip your cursor lands on" (or
// appended to the end of that act if dropped on empty track space) - not
// pixel-precise before/after based on cursor position, but enough for a
// rough rearrange.
function handleSegmentDrop(event, actKey) {
  event.preventDefault();
  const draggedIndex = parseInt(event.dataTransfer.getData('text/plain'), 10);
  if (Number.isNaN(draggedIndex)) return;

  const draggedPos = currentSections.findIndex(s => s.index === draggedIndex);
  if (draggedPos === -1) return;
  const [draggedSection] = currentSections.splice(draggedPos, 1);

  const targetClipEl = event.target.closest('.editor-clip:not(.editor-clip-empty)');
  const targetIndex = targetClipEl ? parseInt(targetClipEl.dataset.sectionIndex, 10) : null;
  if (targetIndex !== null && targetIndex !== draggedIndex) {
    const targetPos = currentSections.findIndex(s => s.index === targetIndex);
    currentSections.splice(targetPos === -1 ? currentSections.length : targetPos, 0, draggedSection);
  } else {
    currentSections.push(draggedSection);
  }

  if (currentAssignments[draggedIndex] !== actKey) {
    // Moved to a different act - its storyboard shot (if any) was written
    // for the old act's tone, same reasoning runArrangeNarrative already
    // applies when re-arranging.
    delete draggedSection.visual;
    delete draggedSection.narration;
    currentAssignments[draggedIndex] = actKey;
  }

  const remaining = currentSections.filter(section => !section.removed);
  renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
}

function updateEditorPreview(container, section) {
  container.innerHTML = '';

  const frame = document.createElement('div');
  frame.className = 'editor-preview-frame';

  if (!section) {
    const empty = document.createElement('div');
    empty.className = 'editor-preview-empty';
    empty.textContent = 'No sections to preview.';
    frame.appendChild(empty);
    container.appendChild(frame);
    return;
  }

  const visual = document.createElement('div');
  visual.className = 'editor-preview-visual';
  visual.textContent = section.visual || `(No visual yet for "${section.title}" - generate a storyboard.)`;
  frame.appendChild(visual);

  if (section.narration) {
    const caption = document.createElement('div');
    caption.className = 'editor-preview-caption';
    caption.textContent = section.narration;
    frame.appendChild(caption);
  }

  container.appendChild(frame);

  const meta = document.createElement('div');
  meta.className = 'editor-preview-meta';
  const act = NARRATIVE_ACTS.find(a => a.key === currentAssignments[section.index]);
  meta.textContent = act ? `${section.title} — ${act.label}` : section.title;
  container.appendChild(meta);
}

function renderMovieEditor(container, label, sections, assignmentsByIndex) {
  container.innerHTML = '';

  // const header = document.createElement('div');
  // header.className = 'paper-source-label';
  // header.textContent = `Narrative arc for "${label}"`;
  // container.appendChild(header);

  if (selectedSectionIndex === null || !sections.some(s => s.index === selectedSectionIndex)) {
    selectedSectionIndex = sections.length ? sections[0].index : null;
  }
  const selectedSection = sections.find(s => s.index === selectedSectionIndex) || null;

  const pinnedTop = document.createElement('div');
  pinnedTop.className = 'editor-pinned-top';

  const preview = document.createElement('div');
  preview.className = 'editor-preview';
  updateEditorPreview(preview, selectedSection);
  pinnedTop.appendChild(preview);

  const timeline = document.createElement('div');
  timeline.className = 'editor-timeline';

  const sectionsBelow = document.createElement('div');
  sectionsBelow.className = 'narrative-sections-below';

  NARRATIVE_ACTS.forEach(act => {
    const columnSections = sections.filter(s => assignmentsByIndex[s.index] === act.key);

    // Timeline segment: label + video track + audio track. Drop handling
    // lives on the whole segment (not per-track) so dropping on either row
    // works the same way - see handleSegmentDrop.
    const segment = document.createElement('div');
    segment.className = 'editor-segment';
    segment.addEventListener('dragover', event => {
      event.preventDefault();
      segment.classList.add('drag-over');
    });
    segment.addEventListener('dragleave', () => {
      segment.classList.remove('drag-over');
    });
    segment.addEventListener('drop', event => {
      segment.classList.remove('drag-over');
      handleSegmentDrop(event, act.key);
    });

    const segLabel = document.createElement('div');
    segLabel.className = 'editor-segment-label';
    segLabel.textContent = act.label;
    segment.appendChild(segLabel);

    const videoTrack = document.createElement('div');
    videoTrack.className = 'editor-track editor-track-video';
    const audioTrack = document.createElement('div');
    audioTrack.className = 'editor-track editor-track-audio';

    if (columnSections.length === 0) {
      videoTrack.appendChild(buildEmptyClip('video'));
      audioTrack.appendChild(buildEmptyClip('audio'));
    } else {
      columnSections.forEach(section => {
        videoTrack.appendChild(buildTimelineClip(section, 'video'));
        audioTrack.appendChild(buildTimelineClip(section, 'audio'));
      });
    }

    segment.appendChild(videoTrack);
    segment.appendChild(audioTrack);
    timeline.appendChild(segment);

    // Sections underneath: the same full-content cards the timeline used to
    // be, one column per act, now supporting detail below the clips.
    const column = document.createElement('div');
    column.className = 'narrative-act-column';

    const heading = document.createElement('div');
    heading.className = 'narrative-act-heading';
    const actTitle = document.createElement('div');
    actTitle.className = 'narrative-act-title';
    actTitle.textContent = act.label;
    const actHint = document.createElement('div');
    actHint.className = 'narrative-act-hint';
    actHint.textContent = act.hint;
    heading.appendChild(actTitle);
    heading.appendChild(actHint);
    column.appendChild(heading);

    if (columnSections.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'narrative-act-empty';
      empty.textContent = 'No sections placed here.';
      column.appendChild(empty);
    } else {
      columnSections.forEach(section => column.appendChild(buildSectionBlock(section, true)));
    }

    sectionsBelow.appendChild(column);
  });

  pinnedTop.appendChild(timeline);
  container.appendChild(pinnedTop);
  container.appendChild(sectionsBelow);

  // Bidirectional surfacing: whichever triggered this render (clicking a
  // clip or clicking a card - both funnel through selectSection), bring
  // the *other* one into view too.
  const selectedClip = container.querySelector('.editor-clip.selected');
  if (selectedClip) selectedClip.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  const selectedCard = container.querySelector('.narrative-sections-below .paper-section-block.selected');
  if (selectedCard) selectedCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// --- Wiring ---

const fileInput = document.getElementById('paper-file-input');
const extractBtn = document.getElementById('extract-paper-btn');
const statusEl = document.getElementById('paper-status');
const resultsEl = document.getElementById('paper-sections');
const documentaryIntentModuleEl = document.getElementById('documentary-intent-module');
const paperActionsEl = document.getElementById('paper-actions');
const arrangeBtn = document.getElementById('arrange-narrative-btn');
const narrativeStatusEl = document.getElementById('narrative-status');
const storyboardActionEl = document.getElementById('storyboard-action');
const storyboardBtn = document.getElementById('generate-storyboard-btn');
const storyboardStatusEl = document.getElementById('storyboard-status');

function setStatus(message, isError) {
  statusEl.textContent = message || '';
  statusEl.classList.toggle('error', !!isError);
}

function setNarrativeStatus(message, isError) {
  narrativeStatusEl.textContent = message || '';
  narrativeStatusEl.classList.toggle('error', !!isError);
}

function setStoryboardStatus(message, isError) {
  storyboardStatusEl.textContent = message || '';
  storyboardStatusEl.classList.toggle('error', !!isError);
}

function runExtraction() {
  const file = fileInput.files[0];
  if (!file) {
    setStatus('Please choose a PDF file.', true);
    return;
  }

  extractBtn.disabled = true;
  setStatus(isPdfFile(file)
    ? 'Extracting sections...'
    : 'Reading and extracting sections...');

  const task = isPdfFile(file) // check if it's a PDF file
    ? fetchPaperExtraction(file).then(result => ({ label: file.name, sections: result.sections }))
    : readTextFile(file).then(({ label, text }) => extractPlainTextSections(label, text)); // if not do the text/markdown process

  task
    .then(({ label, sections }) => {
      currentLabel = label;
      currentSections = sections.map((section, index) => ({
        index,
        title: section.title,
        text: section.text,
        image: section.image || null,
        removed: false,
      }));

      currentAssignments = {};
      selectedSectionIndex = null;
      storyboardActionEl.style.display = 'none';
      setStoryboardStatus('');

      renderSectionFeed(resultsEl, currentLabel, currentSections);
      documentaryIntentModuleEl.style.display = '';
      paperActionsEl.style.display = '';
      setNarrativeStatus('');
      setStatus(`Done. Extracted ${sections.length} section${sections.length === 1 ? '' : 's'} from "${label}".`);
      extractBtn.disabled = false;
    })
    .catch(err => {
      setStatus(err.message, true);
      extractBtn.disabled = false;
    });
}

function runArrangeNarrative() {
  const remaining = currentSections.filter(section => !section.removed);
  if (remaining.length === 0) {
    setNarrativeStatus('No sections remain to arrange - restore at least one first.', true);
    return;
  }

  arrangeBtn.disabled = true;
  setNarrativeStatus('Arranging sections into a narrative arc ...');

  const documentaryGoal = documentaryIntentInput.value.trim();

  fetchNarrativeArc(remaining.map(({ index, title, text }) => ({ index, title, text })), documentaryGoal)
    .then(({ assignments }) => {
      currentAssignments = {};
      assignments.forEach(({ index, act }) => { currentAssignments[index] = act; });

      // A previous storyboard's tone was written for each section's old
      // act - stale now that the arrangement changed, so clear it and let
      // the user regenerate.
      currentSections.forEach(section => {
        delete section.visual;
        delete section.narration;
      });
      selectedSectionIndex = null;

      renderMovieEditor(resultsEl, currentLabel, remaining, currentAssignments);
      setNarrativeStatus(`Done. Arranged ${remaining.length} section${remaining.length === 1 ? '' : 's'} into the narrative arc.`);
      arrangeBtn.disabled = false;
      storyboardActionEl.style.display = '';
      setStoryboardStatus('');

      if (!intentModuleRelocated) {
        // A sibling of #upload-sidebar within .sidebar-stack, not nested
        // inside its .upload-sidebar-body - stays its own separate card
        // (white background and all) rather than merging into that panel.
        document.querySelector('.sidebar-stack').appendChild(documentaryIntentModuleEl);
        documentaryIntentModuleEl.classList.add('module-card--in-sidebar');
        intentModuleRelocated = true;
      }
    })
    .catch(err => {
      setNarrativeStatus(err.message, true);
      arrangeBtn.disabled = false;
    });
}

function runGenerateStoryboard() {
  const arranged = currentSections.filter(section => !section.removed && currentAssignments[section.index]);
  if (arranged.length === 0) {
    setStoryboardStatus('No arranged sections to build a storyboard from - arrange into a narrative arc first.', true);
    return;
  }

  storyboardBtn.disabled = true;
  setStoryboardStatus('Generating a loose storyboard ...');

  const documentaryGoal = documentaryIntentInput.value.trim();

  fetchStoryboard(arranged.map(({ index, title, text }) => ({
    index, title, text, act: currentAssignments[index],
  })), documentaryGoal)
    .then(({ storyboard }) => {
      storyboard.forEach(({ index, visual, narration, entities, video_query, audio_query }) => {
        const section = currentSections.find(s => s.index === index);
        if (section) {
          section.visual = visual;
          section.narration = narration;
          section.entities = entities || [];
          section.videoQuery = video_query;
          section.audioQuery = audio_query;
        }
      });

      renderMovieEditor(resultsEl, currentLabel, arranged, currentAssignments);
      setStoryboardStatus(`Done. Generated a storyboard for ${arranged.length} section${arranged.length === 1 ? '' : 's'}.`);
      storyboardBtn.disabled = false;
    })
    .catch(err => {
      setStoryboardStatus(err.message, true);
      storyboardBtn.disabled = false;
    });
}

extractBtn.addEventListener('click', runExtraction);
arrangeBtn.addEventListener('click', runArrangeNarrative);
storyboardBtn.addEventListener('click', runGenerateStoryboard);

// --- Documentary intent: hardcoded suggestions (not LLM-generated - the
// point is capturing the user's own stated intent, not guessing it before
// they've said anything). Clicking one fills the textarea; read fresh at
// call time in runArrangeNarrative/runGenerateStoryboard rather than kept
// as separate state, so there's nothing to keep in sync.

const DOCUMENTARY_INTENT_SUGGESTIONS = [
  'I want to demonstrate how we carried out our methods.',
  'I want to highlight our most surprising or counterintuitive finding.',
  'I want to emphasize why this problem matters and who it affects.',
  'I want to walk the audience through our reasoning, from question to answer.',
];

const documentaryIntentInput = document.getElementById('documentary-intent-input');
const intentSuggestedChipsEl = document.getElementById('intent-suggested-chips');

DOCUMENTARY_INTENT_SUGGESTIONS.forEach(suggestion => {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip suggested';
  chip.textContent = suggestion;
  chip.addEventListener('click', () => {
    documentaryIntentInput.value = suggestion;
  });
  intentSuggestedChipsEl.appendChild(chip);
});

// Collapsible left-side upload panel - purely a display toggle, no state
// beyond the CSS class (same pattern as presenter-view.js's upload sidebar).
const uploadSidebar = document.getElementById('upload-sidebar');
const uploadSidebarToggle = document.getElementById('upload-sidebar-toggle');

uploadSidebarToggle.addEventListener('click', () => {
  const collapsed = uploadSidebar.classList.toggle('collapsed');
  uploadSidebarToggle.textContent = collapsed ? '«' : '»';
  uploadSidebarToggle.title = collapsed ? 'Expand' : 'Collapse';
});
