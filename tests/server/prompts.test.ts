// G1: every text call tells the model today's date (server clock), so it stops calling past
// dates "future". Each route runs in process; only the Gemini network is faked, and every
// request it sends is checked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { dateContext, promptRules } from '../../server/gemini.ts';

test('dateContext: ISO and written-out date in UTC, with the rule to judge dates against it', () => {
  const line = dateContext(new Date('2026-11-24T23:30:00Z'));
  assert.equal(line, "Today's date is 2026-11-24 (Tuesday, 24 November 2026). Judge every date you see against it: a date on or before today is not in the future.");
  assert.match(promptRules(new Date('2026-01-05T00:00:00Z')), /^Today's date is 2026-01-05 .*\n\nWriting rule: never use em dashes/s);
});

let server: Server;
let base = '';
const realFetch = globalThis.fetch;
const sent: { url: string; body: any }[] = [];

const reply = (text: string) =>
  new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] }), { headers: { 'content-type': 'application/json' } });

before(async () => {
  process.env.VP_NO_AUTOSTART = '1';
  process.env.NODE_ENV = 'production';
  process.env.GEMINI_API_KEY = 'fake-key-prompts';
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes('generativelanguage.googleapis.com')) return realFetch(input, init);
    const body = JSON.parse(String(init?.body ?? '{}'));
    sent.push({ url, body });
    if (url.includes(':streamGenerateContent')) {
      return new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.includes('tts')) {
      const audio = { inlineData: { mimeType: 'audio/L16;rate=24000', data: Buffer.alloc(480).toString('base64') } };
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [audio] }, finishReason: 'STOP' }] }), { headers: { 'content-type': 'application/json' } });
    }
    return reply('{}'); // routes normalise an empty object to safe defaults
  }) as typeof fetch;
  const { createServer } = await import('../../server.ts');
  const app = await createServer({ listen: false });
  server = app!.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server?.close();
  globalThis.fetch = realFetch;
});

const post = (route: string, body: unknown) =>
  realFetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, text: await r.text() }));

test('every audit, page, compare, element, fix, copy, SERP, chat and brief request carries today\'s date', async () => {
  const png = `data:image/png;base64,${(await sharp({ create: { width: 1440, height: 900, channels: 3, background: '#888' } }).png().toBuffer()).toString('base64')}`;
  const tall = `data:image/png;base64,${(await sharp({ create: { width: 1440, height: 2500, channels: 3, background: '#888' } }).png().toBuffer()).toString('base64')}`;
  const finding = { context: 'Hero CTA', current_text: 'Go', seo_analysis: 'x', suggested_optimization: 'y', category: 'Conversion', severity: 'warning' };
  const calls: [string, unknown][] = [
    ['/api/audit/viewport', { screenshotDataUrl: png, viewport: 'desktop' }],
    ['/api/audit/page', { screenshotDataUrl: tall, viewport: 'desktop' }],
    ['/api/audit/more', { screenshotDataUrl: png, viewport: 'desktop', existingItems: [] }],
    ['/api/audit/element', { croppedImageDataUrl: png, viewport: 'desktop', box_2d: [0, 0, 500, 500] }],
    ['/api/audit/fix-code', { finding, url: 'https://example.com/' }],
    ['/api/audit/compare', { desktopScreenshot: png, mobileScreenshot: png, url: 'https://example.com/' }],
    ['/api/copy-variants', { screenshotDataUrl: png, url: 'https://example.com/', currentHeadline: 'Hi' }],
    ['/api/serp-research', { url: 'https://example.com/', summary: 's' }],
    ['/api/chat', { messages: [{ role: 'user', content: 'hi' }] }],
    ['/api/audio-brief', { domain: 'example.com' }],
  ];
  const today = new Date().toISOString().slice(0, 10);
  for (const [route, body] of calls) {
    const before = sent.length;
    const res = await post(route, body);
    const mine = sent.slice(before).filter((s) => !s.url.includes('tts'));
    assert.ok(mine.length > 0, `${route} sent a text request (status ${res.status}: ${res.text.slice(0, 120)})`);
    for (const s of mine) {
      const system = JSON.stringify(s.body.systemInstruction ?? s.body.system_instruction ?? '');
      assert.ok(system.includes(`Today's date is ${today}`), `${route} request carries today's date`);
      assert.ok(system.includes('Judge every date you see against it'), `${route} carries the rule`);
    }
  }
});

test('/api/serp-research includes verified llms.txt, robots.txt, canonical, and JSON-LD telemetry in prompt', async () => {
  const before = sent.length;
  const res = await post('/api/serp-research', {
    url: 'https://example.com/',
    summary: 's',
    metadata: {
      title: 'Example',
      description: 'Desc',
      canonical: 'https://example.com/',
      h1s: ['Hello'],
      h2s: [],
      totalImages: 1,
      missingAltImages: 0,
      schemaTypes: ['Person', 'WebSite'],
      telemetry: {
        renderedWordCount: 500,
        renderedH1Count: 1,
        spaHydratedDiff: false,
        brokenImages: 0,
        jsonLdErrors: 0,
        headingOrderIssues: [],
        smallTapTargets24: 0,
        smallTapTargets44: 0,
        horizontalOverflow: false,
        contrastFailures: [],
        missingLandmarks: [],
        unlabelledInputs: 0,
        formFieldCount: 0,
        origin: {
          robotsTxtPresent: true,
          sitemapCount: 1,
          llmsTxtPresent: true,
          aiBots: [{ bot: 'GPTBot', allowed: true }],
        },
      },
    },
  });
  assert.equal(res.status, 200);
  const mine = sent.slice(before);
  assert.ok(mine.length > 0);
  const promptText = JSON.stringify(mine[0].body);
  assert.match(promptText, /llms\.txt: present/);
  assert.match(promptText, /robots\.txt: present/);
  assert.match(promptText, /Person, WebSite/);
  assert.match(promptText, /do NOT claim llms\.txt/);
});
