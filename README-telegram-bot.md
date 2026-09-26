# Telegram bot

The bot runs beside the recorder. It does not upload audio to Telegram. **Listen so far**, **Open audio**, and clip links open on your recorder's public URL.

## Setup

The API and the bot are two processes.

```bash
cd backend
npm install
npm start
```

In a second terminal, from `backend`:

```bash
TELEGRAM_BOT_TOKEN=your-token-from-BotFather
TELEGRAM_PUBLIC_BASE_URL=https://your-public-recorder-domain
BACKEND_PORT=3001
node telegram-bot.js
```

On Windows PowerShell, set the variables first:

```powershell
$env:TELEGRAM_BOT_TOKEN = "your-token-from-BotFather"
$env:TELEGRAM_PUBLIC_BASE_URL = "https://your-public-recorder-domain"
$env:BACKEND_PORT = "3001"
node telegram-bot.js
```

`TELEGRAM_PUBLIC_BASE_URL` must be the public `https://` address of this recorder. `localhost`, `127.0.0.1`, and private LAN addresses are rejected at startup because the phone cannot open them.

`TELEGRAM_ALLOWED_USER_IDS` is required. Use the numeric Telegram user ID, not a @handle. The bot exits if it is missing. Set the BotFather token only in the terminal. Do not paste it into chat.

## Windows keep-alive

Put the token and numeric user ID in `backend/.env`. That file is gitignored.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\keep-alive.ps1
```

The script starts the recorder API, opens a Cloudflare quick tunnel, and starts the bot with the tunnel's public `https://` URL. If the API, tunnel, or bot exits, all three restart together. The current URL is written to `backend/data/public-url.txt`. `cloudflared` must be on PATH. This is the process that keeps the bot running. A webhook connector cannot do that.

## Commands

Paste an X Space link, or send `/record <X Space link>`.

If the Space is not reachable yet, the bot offers **Watch for it**. That arms the recorder's existing monitor.

- `/status` lists active recordings, with **Listen so far** and **Stop & save**.
- `/archive` lists saved recordings, with **Open audio**, **Create clip**, and a confirmed **Delete**.
- `/clips` lists clips as direct playback links.
- After **Create clip**, send a range such as `1:30-4:00`.
