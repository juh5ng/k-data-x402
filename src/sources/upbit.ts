import { cached, fetchJson } from "../lib/cache";

const UPBIT = "https://api.upbit.com/v1";

interface UpbitMarket {
  market: string;
  korean_name: string;
  english_name: string;
}

interface UpbitTicker {
  market: string;
  trade_price: number;
  signed_change_rate: number;
  signed_change_price: number;
  acc_trade_price_24h: number;
  acc_trade_volume_24h: number;
  high_price: number;
  low_price: number;
  timestamp: number;
}

export interface KrwTicker {
  market: string;
  ticker: string;
  name_ko: string | null;
  name_en: string | null;
  price_krw: number;
  change_24h_pct: number;
  high_24h_krw: number;
  low_24h_krw: number;
  volume_24h_krw: number;
  as_of: string;
}

async function marketIndex(): Promise<Map<string, UpbitMarket>> {
  return cached("upbit:markets", 60 * 60_000, async () => {
    const list = await fetchJson<UpbitMarket[]>(`${UPBIT}/market/all`);
    return new Map(list.filter(m => m.market.startsWith("KRW-")).map(m => [m.market, m]));
  });
}

function normalize(t: UpbitTicker, names: Map<string, UpbitMarket>): KrwTicker {
  const meta = names.get(t.market);
  return {
    market: t.market,
    ticker: t.market.replace("KRW-", ""),
    name_ko: meta?.korean_name ?? null,
    name_en: meta?.english_name ?? null,
    price_krw: t.trade_price,
    change_24h_pct: +(t.signed_change_rate * 100).toFixed(3),
    high_24h_krw: t.high_price,
    low_24h_krw: t.low_price,
    volume_24h_krw: Math.round(t.acc_trade_price_24h),
    as_of: new Date(t.timestamp).toISOString(),
  };
}

/** Live KRW-market quote for one ticker symbol, e.g. "BTC". Cached 10s. */
export async function getKrwTicker(symbol: string): Promise<KrwTicker | null> {
  const sym = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!sym) return null;
  const names = await marketIndex();
  const market = `KRW-${sym}`;
  if (!names.has(market)) return null;
  return cached(`upbit:t:${market}`, 10_000, async () => {
    const [t] = await fetchJson<UpbitTicker[]>(`${UPBIT}/ticker?markets=${market}`);
    return normalize(t, names);
  });
}

/** Snapshot of all KRW markets sorted by 24h traded value. Cached 30s. */
export async function getKrwMarketsSummary(limit = 30): Promise<{
  as_of: string;
  markets_total: number;
  top_by_volume: KrwTicker[];
  top_gainers: KrwTicker[];
  top_losers: KrwTicker[];
}> {
  const all = await cached("upbit:all-tickers", 30_000, async () => {
    const names = await marketIndex();
    const codes = [...names.keys()];
    // Upbit accepts a comma-joined list; chunk to stay under URL limits.
    const out: KrwTicker[] = [];
    for (let i = 0; i < codes.length; i += 100) {
      const chunk = codes.slice(i, i + 100).join(",");
      const ticks = await fetchJson<UpbitTicker[]>(`${UPBIT}/ticker?markets=${chunk}`);
      out.push(...ticks.map(t => normalize(t, names)));
    }
    return out;
  });
  const byVolume = [...all].sort((a, b) => b.volume_24h_krw - a.volume_24h_krw);
  const byChange = [...all].sort((a, b) => b.change_24h_pct - a.change_24h_pct);
  return {
    as_of: new Date().toISOString(),
    markets_total: all.length,
    top_by_volume: byVolume.slice(0, limit),
    top_gainers: byChange.slice(0, 10),
    top_losers: byChange.slice(-10).reverse(),
  };
}
