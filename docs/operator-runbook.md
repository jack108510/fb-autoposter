# Operator Runbook

Use this before any group joining or posting run.

## 1. Decide whether normal Reachr flow is available

Run the structured control tool first:

```bash
reachrctl status
```

This reports Supabase REST/Auth, the local Chrome runner, the Amplr extension worker,
the local fallback queue, and the latest sanitized campaign snapshot.

For lower-level checks, run:

```bash
curl -sS --max-time 15 https://xacehhtgvubcqdoltazg.supabase.co/rest/v1/ >/dev/null
curl -sS --max-time 15 https://xacehhtgvubcqdoltazg.supabase.co/auth/v1/health >/dev/null
curl -sS --max-time 5 http://127.0.0.1:9223/json/version >/dev/null
```

Interpretation:

| Result | Decision |
|---|---|
| Supabase REST/Auth responds and Chrome debug responds | Continue |
| Supabase REST/Auth timeout or Cloudflare 522 | Do not use normal queue |
| Chrome debug connection refused | Restart runner first |

## 2. Confirm actor before actions

Before joining or posting:

- Open Facebook target page/group.
- Confirm active actor is the intended business identity.
- For Empty Slot, actor must be **Empty Slot**.
- If Facebook shows Jack/personal profile or a different Page, stop.

Proof should be visual when possible: screenshot/capture of the composer, group join context, or profile selector showing the actor.

## 3. Queue/run limits

Default conservative limits until a campaign proves stable:

| Action | Limit |
|---|---:|
| Candidate searches | unlimited/read-only |
| Group joins | 5-10/day until quality is proven |
| Posts | 0 until join quality and actor proof are confirmed |
| Failed retries | stop after 3 similar failures |

## 4. Normal flow checklist

- [ ] Supabase REST works.
- [ ] Supabase Auth/session refresh works.
- [ ] Chrome with Amplr extension is running.
- [ ] Debug endpoint `127.0.0.1:9223` responds.
- [ ] Dashboard/extension session is active.
- [ ] `reachrctl snapshot` has created/updated `~/.reachrctl/snapshots/latest.json` after a successful dashboard data load.
- [ ] Facebook is logged in.
- [ ] Intended actor is visually confirmed.
- [ ] Campaign playbook matches target groups.
- [ ] Jobs are queued and visible.
- [ ] Results are written back.

## 4.1 Structured fallback flow

When Supabase/Auth is degraded but the extension runner can still operate from a
known-good campaign snapshot, use `reachrctl` instead of hand-building jobs:

```bash
reachrctl status
reachrctl snapshot
reachrctl list
reachrctl queue-local <campaign-id> --actor "Empty Slot" --campaign empty-slot-pet-owner-groups --max-groups 5
reachrctl queue-local <campaign-id> --actor "Empty Slot" --campaign empty-slot-pet-owner-groups --max-groups 5 --execute
```

`queue-local` is a dry run unless `--execute` is passed. It filters wrong-actor
groups and, for Empty Slot, excludes lost/missing/rescue/adoption/shelter/
rehoming/breeder/buy-sell groups before inserting into the extension's local
fallback queue.

See `docs/reachrctl.md` for command details.

## 5. If blocked

| Blocker | Action |
|---|---|
| Supabase timeout / 522 | Wait, retry, or use no-Supabase fallback; do not force normal queue |
| Expired session and Auth timeout | Wait or fallback; re-login may not help until Auth recovers |
| Chrome debug down | Restart runner and re-check |
| Actor unclear | Stop and ask/verify |
| Facebook prompts, password, 2FA, permissions | Stop and ask Jack |

## 6. After-run report

Report in plain language:

- what campaign ran
- which actor was used
- groups searched/joined/skipped
- failures and reasons
- next recommended action

Do not include secrets or raw tokens.
