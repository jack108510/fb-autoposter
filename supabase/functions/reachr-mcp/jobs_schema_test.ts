// Real handler + SDK, mocked HTTP boundary. Run with --deny-net --allow-env.
// Compatibility fixture deliberately omits optional identity columns: live schema
// on 2026-09-15 has them, but older deployments need not.
const secret = 'sb_secret_schema_test_fixture';
const userId = '11111111-1111-4111-8111-111111111111';
const groupUrl = 'https://www.facebook.com/groups/fixture';
const columns = new Set('id,user_id,message,image_url,groups,delay,ai_enabled,ai_prompt,status,error,started_at,completed_at,created_at,webhook_url,source,api_key_id,result,scheduled_for,repeat_days,repeat_time,first_comment'.split(','));
const calls: { url: URL; method: string; headers: Headers; body: any }[] = [];
let history: unknown[] = [];
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}
const originalServe = Deno.serve;
Deno.serve = (() => ({})) as unknown as typeof Deno.serve;
const { handleMcpRequest } = await import('./index.ts');
Deno.serve = originalServe;
async function rpc(name: string, args: Record<string, unknown> = {}, token = 'user-jwt-fixture') {
  const res = await handleMcpRequest(new Request('https://fixture.invalid/mcp', {
    method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }));
  return await res.json();
}
function test(name: string, fn: () => Promise<void>) {
  Deno.test(name, async () => {
    const names = ['SUPABASE_URL', 'REACHR_SUPABASE_SECRET_KEY', 'REACHR_MCP_TOKEN', 'REACHR_MCP_USER_ID'];
    const previous = names.map(n => Deno.env.get(n));
    const originalFetch = globalThis.fetch;
    Deno.env.set('SUPABASE_URL', 'https://fixture.supabase.co');
    Deno.env.set('REACHR_SUPABASE_SECRET_KEY', secret);
    Deno.env.delete('REACHR_MCP_TOKEN'); Deno.env.delete('REACHR_MCP_USER_ID');
    calls.length = 0; history = [];
    globalThis.fetch = async (input, init) => {
      const opts = init as RequestInit | undefined;
      const url = new URL(String(input));
      const method = opts?.method || 'GET';
      const headers = new Headers(opts?.headers);
      const body = opts?.body ? JSON.parse(String(opts.body)) : undefined;
      calls.push({ url, method, headers, body });
      assert(headers.get('apikey') === secret, 'SDK must use modern apikey');
      assert(headers.get('authorization') !== `Bearer ${secret}`, 'opaque key cannot be Bearer');
      if (url.pathname === '/auth/v1/user') {
        return headers.get('authorization') === 'Bearer user-jwt-fixture'
          ? response({ id: userId }) : response({ message: 'Invalid JWT' }, 401);
      }
      if (method === 'GET') assert(url.searchParams.get('user_id') === `eq.${userId}`, 'reads must remain caller scoped');
      if (url.pathname === '/rest/v1/jsw_groups') return response([
        { group_url: groupUrl, group_name: 'Fixture group', identity_name: 'Saved Page', identity_key: 'page-fixture' },
      ]);
      assert(url.pathname === '/rest/v1/jsw_post_jobs', `Unexpected request: ${url.pathname}`);
      const selected = (url.searchParams.get('select') || '').split(',').filter(Boolean);
      const unknown = [...selected, ...Object.keys(body || {})].find(c => !columns.has(c));
      if (unknown) return response({ code: 'PGRST204', message: `Fixture jobs schema rejects column ${unknown}` }, 400);
      if (method === 'POST') {
        assert(body.user_id === userId, 'insert must use authenticated user');
        return response({ id: 'job-fixture', status: 'pending', created_at: '2026-09-15T00:00:00Z', groups: body.groups }, 201);
      }
      return response(history);
    };
    try { await fn(); } finally {
      globalThis.fetch = originalFetch;
      names.forEach((n, i) => previous[i] === undefined ? Deno.env.delete(n) : Deno.env.set(n, previous[i]!));
    }
  });
}

test('campaign queues on schema without top-level identity, preserving group actor and caller JWT', async () => {
  const body = await rpc('create_post_campaign', {
    message: 'Fixture copy', group_urls: [groupUrl], identity_name: 'Explicit Page',
    first_comment: 'Fixture comment', delay_seconds: 1, user_id: 'spoofed-user',
  });
  assert(!body.error, `campaign failed: ${JSON.stringify(body.error)}`);
  const value = JSON.parse(body.result.content[0].text);
  assert(value.queued === true, 'must return queued');
  assert(value.job.groups[0].identity_name === 'Explicit Page', 'explicit actor retained in group');
  assert(value.job.groups[0].identity_key === 'page-fixture', 'group actor key retained');
  const inserted = calls.find(c => c.method === 'POST')!.body;
  assert(!Object.hasOwn(inserted, 'identity_name'), 'no optional top-level column');
  assert(inserted.delay === 90 && inserted.first_comment === 'Fixture comment', 'other campaign settings preserved');
  assert(calls.every(c => c.headers.get('authorization') === 'Bearer user-jwt-fixture'), 'caller JWT preserved');
});

test('history reads older schema and retains group actors, results and legacy URL groups', async () => {
  history = [
    { id: 'actor-job', groups: [{ url: groupUrl, identity_name: 'Saved Page', identity_key: 'page-fixture' }], result: { text: 'Posted' }, status: 'completed' },
    { id: 'legacy-job', groups: [groupUrl], result: null, status: 'pending' },
    { id: 'empty-job', groups: [], result: null, status: 'pending' },
  ];
  const body = await rpc('get_post_history', { limit: 500, user_id: 'spoofed-user' });
  assert(!body.error, `history failed: ${JSON.stringify(body.error)}`);
  const value = JSON.parse(body.result.content[0].text);
  assert(value.count === 3, 'history count retained');
  assert(JSON.stringify(value.jobs) === JSON.stringify(history), 'history preserves full group actor and legacy payloads');
  const read = calls.find(c => c.url.pathname === '/rest/v1/jsw_post_jobs')!;
  assert(!read.url.searchParams.get('select')!.split(',').includes('identity_name'), 'history does not require optional top-level identity');
  assert(read.url.searchParams.get('limit') === '100', 'limit remains clamped');
  assert(read.url.searchParams.get('order') === 'created_at.desc', 'history remains newest first');
  assert(calls.every(c => c.method === 'GET'), 'history has no writes');
});
