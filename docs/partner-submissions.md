# Partner submissions from Claude Code

The partner key authenticates only the Reachr partner endpoint at `https://n8n.wildeautomations.com/reachr-submit`. One submission stores the ad, checks its links and media, maps it to the active Rose campaign's local, agency, service, or promotion audience, selects three eligible groups outside the active campaign's target list, and queues a separate posting job. The key can also read job status. It cannot read other Reachr data, edit campaigns or settings, select Facebook groups, or choose a posting identity. The new job does not change the active campaign's content or targets.

The endpoint runs on Jack's Mac through the existing named Cloudflare tunnel. If that Mac or tunnel is offline, submission fails; Claude Code should retry later with the same `external_id`. The Supabase secret key remains on Jack's Mac and is never given to the partner.

## Operator setup

- The server script is `scripts/reachr-partner-submit-server.py`. It reads the existing `jsw/keys/reachr-supabase.env` data key and a SHA-256 digest in `jsw/keys/reachr-partner-submit.hash`.
- The plaintext partner key is stored only in `jsw/keys/reachr-partner-submit.key` for handoff. Both files must be mode `0600`.
- The named Cloudflare tunnel routes `/reachr-submit` to `127.0.0.1:4193`, before its general n8n route.
- A LaunchAgent keeps the local intake server running. Submission stores the draft and technical checks, then automatically queues it when the checks pass. If a check or group selection fails, the draft remains stored with the reason in the response.
- Publishing uses the Wildrose Automations Facebook identity, avoids recently used and currently busy groups, and schedules its three targets after the existing campaign's remaining slots for the day. It returns a posting job ID.
- Job status and per-group outcomes appear in **Reachr dashboard → Partner submissions**.
- Rotate access by replacing the key and hash, then restarting the intake service.

## Claude Code use

Set the issued key in the partner's private `REACHR_SUBMIT_KEY` environment variable. Keep it out of prompts, source files, and Git. Give Claude Code this instruction:

> To create a Reachr Facebook group post, write a JSON file with `title`, `message`, a unique `external_id`, and optional `destination_url`, `image_url`, and `notes`. Run `python3 scripts/submit-partner-post.py path/to/submission.json` once. Reachr stores it, checks the assets, chooses eligible groups, and schedules it automatically. The command prints the selected audience, groups, and scheduled time. Use `python3 scripts/publish-partner-post.py --status EXTERNAL_ID` to read job outcomes. Do not use the Reachr dashboard, internal MCP token, or general posting APIs.

Example submission:

```json
{
  "title": "October service offer",
  "message": "Draft text for Jack to review.",
  "destination_url": "https://wildroseautomations.ca/",
  "image_url": "https://i.imgur.com/your-image.png",
  "notes": "Suggested for local homeowner groups; Reachr chooses eligible groups.",
  "external_id": "partner-october-offer-1"
}
```

`external_id` is required. Reusing it with identical content safely returns the existing job or retries scheduling a draft that was stored but could not be queued; reusing it with changed content is rejected. The destination must be on `wildroseautomations.ca`; images can be hosted at `i.imgur.com`, `jack108510.github.io`, or `wildroseautomations.ca`. All links must use HTTPS.

For older stored drafts, `python3 scripts/publish-partner-post.py EXTERNAL_ID` retries scheduling without resubmitting content. A creative quality score does not block publishing; invalid assets or unavailable eligible groups do. Reachr's normal runner still applies its posting safety holds and reports Facebook's actual outcomes.

Reachr's current post jobs support text plus an optional image. A draft marked as a video post stays stored but cannot be queued from a cover image alone. A draft asking for a Facebook poll is published as a regular text post with the listed choices; the API does not create a native Facebook poll.
