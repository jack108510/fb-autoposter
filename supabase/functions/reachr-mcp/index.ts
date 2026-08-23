import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

type ToolHandlerContext = {
  userId: string;
  supabase: any;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, content-type, mcp-session-id, mcp-protocol-version",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

const serverInfo = {
  name: "reachr-mcp",
  version: "0.1.0",
};

const tools = [
  {
    name: "list_groups",
    description:
      "List saved/imported Facebook groups available to the authenticated Reachr user. Does not search Facebook or join groups.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum groups to return. Default 50, max 200.",
        },
        profile: {
          type: "string",
          description: "Optional profile/page name filter.",
        },
      },
    },
  },
  {
    name: "search_saved_groups",
    description:
      "Search the authenticated user's saved Reachr group library by name, URL, tag, or profile/page owner. This only searches already-imported groups.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text." },
        limit: {
          type: "number",
          description: "Maximum groups to return. Default 50, max 200.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "create_post_campaign",
    description:
      "Queue a Reachr post job for selected saved group URLs. This creates a pending job for the Chrome helper; it does not directly control Facebook.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Post text." },
        group_urls: {
          type: "array",
          items: { type: "string" },
          description: "Saved Reachr group URLs to post into.",
        },
        identity_name: {
          type: "string",
          description:
            "Facebook profile/Page name to post as. Defaults to the matched group owner when possible.",
        },
        image_url: { type: "string", description: "Optional image URL." },
        first_comment: {
          type: "string",
          description: "Optional first comment text.",
        },
        delay_seconds: {
          type: "number",
          description: "Delay between groups. Minimum 90 seconds.",
        },
        ai_enabled: {
          type: "boolean",
          description:
            "Whether Reachr should paraphrase/spin copy when the helper posts.",
        },
      },
      required: ["message", "group_urls"],
    },
  },
  {
    name: "get_post_history",
    description:
      "Read recent Reachr post jobs/results for the authenticated user.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum rows to return. Default 20, max 100.",
        },
      },
    },
  },
  {
    name: "import_joined_groups",
    description:
      "Queue a safe Reachr import job so the Chrome helper refreshes already-joined Facebook groups for synced profiles/pages. Does not find or join new groups.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "sync_profiles",
    description:
      "Queue a Reachr profile sync job so the Chrome helper refreshes available Facebook profiles/pages.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

function rpcResult(id: JsonRpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  data?: unknown,
) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data ? { data } : {}) },
  };
}

