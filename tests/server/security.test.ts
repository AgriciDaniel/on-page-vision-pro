// Fixes for the neon-2 security review (.agent/results/neon-2-security.md), SEC-1 to SEC-5.
// Each test failed before its fix. Everything here is local: loopback servers only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { fetchCapped, isPublicAddress, normalizeUrl } from '../../server/safeFetch.ts';
import { startEgressProxy } from '../../server/egressProxy.ts';
import { IMAGE_LIMITS, parseImageDataUrl } from '../../server/image.ts';
import { CaptureError, MAX_CAPTURE_IMAGE_HEIGHT_PX, MAX_CAPTURE_QUEUE, acquireCaptureSlot, closeBrowser, openGuardedContext } from '../../server/pageCapture.ts';
import { captureShot } from '../../server/capture.ts';

after(() => closeBrowser());

// ---- SEC-1: IPv6 is default-deny outside 2000::/3 and the special ranges inside it ------------

test('SEC-1: special-purpose and non-global IPv6 addresses are not public', () => {
  const blocked = [
    '64:ff9b:1::127.0.0.1', '64:ff9b:1::a9fe:a9fe', '64:ff9b:1::5db8:d822', // RFC 8215 local-use NAT64, even with a public v4
    '::ffff:0:127.0.0.1', '::ffff:0:5db8:d822', // RFC 2765 IPv4-translated
    '100::1', // discard-only
    '2001::1', '2001:2::1', '2001:3::1', '2001:10::1', '2001:20::1', '2001:1ff::1', // 2001::/23 IETF protocol assignments
    '2001:db8::1', '3fff::1', '5f00::1', // documentation (x2), SRv6 SIDs
    '4000::1', '8000::1', 'e000::1', '1::1', // outside 2000::/3
    '::', '::1', '::127.0.0.1', '::ffff:127.0.0.1', '64:ff9b::127.0.0.1', '2002:7f00:1::1', 'fe80::1', 'fc00::1', 'ff02::1',
  ];
  for (const ip of blocked) assert.equal(isPublicAddress(ip), false, ip);
});

