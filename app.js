// ═══ Amplr — Dashboard v3 (Supabase) ═══

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const GCOLORS = ['#3b82f6','#ef4444','#10b981','#f59e0b','#8b5cf6','#ec4899','#06b6d4','#84cc16'];

// ─── Supabase ───
const SUPABASE_URL = 'https://xacehhtgvubcqdoltazg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_1TNu5hqotJ7GGQXfjliivQ_ttK51EAA';
let sb = null;
let user = null;

try {
  sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  window.sb = sb;
} catch(e) {
  console.error('[Amplr] Supabase client failed', e);
  showAuthFallback?.('Could not load Supabase auth. Check your connection and try again.');
}

let connected = false;
let cachedData = { posts: [], logs: [], templates: [], groups: [], settings: {} };
let selDays = [1, 2, 3, 4, 5];
let groupCount = 0;
let calDate = new Date();
let schedChecker = null;

// ─── Init ───
document.addEventListener('DOMContentLoaded', () => {
  bootApp().catch(err => {
    console.error('[Amplr] startup failed', err);
    showAuthFallback(err?.message || 'Startup failed. Please refresh and sign in again.');
  });
});

function showAuthFallback(message) {
  const app = document.getElementById('app');
  const auth = document.getElementById('authScreen');
  if (app) app.style.display = 'none';
  if (auth) auth.style.display = 'flex';
  if (message) {
    const err = document.getElementById('authError');
    if (err) {
      err.textContent = message;
      err.style.display = 'block';
    }
  }
}

function safeStartupStep(name, fn) {
  try { return fn(); }
  catch (e) { console.warn(`[Amplr] ${name} skipped`, e); }
}

function byId(id) { return document.getElementById(id); }
function setText(id, value) { const el = byId(id); if (el) el.textContent = value; }
function setHtml(id, value) { const el = byId(id); if (el) el.innerHTML = value; }
function setStyle(id, prop, value) { const el = byId(id); if (el) el.style[prop] = value; }

async function bootApp() {
  safeStartupStep('theme init', initTheme);
  safeStartupStep('day picker init', renderDays);
  safeStartupStep('calendar header init', renderCalNames);
  safeStartupStep('nav init', setupNav);

  if (!sb?.auth) throw new Error('Auth library did not load. Check your connection and refresh.');

  // Check Supabase session. Do this inside a guarded boot path so a failed auth check
  // cannot leave both the login screen and app hidden.
  const { data, error } = await sb.auth.getSession();
  if (error) throw error;
  if (!data.session) {
    showAuthFallback('');
    return;
  }

  await bootAuthenticatedApp(data.session);
}

async function bootAuthenticatedApp(session) {
  user = session.user;

  const auth = document.getElementById('authScreen');
  const app = document.getElementById('app');
  if (auth) auth.style.display = 'none';
  if (app) app.style.display = '';
  window.__amplrBooted = true;

  // Show user email in sidebar once per boot.
  const footer = document.querySelector('.sidebar-footer');
  if (footer && user.email && !footer.querySelector('[data-user-info]')) {
    const userInfo = document.createElement('div');
    userInfo.dataset.userInfo = '1';
    userInfo.style.cssText = 'padding:8px 12px;font-size:12px;color:var(--text-3);border-bottom:1px solid var(--border);margin-bottom:8px;display:flex;align-items:center;gap:8px;';
    userInfo.innerHTML = '<div style="width:24px;height:24px;border-radius:50%;background:linear-gradient(120deg,#5B6FE8,#F368A8);flex-shrink:0;"></div><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(user.email) + '</span>';
    footer.insertBefore(userInfo, footer.firstChild);
  }

  // Render the shell immediately, then hydrate data in the background.
  loadSettings().catch(e => console.warn('[Amplr] settings load failed', e));
  loadDashboard().catch(e => console.warn('[Amplr] dashboard load failed', e));
  checkConn().catch(e => console.warn('[Amplr] connection check failed', e));
  setInterval(() => checkConn().catch(e => console.warn('[Amplr] connection check failed', e)), 30000);
  safeStartupStep('schedule checker init', startScheduleChecker);
}
window.bootAuthenticatedApp = bootAuthenticatedApp;

// ═══ THEME ═══
function initTheme() {
  const dark = localStorage.getItem('amplr_dark') === '1';
  if (dark) {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.getElementById('themeToggle')?.classList.add('on');
  }
}

function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (isDark) {
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('amplr_dark', '0');
    document.getElementById('themeToggle')?.classList.remove('on');
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('amplr_dark', '1');
    document.getElementById('themeToggle')?.classList.add('on');
  }
}

// ═══ NAV ═══
function setupNav() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => nav(item.dataset.page));
  });
}

function nav(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`page-${page}`)?.classList.add('active');
  document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active');
  switch (page) {
    case 'dashboard': loadDashboard(); break;
    case 'calendar': loadCalendar(); break;
    case 'create': loadTemplates(); break;
    case 'scheduled': loadScheduled(); break;
    case 'templates': loadTemplatesPage(); break;
    case 'groups': loadGroups(); break;
    case 'logs': loadLogs(); break;
    case 'settings': loadSettings(); break;
  }
}

// ═══ SUPABASE DATA LAYER ═══
// All dashboard data stored as JSON in amplr_data table.
// Posting creates rows in jsw_post_jobs (extension polls every 30s).

async function sbGet(key) {
  const { data } = await sb.from('amplr_data').select('value').eq('user_id', user.id).eq('key', key).maybeSingle();
  return data?.value || null;
}

async function sbSet(key, value) {
  const { error } = await sb.from('amplr_data').upsert(
    { user_id: user.id, key, value, updated_at: new Date().toISOString() },
    { onConflict: 'user_id,key' }
  );
  if (error) console.error('[Amplr] sbSet error:', key, error.message);
  return error;
}

async function getDashboardExtensionStatus() {
  const { data } = await sb.from('amplr_data')
    .select('value,updated_at')
    .eq('user_id', user.id)
    .eq('key', 'extension_status')
    .maybeSingle();
  return data?.value ? { ...data.value, row_updated_at: data.updated_at } : null;
}

function timeAgo(ts) {
  const t = ts ? Date.parse(ts) : NaN;
  if (!Number.isFinite(t)) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

async function checkConn() {
  const bar = document.getElementById('connBar');
  const dot = document.getElementById('connDot');
  const label = document.getElementById('connLabel');

  if (!user || !bar || !dot || !label) return;

  try {
    const [settingsRes, status, recentRes] = await Promise.all([
      sb.from('jsw_settings').select('ext_heartbeat').eq('user_id', user.id).maybeSingle(),
      getDashboardExtensionStatus(),
      sb.from('jsw_post_jobs')
        .select('status,message')
        .eq('user_id', user.id)
        .in('status', ['pending', 'processing'])
        .order('created_at', { ascending: false })
        .limit(1)
    ]);

    const hb = settingsRes.data?.ext_heartbeat || status?.last_seen || status?.row_updated_at;
    const hbAge = hb ? Date.now() - new Date(hb).getTime() : Infinity;
    const isOnline = hbAge < 90000; // heartbeat within 90s
    const activeJob = recentRes.data?.[0] || null;
    const extVersion = status?.version && status.version !== 'unknown' ? ` v${status.version}` : '';
    const lastSeen = hb ? ` · ${timeAgo(hb)}` : '';

    if (isOnline) {
      connected = true;
      bar.className = 'conn-bar connected';
      dot.className = 'conn-dot on';
      if (activeJob?.status === 'processing') {
        label.textContent = activeJob.message === '__import_groups__' ? 'Syncing groups...' : 'Posting...';
      } else if (activeJob?.status === 'pending') {
        label.textContent = activeJob.message === '__import_groups__' ? 'Group sync queued' : 'Job queued';
      } else {
        label.textContent = `Connected${extVersion}${lastSeen}`;
      }
      label.title = `Extension online${extVersion}${hb ? ` · last seen ${new Date(hb).toLocaleString()}` : ''}`;
    } else {
      connected = false;
      bar.className = 'conn-bar disconnected';
      dot.className = 'conn-dot off';
      label.textContent = hb ? `Extension offline · last seen ${timeAgo(hb)}` : 'Extension offline';
      label.title = 'Open the Amplr Chrome extension and sign in with this dashboard account.';
    }
  } catch (e) {
    connected = false;
    bar.className = 'conn-bar disconnected';
    dot.className = 'conn-dot off';
    label.textContent = 'Connection check failed';
    label.title = e.message || 'Could not check extension connection';
  }

  // Keep this lightweight. Heavy page data is loaded by the active page renderer,
  // not by the 30s heartbeat poll. Re-fetching everything here made startup and
  // periodic checks feel slow.

  // Check for resolved group names from extension
  await pollGroupNames();

  // Fetch extension logs
  await pollExtLogs();
}

// ─── Extension logs ───
async function pollExtLogs() {
  try {
    const { data: logs } = await sb.from('jsw_ext_logs')
      .select('level, message, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(30);

    const el = document.getElementById('extLogList');
    if (!el) return;

    if (!logs || !logs.length) {
      if (!el.querySelector('[data-empty]')) {
        el.innerHTML = '<div data-empty style="color:var(--text-3);padding:20px;text-align:center;">No activity yet. Extension logs will appear here.</div>';
      }
      return;
    }

    const colors = { error: 'var(--red)', warn: 'var(--yellow)', info: 'var(--text-2)' };
    const noisy = /resumed polling for user/i;
    const filtered = [];
    let suppressedPolling = 0;
    logs.forEach(l => {
      if (noisy.test(l.message || '')) { suppressedPolling++; return; }
      filtered.push(l);
    });
    const rows = filtered.slice(0, 20).map(l => {
      const time = new Date(l.created_at).toLocaleTimeString('en-US', { hour12: false });
      const color = colors[l.level] || 'var(--text-2)';
      return `<div style="display:flex;gap:8px;padding:3px 0;border-bottom:1px solid var(--border);">
        <span style="color:var(--text-3);flex-shrink:0;">${time}</span>
        <span style="color:${color};font-weight:${l.level === 'error' ? '700' : '400'};word-break:break-word;">${esc(l.message)}</span>
      </div>`;
    });
    if (suppressedPolling) rows.push(`<div style="color:var(--text-3);padding:6px 0;">Collapsed ${suppressedPolling} routine polling heartbeat log${suppressedPolling === 1 ? '' : 's'}.</div>`);
    el.innerHTML = rows.length ? rows.join('') : '<div style="color:var(--text-3);padding:20px;text-align:center;">Only routine polling heartbeats recently.</div>';

    // Auto-cleanup old logs (>1 hour)
    await sb.from('jsw_ext_logs')
      .delete()
      .eq('user_id', user.id)
      .lt('created_at', new Date(Date.now() - 3600000).toISOString());
  } catch (e) { /* silent */ }
}

async function clearExtLogs() {
  try {
    await sb.from('jsw_ext_logs').delete().eq('user_id', user.id);
    const el = document.getElementById('extLogList');
    if (el) el.innerHTML = '<div style="color:var(--text-3);padding:20px;text-align:center;">Logs cleared.</div>';
  } catch (e) {
    toast('Could not clear logs');
  }
}

// ─── Auto-name resolution ───
async function pollGroupNames() {
  try {
    const { data: resolved } = await sb.from('jsw_group_lookups')
      .select('group_url, group_name, status')
      .eq('user_id', user.id)
      .eq('status', 'done')
      .not('group_name', 'is', null)
      .limit(20);

    if (!resolved || !resolved.length) return;

    let changed = false;
    const groups = cachedData.groups || [];
    resolved.forEach(r => {
      const g = groups.find(g => g.url === r.group_url);
      if (g && g.name !== r.group_name) {
        g.name = r.group_name;
        g.namePending = false;
        changed = true;
      }
    });

    if (changed) {
      cachedData.groups = groups;
      await sbSet('groups', groups);
      const groupPageVisible = document.querySelector('[data-page="groups"]')?.classList.contains('active');
      if (groupPageVisible) loadGroups();
    }

    // Clean up resolved lookups older than 1 hour
    await sb.from('jsw_group_lookups')
      .delete()
      .eq('user_id', user.id)
      .eq('status', 'done')
      .lt('resolved_at', new Date(Date.now() - 3600000).toISOString());
  } catch (e) { /* silent */ }
}

async function fetchAll() {
  try {
    const [postsRes, templatesRes, groupsRes, settings, logs] = await Promise.all([
      sbGet('posts'),
      sbGet('templates'),
      // Groups always come from jsw_groups table (shared with extension)
      sb.from('jsw_groups')
        .select('group_url, group_name, last_posted_at, ban_risk, removal_count, tags')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false }),
      sbGet('settings'),
      sbGet('logs'),
    ]);
    const groups = (groupsRes.data || []).map(r => ({
      url: r.group_url,
      name: r.group_name || r.group_url.split('/').filter(Boolean).pop(),
      last_posted_at: r.last_posted_at || null,
      ban_risk: r.ban_risk || 'low',
      removal_count: r.removal_count || 0,
      tags: Array.isArray(r.tags) ? r.tags : [],
    }));
    return {
      posts: postsRes || [],
      logs: logs || [],
      templates: templatesRes || [],
      groups,
      settings: settings || {},
    };
  } catch (e) {
    return cachedData;
  }
}

