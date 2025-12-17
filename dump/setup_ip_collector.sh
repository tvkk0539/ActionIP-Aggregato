
#!/usr/bin/env bash
# setup_ip_collector.sh — Bootstrap ActionIP Aggregator on Ubuntu (GCP VM)
# This script installs dependencies, scaffolds a minimal Node.js collector, configures systemd,
# and optionally sets up Nginx + Let's Encrypt TLS.

set -euo pipefail

# =========================
# Editable configuration
# =========================
COLLECTOR_PORT=${COLLECTOR_PORT:-3000}
COLLECTOR_TOKEN=${COLLECTOR_TOKEN:-REPLACE_WITH_STRONG_TOKEN}
HMAC_SECRET=${HMAC_SECRET:-}                # optional, leave empty to disable
RETENTION_HOURS=${RETENTION_HOURS:-24}      # hour-level retention (approx delete by days)
MAX_RUNS_PER_IP_PER_DAY=${MAX_RUNS_PER_IP_PER_DAY:-3}
MIN_GAP_HOURS_PER_IP=${MIN_GAP_HOURS_PER_IP:-7}
DOMAIN=${DOMAIN:-}                          # set your domain if you want HTTPS via Nginx/Certbot
ENABLE_NGINX_TLS=${ENABLE_NGINX_TLS:-false} # true/false

# =========================
# Install dependencies
# =========================
echo "[+] Updating apt packages"
sudo apt-get update -y
sudo apt-get upgrade -y

echo "[+] Installing Node.js LTS, git, jq, curl, openssl"
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs git jq curl openssl

echo "[+] Creating app directory /opt/ip-collector"
sudo mkdir -p /opt/ip-collector
sudo chown $USER:$USER /opt/ip-collector
cd /opt/ip-collector

# =========================
# Create minimal server if none exists
# =========================
if [[ ! -f server.js ]]; then
  echo "[+] Writing server.js"
  cat > server.js <<'EOF'
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(bodyParser.json({ limit: '1mb' }));

// Raw body for optional HMAC verification
app.use((req, res, next) => {
  let data = '';
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => { req.rawBody = data; next(); });
});

