#!/bin/bash
set -e

# Configuration
SERVICE_NAME="ip-collector"
REGION="us-central1"

# Check for required environment variables
if [ -z "$PROJECT_ID" ] || [ -z "$COLLECTOR_TOKEN" ] || [ -z "$BUCKET_NAME" ]; then
    echo "Error: Required environment variables are missing."
    echo "Please set PROJECT_ID, COLLECTOR_TOKEN, and BUCKET_NAME."
    exit 1
fi

# Optional variables with defaults
MAX_RUNS=${MAX_RUNS_PER_IP_PER_DAY:-3}
MIN_GAP=${MIN_GAP_HOURS_PER_IP:-7}
RETENTION=${RETENTION_HOURS:-24}
LIFECYCLE_DAYS=${BUCKET_LIFECYCLE_DAYS:-1}

echo "Deploying to Project: $PROJECT_ID"
echo "Bucket: $BUCKET_NAME"

# 1. Create Bucket if it doesn't exist
if ! gsutil ls -b "gs://$BUCKET_NAME" > /dev/null 2>&1; then
    echo "Creating bucket gs://$BUCKET_NAME..."
    gsutil mb -l "$REGION" "gs://$BUCKET_NAME"
else
    echo "Bucket gs://$BUCKET_NAME already exists."
fi

# 2. Set Lifecycle Rule (Day-level retention)
if [ "$LIFECYCLE_DAYS" -gt 0 ]; then
    echo "Setting GCS Lifecycle rule to delete objects older than $LIFECYCLE_DAYS days..."
    cat > lifecycle.json <<EOF
{
  "rule": [
    {
      "action": { "type": "Delete" },
      "condition": { "age": $LIFECYCLE_DAYS }
    }
  ]
}
EOF
    gsutil lifecycle set lifecycle.json "gs://$BUCKET_NAME"
    rm lifecycle.json
fi

# 3. Build & Deploy to Cloud Run
echo "Deploying Cloud Run service..."
gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --platform managed \
  --region "$REGION" \
  --allow-unauthenticated \
  --project "$PROJECT_ID" \
  --set-env-vars "COLLECTOR_TOKEN=$COLLECTOR_TOKEN" \
  --set-env-vars "STORAGE_TYPE=gcs" \
  --set-env-vars "BUCKET_NAME=$BUCKET_NAME" \
  --set-env-vars "PROJECT_ID=$PROJECT_ID" \
  --set-env-vars "MAX_RUNS_PER_IP_PER_DAY=$MAX_RUNS" \
  --set-env-vars "MIN_GAP_HOURS_PER_IP=$MIN_GAP" \
  --set-env-vars "RETENTION_HOURS=$RETENTION" \
  --set-env-vars "HMAC_SECRET=${HMAC_SECRET}" \
  --set-env-vars "EXTERNAL_SINK_URL=${EXTERNAL_SINK_URL}" \
  --set-env-vars "EXTERNAL_SINK_TOKEN=${EXTERNAL_SINK_TOKEN}"

# 4. Output Service URL
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" --region "$REGION" --project "$PROJECT_ID" --format 'value(status.url)')
echo "Deployment Complete!"
echo "Service URL: $SERVICE_URL"
echo ""
echo "To set up the Cloud Scheduler for cleanup, run:"
echo "gcloud scheduler jobs create http ip-collector-cleanup \\"
echo "  --schedule='every 1 hours' \\"
echo "  --uri='$SERVICE_URL/cleanup' \\"
echo "  --http-method=POST \\"
echo "  --headers='Authorization=Bearer $COLLECTOR_TOKEN'"
