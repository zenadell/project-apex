import orchestrator from '../core/orchestrator.js';

async function testAutonomy() {
    console.log('--- EXTREME AUTONOMY STRESS TEST ---');
    await orchestrator.init();
    
    console.log('1. Testing Voice Humanity...');
    const res1 = await orchestrator.execute('speak to me');
    console.log(`Result: ${res1.synthesis}`);
    
    console.log('\n2. Testing Autonomous Self-Repair of PDF Tool...');
    const res2 = await orchestrator.execute('APEX, fix your broken PDF plugin now.');
    console.log(`Result: ${res2.synthesis}`);
    
    console.log('\n--- TEST COMPLETE ---');
    process.exit(0);
}

testAutonomy().catch(err => {
    console.error('Test Failed:', err);
    process.exit(1);
});
