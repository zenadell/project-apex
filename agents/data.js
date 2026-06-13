// agents/data.js
// APEX DataAgent — ETL, data analysis, CSV/Excel/JSON processing, charts, reports.
// Cleans data, finds insights, generates visualizations, exports results.

import { BaseAgent } from './base-agent.js';
import { complete, structured } from '../core/llm.js';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', '.apex-data', 'analysis');
if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

export class DataAgent extends BaseAgent {
  constructor() {
    super({
      name: 'DataAgent',
      type: 'data',
      description: 'ETL, data analysis, CSV/Excel/JSON processing, chart generation, statistical analysis, data cleaning, report creation. Makes sense of any dataset.',
    });
  }

  async run(task) {
    const { action = 'analyze', data, filePath, query } = task;

    switch (action) {
      case 'analyze':       return this.analyze(data || filePath, query);
      case 'clean':         return this.clean(data || filePath);
      case 'transform':     return this.transform(data || filePath, task.transforms);
      case 'query':         return this.queryData(data || filePath, query);
      case 'visualize':     return this.visualize(data || filePath, task.chartType);
      case 'report':        return this.generateReport(data || filePath, task.title);
      case 'merge':         return this.mergeDatasets(task.files);
      case 'stats':         return this.statistics(data || filePath);
      case 'export':        return this.export(data, task.format, task.outputPath);
      case 'from_url':      return this.fromURL(task.url, query);
      default:              return this.analyze(data || filePath, query);
    }
  }

  // ─── ANALYZE DATA ─────────────────────────────────────────────────────────

  async analyze(source, query = 'Provide a comprehensive analysis of this data.') {
    this.log(`Analyzing data: ${typeof source === 'string' ? source : 'inline data'}`);
    const data = await this._load(source);
    const sample = this._sample(data, 50);

    const analysis = await structured(
      `Analyze this dataset.\n\nQuery: "${query}"\n\nData sample (${sample.length} of ${data.length} rows):\n${JSON.stringify(sample, null, 2)}\n\nData types detected: ${this._detectTypes(sample)}`,
      {
        summary: 'executive summary of the data',
        rowCount: 'total records',
        columns: ['column names and their types'],
        keyInsights: ['most important insights from the data'],
        trends: ['any trends or patterns'],
        anomalies: ['unusual values or outliers'],
        dataQuality: { score: '0-100', issues: ['data quality issues found'] },
        recommendations: ['what to do with this data'],
        answer: 'direct answer to the query if specified',
      },
      { temperature: 0.3 }
    );

    this.remember(`Analyzed dataset: ${analysis.summary?.slice(0, 100)}`, { tags: ['data', 'analysis'], importance: 6 });
    return { analysis, sample: sample.slice(0, 5), total: data.length };
  }

  // ─── CLEAN DATA ───────────────────────────────────────────────────────────

  async clean(source) {
    const data = await this._load(source);
    this.log(`Cleaning ${data.length} rows`);

    const cleanPlan = await structured(
      `Plan data cleaning for this dataset.\n\nSample: ${JSON.stringify(this._sample(data, 20), null, 2)}`,
      {
        operations: [
          { type: 'remove_nulls|trim_strings|normalize_types|deduplicate|fix_dates|fill_missing', column: 'column name or *', value: 'fill value if applicable' }
        ],
        summary: 'what cleaning is needed',
      }
    );

    let cleaned = [...data];
    for (const op of cleanPlan.operations || []) {
      cleaned = this._applyCleanOp(cleaned, op);
    }

    const before = data.length;
    const after = cleaned.length;
    const report = { before, after, removed: before - after, plan: cleanPlan };

    // Save cleaned data
    const outputPath = path.join(OUTPUT_DIR, `cleaned-${Date.now()}.json`);
    writeFileSync(outputPath, JSON.stringify(cleaned, null, 2));

    return { cleaned, report, outputPath };
  }

  // ─── QUERY DATA WITH NATURAL LANGUAGE ─────────────────────────────────────

