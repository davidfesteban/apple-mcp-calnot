import { ICloudNoteUrl } from '../../models/icloud-note-url.js';
import { NoteDocument } from '../../models/note-document.js';

export class ICloudNotesDomScraper {
  constructor(browser) {
    this.browser = browser;
  }

  async scrapeNotes() {
    const page = await this.browser.page();
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

  noteFromTarget(target, url) {
    const path = new URL(url).pathname;
    if (!path.startsWith('/notes/note/')) return null;
    const lines = target.text.split(/\n| {2,}/).map(value => value.trim()).filter(Boolean);
    const cloudKit = ICloudNoteUrl.decodePath(path);
    return NoteDocument.appleSnapshotObject({
      recordId: cloudKit?.recordId,
      title: target.title || 'Untitled',
      text: [target.title || 'Untitled', ...lines.filter(line => line !== target.title)].join('\n'),
      url,
      partial: true
    });
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
    const page = await this.browser.page();
    const targets = [];
    for (const { frame, offset } of await this.browser.framesWithOffsets(page)) {
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
    const page = await this.browser.page();
    for (const { frame, offset } of await this.browser.framesWithOffsets(page)) {
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
        const encoded = path.match(/^\/notes\/note\/(.+)$/)?.[1];
        const decoded = (() => {
          try {
            const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
            return new TextDecoder().decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0)));
          } catch {
            return null;
          }
        })();
        return {
          recordId: decoded,
          title: editorLines[0] || 'Untitled',
          text: editorLines.join('\n'),
          url: pageUrl,
          partial: true
        };
      }, { offsetX: offset.x, offsetY: offset.y, pagePath: new URL(page.url()).pathname, pageUrl: page.url() }).catch(() => null);
      if (note) return NoteDocument.appleSnapshotObject(note);
    }
    return null;
  }

  async scrollNoteList() {
    const page = await this.browser.page();
    for (const { frame } of await this.browser.framesWithOffsets(page)) {
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
}
