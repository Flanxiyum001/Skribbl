import test from 'node:test';
import assert from 'node:assert/strict';
import { WORDS, normalizeGuess, pickWords, hiddenWord } from '../src/words.js';
test('word list has enough varied, unique options', () => { assert.ok(WORDS.length >= 150); assert.equal(new Set(WORDS).size, WORDS.length); });
test('guess normalization ignores capitalization and punctuation', () => {
  assert.equal(normalizeGuess('Ice Cream!'), normalizeGuess('ice-cream'));
  assert.notEqual(normalizeGuess('cake'), normalizeGuess('snake'));
});
test('word selection never repeats a choice', () => {
  const words = pickWords(3, () => 0.5);
  assert.equal(words.length, 3); assert.equal(new Set(words).size, 3);
});
test('mask preserves spaces and never exposes entire answer', () => {
  assert.equal(hiddenWord('ice cream', 0), '_ _ _   _ _ _ _ _');
  assert.ok(hiddenWord('ice cream', 2).includes('_'));
});

test('large expanded drawing bank has no normalization-colliding words', () => {
  assert.ok(WORDS.length >= 700);
  assert.equal(new Set(WORDS.map(normalizeGuess)).size, WORDS.length);
  assert.ok(WORDS.every(word => word.length > 1 && word.length <= 42));
});
