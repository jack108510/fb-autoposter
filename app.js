// ═══ Amplr — Dashboard v3 (Supabase) ═══

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const GCOLORS = ['#3b82f6','#ef4444','#10b981','#f59e0b','#8b5cf6','#ec4899','#06b6d4','#84cc16'];

// ─── Supabase ───
const SUPABASE_URL = 'https://xacehhtgvubcqdoltazg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_1TNu5hqotJ7GGQXfjliivQ_ttK51EAA';
let sb = null;
let user = null;

try { sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY); } catch(e) {
  document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#999;font-family:sans-serif;">Failed to load. Check your connection.</div>';
}

let connected = false;
let cachedData = { posts: [], logs: [], templates: [], groups: [], settings: {} };
let selDays = [1, 2, 3, 4, 5];
let groupCount = 0;
let calDate = new Date();
let schedChecker = null;

// ─── Init ───
document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  renderDays();
  renderCalNames();
  setupNav();

  // Check Supabase session
  const { data } = await sb.auth.getSession();
  if (!data.session) {
    // Show login screen instead of redirecting
    document.getElementById('authScreen').style.display = 'flex';
    return;
  }
  user = data.session.user;

  // Show the app
  document.getElementById('app').style.display = '';

  // Show user email in sidebar
  const footer = document.querySelector('.sidebar-footer');
  if (footer && user.email) {
    const userInfo = document.createElement('div');
    userInfo.style.cssText = 'padding:8px 12px;font-size:12px;color:var(--text-3);border-bottom:1px solid var(--border);margin-bottom:8px;display:flex;align-items:center;gap:8px;';
    userInfo.innerHTML = '<div style="width:24px;height:24px;border-radius:50%;background:linear-gradient(120deg,#5B6FE8,#F368A8);flex-shrink:0;"></div><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + user.email + '</span>';
    footer.insertBefore(userInfo, footer.firstChild);
  }

  // Load settings immediately
  cachedData = await fetchAll();
  loadSettings();
  
  await checkConn();
  setInterval(checkConn, 30000);
  startScheduleChecker();
});

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
// Posting creates rows in jsw_post_jobs (extension polls every 10s).

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

