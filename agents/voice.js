// agents/voice.js
// APEX VoiceAgent — Text-to-speech and speech recognition.
// Uses ElevenLabs if key is available, falls back to open-source Kokoro/edge-tts.
import { BaseAgent } from './base-agent.js';
import { complete } from '../core/llm.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = path.join(__dirname, '..', '.apex-audio');
if (!existsSync(AUDIO_DIR)) mkdirSync(AUDIO_DIR, { recursive: true });

export class VoiceAgent extends BaseAgent {
  constructor() {
    super({
      name: 'VoiceAgent',
      type: 'voice',
      description: 'Converts text to speech and transcribes audio. Uses ElevenLabs (if key provided), edge-tts, or espeak. Can voice any APEX response.',
    });
    this._provider = this._detectProvider();
    this._providerStatus = {
      elevenlabs: { failures: 0, lastError: null },
      'edge-tts': { failures: 0, lastError: null },
      espeak: { failures: 0, lastError: null }
    };
  }

  // Update logic: If provider fails 3 times, demote it
  _isProviderHealthy(provider) {
    return this._providerStatus[provider]?.failures < 3;
  }

  async run(task) {
    const { text, action = 'speak', audioPath = null, sendToChannel = false } = task;

    if (action === 'speak_and_send') {
      const generated = await this.speak(text || 'Hello from APEX', { sendToChannel });
      return {
        audioPath: generated.path,
        text: text?.slice(0, 100),
        sendable: true,
        provider: generated.provider,
      };
    }

    if (action === 'speak' || action === 'tts') {
      return this.speak(text);
    }
    if (action === 'transcribe') {
      return this.transcribe(audioPath);
    }
    if (action === 'status') {
      return { provider: this._provider, audioDir: AUDIO_DIR };
    }

    return this.speak(text);
  }

  // Speak text using best available provider
  async speak(text, opts = {}) {
    // Autonomous natural language conversion
    try {
      const { complete } = await import('../core/llm.js');
      const prompt = `The system is trying to speak the following text to the user. If it looks like a raw task plan, code, file paths, or JSON, convert it into a very short, natural, conversational spoken response (1-2 sentences max). Do not include any markdown, emojis, or code blocks in the output. If it is already conversational, just return it exactly as is. Text to speak:\n\n${text}`;
      text = await complete(prompt, { temperature: 0.3 });
      text = text.replace(/[*_#]/g, '').trim(); // Strip residual markdown
    } catch (e) {
      this.log(`Failed to make text conversational: ${e.message}`, 'warn');
    }

    this.log(`Speaking (${this._provider}): "${text.slice(0, 60)}..."`);

    const outputPath = path.join(AUDIO_DIR, `apex-speech-${Date.now()}.mp3`);

    try {
      // Check if current provider was blacklisted
      if (!this._isProviderHealthy(this._provider)) {
        this.log(`Primary provider ${this._provider} is unhealthy. Switching to autonomous failover...`);
        return this._fallbackSpeak(text, outputPath);
      }

      switch (this._provider) {
        case 'elevenlabs':
          await this._elevenLabsTTS(text, outputPath, opts);
          break;
        case 'edge-tts':
          await this._edgeTTS(text, outputPath, opts);
          break;
        case 'espeak':
          await this._espeakTTS(text, outputPath);
          break;
        default:
          await this._fallbackTTS(text, outputPath);
      }

      await this._playAudio(outputPath);

      // Success - reset failure count
      if (this._providerStatus[this._provider]) {
        this._providerStatus[this._provider].failures = 0;
      }

      this.remember(`Spoke: "${text.slice(0, 80)}"`, { tags: ['voice', 'tts'], importance: 3 });
      return { success: true, path: outputPath, provider: this._provider };
    } catch (err) {
      this.log(`TTS failed with ${this._provider}: ${err.message}`, 'warn');
      
      // Update failure status
      if (this._providerStatus[this._provider]) {
        this._providerStatus[this._provider].failures++;
        this._providerStatus[this._provider].lastError = err.message;
      }

      bus.emit('voice:provider_failure', { 
        provider: this._provider, 
        error: err.message,
        isFatal: this._providerStatus[this._provider]?.failures >= 3
      });

      // Auto-escalate to next provider
      return this._fallbackSpeak(text, outputPath);
    }
  }

  // Transcribe audio using Whisper (if available) or API
  async transcribe(audioPath) {
    this.log(`Transcribing: ${audioPath}`);
    try {
      // Try local Whisper first (free, offline)
      const { stdout } = await execAsync(`whisper "${audioPath}" --model tiny --output_format txt`, { timeout: 60000 });
      return { success: true, text: stdout.trim(), provider: 'whisper-local' };
    } catch {
      // Try OpenAI Whisper API
      if (process.env.OPENAI_API_KEY) {
        return this._openaiTranscribe(audioPath);
      }
      return { success: false, error: 'No transcription provider available. Install: pip install openai-whisper' };
    }
  }

  async _elevenLabsTTS(text, outputPath, opts = {}) {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = opts.voiceId || process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Rachel

    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
      },
      {
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        responseType: 'arraybuffer',
        timeout: 30000,
      }
    );

    writeFileSync(outputPath, Buffer.from(response.data));
    // Wait a tiny bit for disk sync
    await new Promise(r => setTimeout(r, 100));
  }

