# Troubleshooting & Tips

This guide covers common questions and troubleshooting steps for the ActionIP Aggregator, especially when deployed on a Virtual Machine (VM).

## 1. Firewall Configuration (The "Manual Step")

Automated scripts cannot change Google Cloud's external firewall rules. You must do this manually in the Google Cloud Console.

### If you are using Port 80/443 (Nginx)
When creating the VM, check the boxes:
- [x] Allow HTTP traffic
- [x] Allow HTTPS traffic

### If you are using Port 3000 (Custom)
You must create a custom firewall rule:
1. Go to **VPC Network** > **Firewall**.
2. Click **Create Firewall Rule**.
3. **Name**: `allow-ip-collector-3000`
4. **Targets**: All instances in the network
5. **Source ranges**: `0.0.0.0/0`
6. **Protocols and ports**: `tcp:3000`

---

## 2. Verify Service Status

To check if the application is running, SSH into your VM and run:

```bash
sudo systemctl status ip-collector
```

- **Green (`active (running)`)**: The service is healthy.
- **Red (`failed`)**: The service crashed. View logs with:
  ```bash
  sudo journalctl -u ip-collector -f
  ```

---

## 3. Finding Your Secrets

The setup script generates a `.env` file with your configuration.

### Find Your Token
```bash
cat /opt/ip-collector/.env
```
Look for `COLLECTOR_TOKEN=...`.

### Find Your Public URL
From inside the VM:
```bash
curl -s ifconfig.me
```
Your URL is `http://<YOUR_IP>:3000` (or `https://<YOUR_DOMAIN>` if you set up SSL).

---

## 4. How Concurrency Works (Q&A)

**Q: What if 200+ workflows start at the exact same time (e.g., cron job)?**

**A:** The system handles this using a "Ingest-Then-Filter" architecture that prevents race conditions.

1.  **Ingestion (No Locking):**
    When 200 requests hit `/ingest`, the system immediately writes 200 small files to disk (one per request). This is extremely fast and ensures every request is "registered" before we check rules.

2.  **The Gate (Deterministic Sorting):**
    When those 200 requests verify themselves at `/gate`, each request reads the *same* list of 200 files.
    - They sort the list by `timestamp` (and `run_id` as a tie-breaker).
    - This sort is "stable," meaning every request sees the exact same order: `Run #1, Run #2, ..., Run #200`.

3.  **The Decision:**
    - **Run #1** checks the list. It sees it is first. It checks if it violates the 3/day limit. If not, it says **YES**.
    - **Run #2** checks the list. It sees Run #1 is first. It calculates the time gap between Run #1 and itself. Since they started at the same time (0 minutes gap), and the rule is "7 hours," it says **NO**.
    - **Run #3...200** all do the same logic and say **NO**.

**Result:** Even with 200 simultaneous requests, exactly **one** will run, and 199 will be denied, respecting your policies perfectly.
