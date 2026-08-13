// Smoke test of data source modules against live upstreams.
// Run: npx esbuild test/smoke-sources.ts --bundle --format=esm --platform=node --outfile=.wrangler/tmp-smoke.mjs && node .wrangler/tmp-smoke.mjs
import { getUsdKrw } from "../src/sources/fx";
import { getKrwTicker, getKrwMarketsSummary } from "../src/sources/upbit";
import { getKimchiPremium } from "../src/sources/kimchi";
import { getHeadlines } from "../src/sources/news";
import { fetchListingPage } from "../src/sources/research";

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

// The research scraper parses HTML rather than a stable API, so this doubles as
// a canary: a markup change upstream shows up here as a coverage drop.
const reports = await fetchListingPage(1);
const pct = (n: number) => `${Math.round((n / reports.length) * 100)}%`;
console.log(
  `RESEARCH: rows=${reports.length}`,
  `| ticker ${pct(reports.filter(r => r.ticker).length)}`,
  `| target ${pct(reports.filter(r => r.target_price).length)}`,
  `| rating ${pct(reports.filter(r => r.rating).length)}`,
  `| broker ${pct(reports.filter(r => r.broker).length)}`,
);
if (reports.length === 0) console.error("  !! parsed 0 rows — listing markup may have changed");
for (const r of reports.slice(0, 3))
  console.log(`  - ${r.published_date} ${r.company}(${r.ticker}) ${r.rating} ${r.target_price} | ${r.broker}`);