// Create a posting job that the extension picks up
async function createJob(post) {
  const groups = (post.groups || []).map(g => typeof g === 'string' ? g : g.url).filter(Boolean);
  const settings = cachedData.settings || {};
  // Ollama needs no API key — toggle alone is enough
  const aiEnabled = document.getElementById('aiToggle')?.classList.contains('on');
  const { error } = await sb.from('jsw_post_jobs').insert({
    user_id: user.id,
    message: post.text,
    image_url: post.imageUrl || null,
    groups: groups,
    delay: settings.delay || 30,
    ai_enabled: !!aiEnabled,
    ai_prompt: settings.ai_prompt || null,
    first_comment: post.firstComment || post.first_comment || null,
    status: 'pending',
  });
  if (error) throw new Error(error.message);
}

// ═══ SPINTAX ═══
function hasSpintax(text) { return /\{[^}]+\|[^}]+\}/.test(text); }
function spinVariation(text) {
  return text.replace(/\{([^}]+)\}/g, (_, c) => {
    const o = c.split('|'); return o[Math.floor(Math.random() * o.length)];
  });
}
function countVariations(text) {
  let count = 1; const r = /\{([^}]+)\}/g; let m;
  while ((m = r.exec(text)) !== null) count *= m[1].split('|').length;
  return count;
}
function normalizeGroupRef(g) {
  if (!g) return '';
  if (typeof g === 'string') return g;
  return g.url || g.group_url || g.name || g.group_name || '';
}
function groupDisplayName(ref) {
  const raw = normalizeGroupRef(ref);
  if (!raw) return 'Unknown group';
  const saved = (cachedData.groups || []).find(g => g.url === raw || g.name === raw);
  if (saved?.name) return saved.name;
  try {
    const u = raw.includes('://') ? new URL(raw) : null;
    const part = u ? u.pathname.split('/').filter(Boolean).pop() : raw.split('/').filter(Boolean).pop();
    return decodeURIComponent(part || raw).replace(/[-_]/g, ' ');
  } catch (_) {
    return String(raw);
  }
}
function isSystemJob(j) {
  return !j || j.message === '__import_groups__' || (j.message || '').startsWith('__');
}
function jobResultCounts(j) {
  const count = Math.max((Array.isArray(j.groups) ? j.groups.length : 0), 1);
  if (j.status === 'done') return { ok: count, fail: 0 };
  if (j.status === 'failed') return { ok: 0, fail: count };
  return { ok: 0, fail: 0 };
}

