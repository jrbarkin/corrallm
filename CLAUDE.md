# CLAUDE.md

corrallm is a cross-platform Electron desktop app (Electron Forge + Vite + React + TypeScript). It will become an agent orchestrator that spawns and manages the Claude Code and Codex CLIs as child processes. Today it has a canvas of agents in the renderer (`src/renderer/graph/`), each opening into a Claude Code-style session (`src/renderer/agent/`); canvases saved as `.corral` files over the `canvas:*` IPC channels, with a project folder their agents work in. A Claude agent runs Simulated (a scripted session) or connected to the real `claude` CLI, in a Terminal or through the Agent SDK (see Connected sessions): a Terminal agent runs Claude Code's own interactive CLI in a node-pty pseudo-terminal, shown in its agent view with xterm.js (`src/main/sessions/terminal/`); an Agent SDK agent runs a Claude Code session through the Agent SDK, shown in corrallm's own transcript and composer (`src/main/sessions/sdk/`). A Codex agent runs Simulated, or connected to the real `codex` CLI through its app server, shown in corrallm's transcript (`src/main/sessions/codex/app-server/`), or (being built) in a Terminal (`src/main/sessions/codex/`, see Codex).

## Commands

Requires Node 24.21.0 (`.nvmrc`) and pnpm 12.11.2 (`packageManager`).

| Command          | Purpose                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `pnpm dev`       | `electron-forge start`: Vite dev server + HMR; press `r` in its terminal UI after main-process changes |
| `pnpm typecheck` | `tsc -b` over the solution (node, web, tooling projects)                                               |
| `pnpm lint`      | ESLint, type-aware, zero warnings allowed (`lint:fix` to autofix)                                      |
| `pnpm format`    | Prettier write (`format:check` to verify)                                                              |
| `pnpm test`      | Vitest: `main`, `preload` (Node) and `renderer` (jsdom) projects                                       |
| `pnpm test:e2e`  | Playwright; its global setup first builds the app unsigned (`electron-forge package`)                  |
| `pnpm package`   | Packaged app for the current OS in `out/`                                                              |
| `pnpm make`      | Installers for the current OS in `out/make/`                                                           |

- Run one Vitest project with `pnpm exec vitest run --project main`.
- `E2E_SKIP_BUILD=1 pnpm test:e2e` reuses the existing production build in `.vite/` (note `pnpm dev` overwrites it). Headless Linux: `xvfb-run -a pnpm test:e2e`.
- `CORRALLM_CLAUDE_PATH=/path/to/claude` makes connected agents run that `claude` instead of the user's own (the e2e tests point it at a fake: `e2e/fake-claude.mjs` for Terminal agents, `src/main/sessions/sdk/fake-claude.mjs` for the Agent SDK). `CORRALLM_CODEX_PATH` does the same for `codex`.
- Packaged-app native check: after `pnpm package`, run the app binary with `CORRALLM_NATIVE_SELFTEST=1` (e.g. `CORRALLM_NATIVE_SELFTEST=1 out/corrallm-darwin-arm64/corrallm.app/Contents/MacOS/corrallm`). It loads node-pty, spawns a shell that exits, and exits 0 on success. CI runs this on all three OSes.

## Testing

