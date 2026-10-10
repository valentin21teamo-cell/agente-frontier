import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitize } from '../src/security/sanitize.js';

test('Sanitization - Redacts exact task password', () => {
  const taskPassword = 'vnc_Secret_Pass_123';
  const text = `Conectando con password ${taskPassword} al escritorio.`;
  const result = sanitize(text, taskPassword);
  assert.equal(result, 'Conectando con password [REDACTADO] al escritorio.');
  assert.ok(!result.includes(taskPassword));
});

test('Sanitization - Redacts regex special characters safely in passwords', () => {
  const complexPass = 'p@$$w0rd(test)+[abc]';
  const text = `Password ingresada: ${complexPass} correctamente.`;
  const result = sanitize(text, complexPass);
  assert.equal(result, 'Password ingresada: [REDACTADO] correctamente.');
  assert.ok(!result.includes(complexPass));
});

test('Sanitization - Redacts TEAM_TOKEN and OPENROUTER_API_KEY from environment', () => {
  process.env.TEAM_TOKEN = 'secret-team-token-abc';
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-abcdef1234567890';

  const text = `Uso token secret-team-token-abc y key sk-or-v1-abcdef1234567890 en la solicitud.`;
  const result = sanitize(text);

  assert.ok(!result.includes('secret-team-token-abc'));
  assert.ok(!result.includes('sk-or-v1-abcdef1234567890'));
  assert.ok(result.includes('[REDACTADO]'));
});

test('Sanitization - Redacts Bearer tokens via regex', () => {
  const text = 'Authorization: Bearer my-arbitrary-token-here en cabecera';
  const result = sanitize(text);
  assert.equal(result, 'Authorization: Bearer [REDACTADO] en cabecera');
  assert.ok(!result.includes('my-arbitrary-token-here'));
});

test('Sanitization - Redacts sk-or-... pattern via regex', () => {
  const text = 'Llamada fallida con sk-or-v1-999abc888xyz: cuota excedida';
  const result = sanitize(text);
  assert.equal(result, 'Llamada fallida con [REDACTADO]: cuota excedida');
  assert.ok(!result.includes('sk-or-v1-999abc888xyz'));
});

test('Sanitization - Redacts ftr_... pattern via regex', () => {
  const text = 'Eval token ftr_eval_run_98765 finalizado';
  const result = sanitize(text);
  assert.equal(result, 'Eval token [REDACTADO] finalizado');
  assert.ok(!result.includes('ftr_eval_run_98765'));
});

test('Sanitization - Safe handling of null, undefined, numbers', () => {
  assert.equal(sanitize(null), '');
  assert.equal(sanitize(undefined), '');
  assert.equal(sanitize(12345), '12345');
});
