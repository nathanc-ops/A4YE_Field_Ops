#!/usr/bin/env bash
# One-time setup of A4YE Field Ops on a fresh Ubuntu 24.04 server (DigitalOcean droplet).
# Run as root:   bash setup.sh
# Safe to run again: it skips what's already done and never touches existing data.
#
# Optional settings (put before the command, e.g.  DOMAIN=ops.example.com bash setup.sh):
#   DOMAIN  web address               (default ops.all4youelectrical.com)
#   REPO    GitHub repository         (default nathanc-ops/A4YE_Field_Ops)
#   BRANCH  branch to run             (default claude/electrical-contractor-platform-1ne6m0)
set -euo pipefail

DOMAIN="${DOMAIN:-ops.all4youelectrical.com}"
REPO="${REPO:-nathanc-ops/A4YE_Field_Ops}"
BRANCH="${BRANCH:-claude/electrical-contractor-platform-1ne6m0}"
APP=/opt/fieldops
DATA=/var/lib/fieldops
ENVF=/etc/fieldops/fieldops.env
KEY=/root/.ssh/fieldops_deploy

say() { printf '\n\033[1;31m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Run this as root (log in as root, or use: sudo bash setup.sh)"
grep -q 'Ubuntu' /etc/os-release || die "This script is written for Ubuntu 24.04"
export DEBIAN_FRONTEND=noninteractive

say "Installing system packages"
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg git ufw unattended-upgrades sqlite3 rclone \
  debian-keyring debian-archive-keyring apt-transport-https
# security updates install themselves
echo 'APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";' > /etc/apt/apt.conf.d/20auto-upgrades

if ! command -v node >/dev/null || ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  say "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi
echo "Node $(node -v)"

if ! command -v caddy >/dev/null; then
  say "Installing Caddy (HTTPS)"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -y -q caddy
fi

# small droplets need swap so npm doesn't run out of memory
if ! swapon --show | grep -q .; then
  say "Adding 1 GB swap"
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

say "Creating the app user and data folders"
id fieldops >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin fieldops
mkdir -p "$DATA/uploads" "$DATA/backups" /etc/fieldops
chown -R fieldops:fieldops "$DATA" && chmod 750 "$DATA"

if [ ! -d "$APP/.git" ]; then
  say "Downloading the program from GitHub"
  if ! git clone -q --branch "$BRANCH" "https://github.com/$REPO.git" "$APP" 2>/dev/null; then
    # private repository: use a read-only deploy key
    mkdir -p /root/.ssh && chmod 700 /root/.ssh
    [ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N '' -C "fieldops@$(hostname)" -f "$KEY"
    ssh-keyscan -q github.com >> /root/.ssh/known_hosts 2>/dev/null
    echo
    echo "The repository is private. Give this server read-only access:"
    echo "  1. Open https://github.com/$REPO/settings/keys/new"
    echo "  2. Title: DigitalOcean server   Key: paste the line below   (leave 'Allow write access' unticked)"
    echo
    cat "$KEY.pub"
    echo
    read -r -p "Press Enter once the key is saved on GitHub... " _
    GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes" git clone -q --branch "$BRANCH" "git@github.com:$REPO.git" "$APP" \
      || die "Still can't download. Check the deploy key on GitHub and run this script again."
    git -C "$APP" config core.sshCommand "ssh -i $KEY -o IdentitiesOnly=yes"
  fi
fi
git -C "$APP" config --global --add safe.directory "$APP" 2>/dev/null || true

say "Installing the program's packages"
(cd "$APP" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
chmod +x "$APP"/deploy/*.sh

if [ ! -f "$ENVF" ]; then
  say "Writing settings to $ENVF"
  cat > "$ENVF" <<EOF
# A4YE Field Ops settings. After editing:  systemctl restart fieldops
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
DB_PATH=$DATA/fieldops.db
UPLOAD_DIR=$DATA/uploads
BACKUP_DIR=$DATA/backups
BACKUP_KEEP=30
PUBLIC_URL=https://$DOMAIN

# Off-site backup folder (an rclone remote named "offsite", see docs/DEPLOY.md), e.g. offsite:a4ye-backups
OFFSITE=

# Email: set it up in the app (Settings -> Email) and press "Send test email".
# These lines are only needed to manage it here instead; when set they take priority over Settings.
# DigitalOcean often blocks ports 25/465/587, so use a sending service on port 2525 (see docs/DEPLOY.md).
#SMTP_HOST=smtp.postmarkapp.com
#SMTP_PORT=2525
#SMTP_USER=
#SMTP_PASS=
#SMTP_FROM=All 4 You Electrical <office@yourdomain.com>
EOF
fi
chown root:fieldops "$ENVF" && chmod 640 "$ENVF"

say "Starting the app"
cp "$APP/deploy/fieldops.service" "$APP/deploy/fieldops-backup.service" "$APP/deploy/fieldops-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable -q --now fieldops fieldops-backup.timer
systemctl restart fieldops

say "Setting up HTTPS for $DOMAIN"
sed "s/DOMAIN_NAME/$DOMAIN/" "$APP/deploy/Caddyfile" > /etc/caddy/Caddyfile
systemctl reload caddy 2>/dev/null || systemctl restart caddy

say "Turning on the firewall (SSH, HTTP, HTTPS only)"
ufw allow OpenSSH >/dev/null && ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ufw --force enable >/dev/null

for _ in $(seq 1 20); do curl -fs http://127.0.0.1:3000/healthz >/dev/null && break; sleep 1; done
curl -fs http://127.0.0.1:3000/healthz >/dev/null || die "The app didn't start. See: journalctl -u fieldops -n 50"

IP=$(curl -fs --max-time 3 http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address || curl -fs --max-time 5 https://api.ipify.org || echo '?')
DNS=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}')
echo
echo "------------------------------------------------------------------"
echo " A4YE Field Ops is running."
echo "   Server IP:  $IP"
if [ "$DNS" = "$IP" ]; then
  echo "   Open:       https://$DOMAIN   (first visit asks you to create the owner account)"
else
  echo "   DNS:        $DOMAIN points to '${DNS:-nothing}', not $IP."
  echo "               Add an A record:  ops  ->  $IP  at your domain's DNS host."
  echo "               HTTPS starts by itself within a few minutes once it points here."
fi
echo "   Settings:   nano $ENVF   then: systemctl restart fieldops"
echo "   Update:     bash $APP/deploy/update.sh"
echo "   Backups:    nightly to $DATA/backups  (run now: bash $APP/deploy/backup.sh)"
echo "------------------------------------------------------------------"
