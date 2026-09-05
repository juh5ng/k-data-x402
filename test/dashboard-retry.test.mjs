import assert from "node:assert/strict";
import test from "node:test";

let retrySync;
try {
  ({ retrySync } = await import("../scripts/retry-sync.mjs"));
} catch {
  // The first TDD run intentionally reaches this branch before the helper exists.
}

test("retries one transient failure before returning the successful result", () => {
  let attempts = 0;
  const result = retrySync?.(() => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary D1 failure");
    return "six sales";
  }, 2);

  assert.equal(result, "six sales");
  assert.equal(attempts, 2);
});
