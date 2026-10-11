/**
 * Escalera de reintento de clic: si el modelo propone un clic y la pantalla no cambia, el siguiente
 * clic cercano a esa misma propuesta se desplaza en pasos pequeños (la puntería del modelo falla por
 * decenas de píxeles, no por cientos). Solo se usa cuando el clic anterior no produjo ningún cambio.
 */

export const LADDER: ReadonlyArray<readonly [number, number]> = [
  [45, 0],
  [90, 0],
  [-45, 0],
  [0, 28],
  [0, -28],
  [90, 28],
  [-45, -28],
];

export interface TriedPoint {
  x: number;
  y: number;
  n: number;
}

export function applyLadder(
  tried: TriedPoint[],
  x: number,
  y: number,
  width: number,
  height: number,
  radius = 25
): { x: number; y: number; shifted: boolean } {
  const entry = tried.find((t) => Math.hypot(t.x - x, t.y - y) <= radius);
  let ox = x;
  let oy = y;
  let shifted = false;
  if (entry) {
    const [dx, dy] = LADDER[(entry.n - 1) % LADDER.length];
    ox = x + dx;
    oy = y + dy;
    shifted = true;
    entry.n += 1;
  } else {
    tried.push({ x, y, n: 1 });
  }
  ox = Math.max(0, Math.min(width - 1, Math.round(ox)));
  oy = Math.max(0, Math.min(height - 1, Math.round(oy)));
  return { x: ox, y: oy, shifted };
}
