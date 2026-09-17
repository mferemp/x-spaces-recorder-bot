import 'dotenv/config';
import { Bot } from 'grammy';
import { extractSpaceId, resolveSpace } from './space.js';
import { RecordingManager } from './recorder.js';

const token = process.env.BOT_TOKEN;
const allowedUserId = Number(process.env.ALLOWED_TELEGRAM_USER_ID || 0);

if (!token) throw new Error('BOT_TOKEN is required.');
if (!allowedUserId) throw new Error('ALLOWED_TELEGRAM_USER_ID is required.');

const bot = new Bot(token);
const recordings = new RecordingManager(bot);

function isAllowed(ctx) {
  return ctx.from?.id === allowedUserId;
}

bot.use(async (ctx, next) => {
  if (!isAllowed(ctx)) {
    await ctx.reply('This is a private archive bot.');
    return;
  }
  await next();
});

bot.command('start', async (ctx) => {
  await ctx.reply('Send me an X Space link. I will try to capture its public audio stream and send the finished recording when it ends. Use /status, /stop, or /cancel while a recording is active.');
});

bot.command('status', async (ctx) => {
  const job = recordings.get(ctx.chat.id);
  await ctx.reply(job ? job.statusText() : 'No active recording in this chat.');
});

bot.command(['stop', 'cancel'], async (ctx) => {
  const job = recordings.get(ctx.chat.id);
  if (!job) return ctx.reply('No active recording in this chat.');
  await ctx.reply('Stopping capture and finalizing the audio received so far…');
  await recordings.stop(ctx.chat.id, ctx.command === 'cancel');
});

bot.on('message:text', async (ctx) => {
  const url = ctx.message.text.trim();
  const spaceId = extractSpaceId(url);
  if (!spaceId) return ctx.reply('Send a valid X Space link, for example: https://x.com/i/spaces/1YpKk…');
  if (recordings.get(ctx.chat.id)) return ctx.reply('A recording is already active here. Use /status or /stop first.');

  await ctx.reply('Checking the Space and locating its public audio stream…');
  try {
    const space = await resolveSpace(spaceId);
    const job = await recordings.start({ chatId: ctx.chat.id, userId: ctx.from.id, space });
    await ctx.reply(`Recording started.\n\nTitle: ${space.title}\nStatus: ${space.state}\nJob: ${job.id}\n\nI will finalize and send what was captured when the stream ends. Use /status to check progress.`);
  } catch (error) {
    console.error(error);
    await ctx.reply(`I could not start capture. ${error.message}`);
  }
});

bot.catch((error) => console.error('Telegram error:', error.error));
await bot.api.setMyCommands([
  { command: 'status', description: 'Show active recording status' },
  { command: 'stop', description: 'Stop and keep audio captured so far' },
  { command: 'cancel', description: 'Stop and discard this recording' }
]);
console.log('X Spaces recorder bot is running.');
bot.start();
