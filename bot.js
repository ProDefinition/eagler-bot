const mineflayer = require('mineflayer');
const readline = require('readline');
const { Groq } = require('groq-sdk');

// Catch log, warn, and error to ensure chunk spam is completely muted
['log', 'warn', 'error'].forEach((method) => {
    const original = console[method];
    console[method] = function(...args) {
        if (args.length && typeof args[0] === 'string' && args[0].includes('Ignoring block entities as chunk failed to load')) {
            return;
        }
        original.apply(console, args);
    };
});

const CONFIG = {
  server: {
    host: 'play.pcsmp.net',
    port: 25565,
    username: 'Habibi',
    version: '1.12.2',
  },
  chat: {
    max_length: 250,  
  },
  groq: {
    apiKey: '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', // <-- PASTE YOUR API KEY RIGHT HERE
    model: 'llama3-8b-8192',          // Fast, small model perfect for yes/no classification
    muteDuration: '10m',              // Default mute duration
    maxQueueSize: 100                 // Prevent memory leaks if API is down
  }
};

// ========================
// STATE
// ========================
let bot = null;
let isInGame = false;
let isLoggedIn = false;

// ========================
// GROQ MODERATION QUEUE
// ========================
const groq = new Groq({ apiKey: CONFIG.groq.apiKey });
const modQueue = [];
let isProcessingQueue = false;

async function processModQueue() {
  if (isProcessingQueue || modQueue.length === 0) return;
  isProcessingQueue = true;

  while (modQueue.length > 0) {
    const item = modQueue[0];

    try {
      const response = await groq.chat.completions.create({
        messages: [
          {
            role: 'system',
            content: 'You are a strict chat moderator. Respond ONLY with "YES" if the message contains profanity, slurs, or severe toxicity. Respond ONLY with "NO" if the message is clean.'
          },
          {
            role: 'user',
            content: `Message: "${item.message}"`
          }
        ],
        model: CONFIG.groq.model,
        temperature: 0, // Strict, deterministic output
        max_tokens: 5,  // We only need a yes/no
      });

      const reply = response.choices[0]?.message?.content?.trim().toUpperCase() || 'NO';

      if (reply.includes('YES')) {
        // Truncate to ensure the command doesn't exceed Minecraft's max length (256 chars)
        const safeMessage = item.message.length > 40 ? item.message.substring(0, 37) + '...' : item.message;
        const muteCommand = `/tempmute ${item.sender} ${CONFIG.groq.muteDuration} Auto-Mod Profanity: ${safeMessage}`;
        
        say(muteCommand);
        console.log(`[Moderation] Muted ${item.sender}. Reason: Profanity detected by AI.`);
      }

      // Successfully processed, remove from queue
      modQueue.shift(); 
      
      // Small artificial delay to respect API rate limits
      await new Promise(r => setTimeout(r, 600)); 

    } catch (error) {
      if (error.status === 429) {
        // Rate Limit Hit
        console.warn(`[Moderation] Rate limit hit! Queue size: ${modQueue.length}. Pausing for 10s...`);
        await new Promise(r => setTimeout(r, 10000));
        // We DO NOT shift the array here. The message stays at [0] and will retry on the next loop.
      } else {
        // Network errors or API outages
        console.error(`[Moderation] API Error: ${error.message}`);
        modQueue.shift(); // Drop the message so the queue doesn't lock up forever
      }
    }
  }

  isProcessingQueue = false;
}

// ========================
// UTILITIES
// ========================
function say(text) {
  if (!bot || !text) return;
  text = text.replace(/[\n\r]/g, ' ').trim();
  
  if (text.length <= CONFIG.chat.max_length) {
    console.log(`[Say] ${text}`);
    bot.chat(text);
    return;
  }

  // Split long messages
  let remaining = text;
  while (remaining.length > 0) {
    let chunk = remaining.slice(0, CONFIG.chat.max_length);
    const lastSpace = chunk.lastIndexOf(' ');
    if (lastSpace > CONFIG.chat.max_length / 2) chunk = chunk.slice(0, lastSpace);
    console.log(`[Say] ${chunk}`);
    bot.chat(chunk);
    remaining = remaining.slice(chunk.length).trim();
  }
}

// ========================
// COMMANDS
// ========================
function handleBangCommand(sender, msg) {
  const args = msg.slice(1).split(/\s+/);
  const cmd = args[0].toLowerCase();

  switch (cmd) {
    case 'inventory':
      const items = bot.inventory.items().map(i => `${i.name}: ${i.count}`).join(', ');
      say(`Inventory: ${items || 'empty'}`);
      break;
    case 'status':
      say(`Health: ${Math.round(bot.health)}/${bot.maxHealth}, Food: ${bot.food}/20`);
      break;
    case 'help':
      say('Commands: !inventory, !status, !roll');
      break;
    case 'roll':
      const sides = parseInt(args[1]) || 6;
      const roll = Math.floor(Math.random() * sides) + 1;
      say(`🎲 Rolled: ${roll}/${sides}`);
      break;
    default:
      say(`Unknown command: ${cmd}`);
  }
}

