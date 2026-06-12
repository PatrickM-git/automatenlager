// #218 (Cloud-Slice 4): API-Basis fürs Cloudflare-Frontend → Render-Backend.
// Diese Datei ERSETZT beim Cloudflare-Pages-Deploy die public/config.js (die auf
// dem Mini same-origin/leer bleibt). RENDER_BACKEND_URL durch die echte
// Render-Domain ersetzen (z. B. https://faltrix-dashboard.onrender.com).
window.__API_BASE__ = 'https://RENDER_BACKEND_URL';
