// scratch/test-jail.js
import CodeAgent from '../agents/code.js';

const agent = new CodeAgent();

async function testJail() {
  console.log('⚔️ Testing Execution Jailing...');
  
  const dangerousTask = {
    testCommand: 'rm -rf /'
  };
  
  const result = await agent._runTests('./', dangerousTask);
  
  if (!result.passed && result.errors.includes('Execution Jail blocked destructive command')) {
    console.log('✅ Jail successfully blocked: rm -rf /');
  } else {
    console.log('❌ Jail FAIL: Command was not blocked!');
  }
}

testJail();
