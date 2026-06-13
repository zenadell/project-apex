// agents/video.js
// APEX VideoAgent — Download YouTube videos, extract audio, transcribe, analyze frames.
// Can replicate ANY project shown in a video — coding tutorials, design walkthroughs, etc.

import { BaseAgent } from './base-agent.js';
import { complete, structured } from '../core/llm.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bus from '../core/event-bus.js';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIDEO_DIR = path.join(__dirname, '..', '.apex-data', 'videos');
if (!existsSync(VIDEO_DIR)) mkdirSync(VIDEO_DIR, { recursive: true });

export class VideoAgent extends BaseAgent {
  constructor() {
    super({
      name: 'VideoAgent',
      type: 'video',
      description: 'Downloads YouTube videos, transcribes audio with Whisper, extracts frames, and replicates any project shown in a video — coding tutorials, designs, builds.',
    });
  }

  async run(task) {
    const { action = 'analyze', url, videoPath } = task;
    switch (action) {
      case 'analyze':    return this.analyzeVideo(url || videoPath, task);
      case 'download':   return this.downloadYouTube(url, task.opts);
      case 'transcribe': return this.transcribe(videoPath || url, task.opts);
      case 'replicate':  return this.replicateFromVideo(url || videoPath, task);
      case 'extract':    return this.extractFrames(videoPath, task.interval);
      case 'summarize':  return this.summarize(url || videoPath);
      default:           return this.analyzeVideo(url || videoPath, task);
    }
  }

  // ── DOWNLOAD YOUTUBE ──────────────────────────────────────────────────────
  async downloadYouTube(url, opts = {}) {
    this.log(`Downloading: ${url}`);
    await this._ensureYtDlp();

    const outputTemplate = path.join(VIDEO_DIR, '%(title)s.%(ext)s');
    const quality = opts.quality || 'bestvideo[height<=720]+bestaudio/best[height<=720]';

    try {
      const { stdout } = await execAsync(
        `yt-dlp "${url}" -f "${quality}" -o "${outputTemplate}" --write-info-json --write-auto-subs --sub-lang en --convert-subs srt --no-playlist 2>&1`,
        { timeout: 300000 }
      );

      // Find downloaded file
      const files = readdirSync(VIDEO_DIR).filter(f => f.endsWith('.mp4') || f.endsWith('.webm') || f.endsWith('.mkv'));
      const newest = files.sort((a, b) => {
        const sa = require('fs').statSync(path.join(VIDEO_DIR, a)).mtime;
        const sb = require('fs').statSync(path.join(VIDEO_DIR, b)).mtime;
        return sb - sa;
      })[0];

      const videoPath = newest ? path.join(VIDEO_DIR, newest) : null;
      const srtPath = videoPath?.replace(/\.(mp4|webm|mkv)$/, '.en.srt');

      bus.emit('video:downloaded', { url, path: videoPath });
      return { videoPath, srtPath: existsSync(srtPath || '') ? srtPath : null, url };
    } catch (err) {
      throw new Error(`Download failed: ${err.message}`);
    }
  }

