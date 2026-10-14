import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRespuesta, normalizeAnswer } from '../scripts/run-test.js';

test('Runner - compara respuestas exactas y normalizadas', () => {
  const eq = (a: string, b: string) => normalizeAnswer(a) === normalizeAnswer(b);
  assert.ok(eq('45', '45'));
  assert.ok(!eq('145', '45'), 'antes "contiene" daba por buena 145 para 45');
  assert.ok(eq('$ 20.060.000', '20060000'));
  assert.ok(eq('20,060,000', '20060000'));
  assert.ok(eq('15; 4', '15;4'));
  assert.ok(eq('50 facturas vencidas', '50'));
  assert.ok(eq('3715040197.', '3715040197'));
  assert.ok(!eq('4', '45'));
});

test('Runner - extrae la línea respuesta del resumen', () => {
  assert.equal(extractRespuesta('respuesta: 45\nSe contaron las facturas.'), '45');
  assert.equal(extractRespuesta('Se contaron.\nRespuesta: 15;4'), '15;4');
  assert.equal(extractRespuesta('No se pudo.'), null);
});

test('Runner - un corte técnico no cuenta como "fallida" decidida por el agente', async () => {
  const { corteTecnico } = await import('../scripts/run-test.js');
  assert.ok(corteTecnico('Límite de costo por tarea alcanzado (0.2658 USD) sin completar. Últimas acciones: ... Pasto'));
  assert.ok(corteTecnico('Plazo máximo de ejecución vencido (285s) tras 14 pasos.'));
  assert.ok(!corteTecnico('Pasto no está en la lista de ciudades de la aplicación; no se registró el cliente.'));
});
