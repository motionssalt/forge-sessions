/**
 * Forge agent loop.
 *
 * This script runs inside GitHub Actions (see .github/workflows/forge-task.yml).
 * It is dispatched with a client_payload containing:
 *   session_id, task_prompt, model, user_pat, target_repo?, target_repo_pat?,
 *   callback_url, callback_secret
 *
 * Responsibilities:
 *   1. Read task + session context (bootstrap sessions/<id>/ if new).
 *   2. Define tools the model can call: run_python, run_shell, read_file,
 *      write_file, edit_file, git_commit_push, browser_action,
 *      upload_output_file, finish.
 *   3. Call Puter.js `puter.ai.chat()` with those tools. Loop:
 *        model -> tool_calls -> execute -> POST progress -> feed result back
 *      until the model returns a plain text final answer (or calls `finish`).
 *   4. Batch git commits of log.md / status.json every 3-5 steps or 30s.
 *   5. On completion, commit final state + outbox contents and post a final
 *      progress update.
 *
 * Puter.js is a browser library; from a headless Node runner we drive it via a
 * lightweight Playwright/Chromium harness (see tools/puter_client.js). This
 * keeps the whole "which LLM provider are we using" question out of the agent
 * loop — Puter handles model selection + credit-free inference.
 *
 * Everything here is intentionally readable — this is a personal beta.
 */

import fs from "node:fs/promises";
import fss from "node:fs";
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
// Read dispatch payload from env. The forge-task.yml workflow writes the
// entire client_payload JSON to $FORGE_PAYLOAD.
// -----------------------------------------------------------------------------
function readPayload() {
  const raw = process.env.FORGE_PAYLOAD;
  if (!raw) throw new Error("FORGE_PAYLOAD not set");
  try { return JSON.parse(raw); } catch (e) { throw new Error("FORGE_PAYLOAD is not valid JSON: " + e.message); }
}

