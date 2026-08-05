// ═══ FB Groups Autoposter — Dashboard v2 ═══

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const GCOLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];

let EXT_ID = localStorage.getItem('fb_ext_id') || '';
let connected = false;
let cachedData = { posts: [], logs: [], templates: [], groups: [], settings: {} };
let selDays = [1, 2, 3, 4, 5];
let groupCount = 0;
let calDate = new Date();

// ─── Init ──
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  renderDays();
  renderCalNames();
  addGroupRow();
  setupNav();
  checkConn();
  setInterval(checkConn, 30000);
});

// ═══ THEME ═══
function initTheme() {
  const dark = localStorage.getItem('fb_dark') === '1';
  if (dark) {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.getElementById('themeToggle').classList.add('on');
  }
}

function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (isDark) {
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('fb_dark', '0');
    document.getElementById('themeToggle').classList.remove('on');
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('fb_dark', '1');
    document.getElementById('themeToggle').classList.add('on');
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

// ═══ EXTENSION COMMS ═══
function sendExt(msg) {
  return new Promise((resolve, reject) => {
    if (!EXT_ID) return reject(new Error('No extension ID'));
    try {
      chrome.runtime.sendMessage(EXT_ID, msg, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(resp);
      });
    } catch (e) { reject(e); }
  });
}

async function checkConn() {
  const bar = document.getElementById('connBar');
  const dot = document.getElementById('connDot');
  const label = document.getElementById('connLabel');

  if (!EXT_ID) {
    connected = false;
    bar.className = 'conn-bar disconnected';
    dot.className = 'conn-dot off';
    label.textContent = 'Not paired';
    return;
  }

  try {
    const resp = await sendExt({ type: 'ping' });
    if (resp?.ok) {
      connected = true;
      bar.className = 'conn-bar connected';
      dot.className = 'conn-dot on';
      label.textContent = 'Connected';
      cachedData = await fetchAll();
      loadDashboard();
    } else throw new Error('bad');
  } catch (e) {
    connected = false;
    bar.className = 'conn-bar disconnected';
    dot.className = 'conn-dot off';
    label.textContent = 'Offline';
  }
}

async function fetchAll() {
  try {
    const data = await sendExt({ type: 'get-data' });
    return {
      posts: data?.posts || [],
      logs: data?.logs || [],
      templates: data?.templates || [],
      groups: data?.groups || [],
      settings: data?.settings || {},
    };
  } catch (e) {
    toast('Cannot reach extension');
    return cachedData;
  }
}

// ═══ SPINTAX ═══
function hasSpintax(text) {
  return /\{[^}]+\|[^}]+\}/.test(text);
}

function spinVariation(text) {
  return text.replace(/\{([^}]+)\}/g, (_, content) => {
    const options = content.split('|');
    return options[Math.floor(Math.random() * options.length)];
  });
}

function countVariations(text) {
  let count = 1;
  const regex = /\{([^}]+)\}/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    count *= m[1].split('|').length;
  }
  return count;
}

