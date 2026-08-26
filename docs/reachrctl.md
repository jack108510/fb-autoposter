# ReachrCtl — Structured Campaign Operations Tool

`reachrctl` is the local, structured control tool for Reachr/Amplr campaign operations.

It exists because the dashboard, Supabase Auth, and the extension runner can fail independently. The tool separates those states and gives a repeatable fallback path.

## Location

```bash
/Users/jackserver/fb-autoposter/scripts/reachrctl.py
~/.local/bin/reachrctl
```

## What it does

| Command | Purpose |
|---|---|
| `reachrctl status` | Checks Supabase REST/Auth, Chrome runner, extension worker, local queue, and latest local snapshot. |
| `reachrctl snapshot` | Saves a sanitized local campaign snapshot from the signed-in dashboard or its browser-side local snapshot cache. |
| `reachrctl list` | Lists campaigns from the latest local snapshot. |
| `reachrctl queue-local <campaign>` | Builds a safe extension local-fallback job from a snapshot. Dry-run by default. |

## Normal operating loop

```bash
reachrctl status
reachrctl snapshot
reachrctl list
reachrctl queue-local <campaign-id> --actor "Empty Slot" --campaign empty-slot-pet-owner-groups --max-groups 5
reachrctl queue-local <campaign-id> --actor "Empty Slot" --campaign empty-slot-pet-owner-groups --max-groups 5 --execute
```

## Snapshot behavior

The Reachr dashboard now writes a sanitized browser-side snapshot after successful data loads:

```text
localStorage['reachr_local_campaign_snapshot']
```

`reachrctl snapshot` can read either live dashboard state or that saved browser-side snapshot. This means after one successful dashboard login/data load, later Supabase/Auth failures do not leave campaign ops blind.

Snapshots are saved here:

```text
~/.reachrctl/snapshots/latest.json
```

Snapshots intentionally strip secrets:

- access tokens
- refresh tokens
- passwords
- API keys
- fields containing `token`, `password`, `secret`, `apikey`, or `api_key`

## Local queue behavior

`queue-local` inserts jobs into the Amplr extension's existing local fallback queue:

```text
chrome.storage.local['amplr_local_fallback_jobs']
```

It does not click Facebook itself. The extension runner still performs the actor-aware job execution path.

`queue-local` is a dry run unless `--execute` is passed.

## Safety rules

- Always run `reachrctl status` first.
- Always confirm the actor with `--actor` if the snapshot is ambiguous.
- For Empty Slot, use:

```bash
--campaign empty-slot-pet-owner-groups --actor "Empty Slot"
```

This filters out lost/missing/rescue/adoption/shelter/rehoming/breeder/buy-sell groups and wrong-actor groups before queueing.

- Keep outage fallback low-volume. Default cap is 5 groups.
- Do not post from fallback unless the campaign was already approved and actor proof exists.
- If the extension reports `has_session: false`, queueing can prepare work but the extension still needs a valid session before it can run cloud/local jobs.

## Current blocker interpretation

If `reachrctl status` reports:

```json
"extension_queue": { "has_session": false }
```

then Chrome/extension is alive but the Amplr/Reachr extension is signed out or lacks a valid session. Jack must sign in once; after that run:

```bash
reachrctl snapshot
reachrctl status
```

## Tests

```bash
node scripts/test-dashboard-local-snapshot.js
node scripts/test-dashboard-api-keys.js
node scripts/test-dashboard-identity-switch.js
python3 scripts/test-reachrctl.py
python3 -m py_compile scripts/reachrctl.py scripts/test-reachrctl.py
```
