function createActBoardNodeId(type) {
  const suffix = window.crypto && typeof window.crypto.randomUUID === 'function'
    ? window.crypto.randomUUID().slice(0, 8)
    : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `act-board-${type}-${suffix}`;
}

function actBoardNarrationTextHash(text) {
  let hash = 2166136261;
  for (const char of String(text || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${hash >>> 0}-${String(text || '').length}`;
}

function actBoardNarrationSourceText(node) {
  return String(node?.transcript || node?.text || '').trim();
}

function actBoardNarrationSpanTextKey(value) {
  return normalizeActBoardFootagePhrase(value).toLocaleLowerCase();
}

function normalizeActBoardFootagePhrase(value) {
  // Preserve word boundaries in selected narration phrases. A native text
  // selection can contain line breaks or repeated spaces, but collapsing those
  // runs to one literal space keeps “election night” searchable as two words
  // instead of allowing a provider/query planner to receive “electionnight”.
  // Inline narration spans can contain zero-width boundary characters that
  // some browsers omit from `selection.toString()`. Treat them as spaces so
  // a phrase such as “election night” never becomes “electionnight”.
  return String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A highlight the presenter deleted must not come back on its own. Two
// things brought it back: Visualize re-runs the classifier (forced, so an
// edit cannot silence it), and the cached analysis is re-applied on render -
// both re-proposed the same clause, and its footage nodes with it. So a
// deletion is remembered against the CLASSIFIER only: a suggestion whose
// wording matches an exclusion is dropped, while a phrase the presenter
// highlights by hand is always accepted (and re-adding clears the exclusion).
function actBoardNarrationSpanExcluded(node, span) {
  const list = Array.isArray(node?.narrationSpanExclusions) ? node.narrationSpanExclusions : [];
  if (!list.length || !span) return false;
  if (span.kind === 'user_selection' || span.origin === 'manual') return false;
  const key = actBoardNarrationSpanTextKey(
    typeof span === 'string' ? span : (span.text || span.fragment || ''));
  if (!key) return false;
  return list.some(item => actBoardNarrationSpanTextKey(
    typeof item === 'string' ? item : (item?.text || '')) === key);
}

function rememberActBoardNarrationExclusion(node, text) {
  if (!node) return;
  const key = actBoardNarrationSpanTextKey(text);
  if (!key) return;
  if (!Array.isArray(node.narrationSpanExclusions)) node.narrationSpanExclusions = [];
  if (!node.narrationSpanExclusions.some(item => actBoardNarrationSpanTextKey(
    typeof item === 'string' ? item : (item?.text || '')) === key)) {
    node.narrationSpanExclusions.push({ text: String(text || '').trim() });
  }
}

function forgetActBoardNarrationExclusion(node, text) {
  if (!node || !Array.isArray(node.narrationSpanExclusions)) return;
  const key = actBoardNarrationSpanTextKey(text);
  node.narrationSpanExclusions = node.narrationSpanExclusions.filter(item =>
    actBoardNarrationSpanTextKey(typeof item === 'string' ? item : (item?.text || '')) !== key);
}

function stripActBoardNarrationExcludedPhrases(node, value) {
  // Kept as a compatibility shim for callers that still use the old helper.
  // There is no permanent phrase blacklist; return the source unchanged.
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function removeActBoardNarrationHighlight(narrationNode, metadata, renderedText) {
  if (!narrationNode || !String(narrationNode.transcript || '').trim()) return;
  // The delete control lives in the detached node-content panel. Record its
  // owner immediately so a concurrent rerender cannot fall back to another
  // narration card while this mutation is being applied.
  actBoardSelectedNodeId = narrationNode.id || '';
  actBoardSelectedNodeActKey = String(narrationNode.actKey || '');
  document.querySelector('.storyboard-act-board-full-playback-panel')
    ?.setAttribute('data-selected-node-id', actBoardSelectedNodeId);
  document.querySelector('.storyboard-act-board-full-playback-panel')
    ?.setAttribute('data-selected-act-key', actBoardSelectedNodeActKey);
  const text = String(renderedText || metadata?.text || '').replace(/\s+/g, ' ').trim();
  if (!text) return;
  const start = Number(metadata?.start);
  cancelActBoardManualFilmability(narrationNode, {
    start,
    end: Number(metadata?.end),
    text,
  });
  const textKey = actBoardNarrationSpanTextKey(text);
  rememberActBoardNarrationExclusion(narrationNode, text);
  const samePhrase = item => actBoardNarrationSpanTextKey(
    item?.text || item?.fragment || item,
  ) === textKey;
  const sameRange = item => {
    const itemStart = Number(item?.start);
    const itemEnd = Number(item?.end);
    const phraseMatches = samePhrase(item);
    // A selection can include punctuation or normalized whitespace that is
    // not present in the classifier's phrase text. A classifier range fully
    // covered by the selected range is still the entity the user deleted.
    if (!phraseMatches && Number.isFinite(start) && Number.isFinite(itemStart)
      && Number.isFinite(Number(metadata?.end)) && Number.isFinite(itemEnd)
      && itemStart >= start && itemEnd <= Number(metadata.end)) return true;
    if (!phraseMatches) return false;
    // Some persisted timing rows only have `startSeconds`, while selected
    // phrase rows use character offsets. If an item has no comparable offset,
    // the phrase text is the only stable identity and should still be removed.
    if (!Number.isFinite(start) || !Number.isFinite(itemStart)) return true;
    if (Math.abs(itemStart - start) < 1) return true;
    // Native text selection normalizes whitespace and can move the end points
    // by a character or two. Treat an overlapping same-phrase range as the
    // same selection so multi-word delete controls cannot leave stale state.
    return Number.isFinite(Number(metadata?.end)) && Number.isFinite(itemEnd)
      && itemStart < Number(metadata.end) && itemEnd > start;
  };
  const phraseFields = ['narrationCandidateSpans', 'fragmentTimings',
    'selectedFootagePhrases', 'footageSuggestedPhrases', 'userFilmablePhrases'];
  phraseFields.forEach(field => {
    if (!Array.isArray(narrationNode[field])) return;
    narrationNode[field] = narrationNode[field].filter(item => !sameRange(item));
  });
  // Remove the entity span itself. The underlying narration words are still
  // rendered as selectable word spans, so the presenter can drag-select the
  // same wording later to add it back as a new footage phrase.
  if (Array.isArray(narrationNode.narrationSpans)) {
    narrationNode.narrationSpans = narrationNode.narrationSpans
      .filter(item => !sameRange(item));
  }
  if (Array.isArray(narrationNode.footageFragments)) {
    narrationNode.footageFragments = narrationNode.footageFragments.filter(item =>
      !samePhrase(item));
  }
  const removedFootageCount = removeActBoardFootageNodesForDeletedPhrases(
    narrationNode.actKey, narrationNode, [textKey]);
  // Keep the current scene narration slide selected while the text is
  // rerendered. Phrase deletion should change highlighting/footage, not move
  // the presenter to another narration segment.
  if (narrationNode.id && narrationNode.sceneId) {
    const selectedSlide = Array.from(document.querySelectorAll(
      `.storyboard-act-board-scene-narration-slide.selected[data-narration-node-id="${String(narrationNode.id).replace(/"/g, '\\"')}"]`,
    ))[0];
    if (selectedSlide) {
      actBoardSelectedNarrationSegmentByScene.set(String(narrationNode.sceneId), narrationNode.id);
    }
  }
  narrationNode.narrationSpanStatus = 'ready';
  narrationNode.narrationSpanError = '';
  saveDebugSession();
  // Deleting a highlight that owned no footage changes text only. A full
  // rerenderActBoard here cost ~46ms of the ~61ms delete - 76% of the work -
  // to rebuild rails and cards that did not change. The in-place highlight
  // refresh does the same visible job in well under a millisecond.
  if (removedFootageCount) {
    rerenderActBoard();
    return;
  }
  unwrapActBoardNarrationSpanInDom(narrationNode, textKey);
  refreshActBoardNarrationHighlightDom(narrationNode);
  refreshActBoardNodeContentPanel(narrationNode.actKey, narrationNode);
}

function removeActBoardFootageNodesForDeletedPhrases(actKey, narrationNode, phraseKeys = null) {
  if (!narrationNode) return 0;
  const deletedPhrases = new Set((Array.isArray(phraseKeys) ? phraseKeys : [])
    .map(key => String(key).split('|')[0])
    .map(actBoardNarrationSpanTextKey)
    .filter(Boolean));
  if (!deletedPhrases.size) return 0;
  const nodes = actBoardNodesForAct(actKey);
  const removeIds = new Set((narrationNode.footageNodeIds || [])
    .map(id => nodes.find(node => node.id === id))
    .filter(node => node?.type === 'footage'
      && deletedPhrases.has(actBoardNarrationSpanTextKey(node.fragment)))
    .map(node => node.id));
  if (!removeIds.size) return 0;
  removeIds.forEach(id => cancelActBoardFootageMediaJob(actKey, id));
  removeIds.forEach(id => {
    const node = nodes.find(item => item.id === id);
    if (!node) return;
    // Splice a deleted shot out of a direct footage chain instead of leaving
    // a broken gap between its former neighbors.
    const previous = nodes.find(item => item.id === node.previousFootageNodeId);
    const next = nodes.find(item => item.id === node.nextFootageNodeId);
    if (previous && previous.nextFootageNodeId === node.id) previous.nextFootageNodeId = next?.id || null;
    if (next && next.previousFootageNodeId === node.id) next.previousFootageNodeId = previous?.id || null;
    node.previousFootageNodeId = null;
    node.nextFootageNodeId = null;
    if (Array.isArray(narrationNode.footageNodeIds)) {
      narrationNode.footageNodeIds = narrationNode.footageNodeIds.filter(item => item !== id);
    }
    if (Array.isArray(actBoardScenes[actKey])) {
      actBoardScenes[actKey] = actBoardScenes[actKey].map(scene => ({
        ...scene,
        sequenceStartNodeId: scene.sequenceStartNodeId === id ? null : scene.sequenceStartNodeId,
        nodeIds: (scene.nodeIds || []).filter(item => item !== id),
        nodeSnapshots: (scene.nodeSnapshots || []).filter(snapshot => snapshot?.id !== id),
        nodeLinks: (scene.nodeLinks || []).filter(link =>
          link.sourceId !== id && link.targetId !== id),
      }));
    }
  });
  nodes.filter(node => node.type === 'audio' && removeIds.has(node.linkedToNodeId))
    .forEach(node => {
      node.linkedToNodeId = null;
      node.linkedToType = null;
    });
  actBoardNodes[actKey] = nodes.filter(node => !removeIds.has(node.id));
  narrationNode.footageFragments = (narrationNode.footageFragments || [])
    .filter(fragment => !deletedPhrases.has(actBoardNarrationSpanTextKey(fragment)));
  recomputeActBoardTiming(narrationNode);
  syncActBoardLiveSceneSnapshots();
  // The caller needs to know: removing shots changes the rails and the canvas,
  // while deleting a highlight that owned no footage only changes the text.
  return removeIds.size;
}

