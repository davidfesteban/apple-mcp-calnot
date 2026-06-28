export class NoteText {
  static normalizeTitle(title) {
    return String(title || '').trim() || 'Untitled';
  }

  static normalizeBody(body) {
    return String(body || '');
  }

  static firstLine(text) {
    return NoteText.normalizeBody(text).split('\n')[0];
  }

  static bodyWithoutTitle(text, title) {
    return text.startsWith(title) ? text.slice(title.length).replace(/^\n/, '') : text;
  }
}
