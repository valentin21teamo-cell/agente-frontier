# Bitácora de evidencia del proyecto

Registro de hechos verificables: qué se cambió, qué se midió y dónde está la prueba.
Regla: lo que no tiene fuente adjunta se marca como **sin archivar** o **por confirmar**.

## Línea de tiempo (fuente: `git log`, hora de Colombia, UTC-5)

| Fecha y hora | Commit | Qué cambió |
|---|---|---|
| 10/10 17:11 | 7ba366c | Servidor inicial: contrato HTTP, cliente RFB/VNC, bucle del agente |
| 10/10 17:51–18:29 | 9545c91 … 1cb3f55 | Auditoría, reintento del primer fotograma RFB, rejilla de coordenadas |
| 10/10 19:18–20:52 | 204cf3d … d987cd9 | JSON truncado del modelo (max_tokens), trayectoria de ratón, escalera de reintento de clic |
| 10/10 21:50 | f210dd8 | Arquitectura planificador + localizador (box_2d normalizado) |
| 10/10 22:09 | c092826 | Localizador exacto por OCR (Tesseract) como fuente principal de coordenadas |
| 10/10 22:47 | 7497229 | OCR en PGM + caché: bloqueo del servidor 1,7 s → 0,3 s; OCR 5,2 s → 2,8 s |
| 11/10 00:00–00:01 | 2bbb8fb, 8178fee | Bitácora por tarea (`/tasks/:id/trace`); 2bbb8fb se subió con una prueba fallando, corregido en 8178fee |
| 12/10 18:57 | dad661a | Estabilidad bajo carga (semáforo de OCR), texto OCR para el planificador, plazo de 285 s |
| 12/10 19:53 | 1b2a381 | OCR de zona, campos con bordes rectos, listas desplegables |
| 12/10 20:29 | 75ce496 | Doble clic real, memoria del razonamiento, capturas por paso |
| 12/10 21:46 | f036cf7 | OCR lee submenús flotantes; runner con historial y tasa de éxito |
| 12/10 21:5x–22:03 | b7fd05f, 6210195, d151266, 60fe173 | Panel web `/panel`, guía para empresa, candado por escritorio, README al día |
| 12/10 ~22:20 | — (configuración) | Cloud Run con mínimo 0 instancias (revisión agente-frontier-00020-bs8) para no pagar 24/7 |
| 12/10 22:31 | — (corrida) | `CORRER-PRUEBAS.cmd`: el código se actualizó, pero las 5 pruebas fallaron antes de guardar resultados y el error solo quedó en la consola. Causa probable, no confirmada: el escritorio de práctica ya no existe |
| 13/10 18:1x | daa1472 | Diagnóstico del entorno sin secretos (`scripts/diagnostico.ts`); el runner registra las fallas en `resultados/errores.log` |
| 13/10 ~19:00 | 7104536 | Escritorio de prueba propio GESTORA ERP + 20 pruebas; OCR variante D; limpieza de campos más robusta; comparación exacta de respuestas |
| 13/10 21:5x–23:00 | c588a2c, fba3dc4, 87f23df | Modelo elegible por tarea (Claude con localización en píxeles); escritorio publicado en Cloud Run por Andrés (`desplegar.sh`) |
| 13/10 23:00–14/10 01:34 | — (corridas) | Banco GESTORA con la revisión 00030: Claude Sonnet 5.5 aprobó 18/20 (17 legítimas) y Gemini 2.5 Flash 8/20. Detalle en `benchmark-2026-10-14/RESULTADOS.md` |
| 13/10 23:18 y 14/10 00:24 | 2f268d2, 321a944 | Buscador de campos: el campo de la derecha gana a la tabla de abajo. El runner ya no aprueba un corte por límite técnico. Se hicieron durante las corridas pero se subieron a las 01:38 junto con b3208db, después de que terminó la ronda de Flash (01:34). Fuente: `git reflog` de `origin/main` |
| 14/10 06:58 | c4eefe6 | Localizador de campos: 11/24 → 23/24, medido sin gastar en modelos (`mediciones/localizador-campos-2026-10-14.md`) |
| 14/10 07:05 | e124147 | OCR incremental (4,9 → 1,2 s al mover el puntero, medición archivada) y prompt más barato (caché de Anthropic, historial más corto). Subido con c4eefe6 a las 07:06; desplegado como revisión 00032 |
| 14/10 07:3x | — (configuración, aprobada por Andrés) | Revisión `agente-frontier-00033-6bf`: `MODEL_ID` y `GROUNDING_MODEL_ID` = `anthropic/claude-sonnet-5.5`; `MAX_COST_USD_PER_TASK` 0,25 → 0,40. Aplicado en la consola de Cloud Run; `/health` confirmó la revisión. Las claves secretas no se tocaron |
| 14/10 13:2x | b08421a, ed4ea39 | Ejecutor: lista desplegable por su valor, submenú con la tecla Derecha, capturas sin puntero, filas de la tabla que ya no pasan por campos, "\|" en las etiquetas, precio de respaldo por modelo. Simulador sin modelos. Pruebas 74/74 (`pruebas/npm-test-b08421a.txt`) |

