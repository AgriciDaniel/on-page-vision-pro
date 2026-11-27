import type { AttentionHotspot, AuditFinding, AuditSession, CanvasOverlay, ViewportAudit, ViewportKey } from '../types';
import { describePosition, findingRect, heatSpots, pageViewOf, type PageView } from '../lib/client/pageView';
import { priorityLines, priorityRows, type PriorityRow } from '../lib/client/priorities';

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(err);
    img.src = src;
  });
}

/** Tallest PNG tile we draw. Browsers refuse canvases past about 32,767 px or 268 M px; this stays well under. */
export const PNG_TILE_MAX_HEIGHT = 16000;

export interface PngTile {
  /** Image rows this tile covers, [y0, y1). */
  y0: number;
  y1: number;
}

/** Split an image height into tiles no taller than maxHeight, as evenly as possible. Pure. */
export function planPngTiles(height: number, maxHeight = PNG_TILE_MAX_HEIGHT): PngTile[] {
  if (!(height > 0)) return [];
  const count = Math.max(1, Math.ceil(height / maxHeight));
  const step = Math.ceil(height / count);
  const tiles: PngTile[] = [];
  for (let y0 = 0; y0 < height; y0 += step) tiles.push({ y0, y1: Math.min(height, y0 + step) });
  return tiles;
}

/** One legend line per boxed finding: "#3  y 4,210 to 4,380 px, Pricing  Hero CTA". Pure. */
export function pngLegendLines(items: AuditFinding[], view: PageView): string[] {
  return items
    .map((item, idx) => {
      const where = describePosition(item, view);
      return where ? `#${idx + 1}  [${item.severity}]  ${where}  ${item.context}` : '';
    })
    .filter(Boolean);
}

const SEVERITY_HEX: Record<string, string> = { critical: '#DC2626', warning: '#D97706', info: '#2563EB' };

export interface PngLegendEntry {
  text: string;
  kind: 'heading' | 'line';
  color: string;
}

/**
 * Everything the PNG legend prints, in order: "Fix these first" (when the audit ranked any) and
 * then each boxed finding's position. Numbers match the badges on the image (#1 = first item). Pure.
 */
export function pngLegendEntries(
  items: AuditFinding[],
  view: PageView,
  priorities: PriorityRow[] = []
): PngLegendEntry[] {
  const entries: PngLegendEntry[] = [];
  if (priorities.length > 0) {
    entries.push({ text: 'Fix these first', kind: 'heading', color: '#0F172A' });
    const num = (it: AuditFinding) => `#${items.findIndex((i) => i.id === it.id) + 1}`;
    priorityLines(priorities, num).forEach((text, i) =>
      entries.push({ text, kind: 'line', color: priorities[i].blocker ? SEVERITY_HEX.critical : '#0F172A' })
    );
  }
  const positions = pngLegendLines(items, view);
  if (positions.length > 0) {
    entries.push({ text: `Finding positions (image ${view.size.width} x ${view.size.height} px)`, kind: 'heading', color: '#0F172A' });
    positions.forEach((text) => {
      const sev = /\[(critical|warning|info)\]/.exec(text)?.[1] ?? 'info';
      entries.push({ text, kind: 'line', color: SEVERITY_HEX[sev] });
    });
  }
  return entries;
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The browser could not encode the PNG.'))), 'image/png')
  );
}

/**
 * Render the annotated screenshot as one or more PNG blobs. Boxes come from box_px when present
 * (full-page audits), else box_2d. Pages taller than PNG_TILE_MAX_HEIGHT are split into tiles;
 * a box crossing a seam is drawn on both tiles, its badge on the tile where it starts. The last
 * tile ends with a legend giving each finding's position in px and its section.
 */
