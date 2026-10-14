/**
 * Corre el agente COMPLETO (bucle, OCR, localizador, cliente RFB, plazos y bitácora) contra el escritorio GESTORA
 * local SIN gastar en modelos. Las llamadas a OpenRouter se interceptan dentro de este proceso:
 *  - al planificador se le responde con un guion fijo de decisiones (las que tomó Claude Sonnet 5.5 en la corrida
 *    del 13/10, en los puntos donde falló el ejecutor);
 *  - a cada consulta de visión se le responde "no lo veo" y se cuenta, porque en una corrida real se paga.
 * Prueba el EJECUTOR (lo que hace el agente con una decisión), no al planificador: el guion no se adapta a la
 * pantalla. Si un paso del ejecutor falla, el guion sigue igual y el resultado lo muestra.
 *
 * AGENTE_DIR permite correr el mismo guion con otra versión del agente (p. ej. un `git worktree` de un commit
 * anterior) para comparar antes y después en la misma máquina y con el mismo escritorio.
 *
 * Uso (escritorio local en :8099, ver medir-localizador.ts):
 *   npx tsx scripts/simular-tarea.ts [submenu] [g15] [buscar] [g04]
 *   AGENTE_DIR=/ruta/al/worktree npx tsx scripts/simular-tarea.ts g15
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ESCRITORIO = process.env.SIM_ESCRITORIO || 'http://localhost:8099';
const TOKEN = process.env.SIM_TOKEN || 'x';
const VNC_PASS = process.env.SIM_VNC_PASSWORD || 'clave123';
const AGENTE_DIR = path.resolve(process.env.AGENTE_DIR || '.');

type Accion = Record<string, unknown>;
type Plan = { pensamiento: string; acciones: Accion[] };
interface Guion {
  tarea: string;
  pasos: Plan[];
  /** Comprobación final: texto que debe verse en la última captura, o una prueba para /__check. */
  verTexto?: string[];
  noVerTexto?: string[];
  check?: string;
}

