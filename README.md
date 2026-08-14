# Forge

**Forge** is a personal agentic AI tool under the MOTIONSALT brand.

It is a self-hosted, web-based AI assistant (similar in spirit to Manus / Genspark) that lets you chat, hand it tasks (edit code, pull/analyze GitHub repos, process uploaded files, run scripts, drive a headless browser), and watch live step-by-step progress as it works. Because all persistence lives in a GitHub repo, you can close the browser mid-task, come back an hour later, and pick up exactly where you left off.

## The three moving parts

```
Frontend (static site)  <-->  Cloudflare Worker (thin relay)  <-->  GitHub (Actions = compute, repo = storage)
```

1. **Frontend** — a static single-page chat UI. Runs in your browser. Talks to the Worker over HTTPS + SSE. Also reads directly from GitHub via the GitHub REST API to reconstruct history.
2. **Cloudflare Worker** — a pure relay. Zero state. It forwards new tasks from the frontend into a GitHub `repository_dispatch` event, and it forwards live progress updates from the running GitHub Actions job back to the connected browser via Server-Sent Events. Nothing is stored here.
3. **GitHub** — the only durable layer. A repo (`forge-sessions`) holds every session as a folder under `sessions/<session-id>/`. A workflow (`forge-task.yml`) is triggered by `repository_dispatch` and runs the actual agent loop on a GitHub Actions runner. That loop calls Puter.js for LLM inference, executes tools (Python, shell, file edits, git, optional Playwright), streams progress to the Worker in real time, and commits `log.md` / `status.json` back to the repo in batches.

Deleting a session is just deleting its folder from the repo in one commit. There is no other state to clean up.

## Status

This is a **beta / single-user** build for Victor. It is deliberately not multi-tenant. There is no signup, no billing, no per-user auth. Your personal GitHub PAT is stored in `localStorage` in your browser and sent as an `Authorization` header to the Worker — this is fine for a personal single-user tool, but it is **not** production-safe. See SETUP.md for the security tradeoff notes.

A future public / multi-user phase would require:

- Real authentication (OAuth via GitHub, session cookies)
- Per-user PAT isolation, held server-side (never in `localStorage`)
- Rate limiting and abuse controls on the Worker
- Signed short-lived URLs for the file-upload/download flows

Everything in this repo is scoped to phase 1: **make it work end-to-end for one user, self-hosted, free to run.**

## Getting started

See [SETUP.md](./SETUP.md) for the full walkthrough.

## Repo layout

```
forge/
  frontend/                  # Static site (HTML/CSS/JS, no framework)
  worker/                    # Cloudflare Worker source + wrangler.toml
  agent/
    run.js                   # The agent loop (Node)
    tools/                   # Individual tool implementations
  .github/
    workflows/
      forge-task.yml         # repository_dispatch-triggered agent runner
      deploy-worker.yml      # Auto-deploys the Cloudflare Worker
      deploy-frontend.yml    # Auto-deploys the static frontend
  sessions/                  # Created at runtime, one folder per session
```
