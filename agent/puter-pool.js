import { init } from "@heyputer/puter.js/src/init.cjs";

// Accounts that fail due to quota or authentication are skipped for this long.
export const BENCH_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_AUTO_WAIT_MS = 60 * 1000;

// FIX (2026-08-15): confirmed by reading @heyputer/puter.js's source
// (src/lib/networkUtils.js / utils.js) that ai.chat() is backed by a raw
// XMLHttpRequest with no `xhr.timeout` set and no 'timeout' event handler
// anywhere in the library. If the server accepts the connection but never
// sends a response and never errors it, the request — and therefore this
// whole agent — hangs forever with no way to detect or recover from it.
// This is true regardless of prompt content; even a plain "hi" goes through
// this exact call.
//
// Since we can't fix the library from here, every call is now wrapped with
// our own timeout at the call site. A timeout is treated as a transient
// failure (not an account-quota failure) so the pool's existing retry loop
// tries the next account immediately instead of benching a healthy one.
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

// Race a promise against a hard timeout. Used to bound the underlying
// library's chat() call, which has no timeout of its own.
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

  // Wrap an account's client so call sites (run.js) don't need to know
  // about the timeout — `pool.getActiveClient()` already returns a client
  // whose `.ai.chat()` is bounded. This preserves the existing call shape
  // `activeAccount.client.ai.chat(messages, opts)` used in run.js.
  _wrapClient(rawClient) {
    const timeoutMs = this.chatTimeoutMs;
    return {
      ...rawClient,
      ai: {
        ...rawClient.ai,
        chat(messages, opts) {
          console.log(`[puter] ai.chat() call starting (timeout=${timeoutMs}ms)`);
          return withTimeout(rawClient.ai.chat(messages, opts), timeoutMs)
            .then(res => {
              console.log("[puter] ai.chat() call resolved");
              return res;
            });
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
    // A timeout is a transient condition (the account itself may be fine —
    // the network or upstream server stalled) so it must NOT bench the
    // account for 15 minutes; that would take a healthy account out of
    // rotation for a one-off stall.
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
