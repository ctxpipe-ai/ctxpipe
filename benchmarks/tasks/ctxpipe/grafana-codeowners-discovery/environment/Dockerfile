FROM ubuntu:24.04

ARG GRAFANA_REPO_SHA=26d36ec

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

RUN git clone --filter=blob:none --no-checkout https://github.com/grafana/grafana /tmp/grafana && \
    cd /tmp/grafana && \
    git checkout "${GRAFANA_REPO_SHA}" && \
    git sparse-checkout init --no-cone && \
    git sparse-checkout set .github scripts pkg/services/featuremgmt /package.json && \
    cp -R . /app/ && \
    cd / && rm -rf /tmp/grafana /app/.git

ENV BENCHMARK_ARM=baseline
