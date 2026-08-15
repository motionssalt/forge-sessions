/**
 * git_commit_push tool.
 *
 * By default this commits/pushes inside the sessions repo (the current
 * $GITHUB_WORKSPACE checkout). If args.to_target_repo is true AND the dispatch
 * payload carried a target_repo + target_repo_pat, we instead:
 *   1. Clone target_repo into a temp dir
 *   2. Copy the requested paths in from the session workspace (or from outbox/)
 *   3. Commit + push using the target PAT
 *
 * The target PAT is a fresh, separately-scoped credential (see SETUP.md).
 * We never log it, never bake it into a remote URL that gets written to
 * .git/config with -v, and we prefer the credential.helper=store scratch
 * pattern with an ephemeral netrc.
 *
 * FIX (2026-08-15): the spawn() wrapper below used to have no timeout —
 * a hung `git push` (bad credentials prompting interactively, network
 * stall, huge clone) could block this tool call, and therefore the whole
 * agent loop, forever. Every subprocess is now bounded and killed if it
 * runs too long, so this tool always resolves.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Git operations against small text files should be fast. Clone is the
// slowest step we do here, so give it more room than commit/push.
const GIT_TIMEOUT_MS = 30_000;
const CLONE_TIMEOUT_MS = 60_000;

function sh(cmd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs || GIT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "", err = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);
    child.stdout.on("data", d => out += d.toString());
    child.stderr.on("data", d => err += d.toString());
    child.on("close", code => {
      clearTimeout(timer);
      resolve({
        code: killed ? 124 : code,
        stdout: out,
        stderr: killed ? `${err}\n[timed out after ${timeoutMs}ms, process killed]` : err,
        killed_by_timeout: killed,
      });
    });
    child.on("error", e => {
      clearTimeout(timer);
      resolve({ code: 1, stdout: out, stderr: err + "\n" + e.message });
    });
  });
}

export async function gitCommitPush(args, ctx) {
  const message = args.message || "forge: update";
  const paths = Array.isArray(args.paths) ? args.paths : null;

  if (!args.to_target_repo) {
    const cwd = ctx.workspaceRoot;
    await sh("git", ["config", "user.email", "forge-agent@users.noreply.github.com"], { cwd });
    await sh("git", ["config", "user.name", "forge-agent"], { cwd });
    if (paths && paths.length) {
      const r = await sh("git", ["add", ...paths], { cwd });
      if (r.code !== 0) return { ok: false, error: `git add failed: ${r.stderr}` };
    } else {
      await sh("git", ["add", "-A"], { cwd });
    }
    const diff = await sh("git", ["diff", "--cached", "--quiet"], { cwd });
    if (diff.code === 0) return { ok: true, summary: "nothing to commit" };
    const commit = await sh("git", ["commit", "-m", message], { cwd });
    if (commit.code !== 0) return { ok: false, error: `git commit failed: ${commit.stderr}` };
    const push = await sh("git", ["push", "origin", "HEAD"], { cwd });
    if (push.code !== 0) {
      await sh("git", ["pull", "--rebase", "origin", "HEAD"], { cwd });
      const push2 = await sh("git", ["push", "origin", "HEAD"], { cwd });
      if (push2.code !== 0) return { ok: false, error: `git push failed: ${push2.stderr}` };
    }
    return { ok: true, summary: `committed to sessions repo: ${message}` };
  }

  // ---- Target repo path -----------------------------------------------------
  if (!ctx.target_repo || !ctx.target_repo_pat) {
    return { ok: false, error: "target_repo / target_repo_pat not provided for this session" };
  }

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "forge-target-"));
  const pat = ctx.target_repo_pat;

  // Use askpass-style env to avoid ever writing the PAT into .git/config.
  const askpass = path.join(scratch, "askpass.sh");
  await fs.writeFile(askpass, `#!/usr/bin/env bash\necho "$FORGE_TARGET_PAT"\n`, { mode: 0o700 });
  const gitEnv = {
    ...process.env,
    GIT_ASKPASS: askpass,
    FORGE_TARGET_PAT: pat,
    GIT_TERMINAL_PROMPT: "0",
  };

  const cloneUrl = `https://x-access-token@github.com/${ctx.target_repo}.git`;
  const cloneRes = await sh("git", ["clone", "--depth", "1", cloneUrl, path.join(scratch, "repo")], { env: gitEnv, timeoutMs: CLONE_TIMEOUT_MS });
  if (cloneRes.code !== 0) return { ok: false, error: `clone failed: ${cloneRes.stderr.replace(pat, "***")}` };

  const repoDir = path.join(scratch, "repo");
  await sh("git", ["config", "user.email", "forge-agent@users.noreply.github.com"], { cwd: repoDir });
  await sh("git", ["config", "user.name", "forge-agent"], { cwd: repoDir });

  // Copy paths in from session workspace or outbox/.
  const sources = paths && paths.length ? paths : ["outbox"];
  for (const p of sources) {
    const src = path.isAbsolute(p) ? p : path.resolve(ctx.sessionDir, p);
    const dst = path.join(repoDir, path.basename(src));
    try {
      const stat = await fs.stat(src);
      if (stat.isDirectory()) {
        await sh("cp", ["-R", src + "/.", dst + "/"]);
      } else {
        await fs.mkdir(path.dirname(dst), { recursive: true });
        await fs.copyFile(src, dst);
      }
    } catch (err) {
      return { ok: false, error: `copy failed for ${p}: ${err.message}` };
    }
  }

  await sh("git", ["add", "-A"], { cwd: repoDir });
  const diff = await sh("git", ["diff", "--cached", "--quiet"], { cwd: repoDir });
  if (diff.code === 0) return { ok: true, summary: "nothing to commit to target repo" };
  const commit = await sh("git", ["commit", "-m", message], { cwd: repoDir });
  if (commit.code !== 0) return { ok: false, error: `commit failed: ${commit.stderr}` };
  const push = await sh("git", ["push", "origin", "HEAD"], { cwd: repoDir, env: gitEnv });
  if (push.code !== 0) return { ok: false, error: `push failed: ${push.stderr.replace(pat, "***")}` };

  return { ok: true, summary: `pushed to ${ctx.target_repo}: ${message}` };
}
