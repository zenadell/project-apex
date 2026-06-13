// agents/device.js
// APEX DeviceAgent — Full device control. Mouse, keyboard, screen reading, app launching,
// file operations, system notifications, clipboard, window management.
// Inspired by OpenClaw's bash-tools + terminal execution model, but for desktop automation.

import { BaseAgent } from './base-agent.js';
import { complete, structured } from '../core/llm.js';
import { exec, execSync, spawn } from 'child_process';
import { promisify } from 'util';
import {
  existsSync, mkdirSync, writeFileSync, readFileSync,
  readdirSync, statSync, copyFileSync, renameSync, unlinkSync,
} from 'fs';
import path from 'path';
import os from 'os';
import bus from '../core/event-bus.js';
import Memory from '../core/memory.js';

const execAsync = promisify(exec);

// Detect platform
const PLATFORM = process.platform; // 'linux', 'darwin', 'win32', 'android' (Termux)
const IS_TERMUX = !!process.env.TERMUX_VERSION || process.env.PREFIX?.includes('com.termux');
const IS_LINUX = PLATFORM === 'linux' && !IS_TERMUX;
const IS_MAC = PLATFORM === 'darwin';
const IS_WIN = PLATFORM === 'win32';

export class DeviceAgent extends BaseAgent {
  constructor() {
    super({
      name: 'DeviceAgent',
      type: 'device',
      description: 'Full device control. Moves mouse, types keyboard, reads screen, launches apps, manages files, sends notifications, controls clipboard. Works on Linux, macOS, Windows, Android (Termux).',
    });
    this._inputDriver = null;
    this._screenDriver = null;
    this._detectDrivers();
  }

  async run(task) {
    const { action, ...params } = task;
    this.log(`DeviceAgent: ${action}`);

    switch (action) {
      // Mouse
      case 'mouse_move':    return this.mouseMove(params.x, params.y);
      case 'mouse_click':   return this.mouseClick(params.x, params.y, params.button);
      case 'mouse_drag':    return this.mouseDrag(params.from, params.to);
      case 'double_click':  return this.doubleClick(params.x, params.y);
      case 'right_click':   return this.mouseClick(params.x, params.y, 'right');
      case 'scroll':        return this.scroll(params.x, params.y, params.direction, params.amount);

      // Keyboard
      case 'type':          return this.type(params.text);
      case 'key':           return this.pressKey(params.key, params.modifiers);
      case 'hotkey':        return this.hotkey(params.keys);
      case 'keyboard_shortcut': return this.hotkey(params.keys);

      // Screen
      case 'screenshot':    return this.screenshot(params.region);
      case 'read_screen':   return this.readScreen(params.region);
      case 'find_on_screen': return this.findOnScreen(params.text);
      case 'wait_for':      return this.waitForElement(params.text, params.timeout);
      case 'ocr':           return this.ocr(params.imagePath || null);

      // Apps
      case 'launch_app':    return this.launchApp(params.app, params.args);
      case 'kill_app':      return this.killApp(params.app);
      case 'focus_window':  return this.focusWindow(params.title);
      case 'list_windows':  return this.listWindows();
      case 'close_window':  return this.closeWindow(params.title);
      case 'maximize':      return this.maximizeWindow(params.title);

      // Files
      case 'read_file':     return this.readFile(params.path);
      case 'write_file':    return this.writeFile(params.path, params.content);
      case 'copy_file':     return this.copyFile(params.from, params.to);
      case 'move_file':     return this.moveFile(params.from, params.to);
      case 'delete_file':   return this.deleteFile(params.path);
      case 'list_files':    return this.listFiles(params.path, params.filter);
      case 'find_files':    return this.findFiles(params.query, params.dir);
      case 'open_file':     return this.openFile(params.path);

      // Clipboard
      case 'copy_to_clipboard':  return this.copyToClipboard(params.text);
      case 'read_clipboard':     return this.readClipboard();

      // Notifications
      case 'notify':        return this.notify(params.title, params.message, params.icon);

      // System
      case 'run_command':   return this.runCommand(params.command, params.cwd);
      case 'system_info':   return this.systemInfo();
      case 'get_env':       return process.env[params.key] || null;
      case 'set_volume':    return this.setVolume(params.level);
      case 'sleep':         return this.sleep(params.ms);

      // Smart — AI plans the steps
      case 'smart':         return this.smartAction(params.objective);

      default:
        return { error: `Unknown action: ${action}` };
    }
  }

  // ─── MOUSE ─────────────────────────────────────────────────────────────────

