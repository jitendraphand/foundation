# Deployment guide

Target: **Oracle Cloud Ampere A1 (VM.Standard.A1.Flex), 2 OCPU / 12 GB RAM, Ubuntu 24.04 Minimal ARM (aarch64)**.

Everything runs in Docker. Once the instance exists, deployment is three commands.

---

## Overview

```
                 GitHub Pages                     Oracle Cloud A1 instance
        ┌──────────────────────────┐      ┌──────────────────────────────────────┐
        │  yourname.github.io/     │      │  Caddy  :443  (auto HTTPS)           │
        │  foundation              │      │    ├── /api/*   → api    (Node 22)   │
        │                          │─────▶│    └── /*       → web    (nginx)     │
        │  [ Enter ]  ──────────┐  │      │                                      │
        └───────────────────────┼──┘      │  api ──▶ db (PostgreSQL 16)          │
                                │         │  volumes: db_data, uploads, backups  │
                                └────────▶└──────────────────────────────────────┘
                       https://<ip-with-dashes>.sslip.io
```

**On the "no domain name" problem.** You do not need one. `sslip.io` is a free
public DNS service that resolves any hostname containing an IP address back to
that IP — `132-145-10-20.sslip.io` resolves to `132.145.10.20`, with no signup,
no account and no token. Because it is a real hostname, Caddy can obtain a real
Let's Encrypt certificate for it, so students get proper HTTPS with no browser
warning, and passwords are encrypted in transit. Your GitHub Pages button links
straight there.

If you buy a domain later, change one line in `.env`, point the domain's A
record at the instance, and run `docker compose up -d`. Caddy re-issues the
certificate automatically.

---

## 0. Trying it on your own machine first

Everything below deploys to a server. If you would rather have a look at it
first, the same stack runs on an ordinary Ubuntu laptop — same containers, same
database, same migrations. Nothing about the trial is a different build.

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2 git
git clone https://github.com/jitendraphand/foundation.git
cd foundation

cp .env.example .env
nano .env          # see below - three lines to change

sudo docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

In `.env`, set:

```
PUBLIC_HOST=localhost
POSTGRES_PASSWORD=<anything, it is only reachable inside docker>
JWT_SECRET=<paste: openssl rand -base64 48>
ENCRYPTION_KEY=<paste: openssl rand -base64 48>
```

The first build takes a few minutes. Then open **http://localhost** and sign in
as `admin` / `foundation_123`.

To let other devices join the trial — a phone or a second laptop on the same
Wi-Fi, which is the only way to really try the student side — find your address
with `hostname -I` and open `http://192.168.x.x` on the other device. Both
machines must be on the same network.

Useful while trying it:

```bash
sudo docker compose logs -f api        # watch the API
sudo docker compose ps                 # what is running
sudo docker compose down               # stop, keeping all data
sudo docker compose down -v            # stop and erase everything
```

**What the trial gives up.** `docker-compose.local.yml` serves plain HTTP
instead of HTTPS, because a laptop has no public hostname and so no certificate
can be issued for it. It also sets `COOKIE_SECURE=false`, without which a
browser would refuse to store the session cookie from an `http://192.168.x.x`
address and nobody could sign in. Both are fine on a machine you control and on
a school LAN. **Never use this override on a server reachable from the
internet** — the real deployment below has HTTPS and secure cookies on by
default, and needs no flags.

Everything you set up during the trial — users, questions, tests, activities —
can be carried over with **Admin → Backups → Generate backup** and then
`./deploy/restore.sh` on the server.

---

## 1. Create the instance

In the Oracle Cloud console: **Compute → Instances → Create instance**.

| Setting | Value |
|---|---|
| Image | Canonical Ubuntu 24.04 **Minimal aarch64** |
| Shape | `VM.Standard.A1.Flex` — 2 OCPU, 12 GB RAM |
| Boot volume | 50 GB or more (the default 46.6 GB works; more is better for backups) |
| VNIC | **Assign a public IPv4 address** — this is essential |
| SSH keys | Upload your public key, or let Oracle generate one and download it |

Note the **public IP address** when the instance finishes provisioning.

---

## 2. Open the ports in Oracle Cloud

This is the step people miss. Oracle blocks inbound traffic at **two** layers,
and both must be opened. This is the cloud-side layer; `bootstrap.sh` handles
the host-side one for you.

1. **Networking → Virtual Cloud Networks →** your VCN
2. **Security Lists →** `Default Security List for <vcn>`
3. **Add Ingress Rules**, and add these two:

| Stateless | Source Type | Source CIDR | IP Protocol | Destination Port Range | Description |
|---|---|---|---|---|---|
| No | CIDR | `0.0.0.0/0` | TCP | `80` | HTTP — needed for Let's Encrypt |
| No | CIDR | `0.0.0.0/0` | TCP | `443` | HTTPS — the exam system |

> Port 80 is not optional. Let's Encrypt validates your certificate over
> port 80. Close it and HTTPS will never be issued.

If your instance uses a **Network Security Group** instead of a security list,
add the same two rules there.

