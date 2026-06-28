export class CloudKitRef {
  constructor({ recordId, database = null, zoneName = null, ownerName = null, recordName = null }) {
    this.recordId = String(recordId || '');
    this.database = database;
    this.zoneName = zoneName;
    this.ownerName = ownerName;
    this.recordName = recordName;
  }

  static fromRecordId(recordId) {
    if (!recordId) return null;
    const parts = String(recordId).split('::');
    return new CloudKitRef({
      recordId,
      database: parts[0] || null,
      zoneName: parts[1] || null,
      ownerName: parts[2] || null,
      recordName: parts.slice(3).join('::') || null
    });
  }

  static fromNotePath(pathname) {
    const encoded = String(pathname || '').match(/^\/notes\/note\/(.+)$/)?.[1];
    if (!encoded) return null;
    try {
      const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
      return CloudKitRef.fromRecordId(Buffer.from(base64, 'base64').toString('utf8'));
    } catch {
      return null;
    }
  }

  toJSON() {
    return {
      recordId: this.recordId,
      database: this.database,
      zoneName: this.zoneName,
      ownerName: this.ownerName,
      recordName: this.recordName
    };
  }
}
