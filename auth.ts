/**
 * Credential resolution.
 *
 * Read-only by design:
 *   - never writes `auth.json`
 *   - never refreshes or mutates an OAuth token (Pi owns that lifecycle)
 *   - never logs, caches or transmits a credential anywhere but its own
 *     provider's official origin
 *
 * Only the *derived* usage numbers are ever persisted (see cache.ts).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { QuotaProviderId } from "./types.ts";

type Credential =
  | { type: "api_key"; key?: string }
  | { type: "oauth"; access?: string; refresh?: string; expires?: number }
  | undefined;

export type AuthResult =
  | { ok: true; secret: string; extra?: Record<string, string>; baseUrl?: string }
  | { ok: false; reason: string; kind: "unconfigured" | "not_applicable" };

function stored(provider: string): Credential {
  try {
    return readStoredCredential(provider) as Credential;
  } catch {
    return undefined;
  }
}

function apiKey(provider: string): string | undefined {
  const credential = stored(provider);
  if (!credential || credential.type !== "api_key") return undefined;
  const key = credential.key;
  return typeof key === "string" && key.trim().length > 0 ? key.trim() : undefined;
}

function oauthAccess(provider: string): { access: string; expires?: number } | undefined {
  const credential = stored(provider);
  if (!credential || credential.type !== "oauth") return undefined;
  const access = credential.access;
  if (typeof access !== "string" || access.trim().length === 0) return undefined;
  return {
    access: access.trim(),
    ...(typeof credential.expires === "number" ? { expires: credential.expires } : {}),
  };
}

function authPath(): string {
  return join(getAgentDir(), "auth.json");
}

/**
 * Claude Pro/Max subscription usage.
 *
 * The usage endpoint is OAuth-only. A direct API key (`sk-ant-api…`) authorizes
 * model calls but has no subscription windows, so it is reported as
 * not-applicable rather than as a failure — the same distinction the upstream
 * pi-usage extension draws.
 */
function resolveClaude(): AuthResult {
  const oauth = oauthAccess("anthropic");
  if (!oauth) {
    const direct = apiKey("anthropic");
    if (direct) {
      return {
        ok: false,
        kind: "not_applicable",
        reason: "direct Anthropic API key — no subscription usage",
      };
    }
    return { ok: false, kind: "unconfigured", reason: "no Claude credential" };
  }
  if (oauth.access.startsWith("sk-ant-api")) {
    return {
      ok: false,
      kind: "not_applicable",
      reason: "direct Anthropic API key — no subscription usage",
    };
  }
  // An expired access token is still sent: Pi refreshes it on the next model
  // call, and a 401 here is reported as a plain error rather than a guess.
  return { ok: true, secret: oauth.access };
}

/**
 * Codex / ChatGPT subscription usage.
 *
 * Two credential sources exist and they are NOT interchangeable: the ChatGPT
 * `wham/usage` endpoint authorizes the account that owns the subscription.
 * The Codex CLI's own credential is tried first because a Pi-level `openai`
 * token can belong to an account with no ChatGPT subscription, which the
 * endpoint rejects with 401 `rejected_by_access_enforcement`.
 */
function resolveCodex(): AuthResult {
  try {
    const raw = readFileSync(join(homedir(), ".codex", "auth.json"), "utf8");
    const tokens = (JSON.parse(raw) as { tokens?: Record<string, unknown> }).tokens;
    const access = typeof tokens?.access_token === "string" ? tokens.access_token : undefined;
    if (access) {
      const accountId =
        typeof tokens?.account_id === "string" ? tokens.account_id : undefined;
      return {
        ok: true,
        secret: access,
        ...(accountId ? { extra: { accountId } } : {}),
      };
    }
  } catch {
    // No Codex CLI credential on this machine — fall through to Pi's store.
  }

  const fromPi = oauthAccess("openai-codex")?.access ?? oauthAccess("openai")?.access;
  if (fromPi) return { ok: true, secret: fromPi };

  return { ok: false, kind: "unconfigured", reason: "no Codex credential" };
}

/**
 * Command Code.
 *
 * Two auth entries can exist because the deleted community plugin stored one
 * under `commandcode` while the official provider uses `command-code`; both
 * carry the same personal API key, so either works. Some hosts also expose a
 * literal variable *name* as the key, which is rejected rather than sent.
 */
