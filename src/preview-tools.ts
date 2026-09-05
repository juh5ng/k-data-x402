/** Wallet-free MCP tools. Their `path` stays internal to the JSON-RPC handler. */
export const FREE_PREVIEW_TOOLS = [
  {
    name: "preview_research_coverage",
    path: "/api/preview/research/coverage",
    description: "Free, date-stamped KRX research coverage. Lists the most-covered tickers with report count, brokerage count, and archive date range; it does not reveal report content.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", description: "How many tickers to show (default 25, max 50)" } },
      additionalProperties: false,
    },
  },
  {
    name: "preview_research",
    path: "/api/preview/research/:ticker",
    description: "Free, date-stamped archive-depth check for one 6-digit KRX ticker. Shows report and brokerage counts, not report content or consensus.",
    inputSchema: {
      type: "object",
      properties: { ticker: { type: "string", description: "6-digit KRX code, e.g. 005930" } },
      required: ["ticker"],
      additionalProperties: false,
    },
  },
  {
    name: "preview_kimchi_premium",
    path: "/api/preview/kimchi-premium",
    description: "Free live BTC-only sample of the dual-basis kimchi premium. Use the paid endpoint for up to 10 symbols.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;
