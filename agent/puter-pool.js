import { init } from "@heyputer/puter.js/src/init.cjs";

// Accounts that fail due to quota or authentication are skipped for this long.
export const BENCH_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_AUTO_WAIT_MS = 60 * 1000;

// -----------------------------------------------------------------------------
// Root-cause note (2026-08-15). Do not remove.
// -----------------------------------------------------------------------------
// Symptom: after step 1 completes successfully, step 2's ai.chat() never
// resolves, the 15s heartbeat stops firing, and nothing times out.
//
// Actual cause, verified against @heyputer/puter.js@2.6.1 source
// (src/modules/ai/chat.js, src/lib/networkUtils.js, src/lib/polyfills/xhrshim.js):
//
//   1. puter.ai.chat() has TWO return shapes. When the server responds with
//      Content-Type: application/json (plain conversational replies), the
//      library's sendOnce()/shape() path runs chat.js's `transform` hook and
//      resolves the promise with a real object:  { message: { role, content,
//      tool_calls? } }.
//      When the server responds with Content-Type: application/x-ndjson
//      (which it does whenever the request carries `tools` OR when a prior
//      assistant message already contains tool_calls / tool results), the
//      library resolves the promise with an async iterator (the raw parsed
//      NDJSON line stream). No `.message` wrapper, and the `transform` hook
//      is skipped for streams.
//
//      Our old run.js did `const assistantMsg = resp.message || resp;` and
//      then read `assistantMsg.tool_calls` — on the streaming path that is
//      reading `.tool_calls` off an async generator, which is `undefined`.
//      So the loop silently thought the model returned "no tool calls".
//
//   2. Worse: nothing ever consumed the iterator. Inside puter.js's Node XHR
//      shim (xhrshim.js line ~163), an NDJSON response drives a
//      `for await (const chunk of resp.body)` loop that, on every chunk,
//      does `mergeUint8Arrays(bytes, chunk)` (allocate + copy the whole
//      accumulated buffer) and `parseBody.call(this, bytes)` (full
//      TextDecoder().decode() over the entire accumulated buffer). That is
//      synchronous O(N²) work on the main thread that runs regardless of
//      whether anyone is reading the iterator. Because those microtasks
//      chain back-to-back off the fetch reader, the event loop can't
//      advance to the timer phase — that's why the setInterval heartbeat
//      stopped firing and made this look like a network hang.
//
//   3. It only manifests on iteration 2 in practice because iteration 1's
//      request has no assistant/tool history and takes the buffered-JSON
//      branch on the server; iteration 2's messages array now contains an
//      assistant `tool_calls` message plus a `role: "tool"` result, so the
//      server switches to NDJSON. It is a property of the message shape,
//      not the call index.
//
//   4. It reproduces with tool prompts but "eventually responds" on plain
//      chat because plain chat stays on the buffered-JSON branch, which
//      does not thrash the shim's decoder.
//
// The fix, therefore, has to live at the call site: whenever ai.chat()
// resolves with an async iterable, we MUST drain it (to let the underlying
// fetch reader complete) AND assemble a real assistant message from the
// NDJSON lines before returning to run.js.
//
// The 90s timeout wrapper stays — it now protects a request that legitimately
// stalls upstream, not the shim-thrash case which the drain-and-assemble fix
// resolves at its actual source.
// -----------------------------------------------------------------------------
const CHAT_TIMEOUT_MS = 90_000;

