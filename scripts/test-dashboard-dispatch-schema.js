#!/usr/bin/env node
// Offline execution of the production dispatch functions; never contacts Supabase.
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
  assert.ok(end > start);
  return source.slice(start, end + 2);
}
function harness() {
  const rows = [], messages = [];
  const elements = {
    createText: { value: 'Fixture message' },
    createFirstComment: { value: 'Fixture comment' },
    aiToggle: { classList: { contains: () => true } },
    postWaiting: { style: {} },
  };
  const context = vm.createContext({
    sb: { from(table) {
      assert.equal(table, 'jsw_post_jobs');
      return { async insert(jobs) {
        rows.push(...(Array.isArray(jobs) ? jobs : [jobs]));
        return { error: null };
      } };
    } },
    user: { id: 'fixture-user' }, cachedData: { settings: { delay: 20, ai_prompt: 'Fixture prompt' } },
    getSelectedPostingIdentity: () => ({ name: 'Selected Profile' }),
    findPostingIdentityByName: name => ({ name }),
    isValidPostingIdentity: identity => Boolean(identity?.name),
    identityKey: identity => identity.name.toLowerCase(),
    getSelectedGroups: () => [{ url: 'https://www.facebook.com/groups/fixture', name: 'Fixture group' }],
    document: { getElementById: id => elements[id] },
    getCreateImageUrl: () => 'https://example.invalid/image.png',
    toast: text => messages.push(text), localStorage: { removeItem() {} }, clearCreateForm() {},
    confirm: () => true,
  });
  vm.runInContext(['createJob', 'postNow', 'selectedGroupTargets'].map(declaration).join('\n'), context);
  return { context, rows, messages };
}
test('saved campaign dispatch uses its saved Page in bounded group jobs', async () => {
  const { context, rows } = harness();
  await context.createJob({ id: 'rose-campaign', text: 'Saved campaign', identityName: 'Saved Profile',
    groups: ['https://www.facebook.com/groups/one', { url: 'https://www.facebook.com/groups/two', identity_name: 'Group Profile', identity_key: 'group-key' }],
    imageUrl: 'https://example.invalid/saved.png', firstComment: 'Saved comment', aiEnabled: false });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.identity_name, 'Saved Profile');
  assert.equal(row.identity_key, 'saved profile');
  assert.equal(row.groups[0].identity_name, 'Saved Profile');
  assert.equal(row.groups[1].identity_name, 'Group Profile');
  assert.equal(row.groups[1].identity_key, 'group-key');
  assert.equal(row.result.campaign_id, 'rose-campaign');
  assert.equal(row.message, 'Saved campaign');
  assert.equal(row.delay, 90);
  assert.equal(row.status, 'pending');
  assert.equal(row.image_url, 'https://example.invalid/saved.png');
  assert.equal(row.first_comment, 'Saved comment');
  assert.equal(row.ai_enabled, false);
  assert.equal(row.ai_prompt, 'Fixture prompt');
});
test('composer dispatch uses selected identity in group JSON and succeeds with existing schema', async () => {
  const { context, rows, messages } = harness();
  await context.postNow();
  assert.deepEqual(messages, ['Sent — Reachr will post it']);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(Object.hasOwn(row, 'identity_name'), false);
  assert.equal(row.groups[0].identity_name, 'Selected Profile');
  assert.equal(row.groups[0].identity_key, 'selected profile');
  assert.equal(row.groups[0].profile_name, 'Selected Profile');
  assert.equal(row.message, 'Fixture message');
  assert.equal(row.first_comment, 'Fixture comment');
  assert.equal(row.delay, 90);
  assert.equal(row.ai_enabled, true);
  assert.equal(row.status, 'pending');
});
