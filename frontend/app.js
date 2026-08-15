/**
 * Forge frontend — a single-page chat UI.
 *
 * State model:
 *   - The Worker holds NO state.
 *   - On load / on session switch, we hit the GitHub REST API directly to
 *     read sessions/<id>/status.json + log.md and reconstruct history.
 *   - While a task is running we ADDITIONALLY subscribe to the Worker's
 *     SSE stream at /stream/:session_id for live step-by-step updates.
 *   - Settings (Worker URL, PATs, sessions repo, default target repo) live
 *     in localStorage only — this is a single-user beta.
 */

const LS_KEYS = {
  workerUrl: "forge.workerUrl",
  userPat:   "forge.userPat",
  targetPat: "forge.targetPat",
  targetRepo:"forge.targetRepo",
  sessionsRepo:"forge.sessionsRepo",
  lastSession: "forge.lastSession",
  model: "forge.model",
};

const state = {
  workerUrl: localStorage.getItem(LS_KEYS.workerUrl) || "",
  userPat:   localStorage.getItem(LS_KEYS.userPat) || "",
  targetPat: localStorage.getItem(LS_KEYS.targetPat) || "",
  targetRepo:localStorage.getItem(LS_KEYS.targetRepo) || "",
  sessionsRepo: localStorage.getItem(LS_KEYS.sessionsRepo) || "",
  model: localStorage.getItem(LS_KEYS.model) || "claude-sonnet-5",
  sessionId: null,
  sse: null,
  pendingFiles: [], // {name, content_base64}
};

// ---------- DOM refs -----------------------------------------------------
const $ = (id) => document.getElementById(id);
const els = {
  streamBox:  $("stream"),
  sessionList:$("session-list"),
  sessionTitle:$("session-title"),
  sessionIdBox:$("session-id"),
  modelSelect:$("model-select"),
  statusInd:  $("status-indicator"),
  outboxPanel:$("outbox-panel"),
  outboxList: $("outbox-list"),
  promptBox:  $("prompt"),
  sendBtn:    $("send-btn"),
  newSession: $("new-session-btn"),
  refreshBtn: $("refresh-sessions"),
  fileInput:  $("file-input"),
  filePick:   $("file-pick"),
  uploadDrop: $("upload-drop"),
  pendingList:$("pending-files"),
  settingsBtn:$("settings-btn"),
  sidebar:    $("sidebar"),
  sidebarOpen:$("sidebar-open"),
  sidebarClose:$("sidebar-close"),
  sidebarBackdrop:$("sidebar-backdrop"),
  modal:      $("settings-modal"),
  cfgWorker:  $("cfg-worker-url"),
  cfgRepo:    $("cfg-sessions-repo"),
  cfgUserPat: $("cfg-user-pat"),
  cfgTargetPat:$("cfg-target-pat"),
  cfgTargetRepo:$("cfg-target-repo"),
  saveSettings:$("settings-save"),
  cancelSettings:$("settings-cancel"),
};

// ---------- Utility ------------------------------------------------------
function nowIso() { return new Date().toISOString(); }
function shortId() {
  // Prefer crypto.randomUUID when available, else fallback.
  const raw = (crypto && crypto.randomUUID) ? crypto.randomUUID().replace(/-/g, "") : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return raw.slice(0, 10);
}
function setUrlSession(sid) {
  const u = new URL(window.location.href);
  if (sid) u.searchParams.set("s", sid); else u.searchParams.delete("s");
  window.history.replaceState({}, "", u.toString());
}
function getUrlSession() {
  const u = new URL(window.location.href);
  return u.searchParams.get("s");
}

