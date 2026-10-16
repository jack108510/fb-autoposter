# Partner submissions from Claude Code

The partner key authenticates only the Reachr partner endpoint at `https://n8n.wildeautomations.com/reachr-submit`. One submission stores the ad, checks its links and media, and enters the automatic daily copy test. A daily planner assigns ads to suitable free group inventory using the Rose campaign's local, agency, service, and promotion audiences. It rotates approved campaign schedules and partner ads within a combined target of 400 group submissions per day. Partner jobs are separate from campaign jobs. The key can read job status but cannot edit campaigns or settings, select Facebook groups, or choose a posting identity.

The endpoint runs on Jack's Mac through the existing named Cloudflare tunnel. If that Mac or tunnel is offline, submission fails; Claude Code should retry later with the same `external_id`. The Supabase secret key remains on Jack's Mac and is never given to the partner.

## Operator setup

- The server script is `scripts/reachr-partner-submit-server.py`. It reads the existing `jsw/keys/reachr-supabase.env` data key and a SHA-256 digest in `jsw/keys/reachr-partner-submit.hash`.
- The plaintext partner key is stored only in `jsw/keys/reachr-partner-submit.key` for handoff. Both files must be mode `0600`.
- The named Cloudflare tunnel routes `/reachr-submit` to `127.0.0.1:4193`, before its general n8n route.
- A LaunchAgent keeps the local intake server running. Submission stores the draft and technical checks. Usable ads enter the next daily allocation; an unusable asset remains stored with the reason in the response.
- A second LaunchAgent runs the allocator before 08:00 Halifax time. It chooses whole, previously approved campaign schedules and builds partner jobs of at most eight groups. It avoids assigning the same group twice that day, excludes groups with medium or high ban risk or prior removals, and uses the Wildrose Automations posting identity.
- The first allocation is balanced: 200 campaign and 200 partner group targets. After both pools have at least 100 attempted group deliveries and 30 attributed engaged visits together, up to 100 slots shift toward the better performing pool. Individual copy receives more slots with stronger engaged-visit rates. An ad retires only after at least 50 delivery attempts with no engaged visits while peers have substantial evidence. With too little evidence, allocation stays exploratory.
- The planner stores a dated plan and deterministic job IDs so a retry cannot queue duplicates. If it cannot fill all 400 eligible targets, it stops before changing campaign schedules and reports the shortfall. Reachr's runner still applies its rolling 24-hour cap and posting holds, so 400 planned targets are not a promise of 400 Facebook publications.
- The existing Rose campaign's approved text, image, groups, and identity are not edited. The planner rotates which of its approved schedules are active each day.
- Job status and per-group outcomes appear in **Reachr dashboard → Partner submissions**.
- Rotate access by replacing the key and hash, then restarting the intake service.

## Claude Code use

Set the issued key in the partner's private `REACHR_SUBMIT_KEY` environment variable. Keep it out of prompts, source files, and Git. Give Claude Code this instruction:

> To test a Reachr Facebook group ad, write a JSON file with `title`, `message`, a unique `external_id`, and optional `destination_url`, `image_url`, and `notes`. Run `python3 scripts/submit-partner-post.py path/to/submission.json` once. Reachr stores it, checks the assets, and places it in the next daily group allocation. The response says whether it was accepted. Use `python3 scripts/publish-partner-post.py --status EXTERNAL_ID` to read job outcomes. Do not use the Reachr dashboard, internal MCP token, or general posting APIs.

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

`external_id` is required. Reusing it with identical content safely returns the existing submission; reusing it with changed content is rejected. The destination must be on `wildroseautomations.ca`; images can be hosted at `i.imgur.com`, `jack108510.github.io`, or `wildroseautomations.ca`. All links must use HTTPS. If the message contains no link, Reachr appends the Rose preview link before posting so engaged visits can be attributed to that copy.

A creative quality score does not block the initial test; invalid assets do. Reachr's normal runner still applies its posting safety holds and reports Facebook's actual outcomes. The October 16 nine original partner jobs remain queued separately; the daily allocator starts with the next day's rotation.

Reachr's current post jobs support text plus an optional image. A draft marked as a video post stays stored but cannot be queued from a cover image alone. A draft asking for a Facebook poll is published as a regular text post with the listed choices; the API does not create a native Facebook poll.
