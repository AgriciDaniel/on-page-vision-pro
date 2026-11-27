import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  linkAcrossViewports,
  type CrossViewportSide,
} from '../../lib/crossViewport.ts';

// Hand-labeled ground truth from .agent/results/final-run/vision-pro-audit-agricidaniel.com-1795517074319.json
// (38 desktop findings, 75 mobile findings).
const REAL_TRUE_PAIRS: ReadonlyArray<readonly [string, string, string]> = [
  ['desktop-1795516676683-0-uxa4', 'mobile-1795516681898-0-n9qb', 'Hero H1: M A K E A I U S E F U L .'],
  ['desktop-1795516676683-1-8ye6', 'mobile-1795516681898-1-bx9c', 'Hero CTA: Join the Pro Hub'],
  ['desktop-1795516676683-3-204r', 'mobile-1795516681898-3-c1bj', 'Above-the-fold trust proof stats'],
  ['desktop-1795516688607-0-ay7w', 'mobile-1795516675127-0-4c0q', 'Trust Proof Chart (N/A visual)'],
  ['desktop-1795516688607-1-n006', 'mobile-1795516675127-3-kkgb', 'Heading: Built to be useful. Open by default.'],
  ['desktop-1795516692307-3-gju2', 'mobile-1795516805178-1-zjj2', 'Secondary repo list (banana-claude..youtubepro)'],
  ['desktop-1795516692307-4-k6zm', 'mobile-1795516805178-3-07ne', 'Heading: Follow the curiosity.'],
  ['desktop-1795516743751-2-zw29', 'mobile-1795516858991-1-nhyp', 'Heading: Good things happen with your people.'],
  ['desktop-1795516737160-3-ubau', 'mobile-1795516924183-3-qo94', 'YouTube CTA: FIND ME ON YOUTUBE'],
  ['desktop-1795516737160-2-4kgm', 'mobile-1795516924183-2-9gl3', 'Video heading: I spent $21,455 and 1,200 hours...'],
  ['desktop-1795516744926-0-mi4z', 'mobile-1795516965119-0-l96q', 'Field Notes: Claude Obsidian v3'],
  ['desktop-1795516744926-1-q0ap', 'mobile-1795516965119-1-vioo', 'Featured note: Claude Code for Marketing (17 Roles, 139 Skills)'],
  ['desktop-1795516744926-2-40hm', 'mobile-1795516988665-3-usir', 'FAQ Accordion'],
  ['desktop-1795516744926-3-ra4l', 'mobile-1795516965119-2-wmnt', 'FAQ Heading: Curious? Good.'],
  ['desktop-1795516951395-0-m2md', 'mobile-1795516988665-0-fkb9', 'Closing CTA: Find your starting point'],
  ['desktop-1795516951395-3-rxk6', 'mobile-1795516987228-2-ehy8', 'Footer Navigation'],
  ['desktop-1795516951395-2-1js9', 'mobile-1795516987228-1-y3vc', 'Footer Search: Find a build note...'],
  ['desktop-1795516688607-5-hqr5', 'mobile-1795516675127-4-8rqn', 'Trust Proof Metrics (57.9K clicks / 1.11M impressions)'],
  ['desktop-1795516692307-2-3lms', 'mobile-1795516805178-4-qgng', 'Trust Proof Bar (67K+ stars, 65+ repos, 6,200+ members)'],
  ['desktop-1795516743751-3-1348', 'mobile-1795516901729-1-9w0c', 'Free Community CTA: Come say hello'],
  ['desktop-1795516744926-4-45fg', 'mobile-1795516939231-3-ygur', 'CTA: Read all 50 notes'],
  ['desktop-1795516951395-5-2sko', 'mobile-1795516988665-4-s48r', "Closing Headline: Let's make something useful."],
  ['desktop-1795516951395-4-grlj', 'mobile-1795516987228-3-kw0h', 'Footer Legal Links'],
];

