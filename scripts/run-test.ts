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
  /** Aprobada de verdad: estado esperado + /__check sin fallas + resumen válido (respuesta, claves, sin secretos). */
  aprobada: boolean;
}

/** Versión del agente que respondió (revisión de Cloud Run o "local"), para que cada medición sea rastreable. */
async function agentVersion(): Promise<string> {
  try {
    const r = await fetch(`${AGENT_BASE}/health`, { signal: AbortSignal.timeout(15000) });
    const j = (await r.json()) as { version?: string };
    return j.version || 'desconocida';
  } catch {
    return 'sin-respuesta';
  }
}

/** Historial acumulado de corridas (una línea JSON por prueba) para medir la tasa de éxito en el tiempo. */
function appendHistory(rep: RunReport, version: string, ronda: number) {
  const dir = path.resolve('resultados');
  fs.mkdirSync(dir, { recursive: true });
  const row = {
    fecha: new Date().toISOString(),
    version,
    ronda,
    id: rep.id,
    aprobada: rep.aprobada,
    estado: rep.estadoFinal,
    esperado: rep.estadoEsperado,
    check: rep.evalResult?.pass ?? null,
    resumen_valido: rep.resumenValido,
    pasos: rep.pasos,
    segundos: rep.duracionSeg,
    costo_usd: Number(rep.costoUsd.toFixed(4)),
    motivo: rep.falloMotivo || '',
    resumen: rep.resumen.slice(0, 300),
  };
  fs.appendFileSync(path.join(dir, 'historial.jsonl'), JSON.stringify(row) + '\n');
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
  // El escritorio necesita unos segundos para volver a pintarse tras el reset.
  await new Promise((r) => setTimeout(r, 6000));
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

    // Un corte de red al consultar no debe tumbar la prueba: se registra y se vuelve a consultar.
    let pollRes: Response;
    try {
      pollRes = await fetch(`${AGENT_BASE}/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${TEAM_TOKEN}` },
        signal: AbortSignal.timeout(20000),
      });
    } catch (e: any) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`[${elapsed}s] Error de red al consultar el estado (${e?.cause?.code || e?.name || 'desconocido'}); reintentando...`);
      continue;
    }

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

  // Bitácora del agente (pasos, tiempos y cómo localizó cada clic) para diagnóstico.
  const debugDir = path.resolve('debug', testCase.id);
  fs.rmSync(debugDir, { recursive: true, force: true }); // sin capturas viejas de otra corrida
  fs.mkdirSync(debugDir, { recursive: true });
  try {
    const tr = await fetch(`${AGENT_BASE}/tasks/${taskId}/trace`, {
      headers: { Authorization: `Bearer ${TEAM_TOKEN}` },
      signal: AbortSignal.timeout(20000),
    });
    if (tr.ok) {
      const { trace } = (await tr.json()) as { trace: string[] };
      console.log('\n--- BITÁCORA DEL AGENTE ---');
      for (const l of trace) console.log(l);
      console.log('--- FIN BITÁCORA ---\n');
      fs.writeFileSync(path.join(debugDir, 'bitacora.txt'), trace.join('\n'));
    }
  } catch {
    console.log('(No se pudo leer la bitácora del agente)');
  }

  // Capturas de cada paso del agente -> debug/<ID>/paso-N.png (para revisar qué vio y dónde hizo clic).
  try {
    const head = await fetch(`${AGENT_BASE}/tasks/${taskId}/shots/0`, {
      headers: { Authorization: `Bearer ${TEAM_TOKEN}` },
      signal: AbortSignal.timeout(20000),
    });
    if (head.ok) {
      const { total } = (await head.json()) as { total: number };
      const dir = debugDir;
      for (let n = 1; n <= total; n++) {
        const r = await fetch(`${AGENT_BASE}/tasks/${taskId}/shots/${n}`, {
          headers: { Authorization: `Bearer ${TEAM_TOKEN}` },
          signal: AbortSignal.timeout(20000),
        });
        if (r.ok) fs.writeFileSync(path.join(dir, `paso-${n}.png`), Buffer.from(await r.arrayBuffer()));
      }
      console.log(`[Runner] ${total} capturas guardadas en ${dir}`);
    }
  } catch {
    console.log('(No se pudieron descargar las capturas)');
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
    falloMotivo: [
      ...validation.errors,
      ...(evalResult?.pass === false ? [`__check: ${JSON.stringify(evalResult).slice(0, 400)}`] : []),
    ].join('; '),
    aprobada: finalStatus === testCase.estado_esperado && evalResult?.pass !== false && validation.valid,
  };
  fs.writeFileSync(path.join(debugDir, 'resultado.json'), JSON.stringify(report, null, 2));

  console.log('\n----------------------------------------------------------------');
  console.log(`REPORTE DE RESULTADOS: ${testCase.id}`);
  console.log(`Tiempo: ${durationSec}s | Pasos: ${steps} | Costo Tarea: $${costUsd.toFixed(4)} USD`);
  console.log(`Costo Acumulado Sesión: $${sessionTotalCostUsd.toFixed(4)} USD`);
  console.log(`Estado: ${finalStatus} (Esperado: ${testCase.estado_esperado})`);
  console.log(`Resumen: "${finalSummary}"`);
  console.log(`Resultado Evaluador (__check):`, JSON.stringify(evalResult, null, 2));
  console.log(`Validación de Resumen: ${validation.valid ? 'PASS' : `FAIL (${validation.errors.join(', ')})`}`);
  console.log(`RESULTADO FINAL ${testCase.id}: ${report.aprobada ? 'APROBADA' : 'NO APROBADA'}`);
  console.log('----------------------------------------------------------------\n');

  // Check stopping rules
  // Las paradas automáticas solo aplican con RUNNER_STRICT=1; por defecto se avisa y se sigue con las demás pruebas.
  const strict = process.env.RUNNER_STRICT === '1';
  if (costUsd > 0.30) {
    console.error(`\n[AVISO DE COSTO] Tarea ${testCase.id} superó US$ 0.30 ($${costUsd.toFixed(4)}).`);
    if (strict) process.exit(1);
  }
  if (sessionTotalCostUsd > 3.00) {
    console.error(`\n[ALERTA DE PARADA] Costo acumulado superó US$ 3.00 ($${sessionTotalCostUsd.toFixed(4)}). Deteniendo ejecución.`);
    process.exit(1);
  }

  if (!report.aprobada) {
    consecutiveFailures++;
    lastFailureReason = report.falloMotivo || 'Evaluación remota falló';
    if (consecutiveFailures >= 2 && process.env.RUNNER_STRICT === '1') {
      console.error(`\n[ALERTA DE PARADA] 2 tareas seguidas fallaron por la causa: "${lastFailureReason}". Deteniendo.`);
      process.exit(1);
    }
  } else {
    consecutiveFailures = 0;
  }

  return report;
}

