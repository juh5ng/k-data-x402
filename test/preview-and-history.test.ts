import assert from "node:assert/strict";
import test from "node:test";

test("research preview reports coverage depth without exposing report content", async () => {
  const preview = await import("../src/free-preview.ts");
  const result = preview.buildResearchPreview({
    ticker: "005930",
    company: "Samsung Electronics",
    reports: 1,
    brokers: 1,
    first_recorded: "2026-08-02",
    latest_published: "2026-09-04",
  });

  assert.deepEqual(result, {
    ticker: "005930",
    company: "Samsung Electronics",
    reports: 1,
    brokers: 1,
    first_recorded: "2026-08-02",
    latest_published: "2026-09-04",
    coverage_note: "single-broker coverage; this is not a consensus",
  });
});

test("history cursor is returned only when the page is full", async () => {
  const history = await import("../src/sources/history.ts");
  assert.equal(history.nextHistoryCursor([1710000300, 1710000000], true), "1710000000");
  assert.equal(history.nextHistoryCursor([1710000000], false), null);
  assert.equal(history.nextHistoryCursor([], false), null);
});

test("history cursor ignores malformed input", async () => {
  const history = await import("../src/sources/history.ts");
  assert.equal(history.historyCursor("1710000000"), 1710000000);
  assert.equal(history.historyCursor("not-a-timestamp"), null);
  assert.equal(history.historyCursor("0"), null);
});

test("catalog advertises the free previews alongside paid endpoints", async () => {
  const catalog = await import("../src/catalog.ts");
  const result = catalog.buildCatalog("https://example.test", "eip155:8453");

  assert.ok(result.free_endpoints.includes("/api/preview/research/coverage"));
  assert.ok(result.free_endpoints.includes("/api/preview/kimchi-premium"));
});

test("hosted MCP publishes wallet-free preview tools", async () => {
  const mcp = await import("../src/preview-tools.ts");
  assert.deepEqual(
    mcp.FREE_PREVIEW_TOOLS.map(tool => tool.name),
    ["preview_research_coverage", "preview_research", "preview_kimchi_premium"],
  );
});

test("catalog documents the cursor used to read a full premium-history window", async () => {
  const catalog = await import("../src/catalog.ts");
  const history = catalog.ENDPOINTS.find(endpoint => endpoint.path === "/api/kimchi-premium/history");
  const properties = history?.querySchema?.properties as Record<string, { description?: string }>;
  assert.match(properties.before.description ?? "", /Unix-second cursor/i);
});
