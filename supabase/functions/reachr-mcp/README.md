# Reachr Claude Connector (Remote MCP)

This folder contains a Supabase Edge Function that exposes Reachr as a Claude custom connector via Remote MCP.

## Endpoint

After deployment:

```txt
https://xacehhtgvubcqdoltazg.supabase.co/functions/v1/reachr-mcp
```

Add that URL in Claude under **Customize → Connectors → Add custom connector**.

## Exposed tools

Safe public connector tools only:

- `list_groups` — list already-imported/saved Reachr groups
- `search_saved_groups` — search saved group library
- `create_post_campaign` — queue a pending Reachr post job for the Chrome helper
- `get_post_history` — read recent Reachr jobs/results
- `import_joined_groups` — queue refresh of already-joined groups
- `sync_profiles` — queue refresh of Facebook profiles/pages

Intentionally not exposed:

- group finder
- group joiner
- any direct browser/Facebook control

Those remain internal agent/API-only.

## Auth modes

The function supports two auth modes:

1. **Supabase user JWT**: pass the user's Supabase access token as `Authorization: Bearer ...`.
2. **Internal connector token**: set both:
   - `REACHR_MCP_TOKEN`
   - `REACHR_MCP_USER_ID`

The internal token is useful for Jack/internal Claude connector testing before adding OAuth.

## Required Supabase secrets

Supabase provides `SUPABASE_URL` automatically. Set these secrets:

```bash
supabase secrets set \
  REACHR_SUPABASE_SERVICE_ROLE_KEY='...' \
  REACHR_MCP_TOKEN='choose-a-long-random-token' \
  REACHR_MCP_USER_ID='reachr-user-uuid' \
  --project-ref xacehhtgvubcqdoltazg
```

`SUPABASE_SERVICE_ROLE_KEY` lets the connector read/write Reachr tables while still scoping every query to the authenticated/internal `user_id`.

## Deploy

```bash
supabase login
supabase functions deploy reachr-mcp --project-ref xacehhtgvubcqdoltazg
```

`supabase/config.toml` sets `verify_jwt = false` so Claude can call MCP `initialize` and `tools/list` before a tool call. The function itself still requires auth for `tools/call`.

## Smoke tests

Initialize:

```bash
curl -s https://xacehhtgvubcqdoltazg.supabase.co/functions/v1/reachr-mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | jq
```

List tools:

```bash
curl -s https://xacehhtgvubcqdoltazg.supabase.co/functions/v1/reachr-mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | jq
```

Call a tool with internal token:

```bash
curl -s https://xacehhtgvubcqdoltazg.supabase.co/functions/v1/reachr-mcp \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer YOUR_REACHR_MCP_TOKEN' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_groups","arguments":{"limit":10}}}' | jq
```

## Next production step

For customer-facing Claude connectors, add OAuth so each Claude user connects their own Reachr account. The current function is ready for internal token testing and can also accept Supabase JWTs if we pass them from a proper OAuth/session bridge.
