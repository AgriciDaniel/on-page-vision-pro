# Security Policy

## Supported Versions

| Version | Supported |
| :--- | :--- |
| `1.0.x` | Yes |

## Reporting a Vulnerability

Please do **not** open a public GitHub issue for security vulnerabilities (SSRF bypasses, egress proxy escapes, access-token weaknesses, or prompt-injection escalation paths).

Instead, report vulnerabilities privately via GitHub Security Advisories:

- Open the **Security** tab on `AgriciDaniel/on-page-vision-pro` and select **Report a vulnerability**.
- Include reproduction steps, affected route or file, and impact assessment.

## Security Design Summary

- **Loopback by default:** The server binds to `127.0.0.1` unless `HOST` is overridden. Non-loopback bindings refuse startup without `APP_ACCESS_TOKEN` unless `ALLOW_OPEN=1` is set explicitly.
- **SSRF & Playwright isolation:** Outbound fetches (`server/safeFetch.ts`) and headless browser capture (`server/egressProxy.ts`) enforce public-address DNS checks on every redirect hop and socket connect, block private/loopback/metadata IP ranges, and disable direct browser transports (WebRTC, WebTransport, Workers, ServiceWorkers, WebSockets, downloads, popups).
- **Rate limits & spend caps:** Fixed-window per-IP rate limits (`RATE_LIMIT_*`) and hard per-process model call ceilings (`VP_MODEL_CALL_BUDGET`) guard against runaway spend.
- **Tool-free LLM boundaries:** Model routes hold no filesystem or network write tools, and untrusted scraped page content is isolated inside `<untrusted_page_data>` delimiters.
