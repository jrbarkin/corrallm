#!/usr/bin/env bash
# Checks the packaged Linux arm64 app in Docker, as CI checks it on Linux: packages the working
# tree (its tracked and untracked files, never ignored ones such as .env) in a Debian container,
# runs the packaged, fused app's native self-test under xvfb-run (in main and in its core process,
# a utility process), checks that it refuses the launch switches that could hijack it, then runs
# the shipped CLI's self-test under its bundled Node. Exits non-zero if any of it fails. Needs Docker
# running (Docker Desktop on an Apple Silicon Mac runs arm64 natively).
#
#   scripts/check-linux.sh
#
# The image (corrallm-check-linux) and its pnpm store and Electron download (Docker volumes of the
# same name) are kept, so a second run is quicker.
set -euo pipefail

cd "$(dirname "$0")/.."
image=corrallm-check-linux
node_version=$(cat .nvmrc)
pnpm_version=$(sed -n 's/.*"packageManager": "pnpm@\([^"]*\)".*/\1/p' package.json)

docker build --quiet --platform linux/arm64 --tag "$image" \
  --build-arg "NODE_VERSION=$node_version" --build-arg "PNPM_VERSION=$pnpm_version" - <<'EOF'
ARG NODE_VERSION
FROM node:${NODE_VERSION}-bookworm
ARG PNPM_VERSION
# A display for Electron (xvfb), and the libraries Electron needs.
RUN apt-get update && apt-get install --yes --no-install-recommends xvfb xauth libgtk-3-0 \
      libnss3 libasound2 libgbm1 libxss1 libxtst6 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxrandr2 libcups2 libpango-1.0-0 libcairo2 \
  && rm -rf /var/lib/apt/lists/*
RUN npm install --global "pnpm@${PNPM_VERSION}"
# Chromium refuses to run as root without its sandbox: the checks run as the image's node user.
# The volumes mounted over these folders start with their owner.
RUN mkdir -p /home/node/.local/share/pnpm /home/node/.cache/electron /home/node/corrallm \
  && chown -R node:node /home/node
USER node
WORKDIR /home/node/corrallm
EOF

# The working tree as git sees it, files that exist only (not ones deleted but not yet committed).
# Chromium's sandbox needs user namespaces, which Docker's default seccomp profile refuses.
git ls-files -z --cached --others --exclude-standard |
  while IFS= read -r -d '' file; do [ -e "$file" ] && printf '%s\0' "$file"; done |
  COPYFILE_DISABLE=1 tar --null --files-from - --create --file - |
  docker run --rm --interactive --platform linux/arm64 \
    --shm-size 1g \
    --security-opt seccomp=unconfined \
    --env HUSKY=0 --env CI=1 \
    --volume "$image-pnpm:/home/node/.local/share/pnpm" \
    --volume "$image-electron:/home/node/.cache/electron" \
    "$image" bash -c '
      set -euo pipefail
      tar --extract --file - --warning=no-unknown-keyword
      pnpm install --frozen-lockfile
      pnpm exec install-electron
      CORRALLM_UNSIGNED=1 pnpm package
      app=out/corrallm-linux-arm64/corrallm
      run() { xvfb-run --auto-servernum "$app" "$@"; }

      echo "--- Native self-test of the packaged app"
      CORRALLM_NATIVE_SELFTEST=1 run

      echo "--- Launch switches it refuses"
      for switch in --remote-debugging-port=0 --gpu-launcher=refused --renderer-cmd-prefix=refused; do
        code=0
        CORRALLM_NATIVE_SELFTEST=1 run "$switch" || code=$?
        if [ "$code" -ne 1 ]; then
          echo "The packaged app accepted $switch (exit $code, expected 1)" >&2
          exit 1
        fi
        echo "refused $switch"
      done

      echo "--- Native self-test of the shipped command, without Node on PATH"
      PATH= CORRALLM_NATIVE_SELFTEST=1 out/corrallm-linux-arm64/resources/bin/corrallm
    '
echo "Linux arm64: the packaged app and its shipped command passed."