// ========================
// BOT CREATION
// ========================
function createBot() {
  console.log('[Bot] Connecting to server...');

  bot = mineflayer.createBot({
    host: CONFIG.server.host,
    port: CONFIG.server.port,
    username: CONFIG.server.username,
    version: CONFIG.server.version,
  });

  bot.once('spawn', () => {
    console.log('[Bot] Spawned!');
    isInGame = true;

    // Anti-AFK jump
    setInterval(() => {
      if (!bot.entity || !isInGame) return;
      if (Math.random() < 0.1) {
        bot.setControlState('jump', true);
        setTimeout(() => bot.setControlState('jump', false), 300);
      }
    }, 8000);
  });

  bot.on('end', () => {
    console.log('[Bot] Disconnected. Reconnecting in 5s...');
    isInGame = false;
    isLoggedIn = false;
    setTimeout(createBot, 5000);
  });

  bot.on('error', (err) => console.log(`[Error] ${err.message}`));
  bot.on('kicked', (reason) => console.log(`[Kicked] ${reason}`));

  bot.on('message', async (jsonMsg) => {
    const text = jsonMsg.toString().trim();
    if (!text || text.length > 500) return;

    const lower = text.toLowerCase();
    
    if (lower.includes('ignoring block entities')) return;

    if (!isLoggedIn && lower.includes('/login')) {
      console.log('[Bot] Auto-logging in...');
      say('/login 551417114');
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
      return;
    }

    // Aggressive server message filtering
    const isServerMessage = /^\[(Server|INFO|WARN|ERROR|System)\]/i.test(text) ||
                            /^\*{3}/.test(text) ||
                            /^\[[+\-]\]/.test(text) ||
                            /(joined|left) the game/i.test(text) ||
                            /(time|seconds|queue|position|limbo|lifesteal|full|estimated)/i.test(text) ||
                            /(tempmuted|unmuted|muted|banned|kicked)/i.test(text) ||
                            /^Habibi/i.test(text) ||
                            /\[Spartan Notification\]/i.test(text) ||
                            /Welcome back!/i.test(text);
    if (isServerMessage) return;

    let sender = null;
    let message = null;

    const cleanText = text.replace(/^(?:\[[^\]]+\]\s*)*(?:MOD|HELPER|SRHELPER|OWNER|ADMIN|COOWNER|BUILDER|VIP|MVP|YOUTUBE)\s+/i, '');

    const match1 = cleanText.match(/^([a-zA-Z0-9_]{3,16})\s*[:»\-]\s*(.+)/);
    if (match1) {
      sender = match1[1];
      message = match1[2];
    }

    if (!sender && text.includes(':')) {
      const parts = text.split(':');
      const beforeColon = parts[0].replace(/^\[.*?\]\s*/, '').trim();
      const words = beforeColon.split(/\s+/);
      const possibleSender = words[words.length - 1];
      if (possibleSender && possibleSender.length >= 3 && possibleSender.length <= 16 && /^[a-zA-Z0-9_]+$/.test(possibleSender)) {
        sender = possibleSender;
        message = parts.slice(1).join(':').trim();
      }
    }

    if (!sender || !message || sender === CONFIG.server.username || sender === 'detected') return;
    if (message.length < 2 || message.match(/^\d+\s+seconds$/i)) return;

    console.log(`[Chat] ${sender}: ${message}`);

    // Queue message for AI moderation (ignore commands to prevent loop checking)
    if (!message.startsWith('!')) {
      if (modQueue.length < CONFIG.groq.maxQueueSize) {
        modQueue.push({ sender, message });
        processModQueue();
      } else {
        console.warn('[Moderation] Warning: Queue is full. Dropping incoming message.');
      }
    }

    // Handle standard commands
    if (message.startsWith('!')) {
      handleBangCommand(sender, message);
    }
  });

  bot.on('health', () => {
    if (bot.food < 14) {
      const food = bot.inventory.items().find(item =>
        item.name.includes('apple') || item.name.includes('bread') ||
        item.name.includes('carrot') || item.name.includes('beef')
      );
      if (food) {
        bot.equip(food, 'hand');
        bot.activateItem();
      }
    }
  });

  bot.on('windowOpen', async (window) => {
    await new Promise(r => setTimeout(r, 500));
    if (bot.currentWindow) bot.clickWindow(1, 0, 0);
  });
}

// ========================
// TERMINAL INPUT
// ========================
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'Habibi> ',
});

rl.prompt();
rl.on('line', (line) => {
  const msg = line.trim();
  if (msg.startsWith('!')) {
    handleBangCommand('Terminal', msg);
  } else if (msg.startsWith('/')) {
    if (bot) bot.chat(msg);
  } else if (msg) {
    say(msg);
  }
  rl.prompt();
});

rl.on('close', () => {
  console.log('[Bot] Shutting down...');
  if (bot) bot.quit();
  process.exit(0);
});

// ========================
// START
// ========================
createBot();
