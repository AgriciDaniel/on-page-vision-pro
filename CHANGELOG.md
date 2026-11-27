# Changelog

All notable changes to On-page Vision Pro are documented in this file.

## [1.0.0] - 2026-11-27

### Added
- **Full-Page & First-Impression Multimodal Audits:** Desktop (`1440px`) and Mobile (`390px @ 2x`) Playwright Chromium capture with `sharp` band stitching, parallel section slicing, seam deduplication, and ranked top priorities.
- **Deterministic Browser Telemetry (`server/pageTelemetry.ts`):** Zero-dependency hydrated DOM and open shadow DOM checks for WCAG 2.2 AA solid-background contrast, `<24px` and `<44px` tap targets, broken images, JSON-LD parsing errors, HTML landmarks, unlabelled inputs, SPA hydration diff, Lab Core Web Vitals (`TTFB`, `FCP`, `LCP`, `CLS`), `/robots.txt` AI crawler policies, `/llms.txt`, and HTTP security headers (`HSTS`, `CSP`, `X-Robots-Tag`).
- **Five Workspaces:** Visual Canvas & Finding Inspector, Desktop vs. Mobile Responsive Parity Compare, Live SERP & GEO Competitor Intelligence (Google Search grounding + URL Context), A/B Copy Variants + Streaming CRO Strategist Chat, and Executive Report with Print/PDF/Markdown/JSON/PNG exports.
- **Visual Lenses & Redesign Studio:** Clearly labeled AI 3s Attention Estimate heatmap, Squint blur lens, CVD color-blindness filters, Section-Aware Deep Scan, Manual Region Audit, and Nano Banana 2.1 (`1K` element and `2K` desktop `16:9` / mobile `9:16` hero) visual redesigns with wipe-slider comparison.
- **Executive Audio Briefings:** Spoken audit briefings synthesized via Gemini 3.8 Flash-Lite TTS (`v1beta`, `Kore` and `Charon` voices) wrapped as playable 24 kHz WAV audio.
- **Hardened Server & Test Suite:** Loopback-first binding, fail-closed `APP_ACCESS_TOKEN`, per-IP rate limits, `VP_MODEL_CALL_BUDGET` spend cap, SSRF public-DNS + Playwright egress proxy, prompt-injection delimiters, Node 22 strip-only TypeScript production boot, and 257 automated tests.
