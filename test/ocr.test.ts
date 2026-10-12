import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PNG } from 'pngjs';
import {
  ocrAvailable,
  ocrScreenshot,
  findTextMatches,
  extractTargetText,
  findFieldNearLabel,
  OcrWord,
} from '../src/agent/ocr.js';

const w = (text: string, x: number, y: number, line: string, conf = 95): OcrWord => ({
  text,
  conf,
  box: { x, y, w: text.length * 7, h: 10 },
  lineKey: line,
});

test('OCR - extractTargetText usa "texto" o lo que va entre comillas', () => {
  assert.equal(extractTargetText("botón 'Entendido' del diálogo"), 'Entendido');
  assert.equal(extractTargetText('menú “Comercial”'), 'Comercial');
  assert.equal(extractTargetText('icono de lupa'), null);
  assert.equal(extractTargetText('lo que sea', 'Guardar'), 'Guardar');
});

test('OCR - findTextMatches prefiere la etiqueta suelta, tolera tildes y errores leves', () => {
  const words = [
    w('Comercial', 126, 39, 'A:1-1-1'),
    w('Use', 229, 94, 'A:1-1-2'),
    w('comercial.', 169, 93, 'A:1-1-2'),
    w('Teléfono', 300, 200, 'A:2-1-1'),
    w('Nuevo', 400, 300, 'A:3-1-1'),
    w('cl1ente', 445, 300, 'A:3-1-1', 80),
  ];
  const m = findTextMatches(words, 'Comercial');
  assert.equal(m[0].box.y, 39, 'debe elegir el menú y no el texto del cuerpo');
  assert.ok(findTextMatches(words, 'Telefono').length === 1, 'sin tilde también');
  assert.ok(findTextMatches(words, 'Nuevo cliente').length === 1, 'frase con error OCR de 1 letra');
  assert.equal(findTextMatches(words, 'Eliminar').length, 0);
});

test('OCR - findFieldNearLabel encuentra la caja de entrada a la derecha de la etiqueta', () => {
  const png = new PNG({ width: 400, height: 100 });
  png.data.fill(0);
  for (let i = 0; i < 400 * 100; i++) {
    png.data[i * 4] = 210; png.data[i * 4 + 1] = 215; png.data[i * 4 + 2] = 225; png.data[i * 4 + 3] = 255;
  }
  // Caja de entrada: borde gris oscuro x=150..350, y=40..62, interior blanco
  for (let y = 40; y <= 62; y++) {
    for (let x = 150; x <= 350; x++) {
      const border = x === 150 || x === 350 || y === 40 || y === 62;
      const v = border ? 120 : 255;
      const i = (y * 400 + x) * 4;
      png.data[i] = v; png.data[i + 1] = v; png.data[i + 2] = v;
    }
  }
  const p = findFieldNearLabel(PNG.sync.write(png), { x: 40, y: 46, w: 60, h: 10 });
  assert.ok(p, 'debe encontrar el campo');
  assert.ok(p!.x > 150 && p!.x < 350 && p!.y > 40 && p!.y < 62, JSON.stringify(p));
});

test('OCR - captura real de SIGECOM: "Entendido" y menús con precisión de píxel', { timeout: 60000 }, async (t) => {
  if (!(await ocrAvailable())) {
    t.skip('Tesseract no está instalado en esta máquina');
    return;
  }
  // Captura del usuario (imagen a escala 0.83 de la pantalla real); el botón "Entendido" está en ≈(749,404).
  const buf = fs.readFileSync('test/fixtures/sigecom-modal.png');
  const words = await ocrScreenshot(buf);
  const ent = findTextMatches(words, 'Entendido')[0];
  assert.ok(ent, 'debe encontrar Entendido');
  const cx = ent.box.x + ent.box.w / 2;
  const cy = ent.box.y + ent.box.h / 2;
  assert.ok(Math.abs(cx - 749) <= 6 && Math.abs(cy - 404) <= 5, `Entendido en (${cx},${cy})`);
  const com = findTextMatches(words, 'Comercial')[0];
  assert.ok(Math.abs(com.box.y + com.box.h / 2 - 43) <= 5, 'Comercial del menú superior');
});

test('OCR - findFieldNearLabel con campo que ya tiene texto y borde suave sobre fondo blanco', () => {
  const W = 500, H = 80;
  const png = new PNG({ width: W, height: H });
  for (let i = 0; i < W * H; i++) { png.data[i * 4] = 255; png.data[i * 4 + 1] = 255; png.data[i * 4 + 2] = 255; png.data[i * 4 + 3] = 255; }
  const set = (x: number, y: number, v: number) => { const i = (y * W + x) * 4; png.data[i] = v; png.data[i + 1] = v; png.data[i + 2] = v; };
  // Caja x=160..460, y=30..54 con borde #ccc (204) e interior blanco; texto oscuro desde x=168
  for (let x = 160; x <= 460; x++) { set(x, 30, 204); set(x, 54, 204); }
  for (let y = 30; y <= 54; y++) { set(160, y, 204); set(460, y, 204); }
  for (let x = 168; x < 300; x += 3) for (let y = 37; y < 47; y++) set(x, y, 40);
  const p = findFieldNearLabel(PNG.sync.write(png), { x: 60, y: 37, w: 70, h: 10 });
  assert.ok(p && p.x > 160 && p.x < 460 && p.y > 30 && p.y < 54, JSON.stringify(p));
});

test('OCR - screenTextForPrompt arma filas de arriba abajo y separa columnas', async () => {
  const { screenTextForPrompt } = await import('../src/agent/ocr.js');
  const words: OcrWord[] = [
    w('Ayuda', 354, 39, 'B:1'),
    w('Archivo', 65, 39, 'B:1'),
    w('Total:', 60, 300, 'A:2'),
    w('45', 110, 300, 'A:2'),
    w('Archivo', 66, 40, 'A:1'), // duplicado de otra variante
  ];
  const txt = screenTextForPrompt(words);
  const lines = txt.split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('Archivo | Ayuda'), lines[0]);
  assert.ok(lines[1].includes('Total: 45'), lines[1]);
  assert.equal((txt.match(/Archivo/g) || []).length, 1, 'sin duplicados entre variantes');
});

test('OCR - varias tareas a la vez no bloquean (semáforo de procesos)', { timeout: 120000 }, async (t) => {
  if (!(await ocrAvailable())) {
    t.skip('Tesseract no está instalado en esta máquina');
    return;
  }
  const base = PNG.sync.read(fs.readFileSync('test/fixtures/sigecom-modal.png'));
  const jobs = [0, 1, 2, 3, 4].map((k) => {
    const p = new PNG({ width: base.width, height: base.height });
    base.data.copy(p.data);
    p.data[k * 4] = (p.data[k * 4] + 1) % 256; // imagen distinta => sin caché
    return ocrScreenshot(PNG.sync.write(p));
  });
  const res = await Promise.all(jobs);
  assert.ok(res.every((r) => findTextMatches(r, 'Entendido').length > 0), 'todas encuentran Entendido');
});
