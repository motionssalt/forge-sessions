/**
 * PuterClient — headless driver for puter.ai.chat().
 *
 * Puter.js is a browser-first library. Rather than reverse-engineering their
 * private HTTP endpoints (which change without notice), we run Puter inside
 * a hidden headless Chromium page and exchange JSON via page.evaluate().
 *
 * Why this is worth the ceremony:
 *   - Puter handles credits, model routing, and provider auth for us.
 *   - It gives us free access to Claude / GPT / Gemini families with a
 *     single client library.
 *   - The tool-calling contract is stable across models because Puter
 *     normalizes it OpenAI-style.
 *
 * If Puter's browser SDK ever exposes a first-party Node client, swap the
 * implementation below without changing the call sites in run.js.
 *
 * FIX (2026-08-15): page.evaluate() has no default timeout in Playwright —
 * if the in-page call to window.puter.ai.chat() stalls (upstream hang,
 * throttling, a network blip that never rejects), the evaluate() call used
 * to wait forever. That hang was invisible to puter-pool.js's retry/bench
 * logic, since reportFailure() only ever runs on a *rejected* promise. Now
 * every chat() call races against a hard timeout so a stuck request always
 * turns into a real error the pool can retry against the next account.
 */

import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

// Ceiling for a single model call inside the hidden page. Generous enough
// for slow tool-heavy responses, but bounded so a stall can never hang the
// job forever.
const CHAT_TIMEOUT_MS = 120_000;
// Ceiling for the initial page navigation + SDK-ready wait.
const INIT_TIMEOUT_MS = 30_000;

const PUTER_HOST_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>forge-puter-host</title>
<script src="https://js.puter.com/v2/"></script>
</head><body>
<script>
  window.__forgeReady = new Promise((resolve) => {
    const check = () => {
      if (window.puter && window.puter.ai && typeof window.puter.ai.chat === "function") {
        resolve(true);
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });

  window.__forgeChat = async function(messages, tools, model) {
    await window.__forgeReady;
    const opts = { model: model, tools: tools };
    const res = await window.puter.ai.chat(messages, opts);
    // Normalize: return { message: { role, content, tool_calls? } }
    let msg;
    if (res && res.message) {
      msg = res.message;
    } else if (typeof res === "string") {
      msg = { role: "assistant", content: res };
    } else if (res && res.content) {
      msg = { role: "assistant", content: res.content, tool_calls: res.tool_calls };
    } else {
      msg = { role: "assistant", content: JSON.stringify(res) };
    }
    return { message: msg };
  };
</script>
</body></html>`;

// Small helper: race a promise against a timeout, rejecting with a clearly
// labeled error so callers (and logs) can tell a timeout apart from a real
// upstream error.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class PuterClient {
  constructor({ model }) {
    this.model = model || "claude-sonnet-5";
    this._browser = null;
    this._context = null;
    this._page = null;
    this._hostFile = null;
  }

  async init() {
    if (this._page) return;
    let playwright;
    try {
      playwright = await import("playwright");
    } catch (e) {
      throw new Error(`playwright is required for PuterClient: ${e.message}`);
    }

    // Write the host HTML to a temp file and open it via file://
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-puter-"));
    this._hostFile = path.join(dir, "host.html");
    await fs.writeFile(this._hostFile, PUTER_HOST_HTML, "utf8");

    this._browser = await playwright.chromium.launch({ headless: true, args: ["--no-sandbox"] });
    this._context = await this._browser.newContext();
    this._page = await this._context.newPage();

    // Surface page console for debugging.
    this._page.on("console", msg => {
      const t = msg.type();
      if (t === "error" || t === "warning") {
        console.warn(`[puter/${t}]`, msg.text());
      }
    });
    this._page.on("pageerror", err => console.warn("[puter/pageerror]", err.message));

    console.log("[puter] navigating hidden page to host.html");
    await this._page.goto("file://" + this._hostFile, { timeout: INIT_TIMEOUT_MS });
    // Wait for the Puter SDK to attach. Already had a timeout — kept as-is,
    // just referencing the shared constant for consistency.
    await this._page.waitForFunction(() => window.__forgeReady, null, { timeout: INIT_TIMEOUT_MS });
    console.log("[puter] host page ready");
  }

  async chat({ messages, tools }) {
    if (!this._page) await this.init();
    console.log(`[puter] chat() call starting (model=${this.model})`);
    try {
      // page.evaluate() has NO default timeout in Playwright — this is the
      // fix. Without withTimeout() here, a stalled upstream response inside
      // the page hangs this call (and the whole agent loop) forever.
      const result = await withTimeout(
        this._page.evaluate(
          async ([msgs, tls, mdl]) => window.__forgeChat(msgs, tls, mdl),
          [messages, tools, this.model]
        ),
        CHAT_TIMEOUT_MS,
        "puter chat()"
      );
      console.log("[puter] chat() call resolved");
      return result;
    } catch (err) {
      console.warn("[puter] chat() call failed:", err.message);
      // If we timed out, the in-page call may still be running against a
      // stuck connection. Recycle the whole browser/page so the next
      // attempt (this account or another) starts from a clean slate
      // instead of potentially reusing a wedged page.
      await this.close();
      throw err;
    }
  }

  async close() {
    try { await this._browser?.close(); } catch {}
    this._browser = null;
    this._context = null;
    this._page = null;
  }
}