// ═══ DASHBOARD ═══
async function loadDashboard() {
  cachedData = await fetchAll();
  const { posts, logs } = cachedData;
  const active = posts.filter(p => p.enabled).length;

  // Pull real data from jsw_post_jobs (extension results)
  const { data: jobs } = await sb.from('jsw_post_jobs')
    .select('status, groups, created_at, completed_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(200);

  let ok = 0, fail = 0, postsThisWeek = 0;
  const groupUrls = new Set();
  const dayMap = {};

  if (jobs && jobs.length) {
    const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
    jobs.forEach(j => {
      const g = Array.isArray(j.groups) ? j.groups : [];
      const count = g.length || 1;
      if (j.status === 'done') ok += count;
      else if (j.status === 'failed') fail += count;
      g.forEach(gu => { const u = typeof gu === 'string' ? gu : gu.url; if (u) groupUrls.add(u); });

      const ts = j.completed_at || j.created_at;
      if (ts) {
        if (new Date(ts) >= weekAgo) postsThisWeek++;
        const dStr = new Date(ts).toDateString();
        if (!dayMap[dStr]) dayMap[dStr] = { ok: 0, fail: 0 };
        if (j.status === 'done') dayMap[dStr].ok += count;
        else if (j.status === 'failed') dayMap[dStr].fail += count;
      }
    });
  }

  // Also count old local logs
  (logs || []).forEach(l => {
    (l.results || []).forEach(r => {
      if (r.success) ok++;
      else fail++;
      const ts = l.timestamp;
      if (ts) {
        const dStr = new Date(ts).toDateString();
        if (!dayMap[dStr]) dayMap[dStr] = { ok: 0, fail: 0 };
        if (r.success) dayMap[dStr].ok++;
        else dayMap[dStr].fail++;
      }
    });
  });

  // Groups from saved groups too
  (cachedData.groups || []).forEach(g => groupUrls.add(g.url));

  // Compute stats
  const totalAttempts = ok + fail;
  const hasActivity = totalAttempts > 0;
  const successRate = hasActivity ? Math.round((ok / totalAttempts) * 100) : 0;

  // Ban risk calculation
  // Factors: posts/day in last 7 days, avg groups per post, failure rate
  const postsPerDay = postsThisWeek / 7;
  const avgGroupsPerPost = postsThisWeek > 0 ? Math.round(ok / postsThisWeek) : 0;
  let banScore = 0;
  if (postsPerDay >= 10) banScore += 40; else if (postsPerDay >= 5) banScore += 25; else if (postsPerDay >= 3) banScore += 10;
  if (avgGroupsPerPost >= 20) banScore += 35; else if (avgGroupsPerPost >= 10) banScore += 20; else if (avgGroupsPerPost >= 5) banScore += 10;
  if (successRate < 50) banScore += 25; else if (successRate < 80) banScore += 10;
  const banLevel = banScore >= 60 ? 'High' : banScore >= 30 ? 'Medium' : 'Low';
  const banColor = banScore >= 60 ? 'var(--red)' : banScore >= 30 ? 'var(--yellow)' : 'var(--green)';

  setText('sPostsWeek', postsThisWeek);
  setText('sGroupsHit', groupUrls.size);
  setText('sSuccessRate', hasActivity ? successRate + '%' : '—');
  setText('sBanRisk', hasActivity ? banLevel : '—');
  setStyle('sBanRisk', 'color', hasActivity ? banColor : 'var(--text-3)');
  setText('navCount', posts.length);

  // 7-day chart from real job data
  const days7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const dStr = d.toDateString();
    const entry = dayMap[dStr] || { ok: 0, fail: 0 };
    days7.push({ label: DAYS[d.getDay()], ok: entry.ok, fail: entry.fail, total: entry.ok + entry.fail });
  }
  const maxVal = Math.max(...days7.map(d => d.total), 1);
  setHtml('chart7day', days7.map(d => {
    const okH = (d.ok / maxVal) * 100;
    const failH = (d.fail / maxVal) * 100;
    return `<div class="chart-col">
      <div style="width:100%;display:flex;flex-direction:column;justify-content:flex-end;height:100px;">
        <div class="chart-bar-fill red" style="height:${failH}%;min-height:${d.fail > 0 ? '4px' : '0'};" title="${d.fail} failed"></div>
        <div class="chart-bar-fill green" style="height:${okH}%;min-height:${d.ok > 0 ? '4px' : '0'};" title="${d.ok} success"></div>
      </div>
      <div class="chart-label">${d.label}</div>
    </div>`;
  }).join(''));

  // Upcoming
  const upcoming = posts.filter(p => p.enabled).slice(0, 5);
  setHtml('dashUpcoming', upcoming.length === 0
    ? '<div class="empty"><p>No scheduled posts</p></div>'
    : upcoming.map(p => {
        const days = p.schedule.days.map(d => DAYS[d]).join(', ');
        const spin = hasSpintax(p.text) ? ' <span class="spin-badge">SPIN</span>' : '';
        return `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);">
          <div style="flex:1;">
            <div style="font-weight:600;font-size:13px;">${esc(p.text.substring(0, 50))}${p.text.length > 50 ? '...' : ''}${spin}</div>
            <div style="font-size:11px;color:var(--text-3);margin-top:2px;">${p.schedule.time} • ${days} • ${p.groups.length} groups</div>
          </div>
          <button class="btn btn-primary btn-xs" onclick="firePost('${p.id}')">Post</button>
        </div>`;
      }).join(''));

  // Top groups from real extension jobs plus legacy logs
  const groupStats = {};
  (jobs || []).filter(j => !isSystemJob(j)).forEach(j => {
    const refs = Array.isArray(j.groups) ? j.groups : [];
    const { ok: jobOk, fail: jobFail } = jobResultCounts(j);
    refs.forEach(ref => {
      const key = normalizeGroupRef(ref);
      if (!key) return;
      if (!groupStats[key]) groupStats[key] = { ok: 0, fail: 0, name: groupDisplayName(key) };
      if (j.status === 'done') groupStats[key].ok += 1;
      else if (j.status === 'failed') groupStats[key].fail += 1;
    });
    if (!refs.length && (jobOk || jobFail)) {
      const key = 'Unknown group';
      if (!groupStats[key]) groupStats[key] = { ok: 0, fail: 0, name: key };
      groupStats[key].ok += jobOk;
      groupStats[key].fail += jobFail;
    }
  });
  (logs || []).forEach(l => {
    (l.results || []).forEach(r => {
      const key = normalizeGroupRef(r.group);
      if (!key) return;
      if (!groupStats[key]) groupStats[key] = { ok: 0, fail: 0, name: groupDisplayName(key) };
      if (r.success) groupStats[key].ok++; else groupStats[key].fail++;
    });
  });
  const topGroups = Object.values(groupStats)
    .map(s => ({ rate: s.ok + s.fail > 0 ? Math.round(s.ok / (s.ok + s.fail) * 100) : 0, ...s }))
    .sort((a, b) => (b.ok + b.fail) - (a.ok + a.fail) || b.ok - a.ok).slice(0, 5);
  setHtml('dashTopGroups', topGroups.length === 0
    ? '<div style="text-align:center;color:var(--text-3);font-size:13px;padding:12px;">No post attempts yet</div>'
    : topGroups.map(g => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);">
        <span style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px;">${esc(g.name)}</span>
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:12px;color:var(--text-3);">${g.ok}/${g.ok + g.fail}</span>
          <div style="width:50px;height:6px;background:var(--surface-2);border-radius:3px;overflow:hidden;">
            <div style="width:${g.rate}%;height:100%;background:${g.rate > 80 ? 'var(--green)' : g.rate > 50 ? 'var(--yellow)' : 'var(--red)'};"></div>
          </div>
        </div>
      </div>`).join(''));
}

// ═══ CALENDAR ═══
function renderCalNames() {
  document.getElementById('calDayNames').innerHTML = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
    .map(d => `<div class="cal-day-name">${d}</div>`).join('');
}
async function loadCalendar() { cachedData = await fetchAll(); renderCalendar(); }
function renderCalendar() {
  const year = calDate.getFullYear(), month = calDate.getMonth();
  document.getElementById('calMonth').textContent = `${MONTHS[month]} ${year}`;
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevDays = new Date(year, month, 0).getDate();
  const today = new Date();
  let html = '';
  for (let i = firstDay - 1; i >= 0; i--) html += `<div class="cal-day other"><div class="cal-day-num">${prevDays - i}</div></div>`;
  const posts = cachedData.posts || [];
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month, d), dayOfWeek = date.getDay();
    const isToday = date.toDateString() === today.toDateString();
    const dayPosts = posts.filter(p => p.enabled && p.schedule.days.includes(dayOfWeek));
    const events = dayPosts.map(p => {
      const colors = ['blue','green','purple']; const c = colors[p.id.charCodeAt(0) % 3];
      return `<div class="cal-event ${c}" onclick="nav('scheduled')" title="${esc(p.text.substring(0, 40))}...">${p.schedule.time} ${esc(p.text.substring(0, 20))}...</div>`;
    }).join('');
    html += `<div class="cal-day ${isToday ? 'today' : ''}"><div class="cal-day-num">${d}</div>${events}</div>`;
  }
  const totalCells = firstDay + daysInMonth;
  const remaining = (7 - (totalCells % 7)) % 7;
  for (let i = 1; i <= remaining; i++) html += `<div class="cal-day other"><div class="cal-day-num">${i}</div></div>`;
  document.getElementById('calGrid').innerHTML = html;
}
function prevMonth() { calDate.setMonth(calDate.getMonth() - 1); renderCalendar(); }
function nextMonth() { calDate.setMonth(calDate.getMonth() + 1); renderCalendar(); }

// ═══ CREATE ═══
function renderDays() {
  document.getElementById('createDays').innerHTML = DAYS.map((name, i) =>
    `<div class="day-chip ${selDays.includes(i) ? 'selected' : ''}" onclick="toggleDay(${i})">${name}</div>`
  ).join('');
}
function toggleDay(d) { selDays = selDays.includes(d) ? selDays.filter(x => x !== d) : [...selDays, d].sort(); renderDays(); updateNextFire(); }

document.addEventListener('input', (e) => {
  if (e.target.id === 'createText') {
    const val = e.target.value;

    // Spintax badge
    const has = hasSpintax(val);
    const badge = document.getElementById('spinInfo');
    if (has) {
      badge.style.display = 'inline-flex';
      badge.textContent = `${countVariations(val)} VARIATIONS`;
    } else { badge.style.display = 'none'; }

    // Character counter
    updateCharCounter(val.length);

    // FB live preview
    updateFbPreview(val);

    // Auto-save draft
    clearTimeout(window._draftTimer);
    window._draftTimer = setTimeout(() => {
      localStorage.setItem('amplr_draft', val);
    }, 2000);
  }

  if (e.target.id === 'createImageUrl') {
    const url = e.target.value.trim();
    const isValid = url.startsWith('http');
    const thumb = document.getElementById('imagePreviewThumb');
    const img = document.getElementById('imagePreviewImg');
    const wrap = document.getElementById('fbPreviewImgWrap');
    const fbImg = document.getElementById('fbPreviewImgEl');
    if (thumb) thumb.style.display = isValid ? 'block' : 'none';
    if (img && isValid) img.src = url;
    if (wrap) wrap.style.display = isValid ? 'block' : 'none';
    if (fbImg && isValid) fbImg.src = url;
  }
});

async function savePost() {
  const text = document.getElementById('createText').value.trim();
  const time = document.getElementById('createTime').value;
  if (!text) return toast('Write something first');
  if (selDays.length === 0) return toast('Pick at least one day');
  const groups = getSelectedGroups();
  if (groups.length === 0) return toast('Select at least one group');
  const imageUrl = document.getElementById('createImageUrl')?.value.trim() || '';
  const post = {
    id: Date.now().toString(), text, imageUrl, groups,
    firstComment: document.getElementById('createFirstComment')?.value.trim() || '',
    schedule: { time, days: [...selDays] }, enabled: true,
    createdAt: new Date().toISOString(),
    hasSpintax: hasSpintax(text), variations: countVariations(text),
  };
  const posts = [...(cachedData.posts || []), post];
  cachedData.posts = posts;
  const err = await sbSet('posts', posts);
  if (err) return toast('Error: ' + err.message);
  toast('Scheduled!');
  clearCreateForm();
  nav('scheduled');
}

async function postNow() {
  const text = document.getElementById('createText').value.trim();
  const groups = getSelectedGroups();
  if (!text) return toast('Write something first');
  if (groups.length === 0) return toast('Select at least one group');
  if (groups.length > 3 && !confirm(`Post this now to ${groups.length} groups?`)) return;
  const imageUrl = document.getElementById('createImageUrl')?.value.trim() || '';

  const waiting = document.getElementById('postWaiting');
  if (waiting) waiting.style.display = 'block';

  try {
    const { error } = await sb.from('jsw_post_jobs').insert({
      user_id: user.id,
      message: text,
      image_url: imageUrl || null,
      groups: groups.map(g => g.url),
      delay: cachedData.settings?.delay || 30,
      status: 'pending',
      first_comment: document.getElementById('createFirstComment')?.value.trim() || null,
      ai_enabled: !!document.getElementById('aiToggle')?.classList.contains('on'),
    });
    if (error) throw new Error(error.message);

    if (waiting) waiting.style.display = 'none';
    toast('Sent — extension will post it');
    clearCreateForm();
  } catch (e) {
    if (waiting) waiting.style.display = 'none';
    toast('Error: ' + e.message);
  }
}

async function saveTemplate() {
  const text = document.getElementById('createText').value.trim();
  if (!text) return toast('Nothing to save');
  const name = prompt('Template name:');
  if (!name) return;
  const firstComment = document.getElementById('createFirstComment')?.value.trim() || '';
  const template = { id: Date.now().toString(), name, text, firstComment, createdAt: new Date().toISOString() };
  const templates = [...(cachedData.templates || []), template];
  cachedData.templates = templates;
  await sbSet('templates', templates);
  toast('Template saved');
}

async function loadTemplates() {
  cachedData = await fetchAll();
  renderGroupChips();
  restoreDraft();
  updateNextFire();
  const templates = cachedData.templates || [];
  document.getElementById('quickTemplates').innerHTML = templates.length === 0
    ? '<div style="font-size:12px;color:var(--text-3);">No saved templates yet</div>'
    : templates.map(t => `
      <div class="template-card" onclick="useTemplate('${t.id}')">
        <div class="template-name">${esc(t.name)}</div>
        <div class="template-preview">${esc(t.text.substring(0, 80))}...</div>
      </div>`).join('');
}

// ─── Tag filter state for group chip selectors ───
let createGroupTagFilter = null;
let tplGroupTagFilter = null;

function renderTagFilterBar(containerId, groups, currentFilter, onClickFn) {
  const bar = document.getElementById(containerId);
  if (!bar) return;
  const allTags = [...new Set(groups.flatMap(g => g.tags || []))].sort();
  if (allTags.length === 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  bar.innerHTML = [
    `<span class="tag-filter-pill ${currentFilter === null ? 'active' : ''}" onclick="${onClickFn}(null)">All</span>`,
    ...allTags.map(t => `<span class="tag-filter-pill ${currentFilter === t ? 'active' : ''}" onclick="${onClickFn}(${JSON.stringify(t)})">${esc(t)}</span>`)
  ].join('');
}

function renderGroupChipsFiltered(containerId, groups, currentFilter) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const filtered = currentFilter ? groups.filter(g => (g.tags || []).includes(currentFilter)) : groups;

  // Hide/show existing chips based on filter
  [...container.querySelectorAll('.group-chip')].forEach(chip => {
    const g = groups.find(x => x.url === chip.dataset.url);
    const show = !currentFilter || (g && (g.tags || []).includes(currentFilter));
    chip.style.display = show ? '' : 'none';
  });
}

function setCreateGroupTagFilter(tag) {
  createGroupTagFilter = tag;
  const groups = cachedData.groups || [];
  renderTagFilterBar('createGroupTagBar', groups, createGroupTagFilter, 'setCreateGroupTagFilter');
  renderGroupChipsFiltered('createGroupSelect', groups, createGroupTagFilter);
}

function setTplGroupTagFilter(tag) {
  tplGroupTagFilter = tag;
  const groups = cachedData.groups || [];
  renderTagFilterBar('tplGroupTagBar', groups, tplGroupTagFilter, 'setTplGroupTagFilter');
  renderGroupChipsFiltered('tplGroupSelect', groups, tplGroupTagFilter);
}

function renderGroupChips() {
  const groups = cachedData.groups || [];
  const container = document.getElementById('createGroupSelect');
  const noGroups = document.getElementById('createNoGroups');
  if (!container) return;

  if (groups.length === 0) {
    container.innerHTML = '';
    if (noGroups) noGroups.style.display = 'block';
    renderTagFilterBar('createGroupTagBar', groups, createGroupTagFilter, 'setCreateGroupTagFilter');
    return;
  }
  if (noGroups) noGroups.style.display = 'none';

  container.innerHTML = groups.map((g, i) => {
    const c = GCOLORS[i % GCOLORS.length];
    return `<div class="group-chip" onclick="this.classList.toggle('selected')" data-url="${esc(g.url)}" data-name="${esc(g.name)}"
      style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:20px;font-size:12px;cursor:pointer;border:1px solid var(--border);background:var(--surface);transition:all .15s;">
      <div style="width:8px;height:8px;border-radius:50%;background:${c};"></div>
      ${esc(g.name)}
    </div>`;
  }).join('');

  // Add selected style dynamically
  if (!document.getElementById('chipSelectedStyle')) {
    const style = document.createElement('style');
    style.id = 'chipSelectedStyle';
    style.textContent = '.group-chip.selected { background: rgba(91,111,232,.15) !important; border-color: #5B6FE8 !important; color: #5B6FE8; }';
    document.head.appendChild(style);
  }

  // Render tag filter bar and apply current filter
  renderTagFilterBar('createGroupTagBar', groups, createGroupTagFilter, 'setCreateGroupTagFilter');
  if (createGroupTagFilter) renderGroupChipsFiltered('createGroupSelect', groups, createGroupTagFilter);
}

function getSelectedGroups() {
  return [...document.querySelectorAll('#createGroupSelect .group-chip.selected')].map(c => ({
    url: c.dataset.url,
    name: c.dataset.name,
  }));
}

function useTemplate(id) {
  const t = (cachedData.templates || []).find(x => x.id === id);
  if (!t) return;
  document.getElementById('createText').value = t.text;
  document.getElementById('createText').dispatchEvent(new Event('input'));
  const fcEl = document.getElementById('createFirstComment');
  if (fcEl) fcEl.value = t.firstComment || '';
  toast(`Loaded: ${t.name}`);
}

// ═══ TEMPLATES PAGE ═══
let activeTplId = null;

async function loadTemplatesPage() {
  cachedData = await fetchAll();
  const templates = cachedData.templates || [];
  const el = document.getElementById('templatesList');
  if (templates.length === 0) {
    el.innerHTML = '<div class="empty"><p>No templates yet.</p><button class="btn btn-primary" style="margin-top:12px;" onclick="nav(\'create\')">Create your first</button></div>';
    return;
  }
  el.innerHTML = templates.map(t => `
    <div style="display:flex;align-items:center;gap:14px;padding:14px 0;border-bottom:1px solid var(--border);cursor:pointer;" onclick="openTplModal('${t.id}')" onmouseover="this.style.background='var(--surface-2)'" onmouseout="this.style.background=''">
      <div style="flex:1;min-width:0;">
        <div style="font-size:14px;font-weight:600;margin-bottom:2px;">${esc(t.name)} ${hasSpintax(t.text) ? '<span class="spin-badge">SPINTAX</span>' : ''}</div>
        <div style="font-size:12px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(t.text.substring(0, 100))}</div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();openTplModal('${t.id}')">Post</button>
      <button class="btn btn-ghost btn-sm" style="color:var(--red);" onclick="event.stopPropagation();deleteTemplate('${t.id}')">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4h10M5 4V2.5C5 2 5.5 1.5 6 1.5h4c0.5 0 1 0.5 1 1V4M6 7v6M10 7v6M4 4l1 10c0 0.5 0.5 1 1 1h4c0.5 0 1-0.5 1-1l1-10"/></svg>
      </button>
    </div>`).join('');
}

function openTplModal(id) {
  const t = (cachedData.templates || []).find(x => x.id === id);
  if (!t) return;
  activeTplId = id;
  document.getElementById('tplModalName').textContent = t.name;
  document.getElementById('tplModalPreview').textContent = t.text;

  // Render group chips
  const groups = cachedData.groups || [];
  const container = document.getElementById('tplGroupSelect');
  if (groups.length === 0) {
    container.innerHTML = '<div style="font-size:13px;color:var(--text-3);">No groups yet — <a href="#" onclick="nav(\'groups\');closeTplModal();return false;" style="color:var(--blue);">add groups first</a></div>';
  } else {
    container.innerHTML = groups.map((g, i) => {
      const c = GCOLORS[i % GCOLORS.length];
      return `<div class="group-chip" data-url="${esc(g.url)}" data-name="${esc(g.name)}" onclick="this.classList.toggle('selected')"
        style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:20px;font-size:12px;cursor:pointer;border:1px solid var(--border);background:var(--surface);transition:all .15s;">
        <div style="width:8px;height:8px;border-radius:50%;background:${c};"></div>${esc(g.name)}</div>`;
    }).join('');
    // Render tag filter bar for modal
    tplGroupTagFilter = null;
    renderTagFilterBar('tplGroupTagBar', groups, tplGroupTagFilter, 'setTplGroupTagFilter');
  }

  // Reset state
  document.getElementById('tplAiToggle').classList.remove('on');
  document.getElementById('tplPosting').style.display = 'none';
  const fcEl = document.getElementById('tplFirstComment');
  if (fcEl) fcEl.value = t.firstComment || '';
  const modal = document.getElementById('tplModal');
  modal.style.display = 'flex';
}

function closeTplModal() {
  document.getElementById('tplModal').style.display = 'none';
  activeTplId = null;
}

function tplSelectAll() {
  document.querySelectorAll('#tplGroupSelect .group-chip').forEach(c => c.classList.add('selected'));
}

function tplClearAll() {
  document.querySelectorAll('#tplGroupSelect .group-chip').forEach(c => c.classList.remove('selected'));
}

function editTemplate() {
  if (!activeTplId) return;
  const id = activeTplId;
  closeTplModal();
  nav('create');
  setTimeout(() => useTemplate(id), 100);
}

async function postTemplate() {
  if (!activeTplId) return;
  const t = (cachedData.templates || []).find(x => x.id === activeTplId);
  if (!t) return;

  const selected = [...document.querySelectorAll('#tplGroupSelect .group-chip.selected')].map(c => ({
    url: c.dataset.url, name: c.dataset.name
  }));
  if (selected.length === 0) return toast('Select at least one group');

  const aiEnabled = document.getElementById('tplAiToggle').classList.contains('on');
  const postingEl = document.getElementById('tplPosting');
  postingEl.style.display = 'flex';

  try {
    const settings = cachedData.settings || {};
    const groups = selected.map(g => g.url);
    const { error } = await sb.from('jsw_post_jobs').insert({
      user_id: user.id,
      message: t.text,
      image_url: null,
      groups,
      delay: settings.delay || 30,
      ai_enabled: aiEnabled,
      ai_prompt: settings.ai_prompt || null,
      status: 'pending',
      first_comment: document.getElementById('tplFirstComment')?.value.trim() || null,
    });
    if (error) throw new Error(error.message);
    closeTplModal();
    toast(`Sent to ${selected.length} group${selected.length > 1 ? 's' : ''} — extension will post`);
  } catch (e) {
    toast('Error: ' + e.message);
    postingEl.style.display = 'none';
  }
}


async function deleteTemplate(id) {
  if (!confirm('Delete this template?')) return;
  const templates = (cachedData.templates || []).filter(t => t.id !== id);
  cachedData.templates = templates;
  await sbSet('templates', templates);
  loadTemplatesPage();
  toast('Deleted');
}

function toggleTplSchedule() {
  const panel = document.getElementById('tplSchedulePanel');
  const btn = document.getElementById('tplScheduleToggleBtn');
  if (!panel) return;
  const showing = panel.style.display !== 'none';
  panel.style.display = showing ? 'none' : 'block';
  if (btn) btn.style.background = showing ? '' : 'var(--blue-light)';
  // Reset day chips
  if (!showing) {
    document.querySelectorAll('#tplDayPicker .day-chip').forEach(c => c.classList.remove('selected'));
    document.querySelectorAll('#tplDayPicker .day-chip').forEach(c =>
      c.onclick = () => c.classList.toggle('selected')
    );
  }
}

async function scheduleTemplate() {
  if (!activeTplId) return;
  const t = (cachedData.templates || []).find(x => x.id === activeTplId);
  if (!t) return;

  const selected = [...document.querySelectorAll('#tplGroupSelect .group-chip.selected')].map(c => c.dataset.url);
  if (selected.length === 0) return toast('Select at least one group');

  const days = [...document.querySelectorAll('#tplDayPicker .day-chip.selected')].map(c => parseInt(c.dataset.day));
  if (days.length === 0) return toast('Select at least one day');

  const time = document.getElementById('tplScheduleTime')?.value || '09:00';
  const aiEnabled = document.getElementById('tplAiToggle').classList.contains('on');
  const settings = cachedData.settings || {};

  // Compute first scheduled_for
  const [hours, minutes] = time.split(':').map(Number);
  const now = new Date();
  let next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  for (let i = 0; i < 8; i++) {
    if (days.includes(next.getDay())) break;
    next.setDate(next.getDate() + 1);
  }

  try {
    const { error } = await sb.from('jsw_post_jobs').insert({
      user_id: user.id,
      message: t.text,
      image_url: null,
      groups: selected,
      delay: settings.delay || 30,
      ai_enabled: aiEnabled,
      ai_prompt: settings.ai_prompt || null,
      first_comment: document.getElementById('tplFirstComment')?.value.trim() || null,
      status: 'pending',
      scheduled_for: next.toISOString(),
      repeat_days: days,
      repeat_time: time,
    });
    if (error) throw new Error(error.message);
    closeTplModal();
    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    toast(`Scheduled — runs ${days.map(d => dayNames[d]).join(', ')} at ${time}`);
  } catch (e) {
    toast('Error: ' + e.message);
  }
}


async function loadScheduled() {
  cachedData = await fetchAll();
  const el = document.getElementById('scheduledList');

  // Query jsw_post_jobs for repeating/scheduled pending jobs
  const { data: scheduledJobs } = await sb.from('jsw_post_jobs')
    .select('*')
    .eq('user_id', user.id)
    .eq('status', 'pending')
    .not('scheduled_for', 'is', null)
    .order('scheduled_for', { ascending: true });

  const legacyPosts = cachedData.posts || [];

  if (legacyPosts.length === 0 && (!scheduledJobs || scheduledJobs.length === 0)) {
    el.innerHTML = '<div class="empty"><p>No scheduled posts yet</p><button class="btn btn-primary" style="margin-top:16px;" onclick="nav(\'create\')">Create Post</button></div>';
    return;
  }

  const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  // Render jsw_post_jobs scheduled entries
  const jobsHtml = (scheduledJobs || []).map(j => {
    const repeatDays = (j.repeat_days || []).map(d => DAYS[d]).join(', ');
    const nextFire = j.scheduled_for ? new Date(j.scheduled_for).toLocaleString() : '—';
    const groupCount = (j.groups || []).length;
    const isRepeating = j.repeat_days?.length > 0;
    return `<div class="post-card">
      <div class="post-text">${esc((j.message || '').substring(0, 140))}</div>
      <div class="post-meta">
        <span>Next: ${nextFire}</span>
        <span>${groupCount} group${groupCount !== 1 ? 's' : ''}</span>
        ${isRepeating ? `<span class="badge badge-blue">${repeatDays} @ ${j.repeat_time}</span>` : '<span class="badge badge-yellow">One-time</span>'}
        ${j.ai_enabled ? '<span class="badge badge-purple">AI</span>' : ''}
      </div>
      <div class="post-actions">
        <button class="btn btn-danger btn-sm" onclick="cancelScheduledJob('${j.id}')">Cancel</button>
      </div>
    </div>`;
  }).join('');

  // Render legacy amplr_data posts
  const legacyHtml = legacyPosts.map(p => {
    const days = (p.schedule?.days || []).map(d => DAYS[d]).join(', ');
    const tags = (p.groups || []).map((g, i) => `<span class="group-tag"><div class="dot" style="background:${GCOLORS[i % GCOLORS.length]}"></div>${esc(g.name || '')}</span>`).join('');
    return `<div class="post-card">
      <div class="post-text">${esc(p.text)}</div>
      <div class="post-meta">
        <span>${p.schedule?.time || ''}</span><span>${days}</span>
        <span class="badge ${p.enabled ? 'badge-on' : 'badge-off'}">${p.enabled ? 'Active' : 'Paused'}</span>
      </div>
      <div style="margin-bottom:10px;">${tags}</div>
      <div class="post-actions">
        <button class="btn btn-primary btn-sm" onclick="firePost('${p.id}')">Post Now</button>
        <button class="btn btn-secondary btn-sm" onclick="togglePost('${p.id}')">${p.enabled ? 'Pause' : 'Resume'}</button>
        <button class="btn btn-danger btn-sm" onclick="delPost('${p.id}')">Delete</button>
      </div>
    </div>`;
  }).join('');

  el.innerHTML = (scheduledJobs?.length ? `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text-3);padding:0 0 10px;">Template Schedules</div>${jobsHtml}` : '') +
    (legacyPosts.length ? `${scheduledJobs?.length ? '<div style="height:16px;"></div>' : ''}<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text-3);padding:0 0 10px;">Recurring Posts</div>${legacyHtml}` : '');
}

