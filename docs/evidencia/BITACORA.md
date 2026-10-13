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

### OCR: variantes de preprocesamiento (12/10, medido en este repo)
- Detalle completo en `mediciones/ocr-variantes-2026-10-12.md`.