const REAL_NON_PAIRS: ReadonlyArray<readonly [string, string, string]> = [
  ['desktop-1795516676683-4-y5oe', 'mobile-1795516675127-0-4c0q', 'Both N/A + Accessibility, unrelated'],
  ['desktop-1795516676683-4-y5oe', 'mobile-1795516867823-3-blqn', 'Both N/A, unrelated'],
  ['desktop-1795516692307-0-ibgs', 'mobile-1795516675127-0-4c0q', 'Both N/A visual boxes, different sections'],
  ['desktop-1795516688607-1-n006', 'mobile-1795516939231-2-41i8', 'Same title Section Heading, different text'],
  ['desktop-1795516688607-1-n006', 'mobile-1795516924183-5-cv1c', 'Same title Section Heading, different text'],
  ['desktop-1795516676683-1-8ye6', 'mobile-1795516917488-1-m0pq', 'Both critical Conversion CTAs, different buttons'],
  ['desktop-1795516676683-3-204r', 'mobile-1795516805178-4-qgng', 'Hero stats vs mid-page authority grid'],
  ['desktop-1795516737160-0-7zh4', 'mobile-1795516867823-5-ge4p', 'Both generic Trust Proof, unrelated'],
  ['desktop-1795516951395-0-m2md', 'mobile-1795516901729-3-92bs', 'Closing CTA vs Free Tier block mentioning same phrase'],
  ['desktop-1795516951395-2-1js9', 'mobile-1795516924183-4-vgux', 'Footer search vs READ THE BUILD NOTE CTA'],
  ['desktop-1795516743751-3-1348', 'mobile-1795516681898-1-bx9c', 'Different Conversion CTAs'],
  ['desktop-1795516688607-2-tefm', 'mobile-1795516753604-0-6lmj', 'Project cards vs terminal slash commands'],
  ['desktop-1795516737160-4-76ci', 'mobile-1795516924183-3-qo94', 'YouTube privacy note vs YouTube CTA'],
  ['desktop-1795516688607-4-nkd7', 'mobile-1795516987228-4-nz28', 'Workspace header vs Footer brand summary'],
];

// Held-out evaluation set: the 8 lowest-scoring pairs from the initial 0.52 run,
// each read in full and labeled strictly (only 'same_element' counts as a valid link).
type HeldOutLabel = 'same_element' | 'same_issue_different_element' | 'unrelated';

const HELD_OUT_BOTTOM_8: ReadonlyArray<readonly [string, string, HeldOutLabel, string]> = [
  ['desktop-1795516743751-1-xoul', 'mobile-1795516901729-0-gbac', 'same_issue_different_element', '2-thumbnail comparison vs Pro-only banner'],
  ['desktop-1795516743751-0-675e', 'mobile-1795516901729-2-ktid', 'same_issue_different_element', 'Full Pro offer+CTA vs bullets-only list'],
  ['desktop-1795516737160-3-ubau', 'mobile-1795516924183-3-qo94', 'same_element', 'FIND ME ON YOUTUBE link'],
  ['desktop-1795516951395-1-gh4j', 'mobile-1795516988665-1-hwyi', 'same_issue_different_element', 'Single Pro pill vs 3-button row'],
  ['desktop-1795516692307-3-gju2', 'mobile-1795516805178-1-zjj2', 'same_element', '6 tilted repo pills (banana-claude..youtubepro)'],
  ['desktop-1795516692307-1-yzoi', 'mobile-1795516753604-5-z6q6', 'same_issue_different_element', 'Whole terminal widget vs /seo output block'],
  ['desktop-1795516676683-2-m7u7', 'mobile-1795516669813-1-x4d8', 'same_issue_different_element', 'Whole Hero Polaroid+stickers vs bottom caption'],
  ['desktop-1795516688607-0-ay7w', 'mobile-1795516675127-0-4c0q', 'same_element', 'Trust Proof Chart (N/A GSC screenshot)'],
];

