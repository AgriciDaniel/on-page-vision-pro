import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import {
  assertPublicUrl,
  fetchCapped,
  FetchCappedError,
  isPublicAddress,
  normalizeUrl,
} from '../../server/safeFetch.ts';
import { HttpError } from '../../server/http.ts';

// ---- address policy ---------------------------------------------------------------------

test('isPublicAddress rejects every non-public range the review probe let through', () => {
  const blocked = [
    '169.254.169.254', '172.17.0.1', '172.31.255.255', '127.0.0.2', '127.0.0.1', '10.1.2.3',
    '192.168.1.1', '100.100.100.200', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254',
    'fe80::1', 'fd00::1', 'fc00::1', 'ff02::1', '64:ff9b::7f00:1', '2002:7f00:1::',
    '[::1]', 'not-an-ip',
  ];
  for (const ip of blocked) assert.equal(isPublicAddress(ip), false, ip);
});

test('isPublicAddress accepts ordinary public addresses', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808']) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
});

test('normalizeUrl blocks private hosts by name and literal, and keeps public ones', () => {
  const rejects = [
    'http://169.254.169.254/latest/meta-data/', 'http://172.17.0.1/', 'http://127.0.0.2/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://2130706433/', 'http://0x7f.1/',
    'http://localhost./', 'http://foo.localhost/', 'http://printer.local/', 'http://intranet/',
    'http://100.100.100.200/', 'ftp://example.com/', 'http://user:pass@example.com/', '',
  ];
  for (const u of rejects) assert.throws(() => normalizeUrl(u), HttpError, u);
  assert.equal(normalizeUrl('agricidaniel.com'), 'https://agricidaniel.com/');
  assert.equal(normalizeUrl('  https://example.com:8443/a?b=1 '), 'https://example.com:8443/a?b=1');
});

const fakeLookup = (table: Record<string, string>) =>
  ((hostname: string, options: any, cb: any) => {
    const callback = typeof options === 'function' ? options : cb;
    const address = table[hostname];
    if (!address) return callback(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    const family = address.includes(':') ? 6 : 4;
    if (options?.all) return callback(null, [{ address, family }]);
    return callback(null, address, family);
  }) as any;

test('assertPublicUrl rejects a public-looking name that resolves to a private address', async () => {
  const lookup = fakeLookup({ 'rebind.example.com': '127.0.0.1', 'ok.example.com': '93.184.216.34' });
  await assert.rejects(assertPublicUrl('https://rebind.example.com/', lookup), HttpError);
  await assert.rejects(assertPublicUrl('https://missing.example.com/', lookup), HttpError);
  assert.equal(await assertPublicUrl('ok.example.com', lookup), 'https://ok.example.com/');
});

// ---- capped fetch against loopback servers ---------------------------------------------------

async function withServer(
  handler: http.RequestListener,
  run: (base: string, port: number) => Promise<void>
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, port);
  } finally {
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
  }
}

const loopbackOnly = (ip: string) => ip === '127.0.0.1';

test('fetchCapped refuses loopback by default (no address policy override)', async () => {
  await withServer((_req, res) => res.end('hi'), async (base) => {
    await assert.rejects(fetchCapped(base, { timeoutMs: 2000, maxBytes: 1000 }), (e: any) => e instanceof FetchCappedError && e.code === 'blocked');
  });
});

test('fetchCapped times out while the body is still streaming (S5 regression)', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write('<html>'); // never ends
    },
    async (base) => {
      const started = Date.now();
      await assert.rejects(
        fetchCapped(base, { timeoutMs: 400, maxBytes: 1_000_000, isAllowedAddress: loopbackOnly }),
        (e: any) => e instanceof FetchCappedError && e.code === 'timeout'
      );
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 1500, `took ${elapsed} ms`);
    }
  );
});

test('fetchCapped stops at the byte cap, with and without content-length', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/declared') {
        res.writeHead(200, { 'content-length': '5000' });
        res.end(Buffer.alloc(5000));
      } else {
        res.writeHead(200);
        res.write(Buffer.alloc(3000));
        res.end(Buffer.alloc(3000));
      }
    },
    async (base) => {
      for (const path of ['/declared', '/chunked']) {
        await assert.rejects(
          fetchCapped(base + path, { timeoutMs: 2000, maxBytes: 4000, isAllowedAddress: loopbackOnly }),
          (e: any) => e instanceof FetchCappedError && e.code === 'too_large',
          path
        );
      }
    }
  );
});

test('fetchCapped caps the decoded size of a gzip body (zip bomb) and decodes normal gzip', async () => {
  const bomb = zlib.gzipSync(Buffer.alloc(2_000_000));
  const small = zlib.gzipSync(Buffer.from('<title>Hello</title>'));
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/html; charset=utf-8' });
      res.end(req.url === '/bomb' ? bomb : small);
    },
    async (base) => {
      await assert.rejects(
        fetchCapped(base + '/bomb', { timeoutMs: 2000, maxBytes: 100_000, isAllowedAddress: loopbackOnly }),
        (e: any) => e.code === 'too_large'
      );
      const ok = await fetchCapped(base + '/small', { timeoutMs: 2000, maxBytes: 100_000, isAllowedAddress: loopbackOnly });
      assert.equal(ok.body.toString(), '<title>Hello</title>');
      assert.equal(ok.contentType, 'text/html');
    }
  );
});

test('fetchCapped follows redirects but re-checks every hop', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/hop') {
        res.writeHead(302, { location: '/final' });
        res.end();
      } else if (req.url === '/to-metadata') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
      } else if (req.url === '/loop') {
        res.writeHead(302, { location: '/loop' });
        res.end();
      } else {
        res.end('final');
      }
    },
    async (base) => {
      const opts = { timeoutMs: 2000, maxBytes: 1000, isAllowedAddress: loopbackOnly };
      const ok = await fetchCapped(base + '/hop', opts);
      assert.equal(ok.body.toString(), 'final');
      assert.equal(ok.url, base + '/final');
      await assert.rejects(fetchCapped(base + '/to-metadata', opts), (e: any) => e.code === 'blocked');
      await assert.rejects(fetchCapped(base + '/loop', opts), (e: any) => e.code === 'redirects');
    }
  );
});

test('fetchCapped checks the DNS answer at connect time (rebinding)', async () => {
  await withServer((_req, res) => res.end('secret'), async (_base, port) => {
    const lookup = fakeLookup({ 'public-name.example.com': '127.0.0.1' });
    await assert.rejects(
      fetchCapped(`http://public-name.example.com:${port}/`, { timeoutMs: 2000, maxBytes: 1000, lookup }),
      (e: any) => e.code === 'blocked'
    );
    // Same name with a policy that allows loopback connects, proving the lookup is the one used.
    const ok = await fetchCapped(`http://public-name.example.com:${port}/`, { timeoutMs: 2000, maxBytes: 1000, lookup, isAllowedAddress: loopbackOnly });
    assert.equal(ok.body.toString(), 'secret');
  });
});
