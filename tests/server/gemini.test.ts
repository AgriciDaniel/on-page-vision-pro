import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ModelOutputError,
  generateJson,
  isFallbackable,
  parseModelJson,
  toPlayableAudio,
  withFallback,
} from '../../server/gemini.ts';

/** Fake SDK client: each model name maps to a response object or an error to throw. */
function fakeAi(byModel: Record<string, any>) {
  const calls: string[] = [];
  return {
    calls,
    models: {
      async generateContent(req: any) {
        calls.push(req.model);
        assert.ok(req.config.abortSignal instanceof AbortSignal, 'every call carries an abort signal');
        const out = byModel[req.model];
        if (out instanceof Error) throw out;
        return out;
      },
    },
  };
}
const ok = (text: string, finishReason = 'STOP') => ({ text, candidates: [{ finishReason }] });
const apiError = (status: number) => Object.assign(new Error(`got status ${status}`), { status });

test('parseModelJson tolerates fences and prose, and throws ModelOutputError otherwise', () => {
  assert.deepEqual(parseModelJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseModelJson('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(parseModelJson('Here you go: {"a":3} hope it helps'), { a: 3 });
  assert.throws(() => parseModelJson('{"items": [{"a": 1}, {"a"'), ModelOutputError);
  assert.throws(() => parseModelJson(''), ModelOutputError);
});

test('isFallbackable uses the SDK status first and does not retry timeouts', () => {
  for (const s of [404, 429, 500, 503]) assert.equal(isFallbackable(apiError(s)), true, String(s));
  for (const s of [400, 401, 403]) assert.equal(isFallbackable(apiError(s)), false, String(s));
  assert.equal(isFallbackable(new ModelOutputError('cut off')), true);
  assert.equal(isFallbackable(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), false);
  assert.equal(isFallbackable(new Error('RESOURCE_EXHAUSTED quota')), true);
  assert.equal(isFallbackable(new SyntaxError('Unexpected end of JSON input')), false);
});

test('generateJson falls back when the primary answer is truncated (MAX_TOKENS)', async () => {
  const ai = fakeAi({ primary: ok('{"items": [', 'MAX_TOKENS'), fallback: ok('{"items": []}') });
  const out = await generateJson({ ai, models: ['primary', 'fallback'], prompt: 'x', schema: {} });
  assert.deepEqual(out.result, { items: [] });
  assert.equal(out.modelUsed, 'fallback');
  assert.deepEqual(ai.calls, ['primary', 'fallback']);
});

test('generateJson falls back on an unknown primary model (404) and on unparseable output', async () => {
  const a = fakeAi({ primary: apiError(404), fallback: ok('{"x":1}') });
  assert.equal((await generateJson({ ai: a, models: ['primary', 'fallback'], prompt: 'x' })).modelUsed, 'fallback');
  const b = fakeAi({ primary: ok('not json at all'), fallback: ok('{"x":1}') });
  assert.equal((await generateJson({ ai: b, models: ['primary', 'fallback'], prompt: 'x' })).modelUsed, 'fallback');
});

test('generateJson does not fall back on a 400 and reports output errors after the fallback fails', async () => {
  const a = fakeAi({ primary: apiError(400), fallback: ok('{}') });
  await assert.rejects(generateJson({ ai: a, models: ['primary', 'fallback'], prompt: 'x' }), (e: any) => e.status === 400);
  assert.deepEqual(a.calls, ['primary']);
  const b = fakeAi({ primary: ok('', 'MAX_TOKENS'), fallback: ok('', 'SAFETY') });
  await assert.rejects(generateJson({ ai: b, models: ['primary', 'fallback'], prompt: 'x' }), ModelOutputError);
});

test('generateJson sends JSON mode with a schema, but not when search tools are used', async () => {
  const seen: any[] = [];
  const ai = { models: { async generateContent(req: any) { seen.push(req.config); return ok('{"a":1}'); } } };
  await generateJson({ ai, models: ['m'], prompt: 'x', schema: { type: 'OBJECT' } });
  await generateJson({ ai, models: ['m'], prompt: 'x', tools: [{ googleSearch: {} }] });
  assert.equal(seen[0].responseMimeType, 'application/json');
  assert.deepEqual(seen[0].responseSchema, { type: 'OBJECT' });
  assert.equal(seen[1].responseMimeType, undefined);
  assert.deepEqual(seen[1].tools, [{ googleSearch: {} }]);
});

test('withFallback gives each attempt its own timeout signal', async () => {
  const out = await withFallback('a', undefined, 50, (_m, signal) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve('late'), 500);
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(signal.reason);
      });
    })
  ).catch((e) => e);
  assert.equal(out.name, 'TimeoutError');
});

test('toPlayableAudio wraps raw PCM in a WAV header using the rate from the MIME type', () => {
  const pcm = Buffer.alloc(4800, 1);
  const out = toPlayableAudio(pcm.toString('base64'), 'audio/L16;codec=pcm;rate=24000');
  assert.equal(out.mimeType, 'audio/wav');
  const wav = Buffer.from(out.dataUrl.split(',')[1], 'base64');
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.equal(wav.length, 44 + pcm.length);

  const other = toPlayableAudio(pcm.toString('base64'), 'audio/pcm;rate=16000;channels=2');
  const wav2 = Buffer.from(other.dataUrl.split(',')[1], 'base64');
  assert.equal(wav2.readUInt32LE(24), 16000);
  assert.equal(wav2.readUInt16LE(22), 2);
});

test('toPlayableAudio passes RIFF data and other containers through unchanged', () => {
  const riff = Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE'), Buffer.alloc(40)]);
  const a = toPlayableAudio(riff.toString('base64'), 'audio/L16;rate=24000');
  assert.equal(a.dataUrl, `data:audio/wav;base64,${riff.toString('base64')}`);
  const mp3 = Buffer.from('ID3' + '\0'.repeat(30)).toString('base64');
  assert.equal(toPlayableAudio(mp3, 'audio/mpeg').dataUrl, `data:audio/mpeg;base64,${mp3}`);
});
