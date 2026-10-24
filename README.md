# corrallm

**An orchestrator for coding agents that can adopt any agentic workflow, and combine them.**

Coding agents such as Claude Code and Codex keep getting better, and the ways people organize them change just as fast: test-first relays, spec-driven plans, review panels, races judged blind, swarms. Most tools build in one of these ways of working, or leave you to script your own orchestration. corrallm is GUI-first and takes that busy work away: pick a workflow off the shelf, say what to build, and go; or adapt it, and run several side by side as parts of one larger effort.

- **A canvas of agents.** Each agent is one of those CLIs, with its own session and a queue of work.
- **Queues you can read.** Steps (the agent's own actions, with what to do in your words, and expected to fail when they should, as tests written first are), messages, if-thens, and waits on other agents' work make the order and hand-offs of a workflow explicit, and editable.
- **Templates.** A workflow, say a TDD relay where Codex writes the tests, Claude makes them pass and Codex refactors, is a template. Start a canvas from it, or insert it into a larger one as one group among others, so a single effort can mix a spec-driven planning group, two racing builders and a review panel. A template can name the CLI for each role, or leave a role open for whichever agent you choose; Claude and Codex roles use their real terminals by default, or an explicitly chosen structured connection.
- **See it run.** All queues shows every agent's queue side by side: the task each is on, and where one waits for another.
- **Intervene when work needs you.** Failed or uncertain tasks wait in Needs you. Inspect the console, give a correction, retry, or resolve the task explicitly; each attempt stays with the original task. What you type appears as a Message in the queue.
- **Pick up where you left off.** Queue progress and unsaved canvases survive a restart. Reopen paused, reconnect to the same native conversations, and Resume when ready; submitted prompts are never automatically replayed.
- **Control agents and groups.** Right-click an agent’s canvas card, queue heading or session header: Pause finishes its current task and holds the queue; Kill interrupts immediately and keeps the console open. A group offers the same controls for all its members, including nested groups. Resume releases only the chosen pause, preserving individual and other group holds. Other agents keep working, and manual console instructions appear as Message rows.
- **Usage you can plan around.** A gauge per backend shows how much of its 5-hour and weekly windows is used, and when they reset. A usage rule says what happens past a share ("if Claude hits 80%"): warn you, pause and ask, or finish the task and wait for the reset; a queue can also check usage in an If, or wait until a window resets.

As models change, the workflows that work best change with them. corrallm is where you build, mix and run them.

> **Status:** early, but the agents are real. A Claude or Codex agent runs the CLI itself (your own `claude` or `codex`, with its login and settings) in the canvas's project folder, connected one of two ways:
>
> - **Claude · Terminal:** all of Claude Code, in a terminal in the agent view, with any login (a Claude subscription included). corrallm types the queue's messages in and follows each turn. What Claude Code asks you (a permission, with the command or the diff it shows; a question; a plan; whether to trust a folder it has never run in) is also listed in Needs you, to answer in the terminal. In a folder Claude Code has yet to trust, one agent's Claude Code starts first and the others once you have trusted the folder there, so you are asked once. Cmd-click a file it links to (Ctrl-click on Windows and Linux) to show it in your file manager, if it's in the project folder.
> - **Claude · Agent SDK:** a real Claude Code session in corrallm's own transcript and composer, close to Claude Code's own: questions, permissions, plans, live progress, background work you can stop, slash commands, `/resume`, `/mcp`, rewind, and the effort beside the model. It needs an API key or a cloud provider, since Anthropic doesn't allow other products to use subscription logins through the Agent SDK: on a subscription it says so, offers to switch the agent to Terminal, and keeps what was sent to it for the terminal. It can also continue its conversation in Terminal at any time, as it does for Claude Code's own screens (`/permissions`, `/login`…) and its bash mode (`!npm test`).
> - **Codex · Terminal:** all of Codex, in a terminal, with any login (a ChatGPT plan included). In either terminal, the CLI starts only when you open its agent or something is sent to it, files you drop are pasted as their paths, and on a Mac, Option works as Meta on a US-like keyboard layout.
> - **Codex · App Server:** a real Codex thread in corrallm's transcript and composer, with Codex's modes, models, reasoning efforts, approvals, plans and slash commands. It runs on an API key or, in a build you run yourself, on your ChatGPT plan once you allow it (once, or always), as OpenAI allows for local apps and never for commercial or hosted ones: a build made for those refuses a ChatGPT login, holds the queued work, and offers Switch to Codex · Terminal.
>
> What stays true while an agent runs (its name, role, model, effort, mode, usage rule) is a setting; what happens in order is a queue item. Open **Agent settings** from its header summary, its summary in All queues, or Settings… in its right-click menu. It sets name, CLI/connection, standing instructions (Role), and startup model, effort and mode, saved with the workflow. New agents use real Terminal connections; a missing CLI reports an actionable error. Older Qwen/Gemini nodes remain unavailable until you choose a connected CLI. A role change saves without interrupting work; Claude can restart when idle and resume the same conversation. Codex currently keeps its original role when resuming, so the panel offers an explicit new conversation to apply a changed role, preserving the earlier conversation in Codex’s history. The agent chip and structured composer still offer quick connection and live model/effort/mode controls; modes that never ask are confirmed each time.
>
> The queues' Run drives connected agents for real. Steps (with what each is to do, in your words) and messages are turns of the agent's session. A step succeeds or fails as the agent says at the end of its reply, so tests that fail fail it; a step you expect to fail, as tests written first should, is turned round: failing is its success, and passing its failure. A tool step needs SUCCEEDED or FAILED on its final line; a missing verdict or unclear condition answer waits for you. Native cancellation and execution errors stay distinct from that task verdict. An If reads what the agent replied, or asks it, yes or no, about a condition in your own words. Stop interrupts what the run started and pauses the run; Resume continues from its place, while Run again starts fresh. If your or your organization's Claude Code settings turn hooks off, corrallm can't read a Terminal agent's replies, and says so in the agent's bar and in the run.
>
> Links open in your browser once you say so, asked once per site ("Always for this site"); a few known sites open at once. Usage is read for real: Claude's from a Terminal agent's status line (yours still shows), Codex's from its app server (which spends no usage), and either can be simulated to try its rule.

> Queue state, concise attempt records and manual Message metadata are stored locally for named and unsaved canvases. The native CLIs keep their conversation history; full transcript and terminal-screen snapshots are deferred to V2.

## Drive corrallm from a terminal

An orchestrator outside corrallm (Claude Code or Codex in another folder, or a script) can send a canvas's agents work through corrallm's MCP server, registered as `corrallm-server`, and wait for what they send back.

1. **Install the command.** The app ships `corrallm`. The Debian and RPM packages link it as `/usr/bin/corrallm`; on macOS, link `corrallm.app/Contents/Resources/bin/corrallm` onto your PATH yourself for now (for example `ln -s /Applications/corrallm.app/Contents/Resources/bin/corrallm ~/.local/bin/corrallm`). From a checkout, `pnpm build:cli` and then `pnpm corrallm …`. The Windows command isn't available yet.
2. **Open the canvas in the app**, choose its project folder there, and save it. corrallm runs a canvas only in the folder you picked in the app.
3. **Serve it**: quit the app (one corrallm owns a profile at a time), then run `corrallm serve --canvas path/to/canvas.corral` in a terminal. It stops cleanly when that terminal closes, so run it in tmux or screen to keep it going. The app doesn't serve corrallm's MCP yet.
4. **Make a token**, in a terminal: `corrallm token new --canvas path/to/canvas.corral --into ~/.corrallm/orchestrator.token`. It asks whichever corrallm owns the profile (`serve`, or the app while it runs), so the token works at once, or writes the profile itself when nothing does. With `--into` the token goes only to that file, readable only by you; without it, the token is shown once on your terminal. A token lasts an hour unless you say `--hours` (12 at most), reaches only the canvases you name, can write unless `--read-only`, and is named `orchestrator` unless `--name` says otherwise. corrallm keeps only its hash, and runs `corrallm token` only on a terminal, so that you make it.
5. **Register corrallm** with the command `corrallm token` printed for each CLI you have installed, run in your orchestrator's folder. Claude Code's reads the token from the file each time it connects, through `corrallm token header --from <file>`: `claude mcp add-json corrallm-server '{"type":"http","url":"http://127.0.0.1:<port>/mcp","headersHelper":"corrallm token header --from \"<file>\""}'`. Codex's reads it from `CORRALLM_OUTSIDE_TOKEN` as Codex starts: `codex mcp add corrallm-server --url http://127.0.0.1:<port>/mcp --bearer-token-env-var CORRALLM_OUTSIDE_TOKEN`. Keep the registration local to that folder, never user-wide: corrallm's own agents run as you and load your user-wide MCP servers, and would get your orchestrator's token.
6. **Send work and wait.** Your orchestrator calls corrallm's tools: `message` to send an agent work, `status` and `messages` to see where things are, and `wait` for what comes back. For a wait longer than its client lets a tool call run, it runs `corrallm wait --for <message id>`, which reads the token from `CORRALLM_OUTSIDE_TOKEN`, or from the file `CORRALLM_OUTSIDE_TOKEN_FILE` names. On a profile other than the app's (`--profile`), set `CORRALLM_URL` to the URL `serve` printed.

**Renewing and revoking.** `corrallm token renew --into ~/.corrallm/orchestrator.token` gives the token a new value, reaching what it did, for `--hours` from now; `corrallm token revoke` removes it. Either takes effect at once: the old token's next call is refused. A client that reads the token from the file picks up the new one as it reconnects, with no restart; one that reads it from a variable keeps the old one until it starts again with the new value.

**What a token can't do.** A token is never you. It reaches only the canvases it was made for, and those it creates. It can't answer what an agent asks you, pick a file or a folder, change who leads, or an agent's mode, connection or CLI, or make, renew or widen a token. Deleting an agent, or discarding or closing what you might lose, waits in the app for you to allow it.

## Development

corrallm is a cross-platform (macOS, Windows, Linux) Electron desktop app built with Electron Forge, Vite, React and TypeScript.

## Prerequisites

| Tool    | Version                              | Notes                                                    |
| ------- | ------------------------------------ | -------------------------------------------------------- |
| Node.js | 24.21.0 (LTS, pinned in `.nvmrc`)    | Matches the Node version bundled in Electron 44          |
| pnpm    | 12.11.2 (pinned in `packageManager`) | pnpm switches itself to the pinned version automatically |
| Git     | 2.32+                                | Required by the pre-commit hooks                         |

## Setup

### 1. Clone

```sh
git clone https://github.com/jrbarkin/corrallm.git
cd corrallm
```

### 2. Install Node.js 24.21.0 with a version manager

The version is pinned in `.nvmrc`. Managers that read it: [fnm](https://github.com/Schniz/fnm), nvm, and nvm-windows 2.x. With nvm-windows 1.x or Volta, install it explicitly instead (`nvm install 24.21.0 && nvm use 24.21.0` or `volta install node@24.21.0`).

With fnm:

1. Install fnm: `brew install fnm` (macOS), `curl -fsSL https://fnm.vercel.app/install | bash` (Linux), or `winget install Schniz.fnm` (Windows).
2. Add fnm to your shell. This step is required; without it `fnm use` fails.
   - zsh / bash: add `eval "$(fnm env --use-on-cd)"` to `~/.zshrc` or `~/.bashrc`.
   - PowerShell: add `fnm env --use-on-cd --shell powershell | Out-String | Invoke-Expression` to `$PROFILE`. If Windows PowerShell 5.1 refuses to load the profile, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
3. Open a new terminal, `cd` into the repo, then:

```sh
fnm install          # installs the version in .nvmrc; --use-on-cd switches to it automatically
node --version       # v24.21.0
```

### 3. Install pnpm

Install pnpm as a standalone executable. Corepack is not recommended because it has been removed from Node 25+.

```sh
# macOS / Linux
curl -fsSL https://get.pnpm.io/install.sh | sh -
# Windows (pnpm's recommended route; Windows Defender may block the PowerShell installer)
npx get-pnpm
```

Open a new terminal afterwards. Inside this repo, pnpm switches itself to the exact version in `package.json#packageManager`.

### 4. Platform-specific tools

- **macOS:** Xcode Command Line Tools (`xcode-select --install`). The DMG maker's dependencies compile small native add-ons during install.
- **Windows:** nothing extra.
- **Linux:** nothing extra to install or run the app. Terminal agents' terminals need WebGL2 (in a virtual machine, 3D acceleration). To build installers with `pnpm make`, install `dpkg` and `rpm` (for example, `sudo apt-get install dpkg rpm`).

node-pty ships prebuilt Node-API binaries for every supported platform, so no C++ toolchain is needed for it.

## Install

```sh
pnpm install
```

`pnpm install` also sets up the Git pre-commit hook (husky).

The Electron binary (about 100 MB) is downloaded the first time it is needed, not during install. To fetch it up front:

```sh
pnpm exec install-electron
```

## Run

```sh
pnpm dev          # start the app with Vite hot reload
```

What happens when you save a file while `pnpm dev` is running:

| You change…                                             | Result                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/renderer/**` (UI, CSS)                             | Updates in place, component state kept                                                            |
| `src/preload/**`                                        | Rebuilt; the window reloads                                                                       |
| `src/main/**` (or `src/shared` code main uses)          | Rebuilt, but the app keeps running the old code: press `r` in the Forge terminal UI to restart it |
| `forge.config.mts`, `vite.*.config.mts`, `package.json` | Stop with Ctrl+C and run `pnpm dev` again                                                         |

To try the production build, run `pnpm package` and open the app in `out/` (for example `open out/corrallm-darwin-arm64/corrallm.app`).

To check a packaged build without opening it, run it with `CORRALLM_NATIVE_SELFTEST=1` (for example `CORRALLM_NATIVE_SELFTEST=1 out/corrallm-darwin-arm64/corrallm.app/Contents/MacOS/corrallm`): in its main process, its core process and the shipped command, it checks that node-pty, the terminal's screen copy, the Agent SDK, SQLite, loopback HTTP and spawning work (the SDK against a fake `claude` of its own, run by the app's shipped Node rather than any `node` on your PATH; no login needed), and exits with 0.

## Common scripts

| Script           | What it does                                                          |
| ---------------- | --------------------------------------------------------------------- |
| `pnpm dev`       | Run the app in development mode                                       |
| `pnpm typecheck` | Type-check all TypeScript projects                                    |
| `pnpm lint`      | ESLint (type-aware rules)                                             |
| `pnpm format`    | Format all files with Prettier                                        |
| `pnpm test`      | Unit tests (Vitest) for main, preload, renderer and store-performance |
| `pnpm test:e2e`  | Build the app (unsigned) and run the Playwright tests                 |
| `pnpm package`   | Package the app for the current OS into `out/`                        |
| `pnpm make`      | Build installers for the current OS into `out/make/`                  |

Local CI runs the done gate in [AGENTS.md](AGENTS.md). On macOS that ends with `pnpm package` and `scripts/check-macos.sh`, which checks the packaged bundle's signature, the native self-test, the refused launch switches and the shipped command; the self-test alone skips the signature and switch checks. For Linux, with Docker running, use `scripts/ci-linux.sh arm64`, `scripts/check-linux.sh arm64` and `scripts/check-linux-packages.sh arm64`; repeat with `x64` (slow emulation on Apple Silicon). These cover e2e under Xvfb and clean deb/rpm installations. GitHub CI is disabled until the repository is public. See [local CI](docs/architecture/toolchain.md#local-ci-while-the-repository-is-private).

## Debugging

In VS Code, run the **Electron: Main + Renderer** launch configuration. It starts the app under the main-process debugger and attaches a Chrome debugger to the window.

## Code signing (optional)

Signing and notarization are turned on only when the matching environment variables are set. Copy `.env.example` to `.env` (git-ignored) or export the variables in CI. Never commit real credentials.

## Contributing

See [AGENTS.md](AGENTS.md) for development rules and [the architecture overview](docs/architecture/overview.md) for the layout, security mechanisms and IPC recipe.

## License

[Apache License 2.0](LICENSE).

Third-party licenses: the optional Agent SDK connection bundles Anthropic's SDK, used subject to [the Legal Agreements Anthropic outlines](https://code.claude.com/docs/en/legal-and-compliance), as its own license says, and not covered by corrallm's Apache-2.0 license. See [NOTICE](NOTICE).

## Troubleshooting

- **`ERR_PNPM_IGNORED_BUILDS` during install:** a dependency wants to run a build script that has not been approved. Review it, then add it to `allowBuilds` in `pnpm-workspace.yaml`.
- **Engine or version errors:** check that `node --version` prints v24.21.0 or a later 24.x (run `fnm use` in the repo root).
- **Install fails because a package is "too new":** pnpm refuses versions published less than a day ago (`minimumReleaseAge`). Wait a day rather than adding exclusions.
- **Forge complains about pnpm's node linker:** `nodeLinker: hoisted` must stay in `pnpm-workspace.yaml`. pnpm 11+ ignores this setting in `.npmrc`.
- **Electron fails to start on Ubuntu 24.04+ with a sandbox error:** AppArmor blocks the unprivileged user namespaces that Chromium's sandbox uses. Allow them with `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`. Don't disable the sandbox.
- **A Terminal agent's view says its terminal needs WebGL2:** corrallm draws terminals with the GPU, and the production CSP rules out a fallback that would draw them unstyled. In a virtual machine, turn on 3D acceleration; over remote desktop (xrdp, VNC), use the computer's own display; otherwise update or enable its graphics driver. Then reopen the view, or restart corrallm. The CLI keeps running meanwhile.
- **`pnpm test:e2e` on headless Linux (SSH, containers) fails with "Missing X server or $DISPLAY":** install Xvfb (`sudo apt-get install xvfb`) and run `xvfb-run -a pnpm test:e2e`.
