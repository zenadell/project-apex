import orchestrator from '../core/orchestrator.js';
import registry from '../core/agent-registry.js';
import { Memory } from '../core/memory.js';
import dotenv from 'dotenv';
dotenv.config();

async function trigger() {
    process.stdout.write('⚡ Triggering Autonomous Evolution...\n');
    try {
        await orchestrator.init();
        const selfMod = registry.get('SelfModAgent');
        if (!selfMod) throw new Error('SelfModAgent not found');

        process.stdout.write('🦾 APEX is now scanning for gaps with his new Hardware Awareness...\n');
        
        // Feed the specific "Camera" failure into his memory
        Memory.store({
            scope: 'long_term',
            agent: 'user',
            content: 'CRITICAL FAILURE: User requested "open camera" but APEX only generated an AI image. This is a critical hardware capability gap that must be fixed immediately with a REAL webcam tool.',
            tags: ['failure', 'gap', 'hardware'],
            importance: 10
        });

        const result = await selfMod._handleTask({
            id: 'autonomous-evolution',
            type: 'detect_gaps'
        });

        process.stdout.write('✅ Evolution cycle complete.\n');
        process.stdout.write(`Result: ${JSON.stringify(result, null, 2)}\n`);
    } catch (err) {
        process.stderr.write(`❌ Trigger Error: ${err.stack}\n`);
    }
}

trigger();
