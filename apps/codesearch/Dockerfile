# Build from monorepo root: docker build -f apps/codesearch/Dockerfile .
#
# The language SDKs are copied from their official images and release binaries
# are downloaded in isolated stages. This keeps package-manager build caches
# separate from application dependencies. The image builds for linux/amd64 and
# linux/arm64. The complete indexer matrix needs linux/amd64, because scip-clang
# and scip-ruby do not publish Linux arm64 binaries. The linux/arm64 image has
# every other tool, which is enough for the Vitest contracts (their tests run
# fake scip-clang and scip-ruby commands). Production deploys linux/amd64.

# ── Stage 1: Go toolchain and Zoekt binaries ─────────────────────────────────
# golang:1.24-bookworm
FROM golang@sha256:1a6d4452c65dea36aac2e2d606b01b4a029ec90cc1ae53890540ce6173ea77ac AS go-tools
# proxy.golang.org sometimes resets a connection in the middle of a module
# download. The "|" in GOPROXY falls back to the origin on any error, and the
# retry keeps the modules that the module cache already holds.
RUN export GOTOOLCHAIN=auto GOBIN=/zoekt-bin GOPROXY='https://proxy.golang.org|direct' && \
    for attempt in 1 2 3 4 5; do \
      go install github.com/sourcegraph/zoekt/cmd/zoekt-index@596c362fcf1388fe0082acfcfc80c4d172efb7c1 && \
      go install github.com/sourcegraph/zoekt/cmd/zoekt-webserver@596c362fcf1388fe0082acfcfc80c4d172efb7c1 && exit 0; \
      echo "go install failed (attempt $attempt of 5)" >&2; \
      sleep $((attempt * 5)); \
    done; \
    exit 1

# ── Stage 2: Node toolchain and npm-distributed SCIP tools ───────────────────
# node:24.22.1-bookworm-slim
FROM node@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS node-tools
RUN npm install --global \
    @ast-grep/cli@0.45.0 \
    @sourcegraph/scip-python@0.6.6 \
    @sourcegraph/scip-typescript@0.4.0 \
  && npm cache clean --force

# ── Stage 3: Rust toolchain and debian-lsp ───────────────────────────────────
# rust:1-bookworm
FROM rust@sha256:c9155318d07341301a78b45ecdd81af2e43b8b297d64e8fd4c5e80d7735607c3 AS rust-tools
ARG DEBIAN_LSP_REV=daee711aba7282a6e79344c71dcaf85593c54040
# The crates.io release predates debian-lsp's SCIP feature, so build that
# feature from a pinned upstream revision.
RUN cargo install \
    --git https://github.com/jelmer/debian-lsp \
    --rev "${DEBIAN_LSP_REV}" \
    --locked \
    --no-default-features \
    --features scip \
    --root /opt/debian-lsp \
    debian-lsp \
  && rm -rf /usr/local/cargo/git /usr/local/cargo/registry

# ── Stage 4: .NET SDK and scip-dotnet ────────────────────────────────────────
# mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim
FROM mcr.microsoft.com/dotnet/sdk@sha256:6ba9644da07bb5b560a402acec9ca38711a0762969f1b61da261df5c9f6f85da AS dotnet-tools
ARG SCIP_DOTNET_VERSION=0.2.14
RUN dotnet tool install \
    --tool-path /opt/dotnet-tools \
    --version "${SCIP_DOTNET_VERSION}" \
    scip-dotnet

# ── Stage 5: Dart SDK and scip_dart ─────────────────────────────────────────
# dart:stable
FROM dart@sha256:517cbeb4612c4dff11c983edea521d5aef3f47a674c23684fad5e89803ca5b1c AS dart-tools
ARG SCIP_DART_VERSION=1.6.2
ENV PUB_CACHE=/opt/pub-cache
RUN dart pub global activate scip_dart "${SCIP_DART_VERSION}"

# ── Stage 6: Official SCIP release binaries ─────────────────────────────────
FROM scratch AS releases

