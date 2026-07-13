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
# This file holds user PINs — we deliberately never bake a real one into
# the image. See config.json.example for the format to copy in via
# `fly ssh console` the first time you deploy.
if [ ! -f /data/config.json ]; then
  if [ -f /app/config.json ]; then
    cp /app/config.json /data/config.json
  fi
fi
if [ -f /data/config.json ]; then
  rm -f /app/config.json
  ln -s /data/config.json /app/config.json
fi

exec "$@"
