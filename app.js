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
    window.location.href = 'dashboard.html';
    return;
  }
  user = data.session.user;

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
  const { error } = await sb.from('amplr_data').upsert({ user_id: user.id, key, value, updated_at: new Date().toISOString() });
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
}

async function fetchAll() {
  try {
    const [posts, templates, groups, settings, logs] = await Promise.all([
      sbGet('posts'),
      sbGet('templates'),
      sbGet('groups'),
      sbGet('settings'),
      sbGet('logs'),
    ]);
    return {
      posts: posts || [],
      logs: logs || [],
      templates: templates || [],
      groups: groups || [],
      settings: settings || {},
    };
  } catch (e) {
    return cachedData;
  }
}

// Create a posting job that the extension picks up
async function createJob(post) {
  const groups = (post.groups || []).map(g => typeof g === 'string' ? g : g.url).filter(Boolean);
  const { error } = await sb.from('jsw_post_jobs').insert({
    user_id: user.id,
    message: post.text,
    image_url: post.imageUrl || null,
    groups: groups,
    delay: cachedData.settings?.delay || 30,
    ai_enabled: false,
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
  const ok = (logs || []).reduce((s, l) => s + (l.results || []).filter(r => r.success).length, 0);
  const fail = (logs || []).reduce((s, l) => s + (l.results || []).filter(r => !r.success).length, 0);
  const groupUrls = new Set();
  posts.forEach(p => (p.groups || []).forEach(g => groupUrls.add(g.url)));

  document.getElementById('sActive').textContent = active;
  document.getElementById('sSuccess').textContent = ok;
  document.getElementById('sFailed').textContent = fail;
  document.getElementById('sGroups').textContent = groupUrls.size;
  document.getElementById('navCount').textContent = posts.length;

  // 7-day chart
  const days7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const dStr = d.toDateString();
    const dayLogs = (logs || []).filter(l => new Date(l.timestamp).toDateString() === dStr);
    const dayOk = dayLogs.reduce((s, l) => s + (l.results || []).filter(r => r.success).length, 0);
    const dayFail = dayLogs.reduce((s, l) => s + (l.results || []).filter(r => !r.success).length, 0);
    days7.push({ label: DAYS[d.getDay()], ok: dayOk, fail: dayFail, total: dayOk + dayFail });
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
function toggleDay(d) { selDays = selDays.includes(d) ? selDays.filter(x => x !== d) : [...selDays, d].sort(); renderDays(); }

document.addEventListener('input', (e) => {
  if (e.target.id === 'createText') {
    const has = hasSpintax(e.target.value);
    const badge = document.getElementById('spinInfo');
    if (has) {
      badge.style.display = 'inline-flex';
      badge.textContent = `${countVariations(e.target.value)} VARIATIONS`;
    } else { badge.style.display = 'none'; }
  }
});

async function savePost() {
  const text = document.getElementById('createText').value.trim();
  const time = document.getElementById('createTime').value;
  if (!text) return toast('Write something first');
  if (selDays.length === 0) return toast('Pick at least one day');
  const groups = getSelectedGroups();
  if (groups.length === 0) return toast('Select at least one group');
  const post = {
    id: Date.now().toString(), text, imageUrl: '', groups,
    schedule: { time, days: [...selDays] }, enabled: true,
    createdAt: new Date().toISOString(),
    hasSpintax: hasSpintax(text), variations: countVariations(text),
  };
  const posts = [...(cachedData.posts || []), post];
  cachedData.posts = posts;
  const err = await sbSet('posts', posts);
  if (err) return toast('Error: ' + err.message);
  toast('Scheduled!');
  document.getElementById('createText').value = '';
  document.getElementById('spinInfo').style.display = 'none';
  nav('scheduled');
}

async function postNow() {
  const text = document.getElementById('createText').value.trim();
  if (!text) return toast('Write something first');
  const groups = getSelectedGroups();
  if (groups.length === 0) return toast('Select at least one group');

  const waiting = document.getElementById('postWaiting');
  if (waiting) waiting.style.display = 'block';

  try {
    const { error } = await sb.from('jsw_post_jobs').insert({
      user_id: user.id,
      message: text,
      groups: groups.map(g => g.url),
      delay: cachedData.settings?.delay || 30,
      status: 'pending',
    });
    if (error) throw new Error(error.message);

    if (waiting) waiting.style.display = 'none';
    toast('Sent — extension will post it');
    document.getElementById('createText').value = '';
    document.getElementById('spinInfo').style.display = 'none';
    document.querySelectorAll('#createGroupSelect .group-chip.selected').forEach(c => c.classList.remove('selected'));
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
  const template = { id: Date.now().toString(), name, text, createdAt: new Date().toISOString() };
  const templates = [...(cachedData.templates || []), template];
  cachedData.templates = templates;
  await sbSet('templates', templates);
  toast('Template saved');
}

async function loadTemplates() {
  cachedData = await fetchAll();
  renderGroupChips();
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
  toast(`Loaded: ${t.name}`);
}

// ═══ TEMPLATES PAGE ═══
async function loadTemplatesPage() {
  cachedData = await fetchAll();
  const templates = cachedData.templates || [];
  const el = document.getElementById('templatesList');
  if (templates.length === 0) {
    el.innerHTML = '<div class="empty"><p>No templates yet. Create a post and "Save as Template".</p></div>';
    return;
  }
  el.innerHTML = templates.map(t => `
    <div class="template-card" onclick="nav('create'); setTimeout(() => useTemplate('${t.id}'), 100);">
      <div class="template-name">${esc(t.name)} ${hasSpintax(t.text) ? '<span class="spin-badge">SPINTAX</span>' : ''}</div>
      <div class="template-preview">${esc(t.text.substring(0, 120))}...</div>
      <div style="margin-top:8px;">
        <button class="btn btn-danger btn-xs" onclick="event.stopPropagation(); deleteTemplate('${t.id}')">Delete</button>
      </div>
    </div>`).join('');
}

async function deleteTemplate(id) {
  if (!confirm('Delete this template?')) return;
  const templates = (cachedData.templates || []).filter(t => t.id !== id);
  cachedData.templates = templates;
  await sbSet('templates', templates);
  loadTemplatesPage();
  toast('Deleted');
}

// ═══ SCHEDULED ═══
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
async function loadGroups() {
  cachedData = await fetchAll();
  const groups = cachedData.groups || [];
  const list = document.getElementById('groupsList');
  const empty = document.getElementById('groupsEmpty');
  const countEl = document.getElementById('groupCount');

  if (countEl) countEl.textContent = `(${groups.length})`;

  if (groups.length === 0) {
    if (list) list.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  // Build post counts per group from posts
  const postCounts = {};
  (cachedData.posts || []).forEach(p => {
    (p.groups || []).forEach(g => {
      const url = typeof g === 'string' ? g : g.url;
      if (url) postCounts[url] = (postCounts[url] || 0) + 1;
    });
  });

  if (list) list.innerHTML = groups.map((g, i) => {
    const posts = postCounts[g.url] || 0;
    return `<div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);">
      <div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(120deg,#5B6FE8,#F368A8);flex-shrink:0;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:13px;">${esc((g.name || '?')[0].toUpperCase())}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;font-size:14px;">${esc(g.name)}</div>
        <div style="font-size:11px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(g.url)}</div>
      </div>
      ${posts > 0 ? `<span class="badge badge-blue" style="flex-shrink:0;">${posts} posts</span>` : ''}
      <button class="btn btn-danger btn-sm" style="flex-shrink:0;" onclick="removeGroup('${esc(g.url)}')">Remove</button>
    </div>`;
  }).join('');
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
    if (!name) name = url.split('/').pop() || url;

    groups.push({ url, name });
    cachedData.groups = groups;

    const err = await sbSet('groups', groups);
    if (err) throw new Error(err.message);

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

async function removeGroup(url) {
  try {
    if (!confirm('Remove this group?')) return;
    const groups = (cachedData.groups || []).filter(g => g.url !== url);
    cachedData.groups = groups;
    const err = await sbSet('groups', groups);
    if (err) throw new Error(err.message);
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
}

async function saveSettings() {
  const settings = {
    ...(cachedData.settings || {}),
    delay: parseInt(document.getElementById('setDelay').value) || 10,
    maxGroups: parseInt(document.getElementById('setMaxGroups').value) || 10,
    jitter: parseInt(document.getElementById('setJitter').value) || 5,
  };
  cachedData.settings = settings;
  await sbSet('settings', settings);
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
