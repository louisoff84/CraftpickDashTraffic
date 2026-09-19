#!/bin/bash
set -euo pipefail

APP_DIR="/var/www/craftpick-trafic-dashboard"
REPO="https://github.com/louisoff84/CraftpickDashTraffic.git"
BRANCH="main"

apt-get update
apt-get install -y curl ca-certificates openssl git tcpdump iproute2 procps

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

mkdir -p "$APP_DIR/data"

if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR"
  git fetch origin "$BRANCH"
  git reset --hard "origin/$BRANCH"
else
  tmp="$(mktemp -d)"
  git clone --branch "$BRANCH" --depth 1 "$REPO" "$tmp/app"
  cp -a "$tmp/app/." "$APP_DIR/"
  rm -rf "$tmp"
fi

if [ ! -f "$APP_DIR/.env" ]; then
  cat > "$APP_DIR/.env" <<EOF
API_KEY=$(openssl rand -hex 32)
HOST=0.0.0.0
PORT=8787
INTERFACE=any
HISTORY_HOURS=24
MAX_SOURCES=10000
MAX_DESTINATIONS=10000
MAX_FLOWS=20000
MAX_PORTS=1000
EOF
  chmod 600 "$APP_DIR/.env"
fi

cd "$APP_DIR"
npm install --omit=dev

cat > /etc/systemd/system/craftpick-traffic.service <<EOF
[Unit]
Description=Craftpick Traffic Monitor V2
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node $APP_DIR/server.js
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

cp "$APP_DIR/craftpick-traffic-update.service" /etc/systemd/system/craftpick-traffic-update.service
cp "$APP_DIR/craftpick-traffic-update.timer" /etc/systemd/system/craftpick-traffic-update.timer
chmod +x "$APP_DIR/update.sh"

systemctl daemon-reload
systemctl enable --now craftpick-traffic.service
systemctl enable --now craftpick-traffic-update.timer

echo
echo "=========================================="
echo " Craftpick Traffic Monitor installed"
echo "=========================================="
echo "API: http://0.0.0.0:8787"
echo "Auto-update: every 5 minutes"
echo
grep '^API_KEY=' "$APP_DIR/.env"
