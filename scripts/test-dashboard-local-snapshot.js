#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function functionBody(source, functionName) {
  const start = source.indexOf(`function ${functionName}`) >= 0 ? source.indexOf(`function ${functionName}`) : source.indexOf(`async function ${functionName}`);
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

const persistBody = functionBody(app, 'persistReachrLocalSnapshot');
const sanitizeBody = functionBody(app, 'sanitizeReachrSnapshotValue');
const fetchAllBody = functionBody(app, 'fetchAll');

assert(app.includes('reachr_local_campaign_snapshot'), 'Dashboard does not define the local campaign snapshot storage key');
assert(persistBody.includes('localStorage.setItem(REACHR_LOCAL_SNAPSHOT_KEY'), 'Snapshot is not written to localStorage');
assert(persistBody.includes('posts') && persistBody.includes('groups') && persistBody.includes('postingIdentities'), 'Snapshot misses campaign/group/identity state');
assert(sanitizeBody.includes('accessToken') && sanitizeBody.includes('refreshToken') && sanitizeBody.includes('password'), 'Snapshot sanitizer does not strip auth/secrets');
assert(fetchAllBody.includes('persistReachrLocalSnapshot(data)'), 'fetchAll does not persist a fresh snapshot after successful load');
assert(!persistBody.includes('session.access_token'), 'Snapshot must not store raw Supabase access tokens');
assert(!persistBody.includes('session.refresh_token'), 'Snapshot must not store raw Supabase refresh tokens');

console.log('PASS: Reachr dashboard persists a sanitized local campaign snapshot after successful data loads.');
