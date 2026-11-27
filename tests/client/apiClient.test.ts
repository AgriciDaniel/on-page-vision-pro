import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiError,
  auditPage,
  CaptureBlockedError,
  captureUrl,
  generateVisualRedesign,
  isAbortError,
  parseSseBuffer,
  toViewportAudit,
} from '../../services/apiClient';

const scores = { clarity: 61, visual_hierarchy: 55, conversion: 48, trust_eeat: 70, overall: 58 };

test('toViewportAudit keeps the server scores exactly', () => {
  const audit = toViewportAudit({ scores, items: [], overall_summary: 'ok', strategic_advisor: '' });
  assert.deepEqual(audit.scores, scores);
});

test('toViewportAudit refuses an audit without scores instead of inventing 69', () => {
  assert.throws(() => toViewportAudit({ items: [] }), /without scores/);
  assert.throws(() => toViewportAudit({ scores: { ...scores, overall: 'x' }, items: [] }), /without scores/);
});

test('toViewportAudit guards arrays and counts severities when counts are missing', () => {
  const audit = toViewportAudit({
    scores,
    items: [{ severity: 'critical' }, { severity: 'warning' }, { severity: 'critical' }],
    attention_hotspots: 'nope',
  });
  assert.equal(audit.critical_count, 2);
  assert.equal(audit.warning_count, 1);
  assert.equal(audit.info_count, 0);
  assert.deepEqual(audit.attention_hotspots, []);
  assert.deepEqual(audit.quick_wins, { count: 0, estimated_impact: 0, top_3: [] });
});

test('parseSseBuffer returns complete events and keeps the unfinished tail', () => {
  const { events, rest } = parseSseBuffer('data: {"text":"Hel"}\n\ndata: {"text":"lo"}\n\ndata: {"te');
  assert.deepEqual(events, [{ text: 'Hel' }, { text: 'lo' }]);
  assert.equal(rest, 'data: {"te');
});

test('parseSseBuffer skips a malformed event instead of throwing', () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { events } = parseSseBuffer('data: {broken\n\ndata: {"done":true}\n\n');
    assert.deepEqual(events, [{ done: true }]);
  } finally {
    console.warn = warn;
  }
});

test('isAbortError recognises an aborted fetch', () => {
  assert.equal(isAbortError(new DOMException('aborted', 'AbortError')), true);
  assert.equal(isAbortError(new Error('boom')), false);
  assert.equal(isAbortError(null), false);
});

/** Run `fn` with fetch answering every request with `status` and `body`. */
async function withFetch(status: number, body: unknown, fn: () => Promise<void>) {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test('a capture 422 keeps the page metadata the server read', async () => {
  const metadata = { title: 'Blocked Site', description: '', h1s: ['Hi'], h2s: [], totalImages: 3, missingAltImages: 1, ctaTexts: [], wordCount: 120, textPreview: '' };
  await withFetch(422, { error: 'Automated viewport capture was blocked by this website.', metadata }, async () => {
    await assert.rejects(captureUrl('https://blocked.example'), (err: any) => {
      assert.ok(err instanceof CaptureBlockedError);
      assert.equal(err.status, 422);
      assert.equal(err.metadata.title, 'Blocked Site');
      assert.match(err.message, /blocked by this website/);
      return true;
    });
  });
});

test('a redesign 422 surfaces the server message with its status', async () => {
  await withFetch(422, { error: 'The model answered with text instead of an image: try a simpler layout' }, async () => {
    await assert.rejects(generateVisualRedesign({ imageDataUrl: 'd', mode: 'element', prompt: 'p' }), (err: any) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 422);
      assert.match(err.message, /text instead of an image/);
      return true;
    });
  });
});

test('other API errors are ApiError with the server text', async () => {
  await withFetch(503, { error: 'The AI service is not configured.' }, async () => {
    await assert.rejects(captureUrl('https://x.example'), (err: any) => {
      assert.ok(err instanceof ApiError && !(err instanceof CaptureBlockedError));
      assert.equal(err.status, 503);
      return true;
    });
  });
});

test('captureUrl sends the requested mode, full page by default', async () => {
  const real = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(
      JSON.stringify({ url: 'https://a.example', domain: 'a.example', metadata: {}, desktopScreenshot: null, mobileScreenshot: null, desktopCapture: null, mobileCapture: null, captureWarnings: [] }),
      { status: 200 }
    );
  }) as typeof fetch;
  try {
    await captureUrl('https://a.example');
    await captureUrl('https://a.example', 'viewport');
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(bodies[0].mode, 'fullpage');
  assert.equal(bodies[1].mode, 'viewport');
});

test('auditPage posts to /api/audit/page and keeps mode, image, sections, box_px and section_index', async () => {
  const real = globalThis.fetch;
  let calledUrl = '';
  let sent: any = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calledUrl = url;
    sent = JSON.parse(String(init.body));
    return new Response(
      JSON.stringify({
        mode: 'fullpage',
        image: { width: 1440, height: 9000 },
        sections: [{ index: 0, yStart: 0, yEnd: 1800, label: 'Hero' }],
        scores: { overall: 60, clarity: 60, visual_hierarchy: 60, conversion: 60, trust_eeat: 60 },
        overall_summary: 's',
        items: [{ id: 'x', severity: 'critical', box_2d: [100.25, 0, 102.5, 500], box_px: [902.25, 0, 922.5, 720], section_index: 0 }],
        warnings: ['Section 3 was retried once.'],
      }),
      { status: 200 }
    );
  }) as typeof fetch;
  try {
    const result = await auditPage({ screenshotDataUrl: 'data:image/jpeg;base64,x', viewport: 'desktop', foldPx: 900 });
    assert.equal(calledUrl, '/api/audit/page');
    assert.equal(sent.foldPx, 900);
    assert.equal(result.mode, 'fullpage');
    assert.deepEqual(result.image, { width: 1440, height: 9000 });
    assert.equal(result.sections?.length, 1);
    assert.deepEqual(result.items[0].box_px, [902.25, 0, 922.5, 720]);
    assert.deepEqual(result.items[0].box_2d, [100.25, 0, 102.5, 500]);
    assert.equal(result.items[0].section_index, 0);
    assert.equal(result.critical_count, 1);
    assert.deepEqual(result.warnings, ['Section 3 was retried once.']);
  } finally {
    globalThis.fetch = real;
  }
});

test('a capture 422 also keeps the server warnings', async () => {
  await withFetch(422, { error: 'blocked', metadata: null, captureWarnings: ['Desktop: timed out.'] }, async () => {
    await assert.rejects(captureUrl('https://b.example'), (err: any) => {
      assert.deepEqual(err.warnings, ['Desktop: timed out.']);
      return true;
    });
  });
});
