# corrallm

Cross-platform (macOS, Windows, Linux) Electron desktop app built with Electron Forge, Vite, React and TypeScript.

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
- **Linux:** nothing extra to install or run the app. To build installers with `pnpm make`, install `dpkg` and `rpm` (for example, `sudo apt-get install dpkg rpm`).

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

## Common scripts

| Script           | What it does                                               |
| ---------------- | ---------------------------------------------------------- |
| `pnpm dev`       | Run the app in development mode                            |
| `pnpm typecheck` | Type-check all TypeScript projects                         |
| `pnpm lint`      | ESLint (type-aware rules)                                  |
| `pnpm format`    | Format all files with Prettier                             |
| `pnpm test`      | Unit tests (Vitest) for main, preload and renderer         |
| `pnpm test:e2e`  | Build the app (unsigned) and run the Playwright smoke test |
| `pnpm package`   | Package the app for the current OS into `out/`             |
| `pnpm make`      | Build installers for the current OS into `out/make/`       |

## Debugging

In VS Code, run the **Electron: Main + Renderer** launch configuration. It starts the app under the main-process debugger and attaches a Chrome debugger to the window.

## Code signing (optional)

Signing and notarization are turned on only when the matching environment variables are set. Copy `.env.example` to `.env` (git-ignored) or export the variables in CI. Never commit real credentials.

## Contributing

See [`CLAUDE.md`](CLAUDE.md) for the project layout, security rules and how to add an IPC channel.

## License

[Apache License 2.0](LICENSE).

## Troubleshooting

- **`ERR_PNPM_IGNORED_BUILDS` during install:** a dependency wants to run a build script that has not been approved. Review it, then add it to `allowBuilds` in `pnpm-workspace.yaml`.
- **Engine or version errors:** check that `node --version` prints v24.21.0 or a later 24.x (run `fnm use` in the repo root).
- **Install fails because a package is "too new":** pnpm refuses versions published less than a day ago (`minimumReleaseAge`). Wait a day rather than adding exclusions.
- **Forge complains about pnpm's node linker:** `nodeLinker: hoisted` must stay in `pnpm-workspace.yaml`. pnpm 11+ ignores this setting in `.npmrc`.
- **Electron fails to start on Ubuntu 24.04+ with a sandbox error:** AppArmor blocks the unprivileged user namespaces that Chromium's sandbox uses. Allow them with `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`. Don't disable the sandbox.
- **`pnpm test:e2e` on headless Linux (SSH, containers) fails with "Missing X server or $DISPLAY":** install Xvfb (`sudo apt-get install xvfb`) and run `xvfb-run -a pnpm test:e2e`.
