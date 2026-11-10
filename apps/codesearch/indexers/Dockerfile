# Builds scip-clang and scip-ruby from their pinned upstream commits for the
# platform of the build (linux/amd64 or linux/arm64).
#
# Upstream publishes these binaries only for x86_64 Linux, and those binaries
# need GLIBC 2.38. The codesearch runtime is Debian Bookworm (GLIBC 2.36).
# Thus this file compiles both indexers on Bookworm, and the verify stage
# fails when a binary needs a GLIBC version above 2.36.
#
# The workflow .github/workflows/indexer-binaries.yaml runs this file and
# publishes the binaries to a GitHub release. After a release, pin the new
# files by checksum in apps/codesearch/release-assets.txt. Local run, from the
# repository root:
#
#   docker buildx build -f apps/codesearch/indexers/Dockerfile \
#     --target binaries --output type=local,dest=out .
#
# Bazel keeps its output base, disk cache and repository cache in BuildKit
# cache mounts. A second build of the same revision takes some seconds.

# ── Toolchain ───────────────────────────────────────────────────────────────
# debian:bookworm-slim
FROM debian@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3 AS toolchain
ARG TARGETARCH
# Bazel downloads the LLVM toolchain of each project. The toolchain compiles
# against the headers and the GLIBC of this image. The upstream release
# runners have libxml2 (for ld.lld of LLVM 21) and the zlib headers (for
# LLVM Support in scip-clang); this slim image needs them explicitly.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    git \
    libtinfo5 \
    libxml2 \
    patch \
    python3 \
    unzip \
    xz-utils \
    zip \
    zlib1g-dev \
  && rm -rf /var/lib/apt/lists/*
# Each project pins its Bazel version in .bazelversion.
RUN set -eu; \
  case "${TARGETARCH}" in \
    amd64) arch=x86_64; \
      sha_7=b774f62102de61f2889784cbe46451b098d22f1553fe366ed0f251602332fa84; \
      sha_6=a40ac69263440761199fcb8da47ad4e3f328cbe79ffbf4ecc14e5ba252857307 ;; \
    arm64) arch=arm64; \
      sha_7=7add3844b05e252ed9cf33f59ea5f9293267f34588ae3276a701cf4b21171fce; \
      sha_6=5afe973cadc036496cac66f1414ca9be36881423f576db363d83afc9084c0c2f ;; \
    *) echo "Unsupported TARGETARCH ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  for pair in "7.5.0 ${sha_7}" "6.5.0 ${sha_6}"; do \
    set -- ${pair}; \
    curl -fsSL --retry 3 -o "/usr/local/bin/bazel-$1" \
      "https://github.com/bazelbuild/bazel/releases/download/$1/bazel-$1-linux-${arch}"; \
    echo "$2  /usr/local/bin/bazel-$1" | sha256sum -c -; \
    chmod +x "/usr/local/bin/bazel-$1"; \
  done
# rules_python refuses to run as root.
RUN useradd --create-home --uid 1000 builder && mkdir /out && chown builder /out
USER builder
WORKDIR /home/builder

# ── scip-clang ──────────────────────────────────────────────────────────────
FROM toolchain AS scip-clang
ARG TARGETARCH
# Tag v0.4.0.
RUN git init -q src && cd src \
  && git fetch -q --depth 1 https://github.com/sourcegraph/scip-clang.git 1860adf8deab7870fed2199eadc190e3965a92ff \
  && git checkout -q FETCH_HEAD
WORKDIR /home/builder/src
RUN --mount=type=cache,id=bazel-scip-clang-${TARGETARCH},target=/home/builder/.cache/bazel,uid=1000,gid=1000 \
  test "$(cat .bazelversion)" = 7.5.0 \
  && start="$(date +%s)" \
  && bazel-7.5.0 build //indexer:scip-clang --config=release-linux \
    --curses=no --show_progress_rate_limit=60 \
    --disk_cache=/home/builder/.cache/bazel/disk \
    --repository_cache=/home/builder/.cache/bazel/repos \
  && cp bazel-bin/indexer/scip-clang /out/scip-clang \
  && echo "scip-clang ${TARGETARCH} build: $(( $(date +%s) - start )) s"

# ── scip-ruby ───────────────────────────────────────────────────────────────
FROM toolchain AS scip-ruby
ARG TARGETARCH
# Tag scip-ruby-v0.4.7.
RUN git init -q src && cd src \
  && git fetch -q --depth 1 https://github.com/sourcegraph/scip-ruby.git 319524058d87cfe5992cfb9eec12ec70fc91213d \
  && git checkout -q FETCH_HEAD
WORKDIR /home/builder/src
RUN --mount=type=cache,id=bazel-scip-ruby-${TARGETARCH},target=/home/builder/.cache/bazel,uid=1000,gid=1000 \
  test "$(cat .bazelversion)" = 6.5.0 \
  && case "${TARGETARCH}" in amd64) config=release-linux ;; arm64) config=release-linux-aarch64 ;; esac \
  && start="$(date +%s)" \
  && bazel-6.5.0 build //main:scip-ruby --config="${config}" \
    --curses=no --show_progress_rate_limit=60 \
    --disk_cache=/home/builder/.cache/bazel/disk \
    --repository_cache=/home/builder/.cache/bazel/repos \
  && cp bazel-bin/main/scip-ruby /out/scip-ruby \
  && echo "scip-ruby ${TARGETARCH} build: $(( $(date +%s) - start )) s"

# ── Verify on the codesearch runtime OS ─────────────────────────────────────
# debian:bookworm-slim
FROM debian@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3 AS verify
RUN apt-get update && apt-get install -y --no-install-recommends \
    binutils \
    clang \
    g++ \
  && rm -rf /var/lib/apt/lists/*
COPY --from=scip-clang /out/scip-clang /usr/local/bin/scip-clang
COPY --from=scip-ruby /out/scip-ruby /usr/local/bin/scip-ruby
COPY apps/codesearch/test/fixtures/scip-cpp /fixtures/cpp
COPY apps/codesearch/test/fixtures/scip-ruby /fixtures/ruby
# The highest GLIBC symbol version of each binary must be 2.36 or less.
RUN set -eu; \
  for binary in scip-clang scip-ruby; do \
    newest="$(objdump -T "/usr/local/bin/${binary}" | grep -o 'GLIBC_[0-9.]*' | sed 's/GLIBC_//' | sort -Vu | tail -n 1)"; \
    echo "${binary} needs GLIBC ${newest}"; \
    test -n "${newest}"; \
    test "$(printf '%s\n2.36\n' "${newest}" | sort -V | tail -n 1)" = 2.36; \
  done
# Index each fixture and look for the symbol of its greet method in the SCIP
# output.
RUN set -eu; \
  cd /fixtures/cpp; \
  printf '[%s,\n%s]\n' \
    '{"directory": "/fixtures/cpp", "file": "src/greeter.cpp", "arguments": ["clang++", "-std=c++17", "-c", "src/greeter.cpp", "-o", "/tmp/greeter.o"]}' \
    '{"directory": "/fixtures/cpp", "file": "src/main.cpp", "arguments": ["clang++", "-std=c++17", "-c", "src/main.cpp", "-o", "/tmp/main.o"]}' \
    > compile_commands.json; \
  scip-clang --compdb-path=compile_commands.json --index-output-path=/tmp/cpp.scip; \
  grep -aq 'fixture/Greeter#greet(' /tmp/cpp.scip; \
  cd /fixtures/ruby; \
  scip-ruby --index-file /tmp/ruby.scip; \
  grep -aq 'Fixture#Greeter#greet()' /tmp/ruby.scip; \
  scip-clang --version; scip-ruby --version

# ── Output: docker buildx build --target binaries --output type=local ───────
FROM scratch AS binaries
COPY --from=verify /usr/local/bin/scip-clang /usr/local/bin/scip-ruby /
