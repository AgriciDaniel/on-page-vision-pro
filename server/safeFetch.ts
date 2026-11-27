// Outbound HTTP for user-supplied and provider URLs.
//
// One rule hides behind two functions: the server never talks to a private, loopback,
// link-local or otherwise non-public address, whatever the URL says, whatever DNS answers,
// and wherever a redirect points.
//
// - assertPublicUrl(raw): normalises a user URL and checks it (name rules, literal IPs, DNS).
// - fetchCapped(url, opts): GET with one deadline covering connect, headers and body, a byte
//   cap on the decoded body, manual redirects re-checked on every hop, and the DNS answer
//   checked inside the socket's own lookup, so a rebinding DNS server cannot swap in a private
//   address between the check and the connect.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { HttpError } from './http.ts';

// ---- address classification -------------------------------------------------------------

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => ((acc << 8) | (Number(part) & 255)) >>> 0, 0);
}

const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT (also some cloud metadata, e.g. 100.100.100.200)
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata 169.254.169.254
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved and broadcast
];

function isPublicIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  return !BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((value & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0);
  });
}

/** Expands an IPv6 address (no brackets, no zone) into 8 numeric hextets. */
function expandIpv6(ip: string): number[] | null {
  let addr = ip.toLowerCase();
  const zone = addr.indexOf('%');
  if (zone !== -1) addr = addr.slice(0, zone);

  // Trailing dotted IPv4 (e.g. ::ffff:127.0.0.1)
  const lastColon = addr.lastIndexOf(':');
  const tail = addr.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (net.isIPv4(tail) === false) return null;
    const v = ipv4ToInt(tail);
    addr = `${addr.slice(0, lastColon + 1)}${(v >>> 16).toString(16)}:${(v & 0xffff).toString(16)}`;
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  const nums = groups.map((g) => parseInt(g, 16));
  return nums.length === 8 && nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? nums : null;
}

