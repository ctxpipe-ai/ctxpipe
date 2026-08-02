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
    go install github.com/sourcegraph/zoekt/cmd/zoekt-index@latest && \
    GOTOOLCHAIN=auto GOBIN=/zoekt-bin \
    go install github.com/sourcegraph/zoekt/cmd/zoekt-webserver@latest

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
FROM debian:bookworm-slim AS release-tools
ARG TARGETARCH=amd64
ARG SCIP_GO_VERSION=0.2.7
ARG SCIP_VERSION=0.9.0
ARG SCIP_JAVA_VERSION=0.13.1
ARG SCIP_CLANG_VERSION=0.4.0
ARG SCIP_CLANG_SHA256=06fd18c576f979a726c651594644ec4a35db4f471f2160b3f72eb89fa6001784
ARG SCIP_RUBY_VERSION=0.4.7
ARG SCIP_RUBY_SHA256=a068c7c3b2042b9eac563ce77ce35dcaca666b418530b1db9f932a3dbc7175dd
ARG RUST_ANALYZER_VERSION=2026-07-27
ARG RUST_ANALYZER_SHA256=ac4f42ddbbd040d75d847e991894776485783e28beb744b9719a660a99abe115
RUN test "${TARGETARCH}" = "amd64" || \
    (echo "The full SCIP matrix requires linux/amd64 (scip-clang/scip-ruby upstream limitation)." >&2; exit 1)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /out /tmp/releases \
  && cd /tmp/releases \
  && download() { curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors --connect-timeout 15 --max-time 600 "$@"; } \
  && download -O "https://github.com/sourcegraph/scip-go/releases/download/v${SCIP_GO_VERSION}/scip-go-linux-amd64.tar.gz" \
  && download -O "https://github.com/sourcegraph/scip-go/releases/download/v${SCIP_GO_VERSION}/scip-go-linux-amd64.tar.gz.sha256" \
  && sha256sum -c scip-go-linux-amd64.tar.gz.sha256 \
  && tar -xzf scip-go-linux-amd64.tar.gz -C /out scip-go \
  && download -O "https://github.com/scip-code/scip/releases/download/v${SCIP_VERSION}/scip-linux-amd64.tar.gz" \
  && download -O "https://github.com/scip-code/scip/releases/download/v${SCIP_VERSION}/scip-linux-amd64.tar.gz.sha256" \
  && sha256sum -c scip-linux-amd64.tar.gz.sha256 \
  && tar -xzf scip-linux-amd64.tar.gz -C /out scip \
  && download -O \
    "https://github.com/scip-code/scip-java/releases/download/v${SCIP_JAVA_VERSION}/scip-java-v${SCIP_JAVA_VERSION}" \
  && download -O \
    "https://github.com/scip-code/scip-java/releases/download/v${SCIP_JAVA_VERSION}/scip-java-v${SCIP_JAVA_VERSION}.sha256" \
  && sha256sum -c "scip-java-v${SCIP_JAVA_VERSION}.sha256" \
  && mv "scip-java-v${SCIP_JAVA_VERSION}" /out/scip-java \
  && download \
    "https://github.com/sourcegraph/scip-clang/releases/download/v${SCIP_CLANG_VERSION}/scip-clang-x86_64-linux" \
    -o scip-clang \
  && echo "${SCIP_CLANG_SHA256}  scip-clang" | sha256sum -c - \
  && mv scip-clang /out/scip-clang \
  && download \
    "https://github.com/sourcegraph/scip-ruby/releases/download/scip-ruby-v${SCIP_RUBY_VERSION}/scip-ruby-x86_64-linux" \
    -o scip-ruby \
  && echo "${SCIP_RUBY_SHA256}  scip-ruby" | sha256sum -c - \
  && mv scip-ruby /out/scip-ruby \
  && download \
    "https://github.com/rust-lang/rust-analyzer/releases/download/${RUST_ANALYZER_VERSION}/rust-analyzer-x86_64-unknown-linux-gnu.gz" \
    -o rust-analyzer.gz \
  && echo "${RUST_ANALYZER_SHA256}  rust-analyzer.gz" | sha256sum -c - \
  && gzip -dc rust-analyzer.gz > /out/rust-analyzer \
  && chmod +x /out/*

# ── Stage 7: Install application dependencies ────────────────────────────────
FROM oven/bun:1.2-slim AS deps
WORKDIR /app
ENV CI=true
RUN bun install -g pnpm@10.12.1
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.json ./
COPY patches patches
COPY apps/codesearch/package.json apps/codesearch/package.json
RUN pnpm install --frozen-lockfile --prod --config.confirmModulesPurge=false

# ── Stage 8: Production runtime ──────────────────────────────────────────────
FROM oven/bun:1.2-slim AS runtime

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
RUN bun install -g pnpm@10.12.1
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.json ./
COPY patches patches
COPY apps/codesearch/package.json apps/codesearch/package.json
RUN pnpm install --frozen-lockfile --config.confirmModulesPurge=false
COPY apps/codesearch ./apps/codesearch
WORKDIR /app/apps/codesearch
CMD ["pnpm", "run", "test:vitest"]

# Default image (no --target) must stay production; tests use --target test
FROM runtime
