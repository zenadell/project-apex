// tools/human-cursor.js
// APEX HumanCursor — Moves like a real human. Bezier curves, random micro-jitter,
// natural typing cadence, scroll physics. Defeats anti-bot systems by being indistinguishable
// from a human. Inspired by Google's Antigravity cursor technique.

import bus from '../core/event-bus.js';

// ─── MATH HELPERS ─────────────────────────────────────────────────────────────

// Cubic Bezier interpolation — natural mouse arc
function cubicBezier(t, p0, p1, p2, p3) {
  const mt = 1 - t;
  return mt*mt*mt*p0 + 3*mt*mt*t*p1 + 3*mt*t*t*p2 + t*t*t*p3;
}

// Generate a realistic mouse path from A to B using Bezier curves
function humanMousePath(startX, startY, endX, endY, steps = null) {
  const dist = Math.hypot(endX - startX, endY - startY);
  const numSteps = steps || Math.max(20, Math.round(dist / 8));

  // Random control points for natural arc
  const midX = (startX + endX) / 2 + (Math.random() - 0.5) * dist * 0.4;
  const midY = (startY + endY) / 2 + (Math.random() - 0.5) * dist * 0.4;
  const cp1x = startX + (midX - startX) * (0.3 + Math.random() * 0.4);
  const cp1y = startY + (midY - startY) * (0.3 + Math.random() * 0.4);
  const cp2x = endX - (endX - midX) * (0.3 + Math.random() * 0.4);
  const cp2y = endY - (endY - midY) * (0.3 + Math.random() * 0.4);

  const path = [];
  for (let i = 0; i <= numSteps; i++) {
    const t = i / numSteps;
    // Add micro-jitter (humans don't move perfectly)
    const jitter = Math.random() * 1.5 - 0.75;
    path.push({
      x: Math.round(cubicBezier(t, startX, cp1x, cp2x, endX) + jitter),
      y: Math.round(cubicBezier(t, startY, cp1y, cp2y, endY) + jitter),
      delay: _humanDelay(t, dist),
    });
  }
  return path;
}

// Speed varies: fast in middle, slow at start/end (Fitts's Law)
function _humanDelay(t, dist) {
  const base = Math.max(5, dist / 800 * 20);
  // Ease-in-out: slow at edges, fast in middle
  const eased = t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
  return base * (1 - eased + 0.2) + Math.random() * 4;
}

