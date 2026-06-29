FROM ubuntu:24.04

ARG LOKI_REPO_SHA=ac76b402773c77bec17545c1297e786933d3e0ab

WORKDIR /app

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
      python3 \
      python3-pip && \
    rm -rf /var/lib/apt/lists/*

# Install uv so verifier can run rewardkit via uvx.
RUN python3 -m pip install --no-cache-dir --break-system-packages uv

RUN git clone --filter=blob:none --no-checkout https://github.com/grafana/loki /tmp/loki && \
    cd /tmp/loki && \
    git checkout "${LOKI_REPO_SHA}" && \
    git sparse-checkout init --no-cone && \
    git sparse-checkout set .gitignore README.md pkg/storage/factory.go && \
    cp -R . /app/ && \
    cd / && rm -rf /tmp/loki /app/.git

ENV BENCHMARK_ARM=baseline
