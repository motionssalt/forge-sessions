/**
 * Forge Cloudflare Worker — thin relay only.
 *
 * This Worker holds ZERO durable state. Everything persistent lives in GitHub.
 * If this Worker restarts, the only thing that breaks is any in-flight SSE
 * stream — the frontend reconnects and reads current state directly from GitHub.
 *
 * Endpoints:
 *   POST /task                     Fire a new task via GitHub repository_dispatch.
 *   POST /progress                 Progress update from the GitHub Actions runner.
 *   GET  /stream/:session_id       SSE stream of live progress updates for a session.
 *   POST /upload                   Proxy a file upload into <session>/inbox/ on GitHub.
 *   POST /delete-session           Delete an entire session folder (one commit).
 *   GET  /health                   Health check.
 *
 * Auth model:
 *   - Frontend requests carry the USER's personal GitHub PAT in the
 *       Authorization: Bearer <pat>
 *     header. The Worker validates it lightly (non-empty, "ghp_" / "github_pat_"
 *     shape) and passes it through to the GitHub REST API for file operations.
 *   - The Worker uses its OWN separate PAT (FORGE_DISPATCH_PAT secret) to fire
 *     repository_dispatch — the user's PAT is not used for that call.
 *   - Progress POSTs from Actions authenticate with FORGE_CALLBACK_SECRET.
 *
 * SSE fan-out:
 *   We keep an in-memory Map<session_id, Set<WritableStreamDefaultWriter>>.
 *   This is fine because loss of subscribers on restart is not a data-loss event:
 *   the frontend just polls GitHub for state on reconnect.
 */

// -----------------------------------------------------------------------------
// In-memory subscriber registry. Keyed by session_id.
// Each subscriber is a { writer, encoder } pair.
// -----------------------------------------------------------------------------
const subscribers = new Map();

function addSubscriber(sessionId, entry) {
  if (!subscribers.has(sessionId)) subscribers.set(sessionId, new Set());
  subscribers.get(sessionId).add(entry);
}

function removeSubscriber(sessionId, entry) {
  const set = subscribers.get(sessionId);
  if (!set) return;
  set.delete(entry);
  if (set.size === 0) subscribers.delete(sessionId);
}

async function broadcast(sessionId, payload) {
  const set = subscribers.get(sessionId);
  if (!set || set.size === 0) return 0;
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  const dead = [];
  for (const entry of set) {
    try {
      await entry.writer.write(entry.encoder.encode(line));
    } catch (_) {
      dead.push(entry);
    }
  }
  for (const d of dead) removeSubscriber(sessionId, d);
  return set.size;
}

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Forge-Callback-Secret, X-Forge-Target-Repo, X-Forge-Target-Pat",
  "Access-Control-Max-Age": "86400",
};

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders },
  });
}

function bad(status, message) {
  return json(status, { error: message });
}

function extractUserPat(request) {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const pat = m[1].trim();
  if (!pat) return null;
  // Accept classic ("ghp_...") or fine-grained ("github_pat_...") PATs.
  if (!/^gh[po]_[A-Za-z0-9_]{20,}$/.test(pat) && !/^github_pat_[A-Za-z0-9_]{20,}$/.test(pat)) {
    return null;
  }
  return pat;
}

