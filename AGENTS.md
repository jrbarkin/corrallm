# AGENTS.md

corrallm is an Electron desktop app and a headless core for orchestrating agents on a canvas.
Agents run native CLIs through adapter connections; the core owns documents, messages and durable state.
The renderer projects the core's topics and sends gestures through the operation registry.

These are the canonical instructions for every agent. Before changing an area, read its architecture doc. A behaviour change updates that area's doc in the same commit. Keep instructions here and implementation detail in the docs; CLAUDE.md only imports this file.

## Read before changing

Start with [the overview](docs/architecture/overview.md). Paths include their tests.

| Code area                                                                       | Read                                                                                       |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `src/main/core/`, main services and `src/main/host/`                            | [Core](docs/architecture/core.md)                                                          |
| `src/main/core/store/`                                                          | [Store](docs/architecture/store.md)                                                        |
| `src/shared/api/`, core operations/dispatch/rules/topics, `src/main/api/`       | [Registry](docs/architecture/registry.md)                                                  |
| `src/main/core/delivery/`                                                       | [Messages](docs/architecture/messages.md)                                                  |
| `src/main/cli/`                                                                 | [Headless](docs/architecture/headless.md)                                                  |
| `src/main/core/canvas/`, `src/shared/model/`, canvas memory, projects and files | [Canvas](docs/architecture/canvas.md), [Core](docs/architecture/core.md)                   |
| `src/main/run-journal.ts`, `src/renderer/run/`, restore and switching           | [Run recovery](docs/architecture/run-recovery.md)                                          |
| Adapter descriptors and catalog consumers                                       | [Catalog](docs/architecture/catalog.md)                                                    |
| `src/main/sessions/`, agent settings                                            | [Sessions](docs/architecture/sessions.md)                                                  |
| `src/main/sessions/claude-code/`                                                | [Claude Code](docs/architecture/claude-code.md), [Sessions](docs/architecture/sessions.md) |
| `src/main/sessions/codex/`                                                      | [Codex](docs/architecture/codex.md), [Sessions](docs/architecture/sessions.md)             |
| Usage in main, renderer and shared                                              | [Usage](docs/architecture/usage.md)                                                        |
| `src/renderer/` (graph, agent, queues, terminal, search)                        | [Renderer](docs/architecture/renderer.md)                                                  |
| `src/shared/engine/`                                                            | [Engine](docs/architecture/engine.md)                                                      |
| `src/preload/`, `src/shared/ipc.ts`, `src/main/ipc.ts`, core channels and links | [IPC](docs/architecture/ipc.md), [Security](docs/architecture/security.md)                 |
| Security, CSP, URLs, trust, tokens, paths and permissions                       | [Security](docs/architecture/security.md)                                                  |
| Native dependencies, packaging and self-tests                                   | [Native modules](docs/architecture/native-modules.md)                                      |
| Configs, dependencies, `build/`, `scripts/`                                     | [Toolchain](docs/architecture/toolchain.md)                                                |
| Test infrastructure, fakes, fixtures and `e2e/`                                 | [Testing](docs/architecture/testing.md), plus the area's doc                               |

## Commands and done gate

Requires Node 24.21.0 (`.nvmrc`) and pnpm 12.11.2 (`packageManager`).

| Command                                      | Purpose                                                  |
| -------------------------------------------- | -------------------------------------------------------- |
| `pnpm dev`                                   | Forge + Vite + HMR; press `r` after main-process changes |
| `pnpm typecheck`                             | TypeScript solution (node, web, tooling)                 |
| `pnpm lint`                                  | Type-aware ESLint, zero warnings                         |
| `pnpm format` / `pnpm format:check`          | Prettier write / verify                                  |
| `pnpm test`                                  | Vitest main, preload, renderer and store-performance     |
| `pnpm exec vitest run --project main <file>` | Focused main tests                                       |
| `pnpm test:e2e`                              | Playwright; first builds the unsigned app and CLI        |
| `pnpm package` / `pnpm make`                 | Packaged app / installers                                |
| `pnpm build:cli`                             | Plain Node CLI in `dist-cli/`                            |
| `pnpm corrallm`                              | CLI: serve, wait, dump or native self-test               |
| `pnpm api:surface`                           | Regenerate the API snapshot; review its diff             |

