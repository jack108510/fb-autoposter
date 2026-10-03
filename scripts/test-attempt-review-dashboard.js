const { test }=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const context=vm.createContext({URL,Date,WeakMap,Map,Set});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../post-status-dashboard.js'),'utf8'),context);
const dashboard=context.ReachrPostDashboard;
const now=Date.parse('2026-10-03T23:00:00Z');
const handoff=(job,group,time='2026-10-03T22:59:00Z')=>({job_id:job,group_url:group,kind:'command_handoff',recorded_at:time,payload:{identity_name:'Rose'}});

test('only unresolved, stale or paused command handoffs require review',()=>{
  const attempts=[handoff('active','https://www.facebook.com/groups/active/'),
    handoff('stale','https://www.facebook.com/groups/stale/','2026-10-03T22:40:00Z'),
    handoff('paused','https://www.facebook.com/groups/paused/'),
    handoff('done','https://www.facebook.com/groups/done/'),
    {job_id:'done',group_url:'https://www.facebook.com/groups/done/',kind:'result',recorded_at:'2026-10-03T22:59:30Z'}];
  const jobs=[{id:'active',status:'processing'},{id:'stale',status:'processing'},{id:'paused',status:'paused'}];
  assert.deepEqual(Array.from(dashboard.attemptReviewRows(attempts,jobs,now),x=>x.job_id).sort(),['paused','stale']);
});

test('review card escapes text and links only to a Facebook group',()=>{
  const html=dashboard.html([],[],true,[handoff('paused','https://www.facebook.com/groups/123/')]);
  assert.match(html,/1 posting handoff needs review/);
  assert.match(html,/Open group/);
  assert.match(html,/may have reached Facebook/);
});
