/**
 * Last-good quota snapshot.
 *
 * Only derived usage numbers are written — windows, percentages, reset
 * timestamps and non-sensitive provider notes. No credential, token, header or
 * account identifier is ever persisted here.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AdapterOutcome, ProviderRecord, QuotaProviderId } from "./types.ts";

/** Last-good data older than this is not worth restoring on startup. */
export const MAX_CACHE_AGE_MS = 12 * 60 * 60 * 1000;

interface CachedProvider {
  windows: Extract<AdapterOutcome, { kind: "ok" }>["windows"];
  notes?: string[];
  fetchedAt: number;
}

type CacheFile = Partial<Record<QuotaProviderId, CachedProvider>>;

function cachePath(): string {
  return join(getAgentDir(), "quota-bar-cache.json");
}

export function loadCache(): Map<QuotaProviderId, ProviderRecord> {
  const restored = new Map<QuotaProviderId, ProviderRecord>();
  try {
    const raw = readFileSync(cachePath(), "utf8");
    const parsed = JSON.parse(raw) as CacheFile;
    const now = Date.now();
    for (const [id, entry] of Object.entries(parsed)) {
      if (!entry || !Array.isArray(entry.windows)) continue;
      if (typeof entry.fetchedAt !== "number") continue;
      if (now - entry.fetchedAt > MAX_CACHE_AGE_MS) continue;
      restored.set(id as QuotaProviderId, {
        outcome: {
          kind: "ok",
          windows: entry.windows,
          ...(entry.notes ? { notes: entry.notes } : {}),
        },
        fetchedAt: entry.fetchedAt,
        failureStreak: 0,
      });
    }
  } catch {
    // Missing or unreadable cache is normal on first run.
  }
  return restored;
}

export function saveCache(records: ReadonlyMap<QuotaProviderId, ProviderRecord>): void {
  try {
    const out: CacheFile = {};
    for (const [id, record] of records) {
      if (record.outcome.kind !== "ok" || record.fetchedAt === undefined) continue;
      out[id] = {
        windows: record.outcome.windows,
        ...(record.outcome.notes ? { notes: record.outcome.notes } : {}),
        fetchedAt: record.fetchedAt,
      };
    }
    const path = cachePath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const temp = `${path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(out, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
  } catch {
    // A cache write failure must never affect the session.
  }
}

export function cacheAgeLabel(fetchedAt: number): string {
  const minutes = Math.round((Date.now() - fetchedAt) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
