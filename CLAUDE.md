# CLAUDE.md

corrallm is a cross-platform Electron desktop app (Electron Forge + Vite + React + TypeScript). It will become an agent orchestrator that spawns and manages the Claude Code and Codex CLIs as child processes. Today it has a canvas of agents in the renderer (`src/renderer/graph/`), each opening into a Claude Code-style session that is scripted until agents are connected (`src/renderer/agent/`); canvases saved as `.corral` files over the `canvas:*` IPC channels; and node-pty installed but used only by the packaged-build self-test.

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
- Packaged-app native check: after `pnpm package`, run the app binary with `CORRALLM_NATIVE_SELFTEST=1` (e.g. `CORRALLM_NATIVE_SELFTEST=1 out/corrallm-darwin-arm64/corrallm.app/Contents/MacOS/corrallm`). It loads node-pty, spawns a shell that exits, and exits 0 on success. CI runs this on all three OSes.

## Testing

- Test-driven by default. For a bug, first write a test that reproduces it and fails, then fix it, then confirm the test passes. For new behaviour, write the tests with (or before) the code.
- The test suite is the regression guard, not ad-hoc review. Keep tests robust and meaningful: assert behaviour users or callers rely on, not incidental details. Prefer unit tests for logic, and add Playwright e2e only for what needs the real app (pointer interactions, CSP, packaging).
- Before calling a change done: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm test:e2e`.

## Layout

```
src/main/       Main process (Node). index.ts is the entry; security.ts, app-protocol.ts, csp.ts,
                url-policy.ts hold the security baseline; ipc.ts registers IPC handlers.
                canvas.ts opens and saves canvas files for the canvas:* channels: it remembers
                each renderer's file, so the renderer never passes a path.
src/preload/    Preload script (sandboxed; may import only 'electron' and src/shared). Exposes window.api.
src/renderer/   React UI. index.html is the Vite root; global.d.ts types window.api.
src/renderer/graph/  Graph editor on React Flow (@xyflow/react). Its nodes are agents (type 'agent');
                     groups are type 'frame'. Pure graph operations in graph.ts; the canvas in
                     GraphEditor.tsx (node views in nodes.tsx); an agent's queue (QueueEditor.tsx, queue.ts,
                     SortableList.tsx and sortable.ts) and questions (Questions.tsx), shown in its agent view; agent types and their actions (sourced catalogs) in agents.ts;
                     Questions.tsx's AskCard also shows what the run holds for the user, in the
                     canvas's Needs you sidebar (above agents' own questions);
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
                     (Transcript.tsx, Composer.tsx). A rail at its right edge (Rail.tsx) spawns an
                     agent from the one shown (spawnAgent in graph.ts: a peer beside it, or one
                     linked below it) and stacks the others opened that way, to switch between.
                     GraphEditor keeps the stack (the agent shown first) and clears it when the view
                     closes. motion.ts animates the panel: out of its canvas card and back, minimized
                     into the rail, grown out of the ⊕ or a stacked card. Sessions are scripted for
                     now: session.ts is the model and reducer, player.ts plays a turn's steps in
                     time, script.ts writes the turn, and sessions.ts keeps every agent's session
                     (useSyncExternalStore) so turns play on while the canvas is shown.
