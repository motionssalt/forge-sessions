/**
 * Forge Puter driver (v2 — 2026-08-15 rewrite).
 *
 * Replaces the previous @heyputer/puter.js + NDJSON-drain approach, which
 * silently returned empty assistant messages whenever the response came back
 * as a stream (the tool-call path). The old code tried to reimplement the
 * SDK's stream handling by hand in Node; puter.js is browser-first and the
 * shim it ships for Node does not carry the tool-calling contract through
 * reliably, so tool_calls arrived as `undefined` and the agent thought
 * "the model returned no tool calls" every time.
 *
 * This driver takes a different approach: it loads the real Puter browser
 * SDK inside a real headless Chromium page (via Playwright) and does the
 * ai.chat() call from inside the page, where tool-calling is well tested.
 * The Node side just marshals JSON in and out. This is the same trick the
 * puter.com playground itself uses, and it works.
 *
 * A pool of accounts (PUTER_TOKEN_1..N) is supported: on quota / auth
 * failures the account is benched for BENCH_COOLDOWN_MS and the next
 * available account is used.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const BENCH_COOLDOWN_MS = 15 * 60 * 1000;
const CHAT_TIMEOUT_MS = 120_000;
const INIT_TIMEOUT_MS = 45_000;

// -----------------------------------------------------------------------------
// The host page. Loads Puter's real browser SDK from js.puter.com and exposes
// two helpers on window:
//   __forgeAuth(token) -> Promise<void>   set the auth token before any call
//   __forgeChat({messages, tools, model}) -> Promise<{message}>
// The chat helper normalizes puter.js's various return shapes down to a
// single OpenAI-style { message: { role, content, tool_calls? } } object.
// -----------------------------------------------------------------------------
const HOST_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>forge-puter-host</title>
<script src="https://js.puter.com/v2/"></script>
</head><body>
<script>
window.__forgeReady = new Promise((resolve) => {
  const t0 = Date.now();
  (function poll() {
    if (window.puter && window.puter.ai && typeof window.puter.ai.chat === "function") return resolve(true);
    if (Date.now() - t0 > 30000) return resolve(false);
    setTimeout(poll, 50);
  })();
});

window.__forgeAuth = async function(token) {
  await window.__forgeReady;
  // Puter exposes a few ways to inject an existing token depending on
  // build; try each in order.
  try {
    if (window.puter.setAuthToken) return window.puter.setAuthToken(token);
  } catch (e) {}
  try {
    if (window.puter.auth && window.puter.auth.setToken) return window.puter.auth.setToken(token);
  } catch (e) {}
  try {
    // Persist to storage where the SDK looks on next call.
    localStorage.setItem("puter.auth.token", token);
  } catch (e) {}
};

// Convert content-parts arrays into a plain string. Some providers stream
// deltas back as [{type:"text", text:"..."}, ...]; the agent expects a flat
// string in .content.
function partsToText(c) {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  let out = "";
  for (const p of c) {
    if (typeof p === "string") out += p;
    else if (p && typeof p.text === "string") out += p.text;
  }
  return out;
}

async function drainStream(stream) {
  // The browser SDK's streaming return value is an async iterable of parts.
  // We fold it into one { role, content, tool_calls? }.
  let content = "";
  let finalContent = null;
  let finalToolCalls = null;
  const toolCallsById = new Map();

  const mergeCall = (partial) => {
    if (!partial) return;
    const id = partial.id || partial.tool_call_id || ("_a_" + toolCallsById.size);
    const prev = toolCallsById.get(id) || {
      id, type: "function", function: { name: "", arguments: "" }
    };
    const fn = partial.function || {};
    if (fn.name) prev.function.name = fn.name;
    if (fn.arguments !== undefined) {
      const a = fn.arguments;
      prev.function.arguments =
        (prev.function.arguments || "") +
        (typeof a === "string" ? a : JSON.stringify(a));
    }
    if (partial.type && !prev.type) prev.type = partial.type;
    toolCallsById.set(id, prev);
  };

  for await (const line of stream) {
    if (!line || typeof line !== "object") continue;

    if (typeof line.text === "string") content += line.text;
    if (typeof line.content_delta === "string") content += line.content_delta;
    if (line.delta && typeof line.delta.content === "string") content += line.delta.content;

    if (Array.isArray(line.choices)) {
      for (const ch of line.choices) {
        if (ch && ch.delta) {
          if (typeof ch.delta.content === "string") content += ch.delta.content;
          if (Array.isArray(ch.delta.tool_calls)) for (const t of ch.delta.tool_calls) mergeCall(t);
        }
        if (ch && ch.message) {
          if (typeof ch.message.content === "string") finalContent = ch.message.content;
          else if (Array.isArray(ch.message.content)) finalContent = partsToText(ch.message.content);
          if (Array.isArray(ch.message.tool_calls)) finalToolCalls = ch.message.tool_calls;
        }
      }
    }

    if (line.tool_call || line.tool_call_delta) mergeCall(line.tool_call || line.tool_call_delta);
    if (Array.isArray(line.tool_calls)) for (const t of line.tool_calls) mergeCall(t);

    if (line.message && typeof line.message === "object") {
      if (typeof line.message.content === "string") finalContent = line.message.content;
      else if (Array.isArray(line.message.content)) finalContent = partsToText(line.message.content);
      if (Array.isArray(line.message.tool_calls)) finalToolCalls = line.message.tool_calls;
    }
  }

  const tool_calls = finalToolCalls !== null ? finalToolCalls : Array.from(toolCallsById.values());
  return {
    role: "assistant",
    content: finalContent !== null ? finalContent : content,
    ...(tool_calls.length ? { tool_calls } : {}),
  };
}

window.__forgeChat = async function({messages, tools, model}) {
  const ready = await window.__forgeReady;
  if (!ready) throw new Error("puter SDK failed to load in host page");
  const opts = { model: model || "claude-sonnet-5" };
  if (tools && tools.length) opts.tools = tools;

  let res;
  try {
    res = await window.puter.ai.chat(messages, opts);
  } catch (err) {
    // Surface a plain JSON-safe error message.
    throw new Error("puter.ai.chat threw: " + (err && err.message ? err.message : String(err)));
  }

  // Normalize every shape puter.js may return:
  //   1) { message: { role, content, tool_calls? } }   (buffered JSON)
  //   2) async iterable of stream lines                (streaming)
  //   3) plain string                                  (legacy)
  //   4) { content, tool_calls? }                      (undocumented)
  if (res && typeof res === "object" && res[Symbol.asyncIterator]) {
    const msg = await drainStream(res);
    return { message: msg };
  }
  if (res && typeof res === "object" && res.message) {
    const m = res.message;
    if (Array.isArray(m.content)) m.content = partsToText(m.content);
    return { message: m };
  }
  if (typeof res === "string") {
    return { message: { role: "assistant", content: res } };
  }
  if (res && typeof res === "object") {
    return { message: {
      role: "assistant",
      content: typeof res.content === "string" ? res.content : partsToText(res.content),
      ...(Array.isArray(res.tool_calls) ? { tool_calls: res.tool_calls } : {}),
    }};
  }
  return { message: { role: "assistant", content: String(res ?? "") } };
};
</script>
</body></html>`;

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function errText(e) {
  if (!e) return "unknown";
  if (typeof e === "string") return e;
  const parts = [e.name, e.message, e.code, e.status, e.statusCode].filter(Boolean).join(" ");
  return parts.toLowerCase();
}

function isAccountFailure(e) {
  const t = errText(e);
  return /(quota|rate.?limit|usage|allowance|credits?\s*(?:exhausted|depleted|over)|insufficient\s*funds|unauthori[sz]ed|forbidden|invalid\s*(?:auth|token|credential)|authentication|auth\s*failed|token\s*(?:expired|invalid)|account\s*(?:disabled|suspended|blocked))/.test(t);
}

function tokenEntries(env = process.env) {
  return Object.entries(env)
    .map(([name, token]) => {
      const m = /^PUTER_TOKEN_(\d+)$/.exec(name);
      return m && Number(m[1]) > 0 && token && token.trim()
        ? { number: Number(m[1]), token: token.trim() }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.number - b.number);
}

// -----------------------------------------------------------------------------
// The pool. One shared Playwright browser + one page per account (lazy-inited).
// -----------------------------------------------------------------------------
class PuterPool {
  constructor({ env = process.env, benchCooldownMs = BENCH_COOLDOWN_MS } = {}) {
    const entries = tokenEntries(env);
    if (!entries.length) {
      throw new Error("No Puter auth tokens found. Set at least one PUTER_TOKEN_* environment variable.");
    }
    this.benchCooldownMs = benchCooldownMs;
    this.accounts = entries.map(({ number, token }, idx) => ({
      index: idx,
      number,
      token,
      page: null,
      benchedUntil: null,
    }));
    this._browser = null;
    this._hostFile = null;
    this._nextIndex = 0;
  }

  get size() { return this.accounts.length; }

  async _ensureBrowser() {
    if (this._browser) return;
    let playwright;
    try {
      playwright = await import("playwright");
    } catch (e) {
      throw new Error(`playwright is required: ${e.message}`);
    }
    const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-puter-"));
    this._hostFile = path.join(tmpdir, "host.html");
    await fs.writeFile(this._hostFile, HOST_HTML, "utf8");
    this._browser = await playwright.chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    console.log("[puter] chromium launched, host file =", this._hostFile);
  }

  async _ensurePage(account) {
    if (account.page) return account.page;
    await this._ensureBrowser();
    const context = await this._browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", err => console.warn(`[puter/account#${account.number}/pageerror]`, err.message));
    page.on("console", msg => {
      const t = msg.type();
      if (t === "error" || t === "warning") {
        console.warn(`[puter/account#${account.number}/${t}]`, msg.text());
      }
    });

    // Prime localStorage with the token BEFORE the SDK loads, so the SDK
    // sees it during init. We do this by first navigating to an about:blank
    // origin equivalent for our file:// host, then setting storage, then
    // reloading into the real host page.
    const fileUrl = "file://" + this._hostFile;
    await page.goto(fileUrl, { timeout: INIT_TIMEOUT_MS });
    // Wait until the SDK is available.
    await page.waitForFunction(() => window.__forgeReady, null, { timeout: INIT_TIMEOUT_MS });
    // Push the token in.
    await page.evaluate(async (tok) => window.__forgeAuth(tok), account.token);
    // Small settle time so any post-auth internal init completes.
    await page.waitForTimeout(100);
    account.page = page;
    console.log(`[puter] account #${account.number} page ready`);
    return page;
  }

  async _pickAvailable(exclude) {
    const now = Date.now();
    for (const a of this.accounts) {
      if (a.benchedUntil && a.benchedUntil <= now) {
        a.benchedUntil = null;
      }
    }
    const available = this.accounts.filter(a => !exclude.has(a.index) && !a.benchedUntil);
    if (!available.length) return null;
    // round-robin
    for (let i = 0; i < this.accounts.length; i++) {
      const idx = (this._nextIndex + i) % this.accounts.length;
      const cand = this.accounts[idx];
      if (available.includes(cand)) {
        this._nextIndex = (idx + 1) % this.accounts.length;
        return cand;
      }
    }
    return available[0];
  }

  /**
   * chat(messages, {tools, model}) — returns { message: {...}, account }.
   * Automatically rotates through accounts on account-level failures.
   * Throws only when every account has been exhausted for this call.
   */
  async chat(messages, { tools, model } = {}) {
    const exclude = new Set();
    let lastError = null;
    while (exclude.size < this.accounts.length) {
      const account = await this._pickAvailable(exclude);
      if (!account) break;
      exclude.add(account.index);
      try {
        const page = await this._ensurePage(account);
        console.log(`[puter] chat() -> account #${account.number} model=${model || "claude-sonnet-5"} tools=${(tools || []).length}`);
        const result = await withTimeout(
          page.evaluate(
            async ({ msgs, tls, mdl }) => window.__forgeChat({ messages: msgs, tools: tls, model: mdl }),
            { msgs: messages, tls: tools || [], mdl: model || "claude-sonnet-5" }
          ),
          CHAT_TIMEOUT_MS,
          `puter chat() on account #${account.number}`
        );
        console.log(`[puter] chat() OK on #${account.number} (${result?.message?.tool_calls?.length ? result.message.tool_calls.length + " tool_call(s)" : "text"})`);
        return { message: result.message, account };
      } catch (err) {
        lastError = err;
        console.warn(`[puter] chat() failed on #${account.number}: ${err.message}`);
        if (isAccountFailure(err)) {
          account.benchedUntil = Date.now() + this.benchCooldownMs;
          console.warn(`[puter] benching account #${account.number} until ${new Date(account.benchedUntil).toISOString()}`);
        }
        // Recycle the page in case it's wedged.
        try { await account.page?.context()?.close(); } catch {}
        account.page = null;
      }
    }
    throw new Error(`All Puter accounts failed for this request: ${lastError?.message || lastError || "unknown"}`);
  }

  async close() {
    try { await this._browser?.close(); } catch {}
    this._browser = null;
  }
}

export function createPuterPool(opts) {
  return new PuterPool(opts);
}