async function githubApi(path, { method = "GET", pat, body, headers = {} } = {}) {
  const url = path.startsWith("http") ? path : `https://api.github.com${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Authorization": `Bearer ${pat}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "forge-worker",
      "Content-Type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

// -----------------------------------------------------------------------------
// Route: POST /task
//   Body: { session_id, task_prompt, model, target_repo?, target_repo_pat? }
//   Header: Authorization: Bearer <user-pat>
//
// Uses the WORKER's own dispatch PAT (secret) to fire repository_dispatch.
// The user's PAT is passed in the client_payload so the Actions job can use it
// for GitHub reads/writes (session storage, optional target-repo pushes).
// -----------------------------------------------------------------------------
async function handleTask(request, env) {
  const userPat = extractUserPat(request);
  if (!userPat) return bad(401, "Missing or invalid GitHub PAT in Authorization header");

  let body;
  try { body = await request.json(); } catch { return bad(400, "Invalid JSON body"); }

  const { session_id, task_prompt, model } = body || {};
  if (!session_id || typeof session_id !== "string") return bad(400, "session_id is required");
  if (!task_prompt || typeof task_prompt !== "string") return bad(400, "task_prompt is required");

  // The header form is preferred so the target PAT never lands in a request log body.
  const targetRepo = body.target_repo || request.headers.get("X-Forge-Target-Repo") || null;
  const targetRepoPat = body.target_repo_pat || request.headers.get("X-Forge-Target-Pat") || null;

  const dispatchPat = env.FORGE_DISPATCH_PAT;
  const sessionsRepo = env.FORGE_SESSIONS_REPO;
  const callbackSecret = env.FORGE_CALLBACK_SECRET;
  const eventType = env.FORGE_DISPATCH_EVENT_TYPE || "forge-task";

  // Check each required secret individually so the error names exactly which
  // one(s) are missing — a combined message makes binding/deploy desyncs
  // (dashboard lists a secret, serving deployment lacks it) slow to diagnose.
  const missingSecrets = [
    ["FORGE_DISPATCH_PAT", dispatchPat],
    ["FORGE_SESSIONS_REPO", sessionsRepo],
    ["FORGE_CALLBACK_SECRET", callbackSecret],
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missingSecrets.length > 0) {
    return bad(500, `Worker is missing required secrets: ${missingSecrets.join(", ")}`);
  }

  // Build a callback URL back to THIS worker. request.url already has the correct host.
  const url = new URL(request.url);
  const callbackUrl = `${url.origin}/progress`;

  const client_payload = {
    session_id,
    task_prompt,
    model: model || "claude-sonnet-5",
    // The Actions job uses this PAT for reads/writes to the sessions repo.
    user_pat: userPat,
    target_repo: targetRepo,
    target_repo_pat: targetRepoPat,
    callback_url: callbackUrl,
    callback_secret: callbackSecret,
    dispatched_at: new Date().toISOString(),
  };

  const res = await githubApi(`/repos/${sessionsRepo}/dispatches`, {
    method: "POST",
    pat: dispatchPat,
    body: { event_type: eventType, client_payload },
  });

  if (!res.ok) {
    return bad(res.status || 502, `GitHub dispatch failed: ${JSON.stringify(res.data)}`);
  }

  // Push an immediate "dispatched" event so the UI shows life right away.
  await broadcast(session_id, {
    type: "status",
    session_id,
    status: "dispatched",
    message: "Task dispatched to GitHub Actions",
    ts: new Date().toISOString(),
  });

  return json(200, { ok: true, session_id, dispatched: true });
}

// -----------------------------------------------------------------------------
// Route: POST /progress
//   Called by the GitHub Actions runner. Authenticated via callback secret.
//   Body: { session_id, type, ...arbitrary }
// -----------------------------------------------------------------------------
async function handleProgress(request, env) {
  const secret = request.headers.get("X-Forge-Callback-Secret");
  if (!secret || secret !== env.FORGE_CALLBACK_SECRET) return bad(401, "bad callback secret");

  let payload;
  try { payload = await request.json(); } catch { return bad(400, "Invalid JSON body"); }

  const sessionId = payload && payload.session_id;
  if (!sessionId) return bad(400, "session_id required");

  const count = await broadcast(sessionId, { ...payload, ts: payload.ts || new Date().toISOString() });
  return json(200, { ok: true, delivered_to: count });
}

// -----------------------------------------------------------------------------
// Route: GET /stream/:session_id
//   Server-Sent Events. The client reconnects automatically on drop; on
//   reconnect it should ALSO fetch current state from GitHub, since events
//   emitted while the client was disconnected are not buffered here.
// -----------------------------------------------------------------------------
function handleStream(request, env, sessionId) {
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();
  const entry = { writer, encoder };
  addSubscriber(sessionId, entry);

  // Prime the connection so browsers commit to the SSE state.
  writer.write(encoder.encode(`: connected\n\n`)).catch(() => {});
  writer.write(encoder.encode(`data: ${JSON.stringify({ type: "hello", session_id: sessionId, ts: new Date().toISOString() })}\n\n`)).catch(() => {});

  // Heartbeat every 20s. Cloudflare will kill idle streams otherwise.
  const heartbeat = setInterval(() => {
    writer.write(encoder.encode(`: ping ${Date.now()}\n\n`)).catch(() => {
      clearInterval(heartbeat);
      removeSubscriber(sessionId, entry);
    });
  }, 20000);

  // Best-effort cleanup when the client aborts.
  request.signal?.addEventListener?.("abort", () => {
    clearInterval(heartbeat);
    try { writer.close(); } catch {}
    removeSubscriber(sessionId, entry);
  });

  return new Response(stream.readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      ...CORS_HEADERS,
    },
  });
}

