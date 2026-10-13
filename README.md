# Agente VNC autónomo — Frontier Hackathon (Reto 1)

Servicio HTTP que recibe una tarea en lenguaje natural y la ejecuta sobre un escritorio legado usando solo VNC/RFB (sin DOM ni accesibilidad).

## Contrato
- `GET /health` → `200 {"ok":true,"version":"<revisión desplegada>"}`
- `POST /tasks` (Bearer `TEAM_TOKEN`) con `{"tarea","escritorio":{"url","password"}}` → `{"task_id"}` en < 2 s
- `GET /tasks/{id}` (Bearer) → `{"estado":"en_curso|terminada|fallida","resumen":"..."}`

## Arquitectura
1. `src/server.ts`: API Express y autenticación (comparación en tiempo constante).
2. `src/tasks/store.ts`: estado en memoria, cola FIFO, plazo por tarea, estado final inmutable, limpieza al terminar.
3. `src/rfb/`: cliente RFB propio (handshake 3.8, autenticación VNC con DES, framebuffer, ratón y teclado). Clic = MouseDown, 120 ms, MouseUp; 1000 ms de espera tras cada acción.
4. `src/agent/loop.ts`: observar (captura PNG) → planificar → localizar → actuar → verificar con diff de capturas.
   - **Planificador** (`MODEL_ID`): ve la captura limpia y devuelve un lote de hasta 6 acciones que nombran su *objetivo* ("botón 'Guardar' del formulario Cliente"), no coordenadas.
   - **Localizador exacto por texto** (`src/agent/ocr.ts`, Tesseract): el planificador indica el texto visible del elemento y el OCR devuelve su caja en píxeles reales de la captura (tres variantes: texto oscuro, texto disperso y texto claro sobre botones de color). Para campos, busca la caja de entrada junto a la etiqueta. Sin IA en las coordenadas.
   - **Localizador de visión** (respaldo para iconos sin texto y desempate entre textos repetidos; `GROUNDING_MODEL_ID`, `src/agent/grounder.ts`): convierte cada objetivo en una caja con el formato nativo de detección de Gemini (`box_2d` = [ymin, xmin, ymax, xmax] normalizado 0-1000) y, para elementos pequeños, repite sobre un recorte ampliado x2.
   - Cada acción se compara antes/después y su efecto ("la pantalla cambió" / "SIN cambio visible") vuelve al planificador. Si un objetivo no aparece, el lote se detiene: nunca escribe a ciegas.
   - Acciones: click, double_click, move, type_text, press_key, key_combo, scroll, wait, finish, fail.
5. `src/security/sanitize.ts`: redacta contraseña de la tarea, tokens y claves en resúmenes y logs.

Decisiones: estado en memoria (instancia única, se pierde al reiniciar); atajos peligrosos bloqueados (Alt+F4, Ctrl+W, Ctrl+Q); `finish`/`fail` arman el resumen en código; la línea `respuesta:` solo aparece en tareas terminadas.

## Panel web
`/panel`: interfaz para operar y medir el agente (entra con el mismo `TEAM_TOKEN`).
- **Operación:**
  - enviar tareas;
  - lista de tareas;
  - capturas paso a paso en vivo, bitácora y resumen;
  - métricas de la instancia: terminadas/fallidas, tiempo promedio y p95, pasos, costo del modelo.
- **Banco de pruebas:** tasa de éxito por prueba y por versión desplegada, con tiempo y costo, a partir de `resultados/historial.jsonl`.

Endpoints que usa el panel (todos con token): `GET /tasks`, `GET /metrics`, `GET /benchmark`, `GET /tasks/{id}/trace`, `GET /tasks/{id}/shots/{n}`.

## Medición (banco de pruebas)
`npx tsx scripts/run-test.ts all 3` corre E1–E5 tres veces contra el escritorio real:
- resetea con `/__reset` y verifica con `/__check`;
- valida el resumen: respuesta esperada, claves de razón y ausencia de secretos.

Una prueba cuenta como **aprobada** solo si cumple las tres cosas. Cada corrida queda en `resultados/historial.jsonl` (con la versión desplegada) y en `debug/<ID>/` (capturas, bitácora y resultado).

