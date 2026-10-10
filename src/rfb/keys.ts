/**
 * X11 Keysyms & Spanish Keyboard Mapping
 * Supports: ñ, Ñ, tildes (á é í ó ú ü), ¿ ¡, # @ / - _ . , : ; ( ) % $, uppercase with Shift.
 */

export const SPECIAL_KEYSYMS: Record<string, number> = {
  BackSpace: 0xff08,
  Tab: 0xff09,
  Return: 0xff0d,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Delete: 0xffff,
  Home: 0xff50,
  Left: 0xff51,
  Up: 0xff52,
  Right: 0xff53,
  Down: 0xff54,
  Page_Up: 0xff55,
  Page_Down: 0xff56,
  End: 0xff57,
  Shift_L: 0xffe1,
  Shift_R: 0xffe2,
  Control_L: 0xffe3,
  Control_R: 0xffe4,
  Alt_L: 0xffe9,
  Alt_R: 0xffea,
  Super_L: 0xffeb,
};

export interface KeyStroke {
  keysym: number;
  shift: boolean;
}

/**
 * Maps a single character to its X11 keysym and whether it requires the Shift modifier.
 */
export function charToKeyStroke(char: string): KeyStroke {
  if (char.length !== 1) {
    throw new Error(`charToKeyStroke espera exactamente 1 carácter, recibió: "${char}"`);
  }

  const code = char.charCodeAt(0);

  // Uppercase ASCII A-Z
  if (code >= 65 && code <= 90) {
    return { keysym: code, shift: true };
  }

  // Lowercase ASCII a-z
  if (code >= 97 && code <= 122) {
    return { keysym: code, shift: false };
  }

  // Digits 0-9
  if (code >= 48 && code <= 57) {
    return { keysym: code, shift: false };
  }

  // Spanish special characters
  switch (char) {
    case 'ñ':
      return { keysym: 0x00f1, shift: false };
    case 'Ñ':
      return { keysym: 0x00d1, shift: true };
    case 'á':
      return { keysym: 0x00e1, shift: false };
    case 'Á':
      return { keysym: 0x00c1, shift: true };
    case 'é':
      return { keysym: 0x00e9, shift: false };
    case 'É':
      return { keysym: 0x00c9, shift: true };
    case 'í':
      return { keysym: 0x00ed, shift: false };
    case 'Í':
      return { keysym: 0x00cd, shift: true };
    case 'ó':
      return { keysym: 0x00f3, shift: false };
    case 'Ó':
      return { keysym: 0x00d3, shift: true };
    case 'ú':
      return { keysym: 0x00fa, shift: false };
    case 'Ú':
      return { keysym: 0x00da, shift: true };
    case 'ü':
      return { keysym: 0x00fc, shift: false };
    case 'Ü':
      return { keysym: 0x00dc, shift: true };
    case '¿':
      return { keysym: 0x00bf, shift: false };
    case '¡':
      return { keysym: 0x00a1, shift: false };
    // Symbols
    case ' ':
      return { keysym: 0x0020, shift: false };
    case '!':
      return { keysym: 0x0021, shift: true };
    case '"':
      return { keysym: 0x0022, shift: true };
    case '#':
      return { keysym: 0x0023, shift: false };
    case '$':
      return { keysym: 0x0024, shift: false };
    case '%':
      return { keysym: 0x0025, shift: false };
    case '&':
      return { keysym: 0x0026, shift: false };
    case "'":
      return { keysym: 0x0027, shift: false };
    case '(':
      return { keysym: 0x0028, shift: false };
    case ')':
      return { keysym: 0x0029, shift: false };
    case '*':
      return { keysym: 0x002a, shift: false };
    case '+':
      return { keysym: 0x002b, shift: false };
    case ',':
      return { keysym: 0x002c, shift: false };
    case '-':
      return { keysym: 0x002d, shift: false };
    case '.':
      return { keysym: 0x002e, shift: false };
    case '/':
      return { keysym: 0x002f, shift: false };
    case ':':
      return { keysym: 0x003a, shift: false };
    case ';':
      return { keysym: 0x003b, shift: false };
    case '<':
      return { keysym: 0x003c, shift: false };
    case '=':
      return { keysym: 0x003d, shift: false };
    case '>':
      return { keysym: 0x003e, shift: false };
    case '?':
      return { keysym: 0x003f, shift: false };
    case '@':
      return { keysym: 0x0040, shift: false };
    case '_':
      return { keysym: 0x005f, shift: false };
    default:
      // Direct Unicode code point (RFC 6143 supports Latin-1 and Unicode keysyms 0x01000000 + codepoint)
      if (code <= 0x00ff) {
        return { keysym: code, shift: false };
      }
      return { keysym: 0x01000000 | code, shift: false };
  }
}

/**
 * Converts a string of text into an array of individual key actions.
 */
export function textToKeyStrokes(text: string): KeyStroke[] {
  const result: KeyStroke[] = [];
  for (let i = 0; i < text.length; i++) {
    result.push(charToKeyStroke(text[i]));
  }
  return result;
}

/**
 * Parses a key combo string like "ctrl+a", "backspace", "enter", "tab".
 */
export function parseKeyCombo(combo: string): { ctrl: boolean; alt: boolean; shift: boolean; keysym: number } {
  const parts = combo.toLowerCase().split('+').map((s) => s.trim());
  let ctrl = false;
  let alt = false;
  let shift = false;
  let mainKey = '';

  for (const part of parts) {
    if (part === 'ctrl' || part === 'control') {
      ctrl = true;
    } else if (part === 'alt') {
      alt = true;
    } else if (part === 'shift') {
      shift = true;
    } else {
      mainKey = part;
    }
  }

  // Case-insensitive lookup in SPECIAL_KEYSYMS
  const lowerMain = mainKey.toLowerCase();
  for (const [k, v] of Object.entries(SPECIAL_KEYSYMS)) {
    if (k.toLowerCase() === lowerMain) {
      return { ctrl, alt, shift, keysym: v };
    }
  }

  if (mainKey.length === 1) {
    const stroke = charToKeyStroke(mainKey);
    return { ctrl, alt, shift: shift || stroke.shift, keysym: stroke.keysym };
  }

  throw new Error(`Tecla o combinación no reconocida: "${combo}"`);
}