// `force`: run even when the node believes its analysis is current. Editing
// the transcript adopts the new hash so the automatic render-time pass stays
// quiet, which also made the EXPLICIT pass - Visualize highlights - a no-op:
// after any edit it found status 'ready' with a matching hash and returned
// null, so no clauses were ever suggested again. An in-flight analysis for the
// same text is still reused rather than restarted.
function requestActBoardNarrationAnalysis(narrationNode, { force = false } = {}) {
  if (!narrationNode || narrationNode.type !== 'narration') return null;
  // Filmable-phrase detection is intentionally transcript-only. Suggested
  // drafts are reference copy, not spoken narration, so they must not create
  // entity highlights or footage suggestions before the presenter records.
  const text = String(narrationNode.transcript || '').trim();
  if (!text) return null;
  const hash = actBoardNarrationTextHash(text);
  // Return an in-flight analysis before consulting the node's status.  The
  // status is already set to `extracting`/`classifying` as soon as the
  // request starts, so the old status guard made callers silently miss the
  // promise and continue with stale filmability spans.
  const key = `${narrationNode.id}:${hash}`;
  if (actBoardNarrationAnalysisPromises.has(key)) {
    return actBoardNarrationAnalysisPromises.get(key);
  }
  if (!force && narrationNode.narrationSpanHash === hash
    && ['extracting', 'classifying', 'ready', 'error'].includes(narrationNode.narrationSpanStatus)) return null;
  const previousController = actBoardNarrationAbortControllers.get(narrationNode.id);
  previousController?.abort?.();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  actBoardNarrationAbortControllers.set(narrationNode.id, controller);
  // The unit is part of the key: a phrase-era analysis of the same text must
  // not be served as a clause analysis, or vice versa. Re-recording the exact
  // same words with a DIFFERENT pause pattern must also miss this cache -
  // splitActBoardClauseSpansAtPauses's cuts depend on where the presenter
  // paused, not just the transcribed text, so the persisted key has to carry
  // that too (`hash` itself stays text-only - it backs several unrelated
  // staleness checks elsewhere that must keep comparing pure text).
  const pauseFingerprint = ACT_BOARD_HIGHLIGHT_UNIT === 'clause'
    ? actBoardPauseCharOffsets(narrationNode).join(',') : '';
  const persistentKey = `${hash}|${actBoardDocumentaryModeForNode(narrationNode.actKey, narrationNode)}|${ACT_BOARD_HIGHLIGHT_UNIT}|${pauseFingerprint}`;
  const cachedAnalysis = readActBoardPersistentCache('narration', persistentKey);
  if (cachedAnalysis && Array.isArray(cachedAnalysis.spans)) {
    narrationNode.narrationSpanHash = hash;
    narrationNode.narrationSpans = cachedAnalysis.spans
      .filter(span => !actBoardNarrationSpanExcluded(narrationNode, span));
    narrationNode.narrationSpanSource = cachedAnalysis.source || 'cached';
    narrationNode.narrationSpanStatus = 'ready';
    alignActBoardNarrationFragments(narrationNode,
      narrationNode.narrationSpans.filter(span => span.bucket !== 'ignore').map(span => span.text));
    if (actBoardNarrationAbortControllers.get(narrationNode.id) === controller) {
      actBoardNarrationAbortControllers.delete(narrationNode.id);
    }
    return null;
  }
  narrationNode.narrationSpanHash = hash;
  narrationNode.narrationSpanStatus = 'extracting';
  const fetchCandidates = ACT_BOARD_HIGHLIGHT_UNIT === 'clause'
    ? fetchNarrationClauses : fetchNarrationSpans;
  const promise = fetchCandidates(text, controller?.signal)
    .then(local => {
      if (actBoardNarrationTextHash(actBoardNarrationSourceText(narrationNode)) !== hash) return;
      let candidates = (Array.isArray(local.spans) ? local.spans : [])
        .filter(span => !actBoardNarrationSpanExcluded(narrationNode, span));
      if (ACT_BOARD_HIGHLIGHT_UNIT === 'clause') {
        candidates = splitActBoardClauseSpansAtPauses(candidates, narrationNode);
      }
      narrationNode.narrationCandidateSpans = candidates;
      // No filmability classifier: clause boundaries (pauses + punctuation +
      // the word-count cap) are the only gate on what becomes a highlight
      // now, so every local candidate is used as-is - there is nothing left
      // to wait on an LLM for here.
      narrationNode.narrationSpans = candidates.map(span => ({ ...span, bucket: 'depictable' }));
      narrationNode.narrationSpanSource = 'local';
      narrationNode.narrationSpanStatus = 'ready';
      writeActBoardPersistentCache('narration', persistentKey, {
        source: narrationNode.narrationSpanSource,
        spans: narrationNode.narrationSpans,
      });
      const detectedFragments = narrationNode.narrationSpans
        .filter(span => span && span.bucket !== 'ignore' && span.text)
        .map(span => span.text);
      alignActBoardNarrationFragments(narrationNode, detectedFragments);
      saveDebugSession();
      const scene = actBoardSceneForNode(narrationNode.actKey, narrationNode);
      queueActBoardScenePatch(narrationNode.actKey, scene?.id || narrationNode.sceneId, {
        persist: true,
      });
    })
    .catch(error => {
      if (error?.name === 'AbortError') return;
      if (actBoardNarrationTextHash(actBoardNarrationSourceText(narrationNode)) !== hash) return;
      narrationNode.narrationSpanStatus = 'error';
      narrationNode.narrationSpanError = error.message;
      alignActBoardNarrationFragments(narrationNode, []);
      saveDebugSession();
      const scene = actBoardSceneForNode(narrationNode.actKey, narrationNode);
      queueActBoardScenePatch(narrationNode.actKey, scene?.id || narrationNode.sceneId, {
        persist: true,
      });
    })
    .finally(() => {
      actBoardNarrationAnalysisPromises.delete(key);
      if (actBoardNarrationAbortControllers.get(narrationNode.id) === controller) {
        actBoardNarrationAbortControllers.delete(narrationNode.id);
      }
    });
  actBoardNarrationAnalysisPromises.set(key, promise);
  return promise;
}

