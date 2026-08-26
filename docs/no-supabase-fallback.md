# No-Supabase Fallback Design

This is the backup path for when Supabase REST/Auth is unavailable. It is not the normal Reachr flow.

## Goal

Allow careful, rate-limited progress without writing to Supabase by using local files and visual confirmation.

## When to use

Use only when:

- Supabase REST/Auth is timing out or returning 522.
- Normal Reachr queue cannot accept jobs.
- Facebook session is available.
- The active actor can be visually confirmed.
- The work is low-volume and safe enough to run manually/local.

Do not use for high-volume posting.

## Local job file

The implemented fallback now has a structured control tool plus browser-side queues.

Primary local tool:

```bash
reachrctl status
reachrctl snapshot
reachrctl list
reachrctl queue-local <campaign-id> --actor "Empty Slot" --campaign empty-slot-pet-owner-groups --max-groups 5 --execute
```

`reachrctl snapshot` stores sanitized campaign state under:

```text
~/.reachrctl/snapshots/latest.json
```

The dashboard also keeps a sanitized browser-local snapshot after successful data
loads:

```text
localStorage['reachr_local_campaign_snapshot']
```

No auth tokens, refresh tokens, API keys, or passwords are stored in these snapshots.

The implemented browser-side fallback uses two durable queues:

| Layer | Storage | Key |
|---|---|---|
| Reachr dashboard | `localStorage` | `amplr_local_fallback_jobs` |
| Amplr extension | `chrome.storage.local` | `amplr_local_fallback_jobs` |
| Amplr extension result log | `chrome.storage.local` | `amplr_local_fallback_results` |

When Supabase job insertion fails, the dashboard sends `QUEUE_LOCAL_FALLBACK_JOB` to the extension. The extension saves the job locally, creates/resumes the `poll-jobs` alarm, and runs pending local jobs through the same identity-verified `executeDashJob()` path. Local jobs are marked with:

```json
{"local_fallback": true, "local_fallback_synced": false}
```

## Older filesystem proposal

Proposed path:

```txt
/Users/jackserver/reachr-local-fallback/jobs/<campaign-slug>.json
```

Example format:

```json
{
  "campaign": "empty-slot-pet-owner-groups",
  "actor": "Empty Slot",
  "mode": "join-only",
  "daily_limit": 5,
  "targets": [
    {
      "query": "New York City pet owners",
      "search_url": "https://www.facebook.com/search/groups/?q=New%20York%20City%20pet%20owners",
      "status": "pending"
    }
  ]
}
```

## Local action log

Proposed path:

```txt
/Users/jackserver/reachr-local-fallback/logs/YYYY-MM-DD.jsonl
```

Example line:

```json
{"ts":"2026-08-24T21:00:00Z","campaign":"empty-slot-pet-owner-groups","actor":"Empty Slot","action":"join_requested","group_name":"Example NYC Pet Owners","source_query":"New York City pet owners","result":"submitted"}
```

## Required visual proof

Before first action each session:

- Capture Facebook actor/profile selector or composer showing **Empty Slot**.
- Capture the target group/search context.
- Do not continue if actor is ambiguous.

## Execution rules

1. Search candidate groups only first.
2. Exclude lost-pet/rescue/adoption/shelter groups for current Empty Slot campaign.
3. Join no more than 5 groups on the first fallback day.
4. Do not post in fallback mode unless Jack explicitly approves after visual proof.
5. Log every action locally.
6. Stop on any Facebook warning, prompt, checkpoint, password, 2FA, or permission dialog.

## Sync back after Supabase recovers

When Supabase is healthy again:

1. Read local JSONL log.
2. Insert summary rows or reconcile statuses.
3. Mark locally completed items as synced.
4. Avoid duplicate joins/posts.

## Why fallback is separate

Normal Reachr is queue-driven and auditable through Supabase. Fallback is local/manual and therefore more fragile. It exists to keep work moving during outages, not to replace the proper product flow.
