window.omniaVideoStudio = (() => {
  const media = [];
  const byId = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
  const humanBytes = n => !n ? "" : n >= 1048576 ? `${(n/1048576).toFixed(1)} MB` : `${Math.ceil(n/1024)} KB`;
  const humanDuration = n => n ? `${Number(n).toFixed(1)}s` : "";

  function isVideoProject() { return true; }
  function refreshVisibility() { byId("videoMediaBin")?.classList.toggle("hidden", !isVideoProject()); }

  function roleOptions(item) {
    const options = item.kind === "audio"
      ? [["auto","Auto"],["narration","Narration / voice-over"],["music","Background music"],["sfx","Sound effect"],["reference","Voice/reference"]]
      : [["auto","Auto"],["primary","Primary visual"],["broll","B-roll"],["reference","Reference only"],["overlay","Overlay"],["logo","Logo/brand asset"]];
    return options.map(([value,label]) => `<option value="${value}" ${item.media_role===value?"selected":""}>${label}</option>`).join("");
  }

  function renderMedia() {
    const list = byId("videoMediaList");
    if (!list) return;
    if (!media.length) {
      list.innerHTML = '<div class="media-empty">No client media added yet. Add images, video clips, music, SFX, or reference audio.</div>';
      return;
    }
    list.innerHTML = media.map((item, index) => {
      const icon = `<svg class="i"><use href="#i-${item.kind === "video" ? "video" : item.kind === "audio" ? "music" : "image"}"/></svg>`;
      const detail = [humanBytes(item.size_bytes), humanDuration(item.duration_seconds), item.width&&item.height?`${item.width}×${item.height}`:""].filter(Boolean).join(" · ");
      const polished = item.polish && item.polish.applied;
      const polishTitle = polished ? escapeHtml((item.polish.adjustments||[]).join(", ")) : "";
      return `<div class="media-bin-item media-asset-row">
        <b class="media-kind">${icon}</b>
        <div class="media-asset-copy"><strong>${escapeHtml(item.filename)}${polished?` <span class="media-polish-badge" title="Auto-enhanced: ${polishTitle}">✨ Enhanced</span>`:""}</strong><small>${escapeHtml(item.kind)}${detail?` · ${escapeHtml(detail)}`:""}</small></div>
        <label class="media-role-label"><span>Use as</span><select data-media-role="${index}">${roleOptions(item)}</select></label>
        <label class="media-note-label"><span>Where/what</span><input type="text" data-media-note="${index}" placeholder="e.g. use as intro, put at the end, beach sunset shot" maxlength="200" value="${escapeHtml(item.creator_note||"")}"></label>
        <button type="button" data-remove-video-media="${index}" aria-label="Remove ${escapeHtml(item.filename)}">×</button>
      </div>`;
    }).join("");
    list.querySelectorAll("[data-remove-video-media]").forEach(button => {
      button.onclick = () => { media.splice(Number(button.dataset.removeVideoMedia), 1); renderMedia(); };
    });
    list.querySelectorAll("[data-media-role]").forEach(select => {
      select.onchange = () => { media[Number(select.dataset.mediaRole)].media_role = select.value; };
    });
    list.querySelectorAll("[data-media-note]").forEach(input => {
      input.oninput = () => { media[Number(input.dataset.mediaNote)].creator_note = input.value; };
    });
  }

  async function uploadOne(file) {
    const form = new FormData(); form.append("document", file);
    const response = await window.omniaApiFetch("/api/files/media-upload", {method:"POST", body:form}, 600000);
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || `Upload failed: ${file.name}`);
    return {
      file_id:data.file_id, filename:data.filename, kind:data.media_type,
      media_role:data.media_role || "auto", size_bytes:data.size_bytes,
      duration_seconds:data.duration_seconds, width:data.width, height:data.height,
      mime_type:data.mime_type, checksum_sha256:data.checksum_sha256,
      polish:data.polish || {applied:false}
    };
  }

  async function addFiles(files) {
    const accepted = [...files].filter(file => file.type.startsWith("image/") || file.type.startsWith("video/") || file.type.startsWith("audio/"));
    const rejected = files.length - accepted.length;
    if (rejected) window.omniaNotify?.(`${rejected} unsupported file(s) skipped.`);
    for (const file of accepted) {
      try {
        window.omniaNotify?.(`Inspecting and uploading: ${file.name}…`);
        media.push(await uploadOne(file)); renderMedia();
      } catch (error) { window.omniaNotify?.(error.message); }
    }
    if (accepted.length) window.omniaNotify?.(`${accepted.length} media file(s) added to the OMNIA IQ Media Studio.`);
  }

  function getFileIds() { return media.map(item => item.file_id); }
  function getMediaItems() { return media.map(item => ({file_id:item.file_id, filename:item.filename, media_role:item.media_role || "auto", creator_note:item.creator_note || ""})); }
  function clear() { media.splice(0, media.length); renderMedia(); }

  function init() {
    byId("projectType")?.addEventListener("change", refreshVisibility);
    const input = byId("videoMediaUpload");
    input?.addEventListener("change", event => { addFiles(event.target.files); event.target.value = ""; });
    const bin = byId("videoMediaBin");
    bin?.addEventListener("dragover", event => { event.preventDefault(); bin.classList.add("is-dragging"); });
    bin?.addEventListener("dragleave", () => bin.classList.remove("is-dragging"));
    bin?.addEventListener("drop", event => { event.preventDefault(); bin.classList.remove("is-dragging"); addFiles(event.dataTransfer.files); });
    refreshVisibility(); renderMedia();
  }

  return {init, refreshVisibility, getFileIds, getMediaItems, clear};
})();
