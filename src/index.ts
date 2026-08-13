import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { RoutesConfig } from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { createCdpFacilitatorClient } from "./lib/cdp-facilitator";

import {
  ENDPOINTS,
  SERVICE_NAME,
  SERVICE_TAGLINE,
  SERVICE_EDGE,
  buildCatalog,
  buildOpenApi,
} from "./catalog";
import { recordSnapshot, ensureSchema } from "./archive";
import { runResearchTick } from "./research";
import { runEndpoint, NotFoundError } from "./handlers";
import { handleMcpRequest } from "./mcp";

/** Must match the hourly entry in wrangler.jsonc triggers.crons. */
const RESEARCH_CRON = "7 * * * *";

interface Env {
  NETWORK: string; // "eip155:84532" (Base Sepolia) or "eip155:8453" (Base mainnet)
  PAY_TO: string; // EVM address receiving USDC
  FACILITATOR_URL?: string; // used when CDP keys are absent
  SERVICE_URL?: string;
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  ARCHIVE: D1Database;
  AI: Ai;
}

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// x402 paywall — built lazily from env (Workers only expose env per-request),
// memoized so the facilitator client is constructed once per isolate.
// ---------------------------------------------------------------------------

function buildFacilitator(env: Env) {
  return env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET
    ? createCdpFacilitatorClient({ apiKeyId: env.CDP_API_KEY_ID, apiKeySecret: env.CDP_API_KEY_SECRET })
    : new HTTPFacilitatorClient({ url: env.FACILITATOR_URL || "https://x402.org/facilitator" });
}

function buildPaywall(env: Env): MiddlewareHandler {
  const facilitator = buildFacilitator(env);

  const network = env.NETWORK as `${string}:${string}`;
  const resourceServer = new x402ResourceServer(facilitator).register(network, new ExactEvmScheme());

  const routes: RoutesConfig = {};
  for (const e of ENDPOINTS) {
    routes[`${e.method} ${e.path}`] = {
      accepts: {
        scheme: "exact",
        price: e.price_usd,
        network,
        payTo: env.PAY_TO,
      },
      description: e.description,
      mimeType: "application/json",
      // Declaring this is what opts the route into the x402 Bazaar, the index
      // agents search to find paid APIs — without it the service is invisible.
      // @x402/extensions validates these with Ajv, whose eval-based codegen
      // Workers forbids; the middleware catches that, so it costs a startup
      // warning and the declaration still ships.
      extensions: {
        ...declareDiscoveryExtension({
          ...(e.querySchema ? { inputSchema: e.querySchema } : {}),
          ...(e.queryExample ? { input: e.queryExample } : {}),
          ...(e.pathParamsSchema ? { pathParamsSchema: e.pathParamsSchema } : {}),
          output: { example: e.outputExample },
        }),
      },
    };
  }

  return paymentMiddleware(routes, resourceServer);
}

/** True if the request targets one of the paid endpoints (supports :param segments). */
function isPaidPath(method: string, path: string): boolean {
  if (method !== "GET") return false;
  return ENDPOINTS.some(e => {
    const pattern = e.path.split("/");
    const actual = path.split("/");
    if (pattern.length !== actual.length) return false;
    return pattern.every((seg, i) => seg.startsWith(":") || seg === actual[i]);
  });
}

let paywall: MiddlewareHandler | null = null;
let paywallKey = "";

// The paywall is constructed on the FIRST PAID request, not at module scope
// or on an unrelated request: paymentMiddleware eagerly starts a facilitator
// sync fetch at construction, and in Workers that I/O is cancelled when its
// originating request finishes — any later request awaiting it would hang.
// Constructing inside a paid request lets that same request await the sync.
app.use("/api/*", async (c, next) => {
  if (!isPaidPath(c.req.method, c.req.path)) return next();
  const env = c.env;
  const key = `${env.NETWORK}|${env.PAY_TO}|${env.FACILITATOR_URL ?? ""}|${env.CDP_API_KEY_ID ? "cdp" : "public"}`;
  if (!paywall || paywallKey !== key) {
    paywall = buildPaywall(env);
    paywallKey = key;
  }
  return paywall(c, next);
});

