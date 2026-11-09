#!/usr/bin/env bash
# Put a database backup back in place.
#   bash /opt/fieldops/deploy/restore.sh                 # lists backups
#   bash /opt/fieldops/deploy/restore.sh <backup file>   # restores it
# The current database is kept as fieldops.db.before-restore-<time>, so a restore can itself be undone.
set -euo pipefail
set -a; . /etc/fieldops/fieldops.env; set +a

if [ $# -eq 0 ]; then
  echo "Backups in $BACKUP_DIR (newest first):"; ls -1t "$BACKUP_DIR" | sed 's/^/  /'
  echo; echo "Restore one with:  bash $0 $BACKUP_DIR/<file>"; exit 0
fi
SRC=$1
[ -f "$SRC" ] || { echo "No such file: $SRC" >&2; exit 1; }
[ "$(sqlite3 "$SRC" 'PRAGMA integrity_check;')" = ok ] || { echo "$SRC is damaged; pick another." >&2; exit 1; }
read -r -p "Replace the live database with $(basename "$SRC")? Everything entered since then will be gone. [y/N] " a
[ "$a" = y ] || [ "$a" = Y ] || exit 1

systemctl stop fieldops
KEEP="$DB_PATH.before-restore-$(date +%Y%m%d-%H%M)"
[ -f "$DB_PATH" ] && mv "$DB_PATH" "$KEEP" && echo "Current database kept as $KEEP"
rm -f "$DB_PATH-journal" "$DB_PATH-wal" "$DB_PATH-shm"
cp "$SRC" "$DB_PATH" && chown fieldops:fieldops "$DB_PATH" && chmod 640 "$DB_PATH"
systemctl start fieldops
echo "Restored. Photos are not part of the database backup and were left as they are."
