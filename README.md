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

## Setup & Deployment

You can deploy this service in two ways:
1.  **Serverless (Recommended):** Google Cloud Run.
2.  **Virtual Machine (VM):** Ubuntu/Debian VM (Local storage).

### Prerequisites

*   Google Cloud Project (GCP)
*   `gcloud` CLI installed and authenticated.

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

### Option A: Deploy to Cloud Run (Serverless)

1.  Edit `infra/cloud-run-deploy.sh` or set the variables in your shell.
2.  Run the script:

```bash
export PROJECT_ID="your-project-id"
export COLLECTOR_TOKEN="your-secret-token"
export BUCKET_NAME="your-bucket-name"
# Optional overrides
export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."

./infra/cloud-run-deploy.sh
```

### Option B: Deploy to VM (Ubuntu)

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