  async queryData(source, query) {
    const data = await this._load(source);
    const sample = this._sample(data, 30);

    // Generate and execute JavaScript filter/map code
    const codeResponse = await complete(
      `Write JavaScript code to answer this query about the dataset.\n\nQuery: "${query}"\n\nDataset sample: ${JSON.stringify(sample, null, 2)}\n\nWrite code that:\n1. Takes 'data' as an array of objects\n2. Returns the answer to the query\n3. Uses array methods (filter, map, reduce, sort)\n4. Returns a clean result\n\nRespond with ONLY the JavaScript expression (no function wrapper, no console.log). It will be executed as: eval('(data) => ' + code)`,
      { temperature: 0.1, maxTokens: 500 }
    );

    try {
      const fn = eval(`(data) => ${codeResponse}`);
      const result = fn(data);
      return { query, result, rowsProcessed: data.length, code: codeResponse };
    } catch (err) {
      // Fallback to AI analysis
      return this.analyze(data, query);
    }
  }

  // ─── STATISTICS ───────────────────────────────────────────────────────────

  async statistics(source) {
    const data = await this._load(source);
    const stats = {};

    if (!data.length) return { stats, error: 'Empty dataset' };

    const numericCols = Object.keys(data[0]).filter(k => typeof data[0][k] === 'number' || !isNaN(parseFloat(data[0][k])));

    for (const col of numericCols) {
      const values = data.map(r => parseFloat(r[col])).filter(v => !isNaN(v));
      if (!values.length) continue;

      const sorted = [...values].sort((a, b) => a - b);
      const sum = values.reduce((a, b) => a + b, 0);
      const mean = sum / values.length;
      const variance = values.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / values.length;

      stats[col] = {
        count: values.length,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        mean: parseFloat(mean.toFixed(4)),
        median: sorted[Math.floor(sorted.length / 2)],
        stdDev: parseFloat(Math.sqrt(variance).toFixed(4)),
        sum: parseFloat(sum.toFixed(4)),
        q1: sorted[Math.floor(sorted.length * 0.25)],
        q3: sorted[Math.floor(sorted.length * 0.75)],
      };
    }

    // AI interpretation
    const interpretation = await complete(
      `Interpret these statistics:\n${JSON.stringify(stats, null, 2)}\n\nProvide key insights in plain English.`,
      { temperature: 0.3, maxTokens: 500 }
    );

    return { stats, interpretation, rowCount: data.length, numericColumns: numericCols };
  }

  // ─── VISUALIZE (generates Chart.js HTML) ──────────────────────────────────

  async visualize(source, chartType = 'auto') {
    const data = await this._load(source);
    const sample = this._sample(data, 100);

    // Determine best chart type
    if (chartType === 'auto') {
      const cols = Object.keys(sample[0] || {});
      const hasDate = cols.some(c => c.toLowerCase().includes('date') || c.toLowerCase().includes('time'));
      chartType = hasDate ? 'line' : cols.length <= 2 ? 'bar' : 'bar';
    }

    const chartCode = await complete(
      `Generate a complete, self-contained HTML page with a Chart.js chart.\n\nChart type: ${chartType}\nData: ${JSON.stringify(sample.slice(0, 50), null, 2)}\n\nRequirements:\n- Use Chart.js from CDN\n- Beautiful dark theme\n- Responsive\n- Include data labels\n- Professional styling\n- Embedded data (no external data files)\n\nReturn ONLY the complete HTML file.`,
      { temperature: 0.2, maxTokens: 4000 }
    );

    const outputPath = path.join(OUTPUT_DIR, `chart-${Date.now()}.html`);
    writeFileSync(outputPath, chartCode);

    return { chartType, outputPath, rows: sample.length, message: `Chart saved to ${outputPath}` };
  }

  // ─── GENERATE REPORT ─────────────────────────────────────────────────────

  async generateReport(source, title = 'Data Analysis Report') {
    const data = await this._load(source);
    const { analysis } = await this.analyze(data, 'Full comprehensive analysis');
    const { stats } = await this.statistics(data);

    const reportHTML = await complete(
      `Generate a professional HTML data analysis report.\n\nTitle: ${title}\nAnalysis: ${JSON.stringify(analysis, null, 2)}\nStats: ${JSON.stringify(stats, null, 2)}\nRow count: ${data.length}\n\nRequirements:\n- Complete self-contained HTML\n- Professional styling (dark theme, tables, sections)\n- Executive summary at top\n- Key insights highlighted\n- Statistics table\n- Recommendations section\n- Footer with generation date\n\nReturn ONLY the HTML.`,
      { temperature: 0.2, maxTokens: 6000 }
    );

    const outputPath = path.join(OUTPUT_DIR, `report-${Date.now()}.html`);
    writeFileSync(outputPath, reportHTML);

    return { title, outputPath, rows: data.length, analysis: analysis.summary };
  }

