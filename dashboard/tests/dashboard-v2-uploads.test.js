const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function getFreePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function buildMultipart({ filename, contentType, data, target }) {
  const boundary = `----codex-boundary-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const chunks = [];
  const push = (value) => chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8'));

  if (target) {
    push(`--${boundary}\r\n`);
    push('Content-Disposition: form-data; name="target"\r\n\r\n');
    push(`${target}\r\n`);
  }

  push(`--${boundary}\r\n`);
  push(`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`);
  push(`Content-Type: ${contentType}\r\n\r\n`);
  push(data);
  push('\r\n');
  push(`--${boundary}--\r\n`);

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function startMockN8n() {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      calls.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });

      if (req.url.startsWith('/api/v1/workflows')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          data: [
            {
              id: 'wf1-id',
              name: 'WF1 - Rechnungseingang automatisch mit Claude',
              active: true,
              updatedAt: '2026-05-25T10:00:00.000Z',
              nodes: [
                {
                  name: 'WF1 Upload Webhook',
                  type: 'n8n-nodes-base.webhook',
                  parameters: {
                    path: 'invoice-upload',
                    httpMethod: 'POST',
                  },
                },
              ],
            },
            {
              id: 'wf9-id',
              name: 'WF9 - Pickliste verarbeiten',
              active: true,
              updatedAt: '2026-05-25T10:00:00.000Z',
              nodes: [
                {
                  name: 'WF9 Upload Webhook',
                  type: 'n8n-nodes-base.webhook',
                  parameters: {
                    path: 'picklist-upload',
                    httpMethod: 'POST',
                  },
                },
              ],
            },
          ],
        }));
        return;
      }

      if (req.url === '/webhook/invoice-upload') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, executionId: 'wf1-run-001' }));
        return;
      }

      if (req.url === '/webhook/picklist-upload') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, executionId: 'wf9-run-001' }));
        return;
      }

      res.statusCode = 404;
      res.end('not found');
    });
  });

  return { server, calls };
}

function startDashboard(port, n8nPort, envOverrides = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      N8N_BASE_URL: `http://127.0.0.1:${n8nPort}`,
      N8N_API_KEY: 'test-key',
      DASHBOARD_ADMIN_LOGIN: 'patrick@example.test',
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Dashboard server did not start in time'));
    }, 10_000);

    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes(`http://localhost:${port}`)) {
        clearTimeout(timeout);
        resolve(child);
      }
    });
    child.stderr.resume();
    child.on('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`Dashboard server exited with code ${code}`));
      }
    });
  });
}

