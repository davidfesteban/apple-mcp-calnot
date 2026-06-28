import { MongoClient, ObjectId } from 'mongodb';

export class Repository {
  constructor({ url, dbName }) {
    this.client = new MongoClient(url);
    this.dbName = dbName;
  }

  async connect() {
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    this.state = this.db.collection('state');
    this.notes = this.db.collection('notes');
    this.pendingWrites = this.db.collection('pending_writes');
    await this.notes.createIndex({ title: 'text', body: 'text' });
    await this.notes.createIndex({ updatedAt: -1 });
    await this.pendingWrites.createIndex({ createdAt: 1 });
  }

  async close() {
    await this.client.close();
  }

  async getState() {
    return (await this.state.findOne({ _id: 'app' })) || { _id: 'app', started: false };
  }

  async saveState(patch) {
    const now = new Date();
    await this.state.updateOne(
      { _id: 'app' },
      { $set: { ...patch, updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true }
    );
    return this.getState();
  }

  async upsertSyncedNote(note) {
    const now = new Date();
    const externalId = note.externalId || note.title;
    if (note.localId && ObjectId.isValid(note.localId)) {
      await this.notes.updateOne(
        { _id: new ObjectId(note.localId) },
        {
          $set: {
            externalId,
            cloudKit: note.cloudKit || null,
            title: note.title || 'Untitled',
            body: note.body || '',
            source: 'apple',
            partial: Boolean(note.partial),
            deletedAt: null,
            syncedAt: now,
            updatedAt: now
          }
        }
      );
      return;
    }
    await this.notes.updateOne(
      { externalId },
      {
        $set: {
          externalId,
          cloudKit: note.cloudKit || null,
          title: note.title || 'Untitled',
          body: note.body || '',
          source: 'apple',
          partial: Boolean(note.partial),
          deletedAt: null,
          syncedAt: now,
          updatedAt: now
        },
        $setOnInsert: { _id: new ObjectId(), createdAt: now }
      },
      { upsert: true }
    );
  }

  async createLocalNote({ title, body }) {
    const now = new Date();
    const doc = {
      title: title || 'Untitled',
      body: body || '',
      source: 'local',
      createdAt: now,
      updatedAt: now,
      deletedAt: null
    };
    const result = await this.notes.insertOne(doc);
    return { ...doc, _id: result.insertedId };
  }

  async appendNote({ id, text }) {
    const note = await this.getNote(id);
    if (!note) return null;
    const body = [note.body, text].filter(Boolean).join('\n');
    await this.notes.updateOne({ _id: new ObjectId(id) }, { $set: { body, updatedAt: new Date() } });
    return this.getNote(id);
  }

  async deleteNote(id) {
    const result = await this.notes.updateOne(
      { _id: new ObjectId(id) },
      { $set: { deletedAt: new Date(), updatedAt: new Date() } }
    );
    return result.matchedCount > 0;
  }

  async getNote(id) {
    if (!ObjectId.isValid(id)) return null;
    return this.notes.findOne({ _id: new ObjectId(id), deletedAt: null });
  }

  async listNotes({ limit = 50 } = {}) {
    return this.notes.find({ deletedAt: null }).sort({ updatedAt: -1 }).limit(limit).toArray();
  }

  async searchNotes(query, { limit = 20 } = {}) {
    if (!query?.trim()) return this.listNotes({ limit });
    return this.notes
      .find({ $text: { $search: query }, deletedAt: null }, { projection: { score: { $meta: 'textScore' } } })
      .sort({ score: { $meta: 'textScore' } })
      .limit(limit)
      .toArray();
  }

  async addPendingWrite(write) {
    const now = new Date();
    await this.pendingWrites.insertOne({ ...write, status: 'pending', createdAt: now, updatedAt: now });
  }

  async listPendingWrites({ limit = 20 } = {}) {
    return this.pendingWrites.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(limit).toArray();
  }

  async markPendingWrite(id, patch) {
    await this.pendingWrites.updateOne(
      { _id: new ObjectId(id) },
      { $set: { ...patch, updatedAt: new Date() } }
    );
  }
}
