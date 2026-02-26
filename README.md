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
2. Append `/setup` to the URL if not already there and visit it.
3. Login prompt appears:
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
1. Railway is still deploying or the engine process hasn't fully started yet.
2. **Solution**: Wait a minute and refresh the page.

Or:
1. The gateway process crashed due to an invalid API key.
2. **Solution**: Check Railway logs, verify your API key, and re-run setup if needed.

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

---

## 🛠️ Support & Issues

If you encounter any bugs, have feature requests, or need help with OpenClaw, please [open an issue on the GitHub repository](https://github.com/praveen-ks-2001/openclaw-railway-template-new/issues). 

When reporting issues, please include:
- A clear description of the problem
- Steps to reproduce
- Relevant logs (you can find these in your Railway dashboard or export them via the setup wizard)
