# Antigravity CLI provider for Paseo

Runs Google's official Antigravity CLI (`agy`) as a Paseo provider: Paseo owns the session, the CLI
does the work, and every turn, tool call, and message is rendered from the CLI's `stream-json`
protocol. Nothing about Antigravity is reimplemented — the plugin spawns the `agy` binary that is
already installed and signed in on your machine.

- Provider id: `antigravity-cli`
- Requires: Paseo ≥ 0.9.1 (provider protocol version 1), Node 24 for the plugin process, and
  Antigravity CLI 1.2.9–1.2.11 for the behaviour described below. The plugin also ships a client
  entry (the [accounts screen](#multiple-accounts)), so the connected Paseo **app** must satisfy the
  same minimum — a compatible daemon does not make an older app compatible.

## Screenshots

![Chatting with Gemini 3.8 Flash through the Antigravity provider](images/01-chat.jpg)
![Slash commands and skills in the composer](images/02-slash-commands.jpg)
![Antigravity enabled in Paseo's provider settings](images/03-provider-enabled.jpg)
![Models discovered from agy](images/04-models.jpg)
![Antigravity accounts: active account, Use button and per-account usage quota](images/05-multiple-accounts.jpg)

## Install

From npm, from GitHub, or by pasting either source into **Settings → Plugins → Plugin source**:

```
paseo plugin install npm:paseo-plugin-antigravity-cli
paseo plugin install github:lefos13/paseo-plugin-antigravity-cli
```

Check it with `paseo plugin ls`; `antigravity-cli` should be `running`. `agy --version` must print and
`agy` must be signed in, and then pick **Antigravity** when you start a new agent. The sidebar entry
**Antigravity accounts** picks which account new agents run under — see
[Multiple accounts](#multiple-accounts).

Unlike [`agy-provider`](https://paseo.cafe/plugins/agy-provider), which adapts Antigravity's ACP
server through Paseo's ACP shim, this plugin drives the `agy` CLI directly over its documented
`stream-json` mode. The `agy` it launches is the first of `providerOptions.agyPath`,
`PASEO_ANTIGRAVITY_BIN`, `~/.local/bin/agy` (checked explicitly, because a daemon started by a GUI app
often has no such directory on `PATH`), then `agy` from `PATH`.

## What the plugin supports

One `agy` process per session: each prompt is one NDJSON turn and exactly one `result` back, and a
prompt sent while a turn runs is queued by the CLI as the next turn. Model, tier, mode, and settings
are launch flags, so a change restarts the CLI on the next turn and resumes the same conversation;
Antigravity conversations can be imported read-only, the conversation id agy reports is persisted,
each subagent becomes a child session ([Subagents](#subagents)), and `permission` covers plan approval
only. Images go over by file, because a `stream-json` turn carries text only.

Models come from `agy models` (cached ten minutes; `force` rediscovers), so the composer offers one
model per family with the tiers that family has — High, Medium and Low today. `providerOptions.effort`
is described in the table below.

Modes are *Default* (review file writes before they run), *Accept edits*, and *Plan*; tool rows cover
shell commands, file edits with a diff, searches, web fetches, and MCP tool calls.

### Plan mode

agy's own `--mode plan` is never passed: on 1.2.11 it either has no effect, while slash-command
expansion is disabled, or approves its own plan review — nobody can answer that in a headless run —
and implements in the same turn. Plan mode is therefore the plugin's own: a plan-mode turn is prefixed
with a `<plan_mode>` block telling the model to investigate read-only and end with a plan, and its last
answer is then offered as a plan (`kind: "plan"` permission) with **Implement** and **Keep planning**.
*Implement* switches to *Accept edits* and sends `The plan is approved. Implement it now.`; *Keep
planning*, or another message, withdraws it. It is an instruction, not a sandbox: a model that ignores
it can still write files.

### Background commands

When the model starts a long-running command in the background, agy holds back every later step until
it exits. After 5 s of that the plugin reads the conversation's own transcript, publishes the held
steps, and completes the turn as soon as the transcript shows the final answer. The CLI holding the
command is left running, so the server stays up (a notice says so), but it cannot take another turn:
your next message stops it, and the command with it, and resumes the conversation in a fresh CLI.

## Subagents

`invoke_subagent` starts each subagent as its own conversation while the parent turn stays open. The
plugin shows a **row per subagent** in the parent timeline (type, role, prompt, *running* until it
finishes) and a **child session per subagent** following the transcript agy names for it: the prompt,
each tool call with its result, and the final answer. A child spawned with `Workspace: branch` runs in
its own git worktree, which becomes that child session's working directory; a `Workspace: inherit`
child keeps the parent's.

The transcript is agy-internal and undocumented, so a child session is best-effort: a missing,
unreadable, or unrecognised transcript leaves the row above in place and never affects the parent turn.
Following stops when the subagent finishes, the session closes, or the turn is interrupted or fails.

## Slash commands

The composer's picker lists the commands this plugin has verified the CLI expands in `stream-json`
turns; a command is a *turn* on a CLI launched without `--disable-slash-commands`, and the next plain
turn relaunches with it.

| Command | Source |
|---|---|
| `/plan`, `/goal`, `/grill-me`, `/teamwork-preview`, `/learn`, `/schedule`, `/boost`, `/browser` | The CLI's own workflows. `/learn` records a behaviour in the workspace's `GEMINI.md`, `/schedule` sets up a recurring run, and `/boost` and `/browser` are the deep-thinking and browser-agent flows. |
| `/<name>` | A skill, either in the workspace's customization roots (`.agents/skills/<name>/SKILL.md`, and the same under `.agent/`, `_agents/`, `_agent/`) or installed for every workspace under `~/.gemini/antigravity-cli/skills/`, `~/.gemini/config/skills/`, `~/.gemini/skills/`, in that precedence. The name is the skill's frontmatter `name`, and the CLI's own built-ins are listed too. |
| `<plugin>:<name>` | A plugin's skill, under `~/.gemini/config/plugins/<plugin>/skills/`. A plugin holding one skill directly in `skills/` is addressed with a `..` placeholder: `/android-cli-plugin:..:android-cli`. |

- **Disabled plugins** are left out: `"enabled": false` in `~/.gemini/config/config.json`, or
  `"disabled": true` in a `plugin.json` with no `config.json` entry (an entry there always wins).
- **`skills.json`** (`.agents/skills.json`, the same file under the other workspace roots, and
  `~/.gemini/config/skills.json`) loads the items directly inside its `path`, one level deep;
  `include_only` and `exclude` name those items exactly, a nested one is named by its relative path in
  `include_only` (`nested/deep`), and a relative `path` resolves from the repository root.
- **Some built-ins are per account**: `/compact`, `/review` and `/owl` are gated server-side, and
  commands the CLI answers itself (`/skills`, `/model`, …) end a `stream-json` turn, so both stay out.

## What it cannot do, and why

- **Steering** is impossible: a line written to agy's stdin while a turn runs is queued as the *next*
  turn, so Paseo replaces the active turn instead of offering to steer it.
- **Tool permission prompts** cannot be surfaced either — agy resolves tool approval internally from
  its own `toolPermission` setting. Choose the behaviour in session settings.
- **Rewind**: Antigravity's `/rewind` is interactive-only; nothing in `stream-json` exposes it.
- **Shared-installer skills** (`~/.agents/skills/`) are offered and expanded by the plugin, not the
  CLI: the turn is sent the `SKILL.md` body, capped at 64 KiB (a larger one fails with
  `code: "skill_too_large"`).

## Session settings

| Setting | Behaviour |
|---|---|
| **Tool approval** | Default *Use Antigravity setting*, no flag; *Skip all permissions* passes `--dangerously-skip-permissions`. |
| **Sandbox** | Off/On; *On* passes `--sandbox`. |
| **Share Paseo tools with Antigravity** | Off/On, *Off* by default — see [MCP sharing](#sharing-paseos-mcp-servers-opt-in). |
| **Agent profile** | An optional select of the custom agents `agy` has here; *Default* passes no `--agent`. |

The select only offers what `agy` will launch: agents under the workspace's `.agents/agents/` and its
global agent roots, `<name>.md` or `<name>/agent.md`, with a frontmatter `name` and `description`.
`mainAgent: false` agents are skipped, hidden ones are offered, and workspace agents need that workspace
trusted in `antigravity-cli/settings.json` (`trustedWorkspaces`) — the real
`~/.gemini/antigravity-cli/settings.json` for the Default account, and each other account's own copy
([Multiple accounts](#multiple-accounts)) — an unknown `--agent` name
silently runs the default agent. The two Off/On settings are selects rather than toggles, because a
Paseo plugin toggle has no visible state; older `true`/`false` values read as *On*/*Off*.

## providerOptions

| Option | Effect |
|---|---|
| `agyPath` | Absolute path to the CLI binary for this session. |
| `extraArgs`, `addDirs` | Extra argv appended after the plugin's own flags, and absolute paths each passed as an extra `--add-dir` (anything else is dropped with a warning notice). |
| `agent` | Custom agent persona to pass as `--agent <name>`. The **Agent profile** setting wins over it. |
| `effort` | Reasoning effort: the selected model family's tier when it has that tier, the `--effort` flag when no model is selected, and otherwise dropped with one log line. Never passed alongside `--model`. |

## Multiple accounts

> **Your own responsibility.** Using the plugin with the Default account — the one sign-in `agy`
> already has — stays within the [terms of service](#terms-of-service) as described there. Whether
> running several Antigravity accounts side by side is allowed is **not clear** from the published
> terms. Use multiple accounts at your own risk.

The sidebar entry **Antigravity accounts** manages a host-wide *active account*: the account every new
agent runs under. The screen lists the accounts and marks the active one; pressing an account shows
its settings in the pane below, and that account's **Use** button makes it the active account — the
active row shows the `active` badge in place of the button. It also adds, signs in and removes
accounts, and edits the two per-account settings below.

- **Default** is the real home and its `~/.gemini` — the account `agy` already uses in a normal
  terminal. It is always listed first, has no directory of its own, and cannot be removed; the plugin
  reads and writes about it exactly as it did before multiple accounts existed.
- **New agents** spawn the official `agy` with `HOME` pointing at the active account's own home. A
  running agent keeps the account it started with: switching changes the next spawn only.
- **Resumed and imported conversations** reopen under the account that created them, because the
  account id is stored beside the conversation id; a conversation with no account id belongs to
  Default. Opening one whose account has been removed fails with an error naming it.
- **Add account** asks for a name, creates the account's home, and opens the CLI's own sign-in there.
  On macOS that is a Terminal window on the **daemon's** machine (the screen names the host) with
  `HOME` set to the account's home; the launcher is `sign-in.command` in the account's directory, run
  with `open`. Off macOS, or when that hand-off fails, nothing is launched and the screen shows the
  exact `HOME=… agy` line to run on that host instead.
- **Sign in again** re-runs that flow for an existing account.
- **Remove** deletes the account's own directory — its sign-in and its conversation history — and
  never touches the real home. Removing the active account makes Default active.
- **Per-account settings**: the pane below the list edits the account's *tool permission* and its
  *trusted workspaces*; the change applies to that account's next launch. Default's copy is shown
  read-only, because `agy` owns the real file.

### Usage quota

Each account's card shows what that account has left: one row per pool the CLI reports — for the
accounts seen here, Gemini models and Claude and GPT models, each with a weekly and a 5-hour pool —
with the share left, a bar, the reset time, and a `checked HH:MM` line (local clock) under the rows.
The figures come from the account's own run of the CLI's print-mode command, spawned under that
account's `HOME` (Default: the daemon's environment unchanged) from the temp directory:

```
HOME=<account home> agy -p /usage --output-format json
```

`agy` 1.1.11 added non-interactive answers for the read-only slash commands, so the binary answers
`/usage` without starting an agent turn, without spending quota and without leaving a conversation
behind; the plugin additionally refuses any answer whose `num_turns` is not 0. The argv is exactly
`-p /usage --output-format json` — never `--disable-slash-commands`, which session launches pass
unless slash commands are allowed, and which would stop `/usage` from expanding and turn it into a
real agent turn that spends quota — and the plugin parses only that command's output. One read takes
a few seconds to about twenty, and writes a normal `agy` log file in the account's
`.gemini/antigravity-cli/log/`.

A card reads when the screen is opened and when **Refresh** is pressed; nothing polls in the
background. The daemon keeps a successful answer for 5 minutes per account and merges concurrent
reads into one process, so reopening the screen is free. While a read runs the card shows *Checking
quota…*; a signed-out account shows a hint; `agy` reporting an error is shown with its own message
(for example an account with no quota summary); anything else is an error with **Refresh** beside it.

The shape of that JSON is not in Antigravity's documentation — it comes from `agy`'s changelog and
observed output — so a future `agy` may change it, and the card then shows an error instead of wrong
numbers.

### The shadow home

An account is a *shadow home*: a directory that looks like a home directory to the CLI. Its top level
is links into your real home, so the agent's shell keeps seeing your dotfiles, and `.gemini` is a real
directory whose shared parts link back to the real `~/.gemini`:

| Shared with the real home (links) | Per account (its own files and directories) |
|---|---|
| Every top-level entry — `~/.ssh`, `~/.gitconfig`, `~/.npmrc`, `~/.agents`, … | `.gemini/antigravity-cli/`: history, brain, conversation index, and any other state `agy` writes |
| `Library` (a real directory) minus `Keychains`, and inside it `Library/Preferences` minus `com.apple.security.plist` | The sign-in, written by `agy` into the account's own `Library/Keychains/account.keychain-db` |
| `.gemini/config` — MCP servers, plugins and `config/skills` | `settings.json` — a copy seeded from the real file, edited in the accounts screen |
| `.gemini/skills` and `.gemini/antigravity-cli/{skills,agents}` | |

`agy` loads and saves its sign-in through the macOS Keychain, and the login Keychain is one slot per
macOS user: a shadow home that could reach it would sign the account in as whoever that Keychain
holds. Each account therefore gets a keychain of its own —
`Library/Keychains/account.keychain-db`, created with an empty password, made that home's default and
unlocked before every launch. `Library/Keychains` and `Library/Preferences/com.apple.security.plist`
(the file that names the default keychain) are the two entries a shadow home never links, so the real
login keychain cannot be reached from an account. The plugin creates and unlocks that keychain; it
never reads or writes what `agy` puts in it.

Limitations:

- **The real login Keychain is out of reach for an account's agent commands**, by design. A tool that
  reads credentials from the macOS Keychain — `gh`, or git's `osxkeychain` helper — finds the
  account's (empty) keychain instead and reports no credentials.
- **A file a tool creates at the top of a shadow home stays in that account.** It shadows the real
  entry for that account; the plugin logs it, never removes or overwrites it, and only refreshes links
  it created itself.
- **The per-account keychain is macOS-only.** On other platforms an account is still a separate
  `HOME`, but `agy` sees no keychain of its own.
- **The first launch of a new account may add plugin-enablement entries to the shared
  `~/.gemini/config/config.json`.** That is the same file, through the same link, that the Default
  account already writes; plain `agy` is unaffected.

## Sharing Paseo's MCP servers (opt-in)

Antigravity reads MCP servers from `~/.gemini/config/mcp_config.json` and from
`<dir>/.agents/mcp_config.json` for each directory it was given. With **Share Paseo tools with
Antigravity** on, the plugin writes Paseo's `mcpServers` into `<cwd>/.agents/mcp_config.json` as
`paseo-<name>` entries before the CLI starts.

- Off by default, and those entries hold whatever credentials the servers use, so inside a git work
  tree the plugin adds the file's path, relative to the repository root, to that repository's own
  `.git/info/exclude`: `git add .` then treats it like a `.gitignore` line and the token in it cannot
  be committed by accident. The plugin never edits `.gitignore` and removes its lines when the last
  Paseo session there closes; outside a git work tree, keep the file out of your commits yourself.
- On the last `session.close` the plugin removes only its own entries, deletes the file only if it
  created it, never overwrites one that is not valid JSON, and `agy mcp list` will not show these
  entries because it reads only your global config — look at `<cwd>/.agents/mcp_config.json`.

## Files the plugin writes

Under `$PASEO_HOME` (default `~/.paseo`), in `plugin-data/antigravity-cli/`:

| Path | Contents |
|---|---|
| `transcripts/<conversationId>.jsonl` | Timeline rows of a conversation — a subagent's child session under its own id — so `history: "replay"` can restore them. Not written with `persist: false`. |
| `attachments/<sessionId>/`, `schemas/<sessionId>.json` | Images decoded from prompts, and the JSON Schema a structured-output turn was launched with; both deleted on `session.close`. |
| `accounts.json` | The account store: the active account's id and every account's id and name. Missing or unparsable means Default only. |
| `accounts/<id>/home/` | The account's shadow home: its links into the real home, its own `.gemini` (sign-in, history, brain), its keychain and its `settings.json`. |
| `accounts/<id>/sign-in.command` | The macOS sign-in launcher written when an account is added or signed in again: `export HOME=<shadow home>`, unlock the account's keychain, `exec agy`. Mode 0700. |

It reads, read-only: each account's `antigravity-cli/settings.json` (`~/.gemini` for Default, the
shadow home otherwise) and its conversation index `antigravity-cli/conversation_summaries.db`, plus a
running subagent's transcript.

## Limitations

- **`--sandbox` is not demonstrated.** The flag is accepted and the turn runs, but with permissive
  Antigravity settings a write outside the workspace still succeeded, so the plugin does not claim the
  restriction holds.
- **Edit diffs are reconstructed** from file snapshots, because the stream names only the edited file;
  a file the plugin cannot read, or one that did not change, leaves the row without a diff.
- **Transient 503s** fail the turn with `code: "unavailable"`, and an error result ends the CLI
  process, which the next turn relaunches on the same conversation.
- **Imported conversations** resume from `session.list`, but their earlier turns are not replayed.
- **The command list is read from disk, not from the CLI**, so a skill the CLI would refuse to load can
  appear in the picker, and a command it no longer expands is sent as ordinary text.
- **Subagent sessions are read-only in Paseo**, and rely on agy's undocumented transcript file: if a
  CLI update changes it, subagents fall back to rows without a child session.

## Terms of service

The [Antigravity Additional Terms of Service](https://antigravity.google/terms) (checked
**2026-09-23**) say, in clause 6:

> You must not abuse, harm, interfere with, or disrupt the Service. This includes, but is not limited
> to, using the Service in connection with products not provided by us. Using third party software,
> tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of
> this Agreement. Such actions may be grounds for suspension or termination of your Antigravity and/or
> Gemini CLI accounts.

What this plugin does about that: it only launches the official `agy` binary you installed, and lets
that binary use whatever session it already has. It never reads, stores, forwards, or refreshes
credentials or OAuth tokens, and never talks to Antigravity's APIs itself. Multiple accounts do not
change that: the plugin only chooses which `HOME` the official `agy` runs with, and on macOS creates
an empty keychain in that home (empty password, made default and unlocked before each launch) for
`agy` to write its own sign-in into — the plugin never reads from it. Quota figures are the same
stance: they come from the official binary's own `/usage` command output
([Usage quota](#usage-quota)), and the plugin does not read the sign-in token or contact any Google
endpoint for them — unlike a tool that sends the stored token to Google's internal quota API or talks
to the CLI's local language-server port, which this plugin deliberately does not do. The plugin does
read the `toolPermission` preference and trusted-workspace list, the read-only conversation index,
subagent transcripts, and the output of the `agy -p /usage` command it runs.

**Default account vs. multiple accounts.** Using the plugin with only the Default account — the
single sign-in `agy` already has on your machine — is the case the paragraph above covers: the
official binary, its own session, nothing added. **Multiple accounts are a different matter, and it is
not clear whether they comply with the terms.** The mechanism is the same (the official binary, a
different `HOME`, no token handling), but the terms do not say whether one person may run several
Antigravity accounts side by side. Moving between accounts when one runs low could also be read as
getting around usage limits. The [Google APIs Terms](https://developers.google.com/terms) (§2.d) and
the Google Cloud Acceptable Use Policy both forbid circumventing limits or quotas. The feature is
provided as is. **Adding and using more than one account is your own decision and your own
responsibility**, including any consequence for the accounts involved.

Access through Gemini Enterprise (Google Cloud), Gemini Enterprise for Business, a Google Workspace
subscription on the Google Cloud Pre-GA Offering Terms, or a Gemini Enterprise Agent Platform API Key
is governed by the terms your administrator accepted instead, and the clause above does not apply;
check with your administrator or Google. This is a description of the terms as published, not legal
advice.
