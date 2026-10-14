# Localizador de campos: medición sin gastar en modelos (14/10/2026)

**Qué se mide.** Si el agente escribe dentro del campo correcto cuando el planificador nombra el campo por su etiqueta, como en "type_text en 'Cliente:'". Se aplica el mismo camino del agente: OCR de la etiqueta, luego el buscador de campos y, si este falla, la etiqueta más 45 px a la derecha.

**Contra qué se compara.** La aplicación GESTORA escribe la caja real de cada campo en pantalla (variable `GESTORA_GEOMETRIA`).

**Cómo se recorre.** Por VNC con el cliente del agente: Clientes, Nuevo cliente, Editar cliente, Facturas y Pedidos, con 24 campos en total.

Herramienta: `scripts/medir-localizador.ts`. No llama a ningún modelo; corre en local con el escritorio de `escritorio/`.

## Resultado

| Código | Campos dentro de su caja real |
|---|---|
| Antes (87f23df, el que corrió en el banco del 13/10) | **11/24** (46 %) |
| Ahora (cambios de 2f268d2 y siguientes) | **23/24** (96 %) |

## Qué fallaba antes

- **Los 8 filtros de Facturas y Pedidos, y los 2 de Clientes.** El punto caía en la cabecera de la tabla (y≈165) en vez del campo (y≈126). La causa: comparar distancias entre centros favorecía la tabla de abajo.
- **"Estado:" en Pedidos.** Se elegía la cabecera de la columna "Estado" en vez del filtro "Estado:".
- **"Notas", un área de texto de 4 líneas.** El buscador solo aceptaba cajas de 14 a 48 px de alto y el agente escribía fuera del cuadro.

## Lo que sigue fallando (1 de 24)

En "Editar cliente", la etiqueta "Número de documento" no se lee porque el puntero del ratón quedó encima después del doble clic que abrió el registro. En una tarea real, el respaldo de visión cubre este caso; esta medición no usa modelos.

## Relación con el banco del 13/10

En la corrida con Claude Sonnet 5.5, 30 de 228 pasos (13 %) se fueron en corregir errores previos. Casi todos eran estos campos: buscador, filtros, "Ciudad" y fechas. Los tres cortes por tope de costo (G04, G15, G20) incluyen ese desperdicio.

Salida completa:

```
=== ANTES (87f23df) ===

Campos ubicados dentro de su caja real: 11/24
  Clientes | "Buscar (nombre o documento):" (TEntry) -> (56,165) vía campo; campo real x 229-487, y 114-138
  Clientes | "Ciudad:" (TCombobox) -> (761,195) vía campo; campo real x 563-709, y 114-138
  Nuevo cliente | "Notas" (Text) -> (119,372) vía derecha+45; campo real x 253-673, y 335-409
  Editar cliente | "Número de documento" (TEntry) -> etiqueta no leída; campo real x 253-439, y 199-223
  Editar cliente | "Notas" (Text) -> (119,372) vía derecha+45; campo real x 253-673, y 335-409
  Facturas | "Cliente:" (TEntry) -> (461,165) vía campo; campo real x 77-299, y 114-138
  Facturas | "Estado:" (TCombobox) -> (353,165) vía campo; campo real x 372-491, y 114-138
  Facturas | "Desde:" (TEntry) -> (545,165) vía campo; campo real x 561-666, y 114-138
  Facturas | "Hasta:" (TEntry) -> (712,165) vía campo; campo real x 724-829, y 114-138
  Pedidos | "Cliente:" (TEntry) -> (431,165) vía campo; campo real x 77-263, y 114-138
  Pedidos | "Estado:" (TCombobox) -> (651,165) vía campo; campo real x 334-453, y 114-138
  Pedidos | "Desde:" (TEntry) -> (505,165) vía campo; campo real x 521-626, y 114-138
  Pedidos | "Hasta:" (TEntry) -> (672,165) vía campo; campo real x 684-789, y 114-138

=== AHORA ===

Campos ubicados dentro de su caja real: 23/24
  Editar cliente | "Número de documento" (TEntry) -> etiqueta no leída; campo real x 253-439, y 199-223
```
