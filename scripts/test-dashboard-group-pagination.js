#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const start = source.indexOf('async function fetchAll(');
const end = source.indexOf('\n}\n', start);
assert.ok(start >= 0 && end > start, 'fetchAll must exist');
const fetchAllSource = source.slice(start, end + 2);

function makeHarness(rows, failurePage = null) {
  const ranges = [];
  const sb = { from(table) {
    assert.equal(table, 'jsw_groups');
    let range = [0, 999];
    const query = {
      select() { return query; }, eq() { return query; }, order() { return query; },
      range(start, end) { range = [start, end]; ranges.push(range); return query; },
      then(resolve, reject) {
        const page = ranges.length;
        return Promise.resolve(failurePage === page
          ? { data: null, error: { message: 'page unavailable' } }
          : { data: rows.slice(range[0], range[1] + 1), error: null }).then(resolve, reject);
      },
    };
    return query;
  } };
  const context = vm.createContext({
    sb, user: { id: 'fixture-user' },
    cachedData: { sentinel: true },
    sbGet: async key => key === 'posts' ? [{ id: 'wildrose', groups: rows.slice(1050, 1148).map(g => ({ url: g.group_url, identity_key: g.identity_key })) }] : [],
    sanitizePostingIdentities: value => value,
    groupOwnerKey: g => g.identity_key,
    isLegacyGroupAssignment: () => false,
    persistReachrLocalSnapshot: () => {},
  });
  vm.runInContext(fetchAllSource, context);
  return { context, ranges };
}

test('dashboard loads all group pages so the 98 older Wildrose schedule groups stay visible', async () => {
  const rows = Array.from({ length: 1536 }, (_, i) => ({
    group_url: `https://www.facebook.com/groups/${i}`,
    group_name: `Group ${i}`,
    identity_key: i >= 1050 && i < 1148 ? 'wildrose automations' : 'other',
    created_at: new Date(1730000000000 - i * 1000).toISOString(),
  }));
  const h = makeHarness(rows);
  const data = await h.context.fetchAll({ persistSnapshot: false });
  assert.equal(data.groups.length, 1536);
  const urls = new Set(data.groups.filter(g => g.identity_key === 'wildrose automations').map(g => g.url));
  assert.equal(data.posts[0].groups.filter(g => urls.has(g.url)).length, 98);
  assert.deepEqual(h.ranges, [[0, 499], [500, 999], [1000, 1499], [1500, 1999]]);
});

test('failed later page cannot silently return a partial group inventory', async () => {
  const rows = Array.from({ length: 600 }, (_, i) => ({ group_url: `https://www.facebook.com/groups/${i}`, identity_key: 'wildrose automations' }));
  const h = makeHarness(rows, 2);
  const data = await h.context.fetchAll({ persistSnapshot: false });
  assert.equal(data.sentinel, true);
  assert.deepEqual(h.ranges, [[0, 499], [500, 999]]);
});
