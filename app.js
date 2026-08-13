// ═══ Reachr — Dashboard v3 (Supabase) ═══

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const GCOLORS = ['#3b82f6','#ef4444','#10b981','#f59e0b','#8b5cf6','#ec4899','#06b6d4','#84cc16'];

// ─── Supabase ───
const SUPABASE_URL = window.AMPLR_SUPABASE_URL || 'https://xacehhtgvubcqdoltazg.supabase.co';
const SUPABASE_KEY = window.AMPLR_SUPABASE_KEY || 'sb_publishable_1TNu5hqotJ7GGQXfjliivQ_ttK51EAA';
let sb = null;
let user = null;

try {
  sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  window.sb = sb;
} catch(e) {
  console.error('[Reachr] Supabase client failed', e);
  showAuthFallback?.('Could not load sign-in. Check your connection and try again.');
}

let connected = false;
let cachedData = { posts: [], logs: [], groups: [], settings: {}, postingIdentities: [] };
let selDays = [1, 2, 3, 4, 5];
let editingPostId = null;
let groupCount = 0;
let historyFilter = 'posts';
let schedChecker = null;
let checkConnRunning = false;
let schedulerBusy = false;
const HEARTBEAT_STALE_MS = 90000;
const SCHEDULE_FIRE_WINDOW_MS = 2 * 60 * 1000;

// ─── Init ───
document.addEventListener('DOMContentLoaded', () => {
  bootApp().catch(err => {
    console.error('[Reachr] startup failed', err);
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
  catch (e) { console.warn(`[Reachr] ${name} skipped`, e); }
}

function byId(id) { return document.getElementById(id); }
function setText(id, value) { const el = byId(id); if (el) el.textContent = value; }
function setHtml(id, value) { const el = byId(id); if (el) el.innerHTML = value; }
function setStyle(id, prop, value) { const el = byId(id); if (el) el.style[prop] = value; }

async function bootApp() {
  safeStartupStep('theme init', initTheme);
  safeStartupStep('day picker init', renderDays);
  safeStartupStep('nav init', setupNav);

  if (!sb?.auth) throw new Error('Sign-in did not load. Check your connection and refresh.');

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
  loadSettings().catch(e => console.warn('[Reachr] settings load failed', e));
  loadCreate().catch(e => console.warn('[Reachr] post flow load failed', e));
  loadDashboard().catch(e => console.warn('[Reachr] overview load failed', e));
  checkConn().catch(e => console.warn('[Reachr] connection check failed', e));
  setInterval(() => checkConn().catch(e => console.warn('[Reachr] connection check failed', e)), 60000);
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

function toggleMobileNav() {
  document.getElementById('sidebar')?.classList.toggle('open');
  document.getElementById('sidebarBackdrop')?.classList.toggle('show');
}

function closeMobileNav() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebarBackdrop')?.classList.remove('show');
}

function nav(page) {
  closeMobileNav();
  if (page !== 'groups' && groupSyncPollTimer) {
    clearInterval(groupSyncPollTimer);
    groupSyncPollTimer = null;
  }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`page-${page}`)?.classList.add('active');
  document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active');
  if (window.history?.replaceState) window.history.replaceState(null, '', `#${page}`);
  switch (page) {
    case 'dashboard': return loadDashboard();
    case 'create': return loadCreate();
    case 'scheduled': return loadScheduled();
    case 'groups': return loadGroups();
    case 'logs': return loadLogs();
    case 'settings': loadSettings(); return refreshIdentitySyncStatus();
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
  if (error) console.error('[Reachr] sbSet error:', key, error.message);
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
  if (checkConnRunning) return;
  const bar = document.getElementById('connBar');
  const dot = document.getElementById('connDot');
  const label = document.getElementById('connLabel');

  if (!user || !bar || !dot || !label) return;
  checkConnRunning = true;

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
    const isOnline = hbAge < HEARTBEAT_STALE_MS;
    const activeJob = recentRes.data?.[0] || null;
    const extVersion = status?.version && status.version !== 'unknown' ? ` v${status.version}` : '';
    const lastSeen = hb ? ` · ${timeAgo(hb)}` : '';

    if (isOnline) {
      connected = true;
      bar.className = 'conn-bar connected';
      dot.className = 'conn-dot on';
      if (activeJob?.status === 'processing') {
        label.textContent = activeJob.message === '__sync_identities__' ? 'Updating profiles...' : activeJob.message === '__import_groups__' ? 'Importing groups...' : 'Posting...';
      } else if (activeJob?.status === 'pending') {
        label.textContent = activeJob.message === '__sync_identities__' ? 'Profile update waiting' : activeJob.message === '__import_groups__' ? 'Group import waiting' : 'Post waiting';
      } else {
        label.textContent = `Connected${extVersion}${lastSeen}`;
      }
      label.title = `Chrome helper connected${extVersion}${hb ? ` · last seen ${new Date(hb).toLocaleString()}` : ''}`;
    } else {
      connected = false;
      bar.className = 'conn-bar disconnected';
      dot.className = 'conn-dot off';
      const staleVersionHint = extVersion ? ` Reopen Reachr in Chrome; dashboard last heard from${extVersion}.` : '';
      label.textContent = hb ? `Chrome helper offline · last seen ${timeAgo(hb)}${extVersion}` : 'Chrome helper offline';
      label.title = `Open Reachr in Chrome and sign in with this dashboard account.${staleVersionHint}`;
    }

    // Keep this lightweight. Heavy page data is loaded by the active page renderer,
    // not by the heartbeat poll. Re-fetching everything here made startup and
    // periodic checks feel slow.
    await pollGroupNames();
    await pollExtLogs();
  } catch (e) {
    connected = false;
    bar.className = 'conn-bar disconnected';
    dot.className = 'conn-dot off';
    label.textContent = 'Could not check connection';
    label.title = 'Open Reachr in Chrome and refresh this page.';
  } finally {
    checkConnRunning = false;
  }
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
        el.innerHTML = '<div data-empty style="color:var(--text-3);padding:20px;text-align:center;">No activity yet. Recent Reachr activity will appear here.</div>';
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
    if (suppressedPolling) rows.push(`<div style="color:var(--text-3);padding:6px 0;">Hid ${suppressedPolling} routine check-in${suppressedPolling === 1 ? '' : 's'}.</div>`);
    el.innerHTML = rows.length ? rows.join('') : '<div style="color:var(--text-3);padding:20px;text-align:center;">Only routine check-ins recently.</div>';

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
    if (el) el.innerHTML = '<div style="color:var(--text-3);padding:20px;text-align:center;">Activity cleared.</div>';
  } catch (e) {
    toast('Could not clear activity');
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
    for (const r of resolved) {
      const g = groups.find(g => g.url === r.group_url);
      if (g && g.name !== r.group_name) {
        g.name = r.group_name;
        g.namePending = false;
        changed = true;
      }
      // Persist the resolved Facebook title back to the canonical table. The
      // dashboard renders jsw_groups, not the old JSON cache, so updating only
      // cachedData/sbSet leaves numeric or placeholder names visible forever.
      await sb.from('jsw_groups')
        .update({ group_name: r.group_name })
        .eq('user_id', user.id)
        .eq('group_url', r.group_url);
    }

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
    const fetchGroups = async () => {
      // Use select('*') so the dashboard stays compatible with whichever jsw_groups
      // schema is currently deployed. Optional columns such as group_avatar_url,
      // profile_key, page_key, joined_as, etc. may not exist in Supabase's live
      // schema/cache; requesting them explicitly makes PostgREST reject the whole
      // query and the Groups page renders 0 even though imports succeeded.
      return sb.from('jsw_groups')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });
    };
    const [postsRes, groupsRes, settings, logs, postingIdentitiesRes] = await Promise.all([
      sbGet('posts'),
      // Groups always come from jsw_groups table (shared with extension)
      fetchGroups(),
      sbGet('settings'),
      sbGet('logs'),
      sbGet('posting_identities'),
    ]);
    const groups = (groupsRes.data || []).map(r => ({
      url: r.group_url,
      name: r.group_name || r.group_url.split('/').filter(Boolean).pop(),
      group_avatar_url: r.group_avatar_url || null,
      avatar_url: r.group_avatar_url || null,
      last_posted_at: r.last_posted_at || null,
      ban_risk: r.ban_risk || 'low',
      removal_count: r.removal_count || 0,
      tags: Array.isArray(r.tags) ? r.tags : [],
      identity_name: r.identity_name || null,
      identity_key: r.identity_key || null,
      profile_name: r.profile_name || null,
      profile_key: r.profile_key || null,
      page_name: r.page_name || null,
      page_key: r.page_key || null,
      joined_as: r.joined_as || null,
      joined_as_key: r.joined_as_key || null,
      member_profile_name: r.member_profile_name || null,
      member_profile_key: r.member_profile_key || null,
      collected_by: r.collected_by || null,
      collected_by_key: r.collected_by_key || null,
      imported_by: r.imported_by || null,
      imported_by_key: r.imported_by_key || null,
    })).filter(g => groupOwnerKey(g) && !isLegacyGroupAssignment(g));
    return {
      posts: postsRes || [],
      logs: logs || [],
      groups,
      settings: settings || {},
      postingIdentities: sanitizePostingIdentities(Array.isArray(postingIdentitiesRes) ? postingIdentitiesRes : (postingIdentitiesRes?.identities || [])),
    };
  } catch (e) {
    return cachedData;
  }
}

