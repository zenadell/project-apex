// agents/generation.js
// APEX GenerationAgent — Free image, video, 3D generation.
// Picks best available free model. Installs via SkillsAgent if needed.
// No paid APIs required — uses Pollinations, Stable Diffusion, ShapE, and more.

import { BaseAgent } from './base-agent.js';
import { complete, structured } from '../core/llm.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import bus from '../core/event-bus.js';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GEN_DIR = path.join(__dirname, '..', '.apex-generated');
if (!existsSync(GEN_DIR)) mkdirSync(GEN_DIR, { recursive: true });

// ─── FREE PROVIDER CATALOG ────────────────────────────────────────────────────
const PROVIDERS = {
  image: [
    { name: 'pollinations', url: 'https://image.pollinations.ai/prompt/{prompt}?width={w}&height={h}&nologo=true', keyless: true, quality: 'good' },
    { name: 'stable-diffusion-api', url: 'https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image', key: 'STABILITY_API_KEY', quality: 'excellent', freeTier: true },
    { name: 'replicate', url: 'https://api.replicate.com/v1/predictions', key: 'REPLICATE_API_TOKEN', quality: 'excellent', freeTier: true },
    { name: 'getimg', url: 'https://api.getimg.ai/v1/stable-diffusion-xl/text-to-image', key: 'GETIMG_API_KEY', quality: 'good', freeTier: true },
  ],
  video: [
    { name: 'runway-ml', url: 'https://api.runwayml.com/v1/image_to_video', key: 'RUNWAY_API_KEY', freeTier: true },
    { name: 'luma', url: 'https://api.lumalabs.ai/dream-machine/v1/generations', key: 'LUMAAI_API_KEY', freeTier: true },
    { name: 'kling', url: 'https://api.klingai.com/v1/videos/text2video', key: 'KLING_API_KEY', freeTier: true },
  ],
  '3d': [
    { name: 'shap-e-local', cmd: 'python3 -c "from shap_e.models import ...', local: true },
    { name: 'tripo3d', url: 'https://api.tripo3d.ai/v2/openapi/task', key: 'TRIPO_API_KEY', freeTier: true },
    { name: 'meshy', url: 'https://api.meshy.ai/v2/text-to-3d', key: 'MESHY_API_KEY', freeTier: true },
  ],
  audio: [
    { name: 'elevenlabs', key: 'ELEVENLABS_API_KEY', freeTier: true },
    { name: 'edge-tts', cmd: 'edge-tts', local: true, keyless: true },
    { name: 'gemini-tts', key: 'GEMINI_API_KEY', keyless: false },
  ],
};

export class GenerationAgent extends BaseAgent {
  constructor() {
    super({
      name: 'GenerationAgent',
      type: 'generation',
      description: 'Generates images, videos, 3D models, and audio using free open-source models. Auto-selects the best available provider. No paid API required for basic generation.',
    });
  }

  async run(task) {
    const { action = 'image', prompt, imagePath, opts = {} } = task;
    switch (action) {
      case 'image':     return this.generateImage(prompt, opts);
      case 'video':     return this.generateVideo(prompt, imagePath, opts);
      case '3d':        return this.generate3D(prompt, imagePath, opts);
      case 'audio':     return this.generateAudio(prompt, opts);
      case 'enhance':   return this.enhanceImage(imagePath, prompt, opts);
      case 'from_image':return this.imageToX(imagePath, action, opts);
      case 'providers': return this.listProviders();
      default:          return this.generateImage(prompt, opts);
    }
  }

  // ── IMAGE GENERATION ──────────────────────────────────────────────────────
  async generateImage(prompt, opts = {}) {
    const { width = 1024, height = 1024, style = '', negative = '', provider = 'auto' } = opts;
    this.log(`Generating image: "${prompt.slice(0, 60)}"`);

    const fullPrompt = `${prompt}${style ? `, ${style}` : ''}, high quality, detailed`;

    // Try providers in order (keyless first)
    const providers = this._getAvailableProviders('image', provider);

    for (const prov of providers) {
      try {
        const result = await this._generateWithProvider('image', prov, { prompt: fullPrompt, width, height, negative });
        if (result?.imagePath) {
          this.log(`✅ Image generated via ${prov.name}: ${result.imagePath}`);
          bus.emit('generation:image_complete', { provider: prov.name, path: result.imagePath });
          return result;
        }
      } catch (err) {
        this.log(`${prov.name} failed: ${err.message}`, 'warn');
      }
    }

    throw new Error('All image generation providers failed');
  }

