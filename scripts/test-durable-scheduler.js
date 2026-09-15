#!/usr/bin/env node
const {test}=require('node:test'); const assert=require('node:assert/strict');
const fs=require('node:fs'); const vm=require('node:vm'); const path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
function fn(name){const start=src.indexOf(`function ${name}(`);return src.slice(start,src.indexOf('\n}',start)+2);}
test('dashboard relinquishes migrated campaign to database owner, preserving legacy schedules',async()=>{
 let tick; const fired=[];
 const posts=[{id:'legacy',enabled:true,schedule:{days:[1],time:'09:00'}},{id:'durable',enabled:true,schedule:{owner:'durable-v1',days:[1],time:'09:00'}}];
 const ctx=vm.createContext({console,Date,Array,Number,clearInterval:()=>{},setInterval:cb=>{tick=cb;},sbGet:async()=>posts,sbSet:async()=>{},createJob:async p=>fired.push(p.id),scheduleLimitReached:()=>false,scheduledFireDue:()=>({fireKey:'due'})});
 vm.runInContext('let schedChecker=null,user={},schedulerBusy=false,cachedData={};\n'+fn('startScheduleChecker'),ctx);
 ctx.startScheduleChecker();await tick();assert.deepEqual(fired,['legacy']);
});
