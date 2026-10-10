/**
 * Autonomous RFB (VNC) Client over WebSocket (websockify)
 * Fully compliant with RFC 6143:
 * - VNC Authentication (DES key bit-reversal)
 * - Dynamic resolution from ServerInit (never hardcoded)
 * - Raw framebuffer tracking with incremental updates
 * - Mouse events with >100ms click duration (120ms) and >=1000ms repaint settling
 * - Spanish keyboard and special keys mapping
 * - PNG screenshot export for visual agent models
 * - Clean lifecycle termination and task isolation
 */

import WebSocket from 'ws';
import { PNG } from 'pngjs';
import { encryptVncChallenge } from './des.js';
import { charToKeyStroke, parseKeyCombo, SPECIAL_KEYSYMS } from './keys.js';
import { safeLogger } from '../security/sanitize.js';

export interface RfbClientOptions {
  url: string;
  password?: string;
  abortSignal?: AbortSignal;
  onDisconnected?: (reason?: string) => void;
}

export interface PixelFormat {
  bpp: number;
  depth: number;
  bigEndian: boolean;
  trueColor: boolean;
  redMax: number;
  greenMax: number;
  blueMax: number;
  redShift: number;
  greenShift: number;
  blueShift: number;
}

const BLOCKED_COMBOS = new Set(['alt+f4', 'ctrl+w', 'ctrl+q', 'ctrl+shift+w', 'f11', 'alt+tab', 'ctrl+alt+delete', 'ctrl+alt+del']);

export class RfbClient {
  private ws?: WebSocket;
  private rxBuffer = Buffer.alloc(0);
  private state: 'handshake_version' | 'security_types' | 'security_auth' | 'security_result' | 'server_init' | 'active' | 'closed' = 'handshake_version';
  
  public width = 0;
  public height = 0;
  public serverName = '';
  public pixelFormat?: PixelFormat;
  private framebuffer = Buffer.alloc(0);
  private initialFramePromise: Promise<void>;
  private resolveInitialFrame!: () => void;
  private hasReceivedFirstFrame = false;
  private closed = false;

  constructor(private options: RfbClientOptions) {
    this.initialFramePromise = new Promise<void>((resolve) => {
      this.resolveInitialFrame = resolve;
    });

    if (options.abortSignal) {
      options.abortSignal.addEventListener('abort', () => {
        this.close('Abort signal triggered');
      });
    }
  }

