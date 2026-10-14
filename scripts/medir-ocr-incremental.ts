/**
 * Mide, SIN gastar en modelos, el OCR incremental contra el OCR completo sobre pares de capturas reales de GESTORA.
 *
 * Para cada par (antes -> después): tiempo del OCR completo de "después", tiempo del incremental (que solo relee
 * las zonas que cambiaron respecto de "antes"), palabras que difieren y posición de textos objetivo con cada uno.
 *
 * Uso: npx tsx scripts/medir-ocr-incremental.ts docs/evidencia/mediciones/ocr-incremental-2026-10-14
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { ocrScreenshot, ocrIncremental, findTextMatches, changedRegions } from '../src/agent/ocr.js';

const S = process.argv[2] || 'docs/evidencia/mediciones/ocr-incremental-2026-10-14';
const pares: Array<[string, string, string, string[]]> = [
  ['mover el puntero sobre la lista', 'i1-lista', 'i2-lista-cursor', ['Clientes', 'Nuevo cliente', 'CL-0010', 'Ciudad:']],
  ['escribir un nombre en el formulario', 'i3-form', 'i4-form-nombre', ['Nombre o razón social', 'Número de documento', 'Guardar', 'Papelería Los Andes']],
  ['abrir la lista de ciudades', 'i4-form-nombre', 'i5-form-combo', ['Pereira', 'Armenia', 'Teléfono', 'Guardar']],
];
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\d]/gu, '').toLowerCase();
const centro = (m: any) => (m ? `(${Math.round(m.box.x + m.box.w / 2)},${Math.round(m.box.y + m.box.h / 2)})` : 'NO');

console.log(`Equipo: ${os.cpus().length} CPU, ${os.cpus()[0]?.model ?? '?'} | ${new Date().toISOString()}`);
for (const [nombre, a, b, objetivos] of pares) {
  const pa = readFileSync(`${S}/${a}.png`);
  const pb = readFileSync(`${S}/${b}.png`);
  const wa = await ocrScreenshot(pa);
  let t = Date.now();
  // Copia del buffer para no reutilizar la caché del OCR de la misma imagen.
  const full = await ocrScreenshot(Buffer.from(pb));
  const tFull = Date.now() - t;
  t = Date.now();
  const inc = await ocrIncremental(pb, { png: pa, words: wa });
  const tInc = Date.now() - t;
  const setF = new Set(full.map((w) => norm(w.text)).filter((w) => w.length >= 3));
  const setI = new Set(inc.words.map((w) => norm(w.text)).filter((w) => w.length >= 3));
  const faltan = [...setF].filter((w) => !setI.has(w));
  const sobran = [...setI].filter((w) => !setF.has(w));
  console.log(`\n== ${nombre} (${a} -> ${b})`);
  console.log(`   zonas cambiadas: ${JSON.stringify(changedRegions(pa, pb))} | modo: ${inc.modo}`);
  console.log(`   OCR completo ${tFull} ms | incremental ${tInc} ms`);
  console.log(`   palabras distintas: completo ${setF.size}, incremental ${setI.size}`);
  console.log(`   faltan en incremental: ${faltan.join(' ') || '-'} | sobran: ${sobran.join(' ') || '-'}`);
  for (const o of objetivos) {
    const mf = findTextMatches(full, o)[0];
    const mi = findTextMatches(inc.words, o)[0];
    console.log(`   "${o}": completo ${centro(mf)} | incremental ${centro(mi)}`);
  }
}
process.exit(0);
