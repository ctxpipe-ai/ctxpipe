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

# No repository checkout in this arm.

ENV BENCHMARK_ARM=ctxpipe
