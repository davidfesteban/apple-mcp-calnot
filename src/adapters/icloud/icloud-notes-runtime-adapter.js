import { ICloudNoteUrl } from '../../models/icloud-note-url.js';
import { NoteDocument } from '../../models/note-document.js';

export class ICloudNotesRuntimeAdapter {
  constructor(browser) {
    this.browser = browser;
  }

  async listNotes() {
    const snapshots = (await this.browser.withNotesRuntime(frame => frame.evaluate(async () => {
      const allNotes = window.NotesApp?.dataManager?.allNotes;
      if (!Array.isArray(allNotes)) return [];

      const activeNotes = allNotes.filter(note => {
        if (!note) return false;
        return !truthyValue(note, 'Deleted') && !truthyValue(note, 'isInTrashOrDeleted');
      });
      const results = [];
      for (const note of activeNotes) {
        const text = await textOf(note);
        results.push(noteSnapshot(note, text));
      }
      return results;

      function valueOf(note, key) {
        try {
          const value = note?.[key];
          return value == null ? null : value;
        } catch {
          return null;
        }
      }

      async function textOf(note) {
        let topo = valueOf(note, 'TopoTextString');
        if (!topo && typeof note?.getTopoText === 'function') {
          try {
            topo = await note.getTopoText();
          } catch {
            topo = null;
          }
        }
        const searchable = valueOf(note, '_searchableText');
        return String(topo || searchable || '').replace(/\u00a0/g, ' ').trimEnd();
      }

      function truthyValue(note, key) {
        const value = valueOf(note, key);
        return typeof value === 'function' ? Boolean(value.call(note)) : Boolean(value);
      }

      function noteSnapshot(note, text) {
        return {
          recordId: String(valueOf(note, 'id') || ''),
          title: String(valueOf(note, 'Title') || text.split('\n')[0] || 'Untitled'),
          text,
          createdAt: dateValue(note, 'created', ['CreationDate', 'creationDate', 'createdAt', 'DateCreated', 'createDate', 'dateCreated', 'createdDate']),
          modifiedAt: dateValue(note, 'modified', ['ModificationDate', 'modificationDate', 'modifiedAt', 'DateModified', 'lastModifiedDate', 'dateModified', 'updatedAt', 'lastChangeDate']),
          url: location.href,
          partial: false
        };
      }

      function dateValue(note, kind, keys) {
        const prioritizedKeys = [
          ...keys,
          ...discoverDateKeys(note, kind)
        ];
        const seen = new Set();
        const scoredDates = [];

        for (const key of prioritizedKeys) {
          if (typeof key !== 'string' || seen.has(key)) continue;
          seen.add(key);
          const date = normalizeDate(note, valueOf(note, key), key);
          if (!date) continue;
          scoredDates.push({ key: key.toLowerCase(), date, score: dateScore(key, kind) });
        }
        scoredDates.sort((a, b) => b.score - a.score);
        return scoredDates[0]?.date || null;
      }

      function dateScore(key, kind) {
        const normalized = String(key || '').toLowerCase();
        if (kind === 'modified' && /(modified|updated|last|change|edit)/.test(normalized)) return 100;
        if (kind === 'created' && /(create|created|new)/.test(normalized)) return 100;
        return 10;
      }

      function discoverDateKeys(note, kind) {
        const keys = [];
        const seen = new Set();
        let current = note;
        let depth = 0;
        const maxDepth = 2;
        while (current && typeof current === 'object' && depth <= maxDepth) {
          try {
            for (const key of Object.getOwnPropertyNames(current)) {
              if (typeof key !== 'string' || seen.has(key)) continue;
              if (!/date|time|modified|created|updated|change|stamp|timestamp|sort/i.test(key)) continue;
              if (/(toString|toJSON|valueOf|constructor|prototype|hasOwnProperty|isPrototypeOf|propertyIsEnumerable|__defineGetter__|__defineSetter__)/i.test(key)) continue;
              keys.push(key);
              seen.add(key);
            }
          } catch {}
          current = Object.getPrototypeOf(current);
          depth += 1;
        }
        return [
          ...keys.filter(key => (kind === 'modified' ? /(modified|updated|change)/i.test(key) : /(create|created)/i.test(key))),
          ...keys.filter(key => (kind === 'modified' ? !/(modified|updated|change)/i.test(key) : !/(create|created)/i.test(key)))
        ];
      }

      function normalizeDate(note, value, keyHint = '') {
        if (value == null) return null;
        const raw = typeof value === 'function' ? safeInvoke(note, value) : value;
        const date = toDate(raw, keyHint);
        return toIso(date);
      }

      function normalizeNestedDate(raw, keyHint = '') {
        const nested = raw;
        const referenceInterval = maybeNumber(nested?.timeIntervalSinceReferenceDate);
        if (referenceInterval != null) return new Date((referenceInterval * 1000) + 978307200000);
        const unixInterval = maybeNumber(nested?.timeIntervalSinceNow1970) ?? maybeNumber(nested?.timeIntervalSince1970);
        if (unixInterval != null) return toDateFromNumber(unixInterval, keyHint);
        const nestedTime = maybeNumber(nested?.time ?? nested?.timestamp);
        if (nestedTime != null) return toDateFromNumber(nestedTime, keyHint);
        const nestedTimeMs = maybeNumber(nested?.timeIntervalSinceReferenceDateMs);
        if (nestedTimeMs != null) return new Date(nestedTimeMs);
        if (typeof nested?.toDate === 'function') {
          try {
            const converted = nested.toDate();
            if (converted instanceof Date) return converted;
          } catch {}
        }
        return null;
      }

      function safeInvoke(context, fn, keyHint = '') {
        try {
          return fn.call(context);
        } catch {
          return null;
        }
      }

      function toDate(raw, keyHint = '') {
        if (raw instanceof Date) return raw;
        if (raw == null) return null;
        if (typeof raw === 'number' || typeof raw === 'bigint') return toDateFromNumber(Number(raw), keyHint);
        if (typeof raw === 'string') {
          const trimmed = raw.trim();
          if (!trimmed) return null;
          const numeric = Number(trimmed);
          if (Number.isFinite(numeric) && String(numeric) === trimmed) {
            return toDateFromNumber(numeric, keyHint);
          }
          const parsed = new Date(trimmed);
          return isLikelyNotesDate(parsed, keyHint) ? parsed : null;
        }
        if (typeof raw === 'object') {
          const nested = normalizeNestedDate(raw, keyHint);
          if (nested) return nested;
          const numeric = Number(raw);
          if (Number.isFinite(numeric)) return toDateFromNumber(numeric, keyHint);
        }
        return null;
      }

      function toDateFromNumber(raw, keyHint = '') {
        if (!Number.isFinite(raw) || raw <= 0) return null;
        const candidates = [];
        if (raw > 1e12 && raw < 1e17) {
          candidates.push(raw);
        } else if (raw > 1e9 && raw < 2e10) {
          candidates.push(raw * 1000);
        } else if (raw > 5e8 && raw <= 1e9) {
          candidates.push((raw * 1000) + 978307200000);
          candidates.push(raw * 1000);
        } else if (raw > 1e6) {
          candidates.push(raw * 1000);
        }
        const unique = [...new Set(candidates.map(candidate => Number(candidate)))];
        const parsed = [];
        for (const candidate of unique) {
          const date = new Date(candidate);
          if (isLikelyNotesDate(date, keyHint)) parsed.push(date);
        }
        if (!parsed.length) return null;
        parsed.sort((a, b) => b.getTime() - a.getTime());
        return parsed[0];
      }

      function isLikelyNotesDate(date, keyHint) {
        const year = date.getUTCFullYear();
        const isRecent = year > 1970 && year < 2100;
        const hint = String(keyHint || '').toLowerCase();
        if (!isRecent) return false;
        if (/(created|creation)/.test(hint)) return year > 1990;
        return true;
      }

      function toIso(date) {
        if (!(date instanceof Date)) return null;
        const epoch = date.getTime();
        if (!Number.isFinite(epoch)) return null;
        return new Date(epoch).toISOString();
      }

      function maybeNumber(value) {
        if (!Number.isFinite(Number(value))) return null;
        return Number(value);
      }
    }))) || [];
    return snapshots.map(snapshot => NoteDocument.appleSnapshotObject(snapshot));
  }

