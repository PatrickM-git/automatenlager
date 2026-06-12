// #218 (Cloud-Slice 4): Laufzeit-API-Basis fürs Frontend.
// Mini/same-origin = leer (Default). Auf Cloudflare wird diese Datei beim Deploy
// durch eine Variante mit der Render-Backend-URL ersetzt (siehe
// dashboard/deploy/cloudflare/config.cloud.js). Bewusst eine separate, nicht
// gebündelte Datei, damit die API-Basis ohne Frontend-Rebuild umstellbar ist.
window.__API_BASE__ = '';
