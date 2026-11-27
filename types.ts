export type SeverityLevel = 'critical' | 'warning' | 'info';
export type EffortLevel = 'quick-win' | 'medium' | 'complex';
export type ViewportKey = 'desktop' | 'mobile';
export type WorkspaceTab = 'canvas' | 'compare' | 'serp' | 'chat' | 'report';
export type AuditGoal = 'general' | 'saas-trial' | 'b2b-demo' | 'ecommerce' | 'lead-gen';

export interface HeadingNode {
  level: number;
  text: string;
}

export interface ContrastFailureSample {
  text: string;
  ratio: number;
  required: number;
  fg: string;
  bg: string;
}

export interface LabCwvMetrics {
  ttfbMs: number | null;
  fcpMs: number | null;
  lcpMs: number | null;
  cls: number | null;
  domNodes: number;
  transferKb: number | null;
  blockedRequests: number;
}

export interface AiBotAccess {
  bot: string;
  allowed: boolean | null;
}

export interface OriginSignals {
  robotsTxtPresent: boolean;
  robotsTxtStatus: number | null;
  sitemapCount: number;
  aiBots: AiBotAccess[];
  llmsTxtPresent: boolean;
  llmsTxtStatus: number | null;
  llmsTxtBytes?: number;
}

export interface PageTelemetry {
  collectedAt: string;
  /** True when rendered DOM carries substantially more copy/headings than raw SSR HTML. */
  spaHydratedDiff: boolean;
  renderedWordCount: number;
  renderedH1Count: number;
  lang: string | null;
  brokenImages: number;
  headingOrderIssues: string[];
  jsonLdErrors: number;
  formFieldCount: number;
  unlabelledInputs: number;
  missingLandmarks: string[];
  bodyFontPx: number | null;
  horizontalOverflow: boolean;
  /** Desktop/primary tap targets under 24x24 px (WCAG 2.2 SC 2.5.8). */
  smallTapTargets24: number;
  /** Mobile tap targets under 44x44 px (or primary viewport when mobile missing). */
  smallTapTargets44: number;
  mobileHorizontalOverflow?: boolean;
  mobileBodyFontPx?: number | null;
  mobileSmallTapTargets24?: number;
  mobileSmallTapTargets44?: number;
  contrastFailures: ContrastFailureSample[];
  contrastUnresolvedCount: number;
  cwv?: LabCwvMetrics;
  origin?: OriginSignals;
  headers?: {
    xRobotsTag?: string;
    hsts?: boolean;
    csp?: boolean;
  };
  finalUrl?: string;
}

export interface SeoMetadata {
  url?: string;
  title: string;
  description: string;
  canonical?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  viewportMeta?: string;
  robotsMeta?: string;
  schemaTypes?: string[];
  headingTree?: HeadingNode[];
  h1s: string[];
  h2s: string[];
  totalImages: number;
  missingAltImages: number;
  ctaTexts: string[];
  wordCount: number;
  textPreview: string;
  telemetry?: PageTelemetry;
}

export interface AttentionHotspot {
  x: number; // 0-1000 horizontal center
  y: number; // 0-1000 vertical center
  radius: number; // 40-220 spread on 0-1000 scale
  intensity: number; // 0-100 fixation strength
  rank: number; // 1 = first gaze fixation
  label: string;
}

export interface CodeFixPatch {
  language: string;
  title: string;
  code: string;
  notes: string;
  ticket_markdown: string;
}

export interface AuditFinding {
  id: string;
  viewport: ViewportKey;
  current_text: string;
  visual_description: string;
  context: string;
  seo_analysis: string;
  suggested_optimization: string;
  severity: SeverityLevel;
  category: string;
  impact_score: number;
  effort_estimate: EffortLevel;
  technical_details?: string;
  standards_violated?: string[];
  element_type: 'heading' | 'button' | 'link' | 'image' | 'form' | 'text' | 'navigation' | 'footer' | 'abstract';
  box_2d?: [number, number, number, number];
  box_confidence?: 'high' | 'medium' | 'low';
  /** Full-page audits: the box in image pixels [y0, x0, y1, x1]. Preferred over box_2d when present. */
  box_px?: [number, number, number, number];
  /** Full-page audits: index into ViewportAudit.sections of the section the finding came from. */
  section_index?: number;
}

export interface ViewportScores {
  clarity: number;
  visual_hierarchy: number;
  conversion: number;
  trust_eeat: number;
  overall: number;
}

export interface FirstImpressionTest {
  passes_5s_test: boolean;
  visitor_understands: string;
  primary_distraction: string;
  single_biggest_lift: string;
}