function isPublicIpv6(ip: string): boolean {
  const h = expandIpv6(ip);
  if (!h) return false;
  const embeddedV4 = (hi: number, lo: number) =>
    `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

  // Forms that embed an IPv4 address are judged by that address.
  if (h.slice(0, 5).every((n) => n === 0) && h[5] === 0xffff) return isPublicIpv4(embeddedV4(h[6], h[7])); // ::ffff:a.b.c.d mapped
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((n) => n === 0)) {
    return isPublicIpv4(embeddedV4(h[6], h[7])); // well-known NAT64 prefix 64:ff9b::/96
  }
  if (h[0] === 0x2002) return isPublicIpv4(embeddedV4(h[1], h[2])); // 6to4 2002::/16

  // Default deny: only global unicast 2000::/3 can be public. This refuses ::, ::1, the
  // IPv4-compatible and IPv4-translated forms (::/96, ::ffff:0:0/96), local-use NAT64
  // 64:ff9b:1::/48, discard 100::/64, unique local, link-local, site-local and multicast.
  if ((h[0] & 0xe000) !== 0x2000) return false;

  // Special-purpose blocks inside 2000::/3 (IANA IPv6 special-purpose address registry).
  if (h[0] === 0x2001 && h[1] < 0x0200) return false; // 2001::/23 IETF protocol assignments: Teredo, benchmarking, ORCHID, AMT, AS112
  if (h[0] === 0x2001 && h[1] === 0x0db8) return false; // 2001:db8::/32 documentation
  if (h[0] === 0x3fff && h[1] < 0x1000) return false; // 3fff::/20 documentation (RFC 9637)
  if (h[0] === 0x5f00) return false; // 5f00::/16 SRv6 SIDs (RFC 9602)
  return true;
}

/** True only for globally routable unicast addresses. Anything unparseable is not public. */
export function isPublicAddress(ip: string): boolean {
  const bare = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  const family = net.isIP(bare.split('%')[0]);
  if (family === 4) return isPublicIpv4(bare);
  if (family === 6) return isPublicIpv6(bare);
  return false;
}

/** Names that only ever mean the local machine or network. Shared with the egress proxy. */
export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa') || h.endsWith('.lan')) return true;
  // Single-label names resolve through the host's search domains (intranet names).
  if (!h.includes('.') && net.isIP(h) === 0) return true;
  return false;
}

function bareHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

// ---- user URL check -------------------------------------------------------------------------

export type LookupFn = typeof dns.lookup;

const PRIVATE_URL_MESSAGE =
  'Local or private network URLs cannot be captured. Upload or paste a screenshot instead.';

/** Parses and normalises a user URL without touching the network. Throws HttpError(400). */
export function normalizeUrl(rawUrl: string): string {
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed) throw new HttpError(400, 'Please enter a website URL.');
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new HttpError(400, 'That does not look like a valid website URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new HttpError(400, 'Only HTTP and HTTPS URLs are supported.');
  }
  if (parsed.username || parsed.password) {
    throw new HttpError(400, 'URLs with embedded credentials are not supported.');
  }
  const host = bareHost(parsed.hostname);
  if (net.isIP(host) ? !isPublicAddress(host) : isBlockedHostname(host)) {
    throw new HttpError(400, PRIVATE_URL_MESSAGE);
  }
  return parsed.toString();
}

/** normalizeUrl plus a DNS check: every resolved address must be public. Throws HttpError(400). */
export async function assertPublicUrl(rawUrl: string, lookup: LookupFn = dns.lookup): Promise<string> {
  const normalized = normalizeUrl(rawUrl);
  const host = bareHost(new URL(normalized).hostname);
  if (net.isIP(host)) return normalized; // already checked in normalizeUrl
  let addresses: dns.LookupAddress[];
  try {
    addresses = await new Promise<dns.LookupAddress[]>((resolve, reject) =>
      lookup(host, { all: true }, (err, result) => (err ? reject(err) : resolve(result as dns.LookupAddress[])))
    );
  } catch {
    throw new HttpError(400, `Could not resolve ${host}. Check the URL and try again.`);
  }
  if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) {
    throw new HttpError(400, PRIVATE_URL_MESSAGE);
  }
  return normalized;
}

// ---- capped fetch ---------------------------------------------------------------------------

export type FetchFailure = 'blocked' | 'timeout' | 'too_large' | 'redirects' | 'network';

export class FetchCappedError extends Error {
  readonly code: FetchFailure;
  constructor(code: FetchFailure, message: string) {
    super(message);
    this.name = 'FetchCappedError';
    this.code = code;
  }
}

export interface CappedResponse {
  status: number;
  url: string; // final URL after redirects
  headers: IncomingHttpHeaders;
  contentType: string; // lower-case media type without parameters, '' if absent
  body: Buffer;
}

export interface FetchCappedOptions {
  timeoutMs: number; // one deadline for every hop, headers and body
  maxBytes: number; // cap on the decoded body
  /** Cap on compressed bytes received for an encoded body. Defaults to maxBytes. */
  maxWireBytes?: number;
  headers?: Record<string, string>;
  method?: 'GET' | 'HEAD'; // default GET
  maxRedirects?: number; // default 5
  /** Address policy. Defaults to public-only; tests pass a looser one for loopback servers. */
  isAllowedAddress?: (ip: string) => boolean;
  /** DNS resolver, injectable for tests. Defaults to dns.lookup. */
  lookup?: LookupFn;
}

function guardedLookup(base: LookupFn, allowed: (ip: string) => boolean) {
  return (hostname: string, options: dns.LookupOptions, callback: (...args: any[]) => void) => {
    base(hostname, { ...options, all: true }, (err, result) => {
      if (err) return callback(err);
      const list = result as unknown as dns.LookupAddress[];
      if (!list.length || list.some((a) => !allowed(a.address))) {
        return callback(new FetchCappedError('blocked', `Refusing to connect to a non-public address for ${hostname}.`));
      }
      if (options?.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

function requestOnce(
  target: URL,
  opts: FetchCappedOptions,
  remainingMs: number
): Promise<{ res: IncomingMessage; req: http.ClientRequest }> {
  const allowed = opts.isAllowedAddress ?? isPublicAddress;
  const host = bareHost(target.hostname);
  if (net.isIP(host)) {
    if (!allowed(host)) {
      return Promise.reject(new FetchCappedError('blocked', `Refusing to connect to non-public address ${host}.`));
    }
  } else if (allowed === isPublicAddress && isBlockedHostname(host)) {
    return Promise.reject(new FetchCappedError('blocked', `Refusing to connect to local host name ${host}.`));
  }

  const client = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null;
  if (!client) return Promise.reject(new FetchCappedError('blocked', `Unsupported protocol ${target.protocol}`));

  return new Promise((resolve, reject) => {
    const req = client.request(
      target,
      {
        method: opts.method ?? 'GET',
        headers: { 'Accept-Encoding': 'gzip, deflate, br', ...(opts.headers || {}) },
        lookup: guardedLookup(opts.lookup ?? dns.lookup, allowed) as any,
      },
      (res) => resolve({ res, req })
    );
    req.setTimeout(Math.max(1, remainingMs), () =>
      req.destroy(new FetchCappedError('timeout', `Timed out after ${opts.timeoutMs} ms.`))
    );
    req.on('error', (err) =>
      reject(err instanceof FetchCappedError ? err : new FetchCappedError('network', err.message))
    );
    req.end();
  });
}

function readBody(res: IncomingMessage, req: http.ClientRequest, opts: FetchCappedOptions, remainingMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const encoding = String(res.headers['content-encoding'] || '').toLowerCase().trim();
    const decoder: zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null =
      encoding === 'gzip' || encoding === 'x-gzip'
        ? zlib.createGunzip()
        : encoding === 'deflate'
          ? zlib.createInflate()
          : encoding === 'br'
            ? zlib.createBrotliDecompress()
            : null;
    const stream: NodeJS.ReadableStream = decoder ? res.pipe(decoder) : res;

    const chunks: Buffer[] = [];
    let size = 0;
    let wire = 0;
    // Compressed bytes on the wire are capped too: decoded size alone lets a stream of empty
    // gzip members run for megabytes while decoding to nothing.
    const maxWire = opts.maxWireBytes ?? opts.maxBytes;
    let settled = false;
    const finish = (err: Error | null, body?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The decompressor holds buffered input and keeps inflating it unless destroyed.
      if (decoder) {
        res.unpipe(decoder);
        decoder.destroy();
      }
      if (err) {
        req.destroy();
        res.destroy();
        reject(err);
      } else {
        resolve(body!);
      }
    };
    const timer = setTimeout(
      () => finish(new FetchCappedError('timeout', `Timed out after ${opts.timeoutMs} ms while reading the body.`)),
      Math.max(1, remainingMs)
    );

    const declared = Number(res.headers['content-length']);
    const declaredCap = encoding ? maxWire : opts.maxBytes;
    if (Number.isFinite(declared) && declared > declaredCap) {
      finish(new FetchCappedError('too_large', `Body of ${declared} bytes exceeds the ${declaredCap} byte cap.`));
      return;
    }

    if (decoder) {
      res.on('data', (chunk: Buffer) => {
        wire += chunk.length;
        if (wire > maxWire) finish(new FetchCappedError('too_large', `Compressed body exceeds the ${maxWire} byte cap.`));
      });
    }

    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > opts.maxBytes) {
        finish(new FetchCappedError('too_large', `Body exceeds the ${opts.maxBytes} byte cap.`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => finish(null, Buffer.concat(chunks)));
    stream.on('error', (err: Error) => finish(err instanceof FetchCappedError ? err : new FetchCappedError('network', err.message)));
    res.on('aborted', () => finish(new FetchCappedError('network', 'Connection closed before the body finished.')));
  });
}

/** GET (or HEAD) with deadline, byte cap and redirect-by-redirect address checks. Non-2xx is returned, not thrown. */
export async function fetchCapped(url: string, opts: FetchCappedOptions): Promise<CappedResponse> {
  const deadline = Date.now() + opts.timeoutMs;
  const maxRedirects = opts.maxRedirects ?? 5;
  let current = new URL(url);

  for (let hop = 0; ; hop++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new FetchCappedError('timeout', `Timed out after ${opts.timeoutMs} ms.`);
    const { res, req } = await requestOnce(current, opts, remaining);
    const status = res.statusCode || 0;
    const location = res.headers.location;

    if (status >= 300 && status < 400 && location) {
      res.resume();
      req.destroy();
      if (hop >= maxRedirects) throw new FetchCappedError('redirects', `More than ${maxRedirects} redirects.`);
      // A Location that is not a valid URL (for example an IPv6 zone id, http://[fe80::1%25eth0]/)
      // is refused like any other blocked target instead of escaping as a raw TypeError.
      try {
        current = new URL(location, current);
      } catch {
        throw new FetchCappedError('blocked', 'The page redirected to an address that is not a valid URL.');
      }
      continue;
    }

    const body = await readBody(res, req, opts, deadline - Date.now());
    const contentType = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    return { status, url: current.toString(), headers: res.headers, contentType, body };
  }
}