function actBoardManualFilmabilityRequestKey(narrationNode, selection) {
  if (!narrationNode?.id || !selection) return '';
  const transcript = String(narrationNode.transcript || '');
  const start = Number(selection.start);
  const end = Number(selection.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return '';
  return [
    narrationNode.id,
    actBoardNarrationTextHash(transcript),
    Math.max(0, start),
    Math.max(0, end),
    actBoardDocumentaryModeForNode(narrationNode.actKey, narrationNode),
  ].join(':');
}

function actBoardManualFilmabilityRangeMatches(item, selection) {
  const itemStart = Number(item?.start);
  const itemEnd = Number(item?.end);
  const start = Number(selection?.start);
  const end = Number(selection?.end);
  return Number.isFinite(itemStart) && Number.isFinite(itemEnd)
    && Number.isFinite(start) && Number.isFinite(end)
    && itemStart === start && itemEnd === end;
}

function actBoardManualFilmabilitySelectionPresent(narrationNode, selection) {
  const liveNode = actBoardNodesForAct(narrationNode?.actKey)
    .find(item => item.id === narrationNode?.id);
  if (liveNode !== narrationNode) return false;
  const fields = ['selectedFootagePhrases', 'userFilmablePhrases',
    'footageSuggestedPhrases'];
  return fields.some(field => Array.isArray(narrationNode?.[field])
    && narrationNode[field].some(item =>
      actBoardManualFilmabilityRangeMatches(item, selection)));
}

function cancelActBoardManualFilmability(narrationNode, selection) {
  const key = actBoardManualFilmabilityRequestKey(narrationNode, selection);
  if (!key) return;
  actBoardManualFilmabilityPromises.delete(key);
}

function updateActBoardManualFilmabilitySelection(narrationNode, selection, classified) {
  if (!narrationNode || !selection || !classified
    || !actBoardManualFilmabilitySelectionPresent(narrationNode, selection)) return false;
  // Never fall back to the raw highlighted text as the query: with no
  // classifier, there is no real query yet, and letting the verbatim
  // selection become the query short-circuits the per-footage-node
  // fetchMediaQueries call (findActBoardFootageNode's explicitQuery check),
  // so the stock search runs on the literal clause instead of a searchable
  // phrase. Leaving it empty is what lets that real query generation run.
  const query = normalizeActBoardFootagePhrase(
    classified.query || classified.visual_proxy || '',
  );
  const next = {
    ...selection,
    text: normalizeActBoardFootagePhrase(selection.text),
    query,
    bucket: classified.bucket || 'depictable',
    visual_proxy: normalizeActBoardFootagePhrase(classified.visual_proxy || ''),
    filmabilityPending: false,
    filmabilitySource: 'local',
  };
  ['selectedFootagePhrases', 'userFilmablePhrases', 'footageSuggestedPhrases']
    .forEach(field => {
      if (!Array.isArray(narrationNode[field])) return;
      narrationNode[field] = narrationNode[field].map(item =>
        actBoardManualFilmabilityRangeMatches(item, selection)
          ? { ...item, ...next } : item);
    });
  saveDebugSession();
  if (!refreshActBoardNarrationHighlightDom(narrationNode)) rerenderActBoard();
  return true;
}

function requestActBoardManualFilmability(narrationNode, selection) {
  if (!narrationNode || narrationNode.type !== 'narration'
    || !String(narrationNode.transcript || '').trim() || !selection) return null;
  const source = String(narrationNode.transcript || '');
  const start = Number(selection.start);
  const end = Number(selection.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const key = actBoardManualFilmabilityRequestKey(narrationNode, selection);
  if (!key) return null;
  const existing = actBoardManualFilmabilityPromises.get(key);
  if (existing) return existing;
  const exactExisting = [
    ...(Array.isArray(narrationNode.narrationSpans) ? narrationNode.narrationSpans : []),
    ...(Array.isArray(narrationNode.narrationCandidateSpans)
      ? narrationNode.narrationCandidateSpans : []),
  ].find(item => actBoardManualFilmabilityRangeMatches(item, selection)
    && item.bucket && item.bucket !== 'pending');
  if (exactExisting) {
    updateActBoardManualFilmabilitySelection(narrationNode, selection, exactExisting);
    return Promise.resolve(exactExisting);
  }
  // No filmability classifier to consult anymore - an explicit presenter
  // selection is depictable by definition, and its actual stock-search query
  // is generated later, per footage node, by fetchMediaQueries. Leave query
  // empty (NOT the raw highlighted text) so that real generation is what
  // runs, rather than a verbatim-clause stock search.
  const classified = { bucket: 'depictable', query: '', visual_proxy: '' };
  updateActBoardManualFilmabilitySelection(narrationNode, selection, classified);
  const promise = Promise.resolve(classified);
  actBoardManualFilmabilityPromises.set(key, promise);
  promise.finally(() => {
    if (actBoardManualFilmabilityPromises.get(key) === promise) {
      actBoardManualFilmabilityPromises.delete(key);
    }
  });
  return promise;
}

function pendingActBoardManualFilmabilityForNode(narrationNode) {
  if (!narrationNode?.id) return [];
  const prefix = `${narrationNode.id}:${actBoardNarrationTextHash(
    String(narrationNode.transcript || ''),
  )}:`;
  return Array.from(actBoardManualFilmabilityPromises.entries())
    .filter(([key]) => key.startsWith(prefix))
    .map(([, promise]) => promise);
}

function waitForActBoardManualFilmability(narrationNode) {
  const pending = pendingActBoardManualFilmabilityForNode(narrationNode);
  return pending.length ? Promise.allSettled(pending) : Promise.resolve([]);
}

function actBoardNarrationFragments(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const seen = new Set();
  const fragments = [];
  const add = value => {
    const fragment = value.replace(/^[-–—:;,\s]+|[-–—:;,\s]+$/g, '').trim();
    if (fragment.split(/\s+/).filter(Boolean).length < 3) return;
    const key = fragment.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    fragments.push(fragment);
  };
  normalized.split(/(?<=[.!?])\s+/).forEach(sentence => {
    const clauses = sentence.split(/\s*[,;:—–]\s*/).filter(Boolean);
    if (clauses.length > 1) clauses.forEach(add);
    else add(sentence);
  });
  if (fragments.length < 2) normalized.split(/\s*[,;:—–]\s*/).forEach(add);
  if (!fragments.length) add(normalized);
  const maxFragments = 5;
  if (fragments.length <= maxFragments) return fragments;
  const evenlySpaced = [];
  for (let index = 0; index < maxFragments; index += 1) {
    const sourceIndex = Math.round(index * (fragments.length - 1) / (maxFragments - 1));
    const fragment = fragments[sourceIndex];
    if (fragment && !evenlySpaced.includes(fragment)) evenlySpaced.push(fragment);
  }
  return evenlySpaced;
}

// pauseAfterWordIndices: optional Set of GLOBAL word indices (the same
// numbering as word.dataset.narrationWordIndex below) - a zero-width,
// textContent-empty marker is inserted right after that word. Word-index
// rather than a character offset so a pause survives being rendered against a
// differently-whitespaced copy of the same words (e.g. the scene-narration
// carousel's `.replace(/\s+/g, ' ')` collapse) - collapsing whitespace never
// changes which word is Nth. Empty textContent keeps the marker invisible to
// callers that read a rendered span's textContent back out as editable
// narration (e.g. makeActBoardInlinePhraseEditor).
function appendActBoardNarrationWords(parent, text, sourceOffset, source, pauseAfterWordIndices) {
  const value = String(text || '');
  if (!value) return;
  const baseWordIndex = normalizedBoardWords(String(source || '').slice(0, sourceOffset)).length;
  const wordPattern = /[A-Za-z0-9']+/g;
  let cursor = 0;
  let match;
  let localWordIndex = 0;
  while ((match = wordPattern.exec(value))) {
    if (match.index > cursor) parent.appendChild(document.createTextNode(value.slice(cursor, match.index)));
    const word = document.createElement('span');
    const globalWordIndex = baseWordIndex + localWordIndex;
    word.className = 'storyboard-act-board-narration-word';
    word.dataset.narrationWordIndex = String(globalWordIndex);
    word.dataset.narrationSourceStart = String(sourceOffset + match.index);
    word.dataset.narrationSourceEnd = String(sourceOffset + match.index + match[0].length);
    word.dataset.narrationWordText = match[0];
    word.textContent = match[0];
    parent.appendChild(word);
    cursor = match.index + match[0].length;
    localWordIndex += 1;
    if (pauseAfterWordIndices && pauseAfterWordIndices.has(globalWordIndex)) {
      const marker = document.createElement('span');
      marker.className = 'storyboard-act-board-narration-pause-marker';
      marker.setAttribute('aria-hidden', 'true');
      marker.title = 'Good place to take a breath';
      parent.appendChild(marker);
    }
  }
  if (cursor < value.length) parent.appendChild(document.createTextNode(value.slice(cursor)));
}

function buildActBoardSuggestedNarrationText(text, fragments, onFragmentEdit, labelText = 'Suggested narration: ', onFragmentSelect, highlightFallback = true, onFragmentRemove = null, pauseWordIndices = null) {
  const container = document.createElement('p');
  container.className = 'storyboard-act-board-node-text';
  // if (onFragmentSelect) {
  //   container.title = 'Click words or drag-select phrases to highlight them, then press Suggest footage. Click a selected phrase again to toggle it off.';
  // }
  const label = document.createElement('strong');
  label.textContent = labelText;
  container.appendChild(label);
  const source = String(text || '');
  const pauseAfterWordIndices = Array.isArray(pauseWordIndices) && pauseWordIndices.length
    ? new Set(pauseWordIndices) : null;
  const ranges = [];
  let searchFrom = 0;
  (Array.isArray(fragments) ? fragments : []).forEach(fragment => {
    const value = typeof fragment === 'string' ? fragment : fragment?.text;
    if (!value) return;
    const explicitStart = Number(fragment?.start);
    const explicitEnd = Number(fragment?.end);
    const hasOffsets = Number.isFinite(explicitStart) && Number.isFinite(explicitEnd)
      && explicitStart >= 0 && explicitEnd > explicitStart;
    const index = hasOffsets ? explicitStart
      : source.toLocaleLowerCase().indexOf(String(value).toLocaleLowerCase(), searchFrom);
    if (index < 0 || index >= source.length) return;
    const end = hasOffsets ? Math.min(source.length, explicitEnd) : index + String(value).length;
    ranges.push({ start: index, end, metadata: typeof fragment === 'string' ? {} : fragment });
    searchFrom = end;
  });
  ranges.sort((a, b) => a.start - b.start);
  // Drop any range that fully contains another, different range in this list
  // (for example an auto-detected clause spanning the whole narration when a
  // short recording has no punctuation left to split on, wrapping around a
  // presenter's own, more specific manual highlight inside it). Without this,
  // the render loop below keeps only the first range reached at a given
  // position and silently skips the narrower one nested inside it, which
  // reads as the manual highlight being swallowed by a highlight box around
  // the entire narration.
  const containsAnotherRange = (candidate, index) => ranges.some((other, otherIndex) => otherIndex !== index
    && candidate.start <= other.start && candidate.end >= other.end
    && (candidate.start < other.start || candidate.end > other.end));
  const visibleRanges = ranges.filter((range, index) => !containsAnotherRange(range, index));
  let cursor = 0;
  visibleRanges.forEach(range => {
    if (range.start < cursor) return;
    if (range.start > cursor) {
      appendActBoardNarrationWords(container, source.slice(cursor, range.start), cursor, source, pauseAfterWordIndices);
    }
    const highlight = document.createElement('span');
    const metadata = range.metadata || {};
    highlight.className = 'storyboard-act-board-node-fragment storyboard-act-board-narration-span';
    // `value` belongs to the range-building loop above; use the actual
    // rendered source slice here so this second loop does not reference an
    // out-of-scope variable.
    const renderedPhrase = source.slice(range.start, range.end);
    highlight.dataset.narrationFragment = renderedPhrase;
    highlight.dataset.narrationFragmentStart = String(range.start);
    highlight.dataset.narrationFragmentEnd = String(range.end);
    if (metadata.bucket) highlight.classList.add(`storyboard-act-board-narration-span-${metadata.bucket}`);
    appendActBoardNarrationWords(highlight, source.slice(range.start, range.end), range.start, source, pauseAfterWordIndices);
    const bucket = metadata.bucket;
    if (bucket === 'depictable') {
      highlight.title = `Find footage for “${metadata.query || highlight.textContent}”`;
    } else if (bucket === 'abstract') {
      highlight.title = `Use visual proxy: ${metadata.visual_proxy || metadata.query || 'find a concrete visual metaphor'}`;
    } else if (bucket === 'pending') {
      highlight.title = 'Classifying this narration phrase…';
    }
    let selectTimer = null;
    if (onFragmentSelect && bucket && bucket !== 'ignore' && bucket !== 'pending') {
      highlight.classList.add('storyboard-act-board-narration-span-clickable');
      highlight.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        clearTimeout(selectTimer);
        selectTimer = setTimeout(() => onFragmentSelect({
          ...metadata,
          start: range.start,
          end: range.end,
          text: renderedPhrase,
          }, renderedPhrase, true), 180);
      });
      highlight.addEventListener('dblclick', () => clearTimeout(selectTimer));
    }
    if (onFragmentRemove) {
      highlight.tabIndex = 0;
      highlight.addEventListener('keydown', event => {
        if (event.key !== 'Delete' && event.key !== 'Backspace') return;
        event.preventDefault();
        event.stopPropagation();
        onFragmentRemove({
          ...metadata,
          start: range.start,
          end: range.end,
          text: renderedPhrase,
        }, renderedPhrase);
      });
      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'storyboard-act-board-narration-span-remove';
      removeButton.textContent = '×';
      removeButton.title = 'Remove this highlighted phrase';
      removeButton.setAttribute('aria-label', `Remove highlighted phrase: ${renderedPhrase}`);
      removeButton.addEventListener('pointerdown', event => {
        event.preventDefault();
        event.stopPropagation();
      });
      removeButton.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        clearTimeout(selectTimer);
        // Prevent a stale native text selection from being re-emitted by the
        // narration container's mouseup handler while this delete click is
        // being processed.
        window.getSelection?.()?.removeAllRanges?.();
        onFragmentRemove({
          ...metadata,
          start: range.start,
          end: range.end,
          text: renderedPhrase,
        }, renderedPhrase);
      });
      highlight.appendChild(removeButton);
    }
    if (onFragmentEdit) {
      if (!bucket || bucket === 'ignore') highlight.title = 'Double-click to edit this narration phrase';
      highlight.addEventListener('dblclick', event => {
        event.preventDefault();
        event.stopPropagation();
        makeActBoardInlinePhraseEditor(
          highlight,
          highlight.textContent,
          replacement => onFragmentEdit(highlight.textContent, replacement)
        );
      });
    }
    container.appendChild(highlight);
    cursor = range.end;
  });
  // Keep narration editable even when the current transcript no longer contains
  // any of the previously detected phrase ranges.
  if (onFragmentEdit && source && !ranges.length) {
    const editable = document.createElement('span');
    editable.className = highlightFallback
      ? 'storyboard-act-board-node-fragment'
      : 'storyboard-act-board-node-plain-editable';
    appendActBoardNarrationWords(editable, source, 0, source, pauseAfterWordIndices);
    editable.title = 'Double-click to edit this narration';
    editable.addEventListener('dblclick', event => {
      event.preventDefault();
      event.stopPropagation();
      makeActBoardInlinePhraseEditor(
        editable,
        editable.textContent,
        replacement => onFragmentEdit(editable.textContent, replacement)
      );
    });
    container.appendChild(editable);
    cursor = source.length;
  }
  if (cursor < source.length) {
    appendActBoardNarrationWords(container, source.slice(cursor), cursor, source, pauseAfterWordIndices);
  }
  if (!source) container.appendChild(document.createTextNode('No narration draft yet.'));
  if (onFragmentSelect && source) {
    // Any word in the narration can seed a new footage idea, not just a span
    // returned by the filmability classifier. Clicks and native text
    // selections accumulate phrase highlights; clicking the same range again
    // toggles it off.
    let textSelectionCaptured = false;
    const emitSelection = (selectedText, start, end, append = false) => {
      const selectedPhrase = normalizeActBoardFootagePhrase(selectedText);
      const safeStart = Number.isFinite(Number(start)) && Number(start) >= 0
        ? Number(start) : source.toLocaleLowerCase().indexOf(selectedPhrase.toLocaleLowerCase());
      const safeEnd = Number.isFinite(Number(end)) && Number(end) > safeStart
        ? Number(end) : safeStart + selectedPhrase.length;
      // Reconstruct from the narration source when offsets are available. This
      // preserves the actual spaces between words even when the browser's
      // native selection crosses inline phrase spans.
      const sourcePhrase = Number.isFinite(safeStart) && safeStart >= 0
        && Number.isFinite(safeEnd) && safeEnd > safeStart
        ? source.slice(safeStart, safeEnd) : selectedPhrase;
      const phrase = normalizeActBoardFootagePhrase(sourcePhrase);
      if (!phrase) return;
      onFragmentSelect({
        text: phrase,
        start: Math.max(0, safeStart),
        end: Math.max(Math.max(0, safeStart), safeEnd),
        // This is a presenter-authored selection, not a classifier result.
        // Keep it provisional until the phrase-level filmability request
        // returns a literal stock query or visual proxy.
        kind: 'user_selection',
        origin: 'manual',
        bucket: 'pending',
        query: '',
      }, phrase, append);
    };
    container.addEventListener('mouseup', event => {
      if (event.target.closest?.('button, input, select, textarea')) return;
      setTimeout(() => {
        const selection = window.getSelection?.();
        if (!selection || selection.isCollapsed || !selection.rangeCount
          || !container.contains(selection.anchorNode)
          || !container.contains(selection.focusNode)) return;
        const phrase = selection.toString().replace(/\s+/g, ' ').trim();
        if (!phrase) return;
        const range = selection.getRangeAt(0);
        const words = Array.from(container.querySelectorAll('[data-narration-source-start]'))
          .filter(word => {
            try { return range.intersectsNode(word); } catch (err) { return false; }
          });
        const starts = words.map(word => Number(word.dataset.narrationSourceStart))
          .filter(Number.isFinite);
        const ends = words.map(word => Number(word.dataset.narrationSourceEnd))
          .filter(Number.isFinite);
        const start = starts.length ? Math.min(...starts) : source.toLocaleLowerCase()
          .indexOf(phrase.toLocaleLowerCase());
        const end = ends.length ? Math.max(...ends) : start + phrase.length;
        textSelectionCaptured = true;
        emitSelection(phrase, start, end, true);
      }, 0);
    });
    // Back to a single click. Editing and highlighting are separate modes now
    // (see buildActBoardNarrationModeToggle), so the transcript is never
    // editable and selectable at the same time and the two cannot fight.
    container.addEventListener('click', event => {
      if (textSelectionCaptured) {
        textSelectionCaptured = false;
        return;
      }
      // Classifier spans with an `ignore` or `pending` bucket do not get their
      // own phrase-click handler, but their child word spans must still be
      // selectable. Only suppress the generic word handler for spans that have
      // an active phrase-click affordance of their own.
      if (event.target.closest('.storyboard-act-board-narration-span-clickable')) return;
      const word = event.target.closest('[data-narration-source-start]');
      if (!word || !container.contains(word)) return;
      emitSelection(word.dataset.narrationWordText || word.textContent,
        Number(word.dataset.narrationSourceStart),
        Number(word.dataset.narrationSourceEnd), true);
    });
  }
  return container;
}