export interface ViewportAudit {
  overall_summary: string;
  strategic_advisor: string;
  first_impression_test?: FirstImpressionTest;
  scores: ViewportScores;
  items: AuditFinding[];
  attention_hotspots?: AttentionHotspot[];
  quick_wins: {
    count: number;
    estimated_impact: number;
    top_3: string[];
  };
  critical_count: number;
  warning_count: number;
  info_count: number;
  model_used?: string;
  /** Set by /api/audit/page. Missing means a viewport audit. */
  mode?: CaptureMode;
  /** Size of the image the audit was run on, in px (full-page audits). */
  image?: { width: number; height: number };
  /** Full-page audits: the overlapping slices the page was audited in, in image px. */
  sections?: PageSectionInfo[];
  /** Full-page audits: sections that failed or were skipped. The rest of the audit still stands. */
  warnings?: string[];
  /** Full-page audits: model calls, retries and time, for cost and speed tracking. */
  stats?: PageAuditStats;
  /** Full-page audits: the 3 to 5 findings to fix first, ranked by the page-level review. */
  top_priorities?: TopPriority[];
  /**
   * Full-page audits: findings left out of `items` only because of the cap (MAX_PAGE_FINDINGS),
   * same shape, mapped and cleaned like `items`, highest severity and impact first. Never
   * counted in the severity counts or scores; never holds findings the overview dropped as low
   * value or repeats. Empty when nothing was cut. For a "show N more" on request.
   */
  omitted_items?: AuditFinding[];
}

/** One section's state in a running full-page audit. */
export type SectionProgressState = 'queued' | 'running' | 'retrying' | 'done' | 'failed';

/** GET /api/audit/progress/:id while POST /api/audit/page (with that progressId) runs. */
export interface PageAuditProgress {
  id: string;
  /** 'done' or 'failed' once the POST has its answer. */
  status: 'running' | 'done' | 'failed';
  /** preparing: before sections are planned; sections: section calls; overview: the page-level call. */
  stage: 'preparing' | 'sections' | 'overview' | 'done';
  sections: {
    total: number;
    done: number;
    failed: number;
    /** 0-based indexes (as in ViewportAudit.sections[].index) running or retrying right now. */
    running: number[];
    /** One state per section, in page order. */
    states: SectionProgressState[];
  };
  /** Section retries so far, including same-model waits after a 429 (rate limited). */
  retries: number;
  overview: 'pending' | 'running' | 'done' | 'failed';
  elapsedMs: number;
  updatedAt: string;
  /** Set when status is 'failed'. */
  error?: string;
}

/** Events auditPage reports while it runs (server side; the client reads PageAuditProgress). */
export type PageAuditProgressEvent =
  | { type: 'plan'; total: number }
  | { type: 'section-start'; index: number }
  | { type: 'section-retry'; index: number }
  | { type: 'section-end'; index: number; ok: boolean }
  | { type: 'overview-start' }
  | { type: 'overview-end'; ok: boolean }
  | { type: 'finished'; ok: boolean; error?: string };

export interface TopPriority {
  /** The `id` of a finding in `items`. */
  finding_id: string;
  /** 1 = fix first. */
  rank: number;
  /** One line: why this comes first. */
  reason: string;
  /** True when it blocks the primary conversion, comprehension of the offer, or indexing. Only these findings are critical. */
  blocker: boolean;
}

export interface TokenUsage {
  prompt: number;
  output: number;
  thinking: number;
  total: number;
}

export interface PageAuditStats {
  /** Every model request sent, including fallback attempts and retries. */
  calls: number;
  /** Sections that were tried a second time after a timeout or a server error. */
  retries: number;
  /** Same-model retries after a 429 (rate limited), sections and overview together. */
  rateLimitRetries?: number;
  thinkingLevel: string;
  /** Page-audit model calls allowed in flight at once (GEMINI_PAGE_AUDIT_CONCURRENCY). */
  concurrency: number;
  /** 'process': one limit shared by every audit running (the default); 'audit': this audit's own. */
  concurrencyScope?: 'process' | 'audit';
  /** Section height in image px for this viewport, before the 16-section cap stretches it. */
  sectionHeight?: number;
  totalMs: number;
  /** Summed over every answered request; absent when the model reported no usage. */
  tokens?: TokenUsage;
  /** ms: from getting a call slot to the answer; waitMs: time waiting for a slot before that. */
  sections: { index: number; attempts: number; retried: boolean; ok: boolean; ms: number; waitMs?: number; tokens?: TokenUsage }[];
  overview: { attempts: number; ok: boolean; ms: number; waitMs?: number; tokens?: TokenUsage };
  /**
   * How many findings the sections found and how many came back in `items`. The rest were
   * dropped by the page-level review as low value (minor polish, or repeating another finding)
   * or left out past the cap. Blockers are never dropped or capped.
   */
  findings?: { found: number; returned: number; droppedLowValue: number; omittedOverCap: number; cap: number };
}

