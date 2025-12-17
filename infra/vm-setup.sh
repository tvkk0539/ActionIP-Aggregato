#!/bin/bash
set -e

# --- VM Setup Script for ActionIP Aggregator ---
# Usage:
#   1. Copy this script to the VM.
#   2. Run: ./vm-setup.sh
#
# Requirements: Ubuntu 20.04/22.04

# --- Configuration ---
APP_DIR="/opt/ip-collector"
REPO_URL="https://github.com/tvkk0539/ActionIP-Aggregato.git" # Replace if private
BRANCH="main"
USER="ubuntu" # Default GCP user. Change if needed.

# --- Prompts ---
read -p "Enter COLLECTOR_TOKEN (secret): " COLLECTOR_TOKEN
read -p "Enter PORT (default 3000): " PORT
PORT=${PORT:-3000}

echo "Updating system..."
sudo apt-get update && sudo apt-get -y upgrade

echo "Installing dependencies..."
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs git jq curl openssl

echo "Setting up Application Directory at $APP_DIR..."
if [ -d "$APP_DIR" ]; then
    echo "Directory exists. Pulling latest..."
    cd "$APP_DIR"
    sudo git pull
else
    sudo mkdir -p "$APP_DIR"
    sudo chown $USER:$USER "$APP_DIR"
    git clone "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"
# Ensure we are on the right branch/version
# git checkout $BRANCH

echo "Installing Node dependencies..."
npm install

echo "Creating .env file..."
cat > .env <<EOF
PORT=$PORT
COLLECTOR_TOKEN=$COLLECTOR_TOKEN
STORAGE_TYPE=local
LOCAL_DATA_DIR=./data
MAX_RUNS_PER_IP_PER_DAY=3
MIN_GAP_HOURS_PER_IP=7
RETENTION_HOURS=24
EOF

echo "Setting up Systemd Service..."
SERVICE_FILE="/etc/systemd/system/ip-collector.service"
sudo bash -c "cat > $SERVICE_FILE" <<EOF
[Unit]
Description=ActionIP Aggregator Service
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/npm start
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable ip-collector
sudo systemctl restart ip-collector

echo "Setting up Local Cron Job for Cleanup (Hourly)..."
# We add a cron job to call the /cleanup endpoint locally
CRON_CMD="curl -s -X POST http://localhost:$PORT/cleanup -H 'Authorization: Bearer $COLLECTOR_TOKEN' >> $APP_DIR/cleanup.log 2>&1"
(crontab -l 2>/dev/null; echo "0 * * * * $CRON_CMD") | crontab -

echo "=========================================="
echo " Setup Complete!"
echo " Service is running on port $PORT"
echo " Local Data stored in: $APP_DIR/data"
echo " View logs: sudo journalctl -u ip-collector -f"
echo "=========================================="