// ---------------------------------------------------------------------------
// Paid routes (guarded by the middleware above)
// ---------------------------------------------------------------------------

type AppContext = Context<{ Bindings: Env }>;

// Each paid route delegates to runEndpoint so HTTP and MCP share one
// implementation and cannot drift apart.
function paidRoute(path: string, pick: (c: AppContext) => Record<string, unknown>) {
  return async (c: AppContext) => {
    try {
      return c.json(await runEndpoint(path, pick(c), c.env));
    } catch (err) {
      if (err instanceof NotFoundError) {
        return c.json({ error: err.message, ...(err.hint ? { hint: err.hint } : {}) }, 404);
      }
      throw err;
    }
  };
}

app.get("/api/kimchi-premium", paidRoute("/api/kimchi-premium", c => ({ symbols: c.req.query("symbols") })));

app.get(
  "/api/kimchi-premium/history",
  paidRoute("/api/kimchi-premium/history", c => ({
    symbol: c.req.query("symbol"),
    window: c.req.query("window"),
    points: c.req.query("points"),
  })),
);

app.get(
  "/api/kimchi-premium/stats",
  paidRoute("/api/kimchi-premium/stats", c => ({
    symbol: c.req.query("symbol"),
    window: c.req.query("window"),
    basis: c.req.query("basis"),
  })),
);

app.get(
  "/api/research/latest",
  paidRoute("/api/research/latest", c => ({ limit: c.req.query("limit") })),
);

app.get(
  "/api/research/company/:ticker",
  paidRoute("/api/research/company/:ticker", c => ({
    ticker: c.req.param("ticker"),
    limit: c.req.query("limit"),
  })),
);

app.get(
  "/api/research/consensus/:ticker",
  paidRoute("/api/research/consensus/:ticker", c => ({
    ticker: c.req.param("ticker"),
    window: c.req.query("window"),
  })),
);

app.get(
  "/api/crypto/krw/markets",
  paidRoute("/api/crypto/krw/markets", c => ({ limit: c.req.query("limit") })),
);

app.get(
  "/api/crypto/krw/:ticker",
  paidRoute("/api/crypto/krw/:ticker", c => ({ ticker: c.req.param("ticker") })),
);

app.get(
  "/api/news/headlines",
  paidRoute("/api/news/headlines", c => ({
    category: c.req.query("category"),
    limit: c.req.query("limit"),
  })),
);

app.get(
  "/api/news/headlines/en",
  paidRoute("/api/news/headlines/en", c => ({
    category: c.req.query("category"),
    limit: c.req.query("limit"),
  })),
);

app.get("/api/fx/usdkrw", paidRoute("/api/fx/usdkrw", () => ({})));

app.get("/api/korea/market-snapshot", paidRoute("/api/korea/market-snapshot", () => ({})));

// ---------------------------------------------------------------------------
// Free discovery routes
// ---------------------------------------------------------------------------

function serviceUrl(c: { env: Env; req: { url: string } }): string {
  return c.env.SERVICE_URL || new URL(c.req.url).origin;
}

// MCP transport. Same catalogue, same handlers, same prices — reached over
// JSON-RPC instead of REST so MCP-native agents can buy without an HTTP client.
app.all("/mcp", c => handleMcpRequest(c.req.raw, c.env, () => buildFacilitator(c.env)));

app.get("/api/catalog", c => c.json(buildCatalog(serviceUrl(c), c.env.NETWORK)));

// Agents read the OpenAPI document at runtime to pick an endpoint, so it is
// free and carries the price of every route.
app.get("/openapi.json", c => c.json(buildOpenApi(serviceUrl(c), c.env.NETWORK)));

