/**
 * Single source of truth for every paid endpoint: pricing, descriptions,
 * and discovery schemas. Consumed by the x402 payment middleware, the free
 * /api/catalog and /openapi.json routes, the landing page, and llms.txt.
 */

export interface EndpointEntry {
  method: "GET";
  path: string;
  price_usd: string;
  description: string;
  querySchema?: Record<string, unknown>;
  queryExample?: Record<string, unknown>;
  pathParamsSchema?: Record<string, unknown>;
  outputExample: unknown;
}

export const SERVICE_NAME = "K-Data x402";
export const SERVICE_TAGLINE =
  "Korean market data for AI agents — kimchi premium on a tradeable USDT basis, premium history and percentiles, Korean news translated to English, Upbit KRW quotes. Pay per request with USDC via x402. No account, no API key.";

/** Why an agent should pick this over calling Upbit directly. Surfaced to agents verbatim. */
export const SERVICE_EDGE = [
  "Dual-basis kimchi premium: the official USD/KRW figure everyone quotes, plus the Upbit KRW/USDT basis that an arbitrageur can actually realize. The two often disagree in sign — official can read negative while the tradeable basis is positive.",
  "Premium history and percentile context, continuously archived. No free source and no competing x402 seller offers this; it cannot be reconstructed after the fact.",
  "Korean headlines translated to English, so a non-Korean agent can actually use them.",
  "Korean sell-side research as structured data: target prices, ratings and revision history per KRX ticker, summarised in English. The listing site shows a rolling recent window only, so the analyst consensus series is archived here and nowhere else.",
];

