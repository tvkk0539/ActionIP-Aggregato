# ActionIP Aggregator

A Google Cloud Run service to collect GitHub Actions Runner IPs and enforce usage policies (e.g., max 3 runs per day per IP, minimum 7-hour gap).

## Features

*   **Public IP Collection:** Collects runner IPs early in the workflow.
*   **Gate Policy:**
    *   **Max Runs:** Limit usage of the same public IP to `N` times per UTC day (default 3).
    *   **Min Gap:** Enforce a minimum gap of `N` hours between uses of the same IP (default 7h).
*   **Notifications:** Sends "fire-and-forget" alerts to Discord with IP usage stats.
*   **Retention:**
    *   **Hour-level:** `/cleanup` endpoint removes old records from storage.
    *   **Day-level:** GCS Lifecycle rules auto-delete files after `N` days.
*   **Storage:**
    *   **Cloud Run Mode:** Google Cloud Storage (NDJSON/CSV) + Optional BigQuery.
    *   **VM Mode:** Local filesystem storage.
*   **External Sink:** Optionally forward records to an external webhook.

## Deployment Options

You can deploy this service in three ways:
1.  **Serverless (Cloud Run):** Best for scalability and low maintenance.
2.  **Virtual Machine (VM):** Ubuntu/Debian VM with Systemd.
3.  **Docker / Docker Compose:** Run anywhere (VPS, Local, etc.) in a container.

### Prerequisites

*   Google Cloud Project (GCP) - *Required for Cloud Run.*
*   Docker & Docker Compose - *Required for Docker deployment.*
*   Node.js 20+ - *Required for manual local dev.*

### Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `COLLECTOR_TOKEN` | **Required.** Bearer token for auth. | - |
| `BUCKET_NAME` | **Required.** GCS Bucket to store data (Cloud Run only). | - |
| `PROJECT_ID` | **Required.** GCP Project ID. | - |
| `HMAC_SECRET` | Optional. Shared secret for signature verification. | - |
| `MAX_RUNS_PER_IP_PER_DAY` | Max times an IP can be used per day. | `3` |
| `MIN_GAP_HOURS_PER_IP` | Min hours between uses of same IP. | `7` |
| `RETENTION_HOURS` | Hours to keep data (for `/cleanup`). | `24` |
| `BUCKET_LIFECYCLE_DAYS` | Days to keep GCS files (GCS Lifecycle). | `1` |
| `DISCORD_WEBHOOK_URL` | Optional. Discord Webhook for notifications. | - |
| `EXTERNAL_SINK_URL` | Optional URL to forward events to. | - |

---

### Option A: Deploy to Cloud Run (Serverless)

1.  Edit `infra/cloud-run-deploy.sh` or set the variables in your shell.
2.  Run the script:

```bash
export PROJECT_ID="your-project-id"
export COLLECTOR_TOKEN="your-secret-token"
export BUCKET_NAME="your-bucket-name"
# Optional overrides
# export MAX_RUNS_PER_IP_PER_DAY=3
export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."

./infra/cloud-run-deploy.sh
```

---

### Option B: Deploy to VM (Ubuntu/Debian)

1.  Copy `infra/vm-setup.sh` to your VM.
2.  Run the script and follow the prompts. You will be asked for the **Discord Webhook URL** during setup.

```bash
chmod +x vm-setup.sh
./vm-setup.sh
```

This will:
*   Install Node.js and dependencies.
*   Set up the app as a systemd service (`ip-collector`).
*   Configure local filesystem storage.
*   Setup a local cron job for hourly cleanup.

---

### Option C: Docker Deployment

You can run the application in a container using the provided `Dockerfile` and `docker-compose.yml`. This works on any system with Docker installed (Linux, Mac, Windows).

#### 1. Using Docker Compose (Recommended)

This method handles port mapping and data persistence automatically.

**Setup:**
1.  Open `docker-compose.yml` and update the environment variables (specifically `COLLECTOR_TOKEN` and `DISCORD_WEBHOOK_URL`).
2.  Or, create a `.env` file in the root directory (Docker Compose reads it automatically):
    ```env
    COLLECTOR_TOKEN=my-super-secret-token
    DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
    STORAGE_TYPE=local
    ```

**Run:**
```bash
# Start in the background
docker-compose up -d

# Check logs
docker-compose logs -f
```

The service will be available at `http://localhost:3000`. Data will be persisted in the `./data` folder on your host machine.

#### 2. Manual Docker Build & Run

If you prefer to run `docker` commands manually:

**Build the image:**
```bash
docker build -t actionip-aggregator .
```

**Run the container:**
```bash
docker run -d \
  --name ip-collector \
  -p 3000:8080 \
  -v $(pwd)/data:/usr/src/app/data \
  -e COLLECTOR_TOKEN="your-secret-token" \
  -e STORAGE_TYPE="local" \
  -e DISCORD_WEBHOOK_URL="https://discord.com/..." \
  actionip-aggregator
```

---

### How to Get a Discord Webhook URL

1.  Open Discord and go to your server.
2.  Right-click a channel (e.g., `#logs`) -> **Edit Channel**.
3.  Go to **Integrations** -> **Webhooks**.
4.  Click **New Webhook**.
5.  Click **Copy Webhook URL**.
6.  Use this URL when setting up the deployment.

---

### Setup Cloud Scheduler (Only for Cloud Run)

After Cloud Run deployment, create a job to run cleanup every hour:

```bash
gcloud scheduler jobs create http ip-collector-cleanup \
  --schedule="every 1 hours" \
  --uri="https://YOUR_SERVICE_URL/cleanup" \
  --http-method=POST \
  --headers="Authorization=Bearer YOUR_TOKEN"
```

## Client Usage (GitHub Actions)

Add the workflow steps from `client/workflow.yml` to your GitHub Actions.

1.  **Ingest:** Sends IP to `/ingest`.
2.  **Gate:** Asks `/gate` if the run should proceed.
3.  **Abort:** If `should_run` is false, the workflow exits successfully (green) but skips work.

## Development

```bash
npm install
npm start
```
