FROM ubuntu:24.04

WORKDIR /app

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates \
      python3 \
      python3-pip && \
    rm -rf /var/lib/apt/lists/*

# Install rewardkit at image build time (avoids verifier depending on live PyPI).
RUN python3 -m pip install --no-cache-dir --break-system-packages uv && \
    uv pip install --system --break-system-packages 'harbor-rewardkit==0.1.*'

# No repository checkout — agents must use hosted ctxpipe MCP for org context.
RUN printf '%s\n' \
  '# Grafana CODEOWNERS discovery (ctxpipe arm)' \
  '' \
  'This workspace has no ingested repository files on disk.' \
  'Use the ctxpipe MCP server configured for your trial to read org code context for grafana/grafana.' \
  > /app/README.md

ENV BENCHMARK_ARM=ctxpipe
