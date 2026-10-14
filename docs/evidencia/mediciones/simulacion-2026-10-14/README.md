# Simulación del agente completo sin gastar en modelos (14/10/2026)

**Qué es.** `scripts/simular-tarea.ts` corre el agente entero contra el escritorio GESTORA en local: bucle, OCR, localizador, cliente VNC, plazos y bitácora. Las llamadas a OpenRouter se interceptan dentro del proceso:

- **Planificador.** Recibe un guion fijo con las decisiones que tomó Claude Sonnet 5.5 en la corrida pagada del 13/10, en los puntos donde falló el ejecutor.
- **Visión.** Cada consulta recibe "no lo veo" y se cuenta, porque en una corrida real se paga.

**Qué mide y qué no.**
- **Mide el ejecutor**: lo que hace el agente con una decisión dada.
- **No mide al planificador.** El guion no se adapta a la pantalla: si un paso falla, los siguientes se ejecutan igual sobre una pantalla equivocada. En una corrida real, Claude se habría corregido con pasos extra pagados, como hizo el 13/10.

**Antes y después, con el mismo escritorio y la misma máquina.**
- **Antes**: el commit e124147, que es lo que está desplegado. Se corrió con `AGENTE_DIR` apuntando a una copia de trabajo de ese commit.
- **Ahora**: el código de este commit.

## Resultado

| Guion | Origen en la corrida del 13/10 | Antes (e124147) | Ahora |
|---|---|---|---|
| `submenu` | 17 de 20 pruebas gastaron un paso abriendo un submenú | ❌ "Clientes" no aparece; 1 consulta de visión | ✅ 0 consultas |
| `g15` | Lista Estado nombrada por su valor ("Pagada") | ❌ "[Todos]" → cabecera (412,165); "[Pagada]" → tabla (898,215); 3 consultas | ✅ 0 consultas |
| `buscar` | El planificador copió "Buscar (nombre \| documento):" | ❌ etiqueta no encontrada; no escribió; 2 consultas | ✅ 0 consultas |
| `g04` | Exportar con fechas y estado; corte por costo | ❌ `/__check` sin exportación; 5 consultas | ✅ `/__check` aprobado; 0 consultas |

Salidas completas, con la bitácora de cada paso: `antes-e124147.txt` y `ahora.txt`.

## Qué falló antes y qué se cambió

1. **El submenú de Tk no abre al pasar el ratón.**
   - Cambio: después de un `move` sobre una opción de menú, si a la derecha del puntero no aparece un panel nuevo con texto, el agente pulsa la tecla Derecha.
   - Primera versión: comparaba palabras del OCR y falló en esta simulación. Al releer la zona del menú, el OCR devolvía trozos del texto de fondo ("ESTORA"), que parecían nuevos.
   - Versión final: compara bloques de píxeles. Prueba: `test/ocr.test.ts`, con capturas reales.
2. **Lista desplegable nombrada por su valor.** Ver `../localizador-2026-10-14-v2/`.
3. **"|" en las etiquetas.**
   - El texto que recibe el planificador partía la fila de "Buscar (nombre o documento):": la "o" quedaba en otra fila y en su lugar aparecía " | ".
   - Cambio: ahora las filas se arman por solape vertical.
   - Además, un " | " copiado en el objetivo vale por una palabra o por ninguna.
4. **Botón contra texto suelto.**
   - En la primera simulación "después", "Filtrar" cayó en la barra de estado ("pulse Filtrar."): la lectura del botón recién pulsado perdió puntaje.
   - Cambio: si el objetivo es un botón y solo algunas coincidencias están dentro de una caja cerrada, valen esas.
5. **Búsqueda parcial con tolerancia.**
   - En la corrida "antes" de g04, "lista" (de "Exportar lista…") encontró "Listo." en la barra de estado y el agente hizo clic ahí.
   - Cambio: la búsqueda parcial ahora exige palabras exactas.

## Cuánto pesaban estos errores en la corrida pagada (13/10, Sonnet 5.5)

Contado en `../../benchmark-2026-10-14/consola-sonnet-5.5.txt`, que tiene 228 pasos del planificador a US$ 0,0165 por paso en promedio:

- **17 pasos** abriendo el submenú a mano, el paso 3 en 17 de las 20 pruebas.
- **49 pasos** repitiendo la escritura en un campo que ya se había intentado llenar. La bitácora muestra que el texto había caído en la cabecera de la tabla (y=165).
- **Al menos 4 clics más** en la tabla por la lista nombrada por su valor (G15).
- De las **70 consultas de visión**, 50 tuvieron causa determinista y ya corregida:
  - 19 por "Cliente:" contra la cabecera "Cliente";
  - 17 por el "|" en la etiqueta;
  - 14 por el puntero encima del texto.

**Estimación, no medición.** Si esos 66 pasos no se repiten y el planificador no gasta pasos en otra cosa, el costo medio bajaría de US$ 0,19 a unos US$ 0,13–0,14 por tarea (≈ COP 420–450, TRM 3.216,01). El tiempo medio bajaría de 206 s a unos 150 s. A esto se sumaría el ahorro de la caché de Anthropic, que todavía no está medido. **La única forma de confirmarlo es una corrida pagada**, que se hará cuando Andrés la apruebe.
