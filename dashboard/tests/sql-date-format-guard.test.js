'use strict';

// Guard gegen die PostgreSQL to_char-"DDTH"-Falle (WF3-Crash vom 2026-06-05).
//
// Hintergrund: In einem to_char-Format-String ist `TH` direkt nach einem
// Zahlmuster ein Ordinal-Suffix-Modifier (1st, 2nd, 5th). Das Muster
// 'YYYY-MM-DDTHH24:MI:SS' wird daher NICHT als "...Tag T Stunde..." gelesen,
// sondern `DD` bekommt das Suffix `TH` und der gemeinte `T`-Literal samt
// folgendem `H` verschwindet:
//
//   to_char(TIMESTAMP '2026-06-05 06:58:56', 'YYYY-MM-DDTHH24:MI:SS')
//     -> "2026-06-05THH24:58:56"      (FALSCH — kein gültiges ISO-Datum)
//
//   to_char(TIMESTAMP '2026-06-05 06:58:56', 'YYYY-MM-DD"T"HH24:MI:SS')
//     -> "2026-06-05T06:58:56"        (RICHTIG — T als Literal in Anführungszeichen)
//
// Folge im kaputten Zustand: `new Date("2026-06-05THH24:...")` ergibt
// Invalid Date, und `.toISOString()` wirft RangeError → der ganze Code-Node
// (und damit der Workflow) crasht. In SQL-WHERE-Vergleichen produziert es
// stillen Daten-Müll. Beides verhindert dieser Test.
//
// Korrekte ISO-8601-Ausgabe aus PostgreSQL braucht den T-Literal in
// doppelten Anführungszeichen: 'YYYY-MM-DD"T"HH24:MI:SS'.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Ungeschützter T zwischen Tag und Stunde: ...DD  T  HH... wobei dem T KEIN
// öffnendes Anführungszeichen vorausgeht. Trifft 'YYYY-MM-DDTHH24...' aber
// NICHT das korrekte 'YYYY-MM-DD"T"HH24...'.
const UNSAFE_DATE_T = /DD(?<!")T(?=HH)/;

function listWorkflowFiles() {
  return fs
    .readdirSync(REPO_ROOT)
    .filter((name) => /^WF.*\.json$/.test(name))
    .sort();
}

test('Kein Workflow-Export nutzt ungeschütztes "DDTHH" in to_char (PostgreSQL Ordinal-Suffix-Falle)', () => {
  const offenders = [];
  for (const name of listWorkflowFiles()) {
    const raw = fs.readFileSync(path.join(REPO_ROOT, name), 'utf8');
    // Pro Zeile prüfen, damit die Fehlermeldung die Fundstelle zeigt.
    raw.split('\n').forEach((line, idx) => {
      if (UNSAFE_DATE_T.test(line) && /to_char/i.test(line)) {
        offenders.push(`${name}:${idx + 1}  ${line.trim().slice(0, 120)}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    'Ungeschütztes "DDTHH" gefunden — T muss als Literal escaped werden: ' +
      "'YYYY-MM-DD\"T\"HH24:MI:SS'. Fundstellen:\n  " +
      offenders.join('\n  '),
  );
});

test('UNSAFE_DATE_T-Regex erkennt die Falle und lässt die korrekte Form durch (Selbsttest)', () => {
  // Kaputt → muss matchen
  assert.ok(UNSAFE_DATE_T.test("to_char(ts,'YYYY-MM-DDTHH24:MI:SS')"));
  // Korrekt (T in Anführungszeichen) → darf NICHT matchen
  assert.ok(!UNSAFE_DATE_T.test('to_char(ts,\'YYYY-MM-DD"T"HH24:MI:SS\')'));
  // Nur Datum ohne Zeit → darf NICHT matchen
  assert.ok(!UNSAFE_DATE_T.test("to_char(ts,'YYYY-MM-DD')"));
});
