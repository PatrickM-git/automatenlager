async function loadV2Overview() {
  const status = document.querySelector('#v2Status');
  try {
    const response = await fetch('/api/v2/overview', { cache: 'no-store' });
    const data = await response.json();
    status.textContent = data.ok
      ? `PG-Datenstand: ${data.generatedAtDisplay || data.generatedAt}`
      : `${data.error.code}: ${data.error.message}`;
  } catch (error) {
    status.textContent = `API nicht erreichbar: ${error.message}`;
  }
}

loadV2Overview();
