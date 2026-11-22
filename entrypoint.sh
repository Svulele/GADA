#!/bin/sh
set -e
umask 077

mkdir -p /data

# --- Database: seed once, then always use the copy on the volume ---
if [ ! -f /data/gada.db ]; then
  if [ -f /app/gada.db ]; then
    cp /app/gada.db /data/gada.db
  else
    touch /data/gada.db
  fi
fi
rm -f /app/gada.db
ln -s /data/gada.db /app/gada.db

# --- config.json: seed once, then always use the private copy on the volume ---
if [ ! -f /data/config.json ]; then
  if [ -f /app/config.json ]; then
    cp /app/config.json /data/config.json
  elif [ -n "$CONFIG_JSON" ]; then
    printf '%s\n' "$CONFIG_JSON" > /data/config.json
  else
    echo "FATAL: Missing private config. Provide /data/config.json or set CONFIG_JSON with non-demo accounts for first boot." >&2
    exit 1
  fi
fi
chmod 600 /data/config.json
chmod 600 /data/gada.db
rm -f /app/config.json
ln -s /data/config.json /app/config.json

export CONFIG_JSON_PATH=/data/config.json

exec "$@"