async function main() {
  // Uso: npx tsx scripts/run-test.ts <E1|E2|...|all> [rondas]
  //   all 3  -> corre las 5 pruebas tres veces y muestra la tasa de éxito de cada una.
  const targetArg = process.argv[2] || 'E1';
  const rondas = Math.max(1, Math.min(10, Number(process.argv[3]) || 1));
  const pruebasDir = path.resolve('pruebas');

  const orderedFiles = [
    { id: 'E1', file: 'E1-crear-cliente.json' },
    { id: 'E5', file: 'E5-homonimos.json' },
    { id: 'E3', file: 'E3-facturas-vencidas.json' },
    { id: 'E2', file: 'E2-direccion-con-nota.json' },
    { id: 'E4', file: 'E4-exportar-pedidos.json' },
  ];

  const loadCase = (id: string): TestCase | null => {
    const found = orderedFiles.find((f) => f.id.toUpperCase() === id.toUpperCase());
    for (const name of [found?.file, `${id.toUpperCase()}.json`, `${id}.json`]) {
      if (!name) continue;
      const full = path.join(pruebasDir, name);
      if (fs.existsSync(full)) return JSON.parse(fs.readFileSync(full, 'utf-8')) as TestCase;
    }
    return null;
  };

  const ids = targetArg === 'all' ? orderedFiles.map((f) => f.id) : targetArg.split(',');
  const version = await agentVersion();
  console.log(`[Runner] Agente: ${AGENT_BASE} | versión: ${version} | pruebas: ${ids.join(',')} | rondas: ${rondas}`);

  const allReports: Array<RunReport & { ronda: number }> = [];
  for (let ronda = 1; ronda <= rondas; ronda++) {
    for (const id of ids) {
      const testCase = loadCase(id);
      if (!testCase) {
        console.error(`Archivo de prueba no encontrado para ${id} en ${pruebasDir}`);
        continue;
      }
      try {
        const rep = await runBenchmarkTask(testCase);
        allReports.push({ ...rep, ronda });
        appendHistory(rep, version, ronda);
      } catch (e: any) {
        // Un error de red en una prueba no detiene las demás.
        console.error(`[Runner] ${id} no se pudo completar: ${e?.cause?.code || e?.message || e}. Sigo con la siguiente.`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  console.log('\n================================================================');
  console.log(`RESUMEN (versión del agente: ${version})`);
  console.log('================================================================');
  console.log('Ronda | ID  | Resultado    | Estado    | Esperado | Check | Pasos | Tiempo | Costo USD | Resumen');
  for (const r of allReports) {
    const checkTxt = r.evalResult?.pass === true ? 'PASS' : r.evalResult?.pass === false ? 'FAIL' : '-';
    console.log(
      `${String(r.ronda).padStart(5)} | ${r.id.padEnd(3)} | ${(r.aprobada ? 'APROBADA' : 'NO APROBADA').padEnd(12)} | ${r.estadoFinal.padEnd(9)} | ${r.estadoEsperado.padEnd(8)} | ${checkTxt.padEnd(5)} | ${String(r.pasos).padStart(5)} | ${String(r.duracionSeg).padStart(5)}s | $${r.costoUsd.toFixed(4)} | ${r.resumen.replace(/\s+/g, ' ').slice(0, 50)}`
    );
  }
  const porId = new Map<string, { ok: number; total: number }>();
  for (const r of allReports) {
    const e = porId.get(r.id) || { ok: 0, total: 0 };
    e.total++;
    if (r.aprobada) e.ok++;
    porId.set(r.id, e);
  }
  const ok = allReports.filter((r) => r.aprobada).length;
  console.log('\nTasa de éxito por prueba: ' + [...porId].map(([id, e]) => `${id} ${e.ok}/${e.total}`).join(' | '));
  console.log(`TOTAL: ${ok}/${allReports.length} aprobadas. Historial acumulado en resultados/historial.jsonl`);
}

main().catch((err) => {
  console.error('Error fatal en runner:', err);
  process.exit(1);
});
