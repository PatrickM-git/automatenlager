'use strict';

/**
 * Google-Drive-Client (Systemgrenze) — Issue #162 (Stufe 6 Slice 2), für WF9 Pickliste.
 *
 * OAuth2-Refresh-Token-Flow (gleiche Credential wie n8n `googleDriveOAuth2Api`) +
 * Drive v3 list/download/move. Ersetzt den n8n-googleDriveTrigger + die Drive-Nodes.
 * Credentials/Ordner-IDs aus `.env.local`. HTTP über injizierbares fetch (Test fakt es).
 *
 *   - listNew()      → PDF-Dateien im Quell-Ordner (nicht im Papierkorb)
 *   - download(id)   → { base64, mimeType }  (alt=media)
 *   - move(id)       → addParents=verarbeitet, removeParents=quelle (Idempotenz)
 */

const { withTimeout } = require('./fetch-timeout.js');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

function buildTokenRequest({ clientId, clientSecret, refreshToken } = {}) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  }).toString();
  return { url: TOKEN_URL, body };
}

function createGoogleDriveClient({ clientId, clientSecret, refreshToken, sourceFolderId, processedFolderId, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('google-drive-client: fetch nicht verfügbar');
  let cachedToken = null;
  let tokenExpiresAt = 0;

  async function getAccessToken() {
    const nowMs = Date.now();
    if (cachedToken && nowMs < tokenExpiresAt - 60_000) return cachedToken;
    const { url, body } = buildTokenRequest({ clientId, clientSecret, refreshToken });
    const resp = await doFetch(url, withTimeout({
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    }));
    const text = await resp.text();
    if (!resp.ok) throw new Error(`google-oauth ${resp.status}: ${text.slice(0, 200)}`);
    const json = JSON.parse(text);
    cachedToken = json.access_token;
    tokenExpiresAt = nowMs + (Number(json.expires_in) || 3600) * 1000;
    if (!cachedToken) throw new Error('google-oauth: kein access_token erhalten');
    return cachedToken;
  }

  async function authedFetch(url, init = {}) {
    const token = await getAccessToken();
    return doFetch(url, withTimeout({ ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${token}` } }));
  }

  async function listNew() {
    const q = `'${sourceFolderId}' in parents and mimeType = 'application/pdf' and trashed = false`;
    const url = `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('files(id,name)')}&orderBy=createdTime`;
    const resp = await authedFetch(url);
    const text = await resp.text();
    if (!resp.ok) throw new Error(`drive.list ${resp.status}: ${text.slice(0, 200)}`);
    return (JSON.parse(text).files || []).map((f) => ({ id: f.id, name: f.name }));
  }

  async function download(fileId) {
    const resp = await authedFetch(`${DRIVE_API}/files/${fileId}?alt=media`);
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`drive.download ${resp.status}: ${t.slice(0, 200)}`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    return { base64: buf.toString('base64'), mimeType: 'application/pdf' };
  }

  async function move(fileId) {
    const url = `${DRIVE_API}/files/${fileId}?addParents=${processedFolderId}&removeParents=${sourceFolderId}&fields=id`;
    const resp = await authedFetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`drive.move ${resp.status}: ${t.slice(0, 200)}`);
    }
    return true;
  }

  // Datei in den Quell-Ordner hochladen (multipart/related, Drive v3 files.create).
  // Ersetzt den n8n-WF1-Upload-Webhook (n8n-Ablösung 2026-06-11): das Dashboard legt
  // Rechnungs-PDFs direkt im Rechnungseingang-Ordner ab; der Intake-Job pollt sie.
  async function upload(name, contentBuffer, mimeType) {
    if (!name || !contentBuffer || !contentBuffer.length) throw new TypeError('drive.upload: name + contentBuffer erforderlich');
    const boundary = `automatenlager-upload-${Date.now().toString(36)}`;
    const metadata = JSON.stringify({ name, parents: [sourceFolderId] });
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
        `--${boundary}\r\ncontent-type: ${mimeType || 'application/octet-stream'}\r\ncontent-transfer-encoding: base64\r\n\r\n`,
        'utf8',
      ),
      Buffer.from(contentBuffer.toString('base64'), 'utf8'),
      Buffer.from(`\r\n--${boundary}--`, 'utf8'),
    ]);
    const resp = await authedFetch(`${UPLOAD_API}/files?uploadType=multipart&fields=id,name`, {
      method: 'POST',
      headers: { 'content-type': `multipart/related; boundary=${boundary}` },
      body,
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`drive.upload ${resp.status}: ${text.slice(0, 200)}`);
    const json = JSON.parse(text);
    if (!json.id) throw new Error('drive.upload: keine Datei-ID erhalten');
    return { id: json.id, name: json.name || name };
  }

  return { listNew, download, move, upload, getAccessToken };
}

function buildDriveClientFromEnv(env, sourceVar, processedVar, { fetchImpl } = {}) {
  const clientId = String((env && env.GOOGLE_DRIVE_CLIENT_ID) || '').trim();
  const clientSecret = String((env && env.GOOGLE_DRIVE_CLIENT_SECRET) || '').trim();
  const refreshToken = String((env && env.GOOGLE_DRIVE_REFRESH_TOKEN) || '').trim();
  const sourceFolderId = String((env && env[sourceVar]) || '').trim();
  const processedFolderId = String((env && env[processedVar]) || '').trim();
  if (!clientId || !clientSecret || !refreshToken || !sourceFolderId || !processedFolderId) {
    return { kind: 'disabled', drive: null };
  }
  return {
    kind: 'live',
    drive: createGoogleDriveClient({ clientId, clientSecret, refreshToken, sourceFolderId, processedFolderId, fetchImpl }),
  };
}

/** Verkabelung aus der Umgebung (WF9 Pickliste). `disabled`, wenn Credentials/Ordner fehlen. */
function buildDriveFromEnv(env = process.env, opts = {}) {
  return buildDriveClientFromEnv(env, 'GOOGLE_DRIVE_PICKLIST_FOLDER_ID', 'GOOGLE_DRIVE_PROCESSED_FOLDER_ID', opts);
}

/**
 * Verkabelung für den WF1-Rechnungseingang: EIGENES Ordnerpaar (Rechnungseingang/
 * verarbeitet), gleiche OAuth-Credential wie die Pickliste. Vorher teilte sich der
 * Intake-Job fälschlich den Picklisten-Ordner — seit der n8n-Ablösung sauber getrennt.
 */
function buildInvoiceDriveFromEnv(env = process.env, opts = {}) {
  return buildDriveClientFromEnv(env, 'GOOGLE_DRIVE_INVOICE_FOLDER_ID', 'GOOGLE_DRIVE_INVOICE_PROCESSED_FOLDER_ID', opts);
}

module.exports = { createGoogleDriveClient, buildTokenRequest, buildDriveFromEnv, buildInvoiceDriveFromEnv, TOKEN_URL, DRIVE_API, UPLOAD_API };
