# OCR: qué variante lee el submenú flotante (12/10/2026)

**Problema.** En la corrida real de E1, el agente abrió Comercial > Maestros pero no encontró "Clientes" en el submenú flotante. Captura: `../capturas/e1-2026-10-12/paso-5.png`.

**Método.** Tesseract 5 (spa+eng, un hilo) sobre capturas reales de 1280x800. Se cuentan las palabras distintas de 3 o más letras con confianza ≥ 30. El tiempo es de un proceso, en el contenedor de desarrollo.

| Captura | A gris x2 psm6 | B gris x2 psm11 (antes) | C claro x2 psm6 | **B gris x3 psm11 (ahora)** | ¿"Clientes" con A+B+C antes? | ¿Con A+B3+C ahora? |
|---|---|---|---|---|---|---|
| paso-5 (submenú abierto) | 25 pal. / 680 ms | 25 / 628 ms | 23 / 621 ms | **27 / 789 ms** | **no** | **sí, en (327,76)** |
| paso-4 (menú Comercial) | 27 / 592 ms | 27 / 554 ms | 26 / 675 ms | 27 / 734 ms | n/a | n/a |
| paso-1 (modal de inicio) | 28 / 520 ms | 27 / 507 ms | 28 / 717 ms | 27 / 681 ms | n/a | n/a |
| sigecom-modal (fixture) | 30 / 543 ms | 28 / 572 ms | 28 / 611 ms | 31 / 922 ms | n/a | n/a |

**Resultado.**
- En las cuatro capturas, la unión A+B3+C cubre al menos lo mismo que A+B+C.
- En paso-5, A+B+C no leía "clientes"; A+B3+C sí.
- B3 cuesta unos 150–350 ms más por proceso. Las tres variantes corren en paralelo.

**Lo que no se resolvió.** "Maestros" resaltado (blanco sobre verde) tampoco se lee en paso-5, porque el puntero del ratón está encima del texto. Si el agente necesita ese texto, el respaldo es la visión.

**Verificación automática.** Prueba `OCR - captura real del agente (E1, 12/10)` en `test/ocr.test.ts`, con fixture `test/fixtures/sigecom-submenu.png`.
