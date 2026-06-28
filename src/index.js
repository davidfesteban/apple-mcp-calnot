import cookieParser from 'cookie-parser';
import express from 'express';
import { BrowserController } from './components/browser.js';
import { Repository } from './components/repository.js';
import { createMcpRouter } from './controller/mcp.js';
import { createWebUiRouter } from './controller/webui.js';
import { AuthProcessor } from './processors/auth.js';
import { NotesProcessor } from './processors/notes.js';

const port = Number(process.env.PORT || 3000);
const dataDir = process.env.DATA_DIR || './data';

const repository = new Repository({
  url: process.env.MONGO_URL || 'mongodb://localhost:27017',
  dbName: process.env.MONGO_DB || 'apple_mcp_calnot'
});
await repository.connect();

const auth = new AuthProcessor(repository);
const browser = new BrowserController({
  dataDir,
  headless: process.env.BROWSER_HEADLESS !== 'false',
  notesUrl: process.env.APPLE_NOTES_URL || 'https://www.icloud.com/notes'
});
const notes = new NotesProcessor({
  repository,
  browser,
  notesUrl: process.env.APPLE_NOTES_URL || 'https://www.icloud.com/notes',
  syncIntervalMs: Number(process.env.SYNC_INTERVAL_MS || 30000)
});

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use('/', createWebUiRouter({ auth, browser, notes, repository }));
app.use('/mcp', await createMcpRouter({ auth, notes }));
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = app.listen(port, () => {
  console.log(`apple-mcp-calnot listening on http://0.0.0.0:${port}`);
});

const shutdown = async () => {
  server.close();
  await notes.stop();
  await browser.close();
  await repository.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
