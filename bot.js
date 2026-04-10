const mineflayer = require('mineflayer');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  bot: {
    host: 'play.pcsmp.net',
    username: 'Habibi',
    version: '1.21.1'
  }
};

// ============================================================================
// LIFESTEAL BOT - Minimal connection only
// ============================================================================

class LifestealBot {
  constructor(config) {
    this.config = config;
    this.bot = null;
  }

  connect() {
    console.log('🤖 Lifesteal bot starting...');

    this.bot = mineflayer.createBot(this.config.bot);

    this.bot.on('login', () => {
      console.log('✅ Connected to', this.config.bot.host);
    });

    this.bot.on('spawn', () => {
      console.log('🎮 Bot spawned in lifesteal world');
      this.bot.chat('Lifesteal bot online.');
    });

    this.bot.on('error', (err) => {
      console.error('❌ Bot error:', err);
    });

    this.bot.on('kicked', (reason) => {
      console.log('👢 Bot was kicked:', reason);
      this.reconnect();
    });

    this.bot.on('end', () => {
      console.log('🔌 Connection ended');
      this.reconnect();
    });
  }

  reconnect() {
    const delay = 5000;
    console.log(`🔄 Reconnecting in ${delay / 1000} seconds...`);
    setTimeout(() => this.connect(), delay);
  }
}

// ============================================================================
// START BOT
// ============================================================================

const lifestealBot = new LifestealBot(CONFIG);
lifestealBot.connect();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down bot...');
  if (lifestealBot.bot) {
    lifestealBot.bot.chat('Lifesteal bot going offline.');
    lifestealBot.bot.quit();
  }
  process.exit(0);
});
