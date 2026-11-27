// Fixes from the 2026-11-24 real run (.agent/results/final-run.md): G2 JSON debris in titles,
// G3 identical titles, G11 too many findings. Fake model only; no network.
import './legacySettings.ts'; // first: pins 1,800 px sections, 3 at once, medium (see the file)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { cleanLabel, findingFromRaw } from '../../server/normalize.ts';
import {
  FINDINGS_PER_SECTION,
  MAX_PAGE_FINDINGS,
  auditPage,
  findingRules,
  firstSectionPrompt,
  mapSectionItems,
  overviewPrompt,
  planPageSections,
  sectionPrompt,
  trimFindings,
  uniqueTitles,
} from '../../server/pageAudit.ts';
import { pageOverviewSchema } from '../../server/auditSchemas.ts';
import type { AuditFinding } from '../../types.ts';

const BRACE_OR_BRACKET = /[{}[\]]/;

// ---------- G2 ----------

test('G2: the raw answer from the real run (0018-page-section-11) is valid JSON; the debris is inside the strings', () => {
  const text = readFileSync(new URL('./fixtures/raw-page-section-11.json', import.meta.url), 'utf8');
  const raw = JSON.parse(text); // strict parse: the lenient parser did not merge anything
  assert.equal(raw.items[3].context, 'Lead Testimonial Card (Trust Proof)}{"invalid":false');
  assert.equal(raw.items[4].context, 'Testimonial Card (Trust Proof)}{"invalid":false');
});

test('G2: findings built from that raw answer carry clean titles', () => {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/raw-page-section-11.json', import.meta.url), 'utf8'));
  const sections = planPageSections(780, 28_058);
  const candidates = mapSectionItems(raw.items, sections[10], { width: 780, height: 28_058 }, 'mobile');
  const titles = candidates.map((c) => c.finding.context);
  assert.deepEqual(titles, [
    'Offer Benefit List above Primary CTA',
    'Primary CTA',
    'Social Proof Section Header',
    'Lead Testimonial Card (Trust Proof)',
    'Testimonial Card (Trust Proof)',
  ]);
  for (const c of candidates) {
    assert.ok(!BRACE_OR_BRACKET.test(c.finding.context), c.finding.context);
    assert.ok(!BRACE_OR_BRACKET.test(c.finding.category), c.finding.category);
  }
});

test('G2: cleanLabel cuts at the first brace, bracket or key fragment and rejects an empty result', () => {
  assert.equal(cleanLabel('Lead Testimonial Card (Trust Proof)}{"invalid":false'), 'Lead Testimonial Card (Trust Proof)');
  assert.equal(cleanLabel('Pricing band CTA","severity":"warning'), 'Pricing band CTA');
  assert.equal(cleanLabel('Footer links ["a","b"]'), 'Footer links');
  assert.equal(cleanLabel('  Hero   primary CTA  '), 'Hero primary CTA');
  assert.equal(cleanLabel('Trust & E-E-A-T'), 'Trust & E-E-A-T');
  assert.equal(cleanLabel('Price: $49 (monthly)'), 'Price: $49 (monthly)', 'ordinary punctuation inside a label stays');
  assert.equal(cleanLabel('{"invalid":false}'), null);
  assert.equal(cleanLabel('}{'), null);
  assert.equal(cleanLabel('"",'), null);
  assert.equal(cleanLabel(''), null);
  assert.equal(cleanLabel(undefined), null);
  assert.equal(cleanLabel({}), null);
  const long = cleanLabel('word '.repeat(40), 30)!;
  assert.ok(long.length <= 30 && !long.endsWith(' '));
});

test('G2: a title that is nothing but debris falls back to the category, then a default', () => {
  const f1 = findingFromRaw({ context: '{"x":1}', category: 'Trust' }, 0, 'mobile', undefined, 0);
  assert.equal(f1.context, 'Trust');
  const f2 = findingFromRaw({ context: '[]', category: '}' }, 0, 'mobile', undefined, 0);
  assert.equal(f2.context, 'Page element');
  assert.equal(f2.category, 'Conversion');
});

