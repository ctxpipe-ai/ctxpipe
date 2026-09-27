FROM oven/bun:1-alpine

# Blacksmith CLI v0.4.61 — direct linux/amd64 binary from the documented
# clireleases channel (https://get.blacksmith.sh uses BLACKSMITH_CHANNEL;
# versioned channels are vX.Y.Z).
ADD https://clireleases.blacksmith.sh/cli/v0.4.61/linux/amd64/blacksmith /usr/local/bin/blacksmith
RUN echo "011ca8f0c5dab2f0f128801f20d8c82a58f002a19c8f2b0393cc4b4dcc42ee0c  /usr/local/bin/blacksmith" | sha256sum -c \
 && chmod 755 /usr/local/bin/blacksmith
ENV BLACKSMITH_DISABLE_AUTO_UPDATE=1

WORKDIR /app

COPY package.json ./
RUN bun install --production
COPY src ./src

USER bun

CMD ["bun", "src/index.ts"]