async function cancelScheduledJob(id) {
  if (!confirm('Cancel this scheduled post?')) return;
  const { error } = await sb.from('jsw_post_jobs').update({ status: 'cancelled' }).eq('id', id).eq('user_id', user.id);
  if (error) return toast('Error: ' + error.message);
  toast('Cancelled');
  loadScheduled();
}

async function firePost(id) {
  const p = (cachedData.posts || []).find(x => x.id === id);
  if (!p) return;
  try { await createJob(p); toast('Post job sent — extension will execute'); }
  catch (e) { toast(e.message); }
}

async function togglePost(id) {
  const posts = (cachedData.posts || []).map(p => p.id === id ? { ...p, enabled: !p.enabled } : p);
  cachedData.posts = posts;
  await sbSet('posts', posts);
  loadScheduled();
}

async function delPost(id) {
  if (!confirm('Delete this post?')) return;
  const posts = (cachedData.posts || []).filter(p => p.id !== id);
  cachedData.posts = posts;
  await sbSet('posts', posts);
  loadScheduled();
  toast('Deleted');
}

async function editPost(id) {
  const p = (cachedData.posts || []).find(x => x.id === id);
  if (!p) return;
  document.getElementById('createText').value = p.text;
  document.getElementById('createTime').value = p.schedule?.time || '09:00';
  selDays = [...(p.schedule?.days || [])]; renderDays();
  document.getElementById('createText').dispatchEvent(new Event('input'));

  // Pre-select the groups that were on this post
  nav('create');
  await loadTemplates(); // renders group chips
  if (p.groups) {
    p.groups.forEach(pg => {
      const chip = [...document.querySelectorAll('#createGroupSelect .group-chip')].find(c => c.dataset.url === pg.url);
      if (chip) chip.classList.add('selected');
    });
  }

  // Delete the old post silently (no confirm, no toast, no reload)
  const posts = (cachedData.posts || []).filter(x => x.id !== id);
  cachedData.posts = posts;
  await sbSet('posts', posts);

  toast('Editing — save to update');
}

