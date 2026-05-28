FROM ubuntu:24.04

ARG PRIMARY_REPO_SHA=abc9b686823cbfb4973c79bc36fea37a3244be6c

WORKDIR /app

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      jq \
      python3 \
      python3-pip \
      unzip && \
    rm -rf /var/lib/apt/lists/*

# Install uv so verifier can run rewardkit via uvx.
RUN python3 -m pip install --no-cache-dir --break-system-packages uv

RUN git clone https://github.com/boxyhq/saas-starter-kit /tmp/saas-starter-kit && \
    cd /tmp/saas-starter-kit && \
    git checkout "${PRIMARY_REPO_SHA}" && \
    rm -rf /app/.git && \
    cp -R . /app/ && \
    cd / && rm -rf /tmp/saas-starter-kit
