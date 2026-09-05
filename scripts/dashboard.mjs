#!/usr/bin/env node
/**
 * Builds the operations dashboard as a single self-contained HTML file.
 *
 * Collect and render live in one script on purpose: the daily routine should be
 * "run this, publish the output" with no judgement calls in between.
 *
 * Everything is baked into the HTML because a published Artifact runs under a
 * CSP that blocks every external request — the page cannot fetch anything for
 * itself, so the refresh has to happen here.
 *
 * Usage: npm run dashboard   ->   .dashboard/index.html
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { retrySync } from "./retry-sync.mjs";

const SERVICE = "https://k-data-x402-production.theblack1022.workers.dev";
const PAY_TO = "0x519c79c7EB7566F7353a324472A5CE4f05330C81";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_RPC = "https://mainnet.base.org";
const DB = "k-data-archive";
const OUT_DIR = ".dashboard";
const PROBE_TIMEOUT = 10_000;

// wrangler's JS entry, run through this same node binary. Going via `npx` would
// mean spawning a .cmd on Windows, which needs shell:true — and that concatenates
// arguments instead of escaping them, so SQL text could not be passed safely.
const WRANGLER = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));

// ---------------------------------------------------------------------------
// D1
// ---------------------------------------------------------------------------

/**
 * Runs one statement and returns its rows.
 *
 * One statement per invocation is not a simplification: a --file holding
 * several statements comes back as a summary ("Total queries executed: 2")
 * with no per-statement rows at all.
 */
function queryD1Once(sql) {
  const res = spawnSync(
    process.execPath,
    [WRANGLER, "d1", "execute", DB, "--env", "production", "--remote", "--json", "--command", sql],
    { encoding: "utf8", maxBuffer: 1 << 27 },
  );
  const out = `${res.stdout ?? ""}`;
  // wrangler prints config warnings before the JSON payload, and those warnings
  // can themselves contain a literal "[" (e.g. an ANSI-colored "[WARNING]" tag),
  // so a plain indexOf("[") can latch onto that instead of the real payload.
  // The payload is wrangler's pretty-printed JSON, whose outer "[" always sits
  // alone on its own line — match that instead of the first "[" anywhere.
  const match = /^\[\r?\n/m.exec(out);
  if (!match) throw new Error((res.stderr || out || "no output").trim().slice(0, 400));
  return JSON.parse(out.slice(match.index))[0]?.results ?? [];
}

function queryD1(sql) {
  return retrySync(() => queryD1Once(sql), 2);
}

function collectRevenue() {
  // Kept in its own batch: before the first sale the table does not exist yet,
  // and that must degrade to an empty dashboard section rather than an error.
  try {
    // Totals, failures and the ledger start date collapse into one row so the
    // refresh spends four wrangler round-trips here rather than six.
    const summary = queryD1(
      `SELECT sum(success) AS sales,
              sum(CASE WHEN success = 1 THEN price_usd ELSE 0 END) AS revenue,
              sum(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed,
              min(ts) AS since
         FROM receipts`,
    )[0] ?? {};
    return {
      available: true,
      byEndpoint: queryD1(
        `SELECT endpoint, transport, count(*) AS n, sum(price_usd) AS revenue
           FROM receipts WHERE success = 1 GROUP BY endpoint, transport ORDER BY revenue DESC`,
      ),
      byDay: queryD1(
        `SELECT date(ts,'unixepoch') AS d, count(*) AS n, sum(price_usd) AS revenue
           FROM receipts WHERE success = 1 GROUP BY d ORDER BY d DESC LIMIT 30`,
      ),
      byPayer: queryD1(
        `SELECT payer, count(*) AS n, sum(price_usd) AS revenue,
                min(ts) AS first_seen, max(ts) AS last_seen
           FROM receipts WHERE success = 1 AND payer IS NOT NULL
          GROUP BY payer ORDER BY n DESC LIMIT 25`,
      ),
      sales: summary.sales ?? 0,
      revenue: summary.revenue ?? 0,
      failed: summary.failed ?? 0,
      since: summary.since ?? null,
    };
  } catch (err) {
    return { available: false, reason: String(err.message ?? err).slice(0, 300) };
  }
}

function collectArchive() {
  try {
    // Scalar subqueries keep both tables to a single round-trip.
    const row =
      queryD1(
        `SELECT (SELECT count(*) FROM research_reports) AS r_n,
                (SELECT sum(processed) FROM research_reports) AS r_done,
                (SELECT count(DISTINCT ticker) FROM research_reports) AS r_tickers,
                (SELECT count(DISTINCT broker) FROM research_reports) AS r_brokers,
                (SELECT max(published_date) FROM research_reports) AS r_newest,
                (SELECT count(*) FROM premium_snapshots) AS p_n,
                (SELECT max(ts) FROM premium_snapshots) AS p_latest`,
      )[0] ?? {};
    return {
      available: true,
      research: {
        n: row.r_n,
        done: row.r_done,
        tickers: row.r_tickers,
        brokers: row.r_brokers,
        newest: row.r_newest,
      },
      premium: { n: row.p_n, latest: row.p_latest },
    };
  } catch (err) {
    return { available: false, reason: String(err.message ?? err).slice(0, 300) };
  }
}

// ---------------------------------------------------------------------------
// On-chain
// ---------------------------------------------------------------------------

/** Current USDC balance of the receiving wallet. One eth_call, no API key. */
async function collectWallet() {
  try {
    const data = `0x70a08231000000000000000000000000${PAY_TO.slice(2)}`;
    const res = await fetch(BASE_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: USDC_BASE, data }, "latest"],
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT),
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    return { available: true, usdc: Number(BigInt(json.result)) / 1e6 };
  } catch (err) {
    return { available: false, reason: String(err.message ?? err).slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// Discovery + health probes
// ---------------------------------------------------------------------------

async function probe(url, expect, init) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT) });
    return { ok: res.status === expect, status: res.status };
  } catch (err) {
    return { ok: false, status: null, error: String(err.message ?? err).slice(0, 120) };
  }
}

