// Paired dashboards renew through the extension; they never rotate its token.
(() => {
  const STORAGE_KEY = 'reachr_session_owner_v1';
  const AUTH_KEY = 'sb-xacehhtgvubcqdoltazg-auth-token';
  const nativeFetch = window.fetch.bind(window);
  const pending = new Map();
  let bridgeSeen = false;
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = event.data;
    if (message?.source !== 'amplr-dashboard-bridge') return;
    if (message.type === 'SESSION_OWNER_READY') bridgeSeen = true;
    const request = pending.get(message.requestId);
    if (request) { bridgeSeen = true; request(message); }
  });
  function cachedSession() {
    try {
      const value = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
      return value?.currentSession || value?.session || value;
    } catch (_) { return null; }
  }
  function wasPaired(userId) {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')?.userId === userId; }
    catch (_) { return false; }
  }
  function askOwner(userId) {
    const requestId = crypto.randomUUID();
    return new Promise(resolve => {
      let timer;
      const finish = response => { clearTimeout(timer); pending.delete(requestId); resolve(response); };
      pending.set(requestId, finish);
      const send = () => window.postMessage({ source: 'amplr-dashboard-page', type: 'RENEW_DASHBOARD_SESSION', requestId, userId }, window.location.origin);
      // The SDK can initialize before the document-idle content script arrives.
      timer = setTimeout(() => finish(null), 15000);
      send();
      const retry = setInterval(() => { if (pending.has(requestId)) send(); else clearInterval(retry); }, 500);
    });
  }
  window.reachrAuthFetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, window.location.href);
    if (url.origin !== 'https://xacehhtgvubcqdoltazg.supabase.co' || url.pathname !== '/auth/v1/token' || url.searchParams.get('grant_type') !== 'refresh_token') return nativeFetch(input, init);
    const cached = cachedSession();
    const userId = cached?.user?.id;
    // No cached identity is never permission to share an extension session.
    if (!userId) return nativeFetch(input, init);
    const response = await askOwner(userId);
    if (response?.ok && response.credentials?.userId === userId) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId }));
      const c = response.credentials;
      return new Response(JSON.stringify({ access_token: c.accessToken, refresh_token: c.refreshToken,
        expires_at: c.expiresAt, expires_in: Math.max(1, c.expiresAt - Math.floor(Date.now() / 1000)),
        token_type: 'bearer', user: cached.user }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (response?.reason === 'account_mismatch' || response?.reason === 'unpaired' && !wasPaired(userId)) {
      return nativeFetch(input, init);
    }
    if (!response && !bridgeSeen && !wasPaired(userId)) return nativeFetch(input, init);
    // A retryable response keeps the SDK's saved session through an outage.
    return new Response(JSON.stringify({ code: 'reachr_session_reconnecting', message: 'Reachr is reconnecting. Your saved login has been retained.' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  };
  window.reachrForgetSessionOwner = () => localStorage.removeItem(STORAGE_KEY);
})();
