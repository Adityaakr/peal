#!/bin/sh
# Entrypoint for the hosted Peal Links node (docker/Dockerfile.links).
#
# What a platform gives the container, and what this turns it into:
#   PEAL_LINKS_SIGNER_KEYS   JSON array of the settlement signer keys (the
#                            gateway's signer set). Written to a file only
#                            root can read and never logged. Required unless
#                            the config names a signer file that already exists.
#   PEAL_LINKS_CONFIG        node profile, default the hosted Sepolia profile
#                            baked into the image.
#   PEAL_LINKS_AUTH_DOMAINS  extra sign-in domains, comma separated (the
#                            platform's own hostname, for example).
#   PORT                     the port the platform routes to; the node listens
#                            on it over IPv6 and IPv4 unless PEAL_LINKS_LISTEN
#                            is set explicitly.
#   PEAL_LINKS_DATA_DIR / PEAL_LINKS_PARAMS_DIR
#                            where the stores and the proving material live;
#                            both default under one mounted volume,
#                            /var/lib/peal-links.
set -eu

: "${PEAL_LINKS_CONFIG:=/etc/peal-links/railway-sepolia.json}"
export PEAL_LINKS_CONFIG
: "${PEAL_LINKS_LISTEN:=[::]:${PORT:-8790}}"
export PEAL_LINKS_LISTEN

mkdir -p /var/lib/peal-links/data /var/lib/peal-links/params

if [ -n "${PEAL_LINKS_SIGNER_KEYS:-}" ]; then
  mkdir -p /run/peal-links
  umask 077
  printf '%s' "$PEAL_LINKS_SIGNER_KEYS" > /run/peal-links/signers.json
  umask 022
  unset PEAL_LINKS_SIGNER_KEYS
fi

exec peal-links-node --config "$PEAL_LINKS_CONFIG"
