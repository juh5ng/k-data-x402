import { getKrwTicker } from "./upbit";
import { getGlobalUsdPrice } from "./global";
import { getUsdKrw } from "./fx";

export interface KimchiEntry {
  ticker: string;
  upbit_krw: number;
  global_usd: number;
  global_usd_source: string;
  /** Global price converted at the official (bank/ECB) USD/KRW rate. */
  global_in_krw_official: number;
  /** Premium vs the official FX rate — the number the press quotes. */
  premium_official_pct: number;
  /** Global price converted at Upbit's own KRW/USDT market rate. */
  global_in_krw_usdt: number;
  /**
   * Premium vs the USDT rate — the margin an arbitrageur can actually realize,
   * since capital controls push the KRW→USD leg through USDT rather than banks.
   */
  premium_usdt_pct: number | null;
}

export interface KimchiReport {
  description: string;
  basis_note: string;
  usdkrw_official: number;
  usdkrw_official_source: string;
  /** Upbit KRW-USDT last price. The gap vs the official rate is the USDT premium. */
  usdkrw_usdt: number | null;
  /** How far Upbit's USDT rate sits above/below the official FX rate, in percent. */
  usdt_premium_pct: number | null;
  entries: KimchiEntry[];
  as_of: string;
}

const DEFAULT_SYMBOLS = ["BTC", "ETH", "XRP", "SOL", "DOGE"];

/**
 * Kimchi premium on two bases.
 *
 * The official-FX premium is the widely quoted figure, but it is not tradeable:
 * moving KRW back out through a bank runs into Korean capital controls, so the
 * exit leg goes through USDT instead. Pricing the same trade at Upbit's KRW/USDT
 * rate gives the margin that is actually realizable, and the spread between the
 * two bases is the structural USDT premium itself.
 *
 * Round trip priced in USD: buy the coin abroad at `global_usd`, sell it on
 * Upbit for `upbit_krw`, then convert KRW back via USDT at `upbit_usdt_krw`.
 * Return = upbit_krw / (global_usd * upbit_usdt_krw).
 */
export async function getKimchiPremium(symbols?: string[]): Promise<KimchiReport> {
  const syms = (symbols?.length ? symbols : DEFAULT_SYMBOLS).slice(0, 10);
  const [fx, usdtTicker] = await Promise.all([getUsdKrw(), getKrwTicker("USDT")]);
  const usdtKrw = usdtTicker?.price_krw ?? null;

  const results = await Promise.all(
    syms.map(async sym => {
      const [krw, usd] = await Promise.all([getKrwTicker(sym), getGlobalUsdPrice(sym)]);
      if (!krw || !usd) return null;
      const officialKrw = usd.price_usd * fx.rate;
      const usdtBasisKrw = usdtKrw ? usd.price_usd * usdtKrw : null;
      return {
        ticker: sym.toUpperCase(),
        upbit_krw: krw.price_krw,
        global_usd: usd.price_usd,
        global_usd_source: usd.source,
        global_in_krw_official: Math.round(officialKrw),
        premium_official_pct: +((krw.price_krw / officialKrw - 1) * 100).toFixed(3),
        global_in_krw_usdt: usdtBasisKrw ? Math.round(usdtBasisKrw) : 0,
        premium_usdt_pct: usdtBasisKrw
          ? +((krw.price_krw / usdtBasisKrw - 1) * 100).toFixed(3)
          : null,
      } satisfies KimchiEntry;
    }),
  );

  return {
    description:
      "Kimchi premium: Upbit (KRW) price vs global USD price, reported on two conversion bases.",
    basis_note:
      "premium_official_pct uses the official USD/KRW rate (the quoted figure). premium_usdt_pct uses Upbit's own KRW/USDT rate and is the margin actually realizable, because the KRW exit leg goes through USDT rather than banks. Neither figure is net of trading or transfer fees.",
    usdkrw_official: fx.rate,
    usdkrw_official_source: fx.source,
    usdkrw_usdt: usdtKrw,
    usdt_premium_pct: usdtKrw ? +((usdtKrw / fx.rate - 1) * 100).toFixed(3) : null,
    entries: results.filter((e): e is KimchiEntry => e !== null),
    as_of: new Date().toISOString(),
  };
}
