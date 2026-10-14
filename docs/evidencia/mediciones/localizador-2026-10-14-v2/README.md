# Localizador de campos, segunda medición (14/10/2026, sin modelos)

Sigue a `../localizador-campos-2026-10-14.md` (11/24 → 23/24). Esta medición agrega dos cosas que aparecieron al revisar las bitácoras pagadas del 13/10:

- **Lista desplegable nombrada por su valor.** En G15, Claude escribió `click "lista desplegable Estado [Pagada]"`: nombró la lista por lo que mostraba, no por su etiqueta. "Pagada" estaba también en 15 filas de la tabla y el agente hizo clic en la tabla 4 veces.
- **La pantalla filtrada de G15.** Facturas con Cliente "Ruiz" y Estado "Pagada".

## Cómo se mide

- **Herramienta.** `scripts/medir-localizador.ts`, contra el escritorio GESTORA en local. La app escribe la caja real de cada campo, su etiqueta y su valor.
- **"Ahora".** Llama a `locateField`, la misma función que usa el agente.
- **"Antes".** El camino del agente en e124147 (lo desplegado hoy), con el buscador de campos de ese commit, tomado con `git show e124147:src/agent/ocr.ts`.
- **Visión.** Ninguno de los dos la usa. Es el peor caso: si la visión desempata, el resultado solo puede mejorar.
- **Puntero.** Las capturas de las dos columnas ya salen sin puntero, porque el cliente VNC pide la forma del puntero aparte (ver abajo).

## Resultado (`salida.txt`)

| Caso | Antes (e124147) | Ahora |
|---|---|---|
| Campo nombrado por su etiqueta ("Cliente:", "Estado:", "Notas"…) | 28/28 | 28/28 |
| Lista desplegable nombrada por su valor ("Todas", "NIT", "Manizales", "Todos", "Pagada") | **0/7** | **7/7** |

## Por qué fallaba "por valor"

El buscador trataba el valor como si fuera una etiqueta y buscaba "su campo" a la derecha o abajo. Debajo de la lista estaba la cabecera de la tabla, que tiene bordes como un campo, así que el clic iba a la cabecera (412,165) o a una fila.

**Cambio.** `fieldContaining` detecta si un texto está **dentro** de una caja cerrada (bordes arriba, abajo, izquierda y derecha) y `locateField` decide así:

1. **Etiqueta con su campo al lado.** Un texto dentro de una caja no es una etiqueta: puede ser una cabecera de tabla, el valor de una lista o texto ya escrito.
2. **Valor dentro de un campo.** El clic va sobre ese valor.
3. **Ninguna caja detectada.** El punto queda 45 px a la derecha de la etiqueta.

## Otro error que salió al probar

**Filas de tabla tomadas por campo.** La parte de arriba de las minúsculas de una fila ("ermanos") pasaba por línea horizontal. El detector muestreaba cada 3 px y aceptaba el 85 %, así que dos filas seguidas parecían el borde superior e inferior de un campo. Ahora revisa cada píxel y exige el 95 %.

Prueba con la captura real: `test/ocr.test.ts`, "lista desplegable nombrada por su valor".

## Puntero del ratón en las capturas

**Antes.** x11vnc pintaba el puntero dentro de la imagen. Tapaba el texto donde se acababa de hacer clic y el OCR no lo leía. En la corrida pagada del 13/10 con Sonnet pasó 14 veces ("Maestros", "Ventas", "Siguiente"), y cada vez se pagó una consulta de visión.

**Cambio.** El cliente VNC del agente pide la pseudo-codificación Cursor (-239, RFC 6143). El servidor manda la forma del puntero aparte y deja de pintarlo en la imagen. Un servidor que no la soporte la ignora.

**Verificado en local.** Con el puntero encima de "Maestros" y de "Siguiente", el OCR lee los dos textos.

**Prueba.** `test/rfb.test.ts`, con un servidor simulado que manda el rectángulo del puntero.
