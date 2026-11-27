import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMarkdownReport, findingLabels, sanitizeSessionForExport } from '../../utils/exportUtils';
import type { AuditFinding, AuditSession, ViewportAudit } from '../../types';

function finding(id: string, viewport: 'desktop' | 'mobile', context: string): AuditFinding {
  return {
    id,
    viewport,
    current_text: '',
    visual_description: '',
    context,
    seo_analysis: `${context} analysis`,
    suggested_optimization: `${context} fix`,
    severity: 'warning',
    category: 'Clarity',
    impact_score: 50,
    effort_estimate: 'medium',
    element_type: 'text',
  };
}

function audit(items: AuditFinding[], summary: string): ViewportAudit {
  return {
    overall_summary: summary,
    strategic_advisor: '',
    scores: { clarity: 1, visual_hierarchy: 2, conversion: 3, trust_eeat: 4, overall: 5 },
    items,
    quick_wins: { count: 0, estimated_impact: 0, top_3: [] },
    critical_count: 0,
    warning_count: items.length,
    info_count: 0,
  };
}

function session(): AuditSession {
  const vp = (items: AuditFinding[], summary: string) => ({
    screenshotDataUrl: 'data:image/png;base64,BIGSHOT',
    width: 1440,
    height: 900,
    analysis: audit(items, summary),
    overlays: [{ id: 'ov', base64: 'data:image/png;base64,OVERLAY', x: 0, y: 0, w: 10, h: 10, label: 'l', prompt: 'p' }],
  });
  return {
    id: 's',
    createdAt: '2026-11-24T00:00:00.000Z',
    updatedAt: '2026-11-24T00:00:00.000Z',
    sourceType: 'url',
    url: 'https://example.com/',
    domain: 'example.com',
    pageTitle: 'Example',
    seoMetadata: { title: '', description: '', h1s: [], h2s: [], totalImages: 0, missingAltImages: 0, ctaTexts: [], wordCount: 0, textPreview: '' },
    viewports: {
      desktop: vp([finding('d1', 'desktop', 'Hero H1'), finding('d2', 'desktop', 'Nav')], 'Desktop summary'),
      mobile: vp([finding('m1', 'mobile', 'Tap target')], 'Mobile summary'),
    },
    comparison: null,
    heroRedesigns: [],
    serpResearch: {
      niche_summary: '',
      positioning_verdict: '',
      competitors: [{ name: 'Rival', url: 'https://rival.com', value_prop_hook: '', strength: '', opportunity_gap: '', capturedScreenshot: 'data:image/png;base64,RIVAL' }],
      keyword_opportunities: [],
      eeat_gaps: [],
      quick_differentiators: [],
      sources: [],
      generated_at: '',
    },
    copyVariants: [],
    chatHistory: [],
    audioBriefing: null,
  };
}

test('findingLabels numbers per viewport with a D or M prefix', () => {
  const labels = findingLabels(session());
  assert.equal(labels.get('d1'), 'D1');
  assert.equal(labels.get('d2'), 'D2');
  assert.equal(labels.get('m1'), 'M1');
});

test('the Markdown report includes mobile findings when desktop exists', () => {
  const md = buildMarkdownReport(session());
  assert.match(md, /## Desktop Findings \(2\)/);
  assert.match(md, /## Mobile Findings \(1\)/);
  assert.match(md, /### M1\. \[WARNING\] Tap target/);
  assert.match(md, /Mobile summary/);
  const dashes = [String.fromCharCode(0x2013), String.fromCharCode(0x2014)];
  assert.ok(!dashes.some((d) => md.includes(d)), 'report text has no en or em dashes');
});

test('the JSON export strips screenshots, overlay images and competitor captures', () => {
  const json = JSON.stringify(sanitizeSessionForExport(session()));
  for (const payload of ['BIGSHOT', 'OVERLAY', 'RIVAL']) {
    assert.ok(!json.includes(payload), `${payload} image data left in export`);
  }
  assert.ok(json.includes('"label":"l"'), 'overlay metadata kept');
});

test('Markdown gives the scope, page sections and each finding position for a full page', () => {
  const desktopAudit = {
    scores: { overall: 70, clarity: 70, visual_hierarchy: 70, conversion: 70, trust_eeat: 70 },
    overall_summary: 'Sum',
    items: [
      { ...finding('d1', 'desktop', 'Pricing CTA'), box_px: [4210, 0, 4380, 300] as [number, number, number, number], section_index: 2 },
      { ...finding('d2', 'desktop', 'Tone'), element_type: 'abstract' as const },
    ],
    attention_hotspots: [],
    critical_count: 0,
    warning_count: 2,
    info_count: 0,
    mode: 'fullpage' as const,
    image: { width: 1440, height: 12000 },
    sections: [
      { index: 0, yStart: 0, yEnd: 1800, label: 'Hero' },
      { index: 1, yStart: 1530, yEnd: 3330, label: 'Features' },
      { index: 2, yStart: 3060, yEnd: 12000, label: 'Pricing' },
    ],
  } as ViewportAudit;
  const session = {
    id: 's',
    url: 'https://a.example',
    domain: 'a.example',
    createdAt: 0,
    viewports: {
      desktop: {
        screenshotDataUrl: 'x',
        width: 1440,
        height: 900,
        analysis: desktopAudit,
        overlays: [],
        naturalWidth: 1440,
        naturalHeight: 12000,
        captureMode: 'fullpage' as const,
        foldPx: 900,
      },
      mobile: null,
    },
    comparison: null,
    copyVariants: [],
    serpResearch: null,
    heroRedesigns: [],
  } as unknown as AuditSession;
  const md = buildMarkdownReport(session);
  assert.match(md, /Desktop scope:\*\* full page, 1440 x 12000 px, first screen ends at 900 px/);
  assert.match(md, /Page Sections/);
  assert.match(md, /3\. Pricing:\*\* y 3060 to 12000 px/);
  assert.match(md, /Position:\*\* y 4,210 to 4,380 px, Pricing/);
  assert.match(md, /Position:\*\* Whole page \(no single element\)/);
});

test('lower-impact findings get their own Markdown heading, numbered after the shown ones', () => {
  const s = session();
  s.viewports.mobile!.analysis!.omitted_items = [finding('m9', 'mobile', 'Footer spacing'), finding('m10', 'mobile', 'Badge contrast')];
  const md = buildMarkdownReport(s);
  assert.match(md, /## Mobile Lower-Impact Findings \(2, left out of the main list\)/);
  assert.match(md, /### M2\. \[WARNING\] Footer spacing/);
  assert.match(md, /### M3\. \[WARNING\] Badge contrast/);
  assert.ok(md.indexOf('## Mobile Findings (1)') < md.indexOf('## Mobile Lower-Impact Findings'));
});

test('no lower-impact heading when omitted_items is empty or missing', () => {
  const s = session();
  s.viewports.mobile!.analysis!.omitted_items = [];
  assert.doesNotMatch(buildMarkdownReport(s), /Lower-Impact Findings/);
  assert.doesNotMatch(buildMarkdownReport(session()), /Lower-Impact Findings/);
});
