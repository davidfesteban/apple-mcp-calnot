import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { Router } from 'express';
import { z } from 'zod';

export async function createMcpRouter({ auth, notes }) {
  const router = Router();
  const transports = {};

  router.use(async (req, res, next) => {
    if (await auth.validateToken(auth.extractToken(req))) return next();
    res.status(401).json({ error: 'token required' });
  });

  router.all('/', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    try {
      let transport = sessionId ? transports[sessionId] : null;
      if (!transport && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: id => {
            transports[id] = transport;
          }
        });
        transport.onclose = () => {
          if (transport.sessionId) delete transports[transport.sessionId];
        };
        await createServer(notes).connect(transport);
      }
      if (!transport) return res.status(400).json({ error: 'invalid MCP session' });
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ error: error.message });
    }
  });

  return router;
}

function createServer(notes) {
  const server = new McpServer({ name: 'apple-mcp-calnot', version: '0.1.0' });

  server.registerTool('listNotes', {
    description: 'List locally synced Apple Notes.',
    inputSchema: { limit: z.number().int().min(1).max(100).default(50) }
  }, async ({ limit }) => textResult(await notes.listNotes({ limit })));

  server.registerTool('getNote', {
    description: 'Get a locally synced Apple Note by id.',
    inputSchema: { id: z.string().min(1) }
  }, async ({ id }) => {
    const result = await notes.getNote(id);
    return result ? textResult(result) : textResult({ error: 'note not found' });
  });

  server.registerTool('searchNotes', {
    description: 'Search locally synced Apple Notes.',
    inputSchema: {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(50).default(20)
    }
  }, async ({ query, limit }) => textResult(await notes.searchNotes(query, { limit })));

  server.registerTool('createNote', {
    description: 'Create an Apple Note through the authenticated iCloud Notes runtime and sync it locally.',
    inputSchema: {
      title: z.string().min(1),
      body: z.string().default('')
    }
  }, async args => textResult(await notes.createNote(args)));

  server.registerTool('appendNote', {
    description: 'Append text to an Apple Note through the authenticated iCloud Notes runtime and sync it locally.',
    inputSchema: {
      id: z.string().min(1),
      text: z.string().min(1)
    }
  }, async args => {
    const result = await notes.appendNote(args);
    return result ? textResult(result) : textResult({ error: 'note not found' });
  });

  server.registerTool('deleteNote', {
    description: 'Move an Apple Note to Recently Deleted through the authenticated iCloud Notes runtime and soft-delete it locally.',
    inputSchema: { id: z.string().min(1) }
  }, async args => {
    const result = await notes.deleteNote(args);
    return result ? textResult(result) : textResult({ error: 'note not found' });
  });

  return server;
}

function textResult(value) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(value, (_key, item) => {
        if (item && typeof item === 'object' && item._id) return { ...item, _id: item._id.toString() };
        return item;
      }, 2)
    }]
  };
}