// Human typing: random delays between keystrokes
function humanTypingDelay(char) {
  const base = 80 + Math.random() * 60;  // 80-140ms per key
  // Slower for special chars, numbers
  if (/[A-Z!@#$%^&*()]/.test(char)) return base * 1.4;
  if (/[0-9]/.test(char)) return base * 1.2;
  // Occasional "thinking pause" (longer delay before a word)
  if (char === ' ' && Math.random() < 0.08) return base * 4;
  return base;
}

// ─── PLAYWRIGHT HUMAN CURSOR ──────────────────────────────────────────────────

export class HumanCursor {
  constructor(page) {
    this._page = page;
    this._x = 100;
    this._y = 100;
    this._moveHistory = [];
  }

  // Move mouse along a human-like Bezier path
  async moveTo(x, y, opts = {}) {
    const path = humanMousePath(this._x, this._y, x, y, opts.steps);

    for (const point of path) {
      await this._page.mouse.move(point.x, point.y);
      await this._sleep(point.delay);
    }

    this._x = x;
    this._y = y;
    this._moveHistory.push({ x, y, ts: Date.now() });
  }

  // Click with human timing (hover → slight pause → click → release)
  async click(x, y, opts = {}) {
    await this.moveTo(x, y);
    await this._sleep(80 + Math.random() * 120); // hover pause
    await this._page.mouse.down();
    await this._sleep(60 + Math.random() * 60);  // hold time
    await this._page.mouse.up();
    await this._sleep(100 + Math.random() * 100); // post-click pause
    bus.emit('human-cursor:click', { x, y });
  }

  // Double click
  async doubleClick(x, y) {
    await this.moveTo(x, y);
    await this._sleep(80 + Math.random() * 80);
    await this._page.mouse.dblclick(x, y);
    await this._sleep(150);
  }

  // Right click
  async rightClick(x, y) {
    await this.moveTo(x, y);
    await this._sleep(100 + Math.random() * 100);
    await this._page.mouse.click(x, y, { button: 'right' });
    await this._sleep(200);
  }

  // Drag from A to B naturally
  async drag(startX, startY, endX, endY) {
    await this.moveTo(startX, startY);
    await this._sleep(100 + Math.random() * 100);
    await this._page.mouse.down();
    await this._sleep(50 + Math.random() * 50);

    const path = humanMousePath(startX, startY, endX, endY);
    for (const point of path) {
      await this._page.mouse.move(point.x, point.y);
      await this._sleep(point.delay * 1.5); // slower during drag
    }

    await this._sleep(80 + Math.random() * 60);
    await this._page.mouse.up();
    this._x = endX; this._y = endY;
  }

  // Type like a human — with variable speed and occasional typo correction
  async type(text, opts = { typoRate: 0.02, correct: true }) {
    for (let i = 0; i < text.length; i++) {
      const char = text[i];

      // Occasional typo simulation
      if (opts.typoRate > 0 && Math.random() < opts.typoRate && opts.correct) {
        const typo = String.fromCharCode(char.charCodeAt(0) + (Math.random() < 0.5 ? 1 : -1));
        await this._page.keyboard.type(typo);
        await this._sleep(humanTypingDelay(typo));
        // "notice" the typo and delete
        await this._sleep(200 + Math.random() * 300);
        await this._page.keyboard.press('Backspace');
        await this._sleep(80 + Math.random() * 80);
      }

      await this._page.keyboard.type(char);
      await this._sleep(humanTypingDelay(char));
    }
  }

  // Scroll with human-like physics (ease in/out, variable speed)
  async scroll(direction = 'down', amount = 500, x = null, y = null) {
    if (x && y) await this.moveTo(x, y);

    const steps = Math.round(amount / 50);
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      // Ease in/out speed
      const speed = Math.sin(t * Math.PI) * 3 + 1;
      const delta = (direction === 'down' ? 1 : -1) * 50 * speed;
      await this._page.mouse.wheel(0, delta);
      await this._sleep(30 + Math.random() * 20);
    }
  }

  // Click on an element found by text/selector — with smart targeting
  async clickElement(page, selectorOrText, opts = {}) {
    // Try to find the element and get its center coordinates
    let element = null;

    // Try as CSS selector first
    try {
      element = await page.$(selectorOrText);
    } catch {}

    // Try as text
    if (!element) {
      try {
        element = await page.getByText(selectorOrText, { exact: false }).first().elementHandle();
      } catch {}
    }

    if (!element) throw new Error(`Element not found: ${selectorOrText}`);

    const box = await element.boundingBox();
    if (!box) throw new Error(`Element has no bounding box: ${selectorOrText}`);

    // Click slightly off-center (humans rarely click dead center)
    const targetX = box.x + box.width * (0.3 + Math.random() * 0.4);
    const targetY = box.y + box.height * (0.3 + Math.random() * 0.4);

    await this.click(Math.round(targetX), Math.round(targetY));
  }

  // Fill an input field naturally
  async fillField(selector, value) {
    await this.clickElement(this._page, selector);
    await this._sleep(100 + Math.random() * 100);
    // Select all existing text first
    await this._page.keyboard.press('Control+a');
    await this._sleep(50 + Math.random() * 50);
    await this.type(value);
  }

  // Human-like page reading (scrolls down slowly as if reading)
  async readPage(duration = 3000) {
    const totalScroll = await this._page.evaluate(() => document.body.scrollHeight - window.innerHeight);
    const steps = Math.round(duration / 100);

    for (let i = 0; i < steps; i++) {
      // Uneven scrolling — faster in boring sections, slower on interesting content
      const speed = 0.5 + Math.random() * 2;
      const delta = (totalScroll / steps) * speed;
      await this._page.mouse.wheel(0, delta);
      await this._sleep(80 + Math.random() * 40);

      // Occasional pause (as if reading something interesting)
      if (Math.random() < 0.05) {
        await this._sleep(800 + Math.random() * 1200);
      }
    }
  }

  // Random mouse wander (human behavior while waiting)
  async wander(duration = 2000) {
    const end = Date.now() + duration;
    const viewport = await this._page.viewportSize();
    while (Date.now() < end) {
      const x = 100 + Math.random() * (viewport.width - 200);
      const y = 100 + Math.random() * (viewport.height - 200);
      await this.moveTo(Math.round(x), Math.round(y), { steps: 15 });
      await this._sleep(300 + Math.random() * 700);
    }
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

// ─── STEALTH BROWSER SESSION ───────────────────────────────────────────────────
// Full browser launch with all anti-detection patches applied

export async function launchStealthBrowser(opts = {}) {
  const pw = await import('playwright');

  const browser = await pw.chromium.launch({
    headless: opts.headless !== false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-dev-shm-usage',
      '--disable-web-security',
      '--disable-site-isolation-trials',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--lang=en-US,en',
      '--window-size=1280,800',
      opts.proxy ? `--proxy-server=${opts.proxy}` : '',
    ].filter(Boolean),
    executablePath: opts.chromePath || undefined,
  });

  const context = await browser.newContext({
    viewport: { width: 1280 + Math.floor(Math.random() * 40), height: 800 + Math.floor(Math.random() * 40) },
    userAgent: _randomUserAgent(),
    locale: 'en-US',
    timezoneId: opts.timezone || 'America/New_York',
    geolocation: opts.location || { latitude: 40.7128, longitude: -74.0060 },
    permissions: ['geolocation'],
    colorScheme: 'dark',
    deviceScaleFactor: 1 + Math.random() * 0.5,
    hasTouch: false,
    isMobile: false,
    javaScriptEnabled: true,
    acceptDownloads: true,
  });

  // Apply deep stealth patches
  await context.addInitScript(() => {
    // Overwrite navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });

    // Override plugins (real browsers have many)
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const p = { length: 5, 0: {name:'Chrome PDF Plugin'}, 1: {name:'Chrome PDF Viewer'}, 2: {name:'Native Client'}, 3: {name:'Chromium PDF Viewer'}, 4: {name:'Microsoft Edge PDF Viewer'} };
        return p;
      },
    });

    // Override languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });

    // Chrome runtime present
    window.chrome = {
      runtime: { id: undefined },
      loadTimes: () => {},
      csi: () => {},
      app: {},
    };

    // Permission query override
    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
      window.navigator.permissions.query = (params) =>
        params.name === 'notifications' ? Promise.resolve({ state: 'default' }) : originalQuery(params);
    }

    // Canvas fingerprint randomization
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      const ctx = originalGetContext.call(this, type, ...args);
      if (type === '2d' && ctx) {
        const originalFillText = ctx.fillText.bind(ctx);
        ctx.fillText = function(...args) {
          ctx.shadowBlur = Math.random() * 0.1;
          return originalFillText(...args);
        };
      }
      return ctx;
    };

    // WebGL fingerprint randomization
    const getParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return 'Intel Inc.';
      if (param === 37446) return 'Intel Iris OpenGL Engine';
      return getParam.apply(this, [param]);
    };
  });

  const page = await context.newPage();
  const cursor = new HumanCursor(page);

  // Simulate initial cursor position
  await page.mouse.move(200 + Math.random() * 800, 200 + Math.random() * 400);

  bus.emit('stealth-browser:launched', { stealth: true });
  return { browser, context, page, cursor };
}

function _randomUserAgent() {
  const agents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  ];
  return agents[Math.floor(Math.random() * agents.length)];
}

export default { HumanCursor, launchStealthBrowser };
