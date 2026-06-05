#!/usr/bin/env node
'use strict';
/*
 * PostToolUse SQL-Date-Guard — blockt, wenn ein WF*.json nach Edit/Write ein
 * ungeschütztes "DDTHH" in einem to_char-Format enthält.
 *
 * Hintergrund (WF3-Crash 2026-06-05): In to_char ist `TH` nach einem Zahlmuster
 * ein Ordinal-Suffix-Modifier. 'YYYY-MM-DDTHH24:MI:SS' liefert daher
 * "2026-06-05THH24:..." statt "2026-06-05T06:..." → Invalid Date → RangeError
 * in JS-Code-Nodes, bzw. stiller Müll in SQL-WHERE-Vergleichen.
 * Korrekt: T als Literal escapen — 'YYYY-MM-DD"T"HH24:MI:SS'.
 *
 * Defensiv: jeder unerwartete Fehler -> exit 0.
 */

const fs = require('fs');
const path = require('path');

// Ungeschützter T zwischen Tag und Stunde (DD T HH), wenn dem T kein " vorausgeht.
const UNSAFE_DATE_T = /DD(?<!")T(?=HH)/;

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
    const hits = [];
    content.split('\n').forEach((line, idx) => {
      if (UNSAFE_DATE_T.test(line) && /to_char/i.test(line)) {
        hits.push(`   ${path.basename(fp)}:${idx + 1}  ${line.trim().slice(0, 110)}`);
      }
    });

    if (hits.length > 0) {
      process.stderr.write(
        `⚠ SQL-Date-Guard: ${path.basename(fp)} nutzt ungeschütztes "DDTHH" in to_char.\n` +
        `   PostgreSQL liest "TH" als Ordinal-Suffix → kaputtes ISO-Datum (WF3-Crash 2026-06-05).\n` +
        `   Fix: T als Literal escapen -> 'YYYY-MM-DD"T"HH24:MI:SS'.\n` +
        hits.join('\n') + '\n',
      );
      return process.exit(2);
    }
    return process.exit(0);
  } catch (e) {
    return process.exit(0); // defensiv
  }
});
