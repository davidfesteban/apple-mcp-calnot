import { CloudKitRef } from './cloud-kit-ref.js';
import { APPLE_SOURCE, ICLOUD_URL_PREFIX, LOCAL_SOURCE } from './note-source.js';
import { NoteSummary } from './note-summary.js';
import { NoteText } from './note-text.js';

export class NoteDocument {
  constructor({ externalId, cloudKit = null, title, body = '', url = null, source = LOCAL_SOURCE, partial = false, appleCreatedAt = null, appleModifiedAt = null, createdAt = null, updatedAt = null, syncedAt = null, deletedAt = null }) {
    this.externalId = externalId || title;
    this.cloudKit = cloudKit;
    this.title = NoteText.normalizeTitle(title);
    this.body = NoteText.normalizeBody(body);
    this.url = url;
    this.source = source;
    this.partial = Boolean(partial);
    this.appleCreatedAt = normalizeDate(appleCreatedAt);
    this.appleModifiedAt = normalizeDate(appleModifiedAt);
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
    this.syncedAt = syncedAt;
    this.deletedAt = deletedAt;
  }

  static fromAppleSnapshot(snapshot) {
    const cloudKit = CloudKitRef.fromRecordId(snapshot?.recordId);
    const path = cloudKit ? `/notes/note/${Buffer.from(cloudKit.recordId, 'utf8').toString('base64')}` : null;
    const title = NoteText.normalizeTitle(snapshot?.title || NoteText.firstLine(snapshot?.text));
    const text = NoteText.normalizeBody(snapshot?.text).replace(/\u00a0/g, ' ').trimEnd();
    return new NoteDocument({
      externalId: path ? `${ICLOUD_URL_PREFIX}${path}` : `icloud-record:${cloudKit?.recordId || title}`,
      cloudKit: cloudKit?.toJSON() || null,
      title,
      body: NoteText.bodyWithoutTitle(text, title),
      url: path ? `https://www.icloud.com${path}` : snapshot?.url,
      source: APPLE_SOURCE,
      partial: Boolean(snapshot?.partial),
      appleCreatedAt: snapshot?.createdAt || null,
      appleModifiedAt: snapshot?.modifiedAt || null
    });
  }

  static fromStored(note) {
    return new NoteDocument({
      externalId: note?.externalId || note?.title,
      cloudKit: note?.cloudKit || null,
      title: note?.title,
      body: note?.body,
      url: note?.url || null,
      source: note?.source || LOCAL_SOURCE,
      partial: note?.partial,
      appleCreatedAt: note?.appleCreatedAt || null,
      appleModifiedAt: note?.appleModifiedAt || null,
      createdAt: note?.createdAt || null,
      updatedAt: note?.updatedAt || null,
      syncedAt: note?.syncedAt || null,
      deletedAt: note?.deletedAt || null
    });
  }

  static local({ title, body }, now = new Date()) {
    return new NoteDocument({
      title,
      body,
      source: LOCAL_SOURCE,
      createdAt: now,
      updatedAt: now,
      deletedAt: null
    });
  }

  static localInsertDocument(note, now = new Date()) {
    return NoteDocument.local(note, now).toInsertDocument();
  }

  static syncedPatch(note, now = new Date()) {
    return NoteDocument.fromStored(note).toSyncedPatch(now);
  }

  static appleSnapshotObject(snapshot) {
    return NoteDocument.fromAppleSnapshot(snapshot).toObject();
  }

  static summary(note) {
    return NoteDocument.fromStored(note).toSummary(note?._id?.toString?.() || note?.id);
  }

  toInsertDocument() {
    return {
      title: this.title,
      body: this.body,
      appleCreatedAt: this.appleCreatedAt,
      appleModifiedAt: this.appleModifiedAt,
      source: this.source,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      deletedAt: this.deletedAt
    };
  }

  toSyncedPatch(now = new Date()) {
    return {
      externalId: this.externalId,
      cloudKit: this.cloudKit,
      title: this.title,
      body: this.body,
      source: APPLE_SOURCE,
      partial: this.partial,
      appleCreatedAt: this.appleCreatedAt,
      appleModifiedAt: this.appleModifiedAt,
      deletedAt: null,
      syncedAt: now,
      updatedAt: this.appleModifiedAt || now
    };
  }

  toObject() {
    return {
      externalId: this.externalId,
      cloudKit: this.cloudKit,
      title: this.title,
      body: this.body,
      url: this.url,
      source: this.source,
      partial: this.partial,
      appleCreatedAt: this.appleCreatedAt,
      appleModifiedAt: this.appleModifiedAt
    };
  }

  toSummary(id) {
    return new NoteSummary({
      id,
      title: this.title,
      body: this.body,
      partial: this.partial,
      appleModifiedAt: this.appleModifiedAt,
      updatedAt: this.updatedAt,
      syncedAt: this.syncedAt
    });
  }
}

function normalizeDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
