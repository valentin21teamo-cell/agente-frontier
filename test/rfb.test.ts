import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { RfbClient } from '../src/rfb/client.js';
import { encryptVncChallenge } from '../src/rfb/des.js';
import { PNG } from 'pngjs';

function startMockRfbServer(expectedPassword = 'vncpass1', opts: { cursor?: boolean } = {}): Promise<{
  server: http.Server;
  wsUrl: string;
  receivedPointerEvents: Array<{ mask: number; x: number; y: number }>;
  receivedKeyEvents: Array<{ down: boolean; keysym: number }>;
  receivedEncodings: number[];
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    const receivedPointerEvents: Array<{ mask: number; x: number; y: number }> = [];
    const receivedKeyEvents: Array<{ down: boolean; keysym: number }> = [];
    const receivedEncodings: number[] = [];

    wss.on('connection', (ws: WebSocket) => {
      // 1. Send Version
      ws.send(Buffer.from('RFB 003.008\n', 'ascii'));

      let stage = 0;
      let challenge = Buffer.alloc(16, 0x42);

      ws.on('message', (data: Buffer) => {
        const msg = Buffer.from(data);

        if (stage === 0) {
          // Received Client Version
          assert.equal(msg.toString('ascii'), 'RFB 003.008\n');
          // Send Security types: 1 type, Type 2 (VNC Auth)
          ws.send(Buffer.from([0x01, 0x02]));
          stage = 1;
        } else if (stage === 1) {
          // Received selected security type
          assert.equal(msg[0], 0x02);
          // Send 16-byte challenge
          ws.send(challenge);
          stage = 2;
        } else if (stage === 2) {
          // Received 16-byte response
          const expectedResp = encryptVncChallenge(challenge, expectedPassword);
          const isCorrect = msg.equals(expectedResp);

          if (!isCorrect) {
            // Fail
            const failBuf = Buffer.alloc(4 + 4 + 22);
            failBuf.writeUInt32BE(1, 0); // Result = 1
            failBuf.writeUInt32BE(22, 4);
            failBuf.write('password check failed!', 8, 'utf-8');
            ws.send(failBuf);
            ws.close();
            return;
          }

          // Success
          const okBuf = Buffer.alloc(4);
          okBuf.writeUInt32BE(0, 0); // Result = 0 (OK)
          ws.send(okBuf);
          stage = 3;
        } else if (stage === 3) {
          // Received ClientInit (shared-flag = 1)
          assert.equal(msg[0], 0x01);

          // Send ServerInit: dynamic resolution 640x480
          const width = 640;
          const height = 480;
          const name = 'Mock-Desktop';
          const nameBuf = Buffer.from(name, 'utf-8');

          const serverInit = Buffer.alloc(24 + nameBuf.length);
          serverInit.writeUInt16BE(width, 0);
          serverInit.writeUInt16BE(height, 2);
          serverInit.writeUInt8(32, 4); // bpp = 32
          serverInit.writeUInt8(24, 5); // depth = 24
          serverInit.writeUInt8(0, 6);  // littleEndian = 0
          serverInit.writeUInt8(1, 7);  // trueColour = 1
          serverInit.writeUInt16BE(255, 8); // redMax
          serverInit.writeUInt16BE(255, 10); // greenMax
          serverInit.writeUInt16BE(255, 12); // blueMax
          serverInit.writeUInt8(16, 14); // redShift (BGRA standard)
          serverInit.writeUInt8(8, 15);  // greenShift
          serverInit.writeUInt8(0, 16);  // blueShift
          serverInit.writeUInt32BE(nameBuf.length, 20);
          nameBuf.copy(serverInit, 24);

          ws.send(serverInit);
          stage = 4;
        } else if (stage === 4) {
          const msgType = msg.readUInt8(0);

          if (msgType === 2) {
            // SetEncodings
            const n = msg.readUInt16BE(2);
            for (let i = 0; i < n; i++) receivedEncodings.push(msg.readInt32BE(4 + i * 4));
          } else if (msgType === 3) {
            // FramebufferUpdateRequest
            const incremental = msg.readUInt8(1);
            if (incremental === 0) {
              // Send a FramebufferUpdate with a Raw rectangle (width: 640, height: 480)
              const rw = 640;
              const rh = 480;
              const rectPixels = Buffer.alloc(rw * rh * 4, 0x80); // gray pixels
              for (let i = 0; i < 100 * 4; i += 4) {
                rectPixels[i] = 255;   // Blue in BGRA
                rectPixels[i + 1] = 0; // Green
                rectPixels[i + 2] = 0; // Red
                rectPixels[i + 3] = 255;
              }

              // Con opts.cursor y si el cliente lo pidió: primero la forma del puntero (Cursor, -239), como x11vnc.
              const cursor = opts.cursor && receivedEncodings.includes(-239);
              const header = Buffer.alloc(4);
              header.writeUInt8(0, 0); // FramebufferUpdate
              header.writeUInt8(0, 1);
              header.writeUInt16BE(cursor ? 2 : 1, 2); // rectangles

              const parts: Buffer[] = [header];
              if (cursor) {
                const cw = 12;
                const ch = 19;
                const cur = Buffer.alloc(12);
                cur.writeUInt16BE(1, 0); // hotspot x
                cur.writeUInt16BE(1, 2); // hotspot y
                cur.writeUInt16BE(cw, 4);
                cur.writeUInt16BE(ch, 6);
                cur.writeInt32BE(-239, 8);
                parts.push(cur, Buffer.alloc(cw * ch * 4, 0xff), Buffer.alloc(Math.floor((cw + 7) / 8) * ch, 0xff));
              }
              const raw = Buffer.alloc(12);
              raw.writeUInt16BE(0, 0);  // x
              raw.writeUInt16BE(0, 2);  // y
              raw.writeUInt16BE(rw, 4); // width
              raw.writeUInt16BE(rh, 6); // height
              raw.writeInt32BE(0, 8);   // Raw encoding
              parts.push(raw, rectPixels);
              ws.send(Buffer.concat(parts));
            }
          } else if (msgType === 5) {
            // PointerEvent
            const mask = msg.readUInt8(1);
            const x = msg.readUInt16BE(2);
            const y = msg.readUInt16BE(4);
            receivedPointerEvents.push({ mask, x, y });
          } else if (msgType === 4) {
            // KeyEvent
            const down = msg.readUInt8(1) === 1;
            const keysym = msg.readUInt32BE(4);
            receivedKeyEvents.push({ down, keysym });
          }
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        server,
        wsUrl: `ws://127.0.0.1:${addr.port}`,
        receivedPointerEvents,
        receivedKeyEvents,
        receivedEncodings,
        close: () =>
          new Promise((res) => {
            for (const c of wss.clients) {
              c.terminate();
            }
            if (typeof (server as any).closeAllConnections === 'function') {
              (server as any).closeAllConnections();
            }
            wss.close(() => {
              server.close(() => res());
            });
          }),
      });
    });
  });
}

