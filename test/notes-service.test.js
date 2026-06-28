import assert from 'node:assert/strict';
import test from 'node:test';
import { NotesService } from '../src/services/notes-service.js';

test('sync reads NotesApp once, upserts in parallel, then drains pending writebacks', async () => {
  const calls = [];
  const browser = {
    async openNotes() {
      calls.push('open');
    },
    async scrapeNotes() {
      calls.push('scrape');
      return [{ externalId: 'a', title: 'A', body: 'one' }, { externalId: 'b', title: 'B', body: 'two' }];
    }
  };
  const repository = {
    async upsertSyncedNote(note) {
      calls.push(`upsert:${note.externalId}`);
    },
    async listPendingWrites() {
      calls.push('pending');
      return [];
    }
  };

  const service = new NotesService({ repository, browser, checkIntervalMs: 300000 });
  const result = await service.sync();

  assert.equal(result.synced, 2);
  assert.deepEqual(result.writeback, { pending: 0, applied: 0, failed: 0 });
  assert.equal(calls[0], 'open');
  assert.equal(calls[1], 'scrape');
  assert(calls.includes('upsert:a'));
  assert(calls.includes('upsert:b'));
  assert.equal(calls.at(-1), 'pending');
});

test('concurrent sync calls share one in-flight browser scrape', async () => {
  let scrapeCount = 0;
  let release;
  const wait = new Promise(resolve => {
    release = resolve;
  });
  const browser = {
    async openNotes() {},
    async scrapeNotes() {
      scrapeCount += 1;
      await wait;
      return [];
    }
  };
  const repository = {
    async upsertSyncedNote() {},
    async listPendingWrites() {
      return [];
    }
  };

  const service = new NotesService({ repository, browser, checkIntervalMs: 300000 });
  const first = service.sync();
  const second = service.sync();
  release();
  await Promise.all([first, second]);

  assert.equal(scrapeCount, 1);
});

test('listNotes returns compact summaries, not full note bodies', async () => {
  const service = new NotesService({
    browser: {},
    checkIntervalMs: 300000,
    repository: {
      async listNotes() {
        return [{ _id: { toString: () => '1' }, title: 'A', body: 'secret body' }];
      }
    }
  });

  const [summary] = await service.listNotes({ limit: 1 });
  assert.equal(summary.id, '1');
  assert.equal(summary.preview, 'secret body');
  assert.equal(summary.bodyLength, 11);
  assert.equal('body' in summary, false);
});
