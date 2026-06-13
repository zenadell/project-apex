// scratch/test-sandbox.js
import SelfModAgent from '../agents/self-mod.js';
import registry from '../core/agent-registry.js';

const agent = new SelfModAgent();

async function testSandbox() {
  console.log('🧪 Testing Sandbox Chamber...');
  
  // Create a BROKEN agent (syntax error)
  const brokenCode = `
    import { BaseAgent } from './base-agent.js';
    export default class BrokenAgent extends BaseAgent {
      constructor() {
        super({ name: 'BrokenAgent', type: 'test' });
      }
      run(task) {
        // Missing closing brace or something - deliberate syntax error
    `;
    
  try {
    console.log('--- Attempting to test broken code ---');
    const result = await agent._testGeneratedCode(brokenCode, 'BrokenAgent', 'agent');
    console.log('Result:', result.success ? 'UNEXPECTED_PASS' : 'EXPECTED_FAIL');
    if (!result.success) {
      console.log('✅ Sandbox successfully caught syntax error:');
      console.log(result.error);
    }
  } catch (e) {
    console.log('Caught error:', e.message);
  }
}

testSandbox();
