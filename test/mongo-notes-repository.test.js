import assert from 'node:assert/strict';
import test from 'node:test';
import { MongoNotesRepository } from '../src/repositories/mongo-notes-repository.js';

test('listNotes sorts by Apple modified time and supports page pagination', async () => {
  const calls = {};
  const returnedNotes = [{ title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }, { title: 'E' }, { title: 'F' }];
  const repository = new MongoNotesRepository({ url: 'mongodb://example', dbName: 'test' });
  repository.notes = {
    find(filter) {
      calls.filter = filter;
      return {
        sort(sort) {
          calls.sort = sort;
          return this;
        },
        skip(offset) {
          calls.offset = offset;
          return this;
        },
        limit(limit) {
          calls.limit = limit;
          return this;
        },
        async toArray() {
          return returnedNotes;
        }
      };
    }
  };

  const page = await repository.listNotes({ page: 2, pageSize: 5 });

  assert.deepEqual(calls.filter, { deletedAt: null });
  assert.deepEqual(calls.sort, { appleModifiedAt: -1, appleCreatedAt: -1, updatedAt: -1, _id: -1 });
  assert.equal(calls.offset, 5);
  assert.equal(calls.limit, 6);
  assert.equal(page.items.length, 5);
  assert.deepEqual(page.pagination, { page: 2, pageSize: 5, hasMore: true, nextPage: 3 });
});

test('listNotes clamps oversized page sizes defensively', async () => {
  const calls = {};
  const repository = new MongoNotesRepository({ url: 'mongodb://example', dbName: 'test' });
  repository.notes = {
    find() {
      return {
        sort() { return this; },
        skip() { return this; },
        limit(limit) {
          calls.limit = limit;
          return this;
        },
        async toArray() { return []; }
      };
    }
  };

  await repository.listNotes({ pageSize: 500, page: -5 });

  assert.equal(calls.limit, 26);
});