app.get("/llms.txt", c => {
  const base = serviceUrl(c);
  const lines = [
    `# ${SERVICE_NAME}`,
    ``,
    `> ${SERVICE_TAGLINE}`,
    ``,
    `Payment: x402 protocol (HTTP 402), scheme "exact", USDC on ${c.env.NETWORK === "eip155:8453" ? "Base mainnet" : "Base Sepolia testnet"}.`,
    `No account or API key needed. Use any x402 client (e.g. @x402/fetch) to pay per request.`,
    ``,
    `## Why this service`,
    ``,
    ...SERVICE_EDGE.map(s => `- ${s}`),
    ``,
    `## Paid endpoints`,
    ``,
    ...ENDPOINTS.map(e => `- [${e.method} ${e.path}](${base}${e.path}) (${e.price_usd}): ${e.description}`),
    ``,
    `## Free endpoints`,
    ``,
    `- [GET /openapi.json](${base}/openapi.json): OpenAPI 3.1 spec with per-endpoint pricing`,
    `- [GET /api/catalog](${base}/api/catalog): machine-readable catalog with schemas and examples`,
  ];
  return c.text(lines.join("\n"));
});

app.get("/robots.txt", c => c.text("User-agent: *\nAllow: /\n"));

app.get("/", c => {
  const base = serviceUrl(c);
  const rows = ENDPOINTS.map(
    e =>
      `<tr><td><code>${e.method} ${e.path}</code></td><td>${e.price_usd}</td><td>${e.description}</td></tr>`,
  ).join("\n");
  return c.html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${SERVICE_NAME} — Korean market data for AI agents</title>
<style>
  body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;line-height:1.55;color:#1a1a1a}
  code{background:#f0f0f0;padding:.1em .35em;border-radius:4px}
  table{border-collapse:collapse;width:100%;font-size:.92rem}
  td,th{border:1px solid #ddd;padding:.5em .6em;text-align:left;vertical-align:top}
  th{background:#fafafa}
  .pill{display:inline-block;background:#eef6ff;color:#1250aa;border-radius:999px;padding:.15em .7em;font-size:.85rem;margin-right:.4em}
  @media (prefers-color-scheme: dark){body{background:#111;color:#eee}code{background:#222}td,th{border-color:#333}th{background:#1a1a1a}.pill{background:#12233d;color:#8fc0ff}}
</style>
</head>
<body>
<h1>${SERVICE_NAME}</h1>
<p>${SERVICE_TAGLINE}</p>
<p><span class="pill">x402</span><span class="pill">USDC on Base</span><span class="pill">no API key</span><span class="pill">agent-first</span></p>
<h2>Why this service</h2>
<ul>
${SERVICE_EDGE.map(s => `<li>${s}</li>`).join("\n")}
</ul>
<h2>How to pay (for agents)</h2>
<ol>
<li>GET any paid endpoint → you receive <code>HTTP 402</code> with payment requirements.</li>
<li>Pay with any x402 client (<code>@x402/fetch</code>, x402 MCP tools, Apify, etc.).</li>
<li>Retry with the payment header → data is returned and payment settles on-chain.</li>
</ol>
<p>For agents: <a href="${base}/openapi.json"><code>openapi.json</code></a> · <a href="${base}/api/catalog"><code>catalog</code></a> · <a href="${base}/llms.txt">llms.txt</a></p>
<h2>Endpoints &amp; pricing</h2>
<table>
<tr><th>Endpoint</th><th>Price</th><th>Description</th></tr>
${rows}
</table>
</body>
</html>`);
});

export default {
  fetch: app.fetch,

  /**
   * Cron ticks. Schema is ensured inside each job rather than in a migration
   * step so a fresh D1 starts recording on the first tick instead of silently
   * dropping data.
   *
   * Hourly: ingest new research listings. Every 5 minutes: append one premium
   * snapshot. Neither may throw past waitUntil — a failed tick should cost one
   * interval, not the schedule.
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (event.cron === RESEARCH_CRON) {
      ctx.waitUntil(
        (async () => {
          try {
            const { inserted, summarized, pending } = await runResearchTick(env.ARCHIVE, env.AI);
            console.log(
              `research: inserted ${inserted}, summarized ${summarized}, pending ${pending}`,
            );
          } catch (err) {
            console.error("research: ingest failed:", err);
          }
        })(),
      );
      return;
    }

    ctx.waitUntil(
      (async () => {
        try {
          await ensureSchema(env.ARCHIVE);
          const rows = await recordSnapshot(env.ARCHIVE);
          console.log(`archive: recorded ${rows} rows`);
        } catch (err) {
          console.error("archive: snapshot failed:", err);
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
