import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  dedupeAcrossSections,
  intersectionOverSmaller,
  intersectionOverUnion,
  isClippedBySection,
  mapBoxToPage,
  ownerSectionIndex,
  planSections,
  type SectionFindingLike,
} from '../../lib/tiling.ts';
import { box2dToPixelRect } from '../../lib/geometry.ts';

describe('lib/tiling', () => {
  it('returns exactly one section for viewport-sized images (1440x900 and 390x844)', () => {
    const desktop = planSections(1440, 900);
    assert.equal(desktop.length, 1);
    assert.deepEqual(desktop[0], { index: 0, yStart: 0, yEnd: 900, width: 1440, height: 900 });

    const mobile = planSections(390, 844);
    assert.equal(mobile.length, 1);
    assert.deepEqual(mobile[0], { index: 0, yStart: 0, yEnd: 844, width: 390, height: 844 });
  });

  it('plans contiguous overlapping sections for 1440x15000 and 2880x40000 pages', () => {
    for (const [w, h] of [
      [1440, 15000],
      [2880, 40000],
    ] as const) {
      const sections = planSections(w, h);
      assert.ok(sections.length > 1);
      assert.equal(sections[0].yStart, 0);
      assert.equal(sections[sections.length - 1].yEnd, h);

      for (let i = 0; i < sections.length; i += 1) {
        const s = sections[i];
        assert.equal(s.index, i);
        assert.equal(s.width, w);
        assert.equal(s.height, s.yEnd - s.yStart);
        assert.ok(s.height >= 400, `section ${i} height ${s.height} < 400`);
        if (i > 0) {
          const prev = sections[i - 1];
          const overlap = prev.yEnd - s.yStart;
          assert.ok(overlap >= 270, `overlap between ${i - 1} and ${i} was ${overlap}`);
        }
      }
    }
  });

  it('never produces a final section thinner than minSectionHeight', () => {
    // 1800 + 50 px overhang would be a 50 px sliver without clamping to minSectionHeight
    const sections = planSections(1440, 1850, {
      sectionHeight: 1800,
      overlapRatio: 0.15,
      minSectionHeight: 400,
    });
    assert.equal(sections.length, 2);
    assert.equal(sections[0].yStart, 0);
    assert.equal(sections[0].yEnd, 1800);
    assert.equal(sections[1].yEnd, 1850);
    assert.equal(sections[1].height, 400);
    assert.equal(sections[1].yStart, 1450);
  });

  it('returns empty array for zero, negative, or non-finite dimensions', () => {
    assert.deepEqual(planSections(0, 900), []);
    assert.deepEqual(planSections(1440, 0), []);
    assert.deepEqual(planSections(-1440, 900), []);
    assert.deepEqual(planSections(1440, -15000), []);
    assert.deepEqual(planSections(Number.NaN, 15000), []);
    assert.deepEqual(planSections(1440, Number.POSITIVE_INFINITY), []);
  });

  it('maps a 40 px button in a middle section of a 1440x15000 page without losing its size', () => {
    const pageSize = { width: 1440, height: 15000 };
    const sections = planSections(pageSize.width, pageSize.height);
    const sec = sections[4]; // yStart=6120, yEnd=7920, height=1800

    // A 40 px tall button starting 500 px into section 4 -> y = 6620..6660
    const ymin = (500 / sec.height) * 1000;
    const ymax = (540 / sec.height) * 1000;
    const mapped = mapBoxToPage([ymin, 250, ymax, 500], sec, pageSize);

    assert.ok(Math.abs(mapped.pixelRect.y - (sec.yStart + 500)) < 1e-9);
    assert.ok(Math.abs(mapped.pixelRect.height - 40) < 1e-9);
    assert.ok(Math.abs(mapped.pixelRect.x - 360) < 1e-9);
    assert.ok(Math.abs(mapped.pixelRect.width - 360) < 1e-9);

    // Re-converting pageBox2d to page pixels must preserve the 40 px button height
    const roundTripped = box2dToPixelRect(mapped.pageBox2d, pageSize);
    assert.ok(Math.abs(roundTripped.height - 40) < 1e-9);
    assert.ok(Math.abs(roundTripped.y - (sec.yStart + 500)) < 1e-9);
  });

  it('computes exact IoU including disjoint, identical, partial, and degenerate rects', () => {
    const a = { x: 100, y: 100, width: 200, height: 100 };
    const identical = { x: 100, y: 100, width: 200, height: 100 };
    const halfOverlap = { x: 200, y: 100, width: 200, height: 100 };
    const disjoint = { x: 500, y: 500, width: 50, height: 50 };
    const zero = { x: 100, y: 100, width: 0, height: 100 };

    assert.equal(intersectionOverUnion(a, identical), 1);
    assert.ok(Math.abs(intersectionOverUnion(a, halfOverlap) - 1 / 3) < 1e-9);
    assert.equal(intersectionOverUnion(a, disjoint), 0);
    assert.equal(intersectionOverUnion(a, zero), 0);
  });

  it('dedupes duplicate findings on a section seam, keeping the higher severity', () => {
    const pageSize = { width: 1440, height: 15000 };
    const sections = planSections(pageSize.width, pageSize.height);
    // Seam between section 0 (0..1800) and section 1 (1530..3330): overlap band is 1530..1800
    const seamBoxSec0 = mapBoxToPage(
      [(1600 / 1800) * 1000, 100, (1700 / 1800) * 1000, 500],
      sections[0],
      pageSize
    );
    const seamBoxSec1 = mapBoxToPage(
      [((1605 - 1530) / 1800) * 1000, 102, ((1702 - 1530) / 1800) * 1000, 498],
      sections[1],
      pageSize
    );

    const findings: SectionFindingLike[] = [
      {
        id: 'f-sec0',
        sectionIndex: 0,
        severity: 'warning',
        category: 'Conversion',
        current_text: 'Start free trial',
        pixelRect: seamBoxSec0.pixelRect,
      },
      {
        id: 'f-sec1',
        sectionIndex: 1,
        severity: 'critical',
        category: 'Conversion',
        current_text: 'Start free trial',
        pixelRect: seamBoxSec1.pixelRect,
      },
      // Different category and different text on the same seam should NOT merge
      {
        id: 'f-sec1-distinct',
        sectionIndex: 1,
        severity: 'info',
        category: 'SEO',
        current_text: 'Missing alt attribute on hero badge',
        pixelRect: seamBoxSec1.pixelRect,
      },
      // Same section, overlapping box should NOT be deduped by cross-section dedupe
      {
        id: 'f-sec0-same',
        sectionIndex: 0,
        severity: 'info',
        category: 'Conversion',
        current_text: 'Start free trial',
        pixelRect: seamBoxSec0.pixelRect,
      },
    ];

    const deduped = dedupeAcrossSections(findings, pageSize);
    assert.equal(deduped.length, 3);
    assert.equal(deduped[0].id, 'f-sec1');
    assert.equal(deduped[0].severity, 'critical');
    assert.equal(deduped[1].id, 'f-sec1-distinct');
    assert.equal(deduped[2].id, 'f-sec0-same');
  });

  it('dedupes findings on a seam by matching text even when category labels differ', () => {
    const pageSize = { width: 1440, height: 15000 };
    const findings: SectionFindingLike[] = [
      {
        id: 'a',
        sectionIndex: 2,
        severity: 'critical',
        category: 'Clarity',
        current_text: 'Book a live product demo',
        pixelRect: { x: 200, y: 4700, width: 400, height: 60 },
      },
      {
        id: 'b',
        sectionIndex: 3,
        severity: 'warning',
        category: 'CTA',
        current_text: 'Book a live product demo',
        pixelRect: { x: 204, y: 4702, width: 396, height: 58 },
      },
    ];

    const deduped = dedupeAcrossSections(findings, pageSize);
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].id, 'a');
    assert.equal(deduped[0].severity, 'critical');
  });

  it('computes intersectionOverSmaller for nested, partial, disjoint, and degenerate rects', () => {
    const full = { x: 100, y: 1650, width: 400, height: 300 };
    const sliver = { x: 100, y: 1650, width: 400, height: 80 };
    const disjoint = { x: 600, y: 1650, width: 100, height: 80 };
    const zero = { x: 100, y: 1650, width: 0, height: 80 };

    // IoU is low (80 / 300 = 0.2667), but IoS is 1.0
    assert.ok(intersectionOverUnion(full, sliver) < 0.3);
    assert.equal(intersectionOverSmaller(full, sliver), 1);
    assert.equal(intersectionOverSmaller(full, disjoint), 0);
    assert.equal(intersectionOverSmaller(full, zero), 0);
  });

  it('detects section clipping on internal seams while ignoring page top and bottom edges', () => {
    const pageSize = { width: 1440, height: 15000 };
    const sections = planSections(pageSize.width, pageSize.height);
    const first = sections[0];
    const middle = sections[1];
    const last = sections[sections.length - 1];

    // Touching page top in section 0 is NOT clipped
    assert.equal(isClippedBySection([0, 100, 100, 500], first, pageSize, 4), false);
    // Touching bottom of section 0 IS clipped (internal seam)
    assert.equal(isClippedBySection([900, 100, 999, 500], first, pageSize, 4), true);
    // Touching top of middle section IS clipped (internal seam)
    assert.equal(isClippedBySection([1, 100, 120, 500], middle, pageSize, 4), true);
    // Interior box in middle section is NOT clipped
    assert.equal(isClippedBySection([200, 100, 400, 500], middle, pageSize, 4), false);
    // Touching page bottom in last section is NOT clipped
    assert.equal(isClippedBySection([850, 100, 1000, 500], last, pageSize, 4), false);
  });

  it('merges a 300 px tall card split 150 and 150 across a seam into one finding with the full 300 px rect', () => {
    const pageSize = { width: 1440, height: 15000 };
    const sections = planSections(pageSize.width, pageSize.height, {
      sectionHeight: 1800,
      overlapRatio: 0,
    });

    // Card spans y=1650..1950 (300 px tall), split 150 px in section 0 and 150 px in section 1
    const topBoxSec0 = [(1650 / 1800) * 1000, 100, 1000, 500] as const;
    const bottomBoxSec1 = [0, 100, (150 / 1800) * 1000, 500] as const;

    assert.equal(isClippedBySection(topBoxSec0, sections[0], pageSize), true);
    assert.equal(isClippedBySection(bottomBoxSec1, sections[1], pageSize), true);

    const topMapped = mapBoxToPage(topBoxSec0, sections[0], pageSize);
    const bottomMapped = mapBoxToPage(bottomBoxSec1, sections[1], pageSize);

    const findings: SectionFindingLike[] = [
      {
        id: 'card-top',
        sectionIndex: 0,
        severity: 'warning',
        category: 'Visual Hierarchy',
        current_text: 'Enterprise plan pricing card',
        pixelRect: topMapped.pixelRect,
        box_2d: topMapped.pageBox2d,
        clipped: true,
      },
      {
        id: 'card-bottom',
        sectionIndex: 1,
        severity: 'critical',
        category: 'Visual Hierarchy',
        current_text: 'Enterprise plan pricing card',
        pixelRect: bottomMapped.pixelRect,
        box_2d: bottomMapped.pageBox2d,
        clipped: true,
      },
    ];

    const deduped = dedupeAcrossSections(findings, pageSize, { sections });
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].severity, 'critical');
    assert.ok(deduped[0].pixelRect);
    assert.ok(Math.abs(deduped[0].pixelRect.y - 1650) < 1e-9);
    assert.ok(Math.abs(deduped[0].pixelRect.height - 300) < 1e-9);
    assert.ok(Math.abs(deduped[0].pixelRect.x - 144) < 1e-9);
    assert.ok(Math.abs(deduped[0].pixelRect.width - 576) < 1e-9);
  });

  it('prefers the unclipped finding when one section clips an element to a low-IoU sliver', () => {
    const pageSize = { width: 1440, height: 15000 };
    const sections = planSections(pageSize.width, pageSize.height);
    // Section 0 ends at 1800; section 1 starts at 1530.
    // A 300 px card at y=1720..2020 has an 80 px sliver in section 0 and full 300 px in section 1.
    const clippedBoxSec0 = [(1720 / 1800) * 1000, 100, 1000, 500] as const;
    const fullBoxSec1 = [((1720 - 1530) / 1800) * 1000, 100, ((2020 - 1530) / 1800) * 1000, 500] as const;

    const mapped0 = mapBoxToPage(clippedBoxSec0, sections[0], pageSize);
    const mapped1 = mapBoxToPage(fullBoxSec1, sections[1], pageSize);

    assert.ok(intersectionOverUnion(mapped0.pixelRect, mapped1.pixelRect) < 0.4);
    assert.equal(intersectionOverSmaller(mapped0.pixelRect, mapped1.pixelRect), 1);

    const findings: SectionFindingLike[] = [
      {
        id: 'clipped-sliver',
        sectionIndex: 0,
        severity: 'critical',
        category: 'Conversion',
        current_text: 'Pro Plan',
        pixelRect: mapped0.pixelRect,
        clipped: isClippedBySection(clippedBoxSec0, sections[0], pageSize),
      },
      {
        id: 'unclipped-full',
        sectionIndex: 1,
        severity: 'warning',
        category: 'Conversion',
        current_text: 'Pro Plan',
        pixelRect: mapped1.pixelRect,
        clipped: isClippedBySection(fullBoxSec1, sections[1], pageSize),
      },
    ];

    const deduped = dedupeAcrossSections(findings, pageSize, { sections });
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].id, 'unclipped-full');
    assert.ok(Math.abs(deduped[0].pixelRect!.height - 300) < 1e-9);
  });

  it('merges a box fully inside the overlap band seen by both sections', () => {
    const pageSize = { width: 1440, height: 15000 };
    const sections = planSections(pageSize.width, pageSize.height);
    // Overlap band between section 0 (0..1800) and section 1 (1530..3330) is 1530..1800.
    // Box at y=1600..1680 is completely inside the overlap band and unclipped in both sections.
    const boxSec0 = [(1600 / 1800) * 1000, 200, (1680 / 1800) * 1000, 600] as const;
    const boxSec1 = [((1600 - 1530) / 1800) * 1000, 202, ((1680 - 1530) / 1800) * 1000, 598] as const;

    const mapped0 = mapBoxToPage(boxSec0, sections[0], pageSize);
    const mapped1 = mapBoxToPage(boxSec1, sections[1], pageSize);

    assert.equal(isClippedBySection(boxSec0, sections[0], pageSize), false);
    assert.equal(isClippedBySection(boxSec1, sections[1], pageSize), false);

    const deduped = dedupeAcrossSections(
      [
        {
          id: 'overlap-0',
          sectionIndex: 0,
          severity: 'info',
          category: 'CTA',
          current_text: 'Get Started Free',
          pixelRect: mapped0.pixelRect,
        },
        {
          id: 'overlap-1',
          sectionIndex: 1,
          severity: 'warning',
          category: 'CTA',
          current_text: 'Get Started Free',
          pixelRect: mapped1.pixelRect,
        },
      ],
      pageSize,
      { sections }
    );

    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].id, 'overlap-1');
    assert.equal(deduped[0].severity, 'warning');
  });

  it('does not merge two different adjacent buttons with different text', () => {
    const pageSize = { width: 1440, height: 15000 };
    const sections = planSections(pageSize.width, pageSize.height);

    const deduped = dedupeAcrossSections(
      [
        {
          id: 'btn-primary',
          sectionIndex: 0,
          severity: 'warning',
          category: 'Conversion',
          current_text: 'Start Free Trial',
          pixelRect: { x: 200, y: 1600, width: 180, height: 44 },
        },
        {
          id: 'btn-secondary',
          sectionIndex: 1,
          severity: 'info',
          category: 'Conversion',
          current_text: 'Watch 2-Min Demo',
          pixelRect: { x: 392, y: 1600, width: 180, height: 44 },
        },
      ],
      pageSize,
      { sections }
    );

    assert.equal(deduped.length, 2);
    assert.equal(deduped[0].id, 'btn-primary');
    assert.equal(deduped[1].id, 'btn-secondary');
  });

  it('returns the nearest-centre section from ownerSectionIndex', () => {
    const sections = planSections(1440, 15000);
    // sec 0 centre = 900, sec 1 centre = 2430, midpoint = 1665
    assert.equal(ownerSectionIndex(0, sections), 0);
    assert.equal(ownerSectionIndex(1600, sections), 0);
    assert.equal(ownerSectionIndex(1700, sections), 1);
    assert.equal(ownerSectionIndex(15000, sections), sections[sections.length - 1].index);
    assert.equal(ownerSectionIndex(500, []), -1);
    assert.equal(ownerSectionIndex(Number.NaN, sections), -1);
  });
});
