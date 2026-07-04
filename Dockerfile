FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production --ignore-scripts

# Playwright's bundled Chromium needs glibc (hence node:22-bookworm-slim
# above, not the smaller node:22-alpine musl-based image used elsewhere in
# this Dockerfile's history) and its own system library deps — --with-deps
# installs those via apt. --ignore-scripts above already skipped
# Playwright's normal postinstall browser download, so this does it
# explicitly.
RUN npx playwright install --with-deps chromium

# CapSolver's official browser extension (loaded into Playwright to
# auto-solve Cloudflare's JS challenge on dacardworld.com — see
# src/services/dacardworld.js; confirmed with the user this is their actual
# integration path) isn't an npm package, just a GitHub release zip from
# CapSolver's own org. Baked into the image at build time so a flaky GitHub
# fetch can't break a production restart; the real API key gets patched
# into its assets/config.js from CAPSOLVER_API_KEY at runtime, never baked
# in here.
#
# xvfb: confirmed directly against a real run that Chromium's headless mode
# (including the newer "headless=new" implementation) never loads the
# extension's Manifest V3 service worker at all — context.serviceWorkers()
# stayed empty for a full 60s wait, so CapSolver never got a chance to solve
# anything. Extensions need a real ("headed") browser, and this server has
# no display — xvfb-run below gives Chromium a virtual one.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip xvfb \
  && curl -sL "https://github.com/capsolver/capsolver-browser-extension/releases/download/v.1.17.0/CapSolver.Browser.Extension-chrome-v1.17.0.zip" -o /tmp/capsolver.zip \
  && unzip -q /tmp/capsolver.zip -d /app/capsolver-extension \
  && rm /tmp/capsolver.zip \
  && apt-get purge -y unzip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

COPY public ./public
COPY src ./src

EXPOSE 3000

ENV NODE_ENV=production

VOLUME /app/data

CMD ["xvfb-run", "-a", "node", "src/server.js"]