function applyActBoardNarrationPhraseSelection(root, narrationNode, onPhraseRemove = null) {
  if (!root || !narrationNode) return;
  const source = String(narrationNode.transcript || narrationNode.text || '');
  const isExcludedRange = range => {
    const start = Number(range?.start);
    const end = Number(range?.end);
    const text = start >= 0 && end > start
      ? source.slice(start, end) : range?.text || '';
    return actBoardNarrationSpanExcluded(narrationNode, { text, start });
  };
  const selections = Array.isArray(narrationNode.selectedFootagePhrases)
    ? narrationNode.selectedFootagePhrases.filter(item => !isExcludedRange(item)) : [];
  const footageSuggested = Array.isArray(narrationNode.footageSuggestedPhrases)
    ? narrationNode.footageSuggestedPhrases.filter(item => !isExcludedRange(item)) : [];
  const userFilmable = Array.isArray(narrationNode.userFilmablePhrases)
    ? narrationNode.userFilmablePhrases.filter(item => !isExcludedRange(item)) : [];
  const ranges = selections.map(item => ({
    start: Number(item.start), end: Number(item.end),
  })).filter(item => Number.isFinite(item.start) && Number.isFinite(item.end));
  const footageRanges = footageSuggested.map(item => ({
    start: Number(item.start), end: Number(item.end),
  })).filter(item => Number.isFinite(item.start) && Number.isFinite(item.end));
  const userRanges = userFilmable.map(item => ({
    start: Number(item.start), end: Number(item.end),
  })).filter(item => Number.isFinite(item.start) && Number.isFinite(item.end));
  root.querySelectorAll('[data-narration-source-start]').forEach(word => {
    const start = Number(word.dataset.narrationSourceStart);
    const end = Number(word.dataset.narrationSourceEnd);
    // Phrase spans contain their own word spans. Keep the durable highlight
    // on the phrase container only; applying the same class to each child
    // creates nested borders/padding and makes it look like a second highlight
    // was added to individual words.
    const insidePhraseSpan = Boolean(word.closest('[data-narration-fragment]'));
    const hasFootage = footageRanges.some(range => end > range.start && start < range.end)
      || userRanges.some(range => end > range.start && start < range.end);
    const alreadyBlue = hasFootage
      || insidePhraseSpan
      || Boolean(word.closest('.storyboard-act-board-narration-span-depictable'));
    // A phrase that already has footage is already rendered in the durable
    // blue state. Do not layer the temporary orange selection state on top of
    // it during a subsequent Visualize request.
    word.classList.toggle('storyboard-act-board-narration-phrase-selected',
      !insidePhraseSpan && !alreadyBlue
      && ranges.some(range => end > range.start && start < range.end));
    word.classList.toggle('storyboard-act-board-narration-phrase-has-footage',
      hasFootage && !insidePhraseSpan
      && !word.closest('.storyboard-act-board-narration-span-depictable'));
  });
  // A delete control belongs to a live entity, so decide from the DATA rather
  // than from the classes on the rendered span. Correcting the transcript can
  // leave a previously rendered `-depictable` span in place after every phrase
  // list has been cleared; trusting that class kept its "x" on screen with
  // nothing behind it and no way to remove it. If the phrase is not in one of
  // the node's live lists, the control does not belong to anything.
  const livePhraseKeys = new Set([
    ...(narrationNode.narrationSpans || []),
    ...(narrationNode.selectedFootagePhrases || []),
    ...(narrationNode.footageSuggestedPhrases || []),
    ...(narrationNode.userFilmablePhrases || []),
    ...(narrationNode.footageFragments || []),
  ].map(item => actBoardNarrationSpanTextKey(
    typeof item === 'string' ? item : (item?.text || item?.fragment || ''),
  )).filter(Boolean));
  root.querySelectorAll('.storyboard-act-board-narration-span-remove').forEach(button => {
    const owner = button.closest('[data-narration-fragment], [data-narration-source-start]')
      || button.parentElement;
    // The button's own glyph is part of the owner's textContent; strip it
    // before matching the phrase.
    const ownerText = String(owner?.dataset?.narrationFragment
      || owner?.textContent?.replace(button.textContent || '', '') || '').trim();
    button.hidden = !livePhraseKeys.has(actBoardNarrationSpanTextKey(ownerText));
  });
  root.querySelectorAll('[data-narration-fragment]').forEach(fragment => {
    const value = fragment.dataset.narrationFragment || '';
    const source = String(narrationNode.transcript || narrationNode.text || '');
    const start = source.toLocaleLowerCase().indexOf(value.toLocaleLowerCase());
    const end = start >= 0 ? start + value.length : -1;
    const hasFootage = start >= 0 && (footageRanges.some(range =>
      end > range.start && start < range.end) || userRanges.some(range =>
      end > range.start && start < range.end));
    const alreadyBlue = hasFootage
      || fragment.classList.contains('storyboard-act-board-narration-span-depictable');
    fragment.classList.toggle('storyboard-act-board-narration-phrase-selected',
      !alreadyBlue && start >= 0 && ranges.some(range => end > range.start && start < range.end));
    fragment.classList.toggle('storyboard-act-board-narration-phrase-has-footage',
      hasFootage && !fragment.classList.contains('storyboard-act-board-narration-span-depictable'));
  });
  // User-added highlights are represented by individual word spans when they
  // do not exactly match a classifier phrase. Mark only the first covered word
  // so the HIGHLIGHT label appears once per selected phrase, rather than once
  // per word.
  root.querySelectorAll('.storyboard-act-board-narration-highlight-label-anchor')
    .forEach(word => word.classList.remove('storyboard-act-board-narration-highlight-label-anchor'));
  const labelRanges = [...footageRanges, ...userRanges, ...ranges];
  if (labelRanges.length) {
    const words = Array.from(root.querySelectorAll('[data-narration-source-start]'));
    labelRanges.forEach(range => {
      const firstWord = words.find(word => {
        const start = Number(word.dataset.narrationSourceStart);
        const end = Number(word.dataset.narrationSourceEnd);
        return end > range.start && start < range.end;
      });
      if (firstWord && !firstWord.closest('[data-narration-fragment]')) {
        firstWord.classList.add('storyboard-act-board-narration-highlight-label-anchor');
      }
    });
  }
  const removableRanges = [...footageRanges, ...userRanges, ...ranges]
    .filter((range, index, all) => all.findIndex(item =>
      item.start === range.start && item.end === range.end) === index);
  if (onPhraseRemove && removableRanges.length) {
    const words = Array.from(root.querySelectorAll('[data-narration-source-start]'));
    const appended = new Set();
    removableRanges.forEach(range => {
      const covered = words.filter(word => {
        const start = Number(word.dataset.narrationSourceStart);
        const end = Number(word.dataset.narrationSourceEnd);
        return end > range.start && start < range.end;
      });
      const anchor = covered[covered.length - 1];
      if (!anchor) return;
      // Classifier-created spans already carry their own remove affordance for
      // the exact same range. A user-added range may be nested inside or
      // overlap that span, however, and still needs its own delete control.
      const parentSpan = anchor.closest('.storyboard-act-board-narration-span');
      const parentStart = Number(parentSpan?.dataset.narrationFragmentStart);
      const parentEnd = Number(parentSpan?.dataset.narrationFragmentEnd);
      const hasExactRemove = parentSpan?.querySelector('.storyboard-act-board-narration-span-remove')
        && Number.isFinite(parentStart) && Number.isFinite(parentEnd)
        && parentStart === range.start && parentEnd === range.end;
      if (hasExactRemove) return;
      const key = `${range.start}:${range.end}`;
      if (appended.has(key)) return;
      appended.add(key);
      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'storyboard-act-board-narration-span-remove storyboard-act-board-narration-user-highlight-remove';
      removeButton.textContent = '×';
      const phrase = source.slice(Math.max(0, range.start), Math.max(0, range.end));
      removeButton.title = 'Remove this user-added highlighted phrase';
      removeButton.setAttribute('aria-label', `Remove highlighted phrase: ${phrase}`);
      removeButton.addEventListener('pointerdown', event => {
        event.preventDefault();
        event.stopPropagation();
      });
      removeButton.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        window.getSelection?.()?.removeAllRanges?.();
        onPhraseRemove({ text: phrase, start: range.start, end: range.end }, phrase);
      });
      anchor.appendChild(removeButton);
    });
  }
}

