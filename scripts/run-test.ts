/**
 * Automated Benchmark Runner for Official Competition Tasks
 * Execution Order: E1, E5, E3, E2, E4
 * Protocol:
 * 1. POST /__reset (Bearer DESKTOP_TOKEN) before each task
 * 2. POST /tasks (instruccion as tarea)
 * 3. Polls GET /tasks/:id every 5 seconds (5 min timeout)
 * 4. POST /__check (Bearer DESKTOP_TOKEN) with original test JSON
 * 5. Validates summary: respuesta_esperada, claves_razon, no secrets, correct estado
 * 6. Stopping rules: single task cost > $0.10, total cost > $3.00, or 2 consecutive failures
 */

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { safeLogger } from '../src/security/sanitize.js';
import { globalTaskStore } from '../src/tasks/store.js';

dotenv.config();

const DESKTOP_HTTP = process.env.DESKTOP_HTTP_URL || '';
const DESKTOP_TOKEN = process.env.DESKTOP_TOKEN || '';
const DESKTOP_WS = process.env.DESKTOP_WS_URL || '';
const DESKTOP_PASSWORD = process.env.DESKTOP_PASSWORD || '';
const TEAM_TOKEN = process.env.TEAM_TOKEN || '';
const AGENT_BASE = process.env.AGENT_URL || 'http://127.0.0.1:3000';

export interface TestCase {
  id: string;
  nivel: string;
  instruccion: string;
  estado_esperado: 'terminada' | 'fallida';
  respuesta_esperada?: string;
  claves_razon?: string[];
  diff_esperado: unknown[];
  lista_blanca?: unknown[];
}

export interface RunReport {
  id: string;
  instruccion: string;
  estadoFinal: 'terminada' | 'fallida' | 'en_curso';
  estadoEsperado: string;
  resumen: string;
  evalResult: any;
  duracionSeg: number;
  pasos: number;
  costoUsd: number;
  resumenValido: boolean;
  falloMotivo?: string;
}

let sessionTotalCostUsd = 0;
let consecutiveFailures = 0;
let lastFailureReason = '';

export async function resetDesktop(): Promise<boolean> {
  if (!DESKTOP_HTTP || !DESKTOP_TOKEN) {
    throw new Error('DESKTOP_HTTP_URL o DESKTOP_TOKEN no configurados');
  }

  safeLogger.info(`[Runner] Reseteando estado del escritorio vía POST /__reset...`);
  const res = await fetch(`${DESKTOP_HTTP}/__reset`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${DESKTOP_TOKEN}` },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Error en /__reset (HTTP ${res.status}): ${errText}`);
  }

  const data = (await res.json()) as { ok: boolean };
  return data.ok;
}

