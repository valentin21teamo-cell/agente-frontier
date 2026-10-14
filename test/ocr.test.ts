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

function canvas(W: number, H: number, bg = 255) {
  const png = new PNG({ width: W, height: H });
  for (let i = 0; i < W * H; i++) { png.data[i * 4] = bg; png.data[i * 4 + 1] = bg; png.data[i * 4 + 2] = bg; png.data[i * 4 + 3] = 255; }
  const set = (x: number, y: number, v: number) => { const i = (y * W + x) * 4; png.data[i] = v; png.data[i + 1] = v; png.data[i + 2] = v; };
  return { png, set };
}

test('OCR - findFieldNearLabel con la etiqueta ENCIMA del campo', () => {
  const { png, set } = canvas(400, 120);
  for (let x = 40; x <= 300; x++) { set(x, 50, 180); set(x, 76, 180); }
  for (let y = 50; y <= 76; y++) { set(40, y, 180); set(300, y, 180); }
  const p = findFieldNearLabel(PNG.sync.write(png), { x: 40, y: 30, w: 80, h: 10 });
  assert.ok(p && p.y > 50 && p.y < 76 && p.x > 40 && p.x < 300, JSON.stringify(p));
});

test('OCR - findFieldNearLabel NO confunde el texto de una etiqueta vecina con un campo', () => {
  const { png, set } = canvas(500, 80);
  // "letras" de una etiqueta vecina: bloques de 6x9 separados, sin bordes rectos largos
  for (let k = 0; k < 10; k++) for (let x = 200 + k * 9; x < 206 + k * 9; x++) for (let y = 36; y < 45; y++) set(x, y, 30);
  const p = findFieldNearLabel(PNG.sync.write(png), { x: 40, y: 36, w: 90, h: 9 });
  assert.equal(p, null);
});

test('OCR - ocrRegion lee una zona ampliada y devuelve coordenadas de pantalla', { timeout: 60000 }, async (t) => {
  if (!(await ocrAvailable())) { t.skip('Tesseract no está instalado'); return; }
  const { ocrRegion } = await import('../src/agent/ocr.js');
  const buf = fs.readFileSync('test/fixtures/sigecom-modal.png');
  const zw = await ocrRegion(buf, { x: 600, y: 300, w: 400, h: 200 }, 3);
  const m = findTextMatches(zw, 'Entendido')[0];
  assert.ok(m, 'debe encontrar Entendido en la zona');
  assert.ok(Math.abs(m.box.x + m.box.w / 2 - 749) <= 6 && Math.abs(m.box.y + m.box.h / 2 - 404) <= 5, JSON.stringify(m.box));
});

test('OCR - captura real del agente (E1, 12/10): "Clientes" dentro del submenú flotante Comercial > Maestros', { timeout: 60000 }, async (t) => {
  if (!(await ocrAvailable())) { t.skip('Tesseract no está instalado'); return; }
  // Pantalla real 1280x800. Antes del cambio de la variante B a x3, el OCR no leía este texto y el agente
  // terminaba haciendo clic con la visión en (230,92), fuera del submenú. "Clientes" está en ≈(327,76).
  const buf = fs.readFileSync('test/fixtures/sigecom-submenu.png');
  const m = findTextMatches(await ocrScreenshot(buf), 'Clientes')[0];
  assert.ok(m, 'el OCR de pantalla completa debe leer "Clientes"');
  assert.ok(Math.abs(m.box.x + m.box.w / 2 - 327) <= 6 && Math.abs(m.box.y + m.box.h / 2 - 76) <= 5, JSON.stringify(m.box));
  const { ocrRegion } = await import('../src/agent/ocr.js');
  const z = findTextMatches(await ocrRegion(buf, { x: 100, y: 0, w: 560, h: 440 }, 3), 'Clientes')[0];
  assert.ok(z, 'el OCR de zona también debe leerlo');
});

test('OCR - variante D (inversión local): lee el fondo atenuado detrás de un modal en la pantalla real 1280x800', { timeout: 60000 }, async (t) => {
  if (!(await ocrAvailable())) { t.skip('Tesseract no está instalado'); return; }
  // Sin la variante D, las otras tres no leían el texto atenuado de fondo (28 palabras vs 50 medidas el 13/10).
  const words = await ocrScreenshot(fs.readFileSync('test/fixtures/sigecom-modal-1280.png'));
  assert.ok(findTextMatches(words, 'Bienvenido a SIGECOM')[0], 'debe leer el título atenuado detrás del modal');
  const ent = findTextMatches(words, 'Entendido')[0];
  assert.ok(ent && Math.abs(ent.box.x + ent.box.w / 2 - 840) <= 8 && Math.abs(ent.box.y + ent.box.h / 2 - 483) <= 6, JSON.stringify(ent?.box));
});

