# Deployment guide

Any Linux machine with Docker, a public IP, and ports 80 and 443 open. Nothing
below is specific to a cloud or an instance type — the examples happen to use
Oracle Cloud's free tier because it is free, but AWS Lightsail, Hetzner, DigitalOcean
or a machine in the school office all work identically.

**Size it for the class.** 2 vCPU / 4 GB is fine up to about fifty students at
once; 4 vCPU / 8 GB is the recommendation for a whole school sitting together
(see [Sizing](../README.md#sizing)). Both arm64 and x86-64 are supported
natively.

Everything runs in Docker. Once the machine exists, deployment is three commands.

---

## Overview

```
                 GitHub Pages                        your Linux host
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

## 1. Create the machine

Whatever your provider, you need:

| Requirement | Value |
|---|---|
| OS | Ubuntu 24.04 (or any distribution Docker runs on) |
| Size | 2 vCPU / 4 GB minimum; **4 vCPU / 8 GB for 200 concurrent students** |
| Disk | 40 GB or more — backups and uploaded images live here |
| Network | **A public IPv4 address**, if students are off-site |
| Access | Your SSH public key |

Note the **public IP address** once it is running.

<details>
<summary>Example: Oracle Cloud free tier</summary>

**Compute → Instances → Create instance**, then Canonical Ubuntu 24.04 Minimal
aarch64 on a `VM.Standard.A1.Flex` shape with 2 OCPU / 12 GB, a 50 GB boot
volume, and **Assign a public IPv4 address** ticked. The A1 shape is free
indefinitely, which is why it is the worked example — nothing else here depends
on it.
</details>

---

## 2. Open ports 80 and 443

This is the step people miss. Most clouds firewall inbound traffic at the
provider level **as well as** on the host, and both must be opened.
`bootstrap.sh` handles the host side; the provider side is yours.

Open **TCP 80** and **TCP 443** from `0.0.0.0/0`.

<details>
<summary>Example: Oracle Cloud security lists</summary>

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
</details>

On AWS this is a security group, on GCP a VPC firewall rule, on Hetzner and
DigitalOcean a cloud firewall. On a machine in the school office it is whatever
the office router does with port forwarding.

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

The first build takes **5–10 minutes** on 2 cores. Subsequent builds are cached
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

## 3a. Running something else on the same machine

A second project on the same host — n8n is the usual one — collides with
Foundation in exactly one place: **ports 80 and 443**. Only one process can
hold them, and Foundation's Caddy already does. Everything else about sharing a
host is fine.

So do not give the other app its own ports. Make Caddy the single front door
for both.

**Hostnames are free.** sslip.io resolves *any* hostname containing an IP back
to that IP, including subdomains — so if Foundation is at
`132-145-10-20.sslip.io`, then `n8n.132-145-10-20.sslip.io` resolves to the
same machine with nothing to configure. Caddy issues a separate certificate for
each automatically.

**1.** Put the other app on the same Docker network and give it no host ports:

```yaml
# n8n's own docker-compose.yml
services:
  n8n:
    image: docker.n8n.io/n8nio/n8n
    restart: unless-stopped
    # No "ports:" - Caddy reaches it over the shared network.
    environment:
      N8N_HOST: n8n.132-145-10-20.sslip.io
      N8N_PROTOCOL: https
      WEBHOOK_URL: https://n8n.132-145-10-20.sslip.io/
    networks: [foundation_default]

networks:
  foundation_default:
    external: true
```

> The network is named after the directory Foundation was cloned into, so
> `foundation_default` assumes `~/foundation`. Check with
> `docker network ls | grep default` if you cloned it somewhere else.

**2.** Add a site block to Foundation's `Caddyfile`:

```caddy
n8n.{$PUBLIC_HOST} {
	reverse_proxy n8n:5678
}
```

`{$PUBLIC_HOST}` is already your Foundation hostname, so this reads
`n8n.132-145-10-20.sslip.io` with nothing new to set.

**3.** `docker compose up -d` in each directory.

The existing `:80` catch-all redirect does not interfere: Caddy matches an
explicit hostname block before a catch-all, so requests to the n8n hostname
reach n8n and everything else still lands on Foundation.

**Watch the memory.** n8n running workflows alongside a school sitting an exam
is two real workloads on one box. On a 4 GB machine that is tight; if you are
sizing for 200 concurrent students, size for both.

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
| Amazon Bedrock | derived from the region | AWS console, see below | `us.anthropic.claude-sonnet-4-20250514-v1:0` |
| Azure OpenAI | derived from the resource | Azure portal → Keys and Endpoint | your **deployment** name, e.g. `exam-writer` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | <https://aistudio.google.com/apikey> | `gemini-2.5-pro` |
| Google Vertex AI | derived from project + region | service-account JSON, see below | `google/gemini-2.5-pro` |
| Oracle Cloud | derived from the region | OCI console → API keys, see below | `meta.llama-3.3-70b-instruct` |
| Other | anything OpenAI-compatible | Groq, Together, a local Ollama, … | whatever it expects |

OpenAI's reasoning models (`o1`/`o3`/`o4`/`gpt-5` lines) are detected
automatically and sent `max_completion_tokens` with no `temperature`, which is
what they require; everything else gets the usual parameters.

**Reasoning models generally** — GLM 4.5/4.6, DeepSeek-R1, QwQ and the rest —
write their working out before the answer. On providers without a JSON mode
(NVIDIA NIM, Hugging Face) that working arrives in the reply, so it is stripped
before the JSON is read, and those models are given roughly twice the token
budget per question so they do not run out mid-thought. Copy the model id
exactly as build.nvidia.com shows it; the field is free text, so any id in the
catalogue works whether or not it is in the suggestion list.

**Asking for a lot of questions.** A request is split into calls of ten,
because one reply cannot hold more than that with worked explanations and
diagram source — asking for forty in one go used to come back truncated and be
reported as a format error. Fifty questions is five calls behind one run: allow
a few minutes, and each later call is told what the earlier ones wrote so they
do not repeat each other. If one call in a batch fails, the questions from the
others are kept and the run says which one failed.

Hugging Face routes to whichever backend provider is fastest by default. To pin
one, append a suffix to the model id — `openai/gpt-oss-120b:groq` — or use
`:cheapest` / `:fastest`.

### Amazon Bedrock

Bedrock is the one provider that does not speak the OpenAI shape, and the one
that needs work in the AWS console before a key will do anything. Three steps,
in order.

**1. Turn the model on, in the region you intend to use.** Bedrock ships with
every model switched off, and a model enabled in `us-east-1` is not enabled in
`eu-west-2`. Go to **Bedrock → Model access** in the region you want, request
access to the models you need, and wait for them to show as *Access granted* —
Anthropic and a few others ask for a one-line description of the use case first
and can take a few minutes to approve. Skipping this is the single most common
cause of a credential that tests fine on paper and returns *access denied* in
practice, which is why that error names the console page.

**2. Create a credential.** Either kind works:

- **Bedrock API key** (*Bedrock → API keys*) — a bearer token, the simpler
  option, and the one to use unless the school's AWS account forbids
  long-lived keys. Copy it when it is created; it is shown in full only once.
- **IAM access key and secret** — an IAM user or role with `bedrock:InvokeModel`
  (and `bedrock:InvokeModelWithResponseStream` if you later want streaming).
  Each request is signed with AWS Signature Version 4, so the secret itself
  never travels. Temporary STS credentials work too: paste the session token
  into the box beside the key. Both are encrypted before they are stored.

**3. Add it under Admin → Settings → LLM providers.** Choose *Amazon Bedrock*,
pick how to authenticate, and give the region — there is no base URL box,
because the endpoint is derived from the region
(`https://bedrock-runtime.<region>.amazonaws.com`, or `.amazonaws.com.cn` in
the China partition). The credential row then shows the region and auth mode,
so several Bedrock credentials in different regions stay distinguishable.

**Model ids need care.** Most current models are not callable on their own id;
they need a *cross-region inference profile*, whose id is the model id with a
geography prefix — `us.`, `eu.` or `apac.`:

```
anthropic.claude-sonnet-4-20250514-v1:0        ← may be refused
us.anthropic.claude-sonnet-4-20250514-v1:0     ← the inference profile
```

If a model id comes back as *"on-demand throughput isn't supported"*, that is
what it means: add the prefix for the geography your region belongs to. Copy
ids from **Bedrock → Model catalogue** rather than typing them; the colon and
version suffix are part of the id.

Costs are billed to the AWS account per token, with no free tier — check the
pricing page for the model before generating a few hundred questions.

### The other clouds

Each of these needs something beyond a key, and each fails in its own
characteristic way when it is wrong.

**Azure OpenAI.** The model box wants the **deployment name** you chose in
Azure AI Foundry, not the underlying model — if you deployed `gpt-4o` as
`exam-writer`, put `exam-writer`. Give the resource name (the part before
`.openai.azure.com`) or paste the whole endpoint URL from the portal; the key
is either of the two under *Keys and Endpoint*. The API version is pinned to a
date and defaults to a current one, which only needs changing on an older
resource.

**Google, two ways.** *Gemini (AI Studio key)* is an ordinary API key and needs
nothing else — use it unless your school's policy requires a GCP project.
*Vertex AI* takes the service-account JSON file itself: create a service
account with the **Vertex AI User** role, download a JSON key, and paste the
whole file. The project is read out of the file, so you only choose a region.
Vertex has no long-lived key — the file is exchanged for an hour-long token
behind the scenes and re-used until it expires.

**Oracle Cloud.** Four identifiers plus a private key, all from *Identity → My
profile → API keys*: tenancy OCID, user OCID, the fingerprint shown beside the
key, and the `.pem` file downloaded when it was created (it must not be
passphrase-protected). The compartment defaults to the tenancy root. The user
also needs a policy allowing `use generative-ai-family` in that compartment —
without it, OCI answers a bare 404 that is indistinguishable from a model that
does not exist, which is why that error says so.

Models are per-region on all of these. A model enabled in one region is not
enabled in the next, and that is by far the commonest cause of a credential
that saves cleanly and then fails on the first real call.

### Free endpoints, and surviving them

The free tiers — OpenRouter's `:free` models, NVIDIA's build tier, Hugging
Face's shared router — are genuinely useful for a school with no budget and
genuinely unreliable. They rate-limit under load, return 503 while a model
loads, and sometimes just drop the connection. None of that means the
credential is wrong, but a single attempt reports it as though it were.

**Retries are automatic.** A call that fails with 429, 503, a timeout or a
dropped connection is retried up to three times with exponential backoff and
jitter — the jitter matters, because batches failing together would otherwise
retry in lockstep and rate-limit each other again. A provider that says how
long to wait is believed, up to a minute. Configuration errors are *not*
retried: a wrong key or a bad model id fails immediately, because waiting
cannot fix either and telling you now is more useful.

**Fallbacks are opt-in.** Tick *Fallback* on any credential and it will be used
when the chosen provider has exhausted its retries. The provider you chose is
always tried first, so a fallback only ever rescues a run that would have been
lost — and nothing is used unless ticked, so a free key running out cannot
quietly start billing a paid account. The run says which batches fell back and
to what.

**Check all now** sends one tiny request to every active provider and reports
up/down with latency. That is the quick way to tell a broken key from a busy
service, without spending a generation run to find out. Anything answering
slower than a few seconds will struggle with a long run.

### Video activities: what "time spent" actually means

Set **minimum seconds** on an activity and a student cannot mark it done until
they have spent that long on the page. Two things about that are worth being
precise on, because the obvious reading is wrong:

- **The time is wall-clock time on the activity page, not video playback.** An
  embedded YouTube or Vimeo player does not report how much was watched to the
  page around it, so the system genuinely cannot know. Time is credited by a
  heartbeat, capped at two minutes per beat so a tab left open overnight does
  not count as engagement.
- **The video must be started.** Opening it is required before an activity with
  a video link can be completed — without that, the time requirement could be
  satisfied by leaving the tab open and doing something else.

So: set minimum seconds to roughly the video's length and this is a reasonable
proxy. It confirms the student opened the video and stayed on the page. It does
not confirm they watched, and nothing browser-based can.

**Only YouTube and Vimeo embed.** Both are recognised and framed inside the
page using their own privacy-preserving player domains. Every other link,
Instagram included, is treated as external and opens in a new tab — Instagram
in particular serves 403 to anything that is not a browser and gates embedding
behind its own flow, so it is materially more work than adding a URL pattern
and has not been attempted.

### Proctoring

Tick **Proctored exam** when creating or editing a test. Set how many
departures are allowed (three by default) and whether leaving fullscreen counts
alongside hiding the page.

**What it sees:** the tab losing focus, the page being hidden behind another
window, the app being switched away from on a phone, and fullscreen being left.
Each is recorded on the attempt with a timestamp. Past the allowance the paper
is submitted automatically.

**What it cannot see:** a second device, a phone under the desk, a person in
the room, notes on paper, or a screenshot. It cannot prevent any of those.

That distinction matters more than the feature: a school that believes this
prevents cheating will supervise less, which makes things worse rather than
better. Treat it as a deterrent against casual tab-switching and as a record to
look at afterwards, not as a lock.

The count is kept by the server, not the page, so editing the page in a
browser's developer tools cannot raise the allowance. The student is told the
paper is proctored before they start — a watch nobody knows about deters
nobody.

Deliberately not attempted: blocking copy, paste, right-click or screenshots.
All are trivial to work around, all break legitimate use — zooming a diagram,
or a screen reader — and all imply a security that is not there.

### Step-up tests

**Admin → Settings → LLM providers → Step-up tests.**

When a student reviews a released result, every question offers them five more
like it, or five building up to it. The paper is generated on the spot, opens
in a new tab, and is marked immediately.

Choose which provider answers those, separately from the one papers are set
with — students trigger this themselves, several times a day across a class, so
it usually wants pointing at something cheap even when papers use the best
model available. Left as *Off*, the buttons do not appear at all.

It is limited to six a student an hour, and a student can only build on a
question from a paper they actually sat whose results have been released — both
because this spends the school's API budget, and because otherwise it would be
a way to read questions out of the bank by guessing ids.

The generated questions belong to the student, so they never appear in anyone's
review queue, and the papers are practice tests: segregated from class results
everywhere, and marked without waiting for a release.

### When the provider is unavailable

**Admin → Set test → Import from a file instead.**

Generation depends on somebody else's service being up, in credit and
reachable. When it is not, and the exam is tomorrow, this takes the same JSON
the model would have produced — from a file, or pasted straight out of any
chat assistant, fences and chatter included — and puts it through exactly the
same validation and the same review queue. Nothing skips approval.

**Download the template** first: it is a worked example of the format, and
doubles as something to hand to an assistant with "give me twenty more like
this". Tags must use the codes from **Settings → Tags**; a question with an
unrecognised tag is skipped with a reason and the rest still load.

**None of the question models generate images.** When a question needs a real
photograph, the model flags it and writes an image-generation prompt instead.

Set an image provider under **Settings → LLM providers → Image generation** and
that prompt becomes a *Generate the picture* button in the review screen: one
click draws it, shows it to you, and attaches it only once you say so. Only
OpenAI and Azure OpenAI can do this — they share the same `/images/generations`
shape. Bedrock, Vertex and Oracle each have their own image API and are not
offered rather than being offered and failing.

Leave it off and the old route still works: copy the prompt into any image
tool and upload the result. Either way a flagged question cannot be approved
until a picture is attached. See [Images](../README.md#images) in the README.

**Copy the key when you create it.** Every provider shows a new key in full
exactly once, and from then on displays a shortened version — `sk-or-v1-…`.
That shortened form is not a key. Pasting it saves cleanly, looks right in the
table, and then fails with the provider's own wording (OpenRouter says
*"Missing Authentication header"*), which reads as if the site is broken. The
key box now refuses anything containing `...`, spaces or quotes, and warns when
a key does not start the way that provider's keys usually do.

**Model ids are exact.** There is no model called `openrouter/free` — free
models are ordinary ids with a `:free` suffix, and `openrouter/auto` lets
OpenRouter choose. A wrong id comes back as *"… is not a valid model ID"* and
is unrelated to the key.

Keys are encrypted with AES-256-GCM before they touch the database and are
never displayed again. Use **Test connection** to confirm one works before
spending a real generation call — it names the problem when the saved key
itself cannot work, rather than passing the provider's error through.

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

### Sessions: idle timeout and one device per account

Two settings in `.env`, both on by default:

- `IDLE_TIMEOUT_MINUTES=30` — a session with no requests at all for half an
  hour ends, and the next click returns to the sign-in page saying so. A
  student writing a paper sends a heartbeat every 20 seconds, so **an exam in
  progress can never time out**; this catches the shared computer somebody
  walked away from. Set it to `0` to disable.
- `SINGLE_DEVICE_LOGIN=true` — signing in ends any other session for that
  account, so one username and password cannot be used on two devices at once.
  The newest sign-in wins and the older device is told exactly why it was
  signed out. Deliberately not the other way round: refusing the new sign-in
  would lock a student out of their own account after a browser crash, until
  their old session happened to expire.

Signing out now genuinely ends the session rather than only clearing the
cookie, and a password change — whether the user does it or an administrator
resets it — signs that account out everywhere.

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
  content, chosen from the dropdown: text, maths, a **picture** you upload, a
  table, an SVG or Mermaid diagram, or code. *Preview* shows exactly what the
  student will see.
- **Colour.** Each card takes one of seven colours from the swatches beside its
  heading — new cards cycle through the palette, so a stack is colourful
  without any work. There is also a small line above the heading for something
  like *Remember this* or *Step 2 of 4*.
- **A picture on its own** is a perfectly good activity: one card, one picture,
  nothing else. PNG, JPEG, WebP or GIF up to 4 MB.
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

### Putting approved questions on a test

Two ways, whichever suits the moment:

- **From the question bank.** Tick the questions, press **Approve**; they stay
  selected and a **Put on a test** button appears. Choose a paper that already
  exists, or fill in a title and duration to create one right there. Either way
  you land in the test builder with the questions on the paper.
- **From the test builder.** Open a test and pick from the approved list at the
  bottom.

The builder's list is filtered by the test's subject to begin with, but that is
only a starting point — the **Subject** dropdown beside it shows every subject
with a count, including *All subjects*. This matters because subjects are free
text: a test called "Maths" and questions filed under "Mathematics" are two
different subjects, and the picker will say so rather than appearing empty.

Only approved questions can go on a paper, and a test students have already
attempted is locked — make a new one instead.

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

### Keeping an eye on things

```bash
sudo docker compose ps          # every service reports healthy/unhealthy
sudo docker compose logs -f api
df -h                           # backups and uploads share the host disk
```

`docker compose ps` shows a health column for all four services. Note that
plain Compose does **not** restart a container because its healthcheck fails —
that is a Swarm/Kubernetes behaviour. `restart: unless-stopped` covers the
process exiting, which is the failure that actually happens; the healthcheck is
for you and for the startup ordering.

Backups and uploads are separate volumes but live on the same disk. Old local
archives are pruned nightly (`BACKUP_RETENTION_DAYS`), and downloaded copies
are untouched — but a disk with no room left will fail a backup and an image
upload alike, so keep an eye on `df -h`.

`DB_POOL_SIZE` (default 20) is how many database connections the API may hold.
Prisma's own default is `cpus × 2 + 1` — five on a two-core box — which a whole
class starting a paper at the same moment will queue behind and then fail with
a pool timeout. Raise it only alongside PostgreSQL's `max_connections`.

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

### "Request failed (502)" on the sign-in page

The page loads, so the web container is fine — 502 means Caddy cannot reach the
**API** container. It is down or restarting, and the reason is always in its
log:

```bash
docker compose ps            # is api "Up", or "Restarting"?
docker compose logs api --tail=50
```

The API prints a framed explanation for the failures that actually happen —
invalid secrets in `.env`, a database whose migration history disagrees with its
tables, a database that never came up. Follow what it says.

If `docker compose ps` shows **no api container at all**, the image did not
build. Rebuild in the foreground so the error is visible instead of scrolling
past:

```bash
docker compose build api
```

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