export const ENDPOINTS: EndpointEntry[] = [
  {
    method: "GET",
    path: "/api/kimchi-premium",
    price_usd: "$0.03",
    description:
      "Kimchi premium on two bases: premium_official_pct (official USD/KRW rate — the quoted figure) and premium_usdt_pct (Upbit KRW/USDT rate — the margin actually realizable, since the KRW exit leg goes through USDT rather than banks). The two frequently disagree in sign. Optional ?symbols=BTC,ETH (max 10).",
    querySchema: {
      properties: {
        symbols: {
          type: "string",
          description: "Comma-separated coin tickers, e.g. BTC,ETH,XRP. Default: BTC,ETH,XRP,SOL,DOGE",
        },
      },
    },
    queryExample: { symbols: "BTC,ETH" },
    outputExample: {
      usdkrw_official: 1443.61,
      usdkrw_usdt: 1437,
      usdt_premium_pct: -0.458,
      entries: [
        {
          ticker: "BTC",
          upbit_krw: 90_731_000,
          global_usd: 63_017.37,
          premium_official_pct: -0.265,
          premium_usdt_pct: 0.193,
        },
      ],
      as_of: "2026-08-01T00:00:00.000Z",
    },
  },
  {
    method: "GET",
    path: "/api/kimchi-premium/stats",
    price_usd: "$0.12",
    description:
      "Where the current kimchi premium sits inside its own recent distribution: percentile, mean, stdev, z-score, min/max/median, and a plain-language read. Answers 'is this premium unusual right now?' in one call. Built from a continuous archive that cannot be reconstructed from any free source. Params: ?symbol=BTC &window=1h|6h|24h|7d|30d|90d &basis=usdt|official.",
    querySchema: {
      properties: {
        symbol: { type: "string", description: "Archived tickers: BTC, ETH, XRP, SOL, DOGE, USDT" },
        window: { type: "string", enum: ["1h", "6h", "24h", "7d", "30d", "90d"], description: "Lookback window (default 24h)" },
        basis: { type: "string", enum: ["usdt", "official"], description: "Which premium basis to analyse (default usdt)" },
      },
    },
    queryExample: { symbol: "BTC", window: "7d", basis: "usdt" },
    outputExample: {
      symbol: "BTC",
      window: "7d",
      basis: "usdt",
      samples: 2016,
      current_pct: 0.193,
      percentile: 92.4,
      mean_pct: 0.041,
      stdev_pct: 0.118,
      zscore: 1.288,
      interpretation: "unusually high versus this window",
    },
  },
  {
    method: "GET",
    path: "/api/kimchi-premium/history",
    price_usd: "$0.08",
    description:
      "Time series of the kimchi premium from the continuous archive, both bases, newest-last. Params: ?symbol=BTC &window=1h|6h|24h|7d|30d|90d &points=500 (max 2000). Archive depth is reported as first_recorded.",
    querySchema: {
      properties: {
        symbol: { type: "string", description: "Archived tickers: BTC, ETH, XRP, SOL, DOGE, USDT" },
        window: { type: "string", enum: ["1h", "6h", "24h", "7d", "30d", "90d"], description: "Lookback window (default 24h)" },
        points: { type: "integer", description: "Max points returned (default 500, max 2000)" },
      },
    },
    queryExample: { symbol: "BTC", window: "24h" },
    outputExample: {
      symbol: "BTC",
      window: "24h",
      points: 288,
      first_recorded: "2026-08-01T14:20:00.000Z",
      series: [
        {
          ts: "2026-08-01T14:25:00.000Z",
          upbit_krw: 90_731_000,
          global_usd: 63_017.37,
          premium_official_pct: -0.265,
          premium_usdt_pct: 0.193,
        },
      ],
    },
  },
  {
    method: "GET",
    path: "/api/research/consensus/:ticker",
    price_usd: "$0.12",
    description:
      "Analyst consensus for one KRX ticker, built from the archived research history: mean/median/min/max target price across brokerages, the spread between them, the rating distribution, and a revision log of every target-price and rating change each house has made. Consensus uses each house's latest view, so a weekly publisher does not outvote a quarterly one. Params: ?window=30d|90d|180d|365d (default 90d).",
    querySchema: {
      properties: {
        window: {
          type: "string",
          enum: ["30d", "90d", "180d", "365d"],
          description: "Lookback window (default 90d)",
        },
      },
    },
    pathParamsSchema: {
      properties: { ticker: { type: "string", description: "6-digit KRX code, e.g. 005930" } },
      required: ["ticker"],
    },
    queryExample: { window: "90d" },
    outputExample: {
      ticker: "011200",
      company: "HMM",
      window: "90d",
      reports_total: 34,
      brokers: 12,
      consensus: {
        mean_target: 30_417,
        median_target: 30_000,
        min_target: 26_000,
        max_target: 35_000,
        spread_pct: 29.59,
        ratings: { Buy: 10, Hold: 2 },
      },
      changes: [
        {
          published_date: "2026-07-31",
          broker: "LS증권",
          analyst: "이재혁",
          target_price: 30_000,
          prev_target_price: 27_000,
          target_change_pct: 11.11,
          target_direction: "raised",
          rating: "Buy",
          prev_rating: null,
          rating_direction: null,
        },
      ],
      series: [
        {
          report_idx: 651_350,
          published_date: "2026-07-31",
          broker: "LS증권",
          analyst: "이재혁",
          target_price: 30_000,
          rating: "Buy",
        },
      ],
      first_recorded: "2026-08-02",
      as_of: "2026-08-02T00:00:00.000Z",
    },
  },
  {
    method: "GET",
    path: "/api/research/company/:ticker",
    price_usd: "$0.05",
    description:
      "Every archived Korean brokerage report for one KRX ticker, newest first: target price, rating, brokerage, analyst, the Korean title with its English translation, and a one-line English summary. Params: ?limit=20 (max 50).",
    querySchema: {
      properties: { limit: { type: "integer", description: "Max reports (default 20, max 50)" } },
    },
    pathParamsSchema: {
      properties: { ticker: { type: "string", description: "6-digit KRX code, e.g. 005930" } },
      required: ["ticker"],
    },
    queryExample: { limit: 10 },
    outputExample: {
      ticker: "011200",
      company: "HMM",
      count: 3,
      first_recorded: "2026-08-02",
      items: [
        {
          report_idx: 651_350,
          published_date: "2026-07-31",
          ticker: "011200",
          company: "HMM",
          title: "2Q26 Preview: 건물 사이에 피어난 장미",
          title_en: "2Q26 Preview: a rose blooming between the buildings",
          summary_en:
            "LS Securities rates HMM (011200) Buy with a KRW 30,000 target in a 2Q26 preview by analyst Lee Jae-hyuk.",
          target_price: 30_000,
          rating: "Buy",
          rating_raw: "Buy",
          analyst: "이재혁",
          broker: "LS증권",
          source_url: "https://consensus.hankyung.com/analysis/downpdf?report_idx=651350",
        },
      ],
      as_of: "2026-08-02T00:00:00.000Z",
    },
  },
  {
    method: "GET",
    path: "/api/research/latest",
    price_usd: "$0.02",
    description:
      "Latest Korean brokerage equity research across all covered companies, newest first — company and KRX ticker, target price, rating, brokerage, analyst, and a one-line English summary of each report. Facts and summaries only; the report PDF stays with its publisher and source_url links back to it. Optional ?limit=20 (max 50).",
    querySchema: {
      properties: { limit: { type: "integer", description: "Max reports (default 20, max 50)" } },
    },
    queryExample: { limit: 10 },
    outputExample: {
      count: 20,
      items: [
        {
          report_idx: 651_350,
          published_date: "2026-07-31",
          ticker: "011200",
          company: "HMM",
          title: "2Q26 Preview: 건물 사이에 피어난 장미",
          title_en: "2Q26 Preview: a rose blooming between the buildings",
          summary_en:
            "LS Securities rates HMM (011200) Buy with a KRW 30,000 target in a 2Q26 preview by analyst Lee Jae-hyuk.",
          target_price: 30_000,
          rating: "Buy",
          rating_raw: "Buy",
          analyst: "이재혁",
          broker: "LS증권",
          source_url: "https://consensus.hankyung.com/analysis/downpdf?report_idx=651350",
        },
      ],
      as_of: "2026-08-02T00:00:00.000Z",
    },
  },
  {
    method: "GET",
    path: "/api/news/headlines/en",
    price_usd: "$0.05",
    description:
      "Latest Korean headlines with English translations attached (title_en), from Yonhap, Maeil Business and Hankyung — deduplicated, newest first. Use this instead of the Korean-only route when the consuming agent does not read Korean. Optional ?category=top|economy|tech|politics and ?limit=20 (max 50).",
    querySchema: {
      properties: {
        category: { type: "string", enum: ["top", "economy", "tech", "politics"], description: "Filter by category" },
        limit: { type: "integer", description: "Max items (default 20, max 50)" },
      },
    },
    queryExample: { category: "economy", limit: 10 },
    outputExample: {
      category: "economy",
      translated: true,
      items: [
        {
          title: "7월 수출 989억달러 역대 2위…반도체 두달째 400억달러대",
          title_en: "July exports at $98.9bn, second highest ever; chips above $40bn for a second month",
          link: "https://www.yna.co.kr/view/...",
          published_at: "2026-08-01T01:35:11.000Z",
          source: "연합뉴스 (Yonhap)",
        },
      ],
    },
  },
  {
    method: "GET",
    path: "/api/korea/market-snapshot",
    price_usd: "$0.08",
    description:
      "One-call Korea briefing: dual-basis kimchi premium + top Upbit KRW markets + USD/KRW + latest economy headlines translated to English. Everything needed for a Korea market read in a single paid request.",
    outputExample: {
      kimchi_premium: { usdkrw_official: 1443.61, usdkrw_usdt: 1437, entries: [] },
      krw_markets: { markets_total: 277, top_by_volume: [] },
      fx: { pair: "USD/KRW", rate: 1443.61 },
      news_economy: { translated: true, items: [] },
      as_of: "2026-08-01T00:00:00.000Z",
    },
  },
  {
    method: "GET",
    path: "/api/crypto/krw/markets",
    price_usd: "$0.01",
    description:
      "Snapshot of all Upbit KRW crypto markets: top by 24h traded value, top gainers, top losers. Optional ?limit=30 (max 100) for the volume ranking.",
    querySchema: {
      properties: {
        limit: { type: "integer", description: "How many top-volume markets to return (default 30, max 100)" },
      },
    },
    outputExample: {
      markets_total: 277,
      top_by_volume: [{ market: "KRW-BTC", ticker: "BTC", price_krw: 90_731_000, change_24h_pct: 1.2 }],
      top_gainers: [],
      top_losers: [],
    },
  },
  {
    method: "GET",
    path: "/api/news/headlines",
    price_usd: "$0.01",
    description:
      "Latest Korean headlines from Yonhap, Maeil Business and Hankyung, deduplicated and newest-first. Titles stay in Korean — use /api/news/headlines/en for English. Optional ?category=top|economy|tech|politics and ?limit=30 (max 100).",
    querySchema: {
      properties: {
        category: { type: "string", enum: ["top", "economy", "tech", "politics"], description: "Filter by category" },
        limit: { type: "integer", description: "Max items (default 30, max 100)" },
      },
    },
    queryExample: { category: "economy", limit: 20 },
    outputExample: {
      category: "economy",
      items: [
        {
          title: "코스피, 외국인 매수세에 상승 마감",
          link: "https://www.yna.co.kr/view/...",
          published_at: "2026-08-01T00:00:00.000Z",
          source: "연합뉴스 (Yonhap)",
        },
      ],
    },
  },
  {
    method: "GET",
    path: "/api/crypto/krw/:ticker",
    price_usd: "$0.005",
    description:
      "Live quote for one Upbit KRW market by ticker symbol (e.g. BTC, ETH, XRP): price, 24h change, 24h high/low, 24h traded value in KRW.",
    pathParamsSchema: {
      properties: { ticker: { type: "string", description: "Coin ticker symbol, e.g. BTC" } },
      required: ["ticker"],
    },
    outputExample: {
      market: "KRW-BTC",
      ticker: "BTC",
      name_en: "Bitcoin",
      price_krw: 90_731_000,
      change_24h_pct: 1.204,
      volume_24h_krw: 250_000_000_000,
      as_of: "2026-08-01T00:00:00.000Z",
    },
  },
  {
    method: "GET",
    path: "/api/fx/usdkrw",
    price_usd: "$0.005",
    description: "Current USD/KRW exchange rate (ECB reference via Frankfurter, fallback open.er-api.com).",
    outputExample: { pair: "USD/KRW", rate: 1443.61, as_of: "2026-08-01", source: "frankfurter.dev (ECB)" },
  },
];

