import { cached, fetchJson } from "../lib/cache";
import { validTimestamp } from '../collection';

/** Global USD spot price for a crypto symbol. Coinbase Exchange primary, Kraken fallback. Cached 10s. */
export async function getGlobalUsdPrice(symbol: string): Promise<{ price_usd: number; source: string; source_as_of: string | null; fetched_at: string } | null> {
  const sym = symbol.toUpperCase();
  return cached(`global:${sym}`, 10_000, async () => {
    try {
      const d = await fetchJson<{ price: string; time?: string }>(
        `https://api.exchange.coinbase.com/products/${sym}-USD/ticker`,
      );
      const p = parseFloat(d.price);
      if (!isFinite(p) || p <= 0) throw new Error("bad price");
      return { price_usd: p, source: "coinbase-exchange", source_as_of: validTimestamp(d.time), fetched_at: new Date().toISOString() };
    } catch {
      try {
        const kSym = sym === "BTC" ? "XBT" : sym;
        const d = await fetchJson<{ result: Record<string, { c: [string, string] }> }>(
          `https://api.kraken.com/0/public/Ticker?pair=${kSym}USD`,
        );
        const first = Object.values(d.result ?? {})[0];
        const p = parseFloat(first?.c?.[0] ?? "");
        if (!isFinite(p) || p <= 0) throw new Error("bad price");
        return { price_usd: p, source: "kraken", source_as_of: null, fetched_at: new Date().toISOString() };
      } catch {
        return null;
      }
    }
  });
}

