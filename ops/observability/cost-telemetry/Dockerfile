FROM oven/bun:1-alpine

# Blacksmith CLI v0.4.61: the binary of the build platform from the documented
# clireleases channel (https://get.blacksmith.sh uses BLACKSMITH_CHANNEL;
# versioned channels are vX.Y.Z). The Deploy workflow builds linux/amd64 and
# linux/arm64; the Fargate task runs linux/arm64.
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) sum=011ca8f0c5dab2f0f128801f20d8c82a58f002a19c8f2b0393cc4b4dcc42ee0c ;; \
      arm64) sum=4c162fa3dc27f5bfaea7f3ab680d7a7268d8a5ea091bb074c5a238165cd82c4c ;; \
      *) echo "no Blacksmith CLI for $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && wget -qO /usr/local/bin/blacksmith "https://clireleases.blacksmith.sh/cli/v0.4.61/linux/$TARGETARCH/blacksmith" \
 && echo "$sum  /usr/local/bin/blacksmith" | sha256sum -c \
 && chmod 755 /usr/local/bin/blacksmith
ENV BLACKSMITH_DISABLE_AUTO_UPDATE=1

WORKDIR /app

COPY package.json ./
RUN bun install --production
COPY src ./src

USER bun

CMD ["bun", "src/index.ts"]