// ═══ GROUPS ═══
// ─── Group tag state ───
let groupTagFilter = null; // null = all
let groupSyncPollTimer = null;

async function getLatestGroupSyncJob() {
  const { data, error } = await sb.from('jsw_post_jobs')
    .select('id,status,result,error,created_at,started_at,completed_at')
    .eq('user_id', user.id)
    .eq('message', '__import_groups__')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getExtensionHeartbeat() {
  const { data, error } = await sb.from('jsw_settings')
    .select('ext_heartbeat')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) return null;
  return data?.ext_heartbeat || null;
}

function isHeartbeatFresh(heartbeat) {
  if (!heartbeat) return false;
  const ts = Date.parse(heartbeat);
  return Number.isFinite(ts) && Date.now() - ts < 2 * 60 * 1000;
}

function isStaleGroupSyncJob(job) {
  if (!job || !['pending', 'processing'].includes(job.status)) return false;
  const raw = job.started_at || job.created_at;
  const ts = raw ? Date.parse(raw) : 0;
  return Number.isFinite(ts) && Date.now() - ts > 15 * 60 * 1000;
}

async function cancelStaleGroupSyncJob(job) {
  if (!job?.id || !isStaleGroupSyncJob(job)) return false;
  const { error } = await sb.from('jsw_post_jobs')
    .update({
      status: 'cancelled',
      error: 'Stale group sync replaced by a new request',
      result: { ...(job.result || {}), stale_cancelled: true, text: 'Stale sync request cancelled.' },
      completed_at: new Date().toISOString()
    })
    .eq('id', job.id)
    .eq('user_id', user.id);
  if (error) throw new Error(error.message);
  return true;
}