test('OCR - campo junto a una etiqueta larga (GESTORA): gana el campo de la derecha, no la tabla de abajo', { timeout: 60000 }, async (t) => {
  if (!(await ocrAvailable())) { t.skip('Tesseract no está instalado'); return; }
  // En la corrida del 13/10 el agente escribía en (56,165), la cabecera de la tabla. El campo está en x 229-486, y 115-137.
  const buf = fs.readFileSync('test/fixtures/gestora-clientes.png');
  const label = findTextMatches(await ocrScreenshot(buf), 'Buscar (nombre o documento):')[0];
  assert.ok(label, 'debe leer la etiqueta');
  const p = findFieldNearLabel(buf, label.box);
  assert.ok(p && p.x > 229 && p.x < 486 && p.y > 115 && p.y < 137, JSON.stringify(p));
});

test('OCR - lista desplegable "Ciudad" en el formulario de GESTORA: se ubica el combo, no la etiqueta', { timeout: 60000 }, async (t) => {
  if (!(await ocrAvailable())) { t.skip('Tesseract no está instalado'); return; }
  const buf = fs.readFileSync('test/fixtures/gestora-form.png');
  const label = findTextMatches(await ocrScreenshot(buf), 'Ciudad')[0];
  assert.ok(label, 'debe leer la etiqueta');
  const p = findFieldNearLabel(buf, label.box);
  assert.ok(p && p.x > 253 && p.x < 435 && p.y > 268 && p.y < 290, JSON.stringify(p));
});

test('OCR - área de texto de varias líneas ("Notas", GESTORA): se ubica dentro del cuadro alto', { timeout: 60000 }, async (t) => {
  if (!(await ocrAvailable())) { t.skip('Tesseract no está instalado'); return; }
  // Antes el buscador solo aceptaba cajas de 14-48 px de alto y el agente escribía en (119,372), fuera del cuadro.
  const buf = fs.readFileSync('test/fixtures/gestora-form.png');
  const label = findTextMatches(await ocrScreenshot(buf), 'Notas')[0];
  assert.ok(label, 'debe leer la etiqueta');
  const p = findFieldNearLabel(buf, label.box);
  assert.ok(p && p.x > 253 && p.x < 673 && p.y > 335 && p.y < 409, JSON.stringify(p));
});

test('OCR - etiqueta con dos puntos gana a la cabecera de columna con el mismo nombre ("Estado:" vs "Estado")', { timeout: 60000 }, async (t) => {
  if (!(await ocrAvailable())) { t.skip('Tesseract no está instalado'); return; }
  const buf = fs.readFileSync('test/fixtures/gestora-pedidos.png');
  const m = findTextMatches(await ocrScreenshot(buf), 'Estado:')[0];
  assert.ok(m && m.box.y < 140, `debe elegir el filtro de arriba (y≈121), no la cabecera (y≈159): ${JSON.stringify(m?.box)}`);
});

test('OCR incremental: tras escribir en un campo solo relee esa zona y los textos quedan en el mismo sitio', { timeout: 90000 }, async (t) => {
  if (!(await ocrAvailable())) { t.skip('Tesseract no está instalado'); return; }
  const { ocrIncremental, changedRegions } = await import('../src/agent/ocr.js');
  const antes = fs.readFileSync('test/fixtures/gestora-form-vacio.png');
  const despues = fs.readFileSync('test/fixtures/gestora-form-nombre.png');
  const zonas = changedRegions(antes, despues)!;
  assert.ok(zonas.length >= 1 && zonas.length <= 4, JSON.stringify(zonas));
  const prev = { png: antes, words: await ocrScreenshot(antes) };
  const inc = await ocrIncremental(despues, prev);
  assert.equal(inc.modo, 'zonas');
  const completo = await ocrScreenshot(despues);
  for (const texto of ['Nombre o razón social', 'Número de documento', 'Guardar', 'Papelería Los Andes']) {
    const a = findTextMatches(completo, texto)[0];
    const b = findTextMatches(inc.words, texto)[0];
    assert.ok(a && b, `"${texto}" debe leerse en ambos`);
    assert.ok(Math.abs(a.box.x - b.box.x) <= 3 && Math.abs(a.box.y - b.box.y) <= 3, `"${texto}" ${JSON.stringify(a.box)} vs ${JSON.stringify(b.box)}`);
  }
  const igual = await ocrIncremental(despues, { png: despues, words: inc.words });
  assert.equal(igual.modo, 'igual', 'sin cambios no se vuelve a leer');
});

