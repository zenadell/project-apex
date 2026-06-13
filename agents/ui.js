// agents/ui.js
// APEX UIAgent — Designs and builds production-quality frontends.
// Figma-level thinking → clean HTML/CSS/JS or React components.
import { BaseAgent } from './base-agent.js';
import { complete, structured } from '../core/llm.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';

export class UIAgent extends BaseAgent {
  constructor() {
    super({
      name: 'UIAgent',
      type: 'frontend',
      description: 'Designs and builds stunning, production-ready frontends. Thinks like a Figma designer, codes like a senior engineer. React, vanilla JS, or any framework.',
    });
  }

  async run(task) {
    const {
      objective,
      outputDir = null,
      framework = 'auto',
      style = 'modern',
      backend = null,
      requirements = [],
      useDesignRepo = true,
      searchForBestRepo = true,
    } = task;

    this.log(`UIAgent: ${objective}`);

    // PHASE 0: Research best design repos/references (auto, no prompting)
    let designInspiration = null;
    if (useDesignRepo) {
      designInspiration = await this._getDesignInspiration(objective, searchForBestRepo);
      this.log(`Design inspiration: ${designInspiration?.repoName || 'internal system'}`);
    }

    // PHASE 1: Design system + architecture
    const design = await this._designSystem(objective, framework, style, requirements, designInspiration);
    this.log(`Design: ${design.framework} | Style: ${design.colorScheme}`);

    // PHASE 2: Component planning
    const components = await this._planComponents(objective, design, backend);
    this.log(`Components planned: ${components.components?.length}`);

    // PHASE 3: Build each component/file
    const files = await this._buildUI(objective, design, components, backend);
    this.log(`Built ${files.length} UI files`);

    // PHASE 4: Write to disk
    if (outputDir) {
      await this._writeToDisk(files, outputDir);
    }

    this.remember(
      `Built UI: ${objective} | Framework: ${design.framework} | Files: ${files.length}`,
      { tags: ['ui', 'frontend', design.framework], importance: 7, scope: 'long_term' }
    );

    return { objective, design, components, files };
  }

  async _getDesignInspiration(objective, searchForBest = true) {
    // Search GitHub for best UI repos relevant to objective
    const searchTerms = ['ui-ux-pro', 'framer-motion-examples', 'animated-components',
      'beautiful-react-ui', 'gsap-animations', 'tailwind-animations', 'motion-ui'];

    const inspiration = {
      repoName: 'internal-design-system',
      animationLibrary: 'CSS + Framer Motion',
      designPrinciples: [
        'Dark theme with neon accents',
        'Micro-interactions on every element',
        'Scroll-triggered animations',
        'Glass morphism cards',
        'Fluid typography with clamp()',
        'Custom cursor effects',
        'Staggered entrance animations',
        'Parallax scrolling sections',
      ],
      colorTrends: ['#7C3AED → #06FFA5 gradients', 'Deep darks #04040a', 'Electric accents'],
      fontPairs: [['Syne', 'Cabinet Grotesk'], ['Space Grotesk', 'Inter'], ['Clash Display', 'Satoshi']],
      animationTechniques: ['GSAP ScrollTrigger', 'Framer Motion variants', 'CSS @keyframes', 'Lenis smooth scroll'],
      componentPatterns: ['Magnetic buttons', 'Text reveal on scroll', 'Split text animation', 'Cursor follower', 'Noise texture overlays'],
      preferredLibraries: ['gsap', 'framer-motion', '@lottiefiles/react-lottie-player', 'three'],
    };

    if (searchForBest) {
      try {
        const registry = (await import('../core/agent-registry.js')).default;
        const research = registry.get('ResearchAgent');
        if (research) {
          const result = await research._handleTask({
            id: 'ui-research',
            query: `GitHub best UI animation library for ${objective} 2024 2025 framer motion gsap beautiful modern`,
            quick: true,
          });
          if (result?.synthesis) {
            inspiration.researchNotes = result.synthesis.slice(0, 500);
          }
        }
      } catch {}
    }

    return inspiration;
  }

