function actBoardSourceSection(actKey) {
  return actBoardSectionsForAct(actKey)[0] || null;
}

function actBoardGenerationContext(actKey, act, node) {
  const source = actBoardSourceSection(actKey);
  const narrationNode = actBoardNodesForAct(actKey).find(item =>
    item.type === 'narration' && item.id === node.narrationNodeId);
  const linkedFootagePhrases = narrationNode
    ? (narrationNode.footageNodeIds || [])
      .map(id => actBoardNodesForAct(actKey).find(item => item.id === id))
      .filter(Boolean)
      .map(item => item.fragment || '')
      .filter(Boolean)
    : [];
  return {
    documentaryMode: actBoardDocumentaryModeForNode(actKey, node),
    sectionIndex: source && Number.isInteger(source.index) ? source.index : 0,
    title: `${act.label || 'Act'} · ${actBoardImageGenerationPhrase(node) || 'footage'}`,
    // Send the Act Board's visual context as separate API fields. Keep only
    // scene-level notes here so the backend does not receive bundled copies.
    sceneNotes: `${act.description || ''}${node.combinedConceptPrompt ? `\nCombine visual concepts: ${node.combinedConceptPrompt}` : ''}`.trim(),
    specificPhrase: actBoardImageGenerationPhrase(node),
    parentNarration: narrationNode?.transcript || narrationNode?.text || '',
    linkedFootagePhrases,
    techniques: actBoardSuggestedTechniques(actKey, node),
    actTitle: act.label || '',
    source,
  };
}

// Act Board uses the same distilled technique palette as Timeline + Scenes,
// but keeps it local to the node-generation request. This deliberately does
// not mutate timeline scene.techniques or add any of the excluded visual
// reference inputs to the Act Board image prompt.

function actBoardMoodboardTechniquePool() {
  const selected = selectedTechniques.size ? Array.from(selectedTechniques) : [];
  const distilled = lastDistillResult && Array.isArray(lastDistillResult.suggested_techniques)
    ? lastDistillResult.suggested_techniques : [];
  return sanitizeDocumentaryTechniques(selected.length ? selected : distilled);
}

function actBoardSuggestedTechniques(actKey, node) {
  if (Array.isArray(node?.imageGenerationTechniques)) {
    const stored = filterActBoardTechniques(
      node.imageGenerationTechniques, ACT_BOARD_IMAGE_TECHNIQUE_CATEGORIES);
    // A saved node may contain an older Rack focus/camera-movement value.
    // Drop that stale value and re-seed from the image-safe pool rather than
    // allowing it to leak into the image-generation prompt.
    if (stored.length || node.imageGenerationTechniques.length === 0) {
      // The node-level picker may contain multiple image-safe techniques. The
      // per-image variant builder below still assigns one technique to each
      // initially generated sample.
      node.imageGenerationTechniques = stored;
      return node.imageGenerationTechniques;
    }
    node.imageGenerationTechniques = [];
  }
  const moodboardTechniques = actBoardMoodboardTechniquePool();
  const moodboardCandidates = Array.from(new Set(moodboardTechniques)).filter(technique =>
    isDocumentaryTechnique(technique)
    && ACT_BOARD_IMAGE_TECHNIQUE_CATEGORIES.has(TECHNIQUE_CATEGORY[technique]));
  const standardCandidates = Array.from(STANDARD_TECHNIQUE_SET).filter(technique =>
    isDocumentaryTechnique(technique)
    && ACT_BOARD_IMAGE_TECHNIQUE_CATEGORIES.has(TECHNIQUE_CATEGORY[technique]));
  // Distilled moodboard techniques take precedence; when none are available,
  // use the standard filmmaking toolkit so image generation still has varied
  // directorial guidance on a fresh board.
  const candidates = moodboardCandidates.length ? moodboardCandidates : standardCandidates;
  if (!candidates.length) return [];

  // Give the node a small palette that can be edited or reused. Each generated
  // image is assigned exactly one technique from this palette below, so a
  // single image never gets an ambiguous bundle of visual directions. The
  // suggested-footage gallery has ACT_BOARD_SUGGESTED_FOOTAGE_IMAGE_SAMPLE_COUNT
  // samples, so seed the fresh node with the same number of possible
  // directions; the input row then truthfully describes every technique that
  // can appear in an image banner.
  const shuffled = candidates.slice();
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const isVisualProxy = node?.filmabilityBucket === 'abstract'
    || Boolean(String(node?.filmabilityProxy || '').trim());
  let suggested = shuffled.slice(0, Math.min(
    ACT_BOARD_SUGGESTED_FOOTAGE_IMAGE_SAMPLE_COUNT, shuffled.length));
  if (isVisualProxy) {
    const proxy = shuffled.find(technique =>
      TECHNIQUE_CATEGORY[technique] === 'metaphor_dataviz');
    if (proxy && !suggested.includes(proxy)) {
      suggested = [proxy, ...suggested].slice(0,
        Math.min(ACT_BOARD_SUGGESTED_FOOTAGE_IMAGE_SAMPLE_COUNT, shuffled.length));
    }
  }
  if (node && typeof node === 'object') node.imageGenerationTechniques = suggested;
  return suggested;
}

function actBoardImageTechniqueCandidates(actKey, node) {
  const stored = filterActBoardTechniques(
    Array.isArray(node?.imageGenerationTechniques) ? node.imageGenerationTechniques : [],
    ACT_BOARD_IMAGE_TECHNIQUE_CATEGORIES,
  );
  // Once a node has a stored/editable palette, it is authoritative. Do not
  // silently add moodboard or standard techniques that are absent from the
  // input row; doing so made image banners claim a technique the presenter
  // never selected.
  if (stored.length) return Array.from(new Set(stored));
  const moodboard = filterActBoardTechniques(
    actBoardMoodboardTechniquePool(), ACT_BOARD_IMAGE_TECHNIQUE_CATEGORIES,
  );
  const standard = filterActBoardTechniques(
    Array.from(STANDARD_TECHNIQUE_SET), ACT_BOARD_IMAGE_TECHNIQUE_CATEGORIES,
  );
  const preferred = moodboard.length ? moodboard : standard;
  return Array.from(new Set([...stored, ...preferred]));
}