/** "$0.12" -> 0.12. Prices are stored as display strings; the ledger needs numbers. */
export function priceToNumber(price: string): number {
  const n = parseFloat(price.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Resolves a concrete request path to its catalogue entry, treating `:param`
 * segments as wildcards: "/api/crypto/krw/BTC" -> the "/api/crypto/krw/:ticker"
 * entry. Used by the paywall to decide what is billable, and by the sales
 * ledger to record which product was bought rather than which URL was hit.
 */
export function matchCatalogPath(path: string): EndpointEntry | null {
  const actual = path.split("/");
  return (
    ENDPOINTS.find(e => {
      const pattern = e.path.split("/");
      if (pattern.length !== actual.length) return false;
      return pattern.every((seg, i) => seg.startsWith(":") || seg === actual[i]);
    }) ?? null
  );
}

/** Machine-readable catalog served free at /api/catalog. */
export function buildCatalog(serviceUrl: string, network: string) {
  return {
    service: SERVICE_NAME,
    tagline: SERVICE_TAGLINE,
    why_this_service: SERVICE_EDGE,
    payment: {
      protocol: "x402",
      version: 2,
      scheme: "exact",
      network,
      currency: "USDC",
      how: "Request any paid endpoint without payment to receive HTTP 402 with payment requirements, pay with any x402 client (e.g. @x402/fetch), then retry with the payment header.",
    },
    base_url: serviceUrl,
    free_endpoints: ["/", "/api/catalog", "/openapi.json", "/llms.txt"],
    paid_endpoints: ENDPOINTS.map(e => ({
      method: e.method,
      path: e.path,
      price_usd: e.price_usd,
      description: e.description,
      query_params: e.querySchema ?? null,
      path_params: e.pathParamsSchema ?? null,
      output_example: e.outputExample,
    })),
  };
}

/**
 * OpenAPI 3.1 document served free at /openapi.json.
 * Agents read this at runtime to decide which endpoint to call, so every
 * endpoint carries its price and an example response.
 */
export function buildOpenApi(serviceUrl: string, network: string) {
  const paths: Record<string, unknown> = {};

  for (const e of ENDPOINTS) {
    // OpenAPI uses {param}; internal routes use :param.
    const oaPath = e.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    const parameters: unknown[] = [];

    const pathProps = (e.pathParamsSchema?.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const [name, schema] of Object.entries(pathProps)) {
      parameters.push({
        name,
        in: "path",
        required: true,
        description: schema.description,
        schema: { type: schema.type ?? "string" },
      });
    }

    const queryProps = (e.querySchema?.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const [name, schema] of Object.entries(queryProps)) {
      parameters.push({
        name,
        in: "query",
        required: false,
        description: schema.description,
        schema: schema.enum
          ? { type: schema.type ?? "string", enum: schema.enum }
          : { type: schema.type ?? "string" },
      });
    }

    paths[oaPath] = {
      get: {
        summary: `${e.description.split(".")[0]}. Costs ${e.price_usd} per call.`,
        description: `${e.description}\n\nPayment: ${e.price_usd} in USDC via the x402 protocol (network ${network}). Calling without payment returns HTTP 402 with the payment requirements in the PAYMENT-REQUIRED header.`,
        operationId: e.path.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, ""),
        parameters: parameters.length ? parameters : undefined,
        responses: {
          "200": {
            description: "Payment accepted; data returned.",
            content: { "application/json": { example: e.outputExample } },
          },
          "402": {
            description:
              "Payment required. The PAYMENT-REQUIRED header carries base64-encoded x402 payment requirements.",
          },
          "404": { description: "Requested resource or symbol is not available." },
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: SERVICE_NAME,
      version: "1.1.0",
      summary: SERVICE_TAGLINE,
      description: [
        SERVICE_TAGLINE,
        "",
        "Why this service:",
        ...SERVICE_EDGE.map(s => `- ${s}`),
        "",
        "Every endpoint below is metered per request with x402 (HTTP 402). No account, API key, or signup is required — an x402-capable client pays in USDC and retries automatically.",
      ].join("\n"),
    },
    servers: [{ url: serviceUrl }],
    paths,
  };
}
