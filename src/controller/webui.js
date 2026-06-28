import { Router } from 'express';

export function createWebUiRouter({ auth, browser, notes, repository }) {
  const router = Router();
  const gate = auth.requireTokenWhenStarted.bind(auth);

  router.get('/', (_req, res) => {
    res.type('html').send(html());
  });

  router.get('/api/state', async (req, res) => {
    const state = await repository.getState();
    const authorized = await auth.validateToken(auth.extractToken(req));
    res.json({
      started: Boolean(state.started),
      hasToken: Boolean(state.tokenHash),
      authorized
    });
  });

  router.post('/api/setup/generate', async (_req, res) => {
    const state = await repository.getState();
    if (state.started) return res.status(409).json({ error: 'already started' });
    const token = await auth.issueToken();
    auth.setCookie(res, token);
    res.json({ token });
  });

  router.post('/api/session', async (req, res) => {
    const token = auth.extractToken(req);
    if (!(await auth.validateToken(token))) return res.status(401).json({ error: 'invalid token' });
    auth.setCookie(res, token);
    res.json({ ok: true });
  });

  router.post('/api/setup/start', async (req, res) => {
    const token = auth.extractToken(req);
    if (!(await auth.start(token))) return res.status(401).json({ error: 'valid token required' });
    auth.setCookie(res, token);
    await notes.start();
    res.json({ started: true });
  });

  router.get('/api/status', gate, async (_req, res) => {
    const state = await repository.getState();
    const browserStatus = await browser.status().catch(error => ({ error: error.message }));
    const localNotes = await repository.listNotes({ limit: 10 });
    res.json({ state: { started: Boolean(state.started) }, browser: browserStatus, notes: localNotes.length });
  });

  router.post('/api/browser/open', gate, async (_req, res) => {
    res.json(await browser.openNotes());
  });

  router.get('/api/browser/screenshot', gate, async (_req, res) => {
    const image = await browser.screenshot();
    res.type('jpg').send(image);
  });

  router.post('/api/browser/click', gate, async (req, res) => {
    await browser.click(req.body);
    res.json({ ok: true });
  });

  router.post('/api/browser/type', gate, async (req, res) => {
    await browser.type(req.body.text || '');
    res.json({ ok: true });
  });

  router.post('/api/browser/key', gate, async (req, res) => {
    await browser.press(req.body.key || 'Enter');
    res.json({ ok: true });
  });

  router.post('/api/sync', gate, async (_req, res) => {
    res.json(await notes.sync());
  });

  return router;
}

function html() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Apple MCP Calnot</title>
  <style>
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f7f8; color: #171717; }
    header { height: 52px; display: flex; align-items: center; gap: 12px; padding: 0 16px; border-bottom: 1px solid #ddd; background: #fff; }
    main { display: grid; grid-template-columns: 320px 1fr; min-height: calc(100vh - 53px); }
    aside { padding: 16px; border-right: 1px solid #ddd; background: #fff; }
    section { padding: 16px; overflow: auto; }
    button, input { font: inherit; height: 36px; border: 1px solid #c9c9c9; border-radius: 6px; padding: 0 10px; }
    button { background: #171717; color: #fff; cursor: pointer; }
    input { width: 100%; box-sizing: border-box; }
    .row { display: flex; gap: 8px; margin: 10px 0; }
    .row > * { flex: 1; }
    .token { overflow-wrap: anywhere; background: #f0f0f0; padding: 10px; border-radius: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    #browser { width: 100%; max-width: 1280px; border: 1px solid #ccc; background: #fff; display: block; }
    #log { white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  </style>
</head>
<body>
  <header><strong>Apple MCP Calnot</strong><span id="badge"></span></header>
  <main>
    <aside>
      <div class="row"><button id="generate">Generate Code</button></div>
      <div id="token" class="token"></div>
      <div class="row"><input id="tokenInput" placeholder="Access code" /></div>
      <div class="row"><button id="login">Unlock</button><button id="start">Start</button></div>
      <div class="row"><button id="open">Open Notes</button><button id="sync">Sync</button></div>
      <div class="row"><input id="typeInput" placeholder="Text to type into browser" /></div>
      <div class="row"><button id="type">Type</button><button id="enter">Enter</button></div>
      <pre id="log"></pre>
    </aside>
    <section>
      <img id="browser" alt="browser" />
    </section>
  </main>
  <script>
    const tokenInput = document.getElementById('tokenInput');
    const tokenBox = document.getElementById('token');
    const log = document.getElementById('log');
    const browser = document.getElementById('browser');
    let token = localStorage.getItem('apple_mcp_token') || '';
    tokenInput.value = token;

    const headers = () => ({ 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) });
    const write = value => { log.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); };
    async function api(path, options = {}) {
      const res = await fetch(path, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      write(data);
      return data;
    }
    async function refresh() {
      const state = await api('/api/state').catch(error => write(error.message));
      if (state) document.getElementById('badge').textContent = state.started ? 'started' : 'setup';
      browser.src = '/api/browser/screenshot?token=' + encodeURIComponent(token) + '&t=' + Date.now();
    }
    document.getElementById('generate').onclick = async () => {
      const data = await api('/api/setup/generate', { method: 'POST', body: '{}' });
      token = data.token;
      localStorage.setItem('apple_mcp_token', token);
      tokenInput.value = token;
      tokenBox.textContent = token;
    };
    document.getElementById('login').onclick = async () => {
      token = tokenInput.value.trim();
      localStorage.setItem('apple_mcp_token', token);
      await api('/api/session', { method: 'POST', body: JSON.stringify({ token }) });
      refresh();
    };
    document.getElementById('start').onclick = () => api('/api/setup/start', { method: 'POST', body: JSON.stringify({ token }) }).then(refresh);
    document.getElementById('open').onclick = () => api('/api/browser/open', { method: 'POST', body: '{}' }).then(refresh);
    document.getElementById('sync').onclick = () => api('/api/sync', { method: 'POST', body: '{}' }).then(refresh);
    document.getElementById('type').onclick = () => api('/api/browser/type', { method: 'POST', body: JSON.stringify({ text: document.getElementById('typeInput').value }) }).then(refresh);
    document.getElementById('enter').onclick = () => api('/api/browser/key', { method: 'POST', body: JSON.stringify({ key: 'Enter' }) }).then(refresh);
    browser.onclick = event => {
      const rect = browser.getBoundingClientRect();
      const x = Math.round((event.clientX - rect.left) * (browser.naturalWidth / rect.width));
      const y = Math.round((event.clientY - rect.top) * (browser.naturalHeight / rect.height));
      api('/api/browser/click', { method: 'POST', body: JSON.stringify({ x, y }) }).then(refresh);
    };
    setInterval(refresh, 4000);
    refresh();
  </script>
</body>
</html>`;
}
