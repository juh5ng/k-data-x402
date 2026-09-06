const SERVICE_URL = "https://k-data-x402-production.theblack1022.workers.dev";
const DISCOVERY_URL = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
const PAGE_SIZE = 1000;

async function readPage(offset) {
  const response = await fetch(`${DISCOVERY_URL}?limit=${PAGE_SIZE}&offset=${offset}`);
  if (!response.ok) throw new Error(`Bazaar request failed at offset ${offset}: HTTP ${response.status}`);
  return response.json();
}

const first = await readPage(0);
const total = Number(first.pagination?.total ?? first.items?.length ?? 0);
const offsets = [];
for (let offset = PAGE_SIZE; offset < total; offset += PAGE_SIZE) offsets.push(offset);

const rest = await Promise.all(offsets.map(readPage));
const items = [first, ...rest].flatMap(page => page.items ?? []);
const matches = items
  .filter(item => String(item.resource ?? "").startsWith(SERVICE_URL))
  .sort((a, b) => String(a.resource).localeCompare(String(b.resource)))
  .map(item => ({
    resource: item.resource,
    lastUpdated: item.lastUpdated ?? null,
    last30dCalls: item.quality?.l30DaysTotalCalls ?? null,
  }));

console.log(JSON.stringify({ scanned: items.length, reportedTotal: total, visible: matches.length, resources: matches }, null, 2));