// ═══ DASHBOARD ═══
async function loadDashboard() {
  cachedData = await fetchAll();
  const { posts, logs } = cachedData;

  const active = posts.filter(p => p.enabled).length;
  const ok = logs.reduce((s, l) => s + (l.results || []).filter(r => r.success).length, 0);
  const fail = logs.reduce((s, l) => s + (l.results || []).filter(r => !r.success).length, 0);
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
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dStr = d.toDateString();
    const dayLogs = logs.filter(l => new Date(l.timestamp).toDateString() === dStr);
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
    ? '''<div class="empty"><p>No scheduled posts</p></div>''
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

  // Top groups by success rate
  const groupStats = {};
  logs.forEach(l => {
    (l.results || []).forEach(r => {
      if (!groupStats[r.group]) groupStats[r.group] = { ok: 0, fail: 0 };
      if (r.success) groupStats[r.group].ok++;
      else groupStats[r.group].fail++;
    });
  });
  const topGroups = Object.entries(groupStats)
    .map(([name, s]) => ({ name, rate: s.ok + s.fail > 0 ? Math.round(s.ok / (s.ok + s.fail) * 100) : 0, ...s }))
    .sort((a, b) => b.ok - a.ok)
    .slice(0, 5);

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
      </div>
    `).join('');
}

// ═══ CALENDAR ═══
function renderCalNames() {
  document.getElementById('calDayNames').innerHTML = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    .map(d => `<div class="cal-day-name">${d}</div>`).join('');
}

async function loadCalendar() {
  cachedData = await fetchAll();
  renderCalendar();
}

function renderCalendar() {
  const year = calDate.getFullYear();
  const month = calDate.getMonth();
  document.getElementById('calMonth').textContent = `${MONTHS[month]} ${year}`;

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevDays = new Date(year, month, 0).getDate();
  const today = new Date();

  let html = '';

  // Previous month trailing days
  for (let i = firstDay - 1; i >= 0; i--) {
    html += `<div class="cal-day other"><div class="cal-day-num">${prevDays - i}</div></div>`;
  }

  // Current month days
  const posts = cachedData.posts || [];
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month, d);
    const dayOfWeek = date.getDay();
    const isToday = date.toDateString() === today.toDateString();

    // Find posts for this day
    const dayPosts = posts.filter(p => p.enabled && p.schedule.days.includes(dayOfWeek));
    const events = dayPosts.map(p => {
      const colors = ['blue', 'green', 'purple'];
      const c = colors[p.id.charCodeAt(0) % 3];
      const spin = hasSpintax(p.text) ? ' ' : '';
      return `<div class="cal-event ${c}" onclick="nav('scheduled')" title="${esc(p.text.substring(0, 40))}...">${p.schedule.time} ${esc(p.text.substring(0, 20))}${spin}...</div>`;
    }).join('');

    html += `<div class="cal-day ${isToday ? 'today' : ''}">
      <div class="cal-day-num">${d}</div>
      ${events}
    </div>`;
  }

  // Next month leading days
  const totalCells = firstDay + daysInMonth;
  const remaining = (7 - (totalCells % 7)) % 7;
  for (let i = 1; i <= remaining; i++) {
    html += `<div class="cal-day other"><div class="cal-day-num">${i}</div></div>`;
  }

  document.getElementById('calGrid').innerHTML = html;
}

function prevMonth() {
  calDate.setMonth(calDate.getMonth() - 1);
  renderCalendar();
}

function nextMonth() {
  calDate.setMonth(calDate.getMonth() + 1);
  renderCalendar();
}

// ═══ CREATE ═══
function renderDays() {
  document.getElementById('createDays').innerHTML = DAYS.map((name, i) =>
    `<div class="day-chip ${selDays.includes(i) ? 'selected' : ''}" onclick="toggleDay(${i})">${name}</div>`
  ).join('');
}

function toggleDay(d) {
  selDays = selDays.includes(d) ? selDays.filter(x => x !== d) : [...selDays, d].sort();
  renderDays();
}

function addGroupRow(pre = {}) {
  groupCount++;
  const c = GCOLORS[(groupCount - 1) % GCOLORS.length];
  const div = document.createElement('div');
  div.className = 'group-entry';
  div.innerHTML = `
    <div class="gc" style="background:${c}"></div>
    <input type="url" class="gu" placeholder="https://www.facebook.com/groups/..." value="${pre.url || ''}" />
    <input type="text" class="gn" placeholder="Name" style="flex:.5;" value="${pre.name || ''}" />
    <button class="btn btn-ghost btn-sm" onclick="this.parentElement.remove()">x</button>
  `;
  document.getElementById('createGroups').appendChild(div);
}

// Live spintax detection
document.addEventListener('input', (e) => {
  if (e.target.id === 'createText') {
    const has = hasSpintax(e.target.value);
    const badge = document.getElementById('spinInfo');
    if (has) {
      const variations = countVariations(e.target.value);
      badge.style.display = 'inline-flex';
      badge.textContent = `${variations} VARIATIONS`;
    } else {
      badge.style.display = 'none';
    }
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
    id: Date.now().toString(),
    text, imageUrl: '', groups,
    schedule: { time, days: [...selDays] },
    enabled: true,
    createdAt: new Date().toISOString(),
    hasSpintax: hasSpintax(text),
    variations: countVariations(text),
  };

  try {
    await sendExt({ type: 'save-post', post });
    toast('Scheduled!');
    document.getElementById('createText').value = '';
    document.getElementById('spinInfo').style.display = 'none';
    nav('scheduled');
  } catch (e) { toast(e.message); }
}

async function postNow() {
  const text = document.getElementById('createText').value.trim();
  if (!text) return toast('Post text required');
  const groups = getGroupsFromForm();
  if (groups.length === 0) return toast('Add at least one group');

  const post = { id: 'temp-' + Date.now(), text, imageUrl: '', groups, schedule: { time: 'now', days: [] }, enabled: false };
  try {
    await sendExt({ type: 'post-now-custom', post });
    toast('Posting now!');
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
  try {
    await sendExt({ type: 'save-templates', templates });
    toast('Template saved');
  } catch (e) { toast(e.message); }
}

async function loadTemplates() {
  const templates = cachedData.templates || [];
  document.getElementById('quickTemplates').innerHTML = templates.length === 0
    ? '<div style="font-size:12px;color:var(--text-3);">No saved templates yet</div>'
    : templates.map(t => `
      <div class="template-card" onclick="useTemplate('${t.id}')">
        <div class="template-name">${esc(t.name)}</div>
        <div class="template-preview">${esc(t.text.substring(0, 80))}...</div>
      </div>
    `).join('');
}

function useTemplate(id) {
  const t = (cachedData.templates || []).find(x => x.id === id);
  if (!t) return;
  document.getElementById('createText').value = t.text;
  // Trigger spintax check
  document.getElementById('createText').dispatchEvent(new Event('input'));
  toast(`Loaded: ${t.name}`);
}

// ═══ TEMPLATES PAGE ═══
async function loadTemplatesPage() {
  cachedData = await fetchAll();
  const templates = cachedData.templates || [];
  const el = document.getElementById('templatesList');
  if (templates.length === 0) {
    el.innerHTML = '''<div class="empty"><p>No templates yet. Create a post and "Save as Template".</p></div>'';
    return;
  }
  el.innerHTML = templates.map(t => `
    <div class="template-card" onclick="nav('create'); setTimeout(() => useTemplate('${t.id}'), 100);">
      <div class="template-name">${esc(t.name)} ${hasSpintax(t.text) ? '<span class="spin-badge">SPINTAX</span>' : ''}</div>
      <div class="template-preview">${esc(t.text.substring(0, 120))}...</div>
      <div style="margin-top:8px;">
        <button class="btn btn-danger btn-xs" onclick="event.stopPropagation(); deleteTemplate('${t.id}')">Delete</button>
      </div>
    </div>
  `).join('');
}