function actBoardImageTechniqueVariants(actKey, node, count = ACT_BOARD_IMAGE_SAMPLE_COUNT) {
  const pool = actBoardImageTechniqueCandidates(actKey, node);
  const total = Math.max(1, Number(count) || ACT_BOARD_IMAGE_SAMPLE_COUNT);
  if (!pool.length) return Array.from({ length: total }, () => []);
  const proxyTechnique = pool.find(technique =>
    TECHNIQUE_CATEGORY[technique] === 'metaphor_dataviz');
  const isVisualProxy = node?.filmabilityBucket === 'abstract'
    || Boolean(String(node?.filmabilityProxy || '').trim());
  const seenVariants = new Set();
  return Array.from({ length: total }, (_, index) => {
    let selected = [];
    // Try a few random subsets, avoiding duplicate technique combinations so
    // the first several gallery samples visibly explore different directions.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const shuffled = pool.slice();
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      // Keep each image focused on one scene technique. The gallery still gets
      // variety because each option samples a different technique where the
      // pool is large enough.
      const desiredSize = 1;
      let candidate = shuffled.slice(0, desiredSize);
      if (isVisualProxy && proxyTechnique && index % 3 === 0
        && !candidate.includes(proxyTechnique)) {
        candidate = [proxyTechnique, ...candidate].slice(0, desiredSize);
      }
      const key = candidate.slice().sort().join('|');
      selected = candidate;
      if (!seenVariants.has(key)) {
        seenVariants.add(key);
        break;
      }
    }
    return selected;
  });
}

function actBoardImageGenerationPhrase(node) {
  if (node && Object.prototype.hasOwnProperty.call(node, 'imageGenerationPhrase')) {
    return String(node.imageGenerationPhrase || '').trim();
  }
  return String(node?.fragment || '').trim();
}

function actBoardImageTechniquesForVisual(visual) {
  if (!visual) return [];
  const techniques = Array.isArray(visual.techniques) && visual.techniques.length
    ? visual.techniques
    : visual.shotPlan?.techniques;
  return filterActBoardTechniques(
    Array.isArray(techniques) ? techniques : [],
    ACT_BOARD_IMAGE_TECHNIQUE_CATEGORIES,
  );
}

// Generated images retain the shot-plan fields that were used to create
// them. Resolve the plan from the selected gallery visual rather than from
// the node's mutable current plan, so editing the node later does not make
// the image-generation inputs claim a different shot was used.
function actBoardImageShotPlanForVisual(node, visual = null) {
  if (!node) return null;
  const selected = visual || actBoardVisualForKey(node, node.selectedVisualKey);
  const visualKey = String(selected?.key || node.selectedVisualKey || '');
  if (!visualKey.startsWith('generated-')) return null;
  const generatedIndex = Number(visualKey.slice('generated-'.length));
  const option = Number.isInteger(generatedIndex)
    ? node.generatedOptions?.[generatedIndex] : null;
  const plan = selected?.shotPlan || option?.shotPlan || option?.shot_plan;
  if (plan && typeof plan === 'object' && Object.keys(plan).length) return plan;
  // Older saved sessions may have stored only the node-level plan. It is
  // still safe to use that fallback for a generated selection, but never for
  // stock footage or an upload where no image shot plan exists.
  return node.shotPlan && typeof node.shotPlan === 'object' ? node.shotPlan : null;
}

// Shot-size letters (see backend/shot_plan_llm.py's _SHOT_SIZES) spelled out
// so a presenter who has not memorized cinematography shorthand still knows
// what "MCU" means at a glance.
const ACT_BOARD_SHOT_SIZE_NAMES = {
  ELS: 'Extreme Long Shot',
  LS: 'Long Shot',
  MLS: 'Medium-Long Shot',
  MS: 'Medium Shot',
  MCU: 'Medium Close-Up',
  CU: 'Close-Up',
  ECU: 'Extreme Close-Up',
};

function actBoardShotSizeDisplayText(value) {
  const key = String(value || '').trim().toUpperCase();
  const name = ACT_BOARD_SHOT_SIZE_NAMES[key];
  return name ? `${key} (${name})` : String(value || '').trim();
}

// One [label, value] pair per populated shot-plan field, for building the
// bolded-label rows in the image-generation inputs panel. Shared with
// actBoardImageShotPlanDisplayText's flat text below so both stay in sync.
function actBoardImageShotPlanRows(node, visual = null) {
  const plan = actBoardImageShotPlanForVisual(node, visual);
  if (!plan) return [];
  const techniques = Array.isArray(plan.techniques)
    ? plan.techniques.filter(Boolean).join(' · ') : '';
  return [
    ['Shot size', actBoardShotSizeDisplayText(plan.shot_size || plan.shotSize)],
    ['Narrative operation', plan.narrative_operation || plan.narrativeOperation],
    ['Purpose', plan.purpose],
    ['Visual description', plan.visual_description || plan.visualDescription || plan.visual],
    ['Techniques', techniques],
  ].filter(([, value]) => String(value || '').trim());
}

function actBoardImageShotPlanDisplayText(node, visual = null) {
  const fields = actBoardImageShotPlanRows(node, visual);
  return fields.length
    ? fields.map(([label, value]) => `${label}: ${String(value).trim()}`).join('\n')
    : 'No saved shot plan for this visual.';
}

