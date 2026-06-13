// agents/vision.js
// APEX VisionAgent — Gemini multimodal vision. Analyzes screenshots, reads text,
// understands UI layouts, identifies elements, reads documents/receipts/diagrams.

import { BaseAgent } from './base-agent.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import axios from 'axios';
import bus from '../core/event-bus.js';

export class VisionAgent extends BaseAgent {
  constructor() {
    super({
      name: 'VisionAgent',
      type: 'vision',
      description: 'Multimodal AI vision. Analyzes images, screenshots, documents, UI layouts. Reads text from any image. Understands diagrams, charts, receipts, handwriting.',
    });
    this._model = null;
  }

  async run(task) {
    const { action = 'analyze', imagePath, imageUrl, prompt, screenshot = false } = task;

    // Take screenshot if requested
    let targetPath = imagePath;
    if (screenshot || action === 'screenshot_and_analyze') {
      targetPath = await this._takeScreenshot();
    }

    // Load image from URL if provided
    if (imageUrl && !targetPath) {
      targetPath = await this._downloadImage(imageUrl);
    }

    if (!targetPath && !imageUrl) {
      return { error: 'Provide imagePath, imageUrl, or set screenshot: true' };
    }

    switch (action) {
      case 'analyze':
      case 'screenshot_and_analyze':
        return this.analyze(targetPath, prompt);
      case 'ocr':
      case 'read_text':
        return this.readText(targetPath);
      case 'describe_ui':
        return this.describeUI(targetPath);
      case 'find_element':
        return this.findElement(targetPath, prompt);
      case 'read_document':
        return this.readDocument(targetPath);
      case 'understand_chart':
        return this.understandChart(targetPath);
      case 'compare':
        return this.compare(targetPath, task.imagePath2, prompt);
      case 'detect_changes':
        return this.detectChanges(targetPath, task.imagePath2);
      default:
        return this.analyze(targetPath, prompt);
    }
  }

  // ─── CORE VISION ─────────────────────────────────────────────────────────

  async analyze(imagePath, prompt = 'Describe everything you see in detail.') {
    this.log(`Analyzing: ${imagePath}`);
    const model = this._getModel();
    const imageData = this._loadImage(imagePath);

    const result = await model.generateContent([
      {
        inlineData: {
          mimeType: this._getMimeType(imagePath),
          data: imageData,
        },
      },
      { text: prompt },
    ]);

    const analysis = result.response.text();
    this.remember(`Vision analysis: ${analysis.slice(0, 200)}`, { tags: ['vision', 'analysis'], importance: 5 });
    bus.emit('vision:analyzed', { imagePath });
    return { imagePath, analysis, prompt };
  }

  // Read all text from an image (OCR)
  async readText(imagePath) {
    return this.analyze(imagePath,
      'Extract ALL text visible in this image. Preserve the layout and formatting as much as possible. Return only the extracted text.'
    );
  }

  // Understand the UI layout — find buttons, forms, menus
  async describeUI(imagePath) {
    const result = await this.analyze(imagePath,
      `Analyze this UI/screenshot and provide:\n1. What application/website is this?\n2. List all interactive elements (buttons, links, inputs) with their labels and approximate positions\n3. What is the current state/page?\n4. What actions can a user take?\n5. Any important content visible?\n\nBe specific and structured.`
    );
    return { ...result, type: 'ui_analysis' };
  }

  // Find a specific element in a screenshot
  async findElement(imagePath, elementDescription) {
    return this.analyze(imagePath,
      `Find this element in the image: "${elementDescription}"\n\nDescribe:\n1. Is it present? (yes/no)\n2. If yes, where is it approximately (top/bottom/left/right, what percentage from edges)\n3. What does it look like?\n4. What text does it contain?\n5. What is its current state (enabled/disabled/checked/etc)?`
    );
  }

  // Read a document (receipt, invoice, letter, form)
  async readDocument(imagePath) {
    return this.analyze(imagePath,
      `This is a document. Extract all information in a structured format:\n- Document type\n- All text content\n- Key fields and their values\n- Dates, amounts, names, addresses\n- Any important identifiers or numbers\n\nReturn as structured data.`
    );
  }

