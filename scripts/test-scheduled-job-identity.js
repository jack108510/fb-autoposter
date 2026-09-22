const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const block = source.match(/async function createJob\(post\) \{[\s\S]*?\n\}\n\n\/\/ ═══ SPINTAX/);
assert.ok(block, 'createJob source must exist');

test('scheduled job uses its saved Page identity, not the currently selected composer Page', async () => {
  let inserted;
  const context = {
    user: { id: 'user-1' },
    cachedData: { settings: { delay: 90 }, postingIdentities: [
      { name: 'Wildrose Automations', id: 'wildrose automations', type: 'page' },
      { name: 'Empty Slot', id: 'empty slot', type: 'page' }
    ] },
    getSelectedPostingIdentity: () => ({ name: 'Empty Slot', id: 'empty slot' }),
    findPostingIdentityByName: name => ({ name, id: name.toLowerCase() }),
    isValidPostingIdentity: identity => Boolean(identity.name),
    identityKey: identity => identity.id,
    document: { getElementById: () => null },
    sb: { from: () => ({ insert: async jobs => { inserted = jobs; return { error: null }; } }) }
  };
  vm.createContext(context);
  vm.runInContext(block[0].replace(/\n\n\/\/ ═══ SPINTAX$/, ''), context);
  await context.createJob({ id: 'rose', text: 'Rose', identityName: 'Wildrose Automations', groups: [{ name: 'Owners', url: 'https://www.facebook.com/groups/123/' }] });
  assert.equal(inserted[0].identity_name, 'Wildrose Automations');
  assert.equal(inserted[0].identity_key, 'wildrose automations');
});
