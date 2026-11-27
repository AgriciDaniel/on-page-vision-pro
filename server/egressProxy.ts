// Backstop for the capture browser. Playwright's route handler sees most requests, but some
// leave Chromium without passing through it: <link rel=prefetch>, speculation-rules prefetch
// and prerender, <a ping> and navigator.sendBeacon (all measured in tests/server/pageCapture.test.ts).
// The browser is therefore launched with this proxy and with the implicit loopback bypass
// removed, so every byte that escapes routing still meets the public-address policy:
// - plain HTTP proxy requests: GET and HEAD only, fetched with fetchCapped (DNS checked,
//   redirects re-checked, size capped); everything else is refused.
// - CONNECT tunnels (HTTPS, WSS): the host is resolved here, every address must be public, and
//   the tunnel is opened to the checked IP, so a second DNS answer cannot swap in a private one.
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns';
import type { AddressInfo } from 'node:net';
import { fetchCapped, isBlockedHostname, isPublicAddress } from './safeFetch.ts';

export interface EgressProxy {
  url: string;
  refused: () => number;
  close: () => Promise<void>;
}

/** Tunnel limits. A capture lasts at most 60 s, and one response through routing at most 8 MB. */
export const TUNNEL_LIMITS = {
  /** CONNECT goes only to the web ports. */
  ports: [443, 80] as readonly number[],
  /** A tunnel is closed this long after it opens, busy or not. */
  maxMs: 60_000,
  /** A tunnel is closed after this many bytes in both directions together. */
  maxBytes: 16 * 1024 * 1024,
  /** Closed after this long with no traffic. */
  idleMs: 30_000,
  /**
   * Tunnels open at once through one proxy; more are refused with 503. Chromium opens about 6
   * connections per host and a page uses a handful of hosts, so 64 covers a real capture.
   */
  maxOpen: 64,
};

export interface EgressProxyOptions {
  /** Address policy; tests loosen it to reach loopback servers. Defaults to public-only. */
  isAllowedAddress?: (ip: string) => boolean;
  allowedPorts?: readonly number[];
  maxTunnelMs?: number;
  maxTunnelBytes?: number;
  maxOpenTunnels?: number;
}

async function resolveAllowed(host: string, allowed: (ip: string) => boolean): Promise<string | null> {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (net.isIP(bare)) return allowed(bare) ? bare : null;
  if (isBlockedHostname(bare)) return null; // same name rules as fetchCapped (.local, .internal, .home.arpa, .lan, single labels)
  try {
    const list = await dns.promises.lookup(bare, { all: true });
    if (!list.length || list.some((a) => !allowed(a.address))) return null;
    return list[0].address;
  } catch {
    return null;
  }
}

export async function startEgressProxy(options: EgressProxyOptions = {}): Promise<EgressProxy> {
  const allowed = options.isAllowedAddress ?? isPublicAddress;
  const ports = options.allowedPorts ?? TUNNEL_LIMITS.ports;
  const maxMs = options.maxTunnelMs ?? TUNNEL_LIMITS.maxMs;
  const maxBytes = options.maxTunnelBytes ?? TUNNEL_LIMITS.maxBytes;
  const maxOpen = options.maxOpenTunnels ?? TUNNEL_LIMITS.maxOpen;
  let openTunnels = 0;
  let refused = 0;
  const sockets = new Set<net.Socket>();

  const server = http.createServer(async (req, res) => {
    const deny = (status = 403) => {
      refused++;
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'text/plain' });
      res.end('Refused by capture egress policy.');
    };
    try {
      const method = (req.method || 'GET').toUpperCase();
      const target = req.url || '';
      if ((method !== 'GET' && method !== 'HEAD') || !/^https?:\/\//i.test(target)) return deny();
      const upstream = await fetchCapped(target, {
        method: method as 'GET' | 'HEAD',
        timeoutMs: 15_000,
        maxBytes: 8 * 1024 * 1024,
        isAllowedAddress: allowed,
        headers: { 'User-Agent': String(req.headers['user-agent'] || 'Mozilla/5.0'), Accept: String(req.headers.accept || '*/*') },
      });
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(upstream.headers)) {
        if (v === undefined || ['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie', 'location'].includes(k)) continue;
        headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
      }
      res.writeHead(upstream.status, headers);
      res.end(upstream.body);
    } catch {
      deny(502);
    }
  });

  server.on('connect', async (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => client.destroy());
    // Counted from the CONNECT on (DNS included) until both sockets are gone.
    if (openTunnels >= maxOpen) {
      refused++;
      client.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      return;
    }
    openTunnels++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        openTunnels--;
      }
    };
    client.on('close', release);
    const [host, portText] = splitHostPort(req.url || '');
    const port = Number(portText);
    const ip = Number.isInteger(port) && ports.includes(port) ? await resolveAllowed(host, allowed) : null;
    if (!ip) {
      refused++;
      release();
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = net.connect({ host: ip, port }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    const close = () => {
      clearTimeout(lifetime);
      release();
      upstream.destroy();
      client.destroy();
    };
    // Hard lifetime and byte cap on top of the idle timeout.
    const lifetime = setTimeout(close, maxMs);
    let bytes = head.length;
    const count = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) close();
    };
    upstream.on('data', count);
    client.on('data', count);
    upstream.on('close', () => {
      sockets.delete(upstream);
      close();
    });
    client.on('close', close);
    upstream.setTimeout(TUNNEL_LIMITS.idleMs, close);
    upstream.on('error', close);
  });

  // Chromium never uses the proxy for plain HTTP upgrades here, but refuse them explicitly.
  server.on('upgrade', (_req, socket: net.Socket) => {
    refused++;
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    refused: () => refused,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

function splitHostPort(authority: string): [string, string] {
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    return [authority.slice(0, end + 1), authority.slice(end + 2)];
  }
  const i = authority.lastIndexOf(':');
  return i === -1 ? [authority, '443'] : [authority.slice(0, i), authority.slice(i + 1)];
}
