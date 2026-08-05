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
  addGroupRow();
  setupNav();

  // Check Supabase session
  const { data } = await sb.auth.getSession();
  if (!data.session) {
    window.location.href = 'signup.html';
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

  // Load settings + pairing code immediately
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
  await sb.from('amplr_data').upsert({ user_id: user.id, key, value, updated_at: new Date().toISOString() });
}

async function checkConn() {
  const bar = document.getElementById('connBar');
  const dot = document.getElementById('connDot');
  const label = document.getElementById('connLabel');

  if (!user) return;

  // Check for recent extension activity (any job in last 2 min)
  const twoMinAgo = new Date(Date.now() - 120000).toISOString();
  const { data: recent } = await sb.from('jsw_post_jobs')
    .select('status,updated_at').eq('user_id', user.id)
    .order('updated_at', { ascending: false }).limit(1);

  // Also check pairing code exists
  const settings = await sbGet('settings') || {};
  const hasPairing = !!settings.pairing_code;

  if (recent && recent[0]) {
    const age = Date.now() - new Date(recent[0].updated_at || 0).getTime();
    const isRecent = age < 120000;
    if (recent[0].status === 'processing') {
      connected = true;
      bar.className = 'conn-bar connected';
      dot.className = 'conn-dot on';
      label.textContent = 'Posting...';
    } else if (isRecent || hasPairing) {
      connected = true;
      bar.className = 'conn-bar connected';
      dot.className = 'conn-dot on';
      label.textContent = 'Connected';
    } else {
      connected = false;
      bar.className = 'conn-bar disconnected';
      dot.className = 'conn-dot off';
      label.textContent = hasPairing ? 'Extension offline' : 'Not paired';
    }
  } else {
    connected = false;
    bar.className = 'conn-bar disconnected';
    dot.className = 'conn-dot off';
    label.textContent = hasPairing ? 'Extension offline' : 'Not paired';
  }

  if (connected) {
    cachedData = await fetchAll();
    loadDashboard();
  }
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
  posts.forEach(p => p.groups.forEach(g => groupUrls.add(g.url)));

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

function addGroupRow(pre = {}) {
  groupCount++;
  const c = GCOLORS[(groupCount - 1) % GCOLORS.length];
  const div = document.createElement('div');
  div.className = 'group-entry';
  div.innerHTML = `
    <div class="gc" style="background:${c}"></div>
    <input type="url" class="gu" placeholder="https://www.facebook.com/groups/..." value="${pre.url || ''}" />
    <input type="text" class="gn" placeholder="Name" style="flex:.5;" value="${pre.name || ''}" />
    <button class="btn btn-ghost btn-sm" onclick="this.parentElement.remove()">x</button>`;
  document.getElementById('createGroups').appendChild(div);
}

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
  if (!text) return toast('Post text required');
  if (selDays.length === 0) return toast('Select at least one day');
  const groups = getGroupsFromForm();
  if (groups.length === 0) return toast('Add at least one group');
  const post = {
    id: Date.now().toString(), text, imageUrl: '', groups,
    schedule: { time, days: [...selDays] }, enabled: true,
    createdAt: new Date().toISOString(),
    hasSpintax: hasSpintax(text), variations: countVariations(text),
  };
  const posts = [...(cachedData.posts || []), post];
  cachedData.posts = posts;
  await sbSet('posts', posts);
  toast('Scheduled!');
  document.getElementById('createText').value = '';
  document.getElementById('spinInfo').style.display = 'none';
  nav('scheduled');
}

async function postNow() {
  const text = document.getElementById('createText').value.trim();
  if (!text) return toast('Post text required');
  const groups = getGroupsFromForm();
  if (groups.length === 0) return toast('Add at least one group');
  try {
    await createJob({ text, imageUrl: '', groups });
    toast('Post job sent — extension will pick it up');
  } catch (e) { toast(e.message); }
}

function getGroupsFromForm() {
  const groups = [];
  document.querySelectorAll('#createGroups .group-entry').forEach(e => {
    const url = e.querySelector('.gu').value.trim();
    const name = e.querySelector('.gn').value.trim() || url;
    if (url) groups.push({ url, name });
  });
  return groups;
}

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
  const templates = cachedData.templates || [];
  document.getElementById('quickTemplates').innerHTML = templates.length === 0
    ? '<div style="font-size:12px;color:var(--text-3);">No saved templates yet</div>'
    : templates.map(t => `
      <div class="template-card" onclick="useTemplate('${t.id}')">
        <div class="template-name">${esc(t.name)}</div>
        <div class="template-preview">${esc(t.text.substring(0, 80))}...</div>
      </div>`).join('');
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

function editPost(id) {
  const p = (cachedData.posts || []).find(x => x.id === id);
  if (!p) return;
  document.getElementById('createText').value = p.text;
  document.getElementById('createTime').value = p.schedule.time;
  selDays = [...p.schedule.days]; renderDays();
  document.getElementById('createGroups').innerHTML = ''; groupCount = 0;
  p.groups.forEach(g => addGroupRow(g));
  document.getElementById('createText').dispatchEvent(new Event('input'));
  delPost(id);
  nav('create');
  toast('Edit and save to update');
}

