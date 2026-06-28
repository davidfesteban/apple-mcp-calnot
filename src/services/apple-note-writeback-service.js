export class AppleNoteWritebackService {
  constructor({ repository, browser }) {
    this.repository = repository;
    this.browser = browser;
  }

  async processPendingWrites({ limit = 10 } = {}) {
    const writes = await this.repository.listPendingWrites({ limit });
    let applied = 0;
    let failed = 0;

    for (const write of writes) {
      const result = await this.applyQueuedWrite(write);
      if (result === 'applied') applied += 1;
      else failed += 1;
    }

    return { pending: writes.length, applied, failed };
  }

  async push(write) {
    try {
      return await this.apply(write);
    } catch (error) {
      await this.repository.addPendingWrite({ ...write, error: error.message });
      return 'queued_after_error';
    }
  }

  async applyQueuedWrite(write) {
    try {
      const result = await this.apply(write, { queue: false });
      if (result === 'applied') {
        await this.repository.markPendingWrite(write._id, { status: 'applied', appliedAt: new Date() });
        return 'applied';
      }
      await this.repository.markPendingWrite(write._id, { status: 'unsupported', error: result });
      return 'failed';
    } catch (error) {
      await this.repository.markPendingWrite(write._id, { status: 'failed', error: error.message });
      return 'failed';
    }
  }

  async apply(write, options = {}) {
    const queue = options.queue !== false;
    if (write.type === 'create') return this.create(write);
    if (write.type === 'append') return this.append(write, { queue });
    if (write.type === 'delete') return this.delete(write, { queue });
    if (queue) await this.queue(write, `unsupported write type: ${write.type}`);
    return 'queued_unsupported';
  }

  async create(write) {
    const created = await this.browser.createNote({ title: write.title, body: write.body });
    const current = created?.externalId ? created : await this.browser.currentNote();
    if (current?.externalId) {
      await this.repository.upsertSyncedNote({ ...current, localId: write.noteId });
    }
    return 'applied';
  }

  async append(write, { queue = true } = {}) {
    const note = await this.repository.getNote(write.noteId);
    const updated = await this.browser.appendExternalNote(note?.externalId, write.text);
    if (!updated && !(await this.browser.openExternalNote(note?.externalId))) {
      if (queue) await this.queue(write, 'note has no stable iCloud URL');
      return 'queued_no_stable_url';
    }
    const current = updated || await this.browser.appendCurrentNote(write.text);
    if (current?.externalId) await this.repository.upsertSyncedNote(current);
    return 'applied';
  }

  async delete(write, { queue = true } = {}) {
    const note = await this.repository.getNote(write.noteId);
    if (await this.browser.deleteExternalNote(note?.externalId || write.externalId)) return 'applied';
    if (queue) await this.queue(write, 'note has no stable iCloud URL');
    return 'queued_no_stable_url';
  }

  async queue(write, error) {
    await this.repository.addPendingWrite({
      ...write,
      pageStatus: await this.browser.status().catch(statusError => ({ error: statusError.message })),
      error
    });
  }
}
