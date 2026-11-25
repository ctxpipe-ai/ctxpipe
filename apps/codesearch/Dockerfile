# Build from monorepo root: docker build -f apps/codesearch/Dockerfile .
#
# The language SDKs are copied from their official images and release binaries
# are downloaded in isolated stages. This keeps package-manager build caches
# separate from application dependencies. The image builds for linux/amd64 and
# linux/arm64 with the complete indexer matrix. Upstream publishes scip-clang
# and scip-ruby only for x86_64. Thus apps/codesearch/indexers/Dockerfile
# builds both for each platform, and release-assets.txt pins the release of
# that build. Railway pulls linux/amd64, and the AWS hosts pull linux/arm64.
#
# The runtime is Debian 13 (Trixie, GLIBC 2.41). The toolchain stages stay on
# Debian 12 images: a binary that links GLIBC 2.36 also runs on 2.41.

# ── Stage 1: Go toolchain and Zoekt binaries ─────────────────────────────────
FROM golang:1.27.4-bookworm@sha256:4fa7c968ba93f1635670522dbb01a2c78150443e1385746924566079f36570ea AS go-tools
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
FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS node-tools
RUN npm install --global \
    @ast-grep/cli@0.51.3 \
    @sourcegraph/scip-python@0.6.8 \
    @sourcegraph/scip-typescript@0.6.2 \
  && npm cache clean --force

# ── Stage 3: Rust toolchain and debian-lsp ───────────────────────────────────
FROM rust:1.99.1-bookworm@sha256:e6f2cff35d0f309acf8433b4f05878ed77092602c5065cc81801177da0bb3a9c AS rust-tools
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
FROM mcr.microsoft.com/dotnet/sdk:8.0.428-bookworm-slim@sha256:1b955f179b02df4f0eb5fadedaa898cbe44d620a64aab52eec72c8e91d1355b5 AS dotnet-tools
ARG SCIP_DOTNET_VERSION=0.2.14
RUN dotnet tool install \
    --tool-path /opt/dotnet-tools \
    --version "${SCIP_DOTNET_VERSION}" \
    scip-dotnet

# ── Stage 5: Dart SDK and scip_dart ─────────────────────────────────────────
FROM dart:3.14.0@sha256:c78970229c8944bd6076caf4e5977ef569ba66750d301a2149f63b41a6725cec AS dart-tools
ARG SCIP_DART_VERSION=1.6.2
ENV PUB_CACHE=/opt/pub-cache
RUN dart pub global activate scip_dart "${SCIP_DART_VERSION}"

# ── Stage 6: Official SCIP release binaries ─────────────────────────────────
FROM scratch AS releases

