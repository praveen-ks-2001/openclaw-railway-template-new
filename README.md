# Openclaw Railway Template (1‑click deploy)

This repo packages **Openclaw** for Railway with a small **/setup** web wizard so users can deploy and onboard **without running any commands**.

## What you get

- **Openclaw Gateway + Control UI** (served at `/` and `/openclaw`)
- A friendly **Setup Wizard** at `/setup` (protected by a password)
- Persistent state via **Railway Volume** (so config/credentials/memory survive redeploys)
- One-click **Export backup** (so users can migrate off Railway later)

## How it works (high level)

- The container runs a wrapper web server.
- The wrapper protects `/setup` with `SETUP_PASSWORD`.
- During setup, the wrapper runs `openclaw onboard --non-interactive ...` inside the container, writes state to the volume, and then starts the gateway.
- After setup, **`/` is Openclaw**. The wrapper reverse-proxies all traffic (including WebSockets) to the local gateway process.

## Railway deploy instructions (what you’ll publish as a Template)

In Railway Template Composer:

1. Create a new template from this GitHub repo.
2. Add a **Volume** mounted at `/data`.
3. Set the following variables:

Required:

- `SETUP_PASSWORD` — user-provided password to access `/setup`

Recommended:

- `OPENCLAW_STATE_DIR=/data/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=/data/workspace`

Optional:

- `OPENCLAW_GATEWAY_TOKEN` — if not set, the wrapper generates one (not ideal). In a template, set it using a generated secret.

Notes:

- This template pins Openclaw to a known-good version by default via Docker build arg `OPENCLAW_VERSION`.

4. Enable **Public Networking** (HTTP). Railway will assign a domain.
5. Deploy.

Then:

- Visit `https://<your-app>.up.railway.app/setup`
- Complete setup
- Visit `https://<your-app>.up.railway.app/` and `/openclaw`

## Getting chat tokens (so you don’t have to scramble)

### Telegram bot token

1. Open Telegram and message **@BotFather**
2. Run `/newbot` and follow the prompts
3. BotFather will give you a token that looks like: `123456789:AA...`
4. Paste that token into `/setup`

### Discord bot token

1. Go to the Discord Developer Portal: https://discord.com/developers/applications
2. **New Application** → pick a name
3. Open the **Bot** tab → **Add Bot**
4. Copy the **Bot Token** and paste it into `/setup`
5. Invite the bot to your server (OAuth2 URL Generator → scopes: `bot`, `applications.commands`; then choose permissions)

## Local smoke test