  // ─── MERGE DATASETS ───────────────────────────────────────────────────────

  async mergeDatasets(files) {
    const datasets = await Promise.all(files.map(f => this._load(f)));
    const merged = datasets.flat();

    const outputPath = path.join(OUTPUT_DIR, `merged-${Date.now()}.json`);
    writeFileSync(outputPath, JSON.stringify(merged, null, 2));

    return { merged: merged.slice(0, 5), total: merged.length, files: files.length, outputPath };
  }

  // ─── FETCH DATA FROM URL ──────────────────────────────────────────────────

  async fromURL(url, query) {
    const axios = (await import('axios')).default;
    const resp = await axios.get(url, { timeout: 15000 });
    let data = resp.data;

    if (typeof data === 'string') {
      // Try CSV
      data = this._parseCSV(data);
    }

    return this.analyze(data, query);
  }

  // ─── EXPORT ───────────────────────────────────────────────────────────────

  async export(data, format = 'json', outputPath = null) {
    const loaded = await this._load(data);
    const out = outputPath || path.join(OUTPUT_DIR, `export-${Date.now()}.${format}`);

    if (format === 'json') {
      writeFileSync(out, JSON.stringify(loaded, null, 2));
    } else if (format === 'csv') {
      const csv = this._toCSV(loaded);
      writeFileSync(out, csv);
    } else if (format === 'tsv') {
      writeFileSync(out, this._toCSV(loaded, '\t'));
    }

    return { exported: true, path: out, format, rows: loaded.length };
  }

  // ─── HELPERS ─────────────────────────────────────────────────────────────

  async _load(source) {
    if (!source) throw new Error('No data source provided');

    // Already an array
    if (Array.isArray(source)) return source;

    // String path to file
    if (typeof source === 'string' && existsSync(source)) {
      const ext = path.extname(source).toLowerCase();
      const content = readFileSync(source, 'utf8');

      if (ext === '.json') return JSON.parse(content);
      if (ext === '.csv' || ext === '.tsv') return this._parseCSV(content, ext === '.tsv' ? '\t' : ',');
      if (ext === '.jsonl') return content.trim().split('\n').map(l => JSON.parse(l));
    }

    // Try JSON parse
    if (typeof source === 'string') {
      try { return JSON.parse(source); } catch {}
      // Try CSV
      return this._parseCSV(source);
    }

    if (typeof source === 'object') return [source];
    throw new Error(`Cannot load data from: ${typeof source}`);
  }

  _parseCSV(text, delimiter = ',') {
    const lines = text.trim().split('\n');
    if (!lines.length) return [];
    const headers = lines[0].split(delimiter).map(h => h.replace(/"/g, '').trim());
    return lines.slice(1).map(line => {
      const values = line.split(delimiter).map(v => v.replace(/"/g, '').trim());
      return Object.fromEntries(headers.map((h, i) => [h, values[i] || '']));
    });
  }

  _toCSV(data, delimiter = ',') {
    if (!data.length) return '';
    const headers = Object.keys(data[0]);
    const rows = data.map(r => headers.map(h => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(delimiter));
    return [headers.join(delimiter), ...rows].join('\n');
  }

  _sample(data, n) {
    if (data.length <= n) return data;
    const step = Math.floor(data.length / n);
    return Array.from({ length: n }, (_, i) => data[i * step]).filter(Boolean);
  }

  _detectTypes(sample) {
    if (!sample.length) return '{}';
    return Object.entries(sample[0]).map(([k, v]) => `${k}: ${typeof v}`).join(', ');
  }

  _applyCleanOp(data, op) {
    switch (op.type) {
      case 'remove_nulls':
        return data.filter(r => op.column === '*' ? Object.values(r).every(v => v !== null && v !== '') : r[op.column] !== null && r[op.column] !== '');
      case 'trim_strings':
        return data.map(r => {
          const out = { ...r };
          const cols = op.column === '*' ? Object.keys(r) : [op.column];
          cols.forEach(c => { if (typeof out[c] === 'string') out[c] = out[c].trim(); });
          return out;
        });
      case 'deduplicate':
        return [...new Map(data.map(r => [JSON.stringify(r), r])).values()];
      case 'fill_missing':
        return data.map(r => ({ ...r, [op.column]: r[op.column] || op.value }));
      default:
        return data;
    }
  }
}

export default DataAgent;
