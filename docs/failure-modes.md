# Failure Modes

## Supabase REST timeout

**Symptoms**

- Table reads/writes hang.
- Job inserts never complete.
- Dashboard state feels frozen or stale.
- Current observed examples: REST root timeout, table read timeout.

**Checks**

```bash
curl -sS --max-time 15 https://xacehhtgvubcqdoltazg.supabase.co/rest/v1/
```

**Action**

- Do not keep queueing duplicate jobs.
- Use retry job with idempotent marker or wait.
- If work must continue, use no-Supabase fallback with local action log.

## Cloudflare 522 on write

**Symptoms**

- Actual write attempt returns:

```txt
HTTP Error 522
error code: 522
```

**Meaning**

Cloudflare/front door was reached, but the origin/backend did not answer in time.

**Action**

- Treat normal queue as unavailable.
- Avoid repeated high-frequency retries.
- Monitor Supabase status and retry slowly.

## Supabase Auth/JWT issue

**Symptoms**

- Supabase status says `Partially Degraded Service`.
- Incident mentions `401 errors due to JWT rejections`.
- Session token is expired and refresh endpoint times out.

**Checks**

```bash
curl -sS --max-time 15 https://xacehhtgvubcqdoltazg.supabase.co/auth/v1/health
```

**Action**

- Do not assume Jack did anything wrong.
- If token is expired, normal flow may break suddenly because refresh is required.
- Wait/retry or use fallback.

## Chrome debug endpoint down

**Symptoms**

```txt
http://127.0.0.1:9223/json/version → connection refused
http://127.0.0.1:9223/json/list → connection refused
```

**Meaning**

The local Chrome instance with remote debugging is not listening.

**Action**

Restart Amplr runner:

```bash
/Users/jackserver/JSW-MultiPost/scripts/amplr-runner.sh
```

Then verify:

```bash
curl -sS http://127.0.0.1:9223/json/version
```

## Extension session expired

**Symptoms**

- Extension local storage contains expired session.
- Refresh token exists but Auth refresh times out.
- Jobs cannot be reliably read/written.

**Action**

- Do not repeatedly poke Facebook; this is a backend/session issue.
- Wait for Auth, re-open dashboard/extension after recovery, then verify session.

## Wrong actor risk

**Symptoms**

- Facebook UI shows personal profile where business Page should act.
- Composer says “Comment as” or “Post as” the wrong identity.
- Page/group context is ambiguous.

**Action**

- Stop immediately.
- Capture visual proof if needed.
- Switch actor manually or ask Jack.
- Never join/post while actor is ambiguous.

## Group quality mismatch

**Symptoms**

- Campaign is pet-owner targeting but group is lost-pet/rescue/adoption/shelter.
- Group location does not match target city.
- Group is spam-heavy or irrelevant.

**Action**

- Save as skipped candidate.
- Do not join.
- Update campaign playbook if pattern repeats.
