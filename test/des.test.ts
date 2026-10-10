import test from 'node:test';
import assert from 'node:assert/strict';
import { reverseByteBits, prepareVncKey, encryptVncChallenge, rawDesEncrypt } from '../src/rfb/des.js';

test('Standard DES Test Vector (NBS / FIPS PUB 46)', () => {
  // Clave: 133457799BBCDFF1
  // Texto: 0123456789ABCDEF
  // Esperado: 85E813540F0AB405
  const key = Buffer.from('133457799BBCDFF1', 'hex');
  const plaintext = Buffer.from('0123456789ABCDEF', 'hex');
  const expectedCiphertext = '85E813540F0AB405';

  const result = rawDesEncrypt(plaintext, key);
  const resultHex = result.toString('hex').toUpperCase();

  assert.equal(resultHex, expectedCiphertext, 'El resultado DES debe coincidir exactamente con el vector estándar NBS');
});

test('VNC DES - Bit reversal reverses 8 bits correctly', () => {
  assert.equal(reverseByteBits(0x01), 0x80);
  assert.equal(reverseByteBits(0x80), 0x01);
  assert.equal(reverseByteBits(0xaa), 0x55);
  assert.equal(reverseByteBits(0x00), 0x00);
  assert.equal(reverseByteBits(0xff), 0xff);
});

test('VNC DES - prepareVncKey pads and truncates to 8 bytes', () => {
  const shortKey = prepareVncKey('abc');
  assert.equal(shortKey.length, 8);
  assert.equal(shortKey[0], reverseByteBits('a'.charCodeAt(0)));
  assert.equal(shortKey[1], reverseByteBits('b'.charCodeAt(0)));
  assert.equal(shortKey[2], reverseByteBits('c'.charCodeAt(0)));
  assert.equal(shortKey[3], 0);

  const longKey = prepareVncKey('1234567890EXTRA');
  assert.equal(longKey.length, 8);
  assert.equal(longKey[7], reverseByteBits('8'.charCodeAt(0)));
});

test('VNC DES - encryptVncChallenge encrypts 16-byte challenge into 16-byte response', () => {
  const challenge = Buffer.from('0123456789abcdef', 'ascii');
  assert.equal(challenge.length, 16);

  const response = encryptVncChallenge(challenge, 'vncpass');
  assert.equal(response.length, 16);
  assert.notDeepEqual(response, challenge);
});