export async function checkWithEvaluator(testCase: TestCase): Promise<any> {
  if (!DESKTOP_HTTP || !DESKTOP_TOKEN) return { pass: false, error: 'No evaluator configured' };

  safeLogger.info(`[Runner] Evaluando cambios con el evaluador vía POST /__check...`);
  const res = await fetch(`${DESKTOP_HTTP}/__check`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DESKTOP_TOKEN}`,
    },
    body: JSON.stringify(testCase),
  });

  if (!res.ok) {
    const errText = await res.text();
    return { pass: false, error: `Evaluator HTTP ${res.status}: ${errText}` };
  }

  return await res.json();
}

function validateSummaryContent(testCase: TestCase, estado: string, resumen: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // 1. Estado must match
  if (estado !== testCase.estado_esperado) {
    errors.push(`Estado devuelto "${estado}" no coincide con el esperado "${testCase.estado_esperado}"`);
  }

  // 2. No secrets in summary
  if (DESKTOP_PASSWORD && resumen.includes(DESKTOP_PASSWORD)) {
    errors.push('Fuga de seguridad: la contraseña del escritorio aparece en el resumen.');
  }
  if (TEAM_TOKEN && resumen.includes(TEAM_TOKEN)) {
    errors.push('Fuga de seguridad: el token del equipo aparece en el resumen.');
  }
  if (process.env.OPENROUTER_API_KEY && resumen.includes(process.env.OPENROUTER_API_KEY)) {
    errors.push('Fuga de seguridad: la API key de OpenRouter aparece en el resumen.');
  }

  // 3. For successful query tasks, check respuesta_esperada
  if (testCase.respuesta_esperada) {
    if (!resumen.includes(testCase.respuesta_esperada)) {
      errors.push(`El resumen no contiene la respuesta esperada: "${testCase.respuesta_esperada}"`);
    }
  }

  // 4. For failed tasks with reason keys (e.g. E5 homonyms), verify all keys are mentioned
  if (testCase.claves_razon && testCase.claves_razon.length > 0) {
    for (const key of testCase.claves_razon) {
      if (!resumen.includes(key)) {
        errors.push(`El resumen de tarea fallida no contiene la clave requerida: "${key}"`);
      }
    }
  }

  // 5. If task failed, it must NOT contain "respuesta:"
  if (estado === 'fallida' && /^\s*respuesta\s*:/im.test(resumen)) {
    errors.push('Una tarea fallida no debe contener la línea "respuesta:"');
  }

  return { valid: errors.length === 0, errors };
}

export async function runBenchmarkTask(testCase: TestCase): Promise<RunReport> {
  console.log('\n================================================================');
  console.log(`INICIANDO PRUEBA: ${testCase.id} [${testCase.nivel}]`);
  console.log(`Instrucción: "${testCase.instruccion}"`);
  console.log(`Estado Esperado: ${testCase.estado_esperado}`);
  console.log('================================================================');

  const startTime = Date.now();

  // 1. POST /__reset
  await resetDesktop();
  await new Promise((r) => setTimeout(r, 2000));

  // 2. POST /tasks
  const postRes = await fetch(`${AGENT_BASE}/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TEAM_TOKEN}`,
    },
    body: JSON.stringify({
      tarea: testCase.instruccion,
      escritorio: {
        url: DESKTOP_WS,
        password: DESKTOP_PASSWORD,
      },
      debug: Boolean(process.env.DEBUG_SHOTS === '1'),
    }),
  });

  if (!postRes.ok) {
    const errText = await postRes.text();
    throw new Error(`POST /tasks falló con HTTP ${postRes.status}: ${errText}`);
  }

  const { task_id: taskId } = (await postRes.json()) as { task_id: string };
  console.log(`[Runner] Tarea creada con ID: ${taskId}`);

  // 3. Poll GET /tasks/:id every 5 seconds (5 minutes timeout)
  let finalStatus: 'terminada' | 'fallida' | 'en_curso' = 'en_curso';
  let finalSummary = '';
  let finalSteps = 0;
  let finalCostUsd = 0;
  const maxWaitMs = 300000;

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 5000));

    const pollRes = await fetch(`${AGENT_BASE}/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${TEAM_TOKEN}` },
    });

    if (!pollRes.ok) continue;

    const pollData = (await pollRes.json()) as {
      estado: 'terminada' | 'fallida' | 'en_curso';
      resumen: string;
      pasos?: number;
      costo_usd?: number;
    };
    finalStatus = pollData.estado;
    finalSummary = pollData.resumen;
    finalSteps = pollData.pasos || 0;
    finalCostUsd = pollData.costo_usd || 0;

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[${elapsed}s] Estado: ${finalStatus} (pasos: ${finalSteps}, costo: $${finalCostUsd.toFixed(4)})`);

    if (finalStatus !== 'en_curso') break;
  }

  const durationSec = Math.round((Date.now() - startTime) / 1000);

  const steps = finalSteps;
  const costUsd = finalCostUsd;

  sessionTotalCostUsd += costUsd;

  // 4. POST /__check
  const evalResult = await checkWithEvaluator(testCase);

  // 5. Validate summary
  const validation = validateSummaryContent(testCase, finalStatus, finalSummary);

  const report: RunReport = {
    id: testCase.id,
    instruccion: testCase.instruccion,
    estadoFinal: finalStatus,
    estadoEsperado: testCase.estado_esperado,
    resumen: finalSummary,
    evalResult,
    duracionSeg: durationSec,
    pasos: steps,
    costoUsd: costUsd,
    resumenValido: validation.valid,
    falloMotivo: validation.errors.join('; '),
  };

  console.log('\n----------------------------------------------------------------');
  console.log(`REPORTE DE RESULTADOS: ${testCase.id}`);
  console.log(`Tiempo: ${durationSec}s | Pasos: ${steps} | Costo Tarea: $${costUsd.toFixed(4)} USD`);
  console.log(`Costo Acumulado Sesión: $${sessionTotalCostUsd.toFixed(4)} USD`);
  console.log(`Estado: ${finalStatus} (Esperado: ${testCase.estado_esperado})`);
  console.log(`Resumen: "${finalSummary}"`);
  console.log(`Resultado Evaluador (__check):`, JSON.stringify(evalResult, null, 2));
  console.log(`Validación de Resumen: ${validation.valid ? 'PASS' : `FAIL (${validation.errors.join(', ')})`}`);
  console.log('----------------------------------------------------------------\n');

  // Check stopping rules
  if (costUsd > 0.10) {
    console.error(`\n[ALERTA DE PARADA] Tarea ${testCase.id} superó US$ 0.10 ($${costUsd.toFixed(4)}). Deteniendo ejecución.`);
    process.exit(1);
  }
  if (sessionTotalCostUsd > 3.00) {
    console.error(`\n[ALERTA DE PARADA] Costo acumulado superó US$ 3.00 ($${sessionTotalCostUsd.toFixed(4)}). Deteniendo ejecución.`);
    process.exit(1);
  }

  const passed = finalStatus === testCase.estado_esperado && (evalResult?.pass !== false);
  if (!passed) {
    consecutiveFailures++;
    lastFailureReason = report.falloMotivo || 'Evaluación remota falló';
    if (consecutiveFailures >= 2) {
      console.error(`\n[ALERTA DE PARADA] 2 tareas seguidas fallaron por la causa: "${lastFailureReason}". Deteniendo.`);
      process.exit(1);
    }
  } else {
    consecutiveFailures = 0;
  }

  return report;
}