// Fills the shot-plan value cell with one row per field, the label bolded -
// `container.textContent = actBoardImageShotPlanDisplayText(...)` could not
// bold a label without also bolding the value, since it is one flat string.
function renderActBoardImageShotPlanRows(container, node, visual = null) {
  if (!container) return;
  container.replaceChildren();
  const fields = actBoardImageShotPlanRows(node, visual);
  if (!fields.length) {
    container.textContent = 'No saved shot plan for this visual.';
    return;
  }
  fields.forEach(([label, value]) => {
    const row = document.createElement('div');
    row.className = 'storyboard-act-board-image-generation-shot-plan-row';
    const strongLabel = document.createElement('strong');
    strongLabel.textContent = `${label}: `;
    row.appendChild(strongLabel);
    row.appendChild(document.createTextNode(String(value).trim()));
    container.appendChild(row);
  });
}

// Keep the editable technique row truthful when an older node selects an
// image whose technique was generated before the current palette was saved.
// Newly generated options already come from the palette, but this migration
// prevents a stale input row from disagreeing with the selected image banner.
function syncActBoardImageTechniquesForVisual(node, visual) {
  if (!node || !visual) return;
  const techniques = actBoardImageTechniquesForVisual(visual);
  if (techniques.length) node.imageGenerationTechniques = techniques;
}

function closeActBoardTechniquePopup() {
  actBoardTechniquePopupCleanup?.();
  actBoardTechniquePopupCleanup = null;
  actBoardTechniquePopupEl?.remove();
  actBoardTechniquePopupEl = null;
  hideTechniqueMotionPreview();
}

function openActBoardVideoMovementPopup(actKey, node) {
  closeActBoardTechniquePopup();
  const selected = new Set(ensureActBoardVideoGenerationTechniques(node));
  const backdrop = document.createElement('div');
  backdrop.className = 'storyboard-act-board-technique-popup-backdrop';
  const dialog = document.createElement('section');
  dialog.className = 'storyboard-act-board-technique-popup narrative-arc-techniques';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Video camera movement');

  const header = document.createElement('div');
  header.className = 'storyboard-act-board-technique-popup-header';
  const heading = document.createElement('strong');
  heading.textContent = 'Video camera movement';
  const actions = document.createElement('div');
  actions.className = 'storyboard-act-board-technique-popup-actions';
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'btn-secondary';
  cancelButton.textContent = 'Cancel';
  const doneButton = document.createElement('button');
  doneButton.type = 'button';
  doneButton.className = 'btn-primary';
  doneButton.textContent = 'Done';
  actions.append(cancelButton, doneButton);
  header.append(heading, actions);
  dialog.appendChild(header);

  // const categoryLabel = document.createElement('div');
  // categoryLabel.className = 'technique-category-label';
  // categoryLabel.textContent = 'Camera movement';
  const row = document.createElement('div');
  row.className = 'chip-row';
  Object.entries(TECHNIQUE_CATEGORY)
    .filter(([, category]) => category === 'movement')
    .map(([technique]) => technique)
    .forEach(technique => row.appendChild(buildTechniqueChip(technique, {
      selectionSet: selected,
      standard: STANDARD_TECHNIQUE_SET.has(technique),
      moodboardDerived: actBoardMoodboardTechniquePool().includes(technique),
    })));
  dialog.append(row);

  const finish = save => {
    if (save) {
      node.videoGenerationTechniques = filterActBoardTechniques(
        Array.from(selected), ACT_BOARD_VIDEO_TECHNIQUE_CATEGORIES);
      saveDebugSession();
    }
    closeActBoardTechniquePopup();
    if (save) rerenderActBoard();
  };
  cancelButton.addEventListener('click', () => finish(false));
  doneButton.addEventListener('click', () => finish(true));
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) finish(false);
  });
  dialog.addEventListener('click', event => event.stopPropagation());
  const handleKeydown = event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  };
  window.addEventListener('keydown', handleKeydown, true);
  actBoardTechniquePopupCleanup = () => window.removeEventListener('keydown', handleKeydown, true);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);
  actBoardTechniquePopupEl = backdrop;
  doneButton.focus({ preventScroll: true });
}