## Incidentes

1. **Redespliegues que cortaron tareas en curso.** Cada `push` a `main` dispara Cloud Build y reinicia la única instancia de Cloud Run; las tareas en memoria se pierden.
   - 10/10: el push 05c14b3 se hizo durante una corrida de pruebas y se perdió E1.
   - 12/10 ~19:53: el push 1b2a381 coincidió con la ventana en que el set oculto se detuvo en 34/56. **No confirmado**: Andrés no recuerda si lanzó "Validar de nuevo" a las 19:21. Lo único verificable: su copia local del repo se actualizó a las 19:21:31 (fecha de modificación del README en su equipo), es decir, hubo actividad a esa hora. No se afirma causa.
   - Corrección de proceso: no se sube nada mientras haya una corrida activa.
2. **Afirmación no verificable "30 de 30 pruebas"** en `docs/INCIDENTE.md`. Corregida el 12/10; ahora cada cifra de pruebas va con su salida completa en `docs/evidencia/pruebas/`.
3. **Commit con prueba fallando** (2bbb8fb, 11/10 00:00). Corregido un minuto después en 8178fee. Desde entonces solo se sube si la salida dice `# fail 0`.

## Mediciones

### Pruebas automatizadas
- `pruebas/npm-test-f036cf7.txt`: 52 pruebas, 52 aprobadas, 0 fallidas, 0 omitidas. Son pruebas de piezas, no de tareas reales.

### Banco de pruebas contra SIGECOM real (E1–E5)
- **12/10, commit 1b2a381, modelo Gemini 2.5 Flash, Cloud Run 4 vCPU.** Fuente: salida del runner que Andrés pegó en el chat (**sin archivar**; desde f036cf7 el runner la guarda en `resultados/historial.jsonl`).

  | Prueba | Resultado | Detalle |
  |---|---|---|
  | E5 | aprobada | — |
  | E4 | aprobada | — |
  | E3 | no aprobada | Respondió 4 en vez de 45: contó solo la última página |
  | E1 | no aprobada | Cliente no creado como se esperaba |
  | E2 | no aprobada | El doble clic no abría el registro |

- **12/10, E1 con 75ce496 o anterior.** No aprobada. El agente abrió Comercial > Maestros, pero el OCR no leyó "Clientes" en el submenú flotante y el clic por visión cayó en (230,92), fuera del submenú. Capturas en `capturas/e1-2026-10-12/`.
- **Prueba de carga** (`scripts/load-test.ts`, 8 tareas simultáneas): ESTABLE, `/health` máximo 1014 ms. Salida **sin archivar**.

### Precisión de coordenadas (localizador)
- Visión con box_2d normalizado: x correcta, y desviada unos 190 px. OCR: error de 1 px. Medido con `scripts/ground-test.ts` sobre el escritorio real (salida **sin archivar**).

