// Run with macOS JavaScriptCore: jsc rose-group-suggestions.test.js
const source = readFile('../app.js');
const start = source.indexOf('function roseGroupRelevance(');
const end = source.indexOf('function getSelectedGroups()', start);
if (start < 0 || end < 0) throw new Error('Rose group suggestions missing');
const groups = [
  { url: 'https://www.facebook.com/groups/1/', name: 'Small Business Owners Canada' },
  { url: 'https://www.facebook.com/groups/2/', name: 'Dog Owners Canada' },
  { url: 'https://www.facebook.com/groups/3/', name: 'Entrepreneur Networking' },
  { url: 'https://www.facebook.com/groups/4/', name: 'Marketing Agency Owners' }
];
const chips = groups.map(group => ({ dataset: { groupKey: group.url }, selected: false,
  classList: { toggle(name, value) { if (name === 'selected') this.owner.selected = value; }, owner: null } }));
chips.forEach(chip => { chip.classList.owner = chip; });
const document = { querySelectorAll: () => chips };
const user = { id: 'account-1' };
const getSelectedPostingIdentity = () => ({ name: 'Wildrose Automations' });
const identityKey = () => 'wildrose-page';
const createVisibleGroups = () => groups;
const groupRefUrl = group => group.url;
const groupChipKey = group => group.url;
const updateSelectedCount = () => {};
const notices = [];
const toast = message => notices.push(message);
let verified = true;
const sb = { from: () => ({ select() { return this; }, eq() { return this; }, order() { return this; },
  limit: async () => ({ data: [{ completed_at: new Date().toISOString(), result: { identities: [{
    identity_key: 'wildrose-page', status: verified ? 'scanned' : 'not_scanned',
    scan_complete: verified, active_identity_verified: verified,
    group_scan_guard_version: 'fb-groups-scraper-v4', group_urls: groups.slice(0, 3).map(group => group.url)
  }] } }], error: null }) }) };
eval(source.slice(start, end));
Promise.resolve().then(async () => {
  await suggestRoseCampaignGroups();
  if (!chips[0].selected || chips[1].selected || chips[2].selected !== true || chips[3].selected) {
    throw new Error('Only relevant, verified Wildrose groups should be selected');
  }
  verified = false;
  chips.forEach(chip => { chip.selected = false; });
  await suggestRoseCampaignGroups();
  if (chips.some(chip => chip.selected) || !notices.at(-1).includes('complete Wildrose group scan')) {
    throw new Error('Unverified scan allowed group selection');
  }
  print('Rose group suggestions test OK');
});
