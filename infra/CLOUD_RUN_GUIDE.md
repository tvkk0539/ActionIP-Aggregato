# Google Cloud Run Guide for ActionIP Aggregator

This guide explains why **Google Cloud Run** is likely the best choice for this project and how to set it up from scratch.

## 1. Cloud Run vs. VM (Virtual Machine)

| Feature | Virtual Machine (VM) | Cloud Run (Serverless) |
| :--- | :--- | :--- |
| **Running State** | **Always On.** It runs 24/7 even if no one uses it. | **On Demand.** It "sleeps" (scales to 0) when idle and wakes up instantly when a request comes in. |
| **Cost** | **Fixed Monthly Cost.** You pay for every second the VM exists (e.g., ~$7-30/month). | **Pay-per-use.** You only pay when a request is processed. For this project, it will likely be **$0.00** (Free Tier covers ~2 million requests/month). |
| **Maintenance** | **High.** You must manage OS updates, security patches, and disk space. | **Zero.** Google manages the server. You just provide the code/container. |
| **Reliability** | If the VM crashes or the disk fills up, the service stops. | Highly available. Google spins up new instances automatically if one fails. |

### 🏆 Recommendation: Cloud Run
For this project, **Cloud Run is superior.**
*   **Why?** Your GitHub Workflows only run a few times a day. A VM would sit idle 99% of the time, wasting money. Cloud Run will wake up *only* when your workflow starts, process the check, and go back to sleep.
*   **Does it work anytime?** **Yes.** Even if it has been "asleep" for hours, the moment your GitHub Action sends a request to `https://your-url/ingest`, Cloud Run wakes up in milliseconds and processes it. You do not need "Always On" CPU for this.

---

## 2. Prerequisites

Before deploying, you need a Google Cloud Project and a way to send the code to it.

