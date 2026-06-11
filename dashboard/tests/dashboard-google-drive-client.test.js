'use strict';

/**
 * Google-Drive-Client (Systemgrenze) — Issue #162 (Stufe 6 Slice 2), für WF9 Pickliste.
 * OAuth2-Refresh-Token-Flow + Drive v3 list/download/move. HTTP wird im Test gefaked.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { createGoogleDriveClient, buildTokenRequest } = require('../lib/google-drive-client.js');

function fakeFetch(responses) {
  const calls = [];
  return {
    calls,
    impl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      const r = responses.shift();
      if (!r) throw new Error('fakeFetch: keine Antwort mehr');
      return {
        ok: r.ok !== false,
        status: r.status || 200,
        text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body || {})),
        json: async () => r.body,
        arrayBuffer: async () => r.bytes || Buffer.from(''),
      };
    },
  };
}

test('#162 buildTokenRequest: OAuth-Refresh-Body korrekt', () => {
  const { url, body } = buildTokenRequest({ clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt' });
  assert.match(url, /oauth2\.googleapis\.com\/token/);
  assert.match(body, /grant_type=refresh_token/);
  assert.match(body, /refresh_token=rt/);
  assert.match(body, /client_id=cid/);
});

test('#162 Drive: Access-Token wird geholt und gecached (kein zweiter Token-POST)', async () => {
  const f = fakeFetch([
    { body: { access_token: 'AT1', expires_in: 3600 } }, // token
    { body: { files: [] } }, // listNew #1
    { body: { files: [] } }, // listNew #2
  ]);
  const drive = createGoogleDriveClient({
    clientId: 'c', clientSecret: 's', refreshToken: 'r',
    sourceFolderId: 'SRC', processedFolderId: 'DST', fetchImpl: f.impl,
  });
  await drive.listNew();
  await drive.listNew();
  const tokenCalls = f.calls.filter((c) => c.url.includes('/token'));
  assert.equal(tokenCalls.length, 1, 'Token nur einmal geholt (gecached)');
});

test('#162 Drive.listNew: q-Filter mit Quell-Ordner, PDF, nicht im Papierkorb', async () => {
  const f = fakeFetch([
    { body: { access_token: 'AT', expires_in: 3600 } },
    { body: { files: [{ id: 'f1', name: 'pick.pdf' }] } },
  ]);
  const drive = createGoogleDriveClient({ clientId: 'c', clientSecret: 's', refreshToken: 'r', sourceFolderId: 'SRC', processedFolderId: 'DST', fetchImpl: f.impl });
  const files = await drive.listNew();
  assert.deepEqual(files, [{ id: 'f1', name: 'pick.pdf' }]);
  const listUrl = decodeURIComponent(f.calls[1].url);
  assert.match(listUrl, /'SRC' in parents/);
  assert.match(listUrl, /trashed\s*=\s*false/);
  assert.match(listUrl, /application\/pdf/);
});

test('#162 Drive.download: liefert base64 + mimeType', async () => {
  const f = fakeFetch([
    { body: { access_token: 'AT', expires_in: 3600 } },
    { bytes: Buffer.from('PDFDATA') }, // alt=media
  ]);
  const drive = createGoogleDriveClient({ clientId: 'c', clientSecret: 's', refreshToken: 'r', sourceFolderId: 'SRC', processedFolderId: 'DST', fetchImpl: f.impl });
  const out = await drive.download('f1');
  assert.equal(out.base64, Buffer.from('PDFDATA').toString('base64'));
  assert.equal(out.mimeType, 'application/pdf');
  assert.match(f.calls[1].url, /files\/f1\?alt=media/);
});

test('#162 Drive.move: PATCH addParents=DST removeParents=SRC', async () => {
  const f = fakeFetch([
    { body: { access_token: 'AT', expires_in: 3600 } },
    { body: { id: 'f1' } }, // patch
  ]);
  const drive = createGoogleDriveClient({ clientId: 'c', clientSecret: 's', refreshToken: 'r', sourceFolderId: 'SRC', processedFolderId: 'DST', fetchImpl: f.impl });
  await drive.move('f1');
  const patch = f.calls[1];
  assert.equal((patch.init.method || '').toUpperCase(), 'PATCH');
  assert.match(patch.url, /files\/f1/);
  assert.match(patch.url, /addParents=DST/);
  assert.match(patch.url, /removeParents=SRC/);
});

test('#162 buildDriveFromEnv: ohne Token ⇒ disabled', () => {
  const { buildDriveFromEnv } = require('../lib/google-drive-client.js');
  assert.equal(buildDriveFromEnv({}).kind, 'disabled');
  const live = buildDriveFromEnv({
    GOOGLE_DRIVE_CLIENT_ID: 'c', GOOGLE_DRIVE_CLIENT_SECRET: 's', GOOGLE_DRIVE_REFRESH_TOKEN: 'r',
    GOOGLE_DRIVE_PICKLIST_FOLDER_ID: 'SRC', GOOGLE_DRIVE_PROCESSED_FOLDER_ID: 'DST',
  }, { fetchImpl: async () => ({}) });
  assert.equal(live.kind, 'live');
  assert.ok(live.drive && typeof live.drive.listNew === 'function');
});

// ── n8n-Ablösung 2026-06-11: Drive-Upload + Invoice-Ordnerpaar ────────────────

const { buildInvoiceDriveFromEnv } = require('../lib/google-drive-client.js');

test('Drive.upload: multipart/related mit Metadata (parents=SRC) + base64-Body, gibt id zurück', async () => {
  const f = fakeFetch([
    { body: { access_token: 'AT', expires_in: 3600 } },
    { body: { id: 'up1', name: 'rechnung.pdf' } },
  ]);
  const drive = createGoogleDriveClient({
    clientId: 'c', clientSecret: 's', refreshToken: 'r',
    sourceFolderId: 'SRC', processedFolderId: 'DST', fetchImpl: f.impl,
  });
  const res = await drive.upload('rechnung.pdf', Buffer.from('PDFDATA'), 'application/pdf');
  assert.equal(res.id, 'up1');
  const call = f.calls.find((c) => c.url.includes('/upload/drive/v3/files'));
  assert.ok(call, 'Upload-Endpoint aufgerufen');
  assert.match(call.url, /uploadType=multipart/);
  assert.match(String(call.init.headers['content-type']), /multipart\/related; boundary=/);
  const body = call.init.body.toString('utf8');
  assert.match(body, /"parents":\["SRC"\]/, 'Datei landet im Quell-Ordner');
  assert.match(body, /content-transfer-encoding: base64/);
  assert.ok(body.includes(Buffer.from('PDFDATA').toString('base64')), 'Inhalt base64-kodiert');
});

test('Drive.upload: HTTP-Fehler wirft (nicht still verschluckt)', async () => {
  const f = fakeFetch([
    { body: { access_token: 'AT', expires_in: 3600 } },
    { ok: false, status: 403, body: { error: 'nope' } },
  ]);
  const drive = createGoogleDriveClient({
    clientId: 'c', clientSecret: 's', refreshToken: 'r',
    sourceFolderId: 'SRC', processedFolderId: 'DST', fetchImpl: f.impl,
  });
  await assert.rejects(() => drive.upload('x.pdf', Buffer.from('X'), 'application/pdf'), /drive\.upload 403/);
});

test('buildInvoiceDriveFromEnv: disabled ohne Invoice-Ordner; live mit eigenem Ordnerpaar', () => {
  const base = { GOOGLE_DRIVE_CLIENT_ID: 'c', GOOGLE_DRIVE_CLIENT_SECRET: 's', GOOGLE_DRIVE_REFRESH_TOKEN: 'r' };
  // Picklisten-Ordner reichen NICHT (eigenes Paar Pflicht — sonst pollt WF1 wieder die Pickliste)
  assert.equal(buildInvoiceDriveFromEnv({ ...base, GOOGLE_DRIVE_PICKLIST_FOLDER_ID: 'P', GOOGLE_DRIVE_PROCESSED_FOLDER_ID: 'Q' }).kind, 'disabled');
  const live = buildInvoiceDriveFromEnv({ ...base, GOOGLE_DRIVE_INVOICE_FOLDER_ID: 'INV', GOOGLE_DRIVE_INVOICE_PROCESSED_FOLDER_ID: 'DONE' });
  assert.equal(live.kind, 'live');
  assert.ok(live.drive && typeof live.drive.upload === 'function');
});
