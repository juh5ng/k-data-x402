import { cached, fetchJson } from "../lib/cache";

/** Global USD spot price for a crypto symbol. Coinbase Exchange primary, Kraken fallback. Cached 10s. */
export async function getGlobalUsdPrice(symbol: string): Promise<{ price_usd: number; source: string } | null> {
  const sym = symbol.toUpperCase();
  return cached(`global:${sym}`, 10_000, async () => {
    try {
      const d = await fetchJson<{ price: string }>(
        `https://api.exchange.coinbase.com/products/${sym}-USD/ticker`,
      );
      const p = parseFloat(d.price);
      if (!isFinite(p) || p <= 0) throw new Error("bad price");
      return { price_usd: p, source: "coinbase-exchange" };
    } catch {
      try {
        const kSym = sym === "BTC" ? "XBT" : sym;
        const d = await fetchJson<{ result: Record<string, { c: [string, string] }> }>(
          `https://api.kraken.com/0/public/Ticker?pair=${kSym}USD`,
        );
        const first = Object.values(d.result ?? {})[0];
        const p = parseFloat(first?.c?.[0] ?? "");
        if (!isFinite(p) || p <= 0) throw new Error("bad price");
        return { price_usd: p, source: "kraken" };
      } catch {
        return null;
      }
    }
  });
}