function tokenEntries(env = process.env) {
  return Object.entries(env)
    .map(([name, token]) => {
      const match = /^PUTER_TOKEN_(\d+)$/.exec(name);
      return match && Number(match[1]) > 0 && token?.trim()
        ? { number: Number(match[1]), token: token.trim() }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.number - b.number);
}

function errorText(error) {
  if (!error) return "unknown error";
  if (typeof error === "string") return error;
  const parts = [error.name, error.message, error.code, error.status, error.statusCode];
  try { parts.push(JSON.stringify(error)); } catch {}
  return parts.filter(Boolean).join(" ").toLowerCase();
}

function isAccountFailure(error) {
  const text = errorText(error);
  return /(quota|rate[ -]?limit|usage|allowance|credits?\s*(?:exhausted|depleted|over)|insufficient\s*funds|unauthori[sz]ed|forbidden|invalid\s*(?:auth|token|credential)|authentication|auth\s*failed|token\s*(?:expired|invalid)|account\s*(?:disabled|suspended|blocked))/.test(text);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class ChatTimeoutError extends Error {
  constructor(ms) {
    super(`puter ai.chat() timed out after ${ms}ms with no response`);
    this.name = "ChatTimeoutError";
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ChatTimeoutError(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isAsyncIterable(x) {
  return x != null && typeof x === "object" && typeof x[Symbol.asyncIterator] === "function";
}

// Flatten a puter.js content-part array (as used by some models' streamed
// deltas) into a plain string. `parts` may be a string, an array of
// { type, text } objects, or a mix.
function partsToString(parts) {
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) return "";
  let out = "";
  for (const p of parts) {
    if (typeof p === "string") out += p;
    else if (p && typeof p.text === "string") out += p.text;
  }
  return out;
}

// Drain puter.js's NDJSON line iterator into a single OpenAI-shaped
// assistant message: { role, content, tool_calls? }.
//
// The shape of the individual lines is model/provider dependent (Puter
// normalizes but not to a single dialect), so we accept several dialects:
//   - { text: "..." }                                  (plain content delta)
//   - { content_delta: "..." } / { delta: { content } }
//   - { tool_call: {...} } / { tool_call_delta: {...} }
//   - { message: { content, tool_calls } }             (final buffered line)
//   - { choices: [{ delta: {...} | message: {...} }] } (OpenAI SSE-ish)
//
// A tool_call may arrive whole in one line or as a stream of deltas keyed by
// id; arguments concatenate as strings.
async function drainAssistantStream(stream) {
  let content = "";
  let finalContent = null;
  const toolCallsById = new Map();
  // If a terminal buffered `message` line arrives, treat it as authoritative
  // and DISCARD the accumulated deltas — the two sources describe the same
  // tool_calls and appending would duplicate their arguments strings.
  let finalToolCalls = null;

  const mergeToolCall = (partial) => {
    if (!partial) return;
    const id = partial.id || partial.tool_call_id || `_anon_${toolCallsById.size}`;
    const prev = toolCallsById.get(id) || {
      id,
      type: "function",
      function: { name: "", arguments: "" },
    };
    const fn = partial.function || {};
    if (fn.name) prev.function.name = fn.name;
    if (fn.arguments !== undefined) {
      const a = fn.arguments;
      prev.function.arguments = (prev.function.arguments || "") +
        (typeof a === "string" ? a : JSON.stringify(a));
    }
    if (partial.type && !prev.type) prev.type = partial.type;
    toolCallsById.set(id, prev);
  };

  try {
    for await (const line of stream) {
      if (line == null || typeof line !== "object") continue;

      // Explicit driver errors surface as thrown promises upstream in the
      // buffered path, but on the streaming path they arrive as an
      // in-band line — surface them the same way here.
      if (line.error && (line.error.code || line.error.message)) {
        const err = new Error(line.error.message || line.error.code || "puter streaming error");
        err.code = line.error.code;
        throw err;
      }

      // Content deltas (several dialects).
      if (typeof line.text === "string") content += line.text;
      if (typeof line.content_delta === "string") content += line.content_delta;
      if (line.delta && typeof line.delta.content === "string") content += line.delta.content;
      if (line.type === "content_delta" && typeof line.text === "string") content += line.text;

      // OpenAI-shaped choices[].delta / choices[].message.
      if (Array.isArray(line.choices)) {
        for (const ch of line.choices) {
          if (ch?.delta) {
            if (typeof ch.delta.content === "string") content += ch.delta.content;
            if (Array.isArray(ch.delta.tool_calls)) {
              for (const t of ch.delta.tool_calls) mergeToolCall(t);
            }
          }
          if (ch?.message) {
            if (typeof ch.message.content === "string") finalContent = ch.message.content;
            else if (Array.isArray(ch.message.content)) finalContent = partsToString(ch.message.content);
            if (Array.isArray(ch.message.tool_calls)) {
              finalToolCalls = ch.message.tool_calls;
            }
          }
        }
      }

      // Tool-call deltas at the top level.
      const tc = line.tool_call || line.tool_call_delta;
      if (tc) mergeToolCall(tc);
      if (Array.isArray(line.tool_calls)) {
        for (const t of line.tool_calls) mergeToolCall(t);
      }

      // A terminal buffered "message" line (Puter sometimes emits this as
      // the last NDJSON record on tool-mode responses). It is authoritative
      // and replaces any accumulated tool_call deltas — the two sources
      // describe the same tool_calls, so appending would duplicate the
      // arguments strings.
      if (line.message && typeof line.message === "object") {
        if (typeof line.message.content === "string") finalContent = line.message.content;
        else if (Array.isArray(line.message.content)) finalContent = partsToString(line.message.content);
        if (Array.isArray(line.message.tool_calls)) {
          finalToolCalls = line.message.tool_calls;
        }
      }
    }
  } catch (err) {
    // Ensure we always finish reading the fetch body so the underlying XHR
    // shim closes cleanly — swallow any secondary throw from `return()`.
    try { await stream.return?.(); } catch {}
    throw err;
  }

  const tool_calls = finalToolCalls !== null ? finalToolCalls : [...toolCallsById.values()];
  return {
    role: "assistant",
    content: finalContent !== null ? finalContent : content,
    ...(tool_calls.length ? { tool_calls } : {}),
  };
}

// Normalize whatever ai.chat() resolved into a { message: {...} } object with
// the standard OpenAI-ish shape, regardless of whether puter.js gave us the
// buffered response or the streaming iterator.
export async function normalizeChatResponse(resp) {
  if (isAsyncIterable(resp)) {
    const message = await drainAssistantStream(resp);
    return { message };
  }
  if (resp && typeof resp === "object" && resp.message) {
    const m = resp.message;
    // Flatten a content-parts array so run.js's `.content` reads work.
    if (Array.isArray(m.content)) {
      return { message: { ...m, content: partsToString(m.content) } };
    }
    return { message: m };
  }
  if (typeof resp === "string") {
    return { message: { role: "assistant", content: resp } };
  }
  // Truly unknown — surface it verbatim under content.
  return { message: { role: "assistant", content: JSON.stringify(resp ?? "") } };
}

export class PuterPool {
  constructor({ env = process.env, benchCooldownMs = BENCH_COOLDOWN_MS, chatTimeoutMs = CHAT_TIMEOUT_MS } = {}) {
    const entries = tokenEntries(env);
    if (!entries.length) {
      throw new Error("No Puter auth tokens found. Set at least one PUTER_TOKEN_* environment variable (or GitHub Actions secret), such as PUTER_TOKEN_1.");
    }

    this.benchCooldownMs = benchCooldownMs;
    this.chatTimeoutMs = chatTimeoutMs;
    this.accounts = entries.map(({ number, token }) => ({
      number,
      client: init(token),
      available: true,
      benchedUntil: null,
    }));
    this.nextIndex = 0;
  }

  get size() {
    return this.accounts.length;
  }

  // Wrap an account's client so run.js always gets a normalized
  // { message: {...} } response, whether puter.js streamed or buffered.
  _wrapClient(rawClient) {
    const timeoutMs = this.chatTimeoutMs;
    return {
      ...rawClient,
      ai: {
        ...rawClient.ai,
        chat: async (messages, opts) => {
          console.log(`[puter] ai.chat() call starting (timeout=${timeoutMs}ms)`);
          // The timeout covers the whole request: the resolve-with-iterator
          // moment (headers received) AND the subsequent drain of the
          // NDJSON body. If we only timed the initial resolve, a stream
          // that opens fast then stalls mid-body would still hang.
          const raw = await withTimeout(
            Promise.resolve(rawClient.ai.chat(messages, opts)),
            timeoutMs
          );
          const normalized = await withTimeout(
            normalizeChatResponse(raw),
            timeoutMs
          );
          console.log(
            `[puter] ai.chat() resolved (` +
            `${normalized.message.tool_calls?.length ? `${normalized.message.tool_calls.length} tool_call(s)` : "text"}` +
            `)`
          );
          return normalized;
        },
      },
    };
  }

  async getActiveClient({ exclude = new Set() } = {}) {
    while (true) {
      const now = Date.now();
      const candidates = this.accounts.filter((account, index) => {
        if (exclude.has(index) || !account.available) return false;
        if (account.benchedUntil && account.benchedUntil <= now) {
          account.benchedUntil = null;
          account.available = true;
        }
        return account.available && !account.benchedUntil;
      });

      if (candidates.length) {
        for (let offset = 0; offset < this.accounts.length; offset++) {
          const index = (this.nextIndex + offset) % this.accounts.length;
          const account = this.accounts[index];
          if (candidates.includes(account)) {
            this.nextIndex = (index + 1) % this.accounts.length;
            return { ...account, client: this._wrapClient(account.client), index };
          }
        }
      }

      const soonest = this.accounts
        .filter((account, index) => !exclude.has(index) && account.benchedUntil)
        .map(account => account.benchedUntil)
        .sort((a, b) => a - b)[0];
      const waitMs = soonest ? Math.max(0, soonest - now) : 0;
      if (waitMs > 0 && waitMs <= MAX_AUTO_WAIT_MS && exclude.size === 0) {
        console.log(`[puter] all accounts benched; waiting ${Math.ceil(waitMs / 1000)}s for the next account`);
        await wait(waitMs);
        continue;
      }

      throw new Error("All Puter accounts are currently unavailable for this request. Check the PUTER_TOKEN_* secrets and account quotas.");
    }
  }

  reportFailure(clientIndex, error) {
    const account = this.accounts[clientIndex];
    if (!account) return { benched: false };
    if (error instanceof ChatTimeoutError || error?.name === "ChatTimeoutError") {
      console.warn(`[puter] account #${account.number} chat() timed out; keeping it in rotation: ${error.message}`);
      return { benched: false };
    }
    if (!isAccountFailure(error)) {
      console.warn(`[puter] account #${account.number} transient error; keeping it in rotation: ${errorText(error)}`);
      return { benched: false };
    }

    account.available = false;
    account.benchedUntil = Date.now() + this.benchCooldownMs;
    console.warn(`[puter] benched account #${account.number} until ${new Date(account.benchedUntil).toISOString()}: ${errorText(error)}`);
    return { benched: true };
  }

  reportSuccess(clientIndex) {
    const account = this.accounts[clientIndex];
    if (!account) return;
    account.available = true;
    account.benchedUntil = null;
    console.log(`[puter] account #${account.number} succeeded`);
  }
}

export function createPuterPool(options) {
  return new PuterPool(options);
}
