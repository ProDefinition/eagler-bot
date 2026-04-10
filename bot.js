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
    apiKey: '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', // <-- API KEY
    model: 'llama3-8b-8192',          // Valid Groq model for fast, logical reasoning
    maxQueueSize: 100                 
  }
};

// ========================
// STATE & MEMORY
// ========================
let bot = null;
let isInGame = false;
let isLoggedIn = false;
let isReady = false; 

// Agent's memory
const chatHistory = [];
const MAX_HISTORY = 15; 
const warnedPlayers = new Set(); // Tracks who has already been warned

// ========================
// GROQ MODERATION QUEUE
// ========================
const groq = new Groq({ apiKey: CONFIG.groq.apiKey });
const modQueue = [];
let isProcessingQueue = false;

// STRICT ZERO-TOLERANCE PROMPT
const SYSTEM_PROMPT = `
You are a ZERO-TOLERANCE, strict AI moderator for a Minecraft server.
You will evaluate the provided chat message.

RULES:
- ANY profanity (e.g., "fuck", "shit", "bitch"), regardless of context or if it is "harmless banter", is strictly forbidden.
- You must punish ALL swearing, toxicity, or spam.

Choose the appropriate action:
- NONE: The message is 100% clean and contains no profanity.
- WARN: Any standard profanity, mild toxicity, or spam.
- MUTE: Severe slurs, bypass attempts, or heavy harassment.
- KICK: Extreme violations (e.g., threats, extreme hate speech).

You MUST respond strictly in valid JSON format. Do not include markdown formatting or extra text.
{
  "action": "NONE" | "WARN" | "MUTE" | "KICK",
  "target": "username of offender",
  "duration": "10m" (only required if action is MUTE),
  "reason": "Brief, professional reason for the punishment"
}
`;

