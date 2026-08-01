import { cached, fetchJson } from "../lib/cache";

export interface FxRate {
  pair: "USD/KRW";
  rate: number;
  as_of: string;
  source: string;
}

interface FrankfurterResp {
  date: string;
  rates: { KRW?: number };
}

interface ErApiResp {
  result: string;
  time_last_update_utc: string;
  rates: { KRW?: number };
}

/** USD→KRW rate. Frankfurter (ECB) primary, open.er-api.com fallback. Cached 10 min. */
export async function getUsdKrw(): Promise<FxRate> {
  return cached("fx:usdkrw", 10 * 60_000, async () => {
    try {
      const d = await fetchJson<FrankfurterResp>(
        "https://api.frankfurter.dev/v1/latest?base=USD&symbols=KRW",
      );
      if (!d.rates?.KRW) throw new Error("no KRW rate");
      return { pair: "USD/KRW" as const, rate: d.rates.KRW, as_of: d.date, source: "frankfurter.dev (ECB)" };
    } catch {
      const d = await fetchJson<ErApiResp>("https://open.er-api.com/v6/latest/USD");
      if (d.result !== "success" || !d.rates?.KRW) throw new Error("fx: all sources failed");
      return {
        pair: "USD/KRW" as const,
        rate: d.rates.KRW,
        as_of: d.time_last_update_utc,
        source: "open.er-api.com",
      };
    }
  });
}