src/renderer/queues/ Every agent's queue side by side, task by task, laid out like a diff viewer
                     (QueuesView.tsx), from the canvas or an agent. lanes.ts aligns rows so a wait
                     sits below what it waits for, links waits and work handed over, and finds waits
                     stuck in a loop; ribbons.ts shapes the ribbons in the gaps between lanes that
                     join linked tasks (from where the view measures them); marks.ts marks tasks
                     (links, the run, a repeat's round) wherever a queue is shown. A repeat is one
                     cell spanning the rows of what it holds (Cell.span, Cell.inner): the cell, its
                     card and its list are CSS subgrids of the lanes' rows, so each item sits in
                     its own row, level with the other lanes.
src/renderer/run/    Running the queues, simulated until agents are connected (runner.ts, a store like
                     sessions.ts): each agent works through its queue, messages go to its session,
                     waits hold until their target is done or their time limit passes, delays until
                     their time comes, OKs until the user decides (RunStore.decide: approve, ask for
                     changes, which go to the agent's session before it asks again, or stop, which
                     stops whatever waits on it). A repeat runs in rounds (AgentRun.rounds), its
                     condition decided once per round of the round's last task that ran; out of
                     rounds it fails and goes on, or asks (decide: one more round, what to try
                     next, or go on). A wait in a repeat for a step in another repeat waits for
                     that round of it (#resultOf); one outside waits for the repeat to end. A
                     repeat that follows another holds at the end of each round until its leader
                     goes round, and ends with it (#follow). Delays and limits are the run's own, on the real
                     clock (RunIO.now, one alarm re-checked at least once a minute); Go on now
                     (RunStore.goOn) ends a hold early. asks.ts derives what each hold for the user
                     asks (never stored), shown on its row, All queues' lane head, the Needs you
                     sidebar and above the agent's composer. run.css marks where the run is on a
                     queue's rows, wherever they are shown.
src/renderer/search/ Reusable type-to-search: search() ranks matches, SearchPicker is the dropdown
                     (its `typed` lists options read from what was typed, such as times, first).
src/shared/     Types shared by all processes, including the IPC contract (ipc.ts). No Node,
                Electron or DOM imports here.
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
- Production renderer is served from `app://main_window/` by `src/main/app-protocol.ts` (not `file://`, not `loadFile`). The CSP is a response header from `src/main/csp.ts`: never add `'unsafe-inline'` or `'unsafe-eval'` to `PROD_CSP`. Dev-only relaxations go in `DEV_CSP`.
- Dev vs production is decided by `MAIN_WINDOW_VITE_DEV_SERVER_URL` (defined only under `pnpm dev`), not `app.isPackaged`. e2e runs the production build unpackaged.
- Navigation and redirects away from the app origin, and renderer-created windows, are blocked (`security.ts`). External links open in the default browser only if `allowedExternalUrl` accepts them (https + `EXTERNAL_URL_ALLOWLIST` in `url-policy.ts`); always open the normalized URL it returns.
- All permission requests and checks are denied (`ALLOWED_PERMISSIONS` in `security.ts`). Add entries deliberately.
- Packaged builds exit if launched with a switch in `FORBIDDEN_SWITCHES` (`src/main/index.ts`): remote debugging, or launcher prefixes such as `--gpu-launcher` that would make the app run an arbitrary executable. CI asserts this.
- Fuses (`forge.config.mts`) must stay as configured: RunAsNode, `NODE_OPTIONS` and Node inspect flags disabled; ASAR integrity and OnlyLoadAppFromAsar enabled (integrity is enforced on macOS and Windows only). Consequences: `child_process.fork` throws in packaged builds (use `utilityProcess.fork` or `spawn`), and Playwright cannot drive the packaged app.
- Credentials only come from environment variables (see `.env.example`). Never commit `.env` or key files; `pnpm dev` strips the signing variables before launching the app.

## Adding an IPC channel

1. Declare it in `IpcContract` in `src/shared/ipc.ts`: `'domain:action': { args: [path: string]; result: Thing }`. Add the matching method to `AppApi` and its channel to `API_CHANNELS`.
2. Add an entry to `handlers` in `src/main/ipc.ts`: `'domain:action': { parseArgs, handler }`. `parseArgs` receives `unknown[]` from an untrusted renderer and must validate every argument (type, length, allowed values) or throw. Use `noArgs` for channels without arguments.
3. Expose it in `src/preload/index.ts`: `action: (path) => invoke(API_CHANNELS.action, path)`.
4. Call it from the renderer as `window.api.action(...)`.
5. Extend `src/main/ipc.test.ts` (sender rejection, argument validation) and `src/preload/index.test.ts`. If the UI uses it, stub it in `src/renderer/App.test.tsx` via `stubApi`.

The compiler enforces that main, preload and renderer agree on argument and result types, and that no contract channel is missing a main handler or an `AppApi` method. For main-to-renderer events, add a separate typed event map to `src/shared/ipc.ts` and expose a `subscribe(callback) => unsubscribe` function from the preload; never pass the raw `IpcRendererEvent` to the renderer.

## Native modules

- Forge's Vite plugin packages only `.vite/`. `package.json` `dependencies` therefore holds only native modules that ship unbundled; everything Vite bundles (React, electron-squirrel-startup, …) belongs in `devDependencies`.
- To add one (e.g. `better-sqlite3`): add it to `dependencies`; add it to `external` in `vite.main.config.mts`; add it to `NATIVE_MODULES` in `forge.config.mts` (runtime files, build-only deps); extend `asar.unpack` so its binaries are real files; keep it in `rebuildConfig.ignoreModules` if it ships Node-API prebuilds; approve its install script in `pnpm-workspace.yaml` `allowBuilds` only if it needs one. Then load and exercise it in `runNativeSelfTest` (`src/main/native-selftest.ts`) so the packaged self-test and CI cover it.
- node-pty is pinned to `1.2.0-beta.14` exactly: 1.1.0 ships a non-executable macOS `spawn-helper` and no Linux prebuilds; beta.15 has a Windows regression (microsoft/node-pty#955).
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
- Auto-update is a TODO in `src/main/index.ts` (Squirrel + ZIP makers are compatible with `update-electron-app`).
