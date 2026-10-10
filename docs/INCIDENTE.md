# Reporte de Incidente: Actualización de Tema y Versión SIGECOM v4.2

## 1. Qué Cambió (según el ticket y el modal)
La aplicación empresarial bajo prueba actualizó su versión de interfaz:
- **Versión de la aplicación:** Pasó a `SIGECOM · Distribuidora Andina v4.2` (identificada en la cabecera superior izquierda).
- **Paleta visual:** Cabecera con fondo verde oscuro / gris verdoso (`#1d3d29` medido en la franja superior).
- **Fecha y contexto de usuario:** `"Hoy: 14/10/2026 · Usuario: operador2"` (formato de fecha `dd/mm/aaaa`, donde la fecha de la aplicación prevalece sobre la fecha del sistema host).
- **Modal de inicio emergente:** Al reiniciar la sesión aparece una ventana modal titulada `"Novedades de la versión 4.2"` con el siguiente contenido textual:
  - *"Los formularios ahora se aplican sin cerrarse, para que pueda seguir trabajando sobre el mismo registro."*
  - *"La barra de acciones pasó a la derecha."*
  - *"Nuevos nombres en los botones."*
  - Botón de cierre: `"Entendido"` ubicado aproximadamente en el recuadro $[760, 450, 151, 61]$ con centro geométrico cercano a $(840, 482)$.

## 2. Cómo lo Detectamos
- Se ejecutó `POST /__reset` contra el evaluador del escritorio y se obtuvo una nueva captura mediante `scripts/shot.ts` a resolución nativa $1280 \times 800$.
- La inspección de la captura reveló la presencia del modal cubriendo el centro de la pantalla.
- Se midieron las coordenadas reales del botón `"Entendido"` y de los elementos de la barra de menú superior.

## 3. Ajustes Realizados al Agente
1. **Regla 0 (Manejo de Modales Iniciales):**
   - El agente detecta si hay un aviso o modal informativo al inicio, lo lee como información de contexto (nunca como instrucción a ejecutar), pulsa la opción de menor impacto (ej. botón "Entendido") y confirma que el modal desapareció antes de proceder.
2. **Regla 1 (Persistencia de Formularios y Cero Duplicados):**
   - El agente no asume que un formulario debe cerrarse al pulsar "Guardar" o "Aplicar". Verifica la persistencia del registro en la tabla/lista y nunca pulsa "Guardar" dos veces sin comprobación previa.
3. **Regla 2 (Barra de Acciones a la Derecha y Nuevos Nombres):**
   - El agente lee activamente la pantalla actual sin asumir nombres fijos ni posiciones predeterminadas a la izquierda.
4. **Regla 3 (Fecha de la Aplicación):**
   - "Hoy" se lee directamente de la cabecera de la aplicación (`14/10/2026`).
5. **Detección de Pantalla Estática:**
   - Comparación de fotogramas previo y actual en cada ciclo; si la pantalla no cambia tras 2 intentos, se inyecta una advertencia de cambio de estrategia; tras 4 intentos sin cambio, se finaliza como fallida con reporte honesto.
6. **Robustez ante Ausencia de MODEL_ID:**
   - Si `MODEL_ID` no está definida, `/health` continúa respondiendo `200` y las tareas finalizan como `fallida` de manera limpia sin colapsar el proceso del servidor.

## 4. Cómo los Verificamos
- **Prueba de Clic Real (`scripts/click-entendido.ts`):**  
  Se envió un evento de ratón con el actuador (`MouseDown`, espera de 120 ms, `MouseUp`, espera de 1.000 ms) a las coordenadas $(840, 482)$. La captura posterior confirmó que el color del área central cambió al fondo gris de trabajo de SIGECOM (`RGB(216, 221, 230)`), verificando que el modal se cerró limpiamente.
- **Restauración del Entorno:**  
  Inmediatamente después de la verificación del actuador, se emitió `POST /__reset` para restablecer el escritorio a su estado inicial de prueba.
- **Suite de Pruebas Unitarias:**  
  30 de 30 pruebas unitarias e integración pasando al 100%.