function renderGroupSyncStatus(job, groups = cachedData.groups || [], heartbeat = null) {
  const statusEl = document.getElementById('groupSyncStatus');
  const btn = document.getElementById('groupSyncBtn');
  if (!statusEl || !btn) return;

  const active = job && ['pending', 'processing'].includes(job.status);
  const stale = isStaleGroupSyncJob(job);
  const online = isHeartbeatFresh(heartbeat);
  btn.disabled = active && !stale;
  btn.textContent = active && !stale ? 'Syncing...' : stale ? 'Retry Sync' : 'Sync Facebook Groups';

  if (!job) {
    statusEl.textContent = groups.length
      ? `Last loaded: ${groups.length} group${groups.length === 1 ? '' : 's'}. Auto-sync runs daily when the extension is online.`
      : online
        ? 'No groups synced yet. Press Sync Facebook Groups to import them.'
        : 'No groups synced yet. Open/sign into the Chrome extension, then press Sync Facebook Groups.';
    statusEl.style.color = online ? 'var(--text-3)' : 'var(--yellow)';
    return;
  }

  const when = job.completed_at || job.started_at || job.created_at;
  const rel = when ? new Date(when).toLocaleString() : '';
  const result = job.result || {};
  if (active) {
    if (stale) {
      statusEl.textContent = `Previous sync is stale${rel ? ' · ' + rel : ''}. Press Retry Sync to replace it. ${online ? '' : 'The extension currently looks offline.'}`.trim();
      statusEl.style.color = 'var(--yellow)';
    } else if (!online) {
      statusEl.textContent = 'Queued, but the Chrome extension is offline or signed out. Open Amplr extension and sign in; it will sync automatically.';
      statusEl.style.color = 'var(--yellow)';
    } else {
      statusEl.textContent = result.text || (job.status === 'pending' ? 'Queued. Extension will pick it up shortly.' : 'Syncing groups in the background...');
      statusEl.style.color = 'var(--yellow)';
    }
  } else if (job.status === 'done') {
    const count = result.count ?? groups.length;
    statusEl.textContent = `Last sync imported ${count} group${count === 1 ? '' : 's'}${rel ? ' · ' + rel : ''}.`;
    statusEl.style.color = 'var(--green)';
  } else if (job.status === 'failed') {
    statusEl.textContent = `Last sync failed${rel ? ' · ' + rel : ''}: ${result.error || job.error || 'unknown error'}`;
    statusEl.style.color = 'var(--red)';
  } else if (job.status === 'cancelled') {
    statusEl.textContent = groups.length ? `Last loaded: ${groups.length} group${groups.length === 1 ? '' : 's'}.` : 'No active sync request.';
    statusEl.style.color = 'var(--text-3)';
  } else {
    statusEl.textContent = `Last sync status: ${job.status}${rel ? ' · ' + rel : ''}`;
    statusEl.style.color = 'var(--text-3)';
  }
}

async function refreshGroupSyncStatus() {
  try {
    const [job, heartbeat] = await Promise.all([getLatestGroupSyncJob(), getExtensionHeartbeat()]);
    renderGroupSyncStatus(job, cachedData.groups || [], heartbeat);
    if (job && ['pending', 'processing'].includes(job.status)) {
      if (!groupSyncPollTimer) {
        groupSyncPollTimer = setInterval(async () => {
          try {
            const [latest, latestHeartbeat] = await Promise.all([getLatestGroupSyncJob(), getExtensionHeartbeat()]);
            renderGroupSyncStatus(latest, cachedData.groups || [], latestHeartbeat);
            if (!latest || !['pending', 'processing'].includes(latest.status)) {
              clearInterval(groupSyncPollTimer);
              groupSyncPollTimer = null;
              await loadGroups();
            }
          } catch (e) {
            console.warn('[Amplr] group sync poll failed:', e.message);
          }
        }, 4000);
      }
    }
    return job;
  } catch (e) {
    const statusEl = document.getElementById('groupSyncStatus');
    if (statusEl) {
      statusEl.textContent = 'Could not read sync status: ' + e.message;
      statusEl.style.color = 'var(--red)';
    }
    return null;
  }
}

async function syncFacebookGroups(automatic = false) {
  try {
    const existing = await getLatestGroupSyncJob();
    const heartbeat = await getExtensionHeartbeat();
    const online = isHeartbeatFresh(heartbeat);

    if (existing && ['pending', 'processing'].includes(existing.status)) {
      if (isStaleGroupSyncJob(existing)) {
        await cancelStaleGroupSyncJob(existing);
      } else {
        renderGroupSyncStatus(existing, cachedData.groups || [], heartbeat);
        if (!automatic) toast('Group sync already running');
        return existing;
      }
    }

    if (automatic && !online) {
      renderGroupSyncStatus(null, cachedData.groups || [], heartbeat);
      return null;
    }

    const { error, data } = await sb.from('jsw_post_jobs').insert({
      user_id: user.id,
      message: '__import_groups__',
      groups: [],
      status: 'pending',
      result: { text: online ? 'Queued group sync. Extension will open Facebook in the background.' : 'Queued group sync. Open/sign into the Chrome extension to run it.' },
      delay: 0,
      ai_enabled: false,
      scheduled_for: null,
    }).select('id,status,result,created_at,started_at,completed_at').single();
    if (error) throw new Error(error.message);

    localStorage.setItem(`amplr_last_group_auto_sync_${user.id}`, String(Date.now()));
    renderGroupSyncStatus(data, cachedData.groups || [], heartbeat);
    refreshGroupSyncStatus();
    toast(automatic ? 'Auto-sync queued' : online ? 'Group sync queued' : 'Sync queued — open the extension to run it');
    return data;
  } catch (e) {
    console.error('[Amplr] syncFacebookGroups error:', e);
    if (!automatic) toast('Sync error: ' + e.message);
    const statusEl = document.getElementById('groupSyncStatus');
    if (statusEl) {
      statusEl.textContent = 'Sync error: ' + e.message;
      statusEl.style.color = 'var(--red)';
    }
    return null;
  }
}

async function maybeAutoSyncFacebookGroups(groups) {
  if (!user) return;
  const latest = await refreshGroupSyncStatus();
  if (latest && ['pending', 'processing'].includes(latest.status) && !isStaleGroupSyncJob(latest)) return;

  const now = Date.now();
  const lastLocal = Number(localStorage.getItem(`amplr_last_group_auto_sync_${user.id}`) || 0);
  if (now - lastLocal < 6 * 60 * 60 * 1000) return; // local throttle

  const lastDoneAt = latest?.status === 'done' ? new Date(latest.completed_at || latest.updated_at || latest.created_at).getTime() : 0;
  const stale = !lastDoneAt || now - lastDoneAt > 24 * 60 * 60 * 1000;
  const empty = !groups || groups.length === 0;
  if (empty || stale) await syncFacebookGroups(true);
}

async function saveGroupTags(url, tags) {
  try {
    await sb.from('jsw_groups').update({ tags }).eq('user_id', user.id).eq('group_url', url);
    const g = (cachedData.groups || []).find(x => x.url === url);
    if (g) g.tags = tags;
  } catch (e) {
    toast('Error saving tag');
  }
}

function renderGroupTagBar(groups) {
  const bar = document.getElementById('groupTagFilterBar');
  if (!bar) return;
  // Collect all unique tags
  const allTags = [...new Set(groups.flatMap(g => g.tags || []))].sort();
  if (allTags.length === 0) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';
  bar.innerHTML = [
    `<span class="tag-filter-pill ${groupTagFilter === null ? 'active' : ''}" onclick="setGroupTagFilter(null)">All</span>`,
    ...allTags.map(t => `<span class="tag-filter-pill ${groupTagFilter === t ? 'active' : ''}" onclick="setGroupTagFilter(${JSON.stringify(t)})">${esc(t)}</span>`)
  ].join('');
}

function setGroupTagFilter(tag) {
  groupTagFilter = tag;
  const groups = cachedData.groups || [];
  renderGroupTagBar(groups);
  renderGroupsList(groups);
}

function renderGroupsList(groups) {
  const list = document.getElementById('groupsList');
  const empty = document.getElementById('groupsEmpty');
  if (!list) return;

  const filtered = groupTagFilter ? groups.filter(g => (g.tags || []).includes(groupTagFilter)) : groups;

  const postCounts = {};
  (cachedData.posts || []).forEach(p => {
    (p.groups || []).forEach(g => {
      const url = typeof g === 'string' ? g : g.url;
      if (url) postCounts[url] = (postCounts[url] || 0) + 1;
    });
  });

  if (filtered.length === 0) {
    list.innerHTML = groupTagFilter
      ? `<div style="padding:24px;text-align:center;color:var(--text-3);font-size:13px;">No groups tagged <strong>${esc(groupTagFilter)}</strong></div>`
      : '';
    if (empty) empty.style.display = groups.length === 0 ? 'block' : 'none';
    return;
  }
  if (empty) empty.style.display = 'none';

  const colors = ['#5B6FE8','#9B5DE5','#F368A8','#10b981','#f59e0b','#06b6d4'];
  list.innerHTML = filtered.map((g, i) => {
    const posts = postCounts[g.url] || 0;
    const color = colors[i % colors.length];
    const isPending = g.namePending;
    const tagPills = (g.tags || []).map(t =>
      `<span class="group-tag-pill" onclick="event.stopPropagation();removeGroupTag('${esc(g.url)}', '${esc(t)}')" title="Click to remove">${esc(t)} ✕</span>`
    ).join('');

    // Cooldown badge
    const cooldownDays = cachedData?.settings?.cooldown_days ?? 2;
    let cooldownBadge = '';
    if (g.last_posted_at && cooldownDays > 0) {
      const daysSince = (Date.now() - new Date(g.last_posted_at).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince < cooldownDays) {
        const daysLeft = (cooldownDays - daysSince).toFixed(1);
        cooldownBadge = `<span style="font-size:10px;padding:2px 8px;border-radius:10px;background:var(--yellow-light);color:var(--yellow);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;" title="Posted ${daysSince.toFixed(1)}d ago — cooldown active">⏱ ${daysLeft}d left</span>`;
      }
    }
    // Ban risk badge
    let banBadge = '';
    if (g.ban_risk === 'high') {
      banBadge = `<span style="font-size:10px;padding:2px 8px;border-radius:10px;background:var(--red-light);color:var(--red);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;" title="${g.removal_count} post(s) removed — high risk">⚠ High Risk</span>`;
    } else if (g.ban_risk === 'medium') {
      banBadge = `<span style="font-size:10px;padding:2px 8px;border-radius:10px;background:var(--yellow-light);color:var(--yellow);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;" title="${g.removal_count} post(s) removed">⚠ Med Risk</span>`;
    }
    return `<div style="display:flex;align-items:center;gap:14px;padding:14px 0;border-bottom:1px solid var(--border);transition:background .15s;" onmouseover="this.style.background='var(--surface-2)'" onmouseout="this.style.background=''">
      <div style="width:40px;height:40px;border-radius:10px;background:${color};flex-shrink:0;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:16px;">${esc((g.name || '?')[0].toUpperCase())}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;font-size:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span>${esc(g.name)}</span>
          ${isPending ? '<span style="font-size:10px;padding:2px 8px;border-radius:10px;background:var(--yellow-light);color:var(--yellow);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Fetching name...</span>' : ''}
          ${cooldownBadge}
          ${banBadge}
        </div>
        <a href="${esc(g.url)}" target="_blank" style="font-size:11px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;max-width:100%;">${esc(g.url)}</a>
        <div style="display:flex;align-items:center;flex-wrap:wrap;gap:4px;margin-top:5px;">
          ${tagPills}
          <span class="group-tag-add" onclick="event.stopPropagation();showTagInput(this, '${esc(g.url)}')" title="Add tag">+ tag</span>
          <input type="text" class="group-tag-input" style="display:none;width:100px;font-size:11px;padding:2px 6px;border:1px solid var(--border);border-radius:12px;outline:none;background:var(--surface);"
            onkeydown="handleTagInput(event, '${esc(g.url)}')" onblur="this.style.display='none';this.previousElementSibling.style.display=''"/>
        </div>
      </div>
      ${posts > 0 ? `<span class="badge badge-blue" style="flex-shrink:0;">${posts} ${posts === 1 ? 'post' : 'posts'}</span>` : ''}
      <button class="btn btn-ghost btn-sm" style="flex-shrink:0;color:var(--red);border-color:transparent;padding:6px 10px;" onclick="removeGroup('${esc(g.url)}')" title="Remove group">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4h10M5 4V2.5C5 2 5.5 1.5 6 1.5h4c0.5 0 1 0.5 1 1V4M6 7v6M10 7v6M4 4l1 10c0 0.5 0.5 1 1 1h4c0.5 0 1-0.5 1-1l1-10"/></svg>
      </button>
    </div>`;
  }).join('');
}

