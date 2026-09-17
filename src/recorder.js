import { spawn } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.env.RECORDINGS_DIR || './recordings');
const maxTelegramMb = Number(process.env.MAX_TELEGRAM_UPLOAD_MB || 45);

function cleanName(value) {
  return value.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'x-space';
}

class RecordingJob {
  constructor({ chatId, userId, space }) {
    this.id = `${space.id}-${Date.now()}`;
    this.chatId = chatId;
    this.userId = userId;
    this.space = space;
    this.startedAt = new Date();
    this.output = path.join(root, `${cleanName(space.title)}-${space.id}.m4a`);
    this.process = null;
    this.stopping = false;
    this.cancelled = false;
  }

  statusText() {
    const seconds = Math.floor((Date.now() - this.startedAt.getTime()) / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `Recording in progress\nTitle: ${this.space.title}\nElapsed: ${hours}h ${minutes}m\nJob: ${this.id}`;
  }
}

export class RecordingManager {
  constructor(bot) {
    this.bot = bot;
    this.jobs = new Map();
  }

  get(chatId) {
    return this.jobs.get(chatId);
  }

  async start({ chatId, userId, space }) {
    await mkdir(root, { recursive: true });
    const job = new RecordingJob({ chatId, userId, space });
    this.jobs.set(chatId, job);

    const args = [
      '-hide_banner', '-loglevel', 'warning', '-y',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10',
      '-i', space.playlistUrl,
      '-vn', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
      job.output
    ];
    job.process = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    job.process.stderr.on('data', (chunk) => console.log(`[${job.id}] ${chunk}`));
    job.process.once('error', async (error) => {
      console.error('FFmpeg launch failed:', error);
      this.jobs.delete(chatId);
      await this.bot.api.sendMessage(chatId, `Recorder failed to launch: ${error.message}`);
    });
    job.process.once('close', async (code) => {
      this.jobs.delete(chatId);
      await this.finish(job, code);
    });
    return job;
  }

  async stop(chatId, cancel = false) {
    const job = this.jobs.get(chatId);
    if (!job) return;
    job.stopping = true;
    job.cancelled = cancel;
    job.process?.kill('SIGINT');
  }

  async finish(job, code) {
    if (job.cancelled) {
      await rm(job.output, { force: true });
      await this.bot.api.sendMessage(job.chatId, 'Recording cancelled and deleted.');
      return;
    }

    try {
      const info = await stat(job.output);
      if (!info.size) throw new Error('The output file is empty.');
      const sizeMb = info.size / 1024 / 1024;
      if (sizeMb > maxTelegramMb) {
        await this.bot.api.sendMessage(job.chatId, `Capture finished (${sizeMb.toFixed(1)} MB), but it exceeds this bot’s direct-upload limit of ${maxTelegramMb} MB. Add object storage later, or temporarily raise MAX_TELEGRAM_UPLOAD_MB if your Telegram bot account supports the larger upload.`);
        return;
      }
      await this.bot.api.sendAudio(job.chatId, createReadStream(job.output), {
        title: job.space.title,
        performer: 'X Space'
      });
      await this.bot.api.sendMessage(job.chatId, `Recording finalized. FFmpeg exited with code ${code ?? 'unknown'}.`);
    } catch (error) {
      console.error('Finalization failed:', error);
      await this.bot.api.sendMessage(job.chatId, `Capture ended, but I could not deliver the file: ${error.message}`);
    }
  }
}