// -----------------------------------------------------------------------------
// Tool schema exposed to the LLM. Keep the shape close to OpenAI-style
// function-calling — Puter.js accepts this format for its Anthropic / OpenAI
// / etc. backends.
// -----------------------------------------------------------------------------
const TOOL_SCHEMA = [
  {
    type: "function",
    function: {
      name: "run_python",
      description: "Run a Python 3 script. Returns stdout, stderr, and exit code. Working dir is the session workspace.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "Python source code to execute." },
          timeout_sec: { type: "number", description: "Timeout in seconds (default 120, max 600)." },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      description: "Run a bash shell command in the session workspace. Returns stdout, stderr, exit code.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Bash command line." },
          timeout_sec: { type: "number" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 file from the session workspace (or an absolute path inside the runner).",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write a UTF-8 file (overwrites). Path is relative to the session workspace unless absolute.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Apply a single find/replace to an existing UTF-8 file. old_string must match exactly once (unless replace_all is true).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          replace_all: { type: "boolean" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_commit_push",
      description: "Stage, commit, and push. If target_repo was supplied at dispatch, this pushes to that repo (using target_repo_pat). Otherwise it commits to the sessions repo.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string" },
          paths: { type: "array", items: { type: "string" }, description: "Optional list of paths to stage. Omit to stage all changes." },
          to_target_repo: { type: "boolean", description: "If true, push to target_repo instead of sessions repo." },
        },
        required: ["message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_action",
      description: "Drive a headless Chromium browser (Playwright). Actions: goto, click, type, screenshot, get_text, wait.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["goto", "click", "type", "screenshot", "get_text", "wait"] },
          url: { type: "string" },
          selector: { type: "string" },
          text: { type: "string" },
          ms: { type: "number" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "upload_output_file",
      description: "Move a file into the session's outbox/ so the user can download it from the Forge UI.",
      parameters: {
        type: "object",
        properties: {
          source_path: { type: "string" },
          dest_name: { type: "string" },
        },
        required: ["source_path", "dest_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "Signal that the task is complete. Provide a final human-readable answer for the user.",
      parameters: {
        type: "object",
        properties: { final_message: { type: "string" } },
        required: ["final_message"],
      },
    },
  },
];

// -----------------------------------------------------------------------------
// Task classifier — decides whether we need Playwright (browser). Kept
// simple/heuristic so we don't waste minutes installing Chromium every run.
// -----------------------------------------------------------------------------
function needsBrowser(prompt) {
  const p = (prompt || "").toLowerCase();
  return /\b(browser|scrape|crawl|screenshot|puppeteer|playwright|headless|open the (page|site|url)|render (this|the) page)\b/.test(p);
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------
async function main() {
  const payload = readPayload();
  const {
    session_id, task_prompt, model,
    user_pat, target_repo, target_repo_pat,
    callback_url, callback_secret,
  } = payload;

  // Heartbeat: prints every 15s for the life of the process so a stall
  // anywhere (including inside a library call we don't control, like
  // @heyputer/puter.js's XHR-based ai.chat()) is visible in the Actions log
  // as "process is alive but not progressing" rather than total silence.
  // Diagnostic only — does not affect control flow.
  let step = 0;
  const heartbeatTimer = setInterval(() => {
    console.log(`[forge/agent] heartbeat: still running, step=${step}`);
  }, 15_000);
  heartbeatTimer.unref?.();

  const workspaceRoot = process.env.GITHUB_WORKSPACE || process.cwd();
  const sessionDir = path.join(workspaceRoot, "sessions", session_id);
  const inboxDir = path.join(sessionDir, "inbox");
  const outboxDir = path.join(sessionDir, "outbox");

  await fs.mkdir(inboxDir, { recursive: true });
  await fs.mkdir(outboxDir, { recursive: true });

  const ctx = {
    session_id,
    workspaceRoot,
    sessionDir,
    inboxDir,
    outboxDir,
    user_pat,
    target_repo,
    target_repo_pat,
    callback_url,
    callback_secret,
    logBuffer: [],
    // We batch commits every N steps or every T ms — whichever hits first.
    commitBatch: { stepsSinceCommit: 0, lastCommitMs: Date.now(), maxSteps: 4, maxMs: 30_000 },
  };

  // Initial status.json
  await writeStatus(ctx, {
    session_id,
    task_prompt,
    model: model || "claude-sonnet-5",
    status: "running",
    current_step: 0,
    started_at: new Date().toISOString(),
  });
  await appendLog(ctx, `# Session ${session_id}\n\n**Task:** ${task_prompt}\n\n**Model:** ${model || "claude-sonnet-5"}\n\n---\n`);
  await postProgress(ctx, { type: "status", status: "running", message: "Agent booted, initializing tools..." });

  // Enumerate existing inbox files so the model knows what the user gave it.
  let inboxFiles = [];
  try {
    inboxFiles = (await fs.readdir(inboxDir)).filter(f => !f.startsWith("."));
  } catch {}

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

    // Retry this same logical model request across each account that is
    // currently available. Account failures may be benched by the pool;
    // transient errors (including a chat() timeout — see puter-pool.js)
    // remain eligible for later requests.
    let resp = null;
    let activeAccount = null;
    const attemptedAccounts = new Set();
    let lastError = null;
    while (attemptedAccounts.size < puterPool.size) {
      activeAccount = await puterPool.getActiveClient({ exclude: attemptedAccounts });
      attemptedAccounts.add(activeAccount.index);
      try {
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
      // Every account either errored or timed out on this request. Fail the
      // step loudly (and non-zero exit at the end) rather than hanging —
      // this is the terminal case the timeout fix guarantees we reach.
      const reason = `All Puter accounts failed for this model request: ${lastError?.message || lastError || "unknown error"}`;
      console.error(`[forge/agent] step ${step}: ${reason}`);
      throw new Error(reason);
    }
    console.log(`[forge/agent] step ${step}: got model response from account #${ctx.currentPuterAccount}`);

    // Puter returns an assistant message with optional tool_calls.
    const assistantMsg = resp.message || resp;
    messages.push(assistantMsg);

    const toolCalls = assistantMsg.tool_calls || [];
    if (!toolCalls.length) {
      // Plain text final answer, without an explicit finish() call.
      finalMessage = typeof assistantMsg.content === "string"
        ? assistantMsg.content
        : (assistantMsg.content?.[0]?.text || "(no message)");
      await postProgress(ctx, { type: "step", step, message: `Model returned final message` });
      break;
    }

    // Execute each tool call sequentially.
    for (const call of toolCalls) {
      const name = call.function?.name || call.name;
      let args = {};
      try { args = typeof call.function?.arguments === "string" ? JSON.parse(call.function.arguments) : (call.function?.arguments || call.arguments || {}); }
      catch { args = {}; }

      await postProgress(ctx, {
        type: "tool_call",
        step,
        tool: name,
        args_preview: previewArgs(args),
      });
      await appendLog(ctx, `\n## Step ${step}: \`${name}\` (using Puter account #${ctx.currentPuterAccount})\n\n\`\`\`json\n${JSON.stringify(args, null, 2).slice(0, 1500)}\n\`\`\`\n`);

      let result;
      try {
        result = await dispatchTool(name, args, ctx, { wantBrowser });
      } catch (err) {
        result = { ok: false, error: err && err.message ? err.message : String(err) };
      }

      await postProgress(ctx, {
        type: "tool_result",
        step,
        tool: name,
        ok: !!result.ok,
        preview: previewResult(result),
      });
      await appendLog(ctx, `\n**Result:** ${result.ok ? "ok" : "error"}\n\n\`\`\`\n${(result.summary || result.error || "").toString().slice(0, 1500)}\n\`\`\`\n`);

      // Feed the tool result back into the conversation.
      messages.push({
        role: "tool",
        tool_call_id: call.id || `${name}-${step}`,
        name,
        content: JSON.stringify(result).slice(0, 24_000),
      });

      // Early exit if the model called `finish`.
      if (name === "finish" && result.ok) {
        finalMessage = args.final_message || "(finished)";
      }
    }

    // Batch-commit local state (log.md, status.json) periodically.
    await commitStateBatched(ctx, { step });

    if (finalMessage !== null) break;
  }

  const status = finalMessage ? "done" : "error";
  const message = finalMessage || `Aborted: exceeded max steps (${maxSteps})`;

  await writeStatus(ctx, {
    session_id,
    task_prompt,
    model: model || "claude-sonnet-5",
    status,
    current_step: step,
    finished_at: new Date().toISOString(),
    final_message: message,
  });
  await appendLog(ctx, `\n---\n\n**Status:** ${status}\n\n**Final message:**\n\n${message}\n`);

  // Force a final commit regardless of the batch counter.
  ctx.commitBatch.stepsSinceCommit = ctx.commitBatch.maxSteps + 1;
  await commitStateBatched(ctx, { step, force: true });

  await postProgress(ctx, {
    type: "status",
    status,
    message,
    step,
  });

  // Exit non-zero on error so the Actions run is flagged red.
  clearInterval(heartbeatTimer);
  if (status === "error") process.exit(2);
}

// -----------------------------------------------------------------------------
// Tool dispatch
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