test('SEC-1: global IPv6, and embedded public IPv4 forms, stay public', () => {
  const allowed = ['2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '2001:200::1', '::ffff:93.184.216.34', '64:ff9b::5db8:d822', '2002:5db8:d822::1'];
  for (const ip of allowed) assert.equal(isPublicAddress(ip), true, ip);
});

test('SEC-1: normalizeUrl refuses the reviewer URLs', () => {
  for (const u of ['http://[64:ff9b:1::127.0.0.1]/', 'http://[::ffff:0:127.0.0.1]/', 'http://[100::1]/', 'http://[2001::1]/']) {
    assert.throws(() => normalizeUrl(u), (e: any) => e.status === 400, u);
  }
});

// ---- SEC-2: wire bytes capped, decompressor destroyed ----------------------------------------

async function localServer(handler: http.RequestListener): Promise<{ base: string; close: () => Promise<void> }> {
  const srv = http.createServer(handler);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { base, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}
const loopbackOk = () => true;

test('SEC-2: 8 MB of empty gzip members is refused under a 64 kB cap', async () => {
  const member = zlib.gzipSync(Buffer.alloc(0));
  const chunk = Buffer.concat(Array(1000).fill(member));
  const s = await localServer((_req, res) => {
    res.writeHead(200, { 'content-encoding': 'gzip' });
    let sent = 0;
    const more = () => {
      while (sent < 8 * 1024 * 1024 && !res.destroyed) {
        sent += chunk.length;
        if (!res.write(chunk)) return void res.once('drain', more);
      }
      if (!res.destroyed) res.end();
    };
    more();
  });
  try {
    await assert.rejects(fetchCapped(`${s.base}/`, { timeoutMs: 5000, maxBytes: 64 * 1024, isAllowedAddress: loopbackOk }), (e: any) => e.code === 'too_large');
  } finally {
    await s.close();
  }
});

test('SEC-2: a declared Content-Length over the cap is refused even when the body is compressed', async () => {
  const s = await localServer((_req, res) => {
    res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': String(10 * 1024 * 1024) });
    res.write(zlib.gzipSync(Buffer.from('x')));
  });
  try {
    await assert.rejects(fetchCapped(`${s.base}/`, { timeoutMs: 2000, maxBytes: 64 * 1024, isAllowedAddress: loopbackOk }), (e: any) => e.code === 'too_large');
  } finally {
    await s.close();
  }
});

test('SEC-2: the decompressor is destroyed when the cap is hit and when the body ends', async () => {
  const created: zlib.BrotliDecompress[] = [];
  const original = zlib.createBrotliDecompress;
  const patch = (fn: unknown) => Object.defineProperty(zlib, 'createBrotliDecompress', { value: fn, configurable: true, writable: true });
  patch((...args: any[]) => {
    const d = original.apply(zlib, args as any);
    created.push(d);
    return d;
  });
  const bomb = zlib.brotliCompressSync(Buffer.alloc(50 * 1024 * 1024));
  const small = zlib.brotliCompressSync(Buffer.from('hello'));
  const s = await localServer((req, res) => {
    res.writeHead(200, { 'content-encoding': 'br' });
    res.end(req.url === '/bomb' ? bomb : small);
  });
  try {
    await assert.rejects(fetchCapped(`${s.base}/bomb`, { timeoutMs: 5000, maxBytes: 1024 * 1024, isAllowedAddress: loopbackOk }), (e: any) => e.code === 'too_large');
    assert.equal(created.length, 1);
    assert.equal(created[0].destroyed, true, 'decompressor destroyed after the cap');
    const ok = await fetchCapped(`${s.base}/small`, { timeoutMs: 5000, maxBytes: 1024, isAllowedAddress: loopbackOk });
    assert.equal(ok.body.toString(), 'hello');
    assert.equal(created[1].destroyed, true, 'decompressor destroyed after a normal body');
  } finally {
    patch(original);
    await s.close();
  }
});

// ---- SEC-3: no downloads, popups closed ------------------------------------------------------

test('SEC-3: a capture context saves no download and closes popups', async () => {
  const { context } = await openGuardedContext({}, 'sec3-test', Date.now() + 20_000);
  try {
    const page = await context.newPage();
    const downloads: (string | null)[] = [];
    page.on('download', async (d) => downloads.push(await d.path().catch(() => null)));
    await page.setContent('<a id="dl" download="probe.bin" href="data:application/octet-stream;base64,QUFBQUFB">dl</a>');
    await page.click('#dl');
    await page.evaluate(`window.open('about:blank', '_blank'); window.open('about:blank', '_blank');`);
    await page.waitForTimeout(800);
    assert.deepEqual(downloads.filter((p) => p !== null), [], 'no file was saved');
    assert.equal(context.pages().length, 1, 'only the capture page is open');
    assert.equal(context.pages()[0], page);
  } finally {
    await context.close();
  }
});

// ---- SEC-4: image width and pixels checked before any decode ---------------------------------

function fakePng(width: number, height: number): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const type = Buffer.from('IHDR');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(13, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([type, ihdr])) >>> 0, 0);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return `data:image/png;base64,${Buffer.concat([sig, len, type, ihdr, crc]).toString('base64')}`;
}

test('SEC-4: one set of image limits, consistent with the capture sizes', () => {
  assert.equal(IMAGE_LIMITS.maxHeightPx, 30_000);
  assert.equal(MAX_CAPTURE_IMAGE_HEIGHT_PX, IMAGE_LIMITS.maxHeightPx);
  assert.equal(IMAGE_LIMITS.maxWidthPx, 2 * 1440);
  assert.equal(IMAGE_LIMITS.maxPixels, 1440 * 30_000);
});

