# Agente VNC autónomo — Frontier Hackathon (Reto 1)

Servicio HTTP que recibe una tarea en lenguaje natural y la ejecuta sobre un escritorio legado usando solo VNC/RFB (sin DOM ni accesibilidad).

## Contrato
- `GET /health` → `200 {"ok":true}`
- `POST /tasks` (Bearer `TEAM_TOKEN`) con `{"tarea","escritorio":{"url","password"}}` → `{"task_id"}` en < 2 s
- `GET /tasks/{id}` (Bearer) → `{"estado":"en_curso|terminada|fallida","resumen":"..."}`

## Arquitectura
1. `src/server.ts`: API Express y autenticación (comparación en tiempo constante).
2. `src/tasks/store.ts`: estado en memoria, cola FIFO, plazo por tarea, estado final inmutable, limpieza al terminar.
3. `src/rfb/`: cliente RFB propio (handshake 3.8, autenticación VNC con DES, framebuffer, ratón y teclado). Clic = MouseDown, 120 ms, MouseUp; 1000 ms de espera tras cada acción.
4. `src/agent/loop.ts`: observar (captura PNG) → planificar → localizar → actuar → verificar con diff de capturas.
   - **Planificador** (`MODEL_ID`): ve la captura limpia y devuelve un lote de hasta 6 acciones que nombran su *objetivo* ("botón 'Guardar' del formulario Cliente"), no coordenadas.
   - **Localizador** (`GROUNDING_MODEL_ID`, `src/agent/grounder.ts`): convierte cada objetivo en una caja con el formato nativo de detección de Gemini (`box_2d` = [ymin, xmin, ymax, xmax] normalizado 0-1000) y, para elementos pequeños, repite sobre un recorte ampliado x2.
   - Cada acción se compara antes/después y su efecto ("la pantalla cambió" / "SIN cambio visible") vuelve al planificador. Si un objetivo no aparece, el lote se detiene: nunca escribe a ciegas.
   - Acciones: click, double_click, move, type_text, press_key, key_combo, scroll, wait, finish, fail.
5. `src/security/sanitize.ts`: redacta contraseña de la tarea, tokens y claves en resúmenes y logs.

Decisiones: estado en memoria (instancia única, se pierde al reiniciar); atajos peligrosos bloqueados (Alt+F4, Ctrl+W, Ctrl+Q); `finish`/`fail` arman el resumen en código; la línea `respuesta:` solo aparece en tareas terminadas.

## Variables de entorno (sin valores en el repo)
`OPENROUTER_API_KEY`, `TEAM_TOKEN`, `MODEL_ID`, `PORT`, `TASK_DEADLINE_MS`, `MAX_STEPS`, `MAX_CONCURRENT_TASKS`, `MAX_COST_USD_PER_TASK`, `COORD_MODE`, `SNAP_CLICKS` (0 por defecto), `DEBUG_SHOTS`. Ver `.env.example`.

## Ejecutar
```
npm install
cp .env.example .env   # completar valores
npm start
npm test
```
Prueba contra el escritorio de práctica: `scripts/run-test.ts` (usa `/__reset` y `/__check`).

## Por qué planificador + localizador
En las pruebas con el escritorio de práctica, pedir coordenadas en píxeles al modelo dio errores de 80 a 280 px: el agente pulsaba (700-750, 470) cuando el botón "Entendido" ocupa x 760-911, y 18 pasos se iban en reintentos. Separar *qué* (planificador) de *dónde* (localizador con coordenadas normalizadas y zoom) ataca esa causa sin depender de la app: no hay posiciones ni colores fijos de ninguna aplicación.

Prueba rápida del localizador contra el escritorio: `npx tsx scripts/ground-test.ts "botón 'Entendido' del diálogo de novedades"`.

## Limitaciones conocidas
- La precisión de coordenadas del modelo es el punto débil (medido en la práctica); ver `docs/INCIDENTE.md`.
- El estado de tareas no sobrevive a reinicios.