  async _designSystem(objective, framework, style, requirements, inspiration = null) {
    const inspPrompt = inspiration ? `\n\nDesign inspiration to use:\n- Animation techniques: ${inspiration.animationTechniques?.join(', ')}\n- Component patterns: ${inspiration.componentPatterns?.join(', ')}\n- Libraries: ${inspiration.preferredLibraries?.join(', ')}\n- Design principles: ${inspiration.designPrinciples?.slice(0,4).join(', ')}` : '';

    return structured(
      `You are a senior UI/UX designer building Framer-quality interfaces.\n\nDesign a complete design system for: "${objective}"\nPreferred framework: ${framework}\nStyle direction: ${style}\nRequirements: ${requirements.join(', ')}${inspPrompt}\n\nCreate a world-class design system with advanced animations.`,
      {
        framework: 'react|vanilla|vue|svelte (best choice)',
        colorScheme: {
          primary: '#hex',
          secondary: '#hex',
          accent: '#hex',
          background: '#hex',
          surface: '#hex',
          text: '#hex',
          textMuted: '#hex',
          border: '#hex',
          error: '#hex',
          success: '#hex',
        },
        typography: {
          fontFamily: 'font stack',
          headingFont: 'heading font',
          baseSize: '16px',
          scale: 'modular scale ratio',
        },
        spacing: 'spacing system description',
        borderRadius: 'border radius values',
        shadows: 'shadow system',
        animations: 'animation philosophy',
        layout: 'grid/flex strategy',
        designLanguage: 'brief description of visual style',
        accessibility: 'WCAG compliance approach',
      },
      { temperature: 0.4 }
    );
  }

  async _planComponents(objective, design, backend) {
    return structured(
      `Plan all React/UI components needed for: "${objective}"\nDesign system: ${JSON.stringify(design)}\nBackend available: ${backend ? 'yes - ' + JSON.stringify(backend) : 'no'}\n\nPlan every component needed.`,
      {
        pages: ['list of pages/routes'],
        components: [
          {
            name: 'ComponentName',
            type: 'page|layout|ui|form|data',
            description: 'what it does',
            props: ['key props'],
            children: ['child component names'],
          }
        ],
        stateManagement: 'how state is managed',
        routing: 'routing approach',
        apiCalls: ['endpoints this UI calls'],
        fileStructure: { 'path/to/file': 'purpose' },
      },
      { temperature: 0.3 }
    );
  }

  async _buildUI(objective, design, components, backend) {
    const files = [];
    const ds = design;

    // CSS Variables / Global Styles
    const globalCSS = this._generateGlobalCSS(ds);
    files.push({ path: 'styles/global.css', content: globalCSS });

    // Build each file in the structure
    const fileList = Object.entries(components.fileStructure || {});

    // Determine if React or vanilla
    const isReact = ds.framework === 'react' || ds.framework === 'next';

    if (isReact) {
      // package.json for React
      files.push({
        path: 'package.json',
        content: JSON.stringify({
          name: objective.toLowerCase().replace(/\s+/g, '-').slice(0, 40),
          version: '1.0.0',
          type: 'module',
          scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
          dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1', 'react-router-dom': '^6.28.0' },
          devDependencies: { vite: '^6.0.0', '@vitejs/plugin-react': '^4.3.4' },
        }, null, 2),
      });

      // Vite config
      files.push({
        path: 'vite.config.js',
        content: `import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\nexport default defineConfig({ plugins: [react()] })`,
      });

      // index.html
      files.push({
        path: 'index.html',
        content: this._generateIndexHTML(objective, ds),
      });
    }

    // Generate main components
    for (const [filePath, description] of fileList.slice(0, 12)) {
      try {
        const code = await this._generateComponent(filePath, description, objective, ds, components, files);
        files.push({ path: filePath, content: code });
        this.log(`Built: ${filePath}`);
      } catch (err) {
        this.log(`Failed to build ${filePath}: ${err.message}`, 'warn');
      }
    }

    // If React, generate a standalone complete version too
    if (isReact && files.length < 5) {
      const standalone = await this._generateStandaloneReact(objective, ds, components, backend);
      files.push({ path: 'src/App.jsx', content: standalone });
    }

    // Always generate a standalone HTML version as fallback
    const standaloneHTML = await this._generateStandaloneHTML(objective, ds, components, backend);
    files.push({ path: 'index.html', content: standaloneHTML });

    return files;
  }

  async _generateComponent(filePath, description, objective, design, components, existingFiles) {
    const ext = path.extname(filePath);
    const isCSS = ext === '.css' || ext === '.scss';
    const existingContext = existingFiles.slice(-2).map(f => `/* ${f.path} */\n${f.content.slice(0, 400)}`).join('\n\n');

    if (isCSS) {
      return complete(
        `Write production CSS for: ${filePath}\nPurpose: ${description}\nDesign system: ${JSON.stringify(design.colorScheme)}\nTypography: ${JSON.stringify(design.typography)}\n\nWrite complete, modern CSS with custom properties. No placeholders.`,
        { temperature: 0.2, maxTokens: 3000 }
      );
    }

    return complete(
      `Write a complete ${ext} component: ${filePath}\nPurpose: ${description}\nProject: ${objective}\nDesign system:\n- Colors: ${JSON.stringify(design.colorScheme)}\n- Font: ${design.typography?.fontFamily}\n- Style: ${design.designLanguage}\n\nOther files:\n${existingContext}\n\nWrite COMPLETE, production-ready code. No TODOs. Fully styled. Accessible.`,
      { temperature: 0.2, maxTokens: 4096 }
    );
  }

