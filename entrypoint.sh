#!/bin/sh
set -e

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

# --- config.json: seed once, then always use the copy on the volume ---
# This file holds user PINs. Seed a private config when available, otherwise
# use the safe demo config so first boot still has login accounts.
if [ ! -f /data/config.json ]; then
  if [ -f /app/config.json ]; then
    cp /app/config.json /data/config.json
  elif [ -n "$CONFIG_JSON" ]; then
    printf '%s\n' "$CONFIG_JSON" > /data/config.json
  elif [ -f /app/config.example.json ]; then
    cp /app/config.example.json /data/config.json
  else
    echo "FATAL: Missing config. Provide /data/config.json, include /app/config.example.json in the image, or set CONFIG_JSON for first boot." >&2
    exit 1
  fi
fi
rm -f /app/config.json
ln -s /data/config.json /app/config.json

export CONFIG_JSON_PATH=/data/config.json

exec "$@"
