# Headless herdr 0.9.5 on Linux for probe.sh; the plugin and the probe come in through a read-only mount of the repository.
FROM debian:trixie-20261020-slim

ARG HERDR_VERSION=0.9.5
ARG HERDR_SHA256=14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d

# jq and procps serve probe.sh only; the plugin scripts need nothing beyond the base image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl jq procps \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /usr/local/bin/herdr "https://github.com/herdrdev/herdr/releases/download/v${HERDR_VERSION}/herdr-linux-x86_64" \
 && echo "${HERDR_SHA256}  /usr/local/bin/herdr" | sha256sum -c - \
 && chmod 755 /usr/local/bin/herdr

RUN useradd --create-home --shell /bin/bash probe
USER probe
WORKDIR /home/probe
ENV TERM=xterm-256color
