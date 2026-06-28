import { ICloudNotesBrowser } from '../adapters/icloud/icloud-notes-browser.js';
import { MongoNotesRepository } from '../repositories/mongo-notes-repository.js';
import { AuthService } from '../services/auth-service.js';
import { NotesService } from '../services/notes-service.js';

export class ApplicationContainer {
  constructor(env = process.env) {
    this.env = env;
  }

  async start() {
    this.repository = new MongoNotesRepository({
      url: this.env.MONGO_URL || 'mongodb://localhost:27017',
      dbName: this.env.MONGO_DB || 'apple_mcp_calnot'
    });
    await this.repository.connect();

    this.auth = new AuthService(this.repository);
    this.browser = new ICloudNotesBrowser({
      dataDir: this.env.DATA_DIR || './data',
      headless: this.env.BROWSER_HEADLESS !== 'false',
      notesUrl: this.env.APPLE_NOTES_URL || 'https://www.icloud.com/notes'
    });
    this.notes = new NotesService({
      repository: this.repository,
      browser: this.browser,
      checkIntervalMs: Number(this.env.CHECK_INTERVAL_MS || this.env.SYNC_INTERVAL_MS || 300000)
    });

    return this;
  }

  async stop() {
    await this.notes?.stop();
    await this.browser?.close();
    await this.repository?.close();
  }
}
