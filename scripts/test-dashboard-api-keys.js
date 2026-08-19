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

const generateBody = functionBody(app, 'generateApiKey');
const loadBody = functionBody(app, 'loadApiKeys');
const revokeBody = functionBody(app, 'revokeApiKey');

assert(html.includes('apiKeyName'), 'Settings is missing the API key name field');
assert(html.includes('apiKeyReveal'), 'Settings is missing the one-time key reveal container');
assert(html.includes('apiScopeJobsRead') && html.includes('checked disabled'), 'jobs:read must be present as the fixed baseline scope');
assert(html.includes('apiScopeJobsWrite') && !/id="apiScopeJobsWrite"\s+checked/.test(html), 'jobs:write must not be selected by default');
assert(generateBody.includes("sb.rpc('amplr_create_api_key'"), 'Key generation does not call the backend key-creation function');
assert(generateBody.includes('p_user_id: user.id'), 'Key generation must bind issuance to the signed-in user');
assert(generateBody.includes('p_scopes: scopes'), 'Key generation does not pass selected scopes');
assert(generateBody.includes('issued?.api_key'), 'Key generation does not handle the raw one-time key value');
assert(generateBody.includes('apiKeyReveal'), 'Key generation does not reveal the raw value once');
assert(generateBody.includes("scopes.includes('jobs:write')"), 'Key generation is missing the write-scope confirmation');
assert(loadBody.includes(".from('jsw_api_keys')"), 'Key listing does not read the API-key table');
assert(loadBody.includes('key_preview'), 'Key listing must display only previews, not raw keys');
assert(revokeBody.includes('revoked_at'), 'Key revocation does not mark the key as revoked');
assert(app.includes('navigator.clipboard.writeText(raw)'), 'One-time API key cannot be copied securely');

console.log('PASS: Dashboard API-key UI uses one-time raw-key display, read-only defaults, scoped issuance, and revocation.');