// Env vars
const PORT = parseInt(process.env.PORT || '3000', 10);
const TOKEN = process.env.COLLECTOR_TOKEN || '';
const HMAC = process.env.HMAC_SECRET || '';
const RETENTION_HOURS = parseInt(process.env.RETENTION_HOURS || '24', 10);
const MAX_RUNS = parseInt(process.env.MAX_RUNS_PER_IP_PER_DAY || '3', 10);
const MIN_GAP = parseInt(process.env.MIN_GAP_HOURS_PER_IP || '7', 10);
const DATA_DIR = '/opt/ip-collector/data';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function requireAuth(req, res) {
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${TOKEN}`) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

function utcDate(tsIso) {
  return (tsIso || new Date().toISOString()).slice(0,10); // YYYY-MM-DD
}

function filePaths(date) {
  const dir = path.join(DATA_DIR, 'ips', date);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return {
    ndjson: path.join(dir, 'ips.ndjson'),
    csv: path.join(dir, 'ips.csv')
  };
}

function appendRecord(rec) {
  const date = utcDate(rec.ts);
  const { ndjson, csv } = filePaths(date);
  fs.appendFileSync(ndjson, JSON.stringify(rec) + '\n');
  if (!fs.existsSync(csv)) fs.writeFileSync(csv, 'account,repo,run_id,job,ip,ts,country,region,city,isp,hostname,loc\n');
  const row = [rec.account||'',rec.repo||'',rec.run_id||'',rec.job||'',rec.ip||'',rec.ts||'',rec.country||'',rec.region||'',rec.city||'',rec.isp||'',rec.hostname||'',rec.loc||''].join(',');
  fs.appendFileSync(csv, row + '\n');
}

function readToday(ip) {
  const date = utcDate(new Date().toISOString());
  const { ndjson } = filePaths(date);
  if (!fs.existsSync(ndjson)) return [];
  const lines = fs.readFileSync(ndjson, 'utf8').trim().split('\n').filter(Boolean);
  const recs = lines.map(l => JSON.parse(l)).filter(r => r.ip === ip);
  return recs;
}

function hoursDiffISO(aIso, bIso) {
  const a = new Date(aIso).getTime();
  const b = new Date(bIso).getTime();
  return Math.abs(a - b) / 36e5; // ms to hours
}

app.post('/ingest', (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const { account, repo, run_id, job, ip, ts, country, region, city, isp, hostname, loc } = req.body || {};
    if (!ip || !ts) return res.status(400).json({ error: 'missing ip/ts' });
    const rec = { account, repo, run_id, job, ip, ts, country, region, city, isp, hostname, loc };
    appendRecord(rec);
    res.json({ ok: true });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'server_error' });
  }
});

app.post('/gate', (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const { ip, ts } = req.body || {};
    if (!ip || !ts) return res.status(400).json({ error: 'missing ip/ts' });
    const recs = readToday(ip);
    const uses_today = recs.length;
    const last_use_utc = recs.length ? recs.map(r => r.ts).sort().slice(-1)[0] : '';
    let should_run = true;
    let reason = '';
    if (uses_today >= MAX_RUNS) { should_run = false; reason = 'max_runs_reached'; }
    else if (last_use_utc && hoursDiffISO(ts, last_use_utc) < MIN_GAP) { should_run = false; reason = 'gap_not_satisfied'; }
    res.json({ should_run, uses_today, last_use_utc, reason });
  } catch (e) {
    console.error(e); res.json({ should_run: true, reason: 'fail_open' });
  }
});

app.get('/summary', (req, res) => {
  try {
    const date = utcDate(new Date().toISOString());
    const { ndjson } = filePaths(date);
    if (!fs.existsSync(ndjson)) return res.json({ total: 0, unique: 0, duplicates: {} });
    const lines = fs.readFileSync(ndjson, 'utf8').trim().split('\n').filter(Boolean);
    const recs = lines.map(l => JSON.parse(l));
    const counts = {};
    for (const r of recs) counts[r.ip] = (counts[r.ip]||0)+1;
    res.json({ total: recs.length, unique: Object.keys(counts).length, duplicates: counts });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'server_error' });
  }
});

app.get('/export', (req, res) => {
  try {
    const fmt = (req.query.format || 'csv').toLowerCase();
    const date = req.query.date || utcDate(new Date().toISOString());
    const { csv, ndjson } = filePaths(date);
    if (fmt === 'json') {
      if (!fs.existsSync(ndjson)) return res.json([]);
      const lines = fs.readFileSync(ndjson, 'utf8').trim().split('\n').filter(Boolean);
      const arr = lines.map(l => JSON.parse(l));
      res.json(arr);
    } else {
      if (!fs.existsSync(csv)) return res.type('text/csv').send('account,repo,run_id,job,ip,ts,country,region,city,isp,hostname,loc\n');
      res.type('text/csv').send(fs.readFileSync(csv, 'utf8'));
    }
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'server_error' });
  }
});

app.post('/cleanup', (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    // Approximate: delete date directories older than ceil(RETENTION_HOURS/24) days
    const keepDays = Math.max(1, Math.ceil(RETENTION_HOURS/24));
    const base = path.join(DATA_DIR, 'ips');
    if (!fs.existsSync(base)) return res.json({ deleted: 0 });
    const today = new Date();
    let deleted = 0;
    for (const d of fs.readdirSync(base)) {
      const dir = path.join(base, d);
      if (!fs.statSync(dir).isDirectory()) continue;
      const diffDays = Math.floor((today - new Date(d)) / 86400000);
      if (diffDays >= keepDays) { fs.rmSync(dir, { recursive: true, force: true }); deleted++; }
    }
    res.json({ deleted });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'server_error' });
  }
});

app.get('/', (req, res) => {
  res.send('ActionIP Aggregator (VM) — use /ingest, /gate, /summary, /export');
});

app.listen(PORT, () => console.log(`collector listening on :${PORT}`));
EOF
fi

# package.json
if [[ ! -f package.json ]]; then
  echo "[+] Writing package.json"
  cat > package.json <<'EOF'
{
  "name": "ip-collector-vm",
  "version": "1.0.0",
  "main": "server.js",
  "type": "commonjs",
  "dependencies": {
    "body-parser": "^1.20.2",
    "express": "^4.18.2"
  }
}
EOF
fi

# install deps
echo "[+] Installing npm dependencies"
npm install --production

# data dir
mkdir -p /opt/ip-collector/data

# =========================
# systemd service
# =========================
echo "[+] Configuring systemd service"
sudo bash -c "cat > /etc/systemd/system/ip-collector.service <<SERVICE
[Unit]
Description=IP Collector Service
After=network.target

[Service]
WorkingDirectory=/opt/ip-collector
ExecStart=/usr/bin/node /opt/ip-collector/server.js
Restart=always
Environment=PORT=${COLLECTOR_PORT}
Environment=COLLECTOR_TOKEN=${COLLECTOR_TOKEN}
Environment=HMAC_SECRET=${HMAC_SECRET}
Environment=RETENTION_HOURS=${RETENTION_HOURS}
Environment=MAX_RUNS_PER_IP_PER_DAY=${MAX_RUNS_PER_IP_PER_DAY}
Environment=MIN_GAP_HOURS_PER_IP=${MIN_GAP_HOURS_PER_IP}
User=root

[Install]
WantedBy=multi-user.target
SERVICE"

sudo systemctl daemon-reload
sudo systemctl enable ip-collector
sudo systemctl restart ip-collector

# =========================
# Optional Nginx + TLS
# =========================
if [[ "${ENABLE_NGINX_TLS}" == "true" && -n "${DOMAIN}" ]]; then
  echo "[+] Installing Nginx and Certbot"
  sudo apt-get install -y nginx certbot python3-certbot-nginx
  # Nginx reverse proxy
  sudo bash -c "cat > /etc/nginx/sites-available/ip-collector <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};
    location / {
        proxy_pass http://127.0.0.1:${COLLECTOR_PORT};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
NGINX"
  sudo ln -sf /etc/nginx/sites-available/ip-collector /etc/nginx/sites-enabled/ip-collector
  sudo nginx -t && sudo systemctl restart nginx
  # Obtain TLS cert (domain must point to this VM)
  sudo certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos -m "admin@${DOMAIN}" || true
fi

# =========================
# Firewall (ufw) – optional local
# =========================
if command -v ufw >/dev/null 2>&1; then
  sudo ufw allow 80 || true
  sudo ufw allow 443 || true
  sudo ufw allow ${COLLECTOR_PORT} || true
fi

# =========================
# Cloud Scheduler hint (optional)
# =========================
cat <<SCHED

[Hint] To schedule hourly cleanup (if you installed gcloud):
  gcloud scheduler jobs create http ip-collector-cleanup \
    --schedule="every 1 hours" \
    --uri="http://$(curl -s ifconfig.me):${COLLECTOR_PORT}/cleanup" \
    --http-method=POST \
    --headers="Authorization=Bearer ${COLLECTOR_TOKEN}"

SCHED

# =========================
# Summary
# =========================
echo "\n[+] Setup complete"
echo "Service URL: http://$(curl -s ifconfig.me):${COLLECTOR_PORT}"
echo "Test ingest: curl -s -X POST http://$(curl -s ifconfig.me):${COLLECTOR_PORT}/ingest -H 'Authorization: Bearer ${COLLECTOR_TOKEN}' -H 'Content-Type: application/json' -d '{\"ip\":\"203.0.113.7\",\"ts\":\"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'\"}'"

