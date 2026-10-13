# CLAUDE.md

corrallm is a cross-platform Electron desktop app (Electron Forge + Vite + React + TypeScript). It will become an agent orchestrator that spawns and manages the Claude Code and Codex CLIs as child processes. Today it has a canvas of agents in the renderer (`src/renderer/graph/`), each opening into a Claude Code-style session (`src/renderer/agent/`); canvases saved as `.corral` files over the `canvas:*` IPC channels, with a project folder their agents work in. A Claude agent runs Simulated (a scripted session) or connected to the real `claude` CLI, in a Terminal or through the Agent SDK (see Connected sessions): a Terminal agent runs Claude Code's own interactive CLI in a node-pty pseudo-terminal, shown in its agent view with xterm.js (`src/main/sessions/terminal/`); an Agent SDK agent runs a Claude Code session through the Agent SDK, shown in corrallm's own transcript and composer (`src/main/sessions/sdk/`).

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
- `CORRALLM_CLAUDE_PATH=/path/to/claude` makes connected agents run that `claude` instead of the user's own (the e2e tests point it at a fake: `e2e/fake-claude.mjs` for Terminal agents, `src/main/sessions/sdk/fake-claude.mjs` for the Agent SDK).
- Packaged-app native check: after `pnpm package`, run the app binary with `CORRALLM_NATIVE_SELFTEST=1` (e.g. `CORRALLM_NATIVE_SELFTEST=1 out/corrallm-darwin-arm64/corrallm.app/Contents/MacOS/corrallm`). `runNativeSelfTest` (`src/main/native-selftest.ts`) runs a shell that exits in a node-pty pseudo-terminal (through `spawnPty`, as Terminal agents run), then `src/main/selftest.ts`'s checks: main's terminal screen copy (@xterm/headless and its addons) reads a status report and snapshots, and the bundled Agent SDK (its `import.meta.url` define, its spawning) runs a query against `src/main/selftest-claude.mjs`, a tiny fake `claude` bundled as text (`?raw`, typed in `src/main/raw.d.ts`) only for this, written to a temporary folder and run with the `node` on the PATH (no login). It exits 0 on success, 2 if a check fails (saying which), 3 on a timeout. CI runs this on all three OSes; `src/main/selftest.test.ts` runs the same checks in the unit tests.

## Testing

- Test-driven by default. For a bug, first write a test that reproduces it and fails, then fix it, then confirm the test passes. For new behaviour, write the tests with (or before) the code.
- The test suite is the regression guard, not ad-hoc review. Keep tests robust and meaningful: assert behaviour users or callers rely on, not incidental details. Prefer unit tests for logic, and add Playwright e2e only for what needs the real app (pointer interactions, CSP, packaging).
- Tests never run the real Claude. Main's session tests use the fake connector (`src/main/sessions/fake.ts`), renderer tests a fake backend (`src/renderer/test-backend.ts`), and e2e runs the app with `CORRALLM_FAKE_SESSIONS=1` (`launchApp({ env })`; honoured only by unpackaged builds), which gives every connection the fake connector. A connector's own tests drive a fake `claude` that prints the CLI's real formats.
- The Agent SDK connector's tests replay what the real CLI did (`src/main/sessions/sdk/fixtures/`, recorded with Haiku in a scratch folder, its paths and the user's own skills and servers taken out) and drive the real SDK against `sessions/sdk/fake-claude.mjs`; e2e (`e2e/sdk.e2e.ts`) points the built app at it with `CORRALLM_CLAUDE_PATH`. With `CLAUDE_CONFIG_DIR` set (only then, so it never writes into the user's own `~/.claude`), the SDK fake keeps its conversations' transcripts there as the CLI does, so the SDK's session functions (listSessions, getSessionMessages, forkSession) read them: `sdk/cli.test.ts` and `e2e/sdk.e2e.ts` point it, and main, at a throwaway folder. It takes the SDK's flags as the SDK passes them (`--flag=value`), really edits the project's notes.txt ("edit"), and with file checkpointing on keeps it as it was before each message, for `rewind_files`. Both fakes answer `claude auth status --json` as the real CLI does: a Claude subscription unless their environment has an API key (the SDK one also takes a cloud provider, or an apiKeyHelper in the project's settings), so tests of a working SDK session give the agents a fake ANTHROPIC_API_KEY. On a machine logged in only with claude.ai, the real Agent SDK connection refuses to start: check it live that way, with no prompt, and use Terminal for live checks. To record new fixtures, run a few tiny prompts through the SDK in a throwaway folder, never a real repository, and keep the same sanitizing.
- The Terminal connector's unit tests run `sessions/terminal/fake-claude.ts` behind a fake pty, and `e2e/terminal.e2e.ts` runs the real connector with `CORRALLM_CLAUDE_PATH` pointing at `e2e/fake-claude.mjs` in a real pty (it logs what it gets in the project folder, since the terminal draws its text on a canvas).
- jsdom cannot draw xterm.js: renderer tests that show a Terminal agent mock `src/renderer/terminal/screen.ts` with `fakeScreens` (`src/renderer/terminal/test-screen.ts`), which also fakes main's terminals (`fakeTerminals`).
- Before calling a change done: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm test:e2e`.

## Layout

```
src/main/       Main process (Node). index.ts is the entry; security.ts, app-protocol.ts, csp.ts,
                url-policy.ts hold the security baseline; ipc.ts registers IPC handlers.
                canvas.ts opens and saves canvas files for the canvas:* channels: it remembers
                each renderer's file, so the renderer never passes a path. links.ts opens the
                links users click (link:open), asking first (see Security rules). project.ts keeps each
                canvas's project folder (picked in a folder dialog); memory.ts remembers, per
                canvas file, in the app's user data, its folder, its agents' session ids, and
                the model and mode each agent was given.