  /**
   * Connects to the VNC server via WebSocket, completes handshake and waits for first framebuffer frame.
   */
  public async connect(): Promise<{ width: number; height: number; serverName: string }> {
    return new Promise((resolve, reject) => {
      const timeoutTimer = setTimeout(() => {
        this.close('Connection timeout');
        reject(new Error('Timeout conectando al servidor RFB por WebSocket'));
      }, 15000);

      try {
        this.ws = new WebSocket(this.options.url);
        this.ws.binaryType = 'nodebuffer';
      } catch (err) {
        clearTimeout(timeoutTimer);
        reject(err);
        return;
      }

      this.ws.on('open', () => {
        safeLogger.info(`[RFB] WebSocket abierto con ${new URL(this.options.url).host}`);
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          this.handleIncomingData(Buffer.from(data));
          if (this.state === 'active' && this.width > 0 && this.height > 0) {
            clearTimeout(timeoutTimer);
            resolve({ width: this.width, height: this.height, serverName: this.serverName });
          }
        } catch (err) {
          clearTimeout(timeoutTimer);
          reject(err);
        }
      });

      this.ws.on('error', (err) => {
        safeLogger.error(`[RFB] Error de WebSocket: ${err.message}`);
        clearTimeout(timeoutTimer);
        reject(err);
      });

      this.ws.on('close', (code, reason) => {
        this.closed = true;
        this.state = 'closed';
        if (this.options.onDisconnected) {
          this.options.onDisconnected(`WebSocket cerrado (${code}: ${reason.toString()})`);
        }
      });
    });
  }

  /**
   * Waits for the first framebuffer update to be rendered.
   */
  public async waitForFirstFrame(timeoutMs = 10000): Promise<void> {
    if (this.hasReceivedFirstFrame) return;

    // Si el escritorio acaba de reiniciarse, puede tardar en pintar: pedimos el cuadro completo cada 2 s.
    const retry = setInterval(() => {
      if (!this.hasReceivedFirstFrame) this.requestFramebufferUpdate(false);
    }, 2000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.initialFramePromise,
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Timeout esperando primer fotograma del framebuffer')), timeoutMs);
        }),
      ]);
    } finally {
      clearInterval(retry);
      if (timer) clearTimeout(timer);
    }
  }

  private handleIncomingData(chunk: Buffer): void {
    this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);

    while (this.rxBuffer.length > 0) {
      if (this.state === 'handshake_version') {
        if (this.rxBuffer.length < 12) return;
        const verStr = this.rxBuffer.subarray(0, 12).toString('ascii');
        this.rxBuffer = this.rxBuffer.subarray(12);

        if (!verStr.startsWith('RFB 003.')) {
          throw new Error(`Protocolo RFB desconocido: ${verStr}`);
        }

        // Respond with standard RFB 003.008
        this.send(Buffer.from('RFB 003.008\n', 'ascii'));
        this.state = 'security_types';
      } else if (this.state === 'security_types') {
        if (this.rxBuffer.length < 1) return;
        const numTypes = this.rxBuffer.readUInt8(0);
        if (this.rxBuffer.length < 1 + numTypes) return;

        const types = this.rxBuffer.subarray(1, 1 + numTypes);
        this.rxBuffer = this.rxBuffer.subarray(1 + numTypes);

        if (types.includes(2)) {
          // Select VNC Authentication
          this.send(Buffer.from([0x02]));
          this.state = 'security_auth';
        } else if (types.includes(1)) {
          // Select None
          this.send(Buffer.from([0x01]));
          this.sendClientInit();
        } else {
          throw new Error(`Tipos de seguridad no soportados: ${Array.from(types).join(',')}`);
        }
      } else if (this.state === 'security_auth') {
        if (this.rxBuffer.length < 16) return;
        const challenge = this.rxBuffer.subarray(0, 16);
        this.rxBuffer = this.rxBuffer.subarray(16);

        const password = this.options.password || '';
        const response = encryptVncChallenge(challenge, password);
        this.send(response);
        this.state = 'security_result';
      } else if (this.state === 'security_result') {
        if (this.rxBuffer.length < 4) return;
        const result = this.rxBuffer.readUInt32BE(0);
        this.rxBuffer = this.rxBuffer.subarray(4);

        if (result !== 0) {
          throw new Error('Autenticación VNC fallida: contraseña incorrecta');
        }

        this.sendClientInit();
      } else if (this.state === 'server_init') {
        if (this.rxBuffer.length < 24) return;
        const nameLen = this.rxBuffer.readUInt32BE(20);
        if (this.rxBuffer.length < 24 + nameLen) return;

        this.width = this.rxBuffer.readUInt16BE(0);
        this.height = this.rxBuffer.readUInt16BE(2);

        this.pixelFormat = {
          bpp: this.rxBuffer.readUInt8(4),
          depth: this.rxBuffer.readUInt8(5),
          bigEndian: this.rxBuffer.readUInt8(6) !== 0,
          trueColor: this.rxBuffer.readUInt8(7) !== 0,
          redMax: this.rxBuffer.readUInt16BE(8),
          greenMax: this.rxBuffer.readUInt16BE(10),
          blueMax: this.rxBuffer.readUInt16BE(12),
          redShift: this.rxBuffer.readUInt8(14),
          greenShift: this.rxBuffer.readUInt8(15),
          blueShift: this.rxBuffer.readUInt8(16),
        };

        this.serverName = this.rxBuffer.subarray(24, 24 + nameLen).toString('utf-8');
        this.rxBuffer = this.rxBuffer.subarray(24 + nameLen);

        // Allocate memory for dynamic framebuffer (RGBA 32-bit)
        this.framebuffer = Buffer.alloc(this.width * this.height * 4, 0xff);

        safeLogger.info(`[RFB] ServerInit recibido: ${this.width}x${this.height}, Desktop: "${this.serverName}"`);

        // 1. Send SetPixelFormat (message-type 0) to ensure consistent 32-bit true-colour BGRA
        const pfMsg = Buffer.alloc(20);
        pfMsg.writeUInt8(0, 0); // message-type = 0
        // padding: bytes 1, 2, 3 = 0
        pfMsg.writeUInt8(32, 4);  // bits-per-pixel = 32
        pfMsg.writeUInt8(24, 5);  // depth = 24
        pfMsg.writeUInt8(0, 6);   // big-endian-flag = 0 (little-endian)
        pfMsg.writeUInt8(1, 7);   // true-colour-flag = 1
        pfMsg.writeUInt16BE(255, 8);  // red-max = 255
        pfMsg.writeUInt16BE(255, 10); // green-max = 255
        pfMsg.writeUInt16BE(255, 12); // blue-max = 255
        pfMsg.writeUInt8(16, 14); // red-shift = 16 (BGRA standard)
        pfMsg.writeUInt8(8, 15);  // green-shift = 8
        pfMsg.writeUInt8(0, 16);  // blue-shift = 0
        // padding: bytes 17, 18, 19 = 0
        this.send(pfMsg);

        // Update local pixelFormat to reflect SetPixelFormat
        this.pixelFormat = {
          bpp: 32,
          depth: 24,
          bigEndian: false,
          trueColor: true,
          redMax: 255,
          greenMax: 255,
          blueMax: 255,
          redShift: 16,
          greenShift: 8,
          blueShift: 0,
        };

        // 2. SetEncodings: Raw (0), CopyRect (1), DesktopSize (-223)
        const encMsg = Buffer.alloc(4 + 3 * 4);
        encMsg.writeUInt8(2, 0); // SetEncodings
        encMsg.writeUInt8(0, 1);
        encMsg.writeUInt16BE(3, 2); // 3 encodings
        encMsg.writeInt32BE(0, 4);     // Raw (0)
        encMsg.writeInt32BE(1, 8);     // CopyRect (1)
        encMsg.writeInt32BE(-223, 12); // DesktopSize (-223)
        this.send(encMsg);

        // 3. Request initial full frame
        this.requestFramebufferUpdate(false);
        this.state = 'active';
      } else if (this.state === 'active') {
        const handled = this.processServerMessage();
        if (!handled) break;
      }
    }
  }

  private sendClientInit(): void {
    // Shared flag = 1
    this.send(Buffer.from([0x01]));
    this.state = 'server_init';
  }

  private requestFramebufferUpdate(incremental: boolean): void {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const req = Buffer.alloc(10);
    req.writeUInt8(3, 0); // FramebufferUpdateRequest
    req.writeUInt8(incremental ? 1 : 0, 1);
    req.writeUInt16BE(0, 2); // x
    req.writeUInt16BE(0, 4); // y
    req.writeUInt16BE(this.width, 6); // width
    req.writeUInt16BE(this.height, 8); // height
    this.send(req);
  }

  private processServerMessage(): boolean {
    if (this.rxBuffer.length < 1) return false;
    const msgType = this.rxBuffer.readUInt8(0);

    if (msgType === 0) {
      // FramebufferUpdate
      if (this.rxBuffer.length < 4) return false;
      const numRects = this.rxBuffer.readUInt16BE(2);

      let offset = 4;
      for (let r = 0; r < numRects; r++) {
        if (this.rxBuffer.length < offset + 12) return false;

        const rx = this.rxBuffer.readUInt16BE(offset);
        const ry = this.rxBuffer.readUInt16BE(offset + 2);
        const rw = this.rxBuffer.readUInt16BE(offset + 4);
        const rh = this.rxBuffer.readUInt16BE(offset + 6);
        const encoding = this.rxBuffer.readInt32BE(offset + 8);
        offset += 12;

        if (encoding === 0) {
          // Raw Encoding
          const bytesPerPixel = (this.pixelFormat?.bpp || 32) / 8;
          const rectDataLen = rw * rh * bytesPerPixel;

          if (this.rxBuffer.length < offset + rectDataLen) {
            return false; // Wait for complete rectangle data
          }

          const rectData = this.rxBuffer.subarray(offset, offset + rectDataLen);
          offset += rectDataLen;

          this.renderRawRectangle(rx, ry, rw, rh, rectData);
        } else if (encoding === 1) {
          // CopyRect Encoding
          if (this.rxBuffer.length < offset + 4) {
            return false;
          }
          const srcX = this.rxBuffer.readUInt16BE(offset);
          const srcY = this.rxBuffer.readUInt16BE(offset + 2);
          offset += 4;
          this.renderCopyRect(srcX, srcY, rx, ry, rw, rh);
        } else if (encoding === -223) {
          // DesktopSize Pseudo-encoding
          this.width = rw;
          this.height = rh;
          this.framebuffer = Buffer.alloc(this.width * this.height * 4, 0xff);
          safeLogger.info(`[RFB] Resolución de pantalla redimensionada (DesktopSize): ${this.width}x${this.height}`);
        } else {
          // Unsupported encoding - fail with clear error per requirement
          const err = new Error(
            `Codificación RFB no soportada: ${encoding}. Solo se admiten Raw (0), CopyRect (1) y DesktopSize (-223).`
          );
          this.close(err.message);
          throw err;
        }
      }

      // Consume the entire parsed message
      this.rxBuffer = this.rxBuffer.subarray(offset);

      if (!this.hasReceivedFirstFrame) {
        this.hasReceivedFirstFrame = true;
        this.resolveInitialFrame();
      }

      // Request next incremental update
      this.requestFramebufferUpdate(true);
      return true;
    } else if (msgType === 2) {
      // Bell
      this.rxBuffer = this.rxBuffer.subarray(1);
      return true;
    } else if (msgType === 3) {
      // ServerCutText
      if (this.rxBuffer.length < 8) return false;
      const textLen = this.rxBuffer.readUInt32BE(4);
      if (this.rxBuffer.length < 8 + textLen) return false;
      this.rxBuffer = this.rxBuffer.subarray(8 + textLen);
      return true;
    }

    return false;
  }

  private renderRawRectangle(rx: number, ry: number, rw: number, rh: number, data: Buffer): void {
    const bpp = (this.pixelFormat?.bpp || 32) / 8;
    const isBgra = (this.pixelFormat?.redShift ?? 16) === 16; // Standard X11 Little-Endian BGRA

    for (let row = 0; row < rh; row++) {
      const targetY = ry + row;
      if (targetY >= this.height) break;

      for (let col = 0; col < rw; col++) {
        const targetX = rx + col;
        if (targetX >= this.width) break;

        const srcIdx = (row * rw + col) * bpp;
        const dstIdx = (targetY * this.width + targetX) * 4;

        if (isBgra) {
          this.framebuffer[dstIdx] = data[srcIdx + 2];     // Red
          this.framebuffer[dstIdx + 1] = data[srcIdx + 1]; // Green
          this.framebuffer[dstIdx + 2] = data[srcIdx];     // Blue
          this.framebuffer[dstIdx + 3] = 0xff;             // Alpha
        } else {
          this.framebuffer[dstIdx] = data[srcIdx];         // Red
          this.framebuffer[dstIdx + 1] = data[srcIdx + 1]; // Green
          this.framebuffer[dstIdx + 2] = data[srcIdx + 2]; // Blue
          this.framebuffer[dstIdx + 3] = 0xff;             // Alpha
        }
      }
    }
  }

  private renderCopyRect(srcX: number, srcY: number, dstX: number, dstY: number, w: number, h: number): void {
    const temp = Buffer.alloc(w * h * 4);
    for (let row = 0; row < h; row++) {
      const srcOffset = ((srcY + row) * this.width + srcX) * 4;
      this.framebuffer.copy(temp, row * w * 4, srcOffset, srcOffset + w * 4);
    }
    for (let row = 0; row < h; row++) {
      const dstOffset = ((dstY + row) * this.width + dstX) * 4;
      temp.copy(this.framebuffer, dstOffset, row * w * 4, (row + 1) * w * 4);
    }
  }

  /**
   * Exports the current framebuffer as a PNG Buffer.
   */
  public async captureScreenshotPng(): Promise<Buffer> {
    if (this.width === 0 || this.height === 0 || this.framebuffer.length === 0) {
      throw new Error('Framebuffer vacío o no inicializado');
    }

    const png = new PNG({ width: this.width, height: this.height });
    this.framebuffer.copy(png.data);
    return PNG.sync.write(png);
  }

  /**
   * Pointer event: mask, x, y
   */
  public sendPointer(buttonMask: number, x: number, y: number): void {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const buf = Buffer.alloc(6);
    buf.writeUInt8(5, 0); // PointerEvent
    buf.writeUInt8(buttonMask, 1);
    buf.writeUInt16BE(Math.max(0, Math.min(this.width - 1, Math.round(x))), 2);
    buf.writeUInt16BE(Math.max(0, Math.min(this.height - 1, Math.round(y))), 4);
    this.send(buf);
  }

  /**
   * Keyboard event: downFlag, keysym
   */
  public sendKey(down: boolean, keysym: number): void {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const buf = Buffer.alloc(8);
    buf.writeUInt8(4, 0); // KeyEvent
    buf.writeUInt8(down ? 1 : 0, 1);
    buf.writeUInt16BE(0, 2); // padding
    buf.writeUInt32BE(keysym, 4);
    this.send(buf);
  }

  /**
   * Executes a robust mouse click:
   * 1. Move to (x, y)
   * 2. Wait 20 ms
   * 3. MouseDown (buttonMask 1)
   * 4. Wait 120 ms (exceeds the 100 ms minimum ignored threshold)
   * 5. MouseUp (buttonMask 0)
   * 6. Wait 1000 ms settling time for app repaint
   */
  public async mouseClick(x: number, y: number): Promise<void> {
    this.sendPointer(0, x, y);
    await new Promise((r) => setTimeout(r, 20));
    this.sendPointer(1, x, y);
    await new Promise((r) => setTimeout(r, 120));
    this.sendPointer(0, x, y);
    await new Promise((r) => setTimeout(r, 1000));
  }

  /**
   * Executes a double click with proper button release and settling.
   */
  public async mouseDoubleClick(x: number, y: number): Promise<void> {
    await this.mouseClick(x, y);
    this.sendPointer(1, x, y);
    await new Promise((r) => setTimeout(r, 120));
    this.sendPointer(0, x, y);
    await new Promise((r) => setTimeout(r, 1000));
  }

  /**
   * Executes mouse scroll:
   * dy > 0: Scroll down (wheel down = button mask 16 / bit 4)
   * dy < 0: Scroll up (wheel up = button mask 8 / bit 3)
   */
  public async scroll(x: number, y: number, dy: number): Promise<void> {
    const mask = dy > 0 ? 16 : 8;
    const ticks = Math.min(5, Math.max(1, Math.abs(Math.round(dy))));

    for (let i = 0; i < ticks; i++) {
      this.sendPointer(mask, x, y);
      await new Promise((r) => setTimeout(r, 40));
      this.sendPointer(0, x, y);
      await new Promise((r) => setTimeout(r, 40));
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  /**
   * Sends a key combination (e.g. "ctrl+a", "backspace", "enter", "tab").
   */
  public async sendKeyCombo(combo: string): Promise<void> {
    const normalized = combo.toLowerCase().replace(/\s+/g, '');
    if (BLOCKED_COMBOS.has(normalized)) {
      throw new Error(`Atajo bloqueado por seguridad: ${combo}`);
    }
    const parsed = parseKeyCombo(combo);

    if (parsed.ctrl) this.sendKey(true, SPECIAL_KEYSYMS.Control_L);
    if (parsed.alt) this.sendKey(true, SPECIAL_KEYSYMS.Alt_L);
    if (parsed.shift) this.sendKey(true, SPECIAL_KEYSYMS.Shift_L);

    await new Promise((r) => setTimeout(r, 30));
    this.sendKey(true, parsed.keysym);
    await new Promise((r) => setTimeout(r, 40));
    this.sendKey(false, parsed.keysym);
    await new Promise((r) => setTimeout(r, 30));

    if (parsed.shift) this.sendKey(false, SPECIAL_KEYSYMS.Shift_L);
    if (parsed.alt) this.sendKey(false, SPECIAL_KEYSYMS.Alt_L);
    if (parsed.ctrl) this.sendKey(false, SPECIAL_KEYSYMS.Control_L);

    await new Promise((r) => setTimeout(r, 1000));
  }

  /**
   * Types text into a field.
   * If clearFirst is true, sends Ctrl+A and Backspace to prevent appending to preexisting text.
   */
  public async typeText(text: string, clearFirst = true): Promise<void> {
    if (clearFirst) {
      await this.sendKeyCombo('ctrl+a');
      await this.sendKeyCombo('backspace');
    }

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const stroke = charToKeyStroke(char);

      if (stroke.shift) {
        this.sendKey(true, SPECIAL_KEYSYMS.Shift_L);
        await new Promise((r) => setTimeout(r, 15));
      }

      this.sendKey(true, stroke.keysym);
      await new Promise((r) => setTimeout(r, 20));
      this.sendKey(false, stroke.keysym);

      if (stroke.shift) {
        await new Promise((r) => setTimeout(r, 15));
        this.sendKey(false, SPECIAL_KEYSYMS.Shift_L);
      }

      await new Promise((r) => setTimeout(r, 25));
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  private send(data: Buffer): void {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(data);
  }

  /**
   * Disconnects the socket cleanly and frees memory.
   */
  public close(reason = 'Client closed'): void {
    if (this.closed) return;
    this.closed = true;
    this.state = 'closed';

    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.close(1000, reason);
        } else {
          this.ws.terminate();
        }
      } catch {
        // ignore
      }
    }

    this.framebuffer = Buffer.alloc(0);
    this.rxBuffer = Buffer.alloc(0);
  }
}