FROM debian:trixie-20261104-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS release-tools
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
  && mkdir -p /out /test-out /tmp/releases \
  && TARGETARCH="${TARGETARCH}" bash /fetch-releases.sh /release-assets.txt /tmp/releases /releases \
  && cd /tmp/releases \
  && tar -xzf "scip-go-${TARGETARCH}.tar.gz" -C /out scip-go \
  && tar -xzf "scip-${TARGETARCH}.tar.gz" -C /out scip \
  && cp scip-java /out/ \
  && gzip -dc "rust-analyzer-${TARGETARCH}.gz" > /out/rust-analyzer \
  && cp "scip-clang-${TARGETARCH}" /out/scip-clang \
  && cp "scip-ruby-${TARGETARCH}" /out/scip-ruby \
  && tar -xzf "versitygw-${TARGETARCH}.tar.gz" -C /test-out --strip-components=1 --wildcards '*/versitygw' \
  && chmod +x /out/* /test-out/*

# ── Stage 7: JDK 17 and Maven ───────────────────────────────────────────────
# Debian 13 has no JDK 17 package, and its JDK 21 cannot run Gradle wrappers
# before 8.5. The Temurin image keeps JDK 17 and brings its Maven.
FROM maven:3.9.16-eclipse-temurin-17@sha256:1a352420f7aba21f5ad08df31bab55f74c013fb491f1ae8ab1dd7ff9ed698584 AS java-tools

# ── Stage 8: Install application dependencies ────────────────────────────────
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS bun-runtime

FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS deps
WORKDIR /app
ENV CI=true
RUN npm install -g pnpm@11.28.11
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.json ./
COPY patches patches
COPY apps/codesearch/package.json apps/codesearch/package.json
# The pnpm store is a BuildKit cache mount (scripts/checks/README.md, Builds).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --store-dir /pnpm/store --frozen-lockfile --prod --config.confirmModulesPurge=false

# ── Stage 9: Production runtime ──────────────────────────────────────────────
FROM debian:trixie-20261104-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS runtime
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
ENV BUN_INSTALL=/usr/local

# Runtime build tools let indexers resolve and compile real-world projects.
# universal-ctags lets zoekt-index record symbol metadata for sym: queries.
# The apt packages have no version pins on purpose: Debian stable ships only
# fixes, and a pin breaks when the mirror drops that version. The nightly
# non-portable detector (scripts/checks/non-portable.json) guards the drift.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    clang \
    cmake \
    composer \
    git \
    llvm \
    ninja-build \
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
COPY --from=java-tools /opt/java/openjdk /opt/java/openjdk
COPY --from=java-tools /usr/share/maven /usr/share/maven
COPY --from=release-tools /out/ /usr/local/bin/

ENV CARGO_HOME=/usr/local/cargo \
    COMPOSER_ALLOW_SUPERUSER=1 \
    COMPOSER_HOME=/opt/composer \
    DOTNET_ROOT=/usr/share/dotnet \
    JAVA_HOME=/opt/java/openjdk \
    PUB_CACHE=/opt/pub-cache \
    RUSTUP_HOME=/usr/local/rustup \
    GOPATH=/tmp/ctxpipe-go \
    GOMODCACHE=/tmp/ctxpipe-go/pkg/mod \
    GOCACHE=/tmp/ctxpipe-go/cache \
    PATH="/opt/java/openjdk/bin:/usr/local/go/bin:/usr/local/cargo/bin:/opt/dotnet-tools:/opt/pub-cache/bin:${PATH}"

ARG SCIP_PHP_VERSION=0.0.2
# v0.0.2 is scip-php's newest release and still constrains google/protobuf to
# <4.33.6, which is affected by the known CVE-2026-6409 audit. Keep PHP matrix
# coverage until upstream ships a release that can consume the fixed major.
# Gradle repositories should use their checked-in wrapper; Debian's Gradle
# 4.4 package is too old for representative modern builds.
RUN ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet \
  && ln -s /usr/share/maven/bin/mvn /usr/local/bin/mvn \
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
    scip-dotnet scip_dart scip-php debian-lsp rust-analyzer ast-grep scip \
    scip-clang scip-ruby; \
    do command -v "${binary}"; done \
  && scip-clang --version && scip-ruby --version \
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
# The RDS CA bundle (https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem),
# as in the backend image: on AWS, codesearch reads Aurora with
# sslmode=verify-full, and Aurora certificates chain to these CAs, which are
# not public roots. Bun and Node read this variable.
COPY apps/backend/certs/rds-global-bundle.pem ./apps/backend/certs/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/app/apps/backend/certs/rds-global-bundle.pem

COPY apps/codesearch/start.sh /start.sh
RUN chmod +x /start.sh

RUN mkdir -p /data/zoekt-index /data/repo-cache

EXPOSE 3001
CMD ["/start.sh"]

# ── Stage 10: Vitest (reuses the production toolchain; adds devDependencies) ──
# Build: docker build -f apps/codesearch/Dockerfile --target test -t ctxpipe-codesearch:test .
# Run:   docker run --rm ctxpipe-codesearch:test
FROM runtime AS test
ENV NODE_ENV=development
# The S3-compatible server of the shard store tests (src/test/s3Server.ts).
COPY --from=release-tools /test-out/versitygw /usr/local/bin/versitygw
RUN npm install -g pnpm@11.28.11
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.json ./
COPY patches patches
COPY apps/codesearch/package.json apps/codesearch/package.json
# The runtime stage leaves apps/backend/certs in /app. pnpm 11 refuses a frozen
# install of every importer when apps/backend exists without its package.json,
# so install only codesearch and the root (the trace code of scripts/checks).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --store-dir /pnpm/store --frozen-lockfile --filter @ctxpipe/codesearch... --filter . --config.confirmModulesPurge=false
COPY apps/codesearch ./apps/codesearch
COPY scripts/ci/check-test-report.mjs ./scripts/ci/check-test-report.mjs
# The trace and result record code (run-vitest-contracts.mjs --trace, --records).
COPY scripts/checks ./scripts/checks
COPY scripts/ci/vitest-launch.mjs ./scripts/ci/vitest-launch.mjs
WORKDIR /app/apps/codesearch
CMD ["pnpm", "run", "test:vitest"]

# Default image (no --target) must stay production; tests use --target test
FROM runtime