// ---------- G3 and G11 prompts ----------

const req = (viewport: 'desktop' | 'mobile') => ({ image: Buffer.alloc(0), width: viewport === 'mobile' ? 780 : 1440, height: 9000, viewport, auditGoal: 'general' as const });

test('G3 and G11: section prompts ask for distinct located titles and fewer findings on mobile', () => {
  assert.deepEqual(FINDINGS_PER_SECTION, { desktop: 6, mobile: 4 });
  for (const vp of ['desktop', 'mobile'] as const) {
    const sections = planPageSections(req(vp).width, 9000);
    for (const text of [firstSectionPrompt(req(vp), sections[0], sections.length, 900), sectionPrompt(req(vp), sections[1], sections.length)]) {
      assert.match(text, new RegExp(`Report UP TO ${FINDINGS_PER_SECTION[vp]} findings`));
      assert.match(text, /distinct, located title/);
      assert.match(text, /"Hero primary CTA" or "Pricing band CTA", never a bare "Primary CTA"/);
    }
  }
  assert.ok(!findingRules('mobile').includes('UP TO 6'));
});

test('G11: the overview asks which findings to drop, and its schema requires the list', () => {
  const sections = planPageSections(780, 9000);
  const text = overviewPrompt(req('mobile'), sections, 'F1 (section 1) [warning] Hero CTA: x');
  assert.match(text, /- drop: the ids of low-value findings .*minor polish, or a finding that repeats another finding/);
  assert.match(text, /Never list a blocker or a top priority/);
  assert.ok((pageOverviewSchema as any).required.includes('drop'));
  assert.equal((pageOverviewSchema as any).properties.drop.type, 'ARRAY');
});

// ---------- G3 and G11 helpers ----------

let n = 0;
const finding = (over: Partial<AuditFinding>): AuditFinding =>
  ({
    id: `f${n++}`,
    viewport: 'mobile',
    current_text: '',
    visual_description: '',
    context: 'X',
    seo_analysis: '',
    suggested_optimization: '',
    severity: 'warning',
    category: 'Conversion',
    impact_score: 50,
    effort_estimate: 'medium',
    standards_violated: [],
    element_type: 'text',
    box_confidence: 'high',
    ...over,
  }) as AuditFinding;

test('G3: repeated titles get their section label, and a number when they share a section', () => {
  const labels = ['Hero', 'Pricing', 'Proof'];
  const out = uniqueTitles(
    [
      finding({ context: 'Primary CTA', section_index: 0 }),
      finding({ context: 'primary cta', section_index: 1 }),
      finding({ context: 'Trust Proof', section_index: 2 }),
      finding({ context: 'Trust Proof', section_index: 2 }),
      finding({ context: 'Footer links', section_index: 2 }),
    ],
    (i) => labels[i ?? 0]
  );
  assert.deepEqual(
    out.map((f) => f.context),
    ['Primary CTA (Hero)', 'primary cta (Pricing)', 'Trust Proof (Proof) 1', 'Trust Proof (Proof) 2', 'Footer links']
  );
  assert.equal(new Set(out.map((f) => f.context.toLowerCase())).size, out.length);
});

