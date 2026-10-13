/**
 * Diagnóstico del entorno de pruebas, sin mostrar secretos.
 * Comprueba, en orden: variables del .env (solo si existen), el agente en Cloud Run (/health),
 * el escritorio de práctica (HTTP, /__reset) y el VNC (WebSocket + saludo RFB).
 * Escribe el resultado en resultados/diagnostico.txt para que se pueda revisar sin pegar nada en el chat.
 *
 * Uso: npx tsx scripts/diagnostico.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import WebSocket from 'ws';
import { sanitize } from '../src/security/sanitize.js';

dotenv.config();

const lines: string[] = [];
const log = (s: string) => {
  const clean = sanitize(s, process.env.DESKTOP_PASSWORD);
  lines.push(clean);
  console.log(clean);
};

/** Solo el host, sin ruta ni parámetros (pueden llevar tokens). */
function hostOf(u?: string): string {
  if (!u) return '(vacía)';
  try {
    return new URL(u).host;
  } catch {
    return '(URL inválida)';
  }
}

async function step(name: string, fn: () => Promise<string>) {
  const t0 = Date.now();
  try {
    const r = await fn();
    log(`[OK]    ${name}: ${r} (${Date.now() - t0} ms)`);
    return true;
  } catch (e: any) {
    const why = e?.cause?.code || e?.code || e?.name || '';
    log(`[FALLA] ${name}: ${why} ${String(e?.message || e).slice(0, 200)} (${Date.now() - t0} ms)`);
    return false;
  }
}

async function main() {
  log(`Diagnóstico ${new Date().toISOString()}`);
  const vars = ['AGENT_URL', 'TEAM_TOKEN', 'DESKTOP_HTTP_URL', 'DESKTOP_TOKEN', 'DESKTOP_WS_URL', 'DESKTOP_PASSWORD'];
  for (const v of vars) log(`        ${v}: ${process.env[v] ? 'definida' : 'NO DEFINIDA'}`);
  log(`        Agente: ${hostOf(process.env.AGENT_URL) === '(vacía)' ? 'localhost:3000 (AGENT_URL vacía)' : hostOf(process.env.AGENT_URL)}`);
  log(`        Escritorio HTTP: ${hostOf(process.env.DESKTOP_HTTP_URL)} | VNC: ${hostOf(process.env.DESKTOP_WS_URL)}`);

  const agent = process.env.AGENT_URL || 'http://127.0.0.1:3000';
  await step('Agente /health', async () => {
    const r = await fetch(`${agent}/health`, { signal: AbortSignal.timeout(60000) });
    const j = (await r.json()) as { version?: string };
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return `HTTP ${r.status}, versión ${j.version ?? '¿?'}`;
  });

  await step('Agente acepta el token (/metrics)', async () => {
    const r = await fetch(`${agent}/metrics`, {
      headers: { Authorization: `Bearer ${process.env.TEAM_TOKEN || ''}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return `HTTP ${r.status}`;
  });

  const deskHttp = process.env.DESKTOP_HTTP_URL || '';
  await step('Escritorio de práctica responde (HTTP)', async () => {
    const r = await fetch(deskHttp, { signal: AbortSignal.timeout(20000) });
    return `HTTP ${r.status}`;
  });

  await step('Escritorio acepta /__reset', async () => {
    const r = await fetch(`${deskHttp}/__reset`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.DESKTOP_TOKEN || ''}` },
      signal: AbortSignal.timeout(30000),
    });
    const body = (await r.text()).slice(0, 120);
    if (!r.ok) throw new Error(`HTTP ${r.status} ${body}`);
    return `HTTP ${r.status} ${body}`;
  });

  await step('VNC por WebSocket (saludo RFB)', () =>
    new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(process.env.DESKTOP_WS_URL || '');
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('sin respuesta en 20 s'));
      }, 20000);
      ws.on('message', (data: Buffer) => {
        clearTimeout(timer);
        const hello = Buffer.from(data).toString('latin1').slice(0, 12).trim();
        ws.close();
        if (hello.startsWith('RFB')) resolve(`servidor dice "${hello}"`);
        else reject(new Error(`respuesta inesperada "${hello}"`));
      });
      ws.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    })
  );

  const dir = path.resolve('resultados');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'diagnostico.txt'), lines.join('\n') + '\n');
  console.log(`\nGuardado en ${path.join(dir, 'diagnostico.txt')}`);
}

main().catch((e) => {
  console.error('Error inesperado en el diagnóstico:', sanitize(String(e?.message || e)));
  process.exit(1);
});