function showTagInput(addBtn, url) {
  const input = addBtn.nextElementSibling;
  addBtn.style.display = 'none';
  input.style.display = '';
  input.value = '';
  input.focus();
}

function handleTagInput(event, url) {
  if (event.key === 'Enter') {
    const tag = event.target.value.trim().toLowerCase();
    if (!tag) { event.target.style.display = 'none'; event.target.previousElementSibling.style.display = ''; return; }
    const g = (cachedData.groups || []).find(x => x.url === url);
    if (!g) return;
    const newTags = [...new Set([...(g.tags || []), tag])];
    saveGroupTags(url, newTags).then(() => {
      loadGroups();
    });
  } else if (event.key === 'Escape') {
    event.target.style.display = 'none';
    event.target.previousElementSibling.style.display = '';
  }
}

function removeGroupTag(url, tag) {
  const g = (cachedData.groups || []).find(x => x.url === url);
  if (!g) return;
  const newTags = (g.tags || []).filter(t => t !== tag);
  saveGroupTags(url, newTags).then(() => {
    if (groupTagFilter === tag && newTags.length === 0) groupTagFilter = null;
    loadGroups();
  });
}

async function loadGroups() {
  cachedData = await fetchAll();
  const groups = cachedData.groups || [];
  const countEl = document.getElementById('groupCount');
  if (countEl) countEl.textContent = `(${groups.length})`;

  renderGroupTagBar(groups);
  renderGroupsList(groups);
  maybeAutoSyncFacebookGroups(groups);
}

// Auto-detect group name from URL as user types/pastes
document.addEventListener('input', (e) => {
  if (e.target.id === 'groupUrlInput') {
    const url = e.target.value.trim();
    const hint = document.getElementById('groupAutoName');
    if (!hint) return;
    const name = extractGroupName(url);
    if (name) {
      hint.style.display = 'block';
      hint.querySelector('strong').textContent = name;
    } else {
      hint.style.display = 'none';
    }
  }
});

// Also auto-detect on paste (immediate)
document.addEventListener('paste', (e) => {
  if (e.target.id === 'groupUrlInput') {
    setTimeout(() => {
      const url = e.target.value.trim();
      const hint = document.getElementById('groupAutoName');
      if (!hint) return;
      const name = extractGroupName(url);
      if (name) {
        hint.style.display = 'block';
        hint.querySelector('strong').textContent = name;
      }
    }, 0);
  }
});

