import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '../..');

describe('build and env health', () => {
  it('loads .env and overrides with .env.local using Node env-file-if-exists flags', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-env-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, '.env'), 'GEMINI_API_KEY=from_env\n');
      fs.writeFileSync(path.join(tmpDir, '.env.local'), 'GEMINI_API_KEY=from_env_local\n');

      const env = { ...process.env };
      delete env.GEMINI_API_KEY;

      const out = execFileSync(
        process.execPath,
        [
          '--env-file-if-exists=.env',
          '--env-file-if-exists=.env.local',
          '-e',
          'process.stdout.write(process.env.GEMINI_API_KEY || "")',
        ],
        { cwd: tmpDir, env, encoding: 'utf8' }
      );
      assert.equal(out, 'from_env_local');

      fs.rmSync(path.join(tmpDir, '.env.local'));
      const outFallback = execFileSync(
        process.execPath,
        [
          '--env-file-if-exists=.env',
          '--env-file-if-exists=.env.local',
          '-e',
          'process.stdout.write(process.env.GEMINI_API_KEY || "")',
        ],
        { cwd: tmpDir, env, encoding: 'utf8' }
      );
      assert.equal(outFallback, 'from_env');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps package.json clean, deduplicated, and configured for production start', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'on-page-vision-pro');
    assert.ok(pkg.engines?.node, 'engines.node must be declared');
    assert.match(pkg.scripts.dev, /--env-file-if-exists=\.env/);
    assert.match(pkg.scripts.dev, /--env-file-if-exists=\.env\.local/);
    assert.match(pkg.scripts.start, /NODE_ENV=production/);
    assert.match(pkg.scripts.start, /--env-file-if-exists=\.env/);
    assert.match(pkg.scripts.start, /--env-file-if-exists=\.env\.local/);

    const deps = Object.keys(pkg.dependencies || {});
    const devDeps = Object.keys(pkg.devDependencies || {});
    const overlap = deps.filter((d) => devDeps.includes(d));
    assert.deepEqual(overlap, [], 'no duplicate dependencies across dependencies and devDependencies');

    for (const removed of ['path', 'url', 'clsx', 'tailwind-merge']) {
      assert.ok(!deps.includes(removed) && !devDeps.includes(removed), `${removed} should be removed`);
    }
  });

  it('ignores .env while keeping .env.example tracked in .gitignore', () => {
    const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    const lines = gitignore.split(/\r?\n/).map((l) => l.trim());
    assert.ok(lines.includes('.env'));
    assert.ok(lines.includes('!.env.example'));
  });
});
