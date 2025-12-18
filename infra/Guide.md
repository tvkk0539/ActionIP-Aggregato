The code for the ActionIP Aggregator is now ready and submitted!

To get this running live, you need to follow these steps to deploy it to Google Cloud and connect it to your GitHub Actions.

Step 1: Deploy to Google Cloud

You need to run the deployment script I created. You can do this from your local machine (if you have gcloud installed) or the Google Cloud Shell.

Open your terminal (or Cloud Shell).
Set the required variables (replace the values with your actual details):

export PROJECT_ID="your-gcp-project-id"
export BUCKET_NAME="your-unique-bucket-name-123"
export COLLECTOR_TOKEN="create-a-strong-secret-password-here"
Run the deploy script:

chmod +x infra/cloud-run-deploy.sh
./infra/cloud-run-deploy.sh
This will build the app, create the Storage Bucket, and deploy the Cloud Run service.
Copy the Service URL: The script will output a URL at the end (e.g., https://ip-collector-xyz.a.run.app). Save this.
Step 2: Configure GitHub Secrets

Go to the GitHub Repository where you want to run your workflows.

Navigate to Settings > Secrets and variables > Actions.
Click New repository secret.
Add these two secrets:
COLLECTOR_URL: Paste the Service URL from Step 1.
COLLECTOR_TOKEN: Paste the token you created in Step 1.
(Optional) HMAC_SECRET: If you set one during deployment.
Step 3: Setup the Cleanup Job (Important)

To ensure data is deleted after 24 hours (or your configured time), create the Cloud Scheduler job. Run this command in your terminal:

gcloud scheduler jobs create http ip-collector-cleanup \
  --schedule="every 1 hours" \
  --uri="YOUR_SERVICE_URL/cleanup" \
  --http-method=POST \
  --headers="Authorization=Bearer YOUR_TOKEN"
Step 4: Use the Workflow

I created a sample workflow in client/workflow.yml.

Move this file to .github/workflows/daily-docker.yml in your repository.
It is already configured to use the secrets you set in Step 2.
That's it! Your system will now automatically collect IPs, enforce the 3x/7h policy, and clean up old data.


You will need to do one manual step in the Google Cloud Console (or using gcloud) because the script runs inside the VM and cannot control the Google Cloud Firewall outside of it.

1. What the Script Does (Internal Firewall)

The script does automatically configure the VM's internal firewall (ufw) to allow traffic on:

Port 22 (SSH)
Port 80 & 443 (HTTP/HTTPS - if you enable Nginx)
Port 3000 (or whatever custom port you choose)
2. What You Must Do (GCP Firewall)

Google Cloud blocks all incoming traffic by default. You need to tell Google Cloud to "Allow traffic to this VM".

If you are using Nginx (Recommended, Port 80/443):

When creating the VM in the console, simply check the boxes:
Allow HTTP traffic
Allow HTTPS traffic
If you missed this, go to VPC Network > Firewall, and click Create Firewall Rule.
Name: allow-http-https
Targets: All instances in the network
Source ranges: 0.0.0.0/0
Protocols and ports: tcp:80, tcp:443
If you are using the Custom Port directly (e.g., 3000):

You must create a custom firewall rule:
Name: allow-ip-collector-3000
Targets: All instances in the network (or valid tag)
Source ranges: 0.0.0.0/0
Protocols and ports: tcp:3000
Summary

Run the script: It handles the software and internal settings.
GCP Console: Make sure the Firewall Rule exists for the port you are using (80/443 or 3000).


Great! Since you've installed the bash script and enabled the firewall ports, your VM should be running the service now.

Here is what you should do next to verify and use it:

1. Verify the Service is Running

SSH into your VM and run:

sudo systemctl status ip-collector
It should say active (running) in green.
If it's not running, check logs: sudo journalctl -u ip-collector -f.
2. Get Your VM's Public IP

In the GCP Console (or via curl ifconfig.me inside the VM), copy your External IP Address. Let's assume it is 34.123.45.67.

3. Test it Locally (from your computer)

Open a terminal on your own computer (not the VM) and try to "Ingest" a fake record to see if it works. (Replace YOUR_TOKEN with the token you entered during setup)

# 1. Ingest a fake record
curl -X POST http://34.123.45.67:3000/ingest \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ip": "1.1.1.1", "run_id": "test-1", "ts": "2024-01-01T10:00:00Z"}'

# Should return: {"status":"ok"}
# 2. Ask the Gate (Should say NO because gap is too small/fresh)
# Wait, for a fresh IP it should say YES.
curl -X POST http://34.123.45.67:3000/gate \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ip": "1.1.1.1", "run_id": "test-1", "ts": "2024-01-01T10:00:00Z"}'

# Should return: {"should_run":true, ...}
4. Connect GitHub Actions

Once the test above works:

Go to your GitHub Repo Settings > Secrets.
Add COLLECTOR_URL -> http://34.123.45.67:3000 (or https://your-domain.com if you set up SSL).
Add COLLECTOR_TOKEN -> YOUR_TOKEN.
Add the Workflow File (client/workflow.yml) to your repo.
That's it! Your GitHub runners will now talk to your VM.


The Bearer YOUR_TOKEN refers to the authentication token required to talk to your service.

Since you are running this on your VM, the token is stored in the .env file created by the setup script.

To find your token:

Run this command on your VM:
cat /opt/ip-collector/.env
Look for the line starting with COLLECTOR_TOKEN=. That is your token.
If you want to set your own token:

You can update the file manually:

nano /opt/ip-collector/.env
Change COLLECTOR_TOKEN=REPLACE_WITH_STRONG_TOKEN to something secret (e.g., my-secret-123).
Restart the service: sudo systemctl restart ip-collector
When using curl or GitHub Actions, you will use Bearer my-secret-123.


The COLLECTOR_URL is the address where your service is accessible on the internet.

Since you are using a VM, your URL follows this format: http://<YOUR_VM_PUBLIC_IP>:3000

To find your URL:

Run this command on your VM to get your Public IP:
curl -s ifconfig.me
Take the IP address it outputs (e.g., 35.123.45.67) and add :3000 to the end.
Example: If the command outputs 35.222.111.10, your COLLECTOR_URL is: http://35.222.111.10:3000

(Note: If you configured a domain name with SSL, it would be https://yourdomain.com).