test('G11: trimFindings drops low-value findings, caps the rest by severity and impact, and keeps every blocker', () => {
  const blockers = [0, 1, 2].map((i) => finding({ severity: 'critical', impact_score: 10 + i }));
  const priority = finding({ severity: 'info', impact_score: 1 });
  const warnings = Array.from({ length: 10 }, (_, i) => finding({ severity: 'warning', impact_score: 40 + i }));
  const infos = Array.from({ length: 5 }, (_, i) => finding({ severity: 'info', impact_score: 90 + i }));
  const all = [...blockers, priority, ...warnings, ...infos];
  const drop = new Set([blockers[0].id, priority.id, warnings[9].id, infos[4].id]);
  const { items, counts, omitted } = trimFindings(all, drop, new Set([priority.id]), 6);

  assert.deepEqual(counts, { found: 19, returned: 6, droppedLowValue: 2, omittedOverCap: 11, cap: 6 });
  const ids = new Set(items.map((f) => f.id));
  for (const b of blockers) assert.ok(ids.has(b.id), 'every blocker kept, even one marked to drop');
  assert.ok(ids.has(priority.id), 'a top priority is kept even when marked to drop');
  assert.ok(!ids.has(warnings[9].id), 'dropped');
  // The 2 free places go to the highest-impact warnings that were not dropped.
  assert.ok(ids.has(warnings[8].id) && ids.has(warnings[7].id));
  assert.ok(!infos.some((f) => ids.has(f.id)), 'warnings outrank info whatever the impact');
  // Cut by the cap: every finding neither kept nor dropped, warnings first, then by impact.
  assert.equal(omitted.length, counts.omittedOverCap);
  assert.deepEqual(omitted.map((f) => f.id), [...warnings.slice(0, 7).reverse(), ...infos.slice(0, 4).reverse()].map((f) => f.id));
  assert.ok(!omitted.some((f) => drop.has(f.id)), 'never the low-value drops');
  assert.ok(!omitted.some((f) => ids.has(f.id)), 'never a shown finding');
  // Original order is kept.
  assert.deepEqual(items.map((f) => f.id), all.filter((f) => ids.has(f.id)).map((f) => f.id));

  const many = Array.from({ length: 5 }, () => finding({ severity: 'critical' }));
  assert.equal(trimFindings(many, new Set(), new Set(), 2).items.length, 5, 'blockers exceed the cap rather than being cut');
});

// ---------- end to end: a 16-section mobile audit ----------

