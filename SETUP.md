# Forge — Setup Guide

Written for Victor. Assumes you're comfortable with a browser, a terminal, and Git, but have not personally set up Cloudflare Workers, GitHub Actions secrets, or fine-grained PATs before. Follow it top to bottom — each step depends on the one above.

If something in here doesn't match what you see on screen because a vendor UI has changed since this doc was written, the underlying idea is still what you want; hunt for the equivalent button.

---

## 0. What you're building, in plain language

Three things talk to each other:

1. **Frontend** — a small static website hosted on Cloudflare Pages (or Netlify). You open it in your browser. It looks like a chat app.
2. **Cloudflare Worker** — a tiny script that lives at a URL like `https://forge-worker.<you>.workers.dev`. It doesn't store anything. Its only job is to (a) tell GitHub Actions "start a job", and (b) forward live progress updates from the running job back to your browser.
3. **GitHub** — one repo, `forge-sessions`, which is the *only* place Forge stores anything. Every chat becomes a folder under `sessions/`. A workflow file (`forge-task.yml`) is what actually runs the AI agent, on GitHub's own free Actions runners.

If any one of those three restarts, nothing is lost, because GitHub is the only durable store.

Free-tier friendly:
- Cloudflare Workers: 100k requests/day free.
- Cloudflare Pages: unlimited requests, effectively free for personal use.
- GitHub Actions: 2,000 free minutes/month on public repos, more on private paid plans.
- The AI itself: served through **Puter.js**, which does not charge you per model call in the current model.

---

## 1. Create the `forge-sessions` repo

1. Go to https://github.com/new.
2. Name it `forge-sessions`. Owner: your account.
3. Private is fine. Public is also fine — nothing sensitive lands here **unless** you upload sensitive files via the Forge UI. Assume everything in this repo is as private as the repo itself.
4. "Initialize with a README" — yes.
5. Create.

Now clone this Forge codebase into that repo:

```bash
git clone https://github.com/<you>/forge-sessions.git
cd forge-sessions
# copy the contents of the forge/ folder from this build into the repo root, then:
git add -A
git commit -m "forge: initial import"
git push
```

Then in the repo's **Settings → Actions → General**:

- **Actions permissions**: allow all actions and reusable workflows.
- **Workflow permissions**: "Read and write permissions" + tick "Allow GitHub Actions to create and approve pull requests" (not strictly required, but avoids friction later).

---

## 2. Create the two GitHub PATs you need

Forge uses **two separate** GitHub personal access tokens on purpose. They have different scopes and live in different places. Do not reuse one.

Go to **GitHub → your avatar → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.

### PAT A — the "Worker dispatch" PAT (server side)

- **Token name**: `forge-dispatch`
- **Expiration**: 1 year (or your preference — set a calendar reminder to rotate).
- **Repository access**: "Only select repositories" → pick **only** `forge-sessions`.
- **Repository permissions**:
  - **Contents**: Read and write
  - **Metadata**: Read-only (automatic)
  - **Actions**: Read and write   (this is what lets it fire `repository_dispatch`)
- Generate. Copy the value. You will paste it into a **GitHub Actions repo secret** in step 3 — you will *not* paste it into Forge's frontend.

### PAT B — the "user session" PAT (your browser)

- **Token name**: `forge-user`
- **Expiration**: 90 days is a reasonable default.
- **Repository access**: `forge-sessions`.
- **Repository permissions**:
  - **Contents**: Read and write
  - **Metadata**: Read-only
  - **Actions**: Read and write   (so the Worker can look up run status if needed, and so the checkout step can push back)
- Generate. Copy. You'll paste this into the Forge **Settings** screen in your browser later (step 7).

### PAT C — the optional "target repo" PAT

If (and only if) you plan to have Forge push code into a *different* repo of yours (say `victor/some-app` that you want it to modify), make a third PAT:

- **Token name**: `forge-target-<projectname>`
- **Repository access**: only that one target repo.
- **Repository permissions**: Contents read/write; Metadata read.
- Generate. You'll paste this into the frontend Settings screen too, but in the *separate* "Target-repo PAT" field.

Rule of thumb: never let PAT A into the browser, and never let PAT B or C into a repo secret.

---

## 3. Add the GitHub Actions repo secrets

In the `forge-sessions` repo on GitHub, go to **Settings → Secrets and variables → Actions → New repository secret**. Add these:

| Name | Value |
|---|---|
| `FORGE_DISPATCH_PAT` | PAT A from above |
| `FORGE_CALLBACK_SECRET` | Any random 32+ char string. Generate with `openssl rand -hex 32` or a password manager. |
| `FORGE_SESSIONS_REPO` | `<your-github-username>/forge-sessions` |
| `CLOUDFLARE_API_TOKEN` | (fill in after step 4) |
| `CLOUDFLARE_ACCOUNT_ID` | (fill in after step 4) |

