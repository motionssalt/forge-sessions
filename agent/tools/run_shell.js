/**
 * run_shell tool. Executes a bash command in the session workspace.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";

export async function runShell(args, ctx) {
  const command = args.command || "";
  const timeoutSec = Math.min(Math.max(Number(args.timeout_sec) || 120, 1), 600);
  if (!command.trim()) return { ok: false, error: "empty command" };

  const cwd = ctx.sessionDir;
  await fs.mkdir(cwd, { recursive: true });

  return await new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    let killed = false;
    const timer = setTimeout(() => { killed = true; try { child.kill("SIGKILL"); } catch {} }, timeoutSec * 1000);
    child.stdout.on("data", d => { stdout += d.toString(); if (stdout.length > 200_000) stdout = stdout.slice(-200_000); });
    child.stderr.on("data", d => { stderr += d.toString(); if (stderr.length > 200_000) stderr = stderr.slice(-200_000); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !killed,
        exit_code: code,
        killed_by_timeout: killed,
        stdout,
        stderr,
        summary: `shell exit=${code}${killed ? " (timed out)" : ""}\n$ ${command}\n${stdout.slice(-1500)}\n${stderr.slice(-500)}`,
      });
    });
    child.on("error", e => resolve({ ok: false, error: e.message }));
  });
}