  async mouseMove(x, y) {
    if (IS_LINUX) await this._xdotool(`mousemove ${x} ${y}`);
    else if (IS_MAC) await this._osascript(`tell application "System Events" to set position of cursor to {${x}, ${y}}`);
    else await execAsync(`python3 -c "import pyautogui; pyautogui.moveTo(${x},${y})"`);
    return { moved: true, x, y };
  }

  async mouseClick(x, y, button = 'left') {
    const btn = button === 'right' ? 3 : button === 'middle' ? 2 : 1;
    if (IS_LINUX) await this._xdotool(`click --clearmodifiers ${btn}`);
    else if (IS_MAC) await this._cliclick(`c:${x},${y}`);
    else await execAsync(`python3 -c "import pyautogui; pyautogui.click(${x},${y}, button='${button}')"`);
    return { clicked: true, x, y, button };
  }

  async doubleClick(x, y) {
    if (IS_LINUX) {
      await this._xdotool(`mousemove ${x} ${y}`);
      await this._xdotool(`click --clearmodifiers --repeat 2 1`);
    } else await execAsync(`python3 -c "import pyautogui; pyautogui.doubleClick(${x},${y})"`);
    return { doubleClicked: true, x, y };
  }

  async mouseDrag(from, to) {
    if (IS_LINUX) {
      await this._xdotool(`mousemove ${from.x} ${from.y}`);
      await this._xdotool(`mousedown 1`);
      await this._xdotool(`mousemove ${to.x} ${to.y}`);
      await this._xdotool(`mouseup 1`);
    } else await execAsync(`python3 -c "import pyautogui; pyautogui.drag(${to.x-from.x},${to.y-from.y})"`);
    return { dragged: true, from, to };
  }

  async scroll(x, y, direction = 'down', amount = 3) {
    const btn = direction === 'down' ? 5 : 4;
    if (IS_LINUX) {
      await this._xdotool(`mousemove ${x} ${y}`);
      for (let i = 0; i < amount; i++) await this._xdotool(`click ${btn}`);
    } else await execAsync(`python3 -c "import pyautogui; pyautogui.scroll(${direction==='down'?-amount:amount}, x=${x}, y=${y})"`);
    return { scrolled: true, direction, amount };
  }

  // ─── KEYBOARD ──────────────────────────────────────────────────────────────

  async type(text) {
    if (IS_LINUX) await this._xdotool(`type --clearmodifiers --delay 20 "${text.replace(/"/g, '\\"')}"`);
    else if (IS_MAC) await this._osascript(`tell application "System Events" to keystroke "${text.replace(/"/g, '\\"')}"`);
    else await execAsync(`python3 -c "import pyautogui; pyautogui.write('${text.replace(/'/g, "\\'")}', interval=0.02)"`);
    return { typed: true, length: text.length };
  }

  async pressKey(key, modifiers = []) {
    const modStr = modifiers.length ? modifiers.join('+') + '+' : '';
    if (IS_LINUX) await this._xdotool(`key ${modStr}${key}`);
    else if (IS_MAC) {
      const modMap = { ctrl: 'control', alt: 'option', meta: 'command' };
      const mods = modifiers.map(m => modMap[m] || m).join(' ');
      await this._osascript(`tell application "System Events" to key code ${key} using {${mods}}`);
    } else await execAsync(`python3 -c "import pyautogui; pyautogui.hotkey('${[...modifiers, key].join("', '")}')"`);
    return { pressed: key, modifiers };
  }

  async hotkey(keys) {
    const keyStr = Array.isArray(keys) ? keys.join('+') : keys;
    if (IS_LINUX) await this._xdotool(`key ${keyStr}`);
    else await execAsync(`python3 -c "import pyautogui; pyautogui.hotkey('${keyStr.split('+').join("', '")}')"`);
    return { hotkey: keyStr };
  }

  // ─── SCREEN ────────────────────────────────────────────────────────────────

  async screenshot(region = null) {
    const { mkdirSync: mkdir, existsSync: exists } = await import('fs');
    const screenshotsDir = path.join(process.cwd(), '.apex-screenshots');
    if (!exists(screenshotsDir)) mkdir(screenshotsDir, { recursive: true });
    const outputPath = path.join(screenshotsDir, `screen-${Date.now()}.png`);

    if (IS_LINUX) {
      if (region) {
        const { x, y, w, h } = region;
        await execAsync(`import -window root -crop ${w}x${h}+${x}+${y} ${outputPath} 2>/dev/null || scrot -a ${x},${y},${w},${h} ${outputPath} 2>/dev/null || gnome-screenshot -f ${outputPath} 2>/dev/null`);
      } else {
        await execAsync(`scrot ${outputPath} 2>/dev/null || gnome-screenshot -f ${outputPath} 2>/dev/null || import -window root ${outputPath} 2>/dev/null`);
      }
    } else if (IS_MAC) {
      const regionArg = region ? `-R${region.x},${region.y},${region.w},${region.h}` : '';
      await execAsync(`screencapture -x ${regionArg} "${outputPath}"`);
    } else if (IS_TERMUX) {
      await execAsync(`termux-screenshot -f ${outputPath} 2>/dev/null`);
    }

    return { path: outputPath, taken: existsSync(outputPath) };
  }

