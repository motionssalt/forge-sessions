/**
 * Forge agent loop.
 *
 * Runs inside GitHub Actions (see .github/workflows/forge-task.yml).
 * See puter-pool.js for the root-cause note on the second-iteration hang
 * — this file's only responsibility around that bug is to consume the
 * *normalized* response the pool wrapper now returns, instead of trying
 * to duck-type puter.js's two return shapes itself.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { runPython } from "./tools/run_python.js";
import { runShell } from "./tools/run_shell.js";
import { readFileTool, writeFileTool, editFileTool } from "./tools/files.js";
import { gitCommitPush } from "./tools/git.js";
import { browserAction } from "./tools/browser.js";
import { uploadOutputFile } from "./tools/upload_output.js";
import { createPuterPool } from "./puter-pool.js";
import { postProgress, appendLog, writeStatus, commitStateBatched } from "./tools/state.js";

// -----------------------------------------------------------------------------
function readPayload() {
  const raw = process.env.FORGE_PAYLOAD;
  if (!raw) throw new Error("FORGE_PAYLOAD not set");
  try { return JSON.parse(raw); } catch (e) { throw new Error("FORGE_PAYLOAD is not valid JSON: " + e.message); }
}

// -----------------------------------------------------------------------------
const TOOL_SCHEMA = [
  { type: "function", function: { name: "run_python", description: "Run a Python 3 script. Returns stdout, stderr, and exit code. Working dir is the session workspace.", parameters: { type: "object", properties: { code: { type: "string" }, timeout_sec: { type: "number" } }, required: ["code"] } } },
  { type: "function", function: { name: "run_shell",  description: "Run a bash shell command in the session workspace. Returns stdout, stderr, exit code.",           parameters: { type: "object", properties: { command: { type: "string" }, timeout_sec: { type: "number" } }, required: ["command"] } } },
  { type: "function", function: { name: "read_file",  description: "Read a UTF-8 file from the session workspace (or an absolute path inside the runner).",           parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "Write a UTF-8 file (overwrites). Path is relative to the session workspace unless absolute.",     parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "edit_file",  description: "Apply a single find/replace to an existing UTF-8 file. old_string must match exactly once (unless replace_all is true).", parameters: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, required: ["path", "old_string", "new_string"] } } },
  { type: "function", function: { name: "git_commit_push", description: "Stage, commit, and push. If target_repo was supplied at dispatch, this pushes to that repo (using target_repo_pat). Otherwise it commits to the sessions repo.", parameters: { type: "object", properties: { message: { type: "string" }, paths: { type: "array", items: { type: "string" } }, to_target_repo: { type: "boolean" } }, required: ["message"] } } },
  { type: "function", function: { name: "browser_action", description: "Drive a headless Chromium browser (Playwright). Actions: goto, click, type, screenshot, get_text, wait.", parameters: { type: "object", properties: { action: { type: "string", enum: ["goto","click","type","screenshot","get_text","wait"] }, url: { type: "string" }, selector: { type: "string" }, text: { type: "string" }, ms: { type: "number" } }, required: ["action"] } } },
  { type: "function", function: { name: "upload_output_file", description: "Move a file into the session's outbox/ so the user can download it from the Forge UI.", parameters: { type: "object", properties: { source_path: { type: "string" }, dest_name: { type: "string" } }, required: ["source_path", "dest_name"] } } },
  { type: "function", function: { name: "finish", description: "Signal that the task is complete. Provide a final human-readable answer for the user.", parameters: { type: "object", properties: { final_message: { type: "string" } }, required: ["final_message"] } } },
];

function needsBrowser(prompt) {
  const p = (prompt || "").toLowerCase();
  return /\b(browser|scrape|crawl|screenshot|puppeteer|playwright|headless|open the (page|site|url)|render (this|the) page)\b/.test(p);
}

// Puter's streaming path sometimes hands us `content` as an array of
// { type, text } parts even after the pool wrapper's flatten step (e.g. a
// buffered final line from a provider that speaks parts). Belt & braces.
function contentToText(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    let out = "";
    for (const p of c) {
      if (typeof p === "string") out += p;
      else if (p && typeof p.text === "string") out += p.text;
    }
    return out;
  }
  return "";
}

// -----------------------------------------------------------------------------
async function main() {
  const payload = readPayload();
  const {
    session_id, task_prompt, model,
    user_pat, target_repo, target_repo_pat,
    callback_url, callback_secret,
  } = payload;

  // Heartbeat. NOTE: intentionally NOT `.unref()`-ed. With unref() the timer
  // is silently allowed to stop firing when it's the only thing keeping the
  // loop alive, which produced the "heartbeat also disappeared" symptom we
  // used to (incorrectly) attribute to full event-loop blockage. We clear
  // this timer explicitly at the end of main(), so keeping it referenced
  // is safe and gives us a reliable liveness signal.
  let step = 0;
  const heartbeatTimer = setInterval(() => {
    console.log(`[forge/agent] heartbeat: still running, step=${step}`);
  }, 15_000);

  try {
    const workspaceRoot = process.env.GITHUB_WORKSPACE || process.cwd();
    const sessionDir = path.join(workspaceRoot, "sessions", session_id);
    const inboxDir = path.join(sessionDir, "inbox");
    const outboxDir = path.join(sessionDir, "outbox");

    await fs.mkdir(inboxDir, { recursive: true });
    await fs.mkdir(outboxDir, { recursive: true });

    const ctx = {
      session_id, workspaceRoot, sessionDir, inboxDir, outboxDir,
      user_pat, target_repo, target_repo_pat,
      callback_url, callback_secret,
      logBuffer: [],
      commitBatch: { stepsSinceCommit: 0, lastCommitMs: Date.now(), maxSteps: 4, maxMs: 30_000 },
    };

    await writeStatus(ctx, {
      session_id, task_prompt,
      model: model || "claude-sonnet-5",
      status: "running", current_step: 0,
      started_at: new Date().toISOString(),
    });
    await appendLog(ctx, `# Session ${session_id}\n\n**Task:** ${task_prompt}\n\n**Model:** ${model || "claude-sonnet-5"}\n\n---\n`);
    await postProgress(ctx, { type: "status", status: "running", message: "Agent booted, initializing tools..." });

    let inboxFiles = [];
    try { inboxFiles = (await fs.readdir(inboxDir)).filter(f => !f.startsWith(".")); } catch {}

    const wantBrowser = needsBrowser(task_prompt);
    const puterPool = createPuterPool();
    await postProgress(ctx, { type: "step", message: `Puter account pool ready (${puterPool.size} account${puterPool.size === 1 ? "" : "s"}, model=${model || "claude-sonnet-5"})` });

    const systemPrompt = [
      "You are Forge, an autonomous coding + research agent operating inside a GitHub Actions job.",
      "You have access to tools. Prefer taking action via tools over describing what you would do.",
      `Session id: ${session_id}. Session workspace on disk: ${sessionDir}.`,
      `Files the user uploaded (in inbox/): ${inboxFiles.length ? inboxFiles.join(", ") : "(none)"}.`,
      "To hand a file back to the user, put it in outbox/ via the upload_output_file tool.",
      "When the task is fully done, call the `finish` tool with a short final_message. Do not call finish until you've actually done the work.",
      "Be terse in reasoning. Be explicit in tool calls.",
    ].join("\n");

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: task_prompt },
    ];

    const maxSteps = 40;
    let finalMessage = null;

    while (step < maxSteps) {
      step++;
      ctx.commitBatch.stepsSinceCommit++;
      console.log(`[forge/agent] step ${step}: requesting model response...`);

      let resp = null;
      let activeAccount = null;
      const attemptedAccounts = new Set();
      let lastError = null;
      while (attemptedAccounts.size < puterPool.size) {
        activeAccount = await puterPool.getActiveClient({ exclude: attemptedAccounts });
        attemptedAccounts.add(activeAccount.index);
        try {
          // The pool wrapper guarantees:
          //   - if puter.js returned an NDJSON iterator, it is fully drained
          //     and folded into a single assistant message here (so the shim
          //     stops thrashing on unread chunks and the underlying fetch
          //     body closes),
          //   - resp is always shaped { message: { role, content, tool_calls? } }.
          resp = await activeAccount.client.ai.chat(messages, {
            model: model || "claude-sonnet-5",
            tools: TOOL_SCHEMA,
          });
          puterPool.reportSuccess(activeAccount.index);
          ctx.currentPuterAccount = activeAccount.number;
          await appendLog(ctx, `\n**Puter account:** #${activeAccount.number}\n`);
          break;
        } catch (err) {
          lastError = err;
          console.warn(`[forge/agent] step ${step}: account #${activeAccount.number} failed: ${err.message}`);
          puterPool.reportFailure(activeAccount.index, err);
        }
      }
      if (!resp) {
        const reason = `All Puter accounts failed for this model request: ${lastError?.message || lastError || "unknown error"}`;
        console.error(`[forge/agent] step ${step}: ${reason}`);
        throw new Error(reason);
      }
      console.log(`[forge/agent] step ${step}: got model response from account #${ctx.currentPuterAccount}`);

      const assistantMsg = resp.message;
      // Store a wire-safe copy in `messages`. We flatten content here so the
      // next request's JSON body is always a plain string, not a parts array
      // whose serialization varies across model providers.
      const wireAssistant = {
        role: "assistant",
        content: contentToText(assistantMsg.content),
        ...(assistantMsg.tool_calls?.length ? { tool_calls: assistantMsg.tool_calls } : {}),
      };
      messages.push(wireAssistant);

      const toolCalls = assistantMsg.tool_calls || [];
      if (!toolCalls.length) {
        finalMessage = wireAssistant.content || "(no message)";
        await postProgress(ctx, { type: "step", step, message: `Model returned final message` });
        break;
      }

      for (const call of toolCalls) {
        const name = call.function?.name || call.name;
        let args = {};
        try {
          args = typeof call.function?.arguments === "string"
            ? JSON.parse(call.function.arguments)
            : (call.function?.arguments || call.arguments || {});
        } catch { args = {}; }

        await postProgress(ctx, { type: "tool_call", step, tool: name, args_preview: previewArgs(args) });
        await appendLog(ctx, `\n## Step ${step}: \`${name}\` (using Puter account #${ctx.currentPuterAccount})\n\n\`\`\`json\n${JSON.stringify(args, null, 2).slice(0, 1500)}\n\`\`\`\n`);

        let result;
        try {
          result = await dispatchTool(name, args, ctx, { wantBrowser });
        } catch (err) {
          result = { ok: false, error: err && err.message ? err.message : String(err) };
        }

        await postProgress(ctx, { type: "tool_result", step, tool: name, ok: !!result.ok, preview: previewResult(result) });
        await appendLog(ctx, `\n**Result:** ${result.ok ? "ok" : "error"}\n\n\`\`\`\n${(result.summary || result.error || "").toString().slice(0, 1500)}\n\`\`\`\n`);

        messages.push({
          role: "tool",
          tool_call_id: call.id || `${name}-${step}`,
          name,
          content: JSON.stringify(result).slice(0, 24_000),
        });

        if (name === "finish" && result.ok) {
          finalMessage = args.final_message || "(finished)";
        }
      }

      await commitStateBatched(ctx, { step });

      if (finalMessage !== null) break;
    }

    const status = finalMessage ? "done" : "error";
    const message = finalMessage || `Aborted: exceeded max steps (${maxSteps})`;

    await writeStatus(ctx, {
      session_id, task_prompt,
      model: model || "claude-sonnet-5",
      status, current_step: step,
      finished_at: new Date().toISOString(),
      final_message: message,
    });
    await appendLog(ctx, `\n---\n\n**Status:** ${status}\n\n**Final message:**\n\n${message}\n`);

    ctx.commitBatch.stepsSinceCommit = ctx.commitBatch.maxSteps + 1;
    await commitStateBatched(ctx, { step, force: true });

    await postProgress(ctx, { type: "status", status, message, step });

    if (status === "error") process.exit(2);
  } finally {
    clearInterval(heartbeatTimer);
  }

  // FIX (2026-08-15): puter.js's init() opens a WebSocket per account (via
  // its bundled undici) that stays connected for the lifetime of the client
  // and holds the Node event loop open even after main() finishes all its
  // awaited work. In GitHub Actions that manifests as: the agent prints its
  // final "commitStateBatched: done" log line, main() returns, but the
  // `node run.js` process never exits — the workflow step then sits idle
  // until the job's 45-minute timeout (or, as in the observed runs, until
  // the concurrency group cancels it on the next dispatch), and the
  // subsequent "Ensure final state is pushed" step never runs.
  //
  // We explicitly exit(0) here so a successful run terminates cleanly
  // regardless of any lingering sockets/timers held by puter.js internals.
  // Anything critical (state commit + progress callback) has already been
  // awaited above, so an immediate exit is safe.
  process.exit(0);
}

// -----------------------------------------------------------------------------
async function dispatchTool(name, args, ctx, opts) {
  switch (name) {
    case "run_python":       return runPython(args, ctx);
    case "run_shell":        return runShell(args, ctx);
    case "read_file":        return readFileTool(args, ctx);
    case "write_file":       return writeFileTool(args, ctx);
    case "edit_file":        return editFileTool(args, ctx);
    case "git_commit_push":  return gitCommitPush(args, ctx);
    case "browser_action":   return browserAction(args, ctx, opts);
    case "upload_output_file": return uploadOutputFile(args, ctx);
    case "finish":           return { ok: true, summary: `finish: ${args.final_message || ""}`.slice(0, 300) };
    default:                 return { ok: false, error: `unknown tool: ${name}` };
  }
}

function previewArgs(args) {
  try {
    const s = JSON.stringify(args);
    return s.length > 300 ? s.slice(0, 300) + "..." : s;
  } catch { return "<unserializable>"; }
}

function previewResult(r) {
  if (!r) return "";
  const s = (r.summary || r.error || "").toString();
  return s.length > 300 ? s.slice(0, 300) + "..." : s;
}

// -----------------------------------------------------------------------------
main().catch(async (err) => {
  console.error("[forge/agent] fatal:", err);
  try {
    const payload = readPayload();
    const ctx = {
      session_id: payload.session_id,
      callback_url: payload.callback_url,
      callback_secret: payload.callback_secret,
    };
    await postProgress(ctx, { type: "status", status: "error", message: `fatal: ${err.message}` });
  } catch {}
  process.exit(1);
});
