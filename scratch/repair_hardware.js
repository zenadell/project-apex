import orchestrator from '../core/orchestrator.js';
import registry from '../core/agent-registry.js';
import dotenv from 'dotenv';
dotenv.config();

async function trigger() {
    process.stdout.write('⚡ Triggering Autonomous Repair...\n');
    try {
        await orchestrator.init();
        const selfMod = registry.get('SelfModAgent');
        if (!selfMod) throw new Error('SelfModAgent not found');

        process.stdout.write('🦾 APEX is auditing his own Hardware tool...\n');
        
        // Explicitly tell him it's broken
        const result = await selfMod.repairPlugin('Hardware Access API');

        process.stdout.write('✅ Repair cycle complete.\n');
        process.stdout.write(`Result: ${JSON.stringify(result, null, 2)}\n`);
    } catch (err) {
        process.stderr.write(`❌ Repair Error: ${err.stack}\n`);
    }
}

trigger();
