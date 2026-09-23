// Run from this directory with macOS JavaScriptCore: jsc group-import-lifecycle.test.js
const source = readFile('../app.js');
const start = source.indexOf('function isStaleGroupSyncJob(');
const end = source.indexOf('function groupScanDetailHtml(', start);
if (start < 0 || end < 0) throw new Error('Group import lifecycle helpers missing');
const isHeartbeatFresh = heartbeat => Date.now() - Date.parse(heartbeat) < 90000;
const user = { id: 'test-user' };
let patched = false;
const sb = { from: () => ({ update: () => ({
  eq: () => ({ eq: () => ({ eq: () => ({ select: async () => { patched = true; return { data: [{ id: 'job-1' }], error: null }; } }) }) })
}) }) };
eval(source.slice(start, end));

const minutesAgo = n => new Date(Date.now() - n * 60000).toISOString();
const online = new Date().toISOString();
const old = minutesAgo(120);
const processing = { id: 'job-1', status: 'processing', started_at: minutesAgo(20) };
if (isStaleGroupSyncJob(processing, online)) throw new Error('Live 20-minute import was marked stale');
if (!isStaleGroupSyncJob(processing, old)) throw new Error('Offline import was not marked stale');
if (isStaleGroupSyncJob({ ...processing, result: { progress_at: minutesAgo(2) } }, online)) throw new Error('Recent scan progress was ignored');
if (!isStaleGroupSyncJob({ ...processing, result: { progress_at: minutesAgo(11) } }, online)) throw new Error('Stalled scan progress was not detected');
Promise.resolve().then(async () => {
  if (await cancelStaleGroupSyncJob(processing, online) || patched) throw new Error('Live import was cancelled');
  if (!await cancelStaleGroupSyncJob(processing, old) || !patched) throw new Error('Offline stale import was not cancelled');
  print('group import lifecycle test OK');
});