function b64Encode(buf) {
  // buf: ArrayBuffer
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function ghHeaders() {
  return {
    "Authorization": `Bearer ${state.userPat}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function ghGet(path) {
  const url = path.startsWith("http") ? path : `https://api.github.com${path}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
  return res.json();
}

async function ghGetRaw(path) {
  // Returns text or null on 404
  const url = path.startsWith("http") ? path : `https://api.github.com${path}`;
  const res = await fetch(url, { headers: { ...ghHeaders(), "Accept": "application/vnd.github.raw" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
  return res.text();
}

// ---------- Rendering ----------------------------------------------------
function iconFor(evt) {
  const t = evt.type;
  if (t === "user")        return "🧑";
  if (t === "status")      return evt.status === "error" ? "⛔" : evt.status === "done" ? "✅" : "⚙";
  if (t === "tool_call") {
    const tool = evt.tool || "";
    if (tool === "run_python") return "🐍";
    if (tool === "run_shell")  return "💻";
    if (tool === "read_file")  return "📖";
    if (tool === "write_file") return "📝";
    if (tool === "edit_file")  return "✏️";
    if (tool === "git_commit_push") return "📦";
    if (tool === "browser_action")  return "🌐";
    if (tool === "upload_output_file") return "📤";
    if (tool === "finish")     return "🏁";
    return "🔧";
  }
  if (t === "tool_result") return evt.ok ? "↩" : "⚠";
  if (t === "final")       return "🎯";
  if (t === "hello")       return "•";
  return "•";
}

function titleFor(evt) {
  if (evt.type === "user")        return "You";
  if (evt.type === "status")      return `Status: ${evt.status || "update"}`;
  if (evt.type === "tool_call")   return `Tool → ${evt.tool}`;
  if (evt.type === "tool_result") return `Result ← ${evt.tool} (${evt.ok ? "ok" : "error"})`;
  if (evt.type === "final")       return "Final answer";
  if (evt.type === "hello")       return "Connected";
  return evt.type || "event";
}

function detailFor(evt) {
  if (evt.type === "user")     return evt.message || evt.content || "";
  if (evt.type === "status")   return evt.message || "";
  if (evt.type === "final")    return evt.message || "";
  if (evt.type === "tool_call") return evt.args_preview ? "```\n" + evt.args_preview + "\n```" : "";
  if (evt.type === "tool_result") return evt.preview ? "```\n" + evt.preview + "\n```" : "";
  return evt.message || "";
}

function renderEvent(evt) {
  const li = document.createElement("div");
  li.className = "event " + (evt.type || "");
  if (evt.type === "tool_result" && !evt.ok) li.classList.add("err");
  const icon = document.createElement("div"); icon.className = "icon"; icon.textContent = iconFor(evt);
  const body = document.createElement("div"); body.className = "body";
  const title = document.createElement("div"); title.className = "title"; title.textContent = titleFor(evt);
  const detail = document.createElement("div"); detail.className = "detail";
  const raw = detailFor(evt);
  if (raw && raw.startsWith("```")) {
    const pre = document.createElement("pre");
    pre.textContent = raw.replace(/^```\n?/, "").replace(/```$/, "");
    detail.appendChild(pre);
  } else {
    detail.textContent = raw;
  }
  const ts = document.createElement("div"); ts.className = "ts";
  ts.textContent = (evt.ts || nowIso()).replace("T", " ").replace(/\..*/, "") + "Z";
  body.appendChild(title); body.appendChild(detail); body.appendChild(ts);
  li.appendChild(icon); li.appendChild(body);
  els.streamBox.appendChild(li);
  els.streamBox.scrollTop = els.streamBox.scrollHeight;
}

function setStatus(s) {
  els.statusInd.classList.remove("idle", "running", "done", "error");
  els.statusInd.classList.add(s);
  els.statusInd.textContent = s;
}

function clearStream() { els.streamBox.innerHTML = ""; }

// ---------- Sessions list ------------------------------------------------
async function loadSessionsList() {
  els.sessionList.innerHTML = "";
  if (!state.sessionsRepo || !state.userPat) return;
  try {
    // List sessions/ folder contents.
    const items = await ghGet(`/repos/${state.sessionsRepo}/contents/sessions`);
    const dirs = Array.isArray(items) ? items.filter(x => x.type === "dir") : [];
    // Sort newest first — GitHub doesn't give us mtimes here; fall back to name (our ids include timestamp bits).
    dirs.sort((a, b) => b.name.localeCompare(a.name));
    for (const d of dirs) {
      const li = document.createElement("li");
      li.dataset.sessionId = d.name;
      const name = document.createElement("span"); name.className = "session-name"; name.textContent = d.name;
      const del = document.createElement("button"); del.className = "del-btn"; del.title = "Delete"; del.textContent = "×";
      del.onclick = async (e) => { e.stopPropagation(); await deleteSession(d.name); };
      li.appendChild(name);
      li.appendChild(del);
      li.onclick = () => { openSession(d.name); closeSidebar(); };
      if (state.sessionId === d.name) li.classList.add("active");
      els.sessionList.appendChild(li);
    }
  } catch (err) {
    console.warn("[forge] loadSessionsList failed:", err);
  }
}

async function deleteSession(sid) {
  if (!confirm(`Delete session ${sid}? This removes its folder from the sessions repo in one commit.`)) return;
  try {
    const res = await fetch(`${state.workerUrl}/delete-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${state.userPat}` },
      body: JSON.stringify({ session_id: sid }),
    });
    if (!res.ok) throw new Error(await res.text());
    if (state.sessionId === sid) {
      state.sessionId = null;
      setUrlSession(null);
      clearStream();
      els.sessionTitle.textContent = "No session";
      els.sessionIdBox.textContent = "";
    }
    await loadSessionsList();
  } catch (err) {
    alert("Delete failed: " + err.message);
  }
}

// ---------- Open session -------------------------------------------------
async function openSession(sid) {
  state.sessionId = sid;
  setUrlSession(sid);
  els.sessionTitle.textContent = sid;
  els.sessionIdBox.textContent = sid;
  clearStream();
  localStorage.setItem(LS_KEYS.lastSession, sid);
  document.querySelectorAll("#session-list li").forEach(li => {
    li.classList.toggle("active", li.dataset.sessionId === sid);
  });

  // Reconstruct history from GitHub.
  await reconstructFromGitHub(sid);
  await loadOutbox(sid);

  // Reset and (re)subscribe to SSE.
  if (state.sse) { try { state.sse.close(); } catch {} state.sse = null; }
  subscribeSse(sid);
}

async function reconstructFromGitHub(sid) {
  try {
    // status.json
    const statusText = await ghGetRaw(`/repos/${state.sessionsRepo}/contents/sessions/${sid}/status.json`);
    if (statusText) {
      try {
        const j = JSON.parse(statusText);
        if (j.task_prompt) renderEvent({ type: "user", message: j.task_prompt, ts: j.started_at });
        if (j.model) {
          els.modelSelect.value = j.model;
          state.model = j.model;
        }
        setStatus(j.status || "idle");
        if (j.final_message) renderEvent({ type: "final", message: j.final_message, ts: j.finished_at });
      } catch (e) {
        console.warn("[forge] status.json parse:", e);
      }
    } else {
      setStatus("idle");
    }
    // log.md — render as a single collapsed "history" event so the user has context.
    const logText = await ghGetRaw(`/repos/${state.sessionsRepo}/contents/sessions/${sid}/log.md`);
    if (logText) {
      const li = document.createElement("div");
      li.className = "event";
      const icon = document.createElement("div"); icon.className = "icon"; icon.textContent = "📜";
      const body = document.createElement("div"); body.className = "body";
      const title = document.createElement("div"); title.className = "title"; title.textContent = "Session log (from GitHub)";
      const pre = document.createElement("pre");
      pre.textContent = logText.length > 20000 ? logText.slice(-20000) + "\n... [truncated]" : logText;
      const detail = document.createElement("div"); detail.className = "detail"; detail.appendChild(pre);
      body.appendChild(title); body.appendChild(detail);
      li.appendChild(icon); li.appendChild(body);
      els.streamBox.appendChild(li);
      els.streamBox.scrollTop = els.streamBox.scrollHeight;
    }
  } catch (err) {
    renderEvent({ type: "status", status: "error", message: "Reconstruct from GitHub failed: " + err.message });
  }
}

async function loadOutbox(sid) {
  els.outboxList.innerHTML = "";
  els.outboxPanel.classList.add("hidden");
  try {
    const items = await ghGet(`/repos/${state.sessionsRepo}/contents/sessions/${sid}/outbox`).catch(() => []);
    const files = Array.isArray(items) ? items.filter(x => x.type === "file") : [];
    if (!files.length) return;
    els.outboxPanel.classList.remove("hidden");
    for (const f of files) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = f.download_url || f.html_url;
      a.textContent = `⤓ ${f.name}`;
      a.target = "_blank";
      a.rel = "noopener";
      li.appendChild(a);
      els.outboxList.appendChild(li);
    }
  } catch (err) {
    console.warn("[forge] loadOutbox failed:", err);
  }
}

// ---------- SSE subscription --------------------------------------------
function subscribeSse(sid) {
  if (!state.workerUrl) return;
  const url = `${state.workerUrl}/stream/${sid}`;
  const es = new EventSource(url);
  state.sse = es;
  es.onmessage = (msg) => {
    try {
      const evt = JSON.parse(msg.data);
      if (evt.type === "hello") return; // don't spam
      renderEvent(evt);
      if (evt.type === "status" && evt.status) setStatus(evt.status);
      if (evt.type === "status" && (evt.status === "done" || evt.status === "error")) {
        // Refresh outbox after completion.
        loadOutbox(sid).catch(() => {});
      }
    } catch (e) {
      console.warn("[forge] SSE parse failed:", e);
    }
  };
  es.onerror = () => {
    // EventSource will auto-reconnect. If it stays broken, the user can still
    // refresh and we'll re-read from GitHub.
    console.warn("[forge] SSE dropped, will retry");
  };
}

// ---------- New session + send ------------------------------------------
async function newSession() {
  const sid = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14) + "-" + shortId();
  state.sessionId = sid;
  setUrlSession(sid);
  els.sessionTitle.textContent = sid;
  els.sessionIdBox.textContent = sid;
  clearStream();
  setStatus("idle");
  els.outboxPanel.classList.add("hidden");
  els.outboxList.innerHTML = "";
  if (state.sse) { try { state.sse.close(); } catch {} state.sse = null; }
  subscribeSse(sid);
  await loadSessionsList();
}

async function sendTask() {
  if (!state.workerUrl || !state.userPat || !state.sessionsRepo) {
    alert("Open Settings first and fill in Worker URL, PAT, and sessions repo.");
    return;
  }
  if (!state.sessionId) await newSession();
  const prompt = els.promptBox.value.trim();
  if (!prompt) return;

  // 1) Upload any pending files first.
  for (const f of state.pendingFiles) {
    if (f.uploaded) continue;
    try {
      const res = await fetch(`${state.workerUrl}/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${state.userPat}` },
        body: JSON.stringify({
          session_id: state.sessionId,
          path: f.name,
          content_base64: f.content_base64,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      f.uploaded = true;
    } catch (err) {
      f.failed = true;
      renderEvent({ type: "status", status: "error", message: `Upload failed for ${f.name}: ${err.message}` });
    }
  }
  refreshPendingFilesUi();

  // 2) Render the user's message locally.
  renderEvent({ type: "user", message: prompt });
  setStatus("running");
  els.promptBox.value = "";

  // 3) Fire the task.
  try {
    const body = {
      session_id: state.sessionId,
      task_prompt: prompt,
      model: state.model,
    };
    // Include target repo config if configured, but send the target PAT via
    // a header so it stays out of the JSON body.
    if (state.targetRepo) body.target_repo = state.targetRepo;
    const res = await fetch(`${state.workerUrl}/task`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${state.userPat}`,
        ...(state.targetPat ? { "X-Forge-Target-Pat": state.targetPat } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
  } catch (err) {
    renderEvent({ type: "status", status: "error", message: "Task dispatch failed: " + err.message });
    setStatus("error");
  }

  // Clear pending files after send.
  state.pendingFiles = [];
  refreshPendingFilesUi();
  loadSessionsList();
}

// ---------- File attach --------------------------------------------------
function refreshPendingFilesUi() {
  els.pendingList.innerHTML = "";
  for (const f of state.pendingFiles) {
    const li = document.createElement("li");
    li.textContent = f.name;
    if (f.uploaded) li.classList.add("uploaded");
    if (f.failed) li.classList.add("failed");
    els.pendingList.appendChild(li);
  }
}

async function ingestFiles(fileList) {
  for (const file of fileList) {
    const buf = await file.arrayBuffer();
    state.pendingFiles.push({
      name: file.name,
      content_base64: b64Encode(buf),
    });
  }
  refreshPendingFilesUi();
}

// ---------- Settings modal ----------------------------------------------
// ---------- Mobile sidebar drawer -----------------------------------------
// Below the 860px CSS breakpoint #sidebar becomes a fixed off-canvas panel;
// these just toggle the `.open` class (and the backdrop) that the media
// query in styles.css keys off of. No-ops above the breakpoint since the
// sidebar is a normal grid column there and CSS ignores `.open`.
function openSidebar() {
  els.sidebar.classList.add("open");
  els.sidebarBackdrop.classList.remove("hidden");
}
function closeSidebar() {
  els.sidebar.classList.remove("open");
  els.sidebarBackdrop.classList.add("hidden");
}

function openSettings() {
  els.cfgWorker.value    = state.workerUrl;
  els.cfgRepo.value      = state.sessionsRepo;
  els.cfgUserPat.value   = state.userPat;
  els.cfgTargetPat.value = state.targetPat;
  els.cfgTargetRepo.value= state.targetRepo;
  els.modal.classList.remove("hidden");
}
function closeSettings() { els.modal.classList.add("hidden"); }
function saveSettings() {
  state.workerUrl    = els.cfgWorker.value.trim().replace(/\/$/, "");
  state.sessionsRepo = els.cfgRepo.value.trim();
  state.userPat      = els.cfgUserPat.value.trim();
  state.targetPat    = els.cfgTargetPat.value.trim();
  state.targetRepo   = els.cfgTargetRepo.value.trim();
  localStorage.setItem(LS_KEYS.workerUrl, state.workerUrl);
  localStorage.setItem(LS_KEYS.sessionsRepo, state.sessionsRepo);
  localStorage.setItem(LS_KEYS.userPat, state.userPat);
  localStorage.setItem(LS_KEYS.targetPat, state.targetPat);
  localStorage.setItem(LS_KEYS.targetRepo, state.targetRepo);
  closeSettings();
  loadSessionsList();
}

// ---------- Boot ---------------------------------------------------------
function wireEvents() {
  els.newSession.onclick = () => { newSession(); closeSidebar(); };
  els.refreshBtn.onclick = () => loadSessionsList();
  els.sendBtn.onclick = () => sendTask();
  els.promptBox.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendTask(); }
  });
  els.settingsBtn.onclick = openSettings;
  els.saveSettings.onclick = saveSettings;
  els.cancelSettings.onclick = closeSettings;
  els.modelSelect.value = state.model;
  els.modelSelect.onchange = () => {
    state.model = els.modelSelect.value;
    localStorage.setItem(LS_KEYS.model, state.model);
  };
  els.filePick.onclick = (e) => { e.preventDefault(); els.fileInput.click(); };
  els.fileInput.onchange = (e) => ingestFiles(e.target.files);
  ["dragenter","dragover"].forEach(evt => {
    els.uploadDrop.addEventListener(evt, e => { e.preventDefault(); els.uploadDrop.classList.add("dragover"); });
  });
  ["dragleave","drop"].forEach(evt => {
    els.uploadDrop.addEventListener(evt, e => { e.preventDefault(); els.uploadDrop.classList.remove("dragover"); });
  });
  els.uploadDrop.addEventListener("drop", (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) ingestFiles(e.dataTransfer.files);
  });

  els.sidebarOpen.onclick = openSidebar;
  els.sidebarClose.onclick = closeSidebar;
  els.sidebarBackdrop.onclick = closeSidebar;
}

async function boot() {
  wireEvents();
  // If settings aren't populated yet, nudge the user to open the modal.
  if (!state.workerUrl || !state.userPat || !state.sessionsRepo) {
    openSettings();
    return;
  }
  await loadSessionsList();
  const sidFromUrl = getUrlSession();
  const sidFromLs  = localStorage.getItem(LS_KEYS.lastSession);
  const sid = sidFromUrl || sidFromLs;
  if (sid) await openSession(sid);
}

boot();
