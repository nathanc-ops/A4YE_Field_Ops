#!/usr/bin/env bash
# Update A4YE Field Ops to the latest version on GitHub.
#   bash /opt/fieldops/deploy/update.sh
# Backs up first; if the new version doesn't start, puts the previous version back.
set -euo pipefail
APP=/opt/fieldops
cd "$APP"
BRANCH=$(git rev-parse --abbrev-ref HEAD)
PREV=$(git rev-parse HEAD)

echo "Backing up first..."
bash "$APP/deploy/backup.sh"

git fetch -q origin "$BRANCH"
if [ "$(git rev-parse "origin/$BRANCH")" = "$PREV" ]; then echo "Already up to date."; exit 0; fi
echo "Changes:"; git log --oneline "$PREV..origin/$BRANCH" | sed 's/^/  /'

install_and_restart() {
  npm ci --omit=dev --no-audit --no-fund --loglevel=error
  chmod +x "$APP"/deploy/*.sh
  cp deploy/fieldops.service deploy/fieldops-backup.service deploy/fieldops-backup.timer /etc/systemd/system/
  systemctl daemon-reload
  systemctl restart fieldops
  for _ in $(seq 1 30); do curl -fs http://127.0.0.1:3000/healthz >/dev/null && return 0; sleep 1; done
  return 1
}

git reset -q --hard "origin/$BRANCH"
if install_and_restart; then
  echo "Updated to $(git log -1 --format='%h %s')."
else
  echo "The new version did not start. Putting the previous version back..." >&2
  journalctl -u fieldops -n 30 --no-pager >&2 || true
  git reset -q --hard "$PREV"
  install_and_restart && echo "Previous version is running again. Nothing was lost." >&2
  exit 1
fi
