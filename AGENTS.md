# On-page Vision Pro Agent Instructions

Express + React 19 + Vite + Tailwind CSS 4 full-page CRO, visual hierarchy, accessibility, and on-page SEO/GEO audit studio using `@google/genai`, Playwright Chromium, and `sharp`.

## Verification Commands

Run all three after code changes before reporting done:

```bash
npm run lint    # tsc --noEmit
npm test        # node --import tsx --test "tests/**/*.test.ts"
npm run build   # vite build (entry JS ~321 kB, no chunk warning)
```

For a production boot check (zero paid calls): `PORT=3109 npm start` and verify `GET /api/health` and `GET /api/session`.

## Hard Repository Invariants

1. **Node strip-only TypeScript (`npm start`)**: `server.ts` and `server/*.ts` execute under Node native type-stripping without `tsx`. Keep explicit `.ts` extensions on relative server imports and never use TypeScript constructor parameter properties (`constructor(private x: T)`). Guarded by `tests/server/stripOnly.test.ts`.
2. **No em dashes or en dashes**: Never write U+2014 or U+2013 anywhere in code, prompts, UI copy, comments, tests, or docs. Guarded by `tests/server/dashes.test.ts` and server text normalization.
3. **Security boundaries are non-negotiable**:
   - Server binds `127.0.0.1` by default; non-loopback `HOST` refuses startup without `APP_ACCESS_TOKEN` unless `ALLOW_OPEN=1` (`server/access.ts`).
   - Keep SSRF DNS checks (`server/safeFetch.ts`), the Playwright egress proxy (`server/egressProxy.ts`), prompt-injection delimiters (`wrapUntrusted`), and image header/pixel-bomb limits (`server/image.ts`, `lib/client/images.ts`) intact.
4. **Secrets and spend caps**:
   - Local `.env.local` is git-ignored (`chmod 600`). Never print, log, or commit `GEMINI_API_KEY`.
   - Paid Gemini API calls should run under `VP_MODEL_CALL_BUDGET` during testing.
5. **Code discipline**: Prefer deep modules with small interfaces over fragmented wrappers; separate structural tidying from behavioral changes; verify UI changes in headless Playwright Chromium instead of trusting unit tests alone.
