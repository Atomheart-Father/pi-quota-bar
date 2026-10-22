# pi-quota-bar

One always-visible line showing the real server-side usage of your AI
subscriptions in [pi](https://github.com/earendil-works/pi). No `/usage` needed,
no dashboard, no wrapping.

```
⌁ Codex 5h 25% ↺3h 7d 42% ↺4d │ ▸ CMD 5h 2% ↺4h 7d 15% ↺5d │ OC 5h 1% ↺1h 7d 24% │ Z.AI 5h 0% 7d 100% ↺21h │ MM 5h 2% ↺5h 7d 69% ↺3d
```

The `▸` marks the provider your current model belongs to. Each provider can be
toggled on and off individually.

## Scope

| Subscription | Source |
|---|---|
| ChatGPT / Codex | `chatgpt.com/backend-api/wham/usage` |
| Command Code | `api.commandcode.ai/alpha/billing/credits` |
| OpenCode Go | `opencode.ai/zen/go/v1/usage` |
| Z.AI / GLM Coding Plan | `open.bigmodel.cn/api/monitor/usage/quota/limit` |
| MiniMax Coding Plan | `api.minimaxi.com/v1/token_plan/remains` |
| OpenDesign Go | no control-plane usage API — see below |

Command Code is read through its own control-plane API using the API key
`pi /login` already stored. This extension never registers a provider and never
routes a model call, so it cannot affect Command Code requests. The old
`commandcode-go-for-pi` plugin is not required and no longer exists.

## How Command Code is measured

Command Code's allowance is denominated in **credits**, not requests, so the bar
reports `used / cap` as a percentage:

```
CMD 5h 2% ↺4h 7d 15% ↺5d        # /subs status shows (0/14) and (5/35)
```

The two windows are the API's own `fiveHour` and `weekly` limits. There is
deliberately **no monthly row**: `monthlyCredits` is a credit grant, not a spend
ceiling, so a "monthly %" would be a number this extension invented.

Two account shapes exist and both work. A team account returns an `org.id`,
which is passed as `orgId`; a personal account returns `org: null`, and in that
case sending `orgId` at all is rejected by the API (`400 Invalid UUID`), so it is
omitted.

## Why OpenDesign shows `—`

OpenDesign's stored key (`sk-amr-…`) is a **data-plane model key**. Every
control-plane usage path on the gateway (`/v1/usage`, `/v1/quota`,
`/v1/subscription`, `/v1/billing`, `/v1/whoami`, …) returns `404`, and a
successful `/v1/chat/completions` call returns no quota header — only token
counts and routing metadata. There is no server-side allowance to read.

Rather than estimate, the bar shows `OD —`. Set `"showNoData": false` in the
config to hide it entirely.

## Install

```bash
pi install git:github.com/Atomheart-Father/pi-quota-bar
```

Or keep it as a local extension — no install and no build step (Pi loads
TypeScript through `jiti`):

```
~/.pi/agent/extensions/quota-bar/index.ts
```

Reload Pi (`/reload`) after installing.

The only prerequisite is that each subscription is already logged in through
`pi /login`. Providers without credentials are hidden automatically.

### Avoid a duplicate footer

If you have `@kaishin/pi-usage` installed, its footer would duplicate this bar.
Turn that footer off so only one line shows:

```json
// ~/.pi/agent/extensions/usage.json
{ "usageStatus": false }
```

Its `/usage` dashboard, `/tokens` and per-provider commands keep working.

## Commands

| Command | Effect |
|---|---|
| `/subs` | Force a refresh and show the summary |
| `/subs status` | Full detail: every window, counts, resets, errors |
| `/subs providers` | Interactive menu — toggle each provider on/off |
| `/subs on <provider>` / `/subs off <provider>` | Toggle one provider without a dialog |

The name in a toggle accepts any spelling: the id (`commandcode`), the short
label (`CMD`) or the Pi provider id (`command-code`).
| `/subs on` / `/subs off` | Enable/disable the whole bar |

Every provider can be switched on and off individually, and the choice is
saved to `quota-bar.json`. Disabling a provider stops its network requests
entirely — it is not merely hidden.

`/subs providers` opens a menu where selecting a row toggles it and the menu
redraws, so several can be changed in one visit:

```
✓  Codex  —  ok (0m ago)
✓  Codex  —  ok (0m ago)
✗  OC  —  not queried
```

## Configuration — `~/.pi/agent/quota-bar.json`

```json
{
  "enabled": true,
  "refreshMinutes": 3,
  "placement": "aboveEditor",
  "showNoData": true,
  "providers": {
    "codex": true, "commandcode": true, "opencode": true,
    "opendesign": true, "zai": true, "minimax": true
  }
}
```

- `refreshMinutes` (1–60) is both the auto-refresh interval and the cache TTL.
  Event handlers (`model_select`, `agent_settled`) only re-render; they never
  turn into extra API calls while cached data is fresh.
- `placement`: `aboveEditor` (default) or `belowEditor` render a dedicated
  widget line; `statusBar` uses the shared footer row.
- `providers`: disable any subscription you do not want fetched or shown.
  Edited by `/subs providers`, or by hand; both write the same file.

## Behaviour

- **Unconfigured providers are hidden.** No credential means no segment, so
  there is never a wall of `N/A`.
- **Failures are contained.** Each provider is fetched independently. A failing
  provider keeps its last good numbers marked `⌛`; only if it never succeeded
  does it show `✗`. Nothing affects the others or the session.
- **Backoff.** Consecutive failures double the retry delay up to the configured
  interval × 16, so a dead endpoint is not hammered.
- **Narrow terminals.** The line compacts in tiers — resets first, then
  secondary windows, then window labels — before trailing providers are dropped.
  The active provider is never dropped. It never wraps to a second line.
- **Untimed rows are filtered.** Codex's `Spend cap` flag and similar
  non-window rows are excluded from the bar (they remain in `/subs status`).
- **`↺` is a countdown** to that window's reset. `!` marks an exhausted window.
- **Colors** are restrained: green/normal below 70% used, warning at 70–90%,
  error at 90%+.

## Data sources and caching

Every provider's payload is normalized by `parsers.ts` alone. Nothing is
delegated to another extension, so uninstalling or renaming one cannot blank
the bar.

Only derived numbers are cached, in `~/.pi/agent/quota-bar-cache.json`
(mode `0600`): percentages, counts, reset timestamps. No credential, token,
header or account identifier is ever written.

## Credentials

Read-only. The extension:

- reads `~/.pi/agent/auth.json` and (for Codex only) `~/.codex/auth.json`;
- never writes, refreshes or mutates a credential — Pi owns OAuth refresh;
- sends a credential only to that provider's own official origin;
- never logs one, and redacts credential-shaped text from any error it renders.

Codex note: the CLI credential in `~/.codex/auth.json` is tried first, because
the ChatGPT usage endpoint authorizes the account that owns the subscription and
a Pi-level `openai` token can belong to an account the endpoint rejects with
401.

## Coexisting with other usage extensions

Any extension that draws its own quota footer or status row will duplicate this
bar. Turn that one off rather than this one. For `@kaishin/pi-usage` that is
`{ "usageStatus": false }` in `~/.pi/agent/extensions/usage.json`.

Its `/usage` dashboard, `/tokens` and provider commands are untouched — set
`"usageStatus": true` to bring the single-provider footer back.

## Tests

```bash
node --experimental-strip-types --test test/*.test.ts
```

The render tests are pure (no network, no credentials) and cover the states
that are awkward to reproduce live: stale last-good data, no-last-good errors,
an exhausted window, unconfigured providers, and a spread of terminal widths.

## Credits

Response parsing was originally adapted from
[`@kaishin/pi-usage`](https://www.npmjs.com/package/@kaishin/pi-usage) (MIT),
which in turn descends from `@latentminds/pi-quotas` and `@narumitw/pi-usage`.
It now lives in this repository so the bar has no runtime dependency on another
extension.

MiniMax endpoint semantics follow
[`pi-show-minimax-quota`](https://www.npmjs.com/package/pi-show-minimax-quota)
(MIT), including the `sk-cp-` / `sk-api-` key distinction.

## License

MIT
