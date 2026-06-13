// agents/blender.js
// APEX BlenderAgent — Creates 3D models, animations, renders via Blender Python API.
// Writes bpy scripts, launches Blender in background mode, exports results.
// Self-researches and installs Blender if not present.

import { BaseAgent } from './base-agent.js';
import { complete, structured } from '../core/llm.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bus from '../core/event-bus.js';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BLENDER_DIR = path.join(__dirname, '..', '.apex-data', 'blender');
if (!existsSync(BLENDER_DIR)) mkdirSync(BLENDER_DIR, { recursive: true });

export class BlenderAgent extends BaseAgent {
  constructor() {
    super({
      name: 'BlenderAgent',
      type: '3d_modeling',
      description: 'Creates 3D models, animations, and renders using Blender Python API. Can build any 3D object from text description or image reference. Exports GLB, OBJ, STL, FBX, PNG.',
    });
    this._blenderPath = null;
  }

  async run(task) {
    const { action = 'create', prompt, imagePath, opts = {} } = task;
    switch (action) {
      case 'create':    return this.create3D(prompt, imagePath, opts);
      case 'render':    return this.render(task.blendFile, opts);
      case 'animate':   return this.animate(prompt, opts);
      case 'script':    return this.runScript(task.script, opts);
      case 'install':   return this.ensureBlender();
      case 'status':    return this.status();
      default:          return this.create3D(prompt, imagePath, opts);
    }
  }

  // ── CREATE 3D FROM DESCRIPTION OR IMAGE ──────────────────────────────────
  async create3D(prompt, imagePath = null, opts = {}) {
    this.log(`Creating 3D: "${prompt?.slice(0, 60)}"`);

    const blenderPath = await this.ensureBlender();
    if (!blenderPath) {
      // Fallback to ShapE via GenerationAgent
      const registry = (await import('../core/agent-registry.js')).default;
      const gen = registry.get('GenerationAgent');
      if (gen) return gen._handleTask({ id: 'blender-fallback', action: '3d', prompt, imagePath });
      return { error: 'Blender not available and no fallback generation agent' };
    }

    // Analyze image if provided
    let imageDescription = '';
    if (imagePath) {
      const registry = (await import('../core/agent-registry.js')).default;
      const vision = registry.get('VisionAgent');
      if (vision) {
        const analysis = await vision.analyze(imagePath, 'Describe the 3D shape, geometry, proportions, materials, and colors of the main object in detail.');
        imageDescription = analysis.analysis;
      }
    }

    // Generate Blender Python script
    const script = await this._generateBlenderScript(prompt, imageDescription, opts);
    const scriptPath = path.join(BLENDER_DIR, `script-${Date.now()}.py`);
    writeFileSync(scriptPath, script);

    // Run in background mode
    const outputPath = path.join(BLENDER_DIR, `model-${Date.now()}`);
    const exportFormat = opts.format || 'glb';

    try {
      const { stdout, stderr } = await execAsync(
        `"${blenderPath}" --background --python "${scriptPath}" -- --output "${outputPath}.${exportFormat}"`,
        { timeout: 300000 }
      );

      const resultPath = `${outputPath}.${exportFormat}`;
      const renderPath = `${outputPath}.png`;

      bus.emit('blender:created', { prompt, path: resultPath });
      this.remember(`Created 3D: ${prompt} → ${resultPath}`, { tags: ['3d', 'blender'], importance: 7 });

      return {
        success: true,
        modelPath: existsSync(resultPath) ? resultPath : null,
        renderPath: existsSync(renderPath) ? renderPath : null,
        script: scriptPath,
        format: exportFormat,
        prompt,
      };
    } catch (err) {
      return { success: false, error: err.message, script: scriptPath };
    }
  }

  // ── GENERATE BLENDER PYTHON SCRIPT ────────────────────────────────────────
  async _generateBlenderScript(prompt, imageDescription, opts = {}) {
    const {
      format = 'glb',
      renderEngine = 'EEVEE',
      resolution = [1920, 1080],
      includeRender = true,
    } = opts;

    const description = imageDescription || prompt;

    return complete(
      `Write a complete Blender Python (bpy) script that creates a 3D model from this description:\n\n"${description}"\n\nThe script must:\n1. Import bpy at the start\n2. Clear the default scene (delete cube, light, camera)\n3. Create the 3D model using Blender's Python API\n4. Add appropriate materials and colors\n5. Set up lighting (3-point lighting minimum)\n6. Add a camera with good framing\n7. ${includeRender ? `Render to PNG at ${resolution[0]}x${resolution[1]} using ${renderEngine}` : 'Skip rendering'}\n8. Export to ${format.toUpperCase()} format\n9. Accept --output argument via sys.argv for the output path\n\nUse these bpy techniques:\n- Primitive meshes (bpy.ops.mesh.primitive_*)\n- Modifiers (subdivision, boolean, solidify)\n- Materials with nodes (Principled BSDF)\n- Proper UV unwrapping if needed\n- Collections for organization\n\nDo NOT use external assets or imports beyond bpy and sys.\nMake it production-quality — this will run headlessly.\n\nReturn ONLY the Python code.`,
      { temperature: 0.2, maxTokens: 4000 }
    );
  }

