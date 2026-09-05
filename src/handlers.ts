import { getKimchiPremium } from "./sources/kimchi";
import { getKrwTicker, getKrwMarketsSummary } from "./sources/upbit";
import { getHeadlines } from "./sources/news";
import { getUsdKrw } from "./sources/fx";
import { getPremiumHistory, getPremiumStats } from "./sources/history";
import {
  getLatestResearch,
  getCompanyResearch,
  getConsensus,
  getResearchCoverage,
  getResearchPreview,
} from "./sources/research-db";

export interface HandlerEnv {
  ARCHIVE: D1Database;
  AI: Ai;
}

/** Thrown for caller-fixable problems; surfaced as 404 over HTTP and as a tool error over MCP. */
export class NotFoundError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function str(value: unknown): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : String(value);
}

/** Same miss for both research-by-ticker routes: bad code, or coverage not deep enough yet. */
const NO_COVERAGE = [
  "no archived research for this ticker",
  "Tickers are 6-digit KRX codes, e.g. 005930 for Samsung Electronics. Coverage starts at the archive's first_recorded date, so very recent tickers may have no history yet.",
] as const;

/**
 * Runs one catalogued endpoint. Both the HTTP routes and the MCP tools go
 * through here, so the two transports can never drift in behaviour or pricing.
 * `path` is the catalog path, e.g. "/api/kimchi-premium/stats".
 */
export async function runEndpoint(
  path: string,
  args: Record<string, unknown>,
  env: HandlerEnv,
): Promise<unknown> {
  switch (path) {
    case "/api/kimchi-premium": {
      const symbols = str(args.symbols)
        ?.split(",")
        .map(s => s.trim())
        .filter(Boolean);
      return getKimchiPremium(symbols);
    }

    case "/api/kimchi-premium/history":
      return getPremiumHistory(
        env.ARCHIVE,
        str(args.symbol) ?? "BTC",
        str(args.window),
        int(args.points, 500, 1, 2000),
        str(args.before),
      );

    case "/api/kimchi-premium/stats": {
      const basis = str(args.basis) === "official" ? "official" : "usdt";
      const stats = await getPremiumStats(env.ARCHIVE, str(args.symbol) ?? "BTC", str(args.window), basis);
      if (!stats) {
        throw new NotFoundError(
          "no archived samples for this symbol and window",
          "Archived symbols are BTC, ETH, XRP, SOL, DOGE, USDT. Try a longer window, e.g. window=7d.",
        );
      }
      return stats;
    }

    case "/api/research/latest":
      return getLatestResearch(env.ARCHIVE, int(args.limit, 20, 1, 50));

    case "/api/research/company/:ticker": {
      const reports = await getCompanyResearch(
        env.ARCHIVE,
        str(args.ticker) ?? "",
        int(args.limit, 20, 1, 50),
      );
      if (!reports) throw new NotFoundError(...NO_COVERAGE);
      return reports;
    }

    case "/api/research/consensus/:ticker": {
      const consensus = await getConsensus(env.ARCHIVE, str(args.ticker) ?? "", str(args.window));
      if (!consensus) throw new NotFoundError(...NO_COVERAGE);
      return consensus;
    }

    case "/api/crypto/krw/markets":
      return getKrwMarketsSummary(int(args.limit, 30, 1, 100));

    case "/api/crypto/krw/:ticker": {
      const ticker = await getKrwTicker(str(args.ticker) ?? "");
      if (!ticker) throw new NotFoundError("unknown ticker: no such KRW market on Upbit");
      return ticker;
    }

    case "/api/news/headlines":
      return getHeadlines(str(args.category), int(args.limit, 30, 1, 100));

    case "/api/news/headlines/en":
      return getHeadlines(str(args.category), int(args.limit, 20, 1, 50), env.AI);

    case "/api/fx/usdkrw":
      return getUsdKrw();

    case "/api/korea/market-snapshot": {
      const [kimchi, markets, fx, news] = await Promise.all([
        getKimchiPremium(),
        getKrwMarketsSummary(10),
        getUsdKrw(),
        getHeadlines("economy", 8, env.AI),
      ]);
      return {
        kimchi_premium: kimchi,
        krw_markets: markets,
        fx,
        news_economy: news,
        as_of: new Date().toISOString(),
      };
    }

    default:
      throw new NotFoundError(`no such endpoint: ${path}`);
  }
}

/** Free previews expose coverage and a one-symbol live sample, never paid report content. */
export async function runPreviewEndpoint(
  path: string,
  args: Record<string, unknown>,
  env: HandlerEnv,
): Promise<unknown> {
  switch (path) {
    case "/api/preview/kimchi-premium":
      return { preview: true, scope: "BTC only; paid endpoint supports up to 10 symbols", data: await getKimchiPremium(["BTC"]) };

    case "/api/preview/research/coverage":
      return getResearchCoverage(env.ARCHIVE, int(args.limit, 25, 1, 50));

    case "/api/preview/research/:ticker": {
      const preview = await getResearchPreview(env.ARCHIVE, str(args.ticker) ?? "");
      if (!preview) throw new NotFoundError(...NO_COVERAGE);
      return preview;
    }

    default:
      throw new NotFoundError(`no such preview: ${path}`);
  }
}
