import { parse } from "node-html-parser";

/**
 * Korean sell-side research listings from Hankyung Consensus.
 *
 * What is sold downstream is deliberately narrow: the *facts* of a report
 * (ticker, target price, rating, broker, analyst, date) plus a summary written
 * in our own words, plus a link back to the publisher. The PDF is never
 * fetched, stored or redistributed here — the report itself belongs to the
 * brokerage that wrote it, and the site's own notice forbids reproduction.
 * Facts are not copyrightable; that boundary is the whole design.
 *
 * Collection is deliberately light-touch: one hourly tick, at most two listing
 * pages per tick, an honest User-Agent, and an incremental stop as soon as a
 * known report_idx appears. Nothing here crawls beyond the listing itself.
 */

const BASE = "https://consensus.hankyung.com";
/** The largest page size the listing offers, so a tick needs fewer round-trips. */
const PAGE_SIZE = 80;
const USER_AGENT =
  "k-data-x402-research/0.1 (+https://k-data-x402-production.theblack1022.workers.dev)";

export interface ResearchRow {
  /** report_idx from the site — stable natural key, and monotonic with publication. */
  report_idx: number;
  /** ISO date, KST as published. */
  published_date: string;
  category: string;
  /** 6-digit KRX code, when the report covers a single listed company. */
  ticker: string | null;
  company: string | null;
  /** Korean title as published, company/ticker prefix removed. */
  title: string;
  /** Target price in KRW (적정가격). */
  target_price: number | null;
  /** Rating exactly as printed (매수, Trading Buy, Not Rated, …). */
  rating_raw: string | null;
  /** Normalized to Buy | Hold | Sell, or null when the house scale doesn't map. */
  rating: string | null;
  analyst: string | null;
  broker: string | null;
  /** Link back to the publisher's page for this report. Attribution, not delivery. */
  source_url: string;
}

/**
 * Korean houses print ratings on several scales, and the listing mixes English
 * and Korean labels on the same page. Normalize for aggregation; `rating_raw`
 * always carries the original so a caller can second-guess this mapping.
 */
const RATINGS: Array<[RegExp, string]> = [
  [/^(strong\s*)?buy$|^매수$|^적극매수$|^outperform$|^overweight$|^trading\s*buy$/i, "Buy"],
  [/^hold$|^중립$|^보유$|^neutral$|^marketperform$|^market\s*perform$|^유지$/i, "Hold"],
  [/^sell$|^매도$|^underperform$|^underweight$|^축소$|^비중축소$/i, "Sell"],
];

function normalizeRating(raw: string | null): string | null {
  if (!raw) return null;
  const t = raw.trim();
  for (const [re, label] of RATINGS) if (re.test(t)) return label;
  return null;
}

