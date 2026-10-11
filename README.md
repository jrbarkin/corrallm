# corrallm

Cross-platform (macOS, Windows, Linux) Electron desktop app built with Electron Forge, Vite, React and TypeScript.

## Prerequisites

| Tool    | Version                              | Notes                                                    |
| ------- | ------------------------------------ | -------------------------------------------------------- |
| Node.js | 24.21.0 (LTS, pinned in `.nvmrc`)    | Matches the Node version bundled in Electron 44          |
| pnpm    | 12.11.2 (pinned in `packageManager`) | pnpm switches itself to the pinned version automatically |
| Git     | 2.32+                                | Required by the pre-commit hooks                         |

### 1. Install Node.js 24 with a version manager

Any manager that reads `.nvmrc` works (fnm, nvm, nvm-windows, Volta). With [fnm](https://github.com/Schniz/fnm):

```sh
# macOS / Linux
brew install fnm            # or: curl -fsSL https://fnm.vercel.app/install | bash
# Windows (PowerShell)
winget install Schniz.fnm

# then, from the repo root
fnm install                 # installs the version in .nvmrc
fnm use
node --version              # v24.21.0
```

Follow fnm's shell setup instructions so the right version is picked up automatically in new terminals.

### 2. Install pnpm

Use the official standalone installer. Corepack is not recommended because it has been removed from Node 25+.

```sh
# macOS / Linux
curl -fsSL https://get.pnpm.io/install.sh | sh -
# Windows (PowerShell)
Invoke-WebRequest https://get.pnpm.io/install.ps1 -UseBasicParsing | Invoke-Expression
```

Open a new terminal afterwards. Inside this repo, pnpm uses the exact version from `package.json#packageManager`.

### 3. Platform-specific tools

- **macOS:** Xcode Command Line Tools (`xcode-select --install`). The DMG maker's dependencies compile small native add-ons during install.
- **Windows:** nothing extra.
- **Linux:** nothing extra to install or run the app. To build installers with `pnpm make`, install `dpkg`, `fakeroot` and `rpm` (for example, `sudo apt-get install dpkg fakeroot rpm`).

node-pty ships prebuilt Node-API binaries for every supported platform, so no C++ toolchain is needed for it.

## Install

```sh
git clone <repo-url> corrallm
cd corrallm
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

## Common scripts

| Script           | What it does                                         |
| ---------------- | ---------------------------------------------------- |
| `pnpm dev`       | Run the app in development mode                      |
| `pnpm typecheck` | Type-check all TypeScript projects                   |
| `pnpm lint`      | ESLint (type-aware rules)                            |
| `pnpm format`    | Format all files with Prettier                       |
| `pnpm test`      | Unit tests (Vitest) for main, preload and renderer   |
| `pnpm test:e2e`  | Build the app and run the Playwright smoke test      |
| `pnpm package`   | Package the app for the current OS into `out/`       |
| `pnpm make`      | Build installers for the current OS into `out/make/` |

## Debugging

In VS Code, run the **Electron: Main + Renderer** launch configuration. It starts the app under the main-process debugger and attaches a Chrome debugger to the window.

## Code signing (optional)

Signing and notarization are turned on only when the matching environment variables are set. Copy `.env.example` to `.env` (git-ignored) or export the variables in CI. Never commit real credentials.

## Contributing

See [`CLAUDE.md`](CLAUDE.md) for the project layout, security rules and how to add an IPC channel.

## Troubleshooting

- **`ERR_PNPM_IGNORED_BUILDS` during install:** a dependency wants to run a build script that has not been approved. Review it, then add it to `allowBuilds` in `pnpm-workspace.yaml`.
- **Engine or version errors:** check that `node --version` prints v24.x (run `fnm use` in the repo root).
- **Forge complains about pnpm's node linker:** `nodeLinker: hoisted` must stay in `pnpm-workspace.yaml`. pnpm 11+ ignores this setting in `.npmrc`.
- **Electron fails to start on Ubuntu 24.04+ with a sandbox error:** AppArmor blocks the unprivileged user namespaces that Chromium's sandbox uses. Allow them with `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`. Don't disable the sandbox.