1.  **Create a Project:** Go to the [Google Cloud Console](https://console.cloud.google.com/) and create a new project (e.g., `actionip-project`).
2.  **Enable Billing:** You must enable billing to use Cloud Run, even if your usage stays within the free tier.
3.  **Enable APIs:** Search for and enable these APIs in the console:
    *   **Cloud Run Admin API**
    *   **Google Container Registry API** (or Artifact Registry)
    *   **Cloud Build API**
    *   **Cloud Logging API**

---

## 3. How to Deploy (The "gcloud" Tool)

To deploy, you need the **Google Cloud CLI (`gcloud`)**. This is the tool that runs **on your computer** (or in the browser) to talk to Google's servers and upload your code. You do NOT need to install this on a server; you use it to *create* the server.

### Step 1: Install Google Cloud CLI

You have two options to run the deployment commands:

#### Option A: Use Google Cloud Shell (Easiest - No Install)
You can run all deployment commands directly in your browser without installing anything on your laptop.

1.  Open the [Google Cloud Console](https://console.cloud.google.com/).
2.  Click the **Activate Cloud Shell** icon (>_) in the top right toolbar.
3.  In the terminal that opens, clone your repo:
    ```bash
    git clone https://github.com/YOUR_USERNAME/ActionIP-Aggregator.git
    cd ActionIP-Aggregator
    ```
4.  Proceed to **Step 2** below.

#### Option B: Install on Local Machine (Your Laptop/VM)
If you prefer to work from your own terminal (Debian/Ubuntu/Mac/Windows):

1.  **Manual Install:** Follow the official [Install Guide](https://cloud.google.com/sdk/docs/install).
2.  **Automatic Install (Debian/Ubuntu):** We have provided a script to automate this for you.
    ```bash
    chmod +x infra/install-gcloud.sh
    ./infra/install-gcloud.sh
    ```
3.  **Login:**
    ```bash
    gcloud auth login
    gcloud config set project YOUR_PROJECT_ID
    ```

---

### Step 2: Configure Your Environment
We need to tell the deployment script your secret token and project details.

**Run these commands in your terminal (Cloud Shell or Local):**

```bash
# 1. Set your Project ID (found in GCP Console dashboard)
export PROJECT_ID="your-project-id-here"

# 2. Create a secure token (you act as the password generator)
# This token must be put in your GitHub Secrets later as COLLECTOR_TOKEN
export COLLECTOR_TOKEN="generate-a-long-random-password-here"

# 3. Choose a unique bucket name for storage
export BUCKET_NAME="actionip-data-${PROJECT_ID}"

# 4. (Optional) Set your Discord Webhook
export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."
```

### Step 3: Run the Deploy Script
We have a script that does the heavy lifting (`infra/cloud-run-deploy.sh`).

```bash
# Make it executable
chmod +x infra/cloud-run-deploy.sh

# Run it
./infra/cloud-run-deploy.sh
```

**What happens next?**
1.  The script creates the Storage Bucket.
2.  It packages your code and uploads it to Google Cloud.
3.  It deploys the service to Cloud Run.
4.  **Success:** It prints a URL ending in `.run.app`.

**Example Output:**
```
Service URL: https://ip-collector-xyz-uc.a.run.app
```

---

## 4. Post-Deployment Steps

### A. Configure GitHub Secrets
Go to your GitHub Repository -> **Settings** -> **Secrets and variables** -> **Actions**.
Add these secrets:
*   `COLLECTOR_URL`: The URL output by the script (e.g., `https://ip-collector...run.app`)
*   `COLLECTOR_TOKEN`: The token you created in Step 2.
*   `HMAC_SECRET`: (Optional) If you set one.

### B. Setup Cleanup Job (Cloud Scheduler)
Since Cloud Run doesn't run background timers (cron) like a VM, we use **Cloud Scheduler** to ping the `/cleanup` endpoint once an hour.

**Run this command ONE TIME in your terminal:**

```bash
gcloud scheduler jobs create http ip-collector-cleanup \
  --schedule="0 * * * *" \
  --uri="YOUR_SERVICE_URL/cleanup" \
  --http-method=POST \
  --headers="Authorization=Bearer YOUR_TOKEN" \
  --location=us-central1
```
*(Replace `YOUR_SERVICE_URL` and `YOUR_TOKEN` with your actual values)*

> **Note:** Once you run this command successfully, Google Cloud will take over and automatically run the job every hour. You do NOT need to run it again.

---

## 5. Troubleshooting Cloud Run

*   **"Service Unavailable" / 503:**
    *   Check if the service is deployed successfully in the GCP Console.
    *   Check the **Logs** tab in Cloud Run for error messages.
*   **"Unauthorized" / 401/403:**
    *   Ensure the `COLLECTOR_TOKEN` in your GitHub Secrets matches exactly what you deployed with.
    *   Ensure the deployment allows unauthenticated invocations (our script sets `--allow-unauthenticated`), because the app handles its own auth via the Token.

---

## 6. Verification & Testing

### "Missing or invalid Authorization header"
If you open your Service URL in a browser and see this error:
> `{"error":"Missing or invalid Authorization header"}`

**🎉 This is GOOD!**
It means your service is running and properly protecting itself. It rejected you because you didn't provide the `COLLECTOR_TOKEN`.

### How to Test Properly
To test if it works, you must use `curl` and provide the token. Run this in your terminal:

```bash
# Replace with your actual URL and Token
curl -X POST https://YOUR-SERVICE-URL.run.app/ingest \
     -H "Authorization: Bearer YOUR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"ip": "1.2.3.4", "run_id": "test-run"}'
```

If it works, you will see: `{"status":"ok"}`.

---

## 7. Managing Environment Variables

In Cloud Run, there is **no `.env` file** and no `systemctl`. Everything is managed through the Google Cloud Console.

### How to View/Edit Variables:
1.  Go to the [Cloud Run Console](https://console.cloud.google.com/run).
2.  Click on your service name (`ip-collector`).
3.  Click **Edit & Deploy New Revision** (top toolbar).
4.  Go to the **Variables & Secrets** tab.
5.  Here you can see `COLLECTOR_TOKEN`, `DISCORD_WEBHOOK_URL`, etc.
6.  Change a value and click **Deploy** to update the service.
