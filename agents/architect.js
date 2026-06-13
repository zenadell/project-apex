// agents/architect.js
// APEX ArchitectAgent — System design, database schemas, API contracts, infrastructure planning.
import { BaseAgent } from './base-agent.js';
import { complete, structured } from '../core/llm.js';
import Memory from '../core/memory.js';

export class ArchitectAgent extends BaseAgent {
  constructor() {
    super({
      name: 'ArchitectAgent',
      type: 'architecture',
      description: 'Designs complete system architectures. DB schemas, API contracts, microservice boundaries, infrastructure diagrams, tech stack decisions. Thinks at the 10,000ft view before anyone writes code.',
    });
  }

  async run(task) {
    const { objective, scale = 'startup', constraints = [], existing = null } = task;
    this.log(`ArchitectAgent: Designing "${objective}"`);

    const architecture = await this._fullArchitecture(objective, scale, constraints, existing);

    this.remember(
      `Architecture for "${objective}": ${architecture.techStack?.join(', ')}`,
      { tags: ['architecture', 'design'], importance: 8, scope: 'long_term' }
    );

    return architecture;
  }

  async _fullArchitecture(objective, scale, constraints, existing) {
    // Mem0: Fetch past Warden failures to prevent repeating mistakes
    let failureContext = '';
    try {
      const pastFailures = Memory.search('warden_failure', { limit: 5 });
      if (pastFailures && pastFailures.length > 0) {
        failureContext = `\nCRITICAL CONTEXT FROM MEMORY (Past Warden Rejections to strictly avoid):\n${pastFailures.map(f => f.content).join('\n---\n')}\n`;
      }
    } catch(e) {}

    return structured(
      `You are a Principal Software Architect.\n\nDesign a complete production system for: "${objective}"\nScale: ${scale}\nConstraints: ${constraints.join(', ') || 'none'}\nExisting systems: ${existing || 'greenfield'}${failureContext}\n\nProvide a comprehensive architecture document.`,
      {
        systemOverview: 'description of what the system does',
        techStack: ['ordered list of technologies'],
        services: [
          {
            name: 'service name',
            responsibility: 'what it does',
            technology: 'tech used',
            port: 'port number',
            endpoints: ['key API endpoints'],
          }
        ],
        database: {
          type: 'PostgreSQL/MongoDB/Redis/etc',
          schemas: [
            {
              name: 'table/collection name',
              fields: [{ name: 'field', type: 'type', constraints: 'constraints' }],
              indexes: ['indexed fields'],
              relationships: ['foreign key relationships'],
            }
          ],
          caching: 'caching strategy',
        },
        api: {
          style: 'REST/GraphQL/gRPC',
          authentication: 'auth mechanism',
          versioning: 'API versioning strategy',
          endpoints: [
            {
              method: 'GET/POST/PUT/DELETE',
              path: '/api/path',
              description: 'what it does',
              requestBody: {},
              response: {},
              auth: 'required/optional/public',
            }
          ],
        },
        infrastructure: {
          hosting: 'where to host',
          containerization: 'Docker/k8s strategy',
          cicd: 'CI/CD approach',
          monitoring: 'logging and monitoring',
          scaling: 'horizontal/vertical scaling strategy',
        },
        security: {
          authentication: 'auth approach',
          authorization: 'RBAC/ABAC',
          encryption: 'data encryption',
          rateLimit: 'rate limiting strategy',
          secrets: 'secrets management',
        },
        estimatedCost: 'monthly cost estimate',
        buildOrder: ['ordered list of what to build first'],
        risks: ['technical risks'],
        alternatives: ['alternative approaches considered'],
        diagram: 'ASCII diagram of system architecture',
      },
      { temperature: 0.3, maxTokens: 6000 }
    );
  }

  // Generate a DB migration file
  async generateMigration(schema, targetDb = 'postgresql') {
    return complete(
      `Generate a database migration for ${targetDb}:\n${JSON.stringify(schema, null, 2)}\n\nReturn complete SQL or migration code.`,
      { temperature: 0.1, maxTokens: 3000 }
    );
  }

  // Generate OpenAPI spec
  async generateOpenAPI(apiSpec, version = '3.0.0') {
    return complete(
      `Generate a complete OpenAPI ${version} specification for:\n${JSON.stringify(apiSpec, null, 2)}\n\nReturn valid YAML.`,
      { temperature: 0.1, maxTokens: 4000 }
    );
  }

  // Evaluate an existing codebase and propose improvements
  async evaluateAndImprove(codebaseDescription) {
    return structured(
      `Evaluate this existing codebase and propose architectural improvements:\n${codebaseDescription}\n\nBe specific and prioritized.`,
      {
        currentScore: 'score out of 100',
        strengths: ['what is good'],
        antiPatterns: ['bad patterns found'],
        improvements: [{ priority: 'high/medium/low', change: 'what to change', benefit: 'why' }],
        migrationPath: ['ordered steps to improve the architecture'],
        estimatedEffort: 'time to implement improvements',
      }
    );
  }
}

export default ArchitectAgent;