  // ── RENDER EXISTING .BLEND FILE ───────────────────────────────────────────
  async render(blendFile, opts = {}) {
    const blenderPath = await this.ensureBlender();
    if (!blenderPath) return { error: 'Blender not installed' };

    const outputPath = path.join(BLENDER_DIR, `render-${Date.now()}.png`);
    const { frame = 1, engine = 'EEVEE' } = opts;

    try {
      await execAsync(
        `"${blenderPath}" --background "${blendFile}" --render-output "${outputPath}" --render-frame ${frame} --engine ${engine}`,
        { timeout: 300000 }
      );
      return { success: true, renderPath: outputPath };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ── ANIMATE ───────────────────────────────────────────────────────────────
  async animate(prompt, opts = {}) {
    const { frames = 60, fps = 24 } = opts;

    const script = await complete(
      `Write a Blender Python script that creates an animation:\n\n"${prompt}"\n\nThe animation should:\n1. Be ${frames} frames at ${fps} fps\n2. Use keyframes (object.keyframe_insert)\n3. Include movement, rotation, or scale changes\n4. Export as video or image sequence\n\nReturn ONLY the Python code.`,
      { temperature: 0.2, maxTokens: 3000 }
    );

    const scriptPath = path.join(BLENDER_DIR, `anim-${Date.now()}.py`);
    writeFileSync(scriptPath, script);

    const blenderPath = await this.ensureBlender();
    if (!blenderPath) return { script, error: 'Blender not installed — script generated but not executed' };

    const outputPath = path.join(BLENDER_DIR, `anim-${Date.now()}`);
    try {
      await execAsync(`"${blenderPath}" --background --python "${scriptPath}" -- --output "${outputPath}"`, { timeout: 600000 });
      return { success: true, outputPath, script: scriptPath };
    } catch (err) {
      return { success: false, error: err.message, script: scriptPath };
    }
  }

  // ── RUN ARBITRARY BPY SCRIPT ──────────────────────────────────────────────
  async runScript(script, opts = {}) {
    const blenderPath = await this.ensureBlender();
    if (!blenderPath) return { error: 'Blender not installed' };

    const scriptPath = path.join(BLENDER_DIR, `custom-${Date.now()}.py`);
    writeFileSync(scriptPath, script);

    try {
      const { stdout, stderr } = await execAsync(
        `"${blenderPath}" --background --python "${scriptPath}"`,
        { timeout: 600000 }
      );
      return { success: true, output: stdout, errors: stderr };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ── ENSURE BLENDER IS INSTALLED ───────────────────────────────────────────
  async ensureBlender() {
    if (this._blenderPath) return this._blenderPath;

    // Check common paths
    const candidates = [
      'blender',
      '/usr/bin/blender',
      '/usr/local/bin/blender',
      '/Applications/Blender.app/Contents/MacOS/Blender',
      'C:\\Program Files\\Blender Foundation\\Blender 4.0\\blender.exe',
    ];

    for (const candidate of candidates) {
      try {
        await execAsync(`"${candidate}" --version`, { timeout: 5000 });
        this._blenderPath = candidate;
        this.log(`Blender found: ${candidate}`);
        return candidate;
      } catch {}
    }

    // Try to install
    this.log('Blender not found — attempting install...');
    try {
      // Linux
      await execAsync('sudo apt-get install -y blender 2>/dev/null || snap install blender --classic 2>/dev/null', { timeout: 300000 });
      this._blenderPath = 'blender';
      return 'blender';
    } catch {}

    try {
      // macOS
      await execAsync('brew install --cask blender', { timeout: 300000 });
      this._blenderPath = '/Applications/Blender.app/Contents/MacOS/Blender';
      return this._blenderPath;
    } catch {}

    this.log('Could not auto-install Blender. Download from blender.org', 'warn');
    return null;
  }

  async status() {
    const blenderPath = await this.ensureBlender();
    let version = null;
    if (blenderPath) {
      try {
        const { stdout } = await execAsync(`"${blenderPath}" --version`, { timeout: 5000 });
        version = stdout.split('\n')[0];
      } catch {}
    }
    return { blenderAvailable: !!blenderPath, blenderPath, version };
  }
}

export default BlenderAgent;
