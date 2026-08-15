/**
 * State + progress helpers.
 *
 * - postProgress: fire-and-forget POST to the Worker's /progress endpoint.
 *   Never throws; a delivery failure must not crash the agent.
 * - appendLog: append markdown to sessions/<id>/log.md.
 * - writeStatus: overwrite sessions/<id>/status.json.
 * - commitStateBatched: git add/commit/push the state files, but only if
 *   enough steps or wall-clock time has elapsed since the last commit.
 *
 * FIX (2026-08-15): every network/subprocess call in this file used to be
 * unbounded — a slow/unreachable Worker or a stuck `git push` would hang
 * the whole GitHub Actions job forever with zero console output, since
 * success was silent and failures only logged if the promise ever settled.
 * Every blocking call below now has an explicit ceiling and always logs
 * on entry/exit so a hang is visible in the Actions log instead of silent.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

// Hard ceiling for the progress-callback POST to the Cloudflare Worker.
const PROGRESS_TIMEOUT_MS = 10_000;
// Hard ceiling for any single git subprocess used for state commits.
const GIT_TIMEOUT_MS = 30_000;

function statusJsonPath(ctx) { return path.join(ctx.sessionDir, "status.json"); }
function logMdPath(ctx)      { return path.join(ctx.sessionDir, "log.md"); }

export async function postProgress(ctx, payload) {
  if (!ctx.callback_url) return;
  const body = { session_id: ctx.session_id, ts: new Date().toISOString(), ...payload };
  try {
    // Node 20+ has global fetch. AbortSignal.timeout() is the fix here:
    // without it, an unresponsive Worker (cold start, network stall, dead
    // deploy) hangs this await forever with no log output at all.
    await fetch(ctx.callback_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forge-Callback-Secret": ctx.callback_secret || "",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROGRESS_TIMEOUT_MS),
    });
  } catch (err) {
    // Deliberately swallow. The agent must not die because the Worker is down.
    // This now ALWAYS fires within PROGRESS_TIMEOUT_MS instead of possibly
    // never firing.
    const reason = err?.name === "TimeoutError" || err?.name === "AbortError"
      ? `timed out after ${PROGRESS_TIMEOUT_MS}ms`
      : err.message;
    console.warn("[forge/agent] postProgress failed:", reason);
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

// Bounded subprocess runner. Previously had no timeout at all — a stuck
// `git push` (auth prompt, network stall, huge diff) would hang the job
// forever. Now it is SIGKILLed after GIT_TIMEOUT_MS and returns a non-zero
// code so callers can see and report the failure instead of hanging.
function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "", err = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill("SIGKILL"); } catch {}
    }, GIT_TIMEOUT_MS);
    child.stdout.on("data", d => out += d.toString());
    child.stderr.on("data", d => err += d.toString());
    child.on("close", code => {
      clearTimeout(timer);
      resolve({
        code: killed ? 124 : code,
        stdout: out,
        stderr: killed ? `${err}\n[timed out after ${GIT_TIMEOUT_MS}ms, process killed]` : err,
        killed_by_timeout: killed,
      });
    });
    child.on("error", e => {
      clearTimeout(timer);
      resolve({ code: 1, stdout: out, stderr: err + "\n" + e.message });
    });
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

  console.log(`[forge/agent] commitStateBatched: starting (force=${!!opts.force}, step=${opts.step})`);

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
    console.log("[forge/agent] commitStateBatched: nothing to commit");
    return { skipped: true, empty: true };
  }

  const stepLabel = opts.step != null ? ` (step ${opts.step})` : "";
  const commit = await sh("git", ["commit", "-m", `forge: session ${ctx.session_id} state${stepLabel}`], { cwd });
  if (commit.code !== 0) {
    console.warn("[forge/agent] commit failed:", commit.stderr);
    return { skipped: false, ok: false, error: commit.stderr };
  }

  const currentBranch = await sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  const initialBranch = (currentBranch.stdout || "").trim() || "main";

  const push = await sh("git", ["push", "origin", `HEAD:refs/heads/${initialBranch}`], { cwd });
  if (push.code !== 0) {
    console.warn("[forge/agent] push failed:", push.stderr);
    // Retry once: fetch + rebase onto the current remote branch, then push
    // again. FIX (2026-08-15): the previous version ran
    // `git pull --rebase origin HEAD` and pushed again WITHOUT checking
    // whether the rebase actually succeeded. `origin HEAD` is not a branch
    // name — rebasing against it can leave the repo mid-rebase or in a
    // state where `HEAD` no longer resolves the way `git push origin HEAD`
    // expects, which produced the exact "not a full refname" error seen in
    // production. We now rebase against an explicit branch, check its exit
    // code, and abort cleanly on conflict instead of pushing from unknown
    // repo state.
    const branchName = initialBranch;
    console.warn(`[forge/agent] retrying: fetch + rebase onto origin/${branchName}`);

    const fetch = await sh("git", ["fetch", "origin", branchName], { cwd });
    if (fetch.code !== 0) {
      console.warn("[forge/agent] fetch failed:", fetch.stderr);
      return { skipped: false, ok: false, error: `fetch failed: ${fetch.stderr}` };
    }

    const rebase = await sh("git", ["rebase", `origin/${branchName}`], { cwd });
    if (rebase.code !== 0) {
      console.warn("[forge/agent] rebase failed, aborting:", rebase.stderr);
      // Leave the repo clean rather than mid-rebase for the next run.
      await sh("git", ["rebase", "--abort"], { cwd });
      return { skipped: false, ok: false, error: `rebase failed: ${rebase.stderr}` };
    }

    const push2 = await sh("git", ["push", "origin", `HEAD:refs/heads/${branchName}`], { cwd });
    if (push2.code !== 0) {
      console.warn("[forge/agent] push retry failed:", push2.stderr);
      return { skipped: false, ok: false, error: push2.stderr };
    }
    console.log("[forge/agent] push retry succeeded");
  }

  b.stepsSinceCommit = 0;
  b.lastCommitMs = now;
  console.log("[forge/agent] commitStateBatched: done");
  return { skipped: false, ok: true };
}
