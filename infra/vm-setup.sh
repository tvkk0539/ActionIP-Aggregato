#!/usr/bin/env bash
# setup_ip_collector.sh — Bootstrap ActionIP Aggregator on Ubuntu (GCP VM)
# This script installs dependencies, clones the ActionIP Aggregator repo,
# configures systemd, and optionally sets up Nginx + Let's Encrypt TLS.

set -euo pipefail

# =========================
# Editable configuration
# =========================
REPO_URL="https://github.com/tvkk0539/ActionIP-Aggregato.git"
APP_DIR="/opt/ip-collector"

# Environment Variables
COLLECTOR_PORT=${COLLECTOR_PORT:-3000}
COLLECTOR_TOKEN=${COLLECTOR_TOKEN:-REPLACE_WITH_STRONG_TOKEN}
HMAC_SECRET=${HMAC_SECRET:-}                # optional
RETENTION_HOURS=${RETENTION_HOURS:-24}
MAX_RUNS_PER_IP_PER_DAY=${MAX_RUNS_PER_IP_PER_DAY:-3}
MIN_GAP_HOURS_PER_IP=${MIN_GAP_HOURS_PER_IP:-7}
DOMAIN=${DOMAIN:-}                          # set domain for HTTPS
ENABLE_NGINX_TLS=${ENABLE_NGINX_TLS:-false} # true/false
DISCORD_WEBHOOK_URL=${DISCORD_WEBHOOK_URL:-} # optional discord webhook
STORAGE_TYPE="local"                        # Force local storage for VM

# =========================
# Install dependencies
# =========================
echo "[+] Updating apt packages"
sudo apt-get update -y
sudo apt-get upgrade -y

echo "[+] Installing Node.js LTS, git, jq, curl, openssl, cron"
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs git jq curl openssl cron

# Ensure cron service is running
sudo systemctl enable cron
sudo systemctl start cron

# =========================
# Deploy Application Code
# =========================
echo "[+] Setting up app directory $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
    echo "    Repo exists. Pulling latest..."
    cd "$APP_DIR"
    sudo git pull
else
    echo "    Cloning repo..."
    sudo mkdir -p "$APP_DIR"
    sudo chown $USER:$USER "$APP_DIR"
    git clone "$REPO_URL" "$APP_DIR"
    cd "$APP_DIR"
fi

echo "[+] Installing NPM dependencies"
npm install --production

# Prompt for Discord Webhook if not set
if [ -z "$DISCORD_WEBHOOK_URL" ]; then
    # Try to read from /dev/tty to handle pipe execution cases
    echo ""
    echo "----------------------------------------------------------------"
    echo " OPTIONAL: Discord Notification Setup"
    echo "----------------------------------------------------------------"
    echo "Enter your Discord Webhook URL (press Enter to skip):"

    if [ -t 0 ]; then
        read -r input_webhook
    else
        # Fallback if stdin is not a TTY (e.g. piped curl)
        # Attempt to read from /dev/tty explicitly
        if read -r input_webhook < /dev/tty; then
            :
        else
            input_webhook=""
            echo "Warning: Cannot read input. Skipping Discord setup."
        fi
    fi

    if [ -n "$input_webhook" ]; then
        DISCORD_WEBHOOK_URL="$input_webhook"
    fi
fi

# Create .env file for the app
echo "[+] Creating .env configuration"
cat > .env <<EOF
PORT=$COLLECTOR_PORT
COLLECTOR_TOKEN=$COLLECTOR_TOKEN
HMAC_SECRET=$HMAC_SECRET
DISCORD_WEBHOOK_URL=$DISCORD_WEBHOOK_URL
RETENTION_HOURS=$RETENTION_HOURS
MAX_RUNS_PER_IP_PER_DAY=$MAX_RUNS_PER_IP_PER_DAY
MIN_GAP_HOURS_PER_IP=$MIN_GAP_HOURS_PER_IP
STORAGE_TYPE=$STORAGE_TYPE
LOCAL_DATA_DIR=./data
EOF

# Ensure data directory exists
mkdir -p "$APP_DIR/data"

# =========================
# Configure Systemd Service
# =========================
echo "[+] Configuring systemd service"
# We add EnvironmentFile to ensure .env is definitely loaded by systemd
sudo bash -c "cat > /etc/systemd/system/ip-collector.service <<SERVICE
[Unit]
Description=ActionIP Aggregator Service
After=network.target

[Service]
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/npm start
Restart=always
User=root
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SERVICE"

sudo systemctl daemon-reload
sudo systemctl enable ip-collector
sudo systemctl restart ip-collector

# =========================
# Setup Hourly Cleanup (Cron)
# =========================
echo "[+] Configuring local cron for cleanup"
CRON_CMD="curl -s -X POST http://localhost:$COLLECTOR_PORT/cleanup -H 'Authorization: Bearer $COLLECTOR_TOKEN' >> $APP_DIR/cleanup.log 2>&1"
# Remove existing job if any, then add new one
(crontab -l 2>/dev/null | grep -v "ip-collector/cleanup") | crontab -
(crontab -l 2>/dev/null; echo "0 * * * * $CRON_CMD") | crontab -

# =========================
# Optional Nginx + TLS
# =========================
if [[ "${ENABLE_NGINX_TLS}" == "true" && -n "${DOMAIN}" ]]; then
  echo "[+] Installing Nginx and Certbot"
  sudo apt-get install -y nginx certbot python3-certbot-nginx

  # Nginx reverse proxy config
  sudo bash -c "cat > /etc/nginx/sites-available/ip-collector <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};
    location / {
        proxy_pass http://127.0.0.1:${COLLECTOR_PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX"

  sudo ln -sf /etc/nginx/sites-available/ip-collector /etc/nginx/sites-enabled/ip-collector
  sudo rm -f /etc/nginx/sites-enabled/default
  sudo nginx -t && sudo systemctl restart nginx

  # Obtain TLS cert
  echo "[+] Obtaining SSL Cert via Certbot..."
  sudo certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos -m "admin@${DOMAIN}" || echo "Warning: Certbot failed. Check DNS settings."
fi

# =========================
# Firewall (ufw)
# =========================
if command -v ufw >/dev/null 2>&1; then
  echo "[+] Configuring Firewall (UFW)"
  sudo ufw allow 22/tcp || true
  sudo ufw allow 80/tcp || true
  sudo ufw allow 443/tcp || true
  sudo ufw allow ${COLLECTOR_PORT}/tcp || true
  # Note: Do not enable ufw if not already enabled to avoid locking out SSH
fi

# =========================
# Summary
# =========================
PUBLIC_IP=$(curl -s ifconfig.me || echo "SERVER_IP")
echo ""
echo "=================================================="
echo " Setup Complete!"
echo " Service running on: http://$PUBLIC_IP:$COLLECTOR_PORT"
echo " Token: $COLLECTOR_TOKEN"
if [[ "${ENABLE_NGINX_TLS}" == "true" ]]; then
    echo " Domain: https://$DOMAIN"
fi
echo " Discord Webhook: ${DISCORD_WEBHOOK_URL:-Not Configured}"
echo "=================================================="
