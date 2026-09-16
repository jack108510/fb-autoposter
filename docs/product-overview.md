# Product Overview

## One-line promise

Reachr/Amplr helps an operator safely find, queue, join, and post into relevant Facebook groups using the correct business identity, with auditability and rate limits.

## Who it is for

| User | Job |
|---|---|
| Jack / operator | Run campaigns without manually tracking every group/action |
| Business Page owner | Reach relevant Facebook communities without wrong-actor mistakes |
| AI assistant/agent | Execute repeatable social workflows with clear safety gates |

## Core jobs-to-be-done

1. Discover candidate Facebook groups for a campaign.
2. Filter groups for audience fit and risk.
3. Queue join/post/import/sync jobs.
4. Run jobs through the Chrome extension against Facebook.
5. Track results, failures, and next actions.
6. Keep identity safe: correct Page/profile every time.

## Product modules

| Module | Responsibility |
|---|---|
| Dashboard (`fb-autoposter`) | Campaign setup, queueing, saved groups, status visibility |
| Supabase | Auth/session, job queue, saved campaign/group data, status/results |
| Chrome extension (`JSW-MultiPost`) | Reads jobs, controls browser/Facebook flow, reports results |
| Runner/watchdog | Keeps Chrome + extension alive and restarts stale workers |
| Campaign playbooks | Define target audiences, exclusions, copy, and limits |

## Non-goals

- No blind mass posting.
- No bypassing actor confirmation for speed.
- No scraping or joining groups that clearly violate campaign targeting.
- No use of personal Jack profile for business Page actions unless explicitly approved.
- No lost-pet, rescue/adoption, animal shelter, missing-pet targeting for the current Empty Slot pet-owner campaign.

## Definition of “proper flow”

A proper Reachr/Amplr run means:

```txt
Dashboard job created
→ Supabase accepts it
→ Extension reads it
→ Chrome/Facebook opens the intended target
→ Active actor is confirmed
→ Action is taken within limit
→ Result is written back
→ Operator can review outcome
```

If any link is unavailable, the system is not in proper flow and should either wait or use the documented fallback.