test('RfbClient - Full Handshake, Dynamic Resolution, Framebuffer Rendering, and PNG Export', async () => {
  const mock = await startMockRfbServer('vncpass1');
  const client = new RfbClient({
    url: mock.wsUrl,
    password: 'vncpass1',
  });

  try {
    const initInfo = await client.connect();
    // 1. Check dynamic resolution read from ServerInit (NOT hardcoded)
    assert.equal(initInfo.width, 640);
    assert.equal(initInfo.height, 480);
    assert.equal(initInfo.serverName, 'Mock-Desktop');

    // 2. Wait for first frame
    await client.waitForFirstFrame(3000);

    // 3. Capture PNG screenshot
    const png = await client.captureScreenshotPng();
    assert.ok(Buffer.isBuffer(png));
    assert.ok(png.length > 100);

    // PNG signature: 0x89, 0x50, 0x4E, 0x47 (PNG)
    assert.equal(png[0], 0x89);
    assert.equal(png[1], 0x50);
    assert.equal(png[2], 0x4e);
    assert.equal(png[3], 0x47);

    // 4. Test Mouse Click: verifies down (120ms) and up events sent to server
    await client.mouseClick(150, 200);
    const clicks = mock.receivedPointerEvents.filter((p) => p.x === 150 && p.y === 200);
    assert.ok(clicks.length >= 2, 'Debió registrar PointerEvents de movimiento, bajada y subida');
    assert.ok(clicks.some((p) => p.mask === 1), 'Debió registrar mask=1 (mousedown)');
    assert.ok(clicks.some((p) => p.mask === 0), 'Debió registrar mask=0 (mouseup)');

    // 5. Test Key Typing: types "Calle 80 # 24-15"
    await client.typeText('Calle 80 # 24-15', false);
    assert.ok(mock.receivedKeyEvents.length >= 10, 'Debió registrar eventos de teclado');

    // Check hash key event (0x0023)
    const hashKey = mock.receivedKeyEvents.find((k) => k.keysym === 0x0023);
    assert.ok(hashKey, 'Debió registrar keysym del caracter #');
  } finally {
    client.close();
    await mock.close();
  }
});

test('RfbClient - Rejects with Authentication Failure on incorrect password', async () => {
  const mock = await startMockRfbServer('correctPassword');
  const client = new RfbClient({
    url: mock.wsUrl,
    password: 'wrongPassword',
  });

  try {
    await assert.rejects(
      async () => {
        await client.connect();
      },
      /Autenticación VNC fallida/
    );
  } finally {
    client.close();
    await mock.close();
  }
});

test('RfbClient - pide la forma del puntero (Cursor -239) y la descarta: la captura queda sin puntero e intacta', async () => {
  const mock = await startMockRfbServer('vncpass1', { cursor: true });
  const client = new RfbClient({ url: mock.wsUrl, password: 'vncpass1' });
  try {
    await client.connect();
    await client.waitForFirstFrame(3000);
    assert.ok(mock.receivedEncodings.includes(-239), 'El cliente debe anunciar la pseudo-codificación Cursor');
    const png = PNG.sync.read(await client.captureScreenshotPng());
    assert.equal(png.width, 640);
    // Los primeros 100 píxeles del rectángulo Raw son azules: si el rectángulo del puntero se leyera mal,
    // el Raw quedaría corrido o la conexión se cerraría por "codificación no soportada".
    assert.deepEqual([...png.data.subarray(0, 3)], [0, 0, 255]);
    assert.deepEqual([...png.data.subarray(100 * 4, 100 * 4 + 3)], [128, 128, 128]);
  } finally {
    client.close();
    await mock.close();
  }
});
