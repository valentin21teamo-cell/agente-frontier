# OCR incremental contra OCR completo (14/10/2026, sin modelos)

**Qué se mide.** Entre un paso y el siguiente, casi siempre cambia solo una parte pequeña de la pantalla: el puntero, el campo donde se escribió o la lista que se abrió. El OCR incremental (commit e124147) compara la captura nueva con la anterior y relee solo las zonas que cambiaron. Si cambian más de 8 zonas o más del 15 % de la pantalla, hace la lectura completa. Cada 8 lecturas parciales hace una completa.

**Con qué.** Cinco capturas reales de GESTORA tomadas por VNC con el cliente del agente (están en esta carpeta) y `scripts/medir-ocr-incremental.ts`. No llama a ningún modelo.

**Equipo.** El de desarrollo, con 2 CPU. Cloud Run tiene 4 vCPU, así que allí los dos tiempos deberían ser menores. **No está medido en Cloud Run.**

## Resultado (`salida.txt`)

| Cambio entre capturas | OCR completo | Incremental | Textos objetivo en el mismo punto |
|---|---|---|---|
| Mover el puntero sobre la lista | 4,9 s | 1,2 s | 4/4 (uno con 1 px de diferencia) |
| Escribir un nombre en el formulario | 2,3 s | 1,4 s | 4/4 |
| Abrir la lista de ciudades | 2,8 s | 2,1 s | 4/4 |

Palabras que difieren entre las dos lecturas: las dos leen lo mismo salvo restos del puntero y una lectura de "NIT" como "INIT". Ninguna diferencia toca un texto objetivo.

## Lo que esto no dice

- **Cuánto baja el tiempo por tarea.** El agente hace OCR dos veces por paso (para el planificador y para ubicar el clic). El ahorro por tarea depende de cuántos pasos cambian poco la pantalla. Se mide en la próxima corrida autorizada.
- **Pantallas que cambian por completo**, como pasar de una lista a un formulario. Ahí el incremental hace lectura completa y no ahorra nada.