`FORGE_CALLBACK_SECRET` is a shared secret between the GitHub Actions runner and the Cloudflare Worker so random people can't spam the Worker's `/progress` endpoint. Any random string works, as long as both sides use the same one.

---

## 4. Set up Cloudflare

### 4a. Make a Cloudflare account

- Sign up at https://dash.cloudflare.com/sign-up if you don't have one. Free tier is enough.

### 4b. Get your Account ID

- Log into the dashboard. On any Workers or Pages page, the URL contains your account ID, and the account overview screen shows it under "Account ID" in the right sidebar. It's a 32-character hex string.
- Paste it into the `CLOUDFLARE_ACCOUNT_ID` secret you created in step 3.

### 4c. Make a Cloudflare API token

- Go to **My Profile → API Tokens → Create Token**.
- Pick "Create Custom Token".
- **Token name**: `forge-deploy`
- **Permissions** — add these rows:
  - Account · Cloudflare Workers Scripts · Edit
  - Account · Account Settings · Read
  - Account · Cloudflare Pages · Edit
- **Account Resources**: Include → your account.
- **Zone Resources**: leave as "All zones" or "Include specific zone" if you're picky (Workers/Pages don't require a zone for this flow).
- Continue → Create Token. Copy the value.
- Paste it into the `CLOUDFLARE_API_TOKEN` secret in step 3.

### 4d. Create the Pages project (one time)

The `deploy-frontend.yml` workflow needs a Pages project to deploy into. Create it once:

- Dashboard → **Workers & Pages → Create → Pages → Upload assets** (or "Direct Upload") → project name **`forge-ui`** → skip the file upload (we deploy via CI). It's fine if the first deploy is empty; the workflow will overwrite it.

Alternatively, on your laptop:

```bash
npx wrangler login
npx wrangler pages project create forge-ui --production-branch=main
```

---

## 5. Deploy the Worker (auto)

You do NOT deploy the Worker manually. The `deploy-worker.yml` GitHub Actions workflow does it. It runs whenever anything under `worker/` changes on `main`.

Push your initial commit (from step 1) and it will run automatically. Watch it in the **Actions** tab of the repo.

When the run finishes green, your Worker is live at:

```
https://forge-worker.<your-cloudflare-subdomain>.workers.dev
```

Your Workers subdomain is shown on the Cloudflare **Workers & Pages** overview page. If you've never used Workers before, Cloudflare prompts you to pick one on your first deploy.

**Important**: This workflow also seeds the Worker's runtime secrets (`FORGE_DISPATCH_PAT`, `FORGE_CALLBACK_SECRET`, `FORGE_SESSIONS_REPO`) via `wrangler secret put`. That means the values you added in step 3 are automatically pushed to Cloudflare. Nothing to do in the Cloudflare dashboard.

We deliberately don't use Cloudflare's native "connect this Worker to a git repo" feature — it has been unreliable for you in the past. This workflow-based deploy is boring and predictable.

---

## 6. Deploy the frontend (auto)

Same pattern. The `deploy-frontend.yml` workflow deploys `frontend/` to the Cloudflare Pages project `forge-ui` whenever `frontend/` changes on `main`.

After the workflow runs green, your frontend is at:

```
https://forge-ui.pages.dev
```

or, if Cloudflare assigns a preview subdomain, at the URL shown in the Actions logs / Cloudflare Pages dashboard.

---

## 7. First run

1. Open your frontend URL (`https://forge-ui.pages.dev`) in a browser.
2. The Settings modal pops up automatically the first time. Fill in:
   - **Worker URL**: `https://forge-worker.<your-subdomain>.workers.dev` (no trailing slash)
   - **Sessions repo**: `<your-username>/forge-sessions`
   - **Personal GitHub PAT (session storage)**: PAT B
   - **Target-repo PAT** and **Default target repo**: fill in only if you want Forge to push to some *other* repo (PAT C + `owner/repo`). Otherwise leave blank.
3. Save.
4. Click **+ New session**.
5. Type a small test task, e.g.:

   > *Create a Python script that prints the current time, run it, and put the output in a file called `hello.txt` in the outbox.*

6. Hit **Send**. What you should see happen, in order:
   - Within a couple of seconds, a "Status: dispatched — Task dispatched to GitHub Actions" event appears.
   - Go to the `forge-sessions` repo → **Actions** tab → you'll see a `forge-task` run appear and start.
   - Back in the browser, streaming events show up: `🐍 Tool → run_python`, `↩ Result ← run_python (ok)`, `📤 Tool → upload_output_file`, `🏁 Tool → finish`, then a **Status: done** and a final message.
   - The `hello.txt` file appears in the **Outbox** panel with a download link.
   - Refresh the page. The whole history is still there (reconstructed from `sessions/<id>/log.md` on GitHub).
   - Close the tab mid-run and come back in a minute. The run finishes on GitHub regardless; when you reopen, current state is fetched fresh.

