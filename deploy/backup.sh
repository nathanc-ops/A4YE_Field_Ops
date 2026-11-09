#!/usr/bin/env bash
# Back up the database (safe while running) and, if set up, copy backups and photos off the server.
# Runs nightly from fieldops-backup.timer; run by hand any time:  bash /opt/fieldops/deploy/backup.sh
set -euo pipefail
APP=/opt/fieldops
set -a; . /etc/fieldops/fieldops.env; set +a

FILE=$(runuser -u fieldops -- env DB_PATH="$DB_PATH" BACKUP_KEEP="${BACKUP_KEEP:-30}" node --no-warnings "$APP/scripts/backup.js" "$BACKUP_DIR")
echo "Database backed up: $FILE ($(du -h "$FILE" | cut -f1))"

if [ -n "${OFFSITE:-}" ]; then
  # database copies: keep every one off-site; photos: add new ones, never delete
  rclone copy "$BACKUP_DIR" "$OFFSITE/database" --max-age 3d
  rclone copy "$UPLOAD_DIR" "$OFFSITE/uploads"
  echo "Copied off-site to $OFFSITE"
else
  echo "WARNING: no off-site copy (OFFSITE is blank in /etc/fieldops/fieldops.env). If this server is lost, so are these backups."
fi
