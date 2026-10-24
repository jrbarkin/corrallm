ARG NODE_VERSION
FROM node:${NODE_VERSION}-bookworm
ARG PNPM_VERSION
# Match the build user's passwd shell and put the pinned Node on login-shell PATH, not only
# Docker's initial environment. The core reads this environment before starting any CLI.
ENV SHELL=/bin/bash
COPY linux-node-path.sh /etc/profile.d/corrallm-node.sh
# Build/test tools; clean install checks use separate Debian/Fedora images, never this one.
RUN apt-get update && apt-get install --yes --no-install-recommends \
      xvfb xauth rpm fakeroot libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxtst6 \
      libatk-bridge2.0-0 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 \
      libcups2 libpango-1.0-0 libcairo2 libgl1-mesa-dri libgl1 libglx-mesa0 \
      libegl1 libegl-mesa0 mesa-utils fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global "pnpm@${PNPM_VERSION}"
RUN mkdir -p /home/node/.local/share/pnpm /home/node/.cache/electron \
      /home/node/corrallm/node_modules/.cache/corrallm-node /home/node/corrallm/test-results \
      /home/node/corrallm/playwright-report \
    && chown -R node:node /home/node
ENV npm_config_store_dir=/home/node/.local/share/pnpm/store
USER node
WORKDIR /home/node/corrallm
# Fail during image creation rather than after an hour of tests. Exercise the core's fallback
# shell too, and require the image's runtime rather than an accidentally installed distro Node.
RUN /bin/sh -ilc 'test "$(command -v node)" = /usr/local/bin/node && test "$(node --version)" = "v$NODE_VERSION"' \
    && "$SHELL" -ilc 'test "$(command -v node)" = /usr/local/bin/node && test "$(node --version)" = "v$NODE_VERSION"'
