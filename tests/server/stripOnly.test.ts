// `npm start` runs server.ts with Node's built-in TypeScript stripping, which rejects syntax
// that needs a compile step (parameter properties, enums, namespaces). Tests run under tsx,
// which accepts it, so this guard checks every server file the way `npm start` reads it.
// It caught `constructor(private now ...)` in server/access.ts on 2026-11-24.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

test('every server file loads under Node strip-only TypeScript (npm start)', () => {
  const files = ['server.ts', 'types.ts', ...readdirSync('server').filter((f) => f.endsWith('.ts')).map((f) => `server/${f}`)];
  const bad: string[] = [];
  for (const f of files) {
    try {
      stripTypeScriptTypes(readFileSync(f, 'utf8'));
    } catch (err) {
      bad.push(`${f}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  assert.deepEqual(bad, []);
});
