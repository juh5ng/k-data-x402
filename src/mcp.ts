import { x402ResourceServer } from "@x402/core/server";
import type { FacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createPaymentWrapper } from "@x402/mcp";

import { ENDPOINTS, SERVICE_NAME, SERVICE_TAGLINE, type EndpointEntry } from "./catalog";
import { runEndpoint, NotFoundError, type HandlerEnv } from "./handlers";

/**
 * Stateless MCP endpoint, spoken directly over JSON-RPC.
 *
 * The MCP SDK's HTTP transports are written against Node's req/res objects and
 * do not run on Workers, but a tools-only server needs just three methods, so
 * the protocol is handled here and `createPaymentWrapper` is invoked directly.
 * Payment travels in the request's `_meta`, exactly as an x402 MCP client sends
 * it, so this stays wire-compatible without the SDK's server plumbing.
 *
 * Tools mirror the HTTP catalogue one-for-one and execute through the same
 * `runEndpoint`, so the two transports cannot drift in behaviour or price.
 */

const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

/** `/api/kimchi-premium/stats` -> `kimchi_premium_stats` */
export function toolNameFor(path: string): string {
  return path
    .replace(/^\/api\//, "")
    .replace(/:/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function inputSchemaFor(e: EndpointEntry): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  const pathProps = (e.pathParamsSchema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, spec] of Object.entries(pathProps)) {
    properties[name] = { type: spec.type ?? "string", description: spec.description };
    required.push(name);
  }
  const queryProps = (e.querySchema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, spec] of Object.entries(queryProps)) {
    properties[name] = spec.enum
      ? { type: spec.type ?? "string", enum: spec.enum, description: spec.description }
      : { type: spec.type ?? "string", description: spec.description };
  }

  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

function toolDescriptor(e: EndpointEntry) {
  return {
    name: toolNameFor(e.path),
    description: `${e.description} Costs ${e.price_usd} in USDC per call, settled via x402.`,
    inputSchema: inputSchemaFor(e),
  };
}

function rpcResult(id: JsonRpcRequest["id"], result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message, data } });
}

export interface McpEnv extends HandlerEnv {
  NETWORK: string;
  PAY_TO: string;
}

/**
 * Handles one MCP JSON-RPC request.
 * `makeFacilitator` is a thunk so the facilitator client is only constructed
 * for calls that actually need payment verification.
 */
export async function handleMcpRequest(
  request: Request,
  env: McpEnv,
  makeFacilitator: () => FacilitatorClient,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("MCP endpoint accepts POST with a JSON-RPC body.", {
      status: 405,
      headers: { allow: "POST" },
    });
  }

  let body: JsonRpcRequest;
  try {
    body = (await request.json()) as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, "Parse error: body must be JSON-RPC 2.0.");
  }

  const { id, method, params } = body;

  // Notifications carry no id and expect no body.
  if (method?.startsWith("notifications/")) return new Response(null, { status: 202 });

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVICE_NAME, version: "1.1.0" },
        instructions: `${SERVICE_TAGLINE}\n\nEvery tool is metered per call in USDC over x402. Calling a tool without payment returns a payment-required error carrying the exact requirements; an x402-capable client pays and retries automatically.`,
      });

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, { tools: ENDPOINTS.map(toolDescriptor) });

    case "tools/call": {
      const name = String(params?.name ?? "");
      const endpoint = ENDPOINTS.find(e => toolNameFor(e.path) === name);
      if (!endpoint) return rpcError(id, -32602, `Unknown tool: ${name}`);

      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      const network = env.NETWORK as `${string}:${string}`;

      const resourceServer = new x402ResourceServer(makeFacilitator()).register(
        network,
        new ExactEvmScheme(),
      );
      await resourceServer.initialize();

      const accepts = await resourceServer.buildPaymentRequirements({
        scheme: "exact",
        network,
        payTo: env.PAY_TO,
        price: endpoint.price_usd,
      });

      // Naming the resource matters: it is what identifies this tool in the
      // Bazaar catalogue. Left unset it defaults to a generic placeholder.
      const paid = createPaymentWrapper(resourceServer, {
        accepts,
        resource: {
          url: `mcp://tool/${name}`,
          description: endpoint.description,
          mimeType: "application/json",
          serviceName: SERVICE_NAME,
          tags: [
            "korea",
            "crypto",
            "kimchi-premium",
            "market-data",
            "news",
            "equity-research",
            "analyst-ratings",
          ],
        },
      });
      const handler = paid(async (toolArgs: Record<string, unknown>) => {
        try {
          const data = await runEndpoint(endpoint.path, toolArgs, env);
          return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
        } catch (err) {
          if (err instanceof NotFoundError) {
            return {
              isError: true,
              content: [
                { type: "text" as const, text: [err.message, err.hint].filter(Boolean).join(" ") },
              ],
            };
          }
          throw err;
        }
      });

      try {
        // The wrapper reads the payment out of `_meta`, where x402 MCP clients put it.
        const result = await handler(args, { _meta: params?._meta });
        return rpcResult(id, result);
      } catch (err) {
        const e = err as { code?: number; message?: string; data?: unknown };
        if (typeof e?.code === "number") return rpcError(id, e.code, e.message ?? "Payment required", e.data);
        return rpcError(id, -32603, `Tool execution failed: ${e?.message ?? String(err)}`);
      }
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