// Create a posting job that the extension picks up
async function createJob(post) {
  const identity = getSelectedPostingIdentity();
  const identityName = post.identityName || post.identity_name || identity?.name || null;
  if (!identityName || !isValidPostingIdentity({ name: identityName })) {
    throw new Error('Update and select a Facebook profile before posting');
  }
  const groups = (post.groups || []).map(g => typeof g === 'string' ? { url: g, identity_name: identityName } : { ...g, identity_name: g.identity_name || identityName }).filter(g => g && g.url);
  const settings = cachedData.settings || {};
  const minDelay = Math.max(parseInt(settings.delay, 10) || 90, 90);
  const aiEnabled = post.aiEnabled ?? post.ai_enabled ?? document.getElementById('aiToggle')?.classList.contains('on');
  const { error } = await sb.from('jsw_post_jobs').insert({
    user_id: user.id,
    message: post.text,
    image_url: post.imageUrl || null,
    groups: groups,
    identity_name: identityName,
    delay: minDelay,
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
function resolveGroupRefName(ref) {
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

function jobResult(j) {
  if (!j) return {};
  if (!j.result) return {};
  if (typeof j.result === 'string') {
    try { return JSON.parse(j.result); } catch (_) { return { text: j.result }; }
  }
  return j.result || {};
}

function isValidPostingIdentity(identity) {
  const name = (identity?.name || '').trim().replace(/\s+/g, ' ');
  if (!name) return false;
  if (/^(quick switch profiles?|see all profiles?|see all pages?|settings(?: & privacy)?|help(?: & support)?|report a problem|give feedback|meta verified|meta business suite|display & accessibility|privacy|terms|privacy policy|advertising|ad choices|cookies|more|active|log out)$/i.test(name)) return false;
  if (/^(?:[A-Z]\s*){1,3}$/i.test(name.replace(/\./g, ''))) return false;
  if (/^(facebook|meta|pages?|profiles?|home|watch|marketplace|groups?|notifications?|menu)$/i.test(name)) return false;
  if (/^https?:\/\//i.test(name)) return false;
  const url = identity?.url || '';
  return !/(\/settings|\/help|\/privacy|\/policies|\/business|\/ads|\/ad_|\/groups\/|\/marketplace|\/events)/i.test(url);
}

function sanitizePostingIdentities(identities) {
  const seen = new Set();
  return (Array.isArray(identities) ? identities : [])
    .filter(isValidPostingIdentity)
    .map(identity => {
      const avatar_url = identity.avatar_url || identity.picture_url || identity.profile_picture_url || identity.photo_url || identity.image_url || identity.thumbnail_url || null;
      return { ...identity, avatar_url };
    })
    .filter(identity => {
      const key = (identity.name || identityKey(identity)).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function identityKey(identity) {
  return identity?.id || identity?.url || identity?.name || '';
}

function identityInitials(name='') {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return (parts.length ? parts.slice(0, 2).map(p => p[0]).join('') : 'A').toUpperCase();
}

function inferredFacebookPictureUrls(identity={}) {
  const urls = [];
  const rawUrl = identity.url || '';
  const addGraph = id => {
    if (id && /^\d{5,}$/.test(String(id))) urls.push(`https://graph.facebook.com/${encodeURIComponent(id)}/picture?type=large`);
  };
  try {
    const parsed = new URL(rawUrl, 'https://www.facebook.com');
    addGraph(parsed.searchParams.get('id'));
    const vanity = parsed.pathname.replace(/^\/+|\/+$/g, '');
    if (vanity && !/^(pages|groups|profile.php|people|help|settings)$/i.test(vanity)) {
      urls.push(`https://graph.facebook.com/${encodeURIComponent(vanity)}/picture?type=large`);
    }
  } catch (_) {}
  addGraph(identity.facebook_id || identity.page_id || identity.profile_id);
  return urls;
}

function identityAvatarCandidates(identity={}) {
  const candidates = [
    identity.avatar_url,
    identity.picture_url,
    identity.profile_picture_url,
    identity.photo_url,
    identity.image_url,
    identity.thumbnail_url,
    ...(Array.isArray(identity.avatar_urls) ? identity.avatar_urls : []),
    ...inferredFacebookPictureUrls(identity)
  ];
  const seen = new Set();
  return candidates
    .map(v => String(v || '').trim())
    .filter(Boolean)
    .filter(v => /^(https?:|data:image\/)/i.test(v))
    .filter(v => {
      if (seen.has(v)) return false;
      seen.add(v);
      return true;
    });
}

function avatarImgOnError(img, initials) {
  try {
    const queue = JSON.parse(img.dataset.fallbacks || '[]');
    const next = queue.shift();
    if (next) {
      img.dataset.fallbacks = JSON.stringify(queue);
      img.src = next;
      return;
    }
  } catch (_) {}
  const parent = img.parentElement;
  if (parent) {
    parent.classList.add('avatar-fallback');
    parent.textContent = initials || 'A';
  }
}

function identityAvatarHtml(identity={}, className='') {
  const name = identity.name || 'Facebook profile';
  const initials = esc(identityInitials(name));
  const urls = identityAvatarCandidates(identity);
  const first = urls[0];
  const rest = esc(JSON.stringify(urls.slice(1)));
  const cls = `profile-avatar ${className}`.trim();
  if (!first) return `<div class="${cls} avatar-fallback">${initials}</div>`;
  return `<div class="${cls}"><img src="${esc(first)}" alt="${esc(name)}" referrerpolicy="no-referrer" loading="lazy" data-fallbacks='${rest}' onerror="avatarImgOnError(this,'${initials}')"></div>`;
}

function identityHasAvatar(identity={}) {
  return identityAvatarCandidates(identity).length > 0;
}

function groupInitials(name='') {
  const cleaned = String(name || '').replace(/[^a-zA-Z0-9\s]/g, ' ').trim();
  const parts = cleaned.split(/\s+/).filter(Boolean).filter(p => !/^(the|and|of|for)$/i.test(p));
  return (parts.length ? parts.slice(0, 2).map(p => p[0]).join('') : 'G').toUpperCase();
}

function groupAvatarCandidates(group={}) {
  const candidates = [group.group_avatar_url, group.avatar_url, group.image_url, group.cover_url, group.picture_url, group.photo_url];
  try {
    const parsed = new URL(group.url || group.group_url || '', 'https://www.facebook.com');
    const match = parsed.pathname.match(/\/groups\/([^/?#]+)/i);
    const idOrSlug = match?.[1];
    if (idOrSlug && /^\d{5,}$/.test(idOrSlug)) candidates.push(`https://graph.facebook.com/${encodeURIComponent(idOrSlug)}/picture?type=large`);
  } catch (_) {}
  const seen = new Set();
  return candidates.map(v => String(v || '').trim()).filter(Boolean).filter(v => /^(https?:|data:image\/)/i.test(v)).filter(v => { if (seen.has(v)) return false; seen.add(v); return true; });
}

function groupAvatarHtml(group={}, className='') {
  const name = group.name || group.group_name || 'Facebook group';
  const initials = esc(groupInitials(name));
  const urls = groupAvatarCandidates(group);
  const cls = `group-avatar ${className}`.trim();
  if (!urls.length) return `<div class="${cls} avatar-fallback">${initials}</div>`;
  const rest = esc(JSON.stringify(urls.slice(1)));
  return `<div class="${cls}"><img src="${esc(urls[0])}" alt="${esc(name)}" referrerpolicy="no-referrer" loading="lazy" data-fallbacks='${rest}' onerror="avatarImgOnError(this,'${initials}')"></div>`;
}

function getSelectedPostingIdentityKey() {
  return localStorage.getItem('amplr_selected_posting_identity') || identityKey((cachedData.postingIdentities || [])[0]) || '';
}

function getSelectedPostingIdentity() {
  const identities = sanitizePostingIdentities(cachedData.postingIdentities || []);
  cachedData.postingIdentities = identities;
  const key = getSelectedPostingIdentityKey();
  const selected = identities.find(i => identityKey(i) === key) || identities[0] || null;
  if (!selected) localStorage.removeItem('amplr_selected_posting_identity');
  return selected;
}

function setSelectedPostingIdentity(key) {
  if (key) localStorage.setItem('amplr_selected_posting_identity', key);
  renderPostingIdentitySelect();
  renderCreateProfileCards();
  filterGroupsForSelectedIdentity();
  updateCreateWizardSummary();
}

function selectPostingIdentityAndContinue(key) {
  setSelectedPostingIdentity(key);
  if (createWizardStep === 1) goCreateStep(2, false);
}

function renderPostingIdentitySelect() {
  const select = document.getElementById('createIdentitySelect');
  if (!select) return;
  const identities = cachedData.postingIdentities || [];
  if (!identities.length) {
    select.innerHTML = '<option value="">No Facebook profiles added yet</option>';
    select.disabled = true;
    updateFacebookPreviewIdentity();
    return;
  }
  select.disabled = false;
  select.innerHTML = identities.map(identity => `<option value="${esc(identityKey(identity))}">${esc(identity.name || 'Unnamed profile')} — ${esc(identity.type || 'Facebook profile')}</option>`).join('');
  const key = getSelectedPostingIdentityKey();
  if (key && [...select.options].some(o => o.value === key)) select.value = key;
  else select.value = identityKey(identities[0]);
  updateFacebookPreviewIdentity();
  renderCreateProfileCards();
  updateCreateWizardSummary();
}

function selectedGroupTargets() {
  const identity = getSelectedPostingIdentity();
  const identityName = identity?.name || null;
  return getSelectedGroups().map(g => ({
    url: g.url,
    name: g.name,
    group_name: g.name,
    identity_name: identityName
  }));
}

function groupRefUrl(group) {
  return typeof group === 'string' ? group : (group?.url || group?.group_url || '');
}

function selectCreateGroupsByUrl(groups = []) {
  const wantedUrls = new Set(groups.map(groupRefUrl).filter(Boolean));
  document.querySelectorAll('#createGroupSelect .group-chip').forEach(chip => {
    chip.classList.toggle('selected', wantedUrls.has(chip.dataset.url));
  });
  updateSelectedCount();
  updateCreateWizardSummary();
}

function findIdentityForGroups(groups = []) {
  const identities = sanitizePostingIdentities(cachedData.postingIdentities || []);
  const refs = groups.filter(g => g && typeof g === 'object');
  const identityKeyFromGroups = refs.map(g => g.identity_key || g.identityKey || g.profile_key || g.profileKey).find(Boolean);
  if (identityKeyFromGroups) {
    const byKey = identities.find(i => identityKey(i) === identityKeyFromGroups);
    if (byKey) return byKey;
  }
  const identityNameFromGroups = refs.map(g => g.identity_name || g.identityName || g.profile_name || g.profileName || g.page_name || g.pageName).find(Boolean);
  return identityNameFromGroups ? findPostingIdentityByName(identityNameFromGroups) : null;
}

function updateFacebookPreviewIdentity() {
  const identity = getSelectedPostingIdentity();
  const nameEl = document.querySelector('.cp-fb-name');
  const avatarEl = document.querySelector('.cp-fb-av');
  if (nameEl) nameEl.textContent = identity?.name || 'Your Page';
  if (avatarEl) avatarEl.outerHTML = identityAvatarHtml(identity || { name: 'Your Page' }, 'cp-fb-av');
}

function renderPostingProfilesList(identities = cachedData.postingIdentities || []) {
  const el = document.getElementById('postingProfilesList');
  if (!el) return;
  if (!identities.length) {
    el.innerHTML = '<div class="empty" style="padding:22px 16px;text-align:center;"><p style="color:var(--text-3);font-size:13px;">No Facebook profiles added yet. Open Reachr in Chrome, sign in to Facebook, then click Update profiles.</p></div>';
    renderPostingIdentitySelect();
    return;
  }
  renderPostingIdentitySelect();
  el.innerHTML = identities.map(identity => {
    const name = esc(identity.name || 'Unnamed profile');
    const type = esc(identity.type || 'Facebook profile');
    const active = identity.is_active ? '<span style="font-size:11px;color:var(--green);font-weight:700;margin-left:6px;">active</span>' : '';
    const avatar = identityAvatarHtml(identity, 'profile-avatar-sm');
    return `<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border);">
      ${avatar}
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:700;color:var(--text);">${name}${active}</div>
        <div style="font-size:12px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${type}${identity.url ? ' · ' + esc(identity.url) : ''}</div>
      </div>
    </div>`;
  }).join('');
}

async function latestIdentitySyncJob() {
  const { data } = await sb.from('jsw_post_jobs')
    .select('id,status,result,error,created_at,started_at,completed_at')
    .eq('user_id', user.id)
    .eq('message', '__sync_identities__')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

function renderIdentitySyncStatus(job = null, identities = cachedData.postingIdentities || []) {
  const statuses = document.querySelectorAll('.identity-sync-status');
  const buttons = document.querySelectorAll('.identity-sync-btn');
  const active = job && ['pending', 'processing'].includes(job.status);
  buttons.forEach(btn => { btn.disabled = !!active; btn.textContent = active ? 'Updating...' : 'Update profiles'; });
  const avatarCount = identities.filter(identityHasAvatar).length;
  let text = identities.length
    ? `Last loaded: ${identities.length} Facebook profile${identities.length === 1 ? '' : 's'} · ${avatarCount} photo${avatarCount === 1 ? '' : 's'}.`
    : 'No Facebook profiles added yet. Press Update profiles.';
  let color = identities.length ? 'var(--green)' : 'var(--text-3)';
  if (job) {
    const result = jobResult(job);
    const rel = timeAgo(job.completed_at || job.started_at || job.created_at);
    if (active) { text = result.text || (job.status === 'pending' ? 'Waiting. Open Reachr in Chrome to continue.' : 'Reading your Facebook profiles...'); color = 'var(--yellow)'; }
    else if (job.status === 'done') { const count = result.count ?? identities.length; const photos = result.avatar_count ?? avatarCount; text = `Last update found ${count} Facebook profile${count === 1 ? '' : 's'} · ${photos} photo${photos === 1 ? '' : 's'} · ${rel}.`; color = 'var(--green)'; }
    else if (job.status === 'failed') { text = `Profile update failed${rel ? ' · ' + rel : ''}: ${result.error || job.error || 'unknown error'}`; color = 'var(--red)'; }
  }
  statuses.forEach(el => { el.textContent = text; el.style.color = color; });
  renderPostingProfilesList(identities);
}

async function refreshIdentitySyncStatus() {
  if (!user) return;
  const identitiesValue = await sbGet('posting_identities');
  cachedData.postingIdentities = sanitizePostingIdentities(Array.isArray(identitiesValue) ? identitiesValue : (identitiesValue?.identities || []));
  renderIdentitySyncStatus(await latestIdentitySyncJob(), cachedData.postingIdentities);
}

async function syncPostingIdentities() {
  if (!user) return;
  try {
    renderIdentitySyncStatus({ status: 'pending', result: { text: 'Starting profile update...' } }, cachedData.postingIdentities || []);
    const { data: existing } = await sb.from('jsw_post_jobs')
      .select('id,status,result,error,created_at,started_at,completed_at')
      .eq('user_id', user.id)
      .eq('message', '__sync_identities__')
      .in('status', ['pending', 'processing'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) {
      renderIdentitySyncStatus(existing, cachedData.postingIdentities || []);
      toast('Profile update already running');
      return existing;
    }
    const { error, data } = await sb.from('jsw_post_jobs').insert({
      user_id: user.id,
      message: '__sync_identities__',
      groups: [],
      status: 'pending',
      result: { text: 'Profile update waiting. Open Reachr in Chrome to continue.' },
      delay: 0,
      ai_enabled: false,
      scheduled_for: null
    }).select('id,status,result,error,created_at,started_at,completed_at').single();
    if (error) throw new Error(error.message);
    toast('Profile update waiting');
    renderIdentitySyncStatus(data, cachedData.postingIdentities || []);
    pollIdentitySyncJob(data.id);
    checkConn().catch(() => {});
    return data;
  } catch (e) {
    console.error('[Reachr] profile update error:', e);
    document.querySelectorAll('.identity-sync-status').forEach(el => { el.textContent = 'Could not start profile update: ' + e.message; el.style.color = 'var(--red)'; });
    document.querySelectorAll('.identity-sync-btn').forEach(btn => { btn.disabled = false; btn.textContent = 'Update profiles'; });
    toast('Could not start profile update');
  }
}

function pollIdentitySyncJob(jobId) {
  const started = Date.now();
  const timer = setInterval(async () => {
    try {
      const { data } = await sb.from('jsw_post_jobs').select('id,status,result,error,created_at,started_at,completed_at').eq('id', jobId).maybeSingle();
      if (!data) return;
      if (['done', 'failed', 'cancelled'].includes(data.status)) {
        clearInterval(timer);
        await refreshIdentitySyncStatus();
        if (data.status === 'done') toast('Profiles updated');
        else toast('Profile update failed');
      } else {
        renderIdentitySyncStatus(data, cachedData.postingIdentities || []);
      }
      if (Date.now() - started > 180000) clearInterval(timer);
    } catch (e) {
      clearInterval(timer);
      console.warn('[Reachr] identity sync poll failed', e);
    }
  }, 2500);
}

// ═══ DASHBOARD ═══
async function loadDashboard() {
  cachedData = await fetchAll();
  const { logs } = cachedData;
  const profileCount = (cachedData.postingIdentities || []).length;
  const groupCount = (cachedData.groups || []).length;

  const { data: jobs } = await sb.from('jsw_post_jobs')
    .select('status, groups, created_at, completed_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(500);

  let successfulPosts = 0;
  let failedPosts = 0;

  (jobs || []).filter(j => !isSystemJob(j)).forEach(j => {
    const groupRefs = Array.isArray(j.groups) ? j.groups : [];
    const count = groupRefs.length || 1;
    if (j.status === 'done') successfulPosts += count;
    if (j.status === 'failed') failedPosts += count;
  });

  (logs || []).forEach(log => {
    (log.results || []).forEach(result => {
      if (result.success) successfulPosts += 1;
      else failedPosts += 1;
    });
  });

  const totalPostsMade = successfulPosts + failedPosts;
  const successRate = totalPostsMade ? Math.round((successfulPosts / totalPostsMade) * 100) + '%' : '—';

  setText('navCount', (cachedData.posts || []).length);
  setText('dashProfilesCount', profileCount);
  setText('dashPostsMadeCount', totalPostsMade);
  setText('dashGroupsCount', groupCount);
  setText('dashSuccessRate', successRate);
}

// ═══ CREATE ═══
function renderDays() {
  document.getElementById('createDays').innerHTML = DAYS.map((name, i) =>
    `<div class="day-chip ${selDays.includes(i) ? 'selected' : ''}" onclick="toggleDay(${i})">${name}</div>`
  ).join('');
}
function toggleDay(d) { selDays = selDays.includes(d) ? selDays.filter(x => x !== d) : [...selDays, d].sort(); renderDays(); updateNextFire(); }

function setCreateImageStatus(message, type = '') {
  const el = document.getElementById('createImageUploadStatus');
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('error', type === 'error');
  el.classList.toggle('ok', type === 'ok');
}

function setCreateImagePreview(url, fileName = '') {
  const isValid = !!url && /^(https?:\/\/|data:image\/)/i.test(url);
  const thumb = document.getElementById('imagePreviewThumb');
  const img = document.getElementById('imagePreviewImg');
  const wrap = document.getElementById('fbPreviewImgWrap');
  const fbImg = document.getElementById('fbPreviewImgEl');
  const remove = document.getElementById('removeImageBtn');
  const name = document.getElementById('createImageFileName');
  if (thumb) thumb.style.display = isValid ? 'block' : 'none';
  if (img && isValid) img.src = url;
  if (wrap) wrap.style.display = isValid ? 'block' : 'none';
  if (fbImg && isValid) fbImg.src = url;
  if (remove) remove.style.display = isValid ? 'inline-flex' : 'none';
  if (name) name.textContent = fileName || '';
  updateCreateWizardSummary();
}

function getCreateImageUrl() {
  return document.getElementById('createUploadedImageUrl')?.value.trim()
    || document.getElementById('createImageUrl')?.value.trim()
    || '';
}

function safeStorageFileName(name = 'image') {
  const ext = (name.match(/\.([a-z0-9]{1,8})$/i)?.[1] || 'jpg').toLowerCase();
  const base = name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'image';
  return `${base}-${Date.now()}.${ext}`;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Could not read image file.'));
    reader.readAsDataURL(file);
  });
}

async function useInlineImageFallback(file, reason) {
  if (file.size > 350 * 1024) throw reason;
  const dataUrl = await fileToDataUrl(file);
  const urlInput = document.getElementById('createImageUrl');
  const uploadedInput = document.getElementById('createUploadedImageUrl');
  if (uploadedInput) uploadedInput.value = dataUrl;
  if (urlInput) urlInput.value = dataUrl;
  setCreateImagePreview(dataUrl, file.name);
  setCreateImageStatus('Image attached locally. Add Supabase Storage for larger images.', 'ok');
}

async function handleCreateImageFile(file) {
  if (!file) return;
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!allowed.includes(file.type)) return setCreateImageStatus('Use JPG, PNG, WEBP, or GIF.', 'error');
  if (file.size > 8 * 1024 * 1024) return setCreateImageStatus('Image is too large. Max 8 MB.', 'error');
  if (!user?.id) return setCreateImageStatus('Sign in before uploading images.', 'error');

  const urlInput = document.getElementById('createImageUrl');
  const uploadedInput = document.getElementById('createUploadedImageUrl');
  const fileInput = document.getElementById('createImageFile');
  const nameEl = document.getElementById('createImageFileName');
  if (nameEl) nameEl.textContent = file.name;
  setCreateImageStatus('Uploading image…');

  try {
    const path = `${user.id}/${safeStorageFileName(file.name)}`;
    const { error } = await sb.storage.from('post-images').upload(path, file, {
      cacheControl: '31536000',
      upsert: false,
      contentType: file.type || 'image/jpeg',
    });
    if (error) throw error;
    const { data } = sb.storage.from('post-images').getPublicUrl(path);
    const publicUrl = data?.publicUrl;
    if (!publicUrl) throw new Error('Upload succeeded but no public URL was returned.');
    if (uploadedInput) uploadedInput.value = publicUrl;
    if (urlInput) urlInput.value = publicUrl;
    setCreateImagePreview(publicUrl, file.name);
    setCreateImageStatus('Image uploaded.', 'ok');
  } catch (e) {
    console.error('[Reachr] image upload failed', e);
    try {
      await useInlineImageFallback(file, e);
      return;
    } catch (fallbackError) {
      if (uploadedInput) uploadedInput.value = '';
      if (fileInput) fileInput.value = '';
      setCreateImageStatus(`Upload failed: ${fallbackError.message || fallbackError}. Storage bucket "post-images" may need setup.`, 'error');
    }
  }
}

function clearCreateImage() {
  const urlInput = document.getElementById('createImageUrl');
  const uploadedInput = document.getElementById('createUploadedImageUrl');
  const fileInput = document.getElementById('createImageFile');
  if (urlInput) urlInput.value = '';
  if (uploadedInput) uploadedInput.value = '';
  if (fileInput) fileInput.value = '';
  setCreateImagePreview('', '');
  setCreateImageStatus('Use JPG, PNG, WEBP, or GIF. Max 8 MB.');
}

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
    updateCreateWizardSummary();
  }

  if (e.target.id === 'createImageUrl') {
    const url = e.target.value.trim();
    const uploadedInput = document.getElementById('createUploadedImageUrl');
    if (uploadedInput && uploadedInput.value !== url) uploadedInput.value = '';
    setCreateImagePreview(url, '');
    if (url) setCreateImageStatus(/^https?:\/\//i.test(url) ? 'Image URL ready.' : 'Paste a full image URL starting with http.', /^https?:\/\//i.test(url) ? 'ok' : 'error');
    else setCreateImageStatus('Use JPG, PNG, WEBP, or GIF. Max 8 MB.');
  }
});

async function savePost() {
  const text = document.getElementById('createText').value.trim();
  const time = document.getElementById('createTime').value;
  if (!text) return toast('Write something first');
  if (selDays.length === 0) return toast('Pick at least one day');
  const existing = editingPostId ? (cachedData.posts || []).find(p => p.id === editingPostId) : null;
  let groups = selectedGroupTargets();
  if (groups.length === 0 && existing) groups = scheduledEventGroups(existing);
  if (groups.length === 0) return toast('Select at least one group');
  const identity = getSelectedPostingIdentity();
  const fallbackIdentityName = existing ? scheduledEventIdentityName(existing) : '';
  if ((!identity?.name || !isValidPostingIdentity(identity)) && !isValidPostingIdentity({ name: fallbackIdentityName })) return toast('Update and select a Facebook profile before posting');
  const identityName = isValidPostingIdentity(identity) ? identity.name : fallbackIdentityName;
  const imageUrl = getCreateImageUrl();
  const maxRuns = parsePositiveInt(document.getElementById('scheduleMaxRuns')?.value);
  const weeks = parsePositiveInt(document.getElementById('scheduleWeeks')?.value);
  const endsAt = weeks ? new Date(Date.now() + weeks * 7 * 24 * 60 * 60 * 1000).toISOString() : (existing?.schedule?.endsAt || null);
  const post = {
    ...(existing || {}),
    id: existing?.id || Date.now().toString(), text, imageUrl, groups, identityName,
    firstComment: document.getElementById('createFirstComment')?.value.trim() || '',
    aiEnabled: !!document.getElementById('aiToggle')?.classList.contains('on'),
    schedule: {
      ...(existing?.schedule || {}),
      time,
      days: [...selDays],
      maxRuns,
      endsAt,
      firedCount: existing?.schedule?.firedCount || 0,
    },
    enabled: true,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    hasSpintax: hasSpintax(text), variations: countVariations(text),
  };
  const posts = editingPostId
    ? (cachedData.posts || []).map(p => p.id === editingPostId ? post : p)
    : [...(cachedData.posts || []), post];
  cachedData.posts = posts;
  const err = await sbSet('posts', posts);
  if (err) return toast('Error: ' + err.message);
  const wasEdit = !!editingPostId;
  editingPostId = null;
  toast(wasEdit ? 'Schedule updated' : 'Scheduled!');
  localStorage.removeItem('amplr_draft');
  clearCreateForm();
  nav('scheduled');
}

async function postNow() {
  const text = document.getElementById('createText').value.trim();
  const groups = selectedGroupTargets();
  const identity = getSelectedPostingIdentity();
  if (!text) return toast('Write something first');
  if (!identity?.name || !isValidPostingIdentity(identity)) return toast('Update and select a Facebook profile before posting');
  const identityName = identity.name;
  if (groups.length === 0) return toast('Select at least one group');
  if (groups.length > 3 && !confirm(`Post this now to ${groups.length} groups?`)) return;
  const imageUrl = getCreateImageUrl();

  const waiting = document.getElementById('postWaiting');
  if (waiting) waiting.style.display = 'block';

  try {
    const { error } = await sb.from('jsw_post_jobs').insert({
      user_id: user.id,
      message: text,
      image_url: imageUrl || null,
      groups: groups,
      identity_name: identityName,
      delay: Math.max(parseInt(cachedData.settings?.delay, 10) || 90, 90),
      status: 'pending',
      first_comment: document.getElementById('createFirstComment')?.value.trim() || null,
      ai_enabled: !!document.getElementById('aiToggle')?.classList.contains('on'),
    });
    if (error) throw new Error(error.message);

    if (waiting) waiting.style.display = 'none';
    toast('Sent — Reachr will post it');
    localStorage.removeItem('amplr_draft');
    clearCreateForm();
  } catch (e) {
    if (waiting) waiting.style.display = 'none';
    toast('Error: ' + e.message);
  }
}

async function loadCreate() {
  cachedData = await fetchAll();
  renderGroupChips();
  renderPostingIdentitySelect();
  restoreDraft();
  updateNextFire();
  initCreateWizard();
}

// ─── Tag filter state for group chip selectors ───
let createGroupTagFilter = null;
let createWizardStep = 1;
let createDeliveryMode = 'now';
let createContentType = localStorage.getItem('amplr_create_content_type') || 'standard';

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
    return `<div class="group-chip" onclick="this.classList.toggle('selected'); updateSelectedCount(); updateCreateWizardSummary();" data-url="${esc(g.url)}" data-name="${esc(g.name)}"
      style="display:inline-flex;align-items:center;gap:8px;padding:7px 12px 7px 8px;border-radius:22px;font-size:12px;cursor:pointer;border:1px solid var(--border);background:var(--surface);transition:all .15s;">
      ${groupAvatarHtml(g, 'group-avatar-chip')}
      <span>${esc(g.name)}</span>
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
  return [...document.querySelectorAll('#createGroupSelect .group-chip.selected')]
    .filter(c => c.style.display !== 'none')
    .map(c => ({
      url: c.dataset.url,
      name: c.dataset.name,
    }));
}


function startOfLocalDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function normalizeTimeValue(value) {
  const m = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '09:00';
  return `${String(Math.min(23, Math.max(0, Number(m[1])))).padStart(2, '0')}:${m[2]}`;
}

function displayTime(value) {
  const [h, m] = normalizeTimeValue(value).split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function findPostingIdentityByName(name) {
  const target = String(name || '').trim().toLowerCase();
  const identities = sanitizePostingIdentities(cachedData.postingIdentities || []);
  return identities.find(i => String(i.name || '').trim().toLowerCase() === target) || (name ? { name } : identities[0] || { name: 'Reachr' });
}

let upcomingPostDetails = {};
let queuedSubscriptionDetails = {};

function scheduledEventIdentityName(item) {
  return item.identityName || item.identity_name || item.groups?.find?.(g => g?.identity_name)?.identity_name || item.profile_name || item.page_name || '';
}

function scheduledEventGroups(item) {
  return Array.isArray(item.groups) ? item.groups : [];
}

function scheduledEventText(item) {
  return item.text || item.message || item.caption || '';
}

function scheduledEventImage(item) {
  return item.imageUrl || item.image_url || item.photo_url || '';
}

function groupDisplayName(group) {
  if (!group) return '';
  if (typeof group === 'string') return resolveGroupRefName(group);
  return group.name || group.group_name || group.title || resolveGroupRefName(group.url || group.group_url) || 'Group';
}

function scheduledWeekEvents(legacyPosts, scheduledJobs, weekDays) {
  const windowStart = startOfLocalDay(weekDays[0]);
  const windowEnd = addDays(windowStart, 7);
  const events = [];

  (scheduledJobs || []).filter(j => !isSystemJob(j)).forEach(j => {
    const when = j.scheduled_for ? new Date(j.scheduled_for) : null;
    if (!when || when < windowStart || when >= windowEnd) return;
    const groupCount = scheduledEventGroups(j).length || 1;
    const identityName = scheduledEventIdentityName(j);
    events.push({
      id: `job-${j.id}`,
      dateKey: localDateKey(when),
      time: normalizeTimeValue(`${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`),
      dateLabel: when.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
      identity: findPostingIdentityByName(identityName),
      identityName,
      text: scheduledEventText(j),
      imageUrl: scheduledEventImage(j),
      groups: scheduledEventGroups(j),
      title: `${identityName || 'Facebook profile'} · ${groupCount} group${groupCount === 1 ? '' : 's'}`
    });
  });

  (legacyPosts || []).filter(p => p.enabled && p.schedule?.time && Array.isArray(p.schedule?.days)).forEach(p => {
    const endsAt = p.schedule?.endsAt ? new Date(p.schedule.endsAt) : null;
    weekDays.forEach(day => {
      if (!p.schedule.days.includes(day.getDay())) return;
      if (endsAt && day > endsAt) return;
      const name = scheduledEventIdentityName(p);
      const groupCount = scheduledEventGroups(p).length || 1;
      events.push({
        id: `post-${p.id}-${localDateKey(day)}`,
        dateKey: localDateKey(day),
        time: normalizeTimeValue(p.schedule.time),
        dateLabel: day.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
        identity: findPostingIdentityByName(name),
        identityName: name,
        text: scheduledEventText(p),
        imageUrl: scheduledEventImage(p),
        groups: scheduledEventGroups(p),
        title: `${name || 'Facebook profile'} · ${groupCount} group${groupCount === 1 ? '' : 's'}`
      });
    });
  });

  return events.sort((a, b) => a.time.localeCompare(b.time));
}

function upcomingAvatarHtml(item) {
  return identityAvatarHtml(item.identity, 'week-post-avatar')
    .replace('<div ', `<div role="button" tabindex="0" title="${esc(item.title)}" onclick="openUpcomingPostDetail('${esc(item.id)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openUpcomingPostDetail('${esc(item.id)}')}" `);
}

function frequencyLabel(post) {
  const days = Array.isArray(post.schedule?.days) ? post.schedule.days : [];
  if (!days.length) return 'Not set';
  const sorted = [...days].sort((a, b) => a - b);
  const weekday = [1,2,3,4,5];
  const weekend = [0,6];
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  if (days.length === 7) return `Daily at ${displayTime(post.schedule?.time || '09:00')}`;
  if (same(sorted, weekday)) return `Weekdays at ${displayTime(post.schedule?.time || '09:00')}`;
  if (same(sorted, weekend)) return `Weekends at ${displayTime(post.schedule?.time || '09:00')}`;
  return `${sorted.map(d => DAYS[d]?.slice(0, 3) || d).join(', ')} at ${displayTime(post.schedule?.time || '09:00')}`;
}

function nextRunLabel(post, from = new Date()) {
  const days = Array.isArray(post.schedule?.days) ? post.schedule.days : [];
  const time = normalizeTimeValue(post.schedule?.time || '09:00');
  if (!days.length || !time) return 'Not set';
  const [hh, mm] = time.split(':').map(Number);
  const endsAt = post.schedule?.endsAt ? new Date(post.schedule.endsAt) : null;
  for (let i = 0; i < 30; i++) {
    const day = addDays(startOfLocalDay(from), i);
    if (!days.includes(day.getDay())) continue;
    day.setHours(hh || 0, mm || 0, 0, 0);
    if (day < from) continue;
    if (endsAt && day > endsAt) return 'Ended';
    return `${day.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · ${displayTime(time)}`;
  }
  return 'Not in next 30 days';
}

function subscriptionPatternKey(item) {
  const groups = scheduledEventGroups(item).map(g => g.url || g.group_url || groupDisplayName(g)).sort().join('|');
  const time = normalizeTimeValue(item.schedule?.time || (() => {
    const when = item.scheduled_for ? new Date(item.scheduled_for) : null;
    return when ? `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}` : '09:00';
  })());
  return [scheduledEventIdentityName(item), groups, time].join('||');
}

function jobGroupKey(job) {
  return subscriptionPatternKey(job);
}

function simpleHash(value) {
  let h = 0;
  const s = String(value || '');
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  return Math.abs(h).toString(36);
}

function queuedJobSubscriptionRows(jobs = []) {
  const grouped = new Map();
  (jobs || []).filter(j => !isSystemJob(j) && j.status === 'pending' && j.scheduled_for).forEach(job => {
    const key = jobGroupKey(job);
    const when = new Date(job.scheduled_for);
    if (!grouped.has(key)) {
      grouped.set(key, {
        id: `jobs-${simpleHash(key)}`,
        kind: 'job_group',
        jobIds: [],
        postCount: 0,
        previews: [],
        text: scheduledEventText(job),
        imageUrl: scheduledEventImage(job),
        identityName: scheduledEventIdentityName(job),
        groups: scheduledEventGroups(job),
        enabled: true,
        schedule: {
          time: normalizeTimeValue(`${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`),
          days: []
        },
        nextDate: when
      });
    }
    const row = grouped.get(key);
    row.jobIds.push(job.id);
    row.postCount += 1;
    const preview = scheduledEventText(job).replace(/\s+/g, ' ').trim();
    if (preview && !row.previews.includes(preview)) row.previews.push(preview);
    if (!row.imageUrl && scheduledEventImage(job)) row.imageUrl = scheduledEventImage(job);
    const day = when.getDay();
    if (!row.schedule.days.includes(day)) row.schedule.days.push(day);
    if (when < row.nextDate) row.nextDate = when;
  });
  return [...grouped.values()].map(row => {
    row.schedule.days.sort((a, b) => a - b);
    return row;
  });
}

function subscriptionRowKey(row) {
  return subscriptionPatternKey(row);
}

function mergedSubscriptionRows(posts = [], jobs = []) {
  const saved = (posts || []).filter(p => p.schedule?.time && Array.isArray(p.schedule?.days)).map(p => ({ ...p, kind: 'post' }));
  const savedKeys = new Set(saved.map(subscriptionRowKey));
  const queued = queuedJobSubscriptionRows(jobs).filter(row => !savedKeys.has(subscriptionRowKey(row)));
  return [...saved, ...queued].sort((a, b) => {
    const an = nextRunDate(a)?.getTime?.() || a.nextDate?.getTime?.() || 0;
    const bn = nextRunDate(b)?.getTime?.() || b.nextDate?.getTime?.() || 0;
    return an - bn;
  });
}

function nextRunDate(post, from = new Date()) {
  const days = Array.isArray(post.schedule?.days) ? post.schedule.days : [];
  const time = normalizeTimeValue(post.schedule?.time || '09:00');
  if (!days.length || !time) return null;
  const [hh, mm] = time.split(':').map(Number);
  const endsAt = post.schedule?.endsAt ? new Date(post.schedule.endsAt) : null;
  for (let i = 0; i < 30; i++) {
    const day = addDays(startOfLocalDay(from), i);
    if (!days.includes(day.getDay())) continue;
    day.setHours(hh || 0, mm || 0, 0, 0);
    if (day < from) continue;
    if (endsAt && day > endsAt) return null;
    return day;
  }
  return null;
}

function renderSubscriptionsTable(posts = [], jobs = []) {
  const subscriptions = mergedSubscriptionRows(posts, jobs);
  if (!subscriptions.length) {
    return `<div class="subscription-card">
      <div class="subscription-top">
        <div><div class="subscription-title">Subscriptions</div><div class="subscription-subtitle">Recurring and queued scheduled posts.</div></div>
        <button class="btn btn-secondary btn-sm" onclick="nav('create')">Add subscription</button>
      </div>
      <div class="subscription-empty">No recurring or queued scheduled posts yet.</div>
    </div>`;
  }

  return `<div class="subscription-card">
    <div class="subscription-top">
      <div><div class="subscription-title">Subscriptions</div><div class="subscription-subtitle">Recurring and queued scheduled posts.</div></div>
      <button class="btn btn-secondary btn-sm" onclick="nav('create')">Add subscription</button>
    </div>
    <div class="subscription-list">${subscriptions.map(post => {
      const identityName = scheduledEventIdentityName(post);
      const identity = findPostingIdentityByName(identityName);
      const groups = scheduledEventGroups(post);
      const groupCount = groups.length || 0;
      const isQueued = post.kind === 'job_group';
      const preview = isQueued && post.previews?.length
        ? post.previews[0]
        : (scheduledEventText(post).replace(/\s+/g, ' ').trim() || 'No post text saved');
      const postMeta = isQueued
        ? `${post.postCount || post.jobIds?.length || 0} scheduled post${(post.postCount || post.jobIds?.length || 0) === 1 ? '' : 's'}${post.previews?.length > 1 ? ` · ${post.previews.length} versions` : ''}`
        : (scheduledEventImage(post) ? 'Includes image' : '');
      const groupNames = groups.map(groupDisplayName).filter(Boolean);
      const groupLabel = groupCount
        ? `${groupCount} group${groupCount === 1 ? '' : 's'}${groupNames.length ? ` · ${groupNames.slice(0, 2).join(', ')}${groupNames.length > 2 ? ` +${groupNames.length - 2}` : ''}` : ''}`
        : 'No groups selected';
      const frequency = frequencyLabel(post);
      const nextLabel = isQueued && post.nextDate ? `${post.nextDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · ${displayTime(post.schedule?.time || '09:00')}` : (post.enabled ? nextRunLabel(post) : 'Paused');
      const statusLabel = isQueued ? 'Scheduled' : (post.enabled ? 'Active' : 'Paused');
      const statusClass = (isQueued || post.enabled) ? 'badge-green' : 'badge-gray';
      const eyeIcon = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8s2.3-4 6.5-4 6.5 4 6.5 4-2.3 4-6.5 4-6.5-4-6.5-4Z"/><circle cx="8" cy="8" r="2"/></svg>';
      const pencilIcon = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M11.8 2.2 13.8 4.2 5.8 12.2 2.5 13.5 3.8 10.2 11.8 2.2Z"/><path d="M10.5 3.5 12.5 5.5"/></svg>';
      const actions = isQueued
        ? `<button class="btn btn-secondary btn-sm icon-action-btn" onclick="openQueuedJobDetail('${esc(post.id)}')" title="View" aria-label="View queued post">${eyeIcon}</button><button class="btn btn-secondary btn-sm icon-action-btn" onclick="editQueuedSubscription('${esc(post.id)}')" title="Edit" aria-label="Edit queued post">${pencilIcon}</button>`
        : `<button class="btn btn-secondary btn-sm icon-action-btn" onclick="openUpcomingPostDetailFromItem(cachedData.posts.find(p => p.id === '${esc(post.id)}'))" title="View" aria-label="View subscription">${eyeIcon}</button><button class="btn btn-secondary btn-sm icon-action-btn" onclick="editPost('${esc(post.id)}')" title="Edit" aria-label="Edit subscription">${pencilIcon}</button>`;
      return `<div class="subscription-item">
        <div class="subscription-item-top">
          <div class="subscription-profile">
            ${identityAvatarHtml(identity, '')}
            <div style="min-width:0;">
              <div class="subscription-profile-name">${esc(identityName || identity?.name || 'Facebook profile')}</div>
              <div class="subscription-muted">${esc(isQueued ? 'Queued schedule' : 'Saved subscription')}</div>
            </div>
          </div>
          <div class="subscription-actions-wrap">
            <span class="badge ${statusClass}">${esc(statusLabel)}</span>
            <div class="subscription-actions">${actions}</div>
          </div>
        </div>
        <div style="min-width:0;">
          <div class="subscription-post-preview" title="${esc(preview)}">${esc(preview)}</div>
          ${postMeta ? `<div class="subscription-muted">${esc(postMeta)}</div>` : ''}
        </div>
        <div class="subscription-meta-row">
          <div class="subscription-meta-pill">
            <div class="subscription-meta-label">Groups</div>
            <div class="subscription-meta-value" title="${esc(groupNames.join(', '))}">${esc(groupLabel)}</div>
          </div>
          <div class="subscription-meta-pill">
            <div class="subscription-meta-label">Frequency</div>
            <div class="subscription-meta-value" title="${esc(frequency)}">${esc(frequency)}</div>
          </div>
          <div class="subscription-meta-pill">
            <div class="subscription-meta-label">Next</div>
            <div class="subscription-meta-value" title="${esc(nextLabel)}">${esc(nextLabel)}</div>
          </div>
        </div>
      </div>`;
    }).join('')}</div>
  </div>`;
}

async function loadScheduled() {
  cachedData = await fetchAll();
  const el = document.getElementById('scheduledList');
  if (!el) return;

  const today = startOfLocalDay(new Date());
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(today, i));
  const weekEnd = addDays(today, 7);

  const { data: scheduledJobs } = await sb.from('jsw_post_jobs')
    .select('*')
    .eq('user_id', user.id)
    .eq('status', 'pending')
    .not('scheduled_for', 'is', null)
    .gte('scheduled_for', today.toISOString())
    .lt('scheduled_for', weekEnd.toISOString())
    .order('scheduled_for', { ascending: true });

  const events = scheduledWeekEvents(cachedData.posts || [], scheduledJobs || [], weekDays);
  upcomingPostDetails = Object.fromEntries(events.map(e => [e.id, e]));
  queuedSubscriptionDetails = Object.fromEntries(queuedJobSubscriptionRows(scheduledJobs || []).map(row => [row.id, row]));

  if (!events.length) {
    el.innerHTML = `<div class="upcoming-week-card">
      <div class="upcoming-week-top">
        <div><div class="upcoming-week-title">This week</div><div class="upcoming-week-range">${weekDays[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${weekDays[6].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div></div>
        <button class="btn btn-primary btn-sm" onclick="nav('create')">Schedule a post</button>
      </div>
      <div class="upcoming-empty"><h3>No posts this week</h3><p>Schedule a post and it will show up here by profile picture.</p></div>
    </div>${renderSubscriptionsTable(cachedData.posts || [], scheduledJobs || [])}`;
    return;
  }

  const times = [...new Set(events.map(e => e.time))].sort();
  const eventMap = new Map();
  events.forEach(e => {
    const key = `${e.dateKey}|${e.time}`;
    if (!eventMap.has(key)) eventMap.set(key, []);
    eventMap.get(key).push(e);
  });

  const header = `<div class="week-grid">
    <div class="week-head-cell"></div>
    ${weekDays.map((day, i) => `<div class="week-head-cell ${i === 0 ? 'today' : ''}"><div class="week-day-name">${day.toLocaleDateString('en-US', { weekday: 'short' })}</div><div class="week-day-date">${day.getDate()}</div></div>`).join('')}
  </div>`;

  const rows = times.map(time => `<div class="week-grid">
    <div class="week-time-label">${displayTime(time)}</div>
    ${weekDays.map(day => {
      const items = eventMap.get(`${localDateKey(day)}|${time}`) || [];
      return `<div class="week-cell ${items.length ? 'has-post' : ''}">${items.length ? `<div class="week-avatar-stack">${items.map(upcomingAvatarHtml).join('')}</div>` : ''}</div>`;
    }).join('')}
  </div>`).join('');

  el.innerHTML = `<div class="upcoming-week-card">
    <div class="upcoming-week-top">
      <div><div class="upcoming-week-title">This week</div><div class="upcoming-week-range">${weekDays[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${weekDays[6].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div></div>
      <button class="btn btn-primary btn-sm" onclick="nav('create')">Schedule a post</button>
    </div>
    <div class="week-scroll"><div class="week-calendar">${header}${rows}</div></div>
  </div>${renderSubscriptionsTable(cachedData.posts || [], scheduledJobs || [])}`;
}

function openUpcomingPostDetail(id) {
  const item = upcomingPostDetails?.[id];
  if (!item) return;
  openUpcomingPostDetailFromItem(item);
}

function openUpcomingPostDetailFromItem(item) {
  const modal = document.getElementById('postDetailModal');
  const avatar = document.getElementById('postDetailAvatar');
  const title = document.getElementById('postDetailTitle');
  const meta = document.getElementById('postDetailMeta');
  const text = document.getElementById('postDetailText');
  const image = document.getElementById('postDetailImage');
  const groups = document.getElementById('postDetailGroups');
  const groupList = scheduledEventGroups(item).map(groupDisplayName).filter(Boolean);
  const identity = item.identity || findPostingIdentityByName(item.identityName || scheduledEventIdentityName(item));
  const time = item.time || item.schedule?.time || '09:00';

  if (avatar) avatar.innerHTML = identityAvatarHtml(identity, '');
  if (title) title.textContent = item.identityName || identity?.name || 'Facebook profile';
  if (meta) meta.textContent = `${item.dateLabel || ''} · ${displayTime(time)}${groupList.length ? ` · ${groupList.length} group${groupList.length === 1 ? '' : 's'}` : ''}`;
  if (text) text.textContent = item.text || 'No post text saved.';
  if (image) {
    if (item.imageUrl) {
      image.src = item.imageUrl;
      image.style.display = 'block';
    } else {
      image.removeAttribute('src');
      image.style.display = 'none';
    }
  }
  if (groups) {
    groups.innerHTML = groupList.length ? groupList.slice(0, 12).map((name, i) => `<span class="group-tag"><div class="dot" style="background:${GCOLORS[i % GCOLORS.length]}"></div>${esc(name)}</span>`).join('') : '';
  }
  modal?.classList.add('show');
}

function closePostDetailModal() {
  document.getElementById('postDetailModal')?.classList.remove('show');
}

async function cancelScheduledJob(id) {
  if (!confirm('Cancel this scheduled post?')) return;
  const { error } = await sb.from('jsw_post_jobs').update({ status: 'cancelled' }).eq('id', id).eq('user_id', user.id);
  if (error) return toast('Error: ' + error.message);
  toast('Cancelled');
  loadScheduled();
}

function openQueuedJobDetail(id) {
  const item = queuedSubscriptionDetails?.[id];
  if (!item) return;
  openUpcomingPostDetailFromItem({
    ...item,
    id,
    dateLabel: item.nextDate ? item.nextDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : 'Queued',
    title: `${scheduledEventIdentityName(item) || 'Facebook profile'} · ${(item.groups || []).length || 1} group${((item.groups || []).length || 1) === 1 ? '' : 's'}`
  });
}

async function editQueuedSubscription(id) {
  const item = queuedSubscriptionDetails?.[id];
  if (!item) return;
  const draft = {
    ...item,
    id: `edit-${id}`,
    kind: 'post',
    enabled: true,
    text: scheduledEventText(item),
    imageUrl: scheduledEventImage(item),
    identityName: scheduledEventIdentityName(item),
    groups: scheduledEventGroups(item),
    schedule: {
      ...(item.schedule || {}),
      time: item.schedule?.time || '09:00',
      days: Array.isArray(item.schedule?.days) && item.schedule.days.length ? item.schedule.days : (item.nextDate ? [item.nextDate.getDay()] : [new Date().getDay()]),
    },
    createdAt: new Date().toISOString()
  };
  cachedData.posts = [draft, ...(cachedData.posts || []).filter(p => p.id !== draft.id)];
  await editPost(draft.id);
  toast('Editing queued post — save to create a saved schedule');
}

async function cancelScheduledJobs(idsCsv) {
  const ids = String(idsCsv || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!ids.length) return;
  if (!confirm(`Cancel ${ids.length} queued scheduled post${ids.length === 1 ? '' : 's'}?`)) return;
  const { error } = await sb.from('jsw_post_jobs').update({ status: 'cancelled' }).eq('user_id', user.id).in('id', ids);
  if (error) return toast('Error: ' + error.message);
  toast('Cancelled');
  loadScheduled();
}

// ═══ POSTS CRUD ═══
async function firePost(id) {
  const p = (cachedData.posts || []).find(x => x.id === id);
  if (!p) return;
  if (scheduleLimitReached(p, new Date())) {
    p.enabled = false;
    await sbSet('posts', cachedData.posts || []);
    loadScheduled();
    return toast('This schedule has reached its run limit');
  }
  try {
    await createJob(p);
    p.schedule = p.schedule || {};
    p.schedule.firedCount = (Number(p.schedule.firedCount) || 0) + 1;
    p.schedule.lastManualFiredAt = new Date().toISOString();
    await sbSet('posts', cachedData.posts || []);
    toast('Post sent — Reachr will handle it');
  }
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

  await nav('create');
  if (!(cachedData.posts || []).some(x => x.id === id)) {
    cachedData.posts = [...(cachedData.posts || []), p];
  }

  const savedGroups = scheduledEventGroups(p);
  const identityName = scheduledEventIdentityName(p);
  const identity = findIdentityForGroups(savedGroups) || findPostingIdentityByName(identityName);
  if (identity) setSelectedPostingIdentity(identityKey(identity));

  const textEl = document.getElementById('createText');
  if (textEl) { textEl.value = scheduledEventText(p); textEl.dispatchEvent(new Event('input')); }

  const imgEl = document.getElementById('createImageUrl');
  if (imgEl) { imgEl.value = scheduledEventImage(p); imgEl.dispatchEvent(new Event('input')); }

  const fcEl = document.getElementById('createFirstComment');
  if (fcEl) fcEl.value = p.firstComment || p.first_comment || '';

  const timeEl = document.getElementById('createTime');
  if (timeEl) timeEl.value = p.schedule?.time || '09:00';

  selDays = [...(p.schedule?.days || [])];
  renderDays();
  setDeliveryMode('schedule', false);

  const maxRunsEl = document.getElementById('scheduleMaxRuns');
  if (maxRunsEl) maxRunsEl.value = p.schedule?.maxRuns || '';
  const weeksEl = document.getElementById('scheduleWeeks');
  if (weeksEl) weeksEl.value = '';

  const aiToggle = document.getElementById('aiToggle');
  if (aiToggle) aiToggle.classList.toggle('on', !!(p.aiEnabled ?? p.ai_enabled));

  const groupSearch = document.getElementById('createGroupSearch');
  if (groupSearch) groupSearch.value = '';
  filterGroupsForSelectedIdentity();
  selectCreateGroupsByUrl(savedGroups);

  updateNextFire();
  updateCreateWizardSummary();
  goCreateStep(3, false);

  editingPostId = id;
  toast('Editing subscription — update profile/groups, then save');
}

// ═══ GROUPS ═══
// ─── Group tag state ───
let groupTagFilter = null; // null = all
let groupSearchQuery = '';
let groupSyncPollTimer = null;
let selectedGroupProfileKey = localStorage.getItem('amplr_selected_group_profile') || '__all__';

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
  return Number.isFinite(ts) && Date.now() - ts < HEARTBEAT_STALE_MS;
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
      error: 'Old group import replaced by a new request',
      result: { ...(job.result || {}), stale_cancelled: true, text: 'Old import request cancelled.' },
      completed_at: new Date().toISOString()
    })
    .eq('id', job.id)
    .eq('user_id', user.id);
  if (error) throw new Error(error.message);
  return true;
}

function groupScanDetailHtml(result = {}) {
  const identities = Array.isArray(result.identities) ? result.identities : [];
  if (!identities.length) return '';
  return `<div class="group-scan-detail" style="margin-top:8px;display:grid;gap:4px;">
    ${identities.map(item => {
      const name = item.identity_name || item.identity_key || 'Profile/page';
      const missed = item.status === 'not_scanned' || !!item.error;
      const detail = missed
        ? `${esc(item.reason || 'No group list was available during this pass.')}`
        : `${item.count || 0} group${(item.count || 0) === 1 ? '' : 's'} · ${item.new_count || 0} new`;
      return `<div style="display:flex;justify-content:space-between;gap:12px;border-top:1px solid var(--border);padding-top:4px;">
        <span>${esc(name)}</span>
        <span style="color:${missed ? 'var(--yellow)' : 'var(--text-3)'};text-align:right;">${detail}</span>
      </div>`;
    }).join('')}
  </div>`;
}

function renderGroupSyncStatus(job, groups = cachedData.groups || [], heartbeat = null) {
  const statusEls = [...document.querySelectorAll('.group-sync-status')];
  const btns = [...document.querySelectorAll('.group-sync-btn')];
  if (statusEls.length === 0 && btns.length === 0) return;

  const setStatus = (content, color, html = false) => statusEls.forEach(el => {
    if (html) el.innerHTML = content;
    else el.textContent = content;
    el.style.color = color;
  });
  const setButtons = (text, disabled) => btns.forEach(btn => {
    btn.disabled = disabled;
    btn.textContent = text;
  });

  const active = job && ['pending', 'processing'].includes(job.status);
  const stale = isStaleGroupSyncJob(job);
  const online = isHeartbeatFresh(heartbeat);
  setButtons(active && !stale ? 'Importing...' : stale ? 'Try again' : 'Import groups', active && !stale);

  if (!job) {
    setStatus(groups.length
      ? `Last loaded: ${groups.length} group${groups.length === 1 ? '' : 's'}. Reachr refreshes this daily when Chrome is open.`
      : online
        ? 'No groups added yet. Press Import groups.'
        : 'No groups added yet. Open Reachr in Chrome, sign in, then press Import groups.', online ? 'var(--text-3)' : 'var(--yellow)');
    return;
  }

  const when = job.completed_at || job.started_at || job.created_at;
  const rel = when ? new Date(when).toLocaleString() : '';
  const result = job.result || {};
  if (active) {
    if (stale) {
      setStatus(`Previous import is old${rel ? ' · ' + rel : ''}. Press Try again to replace it. ${online ? '' : 'Reachr in Chrome currently looks offline.'}`.trim(), 'var(--yellow)');
    } else if (!online) {
      setStatus('Waiting. Open Reachr in Chrome and sign in; your groups will import automatically.', 'var(--yellow)');
    } else {
      setStatus(result.text || (job.status === 'pending' ? 'Waiting. Open Reachr in Chrome to continue.' : 'Importing groups...'), 'var(--yellow)');
    }
  } else if (job.status === 'done') {
    const count = result.total_groups ?? result.count ?? groups.length;
    const baseText = result.text || `Last sync imported ${count} group${count === 1 ? '' : 's'}${rel ? ' · ' + rel : ''}.`;
    const suffix = rel ? ` · ${esc(rel)}` : '';
    const detail = groupScanDetailHtml(result);
    setStatus(`<div>${esc(baseText)}${suffix}</div>${detail}`, 'var(--green)', true);
  } else if (job.status === 'failed') {
    setStatus(`Last import failed${rel ? ' · ' + rel : ''}: ${result.error || job.error || 'unknown error'}`, 'var(--red)');
  } else if (job.status === 'cancelled') {
    setStatus(groups.length ? `Last loaded: ${groups.length} group${groups.length === 1 ? '' : 's'}.` : 'No active import request.', 'var(--text-3)');
  } else {
    setStatus(`Last sync status: ${job.status}${rel ? ' · ' + rel : ''}`, 'var(--text-3)');
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
            console.warn('[Reachr] group sync poll failed:', e.message);
          }
        }, 4000);
      }
    }
    if (groupSyncPollTimer && (!job || !['pending', 'processing'].includes(job.status))) {
      clearInterval(groupSyncPollTimer);
      groupSyncPollTimer = null;
    }
    return job;
  } catch (e) {
    const statusEls = [...document.querySelectorAll('.group-sync-status')];
    statusEls.forEach(el => {
      el.textContent = 'Could not check import status: ' + e.message;
      el.style.color = 'var(--red)';
    });
    return null;
  }
}

function groupImportTargets() {
  return sanitizePostingIdentities(cachedData.postingIdentities || []).map(identity => ({
    identity_name: identity.name || null,
    identity_key: identityKey(identity) || null,
    profile_name: identity.name || null,
    profile_key: identityKey(identity) || null,
    page_name: identity.type && /page/i.test(identity.type) ? identity.name : null,
    type: identity.type || 'Facebook profile',
    url: identity.url || null,
    avatar_url: identity.avatar_url || null,
    import_groups: true,
  })).filter(t => t.identity_name || t.url);
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
        if (!automatic) toast('Group import already running');
        return existing;
      }
    }

    if (automatic && !online) {
      renderGroupSyncStatus(null, cachedData.groups || [], heartbeat);
      return null;
    }

    const importTargets = groupImportTargets();
    if (!importTargets.length) {
      await refreshIdentitySyncStatus();
    }
    const refreshedTargets = importTargets.length ? importTargets : groupImportTargets();
    const { error, data } = await sb.from('jsw_post_jobs').insert({
      user_id: user.id,
      message: '__import_groups__',
      groups: refreshedTargets,
      status: 'pending',
      result: { text: online ? `Group import waiting. Reachr will collect joined groups for ${refreshedTargets.length || 'each'} synced profile/page.` : 'Group import waiting. Open Reachr in Chrome and sign in to continue.' },
      delay: 0,
      ai_enabled: false,
      scheduled_for: null,
    }).select('id,status,result,created_at,started_at,completed_at').single();
    if (error) throw new Error(error.message);

    localStorage.setItem(`amplr_last_group_auto_sync_${user.id}`, String(Date.now()));
    renderGroupSyncStatus(data, cachedData.groups || [], heartbeat);
    refreshGroupSyncStatus();
    toast(automatic ? 'Auto-import waiting' : online ? 'Group import waiting' : 'Import waiting — open Reachr in Chrome to continue');
    return data;
  } catch (e) {
    console.error('[Reachr] syncFacebookGroups error:', e);
    if (!automatic) toast('Import error: ' + e.message);
    const statusEls = [...document.querySelectorAll('.group-sync-status')];
    statusEls.forEach(el => {
      el.textContent = 'Import error: ' + e.message;
      el.style.color = 'var(--red)';
    });
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

function isProfileOwnershipTag(tag) {
  return /^profile:/i.test(String(tag || '').trim());
}

function visibleGroupTags(group = {}) {
  return (group.tags || []).filter(t => !isProfileOwnershipTag(t));
}

function renderGroupTagBar(groups) {
  const bar = document.getElementById('groupTagFilterBar');
  if (!bar) return;
  // Collect all unique user-facing tags
  const allTags = [...new Set(groups.flatMap(g => visibleGroupTags(g)))].sort();
  if (allTags.length === 0) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';
  bar.innerHTML = [
    `<span class="tag-filter-pill ${groupTagFilter === null ? 'active' : ''}" data-tag-filter="">All</span>`,
    ...allTags.map(t => `<span class="tag-filter-pill ${groupTagFilter === t ? 'active' : ''}" data-tag-filter="${esc(t)}">${esc(t)}</span>`)
  ].join('');
}

function setGroupTagFilter(tag) {
  groupTagFilter = tag;
  const groups = cachedData.groups || [];
  renderGroupTagBar(groups);
  renderGroupsList(groups);
}

function clearGroupFilters() {
  groupTagFilter = null;
  groupSearchQuery = '';
  const input = document.getElementById('groupSearchInput');
  if (input) input.value = '';
  renderGroupTagBar(cachedData.groups || []);
  renderGroupsList(cachedData.groups || []);
}

function groupCooldownInfo(g) {
  const cooldownDays = cachedData?.settings?.cooldown_days ?? 2;
  if (!g.last_posted_at || cooldownDays <= 0) return null;
  const daysSince = (Date.now() - new Date(g.last_posted_at).getTime()) / (1000 * 60 * 60 * 24);
  if (!Number.isFinite(daysSince) || daysSince >= cooldownDays) return null;
  return { daysSince, daysLeft: Math.max(0, cooldownDays - daysSince) };
}

function groupRiskLevel(g) {
  return ['high', 'medium'].includes(g.ban_risk) ? g.ban_risk : '';
}

function updateGroupsStats(groups = [], filtered = groups) {
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
  const identities = sanitizePostingIdentities(cachedData.postingIdentities || []);
  const activeProfiles = buildGroupProfileBuckets(groups).filter(b => !['__all__'].includes(b.key) && b.groups.length > 0).length;
  set('groupsTotalStat', groups.length);
  set('groupsTaggedStat', identities.length);
  set('groupsCooldownStat', activeProfiles);
  set('groupsRiskStat', groups.filter(g => groupRiskLevel(g)).length);
  const sub = document.getElementById('groupsLibrarySub');
  if (sub) {
    const base = `${filtered.length} of ${groups.length} group${groups.length === 1 ? '' : 's'}`;
    sub.textContent = `${base} organized by ${identities.length || 0} Facebook profile${identities.length === 1 ? '' : 's'}/Pages.`;
  }
}

function safeExternalHref(value) {
  try {
    const u = new URL(value || '');
    return /^https?:$/i.test(u.protocol) ? u.href : '#';
  } catch (_) {
    return '#';
  }
}

function identityProfileTerms(identity = {}) {
  const name = String(identity.name || '').trim().toLowerCase();
  return [name, name.replace(/\s+/g, '-'), name.replace(/\s+/g, '_')].filter(Boolean);
}

function groupOwnerName(group = {}) {
  return String(group.identity_name || group.identityName || group.profile_name || group.profileName || group.page_name || group.pageName || group.joined_as || group.joinedAs || group.member_profile_name || group.memberProfileName || group.collected_by || group.collectedBy || group.imported_by || group.importedBy || '').trim();
}

function groupOwnerKey(group = {}) {
  return String(group.identity_key || group.identityKey || group.profile_key || group.profileKey || group.page_key || group.pageKey || group.joined_as_key || group.joinedAsKey || group.member_profile_key || group.memberProfileKey || group.collected_by_key || group.collectedByKey || group.imported_by_key || group.importedByKey || '').trim();
}

function isLegacyGroupAssignment(group = {}) {
  return groupOwnerKey(group) === '__legacy__';
}

function groupMatchesIdentity(group = {}, identity = {}) {
  if (!identity?.name) return false;
  const identityName = String(identity.name || '').trim().toLowerCase();
  const key = identityKey(identity);
  const owner = groupOwnerName(group).toLowerCase();
  const groupProfileKey = groupOwnerKey(group);
  const tags = (group.tags || []).map(t => String(t).toLowerCase());
  if (groupProfileKey && key && groupProfileKey === key) return true;
  if (owner && owner === identityName) return true;
  return [...identityProfileTerms(identity), `profile:${identityName}`].some(term => tags.includes(term));
}

function postGroupUrlMatches(ref, groupUrl) {
  const raw = typeof ref === 'string' ? ref : (ref?.url || ref?.group_url || '');
  return raw && groupUrl && raw === groupUrl;
}

function postIdentityNamesForGroup(group = {}) {
  const names = new Set();
  const groupUrl = group.url || group.group_url || '';
  (cachedData.posts || []).forEach(post => {
    if (!(post.groups || []).some(ref => postGroupUrlMatches(ref, groupUrl))) return;
    const name = scheduledEventIdentityName(post);
    if (name) names.add(name);
    (post.groups || []).forEach(ref => {
      if (!postGroupUrlMatches(ref, groupUrl)) return;
      const targetName = typeof ref === 'object' ? (ref.identity_name || ref.identityName || ref.profile_name || ref.page_name || '') : '';
      if (targetName) names.add(targetName);
    });
  });
  return [...names];
}

function profileBucketKeyForName(name) {
  return String(name || '').trim().toLowerCase();
}

function groupAssignmentProfileForGroup(group = {}, identities = sanitizePostingIdentities(cachedData.postingIdentities || [])) {
  if (isLegacyGroupAssignment(group)) return null;
  const ownerKey = groupOwnerKey(group);
  const ownerName = groupOwnerName(group).toLowerCase();
  const byKey = ownerKey ? identities.find(identity => identityKey(identity) === ownerKey) : null;
  if (byKey) return byKey;
  const byOwnerName = ownerName ? identities.find(identity => String(identity.name || '').trim().toLowerCase() === ownerName) : null;
  if (byOwnerName) return byOwnerName;
  const tags = (group.tags || []).map(t => String(t).toLowerCase());
  const byTag = identities.find(identity => {
    const name = String(identity.name || '').trim().toLowerCase();
    return name && tags.includes(`profile:${name}`);
  });
  if (byTag) return byTag;
  const scheduledNames = postIdentityNamesForGroup(group);
  for (const name of scheduledNames) {
    const match = identities.find(identity => profileBucketKeyForName(identity.name) === profileBucketKeyForName(name));
    if (match) return match;
  }
  return null;
}

function buildGroupProfileBuckets(groups = []) {
  const identities = sanitizePostingIdentities(cachedData.postingIdentities || []);
  const buckets = new Map();
  const ensure = (key, profile, label = '') => {
    if (!buckets.has(key)) buckets.set(key, { key, profile, label, groups: [] });
    return buckets.get(key);
  };
  const all = ensure('__all__', { name: 'All profiles', type: 'Everything Reachr knows about' }, 'Every group across every profile/page.');
  identities.forEach(identity => ensure(identityKey(identity), identity));

  groups.forEach(group => {
    all.groups.push(group);
    const attached = new Set();
    identities.forEach(identity => {
      if (groupMatchesIdentity(group, identity)) attached.add(identityKey(identity));
    });
    postIdentityNamesForGroup(group).forEach(name => {
      const matched = identities.find(identity => profileBucketKeyForName(identity.name) === profileBucketKeyForName(name));
      if (matched) attached.add(identityKey(matched));
      else if (name) {
        const key = `name:${profileBucketKeyForName(name)}`;
        ensure(key, { name, type: 'Saved schedule profile' });
        attached.add(key);
      }
    });
    if (!attached.size) {
      const ownerName = groupOwnerName(group) || groupOwnerKey(group) || 'Facebook profile';
      const key = groupOwnerKey(group) || `owner:${profileBucketKeyForName(ownerName)}`;
      ensure(key, { name: ownerName, type: 'Saved profile/page owner' });
      attached.add(key);
    }
    attached.forEach(key => ensure(key, buckets.get(key)?.profile || { name: key }).groups.push(group));
  });

  return [...buckets.values()].sort((a, b) => {
    if (a.key === '__all__') return -1;
    if (b.key === '__all__') return 1;
    return (a.profile?.name || '').localeCompare(b.profile?.name || '');
  });
}

function renderGroupCard(g, postCounts, color) {
  const posts = postCounts[g.url] || 0;
  const isPending = g.namePending;
  const groupUrl = g.url || '';
  const safeHref = safeExternalHref(groupUrl);
  const cooldown = groupCooldownInfo(g);
  const risk = groupRiskLevel(g);
  const avatar = g.avatar_url || g.group_avatar_url;
  const badges = [
    isPending ? '<span class="group-status-pill group-status-warn">Fetching name</span>' : '',
    cooldown ? `<span class="group-status-pill group-status-warn" title="Posted ${cooldown.daysSince.toFixed(1)}d ago — rest period active">${cooldown.daysLeft.toFixed(1)}d rest</span>` : '',
    risk ? `<span class="group-status-pill group-status-risk" title="${g.removal_count || 0} post(s) removed">${risk === 'high' ? 'High risk' : 'Med risk'}</span>` : ''
  ].filter(Boolean).join('');

  return `<div class="group-card" data-group-url="${esc(groupUrl)}">
    <div class="group-card-top">
      <div class="group-card-avatar" style="background:${color};">${avatar ? `<img src="${esc(avatar)}" alt="" onerror="this.remove(); this.parentElement.textContent='${esc((g.name || '?')[0].toUpperCase())}';">` : esc((g.name || '?')[0].toUpperCase())}</div>
      <div class="group-card-main">
        <div class="group-card-title" title="${esc(g.name || 'Facebook group')}">${esc(g.name || 'Facebook group')}</div>
        <a class="group-card-url" href="${esc(safeHref)}" target="_blank" rel="noopener noreferrer" title="${esc(groupUrl)}">${esc(groupUrl || 'No URL saved')}</a>
      </div>
    </div>
    <div class="group-card-badges">${badges}</div>
    <div class="group-card-footer">
      <div class="group-card-meta">${posts > 0 ? `${posts} saved post${posts === 1 ? '' : 's'}` : 'No saved posts'}</div>
      <button class="btn btn-ghost btn-sm group-remove-btn group-card-remove" data-group-url="${esc(groupUrl)}" title="Remove group" aria-label="Remove group">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h10M6 4V2.5h4V4M5 6l.5 7h5L11 6"/></svg>
      </button>
    </div>
  </div>`;
}

function selectGroupProfile(key) {
  selectedGroupProfileKey = key || '__all__';
  localStorage.setItem('amplr_selected_group_profile', selectedGroupProfileKey);
  renderGroupsList(cachedData.groups || []);
}

function postFromGroupProfile(key) {
  if (key && key !== '__all__') {
    localStorage.setItem('amplr_selected_posting_identity', key);
  }
  nav('create');
}

function renderGroupsList(groups) {
  const list = document.getElementById('groupsList');
  const empty = document.getElementById('groupsEmpty');
  if (!list) return;
  const countEl = document.getElementById('groupCount');
  if (countEl) countEl.textContent = `(${groups.length})`;

  const filtered = groups;

  const postCounts = {};
  (cachedData.posts || []).forEach(p => {
    (p.groups || []).forEach(g => {
      const url = typeof g === 'string' ? g : g.url;
      if (url) postCounts[url] = (postCounts[url] || 0) + 1;
    });
  });

  updateGroupsStats(groups, filtered);

  if (empty) empty.style.display = groups.length === 0 ? 'block' : 'none';
  if (groups.length === 0) {
    list.innerHTML = '';
    return;
  }

  const colors = ['#5B6FE8','#9B5DE5','#F368A8','#10b981','#f59e0b','#06b6d4'];
  let cardIndex = 0;
  const buckets = buildGroupProfileBuckets(filtered);
  if (!buckets.some(b => b.key === selectedGroupProfileKey)) selectedGroupProfileKey = '__all__';
  const selectedBucket = buckets.find(b => b.key === selectedGroupProfileKey) || buckets[0];

  const rail = `<aside class="groups-profile-rail">
    ${buckets.map(bucket => {
      const profile = bucket.profile || { name: 'Facebook profile' };
      const avatar = bucket.key === '__all__'
        ? '<div class="profile-avatar profile-avatar-sm avatar-fallback">All</div>'
        : identityAvatarHtml(profile, 'profile-avatar-sm');
      return `<button type="button" class="groups-profile-tab ${bucket.key === selectedGroupProfileKey ? 'active' : ''}" data-group-profile-key="${esc(bucket.key)}">
        ${avatar}
        <div class="groups-profile-tab-main">
          <div class="groups-profile-name">${esc(profile.name || 'Facebook profile')}</div>
          <div class="groups-profile-type">${esc(bucket.label || profile.type || 'Facebook profile')}</div>
        </div>
        <div class="groups-profile-count">${bucket.groups.length}</div>
      </button>`;
    }).join('')}
  </aside>`;

  const profile = selectedBucket.profile || { name: 'Facebook profile' };
  const workspaceAvatar = selectedBucket.key === '__all__'
    ? '<div class="profile-avatar avatar-fallback">All</div>'
    : identityAvatarHtml(profile, '');
  const cards = selectedBucket.groups.length
    ? `<div class="groups-card-grid">${selectedBucket.groups.map(g => renderGroupCard(g, postCounts, colors[(cardIndex++) % colors.length])).join('')}</div>`
    : `<div class="groups-empty-profile">No groups found for this profile yet.</div>`;

  list.innerHTML = `${rail}<main class="groups-workspace">
    <div class="groups-workspace-head">
      <div class="groups-workspace-title">
        ${workspaceAvatar}
        <div style="min-width:0;">
          <h3>${esc(profile.name || 'Facebook profile')}</h3>
          <p>${esc(selectedBucket.label || profile.type || 'Facebook profile')} · ${selectedBucket.groups.length} group${selectedBucket.groups.length === 1 ? '' : 's'}</p>
        </div>
      </div>
      <div class="groups-workspace-actions">
        <button class="btn btn-primary btn-sm" data-post-profile-key="${esc(selectedBucket.key)}">${selectedBucket.key === '__all__' ? 'Create post' : 'Post from this profile'}</button>
      </div>
    </div>
    ${cards}
  </main>`;
}

function showTagInput(addBtn) {
  const input = addBtn.nextElementSibling;
  addBtn.style.display = 'none';
  input.style.display = '';
  input.value = '';
  input.focus();
}

function hideTagInput(input) {
  input.style.display = 'none';
  if (input.previousElementSibling) input.previousElementSibling.style.display = '';
}

function handleTagInput(event) {
  if (event.key === 'Enter') {
    const tag = event.target.value.trim().toLowerCase().replace(/[^a-z0-9 _-]/g, '').slice(0, 32);
    if (!tag) { hideTagInput(event.target); return; }
    const url = event.target.dataset.groupUrl;
    const g = (cachedData.groups || []).find(x => x.url === url);
    if (!g) return;
    const newTags = [...new Set([...(g.tags || []), tag])];
    saveGroupTags(url, newTags).then(() => {
      loadGroups();
    });
  } else if (event.key === 'Escape') {
    hideTagInput(event.target);
  }
}

document.addEventListener('click', (event) => {
  const profileTab = event.target.closest?.('[data-group-profile-key]');
  if (profileTab) {
    event.stopPropagation();
    selectGroupProfile(profileTab.dataset.groupProfileKey || '__all__');
    return;
  }
  const postProfileBtn = event.target.closest?.('[data-post-profile-key]');
  if (postProfileBtn) {
    event.stopPropagation();
    postFromGroupProfile(postProfileBtn.dataset.postProfileKey || '__all__');
    return;
  }
  const removeBtn = event.target.closest?.('.group-remove-btn[data-group-url]');
  if (removeBtn) {
    event.stopPropagation();
    removeGroup(removeBtn.dataset.groupUrl);
  }
});

function groupUpdatePayloadForIdentity(identity) {
  if (!identity) throw new Error('Choose a Facebook profile/page for this group.');
  const key = identityKey(identity) || null;
  return {
    identity_name: identity.name || null,
    identity_key: key,
    profile_name: identity.name || null,
    profile_key: key,
    page_name: identity.type && /page/i.test(identity.type) ? identity.name : null,
  };
}

async function assignGroupToProfile(url, profileKey) {
  const group = (cachedData.groups || []).find(x => x.url === url);
  if (!group) return;
  if (!user?.id) {
    toast('Sign in before assigning groups.');
    renderGroupsList(cachedData.groups || []);
    return;
  }
  const identities = sanitizePostingIdentities(cachedData.postingIdentities || []);
  const identity = profileKey ? identities.find(i => identityKey(i) === profileKey) : null;
  if (!identity) {
    toast('Choose a Facebook profile/page for this group.');
    renderGroupsList(cachedData.groups || []);
    return;
  }
  const payload = groupUpdatePayloadForIdentity(identity);
  try {
    let res = await sb.from('jsw_groups').update(payload).eq('user_id', user.id).eq('group_url', url);
    if (res.error && /identity_name|identity_key|profile_name|profile_key|page_name|schema cache|column/i.test(res.error.message || '')) {
      const tags = new Set(group.tags || []);
      [...tags].filter(t => /^profile:/i.test(t)).forEach(t => tags.delete(t));
      if (identity?.name) tags.add(`profile:${identity.name}`);
      res = await sb.from('jsw_groups').update({ tags: [...tags] }).eq('user_id', user.id).eq('group_url', url);
      group.tags = [...tags];
    }
    if (res.error) throw new Error(res.error.message);
    Object.assign(group, payload);
    selectedGroupProfileKey = profileKey;
    localStorage.setItem('amplr_selected_group_profile', selectedGroupProfileKey);
    renderGroupTagBar(cachedData.groups || []);
    renderGroupsList(cachedData.groups || []);
    toast(`Assigned to ${identity.name}`);
  } catch (e) {
    console.error('[Reachr] assignGroupToProfile error:', e);
    toast('Could not assign profile: ' + e.message);
    renderGroupsList(cachedData.groups || []);
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
  if (e.target.id === 'groupSearchInput') {
    groupSearchQuery = e.target.value || '';
    renderGroupsList(cachedData.groups || []);
    return;
  }
  if (e.target.id === 'groupUrlInput') {
    const url = e.target.value.trim();
    const hint = document.getElementById('groupAutoName');
    if (!hint) return;
    const name = extractGroupName(normalizeFacebookGroupUrl(url) || url);
    if (name) {
      hint.style.display = 'flex';
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
      const name = extractGroupName(normalizeFacebookGroupUrl(url) || url);
      if (name) {
        hint.style.display = 'flex';
        hint.querySelector('strong').textContent = name;
      }
    }, 0);
  }
});

function normalizeFacebookGroupUrl(input) {
  let value = (input || '').trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) {
    value = value.replace(/^@+/, '').replace(/^\/+|\/+$/g, '');
    if (/^facebook\.com\/groups\//i.test(value) || /^www\.facebook\.com\/groups\//i.test(value)) value = 'https://' + value;
    else value = 'https://www.facebook.com/groups/' + value;
  }
  try {
    const u = new URL(value);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (!['facebook.com', 'fb.com', 'm.facebook.com'].includes(host)) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    const groupIndex = parts.findIndex(p => p.toLowerCase() === 'groups');
    const slug = groupIndex >= 0 ? parts[groupIndex + 1] : null;
    if (!slug || /^(feed|discover|joins|create)$/i.test(slug)) return null;
    return `https://www.facebook.com/groups/${encodeURIComponent(decodeURIComponent(slug))}`;
  } catch (_) {
    return null;
  }
}

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
    let url = normalizeFacebookGroupUrl(input.value);
    if (!url) return toast('Paste a valid Facebook group URL');

    // Check for duplicates
    const groups = cachedData.groups || [];
    if (groups.some(g => g.url === url)) return toast('Already added');

    // Auto-detect name
    let name = extractGroupName(url);
    if (!name) name = url.split('/').filter(Boolean).pop() || url;

    const selectedIdentity = selectedGroupProfileKey && selectedGroupProfileKey !== '__all__'
      ? sanitizePostingIdentities(cachedData.postingIdentities || []).find(identity => identityKey(identity) === selectedGroupProfileKey)
      : getSelectedPostingIdentity();
    const ownership = groupUpdatePayloadForIdentity(selectedIdentity);

    // Write directly to jsw_groups (shared with extension)
    const { error: insertErr } = await sb.from('jsw_groups').insert({
      user_id: user.id,
      group_url: url,
      group_name: name || null,
      ...ownership,
    });
    if (insertErr) throw new Error(insertErr.message);

    input.value = '';
    const hint = document.getElementById('groupAutoName');
    if (hint) hint.style.display = 'none';
    toast('Group added');
    loadGroups();
  } catch (e) {
    console.error('[Reachr] addGroup error:', e);
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
    console.error('[Reachr] removeGroup error:', e);
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
  if (!el) return;
  const entries = normalizeHistoryEntries(cachedData.logs || [], jobs || []);
  renderHistory(entries);
}

function normalizeHistoryEntries(logs = [], jobs = []) {
  const entries = [];
  (jobs || []).forEach(j => {
    const result = j.result || {};
    if (j.message === '__import_groups__') {
      const identities = Array.isArray(result.identities) ? result.identities : [];
      entries.push({
        type: 'system',
        timestamp: j.completed_at || j.updated_at || j.created_at,
        title: 'Facebook group scan',
        preview: identities.length ? `${identities.length} profile/page${identities.length === 1 ? '' : 's'} checked` : (j.error || result.error || 'Group import job'),
        status: j.status || 'unknown',
        error: j.status === 'failed' ? (j.error || result.error) : '',
        results: identities.map(item => ({
          group: item.identity_name || item.identity_key || 'Profile/page',
          success: item.status !== 'not_scanned' && !item.error && j.status === 'done',
          failed: item.status === 'not_scanned' || !!item.error || j.status === 'failed',
          error: item.reason || (item.error ? 'No group list was available during this pass.' : ''),
        })),
      });
      return;
    }
    if (isSystemJob(j)) return;
    const status = j.status || 'unknown';
    const groups = Array.isArray(j.groups) ? j.groups : [];
    const success = status === 'done';
    const failed = status === 'failed';
    entries.push({
      type: 'post',
      timestamp: j.completed_at || j.updated_at || j.started_at || j.created_at,
      title: status === 'pending' ? 'Queued post' : status === 'processing' ? 'Posting in progress' : 'Post run',
      preview: scheduledEventText(j).replace(/\s+/g, ' ').trim() || 'No message text saved',
      status,
      error: j.error || '',
      results: groups.map(g => ({ group: groupDisplayName(g), success, failed, error: j.error })),
    });
  });

  (logs || []).forEach(l => entries.push({
    type: 'post',
    timestamp: l.timestamp || l.createdAt || new Date().toISOString(),
    title: l.title || 'Legacy post run',
    preview: l.postPreview || l.text || '',
    status: l.status || '',
    error: l.error || '',
    results: Array.isArray(l.results) ? l.results : [],
  }));

  return entries.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
}

function historyCounts(entries) {
  return entries.reduce((acc, entry) => {
    const results = entry.results || [];
    const ok = results.filter(r => r.success).length;
    const fail = results.filter(r => r.failed || (!r.success && entry.status === 'failed')).length;
    if (entry.type === 'post') acc.posts += 1;
    if (entry.type === 'system') acc.system += 1;
    if (fail > 0 || entry.status === 'failed') acc.failed += 1;
    if (ok > 0 && fail === 0) acc.success += 1;
    return acc;
  }, { posts: 0, system: 0, failed: 0, success: 0 });
}

function setHistoryFilter(filter) {
  historyFilter = filter;
  loadLogs();
}

function historyEntryState(entry) {
  const results = entry.results || [];
  const ok = results.filter(r => r.success).length;
  const fail = results.filter(r => r.failed || (!r.success && entry.status === 'failed')).length;
  const total = results.length;
  const status = entry.status || (ok > 0 ? 'done' : 'unknown');
  const pending = ['pending', 'queued', 'processing'].includes(status);
  const iconClass = pending ? 'pending' : fail && ok ? 'mix' : fail || status === 'failed' || status === 'cancelled' ? 'fail' : ok || status === 'done' ? 'ok' : 'mix';
  const icon = entry.type === 'system' ? 'SYS' : pending ? '...' : fail && ok ? 'MIX' : fail || status === 'failed' ? 'FAIL' : 'OK';
  return { ok, fail, total, status, iconClass, icon };
}

function renderHistory(entries) {
  const el = document.getElementById('logsList');
  const counts = historyCounts(entries);
  const filtered = entries.filter(e => {
    if (historyFilter === 'posts') return e.type === 'post';
    if (historyFilter === 'failed') return historyEntryState(e).fail > 0 || e.status === 'failed';
    if (historyFilter === 'system') return e.type === 'system';
    return true;
  });
  const tabs = [
    ['posts', `Posts (${counts.posts})`],
    ['failed', `Failures (${counts.failed})`],
    ['system', `System (${counts.system})`],
    ['all', `All (${entries.length})`],
  ];
  const listHtml = filtered.length ? `<div class="history-list">${filtered.map(historyItemHtml).join('')}</div>` : `<div class="history-empty"><h3>No matching history</h3><p>Try another filter or post something new.</p></div>`;
  el.innerHTML = `<div class="history-shell">
    <div class="history-summary">
      <div class="history-stat"><strong>${counts.posts}</strong><span>post runs</span></div>
      <div class="history-stat"><strong>${counts.success}</strong><span>clean runs</span></div>
      <div class="history-stat"><strong>${counts.failed}</strong><span>needs attention</span></div>
      <div class="history-stat"><strong>${counts.system}</strong><span>helper jobs</span></div>
    </div>
    <div class="history-toolbar">
      <div class="history-tabs">${tabs.map(([key, label]) => `<button class="history-tab ${historyFilter === key ? 'active' : ''}" onclick="setHistoryFilter('${key}')">${esc(label)}</button>`).join('')}</div>
      <div class="history-actions"><button class="btn btn-secondary btn-sm" onclick="exportLogs()">Export CSV</button><button class="btn btn-danger btn-sm" onclick="clearLogs()">Clear local logs</button></div>
    </div>
    ${listHtml}
  </div>`;
}

function historyItemHtml(entry) {
  const state = historyEntryState(entry);
  const results = entry.results || [];
  const visibleResults = results.slice(0, 8);
  const statusLabel = entry.status === 'done' ? 'complete' : entry.status || 'unknown';
  const groupHtml = visibleResults.length ? visibleResults.map(r => {
    const cls = r.success ? 'ok' : r.failed ? 'fail' : 'warn';
    const label = `${r.success ? 'OK' : r.failed ? 'FAIL' : 'WAIT'} ${r.group || 'Group'}${r.error ? ` — ${String(r.error).slice(0, 90)}` : ''}`;
    return `<span class="history-group-pill ${cls}" title="${esc(label)}">${esc(label)}</span>`;
  }).join('') + (results.length > visibleResults.length ? `<span class="history-group-pill">+${results.length - visibleResults.length} more</span>` : '') : `<span class="history-group-pill warn">No group-level result yet</span>`;
  return `<div class="history-item">
    <div class="history-icon ${state.iconClass}">${state.icon}</div>
    <div class="history-main">
      <div class="history-title-row"><div class="history-title">${esc(entry.title || (entry.type === 'system' ? 'Helper activity' : 'Post run'))}</div><span class="badge ${state.iconClass === 'fail' ? 'badge-off' : state.iconClass === 'ok' ? 'badge-green' : 'badge-yellow'}">${esc(statusLabel)}</span><span class="history-time">${entry.timestamp ? new Date(entry.timestamp).toLocaleString() : 'No time'}</span></div>
      <div class="history-preview">${esc(entry.error || entry.preview || 'No details saved')}</div>
      <div class="history-groups">${groupHtml}</div>
    </div>
    <div class="history-side"><div class="history-score">${state.total ? `${state.ok}/${state.total}` : '—'}</div><div class="history-score-label">succeeded</div></div>
  </div>`;
}

async function clearLogs() {
  if (!confirm('Clear all logs?')) return;
  try {
    cachedData.logs = [];
    await sbSet('logs', []);
    loadLogs();
    toast('Activity cleared');
  } catch (e) {
    toast('Error: ' + e.message);
  }
}

async function exportLogs() {
  const logs = cachedData.logs || [];

  // Include both legacy dashboard logs and recent extension job history.
  const { data: jobs } = await sb.from('jsw_post_jobs')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(50);

  if (logs.length === 0 && (!jobs || jobs.length === 0)) return toast('No activity to export');

  const rows = [['Timestamp', 'Source', 'Preview', 'Group', 'Success', 'Error']];
  logs.forEach(l => {
    (l.results || []).forEach(r => {
      rows.push([l.timestamp, 'legacy', l.postPreview || '', r.group || '', r.success ? 'YES' : 'NO', r.error || '']);
    });
  });
  (jobs || []).filter(j => !isSystemJob(j)).forEach(j => {
    const refs = Array.isArray(j.groups) && j.groups.length ? j.groups : [''];
    refs.forEach(ref => {
      rows.push([
        j.completed_at || j.started_at || j.created_at || '',
        'extension',
        j.message || '',
        groupDisplayName(ref),
        j.status === 'done' ? 'YES' : (j.status === 'failed' ? 'NO' : j.status || ''),
        j.error || ''
      ]);
    });
  });

  const csv = rows.map(r => r.map(c => `"${(c || '').toString().replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Reachr-logs-${new Date().toISOString().split('T')[0]}.csv`;
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
  if (aiKeyEl) aiKeyEl.value = '';
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
    delay: Math.max(parseInt(document.getElementById('setDelay').value) || 90, 90),
    maxGroups: parseInt(document.getElementById('setMaxGroups').value) || 10,
    jitter: parseInt(document.getElementById('setJitter').value) || 5,
    cooldown_days: parseInt(document.getElementById('setCooldown')?.value ?? 2),
    ai_enabled: aiEnabled,
    ai_provider: aiProvider,
    ai_model: aiModel,
    ai_prompt: aiPrompt,
  };
  delete settings.ai_key;
  cachedData.settings = settings;
  await sbSet('settings', settings);

  // Also update jsw_settings so the extension can read ai_key, ai_provider, ai_model, ai_prompt
  try {
    const jswSettings = {
      user_id: user.id,
      ai_provider: aiProvider,
      ai_model: aiModel,
      ai_prompt: aiPrompt || null,
      ai_enabled: aiEnabled,
    };
    if (aiKey) jswSettings.ai_key = aiKey;
    await sb.from('jsw_settings').upsert(jswSettings, { onConflict: 'user_id' });
  } catch (e) {
    console.warn('[Reachr] jsw_settings upsert failed:', e.message);
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
  const typed = prompt('This clears dashboard settings and legacy schedules only. Type RESET to continue:');
  if (typed !== 'RESET') return;
  await sb.from('amplr_data').delete().eq('user_id', user.id);
  toast('Dashboard data reset');
  location.reload();
}

// ═══ SCHEDULE CHECKER ═══
// Checks every 60s if any scheduled post should fire.
// Creates a job in jsw_post_jobs when it's time.
function localScheduleFireKey(post, scheduledAt) {
  const yyyy = scheduledAt.getFullYear();
  const mm = String(scheduledAt.getMonth() + 1).padStart(2, '0');
  const dd = String(scheduledAt.getDate()).padStart(2, '0');
  const hh = String(scheduledAt.getHours()).padStart(2, '0');
  const mi = String(scheduledAt.getMinutes()).padStart(2, '0');
  return `${post.id}:${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function scheduledFireDue(post, now = new Date()) {
  const days = Array.isArray(post.schedule?.days) ? post.schedule.days : [];
  const time = normalizeTimeValue(post.schedule?.time || '');
  if (!days.length || !time || !days.includes(now.getDay())) return null;
  const [hh, mm] = time.split(':').map(Number);
  const scheduledAt = new Date(now);
  scheduledAt.setHours(hh, mm, 0, 0);
  const delta = now.getTime() - scheduledAt.getTime();
  if (delta < 0 || delta > SCHEDULE_FIRE_WINDOW_MS) return null;
  const fireKey = localScheduleFireKey(post, scheduledAt);
  if (post.schedule.lastFiredKey === fireKey) return null;
  return { scheduledAt, fireKey };
}

function startScheduleChecker() {
  if (schedChecker) clearInterval(schedChecker);
  schedChecker = setInterval(async () => {
    if (!user || schedulerBusy) return;
    schedulerBusy = true;
    try {
      const posts = await sbGet('posts') || [];
      const now = new Date();
      let changed = false;
      for (const post of posts) {
        if (!post.enabled) continue;
        if (!post.schedule || !Array.isArray(post.schedule.days) || !post.schedule.time) continue;
        if (scheduleLimitReached(post, now)) {
          post.enabled = false;
          changed = true;
          continue;
        }
        const due = scheduledFireDue(post, now);
        if (!due) continue;
        try {
          await createJob(post);
          post.schedule.lastFiredKey = due.fireKey;
          post.schedule.lastFiredAt = now.toISOString();
          post.schedule.firedCount = (Number(post.schedule.firedCount) || 0) + 1;
          if (scheduleLimitReached(post, now)) post.enabled = false;
          changed = true;
          console.log('[Reachr] Fired scheduled post:', post.id);
        } catch (e) {
          console.warn('[Reachr] Schedule fire failed:', e.message);
        }
      }
      if (changed) {
        cachedData.posts = posts;
        await sbSet('posts', posts);
      }
    } finally {
      schedulerBusy = false;
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

function parsePositiveInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function scheduleLimitReached(post, now = new Date()) {
  const schedule = post.schedule || {};
  const maxRuns = Number(schedule.maxRuns) || 0;
  const firedCount = Number(schedule.firedCount) || 0;
  if (maxRuns && firedCount >= maxRuns) return true;
  if (schedule.endsAt && now > new Date(schedule.endsAt)) return true;
  return false;
}

// ─── AI toggle (Create Post panel) ───
function toggleAI() {
  const toggle = document.getElementById('aiToggle');
  if (!toggle) return;
  toggle.classList.toggle('on');
  updateCreateWizardSummary();
}

// ─── AI toggle (Settings page) ───
function toggleSettingsAI() {
  const toggle = document.getElementById('setAiEnabled');
  if (toggle) toggle.classList.toggle('on');
}

// ─── Create page helpers ───

function initCreateWizard() {
  setCreateContentType(createContentType || 'standard', false);
  setDeliveryMode(createDeliveryMode || 'now', false);
  goCreateStep(createWizardStep || 1, false);
  renderCreateProfileCards();
  filterGroupsForSelectedIdentity();
  updateSelectedCount();
  updateCreateWizardSummary();
}

function clearCreateForm() {
  editingPostId = null;
  const ta = document.getElementById('createText');
  if (ta) { ta.value = ''; ta.dispatchEvent(new Event('input')); }
  const imgInput = document.getElementById('createImageUrl');
  if (imgInput) imgInput.value = '';
  clearCreateImage();
  const fcInput = document.getElementById('createFirstComment');
  if (fcInput) fcInput.value = '';
  const maxRuns = document.getElementById('scheduleMaxRuns');
  if (maxRuns) maxRuns.value = '';
  const weeks = document.getElementById('scheduleWeeks');
  if (weeks) weeks.value = '';
  const spin = document.getElementById('spinInfo');
  if (spin) spin.style.display = 'none';
  document.querySelectorAll('#createGroupSelect .group-chip.selected').forEach(c => c.classList.remove('selected'));
  localStorage.removeItem('amplr_draft');
  goCreateStep(1, false);
  updateSelectedCount();
  updateCreateWizardSummary();
}

function restoreDraft() {
  const draft = localStorage.getItem('amplr_draft');
  const ta = document.getElementById('createText');
  if (draft && ta && !ta.value.trim()) {
    ta.value = draft;
    ta.dispatchEvent(new Event('input'));
  }
}

function validateCreateStep(step) {
  const text = document.getElementById('createText')?.value.trim() || '';
  const identity = getSelectedPostingIdentity();
  if (step >= 2 && !identity) { toast('Choose what page/profile is posting first'); return false; }
  if (step >= 3 && !text) { toast('Write the post content first'); return false; }
  return true;
}

function goCreateStep(step, validate=true) {
  step = Math.max(1, Math.min(4, Number(step) || 1));
  if (validate && !validateCreateStep(step)) return;
  createWizardStep = step;
  document.querySelectorAll('.cp-pane').forEach(p => p.classList.toggle('active', Number(p.dataset.pane) === step));
  document.querySelectorAll('.cp-step').forEach(el => {
    const n = Number(el.dataset.step);
    el.classList.toggle('active', n === step);
    el.classList.toggle('done', n < step);
  });
  document.querySelector('#page-create .cp-shell')?.classList.toggle('cp-profile-focus', step === 1);
  const back = document.getElementById('cpBackBtn');
  const next = document.getElementById('cpNextBtn');
  if (back) back.style.visibility = step === 1 ? 'hidden' : 'visible';
  if (next) next.textContent = step === 4 ? (createDeliveryMode === 'schedule' ? 'Save schedule' : 'Queue post') : (step === 1 ? 'Continue to post' : 'Continue');
  updateCreateWizardSummary();
}

function nextCreateStep() {
  if (createWizardStep < 4) return goCreateStep(createWizardStep + 1);
  if (createDeliveryMode === 'schedule') return savePost();
  return postNow();
}

function prevCreateStep() { goCreateStep(createWizardStep - 1, false); }

function setCreateContentType(type, persist=true) {
  createContentType = type || 'standard';
  if (persist) localStorage.setItem('amplr_create_content_type', createContentType);
  document.querySelectorAll('[data-content-type]').forEach(el => el.classList.toggle('active', el.dataset.contentType === createContentType));
  updateCreateWizardSummary();
}

function setDeliveryMode(mode, update=true) {
  createDeliveryMode = mode === 'schedule' ? 'schedule' : 'now';
  document.querySelectorAll('[data-delivery]').forEach(el => el.classList.toggle('active', el.dataset.delivery === createDeliveryMode));
  const panel = document.getElementById('schedulePanel');
  if (panel) panel.classList.toggle('active', createDeliveryMode === 'schedule');
  const primary = document.getElementById('cpPrimaryAction');
  const sched = document.getElementById('cpScheduleAction');
  if (primary) {
    primary.style.display = createDeliveryMode === 'now' ? 'flex' : 'none';
    primary.textContent = 'Queue one-time post';
  }
  if (sched) sched.style.display = createDeliveryMode === 'schedule' ? 'flex' : 'none';
  if (update) updateCreateWizardSummary();
  goCreateStep(createWizardStep, false);
}

function renderCreateProfileCards() {
  const el = document.getElementById('createProfileCards');
  if (!el) return;
  const identities = cachedData.postingIdentities || [];
  const selected = getSelectedPostingIdentity();
  if (!identities.length) {
    el.innerHTML = '<div class="cp-empty-groups" style="grid-column:1/-1;">No Facebook profiles added yet.</div>';
    return;
  }
  el.innerHTML = identities.map(identity => {
    const key = esc(identityKey(identity));
    const active = selected && identityKey(selected) === identityKey(identity);
    const avatar = identityAvatarHtml(identity, 'cp-profile-avatar');
    return `<div class="cp-profile-card ${active ? 'active' : ''}" data-identity-key="${key}" onclick="selectPostingIdentityAndContinue(this.dataset.identityKey)">
      ${avatar}
      <div style="font-size:14px;font-weight:800;margin-bottom:3px;">${esc(identity.name || 'Unnamed profile')}</div>
      <div style="font-size:12px;color:var(--text-3);">${esc(identity.type || 'Facebook profile')}${identity.is_active ? ' · active' : ''}</div>
    </div>`;
  }).join('');
}

function selectedProfileGroupTags() {
  const identity = getSelectedPostingIdentity();
  const name = (identity?.name || '').toLowerCase();
  if (!name) return [];
  return [name, name.replace(/\s+/g, '-'), name.replace(/\s+/g, '_')];
}

function groupBelongsToSelectedProfile(group) {
  const identity = getSelectedPostingIdentity();
  const profileTags = selectedProfileGroupTags();
  if (!identity || !profileTags.length) return false;
  const tags = (group.tags || []).map(t => String(t).toLowerCase());
  const owner = String(group.identity_name || group.identityName || group.profile_name || group.profileName || group.page_name || group.pageName || '').toLowerCase().trim();
  const groupProfileKey = String(group.identity_key || group.identityKey || group.profile_key || group.profileKey || '').trim();
  if (groupProfileKey && groupProfileKey === identityKey(identity)) return true;
  if (owner && profileTags.includes(owner)) return true;
  return tags.some(t => profileTags.includes(t));
}

function filterGroupsForSelectedIdentity() {
  const search = (document.getElementById('createGroupSearch')?.value || '').toLowerCase().trim();
  const groups = cachedData.groups || [];
  const shown = groups.filter(g => groupBelongsToSelectedProfile(g)).filter(g => !search || (g.name || '').toLowerCase().includes(search) || (g.url || '').toLowerCase().includes(search));
  document.querySelectorAll('#createGroupSelect .group-chip').forEach(chip => {
    const g = groups.find(x => x.url === chip.dataset.url);
    chip.style.display = g && shown.some(x => x.url === g.url) ? '' : 'none';
  });
  const noGroups = document.getElementById('createNoGroups');
  if (noGroups) {
    const identity = getSelectedPostingIdentity();
    noGroups.style.display = shown.length ? 'none' : 'block';
    noGroups.innerHTML = identity
      ? `No groups tied to ${esc(identity.name)} yet.`
      : 'Choose a profile first.';
  }
  const hint = document.getElementById('createGroupScopeHint');
  if (hint) hint.textContent = '';
}

function selectAllGroups() {
  document.querySelectorAll('#createGroupSelect .group-chip').forEach(c => { if (c.style.display !== 'none') c.classList.add('selected'); });
  updateSelectedCount();
  updateCreateWizardSummary();
}

function deselectAllGroups() {
  document.querySelectorAll('#createGroupSelect .group-chip').forEach(c => c.classList.remove('selected'));
  updateSelectedCount();
  updateCreateWizardSummary();
}

function updateSelectedCount() {
  const selected = document.querySelectorAll('#createGroupSelect .group-chip.selected').length;
  const visibleSelected = [...document.querySelectorAll('#createGroupSelect .group-chip.selected')].filter(c => c.style.display !== 'none').length;
  const el = document.getElementById('selectedGroupCount');
  if (el) el.textContent = selected === visibleSelected
    ? `${selected} group${selected === 1 ? '' : 's'} selected`
    : `${selected} group${selected === 1 ? '' : 's'} selected (${visibleSelected} visible)`;
  updateCreateWizardSummary();
}

function updateCreateWizardSummary() {
  const identity = getSelectedPostingIdentity();
  const groupCount = document.querySelectorAll('#createGroupSelect .group-chip.selected').length;
  const maxRuns = parsePositiveInt(document.getElementById('scheduleMaxRuns')?.value);
  const weeks = parsePositiveInt(document.getElementById('scheduleWeeks')?.value);
  const limitText = [maxRuns ? `${maxRuns}x` : '', weeks ? `${weeks}w` : ''].filter(Boolean).join(' / ');
  const delivery = createDeliveryMode === 'schedule' ? `Schedule · ${document.getElementById('createTime')?.value || '09:00'}${limitText ? ' · ' + limitText : ''}` : 'One-time post';
  const aiOn = document.getElementById('aiToggle')?.classList.contains('on');
  setText('createSummaryProfile', identity?.name || 'No profile selected');
  setText('createSummaryGroups', `${groupCount} selected`);
  setText('createSummaryDelivery', delivery);
  setText('createSummaryAI', aiOn ? 'AI paraphrasing on' : 'AI paraphrasing off');
}

// Update count when chips are toggled, even when clicking inside a chip
// rather than directly on the chip element.
document.addEventListener('click', (e) => {
  if (e.target.closest?.('#createGroupSelect .group-chip')) {
    setTimeout(() => { updateSelectedCount(); updateCreateWizardSummary(); }, 0);
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
