#!/usr/bin/env node
'use strict';
/*
 * PostToolUse Encoding-Guard — blockt, wenn ein WF*.json nach Edit/Write eine
 * Encoding-Korruption enthaelt. Zwei Varianten:
 *   1. U+FFFD (Bytes EF BF BD) — Issue #15 (Latin-1/UTF-8-Mismatch), Umlaut weg.
 *   2. Mojibake U+00C3 (Ã...) — UTF-8 als CP1252 fehlinterpretiert; deutsche
 *      Umlaute werden zu 'Ã¤'/'Ã¼'/'ÃŸ' etc. (WF4-Vorfall 2026-06-05). Der
 *      Marker U+00C3 kommt in korrektem deutschem/englischem UTF-8 praktisch
 *      nie vor. Reparatur: raw.encode('cp1252').decode('utf-8').
 *
 * Defensiv: jeder Fehler -> exit 0.
 */

const fs = require('fs');
const path = require('path');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try {
    const j = JSON.parse(raw || '{}');
    const fp = (j.tool_input && j.tool_input.file_path)
      || (j.tool_response && (j.tool_response.filePath || j.tool_response.file_path))
      || '';
    if (!fp) return process.exit(0);
    if (!/^WF.*\.json$/i.test(path.basename(fp))) return process.exit(0);
    if (!fs.existsSync(fp)) return process.exit(0);

    const content = fs.readFileSync(fp, 'utf8');

    // Variante 1: U+FFFD (Issue #15)
    const fffd = content.split('�').length - 1;
    if (fffd > 0) {
      process.stderr.write(
        `⚠ Encoding-Guard: ${path.basename(fp)} enthaelt ${fffd}× U+FFFD (kaputte Umlaute).\n` +
        `   Das ist die in Issue #15 behobene Latin-1/UTF-8-Korruption — NICHT committen/deployen.\n` +
        `   Umlaute aus dem Kontext rekonstruieren (schlie<U+FFFD>en->schließen, <U+FFFD>nderung->Änderung, pr<U+FFFD>fen->prüfen).\n`,
      );
      return process.exit(2);
    }

    // Variante 2: Mojibake U+00C3 (Ã...) — UTF-8 als CP1252 fehlinterpretiert.
    // ASCII-Escape Ã (nicht das literale Zeichen), damit der Marker selbst
    // einen Encoding-Round-Trip dieses Hooks unbeschadet ueberlebt.
    const mojibake = (content.match(/\u00c3/g) || []).length;
    if (mojibake > 0) {
      process.stderr.write(
        `⚠ Encoding-Guard: ${path.basename(fp)} enthaelt ${mojibake}× U+00C3 (Ã) — Mojibake.\n` +
        `   UTF-8 wurde als CP1252 fehlinterpretiert (ä->Ã¤, ü->Ã¼, ß->ÃŸ); WF4-Vorfall 2026-06-05.\n` +
        `   Reparatur: raw.encode('cp1252').decode('utf-8'), dann erneut speichern. NICHT committen/deployen.\n`,
      );
      return process.exit(2);
    }
    return process.exit(0);
  } catch (e) {
    return process.exit(0); // defensiv
  }
});
