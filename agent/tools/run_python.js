/**
 * run_python tool.
 *
 * Writes the model-supplied code to a temp .py file, runs it with python3.
 * Working directory is the session workspace so scripts naturally see the
 * user's uploaded inbox/ files.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export async function runPython(args, ctx) {
  const code = args.code || "";
  const timeoutSec = Math.min(Math.max(Number(args.timeout_sec) || 120, 1), 600);
  if (!code.trim()) return { ok: false, error: "empty code" };

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "forge-py-"));
  const file = path.join(tmp, "script.py");
  await fs.writeFile(file, code, "utf8");

  const cwd = ctx.sessionDir;
  await fs.mkdir(cwd, { recursive: true });

  return await new Promise((resolve) => {
    const child = spawn("python3", [file], { cwd, stdio: ["ignore", "pipe", "pipe"] });
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
        summary: `python exit=${code}${killed ? " (timed out)" : ""}\n--- stdout ---\n${stdout.slice(-2000)}\n--- stderr ---\n${stderr.slice(-1000)}`,
      });
    });
    child.on("error", e => resolve({ ok: false, error: e.message }));
  });
}