  // ── TRANSCRIBE AUDIO ──────────────────────────────────────────────────────
  async transcribe(source, opts = {}) {
    this.log(`Transcribing: ${source}`);

    // Check if it's a URL — download first
    let audioPath = source;
    if (source?.startsWith('http')) {
      const downloaded = await this.downloadYouTube(source);
      audioPath = downloaded.videoPath;

      // Check for existing SRT first
      if (downloaded.srtPath) {
        const { readFileSync } = await import('fs');
        const srtContent = readFileSync(downloaded.srtPath, 'utf8');
        return { transcript: this._parseSRT(srtContent), method: 'youtube-subtitles', source };
      }
    }

    // Try local Whisper
    try {
      await execAsync('which whisper', { timeout: 3000 });
      const model = opts.model || 'small';
      const { stdout } = await execAsync(
        `whisper "${audioPath}" --model ${model} --output_format txt --output_dir ${VIDEO_DIR}`,
        { timeout: 600000 }
      );
      const txtPath = audioPath.replace(/\.(mp4|webm|mkv|mp3|wav)$/, '.txt');
      if (existsSync(txtPath)) {
        const { readFileSync } = await import('fs');
        return { transcript: readFileSync(txtPath, 'utf8'), method: 'whisper-local', model };
      }
    } catch {}

    // Try OpenAI Whisper API
    if (process.env.OPENAI_API_KEY) {
      const axios = (await import('axios')).default;
      const { readFileSync } = await import('fs');
      const FormData = (await import('form-data')).default;
      const form = new FormData();
      form.append('file', readFileSync(audioPath), path.basename(audioPath));
      form.append('model', 'whisper-1');

      const resp = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
        headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        timeout: 120000,
      });
      return { transcript: resp.data.text, method: 'openai-whisper' };
    }

    throw new Error('No transcription method available. Install: pip3 install openai-whisper');
  }

  // ── EXTRACT KEY FRAMES ────────────────────────────────────────────────────
  async extractFrames(videoPath, interval = 5) {
    this.log(`Extracting frames every ${interval}s from ${videoPath}`);
    const framesDir = path.join(VIDEO_DIR, `frames-${Date.now()}`);
    mkdirSync(framesDir, { recursive: true });

    try {
      await execAsync(
        `ffmpeg -i "${videoPath}" -vf "fps=1/${interval}" "${framesDir}/frame-%04d.jpg" -y`,
        { timeout: 120000 }
      );
      const frames = readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
      return { framesDir, frames: frames.map(f => path.join(framesDir, f)), count: frames.length };
    } catch (err) {
      throw new Error(`Frame extraction failed — is ffmpeg installed? ${err.message}`);
    }
  }

  // ── ANALYZE VIDEO ─────────────────────────────────────────────────────────
  async analyzeVideo(source, opts = {}) {
    this.log(`Analyzing video: ${source}`);
    const analysis = { source, type: null, content: null, replicatable: false };

    // Step 1: Get transcript
    let transcript = '';
    try {
      const trans = await this.transcribe(source, opts);
      transcript = trans.transcript;
      analysis.transcript = transcript.slice(0, 3000);
    } catch (err) {
      this.log(`Transcription unavailable: ${err.message}`, 'warn');
    }

    // Step 2: Analyze content
    analysis.content = await structured(
      `Analyze this video transcript and identify what it's about.\n\nTranscript (first 3000 chars):\n${transcript.slice(0, 3000)}\n\nURL/Path: ${source}`,
      {
        type: 'coding-tutorial/design-walkthrough/product-demo/lecture/other',
        title: 'video title or description',
        mainTopic: 'what the video is primarily about',
        technologiesUsed: ['tech stack shown or mentioned'],
        projectType: 'what kind of project is built/shown',
        replicatable: true,
        complexity: 'simple/medium/complex',
        estimatedBuildTime: 'time to replicate',
        keySteps: ['main steps or concepts covered'],
      },
      { temperature: 0.3 }
    );

    analysis.replicatable = analysis.content?.replicatable || false;
    return analysis;
  }

  // ── REPLICATE PROJECT FROM VIDEO ──────────────────────────────────────────
  async replicateFromVideo(source, opts = {}) {
    this.log(`Replicating project from: ${source}`);

    // Step 1: Get full transcript
    const { transcript } = await this.transcribe(source, opts);
    this.log(`Transcript length: ${transcript.length} chars`);

    // Step 2: Extract frames for visual context
    let frames = [];
    if (!source.startsWith('http')) {
      try {
        const extracted = await this.extractFrames(source, 10);
        frames = extracted.frames.slice(0, 10);
      } catch {}
    }

    // Step 3: Parse the tutorial into steps
    const steps = await structured(
      `Parse this video transcript into actionable replication steps.\n\nTranscript:\n${transcript.slice(0, 8000)}\n\nExtract every step needed to replicate what's shown in the video.`,
      {
        projectName: 'name of the project',
        projectType: 'web app/CLI tool/API/design/etc',
        techStack: ['technologies used'],
        steps: [{
          stepNumber: 1,
          title: 'step title',
          action: 'what to do',
          code: 'any code mentioned or implied',
          commands: ['terminal commands to run'],
          filesCreated: ['files created in this step'],
        }],
        finalResult: 'what the finished project does',
        deploymentNotes: 'how to run/deploy it',
      },
      { temperature: 0.2 }
    );

    this.log(`Parsed ${steps.steps?.length} replication steps`);

    // Step 4: Execute replication
    const registry = (await import('../core/agent-registry.js')).default;
    const codeAgent = registry.get('CodeAgent');

    const replication = await codeAgent._handleTask({
      id: `replicate-${Date.now()}`,
      objective: `Replicate this project from a video tutorial: ${steps.projectName}. Tech stack: ${steps.techStack?.join(', ')}. ${steps.finalResult}`,
      context: `Step-by-step guide from video:\n${JSON.stringify(steps.steps, null, 2).slice(0, 5000)}`,
      outputDir: opts.outputDir || path.join(process.cwd(), `apex-replicated-${Date.now()}`),
      type: 'replicate',
    });

    this.remember(
      `Replicated: ${steps.projectName} from video | Tech: ${steps.techStack?.join(', ')}`,
      { tags: ['video', 'replicate', steps.projectType], importance: 8 }
    );

    return {
      source, projectName: steps.projectName, techStack: steps.techStack,
      steps: steps.steps?.length, replication, finalResult: steps.finalResult,
    };
  }

  // ── SUMMARIZE VIDEO ───────────────────────────────────────────────────────
  async summarize(source) {
    const { transcript } = await this.transcribe(source);
    return complete(
      `Summarize this video transcript in 3-5 bullet points:\n\n${transcript.slice(0, 5000)}`,
      { temperature: 0.3, maxTokens: 500 }
    );
  }

  // ── HELPERS ───────────────────────────────────────────────────────────────
  async _ensureYtDlp() {
    try {
      await execAsync('which yt-dlp', { timeout: 3000 });
    } catch {
      this.log('Installing yt-dlp...');
      await execAsync('pip3 install yt-dlp --quiet', { timeout: 120000 });
    }
  }

  _parseSRT(srtContent) {
    return srtContent
      .replace(/\d+\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\n/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\n\n/g, ' ')
      .trim();
  }
}

export default VideoAgent;