  async readScreen(region = null) {
    // Screenshot + OCR
    const { path: screenshotPath } = await this.screenshot(region);
    return this.ocr(screenshotPath);
  }

  async ocr(imagePath = null) {
    // Use tesseract if available
    if (!imagePath) {
      const { path: p } = await this.screenshot();
      imagePath = p;
    }
    try {
      const { stdout } = await execAsync(`tesseract "${imagePath}" stdout 2>/dev/null`);
      return { text: stdout.trim(), method: 'tesseract' };
    } catch {
      // Fallback: AI vision via Gemini (if image model available)
      return this._aiOCR(imagePath);
    }
  }

  async _aiOCR(imagePath) {
    try {
      const { readFileSync: rfs } = await import('fs');
      const imageData = rfs(imagePath).toString('base64');
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genai.getGenerativeModel({ model: 'gemini-1.5-flash' });
      const result = await model.generateContent([
        { text: 'Extract all text from this screenshot. Return only the text content, preserving layout.' },
        { inlineData: { mimeType: 'image/png', data: imageData } },
      ]);
      return { text: result.response.text(), method: 'gemini-vision' };
    } catch (err) {
      return { text: '', error: err.message, method: 'failed' };
    }
  }

  async findOnScreen(text) {
    const { text: screenText } = await this.readScreen();
    const found = screenText.toLowerCase().includes(text.toLowerCase());
    return { found, text, screenContent: screenText.slice(0, 500) };
  }

