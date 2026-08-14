# sessions/

This folder is **runtime-generated**. Each Forge chat session gets its own subfolder here:

```
sessions/<session-id>/
  inbox/          # Files you uploaded for this session
  outbox/         # Files Forge produced for you to download
  status.json     # Structured current state (task, current step, status)
  log.md          # Human-readable append-only step log
```

Deleting a session = deleting its folder in one commit. There is no other state anywhere else.

Do not manually edit these folders while a session is running — the GitHub Actions runner is committing to them.