async function checkConn() {
  const bar = document.getElementById('connBar');
  const dot = document.getElementById('connDot');
  const label = document.getElementById('connLabel');

  if (!user) return;

  // Check extension heartbeat in jsw_settings
  const { data: settingsRow } = await sb.from('jsw_settings')
    .select('ext_heartbeat').eq('user_id', user.id).maybeSingle();

  const hb = settingsRow?.ext_heartbeat;
  const hbAge = hb ? Date.now() - new Date(hb).getTime() : Infinity;
  const isOnline = hbAge < 90000; // heartbeat within 90s

  if (isOnline) {
    connected = true;
    bar.className = 'conn-bar connected';
    dot.className = 'conn-dot on';
    // Check if currently posting
    const { data: recent } = await sb.from('jsw_post_jobs')
      .select('status').eq('user_id', user.id)
      .order('updated_at', { ascending: false }).limit(1);
    label.textContent = recent?.[0]?.status === 'processing' ? 'Posting...' : 'Connected';
  } else {
    connected = false;
    bar.className = 'conn-bar disconnected';
    dot.className = 'conn-dot off';
    label.textContent = 'Extension offline';
  }

  // Always load data regardless of connection state
  cachedData = await fetchAll();
  if (typeof loadSettings === 'function') loadSettings();

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
    el.innerHTML = logs.map(l => {
      const time = new Date(l.created_at).toLocaleTimeString('en-US', { hour12: false });
      const color = colors[l.level] || 'var(--text-2)';
      return `<div style="display:flex;gap:8px;padding:3px 0;border-bottom:1px solid var(--border);">
        <span style="color:var(--text-3);flex-shrink:0;">${time}</span>
        <span style="color:${color};font-weight:${l.level === 'error' ? '700' : '400'};word-break:break-word;">${esc(l.message)}</span>
      </div>`;
    }).join('');

    // Auto-cleanup old logs (>1 hour)
    await sb.from('jsw_ext_logs')
      .delete()
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
        .select('group_url, group_name, tags')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false }),
      sbGet('settings'),
      sbGet('logs'),
    ]);
    const groups = (groupsRes.data || []).map(r => ({
      url: r.group_url,
      name: r.group_name || r.group_url.split('/').filter(Boolean).pop(),
      tags: r.tags || [],
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
  const successRate = totalAttempts > 0 ? Math.round((ok / totalAttempts) * 100) : 100;

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

  document.getElementById('sPostsWeek').textContent = postsThisWeek;
  document.getElementById('sGroupsHit').textContent = groupUrls.size;
  document.getElementById('sSuccessRate').textContent = successRate + '%';
  document.getElementById('sBanRisk').textContent = banLevel;
  document.getElementById('sBanRisk').style.color = banColor;
  document.getElementById('navCount').textContent = posts.length;

  // 7-day chart from real job data
  const days7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const dStr = d.toDateString();
    const entry = dayMap[dStr] || { ok: 0, fail: 0 };
    days7.push({ label: DAYS[d.getDay()], ok: entry.ok, fail: entry.fail, total: entry.ok + entry.fail });
  }
  const maxVal = Math.max(...days7.map(d => d.total), 1);
  document.getElementById('chart7day').innerHTML = days7.map(d => {
    const okH = (d.ok / maxVal) * 100;
    const failH = (d.fail / maxVal) * 100;
    return `<div class="chart-col">
      <div style="width:100%;display:flex;flex-direction:column;justify-content:flex-end;height:100px;">
        <div class="chart-bar-fill red" style="height:${failH}%;min-height:${d.fail > 0 ? '4px' : '0'};" title="${d.fail} failed"></div>
        <div class="chart-bar-fill green" style="height:${okH}%;min-height:${d.ok > 0 ? '4px' : '0'};" title="${d.ok} success"></div>
      </div>
      <div class="chart-label">${d.label}</div>
    </div>`;
  }).join('');

  // Upcoming
  const upcoming = posts.filter(p => p.enabled).slice(0, 5);
  document.getElementById('dashUpcoming').innerHTML = upcoming.length === 0
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
      }).join('');

  // Top groups
  const groupStats = {};
  (logs || []).forEach(l => {
    (l.results || []).forEach(r => {
      if (!groupStats[r.group]) groupStats[r.group] = { ok: 0, fail: 0 };
      if (r.success) groupStats[r.group].ok++; else groupStats[r.group].fail++;
    });
  });
  const topGroups = Object.entries(groupStats)
    .map(([name, s]) => ({ name, rate: s.ok + s.fail > 0 ? Math.round(s.ok / (s.ok + s.fail) * 100) : 0, ...s }))
    .sort((a, b) => b.ok - a.ok).slice(0, 5);
  document.getElementById('dashTopGroups').innerHTML = topGroups.length === 0
    ? '<div style="text-align:center;color:var(--text-3);font-size:13px;padding:12px;">No data yet</div>'
    : topGroups.map(g => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);">
        <span style="font-size:13px;font-weight:600;">${esc(g.name)}</span>
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:12px;color:var(--text-3);">${g.ok}/${g.ok + g.fail}</span>
          <div style="width:50px;height:6px;background:var(--surface-2);border-radius:3px;overflow:hidden;">
            <div style="width:${g.rate}%;height:100%;background:${g.rate > 80 ? 'var(--green)' : g.rate > 50 ? 'var(--yellow)' : 'var(--red)'};"></div>
          </div>
        </div>
      </div>`).join('');
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
  if (!text) return toast('Write something first');
  const groups = getSelectedGroups();
  if (groups.length === 0) return toast('Select at least one group');
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

// (dead code removed — getGroupsFromForm and fetchGroupName)

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

function renderGroupChips() {
  const groups = cachedData.groups || [];
  const container = document.getElementById('createGroupSelect');
  const noGroups = document.getElementById('createNoGroups');
  if (!container) return;

  if (groups.length === 0) {
    container.innerHTML = '';
    if (noGroups) noGroups.style.display = 'block';
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
  nav('create');
  setTimeout(() => useTemplate(activeTplId), 100);
  closeTplModal();
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
      first_comment: t.firstComment || null,
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
  const posts = cachedData.posts || [];
  const el = document.getElementById('scheduledList');
  if (posts.length === 0) {
    el.innerHTML = '<div class="empty"><p>No scheduled posts yet</p><button class="btn btn-primary" style="margin-top:16px;" onclick="nav(\'create\')">Create Post</button></div>';
    return;
  }
  el.innerHTML = posts.map(p => {
    const days = p.schedule.days.map(d => DAYS[d]).join(', ');
    const tags = p.groups.map((g, i) => `<span class="group-tag"><div class="dot" style="background:${GCOLORS[i % GCOLORS.length]}"></div>${esc(g.name)}</span>`).join('');
    const spin = p.hasSpintax ? ` <span class="spin-badge">${p.variations || countVariations(p.text)} VARS</span>` : '';
    return `<div class="post-card">
      <div class="post-text">${esc(p.text)}</div>
      <div class="post-meta">
        <span>${p.schedule.time}</span><span>${days}</span>
        <span class="badge ${p.enabled ? 'badge-on' : 'badge-off'}">${p.enabled ? 'Active' : 'Paused'}</span>${spin}
      </div>
      <div style="margin-bottom:10px;">${tags}</div>
      <div class="post-actions">
        <button class="btn btn-primary btn-sm" onclick="firePost('${p.id}')">Post Now</button>
        <button class="btn btn-secondary btn-sm" onclick="togglePost('${p.id}')">${p.enabled ? 'Pause' : 'Resume'}</button>
        <button class="btn btn-ghost btn-sm" onclick="editPost('${p.id}')">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="delPost('${p.id}')">Delete</button>
      </div>
    </div>`;
  }).join('');
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
    return `<div style="display:flex;align-items:center;gap:14px;padding:14px 0;border-bottom:1px solid var(--border);transition:background .15s;" onmouseover="this.style.background='var(--surface-2)'" onmouseout="this.style.background=''">
      <div style="width:40px;height:40px;border-radius:10px;background:${color};flex-shrink:0;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:16px;">${esc((g.name || '?')[0].toUpperCase())}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;font-size:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span>${esc(g.name)}</span>
          ${isPending ? '<span style="font-size:10px;padding:2px 8px;border-radius:10px;background:var(--yellow-light);color:var(--yellow);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Fetching name...</span>' : ''}
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

