/**
 * Shapes the no-cost research preview. It deliberately exposes coverage facts
 * and dates, but none of the paid report list, translated titles, or summaries.
 */
export interface ResearchPreviewInput {
  ticker: string;
  company: string | null;
  reports: number;
  brokers: number;
  first_recorded: string | null;
  latest_published: string | null;
}

export function buildResearchPreview(input: ResearchPreviewInput) {
  return {
    ...input,
    coverage_note:
      input.brokers < 2
        ? "single-broker coverage; this is not a consensus"
        : "multi-broker coverage; paid consensus includes current views and revision history",
  };
}
