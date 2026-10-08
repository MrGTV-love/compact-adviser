# Shared product contract

This is a documentation contract, not a shared runtime or install-state layer.
Each harness implementation owns its event handling, dependencies, installation, configuration location, and session state.

## Semantics

- Modes: `hint` (default), `auto` (explicit experimental opt-in), and `off`.
A host that gives no process outside the session a way to run `/compact` ships `hint` and `off` only, and says so rather than offering an `auto` it cannot honour. Codex and Grok are such hosts.
- The hint is shown to the person, never to the model. A hint is never written into the conversation, returned as hook feedback, or used to keep the agent working.
- Hint text: the Pi extension, Codex, and Grok display **Compact adviser: work appears completed or recorded. Run /compact to save tokens.** Claude Code's host adds **compact-adviser:**, so the mod supplies only **work appears completed or recorded. Run /compact to save tokens.**
- `minContextTokens` defaults to the constant **40000**, is configurable and persists with the selected mode.
There is no percentage-of-context-window condition.
- A size threshold makes a checkpoint eligible for judgment; it does not order compaction.
- Inspect cheap local state before any TypeSafe Jev request.
- TypeSafe/Jev snapshots include bounded user constraints from the mapped transcript, plus assistant replies and tool results that fall within its last 64 entries. Existing byte budgets still apply (about 14kB recent tail, per-message caps, 8kB user-constraint budget, and a 32kB request refuse path), so message count is not the tight payload bottleneck.
- Long tool-result dumps keep a head and tail slice with an explicit middle omission marker so one result cannot consume the tail budget.
- Optional TypeSafe request logging is off by default and can be enabled from the compact-adviser settings UI in the Pi extension and Claude Code or the external CLI on Codex and Grok. When on, each request body and the matching Jev outcome are appended to a local jsonl log: successful outcomes include answers, score, usage, floor, and qualifies; failures include only a sanitized error kind. Existing secret redaction applies, and the log never includes the API key. The Pi extension uses one shared O_APPEND file per host agent directory. Claude writes one file per session (`compact-adviser-requests-<session-id>.jsonl`) because its host cannot atomically append. Codex writes the same per-session file name with O_APPEND. Grok also writes one O_APPEND file per session because every hook run is a separate process.
- Judge whether known next work can continue without exact older details, not whether context is merely large.
- One judgment decides both hint and auto: two atomic Jev questions in one request, `done` (is the assistant's own latest unit finished) and `shape` (is this conversation hands-on work or coordination), composed in code as score = P(finished) x (0.5 + 0.5 x P(hands_on)). The score must clear a floor that depends on context usage (context tokens over the limit at which the host compacts: Claude Code's auto-compact threshold when the host reports one as enabled, otherwise the model's window; the Pi extension, Codex, and Grok use the window): 0.90 while usage is at most 10 %, 0.50 from 90 % on, and a linear ramp between (floor = 0.90 - 0.5 x (usage - 0.10), rounded to three decimals); unknown usage takes the strictest floor. An optional `profile` setting may replace the questions, the coordination weight, or the floor schedule on every host; see [judge-profiles.md](judge-profiles.md). Auto is not a higher bar. Mode only chooses what happens after a qualifying judgment (hint vs compact). Experimental auto still requires the existing first-use acknowledgement to turn auto on. Measured on the judgment-eval set against what users actually asked next: 95 % precision at 19 % recall at the strict end, 74 % / 91 % at the loose end, with no cliff between. A question that asked Jev to judge finished-and-hands-on in one step, and a companion "would older detail be lost" question, both measured worse and were not kept.
- `COMPACT_ADVISER_DISABLE` is a per-session kill switch. Set to `1`, `true`, `yes` or `on` (case-insensitive, surrounding whitespace ignored), it makes the product take no action for that process: no TypeSafe/Jev request, no hint, no automatic compaction, no command, and no status-line output that depends on a judgment. It wins over a saved `hint` or `auto` mode and over every other enablement path. Any other value, including unset, leaves behavior unchanged. The Pi extension and Claude Code read it once when the session loads. Codex and Grok check it in each short-lived hook, status-line, or command process, all of which inherit the session's fixed environment. Every implementation parses it through a byte-identical `disable.ts`. The Pi extension returns from install before registering hooks or `/compact-adviser`. Codex returns from the hook and CLI process before judging or running a command. Grok returns from hooks, status output, and commands before doing work.
- Non-interactive sessions stay inert when that can be detected reliably. The Pi extension requires `mode === "tui"` with a UI on both Pi and omp; the Claude Code mod requires the host's `session.start` `isInteractive` flag and returns before command registration, session-record pruning, pending-save toasts, and compaction cooldown writes. Codex reads the rollout's `originator`. No host guesses from `CI` or similar ambient variables.
- Uncertain, stale, interrupted, or failed judgments leave context alone. A host whose only user-facing channel is permanent (Codex's hook output becomes a scrollback line that cannot be cleared) reports such a failure nowhere and simply backs off.
Claude Code preserves the settlement generation across asynchronous preparation and rechecks it after key acquisition, before log writes and request dispatch, and before applying a result; a new turn, settings change, snooze/dismiss, or completed manual compaction invalidates that checkpoint.
- Installing or loading the package is consent to send eligible checkpoint context to TypeSafe when a key is available and other product gates pass (mode, minimum context, idle session, and so on). Host-specific key setup is documented in [Quick Start](../README.md#quick-start); key handling and security boundaries are documented in [SECURITY.md](../SECURITY.md#conversation-data). After save the UI reports only presence or key source (`env` / `saved` / `command` / `.env` / `missing`), never the value. A non-empty launch-environment value wins over the saved key, which wins over a session-cwd `.env`. A saved key that starts with `!` is a command: the rest runs as `/bin/sh -c` at call time, only when the launch environment has no key, and its trimmed single-line stdout is the key (source `command`); a failure, timeout or unusable output is no key and falls through to `.env`. The command is never cached or logged, and only the saved setting can hold one.
- There is no separate sharing toggle. A saved `sharingConsent` value from an older version is ignored.
- Native compaction remains authoritative and lossy; no timing model promises perfect preservation.
- Configuration changes do not immediately compact.
Invalid values and cancellation preserve existing settings; failed saves are reported.

## Implementations

| Package | State | Installation |
| --- | --- | --- |
| `packages/pi-extension` | Pi implementation with an omp adapter | See [Pi](../README.md#pi) and [omp](../README.md#omp) installation instructions |
| `packages/claude-mod` | Claude Code mod (early-access function-hooks API) | Load this package path with `claude --plugin-dir` and `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` |
| `packages/codex-plugin` | Codex CLI plugin, hint-only | `codex plugin marketplace add` this repository, then `codex plugin add compact-adviser@compact-adviser` |
| `packages/grok-plugin` | Grok Build plugin, hint-only | `grok plugin install <path> --trust`, then `/compact-adviser-install` for the hooks and a `[ui.status_line]` opt-in for the hint |

The Pi extension uses each host's agent-directory `compact-adviser.json` and session custom entries. The omp settings location is documented in [Quick Start](../README.md#omp).
The Grok plugin uses its own `${GROK_HOME:-~/.grok}/compact-adviser/settings.json`, plus one file per session for cooldowns and one for the verdict the status line reads; its two halves are separate processes, so nothing is held in memory between them.
The Claude Code mod uses its own `userConfig` options (`mode`, `minContextTokens`, `logRequests`, `typesafeApiKey`) in Claude Code's settings, and its own plugin store for the automatic-mode acknowledgement and per-session cooldowns.
`typesafeApiKey` is hidden from `/config` so the host menu never draws the secret.
The Codex plugin owns `<CODEX_HOME>/compact-adviser/`: one `settings.json`, one cooldown record
per session, and the request logs. It does not touch `config.toml`, whose unknown keys are an
error under `--strict-config`, and it has no `auto` mode or acknowledgement to store.
Snooze and dismiss are a known gap: Codex gives neither the hook nor the CLI a reliable
current-session identity, so the CLI could only mutate the most recently written session record.
No implementation reads or mutates another's records.
No harness installs or loads another harness's runtime.

### omp adapter

omp emits `agent_end`, not Pi's `agent_settled`. The adapter ignores automatic
continuations and defers inspection through omp's managed timer. The callback
checks the original session identity and generation and requires the host to
report idle; it does not manufacture idle state or poll until idle.
New input, agent starts, branching, session changes, `auto_compaction_start`, and
`session_compact` invalidate queued or in-flight judgments. Pending messages
prevent an otherwise eligible judgment or its result from acting.

Snapshots use the native active branch and resolve its compaction boundary.
The shared token minimum, Jev policy, cooldowns, and automatic-mode acknowledgement
apply unchanged. Source-sensitive redaction is documented in
[SECURITY.md](../SECURITY.md#conversation-data).
For the host-owned background-compaction and retained-tail limitations, see
[omp usage](../README.md#omp).