- Test-driven by default. For a bug, first write a test that reproduces it and fails, then fix it, then confirm the test passes. For new behaviour, write the tests with (or before) the code.
- The test suite is the regression guard, not ad-hoc review. Keep tests robust and meaningful: assert behaviour users or callers rely on, not incidental details. Prefer unit tests for logic, and add Playwright e2e only for what needs the real app (pointer interactions, CSP, packaging).
- Tests never run the real Claude. Main's session tests use the fake connector (`src/main/sessions/fake.ts`), renderer tests a fake backend (`src/renderer/test-backend.ts`), and e2e runs the app with `CORRALLM_FAKE_SESSIONS=1` (`launchApp({ env })`; honoured only by unpackaged builds), which gives every connection the fake connector. A connector's own tests drive a fake `claude` that prints the CLI's real formats.
- The Agent SDK connector's tests replay what the real CLI did (`src/main/sessions/sdk/fixtures/`, recorded with Haiku in a scratch folder, its paths and the user's own skills and servers taken out) and drive the real SDK against `sessions/sdk/fake-claude.mjs`; e2e (`e2e/sdk.e2e.ts`) points the built app at it with `CORRALLM_CLAUDE_PATH`. To record new fixtures, run a few tiny prompts through the SDK in a throwaway folder, never a real repository, and keep the same sanitizing.
- The Terminal connector's unit tests run `sessions/terminal/fake-claude.ts` behind a fake pty, and `e2e/terminal.e2e.ts` runs the real connector with `CORRALLM_CLAUDE_PATH` pointing at `e2e/fake-claude.mjs` in a real pty (it logs what it gets in the project folder, since the terminal draws its text on a canvas).
- Codex: what the real CLI did is recorded in `sessions/codex/app-server/fixtures/` (its app server's JSON-RPC, both ways, with timestamps: the handshake, models and limits; three turns with a command, an approval, plan mode, `thread/read`; and, recorded through corrallm's own App Server session, a patch and a command with /diff, /status, /mcp and /skills, an interrupt, a pasted image, a resume with its history and /compact: the connector's tests replay these through `replay.ts`, which fails on any request the recording did not make) and `sessions/codex/terminal/fixtures/` (its TUI in a pty: everything it printed, its window titles, the hooks it posted, the keys sent; a resume, and a resume of a missing session). They were recorded with Codex CLI 0.160.1 and GPT-6-Luna (low effort) in a scratch folder, paths, names, account and the user's own MCP servers replaced with stand-ins of the same length. `sessions/codex/fake-codex.mjs` is a fake `codex` (`--version`, `app-server`: what a message starts with makes it run a command, patch, ask, plan, fail or crash; it keeps threads in `FAKE_CODEX_STATE` to resume them) in the same shapes; tests run it with node, and `e2e/app-server.e2e.ts` runs the built app against it (`CORRALLM_CODEX_PATH`).
- jsdom cannot draw xterm.js: renderer tests that show a Terminal agent mock `src/renderer/terminal/screen.ts` with `fakeScreens` (`src/renderer/terminal/test-screen.ts`), which also fakes main's terminals (`fakeTerminals`).
- Before calling a change done: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm test:e2e`.

## Layout

```
src/main/       Main process (Node). index.ts is the entry; security.ts, app-protocol.ts, csp.ts,
                url-policy.ts hold the security baseline; ipc.ts registers IPC handlers.
                canvas.ts opens and saves canvas files for the canvas:* channels: it remembers
                each renderer's file, so the renderer never passes a path. project.ts keeps each
                canvas's project folder (picked in a folder dialog); memory.ts remembers, per
                canvas file, in the app's user data, its folder and its agents' session ids.
src/main/sessions/  Connected sessions (see Connected sessions): connector.ts is the interface a
                connection implements, manager.ts runs every session for the session:* channels
                (and shows Terminal sessions' screens for the terminal:* channels), connectors.ts
                picks each connection's connector, fake.ts is the fake for tests, args.ts validates
                the channels' arguments, environment.ts resolves the agents' environment (the login
                shell's), executables.ts finds the CLIs in it (claude.ts: `claude`), and
                transcript.ts words what every connection shows the same way (paths, output,
                diffs from unified patches, usage limits and when they reset, notices).
src/main/sessions/sdk/  The Agent SDK connection (see Agent SDK below): connector.ts starts a session
                (query() with Claude Code's options), session.ts runs it (turns, interrupts, mode,
                model), translate.ts turns SDK messages into session events (tools.ts words tool
                calls: summaries, diffs, output), prompts.ts answers canUseTool (permissions,
                AskUserQuestion, plans), history.ts replays a resumed session's transcript, inbox.ts
                feeds the streaming query. fixtures/ holds what the real CLI did (recorded.ts reads
                it); fake-claude.mjs is a fake `claude` that speaks the SDK's protocol.
src/main/sessions/terminal/  The Terminal connection (see Terminal below): session.ts runs any CLI's
                terminal (a TerminalSession: the CLI in a node-pty pty (pty.ts), its turns, typing
                the queue's messages in), told what is particular to the CLI by its TerminalCli
                (cli.ts; Claude Code's is claude-code.ts, typing as typing.ts does); connector.ts
                starts Claude Code's. screen.ts keeps a headless xterm.js copy of its screen
                (snapshots for views, Claude Code's prompt's draft, Program Status reports:
                status.ts, the window title), hooks.ts runs the local server CLIs' hooks post to.
                fake-claude.ts fakes Claude Code for its tests.
src/main/sessions/codex/  Codex (see Codex below): codex.ts finds the user's `codex` and its version,
                rpc.ts runs `codex app-server` and speaks its JSON-RPC, login.ts says which login
                Codex has and what it allows, fake-codex.mjs fakes the CLI; terminal/ and
                app-server/ hold its two connections (their connectors, fixtures recorded from the
                real CLI).
src/main/sessions/codex/app-server/  The App Server connection (see Codex below): connector.ts starts
                the app server and its thread (or resumes it, with its history), session.ts runs the
                thread's turns (modes, model, effort, interrupts, plans, slash commands),
                translate.ts turns its items and notifications into session events, prompts.ts
                answers its requests (approvals, questions, elicitations), commands.ts and diff.ts
                are its slash commands (and /diff's git), protocol.ts what corrallm sends.
                recorded.ts reads fixtures/; replay.ts replays one as an app server, for tests.
src/main/files.ts   The project folder's files for @-mentions (project:files): git's list, or a walk.
src/preload/    Preload script (sandboxed; may import only 'electron' and src/shared). Exposes window.api.
src/renderer/   React UI. index.html is the Vite root; global.d.ts types window.api.
src/renderer/graph/  Graph editor on React Flow (@xyflow/react). Its nodes are agents (type 'agent');
                     groups are type 'frame'. Pure graph operations in graph.ts; the canvas in
                     GraphEditor.tsx (node views in nodes.tsx); an agent's queue (QueueEditor.tsx, queue.ts,
                     SortableList.tsx and sortable.ts) and questions (Questions.tsx), shown in its agent view; agent types and their actions (sourced catalogs) in agents.ts;
                     Questions.tsx's AskCard also shows what the run holds for the user, in the
                     canvas's Needs you sidebar (above agents' questions: asked on the canvas, or
                     in their connected sessions);
                     times (a delay's, a wait's time limit: one Time model in queue.ts) read from
                     what is typed, worded and turned into deadlines in time.ts; a repeat
                     (QueueRepeat: steps, messages, waits and delays run in rounds until a
                     condition holds, at most `rounds`, then ask or go on; or, `until` a
                     RepeatEnds, going round with another agent's repeat) is one item holding
                     others: findItem (queue.ts) finds an item at any depth, and graph.ts's
                     operations reach inside through mapItems;
                     automatic layout (dagre) in layout.ts. Stored edges are links (agents that can
                     talk); arrows for the work one agent's queue gives another are derived from
                     the queues (work.ts, opened in WorkDetail.tsx). Drawing an edge asks which
                     (ConnectMenu.tsx). Canvases save as .corral files (versioned JSON; format and
                     validation in file.ts, open/save bar in FileBar.tsx). examples/ holds .corral
                     templates, listed in examples.ts and shown by ExampleGallery.tsx; a test keeps
                     each one valid and written exactly as toFile writes it. A template may leave
                     blanks ({{key}}, filled from its `fields`; templates.ts) and leave agents' types
                     open (no `agent`: the default, or chosen when it is used; withAgents translates
                     steps between types via EQUIVALENT_ACTIONS in agents.ts). It opens as a new
                     canvas or is inserted into this one as a group (insert.ts).
src/renderer/agent/  The agent view (AgentView.tsx), opened full-screen from an agent on the canvas:
                     the agent's questions and queue, left of a Claude Code-style session
                     (Transcript.tsx, its replies' Markdown in Markdown.tsx and blocks.ts;
                     Composer.tsx, completing slash commands and @-mentions: completion.ts), or
                     a Terminal agent's terminal (src/renderer/terminal/). A rail at its right edge (Rail.tsx) spawns an
                     agent from the one shown (spawnAgent in graph.ts: a peer beside it, or one
                     linked below it) and stacks the others opened that way, to switch between.
                     GraphEditor keeps the stack (the agent shown first) and clears it when the view
                     closes. motion.ts animates the panel: out of its canvas card and back, minimized
                     into the rail, grown out of the ⊕ or a stacked card. Its agent chip sets the
                     agent's type and connection (agents.ts: AGENT_CONNECTIONS). session.ts is the
                     model and reducer; sessions.ts keeps every agent's session
                     (useSyncExternalStore) so turns play on while the canvas is shown, and gives
                     each one a driver (driver.ts): scripted.ts plays scripted turns (script.ts
                     writes them, player.ts plays their steps in time), connected.ts plays a
                     connected session's events from main.
src/renderer/queues/ Every agent's queue side by side, task by task, laid out like a diff viewer
                     (QueuesView.tsx), from the canvas or an agent. lanes.ts aligns rows so a wait
                     sits below what it waits for, links waits and work handed over, and finds waits
                     stuck in a loop; ribbons.ts shapes the ribbons in the gaps between lanes that
                     join linked tasks (from where the view measures them); marks.ts marks tasks
                     (links, the run, a repeat's round) wherever a queue is shown. A repeat is one
                     cell spanning the rows of what it holds (Cell.span, Cell.inner): the cell, its
                     card and its list are CSS subgrids of the lanes' rows, so each item sits in
                     its own row, level with the other lanes.
src/renderer/run/    Running the queues (runner.ts, a store like sessions.ts): each agent works
                     through its queue, messages go to its session (scripted or connected) and are
                     done when the turn ends, other steps are simulated; waits hold until their
                     target is done or their time limit passes, delays until their time comes, OKs
                     until the user decides (RunStore.decide: approve, ask for changes, which go to
                     the agent's session, as a message like any other, before it asks again, or
                     stop, which stops whatever waits on it). A repeat runs in rounds
                     (AgentRun.rounds), its condition decided once per round of the round's last
                     task that ran; out of rounds it fails and goes on, or asks (decide: one more
                     round, what to try next, or go on). A wait in a repeat for a step in another
                     repeat waits for that round of it (#resultOf); one outside waits for the repeat
                     to end. A repeat that follows another holds at the end of each round until its
                     leader goes round, and ends with it (#follow). Delays and limits are the run's
                     own, on the real clock (RunIO.now, one alarm re-checked at least once a
                     minute); Go on now (RunStore.goOn) ends a hold early. asks.ts derives what each
                     hold for the user asks (never stored), shown on its row, All queues' lane head,
                     the Needs you sidebar and above the agent's composer (for a Terminal agent, in
                     the bar under its terminal, with a box of its own for the reply). run.css marks
                     where the run is on a queue's rows, wherever they are shown.
src/renderer/terminal/ A Terminal agent's session in its agent view (TerminalPane.tsx): the CLI's own
                     terminal (xterm.js, screen.ts), linked to main's (link.ts, backend.ts), with a bar
                     of what the run asks of the user, what the session does, its queued messages
                     and the queue's ⊕.
src/renderer/search/ Reusable type-to-search: search() ranks matches, SearchPicker is the dropdown
                     (its `typed` lists options read from what was typed, such as times, first).
src/shared/     Types shared by all processes, including the IPC contract (ipc.ts), the
                connected-session protocol (session.ts) and what a terminal view is shown
                (terminal.ts). No Node, Electron or DOM imports here.
e2e/            Playwright Electron tests (*.e2e.ts) and their global setup. Launch the app with
                launchApp() (launch.ts): a throwaway profile, so the real app's saved state never leaks in.
build/          Packaging resources (macOS entitlements, patched rpm spec template).
```

Queues: there is one queue component, QueueEditor.tsx. Every queue the app shows (an agent's own, the one shown beside it to pick from, the work panel between two agents, the lanes of All queues) is built from its rows (`QueueRow`), its end (`QueueEnd`) and its picking (`PickTask`), styled once in GraphEditor.css (cards at rest; what edits a task shows on the one pointed at; the drag handle always shows). Bind edits to an agent with `editsOf` (graph/edits.ts), word tasks with labels.ts, and mark them with `queueMarks` (queues/marks.ts) rather than adding another copy.

TypeScript: `tsconfig.json` is solution-style and references `tsconfig.node.json` (main, preload, shared), `tsconfig.web.json` (renderer, shared) and `tsconfig.tooling.json` (config files, e2e). All extend `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). Every new `.ts` file must fall under one of these `include`s, or type-aware lint fails with "not found by the project service".

ESLint enforces the process boundaries: renderer and shared code cannot import Electron, Node built-ins or main/preload code; the preload cannot import Node built-ins.

Forge's Vite plugin builds `src/main/index.ts` to `.vite/build/main.cjs`, `src/preload/index.ts` to `.vite/build/preload.cjs`, and the renderer to `.vite/renderer/main_window/`.

## Security rules (do not regress)

- Never enable `nodeIntegration`, and never disable `contextIsolation`, `sandbox` or `webSecurity`. No `<webview>`.
- The preload exposes one typed function per IPC channel through `contextBridge`. Never expose `ipcRenderer`, a generic `invoke`/`send`, or Electron event objects to the renderer.
- All IPC goes through the contract in `src/shared/ipc.ts` and the `handle()` wrapper in `src/main/ipc.ts`, which validates the sender frame (top-level frame of our own origin) and parses arguments. Never call `ipcMain.handle`/`ipcMain.on` directly.
- Production renderer is served from `app://main_window/` by `src/main/app-protocol.ts` (not `file://`, not `loadFile`). The CSP is a response header from `src/main/csp.ts`: never add `'unsafe-inline'` or `'unsafe-eval'` to `PROD_CSP`. Dev-only relaxations go in `DEV_CSP`. The only inline styles allowed are the two exact ones xterm.js writes for its scrollbar, by hash (`TERMINAL_STYLES`); xterm.js draws only with its WebGL renderer, loaded before the terminal opens (its DOM renderer's inline styles are blocked).
- Dev vs production is decided by `MAIN_WINDOW_VITE_DEV_SERVER_URL` (defined only under `pnpm dev`), not `app.isPackaged`. e2e runs the production build unpackaged.
- Navigation and redirects away from the app origin, and renderer-created windows, are blocked (`security.ts`). External links open in the default browser only if `allowedExternalUrl` accepts them (https + `EXTERNAL_URL_ALLOWLIST` in `url-policy.ts`); always open the normalized URL it returns.
- All permission requests and checks are denied (`ALLOWED_PERMISSIONS` in `security.ts`). Add entries deliberately.
- Packaged builds exit if launched with a switch in `FORBIDDEN_SWITCHES` (`src/main/index.ts`): remote debugging, or launcher prefixes such as `--gpu-launcher` that would make the app run an arbitrary executable. CI asserts this.
- Fuses (`forge.config.mts`) must stay as configured: RunAsNode, `NODE_OPTIONS` and Node inspect flags disabled; ASAR integrity and OnlyLoadAppFromAsar enabled (integrity is enforced on macOS and Windows only). Consequences: `child_process.fork` throws in packaged builds (use `utilityProcess.fork` or `spawn`), and Playwright cannot drive the packaged app.
- Credentials only come from environment variables (see `.env.example`). Never commit `.env` or key files; `pnpm dev` strips the signing variables before launching the app. Agents use the `claude` and `codex` CLIs' own logins; corrallm never reads, stores or passes credentials.
- Agents run only in the project folder the user picked in main's folder dialog (`project.ts`): that choice is the trust gate (SDK sessions skip Claude Code's own trust dialog). The renderer never passes a path, a command line, an environment or a session id to resume: main resolves `claude` (`sessions/claude.ts`) and `codex` (`sessions/codex/codex.ts`), the environment and the folder, and remembers session ids itself. Connectors use an agent's id only to route events, never in a path or a command line. Every session's process is closed before the app quits. A Terminal view sends only keystrokes and its size; its CLI's hooks post to a server on 127.0.0.1 that needs the session's own token (from its environment), and corrallm only listens to them (it never answers with a decision).

## Adding an IPC channel

1. Declare it in `IpcContract` in `src/shared/ipc.ts`: `'domain:action': { args: [path: string]; result: Thing }`. Add the matching method to `InvokeApi` (part of `AppApi`) and its channel to `API_CHANNELS`.
2. Add an entry to `createHandlers` in `src/main/ipc.ts`: `'domain:action': { parseArgs, handler }`. `parseArgs` receives `unknown[]` from an untrusted renderer and must validate every argument (type, length, allowed values) or throw. Use `noArgs` for channels without arguments.
3. Expose it in `src/preload/index.ts`: `action: (path) => invoke(API_CHANNELS.action, path)`.
4. Call it from the renderer as `window.api.action(...)`.
5. Extend `src/main/ipc.test.ts` (sender rejection, argument validation) and `src/preload/index.test.ts`. If the UI uses it, stub it in `src/renderer/App.test.tsx` via `stubApi`.

The compiler enforces that main, preload and renderer agree on argument and result types, and that no contract channel is missing a main handler or an `AppApi` method.

Main-to-renderer events: declare the event in `IpcEvents` in `src/shared/ipc.ts` (`'domain:event': [agentId: string, thing: Thing]`), add a function to `EventApi` and its event to `API_EVENTS` (the compiler checks none is missing), expose it in the preload with `listen` (`onThing: (listener) => listen(API_EVENTS.onThing, listener)`: it returns a function that stops listening, and never passes the `IpcRendererEvent` on), and send it from main with `sendEvent(contents, 'domain:event', ...)` (src/main/ipc.ts) to the renderer it concerns only.

## Connected sessions

An agent's connection (`AgentConnection` in agents.ts: `simulated`, or a `Connection` its type offers: Claude's `terminal` and `sdk`, Codex's `codex-terminal` and `app-server`; saved in `.corral` files when not simulated) decides what drives its session. A connection names what runs it, so it implies its CLI (`CONNECTION_CLI` in `src/shared/session.ts`) and its view (`TERMINAL_CONNECTIONS`: the CLI's own terminal; the others, corrallm's transcript). Modes are the CLI's (`CLI_MODES`: Claude Code's permission modes; Codex's presets, Read only, Default ('auto'), Full access, and Plan), validated against the connection's CLI in args.ts and the manager; the composer offers an agent's own (`modesOf` in renderer session.ts). Simulated sessions are scripted in the renderer. Connected ones run in main, over the `session:*` channels and the `session:event` event, in the protocol of `src/shared/session.ts`:

- The renderer (`connected.ts`) starts an agent's session when its view opens or a message is sent (`session:start`: connection, model, mode), sends one message at a time (it keeps its own editable queue; the runner hears each turn's end through `SessionStore.send`'s `onDone`), passes on answers to prompts, interrupts, mode and model changes, and closes the session when the agent goes or runs another way. Session events from main are routed to the agent's driver only if they come from its current connection.
- Main (`sessions/manager.ts`) starts the session with the connection's `Connector` in the canvas's project folder (it refuses without one), with the agents' environment (the user's login shell's, cleaned of what corrallm was started from: `environment.ts`), resuming the agent's last session id (remembered per canvas file in `memory.ts`, so sessions survive a restart: one per CLI, Claude Code's in `sessions` and Codex's threads in `threads`; the same id is resumed whichever of its CLI's connections the agent switches to). Opening or forgetting a canvas, choosing another project folder (which forgets the ids), a renderer that goes or reloads, and quitting (`before-quit` in index.ts) close sessions.
- A connector emits `SessionEvent`s through its `SessionHost`: `started` (model, mode, the models it offers, which the composer's model picker lists; a model may offer reasoning `efforts`, which the composer's effort picker lists, and then `started` says the `effort` too), then per turn: `user` (with the renderer's message id, or a new one for a message typed in a terminal), `status` (working, or waiting on the user) and entries by id (`text`/`thinking` stream in, `tool`/`todos` replace; `parent` nests a subagent's entries), prompts (`permission` with what "always" allows, `question` for AskUserQuestion, `plan` for ExitPlanMode; `withdrawn` when no longer asked), `notice` (compaction, retries, usage limits with their reset time, login problems), `usage`, `mode`, `model`, `effort`, and exactly one `end` naming the messages it answered (interrupted, or failed). `status` is never sent outside a turn: only `end` makes a session idle. `closed` if the session stops by itself; it calls `remember(sessionId)` whenever its CLI's session id is known or changes (as after /clear).
- To build a connection: write its `Connector` in its own folder (`src/main/sessions/sdk/`, `src/main/sessions/terminal/`, `src/main/sessions/codex/app-server/`), find the CLI with `requireClaude(spec.env)` (or `requireCodex`), and register it in `connectors.ts` (`Connectors`: each connection's connector, typed with its CLI's modes; a new connection is added to `CONNECTIONS` and `CONNECTION_CLI` too). Its tests drive a fake `claude`; the manager, IPC, renderer and UI need no change unless the protocol grows (then extend `session.ts`'s types, `connected.ts`'s `receive`, and their tests).
- Reasoning effort is optional: a connection whose models offer efforts implements `LiveSession.setEffort` (`session:effort`; the start options carry the effort chosen); the manager refuses it for the others.
- Beyond turns, a session can send `commands` (the slash commands the composer completes; again when they change) and `history` (a resumed session's past turns, as events: the renderer puts them ahead of its transcript unless it shows them already, matching entries by id). A message may carry pasted `images` (validated in args.ts: kinds Claude reads, base64, at most 5 MB each). The composer's @-mentions search the project folder over `project:files` (`src/main/files.ts`); the renderer sends only what was typed.

### Agent SDK

`src/main/sessions/sdk/` runs a Claude agent through `@anthropic-ai/claude-agent-sdk` (bundled into main: devDependency, root entry only; its per-platform CLI copies are skipped in `pnpm-workspace.yaml`, `ignoredOptionalDependencies`). Rules it keeps:

- One streaming `query()` per session, fed by an `Inbox`, so the CLI runs between turns (interrupts, mode and model changes need it). It runs the user's own `claude` (`pathToClaudeCodeExecutable`), never a JS CLI, with Claude Code's own system prompt (`systemPrompt: { type: 'preset', preset: 'claude_code' }`; without it the agent is bare), the user, project and local settings, the mode always given (Manual is the SDK's `default`), `allowDangerouslySkipPermissions` (so the composer can switch to bypass), partial messages (streaming), summarized thinking (`--thinking-display`), and `perTaskStopAffordance` (interrupting stops the turn, not background work).
- Each message is sent with the renderer's id as its uuid and `origin: { kind: 'human' }`; a turn ends on the `result` whose `user_message_uuids` name it. A result naming none of the messages waiting (a background task's follow-up) ends none of them. Interrupt asks the CLI to cancel what it queued too, and ends what it cancelled.
- Its session id is remembered once a turn has run (the CLI writes the transcript from the first message), and again after /clear. An id with no conversation (one a Terminal session of the agent was given before its first message: the connections share the agent's id; or one whose transcript is gone) starts afresh quietly, as a Terminal session does; a session that cannot be resumed otherwise starts afresh, with a warning. A resumed session's history comes from `getSessionMessages` (history.ts).
- Entry ids are stable between live and history: text and thinking are `<API message id>:<block index>`, tool calls their `tool_use` id, user messages their uuid.
- Prompts are canUseTool calls: permissions offer "always" only where the CLI suggests a rule to keep (its suggestions, worded as Claude Code words them); No denies and stops the turn, as the CLI's No does. An approved plan is carried out in the mode chosen once the CLI has left plan mode (it reports the mode it goes back to).
- Policy: Anthropic's docs ask third-party products not to use a claude.ai subscription login through the Agent SDK without approval; corrallm passes no credentials and uses whatever login `claude` has. The Terminal connection runs the CLI itself and is unaffected.

### Terminal

- A Terminal session (`sessions/terminal/session.ts`) runs whatever CLI its TerminalCli describes (`cli.ts`): how to start and resume it, what its screen reports (Program Status, or its window title), what its hooks mean (`TerminalSignal`s: its session id, prompts it took, its reply, a failure, its state when its screen does not say, its mode and model), how to read its prompt's draft and type into it. Turns, waiting on the user, typing the queue's messages once the prompt is ready, views and closing are the same for every CLI. A CLI that picks its own session ids (`newId()` is null) is remembered once its hooks tell it.
- The Terminal connection (`sessions/terminal/`) runs Claude Code's own interactive CLI, so the user has all of Claude Code in the agent view (`TerminalPane.tsx` in place of the transcript and composer): its prompts, modes, models, slash commands and dialogs are answered there. It is started with `--settings` (a file in the temp folder: corrallm's HTTP hooks, merged with the user's), `--session-id` (new) or `--resume` (one with no transcript starts afresh under the same id), and `--model`/`--permission-mode` only when corrallm chose them (Manual is left to the user's own default). corrallm follows it to orchestrate it: Claude Code's Program Status reports (OSC 7501, answered and read in main's copy of the screen) say when it works, waits on the user, is done, was interrupted (idle) or failed; its hooks (`hooks.ts`) tell the session id (it changes with /clear), prompts typed in the terminal, the last reply, failures, mode and model. A message corrallm sends is typed in (a few characters at a time, Ctrl+J for line breaks, then Enter: never a paste, which Claude Code collapses and treats as untrusted) once the prompt is ready: Claude Code idle or done, and nothing the user typed in it. Meanwhile, a dialog (the folder trust prompt) or the user's draft makes the turn wait on the user. A turn ends once Claude Code has taken every message sent in it and stopped working; one the user started in the terminal is a turn too. Answers, modes and models are refused over the session channels: they belong to the terminal.
- Terminal views: `terminal:attach` asks main to show an agent's terminal; main sends `terminal:event`s (`src/shared/terminal.ts`): the screen as it is (a snapshot of its headless copy, now or once the session starts, and again for each new process), then the CLI's output, then its exit. The view (`link.ts`) writes the snapshot from scratch, drops what its terminal answers while doing so, then passes keystrokes (`terminal:input`) and its size (`terminal:resize`) on. The pty lives in main: closing the view (`terminal:detach`) leaves the session running. While no view is shown, main's copy answers the terminal queries a pty needs answered (DA1, which Windows' ConPTY waits on).

### Codex

- `codex.ts` finds the user's `codex` (CORRALLM_CODEX_PATH, the standalone installer's ~/.local/bin, the login shell's PATH; on Windows npm's native `codex.exe`, never its `.cmd`) and checks its version against `MIN_CODEX_VERSION` (0.160.0: what the fixtures and protocol were read from). Codex keeps its own home (~/.codex: config.toml, AGENTS.md, skills, MCP servers, sessions), so corrallm's threads are the user's (`codex resume` sees them, and corrallm can resume theirs).
- `rpc.ts` runs a private `codex app-server` per session over stdio (never the shared daemon a desktop app runs, never `--listen`: its sockets are unauthenticated), says hello (`initialize` with the experimental API, then `initialized`), always sends params (Codex refuses a request without them), answers every request the server makes (an unanswered approval stalls the turn; unhandled methods get -32601), drains stderr, and closes by ending its input, then SIGTERM, never SIGKILL (that orphans what it runs). The renderer never gets raw JSON-RPC or a generic channel: each action gets a typed `session:*` channel.
- Logins: corrallm never reads, stores or passes credentials; Codex uses its own (`codex login`). OpenAI allows a third-party app to run the app server on a ChatGPT login only for open-source and personal local projects (learn.chatgpt.com/docs/app-server, Auth endpoints: "never been permitted for commercial or hosted services"; developers.openai.com/siwc), so, as with Claude Code's Agent SDK, the App Server connection runs on an API key or another provider's login, and refuses a ChatGPT one (`appServerRefusal` in `login.ts`, from `account/read`); a ChatGPT plan runs through Codex · Terminal, which is Codex's own CLI.
- The App Server connection (`codex/app-server/`) runs a Codex thread in corrallm's transcript. Rules it keeps:
  - One private app server per session, closed with it. Its thread starts (`thread/start`) in the project folder with the mode's approval policy and sandbox. Modes are Codex's /permissions presets (Read only: read-only sandbox, on-request; Default: workspace-write, on-request; Full access: no sandbox, never) and Plan (Codex's plan collaboration mode, with Default's permissions). Every `turn/start` carries the model, effort, approval policy, sandbox policy (the one Codex reported for the thread when of the same kind: it carries the user's own config.toml settings) and collaboration mode, which Codex keeps, so a mode switched mid-turn applies from the next turn. `clientUserMessageId` is the renderer's message id, so a resumed thread's history (`thread/resume`'s `initialTurnsPage`, its last 30 turns) matches what was shown live. A thread is remembered once it has a turn (Codex keeps none without), and one that cannot be found starts afresh quietly.
  - A turn ends with `turn/completed`. A plan proposed in plan mode is asked about once its turn ends ("Implement this plan?", as Codex's TUI asks): Yes switches to Default and sends "Implement the plan." in the same corrallm turn, so the queues' Run hears its end once the plan is carried out; feedback keeps planning; no feedback ends it.
  - Codex's requests are prompts, answered as its TUI answers them (`availableDecisions`): Yes is `accept`, "always" the decision Codex offers to keep (this session, a command prefix, a host), No `cancel`, which stops the turn. Codex remembers what "always" allowed: corrallm never answers for the user. Questions (`request_user_input`), MCP elicitations (a form's fields as questions, a link) and permission requests are prompts too; a request Codex stops waiting for is withdrawn, and every one is answered.
  - Tools keep the names Codex's model knows (`exec_command`, its command unwrapped from the user's shell; `apply_patch`, an entry per file with its diff; `web_search`; `mcp__server__tool`; `spawn_agent`…: a subagent's thread nests under the call that spawned it). Reasoning summaries are thinking (Markdown), `update_plan` the turn's to-do list, compaction and reviews notices, and command output streams at most every 150 ms. Usage is the last request's context and the plan's 5-hour and weekly limits (`account/rateLimits/read`, then updates); errors say what to do by `codexErrorInfo` (log in again, when a usage limit resets, /compact).
  - Slash commands are Codex's (commands.ts), run as its TUI runs them: /review, /compact and /init are turns of the thread; /model, /permissions, /status, /mcp, /skills, /diff (git, run by main with the repository kept from running anything), /new, /clear, /rename are answered by the session. Skills are slash commands too (`/name` is sent as `$name`, with the skill attached). Pasted images go as data: URLs (the app server refuses remote ones), and not to a model that reads none.
- Codex · Terminal is a seam for now (`codex/terminal/connector.ts`: it finds `codex`, then says it is not built). It is to run on the shared Terminal session with a TerminalCli of Codex's own (launch: `codex --no-daemon -C <folder>` with session-only `-c` overrides: the folder trusted, command hooks posting to `hooks.ts`'s server with their trust hashes in `hooks.state`, `tui.terminal_title=["activity","run-state"]`; state from its title: a spinner or Working means working, "Action Required" waiting on the user, Ready done, or failed without a Stop hook; messages pasted with bracketed paste, then Enter; resume with `codex resume <id>`, and "No saved session found" starts afresh); the recordings show each of these.

## Native modules

- Forge's Vite plugin packages only `.vite/`. `package.json` `dependencies` therefore holds only native modules that ship unbundled; everything Vite bundles (React, electron-squirrel-startup, …) belongs in `devDependencies`.
- To add one (e.g. `better-sqlite3`): add it to `dependencies`; add it to `external` in `vite.main.config.mts`; add it to `NATIVE_MODULES` in `forge.config.mts` (runtime files, build-only deps); extend `asar.unpack` so its binaries are real files; keep it in `rebuildConfig.ignoreModules` if it ships Node-API prebuilds; approve its install script in `pnpm-workspace.yaml` `allowBuilds` only if it needs one. Then load and exercise it in `runNativeSelfTest` (`src/main/native-selftest.ts`) so the packaged self-test and CI cover it.
- node-pty is pinned to `1.2.0-beta.14` exactly: 1.1.0 ships a non-executable macOS `spawn-helper` and no Linux prebuilds; beta.15 has a Windows regression (microsoft/node-pty#955).
- node-pty runs Terminal agents (`sessions/terminal/pty.ts`, loaded only when one starts) and the packaged self-test.
- node-pty on Windows: pass `useConptyDll: true` (its default `kill()` path uses `child_process.fork`, which the RunAsNode fuse breaks). The bundled ConPTY sends a DA1 query (`ESC[c`) at startup and holds output for about 3 s until answered: attach the pty to xterm.js (which answers) or, for headless consumers, reply `\x1b[?1;2c` when the query appears. Kill or await every pty before the app quits (teardown crashes, node-pty #904/#951).
- Unit tests must never import native modules or the real `electron` module: `vi.mock('electron', ...)` (importing it downloads the Electron binary).

## Toolchain notes

- TypeScript is pinned to `~6.0.3`. typescript-eslint does not support TypeScript 7 yet; don't upgrade.
- pnpm 11+ reads only auth/registry settings from `.npmrc`. Everything else (`nodeLinker: hoisted`, which Forge requires; `engineStrict`; `allowBuilds`; `minimumReleaseAge`) lives in `pnpm-workspace.yaml`. Dependency build scripts fail the install unless listed in `allowBuilds`.
- `minimumReleaseAge: 1440` is set explicitly, which makes it strict: an install that needs a version under a day old fails. Wait instead of approving it, and treat any `minimumReleaseAgeExclude` diff as a red flag.
- `peerDependencies.electron-winstaller` in `package.json` is intentional (from Forge 8's pnpm template): it keeps maker-squirrel's dependencies resolvable when Forge loads `forge.config.mts` under pnpm. Don't remove it.
- Electron 44 downloads its binary on first use: `pnpm exec install-electron` fetches it up front.
- Unsigned macOS builds are re-signed ad hoc in the `postPackage` hook so the bundle signature verifies. Signing and notarization turn on from env vars (`.env.example`); `CORRALLM_UNSIGNED=1` forces an unsigned build.
- `build/rpm.spec.ejs` is a patched copy of electron-installer-redhat's template (rpmbuild >= 4.20 fix); delete it once upstream ships the fix.
- Forge 8's terminal UI hides plain logs; set `CI=1` for linear output.
- The main bundle is CommonJS, where `import.meta` does not exist: `vite.main.config.mts` defines `import.meta.url` as the bundle's own file URL (the Agent SDK uses it when loaded). Without it the bundler writes `{}.url` and main crashes at start; `e2e/sdk.e2e.ts` would catch it.
- Auto-update is a TODO in `src/main/index.ts` (Squirrel + ZIP makers are compatible with `update-electron-app`).