async function deleteTemplate(id) {
  if (!confirm('Delete this template?')) return;
  const templates = (cachedData.templates || []).filter(t => t.id !== id);
  cachedData.templates = templates;
  await sendExt({ type: 'save-templates', templates });
  loadTemplatesPage();
  toast('Deleted');
}

// ═══ SCHEDULED ═══
async function loadScheduled() {
  cachedData = await fetchAll();
  const posts = cachedData.posts || [];
  const el = document.getElementById('scheduledList');

  if (posts.length === 0) {
    el.innerHTML = '''<div class="empty"><p>No scheduled posts yet</p><button class="btn btn-primary" style="margin-top:16px;" onclick="nav(\'create\')">Create Post</button></div>';
    return;
  }

  el.innerHTML = posts.map(p => {
    const days = p.schedule.days.map(d => DAYS[d]).join(', ');
    const tags = p.groups.map((g, i) => `<span class="group-tag"><div class="dot" style="background:${GCOLORS[i % GCOLORS.length]}"></div>${esc(g.name)}</span>`).join('');
    const spin = p.hasSpintax ? ` <span class="spin-badge">${p.variations || countVariations(p.text)} VARS</span>` : '';
    return `<div class="post-card">
      <div class="post-text">${esc(p.text)}</div>
      <div class="post-meta">
        <span>${p.schedule.time}</span>
        <span>${days}</span>
        <span class="badge ${p.enabled ? 'badge-on' : 'badge-off'}">${p.enabled ? 'Active' : 'Paused'}</span>
        ${spin}
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
  try { await sendExt({ type: 'post-now', id }); toast('Posting!'); }
  catch (e) { toast(e.message); }
}

async function togglePost(id) {
  try { await sendExt({ type: 'toggle-post', id }); loadScheduled(); }
  catch (e) { toast(e.message); }
}

async function delPost(id) {
  if (!confirm('Delete this post?')) return;
  try { await sendExt({ type: 'delete-post', id }); loadScheduled(); toast('Deleted'); }
  catch (e) { toast(e.message); }
}

function editPost(id) {
  const p = (cachedData.posts || []).find(x => x.id === id);
  if (!p) return;
  document.getElementById('createText').value = p.text;
  document.getElementById('createTime').value = p.schedule.time;
  selDays = [...p.schedule.days];
  renderDays();
  document.getElementById('createGroups').innerHTML = '';
  groupCount = 0;
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
    const entry = groupMap.get(g.url);
    entry.posts++;
  }));

  (cachedData.logs || []).forEach(l => {
    (l.results || []).forEach(r => {
      const g = Array.from(groupMap.values()).find(x => x.name === r.group);
      if (g) {
        if (r.success) g.ok++; else g.fail++;
      }
    });
  });

  const groups = Array.from(groupMap.values());
  const tbody = document.getElementById('groupsBody');
  const empty = document.getElementById('groupsEmpty');

  if (groups.length === 0) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
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

function showAddGroup() {
  const name = prompt('Group name:');
  if (!name) return;
  const url = prompt('Group URL:');
  if (!url) return;
  // Store as a standalone group
  if (!cachedData.groups) cachedData.groups = [];
  cachedData.groups.push({ name, url });
  sendExt({ type: 'save-groups', groups: cachedData.groups }).then(() => {
    toast('Group added');
    loadGroups();
  });
}

// ═══ LOGS ═══
async function loadLogs() {
  cachedData = await fetchAll();
  const logs = cachedData.logs || [];
  const el = document.getElementById('logsList');

  if (logs.length === 0) {
    el.innerHTML = '''<div class="empty"><p>No activity yet</p></div>'';
    return;
  }

  el.innerHTML = logs.map(l => {
    const results = l.results || [];
    const ok = results.filter(r => r.success).length;
    const fail = results.length - ok;
    const iconClass = ok > 0 && fail > 0 ? 'mix' : ok > 0 ? 'ok' : 'fail';
    const icon = ok > 0 && fail > 0 ? 'MIX' : ok > 0 ? 'OK' : 'FAIL';

    const resultDetails = results.map(r =>
      r.success
        ? `<span style="color:var(--green);">OK ${esc(r.group)}</span> <span style="color:var(--text-3);font-size:10px;">(${r.strategy || '?'})</span>`
        : `<span style="color:var(--red);">FAIL ${esc(r.group)}: ${esc(r.error || 'failed')}</span>`
    ).join('<br>');

    return `<div class="log-row">
      <div class="log-icon ${iconClass}">${icon}</div>
      <div class="log-body">
        <div class="log-time">${new Date(l.timestamp).toLocaleString()} • ${ok}/${results.length} succeeded</div>
        <div class="log-preview">${esc(l.postPreview)}</div>
        <div class="log-results" style="margin-top:4px;">${resultDetails}</div>
      </div>
    </div>`;
  }).join('');
}