test('G2, G3, G11 end to end: a long mobile page comes back capped, clean and with unique titles', async () => {
  const W = 780;
  const H = 28_058;
  const sections = planPageSections(W, H);
  assert.equal(sections.length, 16);
  const image = await sharp({ create: { width: W, height: H, channels: 3, background: '#777' } }).jpeg().toBuffer();
  const reply = (obj: unknown) => ({ text: JSON.stringify(obj), candidates: [{ finishReason: 'STOP' }] });
  const asked: number[] = [];
  let overviewText = '';
  const ai = {
    models: {
      async generateContent(r: any) {
        const text: string = r.contents.parts[1].text;
        const m = /^Audit section (\d+) of/.exec(text);
        if (m) {
          const s = Number(m[1]);
          asked.push(Number(/Report UP TO (\d+) findings/.exec(text)![1]));
          const items = [0, 1, 2, 3].map((k) => ({
            context: k === 0 && (s === 3 || s === 9) ? 'Primary CTA' : k === 1 && s === 11 ? `Testimonial ${s}-${k}}{"invalid":false` : `Item ${s}-${k}`,
            category: 'Conversion',
            severity: k === 3 ? 'info' : 'warning',
            impact_score: k === 0 && (s === 3 || s === 9) ? 99 : 40 + k * 10 + s,
            current_text: `t${s}-${k}`,
            seo_analysis: 'a',
            suggested_optimization: 'b',
            element_type: 'button',
            box_2d: [100 + k * 220, 50, 260 + k * 220, 950],
          }));
          return reply(s === 1 ? { items, first_impression_test: {}, attention_hotspots: [] } : { items });
        }
        overviewText = text;
        const ref = (title: string) => new RegExp(`(F\\d+) \\(section \\d+\\) \\[\\w+\\] ${title.replace(/[()]/g, '\\$&')}:`).exec(text)![1];
        return reply({
          overall_summary: 's',
          strategic_advisor: 'a',
          scores: {},
          section_labels: sections.map((x) => ({ index: x.index, label: x.index === 2 ? 'Hero}{"x"' : `Band ${x.index + 1}` })),
          top_priorities: [{ finding: ref('Item 16-3'), rank: 1, reason: 'Blocks the signup.}{"invalid":false', blocker: true }],
          drop: [ref('Item 16-3'), ref('Item 2-0'), ref('Item 2-1')],
        });
      },
    },
  };

  const audit = await auditPage({ image, width: W, height: H, viewport: 'mobile', auditGoal: 'general' }, { ai: ai as any, concurrency: 4 });

  assert.ok(asked.every((x) => x === 4), 'every mobile section asked for up to 4');
  const s = audit.stats!.findings!;
  assert.equal(s.found, 64);
  assert.equal(s.droppedLowValue, 2, 'the blocker marked to drop was kept');
  assert.equal(s.returned, MAX_PAGE_FINDINGS);
  assert.equal(s.omittedOverCap, 64 - 2 - MAX_PAGE_FINDINGS);
  // Nothing hidden for good: the 32 cut by the cap come back in omitted_items, mapped and
  // cleaned like items, never the 2 dropped ones, and never counted in the severity counts.
  const omitted = audit.omitted_items!;
  assert.equal(omitted.length, 64 - 2 - MAX_PAGE_FINDINGS);
  const shownIds = new Set(audit.items.map((f) => f.id));
  assert.ok(omitted.every((f) => !shownIds.has(f.id)));
  assert.ok(!omitted.some((f) => f.context === 'Item 2-0' || f.context === 'Item 2-1'), 'dropped findings stay dropped');
  assert.ok(omitted.every((f) => f.box_px && f.box_2d && f.viewport === 'mobile' && typeof f.section_index === 'number'), 'mapped like items');
  assert.ok(omitted.every((f) => !BRACE_OR_BRACKET.test(f.context)), 'cleaned like items');
  assert.ok(omitted.every((f) => f.severity !== 'critical'), 'blockers are never cut');
  const allTitles = [...audit.items, ...omitted].map((f) => f.context.toLowerCase());
  assert.equal(new Set(allTitles).size, allTitles.length, 'titles unique across shown and omitted');
  const shownCount = audit.critical_count + audit.warning_count + audit.info_count;
  assert.equal(shownCount, MAX_PAGE_FINDINGS, 'severity counts cover the shown items only');
  assert.equal(s.cap, MAX_PAGE_FINDINGS);
  assert.equal(audit.items.length, MAX_PAGE_FINDINGS);
  assert.ok(audit.warnings!.some((w) => w.includes(`Showing the ${MAX_PAGE_FINDINGS} most important of 64 findings`)));

  const blocker = audit.items.find((f) => f.severity === 'critical')!;
  assert.equal(blocker.context, 'Item 16-3');
  assert.equal(audit.top_priorities![0].finding_id, blocker.id);
  assert.equal(audit.top_priorities![0].reason, 'Blocks the signup.');
  assert.ok(!audit.items.some((f) => f.context === 'Item 2-0' || f.context === 'Item 2-1'));

  const titles = audit.items.map((f) => f.context);
  assert.equal(new Set(titles.map((t) => t.toLowerCase())).size, titles.length, 'no two findings share a title');
  for (const t of titles) assert.ok(!BRACE_OR_BRACKET.test(t), t);
  for (const sec of audit.sections!) assert.ok(!BRACE_OR_BRACKET.test(sec.label), sec.label);
  assert.equal(audit.sections![2].label, 'Hero');
  // Both "Primary CTA" findings (sections 3 and 9) are given the top impact, so they survive the cap.
  assert.ok(titles.includes('Primary CTA (Hero)'), titles.join(' | '));
  assert.ok(titles.includes('Primary CTA (Band 9)'), titles.join(' | '));
  assert.ok(overviewText.includes('- drop:'));
});
