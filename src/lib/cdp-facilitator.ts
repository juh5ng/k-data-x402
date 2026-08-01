import { HTTPFacilitatorClient } from "@x402/core/server";

/**
 * CDP-authenticated x402 facilitator client built on the Workers-native Web
 * Crypto API.
 *
 * This replaces `createCdpFacilitatorClient` from `@coinbase/cdp-sdk/x402`.
 * That SDK signs its JWTs with `jose`, and wrangler's esbuild wraps `jose` in a
 * lazy-init module whose hoisted `isObject` runs before `isObjectLike` is
 * assigned — every facilitator call died with "isObjectLike is not a function".
 * The JWT itself is small and fully specified, so we sign it directly and drop
 * the SDK (plus jose and uncrypto) from the bundle entirely.
 *
 * Wire format must stay byte-compatible with the SDK:
 *   header  { alg: "EdDSA", kid: <apiKeyId>, typ: "JWT", nonce: <32 hex chars> }
 *   payload { sub: <apiKeyId>, iss: "cdp", uris: ["<METHOD> <host><path>"],
 *             iat, nbf, exp }
 */

export const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";

function base64UrlFromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlFromString(s: string): string {
  return base64UrlFromBytes(new TextEncoder().encode(s));
}

function bytesFromBase64(b64: string): Uint8Array {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Ed25519 is exposed as "Ed25519" on current Workers and "NODE-ED25519" on older ones. */
async function importEd25519(seed: Uint8Array, publicKey: Uint8Array): Promise<CryptoKey> {
  const jwk: JsonWebKey = {
    kty: "OKP",
    crv: "Ed25519",
    d: base64UrlFromBytes(seed),
    x: base64UrlFromBytes(publicKey),
  };
  try {
    return await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
  } catch {
    return await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "NODE-ED25519", namedCurve: "NODE-ED25519" } as unknown as Parameters<SubtleCrypto["importKey"]>[2],
      false,
      ["sign"],
    );
  }
}

async function signEd25519(key: CryptoKey, data: Uint8Array): Promise<ArrayBuffer> {
  try {
    return await crypto.subtle.sign({ name: "Ed25519" }, key, data as BufferSource);
  } catch {
    return await crypto.subtle.sign(
      { name: "NODE-ED25519" } as unknown as Parameters<SubtleCrypto["sign"]>[0],
      key,
      data as BufferSource,
    );
  }
}

async function generateCdpJwt(
  apiKeyId: string,
  apiKeySecret: string,
  method: string,
  host: string,
  path: string,
): Promise<string> {
  const decoded = bytesFromBase64(apiKeySecret);
  if (decoded.length !== 64) {
    throw new Error(
      `CDP_API_KEY_SECRET must be a base64 Ed25519 key of 64 bytes (got ${decoded.length}). ` +
        "Copy the Secret API Key value from the CDP portal exactly as shown.",
    );
  }
  const key = await importEd25519(decoded.subarray(0, 32), decoded.subarray(32));

  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = Array.from(nonceBytes, b => b.toString(16).padStart(2, "0")).join("");

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "EdDSA", kid: apiKeyId, typ: "JWT", nonce };
  const payload = {
    sub: apiKeyId,
    iss: "cdp",
    uris: [`${method} ${host}${path}`],
    iat: now,
    nbf: now,
    exp: now + 120,
  };

  const signingInput = `${base64UrlFromString(JSON.stringify(header))}.${base64UrlFromString(
    JSON.stringify(payload),
  )}`;
  const sig = await signEd25519(key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64UrlFromBytes(new Uint8Array(sig))}`;
}

export function createCdpFacilitatorClient(args: {
  apiKeyId: string;
  apiKeySecret: string;
  baseUrl?: string;
}): HTTPFacilitatorClient {
  const baseUrl = args.baseUrl ?? CDP_FACILITATOR_URL;
  const parsed = new URL(baseUrl);
  const host = parsed.host;
  const basePath = parsed.pathname.replace(/\/$/, "");

  const headersFor = async (method: string, path: string) => ({
    Authorization: `Bearer ${await generateCdpJwt(args.apiKeyId, args.apiKeySecret, method, host, path)}`,
    "Correlation-Context": "sdkLanguage=typescript,source=k-data-x402",
  });

  return new HTTPFacilitatorClient({
    url: baseUrl,
    createAuthHeaders: async () => {
      const [verify, settle, supported] = await Promise.all([
        headersFor("POST", `${basePath}/verify`),
        headersFor("POST", `${basePath}/settle`),
        headersFor("GET", `${basePath}/supported`),
      ]);
      return { verify, settle, supported };
    },
  });
}