# debian:bookworm-slim
FROM debian@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3 AS release-tools
ARG TARGETARCH
# Versions and checksums live in release-assets.txt. fetch-releases.sh bounds
# each download (connect, stall and total timeouts, 3 attempts) and fails with
# "Outside service unavailable" when GitHub stays down. CI can pass verified
# files as the `releases` build context (see run-vitest-docker.sh).
RUN --mount=type=bind,source=apps/codesearch/release-assets.txt,target=/release-assets.txt \
    --mount=type=bind,source=apps/codesearch/scripts/fetch-releases.sh,target=/fetch-releases.sh \
    --mount=type=bind,from=releases,target=/releases \
    apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /out /tmp/releases \
  && bash /fetch-releases.sh /release-assets.txt /tmp/releases /releases \
  && cd /tmp/releases \
  && tar -xzf "scip-go-${TARGETARCH}.tar.gz" -C /out scip-go \
  && tar -xzf "scip-${TARGETARCH}.tar.gz" -C /out scip \
  && cp scip-java /out/ \
  && gzip -dc "rust-analyzer-${TARGETARCH}.gz" > /out/rust-analyzer \
  && if [ "${TARGETARCH}" = amd64 ]; then \
    cp scip-clang-amd64 /out/scip-clang && cp scip-ruby-amd64 /out/scip-ruby; \
  fi \
  && chmod +x /out/*

# ── Stage 7: Install application dependencies ────────────────────────────────
# oven/bun:1.4.4-slim
FROM oven/bun@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS bun-runtime

# node:24.22.1-bookworm-slim
FROM node@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS deps
WORKDIR /app
ENV CI=true
RUN npm install -g pnpm@10.12.1
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.json ./
COPY patches patches
COPY apps/codesearch/package.json apps/codesearch/package.json
RUN pnpm install --frozen-lockfile --prod --config.confirmModulesPurge=false

# ── Stage 8: Production runtime ──────────────────────────────────────────────
# Keep the indexer OS contract on Bookworm. Bun's newer slim image uses
# Trixie, which no longer supplies the JDK 17 package required by this matrix.
# debian:bookworm-slim
FROM debian@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3 AS runtime
ARG TARGETARCH
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
ENV BUN_INSTALL=/usr/local

# Runtime build tools let indexers resolve and compile real-world projects.
# universal-ctags lets zoekt-index record symbol metadata for sym: queries.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    clang \
    cmake \
    composer \
    git \
    llvm \
    maven \
    ninja-build \
    openjdk-17-jdk-headless \
    php-cli \
    python3 \
    python3-dev \
    python3-pip \
    python3-venv \
    ruby \
    ruby-dev \
    ruby-bundler \
    universal-ctags \
  && rm -rf /var/lib/apt/lists/*

COPY --from=go-tools /usr/local/go /usr/local/go
COPY --from=go-tools /zoekt-bin/zoekt-index /usr/local/bin/zoekt-index
COPY --from=go-tools /zoekt-bin/zoekt-webserver /usr/local/bin/zoekt-webserver
COPY --from=node-tools /usr/local/ /usr/local/
COPY --from=rust-tools /usr/local/cargo /usr/local/cargo
COPY --from=rust-tools /usr/local/rustup /usr/local/rustup
COPY --from=rust-tools /opt/debian-lsp/bin/debian-lsp /usr/local/bin/debian-lsp
COPY --from=dotnet-tools /usr/share/dotnet /usr/share/dotnet
COPY --from=dotnet-tools /opt/dotnet-tools /opt/dotnet-tools
COPY --from=dart-tools /usr/lib/dart /usr/lib/dart
COPY --from=dart-tools /opt/pub-cache /opt/pub-cache
COPY --from=release-tools /out/ /usr/local/bin/

ENV CARGO_HOME=/usr/local/cargo \
    COMPOSER_ALLOW_SUPERUSER=1 \
    COMPOSER_HOME=/opt/composer \
    DOTNET_ROOT=/usr/share/dotnet \
    JAVA_HOME=/usr/lib/jvm/java-17-openjdk-${TARGETARCH} \
    PUB_CACHE=/opt/pub-cache \
    RUSTUP_HOME=/usr/local/rustup \
    GOPATH=/tmp/ctxpipe-go \
    GOMODCACHE=/tmp/ctxpipe-go/pkg/mod \
    GOCACHE=/tmp/ctxpipe-go/cache \
    PATH="/usr/local/go/bin:/usr/local/cargo/bin:/opt/dotnet-tools:/opt/pub-cache/bin:${PATH}"

ARG SCIP_PHP_VERSION=0.0.2
# v0.0.2 is scip-php's newest release and still constrains google/protobuf to
# <4.33.6, which is affected by the known CVE-2026-6409 audit. Keep PHP matrix
# coverage until upstream ships a release that can consume the fixed major.
# Gradle repositories should use their checked-in wrapper; Bookworm's Gradle
# 4.4 package is too old for representative modern builds.
RUN ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet \
  && ln -s /usr/lib/dart/bin/dart /usr/local/bin/dart \
  && composer global require \
    --no-interaction \
    --no-progress \
    --prefer-dist \
    "davidrjenni/scip-php:${SCIP_PHP_VERSION}" \
  && ln -s /opt/composer/vendor/bin/scip-php /usr/local/bin/scip-php \
  && composer clear-cache \
  && for binary in \
    go node npm python3 javac mvn rustc cargo clang ruby dotnet dart php \
    scip-go scip-typescript scip-python scip-java \
    scip-dotnet scip_dart scip-php debian-lsp rust-analyzer ast-grep scip; \
    do command -v "${binary}"; done \
  && if [ "${TARGETARCH}" = amd64 ]; then command -v scip-clang scip-ruby; fi \
  && ! command -v src \
  && ! command -v sourcegraph-cli

WORKDIR /app
ENV CI=true

ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/codesearch/node_modules ./apps/codesearch/node_modules
COPY tsconfig.json ./
COPY shared ./shared
COPY apps/codesearch/src ./apps/codesearch/src
COPY apps/codesearch/scripts ./apps/codesearch/scripts
COPY apps/codesearch/package.json ./apps/codesearch/package.json
COPY apps/codesearch/tsconfig.json ./apps/codesearch/tsconfig.json

COPY apps/codesearch/start.sh /start.sh
RUN chmod +x /start.sh

RUN mkdir -p /data/zoekt-index /data/repo-cache

EXPOSE 3001
CMD ["/start.sh"]

# ── Stage 9: Vitest (reuses the production toolchain; adds devDependencies) ──
# Build: docker build -f apps/codesearch/Dockerfile --target test -t ctxpipe-codesearch:test .
# Run:   docker run --rm ctxpipe-codesearch:test
FROM runtime AS test
ENV NODE_ENV=development
RUN npm install -g pnpm@10.12.1
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.json ./
COPY patches patches
COPY apps/codesearch/package.json apps/codesearch/package.json
RUN pnpm install --frozen-lockfile --config.confirmModulesPurge=false
COPY apps/codesearch ./apps/codesearch
COPY scripts/ci/check-test-report.mjs ./scripts/ci/check-test-report.mjs
# The trace and result record code (run-vitest-contracts.mjs --trace, --records).
COPY scripts/checks ./scripts/checks
COPY scripts/ci/vitest-launch.mjs ./scripts/ci/vitest-launch.mjs
WORKDIR /app/apps/codesearch
CMD ["pnpm", "run", "test:vitest"]

# Default image (no --target) must stay production; tests use --target test
FROM runtime