test('SEC-4: pixel bombs are refused by the header check; real capture sizes pass', () => {
  const refused: [number, number][] = [[50_000, 30_000], [16_000, 16_000], [2881, 1000], [1440, 30_001], [2880, 15_001]];
  for (const [w, h] of refused) assert.throws(() => parseImageDataUrl(fakePng(w, h), 'img'), (e: any) => e.status === 400, `${w}x${h}`);
  const ok: [number, number][] = [[1440, 30_000], [780, 30_000], [1440, 900], [2880, 15_000], [390, 844]];
  for (const [w, h] of ok) assert.equal(parseImageDataUrl(fakePng(w, h), 'img').width, w);
});

// ---- SEC-5: CONNECT ports, tunnel lifetime and bytes; bounded capture queue ------------------

function connect(proxyPort: number, target: string): Promise<{ status: string; socket: net.Socket; received: () => number; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let head = '';
    let body = 0;
    let gotHead = false;
    const t0 = Date.now();
    const closed = new Promise<number>((r) => socket.on('close', () => r(Date.now() - t0)));
    socket.on('data', (d) => {
      if (gotHead) return void (body += d.length);
      head += d.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end !== -1) {
        gotHead = true;
        body += Buffer.byteLength(head.slice(end + 4), 'latin1');
        resolve({ status: head.split('\r\n')[0], socket, received: () => body, closed });
      }
    });
    socket.on('error', reject);
    socket.on('end', () => !gotHead && resolve({ status: head.split('\r\n')[0] || 'EOF', socket, received: () => body, closed }));
  });
}

test('SEC-5: CONNECT goes only to the allowed ports (443 and 80 by default)', async () => {
  const target = net.createServer((s) => s.end());
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  const port = (target.address() as AddressInfo).port;
  const loose = await startEgressProxy({ isAllowedAddress: loopbackOk, allowedPorts: [port] });
  const strict = await startEgressProxy({ isAllowedAddress: loopbackOk });
  const policy = await startEgressProxy();
  try {
    assert.match((await connect(Number(new URL(loose.url).port), `127.0.0.1:${port}`)).status, /200/);
    for (const p of [22, 25, 6379, port]) {
      assert.match((await connect(Number(new URL(strict.url).port), `127.0.0.1:${p}`)).status, /403/, `port ${p}`);
    }
    // With the default address policy, the reviewer's NAT64 and IPv4-translated targets are refused, not attempted.
    const dp = Number(new URL(policy.url).port);
    assert.match((await connect(dp, '[64:ff9b:1::127.0.0.1]:443')).status, /403/);
    assert.match((await connect(dp, '[::ffff:0:127.0.0.1]:443')).status, /403/);
    assert.match((await connect(dp, 'printer.home.arpa:443')).status, /403/);
  } finally {
    await loose.close();
    await strict.close();
    await policy.close();
    target.close();
  }
});

test('SEC-5: a tunnel is closed at its lifetime and at its byte cap', async () => {
  const quiet = net.createServer(() => {}); // accepts and stays open
  const chatty = net.createServer((s) => s.write(Buffer.alloc(64 * 1024, 1)));
  await new Promise<void>((r) => quiet.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => chatty.listen(0, '127.0.0.1', r));
  const qp = (quiet.address() as AddressInfo).port;
  const cp = (chatty.address() as AddressInfo).port;
  const proxy = await startEgressProxy({ isAllowedAddress: loopbackOk, allowedPorts: [qp, cp], maxTunnelMs: 300, maxTunnelBytes: 4096 });
  const pp = Number(new URL(proxy.url).port);
  try {
    const slow = await connect(pp, `127.0.0.1:${qp}`);
    assert.match(slow.status, /200/);
    const lifetime = await slow.closed;
    assert.ok(lifetime < 1500, `closed after ${lifetime} ms`);

    const big = await connect(pp, `127.0.0.1:${cp}`);
    await big.closed;
    assert.ok(big.received() <= 4096 + 16 * 1024, `received ${big.received()} bytes`); // one socket read may overshoot
    assert.ok(big.received() < 64 * 1024, 'stopped before the full 64 kB');
  } finally {
    await proxy.close();
    quiet.close();
    chatty.close();
  }
});

