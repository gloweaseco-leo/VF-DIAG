#!/bin/sh
set -eu
if [ "${VFDIAG_EGRESS_FILTER:-}" = "1" ]; then
  /usr/local/bin/vfdiag-egress
fi
mkdir -p "${VFDIAG_DATA_DIR:-/var/lib/vfdiag}"
chown -R node:node "${VFDIAG_DATA_DIR:-/var/lib/vfdiag}"
exec setpriv --reuid=node --regid=node --init-groups -- "$@"