// Take one entity's wrapper out of the rendered transcript, leaving its words
// behind as ordinary selectable word spans.
//
// applyActBoardNarrationPhraseSelection only toggles classes and rebuilds the
// small delete affordances - it never removes a classifier span element. So an
// in-place delete cleared the data while the blue highlight stayed on screen,
// which is the "old and new highlighting at once" the mode split was meant to
// end. Unwrapping here keeps the fast path visually honest.
function unwrapActBoardNarrationSpanInDom(narrationNode, textKey) {
  if (!narrationNode?.id || !textKey) return 0;
  // Suggested drafts are excluded everywhere highlight roots are collected:
  // they are not the spoken track, so nothing should highlight in them.
  const roots = Array.from(document.querySelectorAll(
    '[data-act-board-narration-node-id]:not([data-act-board-narration-suggested])'))
    .filter(root => root.dataset.actBoardNarrationNodeId === String(narrationNode.id));
  let unwrapped = 0;
  roots.forEach(root => {
    Array.from(root.querySelectorAll('[data-narration-fragment]')).forEach(span => {
      if (actBoardNarrationSpanTextKey(span.dataset.narrationFragment || '') !== textKey) return;
      // The controls belong to the entity, not to the words underneath it.
      span.querySelectorAll(
        '.storyboard-act-board-narration-span-remove',
      ).forEach(control => control.remove());
      const parent = span.parentNode;
      if (!parent) return;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      span.remove();
      unwrapped += 1;
    });
  });
  return unwrapped;
}

function refreshActBoardNarrationHighlightDom(narrationNode) {
  if (!narrationNode?.id) return false;
  const roots = Array.from(document.querySelectorAll(
    '[data-act-board-narration-node-id]:not([data-act-board-narration-suggested])'))
    .filter(root => root.dataset.actBoardNarrationNodeId === String(narrationNode.id));
  if (!roots.length) return false;
  roots.forEach(root => {
    // Rebuild only the lightweight user-removal affordances. Without this,
    // every additional phrase click would append another × control to the
    // same word anchor while the full board remains mounted.
    root.querySelectorAll('.storyboard-act-board-narration-user-highlight-remove')
      .forEach(button => button.remove());
    applyActBoardNarrationPhraseSelection(
      root,
      narrationNode,
      (metadata, renderedText) => removeActBoardNarrationHighlight(
        narrationNode, metadata, renderedText),
    );
  });
  const card = document.querySelector(
    `.storyboard-act-board-node[data-node-id="${String(narrationNode.id).replace(/"/g, '\\"')}"]`,
  );
  if (card) {
    const source = actBoardNarrationSourceText(narrationNode);
    const fragments = Array.isArray(narrationNode.footageFragments)
      ? narrationNode.footageFragments : [];
    const visualizeButton = card.querySelector('.storyboard-act-board-suggest-footage-btn');
    if (visualizeButton) {
      visualizeButton.disabled = narrationNode.status !== 'ready'
        || !(fragments.length || source.trim() || narrationNode.selectedFootagePhrases?.length);
    }
  }
  return true;
}


// Make a rendered transcript directly editable in place.
//
// Single click just places a caret - editing the words is the common case, and
// it should not require finding a separate control. Marking entities moved to
// double click (see the dblclick handler in buildActBoardSuggestedNarrationText)
// so the two gestures never fight.
//
// Typing destroys the word/highlight span structure this element is built from,
// which is fine: the commit takes the element's plain text and the board
// re-renders the spans from the corrected string.
function enableActBoardInlineTranscriptEditing(element, actKey, node) {
  if (!element || !node?.transcript) return element;
  element.contentEditable = actBoardNarrationSlideEditing() ? 'true' : 'false';
  element.spellcheck = true;
  element.dataset.actBoardTranscriptEditable = 'true';
  element.dataset.narrationMode = actBoardNarrationSlideEditing() ? 'edit' : 'highlight';
  element.title = 'Click to correct the transcript · double-click a word to mark it as an entity';

  let original = String(node.transcript || '');
  let committing = false;

  // textContent concatenates EVERY descendant, and a highlight's delete control
  // is a CHILD of the highlight span. Reading it raw bakes that button's "x"
  // glyph into the transcript as a real character, which then outlives the
  // entity it came from and cannot be deleted by removing the highlight.
  // Strip the injected controls from a clone before reading the words.
  const readText = () => {
    const clone = element.cloneNode(true);
    clone.querySelectorAll(
      '.storyboard-act-board-narration-span-remove',
    ).forEach(control => control.remove());
    return clone.textContent.replace(/\s+/g, ' ').trim();
  };

  const commit = () => {
    if (committing) return;
    const next = readText();
    if (!next || next === original.replace(/\s+/g, ' ').trim()) return;
    committing = true;
    // A correction is a correction, not a request for new highlights. The
    // existing phrases are re-anchored to where their wording now sits (and
    // dropped if the wording is gone); nothing is analysed, so no filmable
    // phrases appear that the presenter did not ask for. Visualize highlights
    // remains the one explicit trigger for the classifier. Previously an edit
    // with no highlights yet re-analysed automatically, which painted
    // suggestions into the transcript the moment Enter was pressed.
    if (commitActBoardTranscriptEdit(node, next, false)) {
      original = next;
      rerenderActBoard({ preservePlayback: true });
    }
    committing = false;
  };

  element.addEventListener('focus', () => { original = String(node.transcript || ''); });
  element.addEventListener('blur', commit);
  element.addEventListener('keydown', event => {
    // Typing must not reach the board, which reads keys as shortcuts.
    event.stopPropagation();
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      element.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      element.textContent = original;
      committing = true;
      element.blur();
      committing = false;
      rerenderActBoard({ preservePlayback: true });
    }
  });
  // A caret drag inside the text is not a node drag.
  element.addEventListener('pointerdown', event => event.stopPropagation());
  return element;
}

