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
    description: 'List one page of synced Apple Note summaries ordered by Apple modified time. Default is 5 per page; use getNote for full content.',
    inputSchema: {
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(10).default(5)
    }
  }, async ({ page, pageSize }) => textResult(await notes.listNotes({ page, pageSize })));

  server.registerTool('getNote', {
    description: 'Get one synced Apple Note by id, including full body content.',
    inputSchema: { id: z.string().min(1) }
  }, async ({ id }) => {
    const result = await notes.getNote(id);
    return result ? textResult(result) : textResult({ error: 'note not found' });
  });

  server.registerTool('searchNotes', {
    description: 'Search synced Apple Notes and return summaries. Use getNote with an id for full content.',
    inputSchema: {
      query: z.string().min(1),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(10).default(5)
    }
  }, async ({ query, page, pageSize }) => textResult(await notes.searchNotes(query, { page, pageSize })));

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
