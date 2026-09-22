const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
const start=source.indexOf('function startScheduleChecker()');
const end=source.indexOf('// ═══ UTIL',start);
assert.ok(start>=0&&end>start);
async function run(post){let tick,jobs=0,writes=0;const ctx={schedChecker:null,schedulerBusy:false,user:{id:'test'},cachedData:{},clearInterval:()=>{},setInterval:cb=>{tick=cb;return 1},sbGet:async()=>[post],sbSet:async()=>{writes++},scheduleLimitReached:()=>false,scheduledFireDue:()=>({fireKey:'due'}),createJob:async()=>{jobs++},console};vm.createContext(ctx);vm.runInContext(source.slice(start,end)+';startScheduleChecker()',ctx);await tick();return {jobs,writes};}
test('held campaign cannot fire even if its enabled flag is stale',async()=>{const post={enabled:true,setupStatus:'held_candidates_assigned_unverified',holdReason:'no publishing authorized',schedule:{days:[2],time:'09:15'}};assert.deepEqual(await run(post),{jobs:0,writes:0});});
test('ordinary enabled campaign remains eligible',async()=>{const post={id:'ordinary',enabled:true,schedule:{days:[2],time:'09:15'}};assert.deepEqual(await run(post),{jobs:1,writes:1});});
