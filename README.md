# X Spaces Recorder Bot

A **private Telegram bot** that accepts an X Space URL, attempts to resolve its public HLS audio stream, records with FFmpeg, and sends the completed audio to your Telegram chat.

## What it does

1. You paste an X Space link into your private bot.
2. The bot looks up the Space and its currently accessible HLS playlist.
3. FFmpeg continuously captures playlist audio while the Space is live.
4. When the stream ends—or when you use `/stop`—the worker finalizes the audio as M4A and sends the completed audio to Telegram when the file is within the configured upload threshold.

## Important limits

- A recorder can capture audio available from the moment it resolves the live stream. It cannot recreate unrecorded audio that occurred before it connected.
- If X has an official replay covering the entire Space, resolving the replay can provide the full available recording after the event ends.
- X routinely changes access controls. This project keeps the resolver in `src/space.js` so it can be updated without changing the bot or recording layer.
- Only record public Spaces or audio you are allowed to archive. Inform participants and comply with applicable laws and platform terms.

## Mobile-only setup

You can do every setup step from an Android phone using Telegram, GitHub, and Railway in Chrome.

### 1. Create your Telegram bot

1. In Telegram, search for `@BotFather` and open the verified account.
2. Send `/newbot`.
3. Give it a display name, for example `My Space Archive`.
4. Choose a username ending in `bot`, for example `my_space_archive_bot`.
5. BotFather sends an API token. Copy it privately. It is equivalent to the bot's password.
6. In BotFather, send `/setprivacy`, choose your bot, and select **Disable**. This helps if you later use it in a private group. For direct messages, it is not necessary.

### 2. Get your numeric Telegram ID

1. Send a message to a reputable ID lookup bot such as `@userinfobot`.
2. Copy the numeric ID it reports for your account.
3. This number goes in `ALLOWED_TELEGRAM_USER_ID`; it prevents anyone else from using your recorder.

### 3. Deploy as a persistent Railway worker

1. In Chrome, sign in at [Railway](https://railway.app/) using GitHub.
2. Tap **New Project** → **Deploy from GitHub repo**.
3. Select this private repository: `x-spaces-recorder-bot`.
4. Railway detects the `Dockerfile`; deploy it as a service/worker. No public domain is required because the bot uses Telegram long polling.
5. In Railway → your service → **Variables**, add:

```text
BOT_TOKEN=the-long-token-from-BotFather
ALLOWED_TELEGRAM_USER_ID=your-numeric-Telegram-ID
```

6. Deploy. The Railway log should say `X Spaces recorder bot is running.`

### 4. Add X access configuration only if needed

The resolver first tries public X API metadata. If your bot responds that X denied access, add one of these Railway variables:

```text
X_BEARER_TOKEN=...
# or
X_GUEST_TOKEN=...
# optionally, when your own permitted X session is required:
X_COOKIE=auth_token=...; ct0=...
```

Do **not** commit any of these values to GitHub. Treat them as passwords. The exact current resolver credential requirements can change as X changes its site/API access rules.

### 5. Start using it

1. Open the bot that you created with BotFather.
2. Tap **Start**.
3. Copy a public X Space link, including a live link such as `https://x.com/i/spaces/...`.
4. Paste it into the bot.
5. It replies when recording starts, then sends the M4A once capture ends.

Commands:

```text
/status   Show elapsed time and active job
/stop     Stop and retain the audio captured so far
/cancel   Stop and delete the active unfinished recording
```

## Large files

The default direct Telegram upload limit in this project is 45 MB to avoid failed delivery. Many long Spaces will exceed this. The simple initial behavior is to retain the M4A on the worker and notify you. For reliable multi-hour archives, add object storage (Cloudflare R2, S3, or Google Drive) as the next upgrade; the bot can then send you a private download link rather than trying to upload a huge audio file.

## Keeping recordings durable

Container disks may be erased on redeploy/restart. Do not treat local worker storage as a permanent archive. Add object storage before relying on it for important recordings.

## Development

```bash
npm install
cp .env.example .env
# Fill in required variables in .env
npm start
```

The Docker image includes FFmpeg. The production process uses Telegram long polling, so it needs a continuously running service rather than a short-lived serverless function.