const c = (objetivo: string, texto: string): Accion => ({ action: 'click', objetivo, texto });
const GUIONES: Record<string, Guion> = {
  // 17 de 20 pruebas del 13/10 (Sonnet) gastaron un paso porque el submenú de Tk no abre con el ratón.
  submenu: {
    tarea: 'Abre la lista de clientes.',
    pasos: [
      { pensamiento: 'Cierro el aviso y abro Comercial.', acciones: [c('botón del diálogo de novedades', 'Entendido'), c('menú superior Comercial', 'Comercial')] },
      { pensamiento: 'Paso el ratón por Maestros.', acciones: [{ action: 'move', objetivo: 'opción del menú Comercial', texto: 'Maestros' }] },
      { pensamiento: 'Abro Clientes.', acciones: [c('opción del submenú Maestros', 'Clientes')] },
      { pensamiento: 'Listo.', acciones: [{ action: 'finish', resumen: 'Lista de clientes abierta.' }] },
    ],
    verTexto: ['Nuevo cliente'],
  },
  // G15 (13/10): el planificador nombró la lista Estado por su valor ("Pagada") y el clic cayó en la tabla.
  g15: {
    tarea: '¿Cuántas facturas pagadas y cuántas pendientes tiene Ferretería Ruiz Hermanos?',
    pasos: [
      { pensamiento: 'Cierro el aviso y abro Cartera.', acciones: [c('botón del diálogo de novedades', 'Entendido'), c('menú superior Cartera', 'Cartera')] },
      { pensamiento: 'Abro Facturas.', acciones: [c('opción del menú Cartera', 'Facturas')] },
      {
        pensamiento: 'Filtro por cliente y abro la lista Estado.',
        acciones: [
          { action: 'type_text', objetivo: 'campo Cliente del filtro', texto: 'Cliente:', text: 'Ruiz', clear_first: true },
          c('lista desplegable Estado en la barra de filtros', 'Todos'),
        ],
      },
      { pensamiento: 'Elijo Pagada y filtro.', acciones: [c('opción de la lista desplegable Estado', 'Pagada'), c('botón Filtrar', 'Filtrar')] },
      { pensamiento: 'Pagadas: 15. Abro la lista Estado para elegir Pendiente.', acciones: [c('lista desplegable Estado en la barra de filtros', 'Pagada')] },
      { pensamiento: 'Elijo Pendiente y filtro.', acciones: [c('opción de la lista desplegable Estado', 'Pendiente'), c('botón Filtrar', 'Filtrar')] },
      { pensamiento: 'Leo el total.', acciones: [{ action: 'finish', resultado: '15;4', resumen: 'Filtré por Ruiz y estado.' }] },
    ],
    verTexto: ['de 4 facturas'],
  },
  // G06/G07/G13/G20 (13/10): el planificador copió "Buscar (nombre | documento):" del texto OCR que le dimos.
  buscar: {
    tarea: 'Busca el cliente Distribuciones La Ceiba.',
    pasos: [
      { pensamiento: 'Cierro el aviso y abro Comercial.', acciones: [c('botón del diálogo de novedades', 'Entendido'), c('menú superior Comercial', 'Comercial')] },
      { pensamiento: 'Abro el submenú Maestros.', acciones: [{ action: 'move', objetivo: 'opción del menú Comercial', texto: 'Maestros' }] },
      { pensamiento: 'Abro Clientes.', acciones: [c('opción del submenú Maestros', 'Clientes')] },
      {
        pensamiento: 'Busco Ceiba.',
        acciones: [
          { action: 'type_text', objetivo: 'campo de búsqueda', texto: 'Buscar (nombre | documento):', text: 'Ceiba', clear_first: true },
          c('botón Buscar', 'Buscar'),
        ],
      },
      { pensamiento: 'Listo.', acciones: [{ action: 'finish', resumen: 'Búsqueda hecha.' }] },
    ],
    verTexto: ['La Ceiba'],
    noVerTexto: ['Ferretería Ruiz Hermanos'], // CL-0001; el código no sirve: el OCR tolera 1 carácter (CL-0002)
  },
  // G04 (13/10): las fechas se escribían en la cabecera de la tabla y se acabó el presupuesto.
  g04: {
    tarea: 'Exporta el reporte de pedidos entregados en septiembre de 2026.',
    pasos: [
      { pensamiento: 'Cierro el aviso y abro Comercial.', acciones: [c('botón del diálogo de novedades', 'Entendido'), c('menú superior Comercial', 'Comercial')] },
      { pensamiento: 'Abro el submenú Ventas.', acciones: [{ action: 'move', objetivo: 'opción del menú Comercial', texto: 'Ventas' }] },
      { pensamiento: 'Abro Pedidos.', acciones: [c('opción del submenú Ventas', 'Pedidos')] },
      {
        pensamiento: 'Fechas y lista Estado.',
        acciones: [
          { action: 'type_text', objetivo: 'campo Desde del filtro', texto: 'Desde:', text: '01/09/2026', clear_first: true },
          { action: 'type_text', objetivo: 'campo Hasta del filtro', texto: 'Hasta:', text: '30/09/2026', clear_first: true },
          c('lista desplegable Estado en la barra de filtros', 'Todos'),
        ],
      },
      { pensamiento: 'Entregado y filtrar.', acciones: [c('opción de la lista desplegable Estado', 'Entregado'), c('botón Filtrar', 'Filtrar')] },
      { pensamiento: 'Exporto.', acciones: [c('botón de la barra de acciones', 'Exportar lista…')] },
      { pensamiento: 'Confirmo.', acciones: [c('botón del diálogo Exportar lista de pedidos', 'Exportar')] },
      { pensamiento: 'Listo.', acciones: [{ action: 'finish', resumen: 'Exportado.' }] },
    ],
    check: 'G04',
  },
};

// ---------------------------------------------------------------- planificador y visión simulados
let guion: Plan[] = [];
let consultasVision = 0;
let llamadasPlanificador = 0;
const fetchReal = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (!/\/chat\/completions$/.test(url)) return fetchReal(input, init);
  const body = JSON.parse(String(init?.body ?? '{}'));
  const texto = JSON.stringify(body.messages ?? []);
  let content: string;
  if (texto.includes('Acciones disponibles')) {
    llamadasPlanificador++;
    const plan = guion.shift() ?? { pensamiento: 'Fin del guion.', acciones: [{ action: 'fail', razon: 'guion agotado; claves: simulación' }] };
    content = JSON.stringify(plan);
  } else {
    consultasVision++;
    content = '{"x": null, "y": null, "box_2d": null}';
  }
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { cost: 0 } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}) as typeof fetch;