function openActBoardTechniquePopup(actKey, node, options = {}) {
  if (!node) return;
  if (options.targetField === 'videoGenerationTechniques') {
    openActBoardVideoMovementPopup(actKey, node);
    return;
  }
  closeActBoardTechniquePopup();
  const allowedCategories = options.allowedCategories || ACT_BOARD_IMAGE_TECHNIQUE_CATEGORIES;
  const targetField = options.targetField || 'imageGenerationTechniques';
  const defaultSelection = targetField === 'imageGenerationTechniques'
    ? actBoardSuggestedTechniques(actKey, node) : [];
  const selectedTechniquesForNode = filterActBoardTechniques(
    Array.isArray(node[targetField]) ? node[targetField] : defaultSelection,
    allowedCategories,
  );
  // Image generation can use a multi-technique node selection. Individual
  // generated samples remain focused through actBoardImageTechniqueVariants,
  // which assigns one technique to each sample rather than collapsing the
  // presenter's selection here.
  const selected = new Set(selectedTechniquesForNode);
  const moodboardSet = new Set(filterActBoardTechniques(
    actBoardMoodboardTechniquePool(), allowedCategories));
  const standardSet = new Set(filterActBoardTechniques(
    STANDARD_TECHNIQUE_SET, allowedCategories));
  let popupView = techniquePanelView === 'standard' ? 'standard' : 'moodboard';

  const backdrop = document.createElement('div');
  backdrop.className = 'storyboard-act-board-technique-popup-backdrop';
  const dialog = document.createElement('section');
  dialog.className = 'storyboard-act-board-technique-popup narrative-arc-techniques';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  const popupTitle = options.title || 'Scene techniques';
  dialog.setAttribute('aria-label', popupTitle);
  const header = document.createElement('div');
  header.className = 'storyboard-act-board-technique-popup-header';
  const heading = document.createElement('strong');
  heading.textContent = popupTitle;
  const headerActions = document.createElement('div');
  headerActions.className = 'storyboard-act-board-technique-popup-actions';
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'btn-secondary';
  cancelButton.textContent = 'Cancel';
  const doneButton = document.createElement('button');
  doneButton.type = 'button';
  doneButton.className = 'btn-primary';
  doneButton.textContent = 'Done';
  headerActions.append(cancelButton, doneButton);
  header.append(heading, headerActions);
  dialog.appendChild(header);
  // const hint = document.createElement('p');
  // hint.className = 'storyboard-act-board-technique-popup-hint';
  // hint.textContent = options.hint
  //   || 'Choose shot composition, lighting, or visual metaphor/data-vis techniques for this image.';
  // dialog.appendChild(hint);

  const toggle = document.createElement('div');
  toggle.className = 'technique-view-toggle';
  const moodboardButton = document.createElement('button');
  moodboardButton.type = 'button';
  moodboardButton.className = 'technique-view-toggle-btn';
  moodboardButton.setAttribute('aria-label', 'Show moodboard-distilled techniques');
  moodboardButton.title = 'Moodboard distilled techniques';
  const standardButton = document.createElement('button');
  standardButton.type = 'button';
  standardButton.className = 'technique-view-toggle-btn';
  standardButton.setAttribute('aria-label', 'Show standard filmmaking toolkit');
  standardButton.title = 'Standard filmmaking toolkit';
  toggle.append(moodboardButton, standardButton);
  dialog.appendChild(toggle);
  const moodboardView = document.createElement('div');
  moodboardView.className = 'technique-view technique-view-moodboard';
  const standardView = document.createElement('div');
  standardView.className = 'technique-view technique-view-standard';
  dialog.append(moodboardView, standardView);

  const renderTechniqueViews = () => {
    moodboardView.replaceChildren();
    standardView.replaceChildren();
    const moodboardHeading = document.createElement('div');
    moodboardHeading.className = 'technique-source-label moodboard';
    moodboardHeading.textContent = 'Distilled from your moodboard';
    moodboardView.appendChild(moodboardHeading);
    const moodboardHint = document.createElement('div');
    moodboardHint.className = 'chip-row-caption';
    moodboardHint.textContent = 'Select the moodboard-derived direction for this node.';
    moodboardView.appendChild(moodboardHint);
    const byCategory = new Map();
    Array.from(moodboardSet).forEach(technique => {
      const category = TECHNIQUE_CATEGORY[technique] || 'other';
      if (!byCategory.has(category)) byCategory.set(category, []);
      byCategory.get(category).push(technique);
    });
    [...TECHNIQUE_CATEGORY_ORDER, { key: 'other', label: 'Other' }].forEach(({ key, label }) => {
      const items = byCategory.get(key);
      if (!items?.length) return;
      const categoryLabel = document.createElement('div');
      categoryLabel.className = 'technique-category-label';
      categoryLabel.textContent = label;
      const row = document.createElement('div');
      row.className = 'chip-row';
      items.forEach(technique => row.appendChild(buildTechniqueChip(technique, {
        selectionSet: selected,
        moodboardDerived: true,
      })));
      moodboardView.append(categoryLabel, row);
    });
    if (!moodboardSet.size) {
      const empty = document.createElement('div');
      empty.className = 'technique-source-empty';
      empty.textContent = 'No moodboard techniques have been distilled yet.';
      moodboardView.appendChild(empty);
    }

    const standardHeading = document.createElement('div');
    standardHeading.className = 'technique-source-label standard';
    standardHeading.textContent = 'Standard filmmaking toolkit';
    standardView.appendChild(standardHeading);
    const standardHint = document.createElement('div');
    standardHint.className = 'chip-row-caption';
    standardHint.textContent = 'Common composition and lighting choices.';
    standardView.appendChild(standardHint);
    STANDARD_TECHNIQUE_GROUPS.forEach(group => {
      const allowedGroupTechniques = group.techniques.filter(technique =>
        !allowedCategories || allowedCategories.has(TECHNIQUE_CATEGORY[technique]));
      if (!allowedGroupTechniques.length) return;
      const categoryLabel = document.createElement('div');
      categoryLabel.className = 'technique-category-label';
      categoryLabel.textContent = group.label;
      const row = document.createElement('div');
      row.className = 'chip-row';
      allowedGroupTechniques.forEach(technique => row.appendChild(buildTechniqueChip(technique, {
        selectionSet: selected,
        standard: true,
        moodboardDerived: moodboardSet.has(technique),
      })));
      standardView.append(categoryLabel, row);
    });

    const activeExtras = Array.from(selected).filter(technique =>
      !moodboardSet.has(technique) && !standardSet.has(technique));
    if (activeExtras.length) {
      const activeLabel = document.createElement('div');
      activeLabel.className = 'technique-source-label moodboard';
      activeLabel.textContent = 'Active for this node';
      const activeRow = document.createElement('div');
      activeRow.className = 'chip-row';
      activeExtras.forEach(technique => activeRow.appendChild(buildTechniqueChip(technique, {
        selectionSet: selected,
      })));
      standardView.append(activeLabel, activeRow);
    }
    const moodboardActive = popupView === 'moodboard';
    moodboardView.style.display = moodboardActive ? '' : 'none';
    standardView.style.display = moodboardActive ? 'none' : '';
    moodboardButton.classList.toggle('active', moodboardActive);
    standardButton.classList.toggle('active', !moodboardActive);
    moodboardButton.setAttribute('aria-pressed', String(moodboardActive));
    standardButton.setAttribute('aria-pressed', String(!moodboardActive));
  };
  moodboardButton.addEventListener('click', () => {
    popupView = 'moodboard';
    renderTechniqueViews();
  });
  standardButton.addEventListener('click', () => {
    popupView = 'standard';
    renderTechniqueViews();
  });
  const finish = save => {
    if (save) {
      const chosen = filterActBoardTechniques(Array.from(selected), allowedCategories);
      node[targetField] = chosen;
      saveDebugSession();
    }
    closeActBoardTechniquePopup();
    if (save) rerenderActBoard();
  };
  cancelButton.addEventListener('click', () => finish(false));
  doneButton.addEventListener('click', () => finish(true));
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) finish(false);
  });
  dialog.addEventListener('click', event => event.stopPropagation());
  const handleKeydown = event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  };
  window.addEventListener('keydown', handleKeydown, true);
  actBoardTechniquePopupCleanup = () => window.removeEventListener('keydown', handleKeydown, true);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);
  actBoardTechniquePopupEl = backdrop;
  renderTechniqueViews();
  doneButton.focus({ preventScroll: true });
}

