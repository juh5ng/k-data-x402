// Smoke test of data source modules against live upstreams.
// Run: npx esbuild test/smoke-sources.ts --bundle --format=esm --platform=node --outfile=.wrangler/tmp-smoke.mjs && node .wrangler/tmp-smoke.mjs
import { getUsdKrw } from "../src/sources/fx";
import { getKrwTicker, getKrwMarketsSummary } from "../src/sources/upbit";
import { getKimchiPremium } from "../src/sources/kimchi";
import { getHeadlines } from "../src/sources/news";

const fx = await getUsdKrw();
console.log("FX:", JSON.stringify(fx));

const btc = await getKrwTicker("BTC");
console.log("BTC KRW:", JSON.stringify(btc));

const markets = await getKrwMarketsSummary(3);
console.log(
  "MARKETS: total =",
  markets.markets_total,
  "| top:",
  markets.top_by_volume.map(m => `${m.ticker}=${m.price_krw}`).join(", "),
);

const kimchi = await getKimchiPremium(["BTC", "ETH"]);
console.log("KIMCHI:", JSON.stringify(kimchi.entries));

const news = await getHeadlines(undefined, 5);
console.log(`NEWS: sources ${news.sources_ok}/${news.sources_total}, items=${news.items.length}`);
for (const n of news.items.slice(0, 5)) console.log("  -", n.source, "|", n.title.slice(0, 60));