test('SEC-5: the capture queue is bounded; a full queue answers busy at once', async () => {
  const far = Date.now() + 30_000;
  const held = [await acquireCaptureSlot(far), await acquireCaptureSlot(far)]; // both slots
  const queued = Array.from({ length: MAX_CAPTURE_QUEUE }, () => acquireCaptureSlot(far).then((release) => release()));
  const t0 = Date.now();
  await assert.rejects(acquireCaptureSlot(far), (e: any) => e instanceof CaptureError && e.reason === 'busy');
  assert.ok(Date.now() - t0 < 200, 'refused at once, not after the deadline');
  for (const r of held) r();
  await Promise.all(queued); // each waiter gets a slot in turn and frees it
});

test('SEC-5: a busy capture is a 429 with a clear message, with no fallback screenshot', async () => {
  let fallbackCalls = 0;
  const warnings: string[] = [];
  await assert.rejects(
    captureShot('https://example.com/', 'desktop', 'fullpage', warnings, {
      browser: async () => {
        throw new CaptureError('busy', 'The capture browser is busy.');
      },
      fallback: async () => {
        fallbackCalls++;
        return null;
      },
    }),
    (e: any) => e.status === 429 && /busy/i.test(e.message) && /retry/i.test(e.message)
  );
  assert.equal(fallbackCalls, 0);
});

// ---- SEC-5 follow-ups from the wave 3 re-probe (.agent/results/neon-2-wave3.md) ---------------

test('SEC-5: the proxy caps tunnels open at once; extra CONNECTs are refused with 503, and a closed tunnel frees its place', async () => {
  const quiet = net.createServer(() => {}); // accepts and stays open
  await new Promise<void>((r) => quiet.listen(0, '127.0.0.1', r));
  const qp = (quiet.address() as AddressInfo).port;
  const proxy = await startEgressProxy({ isAllowedAddress: loopbackOk, allowedPorts: [qp], maxOpenTunnels: 2 });
  const pp = Number(new URL(proxy.url).port);
  try {
    const a = await connect(pp, `127.0.0.1:${qp}`);
    const b = await connect(pp, `127.0.0.1:${qp}`);
    assert.match(a.status, /200/);
    assert.match(b.status, /200/);
    const before = proxy.refused();
    assert.match((await connect(pp, `127.0.0.1:${qp}`)).status, /503/);
    assert.equal(proxy.refused(), before + 1);
    // Closing a tunnel frees its place; a refused target (403) does not keep the place it used.
    a.socket.destroy();
    await a.closed;
    await new Promise((r) => setTimeout(r, 50));
    assert.match((await connect(pp, '127.0.0.1:22')).status, /403/);
    assert.match((await connect(pp, '127.0.0.1:22')).status, /403/);
    const c = await connect(pp, `127.0.0.1:${qp}`);
    assert.match(c.status, /200/);
    assert.match((await connect(pp, `127.0.0.1:${qp}`)).status, /503/, 'b and c are open: full again');
  } finally {
    await proxy.close();
    quiet.close();
  }
});

test('SEC-5: a redirect to a Location that is not a valid URL is FetchCappedError blocked, not a raw TypeError', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(302, { location: 'http://[fe80::1%25eth0]/' });
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await assert.rejects(fetchCapped(`${base}/`, { timeoutMs: 3000, maxBytes: 1024, isAllowedAddress: loopbackOk }), (e: any) => {
      assert.equal(e.name, 'FetchCappedError');
      assert.equal(e.code, 'blocked');
      assert.match(e.message, /not a valid URL/);
      return true;
    });
  } finally {
    server.close();
  }
});