// Commit a corrected transcript. Transcription is imperfect - a misheard word
// makes its phrase unmatchable, which then costs the presenter the filmable
// highlight and Smart arrange's word-level alignment for that phrase.
//
// Footage is always kept: losing a clip the presenter chose because they fixed
// a typo would be far worse than a stale phrase label. The highlights are a
// different matter - their character offsets point into the OLD string and are
// meaningless against the new one - so the caller decides whether to re-analyze
// (see the confirm in the editor below) rather than this silently discarding
// work or silently keeping something broken.
function commitActBoardTranscriptEdit(narrationNode, nextTranscript, reanalyze) {
  if (!narrationNode) return false;
  const next = String(nextTranscript || '').trim();
  const previous = String(narrationNode.transcript || '').trim();
  if (!next || next === previous) return false;
  narrationNode.transcript = next;
  narrationNode.transcriptEditedByUser = true;
  if (reanalyze) {
    narrationNode.narrationSpanHash = '';
    narrationNode.narrationCandidateSpans = [];
    narrationNode.narrationSpans = [];
    narrationNode.narrationSpanStatus = 'stale';
    // Clearing only the classifier spans was not enough. Visualize highlights
    // reads selectedFootagePhrases/userFilmablePhrases/footageSuggestedPhrases,
    // and Smart arrange reads footageFragments - so a highlight the presenter
    // asked to re-derive survived in those lists and came back as generated
    // footage, or pulled its old shot onto the rail again.
    //
    // A phrase whose wording still exists in the corrected transcript is kept
    // and re-anchored: re-analysis is meant to refresh the highlights, not to
    // silently discard a phrase the presenter chose and only moved. One whose
    // wording is gone is dropped, because it no longer describes anything the
    // narration says.
    const survives = next.toLocaleLowerCase();
    ['selectedFootagePhrases', 'footageSuggestedPhrases', 'userFilmablePhrases']
      .forEach(field => {
        if (!Array.isArray(narrationNode[field])) return;
        narrationNode[field] = narrationNode[field].map(item => {
          const text = String(item?.text || item?.fragment || item || '').trim();
          if (!text) return null;
          const index = survives.indexOf(text.toLocaleLowerCase());
          if (index < 0) return null;
          return typeof item === 'string'
            ? item : { ...item, start: index, end: index + text.length };
        }).filter(Boolean);
      });
    // footageFragments names the shots on the rail. Dropping a fragment whose
    // wording is gone is what stops Smart arrange resurrecting its shot; the
    // footage NODE itself is left alone, as the re-analysis prompt promises.
    if (Array.isArray(narrationNode.footageFragments)) {
      narrationNode.footageFragments = narrationNode.footageFragments.filter(item =>
        survives.includes(String(item?.text || item?.fragment || item || '')
          .trim().toLocaleLowerCase()));
    }
    if (Array.isArray(narrationNode.fragmentTimings)) {
      narrationNode.fragmentTimings = narrationNode.fragmentTimings.filter(item =>
        survives.includes(String(item?.text || item?.fragment || item || '')
          .trim().toLocaleLowerCase()));
    }
  } else {
    // Declining means "leave my highlights alone", and that takes more than
    // not clearing them: the board re-runs analysis whenever a transcript's
    // hash stops matching its spans, which would clear them moments later.
    // Adopt the new hash so that automatic pass sees nothing to do.
    narrationNode.narrationSpanHash = actBoardNarrationTextHash(next);
    narrationNode.narrationSpanStatus = 'ready';
    // Every kept phrase still carries offsets into the OLD text. Editing a word
    // earlier in the transcript shifts all of them, and the several matchers
    // then disagree: the highlight stops being painted while the phrase's
    // delete control is still rendered, leaving a stray "x" that nothing can
    // remove. Re-anchor each phrase to where its text now sits, and drop the
    // ones whose wording no longer exists.
    const lower = next.toLocaleLowerCase();
    ['narrationSpans', 'narrationCandidateSpans', 'selectedFootagePhrases',
      'footageSuggestedPhrases', 'userFilmablePhrases'].forEach(field => {
      if (!Array.isArray(narrationNode[field])) return;
      let searchFrom = 0;
      narrationNode[field] = narrationNode[field].map(item => {
        const text = String(item?.text || item?.fragment || '').trim();
        if (!text) return null;
        let index = lower.indexOf(text.toLocaleLowerCase(), searchFrom);
        // A phrase can legitimately sit before the edit point; fall back to a
        // search from the start before giving up on it.
        if (index < 0) index = lower.indexOf(text.toLocaleLowerCase());
        if (index < 0) return null;
        searchFrom = index + text.length;
        return { ...item, start: index, end: index + text.length };
      }).filter(Boolean);
    });
  }
  // Whisper's word timings belong to the audio, not to the edited text, and
  // the aligner matches them to the transcript BY POSITION - so a correction
  // that changes the word count would shift every timestamp. Re-align against
  // the corrected wording; alignActBoardNarrationFragments falls back to a
  // proportional estimate for anything it can no longer match exactly.
  alignActBoardNarrationFragments(narrationNode);
  saveDebugSession();
  return true;
}

function handleActBoardNarrationSpanSelect(narrationNode, metadata, renderedText, appendSelection = false) {
  if (!narrationNode || !String(narrationNode.transcript || '').trim()
    || !renderedText || !metadata || metadata.bucket === 'ignore') return;
  actBoardSelectedNodeId = narrationNode.id || '';
  actBoardSelectedNodeActKey = String(narrationNode.actKey || '');
  document.querySelector('.storyboard-act-board-full-playback-panel')
    ?.setAttribute('data-selected-node-id', actBoardSelectedNodeId);
  document.querySelector('.storyboard-act-board-full-playback-panel')
    ?.setAttribute('data-selected-act-key', actBoardSelectedNodeActKey);
  const source = String(narrationNode.transcript || narrationNode.text || '');
  const metadataStart = Number(metadata.start);
  const metadataEnd = Number(metadata.end);
  // Prefer the source text covered by the character offsets. A DOM selection
  // can omit whitespace between nested inline spans, which would turn a
  // multi-word phrase into a concatenated stock-footage query.
  const offsetPhrase = Number.isFinite(metadataStart) && metadataStart >= 0
    && Number.isFinite(metadataEnd) && metadataEnd > metadataStart
    ? source.slice(metadataStart, metadataEnd) : '';
  const phrase = normalizeActBoardFootagePhrase(
    offsetPhrase || renderedText || metadata.text,
  );
  if (!phrase) return;
  // Highlighting these words by hand overrides an earlier deletion of them.
  forgetActBoardNarrationExclusion(narrationNode, phrase);
  const fallbackStart = source.toLocaleLowerCase().indexOf(phrase.toLocaleLowerCase());
  const start = Number.isFinite(metadataStart) && metadataStart >= 0
    ? metadataStart : fallbackStart;
  const end = Number.isFinite(metadataEnd) && metadataEnd > start
    ? metadataEnd : start + phrase.length;
  const isManualSelection = metadata.kind === 'user_selection'
    || metadata.origin === 'manual';
  const query = isManualSelection ? '' : normalizeActBoardFootagePhrase(
    metadata.query || metadata.visual_proxy || phrase,
  );
  const nextSelection = {
    text: phrase,
    start: Math.max(0, start),
    end: Math.max(Math.max(0, start), end),
    query,
    bucket: isManualSelection ? 'pending' : (metadata.bucket || 'depictable'),
    visual_proxy: metadata.visual_proxy || '',
    kind: isManualSelection ? 'user_selection' : (metadata.kind || 'filmability_candidate'),
    origin: isManualSelection ? 'manual' : (metadata.origin || 'classifier'),
    filmabilityPending: isManualSelection,
  };
  const priorSelections = Array.isArray(narrationNode.selectedFootagePhrases)
    ? narrationNode.selectedFootagePhrases : [];
  const priorUserPhrases = Array.isArray(narrationNode.userFilmablePhrases)
    ? narrationNode.userFilmablePhrases : [];
  const priorSuggestedPhrases = Array.isArray(narrationNode.footageSuggestedPhrases)
    ? narrationNode.footageSuggestedPhrases : [];
  const matchesSelection = item => actBoardNarrationSpanTextKey(
    item?.text || item?.fragment,
  ) === actBoardNarrationSpanTextKey(nextSelection.text)
    && (!Number.isFinite(Number(item?.start))
      || !Number.isFinite(nextSelection.start)
      || Math.abs(Number(item.start) - nextSelection.start) < 1);
  const activePhrases = [...priorSelections, ...priorUserPhrases, ...priorSuggestedPhrases]
    .map(item => ({
      ...item,
      text: normalizeActBoardFootagePhrase(item?.text || item?.fragment),
    }))
    .filter(item => item.text)
    .filter((item, index, all) => all.findIndex(candidate =>
      actBoardNarrationSpanTextKey(candidate.text) === actBoardNarrationSpanTextKey(item.text)
        && Number(candidate.start) === Number(item.start)) === index);
  if (appendSelection) {
    const duplicate = activePhrases.findIndex(matchesSelection);
    const nextPhrases = duplicate >= 0
      ? activePhrases.filter((item, index) => index !== duplicate)
      : [...activePhrases, nextSelection];
    // Keep all three representations synchronized. This prevents a new
    // highlight made after footage already exists from replacing the prior
    // highlights in the transient list used by Visualize highlights.
    narrationNode.selectedFootagePhrases = nextPhrases;
    narrationNode.userFilmablePhrases = nextPhrases.slice();
    if (duplicate >= 0) {
      cancelActBoardManualFilmability(narrationNode, nextSelection);
      narrationNode.footageSuggestedPhrases = priorSuggestedPhrases
        .filter(item => !matchesSelection(item));
    }
  } else {
    priorSelections.forEach(item => cancelActBoardManualFilmability(narrationNode, item));
    priorUserPhrases.forEach(item => cancelActBoardManualFilmability(narrationNode, item));
    narrationNode.selectedFootagePhrases = [nextSelection];
    // A plain click intentionally replaces the user phrase selection. The
    // Plain clicks replace the temporary search selection, while the durable
    // user phrase list is managed by the click/drag handlers above.
    narrationNode.userFilmablePhrases = [nextSelection];
  }
  const count = narrationNode.selectedFootagePhrases.length;
  narrationNode.footageStatus = count
    ? `${count} phrase${count === 1 ? '' : 's'} selected. Press Suggest footage to add ${count === 1 ? 'it' : 'them'} to the linked sequence.`
    : 'Phrase selection cleared.';
  saveDebugSession();
  // Highlighting is a lightweight interaction. Update both the canvas-side
  // narration readout and the selected-node panel in place instead of
  // rebuilding every Act Board scene.
  if (!refreshActBoardNarrationHighlightDom(narrationNode)) rerenderActBoard();
  if (isManualSelection && narrationNode.selectedFootagePhrases.some(item =>
    actBoardManualFilmabilityRangeMatches(item, nextSelection))) {
    requestActBoardManualFilmability(narrationNode, nextSelection);
  }
}

