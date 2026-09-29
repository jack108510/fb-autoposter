(function(root){
  'use strict';
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const mounts=new WeakMap();
  function model(session,jobs,now=Date.now(),turns=[]){
    const expired=session?.state==='active'&&Date.parse(session.lease_until)<=now;
    const state=expired?'recovery_required':session?.state||'unavailable';
    const active=jobs.find(j=>String(j.id)===session?.job_id)||jobs.find(j=>j.status==='processing');
    const campaign=j=>j.result?.campaign_id||j.campaign_id||'job:'+j.id;
    const served=new Map(turns.map(t=>[t.campaign_id,Date.parse(t.last_served_at)]));
    if(session?.state==='active'&&session.campaign_id)served.set(session.campaign_id,now);
    const due=jobs.filter(j=>j.status==='pending'&&(!j.scheduled_for||Date.parse(j.scheduled_for)<=now)).sort((a,b)=>(served.get(campaign(a))||0)-(served.get(campaign(b))||0)||Date.parse(a.created_at)-Date.parse(b.created_at));
    return {state,active,due,paused:jobs.filter(j=>j.status==='paused'),session};
  }
  function html(session,jobs,turns=[]){
    const m=model(session,jobs,Date.now(),turns),titles={active:'Runner working',idle:'Runner available',recovery_required:'Runner interrupted — review needed',unavailable:'Runner status unavailable',offline:'Runner disconnected'};
    const name=j=>j?.result?.campaign_name||j?.campaign_name||j?.identity_name||j?.id||'Campaign';
    const operations={'post-status-monitor':'Checking post outcomes','group-lookup':'Finding groups','popup-import':'Importing groups','campaign':'Posting campaign'};
    const active=m.active?name(m.active):operations[session?.operation]||'No active campaign';
    const reason=session?.reason||(m.state==='recovery_required'?'Confirm the old runner is stopped and review interrupted attempts before resuming.':'');
    return `<section style="padding:20px;border:1px solid var(--border,#ddd);border-radius:18px;margin-bottom:16px;background:var(--surface,#fff)" aria-label="Runner and queue"><h3>${esc(titles[m.state]||'Runner unavailable')}</h3>
    <p style="margin:8px 0">${esc(active)}${session?.identity_name?' · Requested profile: '+esc(session.identity_name):''}</p>
    ${reason?`<p role="status">${esc(reason)}</p>`:''}
    <p style="font-size:12px;margin:8px 0">One batch runs at a time. Due campaigns take turns between batches; campaigns that have waited longest go first. Paused campaigns are not retried; status checks wait for posting.</p>
    <strong>${m.due.length} waiting · ${m.paused.length} paused for review</strong>
    ${m.state==='recovery_required'&&session?.owner?`<details style="margin:10px 0"><summary>Review interrupted runner</summary><label style="display:block;margin:8px 0"><input type="checkbox" data-runner-stopped> I confirmed the old runner is stopped.</label><label style="display:block;margin:8px 0"><input type="checkbox" data-runner-reviewed> I reviewed the interrupted attempts.</label><button type="button" data-runner-recover disabled>Unlock runner</button><p style="font-size:12px">This does not retry posts or resume paused campaigns.</p><div data-runner-feedback role="status"></div></details>`:''}
    ${m.due.length?`<ol style="padding:8px 20px">${m.due.slice(0,12).map(j=>`<li>${esc(name(j))} · ${m.state==='active'?'Waiting for the current batch':m.state==='idle'?'Waiting for the next poll':'Waiting for runner availability'}</li>`).join('')}</ol>`:''}
    ${m.paused.length?`<details><summary>Recent paused campaigns</summary><ul style="padding:8px 20px">${m.paused.slice(0,12).map(j=>`<li>${esc(name(j))} — ${esc(j.error||'Review required')}</li>`).join('')}</ul></details>`:''}</section>`;
  }
  function bridgeStatus(){
    if(!root.window)return Promise.resolve(null);
    return new Promise(resolve=>{
      const requestId='runner-'+crypto.randomUUID();
      const done=value=>{clearTimeout(timer);window.removeEventListener('message',onMessage);resolve(value);};
      const onMessage=event=>{if(event.source===window&&event.origin===location.origin&&event.data?.source==='amplr-dashboard-bridge'&&event.data.requestId===requestId)done(event.data);};
      const timer=setTimeout(()=>done(null),2000);window.addEventListener('message',onMessage);
      window.postMessage({source:'amplr-dashboard-page',type:'GET_RUNNER_STATUS',requestId},location.origin);
    });
  }
  async function mount(container,options){
    const previous=mounts.get(container);if(previous)clearInterval(previous.timer);
    const state={...options,revision:0};mounts.set(container,state);
    async function refresh(){
      const rev=++state.revision;
      if(state.getAccountId()!==state.userId){clearInterval(state.timer);container.replaceChildren();return;}
      const [runner,jobs,local,turns,heartbeat,paused]=await Promise.all([
        state.sb.from('reachr_runner_sessions').select('*').eq('user_id',state.userId).maybeSingle(),
        state.sb.from('jsw_post_jobs').select('id,status,created_at,scheduled_for,identity_name,result,error').eq('user_id',state.userId).in('status',['pending','processing']).order('created_at',{ascending:true}).limit(100),bridgeStatus(),state.sb.from('reachr_runner_campaign_turns').select('campaign_id,last_served_at').eq('user_id',state.userId),state.sb.from('jsw_settings').select('ext_heartbeat').eq('user_id',state.userId).maybeSingle(),
        state.sb.from('jsw_post_jobs').select('id,status,created_at,identity_name,result,error').eq('user_id',state.userId).eq('status','paused').order('created_at',{ascending:false}).limit(20)
      ]);
      if(mounts.get(container)!==state||rev!==state.revision||state.getAccountId()!==state.userId)return;
      const paired=local?.ok&&local.account_id===state.userId;
      const localJobs=paired?local.local_jobs||[]:[];
      const merged=new Map([...(jobs.data||[]),...(paused.data||[]),...localJobs].map(j=>[j.id,j]));
      let session=runner.error?null:runner.data||{state:'idle'};
      if(session?.state==='idle'&&!(Date.now()-Date.parse(heartbeat.data?.ext_heartbeat)<90000))session={...session,state:'offline',reason:'Open Reachr and sign in to continue. Waiting campaigns remain queued.'};
      if(paired&&['blocked','busy','recovery_required'].includes(local.session?.state))session={...session,...local.session};
      container.innerHTML=html(session,[...merged.values()],turns.data||[]);
      const checks=container.querySelectorAll('[data-runner-stopped],[data-runner-reviewed]');
      const button=container.querySelector('[data-runner-recover]');
      if(button){
        checks.forEach(check=>check.addEventListener('change',()=>{button.disabled=![...checks].every(c=>c.checked);}));
        button.addEventListener('click',async()=>{
          if(state.getAccountId()!==state.userId||![...checks].every(c=>c.checked))return;
          button.disabled=true;
          const {data,error}=await state.sb.rpc('reachr_recover_runner_session',{p_expected_owner:session.owner,p_confirmation:'I confirmed the old runner is stopped and reviewed its attempts'});
          if(state.getAccountId()!==state.userId)return;
          const feedback=container.querySelector('[data-runner-feedback]');
          if(feedback)feedback.textContent=error?'Could not unlock the runner. Review active jobs and try again.':data?'Runner unlocked. Paused campaigns and retry holds remain in place.':'Runner ownership changed or a job is still processing. Refresh and review it.';
          if(data)setTimeout(safe,2000);
        });
      }
      if(jobs.error)container.insertAdjacentHTML('beforeend','<p role="status">The campaign queue could not be loaded. Refresh to try again.</p>');
    }
    const safe=()=>refresh().catch(()=>{if(mounts.get(container)===state&&state.getAccountId()===state.userId)container.textContent='Runner status is temporarily unavailable.';});
    await safe();state.timer=setInterval(()=>{if(!container.isConnected){clearInterval(state.timer);return;}if(document.visibilityState==='visible')safe();},15000);
  }
  root.ReachrRunnerDashboard=Object.freeze({mount,html,model});
})(globalThis);