If any of that doesn't happen, jump to **Troubleshooting** below.

---

## 8. Troubleshooting

### Progress events don't stream live, but the run does finish on GitHub

- Most likely cause: the SSE connection from your browser to the Worker is being blocked by a corporate proxy or ad blocker. Confirm by opening browser devtools → Network → filter by `stream/`. You should see a connection that stays open and shows text/event-stream data.
- The frontend still falls back to reading state from GitHub on reload, so nothing is lost — you just don't get live updates.
- Try a different network or disable the extension that's stripping SSE.

### The Actions run fails immediately with "Bad credentials"

- The user PAT (PAT B) doesn't have the scopes it needs on the sessions repo. Regenerate it with **Contents: read/write**, **Metadata: read**, **Actions: read/write**.
- The `actions/checkout@v4` step is the one that fails first when this happens.

### The Actions run fails with "repository_dispatch: 404"

- The Worker fired the dispatch to the wrong repo, or the `FORGE_DISPATCH_PAT` doesn't have write access to that repo. Double-check `FORGE_SESSIONS_REPO` and PAT A's scopes.
- To debug the dispatch itself, hit `POST /health` on your Worker to confirm it's alive; then look at the Worker logs in the Cloudflare dashboard (Workers & Pages → forge-worker → Logs → Real-time).

### The Worker returns 401 "Missing or invalid GitHub PAT"

- The PAT you pasted into the Frontend Settings screen is empty, malformed, or expired. Re-paste it. Fine-grained PATs start with `github_pat_`; classic ones start with `ghp_`. Both are accepted.

### The Worker returns 500 "Worker is missing required secrets"

- The `deploy-worker.yml` step that seeds secrets didn't run — most commonly because you haven't set `FORGE_DISPATCH_PAT` / `FORGE_CALLBACK_SECRET` / `FORGE_SESSIONS_REPO` as **repo secrets** in step 3. Set them and re-run the deploy workflow (Actions tab → deploy-worker → Run workflow).

### The agent loops without progressing

- Open `sessions/<id>/log.md` on GitHub. It will show every tool call and its result. If the model keeps calling the same tool with the same args, your prompt is probably ambiguous — cancel from the Actions tab and try again with a clearer prompt.
- The agent has a hard cap of 40 steps; it will terminate itself with an "error" status if it hits that.

### Playwright / Chromium install times out

- First run in a fresh repo can be slow — `npx playwright install --with-deps chromium` fetches ~200 MB. Give it 3-5 minutes on the first task. Subsequent runs use the cached image on the runner.

---

## 9. Security tradeoffs (read this before doing anything unusual)

Forge is deliberately scoped to a **single user (you)**. That lets us skip a lot of authentication machinery:

- Your two personal PATs live in **`localStorage`** in the browser. Anyone who can run JavaScript in that browser origin can read them. Do not open the Forge frontend on a shared computer, and do not deploy the same frontend under a URL that other people log into.
- The Worker's `/task`, `/upload`, and `/delete-session` endpoints trust whatever PAT you send in the Authorization header — they don't cross-check that it belongs to a specific user. That's fine for a personal beta.
- The Worker's `/progress` endpoint is protected by `FORGE_CALLBACK_SECRET`, which lives only in GitHub Actions secrets and in the Worker's own secret store. It is never sent to the frontend and never logged.
- Target-repo PATs (PAT C) are transmitted from the frontend to the Worker in the `X-Forge-Target-Pat` header (not in the JSON body, to keep them out of the Worker's request-log body captures) and are then embedded in the `repository_dispatch` payload so the GitHub Actions runner can use them. This means they briefly transit through GitHub's `repository_dispatch` API. GitHub redacts them from logs, but if you consider this transit unacceptable for a particular PAT, don't use the target-repo feature for that project — check out the code manually.

Before you ever consider letting anyone else use this: swap `localStorage` for a real auth backend, isolate per-user PATs server-side, and add rate limits + abuse controls on every Worker endpoint. See `README.md`'s "future phase" note.

---

## 10. Rotating credentials

- **PAT B (user session)**: paste a new value into Settings. That's it.
- **PAT A (dispatch)** and **`FORGE_CALLBACK_SECRET`**: update the GitHub Actions repo secrets and push any trivial change under `worker/` (or manually trigger `deploy-worker.yml`) — that reseeds the Worker with the new values.
- **Cloudflare API token**: same as above.

Rotating any of these does not lose sessions, because sessions live in GitHub.
