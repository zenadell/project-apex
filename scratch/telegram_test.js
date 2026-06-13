import { orchestrator } from '../core/orchestrator.js';
import { capabilityRouter } from '../core/capability-router.js';
import { ApexMessageHandler } from '../tools/channels.js';

async function run() {
  await orchestrator.init();
  const handler = new ApexMessageHandler(orchestrator);
  
  console.log("SENDING MESSAGE: 'show me the room'");
  const result = await handler.handle("show me the room", 12345, 'telegram', { chatId: 12345 });
  console.log("RESULT:", JSON.stringify(result, null, 2));
  process.exit(0);
}
run();
