import { NoteDocument } from '../models/note-document.js';
import { AppleNoteWritebackService } from './apple-note-writeback-service.js';

export class NotesService {
  constructor({ repository, browser, checkIntervalMs }) {
    this.repository = repository;
    this.browser = browser;
    this.checkIntervalMs = checkIntervalMs;
    this.writeback = new AppleNoteWritebackService({ repository, browser });
  }

  async start() {
    if (this.timer) return;
    await this.sync();
    this.timer = setInterval(() => {
      this.sync().catch(error => console.error('notes sync failed', error));
    }, this.checkIntervalMs);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async sync() {
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.performSync().finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  async performSync() {
    await this.browser.openNotes();
    const notes = await this.browser.scrapeNotes();
    await Promise.all(notes.map(note => this.repository.upsertSyncedNote(note)));
    return {
      synced: notes.length,
      writeback: await this.writeback.processPendingWrites()
    };
  }

  async listNotes(args) {
    const page = await this.repository.listNotes(args);
    return this.withSyncStatus(page.map(note => NoteDocument.summary(note)), 'Notes sync is currently running. Showing the local database page available so far; retry shortly for fresher results.');
  }

  async getNote(id) {
    return this.repository.getNote(id);
  }

  async searchNotes(query, args) {
    const page = await this.repository.searchNotes(query, args);
    return this.withSyncStatus(page.map(note => NoteDocument.summary(note)), 'Notes sync is currently running. Search results may be incomplete while the database is still filling.');
  }

  isSyncing() {
    return Boolean(this.syncPromise);
  }

  withSyncStatus(page, message) {
    return this.isSyncing() ? page.withSyncStatus({ syncing: true, message }) : page;
  }

  async createNote({ title, body }) {
    const note = await this.repository.createLocalNote({ title, body });
    const appleStatus = await this.writeback.push({
      type: 'create',
      noteId: note._id.toString(),
      title,
      body
    });
    return { note, appleStatus };
  }

  async appendNote({ id, text }) {
    const note = await this.repository.appendNote({ id, text });
    if (!note) return null;
    const appleStatus = await this.writeback.push({ type: 'append', noteId: id, text });
    return { note: await this.repository.getNote(id), appleStatus };
  }

  async deleteNote({ id }) {
    const note = await this.repository.getNote(id);
    const deleted = await this.repository.deleteNote(id);
    if (!deleted) return null;
    const appleStatus = await this.writeback.push({ type: 'delete', noteId: id, externalId: note?.externalId });
    return { deleted: true, appleStatus };
  }
}