export async function renderAnnotatedPngBlobs(
  screenshotDataUrl: string,
  items: AuditFinding[],
  overlays: CanvasOverlay[],
  view: PageView,
  priorities: PriorityRow[] = [],
  heatmap?: { enabled?: boolean; hotspots?: AttentionHotspot[] }
): Promise<Blob[]> {
  const baseImg = await loadImage(screenshotDataUrl);
  const W = baseImg.naturalWidth || baseImg.width;
  const H = baseImg.naturalHeight || baseImg.height;
  const sizedView: PageView = { ...view, size: { width: W, height: H } };
  const spots = heatmap?.enabled ? heatSpots(heatmap.hotspots, items, sizedView) : [];

  const overlayImgs: { img: HTMLImageElement; ov: CanvasOverlay }[] = [];
  for (const ov of overlays) {
    try {
      const src = ov.base64.startsWith('data:image') ? ov.base64 : `data:image/png;base64,${ov.base64}`;
      overlayImgs.push({ img: await loadImage(src), ov });
    } catch {
      // Skip an overlay that will not decode.
    }
  }

  const strokeWidth = Math.max(2, Math.round(W / 420));
  const badgeSize = Math.max(22, Math.round(W / 48));
  const boxes = items
    .map((item, idx) => ({ item, idx, rect: findingRect(item, sizedView) }))
    .filter((b): b is { item: AuditFinding; idx: number; rect: NonNullable<ReturnType<typeof findingRect>> } =>
      Boolean(b.rect)
    );

  const legend = pngLegendEntries(items, sizedView, priorities);
  const lineH = Math.max(18, Math.round(W / 72));
  const rowH = (e: PngLegendEntry) => (e.kind === 'heading' ? lineH * 1.9 : lineH * 1.35);
  const legendH = legend.length > 0 ? Math.round(lineH * 0.6 + legend.reduce((sum, e) => sum + rowH(e), 0)) : 0;
  const tiles = planPngTiles(H);
  const blobs: Blob[] = [];

  for (let t = 0; t < tiles.length; t++) {
    const { y0, y1 } = tiles[t];
    const isLast = t === tiles.length - 1;
    const tileH = y1 - y0;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = tileH + (isLast ? legendH : 0);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser could not render the PNG.');

    ctx.drawImage(baseImg, 0, y0, W, tileH, 0, 0, W, tileH);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, tileH);
    ctx.clip();
    ctx.translate(0, -y0);

    for (const { img, ov } of overlayImgs) {
      const oy = (ov.y / 100) * H;
      const oh = (ov.h / 100) * H;
      if (oy + oh < y0 || oy > y1) continue;
      ctx.drawImage(img, (ov.x / 100) * W, oy, (ov.w / 100) * W, oh);
    }

    if (spots.length > 0 && y0 < sizedView.foldPx) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, sizedView.foldPx);
      ctx.clip();
      for (const spot of spots) {
        const peak = Math.max(0.36, Math.min(0.75, spot.intensity / 120));
        const grad = ctx.createRadialGradient(spot.cx, spot.cy, 0, spot.cx, spot.cy, spot.r);
        grad.addColorStop(0, `rgba(220,38,38,${peak})`);
        grad.addColorStop(0.32, `rgba(249,115,22,${peak * 0.68})`);
        grad.addColorStop(0.6, `rgba(250,204,21,${peak * 0.36})`);
        grad.addColorStop(1, 'rgba(34,211,238,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(spot.cx, spot.cy, spot.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.78)';
      ctx.lineWidth = Math.max(2, Math.round(W / 600));
      ctx.setLineDash([8, 6]);
      for (let i = 0; i < spots.length - 1; i++) {
        ctx.beginPath();
        ctx.moveTo(spots[i].cx, spots[i].cy);
        ctx.lineTo(spots[i + 1].cx, spots[i + 1].cy);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      const nodeR = Math.max(11, Math.round(W / 110));
      for (const spot of spots) {
        ctx.fillStyle = '#0F172A';
        ctx.beginPath();
        ctx.arc(spot.cx, spot.cy, nodeR, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = '#FFFFFF';
        ctx.font = `700 ${Math.round(nodeR * 1.05)}px "JetBrains Mono", monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(spot.rank), spot.cx, spot.cy);
      }
      ctx.restore();
    }

    for (const { item, idx, rect } of boxes) {
      if (rect.y + rect.height < y0 || rect.y > y1) continue;
      const color = SEVERITY_HEX[item.severity] ?? SEVERITY_HEX.info;
      ctx.fillStyle = `${color}18`;
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      ctx.strokeStyle = color;
      ctx.lineWidth = strokeWidth;
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
      if (rect.y >= y0 && rect.y < y1) {
        const by = Math.max(y0, rect.y - badgeSize);
        ctx.fillStyle = color;
        ctx.fillRect(rect.x, by, badgeSize * 1.15, badgeSize);
        ctx.fillStyle = '#FFFFFF';
        ctx.font = `700 ${Math.round(badgeSize * 0.56)}px "JetBrains Mono", monospace`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        ctx.fillText(String(idx + 1), rect.x + (badgeSize * 1.15) / 2, by + badgeSize / 2);
      }
    }
    ctx.restore();

    if (isLast && legendH > 0) {
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, tileH, W, legendH);
      ctx.fillStyle = '#E2E8F0';
      ctx.fillRect(0, tileH, W, 2);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      let y = tileH + lineH * 0.6;
      for (const e of legend) {
        const h = rowH(e);
        ctx.fillStyle = e.color;
        ctx.font =
          e.kind === 'heading'
            ? `700 ${Math.round(lineH * 0.8)}px Inter, sans-serif`
            : `500 ${Math.round(lineH * 0.68)}px "JetBrains Mono", monospace`;
        ctx.fillText(e.text, lineH, y + h / 2, W - lineH * 2);
        y += h;
      }
    }
    blobs.push(await canvasToBlob(canvas));
  }
  return blobs;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Download the annotated PNG. Returns how many files were saved (more than one for very tall pages). */
export async function downloadAnnotatedPng(
  screenshotDataUrl: string,
  items: AuditFinding[],
  overlays: CanvasOverlay[],
  domain: string,
  viewport: ViewportKey,
  view: PageView,
  priorities: PriorityRow[] = [],
  heatmap?: { enabled?: boolean; hotspots?: AttentionHotspot[] }
): Promise<number> {
  const blobs = await renderAnnotatedPngBlobs(screenshotDataUrl, items, overlays, view, priorities, heatmap);
  const stamp = Date.now();
  blobs.forEach((blob, i) => {
    const part = blobs.length > 1 ? `-part-${i + 1}-of-${blobs.length}` : '';
    // Browsers may block a burst of downloads; space them out a little.
    setTimeout(() => downloadBlob(blob, `vision-pro-${domain}-${viewport}${part}-${stamp}.png`), i * 400);
  });
  return blobs.length;
}

export function downloadBlobFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * The label a finding has everywhere: its 1-based position in its own viewport's list, prefixed
 * D (desktop) or M (mobile). Canvas badges show the number on its viewport tab; Report and
 * Markdown show the full label, so "D3" in a report is box 3 on the Desktop canvas.
 */
export function findingLabels(session: AuditSession): Map<string, string> {
  const labels = new Map<string, string>();
  for (const key of ['desktop', 'mobile'] as ViewportKey[]) {
    const prefix = key === 'desktop' ? 'D' : 'M';
    (session.viewports[key]?.analysis?.items || []).forEach((item, idx) => {
      labels.set(item.id, `${prefix}${idx + 1}`);
    });
  }
  return labels;
}

function scoreLine(label: string, audit: ViewportAudit): string {
  const s = audit.scores;
  return `- **${label} Score:** ${s.overall}/100 (Clarity ${s.clarity} · Visual ${s.visual_hierarchy} · Conversion ${s.conversion} · Trust ${s.trust_eeat})`;
}

/** The Markdown report as a string: both viewports, each with its own summary and findings. */
export function buildMarkdownReport(session: AuditSession): string {
  const audits = (['desktop', 'mobile'] as ViewportKey[])
    .map((key) => ({ key, audit: session.viewports[key]?.analysis }))
    .filter((a): a is { key: ViewportKey; audit: ViewportAudit } => Boolean(a.audit));
  const labels = findingLabels(session);
  const name = (key: ViewportKey) => (key === 'desktop' ? 'Desktop' : 'Mobile');
  const lines: string[] = [];

  lines.push(`# On-page Vision Pro Audit: ${session.pageTitle || session.domain}`);
  lines.push(`- **URL:** ${session.url || 'Uploaded design'}`);
  lines.push(`- **Audited:** ${new Date(session.createdAt).toLocaleString()}`);
  for (const { key, audit } of audits) lines.push(scoreLine(name(key), audit));
  for (const { key } of audits) {
    const view = pageViewOf(session.viewports[key]!, key);
    const scope =
      view.mode === 'fullpage'
        ? `full page, ${view.size.width} x ${view.size.height} px, first screen ends at ${Math.round(view.foldPx)} px`
        : `first screen, ${view.size.width} x ${view.size.height} px`;
    lines.push(`- **${name(key)} scope:** ${scope}`);
  }
  lines.push('');

  for (const { key, audit } of audits) {
    const title = audits.length > 1 ? `${name(key)}: ` : '';
    lines.push(`## ${title}Executive Summary`);
    lines.push(audit.overall_summary);
    lines.push('');
    if (audit.strategic_advisor) {
      lines.push(`## ${title}Strategic Growth Roadmap`);
      lines.push(audit.strategic_advisor);
      lines.push('');
    }
    const view = pageViewOf(session.viewports[key]!, key);
    if (view.sections.length > 1) {
      lines.push(`## ${title}Page Sections`);
      view.sections.forEach((sec) => {
        lines.push(`- **${sec.index + 1}. ${sec.label || 'Section'}:** y ${Math.round(sec.yStart)} to ${Math.round(sec.yEnd)} px`);
      });
      lines.push('');
    }
    const fixFirst = priorityRows(audit);
    if (fixFirst.length > 0) {
      lines.push(`## ${title}Fix These First`);
      priorityLines(fixFirst, (it) => labels.get(it.id) ?? '').forEach((l) => lines.push(l));
      lines.push('');
    }
    lines.push(`## ${name(key)} Findings (${audit.items.length})`);
    audit.items.forEach((item) => {
      lines.push(
        `### ${labels.get(item.id)}. [${item.severity.toUpperCase()}] ${item.context} (${item.category})`
      );
      const where = describePosition(item, view);
      lines.push(`- **Position:** ${where || 'Whole page (no single element)'}`);
      lines.push(`- **Diagnosis:** ${item.seo_analysis}`);
      lines.push(`- **Recommended Fix:** ${item.suggested_optimization}`);
      lines.push(`- **Impact:** ${item.impact_score}/100 · **Effort:** ${item.effort_estimate}`);
      if (item.technical_details) lines.push(`- **Technical:** ${item.technical_details}`);
      lines.push('');
    });
    // Findings the server left out over its cap: listed under their own heading, numbered on from
    // the shown ones, so the main list stays the readable one.
    const omitted = audit.omitted_items ?? [];
    if (omitted.length > 0) {
      const prefix = key === 'desktop' ? 'D' : 'M';
      lines.push(`## ${name(key)} Lower-Impact Findings (${omitted.length}, left out of the main list)`);
      omitted.forEach((item, idx) => {
        lines.push(`### ${prefix}${audit.items.length + idx + 1}. [${item.severity.toUpperCase()}] ${item.context} (${item.category})`);
        const where = describePosition(item, view);
        lines.push(`- **Position:** ${where || 'Whole page (no single element)'}`);
        lines.push(`- **Diagnosis:** ${item.seo_analysis}`);
        lines.push(`- **Recommended Fix:** ${item.suggested_optimization}`);
        lines.push(`- **Impact:** ${item.impact_score}/100 · **Effort:** ${item.effort_estimate}`);
        lines.push('');
      });
    }
  }

  if (session.comparison) {
    lines.push('## Desktop vs. Mobile Parity');
    lines.push(`- **Parity Score:** ${session.comparison.parity_score}/100`);
    lines.push(`- **Verdict:** ${session.comparison.executive_verdict}`);
    lines.push('');
  }

  if (session.copyVariants.length > 0) {
    lines.push('## A/B Hero Copy Lab Variants');
    session.copyVariants.forEach((v, idx) => {
      lines.push(`### Variant ${idx + 1}: ${v.angle}`);
      lines.push(`- **Headline:** ${v.headline}`);
      lines.push(`- **Subheadline:** ${v.subheadline}`);
      lines.push(`- **Primary CTA:** ${v.primary_cta}${v.secondary_cta ? ` · **Secondary CTA:** ${v.secondary_cta}` : ''}`);
      lines.push(`- **Rationale:** ${v.rationale}`);
      lines.push('');
    });
  }

  if (session.serpResearch) {
    lines.push('## Live SERP & Competitor Intelligence');
    if (session.serpResearch.search_intent) {
      lines.push(`- **Search Intent:** ${session.serpResearch.search_intent}`);
    }
    lines.push(session.serpResearch.positioning_verdict);
    lines.push('');
    session.serpResearch.competitors.forEach((c) => {
      const badge = c.grounded_domain_match === false ? ' [Unverified domain]' : '';
      lines.push(`- **${c.name}**${badge} (${c.url}): ${c.value_prop_hook}. Opportunity: ${c.opportunity_gap}`);
    });
    if (session.serpResearch.ai_overview_geo_gaps && session.serpResearch.ai_overview_geo_gaps.length > 0) {
      lines.push('');
      lines.push('### AI Overview & GEO Gaps');
      session.serpResearch.ai_overview_geo_gaps.forEach((g) => lines.push(`- ${g}`));
    }
    lines.push('');
  }

  const telemetry = session.seoMetadata?.telemetry;
  if (telemetry) {
    lines.push('## Technical SEO, WCAG 2.2, Lab CWV & AI-Search (GEO) Telemetry');
    lines.push(`- **Rendered DOM:** ${telemetry.renderedWordCount} words, ${telemetry.renderedH1Count} H1${telemetry.spaHydratedDiff ? ' (SPA-hydrated diff detected)' : ''}, lang=${telemetry.lang || 'missing'}`);
    if (telemetry.cwv) {
      lines.push(`- **Lab CWV (proxied, directional):** TTFB ${telemetry.cwv.ttfbMs ?? 'n/a'} ms · FCP ${telemetry.cwv.fcpMs ?? 'n/a'} ms · LCP ${telemetry.cwv.lcpMs ?? 'n/a'} ms · CLS ${telemetry.cwv.cls ?? 'n/a'} · ${telemetry.cwv.domNodes} DOM nodes`);
    }
    lines.push(`- **WCAG 2.2 Measurements:** ${telemetry.contrastFailures.length} solid-bg contrast failures (${telemetry.contrastUnresolvedCount} unresolved over gradients/images), ${telemetry.smallTapTargets24} tap targets <24px, ${telemetry.unlabelledInputs}/${telemetry.formFieldCount} unlabelled inputs`);
    if (telemetry.origin) {
      const blocked = telemetry.origin.aiBots.filter((b) => b.allowed === false).map((b) => b.bot);
      lines.push(`- **Crawler & GEO Signals:** robots.txt ${telemetry.origin.robotsTxtPresent ? `present (${telemetry.origin.sitemapCount} sitemaps${blocked.length ? `, blocks ${blocked.join(', ')}` : ', allows major search & AI bots'})` : 'not found'} · llms.txt ${telemetry.origin.llmsTxtPresent ? 'present' : 'not detected (optional)'}`);
    }
    lines.push('');
  }

  if (session.heroRedesigns.length > 0) {
    lines.push(`## Saved AI Full-Hero Redesigns (${session.heroRedesigns.length})`);
    session.heroRedesigns.forEach((r, idx) => {
      lines.push(`- **Concept ${idx + 1} (${r.viewport}):** ${r.prompt}`);
    });
    lines.push('');
  }

  return lines.join('\n');
}

export function downloadMarkdownReport(session: AuditSession): void {
  downloadBlobFile(
    buildMarkdownReport(session),
    `vision-pro-report-${session.domain}-${Date.now()}.md`,
    'text/markdown;charset=utf-8'
  );
}

const OMITTED = '[omitted-binary]';

/** A copy of the session for the JSON export, with every embedded image and audio clip replaced by a marker. */
export function sanitizeSessionForExport(session: AuditSession) {
  const stripViewport = (key: ViewportKey) => {
    const vp = session.viewports[key];
    if (!vp) return null;
    return {
      ...vp,
      screenshotDataUrl: OMITTED,
      overlays: vp.overlays.map((ov) => ({ ...ov, base64: OMITTED })),
    };
  };
  return {
    ...session,
    viewports: { desktop: stripViewport('desktop'), mobile: stripViewport('mobile') },
    heroRedesigns: session.heroRedesigns.map((r) => ({
      id: r.id,
      viewport: r.viewport,
      prompt: r.prompt,
      createdAt: r.createdAt,
    })),
    serpResearch: session.serpResearch
      ? {
          ...session.serpResearch,
          competitors: session.serpResearch.competitors.map((c) => ({
            ...c,
            capturedScreenshot: c.capturedScreenshot ? OMITTED : c.capturedScreenshot,
          })),
        }
      : null,
    audioBriefing: session.audioBriefing
      ? { script: session.audioBriefing.script, voice: session.audioBriefing.voice }
      : null,
  };
}

export function downloadJsonReport(session: AuditSession): void {
  downloadBlobFile(
    JSON.stringify(sanitizeSessionForExport(session), null, 2),
    `vision-pro-audit-${session.domain}-${Date.now()}.json`,
    'application/json;charset=utf-8'
  );
}
