#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function functionBody(source, functionName) {
  const start = source.indexOf(`async function ${functionName}`);
  assert(start >= 0, `Missing ${functionName}() in app.js`);
  const signatureEnd = source.indexOf('\n', start);
  const bodyStart = source.lastIndexOf('{', signatureEnd);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(bodyStart, i + 1);
    }
  }
  throw new Error(`Could not parse ${functionName}() body`);
}

const testBody = functionBody(app, 'testPostingIdentitySwitch');

assert(html.includes('identitySwitchTestStatus'), 'Dashboard is missing the identity test status area');
assert(app.includes('identity-switch-test-btn'), 'Profile list does not expose a Test switch button');
assert(testBody.includes("message: '__probe_global_identity_switch__'"), 'Dashboard test does not use the helper verification job');
assert(testBody.includes('identity_name: identity.name'), 'Dashboard test does not pass the expected identity name');
assert(testBody.includes('identity_url: identity.url || null'), 'Dashboard test does not pass the expected identity URL');
assert(testBody.includes('ai_enabled: false'), 'Dashboard test must explicitly disable AI work');
assert(!/POST_TO_PAGE/.test(testBody), 'Dashboard test references the posting command');
assert(!/createJob\s*\(/.test(testBody), 'Dashboard test references the normal post-job creator');
assert(!/message:\s*identity\.name/.test(testBody), 'Dashboard test would submit a user identity as post content');

console.log('PASS: Reachr dashboard identity test queues only __probe_global_identity_switch__ and contains no posting path.');