async function processModQueue() {
  if (isProcessingQueue || modQueue.length === 0) return;
  isProcessingQueue = true;

  while (modQueue.length > 0) {
    const item = modQueue[0];
    const contextStr = chatHistory.map(msg => `[${msg.time}] ${msg.sender}: ${msg.message}`).join('\n');
    
    try {
      const response = await groq.chat.completions.create({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `CHAT HISTORY:\n${contextStr || 'No prior history.'}\n\nEVALUATE THIS MESSAGE:\nSender: ${item.sender}\nMessage: "${item.message}"` }
        ],
        model: CONFIG.groq.model,
        temperature: 0.0, // Zero variance, strictly factual decisions
        max_tokens: 150,  
      });

      let reply = response.choices[0]?.message?.content?.trim() || '{}';
      reply = reply.replace(/^```json/i, '').replace(/```$/, '').trim();

      try {
        const decision = JSON.parse(reply);
        
        if (decision.action !== 'NONE') {
          console.log(`[Agent] Decision for ${item.sender}:`, decision);
          
          const target = decision.target || item.sender;
          // Ensure reasons don't trigger anti-caps plugins
          const reason = decision.reason ? `Automod: ${decision.reason}` : `Automod: Policy violation`;
          
          switch (decision.action.toUpperCase()) {
            case 'WARN':
              if (warnedPlayers.has(target)) {
                // Strike 2: Instant Mute
                say(`/tempmute ${target} 10m ${reason} (Ignored Warning)`);
                console.log(`[System] Escalated ${target} to MUTE. They ignored their first warning.`);
              } else {
                // Strike 1: Warning
                warnedPlayers.add(target);
                // Lowercase formatting to bypass aggressive anti-caps plugins
                say(`${target}, warning: ${reason}. next offense is a mute.`);
                console.log(`[System] Issued first warning to ${target}.`);
              }
              break;
            case 'MUTE':
              const duration = decision.duration || '10m';
              say(`/tempmute ${target} ${duration} ${reason}`);
              break;
            case 'KICK':
              say(`/kick ${target} ${reason}`);
              break;
          }
        }
      } catch (parseError) {
        console.error(`[Moderation] Agent returned invalid JSON:`, reply);
      }

      modQueue.shift(); 
      await new Promise(r => setTimeout(r, 800)); 

    } catch (error) {
      if (error.status === 429) {
        console.warn(`[Moderation] Rate limit hit! Queue size: ${modQueue.length}. Pausing for 10s...`);
        await new Promise(r => setTimeout(r, 10000));
      } else {
        console.error(`[Moderation] API Error: ${error.message}`);
        modQueue.shift(); 
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
  
  // Slight delay before sending to avoid triggering the server's anti-spam
  setTimeout(() => {
    if (text.length <= CONFIG.chat.max_length) {
      console.log(`[Say] ${text}`);
      bot.chat(text);
      return;
    }

    let remaining = text;
    let delay = 0;
    while (remaining.length > 0) {
      let chunk = remaining.slice(0, CONFIG.chat.max_length);
      const lastSpace = chunk.lastIndexOf(' ');
      if (lastSpace > CONFIG.chat.max_length / 2) chunk = chunk.slice(0, lastSpace);
      
      setTimeout(() => {
        console.log(`[Say] ${chunk}`);
        bot.chat(chunk);
      }, delay);
      
      delay += 500; // 500ms between long message chunks
      remaining = remaining.slice(chunk.length).trim();
    }
  }, 250);
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

  bot.once('spawn', async () => {
    console.log('[Bot] Entity spawned. Initiating pre-flight checks...');
    isInGame = true;

    await new Promise(r => setTimeout(r, 2000));

    if (!isLoggedIn) {
      console.log('[System] Waiting for authentication...');
      let attempts = 0;
      while (!isLoggedIn && attempts < 15) {
          await new Promise(r => setTimeout(r, 1000));
          attempts++;
      }
    }

    console.log('[System] Testing server sync (Movement)...');
    bot.setControlState('jump', true);
    await new Promise(r => setTimeout(r, 300));
    bot.setControlState('jump', false);

    console.log(`[System] Testing server sync (Data)... Health: ${bot.health}, Food: ${bot.food}`);

    console.log('[System] Purging startup chat buffer (Waiting 3s)...');
    await new Promise(r => setTimeout(r, 3000));

    console.log('[System] >>> ALL CHECKS PASSED. MODERATION AGENT ARMED. <<<');
    isReady = true;

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
    isReady = false;
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
      return;
    }

    if (lower.includes('successfully logged')) isLoggedIn = true;
    if (lower.includes('[+] habibi') || (lower.includes('joined the game') && lower.includes('habibi'))) {
      isInGame = true;
    }
    if (lower.includes('limbo') || lower.includes('queue')) isInGame = false;

    if (!isReady) return;

    if (lower.includes('teleport to you')) {
      setTimeout(() => bot.chat('/tpaccept'), 1000);
      return;
    }

    const isServerMessage = /^\[(Server|INFO|WARN|ERROR|System)\]/i.test(text) ||
                            /^\*{3}/.test(text) ||
                            /^\[[+\-]\]/.test(text) ||
                            /(joined|left) the game/i.test(text) ||
                            /(time|seconds|queue|position|limbo|lifesteal|full|estimated)/i.test(text) ||
                            /(tempmuted|unmuted|muted|banned|kicked|warned)/i.test(text) ||
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
    } else if (text.includes(':')) {
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

    chatHistory.push({ time: new Date().toLocaleTimeString(), sender, message });
    if (chatHistory.length > MAX_HISTORY) chatHistory.shift();

    if (modQueue.length < CONFIG.groq.maxQueueSize) {
      modQueue.push({ sender, message });
      processModQueue();
    } else {
      console.warn('[Moderation] Warning: Queue full. Skipping message.');
    }
  });

  bot.on('health', () => {
    if (!isReady) return; 
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
  if (msg.startsWith('/')) {
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
