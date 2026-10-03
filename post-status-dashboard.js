(function(root){
  'use strict';
  const mounts=new WeakMap();
  const labels={unconfirmed:'Unconfirmed',pending_approval:'Pending approval',published:'Published',declined:'Declined',removed:'Removed'};
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const date=s=>s?new Date(s).toLocaleString():'Not checked yet';
  function safeUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='www.facebook.com'&&!u.port&&!u.username&&!u.password&&/^\/groups\//.test(u.pathname)?u.href:null;}catch(_){return null;}}
  function attemptReviewRows(attempts,jobs,now=Date.now()){
    const byTarget=new Map(),jobStatus=new Map((jobs||[]).map(j=>[String(j.id),j.status]));
    for(const event of attempts||[]){
      const key=`${event.job_id}\u0000${event.group_url}`;
      const state=byTarget.get(key)||{};
      state[event.kind]=event;
      byTarget.set(key,state);
    }
    return [...byTarget.values()].filter(state=>{
      const handoff=state.command_handoff;
      if(!handoff||state.result)return false;
      const age=now-Date.parse(handoff.recorded_at||'');
      return jobStatus.get(String(handoff.job_id))!=='processing'||!Number.isFinite(age)||age>10*60*1000;
    }).map(state=>state.command_handoff).sort((a,b)=>Date.parse(b.recorded_at)-Date.parse(a.recorded_at));
  }
  function html(rows,events,online,review=[]){
    const counts={};for(const r of rows)counts[r.status]=(counts[r.status]||0)+1;
    const summary=Object.entries(labels).map(([s,l])=>`${counts[s]||0} ${l.toLowerCase()}`).join(' · ');
    const due=rows.filter(r=>r.next_check_at&&Date.parse(r.next_check_at)<=Date.now()).length;
    const checked=rows.map(r=>Date.parse(r.last_checked_at||'')).filter(Number.isFinite);
    const lastCheck=checked.length?new Date(Math.max(...checked)).toISOString():null;
    const reviewCards=review.slice(0,20).map(r=>{
      const url=safeUrl(r.group_url);
      return `<li><strong>${esc(r.payload?.identity_name||'Posting profile')}</strong> · ${esc(r.group_url)} · ${esc(date(r.recorded_at))}${url?` · <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open group</a>`:''}</li>`;
    }).join('');
    const alerts=events.filter(e=>e.kind!=='observed').map(e=>{
      const r=rows.find(a=>a.id===e.attempt_id);const url=safeUrl(e.evidence?.post_url||e.evidence?.source_view);
      const title=e.kind==='approved'?'Post approved':e.kind==='monitoring_unavailable'?'Monitoring needs attention':`Post ${e.kind}`;
      return `<li>${esc(title)}${r?' — '+esc(r.group_name||r.group_url):''} · ${esc(date(e.created_at))}${url?` · <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">View evidence</a>`:''}</li>`;
    }).join('');
    const cards=rows.slice(0,50).map(r=>{
      const url=safeUrl(r.evidence?.post_url||r.evidence?.source_view);
      return `<article style="padding:12px 0;border-top:1px solid var(--border,#ddd)"><strong>${esc(r.group_name||r.group_url)}</strong> · ${esc(r.identity_name)} · <strong>${esc(labels[r.status]||'Unconfirmed')}</strong>
      <div style="font-size:12px;margin-top:5px">Submitted ${esc(date(r.submitted_at))} · Last checked ${esc(date(r.last_checked_at))}${r.next_check_at?' · Next check '+esc(date(r.next_check_at)):' · '+esc(r.monitoring_state==='needs_review'?'Needs review':r.monitoring_state==='complete'?'Monitoring complete':r.monitoring_state==='checking'?'Check in progress':'Waiting for monitoring')}</div>
      ${r.last_error?`<div style="font-size:12px;margin-top:5px">${esc(r.last_error)}</div>`:''}
      ${url?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">View evidence</a> `:''}
      ${!['declined','removed'].includes(r.status)?`<button type="button" class="btn btn-secondary btn-sm" data-monitor-check="${esc(r.id)}" style="margin-top:6px">Check again</button>`:''}
      </article>`;
    }).join('');
    return `<section style="padding:20px;border:1px solid var(--border,#ddd);border-radius:18px;margin-bottom:16px;background:var(--surface,var(--card,#fff))"><h3 style="margin-bottom:8px">Post status and approvals</h3>
      <p style="font-size:13px;margin-bottom:8px">${online?'Worker online; posting and verification take turns.':'Worker offline or disconnected; approval checks will resume when it reconnects.'} Checks use the Page currently selected in Facebook.</p>
      ${review.length?`<details open role="status"><summary><strong>${review.length} posting handoff${review.length===1?' needs':'s need'} review</strong></summary><p style="font-size:12px;margin:8px 0">The posting command may have reached Facebook, but Reachr did not save a result. Check the exact group and profile before any retry.</p><ul style="padding:8px 20px">${reviewCards}</ul>${review.length>20?'<p>Showing the newest 20.</p>':''}</details>`:''}
      ${due?`<p role="status" style="font-size:13px;margin-bottom:8px">${due} verification checks due · Last check ${esc(date(lastCheck))}. Publication labels reflect the last confirmed observation.</p>`:''}
      <p style="font-size:13px;margin-bottom:12px">${rows.length?`Latest ${rows.length} monitored targets: ${esc(summary)}`:'No monitored submissions yet. New and recent saved submissions appear when the worker connects.'}</p>
      ${alerts?`<details open><summary>Recent approval and status alerts</summary><ul style="padding:12px 20px">${alerts}</ul></details>`:''}
      ${cards}${rows.length>50?'<p>Showing the newest 50 targets.</p>':''}<div data-monitor-feedback role="status" style="font-size:12px;margin-top:8px"></div></section>`;
  }
  async function mount(container,options){
    const previous=mounts.get(container);if(previous)clearInterval(previous.timer);
    const state={...options,revision:0};mounts.set(container,state);
    const refresh=async()=>{
      const rev=++state.revision;
      if(state.getAccountId()!==state.userId){clearInterval(state.timer);container.replaceChildren();return;}
      const [monitors,events,worker,attempts,jobs]=await Promise.all([
        state.sb.from('reachr_post_monitors').select('*').eq('user_id',state.userId).order('submitted_at',{ascending:false}).limit(1000),
        state.sb.from('reachr_post_monitor_events').select('*').eq('user_id',state.userId).neq('kind','observed').order('created_at',{ascending:false}).limit(20),
        state.sb.from('jsw_settings').select('ext_heartbeat').eq('user_id',state.userId).maybeSingle(),
        state.sb.from('reachr_group_attempt_events').select('job_id,group_url,kind,payload,recorded_at').eq('user_id',state.userId).order('recorded_at',{ascending:false}).limit(1000),
        state.sb.from('jsw_post_jobs').select('id,status').eq('user_id',state.userId).in('status',['processing','paused']).order('created_at',{ascending:false}).limit(200)
      ]);
      if(mounts.get(container)!==state||rev!==state.revision)return;
      if(state.getAccountId()!==state.userId){clearInterval(state.timer);container.replaceChildren();return;}
      if(monitors.error||events.error||attempts.error||jobs.error){container.innerHTML='<section style="padding:16px" role="status"><h3>Post status and approvals</h3><p>Post monitoring is unavailable. Reconnect the worker and refresh to try again.</p></section>';return;}
      const age=Date.now()-Date.parse(worker.data?.ext_heartbeat||'');
      if(state.onRows)state.onRows(monitors.data||[]);
      container.innerHTML=html(monitors.data||[],events.data||[],Number.isFinite(age)&&age>=0&&age<90000,
        attemptReviewRows(attempts.data||[],jobs.data||[]));
      container.querySelectorAll('[data-monitor-check]').forEach(button=>button.addEventListener('click',async()=>{
        if(state.getAccountId()!==state.userId)return;
        button.disabled=true;
        const {data,error}=await state.sb.rpc('reachr_request_monitor_check',{p_attempt_id:button.dataset.monitorCheck});
        if(state.getAccountId()!==state.userId)return;
        const feedback=container.querySelector('[data-monitor-feedback]');
        if(feedback)feedback.textContent=error?'Could not request this check. Try again.':data?'Check requested. It will run when the worker is available.':'A check is already running or this outcome is final.';
        button.disabled=false;
      }));
    };
    const safeRefresh=()=>refresh().catch(()=>{if(state.getAccountId()===state.userId&&mounts.get(container)===state)container.textContent='Post monitoring is temporarily unavailable.';});
    await safeRefresh();
    state.timer=setInterval(()=>{if(!container.isConnected){clearInterval(state.timer);return;}if(document.visibilityState==='visible')safeRefresh();},30000);
  }
  root.ReachrPostDashboard=Object.freeze({mount,html,safeUrl,attemptReviewRows});
})(globalThis);
