/**
 * VNC Authentication DES Challenge Encryptor
 * Implements RFC 6143 Section 7.2.2:
 * 1. Password truncated to 8 bytes or padded with \0 to 8 bytes.
 * 2. Each byte of the 8-byte key has its bits reversed.
 * 3. 16-byte challenge is encrypted in two 8-byte blocks using DES in ECB mode.
 */

// @ts-expect-error - des.js does not provide native TS declarations
import des from 'des.js';

/**
 * Standard DES ECB block encryption (NBS / FIPS PUB 46 compliant).
 */
export function rawDesEncrypt(block: Buffer, key: Buffer): Buffer {
  if (block.length !== 8 || key.length !== 8) {
    throw new Error('rawDesEncrypt requiere bloque y clave de exactamente 8 bytes');
  }
  const cipher = des.DES.create({
    type: 'encrypt',
    key: Array.from(key),
  });
  return Buffer.from(cipher.update(block));
}

/**
 * Reverses the bits in a single byte (bit 0 -> bit 7, bit 1 -> bit 6, etc.)
 */
export function reverseByteBits(b: number): number {
  let result = 0;
  for (let i = 0; i < 8; i++) {
    result = (result << 1) | ((b >> i) & 1);
  }
  return result & 0xff;
}

/**
 * Prepares the 8-byte DES key from the provided VNC password with reversed bits.
 */
export function prepareVncKey(password: string): Buffer {
  const key = Buffer.alloc(8, 0);
  const passBuf = Buffer.from(password, 'latin1');
  const len = Math.min(passBuf.length, 8);

  for (let i = 0; i < len; i++) {
    key[i] = reverseByteBits(passBuf[i]);
  }

  return key;
}

/**
 * Encrypts a 16-byte VNC challenge with the given password.
 */
export function encryptVncChallenge(challenge: Buffer, password: string): Buffer {
  if (challenge.length !== 16) {
    throw new Error(`El challenge de VNC debe ser exactamente de 16 bytes, recibido: ${challenge.length}`);
  }

  const key = prepareVncKey(password);
  const cipher = des.DES.create({
    type: 'encrypt',
    key: Array.from(key),
  });

  const block1 = cipher.update(challenge.subarray(0, 8));
  const block2 = cipher.update(challenge.subarray(8, 16));

  return Buffer.concat([Buffer.from(block1), Buffer.from(block2)]);
}
