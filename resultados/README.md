# Resultados del banco de pruebas

`historial.jsonl`: una línea JSON por prueba corrida con `scripts/run-test.ts` contra el escritorio SIGECOM real.
Campos: fecha, version (revisión de Cloud Run), ronda, id, aprobada, estado, esperado, check, resumen_valido,
pasos, segundos, costo_usd, motivo, resumen.

Se incluye en la imagen del servidor para que el panel (`/panel`, pestaña "Banco de pruebas") lo muestre.
Ningún dato de este archivo se escribe a mano.
