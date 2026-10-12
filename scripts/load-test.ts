/**
 * Prueba de carga del entrypoint: lanza N tareas a la vez (solo lectura) y mide si /health y GET /tasks
 * siguen respondiendo. Sirve para comprobar que el servidor no se cae con el set de evaluación.
 * Uso: npx tsx scripts/load-test.ts [N=8]   (usa AGENT_URL, TEAM_TOKEN, DESKTOP_WS_URL, DESKTOP_PASSWORD del .env)
 * Nota: varias tareas sobre el MISMO escritorio de práctica chocan entre sí; aquí solo importa la estabilidad.
 */
import dotenv from 'dotenv';
dotenv.config();

const BASE = process.env.AGENT_URL || 'http://127.0.0.1:3000';
const TOKEN = process.env.TEAM_TOKEN || '';
const N = Number(process.argv[2]) || 8;
const auth = { Authorization: `Bearer ${TOKEN}` };

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; ok: boolean; status?: number }> {
  const t = Date.now();
  try {
    const r: any = await fn();
    return { ms: Date.now() - t, ok: r.ok, status: r.status };
  } catch {
    return { ms: Date.now() - t, ok: false };
  }
}

async function main() {
  console.log(`[carga] ${N} tareas simultáneas contra ${BASE}`);
  const posts = await Promise.all(
    Array.from({ length: N }, () =>
      fetch(`${BASE}/tasks`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tarea: '¿Cuántas facturas vencidas tiene Ferretería Ruiz?',
          escritorio: { url: process.env.DESKTOP_WS_URL, password: process.env.DESKTOP_PASSWORD },
        }),
        signal: AbortSignal.timeout(10000),
      })
        .then(async (r) => ({ ok: r.ok, id: r.ok ? ((await r.json()) as any).task_id : null }))
        .catch(() => ({ ok: false, id: null }))
    )
  );
  const ids = posts.filter((p) => p.id).map((p) => p.id as string);
  console.log(`[carga] POST aceptados: ${ids.length}/${N}`);

  let maxHealth = 0;
  let fallos = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 300000) {
    await new Promise((r) => setTimeout(r, 5000));
    const h = await timed(() => fetch(`${BASE}/health`, { signal: AbortSignal.timeout(10000) }));
    maxHealth = Math.max(maxHealth, h.ms);
    if (!h.ok) fallos++;
    const estados = await Promise.all(
      ids.map((id) =>
        fetch(`${BASE}/tasks/${id}`, { headers: auth, signal: AbortSignal.timeout(10000) })
          .then(async (r) => (r.ok ? ((await r.json()) as any).estado : `HTTP ${r.status}`))
          .catch(() => 'sin respuesta')
      )
    );
    const resumen = estados.reduce((acc: Record<string, number>, e) => ((acc[e] = (acc[e] || 0) + 1), acc), {});
    console.log(`[${Math.round((Date.now() - t0) / 1000)}s] /health ${h.ok ? 'OK' : 'FALLÓ'} ${h.ms} ms | ${JSON.stringify(resumen)}`);
    if (estados.every((e) => e === 'terminada' || e === 'fallida')) break;
  }
  console.log(`[carga] /health máx ${maxHealth} ms, fallos de /health: ${fallos}. ${fallos === 0 ? 'ESTABLE' : 'INESTABLE'}`);
}

main();