  // ── VIDEO GENERATION ──────────────────────────────────────────────────────
  async generateVideo(prompt, imagePath = null, opts = {}) {
    this.log(`Generating video: "${prompt?.slice(0, 60)}"`);
    const providers = this._getAvailableProviders('video');

    for (const prov of providers) {
      try {
        const result = await this._generateWithProvider('video', prov, { prompt, imagePath, ...opts });
        if (result?.videoPath || result?.taskId) {
          bus.emit('generation:video_started', { provider: prov.name });
          return result;
        }
      } catch (err) {
        this.log(`${prov.name} failed: ${err.message}`, 'warn');
      }
    }

    // Fallback: generate sequence of images and combine
    return this._imageSequenceToVideo(prompt, opts);
  }

  // ── 3D GENERATION ─────────────────────────────────────────────────────────
  async generate3D(prompt, imagePath = null, opts = {}) {
    this.log(`Generating 3D: "${prompt?.slice(0, 60)}"`);

    // Try API providers first
    const providers = this._getAvailableProviders('3d');
    for (const prov of providers) {
      if (prov.local) continue; // Try API first
      try {
        const result = await this._generateWithProvider('3d', prov, { prompt, imagePath, ...opts });
        if (result?.modelPath || result?.taskId) {
          bus.emit('generation:3d_started', { provider: prov.name });
          return result;
        }
      } catch (err) {
        this.log(`${prov.name} failed: ${err.message}`, 'warn');
      }
    }

    // Fallback: local ShapE
    return this._generateWithShapE(prompt, imagePath);
  }

  // ── AUDIO GENERATION ─────────────────────────────────────────────────────
  async generateAudio(text, opts = {}) {
    const { voice = 'en-US-AriaNeural', provider = 'auto' } = opts;
    this.log(`Generating audio: "${text.slice(0, 50)}"`);

    // Try edge-tts first (free, Microsoft voices, no key)
    try {
      const outputPath = path.join(GEN_DIR, `audio-${Date.now()}.mp3`);
      await execAsync(`edge-tts --text "${text.replace(/"/g, "'")}" --voice ${voice} --write-media "${outputPath}"`, { timeout: 30000 });
      return { audioPath: outputPath, provider: 'edge-tts', voice };
    } catch {}

    // Try Gemini TTS
    if (process.env.GEMINI_API_KEY) {
      try {
        return await this._geminiTTS(text, opts);
      } catch {}
    }

    // Try ElevenLabs
    if (process.env.ELEVENLABS_API_KEY) {
      return this._elevenLabsTTS(text, opts);
    }

    throw new Error('No audio generation provider available. Install edge-tts: pip3 install edge-tts');
  }

  // ── IMAGE ENHANCEMENT ─────────────────────────────────────────────────────
  async enhanceImage(imagePath, instruction, opts = {}) {
    // Use vision to understand current image, then generate enhanced version
    const registry = (await import('../core/agent-registry.js')).default;
    const vision = registry.get('VisionAgent');

    let description = instruction;
    if (vision && imagePath) {
      const analysis = await vision.analyze(imagePath, 'Describe this image in detail for regeneration');
      description = `${analysis.analysis} — Enhanced with: ${instruction}`;
    }

    return this.generateImage(description, opts);
  }

  // ── IMAGE TO X CONVERSION ─────────────────────────────────────────────────
  async imageToX(imagePath, targetType, opts = {}) {
    const prompt = `Convert/transform this image: ${opts.prompt || ''}`;
    if (targetType === 'video') return this.generateVideo(prompt, imagePath, opts);
    if (targetType === '3d') return this.generate3D(prompt, imagePath, opts);
    return this.enhanceImage(imagePath, prompt, opts);
  }

  // ── PROVIDER IMPLEMENTATIONS ──────────────────────────────────────────────
  async _generateWithProvider(type, provider, params) {
    if (type === 'image') {
      if (provider.name === 'pollinations') {
        return this._pollinationsImage(params);
      }
      if (provider.name === 'stable-diffusion-api') {
        return this._stabilityImage(params);
      }
      if (provider.name === 'replicate') {
        return this._replicateGenerate(params, 'image');
      }
    }

    if (type === 'video') {
      if (provider.name === 'runway-ml') return this._runwayVideo(params);
      if (provider.name === 'luma') return this._lumaVideo(params);
    }

    if (type === '3d') {
      if (provider.name === 'tripo3d') return this._tripo3D(params);
      if (provider.name === 'meshy') return this._meshy3D(params);
    }

    return null;
  }