/** "30,000" -> 30000; "-", "", "N/A" -> null. */
function parsePrice(raw: string): number | null {
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Accepts 2026-07-31 and 2026.07.31; a year-less 07.31 is read as the current KST year. */
function parseDate(raw: string): string | null {
  const t = raw.trim();
  const full = t.match(/(\d{4})[-.\/](\d{1,2})[-.\/](\d{1,2})/);
  const short = full ? null : t.match(/^(\d{1,2})[-.\/](\d{1,2})$/);
  if (!full && !short) return null;

  // These are published in Seoul, so a year-less date means the current KST year.
  const y = full ? full[1] : String(new Date(Date.now() + 9 * 3600_000).getUTCFullYear());
  const mo = full ? full[2] : short![1];
  const d = full ? full[3] : short![2];

  const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/**
 * Decodes a listing response. The site currently serves UTF-8 and says so, but
 * it is old enough to have shipped EUC-KR within living memory, and Workers'
 * `res.text()` would silently mojibake the whole page if it ever switched back.
 * Sniffing the declared charset costs nothing and removes that failure mode.
 */
export function decodeBody(buf: ArrayBuffer, contentType: string | null): string {
  const fromHeader = contentType?.match(/charset=\s*"?([\w-]+)/i)?.[1];
  let label = fromHeader;
  if (!label) {
    // Charset declarations are ASCII, so a latin1 peek at the head is safe.
    const head = new TextDecoder("latin1").decode(buf.slice(0, 1024));
    label = head.match(/charset=\s*"?([\w-]+)/i)?.[1];
  }
  try {
    return new TextDecoder(label || "utf-8").decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

/**
 * Parses one listing page into rows. Pure, and never throws: a markup change
 * upstream should pause the archive with an empty result the caller can alarm
 * on, not take down a paid endpoint. Malformed individual rows are skipped.
 */
export function parseListingHtml(html: string, category: string): ResearchRow[] {
  const rows: ResearchRow[] = [];
  let doc;
  try {
    doc = parse(html);
  } catch {
    return rows;
  }

  for (const tr of doc.querySelectorAll("tbody tr")) {
    try {
      const tds = tr.querySelectorAll("td");
      // 작성일 · 제목 · 적정가격 · 투자의견 · 작성자 · 제공출처 · 기업정보 · 차트 · 첨부파일
      if (tds.length < 6) continue;

      const link = tds[1].querySelector("a[href*='downpdf']");
      const idx = link?.getAttribute("href")?.match(/report_idx=(\d+)/)?.[1];
      if (!idx) continue;

      const published_date = parseDate(tds[0].text);
      if (!published_date) continue;

      // "HMM(011200) 2Q26 Preview: …" — the code is also in the chart link, which
      // is the fallback for titles that don't carry it.
      const rawTitle = link!.text.replace(/\s+/g, " ").trim();
      const titled = rawTitle.match(/^(.*?)\((\d{6})\)\s*(.*)$/);
      const ticker =
        titled?.[2] ?? tr.innerHTML.match(/(?:business_code|stockcd)=(\d{6})/)?.[1] ?? null;
      const company = titled?.[1]?.trim() || null;
      const title = (titled?.[3] || rawTitle).trim();
      if (!title) continue;

      const rating_raw = tds[3].text.replace(/\s+/g, " ").trim() || null;

      rows.push({
        report_idx: parseInt(idx, 10),
        published_date,
        category,
        ticker,
        company,
        title,
        target_price: parsePrice(tds[2].text),
        rating_raw,
        rating: normalizeRating(rating_raw),
        analyst: tds[4].text.replace(/\s+/g, " ").trim() || null,
        broker: tds[5].text.replace(/\s+/g, " ").trim() || null,
        source_url: `${BASE}/analysis/downpdf?report_idx=${idx}`,
      });
    } catch {
      // One bad row must not cost the other 79.
    }
  }
  return rows;
}

/** Fetches and parses a single listing page. Throws on transport/HTTP failure. */
export async function fetchListingPage(page: number, category = "business"): Promise<ResearchRow[]> {
  const url = `${BASE}/analysis/list?skinType=${category}&pagenum=${PAGE_SIZE}&now_page=${page}`;
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const html = decodeBody(await res.arrayBuffer(), res.headers.get("content-type"));
  return parseListingHtml(html, category);
}

/**
 * Reports published since `maxKnownIdx`, newest first.
 *
 * Page 2 is only requested when every row on page 1 was new — i.e. the backlog
 * genuinely overflows one page. In the steady hourly state this makes exactly
 * one request per tick, which is the point.
 */
export async function fetchNewReports(
  maxKnownIdx: number,
  maxPages = 2,
  category = "business",
): Promise<ResearchRow[]> {
  const out: ResearchRow[] = [];
  for (let page = 1; page <= maxPages; page++) {
    let rows: ResearchRow[];
    try {
      rows = await fetchListingPage(page, category);
    } catch {
      break; // Degrade to what we already have; the next tick retries.
    }
    if (rows.length === 0) break;
    const fresh = rows.filter(r => r.report_idx > maxKnownIdx);
    out.push(...fresh);
    if (fresh.length < rows.length) break; // Reached known ground.
  }
  return out;
}