// -----------------------------------------------------------------------------
// Route: POST /upload
//   Frontend hands us { session_id, path, content_base64, message? }.
//   We write it to <sessionsRepo>/sessions/<session_id>/inbox/<path> via the
//   GitHub Contents API, using the user's PAT. The Worker itself does not
//   store the file — this is a pure proxy so the frontend does not need to
//   embed the GitHub API host directly (keeps CORS + auth uniform).
// -----------------------------------------------------------------------------
async function handleUpload(request, env) {
  const userPat = extractUserPat(request);
  if (!userPat) return bad(401, "Missing or invalid GitHub PAT");

  let body;
  try { body = await request.json(); } catch { return bad(400, "Invalid JSON body"); }
  const { session_id, path, content_base64, message } = body || {};
  if (!session_id || !path || !content_base64) return bad(400, "session_id, path, content_base64 required");

  const sessionsRepo = env.FORGE_SESSIONS_REPO;
  if (!sessionsRepo) return bad(500, "FORGE_SESSIONS_REPO not configured");

  // Prevent path traversal.
  if (path.includes("..") || path.startsWith("/")) return bad(400, "invalid path");

  const targetPath = `sessions/${session_id}/inbox/${path}`;
  const apiPath = `/repos/${sessionsRepo}/contents/${encodeURI(targetPath)}`;

  // Check for existing file to get sha (update vs create).
  const existing = await githubApi(apiPath, { method: "GET", pat: userPat });
  const sha = existing.ok && existing.data && existing.data.sha ? existing.data.sha : undefined;

  const res = await githubApi(apiPath, {
    method: "PUT",
    pat: userPat,
    body: {
      message: message || `forge: upload ${path} to session ${session_id}`,
      content: content_base64,
      sha,
    },
  });

  if (!res.ok) return bad(res.status || 502, `GitHub upload failed: ${JSON.stringify(res.data)}`);
  return json(200, { ok: true, path: targetPath, commit: res.data.commit?.sha });
}

