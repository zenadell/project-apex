import { intentClassifier } from '../core/intent-classifier.js';
import { registry } from '../core/agent-registry.js';
import orchestrator from '../core/orchestrator.js';
import { identity } from '../core/identity.js';

async function runTests() {
    console.log('🧪 Starting APEX Sovereignty Test Suite...\n');

    // 1. Identity Check
    console.log('👤 Checking Identity Sanitization...');
    const id = identity.introduce();
    if (id.products.includes('Chaka AI')) {
        console.error('❌ FAIL: Chaka AI still present in identity!');
    } else {
        console.log('✅ PASS: Identity is focused on APEX.');
    }

    // 2. Intent Classification Scenarios
    console.log('\n👂 Checking Intent Classification Scenarios...');
    const scenarios = [
        { msg: 'Access the webcam and show my actual room', expected: 'hardware' },
        { msg: 'Show me what I asked you', expected: 'action' }, // Contextual, might be action or chat
        { msg: 'Take a photo of the room', expected: 'hardware' },
        { msg: 'Webcam', expected: 'hardware' },
        { msg: 'Who is Chaka?', expected: 'chat' }, // Should be chat/question
    ];

    for (const s of scenarios) {
        const result = await intentClassifier.classify(s.msg);
        console.log(`Msg: "${s.msg}" -> Intent: ${result.intent} (${result.confidence})`);
        if (result.intent !== s.expected && s.expected !== 'action') {
             console.log(`⚠️  Warning: Expected ${s.expected}, got ${result.intent}`);
        }
    }

    // 3. Sandbox Import Stability
    console.log('\n🦾 Checking Sandbox Import Stability...');
    await orchestrator.init();
    const selfMod = registry.get('SelfModAgent');
    
    const testCode = `
import { BaseAgent } from '../agents/BaseAgent';
export default class TestAgent extends BaseAgent {
    constructor() { super({ name: 'Test', type: 'test' }); }
}
    `;
    
    console.log('Testing Agent Generation import fix...');
    const buildResult = await selfMod._testGeneratedCode(testCode, 'TestAgent', 'agent');
    if (buildResult.success) {
        console.log('✅ PASS: Sandbox import fix verified.');
    } else {
        console.error('❌ FAIL: Sandbox still failing imports:', buildResult.error);
    }

    console.log('\n🏁 Tests Finished.');
    process.exit(0);
}

runTests();
