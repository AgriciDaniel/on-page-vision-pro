// Prompt context and response schemas shared by the viewport routes (server.ts) and the
// full-page audit (server/pageAudit.ts). AUDIT_GOAL_CONTEXT and findingItemSchema moved here
// unchanged from server.ts; the page* schemas are new for /api/audit/page.
import { Type } from '@google/genai';
import type { AuditGoal } from '../types.ts';

export const AUDIT_GOAL_CONTEXT: Record<AuditGoal, string> = {
  general: 'General high-converting website first impression, clarity, SEO, and trust.',
  'saas-trial': 'Self-serve SaaS Free Trial / PLG signup: prioritize instant product comprehension, low-friction signup CTA, and time-to-value proof.',
  'b2b-demo': 'Enterprise B2B Demo / Sales-led funnel: prioritize authority, ROI framing, security/compliance proof, and high-intent demo CTA.',
  ecommerce: 'E-commerce / DTC product conversion: prioritize product visual appeal, price/offer clarity, shipping/returns trust, and Add-to-Cart prominence.',
  'lead-gen': 'Lead generation / agency / waitlist conversion: prioritize single-focus offer clarity, social proof, and frictionless lead capture.',
};

export const goalContext = (goal: AuditGoal) => AUDIT_GOAL_CONTEXT[goal] || AUDIT_GOAL_CONTEXT.general;

export const findingItemSchema = {
  type: Type.OBJECT,
  properties: {
    current_text: { type: Type.STRING, description: 'Exact visible text or N/A for visual elements.' },
    visual_description: { type: Type.STRING, description: 'Short visual descriptor of the element.' },
    context: { type: Type.STRING, description: 'Role on page, e.g. Hero Headline, Primary CTA, Navigation Bar, Trust Proof.' },
    seo_analysis: { type: Type.STRING, description: 'Concise diagnostic of what is weak, unclear, or suboptimal.' },
    suggested_optimization: { type: Type.STRING, description: 'Specific, actionable fix including rewrite or design adjustment.' },
    severity: { type: Type.STRING, enum: ['critical', 'warning', 'info'] },
    category: { type: Type.STRING, description: 'Clarity, Conversion, Visual Hierarchy, Trust & E-E-A-T, Accessibility, Navigation, or On-Page SEO.' },
    impact_score: { type: Type.NUMBER, description: '0-100 estimated conversion/UX lift if resolved.' },
    effort_estimate: { type: Type.STRING, enum: ['quick-win', 'medium', 'complex'] },
    technical_details: { type: Type.STRING, description: 'Specific measurements, e.g. Estimated contrast 2.8:1, tap target ~34px, H1 length 14 words.' },
    standards_violated: { type: Type.ARRAY, items: { type: Type.STRING } },
    element_type: {
      type: Type.STRING,
      enum: ['heading', 'button', 'link', 'image', 'form', 'text', 'navigation', 'footer', 'abstract'],
    },
    box_2d: {
      type: Type.ARRAY,
      items: { type: Type.NUMBER },
      description: 'Tight bounding box [ymin, xmin, ymax, xmax] on 0-1000 scale relative to the image. Use [0,0,0,0] only for abstract.',
    },
    box_confidence: { type: Type.STRING, enum: ['high', 'medium', 'low'] },
  },
  required: [
    'current_text',
    'visual_description',
    'context',
    'seo_analysis',
    'suggested_optimization',
    'severity',
    'category',
    'impact_score',
    'effort_estimate',
    'element_type',
    'box_2d',
  ],
};

// ---- full-page audit schemas ------------------------------------------------------------------

const scoresSchema = {
  type: Type.OBJECT,
  properties: {
    clarity: { type: Type.NUMBER, description: 'Content & Value Proposition Clarity across the whole page (0-100)' },
    visual_hierarchy: { type: Type.NUMBER, description: 'Visual Hierarchy & Polish across the whole page (0-100)' },
    conversion: { type: Type.NUMBER, description: 'Conversion & CTA Effectiveness across the whole page (0-100)' },
    trust_eeat: { type: Type.NUMBER, description: 'Trust Signals & E-E-A-T Credibility across the whole page (0-100)' },
  },
  required: ['clarity', 'visual_hierarchy', 'conversion', 'trust_eeat'],
};

