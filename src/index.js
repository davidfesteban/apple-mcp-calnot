import cookieParser from 'cookie-parser';
import express from 'express';
import { ApplicationContainer } from './app/application-container.js';
import { createMcpRouter } from './controllers/mcp-controller.js';
import { createWebUiRouter } from './controllers/web-ui-controller.js';

const port = Number(process.env.PORT || 3000);
const container = await new ApplicationContainer().start();
const { auth, browser, notes, repository } = container;

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
  await container.stop();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