process.env.OPENROUTER_API_KEY = 'simulado';
process.env.MODEL_ID = 'anthropic/claude-sonnet-5.5';
process.env.GROUNDING_MODEL_ID = 'anthropic/claude-sonnet-5.5';
process.env.MAX_COST_USD_PER_TASK = '1';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const { runAgentTask } = await import(path.join(AGENTE_DIR, 'src/agent/loop.ts'));
const { globalTaskStore } = await import(path.join(AGENTE_DIR, 'src/tasks/store.ts'));
const { ocrScreenshot, findTextMatches } = await import(path.join(AGENTE_DIR, 'src/agent/ocr.ts'));
globalTaskStore.setWorkerRunner(runAgentTask);

const nombres = process.argv.slice(2).length > 0 ? process.argv.slice(2) : Object.keys(GUIONES);
let commit = 'desconocido';
try {
  commit = execFileSync('git', ['-C', AGENTE_DIR, 'describe', '--always'], { encoding: 'utf-8' }).trim();
  // Solo cuenta el código: los archivos de evidencia se reescriben durante la propia corrida.
  const cambios = execFileSync('git', ['-C', AGENTE_DIR, 'status', '--porcelain', '--', 'src', 'scripts', 'escritorio', 'package.json'], {
    encoding: 'utf-8',
  }).trim();
  if (cambios) commit += '+cambios-sin-commit';
} catch {
  /* sin git */
}
console.log(`Agente: ${AGENTE_DIR} (commit ${commit}) | escritorio: ${ESCRITORIO} | ${new Date().toISOString()}`);

for (const nombre of nombres) {
  const g = GUIONES[nombre];
  if (!g) {
    console.log(`\n== ${nombre}: no existe ese guion`);
    continue;
  }
  await fetchReal(`${ESCRITORIO}/__reset`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } });
  await sleep(3500);
  guion = g.pasos.map((p) => JSON.parse(JSON.stringify(p)));
  consultasVision = 0;
  llamadasPlanificador = 0;
  const t0 = Date.now();
  const ws = ESCRITORIO.replace(/^http/, 'ws') + '/websockify';
  const task = globalTaskStore.createTask({ tarea: g.tarea, escritorio: { url: ws, password: VNC_PASS } });
  while (task.estado === 'en_curso') await sleep(500);
  const segundos = Math.round((Date.now() - t0) / 1000);

  const fallas: string[] = [];
  const shots: Buffer[] = task.shots ?? [];
  const ultima = shots[shots.length - 1];
  if (ultima && (g.verTexto || g.noVerTexto)) {
    const words = await ocrScreenshot(ultima);
    for (const t of g.verTexto ?? []) if (findTextMatches(words, t).length === 0) fallas.push(`no se ve "${t}"`);
    for (const t of g.noVerTexto ?? []) if (findTextMatches(words, t).length > 0) fallas.push(`se ve "${t}" y no debía`);
  }
  if (g.check) {
    const prueba = JSON.parse(fs.readFileSync(`pruebas-propias/${g.check}.json`, 'utf-8'));
    const r = await fetchReal(`${ESCRITORIO}/__check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(prueba),
    }).then((x) => x.json() as Promise<{ pass: boolean; faltantes?: unknown[]; sobrantes?: unknown[] }>);
    if (!r.pass) fallas.push(`/__check: ${JSON.stringify({ faltantes: r.faltantes, sobrantes: r.sobrantes })}`);
  }
  const ok = task.estado === 'terminada' && fallas.length === 0;
  console.log(`\n== ${nombre}: ${ok ? 'PASA' : 'FALLA'} | estado ${task.estado} | ${segundos} s | pasos ${task.stepCount} | planificador ${llamadasPlanificador} | consultas de visión ${consultasVision}`);
  if (fallas.length) console.log(`   ${fallas.join(' | ')}`);
  if (task.estado !== 'terminada') console.log(`   resumen: ${String(task.resumen).slice(0, 300)}`);
  for (const l of task.trace ?? []) console.log(`   ${l}`);
}
process.exit(0);