// Keep Act Board image generation intentionally narrow. Unlike the
// Timeline + Scenes image path, this path does not pull in paper figures,
// uploaded footage frames, abstract text, moodboard profiles, or a combined
// concept prompt.
function actBoardImageGenerationInputs(actKey, act, node) {
  const nodes = actBoardNodesForAct(actKey);
  const parentNarration = node?.narrationNodeId
    ? nodes.find(item => item.type === 'narration' && item.id === node.narrationNodeId)
    : null;
  const footagePhrases = parentNarration
    ? (parentNarration.footageNodeIds || [])
      .map(id => nodes.find(item => item.type === 'footage' && item.id === id))
      .filter(Boolean)
      .map(item => String(item.fragment || '').trim())
      .filter(Boolean)
    : [];
  const selectedTechnique = actBoardSuggestedTechniques(actKey, node);
  const mergeTechniques = node?.compositionMode === 'merged'
    && Array.isArray(node.combinedConceptTechniques)
    ? filterActBoardTechniques(
      node.combinedConceptTechniques, ACT_BOARD_IMAGE_TECHNIQUE_CATEGORIES,
    ) : [];
  const generationTechniques = Array.from(new Set([
    ...selectedTechnique, ...mergeTechniques,
  ]));
  return {
    // The image-generation phrase is an Act Board-only override. Keep the
    // original narration fragment intact for linking, while making the value
    // the user entered here the actual subject sent to the shot planner.
    phrase: actBoardImageGenerationPhrase(node),
    narration: parentNarration
      ? String(parentNarration.transcript || parentNarration.text || '').trim()
      : '',
    linkedFootagePhrases: Array.from(new Set(footagePhrases)),
    documentaryMode: actBoardDocumentaryModeForNode(actKey, node),
    // The picker can expose several current techniques. A merged concept
    // additionally carries the techniques attached to both source visuals as
    // generation context, so neither node's directorial choices are lost.
    techniques: generationTechniques,
    generationTechniques,
  };
}

function actBoardImageGenerationContext(actKey, act, node) {
  const inputs = actBoardImageGenerationInputs(actKey, act, node);
  return {
    ...inputs,
    // The phrase, parent narration, and linked footage sequence are sent as
    // separate API fields below. Keep sceneNotes free of bundled copies.
    sceneNotes: '',
    title: inputs.phrase || 'footage',
    actTitle: '',
    sectionIndex: (() => {
      const source = actBoardSourceSection(actKey);
      return source && Number.isInteger(source.index) ? source.index : 0;
    })(),
  };
}