function textResult(value: unknown, isError = false): ToolResult {
  const text = typeof value === "string"
    ? value
    : JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

function clampLimit(raw: unknown, fallback: number, max: number) {
  const n = typeof raw === "number" ? raw : Number(raw || fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

function normalizeGroup(row: Record<string, any>) {
  return {
    name: row.group_name || row.name ||
      row.group_url?.split("/").filter(Boolean).pop() || "Facebook group",
    url: row.group_url || row.url || "",
    profile: row.identity_name || row.profile_name || row.page_name ||
      row.joined_as || row.collected_by || row.imported_by || null,
    profile_key: row.identity_key || row.profile_key || row.page_key ||
      row.joined_as_key || row.collected_by_key || row.imported_by_key || null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    last_posted_at: row.last_posted_at || null,
    ban_risk: row.ban_risk || "low",
    removal_count: row.removal_count || 0,
  };
}

async function authenticate(req: Request) {
  const url = Deno.env.get("SUPABASE_URL") ||
    "https://xacehhtgvubcqdoltazg.supabase.co";
  const serviceKey = Deno.env.get("REACHR_SUPABASE_SERVICE_ROLE_KEY") ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ||
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const internalToken = Deno.env.get("REACHR_MCP_TOKEN");
  const internalUserId = Deno.env.get("REACHR_MCP_USER_ID");

  if (!serviceKey && !anonKey) throw new Error("Missing Supabase key env");
  const authHeader = req.headers.get("authorization") || "";
  const bearer = authHeader.match(/^Bearer\s+(.+)$/i)?.[1] || "";

  const supabase = createClient(url, serviceKey || anonKey!, {
    global: {
      headers: bearer && bearer !== internalToken
        ? { Authorization: `Bearer ${bearer}` }
        : {},
    },
    auth: { persistSession: false },
  });

  if (internalToken && internalUserId && bearer && bearer === internalToken) {
    return { userId: internalUserId, supabase };
  }

  if (!bearer) throw new Error("Missing Authorization bearer token");
  const { data, error } = await supabase.auth.getUser(bearer);
  if (error || !data?.user?.id) {
    throw new Error("Invalid Authorization bearer token");
  }
  return { userId: data.user.id, supabase };
}

async function listGroups(
  ctx: ToolHandlerContext,
  args: Record<string, unknown>,
) {
  const limit = clampLimit(args.limit, 50, 200);
  const profile = String(args.profile || "").trim().toLowerCase();
  const { data, error } = await ctx.supabase
    .from("jsw_groups")
    .select("*")
    .eq("user_id", ctx.userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  let groups = (data || []).map(normalizeGroup).filter((g: any) => g.url);
  if (profile) {
    groups = groups.filter((g: any) =>
      String(g.profile || "").toLowerCase().includes(profile)
    );
  }
  return { count: groups.length, groups };
}

async function searchSavedGroups(
  ctx: ToolHandlerContext,
  args: Record<string, unknown>,
) {
  const query = String(args.query || "").trim().toLowerCase();
  if (!query) throw new Error("query is required");
  const all = await listGroups(ctx, { limit: clampLimit(args.limit, 50, 200) });
  const groups = all.groups.filter((g: any) =>
    [g.name, g.url, g.profile, ...(g.tags || [])].join(" ").toLowerCase()
      .includes(query)
  );
  return { count: groups.length, groups };
}

async function createPostCampaign(
  ctx: ToolHandlerContext,
  args: Record<string, unknown>,
) {
  const message = String(args.message || "").trim();
  if (!message) throw new Error("message is required");
  const urls = Array.isArray(args.group_urls)
    ? args.group_urls.map(String).map((s) => s.trim()).filter(Boolean)
    : [];
  if (!urls.length) throw new Error("group_urls is required");
  const { data: rows, error: groupError } = await ctx.supabase
    .from("jsw_groups")
    .select("*")
    .eq("user_id", ctx.userId)
    .in("group_url", urls);
  if (groupError) throw new Error(groupError.message);
  const groups = (rows || []).map(normalizeGroup);
  const found = new Set(groups.map((g: any) => g.url));
  const missing = urls.filter((u) => !found.has(u));
  if (missing.length) {
    throw new Error(
      `These group_urls are not saved in Reachr: ${missing.join(", ")}`,
    );
  }

  const explicitIdentity = String(args.identity_name || "").trim();
  const identityName = explicitIdentity ||
    groups.find((g: any) => g.profile)?.profile;
  if (!identityName) {
    throw new Error(
      "identity_name is required when selected groups do not have a saved profile owner",
    );
  }

  const delay = Math.max(clampLimit(args.delay_seconds, 90, 24 * 60 * 60), 90);
  const payload = {
    user_id: ctx.userId,
    message,
    image_url: String(args.image_url || "").trim() || null,
    first_comment: String(args.first_comment || "").trim() || null,
    groups: groups.map((g: any) => ({
      url: g.url,
      name: g.name,
      group_name: g.name,
      identity_name: identityName,
      identity_key: g.profile_key,
    })),
    identity_name: identityName,
    delay,
    ai_enabled: Boolean(args.ai_enabled),
    status: "pending",
  };
  const { data, error } = await ctx.supabase.from("jsw_post_jobs").insert(
    payload,
  ).select("id,status,created_at,groups").single();
  if (error) throw new Error(error.message);
  return { queued: true, job: data };
}

async function getPostHistory(
  ctx: ToolHandlerContext,
  args: Record<string, unknown>,
) {
  const limit = clampLimit(args.limit, 20, 100);
  const { data, error } = await ctx.supabase
    .from("jsw_post_jobs")
    .select(
      "id,status,message,groups,result,error,created_at,started_at,completed_at,identity_name",
    )
    .eq("user_id", ctx.userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return { count: data?.length || 0, jobs: data || [] };
}

async function importJoinedGroups(ctx: ToolHandlerContext) {
  const { data: identitiesRow } = await ctx.supabase
    .from("amplr_data")
    .select("value")
    .eq("user_id", ctx.userId)
    .eq("key", "posting_identities")
    .maybeSingle();
  const identities = Array.isArray(identitiesRow?.value)
    ? identitiesRow.value
    : (Array.isArray(identitiesRow?.value?.identities)
      ? identitiesRow.value.identities
      : []);
  const targets = identities.map((identity: any) => ({
    identity_name: identity.name || null,
    identity_key: identity.identity_key || identity.profile_key ||
      identity.page_key || identity.id || identity.url || identity.name || null,
    profile_name: identity.name || null,
    profile_key: identity.identity_key || identity.profile_key ||
      identity.page_key || identity.id || identity.url || identity.name || null,
    page_name: /page/i.test(identity.type || "") ? identity.name : null,
    type: identity.type || "Facebook profile",
    url: identity.url || null,
    import_groups: true,
  })).filter((t: any) => t.identity_name || t.url);

  const { data, error } = await ctx.supabase.from("jsw_post_jobs").insert({
    user_id: ctx.userId,
    message: "__import_groups__",
    groups: targets,
    status: "pending",
    result: {
      text: `Claude connector queued group import for ${
        targets.length || "all synced"
      } profile/page target(s).`,
    },
    delay: 0,
    ai_enabled: false,
    scheduled_for: null,
  }).select("id,status,result,created_at").single();
  if (error) throw new Error(error.message);
  return { queued: true, job: data };
}

async function syncProfiles(ctx: ToolHandlerContext) {
  const { data, error } = await ctx.supabase.from("jsw_post_jobs").insert({
    user_id: ctx.userId,
    message: "__sync_identities__",
    groups: [],
    status: "pending",
    result: { text: "Claude connector queued profile sync." },
    delay: 0,
    ai_enabled: false,
    scheduled_for: null,
  }).select("id,status,result,created_at").single();
  if (error) throw new Error(error.message);
  return { queued: true, job: data };
}

async function callTool(
  ctx: ToolHandlerContext,
  name: string,
  args: Record<string, unknown> = {},
) {
  switch (name) {
    case "list_groups":
      return textResult(await listGroups(ctx, args));
    case "search_saved_groups":
      return textResult(await searchSavedGroups(ctx, args));
    case "create_post_campaign":
      return textResult(await createPostCampaign(ctx, args));
    case "get_post_history":
      return textResult(await getPostHistory(ctx, args));
    case "import_joined_groups":
      return textResult(await importJoinedGroups(ctx));
    case "sync_profiles":
      return textResult(await syncProfiles(ctx));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function handleMcpRequest(req: Request) {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method === "GET") {
    return json({
      status: "ok",
      serverInfo,
      tools: tools.map((t) => t.name),
      note: "POST JSON-RPC MCP requests to this endpoint.",
    });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: JsonRpcRequest;
  try {
    body = await req.json();
  } catch (_) {
    return json(rpcError(null, -32700, "Parse error"), 400);
  }

  try {
    if (body.method === "initialize") {
      return json(rpcResult(body.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo,
      }));
    }

    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202, headers: corsHeaders });
    }

    if (body.method === "ping") return json(rpcResult(body.id, {}));

    if (body.method === "tools/list") {
      return json(rpcResult(body.id, { tools }));
    }

    if (body.method === "tools/call") {
      const ctx = await authenticate(req);
      const params = body.params || {};
      const name = String(params.name || "");
      const args = (params.arguments || {}) as Record<string, unknown>;
      return json(rpcResult(body.id, await callTool(ctx, name, args)));
    }

    return json(
      rpcError(body.id, -32601, `Method not found: ${body.method}`),
      404,
    );
  } catch (e) {
    return json(
      rpcError(body.id, -32000, e instanceof Error ? e.message : String(e)),
      200,
    );
  }
}

Deno.serve(handleMcpRequest);
