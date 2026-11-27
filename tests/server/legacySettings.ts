// Import this FIRST in a test file (before anything that loads server/pageAudit.ts or
// server/gemini.ts). It pins the page-audit settings to the values the file's hand-checked
// numbers were written for: 1,800 px sections, 3 at once, medium thinking. Those files test the
// mechanics (slicing, mapping, retries, prompts), not the defaults; tests/server/settings.test.ts
// checks the real defaults (desktop 1,800 px, mobile 2,400 px, 8 shared, low) with nothing pinned.
process.env.GEMINI_PAGE_SECTION_HEIGHT_DESKTOP = '1800';
process.env.GEMINI_PAGE_SECTION_HEIGHT_MOBILE = '1800';
process.env.GEMINI_PAGE_AUDIT_CONCURRENCY = '3';
process.env.GEMINI_PAGE_AUDIT_THINKING = 'medium';
