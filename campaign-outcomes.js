(function(root){
  'use strict';
  const labels={published:'Published',pending_approval:'Pending approval',declined:'Declined',removed:'Removed',unconfirmed:'Unconfirmed',failed:'Failed',skipped:'Skipped',waiting:'Waiting'};
  function array(value){try{return Array.isArray(value)?value:JSON.parse(value||'[]');}catch(_){return [];}}
  function result(job){try{return typeof job.result==='string'?JSON.parse(job.result):job.result||{};}catch(_){return {};}}
  function outcome(row){
    if(row.publication_verified===true&&row.status==='posted')return 'published';
    if(row.pending_approval===true||row.evidence_status==='pending_approval'||row.status==='pending_approval')return 'pending_approval';
    if(['declined','removed','failed','skipped'].includes(row.status))return row.status;
    return 'unconfirmed';
  }
  function summarize(job,monitors=[]){
    const saved=result(job),rows=array(saved.results);
    const counts=Object.fromEntries(Object.keys(labels).map(k=>[k,0]));
    const targets=rows.map(row=>{
      const matches=monitors.filter(m=>String(m.source_job_id)===String(job.id)&&m.group_url===row.group_url&&m.identity_name===(row.identity_name||job.identity_name));
      const monitor=matches.length===1?matches[0]:null;
      const established=monitor&&labels[monitor.status]&&monitor.status!=='unconfirmed'&&monitor.evidence?.verified===true;
      const status=established?monitor.status:outcome(row);
      counts[status]++;
      return {...row,outcome:status,evidence_url:monitor?.evidence?.post_url||monitor?.evidence?.source_view||row.post_url||null};
    });
    const total=Math.max(rows.length,array(job.groups).length,Number(saved.total_groups)||0);
    const missing=Math.max(0,total-rows.length);
    counts[['pending','processing','queued'].includes(job.status)?'waiting':'unconfirmed']+=missing;
    return {counts,total,targets,execution:job.status==='done'?'Execution finished':job.status==='paused'?'Paused for review':job.status==='processing'?'Running':job.status==='pending'?'Queued':job.status==='failed'?'Execution failed':job.status||'Unknown'};
  }
  root.ReachrCampaignOutcomes=Object.freeze({summarize,labels,result});
})(globalThis);
