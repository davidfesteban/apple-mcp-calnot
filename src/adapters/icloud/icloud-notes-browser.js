import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { ICloudNotesDomScraper } from './icloud-notes-dom-scraper.js';
import { ICloudNotesRuntimeAdapter } from './icloud-notes-runtime-adapter.js';

export class ICloudNotesBrowser {
  constructor({ dataDir, headless, notesUrl }) {
    this.profileDir = path.join(dataDir, 'playwright-profile');
    this.headless = headless;
    this.notesUrl = notesUrl;
    this.runtime = new ICloudNotesRuntimeAdapter(this);
    this.domScraper = new ICloudNotesDomScraper(this);
  }

  async page() {
    if (this.currentPage) return this.currentPage;
    await fs.mkdir(this.profileDir, { recursive: true });
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      headless: this.headless,
      viewport: { width: 1280, height: 900 },
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
    this.currentPage = this.context.pages()[0] || (await this.context.newPage());
    return this.currentPage;
  }

  async openNotes() {
    const page = await this.page();
    if (!page.url().startsWith(this.notesUrl)) {
      await page.goto(this.notesUrl, { waitUntil: 'domcontentloaded' });
    }
    await this.waitForNotesReady();
    return this.status();
  }

  async waitForNotesReady() {
    const page = await this.page();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForFunction(() => {
      const text = document.body.innerText.trim();
      return document.title.includes('iCloud') && (location.pathname.startsWith('/notes/note/') || text.length > 100);
    }, null, { timeout: 30000 }).catch(() => {});
  }

  async scrapeNotes() {
    await this.waitForNotesReady();
    const runtimeNotes = await this.runtime.listNotes();
    return runtimeNotes.length ? runtimeNotes : this.domScraper.scrapeNotes();
  }

  async createNote({ title, body }) {
    const runtimeNote = await this.runtime.createNote({ title, body });
    if (runtimeNote) return runtimeNote;

    const page = await this.page();
    await this.waitForNotesReady();
    const newNote = page.getByRole('button', { name: /new note|compose|create/i }).first();
    if (await newNote.count()) await newNote.click();
    else await page.mouse.click(1254, 70);
    await page.keyboard.type([title, body].filter(Boolean).join('\n'));
    return this.status();
  }

  async openExternalNote(externalId) {
    const match = String(externalId || '').match(/^icloud-url:(\/notes\/note\/.+)$/);
    if (!match) return false;
    const page = await this.page();
    await page.goto(`https://www.icloud.com${match[1]}`, { waitUntil: 'domcontentloaded' });
    await this.waitForNotesReady();
    return true;
  }

  async appendCurrentNote(text) {
    const page = await this.page();
    await this.waitForNotesReady();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End').catch(() => {});
    await page.keyboard.type(`\n${text}`);
    return this.status();
  }

  async appendExternalNote(externalId, text) {
    return this.runtime.updateNote({ externalId, appendText: text });
  }

  async deleteExternalNote(externalId) {
    return this.runtime.deleteNote(externalId);
  }

  async currentNote() {
    return this.domScraper.currentNote();
  }

  async inspectNotesRuntime() {
    return this.runtime.inspect();
  }

  async withNotesRuntime(callback) {
    const page = await this.page();
    await this.waitForNotesReady();
    for (const { frame } of await this.framesWithOffsets(page)) {
      const hasRuntime = await frame.evaluate(() => Boolean(window.NotesApp?.dataManager)).catch(() => false);
      if (hasRuntime) return callback(frame);
    }
    return null;
  }

  async framesWithOffsets(page) {
    const frames = [];
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) {
        frames.push({ frame, offset: { x: 0, y: 0 } });
        continue;
      }
      const box = await frame.frameElement().then(handle => handle.boundingBox()).catch(() => null);
      frames.push({ frame, offset: { x: box?.x || 0, y: box?.y || 0 } });
    }
    return frames;
  }

  async screenshot() {
    const page = await this.page();
    return page.screenshot({ type: 'jpeg', quality: 75 });
  }

  async click({ x, y }) {
    const page = await this.page();
    await page.mouse.click(Number(x), Number(y));
  }

  async type(text) {
    const page = await this.page();
    await page.keyboard.type(String(text));
  }

  async press(key) {
    const page = await this.page();
    await page.keyboard.press(String(key));
  }

  async status() {
    const page = await this.page();
    return {
      url: page.url(),
      title: await page.title().catch(() => '')
    };
  }

  async close() {
    await this.context?.close();
  }
}
