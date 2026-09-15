#!/usr/bin/env node
// Offline actual-function regression tests. No browser, credentials, or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
function declaration(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `Missing ${name}`);
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, `Missing end of ${name}`);
  return source.slice(start, end + 2);
}
const clone = value => JSON.parse(JSON.stringify(value));
function fixtures() {
  const base = { id: 'campaign-a', name: 'Campaign A', enabled: true,
    identityName: 'Fixture Page', text: 'Shared copy', firstComment: 'Comment A',
    groups: [{ url: 'https://www.facebook.com/groups/fixture', identity_name: 'Fixture Page' }],
    schedule: { days: [2, 4], time: '09:00', maxRuns: null, firedCount: 8, owner: 'durable-v1', lastFireKey: 'previous-occurrence' },
    aiEnabled: false, updatedAt: '2026-08-01T00:00:00Z' };
  return {
    posts: [base, { ...clone(base), id: 'campaign-b', firstComment: 'Different comment', aiEnabled: true },
      { ...clone(base), id: 'missing-actor', identityName: '', groups: ['https://www.facebook.com/groups/other'] },
      { ...clone(base), id: 'empty-targets', groups: [] }],
    jobs: ['pending', 'processing'].map((status, i) => ({ id: `unrelated-repeat-${i}`, status,
      scheduled_for: null, repeat_days: [1, 3, 5], repeat_time: '11:45',
      groups: ['https://www.facebook.com/groups/unrelated'], message: 'Independent repeat',
      result: { campaign_id: 'external-owner', attempts: 4, custom: { preserve: true } } })),
  };
}
function harness(input = fixtures()) {
  const state = clone(input), writes = [], reads = [], rendered = [];
  const elements = { scheduledList: { innerHTML: '' }, reachrHealthPanel: { innerHTML: '' } };
  const context = vm.createContext({
    user: { id: 'fixture-user' }, cachedData: {}, upcomingPostDetails: {}, queuedSubscriptionDetails: {},
    sbGet: async key => key === 'posts' ? state.posts : key === 'settings' ? {} : [],
    sbSet: async (key, value) => { writes.push({ method: 'sbSet', key, value: clone(value) }); state[key] = clone(value); },
    persistReachrLocalSnapshot: data => writes.push({ method: 'snapshot', data: clone(data) }),
    sanitizePostingIdentities: values => values,
    sb: { from(table) {
      let columns, mutation;
      const query = {
        select(value) { columns = value; reads.push({ table, columns }); return query; },
        eq() { return query; }, not() { return query; }, gte() { return query; },
        lt() { return query; }, order() { return query; }, limit() { return query; },
        in() { return query; },
        then(resolve, reject) {
          if (mutation) {
            writes.push({ table, ...mutation });
            if (table === 'jsw_post_jobs' && mutation.method === 'update') state.jobs.forEach(j => Object.assign(j, clone(mutation.value)));
            return Promise.resolve({ error: null }).then(resolve, reject);
          }
          return Promise.resolve({ data: table === 'jsw_groups' ? [] : columns === '*' ? state.jobs.filter(j => j.scheduled_for) : state.jobs, error: null }).then(resolve, reject);
        },
      };
      for (const method of ['update', 'insert', 'upsert', 'delete']) query[method] = value => { mutation = { method, value }; return query; };
      return query;
    } },
    document: { getElementById: id => elements[id], createElement: () => ({ set textContent(value) { this.innerHTML = String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;'); } }) },
    // Only unrelated calendar/subscription presentation is stubbed. All health,
    // loading, fetching, and health rendering logic comes verbatim from app.js.
    scheduledWeekEvents: (posts, jobs) => { rendered.push({ posts: clone(posts), jobs: clone(jobs) }); return []; },
    queuedJobSubscriptionRows: () => [], renderSubscriptionsTable: () => '',
  });
  const names = ['fetchAll', 'loadScheduled', 'analyzeReachrHealth', 'renderReachrHealthPanel',
    'reachrHealthGroupUrls', 'reachrHealthCampaignKey', 'reachrHealthCampaignName', 'reachrHealthCampaignScore',
    'scheduledEventIdentityName', 'scheduledEventGroups', 'scheduledEventText', 'scheduledEventImage',
    'isValidPostingIdentity', 'simpleHash', 'normalizeTimeValue', 'startOfLocalDay', 'addDays', 'esc'];
  // Include the original repair function while reproducing the regression, if present.
  if (/^async function autoFixReachrHealth\(/m.test(source)) names.push('autoFixReachrHealth');
  vm.runInContext(names.map(declaration).join('\n'), context);
  return { context, state, writes, reads, rendered, elements };
}
test('health findings and panel request review without claiming automatic repairs or protection', async () => {
  const h = harness();
  const before = clone(h.state);
  const health = h.context.analyzeReachrHealth(h.state.posts, h.state.jobs);
  assert.ok(health.issues.length > 0);
  assert.ok(health.issues.every(issue => !issue.autoFix), 'findings must not authorize automatic mutation');
  for (const issue of health.issues) assert.doesNotMatch(issue.detail, /Reachr will (keep|set|pause|clear)/i);
  h.context.renderReachrHealthPanel(health);
  assert.match(h.elements.reachrHealthPanel.innerHTML, /Needs review/);
  assert.match(h.elements.reachrHealthPanel.innerHTML, /read.only/i);
  assert.doesNotMatch(h.elements.reachrHealthPanel.innerHTML, /Auto-fixed|Protected|>auto<|handled before/);
  const warnings = { issues: health.issues.filter(issue => issue.level === 'warn') };
  h.context.renderReachrHealthPanel(warnings);
  assert.match(h.elements.reachrHealthPanel.innerHTML, /Needs review/);
  assert.doesNotMatch(h.elements.reachrHealthPanel.innerHTML, /Auto-fixed|Protected|>auto</);
  assert.deepEqual(h.state, before);
  assert.deepEqual(h.writes, []);
});

test('opening Scheduled twice is inspection only: zero persistence writes, campaigns and independent repeats preserved', async () => {
  const input = fixtures();
  const h = harness(input);
  await h.context.loadScheduled();
  await h.context.loadScheduled();
  assert.deepEqual(h.writes, [], 'page-load inspection must not persist snapshots, delete/pause/expire campaigns, or clear repeat rows');
  assert.deepEqual(h.state, input);
  assert.deepEqual(clone(h.context.cachedData.posts), input.posts);
  assert.equal(h.rendered.length, 2);
  for (const rendered of h.rendered) assert.deepEqual(rendered.posts, input.posts);
  assert.equal(h.reads.filter(r => r.table === 'jsw_post_jobs').length, 4, 'two read-only job queries per load');
  const health = h.context.analyzeReachrHealth(h.state.posts, h.state.jobs);
  assert.deepEqual(new Set(health.issues.map(i => i.type)), new Set(['duplicate_campaigns', 'infinite_campaign', 'missing_actor', 'empty_groups', 'repeat_rows']));
});

test('inspection preserves explicit limits, disabled campaigns, and all repeat metadata variants', async () => {
  const input = fixtures();
  const base = input.posts[0];
  input.posts = [undefined, null, '', 0, 5].map((maxRuns, i) => {
    const post = clone(base);
    post.id = `limit-${i}`;
    post.schedule.maxRuns = maxRuns;
    if (i === 0) delete post.schedule.maxRuns;
    if (i === 4) {
      post.enabled = false;
      post.schedule.endsAt = '2026-08-20T00:00:00Z';
      post.campaignEndsAt = '2026-08-20T00:00:00Z';
    }
    return post;
  });
  input.jobs.push({ ...clone(input.jobs[0]), id: 'done-repeat', status: 'done' },
    { ...clone(input.jobs[0]), id: 'no-repeat', repeat_days: [], repeat_time: null });
  const h = harness(input);
  await h.context.loadScheduled();
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.state, input);
  assert.deepEqual(clone(h.context.cachedData.posts), input.posts);
});

test('empty Scheduled inspection remains read-only and renders a healthy empty state', async () => {
  const h = harness({ posts: [], jobs: [] });
  await h.context.loadScheduled();
  assert.deepEqual(h.writes, []);
  assert.match(h.elements.scheduledList.innerHTML, /No posts this week/);
  assert.match(h.elements.reachrHealthPanel.innerHTML, /Healthy/);
});

test('missing Scheduled container does not persist a snapshot', async () => {
  const h = harness();
  delete h.elements.scheduledList;
  await h.context.loadScheduled();
  assert.deepEqual(h.writes, []);
});

// Characterization of unchanged explicit/default behavior, not new features.
test('other fetchAll callers retain default local snapshot persistence', async () => {
  const h = harness();
  const data = await h.context.fetchAll();
  assert.deepEqual(h.writes.map(w => w.method), ['snapshot']);
  assert.deepEqual(h.writes[0].data.posts, clone(data.posts));
});

test('explicit manual pause and confirmed deletion retain their persistence flows', async () => {
  const h = harness();
  h.context.cachedData = { posts: h.state.posts };
  let reloads = 0;
  h.context.loadScheduled = () => { reloads++; };
  h.context.confirm = () => false;
  h.context.pendingJobIdsForSubscription = async () => [];
  h.context.toast = () => {};
  vm.runInContext(['togglePost', 'delPost'].map(declaration).join('\n'), h.context);
  await h.context.delPost('campaign-a');
  assert.deepEqual(h.writes, [], 'cancelled manual deletion must not write');
  await h.context.togglePost('campaign-a');
  assert.equal(h.state.posts.find(p => p.id === 'campaign-a').enabled, false);
  assert.deepEqual(h.state.posts[0].schedule, fixtures().posts[0].schedule);
  h.context.confirm = () => true;
  await h.context.delPost('campaign-b');
  assert.equal(h.state.posts.some(p => p.id === 'campaign-b'), false);
  assert.equal(h.state.posts.some(p => p.id === 'campaign-a'), true);
  assert.deepEqual(h.writes.map(w => w.method), ['sbSet', 'sbSet']);
  assert.equal(reloads, 2);
});
