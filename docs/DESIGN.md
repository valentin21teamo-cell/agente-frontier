# Arquitectura y Diseño del Sistema

## 1. Visión General
El sistema implementa un agente autónomo que opera un escritorio remoto a través del protocolo RFB (VNC) encapsulado sobre WebSockets binarios (websockify). El núcleo del sistema es un servidor Node.js + TypeScript de alto rendimiento con aislamiento estricto por tarea.

## 2. Contrato HTTP
- `GET /health`: Monitoreo de salud. Responde `200 {"ok":true}` sin requerir cabecera de autenticación.
- `GET /status`: Inspección de estado operativo (conteo de tareas activas, completadas y tiempo de actividad). No expone identificadores, instrucciones, resúmenes ni secretos.
- `POST /tasks`: Recepción de órdenes de trabajo. Exige `Authorization: Bearer <TEAM_TOKEN>`. Valida estrictamente `tarea`, `escritorio.url` (`ws://` o `wss://`) y `escritorio.password`. Despacha la tarea en segundo plano sin bloquear el hilo principal y responde en < 2 segundos con `{"task_id":"<uuid>"}`.
- `GET /tasks/:task_id`: Consulta de estado y resumen (`en_curso`, `terminada`, `fallida`). Exige `Authorization: Bearer <TEAM_TOKEN>`. Todo resumen se entrega sanitizado.

## 3. Almacenamiento y Concurrencia
### Decisión Arquitectónica: Store en memoria (`Map`)
- **Razón técnica**: Una única instancia con estado en memoria es la arquitectura más simple, determinista y menos propensa a fallar por latencia o particiones de red asociadas a brokers externos (Redis, bases de datos o colas distribuidas).
- **Costo asumido**: El estado de las tareas se pierde si el servicio se reinicia. Dado el ciclo de vida de la evaluación (tareas de hasta 5 minutos) y el requisito de instancia única sin balanceo, este costo es aceptable y deliberado.
- **Mecanismo de Cola FIFO**: Si el número de tareas concurrentes excede `MAX_CONCURRENT_TASKS` (por defecto 10), las tareas adicionales no se rechazan: se encolan en orden estricto de llegada (FIFO).
- **Plazo de Tarea (`TASK_DEADLINE_MS`)**: El cronómetro de vencimiento (por defecto 270.000 ms / 4,5 minutos) se inicia en el momento exacto en que ingresa el `POST /tasks`. Si una tarea en cola no alcanza a iniciar con tiempo suficiente, finaliza honestamente como `fallida`.

## 4. Cliente RFB (Transporte y Percepción)
- **Transporte**: Conexión WebSocket binaria a través de la librería estándar `ws`.
- **Autenticación VNC**: Implementación según RFC 6143 Sección 7.2.2. La contraseña (máximo 8 bytes) se deriva con inversión de bits por byte y encripta el challenge de 16 bytes mediante DES en modo ECB sin padding.
- **Resolución Dinámica**: La resolución se lee dinámicamente del mensaje `ServerInit`. No se asume ninguna resolución estática en el código.
- **Renderizado de Framebuffer**: Almacena un framebuffer continuo de 32 bits (RGBA). Soporta la codificación estándar Raw con solicitudes de actualización incrementales continuas.
- **Temporización de Acciones**:
  - Clic de ratón: `MouseDown`, espera de 120 ms (garantiza superar el umbral de 100 ms ignorado por el entorno), `MouseUp`.
  - Tiempo de asentamiento: Tras cada acción (clic, texto, tecla, scroll) se espera un mínimo de 1.000 ms antes de cualquier captura o siguiente acción para permitir el repintado de la aplicación.
- **Mapeo de Teclado**: Soporte completo para caracteres en español (ñ, Ñ, á, é, í, ó, ú, ü, ¿, ¡, #, @, símbolos y modificador Shift). Mecanismo de limpieza preventiva (`Ctrl+A`, `Backspace`) antes de escribir para evitar concatenaciones espurias en campos preexistentes.
- **Captura Visual**: Exportación de framebuffer a buffers PNG mediante `pngjs`.

## 5. Política de Seguridad Zero-Leakage
Toda salida hacia clientes HTTP, archivos de log y trazas de error pasa por `sanitize()`:
- Redacción exacta de contraseñas de escritorio específicas de cada tarea.
- Redacción exacta de variables de entorno sensibles (`TEAM_TOKEN`, `OPENROUTER_API_KEY`, `DESKTOP_TOKEN`, `DESKTOP_PASSWORD`).
- Redacción por patrones de expresiones regulares:
  - Tokens Bearer (`Bearer\s+\S+`)
  - Claves OpenRouter (`sk-or-[A-Za-z0-9_.-]+`)
  - Identificadores de evaluación (`ftr_[A-Za-z0-9_.-]+`)
- Prohibición de registro o persistencia en disco de capturas de pantalla de tareas en producción.
