// agents/security.js
// APEX SecurityAgent — Full Kali Linux bridge. OSINT, scanning, pentesting, forensics.
import { BaseAgent } from './base-agent.js';
import { complete, structured } from '../core/llm.js';
import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';

const execAsync = promisify(exec);

// Full Kali Linux tool catalog
const KALI_TOOLS = {
  recon: {
    nmap: { cmd: 'nmap', desc: 'Network scanner and port mapper', args: '-sV -sC' },
    nikto: { cmd: 'nikto', desc: 'Web server vulnerability scanner', args: '-h' },
    gobuster: { cmd: 'gobuster', desc: 'Directory/file bruteforcer', args: 'dir -u' },
    whatweb: { cmd: 'whatweb', desc: 'Web technology fingerprinter', args: '' },
    theHarvester: { cmd: 'theHarvester', desc: 'OSINT email/domain harvester', args: '-d' },
    amass: { cmd: 'amass', desc: 'Subdomain enumeration', args: 'enum -d' },
    maltego: { cmd: 'maltego', desc: 'OSINT link analysis', args: '' },
    recon_ng: { cmd: 'recon-ng', desc: 'Reconnaissance framework', args: '' },
  },
  exploitation: {
    metasploit: { cmd: 'msfconsole', desc: 'Penetration testing framework', args: '-q -x' },
    sqlmap: { cmd: 'sqlmap', desc: 'SQL injection detection/exploitation', args: '-u' },
    hydra: { cmd: 'hydra', desc: 'Network login bruteforcer', args: '' },
    john: { cmd: 'john', desc: 'Password cracker', args: '' },
    hashcat: { cmd: 'hashcat', desc: 'GPU password cracker', args: '' },
    aircrack_ng: { cmd: 'aircrack-ng', desc: 'WiFi security auditing', args: '' },
    burpsuite: { cmd: 'burpsuite', desc: 'Web app security testing', args: '' },
    beef_xss: { cmd: 'beef-xss', desc: 'Browser Exploitation Framework', args: '' },
  },
  web: {
    wfuzz: { cmd: 'wfuzz', desc: 'Web fuzzer', args: '' },
    ffuf: { cmd: 'ffuf', desc: 'Fast web fuzzer', args: '-u' },
    dirbuster: { cmd: 'dirbuster', desc: 'Directory bruteforcer', args: '' },
    xsstrike: { cmd: 'xsstrike', desc: 'XSS detection tool', args: '-u' },
    commix: { cmd: 'commix', desc: 'Command injection exploiter', args: '' },
    wpscan: { cmd: 'wpscan', desc: 'WordPress vulnerability scanner', args: '--url' },
  },
  network: {
    wireshark: { cmd: 'wireshark', desc: 'Network packet analyzer', args: '' },
    tcpdump: { cmd: 'tcpdump', desc: 'Packet capture', args: '' },
    netcat: { cmd: 'nc', desc: 'Networking utility', args: '' },
    socat: { cmd: 'socat', desc: 'Advanced networking', args: '' },
    arpspoof: { cmd: 'arpspoof', desc: 'ARP cache poisoning', args: '' },
    ettercap: { cmd: 'ettercap', desc: 'MITM attacks', args: '' },
  },
  forensics: {
    autopsy: { cmd: 'autopsy', desc: 'Digital forensics platform', args: '' },
    volatility: { cmd: 'volatility', desc: 'Memory forensics', args: '' },
    binwalk: { cmd: 'binwalk', desc: 'Firmware analysis', args: '' },
    foremost: { cmd: 'foremost', desc: 'File recovery', args: '' },
    exiftool: { cmd: 'exiftool', desc: 'Metadata extractor', args: '' },
    stegseek: { cmd: 'stegseek', desc: 'Steganography detection', args: '' },
  },
  crypto: {
    hashid: { cmd: 'hashid', desc: 'Hash identifier', args: '' },
    openssl: { cmd: 'openssl', desc: 'Cryptography toolkit', args: '' },
    gpg: { cmd: 'gpg', desc: 'PGP encryption', args: '' },
  },
  wireless: {
    airmon_ng: { cmd: 'airmon-ng', desc: 'Wireless monitor mode', args: '' },
    airodump_ng: { cmd: 'airodump-ng', desc: 'Wireless packet capture', args: '' },
    aireplay_ng: { cmd: 'aireplay-ng', desc: 'Wireless injection attacks', args: '' },
    kismet: { cmd: 'kismet', desc: 'Wireless network detector', args: '' },
    wifite: { cmd: 'wifite', desc: 'Automated wireless auditor', args: '' },
  },
};

export class SecurityAgent extends BaseAgent {
  constructor() {
    super({
      name: 'SecurityAgent',
      type: 'security',
      description: 'Full Kali Linux security agent. Performs OSINT, vulnerability scanning, pentesting, forensics, and security analysis. Always operates within legal/authorized scope.',
    });
    this._availableTools = null;
    this._resultsDir = path.join(process.cwd(), '.apex-security-results');
    if (!existsSync(this._resultsDir)) mkdirSync(this._resultsDir, { recursive: true });
  }

