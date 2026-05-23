#!/bin/bash
DATE=$(date +%Y-%m-%d_%H-%M)
DEST="./backups/gada_$DATE.db"
mkdir -p ./backups
cp ./gada.db "$DEST"
echo "Backed up to $DEST"
# keep last 30 backups
ls -t ./backups/gada_*.db 2>/dev/null | tail -n +31 | xargs rm -f
