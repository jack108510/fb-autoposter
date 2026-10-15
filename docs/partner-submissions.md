# Partner submissions from Claude Code

The partner key authenticates only the Reachr intake endpoint at `https://n8n.wildeautomations.com/reachr-submit`. It can add a draft to the existing Reachr data store. It cannot read Reachr data, edit campaigns, select Facebook groups, or start a posting job. Jack reviews drafts in **Reachr dashboard → Partner submissions** and chooses the identity, groups, timing, and approval in **New Post**.

The endpoint runs on Jack's Mac through the existing named Cloudflare tunnel. If that Mac or tunnel is offline, submission fails; Claude Code should retry later with the same `external_id`. The Supabase secret key remains on Jack's Mac and is never given to the partner.

## Operator setup

- The server script is `scripts/reachr-partner-submit-server.py`. It reads the existing `jsw/keys/reachr-supabase.env` data key and a SHA-256 digest in `jsw/keys/reachr-partner-submit.hash`.
- The plaintext partner key is stored only in `jsw/keys/reachr-partner-submit.key` for handoff. Both files must be mode `0600`.
- The named Cloudflare tunnel routes `/reachr-submit` to `127.0.0.1:4193`, before its general n8n route.
- A LaunchAgent keeps the local intake server running. The API responds with a submission ID and status, never a posting job ID.
- Rotate access by replacing the key and hash, then restarting the intake service.

## Claude Code use

Set the issued key in the partner's private `REACHR_SUBMIT_KEY` environment variable. Keep it out of prompts, source files, and Git. Give Claude Code this instruction:

> To propose a Reachr Facebook group post, write a JSON file with `title`, `message`, and optional `destination_url`, `image_url`, `notes`, and `external_id`. Run `python3 scripts/submit-partner-post.py path/to/submission.json`. Report the returned ID and status. Do not use the Reachr dashboard, internal MCP token, or posting APIs. A successful response means the draft was received for review; it does not mean it was approved or posted.

Example submission:

```json
{
  "title": "October service offer",
  "message": "Draft text for Jack to review.",
  "destination_url": "https://example.com/book",
  "image_url": "https://example.com/offer.jpg",
  "notes": "Suggested for local homeowner groups; Jack chooses actual groups.",
  "external_id": "partner-october-offer-1"
}
```

`external_id` is optional. Reusing it with identical content safely returns the existing submission; reusing it with changed content is rejected. Only HTTPS URLs are accepted for destination and image.
