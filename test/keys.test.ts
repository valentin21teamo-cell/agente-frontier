import test from 'node:test';
import assert from 'node:assert/strict';
import { charToKeyStroke, textToKeyStrokes, parseKeyCombo, SPECIAL_KEYSYMS } from '../src/rfb/keys.js';

test('Keyboard Mapping - "Papelería" correctly maps accents, uppercase, and lowercase', () => {
  const text = 'Papelería';
  const strokes = textToKeyStrokes(text);

  assert.equal(strokes.length, 9);

  // 'P' -> uppercase with Shift
  assert.equal(strokes[0].keysym, 80); // 'P'
  assert.equal(strokes[0].shift, true);

  // 'a'
  assert.equal(strokes[1].keysym, 97);
  assert.equal(strokes[1].shift, false);

  // 'p'
  assert.equal(strokes[2].keysym, 112);
  assert.equal(strokes[2].shift, false);

  // 'e'
  assert.equal(strokes[3].keysym, 101);
  assert.equal(strokes[3].shift, false);

  // 'l'
  assert.equal(strokes[4].keysym, 108);
  assert.equal(strokes[4].shift, false);

  // 'e'
  assert.equal(strokes[5].keysym, 101);
  assert.equal(strokes[5].shift, false);

  // 'r'
  assert.equal(strokes[6].keysym, 114);
  assert.equal(strokes[6].shift, false);

  // 'í' -> X11 keysym 0x00ED (XK_iacute)
  assert.equal(strokes[7].keysym, 0x00ed);
  assert.equal(strokes[7].shift, false);

  // 'a'
  assert.equal(strokes[8].keysym, 97);
  assert.equal(strokes[8].shift, false);
});

test('Keyboard Mapping - "Calle 80 # 24-15" maps numbers, spaces, hash and hyphen', () => {
  const text = 'Calle 80 # 24-15';
  const strokes = textToKeyStrokes(text);

  assert.equal(strokes.length, text.length);

  // 'C'
  assert.equal(strokes[0].keysym, 67);
  assert.equal(strokes[0].shift, true);

  // '#' (hash symbol) -> keysym 0x0023
  const hashStroke = strokes[9]; // index 9 is '#'
  assert.equal(hashStroke.keysym, 0x0023);

  // '-' (hyphen) -> keysym 0x002d
  const hyphenStroke = strokes[13]; // index 13 is '-'
  assert.equal(hyphenStroke.keysym, 0x002d);
});

test('Keyboard Mapping - Email address with @, dots and symbols', () => {
  const email = 'usuario.prueba+123@distribuidora-faro.com';
  const strokes = textToKeyStrokes(email);

  assert.equal(strokes.length, email.length);

  // '@' -> 0x0040
  const atIndex = email.indexOf('@');
  assert.equal(strokes[atIndex].keysym, 0x0040);

  // '.' -> 0x002e
  const dotIndex = email.indexOf('.');
  assert.equal(strokes[dotIndex].keysym, 0x002e);

  // '+' -> 0x002b
  const plusIndex = email.indexOf('+');
  assert.equal(strokes[plusIndex].keysym, 0x002b);
});

test('Keyboard Mapping - Spanish special characters: ñ, Ñ, tildes, ¿, ¡, %, $', () => {
  const specialChars = 'ñÑáéíóúÁÉÍÓÚüÜ¿¡%$';
  const strokes = textToKeyStrokes(specialChars);

  assert.equal(strokes[0].keysym, 0x00f1); // ñ
  assert.equal(strokes[0].shift, false);

  assert.equal(strokes[1].keysym, 0x00d1); // Ñ
  assert.equal(strokes[1].shift, true);

  assert.equal(strokes[2].keysym, 0x00e1); // á
  assert.equal(strokes[7].keysym, 0x00c1); // Á
  assert.equal(strokes[7].shift, true);

  assert.equal(strokes[12].keysym, 0x00fc); // ü
  assert.equal(strokes[13].keysym, 0x00dc); // Ü
  assert.equal(strokes[13].shift, true);

  assert.equal(strokes[14].keysym, 0x00bf); // ¿
  assert.equal(strokes[15].keysym, 0x00a1); // ¡
  assert.equal(strokes[16].keysym, 0x0025); // %
  assert.equal(strokes[17].keysym, 0x0024); // $
});

test('Keyboard Mapping - Combos parse correctly (ctrl+a, backspace, enter)', () => {
  const ctrlA = parseKeyCombo('ctrl+a');
  assert.equal(ctrlA.ctrl, true);
  assert.equal(ctrlA.keysym, 97);

  const bs = parseKeyCombo('backspace');
  assert.equal(bs.keysym, SPECIAL_KEYSYMS.BackSpace);

  const enter = parseKeyCombo('enter');
  assert.equal(enter.keysym, SPECIAL_KEYSYMS.Return);
});