  async createNote({ title, body }) {
    const fullText = [title || 'Untitled', body || ''].join('\n').trimEnd();
    const snapshot = await this.browser.withNotesRuntime(frame => frame.evaluate(async ({ text }) => {
      const dataManager = window.NotesApp?.dataManager;
      const selected = window.NotesApp?.mainViewModel?.selectedNote;
      if (!dataManager || !selected) return null;

      const Note = selected.constructor;
      const folder = (dataManager.allFolders || []).find(item => String(item.recordName) === 'DefaultFolder-CloudKit')
        || (dataManager.allFolders || []).find(item => String(item.Title) === 'Notes')
        || selected.getFolder?.();
      const note = Note.createNoteWithTitleText(text, folder);
      dataManager.userDidCreateNote(note);
      await note.save(true);
      const createdAt = toOptionalIso(note.CreationDate ?? note.creationDate ?? note.DateCreated ?? note.createdAt ?? note.createDate);
      const modifiedAt = toOptionalIso(note.ModificationDate ?? note.modificationDate ?? note.DateModified ?? note.modifiedAt ?? note.lastModifiedDate ?? new Date());
      return {
        recordId: String(note.id || ''),
        title: String(note.Title || text.split('\n')[0] || 'Untitled'),
        text,
        createdAt,
        modifiedAt,
        url: location.href,
        partial: false
      };

      function toOptionalIso(value) {
        try {
          return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
        } catch {
          return null;
        }
      }
    }, { text: fullText }));

    return snapshot ? NoteDocument.appleSnapshotObject(snapshot) : null;
  }