function extractGroupName(url) {
  if (!url) return null;
  // Match facebook.com/groups/NAME or ID
  const m = url.match(/facebook\.com\/groups\/([^\/\?]+)/i);
  if (m) {
    const slug = decodeURIComponent(m[1]);
    // If it's a numeric ID, can't auto-name
    if (/^\d+$/.test(slug)) return null;
    // Convert slug to readable name
    return slug.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
  return null;
}

async function addGroupFromInput() {
  try {
    const input = document.getElementById('groupUrlInput');
    if (!input) return;
    let url = input.value.trim();
    if (!url) return toast('Enter a group URL');

    // Normalize URL
    if (!url.startsWith('http')) url = 'https://www.facebook.com/groups/' + url;
    url = url.replace(/\/$/, '');

    // Check for duplicates
    const groups = cachedData.groups || [];
    if (groups.some(g => g.url === url)) return toast('Already added');

    // Auto-detect name
    let name = extractGroupName(url);
    if (!name) name = url.split('/').filter(Boolean).pop() || url;

    // Write directly to jsw_groups (shared with extension)
    const { error: insertErr } = await sb.from('jsw_groups').insert({
      user_id: user.id,
      group_url: url,
      group_name: name || null,
    });
    if (insertErr) throw new Error(insertErr.message);

    input.value = '';
    const hint = document.getElementById('groupAutoName');
    if (hint) hint.style.display = 'none';
    toast('Group added');
    loadGroups();
  } catch (e) {
    console.error('[Amplr] addGroup error:', e);
    toast('Error: ' + e.message);
  }
}


async function removeGroup(url) {
  try {
    if (!confirm('Remove this group?')) return;
    const { error } = await sb.from('jsw_groups')
      .delete()
      .eq('user_id', user.id)
      .eq('group_url', url);
    if (error) throw new Error(error.message);
    loadGroups();
    toast('Removed');
  } catch (e) {
    console.error('[Amplr] removeGroup error:', e);
    toast('Error: ' + e.message);
  }
}

// ═══ LOGS ═══
async function loadLogs() {
  cachedData = await fetchAll();
  const { data: jobs } = await sb.from('jsw_post_jobs')
    .select('*').eq('user_id', user.id)
    .order('created_at', { ascending: false }).limit(75);

  const el = document.getElementById('logsList');
  const logs = cachedData.logs || [];
  const allEntries = [];

  (jobs || []).filter(j => !isSystemJob(j)).forEach(j => {
    const groups = Array.isArray(j.groups) ? j.groups : [];
    const status = j.status || 'unknown';
    const success = status === 'done';
    const failed = status === 'failed';
    allEntries.push({
      timestamp: j.completed_at || j.updated_at || j.created_at,
      postPreview: (j.message || '').substring(0, 100),
      results: groups.map(g => ({
        group: groupDisplayName(g),
        rawGroup: normalizeGroupRef(g),
        success,
        failed,
        error: j.error,
      })),
      status,
      error: j.error,
    });
  });
  logs.forEach(l => allEntries.push(l));

  if (allEntries.length === 0) {
    el.innerHTML = '<div class="empty"><p>No activity yet</p></div>';
    return;
  }
  el.innerHTML = allEntries.map(l => {
    const results = l.results || [];
    const ok = results.filter(r => r.success).length;
    const fail = results.filter(r => r.failed || (!r.success && l.status === 'failed')).length;
    const status = l.status || (ok > 0 ? 'done' : 'failed');
    const iconClass = status === 'cancelled' ? 'fail' : ok > 0 && fail > 0 ? 'mix' : ok > 0 ? 'ok' : status === 'processing' ? 'mix' : 'fail';
    const icon = status === 'processing' ? '...' : status === 'cancelled' ? 'CANCEL' : ok > 0 && fail > 0 ? 'MIX' : ok > 0 ? 'OK' : 'FAIL';
    const total = results.length;
    const resultDetails = status === 'cancelled'
      ? '<span style="color:var(--text-3);">Cancelled before posting</span>'
      : status === 'processing'
        ? '<span style="color:var(--yellow);">Processing in extension</span>'
        : results.map(r =>
            r.success
              ? `<span style="color:var(--green);">OK ${esc(r.group)}</span>`
              : `<span style="color:var(--red);">FAIL ${esc(r.group)}${r.error ? ': ' + esc(String(r.error)) : ''}</span>`
          ).join('<br>');
    return `<div class="log-row">
      <div class="log-icon ${iconClass}">${icon}</div>
      <div class="log-body">
        <div class="log-time">${new Date(l.timestamp).toLocaleString()} • ${ok}/${total} succeeded • ${esc(status)}</div>
        <div class="log-preview">${esc(l.postPreview || l.text || '')}</div>
        <div class="log-results" style="margin-top:4px;">${resultDetails || '<span style="color:var(--text-3);">No group-level results yet</span>'}</div>
      </div>
    </div>`;
  }).join('');
}

async function clearLogs() {
  if (!confirm('Clear all logs?')) return;
  try {
    cachedData.logs = [];
    await sbSet('logs', []);
    loadLogs();
    toast('Logs cleared');
  } catch (e) {
    toast('Error: ' + e.message);
  }
}

async function exportLogs() {
  const logs = cachedData.logs || [];
  if (logs.length === 0) return toast('No logs to export');

  // Also include Supabase job history
  const { data: jobs } = await sb.from('jsw_post_jobs').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(50);
  const rows = [['Timestamp', 'Preview', 'Group', 'Success', 'Error']];
  logs.forEach(l => {
    (l.results || []).forEach(r => {
      rows.push([l.timestamp, l.postPreview || '', r.group || '', r.success ? 'YES' : 'NO', r.error || '']);
    });
  });

  const csv = rows.map(r => r.map(c => `"${(c || '').toString().replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `amplr-logs-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Exported');
}

// ═══ SETTINGS ═══
async function loadSettings() {
  cachedData.settings = await sbGet('settings') || cachedData.settings || {};
  const s = cachedData.settings;

  // Status
  const statusEl = document.getElementById('connStatus');
  const hintEl = document.getElementById('installHint');
  if (statusEl) {
    statusEl.innerHTML = connected
      ? '<span style="color:var(--green);">Connected & ready</span>'
      : '<span style="color:var(--red);">Extension offline</span>';
  }
  if (hintEl) {
    hintEl.style.display = connected ? 'none' : 'block';
  }

  if (s.delay) document.getElementById('setDelay').value = s.delay;
  if (s.maxGroups) document.getElementById('setMaxGroups').value = s.maxGroups;
  if (s.jitter) document.getElementById('setJitter').value = s.jitter;
  if (s.cooldown_days != null) {
    const el = document.getElementById('setCooldown');
    if (el) el.value = s.cooldown_days;
  }

  // AI settings
  const aiEnabledEl = document.getElementById('setAiEnabled');
  if (aiEnabledEl) {
    aiEnabledEl.classList.toggle('on', !!s.ai_enabled);
  }
  const aiProviderEl = document.getElementById('setAiProvider');
  if (aiProviderEl && s.ai_provider) aiProviderEl.value = s.ai_provider;
  const aiModelEl = document.getElementById('setAiModel');
  if (aiModelEl && s.ai_model) aiModelEl.value = s.ai_model;
  const aiKeyEl = document.getElementById('setAiKey');
  if (aiKeyEl && s.ai_key) aiKeyEl.value = s.ai_key;
  const aiPromptEl = document.getElementById('setAiPrompt');
  if (aiPromptEl && s.ai_prompt) aiPromptEl.value = s.ai_prompt;
}

async function saveSettings() {
  const aiKey = document.getElementById('setAiKey')?.value.trim() || '';
  const aiProvider = document.getElementById('setAiProvider')?.value || 'openai';
  const aiModel = document.getElementById('setAiModel')?.value.trim() || 'gpt-4o-mini';
  const aiEnabled = document.getElementById('setAiEnabled')?.classList.contains('on') || false;
  const aiPrompt = document.getElementById('setAiPrompt')?.value.trim() || '';

  const settings = {
    ...(cachedData.settings || {}),
    delay: parseInt(document.getElementById('setDelay').value) || 10,
    maxGroups: parseInt(document.getElementById('setMaxGroups').value) || 10,
    jitter: parseInt(document.getElementById('setJitter').value) || 5,
    cooldown_days: parseInt(document.getElementById('setCooldown')?.value ?? 2),
    ai_enabled: aiEnabled,
    ai_provider: aiProvider,
    ai_model: aiModel,
    ai_key: aiKey,
    ai_prompt: aiPrompt,
  };
  cachedData.settings = settings;
  await sbSet('settings', settings);

  // Also update jsw_settings so the extension can read ai_key, ai_provider, ai_model, ai_prompt
  try {
    await sb.from('jsw_settings').upsert({
      user_id: user.id,
      ai_provider: aiProvider,
      ai_model: aiModel,
      ai_key: aiKey,
      ai_prompt: aiPrompt || null,
      ai_enabled: aiEnabled,
    }, { onConflict: 'user_id' });
  } catch (e) {
    console.warn('[Amplr] jsw_settings upsert failed:', e.message);
  }

  toast('Settings saved');
}

async function deleteAllPosts() {
  if (!confirm('Clear legacy recurring posts from this dashboard? This does not delete extension job history.')) return;
  cachedData.posts = [];
  await sbSet('posts', []);
  toast('Legacy recurring posts cleared');
  loadScheduled();
}

async function resetAll() {
  const typed = prompt('This clears dashboard settings/templates/legacy schedules only. Type RESET to continue:');
  if (typed !== 'RESET') return;
  await sb.from('amplr_data').delete().eq('user_id', user.id);
  toast('Dashboard data reset');
  location.reload();
}

// ═══ SCHEDULE CHECKER ═══
// Checks every 60s if any scheduled post should fire.
// Creates a job in jsw_post_jobs when it's time.
function startScheduleChecker() {
  if (schedChecker) clearInterval(schedChecker);
  schedChecker = setInterval(async () => {
    if (!user) return;
    const posts = await sbGet('posts') || [];
    const now = new Date();
    const currentDay = now.getDay();
    const currentTime = now.toTimeString().substring(0, 5);

    for (const post of posts) {
      if (!post.enabled) continue;
      if (!post.schedule || !post.schedule.days || !post.schedule.time) continue;
      if (post.schedule.days.includes(currentDay) && post.schedule.time === currentTime) {
        // Check we haven't already fired this in the last 2 minutes
        const logs = await sbGet('logs') || [];
        const recent = logs.find(l =>
          l.postId === post.id &&
          Date.now() - new Date(l.timestamp).getTime() < 120000
        );
        if (recent) continue;
        try {
          await createJob(post);
          console.log('[Amplr] Fired scheduled post:', post.id);
        } catch (e) {
          console.warn('[Amplr] Schedule fire failed:', e.message);
        }
      }
    }
  }, 60000);
}

// ═══ UTIL ═══
function esc(s) {
  if (!s) return '';
  const d = document.createElement('div'); d.textContent = s; return d.innerHTML;
}
function toast(msg) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ─── AI toggle (Create Post panel) ───
function toggleAI() {
  const toggle = document.getElementById('aiToggle');
  const status = document.getElementById('aiStatus');
  if (!toggle) return;
  // Ollama runs locally — no API key needed
  toggle.classList.toggle('on');
  if (status) status.style.display = toggle.classList.contains('on') ? 'flex' : 'none';
}

// ─── AI toggle (Settings page) ───
function toggleSettingsAI() {
  const toggle = document.getElementById('setAiEnabled');
  if (toggle) toggle.classList.toggle('on');
}

// ─── Create page helpers ───

function clearCreateForm() {
  const ta = document.getElementById('createText');
  if (ta) { ta.value = ''; ta.dispatchEvent(new Event('input')); }
  const imgInput = document.getElementById('createImageUrl');
  if (imgInput) { imgInput.value = ''; imgInput.dispatchEvent(new Event('input')); }
  const fcInput = document.getElementById('createFirstComment');
  if (fcInput) fcInput.value = '';
  document.getElementById('spinInfo').style.display = 'none';
  document.querySelectorAll('#createGroupSelect .group-chip.selected').forEach(c => c.classList.remove('selected'));
  localStorage.removeItem('amplr_draft');
}

function restoreDraft() {
  const draft = localStorage.getItem('amplr_draft');
  const ta = document.getElementById('createText');
  if (draft && ta && !ta.value.trim()) {
    ta.value = draft;
    ta.dispatchEvent(new Event('input'));
  }
}

function selectAllGroups() {
  document.querySelectorAll('#createGroupSelect .group-chip').forEach(c => c.classList.add('selected'));
  updateSelectedCount();
}

function deselectAllGroups() {
  document.querySelectorAll('#createGroupSelect .group-chip').forEach(c => c.classList.remove('selected'));
  updateSelectedCount();
}

function updateSelectedCount() {
  const count = document.querySelectorAll('#createGroupSelect .group-chip.selected').length;
  const el = document.getElementById('selectedGroupCount');
  if (el) el.textContent = `${count} group${count === 1 ? '' : 's'} selected`;
}

// Update count when chips are toggled, even when clicking inside a chip
// rather than directly on the chip element.
document.addEventListener('click', (e) => {
  if (e.target.closest?.('#createGroupSelect .group-chip')) {
    setTimeout(updateSelectedCount, 0);
  }
});

function insertEmoji(emoji) {
  const ta = document.getElementById('createText');
  if (!ta) return;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  ta.value = ta.value.slice(0, start) + emoji + ta.value.slice(end);
  ta.selectionStart = ta.selectionEnd = start + emoji.length;
  ta.focus();
  ta.dispatchEvent(new Event('input'));
}

function updateCharCounter(len) {
  const el = document.getElementById('charCounter');
  if (!el) return;
  const max = 63206;
  el.textContent = `${len.toLocaleString()} / ${max.toLocaleString()}`;
  if (len > 60000) {
    el.style.color = 'var(--red)';
  } else if (len > 50000) {
    el.style.color = 'var(--yellow)';
  } else {
    el.style.color = 'var(--green)';
  }
}

function updateFbPreview(text) {
  const el = document.getElementById('fbPreviewText');
  if (!el) return;
  if (!text.trim()) {
    el.textContent = 'Start typing to see a preview…';
    el.style.fontStyle = 'italic';
    el.style.color = 'var(--text-3)';
  } else {
    el.textContent = text;
    el.style.fontStyle = '';
    el.style.color = '';
  }
}

function updateNextFire() {
  const indicator = document.getElementById('nextFireIndicator');
  const nextFireText = document.getElementById('nextFireText');
  const timeInput = document.getElementById('createTime');
  if (!indicator || !nextFireText || !timeInput) return;

  if (selDays.length === 0) { indicator.style.display = 'none'; return; }

  const [hours, minutes] = timeInput.value.split(':').map(Number);
  const now = new Date();
  let next = null;

  for (let ahead = 0; ahead <= 7; ahead++) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + ahead);
    candidate.setHours(hours, minutes, 0, 0);
    if (selDays.includes(candidate.getDay()) && candidate > now) {
      next = candidate;
      break;
    }
  }

  if (next) {
    indicator.style.display = 'block';
    const dayName = DAYS[next.getDay()];
    const dateStr = next.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const timeStr = next.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    nextFireText.textContent = `${dayName} ${dateStr} at ${timeStr}`;
  } else {
    indicator.style.display = 'none';
  }
}
