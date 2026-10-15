/**
 * Adapters: the network half of each provider.
 *
 * Each adapter owns the official usage endpoint, the credential shape it needs,
 * and the normalization of that provider's payload into bar windows.
 *
 * Adding a subscription means one registry entry plus one adapter here — the
 * fetch loop, cache, backoff, rendering and commands are provider-agnostic.
 *
 * Command Code / GOAT is intentionally not an adapter: `commandcode-go-for-pi`
 * owns that provider, its auth, its failover and its own `cc-quota` widget.
 */

import type { AdapterOutcome, BarWindow, QuotaProviderId } from "./types.ts";
import { resolveAuth } from "./auth.ts";
import { parseProviderPayload, sortWindows } from "./parsers.ts";
import { PROVIDER_DESCRIPTORS } from "./registry.ts";
import { redact } from "./util.ts";

export interface Adapter {
  id: QuotaProviderId;
  /** Official origin. Credentials are only ever sent here. */
  origin: string;
  request(
    auth: { secret: string; extra?: Record<string, string>; baseUrl?: string },
    signal: AbortSignal,
  ): Promise<unknown>;
}

const TIMEOUT_MS = 15_000;

async function getJson(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  secrets: readonly string[],
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json", ...headers },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const detail = redact(body, secrets).slice(0, 120);
      throw new Error(`HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("invalid JSON response");
    }
  } catch (error) {
    if (signal.aborted) throw new Error("request cancelled");
    if (controller.signal.aborted) throw new Error("request timed out");
    throw error instanceof Error
      ? new Error(redact(error.message, secrets))
      : new Error("request failed");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

const REQUESTS: Record<
  QuotaProviderId,
  { origin: string; request: Adapter["request"] }
> = {
  claude: {
    origin: "https://api.anthropic.com",
    request: ({ secret }, signal) =>
      getJson(
        "https://api.anthropic.com/api/oauth/usage",
        {
          Authorization: `Bearer ${secret}`,
          "anthropic-beta": "oauth-2025-04-20",
          "user-agent": "pi-quota-bar",
        },
        signal,
        [secret],
      ),
  },
  codex: {
    origin: "https://chatgpt.com",
    request: ({ secret, extra }, signal) =>
      getJson(
        "https://chatgpt.com/backend-api/wham/usage",
        {
          Authorization: `Bearer ${secret}`,
          ...(extra?.accountId ? { "ChatGPT-Account-Id": extra.accountId } : {}),
          origin: "https://chatgpt.com",
          referer: "https://chatgpt.com/",
          "user-agent": "Mozilla/5.0",
        },
        signal,
        [secret],
      ),
  },
  opencode: {
    origin: "https://opencode.ai",
    request: ({ secret }, signal) =>
      getJson(
        "https://opencode.ai/zen/go/v1/usage",
        { Authorization: `Bearer ${secret}` },
        signal,
        [secret],
      ),
  },
  opendesign: {
    origin: "https://amr-link.open-design.ai",
    // resolveAuth() reports `unavailable` before a request is issued, so this
    // is unreachable. It exists to keep the adapter shape uniform and to
    // document that the gateway exposes no usage route.
    request: () => Promise.reject(new Error("OpenDesign exposes no control-plane usage API")),
  },
  zai: {
    origin: "https://open.bigmodel.cn",
    request: ({ secret, baseUrl }, signal) =>
      getJson(
        `${baseUrl ?? "https://open.bigmodel.cn"}/api/monitor/usage/quota/limit`,
        { Authorization: `Bearer ${secret}` },
        signal,
        [secret],
      ),
  },
  minimax: {
    origin: "https://api.minimaxi.com",
    request: ({ secret, baseUrl }, signal) =>
      getJson(
        `${baseUrl ?? "https://api.minimaxi.com"}/v1/token_plan/remains`,
        { Authorization: `Bearer ${secret}` },
        signal,
        [secret],
      ),
  },
};

export const ADAPTERS: readonly Adapter[] = PROVIDER_DESCRIPTORS.map((descriptor) => ({
  id: descriptor.id,
  origin: REQUESTS[descriptor.id].origin,
  request: REQUESTS[descriptor.id].request,
}));

/**
 * Fetch and normalize one provider's usage.
 *
 * Never throws: every failure mode becomes an outcome the renderer understands,
 * so one broken provider cannot affect the others or the session.
 */
export async function fetchProvider(
  adapter: Adapter,
  signal: AbortSignal,
): Promise<AdapterOutcome> {
  const auth = resolveAuth(adapter.id);
  if (!auth.ok) {
    return auth.kind === "unconfigured"
      ? { kind: "unconfigured", reason: auth.reason }
      : auth.kind === "not_applicable"
        ? { kind: "not_applicable", reason: auth.reason }
        : { kind: "unavailable", reason: auth.reason };
  }

  try {
    const payload = await adapter.request(auth, signal);
    const windows: BarWindow[] | undefined = parseProviderPayload(adapter.id, payload);
    if (!windows || windows.length === 0) {
      return { kind: "error", reason: "no usage data in response" };
    }
    return { kind: "ok", windows: sortWindows(windows) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "request failed";
    return { kind: "error", reason: redact(reason, [auth.secret]) };
  }
}