Before calling a change done on macOS: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm test:e2e`, then `pnpm package` and `scripts/check-macos.sh` (bundle signature, native self-test, refused switches and shipped command). The Linux half runs locally in Docker: `scripts/ci-linux.sh`, `scripts/check-linux.sh` and `scripts/check-linux-packages.sh`, each with `arm64` and `x64`. GitHub CI is disabled until the repository is public.
See [toolchain](docs/architecture/toolchain.md) for executable overrides, build environments and the packaged self-test; [testing](docs/architecture/testing.md) for load/crash gates and production-build reuse.

## Testing rules

- Test-driven by default. For a bug, first write a test that reproduces it and fails, then fix it, then confirm the test passes. For new behaviour, write the tests with (or before) the code.
- Assert behaviour callers rely on, not incidental details. Prefer unit tests; e2e is for real app interactions, CSP and packaging.
- Tests never run the real CLIs. `e2e/launch.ts` defaults `CORRALLM_AGENT_PATHS` to `{}`; override only with a JSON map of fakes. Session/core tests use `src/main/sessions/fake.ts`; engine/renderer tests use `src/shared/engine/test-backend.ts`. Connector tests drive fake CLIs against sanitized recorded fixtures. Adapter docs describe their fakes and recordings; keep config/state in throwaway folders, never the user's profile.
- `src/shared/test-catalog.json` is never edited by hand. After descriptor changes regenerate it with `pnpm exec vitest run --project main -u src/main/sessions/adapters.test.ts`. Test catalog consumers with `src/shared/test-made-up.ts` too; shared tests never import the renderer.
- Every test file that makes a run uses `liveRun` and `afterEach(expectRestorable)` from `src/shared/engine/run/test-restore.ts`. A run's checkpoint must restore whatever it holds.
- jsdom cannot draw xterm.js. Mock `src/renderer/terminal/screen.ts` with `fakeScreens` from `src/renderer/terminal/test-screen.ts` (also `fakeTerminals` for main's terminals).
- Unit tests must never import native modules or the real `electron` module: `vi.mock('electron', ...)` (importing it downloads the Electron binary).
- Gesture tests use `expectOneOp` from `src/renderer/test-api.ts`; never substitute renderer-local document edits for operations.

## Security rules (do not regress)

Read [security mechanisms](docs/architecture/security.md) before touching these paths. CLI-specific argv, trust, hooks and R42 ID rules belong in the [Claude Code](docs/architecture/claude-code.md) and [Codex](docs/architecture/codex.md) docs.

- Never enable `nodeIntegration`, and never disable `contextIsolation`, `sandbox` or `webSecurity`. No `<webview>`.
- Expose only typed, fixed channel/operation functions through `contextBridge`. Never expose `ipcRenderer`, a port, generic invoke/send, a function taking a channel/operation name, or Electron event objects to the page.
- Keep `ipcMain.handle`/`ipcMain.on` in `src/main/ipc.ts`: only `core:connect`, checking our top-level sender frame and empty arguments. Identity comes from the trusted window port, never a message. Validate every operation/channel argument in the core.
- Production uses `app://main_window/`, never file:// or loadFile. Never add unsafe-inline or unsafe-eval to `PROD_CSP`; keep dev relaxations in `DEV_CSP` and only the exact hashed xterm styles. Dev is determined by `MAIN_WINDOW_VITE_DEV_SERVER_URL`, not `app.isPackaged`.
- Block navigation, redirects and renderer-created windows. Links use `link.open` or `link.reveal`, never window.open/target=_blank. Validate, cap and normalize URLs in the core; open only normalized targets. File reveal requires an existing real path within the chosen project, never opens/executes it, and never follows a symlink outside.
- All permission requests and checks are denied (`ALLOWED_PERMISSIONS` in `security.ts`). Add entries deliberately.
- Canvas and token text never act as the user. Refuse a token's shell-prefixed message; hold automated canvas text starting with its recipient's current shell prefix at both dispatch and session start. Only user-typed sends pass holds. Frame other parties' messages with their sender; never let a message bypass sandbox permissions.
- No token is ever you. Human identity comes only from main's trusted window/native UI. Human-only operations are refused to tokens, not merely hidden. Token deletes and destructive discard/replace/close/save cases require R4 proposals; only you answer them, only while current, and refusal rules win over proposals.
- Every transport calls `core.call`. Audience/reach are enforced on every call, with rechecks inside scopes/builds; token change rules run on the committed change, whatever op built it. No operation may widen a token.
- Both local servers bind only 127.0.0.1, rejecting foreign Host and any Origin before token checks. MCP accepts only bounded application/json bodies.
- Native conversation IDs meet R42 at every boundary: the platform's bounded safe shape, never a leading dash, then their adapter's stricter shape. Never let an ID be read as a CLI flag. Agent IDs route events only, never argv or native paths.
- One owner per profile: retain both the app instance lock and core.lock. End a canvas's sessions when its window reloads, crashes, closes or switches away, unless the core runs it.
- Canvas files opened or saved and project folders worked in are core-minted `TrustedPath`s from completed dialogs or previously kept canvas memory. No command line mints a `TrustedPath`; `serve` opens a `--canvas` file only if canvas memory names it, using its kept project folder. `--profile` selects a profile, never a trusted project folder. The renderer supplies no project/file path, command line or environment. The picked project is the trust gate. Terminal file drops are the narrow exception: preload-derived paths, core-validated and quoted only for pasting.
- Outside tokens are made, renewed and revoked by a person on a terminal (`serve --new-token`, or `corrallm token` over the profile's owner-only token socket, never MCP), bounded to named canvases/expiry, stored only as durable SHA-256 hashes and printed once, or written only to the 0600 file `--into` names. Never log/store plaintext tokens otherwise or put them in argv; wait reads its environment (or that file) and sends them only to validated local HTTP.
- Read-only Git uses `SAFE_GIT_OPTIONS` as the minimum (no repository fsmonitor or implicit bare repositories). Diff-producing commands also use `safeGitDiffArgs` from `src/main/git.ts`, after reading filter-driver keys, to disable external diff, textconv and filter-driver execution.
- Keep `FORBIDDEN_SWITCHES` and the configured fuses: no RunAsNode, NODE_OPTIONS or Node inspect; ASAR integrity and OnlyLoadAppFromAsar stay enabled. Packaged children use utilityProcess/spawn, not child_process.fork.
- Never commit `.env` or key files. Credentials belong to CLI logins/environment, never corrallm's stores/arguments; login checks ask only the kind. Validate settings against the catalog connection; model and effort values pass `MODEL_PATTERN`/`EFFORT_PATTERN`, never with a leading dash. Explicit startup modes must ask. Hooks are observed, never answered; never override user/managed hook disabling or trust untrusted hooks. Close every session process before quitting. Usage keeps shares and times only.

## Boundaries and toolchain

- ESLint enforces process boundaries: renderer/shared cannot import Electron, Node or main/preload; preload cannot import Node. Shared code (tests too) cannot import renderer or React Flow.
- The Electron-free core, sessions, API, CLI and services cannot import Electron or `src/main/host/`; use `HostServices`. Only the core composes profile stores. Only approved core sites mint `TrustedPath`; only `core/gui.ts` makes human callers.
- Only `src/main/sessions/adapters.ts` imports adapter folders in production. Adapters may import their own code and terminal toolkit, never another adapter (tests included). `ADAPTER_IMPORTERS` stays empty.
- Platform code names no CLI. `src/main/platform-neutral.test.ts` pins existing exceptions exactly; lower counts when they drop, never increase them to accommodate new names. Read the catalog/registry instead.
- Every new TypeScript file must belong to a tsconfig `include`: node (main/preload/shared), web (renderer/shared), or tooling (configs/e2e). Keep strict base options and solution references.
- Keep TypeScript `~6.0.3` (typescript-eslint does not support 7), node-pty `1.2.0-beta.14`, and the Node/pnpm pins above. pnpm workspace settings/build approvals live in `pnpm-workspace.yaml`; retain strict `minimumReleaseAge: 1440`, wait for too-new packages, and treat exclusions as a red flag. Keep the intentional electron-winstaller peer dependency.
- Only unbundled native modules belong in dependencies; Vite-bundled packages belong in devDependencies. Follow [native modules](docs/architecture/native-modules.md) for externals, packing, rebuilds and install approvals; exercise each in packaged/main/core/CLI self-tests. Keep Windows ConPTY settings and close every pty before quit.
- SQLite is reached only through `sqlite.ts`; writes acknowledge only after the log flush. A failed flush fails the store closed. The checkpointer is the only other writing connection.

## Adding things

These are checklists; read the linked recipe before implementing.

- **Operation:** [registry recipe](docs/architecture/registry.md). Add audience/kind/scope/rules/self/drains to SURFACE; define strict bounded branded input and object output; implement through core services (`ctx.commit` for documents); add deviation/UNHOSTED if needed, RULES/checks, REAL_FIXTURES and reach fixtures for every ID kind. Add the gesture or NO_GESTURE reason. Run `pnpm api:surface`, inspect its diff, and keep surface/transport/reach/gesture tests green.
- **IPC channel:** [IPC recipe](docs/architecture/ipc.md). Prefer an operation. Transitional channels declare IpcContract, InvokeApi and API_CHANNELS, validate unknown arguments in core handlers, expose one fixed preload method, then add core/preload tests and UI stubs. Events declare IpcEvents/EventApi/API_EVENTS and a removable listener; send only to the canvas's windows.
- **Connection:** [sessions recipe](docs/architecture/sessions.md). Implement a Connector in its adapter using the registry-supplied executable, declare its descriptor and register it by connection ID; pin capabilities in the adapter contract and drive a fake CLI in tests. Extend shared session types, the engine receiver and tests only if the protocol grows. Keep argv, native-ID validation and other CLI-specific rules inside the adapter.

The docs guard (`src/main/docs.test.ts`) checks concrete backticked repository paths, this file's 20,000-byte ceiling and the exact CLAUDE import. Update references when files move.
