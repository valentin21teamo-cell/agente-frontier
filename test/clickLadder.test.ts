import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLadder, TriedPoint } from '../src/agent/clickLadder.js';

test('ClickLadder - el primer clic no se desplaza y el repetido sí, en pasos pequeños', () => {
  const tried: TriedPoint[] = [];
  const a = applyLadder(tried, 750, 470, 1280, 800);
  assert.deepEqual([a.x, a.y, a.shifted], [750, 470, false]);
  const b = applyLadder(tried, 752, 471, 1280, 800);
  assert.equal(b.shifted, true);
  assert.equal(b.x, 797); // +45
  const c = applyLadder(tried, 750, 470, 1280, 800);
  assert.equal(c.x, 840); // +90
});

test('ClickLadder - no se sale de la pantalla', () => {
  const tried: TriedPoint[] = [{ x: 1275, y: 5, n: 2 }];
  const r = applyLadder(tried, 1275, 5, 1280, 800);
  assert.ok(r.x <= 1279 && r.y >= 0);
});
