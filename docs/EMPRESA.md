# Cómo llevar este agente a una empresa real

Esta guía parte de lo que ya existe en el repo y de lo que aprendimos con fallas reales en la competencia.
Las cifras de costo de Cloud Run vienen de la página oficial de precios (consultada el 12/10/2026). Las demás cifras dicen de dónde salen.

## 1. Para qué sirve y cuándo NO usarlo

**Qué hace.** Opera una aplicación de escritorio vieja (ERP, facturación, inventario) como lo haría una persona: ve la pantalla, mueve el ratón y escribe. La tarea entra en lenguaje natural ("registra el cliente X", "¿cuántas facturas vencidas tiene Y?"). Es automatización de procesos (RPA) que no depende de coordenadas grabadas, así que aguanta cambios de interfaz como los de SIGECOM v4.2.

**Cuándo sí:**
- la aplicación no tiene API ni acceso seguro a su base de datos;
- el proceso es repetitivo y tiene reglas claras;
- se puede verificar el resultado en pantalla.

**Cuándo no:**
- **Si hay API o base de datos accesible.** Una integración directa es más rápida, más barata y casi 100 % confiable. Este agente tarda minutos por tarea y, medido hoy, no acierta siempre (ver `docs/evidencia/BITACORA.md`).
- **Si el proceso mueve dinero o borra datos y no hay una persona que apruebe antes.**

## 2. Lo que ya está hecho (reutilizable en otro proyecto)

| Pieza | Archivo | Se reutiliza tal cual en otra app |
|---|---|---|
| Cliente VNC/RFB 3.8 sobre WebSocket, autenticación DES, ratón y teclado | `src/rfb/` | Sí: sirve para cualquier escritorio VNC |
| Localizador por OCR (Tesseract): ubica botones y campos por su texto con 1 px de error | `src/agent/ocr.ts` | Sí |
| Localizador por visión (respaldo para elementos sin texto) | `src/agent/grounder.ts` | Sí |
| Planificador con reglas (modales, homónimos, verificación antes de terminar, cero duplicados) | `src/agent/loop.ts` | Sí; las reglas son genéricas, no de SIGECOM |
| Verificación por acción (diferencia de pantalla antes y después) y bitácora | `src/agent/loop.ts` | Sí |
| API HTTP con token, cola de tareas, plazos y limpieza de secretos en las respuestas | `src/server.ts`, `src/tasks/store.ts`, `src/security/sanitize.ts` | Sí |
| Panel web de operación y medición | `src/panel/index.html` (`/panel`) | Sí |
| Banco de pruebas con historial y tasa de éxito | `scripts/run-test.ts`, `resultados/` | Sí; los casos de prueba se escriben de nuevo para cada app |

**Para adaptarlo a otra aplicación:**
1. Escribe de 20 a 50 casos de prueba reales del proceso, en el mismo formato de `pruebas/*.json`.
2. Corre el banco de pruebas y mide.
3. Ajusta las reglas del planificador solo con lo que muestren las fallas medidas.

## 3. Lo que falta para producción (y por qué)

Cada punto sale de un problema que tuvimos o de un riesgo concreto.

### 3.1 Que un despliegue no mate las tareas en curso
**Problema real.** Cada `push` a `main` redesplegaba Cloud Run y la instancia nueva arrancaba vacía. Así se perdieron tareas en dos corridas (ver bitácora). Las tareas viven en memoria (`src/tasks/store.ts`).

**Solución:**
- Guardar tareas y pasos en una base de datos (por ejemplo PostgreSQL) y las capturas en almacenamiento de objetos (Cloud Storage).
- Usar una cola (Cloud Tasks o Pub/Sub) y trabajadores aparte. Si un trabajador muere, la tarea se reintenta o queda marcada, pero no se pierde en silencio.
- Separar ambientes: `main` despliega solo a pruebas, y producción se promueve a mano.
- Atender la señal de apagado. Cloud Run manda SIGTERM y da unos 10 segundos; en ese tiempo hay que dejar de aceptar tareas y guardar el estado.

### 3.2 Un escritorio, una tarea a la vez
**Riesgo.** El servidor acepta hasta 10 tareas simultáneas. En la competencia cada tarea traía su escritorio; en una empresa, dos tareas sobre el mismo escritorio se pisarían el ratón.

**Solución:**
- Un candado por escritorio: las tareas del mismo escritorio hacen fila. **Ya existe**: se activa con `DESKTOP_LOCK=1` y tiene prueba en `test/store.test.ts`. Viene apagado para no cambiar el comportamiento del contrato de la competencia.
- Un grupo de escritorios (varias sesiones VNC) para trabajar en paralelo.

### 3.3 Seguridad
- **Secretos.**
  - El token, la llave del modelo y las contraseñas VNC van en Secret Manager, no en variables escritas a mano.
  - Las contraseñas nunca van al modelo. Hoy ya se limpian de resúmenes y bitácoras (`sanitize.ts`, con pruebas).
