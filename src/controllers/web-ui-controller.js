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
    res.json({ token, mcpUrl: mcpUrl(_req, token) });
  });

  router.post('/api/session', async (req, res) => {
    const token = auth.extractToken(req);
    if (!(await auth.validateToken(token))) return res.status(401).json({ error: 'invalid token' });
    res.json({ ok: true });
  });

  router.post('/api/setup/start', async (req, res) => {
    const token = auth.extractToken(req);
    if (!(await auth.start(token))) return res.status(401).json({ error: 'valid token required' });
    await notes.start();
    res.json({ started: true, mcpUrl: mcpUrl(req, token) });
  });

  router.get('/api/status', gate, async (_req, res) => {
    const state = await repository.getState();
    const browserStatus = await browser.status().catch(error => ({ error: error.message }));
    const localNotes = await repository.listNotes({ page: 1, pageSize: 5 });
    res.json({ state: { started: Boolean(state.started) }, browser: browserStatus, notes: localNotes.items.length });
  });

  router.post('/api/browser/open', gate, async (_req, res) => {
    res.json(await browser.openNotes());
  });

  router.get('/api/browser/screenshot', gate, async (_req, res) => {
    try {
      const image = await browser.screenshot();
      res.type('jpg').send(image);
    } catch (error) {
      res.status(503).json({ error: error.message });
    }
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

  router.get('/api/debug/icloud', gate, async (_req, res) => {
    res.json(await browser.inspectNotesRuntime());
  });

  return router;
}

function mcpUrl(req, token) {
  return `${req.protocol}://${req.get('host')}/mcp?token=${encodeURIComponent(token)}`;
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
    main { display: grid; grid-template-columns: 280px 1fr; min-height: calc(100vh - 53px); }
    aside { padding: 16px; border-right: 1px solid #ddd; background: #fff; }
    section { padding: 16px; overflow: auto; }
    button, input { font: inherit; height: 36px; border: 1px solid #c9c9c9; border-radius: 6px; padding: 0 10px; }
    button { background: #171717; color: #fff; cursor: pointer; }
    button:disabled { opacity: 0.55; cursor: default; }
    input { width: 100%; box-sizing: border-box; }
    .row { display: flex; gap: 8px; margin: 10px 0; }
    .row > * { flex: 1; }
    .hidden { display: none; }
    .token { overflow-wrap: anywhere; background: #f0f0f0; padding: 10px; border-radius: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; margin: 10px 0; }
    #browser { width: 100%; max-width: 1280px; border: 1px solid #ccc; background: #fff; display: block; outline: none; }
    #browser:focus { border-color: #171717; }
    #log { white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  </style>
</head>
<body>
  <header><strong>Apple MCP Calnot</strong><span id="badge"></span></header>
  <main>
    <aside>
      <div id="locked" class="hidden">
        <div class="row"><input id="tokenInput" placeholder="Access code" /></div>
        <div class="row"><button id="unlock">Unlock</button></div>
      </div>
      <div id="setup">
        <div class="row"><button id="primary">Generate Code</button></div>
        <div id="token" class="token hidden"></div>
        <div id="mcpUrl" class="token hidden"></div>
        <div class="row"><button id="copyMcp" class="hidden">Copy MCP URL</button></div>
      </div>
      <pre id="log"></pre>
    </aside>
    <section>
      <img id="browser" alt="browser" tabindex="0" />
    </section>
  </main>
  <script>
    const tokenInput = document.getElementById('tokenInput');
    const tokenBox = document.getElementById('token');
    const mcpUrlBox = document.getElementById('mcpUrl');
    const copyMcp = document.getElementById('copyMcp');
    const primary = document.getElementById('primary');
    const locked = document.getElementById('locked');
    const setup = document.getElementById('setup');
    const log = document.getElementById('log');
    const browser = document.getElementById('browser');
    let token = localStorage.getItem('apple_mcp_token') || '';
    let generated = false;
    let started = false;
    tokenInput.value = token;

    const headers = () => ({ 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) });
    const mcpUrl = () => location.origin + '/mcp?token=' + encodeURIComponent(token);
    const write = value => { log.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); };
    async function api(path, options = {}) {
      const res = await fetch(path, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      write(data);
      return data;
    }
    async function openNotes() {
      await api('/api/browser/open', { method: 'POST', body: '{}' }).catch(error => write(error.message));
    }
    function render(state) {
      if (!state) return;
      started = state.started;
      if (!started) generated = Boolean(state.authorized && token);
      document.getElementById('badge').textContent = started ? 'started' : 'setup';
      locked.classList.toggle('hidden', !started || state.authorized);
      setup.classList.toggle('hidden', started);
      tokenBox.classList.toggle('hidden', !token);
      mcpUrlBox.classList.toggle('hidden', !token);
      copyMcp.classList.toggle('hidden', !token);
      if (token) {
        tokenBox.textContent = 'Access code: ' + token;
        mcpUrlBox.textContent = mcpUrl();
      }
      primary.textContent = generated ? 'Start' : 'Generate Code';
    }
    function refreshScreenshot() {
      browser.src = '/api/browser/screenshot?token=' + encodeURIComponent(token) + '&t=' + Date.now();
    }
    async function refreshState() {
      const state = await api('/api/state').catch(error => write(error.message));
      render(state);
    }
    async function refresh() {
      await refreshState();
      refreshScreenshot();
    }
    primary.onclick = async () => {
      primary.disabled = true;
      try {
        if (!generated) {
          const data = await api('/api/setup/generate', { method: 'POST', body: '{}' });
          token = data.token;
          generated = true;
          localStorage.setItem('apple_mcp_token', token);
          tokenInput.value = token;
          await navigator.clipboard?.writeText(data.mcpUrl || mcpUrl()).catch(() => {});
        } else {
          await api('/api/setup/start', { method: 'POST', body: JSON.stringify({ token }) });
        }
        await refresh();
      } finally {
        primary.disabled = false;
      }
    };
    document.getElementById('unlock').onclick = async () => {
      token = tokenInput.value.trim();
      localStorage.setItem('apple_mcp_token', token);
      await api('/api/session', { method: 'POST', body: JSON.stringify({ token }) });
      refresh();
    };
    copyMcp.onclick = async () => {
      await navigator.clipboard?.writeText(mcpUrl()).catch(() => {});
      write({ copied: mcpUrl() });
    };
    browser.onclick = event => {
      browser.focus();
      const rect = browser.getBoundingClientRect();
      const x = Math.round((event.clientX - rect.left) * (browser.naturalWidth / rect.width));
      const y = Math.round((event.clientY - rect.top) * (browser.naturalHeight / rect.height));
      api('/api/browser/click', { method: 'POST', body: JSON.stringify({ x, y }) }).then(refresh);
    };
    browser.onkeydown = event => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      const special = ['Backspace', 'Delete', 'Enter', 'Escape', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
      if (!special.includes(event.key) && event.key.length !== 1) return;
      const path = special.includes(event.key) ? '/api/browser/key' : '/api/browser/type';
      const body = special.includes(event.key) ? { key: event.key } : { text: event.key };
      api(path, { method: 'POST', body: JSON.stringify(body) }).then(refresh);
    };
    browser.onpaste = event => {
      event.preventDefault();
      const text = event.clipboardData.getData('text');
      api('/api/browser/type', { method: 'POST', body: JSON.stringify({ text }) }).then(refresh);
    };
    setInterval(refreshScreenshot, 1000);
    setInterval(refreshState, 4000);
    refresh().then(() => {
      if (!started) openNotes();
    });
  </script>
</body>
</html>`;
}