async function main() {
  const targetArg = process.argv[2] || 'E1';
  const pruebasDir = path.resolve('pruebas');

  const orderedFiles = [
    { id: 'E1', file: 'E1-crear-cliente.json' },
    { id: 'E5', file: 'E5-homonimos.json' },
    { id: 'E3', file: 'E3-facturas-vencidas.json' },
    { id: 'E2', file: 'E2-direccion-con-nota.json' },
    { id: 'E4', file: 'E4-exportar-pedidos.json' },
  ];

  if (targetArg === 'all') {
    const allReports: RunReport[] = [];
    for (const item of orderedFiles) {
      const fullPath = path.join(pruebasDir, item.file);
      if (fs.existsSync(fullPath)) {
        const testCase = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as TestCase;
        const rep = await runBenchmarkTask(testCase);
        allReports.push(rep);
      }
    }

    console.log('\n================================================================');
    console.log('TABLA RESUMEN DE TODAS LAS PRUEBAS OFICIALES:');
    console.log('================================================================');
    console.log('ID | Estado | Esperado | Check | Pasos | Tiempo | Costo USD | Resumen');
    for (const r of allReports) {
      const checkPass = r.evalResult?.pass ? 'PASS' : 'FAIL';
      console.log(`${r.id.padEnd(3)} | ${r.estadoFinal.padEnd(9)} | ${r.estadoEsperado.padEnd(8)} | ${checkPass.padEnd(5)} | ${String(r.pasos).padStart(5)} | ${String(r.duracionSeg).padStart(4)}s | $${r.costoUsd.toFixed(4)} | ${r.resumen.slice(0, 40)}...`);
    }
  } else {
    const found = orderedFiles.find((f) => f.id.toUpperCase() === targetArg.toUpperCase());
    const fileToLoad = found ? found.file : `${targetArg.toUpperCase()}.json`;
    const fullPath = path.join(pruebasDir, fileToLoad);

    if (!fs.existsSync(fullPath)) {
      console.error(`Archivo de prueba no encontrado: ${fullPath}`);
      process.exit(1);
    }

    const testCase = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as TestCase;
    await runBenchmarkTask(testCase);
  }
}

main().catch((err) => {
  console.error('Error fatal en runner:', err);
  process.exit(1);
});
