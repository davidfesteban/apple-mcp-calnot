import { NoteText } from './note-text.js';

export class NoteSummary {
  constructor({ id, title, body = '', partial = false, updatedAt = null, syncedAt = null }) {
    this.id = String(id || '');
    this.title = NoteText.normalizeTitle(title);
    this.preview = NoteText.normalizeBody(body).slice(0, 300);
    this.bodyLength = NoteText.normalizeBody(body).length;
    this.partial = Boolean(partial);
    this.updatedAt = updatedAt;
    this.syncedAt = syncedAt;
  }
}
