import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const srcRoot = path.resolve('src');

test('source is organized by explicit architectural roles', async () => {
  const files = (await sourceFiles(srcRoot)).map(file => path.relative(srcRoot, file));
  assert(files.some(file => file.startsWith('models/')));
  assert(files.some(file => file.startsWith('adapters/icloud/')));
  assert(files.some(file => file.startsWith('repositories/')));
  assert(files.some(file => file.startsWith('services/')));
  assert(files.some(file => file.startsWith('controllers/')));
  assert(!files.some(file => file.startsWith('components/')));
  assert(!files.some(file => file.startsWith('processors/')));
  assert(!files.some(file => file.startsWith('domain/')));
});

test('models do not depend on adapters, services, repositories, or controllers', async () => {
  for (const file of await sourceFiles(path.join(srcRoot, 'models'))) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /from ['"]\.\.\/(?:adapters|services|repositories|controllers)\//, file);
  }
});

test('adapters do not import services or repositories', async () => {
  for (const file of await sourceFiles(path.join(srcRoot, 'adapters'))) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /from ['"].*(?:services|repositories)\//, file);
  }
});

test('old generic class names do not come back', async () => {
  const forbidden = /\b(BrowserController|Repository|AuthProcessor|NotesProcessor|AppleWritebackProcessor|DomNotesScraper|ICloudNotesRuntime)\b/;
  for (const file of await sourceFiles(srcRoot)) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, forbidden, file);
  }
});

async function sourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => {
    const entryPath = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(entryPath) : entryPath.endsWith('.js') ? [entryPath] : [];
  }));
  return files.flat();
}