describe('lib/crossViewport', () => {
  it('handles empty sides and one-side-only audits cleanly', () => {
    const empty = linkAcrossViewports({ items: [] }, { items: [] });
    assert.deepEqual(empty, { pairs: [], unmatchedDesktopIds: [], unmatchedMobileIds: [] });

    const desktopOnly = linkAcrossViewports(
      {
        items: [
          {
            id: 'd-1',
            context: 'Hero CTA',
            category: 'Conversion',
            current_text: 'Start Free Trial',
            severity: 'critical',
          },
        ],
      },
      null
    );
    assert.deepEqual(desktopOnly.pairs, []);
    assert.deepEqual(desktopOnly.unmatchedDesktopIds, ['d-1']);
    assert.deepEqual(desktopOnly.unmatchedMobileIds, []);

    const mobileOnly = linkAcrossViewports(undefined, {
      items: [
        {
          id: 'm-1',
          context: 'Hero CTA',
          category: 'Conversion',
          current_text: 'Start Free Trial',
          severity: 'critical',
        },
      ],
    });
    assert.deepEqual(mobileOnly.pairs, []);
    assert.deepEqual(mobileOnly.unmatchedDesktopIds, []);
    assert.deepEqual(mobileOnly.unmatchedMobileIds, ['m-1']);
  });

  it('links viewport-mode audits without sections or box_px using text, title, and box_2d', () => {
    const desktop: CrossViewportSide = {
      items: [
        {
          id: 'd-hero',
          context: 'Hero Primary Button',
          category: 'Conversion',
          current_text: 'Book a Demo',
          severity: 'critical',
          box_2d: [500, 100, 580, 400],
        },
      ],
      image: { width: 1440, height: 900 },
    };
    const mobile: CrossViewportSide = {
      items: [
        {
          id: 'm-hero',
          context: 'Primary CTA',
          category: 'Conversion',
          current_text: 'Book a Demo ↗',
          severity: 'critical',
          box_2d: [540, 80, 620, 720],
        },
      ],
      image: { width: 390, height: 844 },
    };

    const res = linkAcrossViewports(desktop, mobile);
    assert.equal(res.pairs.length, 1);
    assert.equal(res.pairs[0].desktopId, 'd-hero');
    assert.equal(res.pairs[0].mobileId, 'm-hero');
    assert.ok(res.pairs[0].reasons.includes('exact_text'));
    assert.deepEqual(res.unmatchedDesktopIds, []);
    assert.deepEqual(res.unmatchedMobileIds, []);
  });

  it('refuses to link findings with identical titles and categories when quoted text differs', () => {
    const desktop: CrossViewportSide = {
      items: [
        {
          id: 'd-h2',
          context: 'Section Heading',
          category: 'On-Page SEO',
          current_text: 'Built to be useful. Open by default.',
          severity: 'warning',
          box_px: [2275, 82, 2426, 662],
          section_index: 1,
        },
      ],
      image: { width: 1440, height: 10539 },
      sections: [{ index: 1, yStart: 1530, yEnd: 3330, label: 'Proof & Workspace' }],
    };
    const mobile: CrossViewportSide = {
      items: [
        {
          id: 'm-h2',
          context: 'Section Heading',
          category: 'On-Page SEO',
          current_text: 'Notes from the workbench.',
          severity: 'warning',
          box_px: [6000, 32, 6130, 400],
          section_index: 1,
        },
      ],
      image: { width: 780, height: 28058 },
      sections: [{ index: 1, yStart: 5000, yEnd: 7000, label: 'Proof & Workspace' }],
    };

    const res = linkAcrossViewports(desktop, mobile);
    assert.equal(res.pairs.length, 0);
    assert.deepEqual(res.unmatchedDesktopIds, ['d-h2']);
    assert.deepEqual(res.unmatchedMobileIds, ['m-h2']);
  });

  it('enforces one-to-one matching deterministically (best score wins)', () => {
    const desktop: CrossViewportSide = {
      items: [
        {
          id: 'd-1',
          context: 'Closing CTA',
          category: 'Conversion',
          current_text: 'Find your starting point',
          severity: 'warning',
        },
      ],
    };
    const mobile: CrossViewportSide = {
      items: [
        {
          id: 'm-weak',
          context: 'Free Tier Block',
          category: 'Visual Hierarchy',
          current_text: 'Find your starting point and compare workflows with other builders',
          severity: 'info',
        },
        {
          id: 'm-exact',
          context: 'Primary Closing CTA',
          category: 'Conversion',
          current_text: 'Find your starting point ↗',
          severity: 'warning',
        },
      ],
    };

    const run1 = linkAcrossViewports(desktop, mobile);
    const run2 = linkAcrossViewports(desktop, mobile);
    assert.deepEqual(run1, run2);
    assert.equal(run1.pairs.length, 1);
    assert.equal(run1.pairs[0].mobileId, 'm-exact');
    assert.deepEqual(run1.unmatchedMobileIds, ['m-weak']);
  });

  it('achieves high precision and recall on the real 38x75 agricidaniel.com audit fixture', (t) => {
    const auditPath = path.resolve(
      process.cwd(),
      '.agent/results/final-run/vision-pro-audit-agricidaniel.com-1795517074319.json'
    );
    if (!fs.existsSync(auditPath)) {
      t.skip('optional local .agent/results fixture not present in clean clone');
      return;
    }
    const raw = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
    const desktopSide: CrossViewportSide = {
      items: raw.viewports.desktop.analysis.items,
      image: raw.viewports.desktop.analysis.image,
      sections: raw.viewports.desktop.analysis.sections,
    };
    const mobileSide: CrossViewportSide = {
      items: raw.viewports.mobile.analysis.items,
      image: raw.viewports.mobile.analysis.image,
      sections: raw.viewports.mobile.analysis.sections,
    };

    const res = linkAcrossViewports(desktopSide, mobileSide);

    // Every desktop and mobile ID appears at most once across pairs + unmatched
    const pairedD = new Set(res.pairs.map((p) => p.desktopId));
    const pairedM = new Set(res.pairs.map((p) => p.mobileId));
    assert.equal(pairedD.size, res.pairs.length);
    assert.equal(pairedM.size, res.pairs.length);
    assert.equal(pairedD.size + res.unmatchedDesktopIds.length, desktopSide.items.length);
    assert.equal(pairedM.size + res.unmatchedMobileIds.length, mobileSide.items.length);

    const predictedSet = new Set(res.pairs.map((p) => `${p.desktopId}::${p.mobileId}`));

    let truePositives = 0;
    const missedTruePairs: string[] = [];
    for (const [dId, mId, label] of REAL_TRUE_PAIRS) {
      if (predictedSet.has(`${dId}::${mId}`)) {
        truePositives += 1;
      } else {
        missedTruePairs.push(`${label} (${dId} <-> ${mId})`);
      }
    }

    let falsePositives = 0;
    const hitNonPairs: string[] = [];
    for (const [dId, mId, label] of REAL_NON_PAIRS) {
      if (predictedSet.has(`${dId}::${mId}`)) {
        falsePositives += 1;
        hitNonPairs.push(`${label} (${dId} <-> ${mId})`);
      }
    }

    const precision = truePositives / Math.max(1, truePositives + falsePositives);
    const recall = truePositives / REAL_TRUE_PAIRS.length;

    // Report metrics cleanly in test diagnostic output
    console.log(
      `[real-fixture] totalPairs=${res.pairs.length} TP=${truePositives}/${REAL_TRUE_PAIRS.length} FP=${falsePositives}/${REAL_NON_PAIRS.length} precision=${(precision * 100).toFixed(1)}% recall=${(recall * 100).toFixed(1)}%`
    );
    if (missedTruePairs.length) console.log('  missed:', missedTruePairs);
    if (hitNonPairs.length) console.log('  false positives:', hitNonPairs);

    assert.equal(falsePositives, 0, `Unexpected false positives: ${hitNonPairs.join(', ')}`);
    assert.ok(precision >= 0.95, `Expected precision >= 0.95, got ${precision}`);
    assert.ok(recall >= 0.8, `Expected recall >= 0.80, got ${recall}`);

    // Held-out bottom-8 evaluation: zero wrong links may survive
    let heldOutCorrect = 0;
    let heldOutWrong = 0;
    const heldOutWrongList: string[] = [];
    const heldOutLostTrue: string[] = [];
    const heldOutTotalTrue = HELD_OUT_BOTTOM_8.filter((h) => h[2] === 'same_element').length;

    for (const [dId, mId, label, note] of HELD_OUT_BOTTOM_8) {
      const linked = predictedSet.has(`${dId}::${mId}`);
      if (linked && label === 'same_element') heldOutCorrect += 1;
      else if (linked && label !== 'same_element') {
        heldOutWrong += 1;
        heldOutWrongList.push(`${note} (${label})`);
      } else if (!linked && label === 'same_element') {
        heldOutLostTrue.push(note);
      }
    }

    const heldOutPrecision =
      heldOutCorrect + heldOutWrong > 0
        ? heldOutCorrect / (heldOutCorrect + heldOutWrong)
        : 1;
    console.log(
      `[held-out-8] linked=${heldOutCorrect + heldOutWrong} correct=${heldOutCorrect}/${heldOutTotalTrue} wrong=${heldOutWrong} precision=${(heldOutPrecision * 100).toFixed(1)}%`
    );
    if (heldOutLostTrue.length) console.log('  held-out true pairs lost:', heldOutLostTrue);

    assert.equal(heldOutWrong, 0, `Wrong links survived in held-out set: ${heldOutWrongList.join(', ')}`);
  });
});
