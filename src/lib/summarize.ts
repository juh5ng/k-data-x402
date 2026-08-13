import { MODEL, expandKoreanNumerals } from "./translate";

/**
 * English summaries of Korean research reports, written from the report's
 * facts rather than its prose.
 *
 * Two constraints shape this file:
 *
 * 1. Copyright. The report body belongs to the brokerage. What is summarized
 *    here is the metadata a listing publishes — company, rating, target price,
 *    house, analyst, date, and the title's angle — restated in our own words.
 *    The prompt forbids inventing anything the caller did not supply, which
 *    keeps the output inside those facts.
 * 2. Cost placement. Unlike lib/translate.ts, nothing here is cached per
 *    request: summaries are generated once, during the cron ingest, and stored
 *    in D1. A paid request never runs a model — it reads a row. So a summary is
 *    paid for once and then sold indefinitely.
 */

export interface ReportMeta {
  company: string | null;
  ticker: string | null;
  title: string;
  target_price: number | null;
  rating: string | null;
  rating_raw: string | null;
  broker: string | null;
  analyst: string | null;
  published_date: string;
}

const SYSTEM_PROMPT = [
  "You write one-sentence English summaries of Korean sell-side equity research, for trading agents that do not read Korean.",
  "You are given only a report's metadata. Restate it in your own words.",
  "Rules:",
  "- Output ONLY the summary. 1-2 sentences, no preamble, no quotes around the whole line, no bullet points.",
  "- Name the brokerage, the rating, the company with its ticker, and the target price when each is given.",
  "- Write target prices as KRW with thousands separators, e.g. KRW 30,000.",
  "- Convey what the Korean title claims, translated, not transliterated.",
  "- Copy every number exactly as given. Never rescale, convert or round.",
  "- Write every proper noun in English. The reader does not read Hangul, so no Korean characters may appear in your output.",
  "- Brokerages: translate the house name, e.g. LS증권 -> LS Securities, 키움증권 -> Kiwoom Securities, iM증권 -> iM Securities.",
  "- Companies: use the standard English name when the company has one (삼성에스디에스 -> Samsung SDS), otherwise romanize it. Always keep the ticker.",
  "- Analysts: romanize the name literally (이재혁 -> Lee Jae-hyuk). Never substitute a different name.",
  "- State no fact that is not in the input. Do not speculate about earnings, catalysts or price moves.",
  "- Never write 'maintains', 'reiterates', 'initiates', 'raises' or 'cuts'. You are given this report's rating only, not the one before it.",
  "- Do not add investment advice or a recommendation of your own.",
].join("\n");

function buildUserMessage(meta: ReportMeta): string {
  const lines = [
    `Company: ${meta.company ?? "unspecified"}${meta.ticker ? ` (${meta.ticker})` : ""}`,
    `Brokerage: ${meta.broker ?? "unspecified"}`,
    `Analyst: ${meta.analyst ?? "unspecified"}`,
    `Rating: ${meta.rating ?? meta.rating_raw ?? "not stated"}`,
    `Target price: ${meta.target_price ? `KRW ${meta.target_price.toLocaleString("en-US")}` : "not stated"}`,
    `Published: ${meta.published_date}`,
    // Myriad units are expanded before the model sees them — see lib/translate.ts
    // for why no model is trusted to convert 억/조 itself.
    `Korean title: ${expandKoreanNumerals(meta.title)}`,
  ];
  return lines.join("\n");
}

function clean(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim().replace(/^["'“‘]|["'”’]$/g, "").trim();
  return text || null;
}

/**
 * Summarizes one report from its metadata.
 * Returns null on any failure — a missing summary should leave the row's facts
 * sellable, not abort an ingest tick partway through a batch.
 */
export async function summarizeReportMeta(ai: Ai, meta: ReportMeta): Promise<string | null> {
  try {
    const res = await ai.run(MODEL as Parameters<Ai["run"]>[0], {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserMessage(meta) },
      ],
      max_tokens: 120,
      temperature: 0,
    } as Parameters<Ai["run"]>[1]);
    return clean((res as { response?: string })?.response);
  } catch {
    return null;
  }
}
