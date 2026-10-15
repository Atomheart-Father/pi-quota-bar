/**
 * Configuration: `~/.pi/agent/quota-bar.json` (or `$PI_CODING_AGENT_DIR`).
 *
 * Every field is optional; a missing or malformed file falls back to defaults
 * rather than disabling the bar.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { QuotaProviderId } from "./types.ts";

export type BarPlacement = "aboveEditor" | "belowEditor" | "statusBar";

export interface QuotaBarConfig {
  enabled: boolean;
  /** Auto-refresh interval in minutes (1–60). */
  refreshMinutes: number;
  /** Render the shared status row instead of a dedicated widget line. */
  placement: BarPlacement;
  /** Show providers with a credential but no readable usage (e.g. OpenDesign). */
  showNoData: boolean;
  /** Per-provider switches. */
  providers: Record<QuotaProviderId, boolean>;
}

export const DEFAULT_CONFIG: QuotaBarConfig = {
  enabled: true,
  refreshMinutes: 3,
  placement: "aboveEditor",
  showNoData: true,
  providers: {
    claude: true,
    codex: true,
    opencode: true,
    opendesign: true,
    zai: true,
    minimax: true,
  },
};

export function configPath(): string {
  return join(getAgentDir(), "quota-bar.json");
}

function normalize(input: Partial<QuotaBarConfig>): QuotaBarConfig {
  const config: QuotaBarConfig = {
    ...DEFAULT_CONFIG,
    ...input,
    providers: { ...DEFAULT_CONFIG.providers, ...(input.providers ?? {}) },
  };
  if (!Number.isFinite(config.refreshMinutes) || config.refreshMinutes < 1) {
    config.refreshMinutes = DEFAULT_CONFIG.refreshMinutes;
  }
  if (config.refreshMinutes > 60) config.refreshMinutes = 60;
  if (
    config.placement !== "aboveEditor" &&
    config.placement !== "belowEditor" &&
    config.placement !== "statusBar"
  ) {
    config.placement = DEFAULT_CONFIG.placement;
  }
  for (const id of Object.keys(config.providers) as QuotaProviderId[]) {
    if (typeof config.providers[id] !== "boolean") config.providers[id] = true;
  }
  return config;
}

export function loadConfig(): QuotaBarConfig {
  try {
    const raw = readFileSync(configPath(), "utf8");
    return normalize(JSON.parse(raw) as Partial<QuotaBarConfig>);
  } catch {
    return { ...DEFAULT_CONFIG, providers: { ...DEFAULT_CONFIG.providers } };
  }
}

export function saveConfig(config: QuotaBarConfig): void {
  try {
    const path = configPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const temp = `${path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
  } catch {
    // A config write failure must not affect the session.
  }
}

/** The order providers appear in the bar. */
export const PROVIDER_ORDER: readonly QuotaProviderId[] = [
  "claude",
  "codex",
  "opencode",
  "opendesign",
  "zai",
  "minimax",
];
