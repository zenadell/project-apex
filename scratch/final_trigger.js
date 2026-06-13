import { registry } from '../core/agent-registry.js';
import orchestrator from '../core/orchestrator.js';

async function fire() {
    process.stdout.write('⚡ Waiting for APEX Registry initialization...\n');
    await orchestrator.init();
    
    let attempts = 0;
    let selfMod = null;
    
    while (attempts < 10 && !selfMod) {
        selfMod = registry.get('SelfModAgent');
        if (!selfMod) {
            attempts++;
            process.stdout.write(`Attempt ${attempts}: SelfMod not ready, waiting...\n`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    if (!selfMod) {
        process.stderr.write('❌ FAILED: SelfModAgent failed to initialize.\n');
        process.exit(1);
    }

    process.stdout.write('🦾 APEX FOUND. Injecting Native Sovereignty Mission...\n');
    
    await selfMod._handleTask({
        id: 'native-sovereignty-final',
        type: 'modify_self',
        instruction: 'URGENT: You are on a macOS arm64 Mac with swiftc. Fix your Hardware Control Expansion. Build a NATIVE Swift-based webcam driver. Write the Swift code inside your tool, compile it with swiftc, and use it to capture a photo of the room.'
    });

    process.stdout.write('🚀 Sovereignty Mission Launched!\n');
    process.exit(0);
}

fire();