  async waitForElement(text, timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const { found } = await this.findOnScreen(text);
      if (found) return { found: true, waitedMs: Date.now() - start };
      await new Promise(r => setTimeout(r, 500));
    }
    return { found: false, timedOut: true };
  }

  // ─── APPS ──────────────────────────────────────────────────────────────────

  async launchApp(app, args = []) {
    let cmd;
    if (IS_LINUX) {
      cmd = `${app} ${args.join(' ')} &`;
    } else if (IS_MAC) {
      cmd = args.length ? `open -a "${app}" --args ${args.join(' ')}` : `open -a "${app}"`;
    } else if (IS_WIN) {
      cmd = `start "" "${app}" ${args.join(' ')}`;
    } else if (IS_TERMUX) {
      cmd = `am start -a android.intent.action.VIEW -d "${app}" &`;
    }
    await execAsync(cmd, { timeout: 10000 });
    return { launched: app, args };
  }

  async killApp(app) {
    if (IS_LINUX || IS_MAC) await execAsync(`pkill -f "${app}" 2>/dev/null || killall "${app}" 2>/dev/null`);
    else if (IS_WIN) await execAsync(`taskkill /IM "${app}.exe" /F`);
    return { killed: app };
  }

  async listWindows() {
    if (IS_LINUX) {
      try {
        const { stdout } = await execAsync(`wmctrl -l 2>/dev/null || xdotool search --name "" 2>/dev/null`);
        return { windows: stdout.trim().split('\n').filter(Boolean) };
      } catch { return { windows: [] }; }
    }
    if (IS_MAC) {
      const script = `tell application "System Events" to get name of every process where background only is false`;
      const { stdout } = await this._osascript(script, true);
      return { windows: stdout.trim().split(',').map(s => s.trim()) };
    }
    return { windows: [] };
  }

  async focusWindow(title) {
    if (IS_LINUX) await this._xdotool(`search --name "${title}" windowactivate --sync`);
    else if (IS_MAC) await this._osascript(`tell application "${title}" to activate`);
    return { focused: title };
  }

  async closeWindow(title) {
    if (IS_LINUX) await this._xdotool(`search --name "${title}" windowclose`);
    else if (IS_MAC) await this._osascript(`tell application "${title}" to quit`);
    return { closed: title };
  }

  async maximizeWindow(title) {
    if (IS_LINUX) await this._xdotool(`search --name "${title}" windowmaximize`);
    return { maximized: title };
  }

  // ─── FILES ─────────────────────────────────────────────────────────────────

  readFile(filePath) {
    const full = this._resolvePath(filePath);
    const content = readFileSync(full, 'utf8');
    this.remember(`Read file: ${filePath} (${content.length} chars)`, { tags: ['file', 'read'] });
    return { path: filePath, content, size: content.length };
  }

  writeFile(filePath, content) {
    const full = this._resolvePath(filePath);
    const dir = path.dirname(full);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(full, content, 'utf8');
    this.remember(`Wrote file: ${filePath}`, { tags: ['file', 'write'], importance: 6 });
    return { path: filePath, written: true, size: content.length };
  }

  copyFile(from, to) {
    copyFileSync(this._resolvePath(from), this._resolvePath(to));
    return { from, to, copied: true };
  }

  moveFile(from, to) {
    renameSync(this._resolvePath(from), this._resolvePath(to));
    return { from, to, moved: true };
  }

  deleteFile(filePath) {
    unlinkSync(this._resolvePath(filePath));
    return { path: filePath, deleted: true };
  }

  listFiles(dirPath = '.', filter = null) {
    const full = this._resolvePath(dirPath);
    const entries = readdirSync(full, { withFileTypes: true }).map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
      size: e.isFile() ? statSync(path.join(full, e.name)).size : null,
    }));
    return { path: dirPath, files: filter ? entries.filter(e => e.name.includes(filter)) : entries };
  }

  async findFiles(query, dir = os.homedir()) {
    try {
      const { stdout } = await execAsync(`find "${dir}" -name "*${query}*" -maxdepth 5 2>/dev/null | head -20`);
      return { query, results: stdout.trim().split('\n').filter(Boolean) };
    } catch {
      return { query, results: [] };
    }
  }

  async openFile(filePath) {
    const full = this._resolvePath(filePath);
    const cmd = IS_MAC ? `open "${full}"` : IS_WIN ? `start "" "${full}"` : `xdg-open "${full}" &`;
    await execAsync(cmd);
    return { opened: filePath };
  }

  // ─── CLIPBOARD ─────────────────────────────────────────────────────────────

  async copyToClipboard(text) {
    if (IS_LINUX) {
      await execAsync(`echo "${text.replace(/"/g, '\\"')}" | xclip -selection clipboard 2>/dev/null || echo "${text.replace(/"/g, '\\"')}" | xsel --clipboard --input 2>/dev/null`);
    } else if (IS_MAC) {
      await execAsync(`echo "${text.replace(/"/g, '\\"')}" | pbcopy`);
    } else if (IS_WIN) {
      await execAsync(`echo ${text.replace(/"/g, '\\"')} | clip`);
    } else if (IS_TERMUX) {
      await execAsync(`termux-clipboard-set "${text.replace(/"/g, '\\"')}"`);
    }
    return { copied: true, length: text.length };
  }

  async readClipboard() {
    let text = '';
    if (IS_LINUX) {
      const { stdout } = await execAsync(`xclip -selection clipboard -o 2>/dev/null || xsel --clipboard --output 2>/dev/null`);
      text = stdout;
    } else if (IS_MAC) {
      const { stdout } = await execAsync('pbpaste');
      text = stdout;
    } else if (IS_TERMUX) {
      const { stdout } = await execAsync('termux-clipboard-get');
      text = stdout;
    }
    return { text: text.trim() };
  }

  // ─── NOTIFICATIONS ─────────────────────────────────────────────────────────

  async notify(title, message, icon = '') {
    if (IS_LINUX) {
      await execAsync(`notify-send "${title}" "${message}" ${icon ? `-i ${icon}` : ''} 2>/dev/null`);
    } else if (IS_MAC) {
      await this._osascript(`display notification "${message}" with title "${title}"`);
    } else if (IS_TERMUX) {
      await execAsync(`termux-notification --title "${title}" --content "${message}"`);
    } else if (IS_WIN) {
      const ps = `Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; $n.BalloonTipTitle = '${title}'; $n.BalloonTipText = '${message}'; $n.Visible = $true; $n.ShowBalloonTip(5000)`;
      await execAsync(`powershell -Command "${ps}"`);
    }
    return { notified: true, title, message };
  }

  // ─── SYSTEM ────────────────────────────────────────────────────────────────

  async runCommand(command, cwd = process.cwd()) {
    const { stdout, stderr } = await execAsync(command, { cwd, timeout: 60000 });
    return { command, stdout, stderr, success: true };
  }

  systemInfo() {
    return {
      platform: PLATFORM,
      isTermux: IS_TERMUX,
      isLinux: IS_LINUX,
      isMac: IS_MAC,
      isWindows: IS_WIN,
      hostname: os.hostname(),
      username: os.userInfo().username,
      homeDir: os.homedir(),
      tmpDir: os.tmpdir(),
      cpus: os.cpus().length,
      totalMemGB: (os.totalmem() / 1e9).toFixed(1),
      freeMemGB: (os.freemem() / 1e9).toFixed(1),
      uptime: os.uptime(),
      nodeVersion: process.version,
    };
  }

  async setVolume(level) {
    if (IS_LINUX) await execAsync(`amixer set Master ${level}% 2>/dev/null || pactl set-sink-volume @DEFAULT_SINK@ ${level}% 2>/dev/null`);
    else if (IS_MAC) await execAsync(`osascript -e "set volume output volume ${level}"`);
    return { volume: level };
  }

  async sleep(ms) {
    await new Promise(r => setTimeout(r, ms));
    return { slept: ms };
  }

  // ─── SMART ACTION — AI plans all steps ────────────────────────────────────

  async smartAction(objective) {
    this.log(`Smart action: ${objective}`);
    const sysInfo = this.systemInfo();

    const plan = await structured(
      `You are controlling a ${sysInfo.platform} device${IS_TERMUX ? ' (Termux/Android)' : ''}.\n\nObjective: "${objective}"\n\nPlan a sequence of device actions to accomplish this. Use only actions available on this platform.`,
      {
        steps: [
          {
            action: 'action_name',
            params: {},
            description: 'what this does',
          }
        ],
        notes: 'anything important to know',
      },
      { temperature: 0.3 }
    );

    const results = [];
    for (const step of plan.steps || []) {
      try {
        this.log(`Step: ${step.description}`);
        const result = await this.run({ action: step.action, ...step.params });
        results.push({ step: step.description, result, success: true });
      } catch (err) {
        results.push({ step: step.description, error: err.message, success: false });
      }
    }

    this.remember(`Smart action: "${objective}" — ${results.length} steps`, {
      tags: ['device', 'smart', 'automation'], importance: 7,
    });

    return { objective, plan, results };
  }

  // ─── HELPERS ───────────────────────────────────────────────────────────────

  _resolvePath(p) {
    if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
    if (path.isAbsolute(p)) return p;
    return path.join(process.cwd(), p);
  }

  async _xdotool(args) {
    return execAsync(`xdotool ${args}`, { timeout: 10000 });
  }

  async _osascript(script, returnStdout = false) {
    const result = await execAsync(`osascript -e '${script}'`, { timeout: 10000 });
    return returnStdout ? result : { success: true };
  }

  async _cliclick(args) {
    return execAsync(`cliclick ${args}`, { timeout: 5000 });
  }

  _detectDrivers() {
    if (IS_LINUX) {
      try { execSync('which xdotool', { stdio: 'pipe' }); this._inputDriver = 'xdotool'; } catch {}
      try { execSync('which scrot', { stdio: 'pipe' }); this._screenDriver = 'scrot'; } catch {}
    } else if (IS_MAC) {
      this._inputDriver = 'osascript';
      this._screenDriver = 'screencapture';
    } else if (IS_TERMUX) {
      this._inputDriver = 'termux-input';
    }
    this.log(`Input driver: ${this._inputDriver || 'pyautogui-fallback'}, Screen: ${this._screenDriver || 'none'}`);
  }

  // Auto-install missing drivers
  async selfInstallDrivers() {
    const toInstall = [];
    if (IS_LINUX) {
      try { execSync('which xdotool', { stdio: 'pipe' }); } catch { toInstall.push('xdotool'); }
      try { execSync('which scrot', { stdio: 'pipe' }); } catch { toInstall.push('scrot'); }
      try { execSync('which tesseract', { stdio: 'pipe' }); } catch { toInstall.push('tesseract-ocr'); }
      try { execSync('which xclip', { stdio: 'pipe' }); } catch { toInstall.push('xclip'); }
      try { execSync('which wmctrl', { stdio: 'pipe' }); } catch { toInstall.push('wmctrl'); }
    }
    if (toInstall.length) {
      try {
        await execAsync(`sudo apt-get install -y ${toInstall.join(' ')} 2>/dev/null || pkg install ${toInstall.join(' ')} -y 2>/dev/null`);
        this.log(`Installed drivers: ${toInstall.join(', ')}`);
      } catch {
        // Also try pyautogui as universal fallback
        await execAsync('pip3 install pyautogui --quiet 2>/dev/null');
      }
    }
    return { installed: toInstall };
  }
}

export default DeviceAgent;