function makeActBoardInlinePhraseEditor(element, original, onCommit) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = original;
  input.className = 'storyboard-act-board-node-fragment-editor';
  element.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = commit => {
    if (finished) return;
    finished = true;
    const value = input.value.trim();
    if (commit && value && value !== original) onCommit(value);
    else input.replaceWith(element);
  };
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true), { once: true });
}

function estimateActBoardNarrationSeconds(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(2, words / 2.5); // roughly 150 spoken words per minute
}

// Whisper normally returns a spaced transcript, but a few transcription
// responses (or older persisted sessions) can contain concatenated words even
// while still providing reliable word-level timestamps. Rebuild only those
// malformed cases from the timestamped words; otherwise preserve the original
// whitespace and line breaks exactly as returned.
function actBoardTranscriptionText(result) {
  // Whisper normally returns `words` at the top level, while some compatible
  // gateways nest them under each timed segment. Flatten both shapes before
  // deciding whether a malformed aggregate transcript needs reconstruction.
  const nestedWords = Array.isArray(result?.segments)
    ? result.segments.flatMap(segment => Array.isArray(segment?.words)
      ? segment.words : [])
    : [];
  const rawWords = Array.isArray(result?.words) && result.words.length
    ? result.words : nestedWords;
  const words = rawWords
    .map(item => String(item?.word || item?.text || '').trim()).filter(Boolean);
  let text = String(result?.text || '').trim();
  // A few Whisper-compatible gateways return timestamped words but omit the
  // top-level text field. Derive the display transcript from those words so
  // the narration never renders as an empty/concatenated string.
  if (!text && words.length) text = words.join(' ');
  if (words.length > 1) {
    const whitespaceCount = (text.match(/\s/g) || []).length;
    if (whitespaceCount < words.length - 1) return words.join(' ');
  }
  // Some Whisper-compatible proxies omit word-level timestamps but still
  // return multiple timed segments. If their concatenated text lost the
  // separators, rebuild it from those segment strings as a safe fallback.
  const segments = Array.isArray(result?.segments)
    ? result.segments.map(item => String(item?.text || '').trim()).filter(Boolean)
    : [];
  if (!text && segments.length) text = segments.join(' ');
  if (segments.length > 1) {
    const whitespaceCount = (text.match(/\s/g) || []).length;
    if (whitespaceCount < segments.length - 1) return segments.join(' ');
  }
  return text;
}

function normalizedBoardWords(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9']+/g) || [];
}

// Convert phrase timestamps into contiguous footage windows. The phrase start
// is the boundary where a later shot begins, while the first shot owns the
// pre-roll and the final shot owns the tail through the end of narration.
// `endIndex` (defaults to `index`) lets a caller ask for the window through a
// LATER row than the one it started at - see applyActBoardFootageAlignment's
// merge pass, which folds several short clause rows into one held shot.
function actBoardNarrationFootageWindow(timings, index, totalDuration, previousStart = 0, endIndex = index) {
  const timing = Array.isArray(timings) ? timings[index] : null;
  const requestedStart = index === 0
    ? 0 : Number(timing?.startSeconds);
  const start = Math.max(previousStart, Number.isFinite(requestedStart) ? requestedStart : previousStart);
  const nextTiming = Array.isArray(timings)
    ? timings.slice(endIndex + 1).find(item => Number.isFinite(Number(item?.startSeconds)))
    : null;
  const requestedEnd = nextTiming ? Number(nextTiming.startSeconds) : Number(totalDuration);
  const end = Math.max(start, Number.isFinite(requestedEnd) ? requestedEnd : start);
  return {
    startSeconds: start,
    durationSeconds: Math.max(0.5, end - start),
    endSeconds: end,
  };
}

// Greedy forward scan for a phrase in a list of timed words. Shared by the
// narration aligner and by Smart arrange so there is a single definition of
// "this phrase occurs here" rather than two that can drift apart.
function matchActBoardPhraseInTimedWords(timedWords, phrase, searchFrom = 0) {
  const phraseWords = normalizedBoardWords(phrase);
  if (!phraseWords.length || !Array.isArray(timedWords)) return null;
  for (let i = Math.max(0, searchFrom); i <= timedWords.length - phraseWords.length; i += 1) {
    if (phraseWords.every((word, offset) => timedWords[i + offset]?.word === word)) {
      return {
        index: i,
        length: phraseWords.length,
        startSeconds: timedWords[i].start,
        endSeconds: timedWords[i + phraseWords.length - 1].end,
        matchedText: timedWords.slice(i, i + phraseWords.length).map(item => item.word).join(' '),
      };
    }
  }
  return null;
}

// Build the timed-word table for one narration segment.
//
// Whisper's word list is matched to the transcript's words BY POSITION, so a
// tokenization mismatch would shift every timestamp without any visible error.
// Only trust the supplied timings when the two lists are the same length, and
// report which of the two happened so callers can say whether an arrangement is
// word-timed or merely estimated.
function actBoardTimedWordsFor(narrationNode) {
  const transcript = String(narrationNode?.transcript || '').trim();
  const duration = Math.max(0.5, Number(narrationNode?.audioDurationSeconds) > 0
    ? Number(narrationNode.audioDurationSeconds)
    : estimateActBoardNarrationSeconds(transcript || narrationNode?.text));
  if (!transcript) return { words: [], duration, timed: false };
  const transcriptWords = normalizedBoardWords(transcript);
  const supplied = Array.isArray(narrationNode.transcriptWords)
    ? narrationNode.transcriptWords.filter(word =>
      Number.isFinite(Number(word?.start)) && Number.isFinite(Number(word?.end)))
    : [];
  const timed = supplied.length > 0 && supplied.length === transcriptWords.length;
  const total = Math.max(transcriptWords.length, 1);
  const words = transcriptWords.map((word, index) => ({
    word,
    start: timed ? Number(supplied[index].start) : (index / total) * duration,
    end: timed ? Number(supplied[index].end) : ((index + 1) / total) * duration,
  }));
  return { words, duration, timed };
}