// (dead code removed — fetchGroupName)

async function syncGroupsFromFacebook() {
  if (!connected) {
    toast('Extension not connected — open Chrome with Amplr extension running first');
    return;
  }
  const btn = document.getElementById('syncGroupsBtn');
  const statusEl = document.getElementById('syncStatus');
  const statusText = document.getElementById('syncStatusText');

  btn.disabled = true;
  btn.textContent = 'Syncing...';
  statusEl.style.display = 'flex';
  statusText.textContent = 'Queuing import job...';

  try {
    // Insert a special import_groups job — extension polls for these
    const { data: job, error } = await sb.from('jsw_post_jobs').insert({
      user_id: user.id,
      message: '__import_groups__',
      groups: [],
      status: 'pending',
      ai_enabled: false,
    }).select('id').single();
    if (error) throw new Error(error.message);

    statusText.textContent = 'Extension is importing your groups...';

    // Poll until job is done or failed (max 3 min)
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      if (attempts > 36) { // 36 * 5s = 3min
        clearInterval(poll);
        btn.disabled = false;
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"/></svg> Sync from Facebook';
        statusEl.style.display = 'none';
        toast('Timed out — is the extension running?');
        return;
      }
      const { data: j } = await sb.from('jsw_post_jobs').select('status, result').eq('id', job.id).single();
      if (!j) return;
      if (j.status === 'done') {
        clearInterval(poll);
        btn.disabled = false;
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"/></svg> Sync from Facebook';
        statusEl.style.display = 'none';
        const count = j.result?.count || '';
        toast(count ? `Synced ${count} groups from Facebook` : 'Groups synced');
        loadGroups();
      } else if (j.status === 'failed') {
        clearInterval(poll);
        btn.disabled = false;
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"/></svg> Sync from Facebook';
        statusEl.style.display = 'none';
        toast('Sync failed — ' + (j.result?.error || 'check extension'));
      } else {
        statusText.textContent = j.result?.text || 'Extension is importing your groups...';
      }
    }, 5000);

  } catch (e) {
    btn.disabled = false;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"/></svg> Sync from Facebook';
    statusEl.style.display = 'none';
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
  // Also fetch job history from Supabase
  const { data: jobs } = await sb.from('jsw_post_jobs')
    .select('*').eq('user_id', user.id)
    .order('created_at', { ascending: false }).limit(50);

  const el = document.getElementById('logsList');
  const logs = cachedData.logs || [];

  // Merge Supabase jobs with local logs
  const allEntries = [];
  if (jobs && jobs.length) {
    jobs.forEach(j => {
      const ok = j.status === 'done';
      allEntries.push({
        timestamp: j.completed_at || j.created_at,
        postPreview: (j.message || '').substring(0, 80),
        results: (j.groups || []).map(g => ({
          group: typeof g === 'string' ? g.split('/').pop() : g,
          success: ok,
          error: j.error,
          strategy: 'ext'
        })),
        status: j.status,
      });
    });
  }
  logs.forEach(l => allEntries.push(l));

  if (allEntries.length === 0) {
    el.innerHTML = '<div class="empty"><p>No activity yet</p></div>';
    return;
  }
  el.innerHTML = allEntries.map(l => {
    const results = l.results || [];
    const ok = results.filter(r => r.success).length;
    const fail = results.length - ok;
    const iconClass = ok > 0 && fail > 0 ? 'mix' : ok > 0 ? 'ok' : 'fail';
    const icon = l.status === 'processing' ? '...' : ok > 0 && fail > 0 ? 'MIX' : ok > 0 ? 'OK' : 'FAIL';
    const resultDetails = results.map(r =>
      r.success
        ? `<span style="color:var(--green);">OK ${esc(r.group)}</span>`
        : `<span style="color:var(--red);">FAIL ${esc(r.group)}: ${esc(r.error || 'failed')}</span>`
    ).join('<br>');
    return `<div class="log-row">
      <div class="log-icon ${iconClass}">${icon}</div>
      <div class="log-body">
        <div class="log-time">${new Date(l.timestamp).toLocaleString()} • ${ok}/${results.length} succeeded</div>
        <div class="log-preview">${esc(l.postPreview || l.text || '')}</div>
        <div class="log-results" style="margin-top:4px;">${resultDetails}</div>
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
  if (!confirm('Delete ALL scheduled posts?')) return;
  cachedData.posts = [];
  await sbSet('posts', []);
  toast('All posts deleted');
  loadScheduled();
}

async function resetAll() {
  if (!confirm('Reset EVERYTHING?')) return;
  await sb.from('amplr_data').delete().eq('user_id', user.id);
  toast('Reset complete');
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
  if (el) el.textContent = count + ' selected';
}

// Update count when chips are toggled
document.addEventListener('click', (e) => {
  if (e.target.classList?.contains('group-chip')) {
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