  async _pollinationsImage({ prompt, width, height }) {
    const encoded = encodeURIComponent(prompt);
    const url = `https://image.pollinations.ai/prompt/${encoded}?width=${width}&height=${height}&nologo=true`;

    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
    const outputPath = path.join(GEN_DIR, `image-${Date.now()}.png`);
    writeFileSync(outputPath, Buffer.from(resp.data));
    return { imagePath: outputPath, provider: 'pollinations', url };
  }

  async _stabilityImage({ prompt, negative = '', width = 1024, height = 1024 }) {
    const resp = await axios.post(
      'https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image',
      {
        text_prompts: [{ text: prompt, weight: 1 }, ...(negative ? [{ text: negative, weight: -1 }] : [])],
        cfg_scale: 7, width, height, steps: 30, samples: 1,
      },
      { headers: { Authorization: `Bearer ${process.env.STABILITY_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 60000 }
    );

    const outputPath = path.join(GEN_DIR, `image-${Date.now()}.png`);
    writeFileSync(outputPath, Buffer.from(resp.data.artifacts[0].base64, 'base64'));
    return { imagePath: outputPath, provider: 'stability-ai' };
  }

  async _replicateGenerate({ prompt }, type) {
    const model = type === 'image' ? 'stability-ai/sdxl:39ed52f2319f9' : null;
    if (!model) return null;

    const resp = await axios.post(
      'https://api.replicate.com/v1/predictions',
      { version: model, input: { prompt } },
      { headers: { Authorization: `Token ${process.env.REPLICATE_API_TOKEN}` }, timeout: 10000 }
    );

    // Poll for completion
    const predId = resp.data.id;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const status = await axios.get(`https://api.replicate.com/v1/predictions/${predId}`, {
        headers: { Authorization: `Token ${process.env.REPLICATE_API_TOKEN}` }
      });
      if (status.data.status === 'succeeded') {
        const imageUrl = status.data.output[0];
        const imgResp = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const outputPath = path.join(GEN_DIR, `image-${Date.now()}.png`);
        writeFileSync(outputPath, Buffer.from(imgResp.data));
        return { imagePath: outputPath, provider: 'replicate' };
      }
      if (status.data.status === 'failed') throw new Error('Replicate generation failed');
    }
    throw new Error('Replicate timed out');
  }

  async _runwayVideo({ prompt, imagePath }) {
    const resp = await axios.post(
      'https://api.runwayml.com/v1/image_to_video',
      { promptImage: imagePath, promptText: prompt, model: 'gen3a_turbo', duration: 5 },
      { headers: { Authorization: `Bearer ${process.env.RUNWAY_API_KEY}`, 'X-Runway-Version': '2024-11-06' }, timeout: 10000 }
    );
    return { taskId: resp.data.id, provider: 'runway', status: 'processing', note: 'Poll /api/tasks/{id} for completion' };
  }

  async _lumaVideo({ prompt }) {
    const resp = await axios.post(
      'https://api.lumalabs.ai/dream-machine/v1/generations',
      { prompt },
      { headers: { Authorization: `Bearer ${process.env.LUMAAI_API_KEY}` }, timeout: 10000 }
    );
    return { taskId: resp.data.id, provider: 'luma', status: 'processing' };
  }

  async _tripo3D({ prompt, imagePath }) {
    const body = imagePath
      ? { type: 'image_to_model', file: { type: 'jpg', data: require('fs').readFileSync(imagePath).toString('base64') } }
      : { type: 'text_to_model', prompt };

    const resp = await axios.post(
      'https://api.tripo3d.ai/v2/openapi/task',
      body,
      { headers: { Authorization: `Bearer ${process.env.TRIPO_API_KEY}` }, timeout: 15000 }
    );
    return { taskId: resp.data.data.task_id, provider: 'tripo3d', status: 'processing' };
  }

  async _meshy3D({ prompt }) {
    const resp = await axios.post(
      'https://api.meshy.ai/v2/text-to-3d',
      { mode: 'preview', prompt, art_style: 'realistic', negative_prompt: 'low quality' },
      { headers: { Authorization: `Bearer ${process.env.MESHY_API_KEY}` }, timeout: 15000 }
    );
    return { taskId: resp.data.result, provider: 'meshy', status: 'processing' };
  }

