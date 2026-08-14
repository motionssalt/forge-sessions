/**
 * upload_output_file tool.
 *
 * Move (or copy) a file from anywhere in the session workspace into
 * sessions/<id>/outbox/ so the Forge UI can list + serve it as a download.
 *
 * The actual git-push happens in the batched state commit — no per-file
 * commit here.
 */

import fs from "node:fs/promises";
import path from "node:path";

export async function uploadOutputFile(args, ctx) {
  try {
    const src = path.isAbsolute(args.source_path)
      ? args.source_path
      : path.resolve(ctx.sessionDir, args.source_path);
    const destName = args.dest_name || path.basename(src);
    if (destName.includes("/") || destName.includes("..")) {
      return { ok: false, error: "dest_name must be a plain filename with no slashes" };
    }
    const dest = path.join(ctx.outboxDir, destName);

    await fs.mkdir(ctx.outboxDir, { recursive: true });
    const buf = await fs.readFile(src);
    await fs.writeFile(dest, buf);
    return { ok: true, path: dest, bytes: buf.length, summary: `copied ${src} -> ${dest} (${buf.length} bytes)` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