  async _edgeTTS(text, outputPath, opts = {}) {
    const voice = opts.voice || 'en-US-AriaNeural';
    const ttsPath = this._edgeTTSPath || 'edge-tts';
    // edge-tts is a free Python package that uses Microsoft's TTS
    await execAsync(`${ttsPath} --text "${text.replace(/"/g, "'")}" --voice ${voice} --write-media "${outputPath}"`, {
      timeout: 30000,
    });
  }

  async _espeakTTS(text, outputPath) {
    // espeak — lowest quality but always available on Linux
    const wavPath = outputPath.replace('.mp3', '.wav');
    await execAsync(`espeak -w "${wavPath}" "${text.replace(/"/g, "'")}"`, { timeout: 10000 });
    // Convert to mp3 if ffmpeg available
    try {
      await execAsync(`ffmpeg -i "${wavPath}" "${outputPath}" -y`, { timeout: 10000 });
    } catch {
      // Return wav if no ffmpeg
      return wavPath;
    }
  }

  async _fallbackTTS(text, outputPath) {
    // Last resort: generate a simple audio notification + print text
    this.log(`Audio not available. Text: ${text}`, 'warn');
    try {
      await execAsync(`echo "${text.replace(/"/g, "'")}" | festival --tts`, { timeout: 10000 });
    } catch {
      console.log(`[APEX Voice] ${text}`);
    }
  }

  async _fallbackSpeak(text, outputPath) {
    const fallbacks = ['edge-tts', 'espeak', 'festival'];
    for (const fb of fallbacks) {
      if (fb === this._provider) continue;
      try {
        if (fb === 'edge-tts') await this._edgeTTS(text, outputPath);
        if (fb === 'espeak') await this._espeakTTS(text, outputPath);
        await this._playAudio(outputPath);
        return { success: true, path: outputPath, provider: fb };
      } catch {}
    }
    return { success: false, error: 'All TTS providers failed' };
  }

  async _playAudio(audioPath) {
    // Try different audio players
    const players = ['mpg123', 'mpv', 'ffplay -nodisp -autoexit', 'aplay', 'afplay'];
    for (const player of players) {
      try {
        await execAsync(`${player} "${audioPath}" 2>/dev/null`, { timeout: 30000 });
        return;
      } catch {}
    }
    // If no player found, just return (file is saved)
    this.log(`Audio saved to ${audioPath} (no audio player found)`, 'warn');
  }

  async _openaiTranscribe(audioPath) {
    const formData = new FormData();
    const { readFileSync } = await import('fs');
    const file = new Blob([readFileSync(audioPath)]);
    formData.append('file', file, path.basename(audioPath));
    formData.append('model', 'whisper-1');

    const resp = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'multipart/form-data',
      },
    });
    return { success: true, text: resp.data.text, provider: 'openai-whisper' };
  }

  _detectProvider() {
    if (process.env.ELEVENLABS_API_KEY) return 'elevenlabs';
    // Check if edge-tts is installed (including common mac user paths)
    const paths = ['edge-tts', '/Users/mac/Library/Python/3.9/bin/edge-tts', '/usr/local/bin/edge-tts', '/opt/homebrew/bin/edge-tts'];
    for (const p of paths) {
      try {
        require('child_process').execSync(`which ${p} || ls ${p}`, { stdio: 'pipe' });
        this._edgeTTSPath = p;
        return 'edge-tts';
      } catch {}
    }
    // Check espeak
    try {
      require('child_process').execSync('which espeak', { stdio: 'pipe' });
      return 'espeak';
    } catch {}
    return 'fallback';
  }

  // Install the best available TTS
  async selfInstall() {
    this.log('Installing best available TTS provider...');
    try {
      // edge-tts is free, high quality, Microsoft voices
      await execAsync('pip3 install edge-tts --quiet', { timeout: 60000 });
      this._provider = 'edge-tts';
      this.log('✅ edge-tts installed (Microsoft Neural TTS)');
      return { provider: 'edge-tts', quality: 'high' };
    } catch {
      try {
        await execAsync('apt-get install -y espeak 2>/dev/null || brew install espeak 2>/dev/null', { timeout: 30000 });
        this._provider = 'espeak';
        this.log('✅ espeak installed (basic TTS)');
        return { provider: 'espeak', quality: 'basic' };
      } catch {
        return { provider: 'none', error: 'Could not install any TTS' };
      }
    }
  }
}

export default VoiceAgent;
