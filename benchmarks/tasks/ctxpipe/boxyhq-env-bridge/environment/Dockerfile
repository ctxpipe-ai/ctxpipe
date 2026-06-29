FROM ubuntu:24.04

ARG SAAS_STARTER_SHA=abc9b686823cbfb4973c79bc36fea37a3244be6c

WORKDIR /app

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    python3 \
  && rm -rf /var/lib/apt/lists/*

RUN git clone --filter=blob:none https://github.com/boxyhq/saas-starter-kit.git /app/saas-starter-kit \
  && cd /app/saas-starter-kit \
  && git checkout "${SAAS_STARTER_SHA}"