src/main/sessions/  Connected sessions (see Connected sessions): connector.ts is the interface a
                connection implements, manager.ts runs every session for the session:* channels
                (and shows Terminal sessions' screens for the terminal:* channels), connectors.ts
                picks each connection's connector, fake.ts is the fake for tests, args.ts validates
                the channels' arguments, environment.ts and claude.ts resolve the agents'
                environment (the login shell's) and the `claude` executable.
src/main/sessions/sdk/  The Agent SDK connection (see Agent SDK below): connector.ts starts a session
                (query() with Claude Code's options) once login.ts has checked the CLI's login (an
                API key or a cloud provider, never a subscription), session.ts runs it (turns, interrupts, mode,
                model; settings.ts reads the CLI's default mode), translate.ts turns SDK messages into session events (tools.ts words tool
                calls: summaries, diffs, output), prompts.ts answers canUseTool (permissions,
                AskUserQuestion, plans) and MCP servers' requests (onElicitation: forms, which
                mcp.ts reads and checks, and links), mcp.ts also words /mcp's servers, history.ts replays a resumed session's transcript, inbox.ts
                feeds the streaming query; conversations.ts reads the conversations Claude Code
                kept for a folder (the SDK's listSessions), whichever connection ran them, for
                /resume, and forks one to rewind it (getSessionMessages, forkSession). fixtures/ holds what the real CLI did (recorded.ts reads
                it); fake-claude.mjs is a fake `claude` that speaks the SDK's protocol.
src/main/sessions/terminal/  The Terminal connection (see Terminal below): connector.ts starts a
                TerminalSession (session.ts: the CLI in a node-pty pty (pty.ts), its turns, typing
                the queue's messages in (typing.ts)), screen.ts keeps a headless xterm.js copy of
                its screen (snapshots for views, the prompt's draft, Program Status reports:
                status.ts), hooks.ts runs the local server its Claude Code hooks post to, drop.ts
                quotes the paths of files dropped on its view. fake-claude.ts fakes the CLI for its
                tests.
src/main/files.ts   The project folder's files for @-mentions (project:files): git's list, or a walk.
src/main/native-selftest.ts, selftest.ts, selftest-claude.mjs  The packaged app's self-test (see Commands).
src/preload/    Preload script (sandboxed; may import only 'electron' and src/shared). Exposes window.api.
src/renderer/   React UI. index.html is the Vite root; global.d.ts types window.api; open-link.ts
                is where clicked links go (main's link:open, provided by App.tsx).
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
                     agent's type and connection (agents.ts: AGENT_CONNECTIONS, Terminal first);
                     an Agent SDK agent's chip also offers Continue in Terminal, and so does its
                     composer for a command only Claude Code's terminal runs (commands.ts:
                     /permissions, /login, a bare /config…, completed "In Terminal" and never sent
                     to the SDK session; and a shell command for its bash mode, "!" first,
                     bashCommand): the agent switches to Terminal, which resumes the same session,
                     and SessionStore.sendOnceIn runs the command there (a "!" message is typed into
                     Claude Code's prompt like any other, so the renderer still passes no command
                     line: running one in main, for the Agent SDK, would need the security rule
                     changed first). The view answers
                     some commands itself for an Agent SDK agent (commands.ts' VIEW_COMMANDS), in
                     a panel above the composer: /resume (ResumePicker.tsx) picks another of the
                     project folder's conversations to open in the agent (SessionStore.resume:
                     main makes it the agent's own, the transcript empties, and the session starts
                     again resuming it, its history filling the transcript), /mcp (McpPanel.tsx)
                     lists its MCP servers to reconnect, disable or enable (signing in to one is
                     Claude Code's /mcp, in Terminal), and /rewind (Rewind.tsx; also Esc twice in
                     an idle Agent SDK agent's empty composer, as in Claude Code, where one Esc
                     still closes the view half a second later, and "Rewind to here" on the
                     user's messages since the last /clear that the CLI has: rewindPoints) previews what restoring the files to before a message
                     changes, then restores the code, the conversation or both
                     (SessionStore.rewind; the message goes back into the composer to edit);
                     Esc closes such a panel first. An MCP
                     server's request shows in the transcript (Elicitation.tsx: a form, or a link
                     to open through main). session.ts is the
                     model and reducer; sessions.ts keeps every agent's session
                     (useSyncExternalStore) so turns play on while the canvas is shown, and gives
                     each one a driver (driver.ts): scripted.ts plays scripted turns (script.ts
                     writes them, player.ts plays their steps in time), connected.ts plays a
                     connected session's events from main; history.ts merges a resumed session's
                     history into the transcript (what it lacks goes where it happened; a turn a
                     Terminal session showed in short is filled in).
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
                     through its queue. A message goes to its session (scripted or connected), or,
                     aimed at another agent, to that one's, and is done when that turn ends (failed
                     if it failed or was interrupted). A connected agent's steps go to its session
                     too (turns.ts words them: a slash command as it is, a tool as a short
                     instruction to use it; with what the step is to do in the user's words,
                     QueueStep.instruction, edited in the step's row: a command's arguments, or
                     after the tool), done when their turn ends; a simulated agent's steps take a
                     timer and may fail (and ignore the instruction). A connected agent's conditions are real (never
                     chance): "the output contains" is matched, exactly, against what it replied in
                     the checked task's turn (RunIO.send's `done`: SessionStore's turnReply, its
                     top-level text; for a Terminal agent, the Stop hook's last reply), and one in
                     the user's words is asked of it in its own session, yes or no ("corrallm asks:
                     …"; an unclear or missing answer is no, said in its session by RunIO.tell, a
                     warning notice a Terminal agent's bar shows too); a simulated agent's are by
                     chance. Stop (and Run again) takes back what the run sent that is still going
                     (RunIO.send returns it: SessionStore.send's take-back, off the session's queue
                     or interrupting its turn), and no longer hears those turns end. Waits hold
                     until their target is done or their time limit passes, delays until their
                     time comes, OKs until the user decides (RunStore.decide: approve, ask for
                     changes, which go to the agent's session, as a message like any other with
                     the images pasted into it, before it asks again, or stop, which stops whatever
                     waits on it; while it asks, a slash command typed in a connected agent's
                     composer runs as a command instead, as its ask bar says). A repeat runs in
                     rounds (AgentRun.rounds), its condition decided once per round of the round's
                     last task that ran; out of rounds it fails and goes on, or asks (decide: one
                     more round, what to try next, or go on). A wait in a repeat for a step in another
                     repeat waits for that round of it (#resultOf); one outside waits for the repeat
                     to end. A repeat that follows another holds at the end of each round until its
                     leader goes round, and ends with it (#follow). Delays and limits are the run's
                     own, on the real clock (RunIO.now, one alarm re-checked at least once a
                     minute); Go on now (RunStore.goOn) ends a hold early. A task whose session would
                     not start (an Agent SDK agent on a Claude subscription: its message stays in
                     that session's queue, RunIO.send's `refused`) neither fails nor goes on: its
                     agent asks the user (AgentRun.refused: the session's words, and Switch to
                     Terminal, which RunIO.connect does), and works again once that agent runs
                     another way (`update`), its session sending what it kept. asks.ts derives what each
                     hold for the user asks (never stored), shown on its row, All queues' lane head,
                     the Needs you sidebar and above the agent's composer (for a Terminal agent, in
                     the bar under its terminal, with a box of its own for the reply). run.css marks
                     where the run is on a queue's rows, wherever they are shown.
src/renderer/terminal/ A Terminal agent's session in its agent view (TerminalPane.tsx): the CLI's own
                     terminal (xterm.js, screen.ts), linked to main's (link.ts, backend.ts), with a bar
                     of what the run asks of the user, the session's last warning (until dismissed),
                     what the session does, its queued messages, the queue's ⊕ and, on a Mac, whether
                     Option works as Meta (keyboard.ts). Files dropped on it are pasted as their paths.
                     What its Claude Code asks in it is listed in the canvas's Needs you sidebar
                     (Questions.tsx's TerminalAskCard: shown, never answered; Open terminal).
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
- Navigation and redirects away from the app origin, and renderer-created windows, are blocked (`security.ts`; one to an allowlisted site, `allowedExternalUrl`, opens in the browser instead). Links the user clicks (Markdown links in a transcript, links Cmd-clicked in a terminal, OSC 8 or found by xterm.js's web-links addon) go to main over `link:open` with only their URL (`OpenLinkContext` in the renderer), never through `window.open` or `target="_blank"`. Main decides, never on the renderer's say-so (`links.ts`): the URL is validated and length-capped (`MAX_LINK_LENGTH`) and normalized by `linkTarget` (`url-policy.ts`: https, or http to localhost or 127.0.0.1 only; no credentials); a site on `EXTERNAL_URL_ALLOWLIST` (https, default port) opens at once; any other asks in a native dialog ("Open docs.example.com in your browser?", with "Always for this site"), one question per window at a time, and a site allowed always is remembered by origin in user data (`links.json`). Always open the normalized URL, never the raw input.
- All permission requests and checks are denied (`ALLOWED_PERMISSIONS` in `security.ts`). Add entries deliberately.
- Packaged builds exit if launched with a switch in `FORBIDDEN_SWITCHES` (`src/main/index.ts`): remote debugging, or launcher prefixes such as `--gpu-launcher` that would make the app run an arbitrary executable. CI asserts this.
- Fuses (`forge.config.mts`) must stay as configured: RunAsNode, `NODE_OPTIONS` and Node inspect flags disabled; ASAR integrity and OnlyLoadAppFromAsar enabled (integrity is enforced on macOS and Windows only). Consequences: `child_process.fork` throws in packaged builds (use `utilityProcess.fork` or `spawn`), and Playwright cannot drive the packaged app.
- Credentials only come from environment variables (see `.env.example`). Never commit `.env` or key files; `pnpm dev` strips the signing variables before launching the app. Agents use the `claude` CLI's own login; corrallm never reads, stores or passes credentials (the Agent SDK connection asks `claude auth status` only what kind of login it has).
- Agents run only in the project folder the user picked in main's folder dialog (`project.ts`): that choice is the trust gate (SDK sessions skip Claude Code's own trust dialog). The renderer never passes a path, a command line or an environment, and names a session to resume only by picking one main listed for the canvas's project folder (`session:list`, then `session:resume`): main resolves `claude` (`sessions/claude.ts`), the environment and the folder, and remembers session ids itself. The one path that crosses is a file dropped on a terminal: the page passes the dropped `File` objects, the preload reads their paths with `webUtils.getPathForFile` (a file the page made has none), and main checks them (`terminal:drop`: absolute, length-capped, no control characters; then that they exist) before pasting them, quoted, into that terminal, never using them otherwise. Connectors use an agent's id only to route events, never in a path or a command line. Every session's process is closed before the app quits. A Terminal view sends only keystrokes, its size and dropped files; its CLI's hooks post to a server on 127.0.0.1 that needs the session's own token (from its environment), and corrallm only listens to them (it never answers with a decision, and never answers what Claude Code asks in its terminal).

## Adding an IPC channel

1. Declare it in `IpcContract` in `src/shared/ipc.ts`: `'domain:action': { args: [path: string]; result: Thing }`. Add the matching method to `InvokeApi` (part of `AppApi`) and its channel to `API_CHANNELS`.
2. Add an entry to `createHandlers` in `src/main/ipc.ts`: `'domain:action': { parseArgs, handler }`. `parseArgs` receives `unknown[]` from an untrusted renderer and must validate every argument (type, length, allowed values) or throw. Use `noArgs` for channels without arguments.
3. Expose it in `src/preload/index.ts`: `action: (path) => invoke(API_CHANNELS.action, path)`.
4. Call it from the renderer as `window.api.action(...)`.
5. Extend `src/main/ipc.test.ts` (sender rejection, argument validation) and `src/preload/index.test.ts`. If the UI uses it, stub it in `src/renderer/App.test.tsx` via `stubApi`.

The compiler enforces that main, preload and renderer agree on argument and result types, and that no contract channel is missing a main handler or an `AppApi` method.

Main-to-renderer events: declare the event in `IpcEvents` in `src/shared/ipc.ts` (`'domain:event': [agentId: string, thing: Thing]`), add a function to `EventApi` and its event to `API_EVENTS` (the compiler checks none is missing), expose it in the preload with `listen` (`onThing: (listener) => listen(API_EVENTS.onThing, listener)`: it returns a function that stops listening, and never passes the `IpcRendererEvent` on), and send it from main with `sendEvent(contents, 'domain:event', ...)` (src/main/ipc.ts) to the renderer it concerns only.

## Connected sessions

A Claude agent's connection (`AgentConnection` in agents.ts: `simulated`, `terminal`, `sdk`; saved in `.corral` files when not simulated) decides what drives its session. Simulated sessions are scripted in the renderer. Connected ones run in main, over the `session:*` channels and the `session:event` event, in the protocol of `src/shared/session.ts`:

- The renderer (`connected.ts`) starts an agent's session when its view opens or a message is sent (`session:start`: connection, and the model and mode the user chose in its composer, `Session.chosen`, or null for each not chosen), sends one message at a time (it keeps its own editable queue; the runner hears each turn's end through `SessionStore.send`'s `onDone`, with what the agent replied in it, and takes a message back with the function `send` returns: off the queue, or interrupting its turn), passes on answers to prompts, interrupts, mode and model changes, and closes the session when the agent goes or runs another way. Session events from main are routed to the agent's driver only if they come from its current connection. A start that fails after a `notice` offering another connection (`switchTo`) is a refusal, not a failed turn: the message that started it goes back to the head of the queue, unsent (never a turn in the transcript; the refusal is said once), its sender hears through `send`'s `onRefused` (as do those of every message queued behind it), and it goes once the agent runs another way, or once the session starts after all (when its view opens again, or another message tries it again). main's `user` echo of a message marks it as the CLI's (`reached`), the only messages a rewind offers.
- Main (`sessions/manager.ts`) starts the session with the connection's `Connector` in the canvas's project folder (it refuses without one), with the agents' environment (the user's login shell's, cleaned of what corrallm was started from: `environment.ts`), resuming the agent's last session id (remembered per canvas file in `memory.ts`, so sessions survive a restart; the same id is resumed whichever connection the agent switches to). It also remembers there the model and mode each agent was given (`chosen`: what the renderer chose at a start, and every `session:mode`/`session:model` switch that succeeded), and fills in the start's nulls from them; what is still null goes to the connector as null, meaning the CLI's default model and the user's own default mode. Bypassing permissions is never remembered: choosing it forgets the agent's mode, so a session never starts bypassing them unless the user just chose to. Opening or forgetting a canvas, choosing another project folder (which forgets the ids), a renderer that goes or reloads, and quitting (`before-quit` in index.ts) close sessions.
- A connector emits `SessionEvent`s through its `SessionHost`: `started` (model, mode, the models it offers, which the composer's model picker lists, each with the effort levels it takes, and `modes` when it can't switch to every mode: bypassing permissions turned off by the CLI's settings, so the mode menu leaves it out), then per turn: `user` (with the renderer's message id, or a new one for a message typed in a terminal), `status` (working, or waiting on the user) and entries by id (`text`/`thinking` stream in, `tool`/`todos` replace; `parent` nests a subagent's entries; a `tool`'s `progress`: how long it has run, what a subagent is doing and has used), prompts (`permission` with what "always" allows, `question` for AskUserQuestion with its header, its answers' meanings and whether several may be picked, `plan` for ExitPlanMode, `elicitation` for an MCP server's form or link; `withdrawn` when no longer asked), `notice` (compaction, retries, usage limits with their reset time, login problems, hooks that failed or blocked; `switchTo` offers another connection, shown as a button that switches the agent: a connector that refuses to start says why this way, before `start` rejects with the same words), `cleared` (/clear: the transcript marks it), `usage`, `mode`, `model`, and exactly one `end` naming the messages it answered (interrupted, or failed). `status` is never sent outside a turn: only `end` makes a session idle. In a turn or not: `tasks` (the work it runs in the background now, the whole list each time; the composer lists them with a Stop, as does each one's tool line), `suggestion` (what the user might send next, after a turn: the composer's empty box offers it, Tab takes it) and, from a Terminal session, `asking` (what its CLI asks the user in its terminal now, `TerminalAsk`s, the whole list each time, none once it goes on: listed in the canvas's Needs you sidebar, never answered from corrallm). `closed` if the session stops by itself; it calls `remember(sessionId)` whenever its CLI's session id is known or changes (as after /clear).
- Besides the turn, the renderer may answer a permission with a no and `feedback` (what to do instead), set the effort (`session:effort`, a level or null for the model's default) and stop a background task by the id `tasks` gave (`session:stopTask`). A connection that does neither leaves `LiveSession.setEffort`/`stopTask` out, and the manager refuses them (a Terminal agent sets them in its terminal).
- To build a connection: write its `Connector` in its own folder (`src/main/sessions/sdk/`, `src/main/sessions/terminal/`), find the CLI with `requireClaude(spec.env)`, and register it in `connectors.ts`. Its tests drive a fake `claude`; the manager, IPC, renderer and UI need no change unless the protocol grows (then extend `session.ts`'s types, `connected.ts`'s `receive`, and their tests).
- Rewind: a `LiveSession` may restore its files to before a message (`rewindFiles`, with a dry run to preview: an Agent SDK session's, Claude Code's file checkpoints, `enableFileCheckpointing`; never while a turn goes on), over `session:rewind-preview` and `session:rewind` (`code`, `conversation` or `both`). Main rewinds a conversation by forking it (`sdk/conversations.ts`: a copy up to the entry before the message, `forkSession`), so either connection resumes the copy, across restarts too: the copy becomes the agent's own and its session ends, to resume it when it starts again (rewound to its first message, the agent starts afresh); the original stays, for /resume. It checks the message is in the conversation, and restores the files, before it forks or ends anything, so a failure changes nothing. A copy has no file checkpoints from before it (the SDK copies none), so its earlier files can no longer be restored, as the preview then says. A Terminal session rewinds in its terminal (Esc twice there).
- /mcp: a `LiveSession` may show its MCP servers itself (`mcpServers`, `changeMcpServer`: an Agent SDK session's, from the CLI's `mcpServerStatus`, `reconnectMcpServer`, `toggleMcpServer`), over `session:mcp` and `session:mcp-change`; a Terminal session's are its terminal's own /mcp.
- /resume: `session:list` lists the conversations Claude Code kept for the canvas's project folder (`sdk/conversations.ts`: the SDK's `listSessions` for the folder's real path, not its worktrees', most recent first), saying which is the agent's own; `session:resume` makes one the agent's own (its session ends; it resumes that one when it starts again). Main opens only a conversation it listed for that renderer and the folder it has now: the renderer names one, never a path.
- Beyond turns, a session can send `commands` (the slash commands the composer completes; again when they change) and `history` (a resumed session's past turns, as events: the renderer puts them ahead of its transcript unless it shows them already, matching entries by id). A message may carry pasted `images` (validated in args.ts: kinds Claude reads, base64, at most 5 MB each). The composer's @-mentions search the project folder over `project:files` (`src/main/files.ts`); the renderer sends only what was typed.

### Agent SDK

`src/main/sessions/sdk/` runs a Claude agent through `@anthropic-ai/claude-agent-sdk` (bundled into main: devDependency, root entry only; its per-platform CLI copies are skipped in `pnpm-workspace.yaml`, `ignoredOptionalDependencies`). Rules it keeps:

- One streaming `query()` per session, fed by an `Inbox`, so the CLI runs between turns (interrupts, mode and model changes need it). It runs the user's own `claude` (`pathToClaudeCodeExecutable`), never a JS CLI, with Claude Code's own system prompt (`systemPrompt: { type: 'preset', preset: 'claude_code' }`; without it the agent is bare), the user, project and local settings, `permissionMode` only when the agent was given a mode (Manual is the SDK's `default`; otherwise the user's own default mode applies, and `started` reports it from the CLI's settings: `settings.ts` asks the running CLI with `get_settings`, which the SDK's Query has at runtime though its types leave it out; the first turn's `init` corrects it if the CLI says otherwise), `allowDangerouslySkipPermissions` (so the mode menu can switch to bypassing permissions once the user confirms it there; as in Claude Code, Shift+Tab never cycles into it, and where the CLI's settings turn it off, `permissions.disableBypassPermissionsMode`, read with `get_settings`, it is not offered), partial messages (streaming), summarized thinking (`--thinking-display`), `perTaskStopAffordance` (interrupting stops the turn, not background work), file checkpoints (`enableFileCheckpointing`, which rewinds restore) and `onElicitation` (MCP servers' requests).
- Each message is sent with the renderer's id as its uuid and `origin: { kind: 'human' }`; a turn ends on the `result` whose `user_message_uuids` name it. A result naming none of the messages waiting (a background task's follow-up) ends none of them. Interrupt asks the CLI to cancel what it queued too, and ends what it cancelled.
- Its session id is remembered once a turn has run (the CLI writes the transcript from the first message), and again after /clear. An id with no conversation (one a Terminal session of the agent was given before its first message: the connections share the agent's id; or one whose transcript is gone) starts afresh quietly, as a Terminal session does; a session that cannot be resumed otherwise starts afresh, with a warning. A resumed session's history comes from `getSessionMessages` (history.ts).
- Entry ids are stable between live and history: text and thinking are `<API message id>:<block index>`, tool calls their `tool_use` id, user messages their uuid.
- Prompts are canUseTool calls: permissions offer "always" only where the CLI suggests a rule to keep (its suggestions, worded as Claude Code words them); No denies and stops the turn, as the CLI's No does; No with what to do instead denies with Claude Code's own message and those words, and the turn goes on. An approved plan is carried out in the mode chosen once the CLI has left plan mode (it reports the mode it goes back to). An MCP server's request (`onElicitation`) is a prompt too: a form, in the flat JSON Schema the protocol allows (`mcp.ts`; one corrallm can't show is declined, and the user told), whose answer main checks against the form before it goes back (one that does not fit is refused and the form still waits), or a link the user opens through `link:open`.
- Live progress and the background (translate.ts): `tool_progress` and `task_progress` become a tool's `progress`; `task_started` ties a task to the call that started it, and `background_tasks_changed` (a level: each one replaces the list; housekeeping tasks left out) becomes `tasks`. `stopTask` stops only a task in that list (query.stopTask; its notification ends its line). Hook events (`includeHookEvents`) show only what Claude Code shows: a hook that failed ("… hook error: …") or blocked ("… hook returned blocking error: …"; a Stop hook's "… hook feedback: …"), never what hooks print when they work. Predictions of the next message (`promptSuggestions`) arrive after a turn's result. The effort is set for the session only (`applyFlagSettings({ effortLevel })`, as /effort does without saving; null goes back to the model's default), and set again when the renderer's session starts again.
- History (history.ts): a turn lasts until its own last work (never the next message, nor what the CLI noted later); a slash command's output shows even when the transcript keeps it as meta (as /context's is).
- Logins ("Terminal for subscriptions"): Anthropic doesn't allow other products to offer claude.ai logins or subscription rate limits through the Agent SDK without its approval. So wherever corrallm offers a Claude connection, Terminal comes first (`AGENT_CONNECTIONS`; agents stay Simulated until connected, and a spawned agent keeps its source's connection), and the Agent SDK connection starts only with an API key (ANTHROPIC_API_KEY, an apiKeyHelper, ANTHROPIC_AUTH_TOKEN) or a cloud provider (Bedrock, Vertex, Foundry, a gateway). Before `query()`, `login.ts` asks the CLI how it is logged in: `claude auth status --json`, run by main with the agents' environment in the project folder (so a project's apiKeyHelper counts). That is the check, not the SDK's own `account`/`apiKeySource` reports, which come only once the CLI runs under the SDK. A claude.ai login (`authMethod: "claude.ai"`), a `claude setup-token` token (`"oauth_token"`), or a status it can't read refuses the start: a `notice` (one sentence, offering Terminal) and a rejection. Not being logged in at all starts, and the CLI says so. corrallm reads only what kind of login the CLI reports, and whether ANTHROPIC_AUTH_TOKEN is set, never a credential's value; it passes none. The Terminal connection runs the CLI itself, with any login.

### Terminal

- The Terminal connection (`sessions/terminal/`) runs Claude Code's own interactive CLI, so the user has all of Claude Code in the agent view (`TerminalPane.tsx` in place of the transcript and composer): its prompts, modes, models, slash commands and dialogs are answered there. It is started with `--settings` (a file in the temp folder: corrallm's HTTP hooks, merged with the user's), `--session-id` (new) or `--resume` (one with no transcript starts afresh under the same id), and `--model`/`--permission-mode` only when the agent was given them (an explicit Manual too, as `manual`, one of the flag's choices; `default` as a model is left out): otherwise the user's own defaults apply. corrallm follows it to orchestrate it: Claude Code's Program Status reports (OSC 7501, answered and read in main's copy of the screen) say when it works, waits on the user, is done, was interrupted (idle) or failed; its hooks (`hooks.ts`) tell the session id (it changes with /clear), prompts typed in the terminal, the last reply, failures, mode and model. A message corrallm sends is typed in (a few characters at a time, Ctrl+J for line breaks, then Enter: never a paste, which Claude Code collapses and treats as untrusted) once the prompt is ready: Claude Code idle or done, and nothing the user typed in it. Meanwhile, a dialog (the folder trust prompt) or the user's draft makes the turn wait on the user. A turn ends once Claude Code has taken every message sent in it and stopped working; one the user started in the terminal is a turn too. Answers, modes and models are refused over the session channels: they belong to the terminal.
- What Claude Code asks in its terminal (`asking`): its PermissionRequest hook tells a permission prompt's tool and input (worded by `sdk/tools.ts`), PreToolUse (only for AskUserQuestion and ExitPlanMode) its questions and plan (PermissionRequest tells them too, without a call id: told once), Notification what it needs when nothing else says (an MCP server's question). Recorded from 2.1.296: the hooks come just before its Program Status says `blocked` (with `kind` permission, question or auth, and `msg`, as "approve Bash: git init" or "answer: Pick a color (Red · Blue)"). corrallm lists what the hooks told within a few seconds before a wait began, or else the wait's `msg` (or the notification's words), while it waits; once it goes on (the user answered in the terminal), the turn ends or the CLI exits, it lists nothing. Without status reports, what the hooks told is listed until the turn ends. Every hook is answered with no decision.
- The view: files dropped on it are pasted as their paths (the preload reads them from the files with `webUtils.getPathForFile`; `terminal:drop` checks them; main pastes those that exist, quoted for a shell, `drop.ts`, bracketed when Claude Code asked, so it takes an image's path as the image). On a Mac, Option works as Meta only on a US-like keyboard layout (`navigator.keyboard.getLayoutMap`; elsewhere Option types characters, as @ on a German layout), unless the user chose otherwise with the switch in the bar (kept in localStorage). When the screen is reset (a snapshot, as for a new CLI process), the view fits it and draws it afresh (`Screen.redraw`).
- Terminal views: `terminal:attach` asks main to show an agent's terminal; main sends `terminal:event`s (`src/shared/terminal.ts`): the screen as it is (a snapshot of its headless copy, now or once the session starts, and again for each new process), then the CLI's output, then its exit. The view (`link.ts`) writes the snapshot from scratch, drops what its terminal answers while doing so, then passes keystrokes (`terminal:input`) and its size (`terminal:resize`) on. The pty lives in main: closing the view (`terminal:detach`) leaves the session running. While no view is shown, main's copy answers the terminal queries a pty needs answered (DA1, which Windows' ConPTY waits on).

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
- The main bundle is CommonJS, where `import.meta` does not exist: `vite.main.config.mts` defines `import.meta.url` as the bundle's own file URL (the Agent SDK uses it when loaded). Without it the bundler writes `{}.url` and main crashes at start; `e2e/sdk.e2e.ts` and the packaged self-test would catch it.
- Auto-update is a TODO in `src/main/index.ts` (Squirrel + ZIP makers are compatible with `update-electron-app`).
