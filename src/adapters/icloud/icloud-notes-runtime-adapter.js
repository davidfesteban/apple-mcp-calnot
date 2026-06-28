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
          createdAt: dateValue(note, ['CreationDate', 'creationDate', 'createdAt', 'DateCreated']),
          modifiedAt: dateValue(note, ['ModificationDate', 'modificationDate', 'modifiedAt', 'DateModified', 'lastModifiedDate']),
          url: location.href,
          partial: false
        };
      }

      function dateValue(note, keys) {
        for (const key of keys) {
          const value = valueOf(note, key);
          const date = normalizeDate(note, value);
          if (date) return date;
        }
        return null;
      }

      function normalizeDate(note, value) {
        if (!value) return null;
        try {
          const raw = typeof value === 'function' ? value.call(note) : value;
          const date = raw instanceof Date ? raw : new Date(raw);
          return Number.isNaN(date.getTime()) ? null : date.toISOString();
        } catch {
          return null;
        }
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
      return {
        recordId: String(note.id || ''),
        title: String(note.Title || text.split('\n')[0] || 'Untitled'),
        text,
        createdAt: note.CreationDate || note.creationDate || null,
        modifiedAt: note.ModificationDate || note.modificationDate || new Date().toISOString(),
        url: location.href,
        partial: false
      };
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
      return {
        recordId: String(note.id || ''),
        title: String(note.Title || nextText.split('\n')[0] || 'Untitled'),
        text: nextText,
        createdAt: note.CreationDate || note.creationDate || null,
        modifiedAt: new Date().toISOString(),
        url: location.href,
        partial: false
      };
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
