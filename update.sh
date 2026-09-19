#!/bin/bash
set -euo pipefail

APP_DIR="/var/www/craftpick-trafic-dashboard"
SERVICE="craftpick-traffic.service"
BRANCH="main"
LOG="/var/log/craftpick-traffic-update.log"

exec >>"$LOG" 2>&1

echo "===== $(date -Is) ====="

cd "$APP_DIR"

if [ ! -d .git ]; then
  echo "ERROR: $APP_DIR is not a git repository"
  exit 1
fi

git fetch --prune origin "$BRANCH"

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "Already up to date: $LOCAL"
  exit 0
fi

OLD="$LOCAL"
BACKUP_BRANCH="craftpick-auto-update-backup-$(date +%s)"

git branch "$BACKUP_BRANCH" "$OLD"
git reset --hard "origin/$BRANCH"

if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

systemctl restart "$SERVICE"
sleep 3

if ! curl -fsS http://127.0.0.1:8787/health >/dev/null; then
  echo "ERROR: health check failed, rolling back to $OLD"

  systemctl stop "$SERVICE" || true
  git reset --hard "$OLD"

  if [ -f package-lock.json ]; then
    npm ci --omit=dev || true
  else
    npm install --omit=dev || true
  fi

  systemctl start "$SERVICE"
  git branch -D "$BACKUP_BRANCH" || true
  exit 1
fi

git branch -D "$BACKUP_BRANCH" || true

echo "Updated successfully: $OLD -> $REMOTE"