- **Inyección por pantalla.** El texto de la aplicación se trata como dato, nunca como instrucción (regla 1 del planificador). En producción se suma una lista de acciones permitidas por proceso.
- **Aprobación humana** antes de acciones irreversibles: borrar, anular, pagar, cambiar datos bancarios. El agente prepara el cambio, una persona lo aprueba en el panel y solo entonces se aplica.
- **Accesos por persona** (por ejemplo, inicio de sesión de la empresa) en lugar de un token compartido, para saber quién pidió cada tarea.
- **Datos personales.** Las capturas tienen nombres, NIT y teléfonos. En Colombia aplica la Ley 1581 de 2012 de protección de datos personales. Hace falta definir cuánto tiempo se guardan las capturas, quién las ve y dónde se almacenan. Hoy se borran de memoria 20 minutos después de terminar la tarea.

### 3.4 Auditoría
Cada acción queda registrada con:
- quién pidió la tarea;
- qué texto recibió;
- qué hizo el agente, paso a paso, con captura antes y después;
- quién aprobó, si aplica;
- el resultado.

La bitácora (`/tasks/:id/trace`) y las capturas por paso (`/tasks/:id/shots/:n`) ya existen; falta guardarlas de forma permanente.

### 3.5 Calidad medida, no supuesta
- **El banco de pruebas como puerta de despliegue.** Ninguna versión pasa a producción si su tasa de éxito en el set de regresión baja frente a la versión actual. `scripts/run-test.ts` ya calcula la tasa por prueba y la guarda por versión en `resultados/historial.jsonl`.
- **Versionar el modelo y el prompt** igual que el código. Cambiar de modelo cambia la tasa de éxito, así que se mide antes de cambiar.
- **Modo sombra al inicio.** El agente propone y una persona ejecuta y compara. Solo se pasa a autonomía cuando la tasa medida lo justifica.

### 3.6 Observabilidad
- **Métricas por tarea:** éxito, tiempo, pasos, costo del modelo y causa de falla. El panel (`/panel`) ya muestra las de la instancia; en producción van a un sistema de métricas (por ejemplo Cloud Monitoring u OpenTelemetry) con alertas.
- **Alertas mínimas:**
  - la tasa de éxito cae por debajo del umbral;
  - el tiempo medio sube;
  - el costo por tarea pasa el tope;
  - el escritorio no responde.

## 4. Costos (en pesos colombianos)

TRM de referencia: COP 3.216,01 por dólar (07/10/2026, Portafolio).

**Servidor (Cloud Run, facturación por instancia, nivel 1).** US$ 0,000018 por vCPU-segundo y US$ 0,000002 por GiB-segundo. Gratis cada mes: 240.000 vCPU-segundos y 450.000 GiB-segundos.

| Configuración | Uso | Costo aproximado al mes, después de la capa gratuita |
|---|---|---|
| 4 vCPU / 4 GiB, siempre encendido | 24/7 | US$ 202 ≈ COP 650.000 |
| 2 vCPU / 2 GiB, siempre encendido | 24/7 | US$ 98 ≈ COP 317.000 |
| 1 vCPU / 2 GiB, siempre encendido | 24/7 | US$ 52 ≈ COP 167.000 |
| 4 vCPU / 4 GiB, se apaga sin uso (mínimo 0) | ~16 h encendido al mes | ≈ COP 0 (dentro de la capa gratuita) |
| 4 vCPU / 4 GiB, se apaga sin uso | cada hora extra | ≈ US$ 0,29 ≈ COP 930 |

Son cálculos propios con la tarifa oficial. El valor real se confirma en Facturación de Google Cloud.

**Modelo de IA (OpenRouter, Gemini 2.5 Flash).** Se cobra por tarea según los tokens usados. El costo real por tarea lo mide el banco de pruebas (columna `costo_usd` del historial). Para una empresa:

`costo mensual del modelo = tareas al mes × costo medio por tarea medido`

**Base de datos, cola y almacenamiento** (para el punto 3.1). Sus precios se consultan en las páginas oficiales de Cloud SQL, Cloud Tasks y Cloud Storage antes de cotizar. No se ponen aquí cifras sin fuente.

## 5. Plan de piloto en una empresa (4 semanas)

1. **Semana 1: elegir y medir.**
   - Un solo proceso, repetitivo, con resultado verificable en pantalla.
   - Medir cuánto tarda hoy una persona y cuántos errores comete.
   - Escribir de 20 a 50 casos de prueba reales.
2. **Semana 2: adaptar y medir el agente.**
   - Correr el banco de pruebas al menos 3 veces seguidas.
   - Reportar la tasa de éxito real por caso. Si es baja, corregir según las capturas y la bitácora; nunca ajustar a ciegas.
3. **Semana 3: modo sombra.** El agente trabaja en paralelo con la persona, sin aplicar cambios, y se comparan los resultados.
4. **Semana 4: decisión con datos.**
   - Comparar tasa de éxito, tiempo y costo por tarea (en COP) contra el proceso manual.
   - Decidir si se pasa a autonomía con aprobación humana en las acciones críticas.

**Criterio de salida.** Si la tasa de éxito medida no supera la del proceso manual, o el costo por tarea no compensa, no se implementa. Esa conclusión también es un buen resultado del piloto.
