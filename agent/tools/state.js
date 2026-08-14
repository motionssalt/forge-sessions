/**
 * State + progress helpers.
 *
 * - postProgress: fire-and-forget POST to the Worker's /progress endpoint.
 *   Never throws; a delivery failure must not crash the agent.
 * - appendLog: append markdown to sessions/<id>/log.md.
 * - writeStatus: overwrite sessions/<id>/status.json.
 * - commitStateBatched: git add/commit/push the state files, but only if
 *   enough steps or wall-clock time has elapsed since the last commit.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

function statusJsonPath(ctx) { return path.join(ctx.sessionDir, "status.json"); }
function logMdPath(ctx)      { return path.join(ctx.sessionDir, "log.md"); }

export async function postProgress(ctx, payload) {
  if (!ctx.callback_url) return;
  const body = { session_id: ctx.session_id, ts: new Date().toISOString(), ...payload };
  try {
    // Node 20+ has global fetch.
    await fetch(ctx.callback_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forge-Callback-Secret": ctx.callback_secret || "",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Deliberately swallow. The agent must not die because the Worker is down.
    console.warn("[forge/agent] postProgress failed:", err.message);
  }
}

export async function appendLog(ctx, chunk) {
  try {
    await fs.mkdir(ctx.sessionDir, { recursive: true });
    await fs.appendFile(logMdPath(ctx), chunk, "utf8");
  } catch (err) {
    console.warn("[forge/agent] appendLog failed:", err.message);
  }
}

export async function writeStatus(ctx, status) {
  try {
    await fs.mkdir(ctx.sessionDir, { recursive: true });
    await fs.writeFile(statusJsonPath(ctx), JSON.stringify(status, null, 2), "utf8");
  } catch (err) {
    console.warn("[forge/agent] writeStatus failed:", err.message);
  }
}

function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "", err = "";
    child.stdout.on("data", d => out += d.toString());
    child.stderr.on("data", d => err += d.toString());
    child.on("close", code => resolve({ code, stdout: out, stderr: err }));
    child.on("error", e => resolve({ code: 1, stdout: out, stderr: err + "\n" + e.message }));
  });
}

/**
 * Commit sessions/<id>/log.md + status.json + outbox/ back to origin.
 *
 * We batch these commits: the caller increments ctx.commitBatch.stepsSinceCommit
 * on each step, and we only actually commit when either
 *   stepsSinceCommit >= maxSteps  OR  (now - lastCommitMs) >= maxMs
 *   OR opts.force === true.
 * This avoids one-commit-per-micro-step noise while still keeping the repo
 * up to date within ~30 seconds.
 */
export async function commitStateBatched(ctx, opts = {}) {
  const b = ctx.commitBatch;
  const now = Date.now();
  const timeDue = (now - b.lastCommitMs) >= b.maxMs;
  const stepDue = b.stepsSinceCommit >= b.maxSteps;
  if (!opts.force && !timeDue && !stepDue) return { skipped: true };

  const cwd = ctx.workspaceRoot;
  const relLog     = path.relative(cwd, logMdPath(ctx));
  const relStatus  = path.relative(cwd, statusJsonPath(ctx));
  const relOutbox  = path.relative(cwd, ctx.outboxDir);
  const relSession = path.relative(cwd, ctx.sessionDir);

  // Configure identity every commit — cheap and idempotent.
  await sh("git", ["config", "user.email", "forge-agent@users.noreply.github.com"], { cwd });
  await sh("git", ["config", "user.name",  "forge-agent"], { cwd });

  await sh("git", ["add", relLog, relStatus, relOutbox, `${relSession}/inbox`], { cwd });

  // Anything staged?
  const diff = await sh("git", ["diff", "--cached", "--quiet"], { cwd });
  if (diff.code === 0) {
    // Nothing to commit. Still refresh the batch timer so we don't
    // hot-spin on a no-op.
    b.stepsSinceCommit = 0;
    b.lastCommitMs = now;
    return { skipped: true, empty: true };
  }

  const stepLabel = opts.step != null ? ` (step ${opts.step})` : "";
  const commit = await sh("git", ["commit", "-m", `forge: session ${ctx.session_id} state${stepLabel}`], { cwd });
  if (commit.code !== 0) {
    console.warn("[forge/agent] commit failed:", commit.stderr);
    return { skipped: false, ok: false, error: commit.stderr };
  }

  const push = await sh("git", ["push", "origin", "HEAD"], { cwd });
  if (push.code !== 0) {
    console.warn("[forge/agent] push failed:", push.stderr);
    // Try a rebase-pull-then-push once (in case the human deleted a session
    // in parallel).
    await sh("git", ["pull", "--rebase", "origin", "HEAD"], { cwd });
    const push2 = await sh("git", ["push", "origin", "HEAD"], { cwd });
    if (push2.code !== 0) return { skipped: false, ok: false, error: push2.stderr };
  }

  b.stepsSinceCommit = 0;
  b.lastCommitMs = now;
  return { skipped: false, ok: true };
}
