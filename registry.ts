/**
 * Provider display registry.
 *
 * Deliberately dependency-free: only labels and the Pi provider ids used for
 * highlighting. The network-facing half of each provider lives in adapters.ts,
 * so rendering and its tests never touch credentials or fetch.
 *
 * Adding a subscription = one entry here + one adapter with a matching id.
 */

import type { QuotaProviderId } from "./types.ts";

export interface ProviderDescriptor {
  id: QuotaProviderId;
  /** Short label used in the bar. */
  label: string;
  /** Full label used by `/subs status`. */
  longLabel: string;
  /** Pi provider ids this subscription maps to, for the ▸ highlight. */
  piProviders: readonly string[];
}

export const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = [
  {
    id: "codex",
    label: "Codex",
    longLabel: "ChatGPT / Codex",
    piProviders: ["openai-codex", "openai"],
  },
  {
    id: "commandcode",
    // "CMD" rather than "CC": two C-initials read as an abbreviation of
    // something else, so the label spells out the product instead.
    label: "CMD",
    longLabel: "Command Code",
    piProviders: ["command-code", "commandcode"],
  },
  {
    id: "opencode",
    label: "OC",
    longLabel: "OpenCode Go",
    piProviders: ["opencode-go", "opencode"],
  },
  {
    id: "opendesign",
    label: "OD",
    longLabel: "OpenDesign Go",
    piProviders: ["opendesign"],
  },
  {
    id: "zai",
    label: "Z.AI",
    longLabel: "Z.AI / GLM Coding Plan",
    piProviders: ["zai", "zai-coding-cn", "zai-coding", "bigmodel"],
  },
  {
    id: "minimax",
    label: "MM",
    longLabel: "MiniMax Coding Plan",
    piProviders: ["minimax-cn", "minimax"],
  },
];

export function descriptorFor(id: QuotaProviderId): ProviderDescriptor | undefined {
  return PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.id === id);
}
