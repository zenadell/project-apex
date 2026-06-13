// scratch/test-armor.js
import { orchestrator } from '../core/orchestrator.js';
import bus from '../core/event-bus.js';

console.log('🛡️ Testing Global Process Armor...');

bus.on('system:fatal_crash', ({ error, type }) => {
  console.log(`✅ Armor intercepted fatal crash! Type: ${type}`);
  console.log(`Error snippet: ${error.split('\n')[0]}`);
  process.exit(0);
});

// Trigger a fatal uncaught exception (should be caught by apex.js handlers)
setTimeout(() => {
  console.log('💥 Triggering fatal crash...');
  throw new Error('SIMULATED_FATAL_CRASH');
}, 1000);
