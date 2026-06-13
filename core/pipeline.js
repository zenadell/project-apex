// core/pipeline.js
// APEX Pipeline Runner — executes named multi-step pipelines from config/agents.yaml
import { v4 as uuidv4 } from 'uuid';
import chalk from 'chalk';
import ora from 'ora';
import bus from './event-bus.js';
import registry from './agent-registry.js';
import Memory from './memory.js';
import { getPipeline } from '../config/loader.js';
import { complete } from './llm.js';

export class PipelineRunner {
  constructor() {
    this._running = {};
  }

  // Run a named pipeline from config
  async run(pipelineName, variables = {}) {
    const pipeline = getPipeline(pipelineName);
    if (!pipeline) throw new Error(`Pipeline "${pipelineName}" not found in config/agents.yaml`);
    return this.execute(pipeline, variables);
  }

  // Execute a pipeline definition directly
  async execute(pipeline, variables = {}) {
    const pipelineId = uuidv4();
    const startTime = Date.now();
    const results = {};

    console.log(chalk.cyan(`\n🔁 Pipeline: ${pipeline.description || 'unnamed'}\n`));
    bus.emit('pipeline:started', { id: pipelineId, pipeline: pipeline.description });

    for (let i = 0; i < pipeline.steps.length; i++) {
      const step = pipeline.steps[i];

      // Check dependencies
      if (step.dependsOn !== undefined) {
        const deps = Array.isArray(step.dependsOn) ? step.dependsOn : [step.dependsOn];
        for (const dep of deps) {
          if (!results[dep]) {
            console.log(chalk.yellow(`  ⚠️  Step ${i} waiting for step ${dep}...`));
          }
        }
      }

      // Substitute variables in task string
      const taskStr = this._interpolate(step.task, variables, results, i);

      const spinner = ora(chalk.blue(`  Step ${i + 1}/${pipeline.steps.length}: ${step.agent}`)).start();

      try {
        const agent = registry.get(step.agent);
        if (!agent) throw new Error(`Agent "${step.agent}" not registered`);

        const taskObj = this._buildTaskObject(step.agent, taskStr, results);

        // Parallel steps
        if (step.parallel) {
          results[i] = this._runParallel(step, taskObj);
        } else {
          results[i] = await agent._handleTask({ id: uuidv4(), ...taskObj });
        }

        spinner.succeed(chalk.green(`  Step ${i + 1}: ${step.agent} ✓`));
        bus.emit('pipeline:step_complete', { pipelineId, step: i, agent: step.agent });
      } catch (err) {
        spinner.fail(chalk.red(`  Step ${i + 1}: ${step.agent} ✗ — ${err.message}`));
        results[i] = { error: err.message };
        bus.emit('pipeline:step_failed', { pipelineId, step: i, error: err.message });
      }
    }

    // Synthesize all results
    const synthesis = await this._synthesize(pipeline, results, variables);

    const duration = Date.now() - startTime;
    Memory.storeTask({
      id: pipelineId,
      task: `Pipeline: ${pipeline.description}`,
      plan: pipeline,
      result: synthesis,
      agentsUsed: pipeline.steps.map(s => s.agent),
      success: true,
      durationMs: duration,
    });

    bus.emit('pipeline:completed', { id: pipelineId, duration });
    console.log(chalk.green(`\n✅ Pipeline complete in ${(duration / 1000).toFixed(1)}s\n`));

    return { pipelineId, results, synthesis, duration };
  }

  // Build a pipeline on the fly with AI
  async buildAndRun(objective) {
    const pipeline = await this._generatePipeline(objective);
    return this.execute(pipeline, { objective });
  }

  async _generatePipeline(objective) {
    const agentList = registry.all().map(a => `${a.name}: ${a.description}`).join('\n');
    const { structured } = await import('./llm.js');

    return structured(
      `Design an optimal multi-agent pipeline for: "${objective}"\n\nAvailable agents:\n${agentList}\n\nCreate a pipeline with 2-6 steps.`,
      {
        description: 'pipeline description',
        steps: [
          {
            agent: 'agent name',
            task: 'task description (use {objective} for the main goal)',
            parallel: false,
            dependsOn: null,
          }
        ],
      }
    );
  }

  _interpolate(task, variables, results, currentStep) {
    let result = task;
    // Replace {variable} placeholders
    for (const [key, value] of Object.entries(variables)) {
      result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }
    // Replace {stepN} with previous step results
    for (let i = 0; i < currentStep; i++) {
      const stepResult = results[i];
      if (stepResult) {
        const summary = typeof stepResult === 'string'
          ? stepResult.slice(0, 200)
          : JSON.stringify(stepResult).slice(0, 200);
        result = result.replace(new RegExp(`\\{step${i}\\}`, 'g'), summary);
      }
    }
    return result;
  }

  _buildTaskObject(agentName, task, previousResults) {
    const context = Object.values(previousResults)
      .filter(r => r && !r.error)
      .slice(-2)
      .map(r => (typeof r === 'string' ? r : JSON.stringify(r)).slice(0, 800))
      .join('\n\n');

    const map = {
      ResearchAgent: { query: task, context },
      CodeAgent: { objective: task, context },
      UIAgent: { objective: task, context },
      ArchitectAgent: { objective: task },
      SecurityAgent: { objective: task },
      BrowserAgent: { objective: task },
      QAAgent: { objective: task },
      SkillsAgent: { objective: task, type: 'auto' },
      SelfModAgent: { type: 'detect_gaps' },
      VoiceAgent: { text: task, action: 'speak' },
    };

    return map[agentName] || { prompt: task, context };
  }

  async _runParallel(step, taskObj) {
    const agent = registry.get(step.agent);
    return agent._handleTask({ id: uuidv4(), ...taskObj });
  }

  async _synthesize(pipeline, results, variables) {
    const resultSummary = Object.entries(results)
      .map(([i, r]) => {
        const agent = pipeline.steps[i]?.agent || `Step ${i}`;
        const content = typeof r === 'string' ? r : JSON.stringify(r);
        return `${agent}:\n${content.slice(0, 800)}`;
      })
      .join('\n\n---\n\n');

    return complete(
      `Synthesize these pipeline results into a clear, comprehensive summary:\n\nPipeline: ${pipeline.description}\nVariables: ${JSON.stringify(variables)}\n\nResults:\n${resultSummary}\n\nProvide a clean, actionable summary of everything accomplished.`,
      { temperature: 0.3, maxTokens: 2000 }
    );
  }
}

export const pipelineRunner = new PipelineRunner();
export default pipelineRunner;
