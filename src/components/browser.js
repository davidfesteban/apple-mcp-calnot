import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

export class BrowserController {
  constructor({ dataDir, headless, notesUrl }) {
    this.profileDir = path.join(dataDir, 'playwright-profile');
    this.headless = headless;
    this.notesUrl = notesUrl;
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
    await page.goto(this.notesUrl, { waitUntil: 'domcontentloaded' });
    return this.status();
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

  async evaluate(fn, arg) {
    const page = await this.page();
    return page.evaluate(fn, arg);
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
