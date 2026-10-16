# Build from monorepo root: docker build -f apps/codesearch/Dockerfile .
#
# The language SDKs are copied from their official images and release binaries
# are downloaded in isolated stages. This keeps package-manager build caches
# separate from application dependencies. The complete indexer matrix currently
# targets linux/amd64 because scip-clang and scip-ruby do not publish Linux arm64
# binaries.

# ── Stage 1: Go toolchain and Zoekt binaries ─────────────────────────────────
FROM golang:1.24-bookworm AS go-tools
RUN GOTOOLCHAIN=auto GOBIN=/zoekt-bin \
    go install github.com/sourcegraph/zoekt/cmd/zoekt-index@596c362fcf1388fe0082acfcfc80c4d172efb7c1 && \
    GOTOOLCHAIN=auto GOBIN=/zoekt-bin \
    go install github.com/sourcegraph/zoekt/cmd/zoekt-webserver@596c362fcf1388fe0082acfcfc80c4d172efb7c1

# ── Stage 2: Node toolchain and npm-distributed SCIP tools ───────────────────
FROM node:22-bookworm-slim AS node-tools
RUN npm install --global \
    @ast-grep/cli@0.45.0 \
    @sourcegraph/scip-python@0.6.6 \
    @sourcegraph/scip-typescript@0.4.0 \
  && npm cache clean --force

# ── Stage 3: Rust toolchain and debian-lsp ───────────────────────────────────
FROM rust:1-bookworm AS rust-tools
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
FROM mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim AS dotnet-tools
ARG SCIP_DOTNET_VERSION=0.2.14
RUN dotnet tool install \
    --tool-path /opt/dotnet-tools \
    --version "${SCIP_DOTNET_VERSION}" \
    scip-dotnet

# ── Stage 5: Dart SDK and scip_dart ─────────────────────────────────────────
FROM dart:stable AS dart-tools
ARG SCIP_DART_VERSION=1.6.2
ENV PUB_CACHE=/opt/pub-cache
RUN dart pub global activate scip_dart "${SCIP_DART_VERSION}"

# ── Stage 6: Official SCIP release binaries ─────────────────────────────────
FROM scratch AS releases

FROM debian:bookworm-slim AS release-tools
ARG TARGETARCH=amd64
RUN test "${TARGETARCH}" = "amd64" || \
    (echo "The full SCIP matrix requires linux/amd64 (scip-clang/scip-ruby upstream limitation)." >&2; exit 1)
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
  && tar -xzf scip-go.tar.gz -C /out scip-go \
  && tar -xzf scip.tar.gz -C /out scip \
  && cp scip-java scip-clang scip-ruby /out/ \
  && gzip -dc rust-analyzer.gz > /out/rust-analyzer \
  && chmod +x /out/*

# ── Stage 7: Install application dependencies ────────────────────────────────
FROM oven/bun:1.4.2-slim AS bun-runtime

FROM node:22-bookworm-slim AS deps
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
FROM debian:bookworm-slim AS runtime
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
    JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
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
    scip-go scip-typescript scip-python scip-java scip-clang scip-ruby \
    scip-dotnet scip_dart scip-php debian-lsp rust-analyzer ast-grep scip; \
    do command -v "${binary}"; done \
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
WORKDIR /app/apps/codesearch
CMD ["pnpm", "run", "test:vitest"]

# Default image (no --target) must stay production; tests use --target test
FROM runtime
