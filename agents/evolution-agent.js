import { BaseAgent } from './base-agent.js';
import { complete } from '../core/llm.js';
import registry from '../core/agent-registry.js';
import { z } from 'zod';
import chalk from 'chalk';

const EvolutionPlanSchema = z.object({
  targetFiles: z.array(z.string()),
  dependencies: z.array(z.string()),
  architecture: z.array(z.string()),
  destructive: z.boolean(),
  reasoning: z.string()
});

export class EvolutionAgent extends BaseAgent {
  constructor() {
    super({
      name: 'EvolutionAgent',
      type: 'evolution',
      description: 'The Planning Committee. Drafts strict architectural plans for self-modification before allowing CodeAgent to execute them.'
    });
  }

  async run(task) {
    const { objective } = task;
    this.log(chalk.magenta(`🧬 Initiating Evolutionary Sequence: "${objective}"`));

    // Phase 1: Planning Committee Debate
    this.log('Drafting rigorous architectural plan...');
    const prompt = `You are the APEX Evolution Agent (Planning Committee).
Your objective is to self-modify the APEX core architecture to satisfy: "${objective}"

You must outline the exact files to modify, the architecture to use, and whether this is a destructive change.
Respond ONLY with valid JSON matching this schema:
{
  "targetFiles": ["agents/foo.js"],
  "dependencies": ["zod"],
  "architecture": ["Node.js", "Zod", "Daytona"],
  "destructive": false,
  "reasoning": "Explanation of the evolution"
}`;

    let plan;
    try {
      const response = await complete(prompt, { temperature: 0.1 });
      let cleanJson = response.trim();
      if (cleanJson.startsWith('\`\`\`json')) cleanJson = cleanJson.slice(7);
      else if (cleanJson.startsWith('\`\`\`')) cleanJson = cleanJson.slice(3);
      if (cleanJson.endsWith('\`\`\`')) cleanJson = cleanJson.slice(0, -3);
      
      const parsed = JSON.parse(cleanJson);
      plan = EvolutionPlanSchema.parse(parsed);
      this.log(`Plan Vetted: ${plan.targetFiles.join(', ')}`);
    } catch (err) {
      this.log(`❌ Planning Committee rejected the evolution. Invalid plan: ${err.message}`, 'error');
      return { success: false, message: 'Evolution aborted due to invalid plan.' };
    }

    if (plan.destructive) {
      this.log(`❌ Evolution aborted: Destructive architectural changes are not permitted.`, 'error');
      return { success: false, message: 'Evolution aborted due to destructive flag.' };
    }

    // Phase 2: Orchestrate CodeAgent Execution inside Daytona Sandbox
    const codeAgent = registry.get('CodeAgent');
    if (!codeAgent) throw new Error('CodeAgent not found in registry.');

    this.log(`Handing off to CodeAgent (ApexForge Engine) for Sandbox Execution...`);
    
    // We pass `isSelfModifying` flag so the Warden allows modifications to apex.js/core/agents
    const codeTask = {
      objective: objective,
      outputDir: process.cwd(),
      type: 'project',
      goldenBlueprint: JSON.stringify(plan.architecture),
      isSelfModifying: true 
    };

    const result = await codeAgent.run(codeTask);
    
    if (result && result.success) {
      this.log(chalk.green(`✅ Evolutionary Merge Complete!`));
    } else {
      this.log(chalk.red(`❌ Evolutionary Merge Failed. Reverting changes.`), 'error');
    }
    
    return result;
  }
}
