import { CloudKitRef } from './cloud-kit-ref.js';
import { ICLOUD_URL_PREFIX } from './note-source.js';

export class ICloudNoteUrl {
  static decodePath(pathname) {
    return CloudKitRef.fromNotePath(pathname)?.toJSON() || null;
  }

  static recordIdFromExternalId(externalId) {
    const path = String(externalId || '').match(new RegExp(`^${ICLOUD_URL_PREFIX}(/notes/note/.+)$`))?.[1];
    return CloudKitRef.fromNotePath(path)?.recordId || null;
  }
}
