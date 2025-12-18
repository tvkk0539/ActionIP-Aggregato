#!/bin/bash
# install-gcloud.sh — Automate Google Cloud CLI installation on Debian/Ubuntu
# Source: https://cloud.google.com/sdk/docs/install#deb

set -e

echo "[+] Updating apt and installing prerequisites..."
sudo apt-get update
sudo apt-get install -y apt-transport-https ca-certificates gnupg curl

echo "[+] Adding Google Cloud public key..."
# Note: Using the new location for keyrings as recommended by Google/Debian
curl https://packages.cloud.google.com/apt/doc/apt-key.gpg | sudo gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg

echo "[+] Adding Google Cloud CLI repository..."
echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | sudo tee /etc/apt/sources.list.d/google-cloud-sdk.list

echo "[+] Installing google-cloud-cli..."
sudo apt-get update
sudo apt-get install -y google-cloud-cli

echo ""
echo "=================================================="
echo " GCloud CLI Installed Successfully!"
echo " Next steps:"
echo " 1. Run: gcloud init"
echo " 2. Or login directly: gcloud auth login"
echo "=================================================="
