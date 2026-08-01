import { XMLParser } from "fast-xml-parser";
import { cached } from "../lib/cache";
import { translateKoToEn } from "../lib/translate";

export type NewsCategory = "top" | "economy" | "tech" | "politics";

interface Feed {
  url: string;
  source: string;
  category: NewsCategory;
}

/** Keyless public RSS feeds from major Korean outlets. Dead feeds are skipped gracefully. */
const FEEDS: Feed[] = [
  { url: "https://www.yna.co.kr/rss/news.xml", source: "연합뉴스 (Yonhap)", category: "top" },
  { url: "https://www.yna.co.kr/rss/economy.xml", source: "연합뉴스 (Yonhap)", category: "economy" },
  { url: "https://www.yna.co.kr/rss/politics.xml", source: "연합뉴스 (Yonhap)", category: "politics" },
  { url: "https://www.mk.co.kr/rss/30000001/", source: "매일경제 (Maeil Business)", category: "top" },
  { url: "https://www.mk.co.kr/rss/50100032/", source: "매일경제 (Maeil Business)", category: "economy" },
  { url: "https://www.mk.co.kr/rss/50200011/", source: "매일경제 (Maeil Business)", category: "tech" },
  { url: "https://www.hankyung.com/feed/economy", source: "한국경제 (Hankyung)", category: "economy" },
  { url: "https://www.hankyung.com/feed/it", source: "한국경제 (Hankyung)", category: "tech" },
];

export interface NewsItem {
  /** Original Korean headline as published. */
  title: string;
  /** English translation, present only when the caller asks for it. */
  title_en?: string | null;
  link: string;
  published_at: string | null;
  source: string;
  category: NewsCategory;
}

const parser = new XMLParser({ ignoreAttributes: false });

function text(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (v && typeof v === "object" && "#text" in (v as Record<string, unknown>))
    return String((v as Record<string, unknown>)["#text"]).trim();
  return "";
}

async function fetchFeed(feed: Feed): Promise<NewsItem[]> {
  const res = await fetch(feed.url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; k-data-x402/0.1; RSS reader)",
      accept: "application/rss+xml, application/xml, text/xml, */*",
    },
  });
  if (!res.ok) throw new Error(`${feed.url} -> ${res.status}`);
  const xml = await res.text();
  const doc = parser.parse(xml);
  const rawItems = doc?.rss?.channel?.item ?? doc?.feed?.entry ?? [];
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];
  return items
    .map((it: Record<string, unknown>): NewsItem | null => {
      const title = text(it.title);
      const link =
        text(it.link) ||
        (it.link && typeof it.link === "object" ? String((it.link as Record<string, unknown>)["@_href"] ?? "") : "");
      if (!title || !link) return null;
      const pub = text(it.pubDate) || text(it.published) || text(it["dc:date"]);
      let published: string | null = null;
      if (pub) {
        const d = new Date(pub);
        if (!isNaN(d.getTime())) published = d.toISOString();
      }
      return { title, link, published_at: published, source: feed.source, category: feed.category };
    })
    .filter((x): x is NewsItem => x !== null);
}

/**
 * Aggregated Korean news headlines, newest first. Cached 5 min.
 * Pass `ai` to attach English translations to the returned slice.
 */
export async function getHeadlines(
  category?: string,
  limit = 30,
  ai?: Ai,
): Promise<{
  as_of: string;
  category: string;
  sources_ok: number;
  sources_total: number;
  translated: boolean;
  items: NewsItem[];
}> {
  const cat = (["top", "economy", "tech", "politics"] as const).find(c => c === category) ?? null;
  const feeds = cat ? FEEDS.filter(f => f.category === cat) : FEEDS;
  const all = await cached(`news:${cat ?? "all"}`, 5 * 60_000, async () => {
    const settled = await Promise.allSettled(feeds.map(fetchFeed));
    const ok = settled.filter(s => s.status === "fulfilled").length;
    const items = settled
      .flatMap(s => (s.status === "fulfilled" ? s.value : []))
      .sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""));
    // De-dup near-identical titles across feeds.
    const seen = new Set<string>();
    const deduped = items.filter(i => {
      const k = i.title.replace(/\s+/g, "");
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { ok, total: feeds.length, items: deduped };
  });
  // Translate only the slice actually returned — translating the full feed
  // would burn neurons on items the caller never sees.
  let items = all.items.slice(0, Math.min(Math.max(limit, 1), 100));
  if (ai && items.length) {
    const translations = await translateKoToEn(ai, items.map(i => i.title));
    items = items.map((item, i) => ({ ...item, title_en: translations[i] }));
  }

  return {
    as_of: new Date().toISOString(),
    category: cat ?? "all",
    sources_ok: all.ok,
    sources_total: all.total,
    translated: Boolean(ai),
    items,
  };
}
