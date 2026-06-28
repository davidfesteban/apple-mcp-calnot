import assert from 'node:assert/strict';
import test from 'node:test';
import { ICloudNoteUrl } from '../src/models/icloud-note-url.js';
import { NoteDocument } from '../src/models/note-document.js';

test('maps Apple snapshots into stored note documents', () => {
  const recordId = 'CloudKit::zone::owner::record';
  const note = NoteDocument.appleSnapshotObject({
    recordId,
    title: 'Project',
    text: 'Project\nbody',
    url: 'https://www.icloud.com/notes'
  });

  assert.equal(note.title, 'Project');
  assert.equal(note.body, 'body');
  assert.equal(note.source, 'apple');
  assert.equal(note.cloudKit.recordId, recordId);
  assert.match(note.externalId, /^icloud-url:\/notes\/note\//);
});

test('decodes iCloud note URLs back to record ids', () => {
  const recordId = 'CloudKit::zone::owner::record';
  const path = `/notes/note/${Buffer.from(recordId, 'utf8').toString('base64')}`;

  assert.equal(ICloudNoteUrl.decodePath(path).recordId, recordId);
  assert.equal(ICloudNoteUrl.recordIdFromExternalId(`icloud-url:${path}`), recordId);
});

test('summaries never expose full body content', () => {
  const summary = NoteDocument.summary({
    _id: { toString: () => 'note-id' },
    title: 'Title',
    body: 'full body',
    appleModifiedAt: new Date('2026-06-28T18:30:00Z')
  });

  assert.deepEqual(Object.keys(summary), ['id', 'title', 'preview', 'bodyLength', 'partial', 'appleModifiedAt', 'updatedAt', 'syncedAt']);
  assert.equal(summary.id, 'note-id');
  assert.equal(summary.preview, 'full body');
  assert.equal(summary.bodyLength, 9);
  assert.equal(summary.appleModifiedAt.toISOString(), '2026-06-28T18:30:00.000Z');
  assert.equal('body' in summary, false);
});

test('synced patches preserve Apple modified time as updatedAt', () => {
  const modifiedAt = new Date('2026-06-28T18:31:00Z');
  const patch = NoteDocument.syncedPatch({
    externalId: 'icloud-record:1',
    title: 'A',
    body: 'B',
    appleModifiedAt: modifiedAt
  }, new Date('2026-06-28T18:40:00Z'));

  assert.equal(patch.updatedAt.toISOString(), modifiedAt.toISOString());
  assert.equal(patch.syncedAt.toISOString(), '2026-06-28T18:40:00.000Z');
});