async function clearLogs() {
  if (!confirm('Clear all logs?')) return;
  try { await sendExt({ type: 'clear-logs' }); loadLogs(); toast('Cleared'); }
  catch (e) { toast(e.message); }
}

function exportLogs() {
  const logs = cachedData.logs || [];
  if (logs.length === 0) return toast('No logs to export');
  
  const rows = [['Timestamp', 'Preview', 'Group', 'Success', 'Error', 'Strategy']];
  logs.forEach(l => {
    (l.results || []).forEach(r => {
      rows.push([l.timestamp, l.postPreview || '', r.group || '', r.success ? 'YES' : 'NO', r.error || '', r.strategy || '']);
    });
  });
  
  const csv = rows.map(r => r.map(c => `"${(c || '').toString().replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `autoposter-logs-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Exported');
}

// ═══ SETTINGS ═══
function loadSettings() {
  document.getElementById('settingsExtId').value = EXT_ID;
  document.getElementById('connStatus').innerHTML = connected
    ? '<span style="color:var(--green);">● Connected & ready</span>'
    : '<span style="color:var(--red);">● Not connected</span>';
  const s = cachedData.settings || {};
  if (s.delay) document.getElementById('setDelay').value = s.delay;
  if (s.maxGroups) document.getElementById('setMaxGroups').value = s.maxGroups;
  if (s.jitter) document.getElementById('setJitter').value = s.jitter;
  if (s.strategy) document.getElementById('setStrategy').value = s.strategy;
}

async function saveExtSettings() {
  const id = document.getElementById('settingsExtId').value.trim();
  if (!id) return toast('Enter extension ID');
  EXT_ID = id;
  localStorage.setItem('fb_ext_id', id);
  toast('Saved. Checking...');
  checkConn();
}

async function saveSettings() {
  const settings = {
    delay: parseInt(document.getElementById('setDelay').value) || 10,
    maxGroups: parseInt(document.getElementById('setMaxGroups').value) || 10,
    jitter: parseInt(document.getElementById('setJitter').value) || 5,
    strategy: document.getElementById('setStrategy').value,
  };
  try { await sendExt({ type: 'save-settings', settings }); toast('Settings saved'); }
  catch (e) { toast(e.message); }
}

async function deleteAllPosts() {
  if (!confirm('Delete ALL scheduled posts?')) return;
  try { await sendExt({ type: 'delete-all-posts' }); toast('All posts deleted'); loadScheduled(); }
  catch (e) { toast(e.message); }
}

async function resetAll() {
  if (!confirm('Reset EVERYTHING?')) return;
  try { await sendExt({ type: 'factory-reset' }); toast('Reset complete'); location.reload(); }
  catch (e) { toast(e.message); }
}

// ═══ MODAL ═══
function openModal() {
  document.getElementById('extIdInput').value = EXT_ID;
  document.getElementById('connectModal').classList.add('show');
}
function closeModal() {
  document.getElementById('connectModal').classList.remove('show');
}
function doConnect() {
  const id = document.getElementById('extIdInput').value.trim();
  if (!id) return toast('Enter extension ID');
  EXT_ID = id;
  localStorage.setItem('fb_ext_id', id);
  closeModal();
  checkConn();
}

// ═══ UTIL ═══
function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function toast(msg) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}
