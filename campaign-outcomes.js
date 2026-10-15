(function(root){
  'use strict';
  const labels={submitted:'Submitted',unconfirmed:'Outcome unknown',failed:'Failed',skipped:'Skipped',waiting:'Waiting'};
  function array(value){try{return Array.isArray(value)?value:JSON.parse(value||'[]');}catch(_){return [];}}
  function result(job){try{return typeof job.result==='string'?JSON.parse(job.result):job.result||{};}catch(_){return {};}}
  function outcome(row){
    if(['posted','submitted_unconfirmed','pending_approval'].includes(row.status))return 'submitted';
    if(['failed','skipped'].includes(row.status))return row.status;
    return 'unconfirmed';
  }
  function summarize(job){
    const saved=result(job),rows=array(saved.results);
    const counts=Object.fromEntries(Object.keys(labels).map(k=>[k,0]));
    const targets=rows.map(row=>{
      const status=outcome(row);
      counts[status]++;
      return {...row,outcome:status,evidence_url:row.post_url||null};
    });
    const total=Math.max(rows.length,array(job.groups).length,Number(saved.total_groups)||0);
    const missing=Math.max(0,total-rows.length);
    counts[['pending','processing','queued'].includes(job.status)?'waiting':'unconfirmed']+=missing;
    return {counts,total,targets,execution:job.status==='done'?'Execution finished':job.status==='paused'?'Paused for review':job.status==='processing'?'Running':job.status==='pending'?'Queued':job.status==='failed'?'Execution failed':job.status||'Unknown'};
  }
  root.ReachrCampaignOutcomes=Object.freeze({summarize,labels,result});
})(globalThis);