// Character offsets in the transcript right after the last word spoken before
// a real recorded silence (ACT_BOARD_PAUSE_MIN_SECONDS+ - see
// narrationNode.silences, backend/ingest/transcription.py's detect_silences).
// Deliberately NOT based on the gap between consecutive word timestamps:
// Whisper's per-word timing is an approximate internal alignment, not true
// forced-alignment, and was confirmed live to report a flat 0s gap between
// every word across a recording that had a genuine, audible 1-2s pause -
// silence detection runs directly on the audio waveform instead, independent
// of Whisper entirely. A word's own START time is still trusted to place it
// in the right neighborhood (only the INTER-word gap was unreliable).
// Returns [] whenever word timing is only estimated (actBoardTimedWordsFor's
// `timed: false`) or no silence was detected.
function actBoardPauseCharOffsets(narrationNode) {
  const { words: timedWords, timed } = actBoardTimedWordsFor(narrationNode);
  if (!timed || timedWords.length < 2) return [];
  const silences = (Array.isArray(narrationNode?.silences) ? narrationNode.silences : [])
    .filter(silence => Number(silence?.duration ?? (Number(silence?.end) - Number(silence?.start)))
      >= ACT_BOARD_PAUSE_MIN_SECONDS);
  if (!silences.length) return [];
  const transcript = String(narrationNode?.transcript || '');
  const wordPattern = /[A-Za-z0-9']+/g;
  const charRanges = [];
  let match;
  while ((match = wordPattern.exec(transcript))) {
    charRanges.push({ start: match.index, end: match.index + match[0].length });
  }
  // charRanges (this word pattern) and timedWords (normalizedBoardWords, same
  // character class only lower-cased) tokenize the same transcript the same
  // way, so they align by position - but never assume it, only trust it.
  if (charRanges.length !== timedWords.length) return [];
  const offsets = new Set();
  silences.forEach(silence => {
    const silenceStart = Number(silence.start);
    if (!Number.isFinite(silenceStart)) return;
    let lastIndex = -1;
    for (let i = 0; i < timedWords.length; i += 1) {
      if (Number(timedWords[i].start) <= silenceStart) lastIndex = i;
      else break;
    }
    if (lastIndex >= 0) offsets.add(charRanges[lastIndex].end);
  });
  return Array.from(offsets).sort((a, b) => a - b);
}

// Trims the same leading/trailing whitespace/punctuation backend/server.py's
// narration_clauses route strips via its own `add()`, so a pause-forced cut
// reads as clean text. Returns null for a piece that trims down to nothing
// usable (mirrors that route's length/alnum checks).
function trimActBoardClauseText(source, start, end) {
  const raw = source.slice(start, end);
  const leadingLen = (/^[\s,;:\-–—]*/.exec(raw) || [''])[0].length;
  const trailingLen = (/[\s,;:\-–—.!?]*$/.exec(raw) || [''])[0].length;
  const trimmedStart = start + leadingLen;
  const trimmedEnd = Math.max(trimmedStart, end - trailingLen);
  if (trimmedEnd <= trimmedStart) return null;
  const text = source.slice(trimmedStart, trimmedEnd);
  if (!/[a-z0-9]/i.test(text)) return null;
  return { start: trimmedStart, end: trimmedEnd, text };
}

// A presenter's own recorded pause is a stronger cue than punctuation, so this
// ADDS a cut inside an already backend-split clause wherever a real pause
// falls - never merges clauses back together, and never touches a non-clause
// span (phrase/entity/user_selection) kind. No minimum-words-per-side floor:
// narration is now suggested as one sentence per segment (see
// applyActBoardNarrationSuggestion), so a pause near either edge of a short
// segment is common and should still split rather than get silently dropped.
function splitActBoardClauseSpansAtPauses(spans, narrationNode) {
  if (!Array.isArray(spans) || !spans.length) return spans;
  const pauseOffsets = actBoardPauseCharOffsets(narrationNode);
  if (!pauseOffsets.length) return spans;
  const transcript = String(narrationNode?.transcript || '');
  const result = [];
  spans.forEach(span => {
    if (!span || span.kind !== 'clause') {
      result.push(span);
      return;
    }
    const pieces = [{ start: Number(span.start), end: Number(span.end) }];
    pauseOffsets.forEach(offset => {
      for (let i = 0; i < pieces.length; i += 1) {
        const piece = pieces[i];
        if (offset <= piece.start || offset >= piece.end) continue;
        pieces.splice(i, 1, { start: piece.start, end: offset }, { start: offset, end: piece.end });
        break;
      }
    });
    if (pieces.length === 1) {
      result.push(span);
      return;
    }
    pieces.forEach(piece => {
      const trimmed = trimActBoardClauseText(transcript, piece.start, piece.end);
      if (trimmed) result.push({ ...span, start: trimmed.start, end: trimmed.end, text: trimmed.text });
    });
  });
  return result;
}

// Map a character window in the transcript onto the word range it covers, so a
// span's saved offsets (or a match returned by the backend) can be read off the
// same timed-word table that exact matching uses. The index convention matches
// `appendActBoardNarrationWords`: words before the offset, counted the same way.
function actBoardWordRangeForCharRange(transcript, start, end) {
  const source = String(transcript || '');
  const from = Math.max(0, Math.min(source.length, Number(start)));
  const to = Math.max(from, Math.min(source.length, Number(end)));
  if (!(to > from)) return null;
  const index = normalizedBoardWords(source.slice(0, from)).length;
  const length = normalizedBoardWords(source.slice(from, to)).length;
  return length ? { index, length } : null;
}

// Real spoken duration of one classified span (clause/phrase), in seconds -
// used to size how many alternate footage nodes a clause needs (see
// suggestActBoardSelectedFootage) instead of a flat per-clause count: a short
// clause squeezed against several shots at the 5s floor stretched every one
// of them far past how long it is actually spoken. Returns null when real
// word timing isn't available (should not happen in practice - footage
// suggestion is transcript-only, i.e. always post-recording - but never
// trust that blindly).
function actBoardClauseSpokenSeconds(narrationNode, phrase) {
  const transcript = String(narrationNode?.transcript || '');
  const range = actBoardWordRangeForCharRange(transcript, phrase?.start, phrase?.end);
  if (!range) return null;
  const { words: timedWords, timed } = actBoardTimedWordsFor(narrationNode);
  if (!timed) return null;
  const first = timedWords[range.index];
  const last = timedWords[range.index + range.length - 1];
  if (!first || !last) return null;
  return Math.max(0, Number(last.end) - Number(first.start));
}

// Character offsets a narration already knows for its phrases. Footage nodes
// keep only a copy of the phrase text, so this is what recovers the position of
// that text in the transcript without re-deriving it.
function actBoardPhraseOffsetsFor(narrationNode) {
  const offsets = new Map();
  const add = item => {
    const text = String(item?.text || item?.fragment || '').trim();
    const start = Number(item?.start);
    const end = Number(item?.end);
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    const key = normalizedBoardWords(text).join(' ');
    if (key && !offsets.has(key)) offsets.set(key, { start, end });
  };
  (narrationNode?.narrationSpans || []).forEach(add);
  (narrationNode?.footageSuggestedPhrases || []).forEach(add);
  (narrationNode?.selectedFootagePhrases || []).forEach(add);
  (narrationNode?.userFilmablePhrases || []).forEach(add);
  return offsets;
}

// `resetPinned`: a shot the presenter or Smart arrange has placed is pinned
// (timingWasManuallyAdjusted). By default the aligner leaves pinned shots
// where they are and only times the rest - this runs from span analysis,
// transcript edits and the narration audio's own metadata event, none of
// which should silently undo a placement. A NEW recording is a new timeline,
// so that caller passes resetPinned to re-time everything.
function alignActBoardNarrationFragments(narrationNode, fragmentOverride = null, { resetPinned = false } = {}) {
  const transcript = (narrationNode.transcript || '').trim();
  const hasOverride = Array.isArray(fragmentOverride);
  const fragments = hasOverride
    ? fragmentOverride.map(fragment => String(fragment || '').trim()).filter(Boolean)
    : (narrationNode.footageFragments || actBoardNarrationFragments(narrationNode.text));
  if (!transcript) return;
  // A completed filmability pass can legitimately find no filmable phrases.
  // Clear stale rows from the prior transcript in that case.
  if (!fragments.length) {
    if (hasOverride) narrationNode.fragmentTimings = [];
    return;
  }
  const duration = Number(narrationNode.audioDurationSeconds) > 0
    ? Number(narrationNode.audioDurationSeconds)
    : estimateActBoardNarrationSeconds(transcript);
  const transcriptWords = normalizedBoardWords(transcript);
  const suppliedWords = Array.isArray(narrationNode.transcriptWords)
    ? narrationNode.transcriptWords.filter(word => Number.isFinite(Number(word.start)) && Number.isFinite(Number(word.end)))
    : [];
  const timedWords = transcriptWords.map((word, index) => {
    const supplied = suppliedWords[index];
    return {
      word,
      start: supplied ? Number(supplied.start) : (index / Math.max(transcriptWords.length, 1)) * duration,
      end: supplied ? Number(supplied.end) : ((index + 1) / Math.max(transcriptWords.length, 1)) * duration,
    };
  });
  let searchFrom = 0;
  const timings = fragments.map(fragment => {
    const hit = matchActBoardPhraseInTimedWords(timedWords, fragment, searchFrom);
    if (!hit) return null;
    searchFrom = hit.index + hit.length;
    return {
      fragment,
      startSeconds: hit.startSeconds,
      endSeconds: hit.endSeconds,
      matchedText: hit.matchedText,
    };
  });
  const fallbackWords = Math.max(1, fragments.reduce((sum, fragment) =>
    sum + normalizedBoardWords(fragment).length, 0));
  let fallbackCursor = 0;
  narrationNode.fragmentTimings = timings.map((timing, index) => {
    if (timing) {
      fallbackCursor = Math.max(fallbackCursor, timing.endSeconds);
      return timing;
    }
    const seconds = duration * normalizedBoardWords(fragments[index]).length / fallbackWords;
    const result = {
      fragment: fragments[index],
      startSeconds: fallbackCursor,
      endSeconds: Math.min(duration, fallbackCursor + seconds),
      matchedText: '',
    };
    fallbackCursor = result.endSeconds;
    return result;
  });
  narrationNode.alignmentSource = suppliedWords.length ? 'transcription timestamps' : 'estimated from transcript duration';
  narrationNode.audioDurationSeconds = duration;
  narrationNode.narrationAudioDurationSeconds = duration;
  narrationNode.narrationSegmentDurationSeconds = duration;
  const nodes = actBoardNodesForAct(narrationNode.actKey);
  const byFragment = new Map(narrationNode.fragmentTimings.map(timing => [timing.fragment, timing]));
  const linked = (narrationNode.footageNodeIds || [])
    .map(id => nodes.find(node => node.id === id)).filter(Boolean);
  let previousStart = 0;
  linked.forEach((node, index) => {
    // Keep the narration list's order stable even when a rerecord no longer
    // contains an older footage phrase.  The sequence index is also what the
    // playback rail uses as its deterministic tie-breaker.
    node.sequenceIndex = index;
    // An alternate parked off the rail has no timing to keep honest; leave it
    // where it is until the presenter drops it on.
    if (!actBoardTrackNodeVisible(node)) return;
    if (node.timingWasManuallyAdjusted && !resetPinned) {
      // Placed by the presenter or by Smart arrange. This aligner used to
      // overwrite it regardless and then clear the pin, so a narration audio
      // element's loadedmetadata event ~150ms after an arrange silently threw
      // the arrangement away. Keep it, and keep later shots from being timed
      // on top of it.
      previousStart = Math.max(previousStart,
        (Number(node.startSeconds) || 0) + Math.max(0.5, Number(node.durationSeconds) || 0.5));
      return;
    }
    const timing = byFragment.get(node.fragment);
    if (!timing) {
      // A prior footage card can legitimately outlive the transcript that
      // created it.  Leave its manually chosen source window and direct
      // footage links intact instead of reassigning it to a new phrase's
      // timing window.
      return;
    }
    const timingIndex = narrationNode.fragmentTimings.findIndex(item => item === timing);
    const window = actBoardNarrationFootageWindow(
      narrationNode.fragmentTimings,
      timingIndex >= 0 ? timingIndex : index,
      duration,
      previousStart,
    );
    // Several shots can share one fragment (a clause's 2-3 shots). Lay them
    // consecutively across the fragment's window instead of stacking them on
    // its start and shoving the later ones into the next fragment.
    const siblings = linked.filter(item => actBoardTrackNodeVisible(item)
      && item.fragment === node.fragment);
    const position = Math.max(0, siblings.indexOf(node));
    // Siblings are interspersed through the fragment's own spoken span, a
    // single shot holds to the next fragment as before.
    const spokenEnd = Number(timing.endSeconds);
    const endsWithSpokenSpan = siblings.length > 1 || node.footageBeatKind === 'clause';
    const windowSeconds = endsWithSpokenSpan && Number.isFinite(spokenEnd) && spokenEnd > window.startSeconds
      ? Math.min(window.durationSeconds, spokenEnd - window.startSeconds)
      : window.durationSeconds;
    const share = Math.max(0.5, windowSeconds / Math.max(1, siblings.length));
    // The phrase window says how long the shot could hold; the clip says how
    // long it actually has. The last phrase's window runs to the end of the
    // narration, which for a short generated clip meant looping it for the
    // rest of the recording. Leave a gap instead.
    const length = Math.min(share, actBoardFootageMaxDurationSeconds(node));
    node.startSeconds = Number((window.startSeconds + position * share).toFixed(2));
    node.durationSeconds = Number(Math.max(0.5, length).toFixed(2));
    node.durationWasSuggested = false;
    node.alignedToNarration = true;
    node.timingWasManuallyAdjusted = false;
    previousStart = Math.max(previousStart, node.startSeconds + node.durationSeconds);
  });
  narrationNode.durationSeconds = duration;
}

