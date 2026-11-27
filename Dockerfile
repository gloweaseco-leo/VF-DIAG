FROM node:24-bookworm-slim

# The glibc release needs glibc 2.38+. Debian bookworm has 2.36, so the image uses the musl build.
ARG SITEONE_VERSION=2.5.1
ARG SITEONE_TARBALL_SHA256=bd96b9502563aea2581fc248625871e69b60d7f1bb68a484f226c551c73706fd

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && curl -fsSL -o /tmp/siteone.tar.gz "https://github.com/janreges/siteone-crawler/releases/download/v${SITEONE_VERSION}/siteone-crawler-v${SITEONE_VERSION}-linux-musl-x64.tar.gz" \
  && echo "${SITEONE_TARBALL_SHA256}  /tmp/siteone.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/siteone.tar.gz -C /tmp \
  && install -m 0755 /tmp/siteone-crawler/siteone-crawler /usr/local/bin/siteone-crawler \
  && rm -rf /tmp/siteone.tar.gz /tmp/siteone-crawler \
  && apt-get purge -y curl \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/* \
  && printf '%s\n' \
    '#!/bin/sh' \
    'set -eu' \
    'mkdir -p "${VFDIAG_DATA_DIR:-/var/lib/vfdiag}"' \
    'chown -R node:node "${VFDIAG_DATA_DIR:-/var/lib/vfdiag}"' \
    'exec setpriv --reuid=node --regid=node --init-groups -- "$@"' \
    > /usr/local/bin/vfdiag-entrypoint \
  && chmod 755 /usr/local/bin/vfdiag-entrypoint

RUN apt-get update \
  && apt-get install -y --no-install-recommends iptables \
  && rm -rf /var/lib/apt/lists/*

RUN printf 'Acquire::Retries "8";\nAcquire::http::Timeout "60";\n' > /etc/apt/apt.conf.d/80-retries \
  && apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-noto-cjk fontconfig \
  && rm -rf /var/lib/apt/lists/*

COPY docker/vfdiag-egress.sh /usr/local/bin/vfdiag-egress
COPY docker/entrypoint.sh /usr/local/bin/vfdiag-entrypoint
RUN chmod 755 /usr/local/bin/vfdiag-egress /usr/local/bin/vfdiag-entrypoint

WORKDIR /app
COPY package.json ./
COPY contracts ./contracts
COPY fixtures ./fixtures
COPY src ./src

ENV NODE_ENV=production \
    VFDIAG_BIND=0.0.0.0 \
    VFDIAG_PORT=8787 \
    VFDIAG_DATA_DIR=/var/lib/vfdiag \
    SITEONE_BIN=/usr/local/bin/siteone-crawler \
    SITEONE_VERSION=2.5.1 \
    VFDIAG_CHROMIUM=/usr/bin/chromium

EXPOSE 8787
ENTRYPOINT ["vfdiag-entrypoint"]
CMD ["node", "src/server.ts"]
