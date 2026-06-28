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
    body: 'full body'
  });

  assert.deepEqual(Object.keys(summary), ['id', 'title', 'preview', 'bodyLength', 'partial', 'updatedAt', 'syncedAt']);
  assert.equal(summary.id, 'note-id');
  assert.equal(summary.preview, 'full body');
  assert.equal(summary.bodyLength, 9);
  assert.equal('body' in summary, false);
});
