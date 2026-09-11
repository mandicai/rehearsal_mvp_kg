//#region --- YOUR MEDIA (storyboard.html only)
// a running collection of
// supplementary reference audio/video the presenter records or uploads in
// #media-bank-module, separate from (in addition to) the one documentary-
// intent narration recorded on index.html. Each item just holds enough to
// play it back (a disk-served preview_url, same convention as footage/
// narration elsewhere in this file) - never re-fetched/decoded through the
// Web Audio API the way the intent narration is, since a plain <audio>/
// <video src> already handles arbitrary-length playback natively and none
// of this needs a waveform or proportional timing. Starts pre-populated
// with MEDIA_BANK_ASSET_DEFAULTS above rather than restored from a saved
// session (see restoreDebugSession, which doesn't touch this) - a
// deliberate reset ("for now"), not persisted per-session state.
let mediaBankItems = MEDIA_BANK_ASSET_DEFAULTS.slice();

function renderMediaBankItems() {
  if (!mediaBankListEl) return;
  mediaBankListEl.innerHTML = '';
  mediaBankItems.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'media-bank-item';

    const label = document.createElement('div');
    label.className = 'media-bank-item-label';
    label.textContent = item.label;

    // Audio items only - dragged onto a section's narration area (see
    // buildSectionBlock's drop handler) to use as that shot's narration.
    // The index (not the item itself) is what's carried across the drag,
    // since dataTransfer can only hold strings. draggable lives on the
    // label specifically, not the whole row (which also contains the
    // player below) - a draggable ancestor is a known way to break normal
    // clicks on native <audio>/<video> controls in some browsers (the
    // browser's drag-detection on mousedown can swallow the click meant
    // for the player instead), so this keeps the two areas separate.
    if (item.kind === 'audio') {
      row.classList.add('draggable');
      label.draggable = true;
      label.addEventListener('dragstart', event => {
        event.dataTransfer.setData('application/x-media-bank-index', String(index));
        event.dataTransfer.effectAllowed = 'copy';
      });
    }
    row.appendChild(label);

    const player = document.createElement(item.kind === 'video' ? 'video' : 'audio');
    player.controls = true;
    player.src = item.previewUrl;
    row.appendChild(player);

    mediaBankListEl.appendChild(row);
  });
}

// Uploads a freshly recorded/picked audio or video file, then adds it to
// the list once saved - project_id is shared with footage/narration
// uploads (see fetchUploadFootage/fetchUploadNarration), so everything for
// one documentary lands under the same premiere_exports/<project_id>/.
function addMediaBankItem(kind, label, file) {
  mediaBankStatusEl.textContent = `Uploading "${label}" ...`;
  mediaBankStatusEl.classList.remove('error');
  fetchUploadMediaBankItem(file, premiereProjectId)
    .then(({ project_id, preview_url, file_path }) => {
      premiereProjectId = project_id;
      mediaBankItems.push({ kind, label, previewUrl: preview_url, filePath: file_path || null });
      mediaBankStatusEl.textContent = '';
      renderMediaBankItems();
      saveDebugSession();
    })
    .catch(err => {
      mediaBankStatusEl.textContent = err.message;
      mediaBankStatusEl.classList.add('error');
    });
}

//#endregion

