'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inferProductCategory } = require('../lib/product-category.js');

// Ground truth aus der Live-DB (2026-06-04). Der Klassifizierer (für WF2) muss
// diese real existierenden Produkte korrekt einordnen.

const KNOWN_DRINKS = [
  'Capri Sonne Kirsch', 'Capri Sun Safari fruits', 'Coca Cola', 'Coca Cola zero',
  'Fanta Exotic', 'Hochwald Eiskaffee', 'Lichtenauer medium', 'Lichtenauer still',
  'Red Bull', 'Red Bull Spring', 'Red Bull summer edition', 'Sprite',
];

const KNOWN_SNACKS = [
  '7 Days Croissant', '7 Days Croissant Double', 'Bueno', 'Bueno White',
  'Duplo original', 'Erdnüsse', 'Falcone XXL-Cookies Cranberry',
  'Falcone XXL-Cookies Nussnougatcreme', 'Ferrero Duplo Chocnut', 'Hanuta',
  'Haribo Goldbären', 'Haribo Miami Sauer', 'Kinder Country', 'KitKat',
  'KitKat Chunky', 'Leibniz Kek´n Cream Choce', 'Maltesers', 'Manner minis',
  'Milka Oreo Schokoriegel', 'M&M´s Chocolate', "M&M's Crispy", "M&M's Peanut",
  'Mr. Toms', 'Nick Nacks', 'Pick Up', 'Pombären', 'Salzstangen',
  'Skittles fruit', 'Snickers', 'Snickers Creamy', 'Studentenfutter',
  'Twix original', 'Twix salted caramel', 'Willis Brownie Bites 2-Pack',
];

test('inferProductCategory: alle bekannten Getränke -> getraenk', () => {
  for (const name of KNOWN_DRINKS) {
    assert.equal(inferProductCategory(name), 'getraenk', `${name} sollte getraenk sein`);
  }
});

test('inferProductCategory: alle bekannten Snacks -> snack (keine Fehl-Treffer)', () => {
  for (const name of KNOWN_SNACKS) {
    assert.equal(inferProductCategory(name), 'snack', `${name} sollte snack sein`);
  }
});

test('inferProductCategory: Rechnungs-Alias mit Volumenangabe gibt den Ausschlag', () => {
  // Genau die echten WF2-Eingaben (Produktname + Rechnungszeile).
  assert.equal(inferProductCategory('Hochwald Eiskaffee', '250ml HOCHWALD EISKAFFEE'), 'getraenk');
  assert.equal(inferProductCategory('Red Bull summer edition', '0,25 RED BULL SUMMER EDT SF'), 'getraenk');
  // Volumen allein (unbekannter Name) reicht.
  assert.equal(inferProductCategory('Irgendeine Limo 500ml'), 'getraenk');
  assert.equal(inferProductCategory('Neues Wasser 1,5l'), 'getraenk');
});

test('inferProductCategory: Default bleibt snack (nie schlechter als bisher)', () => {
  assert.equal(inferProductCategory(''), 'snack');
  assert.equal(inferProductCategory(null), 'snack');
  assert.equal(inferProductCategory('Völlig unbekanntes Knabberzeug'), 'snack');
});

test('inferProductCategory: Capri Sun (Getränk) wird als getraenk erkannt', () => {
  // In den Altdaten war "Capri Sun Zero Monster Alarm" faelschlich als snack
  // gelabelt — der Klassifizierer ist hier bewusst korrekter.
  assert.equal(inferProductCategory('Capri Sun Zero Monster Alarm'), 'getraenk');
});
