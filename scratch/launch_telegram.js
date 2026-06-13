import orchestrator from '../core/orchestrator.js';
import dotenv from 'dotenv';
dotenv.config();

async function launch() {
    process.stdout.write('⚡ APEX Autonomous Launcher\n');
    try {
        await orchestrator.init();
        process.stdout.write('✅ Orchestrator Initialized\n');
        
        // Start Telegram channel manually
        const { TelegramChannel } = await import('../tools/channels.js');
        
        const telegram = new TelegramChannel(orchestrator);
        await telegram.start(process.env.TELEGRAM_BOT_TOKEN);
        
        process.stdout.write('✅ Telegram bot online\n');
        process.stdout.write('✅ Telegram Channel Active & Polling\n');
    } catch (err) {
        process.stderr.write(`❌ FATAL LAUNCH ERROR: ${err.stack}\n`);
        process.exit(1);
    }
}

launch();