---

## 3. Deploy

```bash
ssh ubuntu@YOUR_PUBLIC_IP

# Ubuntu Minimal has no git out of the box.
sudo apt-get update && sudo apt-get install -y git

git clone https://github.com/YOUR_USERNAME/foundation.git
cd foundation
./deploy/bootstrap.sh
```

`bootstrap.sh` installs Docker, creates a 2 GB swap file, opens the host
firewall, generates `.env` with strong random secrets, detects your public IP
and fills in `PUBLIC_HOST`, then builds and starts everything.

**It will stop once after installing Docker** to add you to the `docker` group.
Log out and back in, then run it again — or continue immediately with:

```bash
exec sg docker -- ./deploy/bootstrap.sh
```

The first build takes **5–10 minutes** on 2 OCPUs. Subsequent builds are cached
and take under a minute.

When it finishes it prints your URL and admin credentials.

### First visit

Open `https://<your-ip-with-dashes>.sslip.io`.

The very first load takes about 15 seconds while Caddy obtains its certificate.
If you get a browser warning, wait a minute and reload — the certificate is
still being issued.

Sign in with `admin` / `foundation_123`, then **change that password
immediately** from the footer link.

---

## 4. Point the GitHub Pages button at your server

1. Edit `docs/config.js` in this repository:

   ```js
   window.FOUNDATION_CONFIG = {
     SERVER_URL: 'https://132-145-10-20.sslip.io',   // your value
   };
   ```

2. Commit and push.

3. On GitHub: **Settings → Pages → Source: Deploy from a branch**, then choose
   your branch and the **`/docs` folder**. Save.

4. After a minute, `https://YOUR_USERNAME.github.io/foundation/` shows a single
   **Enter** button that takes students to your server.

Because both pages are HTTPS, browsers make the jump silently — no warning, no
mixed-content block.

---

## 5. Configure the LLM provider

**Admin → Settings → LLM providers → Add credential.**

| Provider | Base URL | Where to get a key | Model id format |
|---|---|---|---|
| OpenAI | `https://api.openai.com/v1` | <https://platform.openai.com/api-keys> | `gpt-4.1`, `gpt-4.1-mini` |
| OpenRouter | `https://openrouter.ai/api/v1` | <https://openrouter.ai/keys> | `anthropic/claude-sonnet-4.5` |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` | <https://build.nvidia.com/> | `meta/llama-3.3-70b-instruct` |
| Hugging Face | `https://router.huggingface.co/v1` | <https://huggingface.co/settings/tokens> | `meta-llama/Llama-3.3-70B-Instruct` |
| Other | anything OpenAI-compatible | Groq, Together, a local Ollama, … | whatever it expects |

OpenAI's reasoning models (`o1`/`o3`/`o4`/`gpt-5` lines) are detected
automatically and sent `max_completion_tokens` with no `temperature`, which is
what they require; everything else gets the usual parameters.

Hugging Face routes to whichever backend provider is fastest by default. To pin
one, append a suffix to the model id — `openai/gpt-oss-120b:groq` — or use
`:cheapest` / `:fastest`.

