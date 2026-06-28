import { MongoClient, ObjectId } from 'mongodb';
import { NoteDocument } from '../models/note-document.js';
import { PaginatedResult } from '../models/paginated-result.js';

export class MongoNotesRepository {
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
    await this.notes.createIndex({ appleModifiedAt: -1, appleCreatedAt: -1, _id: -1 });
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
    const patch = NoteDocument.syncedPatch(note, now);
    if (note.localId && ObjectId.isValid(note.localId)) {
      await this.notes.updateOne(
        { _id: new ObjectId(note.localId) },
        { $set: patch }
      );
      return;
    }
    await this.notes.updateOne(
      { externalId: patch.externalId },
      {
        $set: patch,
        $setOnInsert: { _id: new ObjectId(), createdAt: now }
      },
      { upsert: true }
    );
  }

  async createLocalNote({ title, body }) {
    const now = new Date();
    const doc = NoteDocument.localInsertDocument({ title, body }, now);
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

  async listNotes({ page = 1, pageSize = 5 } = {}) {
    const pagination = normalizePagination({ page, pageSize });
    const notes = await this.notes
      .find({ deletedAt: null })
      .sort({ appleModifiedAt: -1, appleCreatedAt: -1, updatedAt: -1, _id: -1 })
      .skip((pagination.page - 1) * pagination.pageSize)
      .limit(pagination.pageSize + 1)
      .toArray();
    return pageResult(notes, pagination);
  }

  async searchNotes(query, { page = 1, pageSize = 5 } = {}) {
    if (!query?.trim()) return this.listNotes({ page, pageSize });
    const pagination = normalizePagination({ page, pageSize });
    const notes = await this.notes
      .find({ $text: { $search: query }, deletedAt: null }, { projection: { score: { $meta: 'textScore' } } })
      .sort({ score: { $meta: 'textScore' }, appleModifiedAt: -1, updatedAt: -1, _id: -1 })
      .skip((pagination.page - 1) * pagination.pageSize)
      .limit(pagination.pageSize + 1)
      .toArray();
    return pageResult(notes, pagination);
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

function normalizePagination({ page, pageSize }) {
  return {
    page: positiveInt(page, 1),
    pageSize: Math.min(positiveInt(pageSize, 5), 25)
  };
}

function positiveInt(input, fallback) {
  const value = Number(input);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}

function pageResult(notes, pagination) {
  return new PaginatedResult({
    items: notes.slice(0, pagination.pageSize),
    page: pagination.page,
    pageSize: pagination.pageSize,
    hasMore: notes.length > pagination.pageSize
  });
}