async function collectHealth(catalogPaths) {
  const free = ["/", "/api/catalog", "/openapi.json", "/llms.txt", "/robots.txt"];
  const freeResults = await Promise.all(free.map(p => probe(SERVICE + p, 200)));
  // Paid routes must answer 402, not 200: a 200 would mean the paywall is open.
  const paidSample = catalogPaths.map(p => p.replace(":ticker", "005930"));
  const paidResults = await Promise.all(paidSample.map(p => probe(SERVICE + p, 402)));

  let tools = null;
  try {
    const res = await fetch(SERVICE + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT),
    });
    tools = (await res.json())?.result?.tools?.length ?? null;
  } catch {
    tools = null;
  }

  return {
    free: free.map((p, i) => ({ path: p, ...freeResults[i] })),
    freeOk: freeResults.filter(r => r.ok).length,
    paidOk: paidResults.filter(r => r.ok).length,
    paidTotal: paidResults.length,
    tools,
  };
}

async function collectListings() {
  const out = {};
  try {
    const res = await fetch("https://registry.modelcontextprotocol.io/v0/servers?search=k-data", {
      signal: AbortSignal.timeout(PROBE_TIMEOUT),
    });
    const json = await res.json();
    const servers = json.servers ?? json.data ?? [];
    const mine = servers.filter(s => (s.name ?? s.server?.name ?? "").includes("k-data-mcp"));
    const versions = mine.map(s => s.version ?? s.server?.version).filter(Boolean);
    out.registry = { ok: mine.length > 0, versions };
  } catch (err) {
    out.registry = { ok: false, error: String(err.message ?? err).slice(0, 120) };
  }

  try {
    const res = await fetch("https://registry.npmjs.org/k-data-mcp", {
      signal: AbortSignal.timeout(PROBE_TIMEOUT),
    });
    const json = await res.json();
    out.npm = { ok: true, version: json["dist-tags"]?.latest ?? null };
  } catch (err) {
    out.npm = { ok: false, error: String(err.message ?? err).slice(0, 120) };
  }

  for (const [key, repo] of [
    ["repoClient", "juh5ng/k-data-mcp"],
    ["repoServer", "juh5ng/k-data-x402"],
  ]) {
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "k-data-dashboard" },
        signal: AbortSignal.timeout(PROBE_TIMEOUT),
      });
      const json = await res.json();
      out[key] = { ok: res.ok, pushed_at: json.pushed_at ?? null, private: json.private ?? null };
    } catch (err) {
      out[key] = { ok: false, error: String(err.message ?? err).slice(0, 120) };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const esc = s =>
  String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const usd = n => `$${Number(n ?? 0).toFixed(n && Math.abs(n) >= 1 ? 2 : 4)}`;
const num = n => Number(n ?? 0).toLocaleString("en-US");
const day = ts => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "—");
const ago = ts => {
  if (!ts) return "—";
  const mins = Math.round((Date.now() / 1000 - ts) / 60);
  if (mins < 60) return `${mins}분 전`;
  if (mins < 1440) return `${Math.round(mins / 60)}시간 전`;
  return `${Math.round(mins / 1440)}일 전`;
};