async function generateActBoardNodeExamples(
  actKey, act, node, count = ACT_BOARD_IMAGE_SAMPLE_COUNT, options = {},
) {
  const jobKey = `${actKey}:${node.id}:images`;
  const jobToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const shouldRerender = options.rerender !== false;
  const shouldPersist = options.persist !== false;
  const previousController = actBoardGenerationAbortControllers.get(jobKey);
  if (previousController?.controller) {
    try { previousController.controller.abort(); } catch (err) { /* already finished */ }
  }
  const generationController = typeof AbortController === 'function'
    ? new AbortController() : null;
  actBoardGenerationAbortControllers.set(jobKey, {
    controller: generationController,
    suggestionToken: options.suggestionToken || null,
  });
  actBoardGenerationJobs.set(jobKey, jobToken);
  const getLiveNode = () => actBoardNodesForAct(actKey).find(item => item.id === node.id) || node;
  const context = actBoardImageGenerationContext(actKey, act, node);
  const techniqueVariants = actBoardImageTechniqueVariants(
    actKey, node, count,
  );
  const generationCacheKey = options.cache
    ? (options.cacheKey || JSON.stringify({
      sectionIndex: context.sectionIndex,
      sceneNotes: context.sceneNotes,
      phrase: context.phrase,
      narration: context.narration,
      actTitle: context.actTitle,
      documentaryMode: context.documentaryMode,
      techniques: context.generationTechniques || context.techniques || [],
      techniqueVariants,
      count: Math.max(1, Number(count) || ACT_BOARD_IMAGE_SAMPLE_COUNT),
    })) : '';
  node.generationStatus = 'generating-images';
  node.generationError = '';
  if (shouldPersist) saveDebugSession();
  if (shouldRerender) rerenderActBoard();
  try {
    let result = generationCacheKey
      ? (actBoardImageGenerationCache.get(generationCacheKey)
        || readActBoardPersistentCache('images', generationCacheKey))
      : null;
    if (result && generationCacheKey && !actBoardImageGenerationCache.has(generationCacheKey)) {
      actBoardImageGenerationCache.set(generationCacheKey, result);
    }
    if (!result) {
      result = await enqueueActBoardImageRequest(
        () => fetchGenerateShotExamples({
          sectionIndex: context.sectionIndex,
          title: context.title,
          sceneNotes: context.sceneNotes,
          specificPhrase: context.phrase,
          parentNarration: context.narration,
          linkedFootagePhrases: context.linkedFootagePhrases,
          narration: context.narration,
          actTitle: context.actTitle,
          documentaryMode: context.documentaryMode,
          techniques: context.generationTechniques || context.techniques,
          techniqueVariants,
          count: Math.max(1, Number(count) || ACT_BOARD_IMAGE_SAMPLE_COUNT),
          video: false,
          projectId: premiereProjectId,
          // When the presenter has pinned a reference image, generate as an
          // edit of it rather than from the prompt alone.
          referenceSketchUrl: actBoardReferenceImageUrl(node),
          signal: generationController?.signal,
        }),
        generationController?.signal,
      );
      if (generationCacheKey && result) {
        if (actBoardImageGenerationCache.size >= 64) {
          actBoardImageGenerationCache.delete(
            actBoardImageGenerationCache.keys().next().value);
        }
        actBoardImageGenerationCache.set(generationCacheKey, result);
        writeActBoardPersistentCache('images', generationCacheKey, result);
      }
    }
    premiereProjectId = result.project_id;
    if (actBoardGenerationJobs.get(jobKey) !== jobToken) return;
    node = getLiveNode();
    const freshGeneratedOptions = (result.examples || []).map((example, index) => ({
      url: example.preview_url,
      thumbnail_url: example.thumbnail_url || example.preview_url,
      kind: example.kind || 'image',
      label: example.label || 'Generated example',
      shot_size: example.shot_size || '',
      movement: example.movement || '',
      // Preserve the exact visual phrase used for this generated image. A
      // later video request should not silently switch to a newly edited node
      // phrase when this image remains selected.
      specificPhrase: context.phrase,
      techniques: (example.techniques || techniqueVariants[index] || context.techniques || []).slice(0, 1),
      shotPlan: {
        shot_size: example.shot_size || '',
        narrative_operation: example.narrative_operation || '',
        purpose: example.purpose || '',
        visual_description: example.visual_description || '',
        techniques: (example.techniques || techniqueVariants[index] || context.techniques || []).slice(0, 1),
      },
    }));
    const selectedKeyBeforeGeneration = String(node.selectedVisualKey || '');
    const mediaBeforeGeneration = {
      mediaUrl: node.mediaUrl || '',
      mediaThumbnailUrl: node.mediaThumbnailUrl || '',
      mediaKind: node.mediaKind || '',
      mediaOrigin: node.mediaOrigin || '',
      sourceDurationSeconds: Number(node.sourceDurationSeconds) || 0,
      trimStartSeconds: Number(node.trimStartSeconds) || 0,
    };
    const selectedGeneratedBeforeGeneration = selectedKeyBeforeGeneration.startsWith('generated-')
      ? node.generatedOptions?.[Number(selectedKeyBeforeGeneration.slice('generated-'.length))]
      : null;
    node.generatedOptions = mergePinnedActBoardVisuals(node.generatedOptions, freshGeneratedOptions);
    node.shotPlan = {
      ...(result.shot_plan || (node.generatedOptions[0] && node.generatedOptions[0].shotPlan) || {}),
      ...(String(node.animationDirection || '').trim()
        ? { animation_direction: String(node.animationDirection).trim() }
        : {}),
    };
    node.generationStatus = 'ready';
    // A single-image Generate image request is an explicit replacement action:
    // once it finishes, show that new image in the selected footage box. The
    // larger suggested-footage gallery still only populates the rail so it
    // does not unexpectedly replace a visual the presenter already chose.
    let selectedKey = selectedKeyBeforeGeneration;
    const shouldSelectNewImage = Number(count) === 1 && freshGeneratedOptions.length > 0;
    if (shouldSelectNewImage) {
      const newestImage = freshGeneratedOptions[freshGeneratedOptions.length - 1];
      const generatedIndex = node.generatedOptions.findIndex(option =>
        actBoardVisualIdentity(option) === actBoardVisualIdentity(newestImage));
      if (generatedIndex >= 0) {
        selectedKey = `generated-${generatedIndex}`;
        node.selectedVisualKey = selectedKey;
        node.selectedGeneratedIndex = generatedIndex;
        node.mediaUrl = newestImage.url || '';
        node.mediaThumbnailUrl = newestImage.thumbnail_url || newestImage.url || '';
        node.mediaKind = newestImage.kind || 'image';
        node.mediaOrigin = 'generated';
        node.shotPlan = newestImage.shotPlan || node.shotPlan || {};
        syncActBoardImageTechniquesForVisual(node, newestImage);
        node.sourceDurationSeconds = Number(
          newestImage.duration_seconds || newestImage.duration) || 0;
        node.trimStartSeconds = 0;
      }
    } else if (selectedGeneratedBeforeGeneration) {
      const preservedIndex = node.generatedOptions.findIndex(option =>
        actBoardVisualIdentity(option) === actBoardVisualIdentity(selectedGeneratedBeforeGeneration));
      if (preservedIndex >= 0) {
        selectedKey = `generated-${preservedIndex}`;
        node.selectedVisualKey = selectedKey;
        node.selectedGeneratedIndex = preservedIndex;
      } else {
        selectedKey = 'upload';
        node.selectedVisualKey = selectedKey;
      }
    }
    const selectedGeneratedIndex = selectedKey.startsWith('generated-')
      ? Number(selectedKey.slice('generated-'.length)) : -1;
    const selectedResultIndex = selectedKey.startsWith('result-')
      ? Number(selectedKey.slice('result-'.length)) : -1;
    const selectionStillExists = selectedKey === 'upload' || !selectedKey
      || (selectedKey.startsWith('generated-')
        && Number.isInteger(selectedGeneratedIndex)
        && Boolean(node.generatedOptions[selectedGeneratedIndex]))
      || (selectedKey.startsWith('result-')
        && Number.isInteger(selectedResultIndex)
        && Boolean(node.results?.[selectedResultIndex]));
    if (!selectionStillExists) node.selectedVisualKey = 'upload';
    // Multi-image suggestion passes must leave a user-uploaded/selected
    // visual alone. The explicit single-image Generate image action is the
    // one exception: it intentionally replaces the selection with its new
    // generated result.
    if (!shouldSelectNewImage && node.selectedVisualKey === 'upload'
      && (mediaBeforeGeneration.mediaUrl || mediaBeforeGeneration.mediaThumbnailUrl)) {
      node.mediaUrl = mediaBeforeGeneration.mediaUrl;
      node.mediaThumbnailUrl = mediaBeforeGeneration.mediaThumbnailUrl;
      node.mediaKind = mediaBeforeGeneration.mediaKind;
      node.mediaOrigin = mediaBeforeGeneration.mediaOrigin || 'upload';
      node.sourceDurationSeconds = mediaBeforeGeneration.sourceDurationSeconds;
      node.trimStartSeconds = mediaBeforeGeneration.trimStartSeconds;
    } else if (!node.selectedVisualKey || node.selectedVisualKey === 'upload') {
      node.mediaUrl = '';
      node.mediaThumbnailUrl = '';
      node.mediaKind = '';
      node.mediaOrigin = '';
    }
    // Keep the committed scene snapshot in step with the live node after an
    // async image generation completes. Otherwise a scene card rebuilt from
    // its snapshot can lose the newly selected image (especially for merged
    // and split compositions) until the next explicit scene save.
    syncActBoardLiveSceneSnapshots(actBoardSceneForNode(actKey, node) || null);
    if (shouldPersist) saveDebugSession();
    if (shouldRerender) rerenderActBoard();
    options.onUpdate?.(node);
  } catch (err) {
    if (isGenerationAbort(err)) return;
    node = getLiveNode();
    node.generationStatus = 'error';
    node.generationError = err.message;
    if (shouldPersist) saveDebugSession();
    if (shouldRerender) rerenderActBoard();
    options.onUpdate?.(node);
  } finally {
    if (actBoardGenerationJobs.get(jobKey) === jobToken) actBoardGenerationJobs.delete(jobKey);
    if (actBoardGenerationAbortControllers.get(jobKey)?.controller === generationController) {
      actBoardGenerationAbortControllers.delete(jobKey);
    }
  }
}

