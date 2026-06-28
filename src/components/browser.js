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
    }, null, {
      timeout: 30000
    }).catch(() => {});
  }

  async scrapeNotes() {
    const page = await this.page();
    await this.waitForNotesReady();
    const runtimeNotes = await this.runtimeNotes();
    if (runtimeNotes.length) return runtimeNotes;

    const notesByUrl = new Map();
    let lastTargetKey = '';
    let stagnantScrolls = 0;

    for (let pageIndex = 0; pageIndex < 40; pageIndex += 1) {
      const targets = await this.visibleNoteTargets();
      const targetKey = targets.map(target => target.text).join('|');
      stagnantScrolls = targetKey === lastTargetKey ? stagnantScrolls + 1 : 0;
      lastTargetKey = targetKey;

      for (const target of targets) {
        await page.mouse.click(target.x, target.y);
        await page.waitForTimeout(700);
        const note = (await this.waitForCurrentNote({ timeoutMs: 1200 })) || this.noteFromTarget(target, page.url());
        if (note?.externalId) notesByUrl.set(note.externalId, note);
      }

      if (stagnantScrolls >= 2 || !(await this.scrollNoteList())) break;
    }

    return Array.from(notesByUrl.values());
  }

  async runtimeNotes() {
    const page = await this.page();
    for (const { frame } of await this.framesWithOffsets(page)) {
      const notes = await frame.evaluate(async () => {
        const app = window.NotesApp;
        const allNotes = app?.dataManager?.allNotes;
        if (!Array.isArray(allNotes)) return [];

        const encodeNoteId = id => btoa(unescape(encodeURIComponent(id)));
        const valueOf = (note, key) => {
          try {
            const value = note?.[key];
            return value == null ? null : value;
          } catch {
            return null;
          }
        };
        const textOf = async note => {
          let topo = valueOf(note, 'TopoTextString');
          if (!topo && typeof note?.getTopoText === 'function') {
            try {
              topo = await note.getTopoText();
            } catch {
              topo = null;
            }
          }
          const searchable = valueOf(note, '_searchableText');
          const text = topo ? String(topo) : searchable ? String(searchable) : '';
          return text.replace(/\u00a0/g, ' ').trimEnd();
        };
        const truthyValue = (note, key) => {
          const value = valueOf(note, key);
          return typeof value === 'function' ? Boolean(value.call(note)) : Boolean(value);
        };

        const activeNotes = allNotes
          .filter(note => note && !truthyValue(note, 'Deleted') && !truthyValue(note, 'isInTrashOrDeleted'));
        const results = [];
        for (const note of activeNotes) {
          const id = String(valueOf(note, 'id') || '');
          const text = await textOf(note);
          const title = String(valueOf(note, 'Title') || text.split('\n')[0] || 'Untitled').trim() || 'Untitled';
          const body = text.startsWith(title) ? text.slice(title.length).replace(/^\n/, '') : text;
          const parts = id.split('::');
          const path = id ? `/notes/note/${encodeNoteId(id)}` : null;
          results.push({
            externalId: path ? `icloud-url:${path}` : `icloud-record:${id || title}`,
            cloudKit: id ? {
              recordId: id,
              database: parts[0] || null,
              zoneName: parts[1] || null,
              ownerName: parts[2] || null,
              recordName: parts.slice(3).join('::') || null
            } : null,
            title,
            body,
            url: path ? `https://www.icloud.com${path}` : location.href,
            source: 'apple',
            partial: false
          });
        }
        return results;
      }).catch(() => []);
      if (notes.length) return notes;
    }
    return [];
  }

  noteFromTarget(target, url) {
    const path = new URL(url).pathname;
    if (!path.startsWith('/notes/note/')) return null;
    const cloudKit = decodeNotePath(path);
    const lines = target.text.split(/\n| {2,}/).map(value => value.trim()).filter(Boolean);
    const body = lines.filter(line => line !== target.title).join('\n');
    return {
      externalId: `icloud-url:${path}`,
      cloudKit,
      title: target.title || 'Untitled',
      body,
      url,
      source: 'apple',
      partial: true
    };
  }

  async waitForCurrentNote({ timeoutMs = 8000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastNote = null;
    while (Date.now() < deadline) {
      lastNote = await this.currentNote();
      if (lastNote && lastNote.title !== 'Loading…' && lastNote.title !== '⇨' && lastNote.body !== '⇨\n⇦') return lastNote;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    return null;
  }

  async visibleNoteTargets() {
    const page = await this.page();
    const targets = [];
    for (const { frame, offset } of await this.framesWithOffsets(page)) {
      const frameTargets = await frame.evaluate(({ offsetX, offsetY }) => {
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const normalize = value => (value || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
        const isVisible = rect => rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.right > 0 && rect.top < viewportHeight && rect.left < viewportWidth;

        function roots(root = document) {
          const result = [root];
          for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) result.push(...roots(el.shadowRoot));
          }
          return result;
        }

        const elements = roots()
          .flatMap(root => Array.from(root.querySelectorAll('*')))
          .map(el => {
            const rect = el.getBoundingClientRect();
            const text = normalize(el.innerText || el.textContent);
            return { text, rect };
          })
          .filter(item => item.text && isVisible(item.rect));

        return elements
          .filter(item => item.rect.left + offsetX >= 250 && item.rect.right + offsetX <= 590 && item.rect.top + offsetY >= 85 && item.rect.height >= 35)
          .filter(item => item.rect.height <= 120 && item.text.length >= 2 && item.text.length <= 500)
          .sort((a, b) => a.rect.top - b.rect.top)
          .reduce((items, card) => {
            const lines = card.text.split(/\n| {2,}/).map(normalize).filter(Boolean);
            const title = lines.find(line => !/^\d{1,2}:\d{2}|^\d{1,2}\/\d{1,2}\/\d{2,4}|^Notes$|^Compartida$|^Yo$/.test(line));
            if (!title || items.some(item => item.title === title)) return items;
            items.push({
              title,
              text: card.text,
              x: Math.round(offsetX + (card.rect.left + card.rect.right) / 2),
              y: Math.round(offsetY + (card.rect.top + card.rect.bottom) / 2)
            });
            return items;
          }, []);
      }, { offsetX: offset.x, offsetY: offset.y }).catch(() => []);
      targets.push(...frameTargets);
    }
    return targets.filter((target, index) => targets.findIndex(item => item.text === target.text) === index);
  }

  async currentNote() {
    const page = await this.page();
    for (const { frame, offset } of await this.framesWithOffsets(page)) {
      const note = await frame.evaluate(({ offsetX, offsetY, pagePath, pageUrl }) => {
        const normalize = value => (value || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();

        function roots(root = document) {
          const result = [root];
          for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) result.push(...roots(el.shadowRoot));
          }
          return result;
        }

        const elements = roots()
          .flatMap(root => Array.from(root.querySelectorAll('*')))
          .map(el => {
            const rect = el.getBoundingClientRect();
            return { text: normalize(el.innerText || el.textContent), rect };
          })
          .filter(item => item.text && item.rect.left + offsetX >= 580 && item.rect.top + offsetY >= 90 && item.rect.width > 100 && item.rect.height > 20)
          .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height));

        const editorText = elements.map(item => item.text).find(text => text.length > 5) || '';
        const editorLines = editorText.split('\n').map(normalize).filter(Boolean);
        const path = location.pathname.startsWith('/notes/note/') ? location.pathname : pagePath;
        if (!editorLines.length || !path.startsWith('/notes/note/')) return null;
        const encoded = path.split('/').pop();
        const decoded = (() => {
          try {
            const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
            return new TextDecoder().decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0)));
          } catch {
            return null;
          }
        })();
        const parts = decoded?.split('::') || [];
        return {
          externalId: `icloud-url:${path}`,
          cloudKit: decoded ? {
            recordId: decoded,
            database: parts[0] || null,
            zoneName: parts[1] || null,
            ownerName: parts[2] || null,
            recordName: parts.slice(3).join('::') || null
          } : null,
          title: editorLines[0] || 'Untitled',
          body: editorLines.slice(1).join('\n'),
          url: pageUrl,
          source: 'apple'
        };
      }, { offsetX: offset.x, offsetY: offset.y, pagePath: new URL(page.url()).pathname, pageUrl: page.url() }).catch(() => null);
      if (note) return note;
    }
    return null;
  }

  async scrollNoteList() {
    const page = await this.page();
    for (const { frame } of await this.framesWithOffsets(page)) {
      const scrolled = await frame.evaluate(() => {
      function roots(root = document) {
        const result = [root];
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) result.push(...roots(el.shadowRoot));
        }
        return result;
      }

      const candidates = roots()
        .flatMap(root => Array.from(root.querySelectorAll('*')))
        .map(el => {
          const rect = el.getBoundingClientRect();
          return { el, rect, scrollable: el.scrollHeight > el.clientHeight + 20 };
        })
        .filter(item => item.scrollable && item.rect.left >= 250 && item.rect.right <= 590 && item.rect.height > 200)
        .sort((a, b) => (b.rect.height * b.rect.width) - (a.rect.height * a.rect.width));
      const target = candidates[0]?.el;
      if (!target) return false;
      const before = target.scrollTop;
      target.scrollTop += Math.floor(target.clientHeight * 0.8);
      return target.scrollTop !== before;
      }).catch(() => false);
      if (scrolled) return true;
    }
    return false;
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

  async createNote({ title, body }) {
    const runtimeNote = await this.createRuntimeNote({ title, body });
    if (runtimeNote) return runtimeNote;

    const page = await this.page();
    await this.waitForNotesReady();
    const newNote = page.getByRole('button', { name: /new note|compose|create/i }).first();
    if (await newNote.count()) await newNote.click();
    else await page.mouse.click(1254, 70);
    await page.keyboard.type([title, body].filter(Boolean).join('\n'));
    return this.status();
  }

  async createRuntimeNote({ title, body }) {
    const fullText = [title || 'Untitled', body || ''].join('\n').trimEnd();
    return this.withNotesRuntime(async frame => frame.evaluate(async ({ text }) => {
      const app = window.NotesApp;
      const dataManager = app?.dataManager;
      const selected = app?.mainViewModel?.selectedNote;
      if (!dataManager || !selected) return null;
      const Note = selected.constructor;
      const folder = (dataManager.allFolders || []).find(item => String(item.recordName) === 'DefaultFolder-CloudKit')
        || (dataManager.allFolders || []).find(item => String(item.Title) === 'Notes')
        || selected.getFolder?.();
      const note = Note.createNoteWithTitleText(text, folder);
      dataManager.userDidCreateNote(note);
      await note.save(true);
      return noteToDocument(note, text);

      function noteToDocument(note, fallbackText) {
        const id = String(note.id || '');
        const parts = id.split('::');
        const path = id ? `/notes/note/${btoa(unescape(encodeURIComponent(id)))}` : null;
        const title = String(note.Title || fallbackText.split('\n')[0] || 'Untitled').trim() || 'Untitled';
        const body = fallbackText.startsWith(title) ? fallbackText.slice(title.length).replace(/^\n/, '') : fallbackText;
        return {
          externalId: path ? `icloud-url:${path}` : `icloud-record:${id || title}`,
          cloudKit: id ? {
            recordId: id,
            database: parts[0] || null,
            zoneName: parts[1] || null,
            ownerName: parts[2] || null,
            recordName: parts.slice(3).join('::') || null
          } : null,
          title,
          body,
          url: path ? `https://www.icloud.com${path}` : location.href,
          source: 'apple',
          partial: false
        };
      }
    }, { text: fullText }));
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
    return this.updateRuntimeNote({ externalId, appendText: text });
  }

  async updateRuntimeNote({ externalId, body, appendText }) {
    const recordId = recordIdFromExternalId(externalId);
    if (!recordId) return null;
    return this.withNotesRuntime(async frame => frame.evaluate(async ({ recordId, body, appendText }) => {
      const app = window.NotesApp;
      const dataManager = app?.dataManager;
      const notes = dataManager?.allNotes;
      if (!Array.isArray(notes)) return null;
      const note = notes.find(item => String(item.id) === recordId);
      if (!note || typeof note.getTopoText !== 'function') return null;
      const currentText = String(await note.getTopoText() || '').trimEnd();
      const nextText = body == null ? [currentText, appendText].filter(Boolean).join('\n') : String(body);
      const replacement = note.constructor.createInitialTopoTextString(nextText);
      dataManager.topoTextManager.load(note.id, replacement);
      note.userDidChangeTopoText();
      await note.save(true);
      return noteToDocument(note, nextText);

      function noteToDocument(note, text) {
        const id = String(note.id || '');
        const parts = id.split('::');
        const path = id ? `/notes/note/${btoa(unescape(encodeURIComponent(id)))}` : null;
        const title = String(note.Title || text.split('\n')[0] || 'Untitled').trim() || 'Untitled';
        const noteBody = text.startsWith(title) ? text.slice(title.length).replace(/^\n/, '') : text;
        return {
          externalId: path ? `icloud-url:${path}` : `icloud-record:${id || title}`,
          cloudKit: id ? {
            recordId: id,
            database: parts[0] || null,
            zoneName: parts[1] || null,
            ownerName: parts[2] || null,
            recordName: parts.slice(3).join('::') || null
          } : null,
          title,
          body: noteBody,
          url: path ? `https://www.icloud.com${path}` : location.href,
          source: 'apple',
          partial: false
        };
      }
    }, { recordId, body, appendText }));
  }

  async deleteExternalNote(externalId) {
    const recordId = recordIdFromExternalId(externalId);
    if (!recordId) return false;
    const result = await this.withNotesRuntime(async frame => frame.evaluate(async ({ recordId }) => {
      const notes = window.NotesApp?.dataManager?.allNotes;
      if (!Array.isArray(notes)) return false;
      const note = notes.find(item => String(item.id) === recordId);
      if (!note || typeof note.deleteOrMoveToRecentlyDeletedAsNeeded !== 'function') return false;
      await note.deleteOrMoveToRecentlyDeletedAsNeeded();
      return true;
    }, { recordId }));
    return Boolean(result);
  }

  async screenshot() {
    const page = await this.page();
    return page.screenshot({ type: 'jpeg', quality: 75 });
  }

  async inspectNotesRuntime() {
    const page = await this.page();
    await this.waitForNotesReady();
    const frames = await this.framesWithOffsets(page);
    const results = [];
    for (const { frame } of frames) {
      const result = await frame.evaluate(() => {
        const interesting = /notes|cloud|ck|data|application|debug|topo|model|store|record/i;
        const safeKeys = value => {
          try {
            if (!value || (typeof value !== 'object' && typeof value !== 'function')) return [];
            return Object.keys(value).slice(0, 80);
          } catch {
            return [];
          }
        };
        const summarize = key => {
          try {
            const value = window[key];
            return {
              key,
              type: typeof value,
              constructor: value?.constructor?.name || null,
              keys: safeKeys(value)
            };
          } catch (error) {
            return { key, error: error.message };
          }
        };
        const cloudKitRequests = performance.getEntriesByType('resource')
          .map(entry => entry.name)
          .filter(name => /ckdatabasews|gateway|com\.apple\.notes|records\//i.test(name))
          .slice(-60);
        const globals = Object.keys(window).filter(key => interesting.test(key)).sort().slice(0, 120);
        const known = ['NotesApp', 'Application', 'CloudKit', 'CK', 'Debug']
          .filter(key => key in window)
          .map(summarize);
        return {
          href: location.href,
          title: document.title,
          path: location.pathname,
          globals,
          known,
          cloudKitRequests,
          notePath: location.pathname.startsWith('/notes/note/') ? location.pathname : null
        };
      }).catch(error => ({ url: frame.url(), error: error.message }));
      results.push({ url: frame.url(), result });
    }
    return {
      page: await this.status(),
      currentNote: await this.currentNote().catch(() => null),
      frames: results
    };
  }

  async withNotesRuntime(callback) {
    const page = await this.page();
    await this.waitForNotesReady();
    for (const { frame } of await this.framesWithOffsets(page)) {
      const hasRuntime = await frame.evaluate(() => Boolean(window.NotesApp?.dataManager)).catch(() => false);
      if (!hasRuntime) continue;
      return callback(frame);
    }
    return null;
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

function decodeNotePath(pathname) {
  const encoded = String(pathname || '').split('/').pop();
  if (!encoded) return null;
  try {
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
    const recordId = Buffer.from(base64, 'base64').toString('utf8');
    const parts = recordId.split('::');
    return {
      recordId,
      database: parts[0] || null,
      zoneName: parts[1] || null,
      ownerName: parts[2] || null,
      recordName: parts.slice(3).join('::') || null
    };
  } catch {
    return null;
  }
}

function recordIdFromExternalId(externalId) {
  const match = String(externalId || '').match(/^icloud-url:(\/notes\/note\/.+)$/);
  if (!match) return null;
  return decodeNotePath(match[1])?.recordId || null;
}