function chip(state, label) {
  return `<span class="chip chip--${state}">${esc(label)}</span>`;
}

function sparkline(byDay) {
  const rows = [...byDay].reverse();
  if (rows.length < 2) return "";
  const vals = rows.map(r => Number(r.revenue ?? 0));
  const max = Math.max(...vals, 0.0001);
  const w = 640;
  const h = 90;
  const step = w / (vals.length - 1);
  const pts = vals.map((v, i) => [i * step, h - (v / max) * (h - 12) - 4]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const area = `${line}L${w},${h}L0,${h}Z`;
  const [lx, ly] = pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img"
    aria-label="일자별 매출 추이"><path class="spark__area" d="${area}"/><path class="spark__line" d="${line}"/>
    <circle class="spark__dot" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="3.5"/></svg>
    <div class="spark__axis"><span>${esc(rows[0].d)}</span><span>${esc(rows[rows.length - 1].d)}</span></div>`;
}

function revenueSection(rev, wallet) {
  if (!rev.available) {
    return `<p class="empty">매출 원장을 아직 읽을 수 없습니다. 첫 결제가 정산되면 <code>receipts</code>
      테이블이 생성됩니다.<br><span class="muted">${esc(rev.reason ?? "")}</span></p>`;
  }
  if (!rev.sales) {
    return `<p class="empty"><strong>아직 결제가 없습니다.</strong> 엔드포인트별 매출은 첫 판매부터 쌓입니다.
      지갑에 들어온 ${usd(wallet.usdc ?? 0)}는 부트스트랩 자가구매분입니다.</p>`;
  }

  const total = rev.byEndpoint.reduce((s, r) => s + Number(r.revenue ?? 0), 0) || 1;
  const rows = rev.byEndpoint
    .map(
      r => `<tr><td><code>${esc(r.endpoint)}</code></td><td>${chip("neutral", r.transport)}</td>
        <td class="n">${num(r.n)}</td><td class="n">${usd(r.revenue)}</td>
        <td class="n">${((Number(r.revenue) / total) * 100).toFixed(1)}%</td></tr>`,
    )
    .join("");

  const repeats = rev.byPayer.filter(p => Number(p.n) > 1).length;
  const payers = rev.byPayer
    .map(
      p => `<tr><td><code class="addr">${esc(p.payer)}</code></td>
        <td class="n">${num(p.n)}</td><td class="n">${usd(p.revenue)}</td>
        <td>${esc(day(p.first_seen))}</td><td>${esc(day(p.last_seen))}</td>
        <td>${Number(p.n) > 1 ? chip("good", "재구매") : chip("neutral", "1회")}</td></tr>`,
    )
    .join("");

  return `
    <div class="scroll"><table>
      <thead><tr><th>엔드포인트</th><th>경로</th><th class="n">건수</th><th class="n">매출</th><th class="n">비중</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${rev.byDay.length > 1 ? `<div class="spark__wrap">${sparkline(rev.byDay)}</div>` : ""}
    <h3>구매자 <span class="muted">— 재구매 ${repeats}명 / 전체 ${rev.byPayer.length}명</span></h3>
    <p class="note">같은 지갑이 두 번 이상 샀는지가 지금 단계에서 가장 중요한 신호입니다. 1회성 구매만 이어진다면
      발견은 됐지만 쓸모가 증명되지 않았다는 뜻입니다.</p>
    <div class="scroll"><table>
      <thead><tr><th>지갑</th><th class="n">건수</th><th class="n">매출</th><th>첫 구매</th><th>최근</th><th>구분</th></tr></thead>
      <tbody>${payers}</tbody>
    </table></div>
    ${rev.failed ? `<p class="warn">정산 실패 ${num(rev.failed)}건 — 구매를 시도했으나 결제가 완료되지 않았습니다.</p>` : ""}`;
}

const DISCOVERY = wallet => [
  {
    group: "직접 접근 — 에이전트가 서비스에서 직접 읽는 것",
    items: [
      [`${SERVICE}/api/catalog`, "카탈로그", "가격·스키마·출력 예시가 담긴 기계 판독용 목록. 설치형 클라이언트가 기동 시 이걸 읽어 도구를 만든다."],
      [`${SERVICE}/openapi.json`, "OpenAPI 3.1", "엔드포인트별 가격과 예시 응답. 에이전트가 어떤 걸 살지 판단하는 근거."],
      [`${SERVICE}/llms.txt`, "llms.txt", "LLM 대상 요약. 크롤러와 에이전트가 가장 먼저 보는 파일."],
      [`${SERVICE}/mcp`, "MCP 엔드포인트", "JSON-RPC. tools/list로 도구 12개를 노출하고 도구별로 과금한다."],
      [SERVICE, "랜딩 페이지", "사람이 보는 유일한 면. 가격표와 결제 방법을 담는다."],
    ],
  },
  {
    group: "x402 생태계 — 결제가 발생해야 등재된다",
    items: [
      ["https://www.x402scan.com/", "x402scan", "실제 정산 기록으로 색인된다. 자가구매 1건이 최초 등재를 만든 이유."],
      ["https://basescan.org/address/" + PAY_TO, "수취 지갑", `Base 메인넷 USDC 입금 내역. 현재 ${wallet.available ? usd(wallet.usdc) : "조회 실패"}.`],
    ],
  },
  {
    group: "MCP 생태계 — 설치형 클라이언트 유통",
    items: [
      ["https://registry.modelcontextprotocol.io/v0/servers?search=k-data", "공식 MCP Registry", "다른 디렉터리와 클라이언트가 여기를 피드로 읽는다. 가장 상류."],
      ["https://glama.ai/mcp/servers/@juh5ng/k-data-mcp", "Glama", "공개 저장소를 자동 색인. 재크롤 전까지 옛 도구 목록이 표시된다."],
      ["https://smithery.ai/", "Smithery", "웹 폼 제출 방식. 등록 여부는 수동 확인."],
      ["https://www.pulsemcp.com/", "PulseMCP", "웹 폼 제출 방식. 등록 여부는 수동 확인."],
    ],
  },
  {
    group: "패키지 · 소스",
    items: [
      ["https://www.npmjs.com/package/k-data-mcp", "npm", "설치형 클라이언트. npx k-data-mcp 로 바로 실행된다."],
      ["https://github.com/juh5ng/k-data-mcp", "클라이언트 저장소", "npm에 배포되는 소스. Glama가 색인하는 대상."],
      ["https://github.com/juh5ng/k-data-x402", "서버 저장소", "Worker 본체. 데이터·가격·아카이브가 여기서 결정된다."],
    ],
  },
];

function discoverySection(listings, wallet) {
  const status = url => {
    if (url.includes("registry.modelcontextprotocol.io")) {
      const r = listings.registry;
      return r?.ok ? chip("good", `등재 v${r.versions.join(", v")}`) : chip("bad", "미확인");
    }
    if (url.includes("npmjs.com")) {
      return listings.npm?.ok ? chip("good", `v${listings.npm.version}`) : chip("bad", "미확인");
    }
    if (url.includes("github.com/juh5ng/k-data-mcp")) {
      return listings.repoClient?.ok
        ? chip("good", `push ${String(listings.repoClient.pushed_at).slice(0, 10)}`)
        : chip("bad", "미확인");
    }
    if (url.includes("github.com/juh5ng/k-data-x402")) {
      return listings.repoServer?.ok
        ? chip("good", `push ${String(listings.repoServer.pushed_at).slice(0, 10)}`)
        : chip("bad", "미확인");
    }
    if (url.includes("glama.ai")) return chip("warn", "수동 확인");
    if (url.includes("smithery.ai") || url.includes("pulsemcp.com")) return chip("warn", "수동 확인");
    return chip("neutral", "링크");
  };

  return DISCOVERY(wallet)
    .map(
      // Not .h3: that style uppercases, and "x402" is a product name, not a label.
      g => `<h3 class="group">${esc(g.group)}</h3>
      <ul class="paths">${g.items
        .map(
          ([url, name, why]) => `<li>
            <div class="paths__head"><a href="${esc(url)}" target="_blank" rel="noopener">${esc(name)}</a>${status(url)}</div>
            <p>${esc(why)}</p>
            <code class="paths__url">${esc(url)}</code>
          </li>`,
        )
        .join("")}</ul>`,
    )
    .join("");
}

function render(d) {
  const w = d.wallet;
  const rev = d.revenue;
  const a = d.archive;
  const h = d.health;

  const cronPremium = a.available ? a.premium.latest : null;
  const premiumFresh = cronPremium && Date.now() / 1000 - cronPremium < 30 * 60;

  return `<title>K-Data 운영 대시보드</title>
<style>
  :root{
    --bg:#F2F5F4; --surface:#FFFFFF; --surface-2:#EAEFED; --line:#D5DEDA;
    --ink:#12201D; --muted:#61736E; --accent:#2C7A6A; --accent-soft:#DCEBE6;
    --good:#4C7A2B; --good-bg:#E8F1DE; --warn:#96690F; --warn-bg:#F7EDD8;
    --bad:#A93A2A; --bad-bg:#F7E2DE;
    --serif:ui-serif,"Iowan Old Style","Source Serif 4",Georgia,serif;
    --sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    --mono:ui-monospace,"SF Mono","Cascadia Mono",Consolas,monospace;
  }
  @media (prefers-color-scheme:dark){
    :root:not([data-theme="light"]){
      --bg:#0E1614; --surface:#16211E; --surface-2:#1D2A26; --line:#2B3B36;
      --ink:#E4EDEA; --muted:#93A6A0; --accent:#63C9B0; --accent-soft:#1B322C;
      --good:#9BC97A; --good-bg:#1F2E19; --warn:#DCB55E; --warn-bg:#332812;
      --bad:#E08A78; --bad-bg:#38201B;
    }
  }
  :root[data-theme="dark"]{
    --bg:#0E1614; --surface:#16211E; --surface-2:#1D2A26; --line:#2B3B36;
    --ink:#E4EDEA; --muted:#93A6A0; --accent:#63C9B0; --accent-soft:#1B322C;
    --good:#9BC97A; --good-bg:#1F2E19; --warn:#DCB55E; --warn-bg:#332812;
    --bad:#E08A78; --bad-bg:#38201B;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);
    line-height:1.6;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1080px;margin:0 auto;padding:2.5rem 1.25rem 4rem;
    display:flex;flex-direction:column;gap:2rem}
  header h1{font-family:var(--serif);font-size:clamp(1.6rem,3.5vw,2.2rem);margin:0;
    letter-spacing:-.01em;text-wrap:balance}
  header p{margin:.35rem 0 0;color:var(--muted);font-size:.93rem}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1px;
    background:var(--line);border:1px solid var(--line);border-radius:10px;overflow:hidden}
  .stat{background:var(--surface);padding:1rem 1.1rem}
  .stat__label{font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
  .stat__value{font-family:var(--mono);font-variant-numeric:tabular-nums;
    font-size:1.5rem;margin-top:.3rem;letter-spacing:-.02em}
  .stat__sub{font-size:.8rem;color:var(--muted);margin-top:.15rem}
  section{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:1.4rem 1.5rem}
  section>h2{font-family:var(--serif);font-size:1.15rem;margin:0 0 .2rem;letter-spacing:-.01em}
  section>.sub{color:var(--muted);font-size:.86rem;margin:0 0 1.1rem}
  h3{font-size:.82rem;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);
    margin:1.6rem 0 .6rem;font-weight:600}
  h3:first-of-type{margin-top:.4rem}
  h3.group{text-transform:none;letter-spacing:0;font-size:.9rem;color:var(--ink);font-weight:600}
  .scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
  table{width:100%;border-collapse:collapse;font-size:.88rem;min-width:520px}
  th{text-align:left;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;
    color:var(--muted);font-weight:600;padding:.4rem .6rem;border-bottom:1px solid var(--line)}
  td{padding:.5rem .6rem;border-bottom:1px solid var(--line)}
  tr:last-child td{border-bottom:none}
  td.n,th.n{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums}
  code{font-family:var(--mono);font-size:.85em;background:var(--surface-2);
    padding:.1em .35em;border-radius:4px}
  .addr{font-size:.78em;word-break:break-all}
  .chip{display:inline-block;font-size:.7rem;font-weight:600;letter-spacing:.03em;
    padding:.15em .55em;border-radius:999px;white-space:nowrap}
  .chip--good{background:var(--good-bg);color:var(--good)}
  .chip--warn{background:var(--warn-bg);color:var(--warn)}
  .chip--bad{background:var(--bad-bg);color:var(--bad)}
  .chip--neutral{background:var(--surface-2);color:var(--muted)}
  .paths{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.85rem}
  .paths li{border-left:2px solid var(--accent-soft);padding-left:.9rem}
  .paths__head{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap}
  .paths__head a{color:var(--accent);font-weight:600;text-decoration:none}
  .paths__head a:hover,.paths__head a:focus-visible{text-decoration:underline}
  .paths p{margin:.2rem 0 .25rem;font-size:.87rem;color:var(--muted)}
  .paths__url{font-size:.74rem;word-break:break-all;background:none;padding:0;color:var(--muted)}
  .empty{background:var(--surface-2);border-radius:8px;padding:1rem 1.1rem;margin:0;font-size:.9rem}
  .note{font-size:.85rem;color:var(--muted);margin:.2rem 0 .8rem}
  .warn{color:var(--warn);font-size:.87rem;margin:.9rem 0 0}
  .muted{color:var(--muted);font-weight:400}
  .spark__wrap{margin:1.4rem 0 .4rem}
  .spark{width:100%;height:90px;display:block}
  .spark__area{fill:var(--accent-soft)}
  .spark__line{fill:none;stroke:var(--accent);stroke-width:2;stroke-linejoin:round}
  .spark__dot{fill:var(--accent)}
  .spark__axis{display:flex;justify-content:space-between;font-family:var(--mono);
    font-size:.72rem;color:var(--muted);margin-top:.2rem}
  .kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:.9rem}
  .kv div{background:var(--surface-2);border-radius:8px;padding:.7rem .85rem}
  .kv dt{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
  .kv dd{margin:.2rem 0 0;font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:1.05rem}
  footer{color:var(--muted);font-size:.78rem;text-align:center}
  a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>

<div class="wrap">
  <header>
    <h1>K-Data 운영 대시보드</h1>
    <p>${esc(d.generatedAt)} 기준 · 에이전트에게 한국 시장 데이터를 x402/USDC로 판매</p>
  </header>

  <div class="stats">
    <div class="stat"><div class="stat__label">지갑 잔액</div>
      <div class="stat__value">${w.available ? usd(w.usdc) : "—"}</div>
      <div class="stat__sub">Base 메인넷 USDC</div></div>
    <div class="stat"><div class="stat__label">누적 매출</div>
      <div class="stat__value">${rev.available ? usd(rev.revenue) : "—"}</div>
      <div class="stat__sub">${
        !rev.available ? "원장 생성 전" : rev.since ? `집계 시작 ${esc(day(rev.since))}` : "첫 판매 대기"
      }</div></div>
    <div class="stat"><div class="stat__label">판매 건수</div>
      <div class="stat__value">${rev.available ? num(rev.sales) : "—"}</div>
      <div class="stat__sub">${rev.available && rev.failed ? `정산 실패 ${num(rev.failed)}건` : "정산 실패 없음"}</div></div>
    <div class="stat"><div class="stat__label">서비스 상태</div>
      <div class="stat__value">${h.tools ?? "—"}<span style="font-size:.9rem;color:var(--muted)"> 도구</span></div>
      <div class="stat__sub">유료 ${h.paidOk}/${h.paidTotal} · 무료 ${h.freeOk}/${h.free.length}</div></div>
  </div>

  <section>
    <h2>매출</h2>
    <p class="sub">무엇이 팔렸는지는 정산 영수증에서만 알 수 있습니다 — 카탈로그 가격이 엔드포인트끼리 겹쳐
      온체인 금액만으로는 구분되지 않습니다.</p>
    ${revenueSection(rev, w)}
  </section>

  <section>
    <h2>에이전트가 우리를 찾는 경로</h2>
    <p class="sub">각 경로가 무엇을 노출하는지와 현재 상태입니다. SPA로 된 디렉터리는 자동 확인이 불가능해
      수동 확인 표시를 답니다.</p>
    ${discoverySection(d.listings, w)}
  </section>

  <section>
    <h2>서비스 상태</h2>
    <p class="sub">유료 라우트는 402를, 무료 라우트는 200을 반환해야 정상입니다. 유료가 200이면 페이월이 열린 것입니다.</p>
    <div class="kv">
      <div><dt>유료 라우트</dt><dd>${h.paidOk} / ${h.paidTotal} <span style="font-size:.8rem">402</span></dd></div>
      <div><dt>무료 라우트</dt><dd>${h.freeOk} / ${h.free.length} <span style="font-size:.8rem">200</span></dd></div>
      <div><dt>MCP 도구</dt><dd>${h.tools ?? "—"}</dd></div>
      <div><dt>프리미엄 cron</dt><dd style="font-size:.9rem">${premiumFresh ? "정상" : "지연"} · ${esc(ago(cronPremium))}</dd></div>
    </div>
  </section>

  <section>
    <h2>아카이브 — 복리로 쌓이는 자산</h2>
    <p class="sub">목록 사이트는 최근 구간만 노출하므로 사후 재구성이 불가능합니다. 매일 늘어난 만큼이 해자입니다.</p>
    ${
      a.available
        ? `<div class="kv">
      <div><dt>리서치 리포트</dt><dd>${num(a.research.n)}</dd></div>
      <div><dt>요약 완료</dt><dd>${num(a.research.done)}</dd></div>
      <div><dt>커버 종목</dt><dd>${num(a.research.tickers)}</dd></div>
      <div><dt>증권사</dt><dd>${num(a.research.brokers)}</dd></div>
      <div><dt>최신 리포트</dt><dd style="font-size:.95rem">${esc(a.research.newest ?? "—")}</dd></div>
      <div><dt>프리미엄 스냅샷</dt><dd>${num(a.premium.n)}</dd></div>
    </div>`
        : `<p class="empty">아카이브를 읽지 못했습니다.<br><span class="muted">${esc(a.reason ?? "")}</span></p>`
    }
  </section>

  <footer>매일 아침 routine이 <code>npm run dashboard</code>를 실행해 이 페이지를 갱신합니다.</footer>
</div>
`;
}

// ---------------------------------------------------------------------------

async function main() {
  const catalogPaths = ["/api/research/consensus/:ticker", "/api/kimchi-premium", "/api/fx/usdkrw"];
  console.log("collecting…");

  const [wallet, listings, health] = await Promise.all([
    collectWallet(),
    collectListings(),
    collectHealth(catalogPaths),
  ]);
  const revenue = collectRevenue();
  const archive = collectArchive();

  const data = {
    generatedAt: new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) + " KST",
    wallet,
    revenue,
    archive,
    health,
    listings,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, "index.html");
  writeFileSync(file, render(data), "utf8");

  console.log(`wallet    : ${wallet.available ? usd(wallet.usdc) : "unavailable — " + wallet.reason}`);
  console.log(
    `revenue   : ${revenue.available ? `${revenue.sales} sales, ${usd(revenue.revenue)}` : "ledger not created yet"}`,
  );
  console.log(`health    : paid ${health.paidOk}/${health.paidTotal}, free ${health.freeOk}/${health.free.length}, tools ${health.tools}`);
  console.log(`archive   : ${archive.available ? `${archive.research.n} reports` : "unavailable"}`);
  console.log(`\nwrote ${file}`);
}

await main();