async function generateActBoardNodeVideo(actKey, act, node) {
  const selectedKey = String(node.selectedVisualKey || '');
  const selected = actBoardVisualForKey(node, selectedKey);
  const twoFrameEnabled = node.twoFrameVideoEnabled === true;
  const startKey = String(node.videoStartFrameKey || selectedKey || '');
  const endKey = String(node.videoEndFrameKey || '');
  // A node can retain the initial `upload` key after generated images are
  // added. If that saved key no longer resolves to a still, fall back to the
  // currently selected still rather than reporting a misleading start-frame
  // validation error.
  const savedStartVisual = twoFrameEnabled ? actBoardVisualForKey(node, startKey) : null;
  const startVisual = twoFrameEnabled
    ? (savedStartVisual && savedStartVisual.kind !== 'video'
      ? savedStartVisual
      : (selected && selected.kind !== 'video' ? selected : null))
    : selected;
  const endVisual = twoFrameEnabled ? actBoardVisualForKey(node, endKey) : null;
  // The reference image (see actBoardReferenceVisual) is just the selected
  // still, so outside two-frame mode this is the same value as startVisual -
  // kept as its own read for symmetry with the image-generation path, which
  // has no startVisual concept of its own.
  const referenceVisual = twoFrameEnabled ? null : actBoardReferenceVisual(node);
  const seedVisual = referenceVisual || startVisual;
  const chosenImageUrl = seedVisual && seedVisual.kind !== 'video' ? seedVisual.url : '';
  if (!chosenImageUrl) {
    node.error = twoFrameEnabled
      ? 'Choose a still image for the start frame before generating a video.'
      : 'Generate or upload an image before generating a video.';
    saveDebugSession();
    rerenderActBoard({ preservePlayback: true });
    return;
  }
  if (twoFrameEnabled && (!endVisual || endVisual.kind === 'video' || !endVisual.url)) {
    node.error = 'Choose a still image for the end frame before generating a video.';
    saveDebugSession();
    rerenderActBoard({ preservePlayback: true });
    return;
  }
  const context = actBoardGenerationContext(actKey, act, node);
  const sourceShotPlan = startVisual?.shotPlan || node.shotPlan || {};
  const visualDescription = String(
    sourceShotPlan.user_visual_field || sourceShotPlan.visual_description || '',
  ).trim();
  const animationDirection = actBoardSuggestedCameraDirection(sourceShotPlan);
  // Keep the operation-derived motion direction on the shot plan so it
  // survives rerenders and is sent as the canonical instruction for the video
  // request. The Act Board does not expose a user-editable motion control.
  node.animationDirection = animationDirection;
  node.shotPlan = { ...sourceShotPlan, animation_direction: animationDirection };
  const selectedImagePhrase = startVisual
    && Object.prototype.hasOwnProperty.call(startVisual, 'specificPhrase')
    ? String(startVisual.specificPhrase || '').trim()
    : context.specificPhrase;
  const videoTechniques = ensureActBoardVideoGenerationTechniques(node);
  const jobKey = `${actKey}:${node.id}:video`;
  const jobToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const previousController = actBoardGenerationAbortControllers.get(jobKey);
  previousController?.controller?.abort?.();
  const generationController = typeof AbortController === 'function'
    ? new AbortController() : null;
  actBoardGenerationAbortControllers.set(jobKey, {
    controller: generationController,
    suggestionToken: null,
  });
  actBoardGenerationJobs.set(jobKey, jobToken);
  const getLiveNode = () => actBoardNodesForAct(actKey).find(item => item.id === node.id) || node;
  node.generationStatus = 'generating-video';
  node.generationError = '';
  saveDebugSession();
  rerenderActBoard({ preservePlayback: true });
  try {
    // Generate a fresh shot plan immediately before animating. The edited
    // visual field and operation-derived camera direction are unified by the
    // planner.
    const planResult = await fetchGenerateShotPlan({
      sectionIndex: context.sectionIndex,
      title: context.title,
      sceneNotes: context.sceneNotes,
      specificPhrase: selectedImagePhrase,
      parentNarration: context.parentNarration,
      linkedFootagePhrases: context.linkedFootagePhrases,
      documentaryMode: context.documentaryMode,
      techniques: videoTechniques,
      animationDirection,
      visualDescription,
      projectId: premiereProjectId,
      signal: generationController?.signal,
    });
    premiereProjectId = planResult.project_id || premiereProjectId;
    if (actBoardGenerationJobs.get(jobKey) !== jobToken) return;
    node = getLiveNode();
    const plannedAnimationDirection = actBoardSuggestedCameraDirection(planResult.shot_plan || {});
    node.shotPlan = {
      ...(planResult.shot_plan || {}),
      animation_direction: plannedAnimationDirection,
      ...(visualDescription
        ? { user_visual_field: visualDescription, subject_action: visualDescription }
        : {}),
    };
    node.animationDirection = plannedAnimationDirection;
    saveDebugSession();
    const result = await fetchGenerateShotVideo({
      sectionIndex: context.sectionIndex,
      chosenImageUrl,
      startImageUrl: twoFrameEnabled ? startVisual.url : '',
      endImageUrl: twoFrameEnabled ? endVisual.url : '',
      sceneNotes: context.sceneNotes,
      specificPhrase: selectedImagePhrase,
      parentNarration: context.parentNarration,
      linkedFootagePhrases: context.linkedFootagePhrases,
      documentaryMode: context.documentaryMode,
      techniques: videoTechniques,
      animationDirection: plannedAnimationDirection,
      subjectAction: visualDescription,
      projectId: premiereProjectId,
      shotPlan: node.shotPlan || {},
      signal: generationController?.signal,
    });
    premiereProjectId = result.project_id;
    if (actBoardGenerationJobs.get(jobKey) !== jobToken) return;
    node = getLiveNode();
    const resultShotPlan = {
      ...(result.shot_plan || node.shotPlan || {}),
      animation_direction: plannedAnimationDirection,
      ...(visualDescription
        ? { user_visual_field: visualDescription, subject_action: visualDescription }
        : {}),
    };
    const video = {
      url: result.preview_url,
      thumbnail_url: result.thumbnail_url || (startVisual && (startVisual.thumbnailUrl || startVisual.url)) || chosenImageUrl,
      kind: 'video',
      duration_seconds: ACT_BOARD_GENERATED_VIDEO_SECONDS,
      label: result.generation_mode === 'two-frame'
        ? 'Generated video · start/end frames' : 'Generated video',
      shot_size: (result.shot_plan && result.shot_plan.shot_size) || (node.shotPlan && node.shotPlan.shot_size) || '',
      movement: (result.shot_plan && result.shot_plan.movement) || (node.shotPlan && node.shotPlan.movement) || '',
      specificPhrase: selected?.specificPhrase || context.specificPhrase || '',
      shotPlan: resultShotPlan,
      animationDirection: plannedAnimationDirection,
      generationMode: result.generation_mode || (twoFrameEnabled ? 'two-frame' : 'single-image'),
    };
    node.generatedOptions = [...(node.generatedOptions || []), video];
    node.selectedGeneratedIndex = node.generatedOptions.length - 1;
    // A generated video is the output the presenter just asked for, so make
    // that exact option the selected preview. Image generation deliberately
    // leaves the upload/current selection alone, but video generation should
    // immediately show and play the newly-created animation in the node.
    node.selectedVisualKey = `generated-${node.selectedGeneratedIndex}`;
    node.mediaUrl = video.url;
    node.mediaThumbnailUrl = video.thumbnail_url;
    node.mediaKind = 'video';
    node.mediaOrigin = 'generated';
    node.shotPlan = video.shotPlan;
    if (node.timingWasManuallyAdjusted !== true) {
      node.sourceDurationSeconds = ACT_BOARD_GENERATED_VIDEO_SECONDS;
      node.trimStartSeconds = 0;
      node.durationSeconds = ACT_BOARD_GENERATED_VIDEO_SECONDS;
      node.durationWasSuggested = false;
    }
    node.generationStatus = 'ready';
    saveDebugSession();
    rerenderActBoard({ preservePlayback: true });
  } catch (err) {
    if (isGenerationAbort(err)) return;
    node = getLiveNode();
    node.generationStatus = 'error';
    node.generationError = err.message;
    saveDebugSession();
    rerenderActBoard({ preservePlayback: true });
  } finally {
    if (actBoardGenerationJobs.get(jobKey) === jobToken) actBoardGenerationJobs.delete(jobKey);
    if (actBoardGenerationAbortControllers.get(jobKey)?.controller === generationController) {
      actBoardGenerationAbortControllers.delete(jobKey);
    }
  }
}

