const mineflayer = require('mineflayer');

// ============================================================================
// CONFIGURATION - Server connection only
// ============================================================================
const CONFIG = {
  server: {
    host: 'play.pcsmp.net',
    port: 25565,
    username: 'Habibi',
    version: '1.12.2',
  }
};

// ============================================================================
// LIFESTEAL BOT - Joins server and clicks into lifesteal mode
// ============================================================================
let bot = null;
let isInGame = false;
let isLoggedIn = false;

function createBot() {
  console.log('[Bot] Connecting to server...');
  
  bot = mineflayer.createBot({
    host: CONFIG.server.host,
    port: CONFIG.server.port,
    username: CONFIG.server.username,
    version: CONFIG.server.version,
  });

  bot.once('spawn', () => {
    console.log('[Bot] Spawned in world');
    isInGame = true;
    bot.chat('Lifesteal bot online.');
  });

  // Auto‑reconnect on disconnect
  bot.on('end', () => {
    console.log('[Bot] Disconnected. Reconnecting in 5s...');
    isInGame = false;
    isLoggedIn = false;
    setTimeout(createBot, 5000);
  });

  bot.on('error', (err) => console.log(`[Error] ${err.message}`));
  bot.on('kicked', (reason) => console.log(`[Kicked] ${reason}`));

  // ─────────────────────────────────────────────────────────────────
  // HANDLE SERVER MESSAGES (auto‑login, keep‑alive, lifesteal menu)
  // ─────────────────────────────────────────────────────────────────
  bot.on('message', (jsonMsg) => {
    const text = jsonMsg.toString().trim();
    if (!text) return;
    const lower = text.toLowerCase();

    // Suppress chunk loading spam
    if (lower.includes('ignoring block entities')) return;

    console.log(`[Server] ${text}`);

    // Auto‑login (common on cracked servers)
    if (!isLoggedIn && lower.includes('/login')) {
      console.log('[Bot] Auto‑logging in...');
      bot.chat('/login 551417114'); // Replace with actual password if needed
      isLoggedIn = true;
      return;
    }

    if (lower.includes('successfully logged')) isLoggedIn = true;
    if (lower.includes('[+] habibi') || (lower.includes('joined the game') && lower.includes('habibi'))) {
      isInGame = true;
    }
    if (lower.includes('limbo') || lower.includes('queue')) isInGame = false;
    if (lower.includes('teleport to you')) {
      setTimeout(() => bot.chat('/tpaccept'), 1000);
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // CLICK INTO LIFESTEAL MENU WHEN IT OPENS
  // ─────────────────────────────────────────────────────────────────
  bot.on('windowOpen', (window) => {
    // Detect the lifesteal menu – adjust the title if yours is different
    if (window.title && (
      window.title.includes('Lifesteal') ||
      window.title.includes('Select Mode') ||
      window.title.includes('Play') ||
      window.title.includes('Game Menu')
    )) {
      console.log(`[Bot] Lifesteal menu detected (title: "${window.title}"). Clicking slot 0.`);
      
      // Click the first slot (slot 0) with a normal left click
      bot.clickWindow(0, 0, 0, (err) => {
        if (err) {
          console.log(`[Bot] Error clicking slot: ${err.message}`);
          return;
        }
        console.log('[Bot] Successfully clicked slot 0. Joining lifesteal...');
      });

      // Close the window after a short delay to keep things tidy
      setTimeout(() => window.close(), 500);
    }
  });
}

// ============================================================================
// START BOT
// ============================================================================
createBot();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Bot] Shutting down...');
  if (bot) {
    bot.chat('Lifesteal bot going offline.');
    bot.quit();
  }
  process.exit(0);
});