  // Understand a chart or diagram
  async understandChart(imagePath) {
    return this.analyze(imagePath,
      `This is a chart/diagram/graph. Provide:\n1. Chart type\n2. What data it represents\n3. Key values and trends\n4. Axis labels and ranges\n5. Main insights and conclusions\n6. Any notable anomalies or highlights`
    );
  }

  // Compare two images
  async compare(imagePath1, imagePath2, prompt = 'What are the differences between these two images?') {
    const model = this._getModel();
    const image1 = this._loadImage(imagePath1);
    const image2 = this._loadImage(imagePath2);
    const mime1 = this._getMimeType(imagePath1);
    const mime2 = this._getMimeType(imagePath2);

    const result = await model.generateContent([
      { inlineData: { mimeType: mime1, data: image1 } },
      { inlineData: { mimeType: mime2, data: image2 } },
      { text: prompt },
    ]);

    return { imagePath1, imagePath2, comparison: result.response.text() };
  }

  // Detect what changed between two screenshots
  async detectChanges(before, after) {
    return this.compare(before, after,
      `These are two screenshots taken at different times. List every change you can detect:\n- New elements added\n- Elements removed\n- Text that changed\n- Visual changes\n- State changes (loading, errors, etc)\n\nBe specific about what changed and where.`
    );
  }

  // Analyze screen + decide next browser/device action
  async planNextAction(screenshotPath, objective) {
    const result = await this.analyze(screenshotPath,
      `You are controlling a computer to accomplish: "${objective}"\n\nLook at this screenshot and determine:\n1. Current state of the screen\n2. Have we accomplished the objective? (yes/no)\n3. If not, what is the NEXT single action to take?\n4. Specify: action type (click/type/scroll/navigate), element to target, value if needed\n\nBe precise and actionable.`
    );

    // Parse the action recommendation
    const actionPlan = await this._parseActionFromAnalysis(result.analysis, objective);
    return { screenshot: screenshotPath, analysis: result.analysis, nextAction: actionPlan };
  }

  async _parseActionFromAnalysis(analysis, objective) {
    const { structured } = await import('../core/llm.js');
    return structured(
      `Extract the next action from this analysis:\n${analysis}\n\nObjective: ${objective}`,
      {
        completed: false,
        action: { type: 'click|type|scroll|navigate|wait|done', target: 'element description', value: 'value if type/navigate', reason: 'why' },
      },
      { temperature: 0.1 }
    );
  }

  // Verify a task was completed by looking at screen
  async verifyCompletion(screenshotPath, expectedOutcome) {
    return this.analyze(screenshotPath,
      `Expected outcome: "${expectedOutcome}"\n\nLooking at this screenshot:\n1. Was the expected outcome achieved? (yes/partially/no)\n2. What evidence supports your conclusion?\n3. If not completed, what is missing or wrong?\n4. Confidence level (0-100%)`
    );
  }

  // Read QR code or barcode from image
  async readQR(imagePath) {
    return this.analyze(imagePath, 'Is there a QR code or barcode in this image? If yes, what does it contain/encode? Decode it completely.');
  }

  // ─── HELPERS ─────────────────────────────────────────────────────────────

  _getModel() {
    if (this._model) return this._model;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY required for VisionAgent');
    const genai = new GoogleGenerativeAI(apiKey);
    this._model = genai.getGenerativeModel({ model: 'gemini-1.5-flash' });
    return this._model;
  }

  _loadImage(imagePath) {
    if (!existsSync(imagePath)) throw new Error(`Image not found: ${imagePath}`);
    return readFileSync(imagePath).toString('base64');
  }

  _getMimeType(imagePath) {
    const ext = path.extname(imagePath).toLowerCase();
    const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
    return types[ext] || 'image/png';
  }

  async _takeScreenshot() {
    const deviceAgent = (await import('../core/agent-registry.js')).default.get('DeviceAgent');
    if (!deviceAgent) throw new Error('DeviceAgent not available for screenshot');
    const result = await deviceAgent._handleTask({ id: 'screenshot', action: 'screenshot' });
    return result.path;
  }

  async _downloadImage(url) {
    const { mkdirSync, existsSync: exists } = await import('fs');
    const tmpDir = '/tmp/apex-vision';
    if (!exists(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `img-${Date.now()}.png`);

    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
    require('fs').writeFileSync(tmpPath, Buffer.from(resp.data));
    return tmpPath;
  }
}

export default VisionAgent;