// -----------------------------------------------------------------------------
// Route: POST /delete-session
//   Body: { session_id }
//   Deletes every file under sessions/<session_id>/ in a single tree commit,
//   using the user's PAT.
// -----------------------------------------------------------------------------
async function handleDeleteSession(request, env) {
  const userPat = extractUserPat(request);
  if (!userPat) return bad(401, "Missing or invalid GitHub PAT");

  let body;
  try { body = await request.json(); } catch { return bad(400, "Invalid JSON body"); }
  const { session_id } = body || {};
  if (!session_id) return bad(400, "session_id required");

  const sessionsRepo = env.FORGE_SESSIONS_REPO;
  if (!sessionsRepo) return bad(500, "FORGE_SESSIONS_REPO not configured");

  // Strategy: list the tree, walk the folder, and issue a single commit that
  // rewrites the tree without those paths. This is the atomic way to delete
  // a whole folder in one commit via the Git Data API.
  //
  // 1. Get the default branch's head commit.
  const repoInfo = await githubApi(`/repos/${sessionsRepo}`, { pat: userPat });
  if (!repoInfo.ok) return bad(repoInfo.status || 502, `GitHub repo lookup failed: ${JSON.stringify(repoInfo.data)}`);
  const defaultBranch = repoInfo.data.default_branch || "main";

  const refRes = await githubApi(`/repos/${sessionsRepo}/git/refs/heads/${defaultBranch}`, { pat: userPat });
  if (!refRes.ok) return bad(refRes.status || 502, `GitHub ref lookup failed: ${JSON.stringify(refRes.data)}`);
  const headSha = refRes.data.object.sha;

  const commitRes = await githubApi(`/repos/${sessionsRepo}/git/commits/${headSha}`, { pat: userPat });
  if (!commitRes.ok) return bad(commitRes.status || 502, `GitHub commit lookup failed`);
  const baseTreeSha = commitRes.data.tree.sha;

  // 2. Get the recursive tree, find entries under sessions/<session_id>/
  const treeRes = await githubApi(`/repos/${sessionsRepo}/git/trees/${baseTreeSha}?recursive=1`, { pat: userPat });
  if (!treeRes.ok) return bad(treeRes.status || 502, `GitHub tree lookup failed`);

  const prefix = `sessions/${session_id}/`;
  const toDelete = (treeRes.data.tree || []).filter(e => e.type === "blob" && e.path.startsWith(prefix));
  if (toDelete.length === 0) return json(200, { ok: true, deleted: 0, note: "nothing to delete" });

  // 3. Build a new tree that nulls out those blobs.
  const newTree = toDelete.map(e => ({ path: e.path, mode: e.mode, type: "blob", sha: null }));
  const newTreeRes = await githubApi(`/repos/${sessionsRepo}/git/trees`, {
    method: "POST", pat: userPat,
    body: { base_tree: baseTreeSha, tree: newTree },
  });
  if (!newTreeRes.ok) return bad(newTreeRes.status || 502, `GitHub tree create failed: ${JSON.stringify(newTreeRes.data)}`);

  // 4. Create the commit and move the ref.
  const newCommitRes = await githubApi(`/repos/${sessionsRepo}/git/commits`, {
    method: "POST", pat: userPat,
    body: {
      message: `forge: delete session ${session_id}`,
      tree: newTreeRes.data.sha,
      parents: [headSha],
    },
  });
  if (!newCommitRes.ok) return bad(newCommitRes.status || 502, `GitHub commit create failed`);

  const updateRefRes = await githubApi(`/repos/${sessionsRepo}/git/refs/heads/${defaultBranch}`, {
    method: "PATCH", pat: userPat,
    body: { sha: newCommitRes.data.sha, force: false },
  });
  if (!updateRefRes.ok) return bad(updateRefRes.status || 502, `GitHub ref update failed`);

  return json(200, { ok: true, deleted: toDelete.length, commit: newCommitRes.data.sha });
}

// -----------------------------------------------------------------------------
// Dispatcher
// -----------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const p = url.pathname;

    try {
      if (p === "/health") return json(200, { ok: true, service: "forge-worker" });
      if (p === "/task" && request.method === "POST") return await handleTask(request, env);
      if (p === "/progress" && request.method === "POST") return await handleProgress(request, env);
      if (p === "/upload" && request.method === "POST") return await handleUpload(request, env);
      if (p === "/delete-session" && request.method === "POST") return await handleDeleteSession(request, env);

      const streamMatch = p.match(/^\/stream\/([A-Za-z0-9_\-]+)$/);
      if (streamMatch && request.method === "GET") {
        return handleStream(request, env, streamMatch[1]);
      }

      // Every non-API request is served by the static frontend bundled with this Worker.
      // Keep API routes above so they are handled by the relay logic exactly as before.
      return env.ASSETS.fetch(request);
    } catch (err) {
      return bad(500, `worker error: ${err && err.message ? err.message : String(err)}`);
    }
  },
};
