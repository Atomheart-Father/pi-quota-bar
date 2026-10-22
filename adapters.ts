/**
 * Adapters: the network half of each provider.
 *
 * Each adapter owns the official usage endpoint, the credential shape it needs,
 * and the normalization of that provider's payload into bar windows.
 *
 * Adding a subscription means one registry entry plus one adapter here — the
 * fetch loop, cache, backoff, rendering and commands are provider-agnostic.
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
  commandcode: {
    origin: "https://api.commandcode.ai",
    // Command Code needs a composite request: `whoami` supplies the account,
    // and the per-personal-account endpoints reject an `orgId` parameter
    // outright (400 Invalid UUID), so it is only sent when a real org exists.
    // Credits and subscription are fetched together, then the usage summary is
    // scoped to the subscription's own start — unscoped, it returns lifetime
    // totals and a monthly percentage would be meaningless.
    request: async ({ secret }, signal) => {
      const headers = { Authorization: `Bearer ${secret}` };
      const base = "https://api.commandcode.ai";
      const whoami = await getJson(`${base}/alpha/whoami`, headers, signal, [secret]);
      const orgId = commandCodeOrgId(whoami);
      const withOrg = (path: string): string =>
        orgId ? `${base}${path}?orgId=${encodeURIComponent(orgId)}` : `${base}${path}`;

      const [credits, subscription] = await Promise.all([
        getJson(withOrg("/alpha/billing/credits"), headers, signal, [secret]),
        getJson(withOrg("/alpha/billing/subscriptions"), headers, signal, [secret]).catch(
          () => null,
        ),
      ]);

      // Summary and subscription are both best-effort: the window limits above
      // are the load-bearing numbers, and they survive either failing.
      const periodStart = commandCodePeriodStart(subscription);
      const since = periodStart ? `?since=${encodeURIComponent(periodStart)}` : "";
      const summary = await getJson(
        `${base}/alpha/usage/summary${since}`,
        headers,
        signal,
        [secret],
      ).catch(() => null);

      return { whoami, credits, subscription, summary };
    },
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

/**
 * Command Code returns `{ org: { id } }` for team accounts and `org: null` for
 * personal ones. Only a real id may be passed as `orgId`.
 */
function commandCodeOrgId(whoami: unknown): string | undefined {
  if (!whoami || typeof whoami !== "object") return undefined;
  const org = (whoami as { org?: unknown }).org;
  if (!org || typeof org !== "object") return undefined;
  const id = (org as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * The billing period start, used to scope the usage summary.
 *
 * Without it the summary endpoint returns lifetime totals, which would make a
 * monthly percentage meaningless.
 */
function commandCodePeriodStart(subscription: unknown): string | undefined {
  if (!subscription || typeof subscription !== "object") return undefined;
  const data = (subscription as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const start = (data as { currentPeriodStart?: unknown }).currentPeriodStart;
  if (typeof start === "string" && start.length > 0) return start;
  if (typeof start === "number" && Number.isFinite(start)) return new Date(start).toISOString();
  return undefined;
}

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
