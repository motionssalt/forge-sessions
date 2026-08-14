/**
 * File tools: read_file, write_file, edit_file.
 *
 * All paths are resolved relative to the session workspace unless absolute.
 * We refuse to write outside GITHUB_WORKSPACE — the runner is ephemeral but
 * the model shouldn't be poking system paths anyway.
 */

import fs from "node:fs/promises";
import path from "node:path";

function resolveInWorkspace(ctx, p) {
  if (!p) throw new Error("path required");
  const abs = path.isAbsolute(p) ? p : path.resolve(ctx.sessionDir, p);
  const root = ctx.workspaceRoot;
  if (!abs.startsWith(root + path.sep) && abs !== root) {
    throw new Error(`path escapes workspace: ${p}`);
  }
  return abs;
}

export async function readFileTool(args, ctx) {
  try {
    const abs = resolveInWorkspace(ctx, args.path);
    const buf = await fs.readFile(abs);
    const text = buf.toString("utf8");
    return {
      ok: true,
      path: abs,
      bytes: buf.length,
      content: text.length > 40_000 ? text.slice(0, 40_000) + `\n... [truncated, total ${buf.length} bytes]` : text,
      summary: `read ${abs} (${buf.length} bytes)`,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function writeFileTool(args, ctx) {
  try {
    const abs = resolveInWorkspace(ctx, args.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, args.content ?? "", "utf8");
    return { ok: true, path: abs, summary: `wrote ${abs} (${(args.content || "").length} chars)` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function editFileTool(args, ctx) {
  try {
    const abs = resolveInWorkspace(ctx, args.path);
    const original = await fs.readFile(abs, "utf8");
    const oldS = args.old_string ?? "";
    const newS = args.new_string ?? "";
    if (!oldS) return { ok: false, error: "old_string required" };

    let updated;
    if (args.replace_all) {
      updated = original.split(oldS).join(newS);
      if (updated === original) return { ok: false, error: "old_string not found" };
    } else {
      const idx = original.indexOf(oldS);
      if (idx === -1) return { ok: false, error: "old_string not found" };
      const idx2 = original.indexOf(oldS, idx + oldS.length);
      if (idx2 !== -1) return { ok: false, error: "old_string is not unique (pass replace_all=true if intended)" };
      updated = original.slice(0, idx) + newS + original.slice(idx + oldS.length);
    }
    await fs.writeFile(abs, updated, "utf8");
    return { ok: true, path: abs, summary: `edited ${abs}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