  async updateNote({ externalId, body, appendText }) {
    const recordId = ICloudNoteUrl.recordIdFromExternalId(externalId);
    if (!recordId) return null;
    const snapshot = await this.browser.withNotesRuntime(frame => frame.evaluate(async ({ recordId, body, appendText }) => {
      const dataManager = window.NotesApp?.dataManager;
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
      const createdAt = toOptionalIso(note.CreationDate ?? note.creationDate ?? note.DateCreated ?? note.createdAt ?? note.createDate);
      const modifiedAt = toOptionalIso(note.ModificationDate ?? note.modificationDate ?? note.DateModified ?? note.modifiedAt ?? note.lastModifiedDate ?? new Date());
      return {
        recordId: String(note.id || ''),
        title: String(note.Title || nextText.split('\n')[0] || 'Untitled'),
        text: nextText,
        createdAt,
        modifiedAt,
        url: location.href,
        partial: false
      };

      function toOptionalIso(value) {
        try {
          return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
        } catch {
          return null;
        }
      }
    }, { recordId, body, appendText }));

    return snapshot ? NoteDocument.appleSnapshotObject(snapshot) : null;
  }

  async deleteNote(externalId) {
    const recordId = ICloudNoteUrl.recordIdFromExternalId(externalId);
    if (!recordId) return false;
    const result = await this.browser.withNotesRuntime(frame => frame.evaluate(async ({ recordId }) => {
      const notes = window.NotesApp?.dataManager?.allNotes;
      if (!Array.isArray(notes)) return false;
      const note = notes.find(item => String(item.id) === recordId);
      if (!note || typeof note.deleteOrMoveToRecentlyDeletedAsNeeded !== 'function') return false;
      await note.deleteOrMoveToRecentlyDeletedAsNeeded();
      return true;
    }, { recordId }));
    return Boolean(result);
  }

  async inspect() {
    const page = await this.browser.page();
    await this.browser.waitForNotesReady();
    const frames = await this.browser.framesWithOffsets(page);
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
      page: await this.browser.status(),
      currentNote: await this.browser.currentNote().catch(() => null),
      frames: results
    };
  }
}