test('OCR - lista desplegable nombrada por su valor ("Pagada", G15): el clic va a la lista, no a las 15 filas de la tabla', { timeout: 90000 }, async (t) => {
  if (!(await ocrAvailable())) { t.skip('Tesseract no está instalado'); return; }
  const { locateField, fieldContaining } = await import('../src/agent/ocr.js');
  // Captura real (14/10): Facturas filtrada por Cliente "Ruiz" y Estado "Pagada". Lista Estado: x 372-491, y 114-138.
  const buf = fs.readFileSync('test/fixtures/gestora-facturas-pagada.png');
  const words = await ocrScreenshot(buf);
  const sinVision = async () => null;
  const enCaja = (p: { x: number; y: number }, x0: number, x1: number, y0: number, y1: number) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;

  const pagada = findTextMatches(words, 'Pagada');
  assert.ok(pagada.length >= 15, `"Pagada" se repite en la tabla: ${pagada.length}`);
  const p1 = await locateField(buf, pagada, sinVision, 1280);
  assert.ok(enCaja(p1, 372, 491, 114, 138), `por valor debe caer en la lista Estado: ${JSON.stringify(p1)}`);

  // La etiqueta sigue funcionando y la cabecera de columna "Estado" no se toma por etiqueta.
  const p2 = await locateField(buf, findTextMatches(words, 'Estado:'), sinVision, 1280);
  assert.ok(enCaja(p2, 372, 491, 114, 138), `por etiqueta: ${JSON.stringify(p2)}`);
  const p3 = await locateField(buf, findTextMatches(words, 'Cliente:'), sinVision, 1280);
  assert.ok(enCaja(p3, 77, 299, 114, 138), `filtro Cliente: ${JSON.stringify(p3)}`);
  // Texto ya escrito en el filtro ("Ruiz") también se ubica dentro de su campo, no en las filas.
  const p4 = await locateField(buf, findTextMatches(words, 'Ruiz'), sinVision, 1280);
  assert.ok(enCaja(p4, 77, 299, 114, 138), `"Ruiz" escrito en el filtro: ${JSON.stringify(p4)}`);

  // Celdas de una fila de tabla (sin bordes) no son cajas; las cabeceras sí.
  const celda = findTextMatches(words, 'FV-10007')[0];
  assert.equal(fieldContaining(buf, celda.box), null);
  const cabecera = findTextMatches(words, 'Número')[0];
  assert.ok(fieldContaining(buf, cabecera.box), 'la cabecera "Número" está dentro de una caja cerrada');
});

test('OCR - submenú: pasar el ratón por "Maestros" en Tk no lo abre; la tecla Derecha sí (capturas reales, 14/10)', { timeout: 90000 }, async (t) => {
  if (!(await ocrAvailable())) { t.skip('Tesseract no está instalado'); return; }
  const { submenuOpened } = await import('../src/agent/ocr.js');
  const abierto = fs.readFileSync('test/fixtures/gestora-menu-abierto.png');
  const hover = fs.readFileSync('test/fixtures/gestora-menu-hover.png');
  const submenu = fs.readFileSync('test/fixtures/gestora-menu-submenu.png');
  // El puntero quedó en (115,75), sobre "Maestros".
  assert.equal(submenuOpened(abierto, hover, await ocrScreenshot(hover), 115, 75), false, 'el resaltado de la opción no es un submenú');
  assert.equal(submenuOpened(hover, submenu, await ocrScreenshot(submenu), 115, 75), true, '"Clientes" apareció a la derecha');
});

test('OCR - texto para el planificador: la "o" de "Buscar (nombre o documento):" queda en su fila', { timeout: 60000 }, async (t) => {
  if (!(await ocrAvailable())) { t.skip('Tesseract no está instalado'); return; }
  // Antes llegaba como "Buscar (nombre | documento):": el planificador copiaba esa etiqueta y el OCR no la encontraba
  // (17 consultas de visión pagadas en la corrida del 13/10).
  const { screenTextForPrompt } = await import('../src/agent/ocr.js');
  const texto = screenTextForPrompt(await ocrScreenshot(fs.readFileSync('test/fixtures/gestora-clientes.png')));
  assert.match(texto, /Buscar \(nombre o documento\):/);
  assert.doesNotMatch(texto, /nombre \| documento/);
});

test('OCR - un " | " copiado del texto del planificador vale por una palabra o por ninguna', () => {
  const words = [
    w('Buscar', 19, 121, 'A:1-1-1'),
    w('(nombre', 68, 120, 'A:1-1-1'),
    w('o', 127, 123, 'A:1-1-1'),
    w('documento):', 139, 120, 'A:1-1-1'),
    w('Total', 19, 684, 'A:1-2-1'),
    w('filtrado:', 60, 684, 'A:1-2-1'),
    w('$', 130, 684, 'A:1-2-1'),
    w('70.670.000', 140, 684, 'A:1-2-1'),
  ];
  assert.equal(findTextMatches(words, 'Buscar (nombre | documento):').length, 1, 'el | ocupa el lugar de la "o"');
  assert.equal(findTextMatches(words, 'filtrado: | $ 70.670.000').length, 1, 'el | no ocupa ninguna palabra');
  assert.equal(findTextMatches(words, 'Buscar (nombre | teléfono):').length, 0, 'el resto debe coincidir');
});
