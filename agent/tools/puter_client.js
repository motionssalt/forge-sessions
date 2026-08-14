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
 */

import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

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

    await this._page.goto("file://" + this._hostFile);
    // Wait for the Puter SDK to attach.
    await this._page.waitForFunction(() => window.__forgeReady, null, { timeout: 30000 });
  }

  async chat({ messages, tools }) {
    if (!this._page) await this.init();
    // page.evaluate serializes args as JSON — fine for our payloads.
    const result = await this._page.evaluate(
      async ([msgs, tls, mdl]) => window.__forgeChat(msgs, tls, mdl),
      [messages, tools, this.model]
    );
    return result;
  }

  async close() {
    try { await this._browser?.close(); } catch {}
    this._browser = null;
    this._context = null;
    this._page = null;
  }
}
