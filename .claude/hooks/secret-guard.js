#!/usr/bin/env node
'use strict';
/*
 * PreToolUse Secret-Guard — blockt Bash/Edit/Write, wenn ein KLARTEXT-Geheimnis
 * im Befehl bzw. neuen Dateiinhalt steht. Härtet die Memory-Regeln
 * feedback_no_api_keys_in_commands / feedback_no_api_keys_in_chat technisch ab.
 *
 * Defensiv: jeder Fehler -> exit 0 (ein Hook-Bug darf die Arbeit NIE blockieren).
 * Whitelist: Platzhalter / $VAR / $(...) / *** etc. werden NICHT geblockt, damit
 * das legitime Muster "Key aus Datei/Variable lesen" weiter funktioniert.
 */

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try {
    const j = JSON.parse(raw || '{}');
    const tool = j.tool_name || '';
    const ti = j.tool_input || {};
    let text = '';
    if (tool === 'Bash') text = ti.command || '';
    else if (tool === 'Write') text = ti.content || '';
    else if (tool === 'Edit') text = ti.new_string || '';
    else return process.exit(0);
    if (!text) return process.exit(0);

    const PATTERNS = [
      { name: 'JWT / n8n-API-Key / OAuth', re: /eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}/ },
      { name: 'OpenAI/Anthropic sk-Key', re: /sk-[A-Za-z0-9_-]{20,}/ },
      { name: 'GitHub-Token', re: /gh[posru]_[A-Za-z0-9]{30,}/ },
      { name: 'AWS-Access-Key', re: /AKIA[0-9A-Z]{16}/ },
      { name: 'Google-API-Key', re: /AIza[0-9A-Za-z_-]{30,}/ },
      { name: 'Slack-Token', re: /xox[baprs]-[0-9A-Za-z-]{10,}/ },
      { name: 'Postgres-URL mit Passwort', re: /postgres(?:ql)?:\/\/[^:@\s]+:[^@\s]+@/ },
      { name: 'Bearer/Auth-Header mit Token', re: /(?:Bearer|X-N8N-API-KEY:|Authorization:)\s*[A-Za-z0-9._-]{20,}/i },
    ];

    const looksLikePlaceholder = (m) => {
      const s = String(m);
      if (/\$\{?\w+\}?/.test(s)) return true;          // $VAR / ${VAR}
      if (/\$\(/.test(s)) return true;                  // $(...)
      if (/%[sd]/.test(s)) return true;                 // printf %s
      if (/\*{3,}/.test(s)) return true;                // ***
      if (/<[^>]+>/.test(s)) return true;               // <...>
      if (/(xxx|your[-_]|placeholder|EINTRAGEN|example|dummy|changeme|redacted|maskiert|token_here)/i.test(s)) return true;
      const core = s.replace(/[^A-Za-z0-9]/g, '');
      if (core.length > 6 && /^(.)\1+$/.test(core)) return true; // aaaaaa…
      return false;
    };

    for (const p of PATTERNS) {
      const hit = text.match(p.re);
      if (!hit) continue;
      const around = text.slice(Math.max(0, hit.index - 6), hit.index + hit[0].length + 6);
      if (looksLikePlaceholder(hit[0]) || looksLikePlaceholder(around)) continue;
      process.stderr.write(
        `🔒 Secret-Guard: moeglicher Klartext-Schluessel erkannt (${p.name}) im ${tool}-Aufruf.\n` +
        `   Treffer: ${hit[0].slice(0, 12)}…\n` +
        `   -> Tokens NIE im Klartext einbetten. Aus Datei/Variable lesen ($(cat …) / curl-config / Platzhalter).\n` +
        `   (Memory-Regel feedback_no_api_keys_in_commands). Wenn Fehlalarm: Wert maskieren oder Hook via /hooks anpassen.\n`,
      );
      return process.exit(2);
    }
    return process.exit(0);
  } catch (e) {
    return process.exit(0); // defensiv
  }
});