function requestDashboard(port, { method = 'GET', pathName = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathName,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          headers: res.headers,
          raw,
          json: () => JSON.parse(raw),
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('AC: Admin kann Rechnungsdatei hochladen und an WF1/WF2-Pfad uebergeben', async (t) => {
  const mockN8n = startMockN8n();
  const n8nPort = await listen(mockN8n.server);
  const dashboardPort = await getFreePort();
  const dashboard = await startDashboard(dashboardPort, n8nPort);

  t.after(() => {
    dashboard.kill();
    mockN8n.server.close();
  });

  const multipart = buildMultipart({
    filename: 'rechnung-2026-05.pdf',
    contentType: 'application/pdf',
    data: Buffer.from('%PDF-1.4\nInvoice content\n', 'utf8'),
    target: 'invoice',
  });

  const response = await requestDashboard(dashboardPort, {
    method: 'POST',
    pathName: '/api/v2/uploads/invoice',
    headers: {
      'Content-Type': multipart.contentType,
      'Content-Length': String(multipart.body.length),
      'Tailscale-User-Login': 'patrick@example.test',
    },
    body: multipart.body,
  });

  assert.equal(response.status, 200);
  const body = response.json();
  assert.equal(body.ok, true);
  assert.equal(body.target, 'invoice');
  assert.equal(body.viewer.role, 'admin');
  assert.equal(body.upload.fileName, 'rechnung-2026-05.pdf');
  assert.equal(body.workflow.id, 'wf1-id');
  assert.equal(body.workflow.method, 'POST');
  assert.equal(body.workflow.status, 'accepted');

  const uploadCall = mockN8n.calls.find((call) => call.method === 'POST' && call.url === '/webhook/invoice-upload');
  assert.ok(uploadCall, 'WF1 webhook wurde nicht aufgerufen');
  assert.match(uploadCall.headers['content-type'] || '', /^multipart\/form-data/i);
  assert.match(uploadCall.body.toString('latin1'), /rechnung-2026-05\.pdf/);
});

test('AC: Admin kann Picklisten-PDF hochladen und an WF9-Pfad uebergeben', async (t) => {
  const mockN8n = startMockN8n();
  const n8nPort = await listen(mockN8n.server);
  const dashboardPort = await getFreePort();
  const dashboard = await startDashboard(dashboardPort, n8nPort);

  t.after(() => {
    dashboard.kill();
    mockN8n.server.close();
  });

  const multipart = buildMultipart({
    filename: 'pickliste-kw22.pdf',
    contentType: 'application/pdf',
    data: Buffer.from('%PDF-1.4\nPicklist\n', 'utf8'),
    target: 'picklist',
  });

  const response = await requestDashboard(dashboardPort, {
    method: 'POST',
    pathName: '/api/v2/uploads/picklist',
    headers: {
      'Content-Type': multipart.contentType,
      'Content-Length': String(multipart.body.length),
      'Tailscale-User-Login': 'patrick@example.test',
    },
    body: multipart.body,
  });

  assert.equal(response.status, 200);
  const body = response.json();
  assert.equal(body.ok, true);
  assert.equal(body.target, 'picklist');
  assert.equal(body.upload.mimeType, 'application/pdf');
  assert.equal(body.workflow.id, 'wf9-id');

  const uploadCall = mockN8n.calls.find((call) => call.method === 'POST' && call.url === '/webhook/picklist-upload');
  assert.ok(uploadCall, 'WF9 webhook wurde nicht aufgerufen');
});

test('AC: Validierung blockiert ungueltigen Dateityp fuer Picklisten', async (t) => {
  const mockN8n = startMockN8n();
  const n8nPort = await listen(mockN8n.server);
  const dashboardPort = await getFreePort();
  const dashboard = await startDashboard(dashboardPort, n8nPort);

  t.after(() => {
    dashboard.kill();
    mockN8n.server.close();
  });

  const multipart = buildMultipart({
    filename: 'pickliste.png',
    contentType: 'image/png',
    data: Buffer.from('not a pdf', 'utf8'),
    target: 'picklist',
  });

  const response = await requestDashboard(dashboardPort, {
    method: 'POST',
    pathName: '/api/v2/uploads/picklist',
    headers: {
      'Content-Type': multipart.contentType,
      'Content-Length': String(multipart.body.length),
      'Tailscale-User-Login': 'patrick@example.test',
    },
    body: multipart.body,
  });

  assert.equal(response.status, 422);
  const body = response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'FILE_TYPE_NOT_ALLOWED');
  assert.equal(mockN8n.calls.some((call) => call.url === '/webhook/picklist-upload' && call.method === 'POST'), false);
});

test('AC: Validierung blockiert zu grosse Dateien', async (t) => {
  const mockN8n = startMockN8n();
  const n8nPort = await listen(mockN8n.server);
  const dashboardPort = await getFreePort();
  const dashboard = await startDashboard(dashboardPort, n8nPort);

  t.after(() => {
    dashboard.kill();
    mockN8n.server.close();
  });

  const multipart = buildMultipart({
    filename: 'rechnung-gross.pdf',
    contentType: 'application/pdf',
    data: Buffer.alloc(10 * 1024 * 1024 + 1, 65),
    target: 'invoice',
  });

  const response = await requestDashboard(dashboardPort, {
    method: 'POST',
    pathName: '/api/v2/uploads/invoice',
    headers: {
      'Content-Type': multipart.contentType,
      'Content-Length': String(multipart.body.length),
      'Tailscale-User-Login': 'patrick@example.test',
    },
    body: multipart.body,
  });

  assert.equal(response.status, 413);
  const body = response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'FILE_TOO_LARGE');
});