Evidencia del proyecto (salida real de pruebas, mediciones, capturas, incidentes): `docs/evidencia/`.

## Escritorio de prueba propio (GESTORA ERP)
El escritorio de práctica de la competencia ya no existe. Para seguir midiendo, `escritorio/` trae lo siguiente:
- una aplicación legada ficticia operable por VNC;
- un evaluador compatible (`/__reset`, `/__check`);
- 20 pruebas con respuestas calculadas desde los datos (`pruebas-propias/`).

Para correrlas: `npx tsx scripts/run-test.ts propias`. Detalles y despliegue en [`escritorio/README.md`](escritorio/README.md).

## Variables de entorno (sin valores en el repo)
`OPENROUTER_API_KEY`, `TEAM_TOKEN`, `MODEL_ID`, `GROUNDING_MODEL_ID`, `PORT`, `TASK_DEADLINE_MS`, `MAX_STEPS`, `MAX_CONCURRENT_TASKS`, `MAX_COST_USD_PER_TASK`, `OCR_MAX_PROCS`, `DESKTOP_LOCK`, `SNAP_CLICKS` (0 por defecto), `DEBUG_SHOTS`. Ver `.env.example`.

## Ejecutar
```
npm install
cp .env.example .env   # completar valores
npm start
npm test
```
Prueba contra el escritorio de práctica: `scripts/run-test.ts` (usa `/__reset` y `/__check`).

## Por qué planificador + localizador
En las pruebas con el escritorio de práctica, pedir coordenadas en píxeles al modelo dio errores de 80 a 280 px: el agente pulsaba (700-750, 470) cuando el botón "Entendido" ocupa x 760-911, y 18 pasos se iban en reintentos. Separar *qué* (planificador) de *dónde* ataca esa causa. Primero se probó un localizador de visión (formato `box_2d` de Gemini): acertó la x del botón "Entendido" (839 vs 842) pero falló la y por ~190 px. Por eso el localizador principal es OCR: en la captura real ubica "Entendido" en el centro del botón (error < 6 px, ver `test/ocr.test.ts`). No hay posiciones ni colores fijos de ninguna aplicación.

Prueba rápida del localizador contra el escritorio: `npx tsx scripts/ground-test.ts "botón 'Entendido' del diálogo de novedades"`.

## Estabilidad con muchas tareas a la vez
- El set de evaluación lanza decenas de tareas. El OCR (Tesseract) es lo más pesado: un semáforo global limita los procesos simultáneos (`OCR_MAX_PROCS`, por defecto 2), cada proceso usa un solo hilo y, si la espera supera 12 s, ese paso sigue sin OCR en vez de bloquear.
- Manejadores globales de errores: un fallo en una tarea no tumba el servidor.
- Bitácora por tarea con tiempos: `GET /tasks/{id}/trace` (requiere el token). `scripts/load-test.ts` mide que `/health` siga respondiendo con N tareas simultáneas.

## Limitaciones conocidas
- La tasa de éxito real se mide con el banco de pruebas y está en `docs/evidencia/BITACORA.md`. No es 100 %.
- El estado de las tareas vive en memoria y no sobrevive a reinicios ni redespliegues. Ya pasó: se perdieron tareas al hacer push durante corridas.
- Varias tareas sobre el mismo escritorio se pisan entre sí, salvo con `DESKTOP_LOCK=1`.
- Qué falta para usarlo en una empresa y cuánto cuesta en COP: `docs/EMPRESA.md`.

## Cómo se construyó
- **Primera versión:** Andrés la generó con Google AI Studio (Gemini), commit 7ba366c.
- **De ahí en adelante:** Claude (Anthropic) escribió el código bajo su dirección. Por eso los commits llevan la línea `Co-Authored-By: Claude`.
- **Trabajo de Andrés:**
  - definir el objetivo y las prioridades;
  - correr las pruebas contra el escritorio real desde su equipo;
  - desplegar en Google Cloud Run;
  - decidir con base en los resultados medidos.

Las decisiones y los incidentes, con fecha y commit, están en `docs/evidencia/BITACORA.md`.
