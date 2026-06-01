#!/usr/bin/env node
'use strict';
/*
 * PostToolUse Encoding-Guard — warnt, wenn ein WF*.json nach Edit/Write
 * U+FFFD (kaputte Umlaute, Bytes EF BF BD) enthaelt. Verhindert die Regression
 * aus Issue #15 (Latin-1/UTF-8-Mismatch in den n8n-Workflow-Exports).
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
    const count = content.split('�').length - 1;
    if (count > 0) {
      process.stderr.write(
        `⚠ Encoding-Guard: ${path.basename(fp)} enthaelt ${count}× U+FFFD (kaputte Umlaute).\n` +
        `   Das ist die in Issue #15 behobene Latin-1/UTF-8-Korruption — NICHT committen/deployen.\n` +
        `   Umlaute aus dem Kontext rekonstruieren (schlie<U+FFFD>en->schließen, <U+FFFD>nderung->Änderung, pr<U+FFFD>fen->prüfen).\n`,
      );
      return process.exit(2);
    }
    return process.exit(0);
  } catch (e) {
    return process.exit(0); // defensiv
  }
});