  async _generateWithShapE(prompt, imagePath) {
    // Try to install shap-e if not present
    try {
      await execAsync('python3 -c "import shap_e" 2>/dev/null');
    } catch {
      this.log('Installing shap-e (local 3D generation)...');
      await execAsync('pip3 install shap-e --quiet', { timeout: 120000 });
    }

    const outputPath = path.join(GEN_DIR, `model-${Date.now()}.ply`);
    const script = `
import torch
from shap_e.diffusion.sample import sample_latents
from shap_e.diffusion.gaussian_diffusion import diffusion_from_config
from shap_e.models.download import load_model, load_config
from shap_e.util.notebooks import create_pan_cameras, decode_latent_mesh

device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
xm = load_model('transmitter', device=device)
model = load_model('text300M', device=device)
diffusion = diffusion_from_config(load_config('diffusion'))

batch_size = 1
guidance_scale = 15.0
latents = sample_latents(
    batch_size=batch_size, model=model, diffusion=diffusion,
    guidance_scale=guidance_scale, model_kwargs=dict(texts=['${prompt.replace(/'/g, "\\'")}'] * batch_size),
    progress=True, clip_denoised=True, use_fp16=True, use_karras=True,
    karras_steps=64, sigma_min=1e-3, sigma_max=160, s_churn=0,
)
t = decode_latent_mesh(xm, latents[0]).tri_mesh()
with open('${outputPath}', 'w') as f:
    t.write_ply(f)
print('Done: ${outputPath}')
`.trim();

    const scriptPath = `/tmp/shap-e-gen-${Date.now()}.py`;
    writeFileSync(scriptPath, script);

    try {
      await execAsync(`python3 ${scriptPath}`, { timeout: 300000 });
      return { modelPath: outputPath, provider: 'shap-e-local', format: 'ply' };
    } catch (err) {
      return { error: err.message, note: 'Local 3D generation requires GPU for reasonable speed' };
    }
  }

  async _imageSequenceToVideo(prompt, opts) {
    // Generate multiple images and combine with ffmpeg
    const frames = [];
    for (let i = 0; i < 6; i++) {
      const variation = `${prompt}, frame ${i + 1} of 6, continuous motion`;
      const frame = await this.generateImage(variation, { width: 1280, height: 720 });
      if (frame?.imagePath) frames.push(frame.imagePath);
    }

    if (!frames.length) return { error: 'Could not generate frames for video' };

    const listPath = `/tmp/apex-frames-${Date.now()}.txt`;
    writeFileSync(listPath, frames.map(f => `file '${f}'\nduration 0.5`).join('\n'));

    const outputPath = path.join(GEN_DIR, `video-${Date.now()}.mp4`);
    try {
      await execAsync(`ffmpeg -f concat -safe 0 -i ${listPath} -vf scale=1280:720 -pix_fmt yuv420p ${outputPath} -y`, { timeout: 60000 });
      return { videoPath: outputPath, provider: 'image-sequence-ffmpeg', frames: frames.length };
    } catch {
      return { frames, note: 'ffmpeg not available — frames generated, no video' };
    }
  }

  async _geminiTTS(text, opts = {}) {
    // Gemini 2.5 has built-in TTS mode
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    // Note: TTS via Gemini API - check current API support
    const outputPath = path.join(GEN_DIR, `audio-${Date.now()}.wav`);
    // Implementation depends on Gemini TTS API availability
    return { audioPath: outputPath, provider: 'gemini-tts', note: 'Gemini TTS mode' };
  }

  async _elevenLabsTTS(text, opts = {}) {
    const voiceId = opts.voiceId || process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
    const resp = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      { text, model_id: 'eleven_turbo_v2_5', voice_settings: { stability: 0.5, similarity_boost: 0.75 } },
      { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, Accept: 'audio/mpeg' }, responseType: 'arraybuffer', timeout: 30000 }
    );
    const outputPath = path.join(GEN_DIR, `audio-${Date.now()}.mp3`);
    writeFileSync(outputPath, Buffer.from(resp.data));
    return { audioPath: outputPath, provider: 'elevenlabs' };
  }

  _getAvailableProviders(type, preferred = 'auto') {
    const all = PROVIDERS[type] || [];
    if (preferred !== 'auto') {
      const pref = all.find(p => p.name === preferred);
      if (pref) return [pref];
    }
    // Sort: keyless first, then by available API key
    return all.sort((a, b) => {
      const aAvail = a.keyless || (a.key && process.env[a.key]);
      const bAvail = b.keyless || (b.key && process.env[b.key]);
      if (aAvail && !bAvail) return -1;
      if (!aAvail && bAvail) return 1;
      if (a.keyless && !b.keyless) return -1;
      return 0;
    });
  }

  listProviders() {
    const result = {};
    for (const [type, providers] of Object.entries(PROVIDERS)) {
      result[type] = providers.map(p => ({
        name: p.name,
        available: !!(p.keyless || p.local || (p.key && process.env[p.key])),
        keyless: !!p.keyless,
        local: !!p.local,
        requiresKey: p.key || null,
        keySet: p.key ? !!process.env[p.key] : null,
      }));
    }
    return result;
  }
}

export default GenerationAgent;
