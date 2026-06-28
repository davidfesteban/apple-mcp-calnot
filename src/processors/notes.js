export class NotesProcessor {
  constructor({ repository, browser, notesUrl, checkIntervalMs }) {
    this.repository = repository;
    this.browser = browser;
    this.notesUrl = notesUrl;
    this.checkIntervalMs = checkIntervalMs;
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
    await this.browser.openNotes();
    const notes = await this.scrapeVisibleNotes();
    for (const note of notes) await this.repository.upsertSyncedNote(note);
    const writeback = await this.processPendingWrites();
    return { synced: notes.length, writeback };
  }

  async scrapeVisibleNotes() {
    return this.browser.scrapeNotes();
  }

  async processPendingWrites() {
    const writes = await this.repository.listPendingWrites({ limit: 10 });
    let applied = 0;
    let failed = 0;
    for (const write of writes) {
      try {
        if (write.type === 'create') {
          const created = await this.browser.createNote({ title: write.title, body: write.body });
          const current = created?.externalId ? created : await this.browser.currentNote();
          if (current?.externalId) {
            await this.repository.upsertSyncedNote({ ...current, localId: write.noteId });
          }
        } else if (write.type === 'append') {
          const note = await this.repository.getNote(write.noteId);
          const updated = await this.browser.appendExternalNote(note?.externalId, write.text);
          if (!updated && !(await this.browser.openExternalNote(note?.externalId))) {
            await this.repository.markPendingWrite(write._id, { status: 'unsupported', error: 'note has no stable iCloud URL' });
            failed += 1;
            continue;
          }
          const current = updated || await this.browser.appendCurrentNote(write.text);
          if (current?.externalId) await this.repository.upsertSyncedNote(current);
        } else if (write.type === 'delete') {
          const note = await this.repository.getNote(write.noteId);
          if (!(await this.browser.deleteExternalNote(note?.externalId || write.externalId))) {
            await this.repository.markPendingWrite(write._id, { status: 'unsupported', error: 'note has no stable iCloud URL' });
            failed += 1;
            continue;
          }
        } else {
          await this.repository.markPendingWrite(write._id, { status: 'unsupported', error: `unsupported write type: ${write.type}` });
          failed += 1;
          continue;
        }
        await this.repository.markPendingWrite(write._id, { status: 'applied', appliedAt: new Date() });
        applied += 1;
      } catch (error) {
        await this.repository.markPendingWrite(write._id, { status: 'failed', error: error.message });
        failed += 1;
      }
    }
    return { pending: writes.length, applied, failed };
  }

  async listNotes(args) {
    const notes = await this.repository.listNotes(args);
    return notes.map(noteSummary);
  }

  async getNote(id) {
    return this.repository.getNote(id);
  }

  async searchNotes(query, args) {
    const notes = await this.repository.searchNotes(query, args);
    return notes.map(noteSummary);
  }

  async createNote({ title, body }) {
    const note = await this.repository.createLocalNote({ title, body });
    const appleStatus = await this.pushAppleWrite({
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
    const appleStatus = await this.pushAppleWrite({ type: 'append', noteId: id, text });
    return { note: await this.repository.getNote(id), appleStatus };
  }

  async deleteNote({ id }) {
    const note = await this.repository.getNote(id);
    const deleted = await this.repository.deleteNote(id);
    if (!deleted) return null;
    const appleStatus = await this.pushAppleWrite({ type: 'delete', noteId: id, externalId: note?.externalId });
    return { deleted: true, appleStatus };
  }

  async pushAppleWrite(write) {
    try {
      const pageStatus = await this.browser.status();
      if (write.type === 'create') {
        const created = await this.browser.createNote({ title: write.title, body: write.body });
        const current = created?.externalId ? created : await this.browser.currentNote();
        if (current?.externalId) {
          await this.repository.upsertSyncedNote({ ...current, localId: write.noteId });
        }
        return 'applied';
      }
      if (write.type === 'append') {
        const note = await this.repository.getNote(write.noteId);
        const updated = await this.browser.appendExternalNote(note?.externalId, write.text);
        if (!updated && !(await this.browser.openExternalNote(note?.externalId))) {
          await this.repository.addPendingWrite({ ...write, pageStatus, error: 'note has no stable iCloud URL' });
          return 'queued_no_stable_url';
        }
        const current = updated || await this.browser.appendCurrentNote(write.text);
        if (current?.externalId) await this.repository.upsertSyncedNote(current);
        return 'applied';
      }
      if (write.type === 'delete') {
        const note = await this.repository.getNote(write.noteId);
        if (await this.browser.deleteExternalNote(note?.externalId || write.externalId)) return 'applied';
        await this.repository.addPendingWrite({ ...write, pageStatus, error: 'note has no stable iCloud URL' });
        return 'queued_no_stable_url';
      }
      await this.repository.addPendingWrite({ ...write, pageStatus, error: `unsupported write type: ${write.type}` });
      return 'queued_unsupported';
    } catch (error) {
      await this.repository.addPendingWrite({ ...write, error: error.message });
      return 'queued_after_error';
    }
  }
}

function noteSummary(note) {
  return {
    _id: note._id,
    title: note.title,
    preview: String(note.body || '').slice(0, 300),
    bodyLength: String(note.body || '').length,
    source: note.source,
    partial: Boolean(note.partial),
    updatedAt: note.updatedAt,
    syncedAt: note.syncedAt,
    cloudKit: note.cloudKit
  };
}