/** One audited slice of a full-page image. yStart and yEnd are image px. */
export interface PageSectionInfo {
  index: number;
  yStart: number;
  yEnd: number;
  label: string;
}

export interface CanvasOverlay {
  id: string;
  base64: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  prompt: string;
}

export type CaptureMode = 'viewport' | 'fullpage';

export type CaptureProvider = 'playwright' | 'microlink' | 'thum.io' | 'mshots';

/** What the capture service reported for one screenshot, before the client scaled it. */
export interface CaptureInfo {
  width: number;
  height: number;
  provider: CaptureProvider;
  /** Wave 2 capture fields, in image px. */
  captureMode?: CaptureMode;
  foldPx?: number;
  /** True when a full page was cut at the height cap. */
  truncated?: boolean;
}

export interface ViewportData {
  screenshotDataUrl: string;
  /** Size of the browser viewport the shot represents (CSS px), e.g. 1440x900. Not the image size. */
  width: number;
  height: number;
  analysis: ViewportAudit | null;
  overlays: CanvasOverlay[];
  /** Real pixel size of screenshotDataUrl. Missing on sessions saved before wave 1. */
  naturalWidth?: number;
  naturalHeight?: number;
  /** Whether the image is one viewport or the whole page. Missing means 'viewport'. */
  captureMode?: CaptureMode;
  /** Fold position in image pixels (the bottom of the first screen). */
  foldPx?: number;
  /** Set for URL captures: the service that took the shot and its original size. */
  capture?: CaptureInfo;
}

export interface ParityIssue {
  title: string;
  severity: SeverityLevel;
  desktop_behavior: string;
  mobile_behavior: string;
  recommended_fix: string;
}

export interface ComparisonSummary {
  parity_score: number;
  executive_verdict: string;
  above_the_fold_delta: string;
  tap_target_verdict: string;
  parity_issues: ParityIssue[];
  generated_at: string;
}

export interface HeroRedesignItem {
  id: string;
  viewport: ViewportKey;
  /** Optional for newer saves (the viewport screenshot is reused to save IndexedDB quota). */
  originalDataUrl?: string;
  redesignedDataUrl: string;
  prompt: string;
  modelUsed?: string;
  createdAt: string;
}

export interface SerpCompetitor {
  name: string;
  url: string;
  value_prop_hook: string;
  strength: string;
  opportunity_gap: string;
  /** True when the competitor host matches a grounded search source (title domain or URI host). */
  grounded_domain_match?: boolean;
  capturedScreenshot?: string | null;
  /** Provider and size of capturedScreenshot. */
  capturedInfo?: CaptureInfo;
}

export interface GroundingSource {
  title: string;
  uri: string;
}

export interface SerpResearchResult {
  niche_summary: string;
  positioning_verdict: string;
  search_intent?: string;
  competitors: SerpCompetitor[];
  keyword_opportunities: string[];
  eeat_gaps: string[];
  ai_overview_geo_gaps?: string[];
  quick_differentiators: string[];
  web_search_queries?: string[];
  search_entry_point_html?: string;
  sources: GroundingSource[];
  generated_at: string;
}

export interface CopyVariant {
  id: string;
  angle: string;
  headline: string;
  subheadline: string;
  primary_cta: string;
  secondary_cta?: string;
  rationale: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface AudioBriefing {
  script: string;
  audioDataUrl: string;
  voice: 'Kore' | 'Charon';
  generatedAt: string;
}

export interface AuditSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  sourceType: 'url' | 'upload';
  url: string;
  domain: string;
  pageTitle: string;
  auditGoal?: AuditGoal;
  targetKeyword?: string;
  resolvedFindingIds?: string[];
  codeFixes?: Record<string, CodeFixPatch>;
  seoMetadata: SeoMetadata;
  viewports: {
    desktop: ViewportData | null;
    mobile: ViewportData | null;
  };
  comparison: ComparisonSummary | null;
  heroRedesigns: HeroRedesignItem[];
  serpResearch: SerpResearchResult | null;
  copyVariants: CopyVariant[];
  chatHistory: ChatMessage[];
  audioBriefing: AudioBriefing | null;
}

export interface AuditHistoryHeader {
  id: string;
  createdAt: string;
  domain: string;
  url: string;
  pageTitle: string;
  sourceType: 'url' | 'upload';
  desktopScore: number | null;
  mobileScore: number | null;
  criticalCount: number;
  thumbnailDataUrl: string;
}

export interface ToastNotice {
  id: string;
  type: 'info' | 'success' | 'error';
  message: string;
}

export type CaptureStage =
  | 'idle'
  | 'capturing'
  | 'auditing-desktop'
  | 'auditing-mobile'
  | 'comparing'
  | 'ready'
  | 'error';