test('AC: Zieltyp-Mismatch wird abgewiesen', async (t) => {
  const mockN8n = startMockN8n();
  const n8nPort = await listen(mockN8n.server);
  const dashboardPort = await getFreePort();
  const dashboard = await startDashboard(dashboardPort, n8nPort);

  t.after(() => {
    dashboard.kill();
    mockN8n.server.close();
  });

  const multipart = buildMultipart({
    filename: 'rechnung.pdf',
    contentType: 'application/pdf',
    data: Buffer.from('x', 'utf8'),
    target: 'picklist',
  });

  const response = await requestDashboard(dashboardPort, {
    method: 'POST',
    pathName: '/api/v2/uploads/invoice',
    headers: {
      'Content-Type': multipart.contentType,
      'Content-Length': String(multipart.body.length),
      'Tailscale-User-Login': 'patrick@example.test',
    },
    body: multipart.body,
  });

  assert.equal(response.status, 400);
  const body = response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'TARGET_MISMATCH');
});

test('AC: Upload-Capabilities sind fuer Admin sichtbar und fuer Read-Only gesperrt', async (t) => {
  const mockN8n = startMockN8n();
  const n8nPort = await listen(mockN8n.server);
  const dashboardPort = await getFreePort();
  const dashboard = await startDashboard(dashboardPort, n8nPort);

  t.after(() => {
    dashboard.kill();
    mockN8n.server.close();
  });

  const admin = await requestDashboard(dashboardPort, {
    pathName: '/api/v2/upload-capabilities',
    headers: {
      'Tailscale-User-Login': 'patrick@example.test',
    },
  });
  assert.equal(admin.status, 200);
  const adminBody = admin.json();
  assert.equal(adminBody.ok, true);
  assert.equal(adminBody.viewer.role, 'admin');
  assert.equal(adminBody.canUpload, true);
  assert.deepEqual(adminBody.targets.map((item) => item.id).sort(), ['invoice', 'picklist']);

  const guest = await requestDashboard(dashboardPort, {
    pathName: '/api/v2/upload-capabilities',
    headers: {
      'Tailscale-User-Login': 'freund@example.test',
    },
  });
  assert.equal(guest.status, 200);
  const guestBody = guest.json();
  assert.equal(guestBody.ok, true);
  assert.equal(guestBody.viewer.role, 'guest');
  assert.equal(guestBody.canUpload, false);
});

test('AC: Read-Only darf keine Uploads ausfuehren (403 + Audit)', async (t) => {
  const auditLogPath = path.join(os.tmpdir(), `dashboard-v2-upload-audit-${Date.now()}.jsonl`);
  const mockN8n = startMockN8n();
  const n8nPort = await listen(mockN8n.server);
  const dashboardPort = await getFreePort();
  const dashboard = await startDashboard(dashboardPort, n8nPort, {
    DASHBOARD_AUDIT_LOG: auditLogPath,
  });

  t.after(() => {
    dashboard.kill();
    mockN8n.server.close();
    fs.rmSync(auditLogPath, { force: true });
  });

  const multipart = buildMultipart({
    filename: 'rechnung.pdf',
    contentType: 'application/pdf',
    data: Buffer.from('x', 'utf8'),
    target: 'invoice',
  });

  const response = await requestDashboard(dashboardPort, {
    method: 'POST',
    pathName: '/api/v2/uploads/invoice',
    headers: {
      'Content-Type': multipart.contentType,
      'Content-Length': String(multipart.body.length),
      'Tailscale-User-Login': 'freund@example.test',
    },
    body: multipart.body,
  });

  assert.equal(response.status, 403);
  const body = response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'READ_ONLY_FORBIDDEN');
  assert.equal(body.viewer.role, 'guest');
  assert.equal(mockN8n.calls.some((call) => call.url === '/webhook/invoice-upload' && call.method === 'POST'), false);

  const lines = fs.readFileSync(auditLogPath, 'utf8').trim().split(/\r?\n/);
  const entry = JSON.parse(lines.at(-1));
  assert.equal(entry.event, 'v2_upload_denied');
  assert.equal(entry.target, 'invoice');
  assert.equal(entry.login, 'freund@example.test');
});