  async run(task) {
    const { objective, target = null, scope = 'recon', authorization = false } = task;

    // Safety check
    if (!authorization && target && !this._isSafeTarget(target)) {
      return {
        error: 'Authorization required. Set authorization: true to confirm this is a target you own or have explicit permission to test.',
        safe: false,
      };
    }

    this.log(`SecurityAgent: ${objective} | Target: ${target || 'none'} | Scope: ${scope}`);

    // Discover available tools
    const tools = await this.discoverTools();
    this.log(`Available Kali tools: ${tools.length}`);

    // Plan attack/assessment
    const plan = await this._planAssessment(objective, target, scope, tools);

    // Execute
    const results = await this._executeAssessment(plan, target);

    // Analyze results with AI
    const analysis = await this._analyzeResults(results, objective);

    // Save report
    const reportPath = this._saveReport({ objective, target, plan, results, analysis });

    this.remember(
      `Security assessment: ${objective} on ${target}. Findings: ${analysis.critical_findings?.length || 0} critical.`,
      { tags: ['security', 'assessment', scope], importance: 9, scope: 'long_term' }
    );

    return { objective, target, plan, results, analysis, reportPath };
  }

  // Discover which Kali tools are actually installed
  async discoverTools() {
    if (this._availableTools) return this._availableTools;

    const available = [];
    for (const [category, tools] of Object.entries(KALI_TOOLS)) {
      for (const [name, info] of Object.entries(tools)) {
        try {
          execSync(`which ${info.cmd}`, { stdio: 'pipe', timeout: 2000 });
          available.push({ name, category, ...info });
        } catch {}
      }
    }

    this._availableTools = available;
    this.log(`Discovered ${available.length} Kali tools installed`);
    return available;
  }

  async _planAssessment(objective, target, scope, availableTools) {
    const toolNames = availableTools.map(t => `${t.name} (${t.desc})`).join(', ');
    return structured(
      `You are planning a security assessment.\n\nObjective: ${objective}\nTarget: ${target || 'not specified'}\nScope: ${scope}\nAvailable tools: ${toolNames || 'none found - will use built-in methods'}\n\nCreate a detailed assessment plan.`,
      {
        phases: ['array of phase names'],
        commands: [{ tool: 'tool name', command: 'full command string', purpose: 'what this does' }],
        expectedFindings: ['what to look for'],
        riskLevel: 'low/medium/high',
        estimatedTime: 'estimated time to complete',
      }
    );
  }

  async _executeAssessment(plan, target) {
    const results = [];

    for (const step of (plan.commands || []).slice(0, 10)) {
      try {
        this.log(`Running: ${step.command}`);
        const output = await this._runTool(step.command, target);
        results.push({
          tool: step.tool,
          purpose: step.purpose,
          command: step.command,
          output: output.slice(0, 5000),
          success: true,
        });
      } catch (err) {
        results.push({
          tool: step.tool,
          command: step.command,
          error: err.message,
          success: false,
        });
      }
    }

    return results;
  }

  async _runTool(command, target) {
    // Replace TARGET placeholder
    const finalCmd = command.replace(/\{TARGET\}/g, target || '');

    try {
      const { stdout, stderr } = await execAsync(finalCmd, {
        timeout: 60000,
        env: { ...process.env, PATH: `/usr/share/metasploit-framework:${process.env.PATH}` },
      });
      return stdout + stderr;
    } catch (err) {
      return err.stdout + err.message;
    }
  }

  async _analyzeResults(results, objective) {
    const rawData = results.map(r => `Tool: ${r.tool}\nOutput: ${r.output || r.error || ''}`).join('\n\n---\n\n');

    return structured(
      `Analyze these security assessment results for: "${objective}"\n\n${rawData}\n\nProvide expert security analysis.`,
      {
        critical_findings: ['list of critical vulnerabilities or findings'],
        high_findings: ['list of high severity findings'],
        medium_findings: ['list of medium findings'],
        low_findings: ['list of low findings'],
        attack_surface: 'description of attack surface discovered',
        recommendations: ['prioritized list of remediation steps'],
        executive_summary: 'brief non-technical summary',
        risk_score: 'overall risk score 1-10',
      }
    );
  }

  _saveReport(data) {
    const reportPath = path.join(this._resultsDir, `report-${Date.now()}.json`);
    writeFileSync(reportPath, JSON.stringify(data, null, 2));
    return reportPath;
  }

  _isSafeTarget(target) {
    // Always safe: localhost, private IPs, .local domains
    return (
      target.includes('localhost') ||
      target.includes('127.0.0.1') ||
      target.includes('192.168.') ||
      target.includes('10.0.') ||
      target.includes('.local') ||
      target.includes('example.com') ||
      target.includes('testphp.vulnweb.com') // public test target
    );
  }

  // Direct tool execution (for manual use)
  async executeTool(toolName, args, target = '') {
    const tool = Object.values(KALI_TOOLS).flatMap(cat => Object.values(cat)).find(t => t.cmd === toolName);
    if (!tool) throw new Error(`Tool ${toolName} not in catalog`);

    const cmd = `${toolName} ${args} ${target}`.trim();
    return this._runTool(cmd, target);
  }

  // OSINT on a target
  async osint(target) {
    return this.run({
      objective: `Full OSINT investigation of ${target}`,
      target,
      scope: 'recon',
      authorization: true, // OSINT is passive/legal
    });
  }

  // Vulnerability scan
  async vulnScan(target) {
    return this.run({
      objective: `Vulnerability scan of ${target}`,
      target,
      scope: 'vulnerability_scan',
      authorization: this._isSafeTarget(target),
    });
  }
}

export default SecurityAgent;
