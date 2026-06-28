import assert from 'node:assert/strict';
import express from 'express';
import test from 'node:test';
import { createWebUiRouter } from '../src/controllers/web-ui-controller.js';

test('generate returns a full MCP URL and does not set an auth cookie', async () => {
  const app = testApp();
  const response = await fetch(`${app.url}/api/setup/generate`, { method: 'POST' });
  const body = await response.json();
  await app.close();

  assert.equal(response.status, 200);
  assert.match(body.token, /^[^.]+\..+/);
  assert.equal(body.mcpUrl, `${app.url}/mcp?token=${encodeURIComponent(body.token)}`);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('start locks protected routes unless token is explicitly sent', async () => {
  const app = testApp();
  const generated = await (await fetch(`${app.url}/api/setup/generate`, { method: 'POST' })).json();

  const startResponse = await fetch(`${app.url}/api/setup/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: generated.token })
  });
  const lockedResponse = await fetch(`${app.url}/api/status`);
  const authorizedResponse = await fetch(`${app.url}/api/status?token=${encodeURIComponent(generated.token)}`);
  await app.close();

  assert.equal(startResponse.status, 200);
  assert.equal(startResponse.headers.get('set-cookie'), null);
  assert.equal(lockedResponse.status, 401);
  assert.equal(authorizedResponse.status, 200);
});

function testApp() {
  let tokenHash = null;
  let started = false;
  const app = express();
  app.use(express.json());
  app.use('/', createWebUiRouter({
    auth: {
      extractToken(req) {
        const header = req.get('authorization') || '';
        if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
        return req.body?.token || req.query?.token;
      },
      async issueToken() {
        tokenHash = 'token';
        return 'token.secret';
      },
      async validateToken(token) {
        return token === 'token.secret' && Boolean(tokenHash);
      },
      async start(token) {
        if (token !== 'token.secret') return false;
        started = true;
        return true;
      },
      async requireTokenWhenStarted(req, res, next) {
        if (!started || this.extractToken(req) === 'token.secret') return next();
        res.status(401).json({ error: 'token required' });
      }
    },
    browser: {
      async status() {
        return { url: 'about:blank', title: '' };
      }
    },
    notes: {
      async start() {}
    },
    repository: {
      async getState() {
        return { started, tokenHash };
      },
      async listNotes() {
        return [];
      }
    }
  }));
  const server = app.listen(0);
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve))
  };
}