/** Overview call: one small picture of the whole page; narrative, scores and section labels. */
export const pageOverviewSchema = {
  type: Type.OBJECT,
  properties: {
    overall_summary: {
      type: Type.STRING,
      description: 'Executive summary of the whole page: story flow from top to bottom, messaging clarity, and conversion readiness.',
    },
    strategic_advisor: {
      type: Type.STRING,
      description: 'Actionable 3-paragraph growth roadmap for the whole page, prioritized by highest conversion ROI.',
    },
    scores: scoresSchema,
    section_labels: {
      type: Type.ARRAY,
      description: 'One short label per listed section, in order, naming what the section mainly contains (e.g. Hero, Social proof, Pricing, FAQ, Footer).',
      items: {
        type: Type.OBJECT,
        properties: {
          index: { type: Type.NUMBER },
          label: { type: Type.STRING },
        },
        required: ['index', 'label'],
      },
    },
    top_priorities: {
      type: Type.ARRAY,
      description: 'The 3 to 5 findings to fix first, ranked, each referenced by its id from the findings list (F1, F2, ...).',
      items: {
        type: Type.OBJECT,
        properties: {
          finding: { type: Type.STRING, description: 'Finding id exactly as listed, e.g. F7.' },
          rank: { type: Type.NUMBER, description: '1 = fix first.' },
          reason: { type: Type.STRING, description: 'One line: why this comes first.' },
          blocker: { type: Type.BOOLEAN, description: 'True only if it blocks the primary conversion, comprehension of the offer, or indexing.' },
        },
        required: ['finding', 'rank', 'reason', 'blocker'],
      },
    },
    drop: {
      type: Type.ARRAY,
      description: 'Ids of low-value findings to leave out (minor polish, or a finding that repeats another in other words). Never a blocker or a top priority. May be empty.',
      items: { type: Type.STRING, description: 'Finding id exactly as listed, e.g. F12.' },
    },
  },
  required: ['overall_summary', 'strategic_advisor', 'scores', 'section_labels', 'top_priorities', 'drop'],
};

/** Every section after the first: findings only. */
export const pageSectionSchema = {
  type: Type.OBJECT,
  properties: {
    items: { type: Type.ARRAY, items: findingItemSchema },
  },
  required: ['items'],
};

/** The first section also carries the first impression test and the gaze hotspots. */
export const pageFirstSectionSchema = {
  type: Type.OBJECT,
  properties: {
    items: { type: Type.ARRAY, items: findingItemSchema },
    first_impression_test: {
      type: Type.OBJECT,
      description: '5-Second First Impression Test verdict for the first screen, simulating a cold first-time visitor.',
      properties: {
        passes_5s_test: { type: Type.BOOLEAN, description: 'True if a cold visitor grasps What it is, Who it is for, and What to click from the first screen in under 5 seconds.' },
        visitor_understands: { type: Type.STRING, description: '1 crisp sentence stating what a cold visitor takes away in 5 seconds.' },
        primary_distraction: { type: Type.STRING, description: '1 crisp sentence naming what pulls eyes away from the primary CTA or creates hesitation.' },
        single_biggest_lift: { type: Type.STRING, description: 'The #1 highest-ROI change to make on the first screen.' },
      },
      required: ['passes_5s_test', 'visitor_understands', 'primary_distraction', 'single_biggest_lift'],
    },
    attention_hotspots: {
      type: Type.ARRAY,
      description: '4 to 6 predicted 3-second eye-tracking fixation points on the first screen, ordered by gaze rank 1..6.',
      items: {
        type: Type.OBJECT,
        properties: {
          x: { type: Type.NUMBER, description: '0-1000 horizontal center of fixation in this image' },
          y: { type: Type.NUMBER, description: '0-1000 vertical center of fixation in this image' },
          radius: { type: Type.NUMBER, description: '60-180 attention radius on a 0-1000 scale of the image WIDTH' },
          intensity: { type: Type.NUMBER, description: '30-100 visual pull strength' },
          rank: { type: Type.NUMBER, description: '1 = first eye fixation, 2 = second, etc.' },
          label: { type: Type.STRING, description: 'Short label of what pulls attention here (e.g. Hero Headline, Primary CTA)' },
        },
        required: ['x', 'y', 'radius', 'intensity', 'rank', 'label'],
      },
    },
  },
  required: ['items', 'first_impression_test', 'attention_hotspots'],
};
