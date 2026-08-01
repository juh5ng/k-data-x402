/**
 * "Buyer agent" — pays for an endpoint with x402 and prints the data.
 * This is the bootstrap purchase: the first settlement is what gets the
 * service indexed by x402scan and the x402 Bazaar so other agents find it.
 *
 * Build:
 *   npx esbuild test/agent-client.ts --bundle --format=esm --platform=node --outfile=.wrangler/agent.mjs
 * Run (wallet needs USDC + a little ETH for gas on the target network):
 *   EVM_PRIVATE_KEY=0x... node .wrangler/agent.mjs <url>
 */
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const key = process.env.EVM_PRIVATE_KEY as `0x${string}` | undefined;
if (!key) {
  console.error("EVM_PRIVATE_KEY env var is required (wallet funded with USDC on the target network)");
  process.exit(1);
}
const url = process.argv[2] ?? "https://k-data-x402-production.theblack1022.workers.dev/api/fx/usdkrw";

const account = privateKeyToAccount(key);
console.log(`Buyer wallet: ${account.address}`);
console.log(`Target:       ${url}\n`);

// Show what the server is asking for before paying.
const probe = await fetch(url);
const header = probe.headers.get("payment-required");
if (probe.status !== 402 || !header) {
  console.error(`Expected 402 with a PAYMENT-REQUIRED header, got ${probe.status}.`);
  process.exit(1);
}
const required = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
for (const a of required.accepts ?? []) {
  console.log(`Price: ${Number(a.amount) / 1e6} ${a.extra?.name ?? "USDC"} on ${a.network}`);
  console.log(`Pays to: ${a.payTo}`);
  console.log(`Asset:   ${a.asset}\n`);
}

const client = new x402Client();
client.register("eip155:*", new ExactEvmScheme(account));
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

let res: Response;
try {
  res = await fetchWithPayment(url, { method: "GET" });
} catch (err) {
  console.error("Payment failed:", (err as Error)?.message ?? err);
  console.error("\nMost common cause: the wallet holds no USDC on this network, or no ETH for gas.");
  process.exit(1);
}

if (res.status === 402) {
  console.error("Still 402 after the payment attempt — the client did not produce a valid payment.");
  console.error("Check that the wallet holds USDC on the network shown above.");
  process.exit(1);
}

console.log(`HTTP ${res.status}`);
console.log("Data:", JSON.stringify(await res.json(), null, 2));

try {
  const settle = new x402HTTPClient(client).getPaymentSettleResponse(n => res.headers.get(n));
  console.log("\nSettlement:", JSON.stringify(settle, null, 2));
  if (settle?.transaction) {
    console.log(`\nOn-chain: https://basescan.org/tx/${settle.transaction}`);
  }
} catch {
  console.log("\n(no settlement header returned)");
}
