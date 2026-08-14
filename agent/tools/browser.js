/**
 * browser_action tool. Backed by Playwright (headless Chromium).
 *
 * Playwright is installed by the workflow ONLY when the initial task
 * classification decided the task needs a browser — otherwise this tool
 * returns a soft error so the model can plan without it.
 *
 * We keep a singleton browser across calls in this process so multiple
 * browser_action tool calls in one agent run don't each pay startup cost.
 */

import fs from "node:fs/promises";
import path from "node:path";

let _browser = null;
let _context = null;
let _page = null;

async function ensureBrowser(opts) {
  if (_page) return _page;
  if (!opts.wantBrowser) {
    throw new Error("browser was not provisioned for this task (classifier said no); rerun with an explicit browser cue in your prompt");
  }
  let playwright;
  try {
    playwright = await import("playwright");
  } catch (e) {
    throw new Error(`playwright not installed: ${e.message}`);
  }
  _browser = await playwright.chromium.launch({ headless: true });
  _context = await _browser.newContext();
  _page = await _context.newPage();
  return _page;
}

export async function browserAction(args, ctx, opts = {}) {
  try {
    const page = await ensureBrowser(opts);
    const a = args.action;
    switch (a) {
      case "goto": {
        if (!args.url) return { ok: false, error: "url required for goto" };
        const resp = await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        return { ok: true, summary: `goto ${args.url} -> ${resp?.status()}` };
      }
      case "click": {
        if (!args.selector) return { ok: false, error: "selector required for click" };
        await page.click(args.selector, { timeout: 10000 });
        return { ok: true, summary: `clicked ${args.selector}` };
      }
      case "type": {
        if (!args.selector) return { ok: false, error: "selector required for type" };
        await page.fill(args.selector, args.text ?? "");
        return { ok: true, summary: `typed into ${args.selector}` };
      }
      case "get_text": {
        const sel = args.selector || "body";
        const text = await page.locator(sel).innerText({ timeout: 10000 });
        const trimmed = text.length > 20_000 ? text.slice(0, 20_000) + "... [truncated]" : text;
        return { ok: true, text: trimmed, summary: `got ${trimmed.length} chars from ${sel}` };
      }
      case "screenshot": {
        const outbox = ctx.outboxDir;
        await fs.mkdir(outbox, { recursive: true });
        const file = path.join(outbox, `screenshot-${Date.now()}.png`);
        await page.screenshot({ path: file, fullPage: true });
        return { ok: true, path: file, summary: `screenshot saved to ${file}` };
      }
      case "wait": {
        const ms = Math.min(Math.max(Number(args.ms) || 1000, 0), 30000);
        await page.waitForTimeout(ms);
        return { ok: true, summary: `waited ${ms}ms` };
      }
      default:
        return { ok: false, error: `unknown browser action: ${a}` };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
