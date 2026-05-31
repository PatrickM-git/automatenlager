'use strict';

// Issue #15 — Encoding: deutsche Umlaute als U+FFFD in WF4/5/7/9 reparieren.
//
// Diese Tests prüfen das Verhalten gegen die Repo-Exports (Artefakte), nicht
// gegen die laufende n8n-Instanz:
//   1. Die normalize()-Kette in WF4 mappt echte Umlaute (ä→ae, ö→oe, ü→ue, ß→ss).
//      Im kaputten Zustand matchen die Regexes auf U+FFFD und der Umlaut bleibt
//      stehen → "Müller" wird zu "müller" statt "mueller".
//   2. In keinem produktiven Workflow-Export steht noch ein U+FFFD (0xEFBFBD).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REPLACEMENT_CHAR = '�';

function listWorkflowFiles() {
  return fs
    .readdirSync(REPO_ROOT)
    .filter((name) => /^WF.*\.json$/.test(name))
    .sort();
}

function readRaw(name) {
  return fs.readFileSync(path.join(REPO_ROOT, name), 'utf8');
}

// Alle String-Werte eines geparsten JSON rekursiv einsammeln (Node-Code steckt
// in parameters.jsCode; rekursiv ist robust gegen Struktur-Details).
function collectStrings(node, out) {
  if (typeof node === 'string') {
    out.push(node);
  } else if (Array.isArray(node)) {
    for (const v of node) collectStrings(v, out);
  } else if (node && typeof node === 'object') {
    for (const v of Object.values(node)) collectStrings(v, out);
  }
  return out;
}

// Extrahiert aus einem jsCode-String jede Normalisierungs-Kette als aufrufbare
// Funktion. Anker: ".toLowerCase()" ... bis zum ersten "'ss')". Dieser Anker ist
// in kaputtem wie repariertem Zustand identisch (nur das Regex-Pattern /…/ ändert
// sich, nicht das Ersetzungsziel 'ss'), der Test bleibt dadurch über RED→GREEN stabil.
function extractNormalizeChains(jsCode) {
  const chains = [];
  const re = /\.toLowerCase\(\)[\s\S]*?'ss'\)/g;
  let m;
  while ((m = re.exec(jsCode)) !== null) {
    const chain = m[0];
    // Aufrufbar machen: String(v)<chain>
    const fn = new Function('v', `return String(v)${chain};`);
    chains.push(fn);
  }
  return chains;
}

test('WF4 normalize() mappt echte deutsche Umlaute (ä→ae, ö→oe, ü→ue, ß→ss)', () => {
  const wf4Name = listWorkflowFiles().find((n) => /^WF4\b/.test(n));
  assert.ok(wf4Name, 'WF4-Export nicht gefunden');

  const wf = JSON.parse(readRaw(wf4Name));
  const strings = collectStrings(wf, []);
  const codeWithNormalize = strings.filter(
    (s) => s.includes('.toLowerCase()') && s.includes("'ss')"),
  );
  assert.ok(
    codeWithNormalize.length > 0,
    'Keine Normalisierungs-Funktion in WF4 gefunden',
  );

  const cases = [
    ['Müller', 'mueller'],
    ['Größe', 'groesse'],
    ['Spaß', 'spass'],
    ['Äpfel', 'aepfel'],
  ];

  let chainCount = 0;
  for (const code of codeWithNormalize) {
    for (const fn of extractNormalizeChains(code)) {
      chainCount += 1;
      for (const [input, expected] of cases) {
        assert.equal(
          fn(input),
          expected,
          `normalize("${input}") sollte "${expected}" ergeben`,
        );
      }
    }
  }
  assert.ok(chainCount > 0, 'Keine normalize()-Kette extrahierbar');
});

test('Kein produktiver Workflow-Export enthält U+FFFD (0xEFBFBD)', () => {
  const offenders = [];
  for (const name of listWorkflowFiles()) {
    const raw = readRaw(name);
    const count = raw.split(REPLACEMENT_CHAR).length - 1;
    if (count > 0) offenders.push(`${name}: ${count}×`);
  }
  assert.deepEqual(
    offenders,
    [],
    `U+FFFD noch vorhanden in:\n  ${offenders.join('\n  ')}`,
  );
});