// ═══ GROUPS ═══
async function loadGroups() {
  cachedData = await fetchAll();
  const posts = cachedData.posts || [];
  const groupMap = new Map();
  posts.forEach(p => p.groups.forEach(g => {
    if (!groupMap.has(g.url)) groupMap.set(g.url, { ...g, posts: 0, ok: 0, fail: 0 });
    groupMap.get(g.url).posts++;
  }));
  (cachedData.logs || []).forEach(l => {
    (l.results || []).forEach(r => {
      const g = Array.from(groupMap.values()).find(x => x.name === r.group);
      if (g) { if (r.success) g.ok++; else g.fail++; }
    });
  });
  const groups = Array.from(groupMap.values());
  const tbody = document.getElementById('groupsBody');
  const empty = document.getElementById('groupsEmpty');
  if (groups.length === 0) { tbody.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  tbody.innerHTML = groups.map(g => {
    const total = g.ok + g.fail;
    const rate = total > 0 ? Math.round(g.ok / total * 100) : null;
    return `<tr>
      <td><strong>${esc(g.name)}</strong></td>
      <td style="font-size:11px;color:var(--text-3);max-width:250px;overflow:hidden;text-overflow:ellipsis;">${esc(g.url)}</td>
      <td><span class="badge badge-blue">${g.posts}</span></td>
      <td>${rate !== null ? `<div style="display:flex;align-items:center;gap:6px;"><div style="width:40px;height:5px;background:var(--surface-2);border-radius:3px;overflow:hidden;"><div style="width:${rate}%;height:100%;background:${rate > 80 ? 'var(--green)' : rate > 50 ? 'var(--yellow)' : 'var(--red)'};"></div></div><span style="font-size:11px;color:var(--text-3);">${rate}%</span></div>` : '—'}</td>
      <td></td>
    </tr>`;
  }).join('');
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

// ═══ SETTINGS ═══
async function loadSettings() {
  // Always fetch fresh settings to ensure pairing code is shown
  cachedData.settings = await sbGet('settings') || cachedData.settings || {};
  const s = cachedData.settings;
  // Show pairing code section
  const codeEl = document.getElementById('pairingCodeDisplay');
  if (codeEl) {
    if (s.pairing_code) {
      codeEl.innerHTML = `<div style="display:flex;align-items:center;gap:12px;">
        <div style="font-size:24px;font-weight:800;letter-spacing:4px;font-family:'SF Mono','Monaco','Menlo',monospace;background:linear-gradient(120deg,#5B6FE8,#9B5DE5,#F368A8);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;cursor:pointer;" onclick="copyBannerCode()">${s.pairing_code}</div>
        <button class="btn btn-ghost btn-sm" onclick="generatePairingCode()">New</button>
      </div>`;
    } else {
      codeEl.innerHTML = `<button class="btn btn-primary btn-sm" onclick="generatePairingCode()">Generate Code</button>`;
    }
  }

  // Status
  const statusEl = document.getElementById('connStatus');
  const hintEl = document.getElementById('installHint');
  if (statusEl) {
    statusEl.innerHTML = connected
      ? '<span style="color:var(--green);">Connected & ready</span>'
      : '<span style="color:var(--red);">Extension not paired — enter the code above in your extension</span>';
  }
  if (hintEl) {
    hintEl.style.display = connected ? 'none' : 'block';
  }

  // Show/hide pairing banner on dashboard
  const banner = document.getElementById('pairingBanner');
  const bannerCode = document.getElementById('bannerCode');
  if (banner && bannerCode) {
    if (!connected && s.pairing_code) {
      banner.style.display = 'block';
      bannerCode.textContent = s.pairing_code;
    } else {
      banner.style.display = 'none';
    }
  }

  if (s.delay) document.getElementById('setDelay').value = s.delay;
  if (s.maxGroups) document.getElementById('setMaxGroups').value = s.maxGroups;
  if (s.jitter) document.getElementById('setJitter').value = s.jitter;
}

async function generatePairingCode() {
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  const settings = { ...(cachedData.settings || {}), pairing_code: code };
  cachedData.settings = settings;
  await sbSet('settings', settings);

  // Also upsert into jsw_settings so the extension can find it
  await sb.from('jsw_settings').upsert({
    user_id: user.id, pairing_code: code,
    ai_provider: settings.ai_provider || 'openai',
    ai_model: settings.ai_model || 'gpt-4o-mini',
    default_delay: settings.delay || 30,
    ai_enabled: false,
  });

  toast('Pairing code generated');
  loadSettings();
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

// ═══ LOGOUT ═══
async function logout() {
  await sb.auth.signOut();
  window.location.href = 'signup.html';
}

// ═══ BANNER ═══
function copyBannerCode() {
  const code = document.getElementById('bannerCode')?.textContent || '';
  if (!code || code.includes('—')) return;
  navigator.clipboard.writeText(code).then(() => {
    toast('Code copied!');
  });
}

// ═══ MODAL ═══
function openModal() {
  loadSettings(); // Refresh pairing code
  document.getElementById('connectModal').classList.add('show');
}
function closeModal() { document.getElementById('connectModal').classList.remove('show'); }

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