  async _generateStandaloneHTML(objective, design, components, backend) {
    const ds = design;
    return complete(
      `Build a complete, stunning single-file HTML app for: "${objective}"\n\nDesign system:\n- Colors: primary=${ds.colorScheme?.primary}, background=${ds.colorScheme?.background}, accent=${ds.colorScheme?.accent}\n- Font: ${ds.typography?.fontFamily || 'Inter, sans-serif'}\n- Style: ${ds.designLanguage}\n- Border radius: ${ds.borderRadius}\n\nPages/sections needed: ${components.pages?.join(', ')}\nComponents: ${components.components?.map(c => c.name).join(', ')}\nBackend API: ${backend ? JSON.stringify(backend) : 'none - use mock data'}\n\nRequirements:\n- All CSS inline in <style> tag\n- All JS inline in <script> tag\n- Fully responsive mobile-first\n- Dark/light mode toggle\n- Smooth animations\n- Production quality — looks like a funded startup\n- No external dependencies except Google Fonts\n- Use CSS Grid + Flexbox\n- Real placeholder content (not lorem ipsum)\n- Interactive (working buttons, menus, etc)\n\nReturn ONLY the complete HTML file.`,
      { temperature: 0.3, maxTokens: 8192 }
    );
  }

  async _generateStandaloneReact(objective, design, components, backend) {
    return complete(
      `Build a complete React App.jsx single file for: "${objective}"\nDesign: ${JSON.stringify(design.colorScheme)}\nComponents needed: ${components.components?.map(c => c.name).join(', ')}\nBackend: ${backend ? JSON.stringify(backend) : 'mock data'}\n\nRequirements:\n- All components in one file using useState, useEffect\n- Styled with inline styles using the design system colors\n- Fully functional with mock data if no backend\n- Production quality\n\nReturn ONLY the JSX code.`,
      { temperature: 0.3, maxTokens: 6000 }
    );
  }

  _generateGlobalCSS(ds) {
    const c = ds.colorScheme || {};
    return `/* APEX Generated — Global Design System */
:root {
  --color-primary: ${c.primary || '#6366f1'};
  --color-secondary: ${c.secondary || '#8b5cf6'};
  --color-accent: ${c.accent || '#f59e0b'};
  --color-bg: ${c.background || '#0f0f1a'};
  --color-surface: ${c.surface || '#1a1a2e'};
  --color-text: ${c.text || '#f8fafc'};
  --color-text-muted: ${c.textMuted || '#94a3b8'};
  --color-border: ${c.border || '#334155'};
  --color-error: ${c.error || '#ef4444'};
  --color-success: ${c.success || '#22c55e'};
  --font-base: ${ds.typography?.fontFamily || "'Inter', 'Segoe UI', sans-serif"};
  --font-heading: ${ds.typography?.headingFont || "'Inter', sans-serif"};
  --radius: ${ds.borderRadius || '12px'};
  --radius-sm: 6px;
  --radius-lg: 20px;
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { font-size: 16px; scroll-behavior: smooth; }
body { font-family: var(--font-base); background: var(--color-bg); color: var(--color-text); line-height: 1.6; }
h1,h2,h3,h4,h5,h6 { font-family: var(--font-heading); line-height: 1.2; }
a { color: var(--color-primary); text-decoration: none; }
a:hover { opacity: 0.85; }
img { max-width: 100%; height: auto; display: block; }
button { cursor: pointer; font-family: var(--font-base); }
input, textarea, select { font-family: var(--font-base); }
`;
  }

  _generateIndexHTML(title, ds) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.jsx"></script>
</body>
</html>`;
  }

  async _writeToDisk(files, outputDir) {
    const { mkdirSync: mkdir, writeFileSync: write, existsSync: exists } = await import('fs');
    if (!exists(outputDir)) mkdir(outputDir, { recursive: true });

    for (const file of files) {
      const fullPath = path.join(outputDir, file.path);
      const dir = path.dirname(fullPath);
      if (!exists(dir)) mkdir(dir, { recursive: true });
      write(fullPath, file.content, 'utf8');
    }
  }

  // Design-only mode — returns design spec without building
  async designOnly(description) {
    const design = await this._designSystem(description, 'auto', 'modern', []);
    const components = await this._planComponents(description, design, null);
    return { design, components };
  }
}

export default UIAgent;
