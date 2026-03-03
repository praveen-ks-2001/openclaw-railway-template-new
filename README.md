![OpenCrawl Logo](https://res.cloudinary.com/asset-cloudinary/image/upload/v1769907898/openclaw-logo-text_w3qcgl.avif)


# Deploy and Host OpenClaw (Prev Clawdbot, Moltbot) – Self-Hosted AI Agents on Railway

OpenClaw is a powerful AI agent framework that enables you to run Claude, GPT, or Gemini as your personal assistant. Chat via web, Telegram, Discord, or Slack. Execute code, browse the web, schedule tasks, and maintain conversation context.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/openclaw-prev-clawdbot-moltbot-self-host?referralCode=QXdhdr&utm_medium=integration&utm_source=template&utm_campaign=generic)

## 🚀 Quick Start Deployment Guide

### Step 1: Deploy on Railway

1. Click the **"Deploy on Railway"** button at the top of this page &amp; wait for the initial deployment to complete (~3-5 minutes)

### Step 2: Note Your Credentials

Check the **Variables** tab and save following:

- **SETUP_PASSWORD**: Your password for accessing the setup wizard

⚠️ **Keep this secure!** You'll need this in the next steps.

### Step 3: Access Setup Wizard

1. Click on the URL provided by Railway in your project dashboard (e.g., `https://your-app-xyz.up.railway.app`)
2. Login prompt appears:
   - **Username**: Leave blank (press Enter)
   - **Password**: Enter your `SETUP_PASSWORD`

### Step 4: Complete the Setup Wizard

Once you log in, follow the intuitive 7-step guide on the left side of the setup screen to bring your AI agent online:

![OpenClaw setup using UI](https://res.cloudinary.com/asset-cloudinary/image/upload/v1772139854/setup_page_pt4haa.png)

1. Select your **provider & auth type**, then paste your API key
2. Add **channels** (optional — can be done later)
3. Click **Run Setup**
4. If you added a channel token, click **Approve Pairing** and enter the code
   *(After setup, message your bot on the channel. It will reply with a pairing code. Enter that code here to grant DM access.)*
5. Click **Open OpenClaw UI**
6. First login? Click **Manage Devices** → **Approve Latest Request**
   *(New browsers need a one-time device approval. After clicking "Open OpenClaw UI", come back here, click "Manage Devices", and approve the pending request.)*
7. You should now see **Health: OK** in the OpenClaw UI.

![Health Ok](https://res.cloudinary.com/asset-cloudinary/image/upload/v1772139788/health_ok_swgk94.png)

### Step 5: Start Chatting

1. Click **"Chat"** in the sidebar of the newly opened OpenClaw UI
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
2. Scroll to the **"Channels"** section
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

### The OpenClaw UI says "Pairing Required" — what do I do?

Any new browser opening the OpenClaw UI needs a one-time device approval. Go to `/setup`, click **Manage Devices** → **Approve Latest Request**. That's it — the browser is now authorized.

### The UI shows "Gateway Disconnected" or an auth error

Go to `/setup` and click **Open OpenClaw UI** from there. This automatically injects the required auth tokens into the session. Opening the UI directly from the Railway URL without going through `/setup` first will cause this.

### How do I approve a Telegram or Discord channel?

After running setup:
1. Go to `/setup` → click **Approve Pairing**
2. Enter the pairing code shown in your channel

If no pairing code appeared, send `hey` to your bot in the channel — it will reply with the code. Then enter that code in the Approve Pairing dialog.

### How do I enable the TUI (terminal UI)?

Set the environment variable `ENABLE_TUI=true` in your Railway service variables, then redeploy. Once running, access it at `/tui` on your Railway URL.

### What is the difference between OpenClaw, Clawdbot, and Moltbot?

Same project, different names over time. Moltbot → Clawdbot → OpenClaw is the evolution. OpenClaw is the current name.

### How much does it cost to run OpenClaw on Railway?

**Railway**: ~$5-10/month (Hobby plan: $5/month base + usage). Free tier available with limits.

**AI API costs** (varies by usage):
- Anthropic Claude: ~$5-30/month for moderate personal use
- OpenAI GPT: ~$5-40/month depending on model
- Google Gemini: Often free for personal use

### Is my data private?

Yes. OpenClaw is self-hosted — all data stays on your Railway instance. API keys are stored encrypted in your volume. Traffic is HTTPS.

### Can I switch AI providers after setup?

Yes. Go to `/setup`, change the provider and API key in the config, and click **Run Setup** again.

### Can I use OpenClaw without Telegram/Discord?

Yes. The web UI at your Railway URL is fully functional on its own. Channels are optional.

### How do I access it from my phone?

Visit your Railway URL in a mobile browser, or use the Telegram/Discord/Slack apps if you've set up those channels.

### Can I run multiple OpenClaw instances?

Yes — deploy the template multiple times on Railway. Each gets its own domain, volume, and config. Useful for separating personal and work use.

### Can I migrate off Railway?

Yes. Go to `/setup` → export a backup (`.tar.gz`) → deploy OpenClaw on any platform (VPS, Docker, home server) → import the backup there.

---

## 🛠️ Support & Issues

If you encounter any bugs, have feature requests, or need help with OpenClaw, please [open an issue on the GitHub repository](https://github.com/praveen-ks-2001/openclaw-railway-template-new/issues). 

When reporting issues, please include:
- A clear description of the problem
- Steps to reproduce
- Relevant logs (you can find these in your Railway dashboard or export them via the setup wizard)
