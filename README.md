# Apple MCP Calnot

Local MCP/WebUI bridge for iCloud Notes.

The app keeps an authenticated iCloud Notes browser session alive, syncs notes into MongoDB, and exposes note operations through MCP.

## Commands

```bash
make start
make stop
make clean
```

- `make start` starts Docker Compose without rebuilding and preserves volumes/session state.
- `make stop` stops containers and preserves volumes/session state.
- `make clean` removes containers and volumes. This wipes MongoDB and the browser profile, so iCloud login will be required again.

To apply code changes to the app container while preserving volumes/session:

```bash
docker compose up -d --build mcp-notes
```

## Login Flow

1. Open the WebUI at `http://localhost:3000`.
2. Click `Generate Code`.
3. Copy the generated code.
4. Log into iCloud in the embedded browser view.
5. Click `Start`.
6. After start, WebUI/API/MCP access requires the generated code.

The browser profile is persisted in the Docker volume mounted at `/data`, so normal `make stop` / `make start` should keep the iCloud session.

## Current Architecture

```text
WebUI / MCP
    |
NotesProcessor
    |
BrowserController
    |
Playwright authenticated iCloud page
    |
iCloud Notes iframe
    |
window.NotesApp
    |
NotesApp.dataManager.allNotes
    |
note.getTopoText()
    |
MongoDB
```

Playwright is still useful, but not for OCR or visual scraping. It is used to keep an authenticated iCloud page open and to evaluate JavaScript inside the iCloud Notes iframe.

## iCloud Notes Discovery

We originally saw note content rendered through a canvas-like/custom editor surface. OCR was rejected because it is unreliable and loses structure. The important discovery is that the visible editor is only the presentation layer; the real Notes model is available in the running iCloud web app.

The path to discovery was:

1. The top-level iCloud HTML showed that `/notes` bootstraps a child application iframe.
2. The bootstrap script resolves `/notes` to `notes3`.
3. It creates an iframe with id `early-child`.
4. That iframe loads:

```text
https://www.icloud.com/applications/notes3/current/en-us/index.html?rootDomain=www...
```

5. Safari Apple Events inspection confirmed the top page has that iframe.
6. Inspecting `document.querySelector('iframe').contentWindow` showed these globals:

```text
CloudKit
NotesApp
```

7. Drilling into `window.NotesApp` showed:

```text
NotesApp.dataManager
NotesApp.mainViewModel
NotesApp.rootViewController
```

8. `NotesApp.dataManager.allNotes` contains the loaded note models.
9. `NotesApp.mainViewModel.selectedNote` points to the selected note.
10. Each note model exposes Notes-specific fields and helpers:

```text
id
recordName
Title
Snippet
TopoTextString
getTopoText()
CreationDate
ModificationDate
zoneID
```

`note.getTopoText()` loads/decodes the full note body using Apple's own app code. This avoids OCR, canvas parsing, and reimplementing Apple's TopoText decoder.

## CloudKit vs NotesApp

`CloudKit` is Apple's generic iCloud database transport layer. It talks to endpoints such as:

```text
ckdatabasews/.../database/1/com.apple.notes/production/private/records/query
ckdatabasews/.../database/1/com.apple.notes/production/private/records/lookup
ckdatabasews/.../database/1/com.apple.notes/production/private/changes/zone
```

`NotesApp` is the running iCloud Notes web application loaded inside the iframe. It wraps CloudKit, owns UI/application state, manages folders and notes, and decodes Notes-specific content.

For this project, `NotesApp` is the preferred first integration point because it already exposes decoded note models:

```js
const notesWindow = document.querySelector('iframe').contentWindow;
const notes = notesWindow.NotesApp.dataManager.allNotes;
const body = String(await notes[0].getTopoText());
```

Direct CloudKit access is still useful later for lower-level sync/write operations, but it requires handling raw record fields, assets, zipped protobuf TopoText, and write semantics.

## Stable Note Identity

iCloud note URLs contain the CloudKit identity encoded as base64:

```text
/notes/note/<base64>
```

Decoding the URL path gives:

```text
Private::Notes::currentUser::<recordName>
```

Example observed from Safari:

```text
Private::Notes::currentUser::ADAC358D-E303-4639-A5C2-192AE0726967
```

The sync stores this metadata as `cloudKit`:

```json
{
  "recordId": "Private::Notes::currentUser::<recordName>",
  "database": "Private",
  "zoneName": "Notes",
  "ownerName": "currentUser",
  "recordName": "<recordName>"
}
```

## Sync Strategy

The current read path is:

1. Open or reuse the authenticated iCloud Notes page.
2. Find the Notes iframe.
3. Evaluate JavaScript inside the iframe.
4. Read `NotesApp.dataManager.allNotes`.
5. Filter deleted/trash notes.
6. Await `note.getTopoText()` for each note.
7. Store title, body, URL identity, and CloudKit metadata in MongoDB.

The older DOM/card scraper remains only as a fallback.

## Write Strategy

Safari runtime testing confirmed that create, update, and delete can be driven through `NotesApp` directly.

Observed working methods:

```js
const app = document.querySelector('iframe').contentWindow.NotesApp;
const dataManager = app.dataManager;
const Note = app.mainViewModel.selectedNote.constructor;
```

Create:

```js
const note = Note.createNoteWithTitleText(fullText, folder);
dataManager.userDidCreateNote(note);
await note.save(true);
```

Update:

```js
const replacement = Note.createInitialTopoTextString(nextText);
dataManager.topoTextManager.load(note.id, replacement);
note.userDidChangeTopoText();
await note.save(true);
```

Delete:

```js
await note.deleteOrMoveToRecentlyDeletedAsNeeded();
```

The delete path moves normal private notes to Recently Deleted, matching the web app behavior.

The probe used a temporary note and verified:

- create through `Note.createNoteWithTitleText`
- update through `topoTextManager.load` and `userDidChangeTopoText`
- delete through `deleteOrMoveToRecentlyDeletedAsNeeded`
- stable CloudKit identity persisted as `Private::Notes::currentUser::<recordName>`

MCP writes now use this runtime path first. UI keyboard fallback remains only as a backup for append/create.

## What Not To Do

- Do not use OCR/Tesseract for note bodies.
- Do not treat canvas pixels as the source of truth.
- Do not identify notes by title; titles are mutable and non-unique.
- Do not use `make clean` unless you intentionally want to wipe browser and database persistence.

## Validation

```bash
npm run check
```

## MCP Endpoint

The MCP server is exposed at:

```text
POST /mcp
```

Authentication accepts any of:

```text
Authorization: Bearer <generated-code>
X-Auth-Token: <generated-code>
?token=<generated-code>
apple_mcp_token cookie
```

The server advertises these MCP tools:

```text
listNotes
getNote
searchNotes
createNote
appendNote
deleteNote
```

For ChatGPT testing, expose the app over HTTPS and configure the MCP URL as:

```text
https://your-domain.example/mcp?token=<generated-code>
```

Using the token in the URL is convenient for testing because the current server uses a generated static code, not OAuth. For a durable public deployment, prefer adding OAuth or a reverse proxy that injects the bearer token server-side, so the code is not stored in connector URLs or logs.