function resolveCommandCode(): AuthResult {
  const placeholders = new Set(["CMD_API_KEY", "COMMAND_CODE_API_KEY", "$CMD_API_KEY"]);
  const candidates = [
    process.env.CMD_API_KEY?.trim(),
    process.env.COMMAND_CODE_API_KEY?.trim(),
    apiKey("command-code"),
    apiKey("commandcode"),
  ];
  for (const candidate of candidates) {
    if (!candidate || placeholders.has(candidate)) continue;
    return { ok: true, secret: candidate };
  }
  return { ok: false, kind: "unconfigured", reason: "no Command Code credential" };
}

function resolveOpenCode(): AuthResult {
  const envFirst = process.env.OPENCODE_GO_API_KEY?.trim();
  if (envFirst) return { ok: true, secret: envFirst };
  const key = apiKey("opencode-go");
  if (key) return { ok: true, secret: key };
  const envGeneric = process.env.OPENCODE_API_KEY?.trim();
  if (envGeneric) return { ok: true, secret: envGeneric };
  return { ok: false, kind: "unconfigured", reason: "no OpenCode Go credential" };
}

/**
 * OpenDesign Go.
 *
 * The stored `sk-amr-…` key is a data-plane model key. Every control-plane
 * usage path on the gateway and the public site returns 404, and a successful
 * `/v1/chat/completions` response carries no quota header — only token counts
 * and routing metadata. There is therefore no server-side allowance to read,
 * and this adapter reports that plainly instead of estimating from token
 * counts × a hardcoded price.
 */
function resolveOpenDesign(): AuthResult {
  const key = apiKey("opendesign");
  if (!key) return { ok: false, kind: "unconfigured", reason: "no OpenDesign credential" };
  return {
    ok: false,
    kind: "unavailable",
    reason: "no control-plane usage API (model key only)",
  };
}

/** Z.AI / GLM Coding Plan. The CN origin is the only one that serves the quota route. */
function resolveZai(): AuthResult {
  const envKey = process.env.ZAI_CODING_CN_API_KEY?.trim() ?? process.env.ZAI_API_KEY?.trim();
  const cnKey = apiKey("zai-coding-cn");
  if (cnKey) return { ok: true, secret: cnKey, baseUrl: "https://open.bigmodel.cn" };
  if (envKey) return { ok: true, secret: envKey, baseUrl: "https://open.bigmodel.cn" };
  const intlKey = apiKey("zai");
  if (intlKey) return { ok: true, secret: intlKey, baseUrl: "https://api.z.ai" };
  return { ok: false, kind: "unconfigured", reason: "no Z.AI credential" };
}

/**
 * MiniMax Coding Plan.
 *
 * Two key flavours authorize different endpoints: `sk-cp-…` reaches the Token
 * Plan quota route, `sk-api-…` only reaches the pay-as-you-go balance route.
 * The wrong flavour is reported as not-applicable so the bar never shows a
 * misleading number or a generic upstream error.
 */
function resolveMiniMax(): AuthResult {
  const key = apiKey("minimax-cn") ?? apiKey("minimax");
  if (!key) return { ok: false, kind: "unconfigured", reason: "no MiniMax credential" };
  if (key.startsWith("sk-api-")) {
    return {
      ok: false,
      kind: "not_applicable",
      reason: "pay-as-you-go key — need a Token Plan key (sk-cp-…)",
    };
  }
  const isCn = Boolean(apiKey("minimax-cn"));
  return {
    ok: true,
    secret: key,
    baseUrl: isCn ? "https://api.minimaxi.com" : "https://api.minimax.io",
  };
}

export function resolveAuth(provider: QuotaProviderId): AuthResult {
  try {
    switch (provider) {
      case "claude":
        return resolveClaude();
      case "codex":
        return resolveCodex();
      case "commandcode":
        return resolveCommandCode();
      case "opencode":
        return resolveOpenCode();
      case "opendesign":
        return resolveOpenDesign();
      case "zai":
        return resolveZai();
      case "minimax":
        return resolveMiniMax();
    }
  } catch (error) {
    return {
      ok: false,
      kind: "unconfigured",
      reason: error instanceof Error ? error.message : "credential lookup failed",
    };
  }
}

/** True when a credential is present for the provider (used for the config probe). */
export function hasCredential(provider: QuotaProviderId): boolean {
  const result = resolveAuth(provider);
  // `unavailable`/`not_applicable` both imply a credential was found.
  return result.ok || result.kind !== "unconfigured";
}

export { authPath as quotaBarAuthPath };