```bash
docker build -t openclaw-railway-template .

docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e SETUP_PASSWORD=test \
  -e OPENCLAW_STATE_DIR=/data/.openclaw \
  -e OPENCLAW_WORKSPACE_DIR=/data/workspace \
  -v $(pwd)/.tmpdata:/data \
  openclaw-railway-template

# open http://localhost:8080/setup (password: test)
```
![OpenCrawl Logo](https://res.cloudinary.com/asset-cloudinary/image/upload/v1769907898/openclaw-logo-text_w3qcgl.avif)

# Deploy and Host OpenClaw (Prev Clawdbot, Moltbot) – Self-Hosted AI Agents on Railway

OpenClaw is a powerful AI agent framework that enables you to run Claude, GPT, or Gemini as your personal assistant. Chat via web, Telegram, Discord, or Slack. Execute code, browse the web, schedule tasks, and maintain conversation context.


## 🚀 Quick Start Deployment Guide

### Step 1: Deploy on Railway

1. Click the **"Deploy on Railway"** button at the top of this page &amp; wait for the initial deployment to complete (~3-5 minutes)

### Step 2: Note Your Credentials

Check the **Variables** tab and save these values:

- **SETUP_PASSWORD**: Your password for accessing the setup wizard
- **OPENCLAW_GATEWAY_TOKEN**: Auto-generated 64-character token for gateway authentication

⚠️ **Keep these secure!** You'll need them in the next steps.

### Step 3: Generate Public Domain

1. Go to **Settings** → **Networking** → Click **"Generate Domain"**
2. Copy your Railway URL (e.g., `your-app-xyz.up.railway.app`)

### Step 4: Access Setup Wizard

1. Visit: `https://your-app-xyz.up.railway.app/setup`
2. Login prompt appears:
   - **Username**: Leave blank (press Enter)
   - **Password**: Enter your `SETUP_PASSWORD`

### Step 5: Configure Your AI Agent

In the setup wizard:

![OpenClaw setup using UI](https://res.cloudinary.com/asset-cloudinary/image/upload/v1769907891/setup_page_wgyx8k.png)

1. **Provider Group**: Choose your AI provider (e.g., "Anthropic")
2. **Auth Method**: Select "Anthropic API key" (or your provider's method)
3. **Key/Token**: Paste your API key
4. **Wizard Flow**: Keep as "quickstart"
5. Click **"Run Setup"**
6. Wait for completion (~30-60 seconds)

### Step 7: Connect to Gateway

![OpenClaw Gateway token update](https://res.cloudinary.com/asset-cloudinary/image/upload/v1769907892/gateway_update_bs29gv.png)
1. Click **"Open OpenClaw UI"** at the top of the setup page
2. Navigate to **Overview** in the sidebar
3. Find the **Gateway Access** section
4. Paste your `OPENCLAW_GATEWAY_TOKEN` in the token field
5. Click **"Connect"**
6. Status changes to **Connected** 🟢

### Step 8: Start Chatting

1. Click **"Chat"** in the sidebar
2. Type your first message
3. Enjoy your self-hosted AI assistant! 🎉

---

## About Hosting OpenClaw (Prev Clawdbot, Moltbot) – Self-Hosted AI Agents

Deploying OpenClaw on Railway traditionally requires interactive terminal access for onboarding, which Railway doesn't provide. This template solves that challenge by wrapping OpenClaw's gateway with a web-based setup wizard. You get a one-click deployment with browser-based configuration—no CLI commands needed. This template lets you deploy OpenClaw in 1 click.

## Common Use Cases

- **Personal AI Assistant**: Chat with Claude/GPT via web interface or messaging apps for research, coding help, writing, and daily tasks
- **Automated Workflows**: Schedule recurring tasks, monitor websites, send notifications, and automate repetitive processes using cron jobs

## Dependencies for OpenClaw (Prev Clawdbot, Moltbot) – Self-Hosted AI Agents Hosting

- **AI Provider API Key**: Anthropic Claude, OpenAI GPT, Google Gemini, or other supported providers

### Deployment Dependencies

- [OpenClaw GitHub Repository](https://github.com/openclaw/openclaw) - Source code for the AI agent framework
- [Anthropic API Keys](https://platform.claude.com/) - Claude AI models (recommended)
- [OpenAI API Keys](https://platform.openai.com/) - GPT models (alternative)
- [Google AI Studio](https://aistudio.google.com/) - Gemini models (alternative)
- [Telegram BotFather](https://t.me/botfather) - Create Telegram bots for messaging
- [Discord Developer Portal](https://discord.com/developers/applications) - Create Discord bots

---

## 🔑 How to Get API Keys for Different AI Providers

### How to Get an Anthropic API Key? (Claude - Recommended)

1. Visit [Anthropic Console](https://platform.claude.com/dashboard)
2. Sign up/log in → Navigate to **"API Keys"** in the left sidebar → Click **"Create Key"**
3. Name your key (e.g., "OpenClaw Railway") → Copy the key → Paste into the setup wizard

### How to Get an OpenAI API Key? (GPT)

1. Go to [OpenAI Platform](https://platform.openai.com/)
2. Create an account or sign in → Click on your profile → **"View API Keys"**
3. Click **"Create new secret key"** → Name it (optional) and click **"Create"**
4. Copy the key → Paste into the setup wizard

### How to Get a Google Gemini API Key?

1. Visit [Google AI Studio](https://aistudio.google.com/)
2. Sign in with your Google account
3. Click **"Get API Key"** in the left menu
4. Select existing project or create new
5. Click **"Create API Key"**
6. Copy the generated key
7. Paste into the setup wizard

---

## 💬 How to Add Messaging Channels to OpenClaw

### How to Add a Telegram Bot?

**Step 1: Create Your Bot**
1. Open Telegram and search for `@BotFather`
2. Send the command: `/newbot`
3. Choose a display name: "My OpenClaw Assistant"
4. Choose a username: `my_openclaw_bot` (must end with 'bot')
5. BotFather will give you a token (format: `123456789:ABCdef...`)
6. Copy this token

**Step 2: Add to OpenClaw**
1. Go to your setup wizard: `/setup`
2. Scroll to **"Optional: Channels"** section
3. Paste token in **"Telegram bot token"** field
4. Click **"Run Setup"**
5. Wait for completion

**Step 3: Start Chatting**
1. Search for your bot username in Telegram
2. Click **"Start"** or send `/start`
3. Begin chatting with your AI agent!

### How to Add a Discord Bot?

**Step 1: Create Discord Application**
1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **"New Application"**
3. Name it (e.g., "OpenClaw Bot")
4. Go to **"Bot"** tab in left sidebar
5. Click **"Add Bot"** → Confirm

**Step 2: Configure Bot**
1. Under **"Privileged Gateway Intents"**:
   - ✅ Enable **"MESSAGE CONTENT INTENT"** (Required!)
2. Click **"Reset Token"** → Copy the token
3. Save the token securely

**Step 3: Invite Bot to Your Server**
1. Go to **"OAuth2"** → **"URL Generator"**
2. Select scopes:
   - ✅ `bot`
   - ✅ `applications.commands`
3. Select permissions:
   - ✅ Read Messages/View Channels
   - ✅ Send Messages
   - ✅ Read Message History
   - ✅ Embed Links
4. Copy the generated URL
5. Open URL in browser → Select server → Authorize

**Step 4: Add to OpenClaw**
1. Go to your setup wizard: `/setup`
2. Paste token in **"Discord bot token"** field
3. Click **"Run Setup"**
4. Mention `@YourBotName` in Discord to chat!

---


## ❓ Frequently Asked Questions (FAQ)

### What is the difference between OpenClaw, Clawdbot, and Moltbot?

OpenClaw is the current official name of the project. It was previously known as "Clawdbot" and "Moltbot" - these are older names for the same framework. 

### Can I use multiple AI providers at once in OpenClaw?

Currently, OpenClaw is configured to use one primary AI provider at a time. However, you can switch providers by editing the configuration via the setup wizard's config editor or by re-running the setup wizard.

### How much does it cost to run OpenClaw on Railway?

**Railway costs**: $5-10/month on the Hobby plan ($5/month subscription + ~$5 usage). Free tier available with limitations.

**AI API costs**: Varies by usage and provider:
- Anthropic Claude: ~$5-30/month for moderate personal use
- OpenAI GPT: ~$5-40/month depending on model and usage
- Google Gemini: Often free for personal use

### Is my data private and secure on OpenClaw?

Yes! OpenClaw is self-hosted, meaning:
- All data stays on your Railway instance
- API keys are encrypted and stored in your volume
- Communication between browser and gateway is encrypted (HTTPS)

### Can I migrate my OpenClaw instance off Railway?

Absolutely! That's the beauty of self-hosting:

1. Export a backup via `/setup`
2. Download the `.tar.gz` file
3. Deploy OpenClaw on another platform (VPS, Docker, home server)
4. Import the backup on your new instance

### Why is my OpenClaw UI gateway showing "Disconnected" after setup?

This usually means:
1. You haven't pasted the `OPENCLAW_GATEWAY_TOKEN` in the UI
2. **Solution**: Go to Overview → Gateway Access → Paste token → Click Connect

Or:
1. The gateway process crashed due to invalid API key
2. **Solution**: Check Railway logs, verify API key, re-run setup if needed

### Can I use OpenClaw without any messaging channels?

Yes! The web UI at `/` provides a full-featured chat interface. Telegram, Discord, and Slack are optional additions for convenience. You can use OpenClaw entirely through the web interface if you prefer.

### How do I access OpenClaw from my phone?

- **Web Interface**: Just visit your Railway URL in your mobile browser
- **Telegram**: Add the Telegram bot and chat from the Telegram app
- **Discord**: Use Discord mobile app with your bot
- **Slack**: Use Slack mobile app with your bot

### Can I run multiple OpenClaw instances?

Yes! Each Railway service can run its own independent OpenClaw instance:
1. Deploy the template multiple times
2. Each gets its own domain, volume, and configuration
3. You can have separate instances for different purposes (personal, work, testing)
4. Each instance needs its own API keys (or can share, depending on your API limits)