**None of these generate images.** When a question needs a real photograph, the
model flags it and writes an image-generation prompt instead. You copy that
prompt into any image tool and upload the result from the review screen. See
[Images](../README.md#images) in the README.

Keys are encrypted with AES-256-GCM before they touch the database and are
never displayed again. Use **Test connection** to confirm one works before
spending a real generation call.

---

## 6. Day-to-day operations

```bash
cd ~/foundation

docker compose ps                  # what is running
docker compose logs -f api         # follow API logs
docker compose logs -f caddy       # certificate problems show up here
docker compose restart api         # restart just the API
docker compose down                # stop everything (data is safe in volumes)
docker compose up -d               # start everything
```

### Updating to a new version

```bash
cd ~/foundation
git pull
docker compose build
docker compose up -d
```

Database migrations run automatically on startup. Existing data is preserved.

### Adding colleagues

**Admin → Administrators → New administrator.** Tick the privileges they need,
or start from a preset and adjust. Give them the temporary password in person;
they must change it at first sign-in.

Grant **Manage administrators** sparingly — a holder can change anybody's
privileges, including yours. The system will not let you remove the last one.

### Pausing a test outside certain hours

Set the school timezone once under **Admin → Settings → School** — every window
is wall-clock time in that zone, and the server itself runs UTC.

Then on any test, **Availability** offers:

- *Any time of day* (default)
- *Only during set hours* — e.g. school hours, Mon–Fri 8am–3pm
- *Paused during set hours* — e.g. 11pm–5am every night

Presets cover the common cases. A window can be changed on a live test at any
time; it does not affect anybody's marks. By default a student already writing
may finish; tick *"Submit papers still in progress when the window closes"* if
nobody should be writing outside those hours at all.

### Making students read something first

**Admin → Activities → New activity.** Give it a title, choose whether it is
cards, a video, or both, and pick the audience (grades and divisions; leave
both blank for the whole school).

- **Cards** are written one at a time. Each card holds one or more pieces of
  content, chosen from the dropdown: text, maths, a table, an SVG or Mermaid
  diagram, or code. *Preview* shows exactly what the student will see.
- **Video** takes any link. YouTube and Vimeo play inside the page; anything
  else becomes a button that opens the video in a new tab.
- **Minimum time** is the number of seconds a student must have the activity
  open before they can mark it done. Leave it at 0 for a short notice.
- **Must be done first** is the point of the feature: while it is ticked and
  the activity is live, students in the audience cannot reach their dashboard
  or start a test until they have been through it. Untick it and the activity
  simply appears on their dashboard.

Nothing happens until you press **Publish** — an activity is a draft until
then. **Who** shows the roster: completed, part way, not started. **Reset**
puts an activity back in front of a student who has already done it, which is
what you want after correcting a card half the class has read.

To take an activity down, **Unpublish** it (returns it to draft) or **Archive**
it, which keeps the record of who completed it.

### Releasing results after a test

Students never see a score at submit time. Once the class has finished, open
**Admin → Tests**, find the test, and click **Release results** (also available
inside the test itself). Every student who has submitted can then see their
score, breakdown and — if the test allows it — the correct answers. Clicking
**Withdraw results** hides them again.

Practice tests are exempt: their results are always immediate, so the release
buttons do not appear for them.

### Backups

From the UI: **Admin → Backups → Generate backup**, then download the archive
and put it on Google Drive. It is a plain `.tar.gz` — you can open it with any
unzip tool to check what is inside. It does contain password hashes and stored
API keys, so keep it in a private folder rather than a shared one.

From the command line, or from cron:

```bash
./deploy/backup.sh
```

Nightly at 02:30 — `crontab -e`:

```
30 2 * * * cd /home/ubuntu/foundation && ./deploy/backup.sh >> /home/ubuntu/backup.log 2>&1
```

### Restoring

```bash
scp foundation-backup-*.tar.gz ubuntu@YOUR_IP:~/
ssh ubuntu@YOUR_IP
cd ~/foundation
./deploy/restore.sh ~/foundation-backup-TIMESTAMP.tar.gz
```

The script takes a safety dump of the current database before overwriting
anything, and tells you how to roll back.

---

## 7. Data persistence

| What | Where | Survives `docker compose down` | Survives instance stop/start | Survives instance **termination** |
|---|---|---|---|---|
| Database | `db_data` volume | ✅ | ✅ | ❌ |
| Uploaded images | `uploads` volume | ✅ | ✅ | ❌ |
| Backup archives | `backups` volume | ✅ | ✅ | ❌ |
| HTTPS certificates | `caddy_data` volume | ✅ | ✅ | ❌ |
| **Downloaded backups** | your Google Drive | ✅ | ✅ | ✅ |

Docker volumes live on the instance's block-storage boot volume, so stopping
and restarting the instance is completely safe. Terminating it is not — which
is exactly what the backup feature is for. Download an archive regularly.

---

## 8. Troubleshooting

**The site does not load at all**

```bash
# Are the containers up?
docker compose ps

# Is the port reachable from outside? Run this on your laptop, not the server.
curl -v http://YOUR_PUBLIC_IP
```

If `docker compose ps` shows everything healthy but the request times out, the
ports are still closed. Check **both** layers:

```bash
sudo iptables -L INPUT -n --line-numbers | grep -E '80|443'
```

and re-check the Oracle security list from section 2.

**HTTPS certificate is not issued**

```bash
docker compose logs caddy | tail -50
```

Common causes, in order of likelihood:
- Port 80 is closed in the Oracle security list (the most common by far)
- `PUBLIC_HOST` in `.env` does not match the instance's actual public IP
- Let's Encrypt rate limit — 5 failures per hour per hostname; wait an hour

**"Provider returned 401"** — the API key is wrong or expired. Re-enter it under
Admin → Settings.

**"Could not decrypt stored API key"** — `ENCRYPTION_KEY` in `.env` changed.
Restore the old value, or re-enter the keys.

**Out of disk**

```bash
df -h
docker system prune -af        # removes unused images and build cache
```

**The build runs out of memory** — confirm swap is on with `free -h`. If it
shows 0 B, re-run `./deploy/bootstrap.sh`.

---

## 9. Security notes

- The database port is never published to the host; only the other containers
  can reach it.
- Passwords are hashed with Argon2id (64 MB, 3 passes).
- Sessions are httpOnly, SameSite=Lax cookies, marked Secure in production.
- LLM API keys are AES-256-GCM encrypted at rest.
- SVG from the LLM is sanitised against an allow-list **before it is stored**,
  and again in the browser before rendering.
- Login and signup are rate limited; eight failed logins locks an account for
  15 minutes.
- Every administrative action is written to an audit log.

**Do this after your first sign-in:**

1. Change the admin password.
2. Consider restricting SSH to your own IP in the Oracle security list.
3. Keep downloaded backup archives in a private folder — they are not encrypted
   and contain password hashes.
