// Run from this directory with macOS JavaScriptCore: jsc durable-campaign-save.test.js
const source = readFile('../app.js');
const start = source.indexOf('async function savePost(');
const end = source.indexOf('async function postNow()', start);
if (start < 0 || end < 0) throw new Error('savePost source missing');

async function check(activate) {
  const calls = [];
  const inputs = {
    createText: { value: 'Exact saved text' }, createTime: { value: '09:00' },
    scheduleMaxRuns: { value: '3' }, scheduleWeeks: { value: '' },
    createCampaignName: { value: 'Wildrose test' }, createFirstComment: { value: '' },
    aiToggle: { classList: { contains: () => false } },
    campaignOffer: { value: 'Product information' }, campaignDisclosures: { value: 'None' },
    campaignDestination: { value: 'No external link' }, campaignApproverName: { value: 'Jack' },
    campaignApprovalCheck: { checked: activate },
  };
  const document = { getElementById: id => inputs[id] || null };
  const sb = { from(table) {
    if (table !== 'reachr_campaign_schedules') throw new Error(`Unexpected table ${table}`);
    return {
      upsert: async row => { calls.push({ kind: 'save', row }); return { error: null }; },
      update(patch) {
        calls.push({ kind: 'activate', patch });
        return { eq() { return this; }, select() { return this; }, maybeSingle: async () => ({ data: { id: 'campaign-1' }, error: null }) };
      }
    };
  }, rpc: async (name, payload) => { calls.push({ kind: 'approval', name, payload }); return { error: null }; } };
  const user = { id: 'user-1' };
  const cachedData = { posts: [], settings: { delay: 90 } };
  const selectedGroupTargets = () => [{ url: 'https://www.facebook.com/groups/123/', identity_key: 'page-1' }];
  const getSelectedPostingIdentity = () => ({ name: 'Wildrose Automations', id: 'page-1', type: 'page' });
  const isValidPostingIdentity = identity => !!identity?.name;
  const identityKey = identity => identity.id;
  const normalizeTimeValue = value => value;
  const parsePositiveInt = value => Number(value) || null;
  const getCreateImageUrl = () => '';
  const nextRunDate = () => new Date('2026-09-24T12:00:00Z');
  const localStorage = { removeItem() {} };
  const clearCreateForm = () => {};
  const nav = () => {};
  const toast = message => calls.push({ kind: 'toast', message });
  const crypto = { randomUUID: () => 'campaign-1' };
  const sbGet = async () => [];
  const sbSet = async () => null;
  const scheduledEventGroups = () => [];
  const scheduledEventIdentityName = () => '';
  const cancelPendingCampaignJobs = async () => 0;
  let editingPostId = null;
  let selDays = [1, 3];
  eval(source.slice(start, end));
  await savePost(activate);
  if (calls[0]?.kind !== 'save' || calls[0].row.status !== 'draft' || calls[0].row.enabled !== false) throw new Error('Save must write a draft first');
  if (activate) {
    if (calls[1]?.kind !== 'approval' || calls[2]?.kind !== 'activate') throw new Error('Activation must follow approval');
  } else if (calls.some(call => call.kind === 'approval' || call.kind === 'activate')) {
    throw new Error('Draft triggered activation');
  }
}

Promise.resolve().then(() => check(false)).then(() => check(true)).then(() => print('durable campaign save test OK'));