### Escritorio propio GESTORA (13/10, local, con el cliente RFB del agente)
- Flujos por clic que pasan `/__check`: crear cliente (G01), exportar con filtros (G04), cambiar teléfono sin tocar las notas inyectadas (G07) y anular pedido (G11).
- Sin token, `/__check` responde 401. Un cambio de más o sobre el registro equivocado no pasa (pruebas unitarias).
- **Hallazgo:** en Tk, Ctrl+A no selecciona todo. El agente escribió `32055512343647643075`, con el texto viejo pegado al nuevo (captura `capturas/gestora-2026-10-13/06-...`). Corregido en el cliente RFB y verificado: G07 pasa (`07-...`).
- Salidas: `pruebas/npm-test-7104536.txt` (58/58) y `pruebas/python-escritorio-7104536.txt` (11/11).
- **Medido el 13–14/10** con el agente completo en Cloud Run: Sonnet 5.5 aprobó 18/20 a COP 611 por tarea y Gemini 2.5 Flash 8/20 a COP 115. Flash obedeció la instrucción inyectada en G07 y declaró éxito sin crear el cliente en G01. Detalle en `benchmark-2026-10-14/RESULTADOS.md`.

### OCR: variante D (inversión local), 13/10
- Captura real de SIGECOM con el modal de novedades: las variantes A+B+C leían 28 palabras distintas y con D, 50. El fondo atenuado detrás del modal antes no se leía.
- En GESTORA, la opción resaltada de un menú (texto blanco sobre azul oscuro) tampoco se leía con D. Se cambió el resaltado del menú de la app a un color claro. En apps reales, ese caso queda a cargo del respaldo de visión.

### Localizador de campos (14/10, sin modelos)
- 11/24 → 23/24 campos con el punto dentro de su caja real. Detalle y salida completa en `mediciones/localizador-campos-2026-10-14.md`.
- **Segunda medición**, con el buscador de e124147 como "antes", en la misma corrida:
  - por etiqueta: 28/28 → 28/28;
  - lista desplegable nombrada por su valor, el caso de G15: **0/7 → 7/7**.
  - Detalle en `mediciones/localizador-2026-10-14-v2/`.

### Simulación del agente completo sin modelos (14/10)
- `scripts/simular-tarea.ts` intercepta las llamadas a OpenRouter. El planificador sigue un guion con las decisiones reales de Claude del 13/10; las consultas de visión se cuentan, sin pagarlas.
- Cuatro guiones: submenú, G15, búsqueda y G04.
  - e124147 (lo desplegado): **0/4**, con 11 consultas de visión.
  - Este commit: **4/4**, con 0 consultas.
  - G04 pasa `/__check`.
- No mide al planificador. Detalle en `mediciones/simulacion-2026-10-14/`.
- **Corrección de una cifra mía.** Dije que el submenú costó un paso en 11 de las 20 pruebas. Contado en la bitácora: fueron **17 de 20**.

### Pasos perdidos en la corrida pagada de Sonnet (13/10), contados en la bitácora
- **17 de 228 pasos** se fueron abriendo el submenú.
- **49 pasos** repitieron la escritura en un campo que ya se había intentado llenar.
- De las 70 consultas de visión, **50** tuvieron causa determinista, ya corregida:
  - 19: la cabecera de la tabla compitiendo con la etiqueta;
  - 17: el "|" en la etiqueta;
  - 14: el puntero tapando el texto.
- Estimación, no medida: US$ 0,19 → 0,13–0,14 por tarea. Se confirma solo con una corrida pagada.

### OCR incremental (14/10, sin modelos)
- Capturas reales de GESTORA en un equipo de 2 CPU, OCR completo contra incremental: 4,9 → 1,2 s al mover el puntero, 2,3 → 1,4 s al escribir un nombre, 2,8 → 2,1 s al abrir una lista. De 12 textos comprobados, 11 quedaron en el mismo punto y uno a 1 px. Detalle, capturas y salida en `mediciones/ocr-incremental-2026-10-14/`. Prueba automática en `test/ocr.test.ts` (commit e124147).
- El mensaje del commit e124147 da cifras de una primera medición que no se archivó (4,7 → 1,4 s, 2,3 → 1,2 s, 2,7 → 2,0 s, "mismas posiciones"). Las que valen son las archivadas.
- Lo que no está medido: cuánto baja el tiempo y el costo por tarea completa. Se mide en la próxima corrida autorizada.

### OCR: variantes de preprocesamiento (12/10, medido en este repo)
- Detalle completo en `mediciones/ocr-variantes-2026-10-12.md`.
