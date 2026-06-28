export class NotesProcessor {
  constructor({ repository, browser, notesUrl, syncIntervalMs }) {
    this.repository = repository;
    this.browser = browser;
    this.notesUrl = notesUrl;
    this.syncIntervalMs = syncIntervalMs;
  }

  async start() {
    if (this.timer) return;
    await this.sync();
    this.timer = setInterval(() => {
      this.sync().catch(error => console.error('notes sync failed', error));
    }, this.syncIntervalMs);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async sync() {
    await this.browser.openNotes();
    const notes = await this.scrapeVisibleNotes();
    for (const note of notes) await this.repository.upsertSyncedNote(note);
    return { synced: notes.length };
  }

  async scrapeVisibleNotes() {
    return this.browser.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('[role="listitem"], [role="option"], li, button'));
      const seen = new Set();
      return candidates
        .map((el, index) => {
          const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
          if (!text || text.length < 2 || text.length > 500 || seen.has(text)) return null;
          seen.add(text);
          const [title, ...bodyParts] = text.split(/\s{2,}|\n/).filter(Boolean);
          return {
            externalId: `visible-${index}-${title}`,
            title: title || 'Untitled',
            body: bodyParts.join('\n')
          };
        })
        .filter(Boolean)
        .slice(0, 100);
    });
  }

  async listNotes(args) {
    return this.repository.listNotes(args);
  }

  async getNote(id) {
    return this.repository.getNote(id);
  }

  async searchNotes(query, args) {
    return this.repository.searchNotes(query, args);
  }

  async createNote({ title, body }) {
    const note = await this.repository.createLocalNote({ title, body });
    const appleStatus = await this.tryAppleWrite({
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
    const appleStatus = await this.tryAppleWrite({ type: 'append', noteId: id, text });
    return { note, appleStatus };
  }

  async deleteNote({ id }) {
    const deleted = await this.repository.deleteNote(id);
    if (!deleted) return null;
    const appleStatus = await this.tryAppleWrite({ type: 'delete', noteId: id });
    return { deleted: true, appleStatus };
  }

  async tryAppleWrite(write) {
    try {
      const pageStatus = await this.browser.status();
      await this.repository.addPendingWrite({ ...write, pageStatus });
      return 'queued';
    } catch (error) {
      await this.repository.addPendingWrite({ ...write, error: error.message });
      return 'queued_browser_unavailable';
    }
  }
}
