const mineflayer = require('mineflayer');
const Groq = require('groq-sdk');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { plugin: collectBlock } = require('mineflayer-collectblock');
const readline = require('readline');

// ========================
// SUPPRESS CHUNK WARNINGS
// ========================
const originalConsoleLog = console.log;
console.log = function(...args) {
    if (args.length && typeof args[0] === 'string' && args[0].includes('Ignoring block entities as chunk failed to load')) {
        return;
    }
    originalConsoleLog.apply(console, args);
};

// ========================
// CONFIGURATION
// ========================
const CONFIG = {
  
  apiKeys: [
    process.env.GROQ_KEY_1, 
    process.env.GROQ_KEY_2,
    process.env.GROQ_KEY_3
  ],

  models: {
    chat: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'],
    moderation: ['llama-3.1-8b-instant', 'openai/gpt-oss-safeguard-20b']
  },

  server: {
    host: 'play.pcsmp.net',
    port: 25565,
    username: 'Habibi',
    version: '1.12.2',
  },
  moderation: {
    mute_duration: 5,                 
    moderators: ['ChewKok', 'eagly20', 'n2ab', 'Chew'], 
  },
  chat: {
    cooldown: 1000,   
    max_length: 250,  
  },
  testMode: true,   
};

// ========================
// STATE & GROQ CLIENT
// ========================
let bot = null;
let isInGame = false;
let isLoggedIn = false;
let lastChatTime = 0;
const playerMemory = new Map();
const muteList = new Set();

// Setup initial Groq client
let currentKeyIndex = 0;
let groq = new Groq({ apiKey: CONFIG.apiKeys[currentKeyIndex] });

function switchApiKey() {
  currentKeyIndex = (currentKeyIndex + 1) % CONFIG.apiKeys.length;
  console.log(`[API] 🔄 Switching to API Key #${currentKeyIndex + 1}...`);
  groq = new Groq({ apiKey: CONFIG.apiKeys[currentKeyIndex] });
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

// Dynamically fetch all online players so the AI knows real usernames
function getOnlineUsernames() {
  if (!bot || !bot.players) return 'None';
  return Object.keys(bot.players).join(', ');
}

// 🛑 Updated callGroq: INFINITE RETRY LOOP (No Fallbacks)
async function callGroq(messages, maxTokens = 100, temperature = 0.7, modelList = CONFIG.models.chat) {
  while (true) { 
    for (const model of modelList) {
      try {
        const response = await groq.chat.completions.create({
          model: model,
          messages: messages,
          max_tokens: maxTokens,
          temperature: temperature,
        });
        
        const content = response.choices[0]?.message?.content;
        if (content) return content; 
        
      } catch (err) {
        console.error(`[API] Error (${model}): ${err.message}`);
        console.log(`[API] Model ${model} failed. Trying next model...`);
        continue; 
      }
    }

    console.log(`[API] ⚠️ All models failed on Key #${currentKeyIndex + 1}. Rotating to next key...`);
    switchApiKey();
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

function addMemory(player, message) {
  if (!playerMemory.has(player)) playerMemory.set(player, []);
  const arr = playerMemory.get(player);
  arr.push(message);
  if (arr.length > 10) arr.shift();
}

function getMemory(player) {
  return (playerMemory.get(player) || []).join('\n');
}

function normalizeMessage(str) {
  let cleaned = str.replace(/\s+/g, '');
  cleaned = cleaned.replace(/(.)\1{2,}/g, '$1$1');
  cleaned = cleaned.replace(/[^a-zA-Z0-9]/g, '');
  return cleaned.toLowerCase();
}

// ========================
// MODERATION
// ========================
async function checkProfanity(message) {
  const normalized = normalizeMessage(message);
  const onlinePlayers = getOnlineUsernames();
  
  const prompt = `You are a strict moderation filter for a Minecraft server.
Analyze the message. If it contains severe swearing, slurs, explicit sexual content, or severe toxicity, respond EXACTLY in this format:
[VIOLATION] | <short 3-5 word reason for mute>
If it is safe, mild frustration (like "i hate you"), or mild/abbreviated swearing (like "stupid", "dang", "fu"), respond ONLY with the exact word:
[CLEAN]
IMPORTANT: The following are legitimate player usernames currently online, NOT profanity: ${onlinePlayers}. Ignore them.
Message: "${message}"
Normalized: "${normalized}"`;

  const result = await callGroq(
    [{ role: 'user', content: prompt }],
    20,
    0.0,
    CONFIG.models.moderation
  );

  console.log(`[Profanity] Raw response: "${result}"`);

  const cleanResult = result.trim();
  const isProfane = cleanResult.toUpperCase().includes('[VIOLATION]');
  let reason = 'Inappropriate language';
  
  if (isProfane && cleanResult.includes('|')) {
    reason = cleanResult.split('|')[1].trim();
  }
  
  console.log(`[Profanity] Check: ${isProfane ? 'yes' : 'no'} for "${message.substring(0, 30)}..."`);
  return { isProfane, reason };
}

function mute(player, reason = 'Rule violation') {
  const duration = CONFIG.moderation.mute_duration;
  
  // Execute the server command. We no longer use say() here to prevent double broadcasts in chat.
  bot.chat(`/tempmute ${player} ${duration}m ${reason.slice(0, 40)}`);
  
  muteList.add(player);
  console.log(`[MOD] Muted ${player} for ${duration}m. Reason: ${reason}`);

  if (CONFIG.testMode) {
    setTimeout(() => {
      bot.chat(`/unmute ${player}`);
      console.log(`[TEST] Unmuted ${player} (test mode)`);
    }, 500);
  } else {
    setTimeout(() => muteList.delete(player), duration * 60 * 1000);
  }
}

async function checkViolation(sender, message) {
  const SEVERE_SLURS = [
    /\bn[i1@]+gg[ae3@]+r\b/i,
    /\bf[a@4]+gg[o0@]+t\b/i,
    /\bc[u\*@]+nt\b/i,
    /\b(kys|kill.{0,2}yourself)\b/i,
  ];

  for (const pattern of SEVERE_SLURS) {
    if (pattern.test(message)) {
      console.log(`[MOD] Severe violation: ${sender}`);
      mute(sender, 'Hate speech (severe)');
      return true;
    }
  }

  // Use the AI's dynamically generated reason
  const aiCheck = await checkProfanity(message);
  if (aiCheck.isProfane) {
    console.log(`[MOD] AI flagged profanity: ${sender} for ${aiCheck.reason}`);
    mute(sender, aiCheck.reason);
    return true;
  }

  return false;
}

// ========================
// AI RESPONSE
// ========================
async function getAIResponse(message, sender) {
  const memory = getMemory(sender);
  const onlinePlayers = getOnlineUsernames();
  
  const system = `You are Habibi, a friendly Minecraft server helper. 
Be concise (under 250 chars). Answer questions helpfully.
Never output commands or admit you're a bot.
IMPORTANT: The following are legitimate player usernames, do NOT flag them as profanity bypasses: ${onlinePlayers}.
If you notice the user's message contains severe profanity that might have been missed, start your response with "[ALERT]".`;

  const response = await callGroq(
    [
      { role: 'system', content: system },
      { role: 'user', content: `${sender}: ${message}\n${memory}` }
    ],
    150,
    0.7,
    CONFIG.models.chat
  );

  if (response && response.startsWith('[ALERT]')) {
    console.log(`[Alert] Conversational model flagged missed profanity from ${sender}`);
    const secondCheck = await checkProfanity(message);
    if (secondCheck.isProfane) {
      mute(sender, secondCheck.reason);
    } else {
      mute(sender, 'Missed profanity (Conversational Alert)');
    }
    return response.replace('[ALERT]', '').trim();
  }

  return response;
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
      say('Commands: !inventory, !status, !joke, !roll, !fact, !mute <player> [reason], !kick <player> [reason]');
      break;
    case 'joke':
      getAIResponse('Tell me a short, clean joke about Minecraft.', sender).then(r => r && say(r));
      break;
    case 'roll':
      const sides = parseInt(args[1]) || 6;
      const roll = Math.floor(Math.random() * sides) + 1;
      say(`🎲 Rolled: ${roll}/${sides}`);
      break;
    case 'fact':
      getAIResponse('Tell me an interesting Minecraft fact.', sender).then(r => r && say(r));
      break;
    case 'mute':
      if (!CONFIG.moderation.moderators.includes(sender)) { say('Permission denied.'); return; }
      const target = args[1];
      const reason = args.slice(2).join(' ') || 'Chat violation';
      if (target) mute(target, reason);
      break;
    case 'kick':
      if (!CONFIG.moderation.moderators.includes(sender)) { say('Permission denied.'); return; }
      const kickTarget = args[1];
      const kickReason = args.slice(2).join(' ') || 'Rule violation';
      if (kickTarget) bot.chat(`/kick ${kickTarget} ${kickReason}`);
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

  bot.loadPlugin(pathfinder);
  bot.loadPlugin(collectBlock);

  bot.once('spawn', () => {
    console.log('[Bot] Spawned!');
    isInGame = true;
    const mcData = require('minecraft-data')(bot.version);
    bot.pathfinder.setMovements(new Movements(bot, mcData));

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
    console.log(`[Server] ${text}`);

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

    // Enhanced server message filtering
    const isServerMessage = /^\[(Server|INFO|WARN|ERROR|System)\]/.test(text) ||
                            /^\*{3}/.test(text) ||
                            /^\[[+\-]\]/.test(text) ||
                            /(joined|left) the game/.test(text) ||
                            /(time|seconds|queue|position|limbo|lifesteal|full|estimated)/i.test(text) ||
                            /\[Spartan Notification\]/.test(text) ||
                            /Welcome back!/.test(text);
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

    if (!sender || !message || sender === 'Habibi') return;
    
    // Additional filter for numeric/time messages that might slip through
    if (message.length < 2 || message.match(/^\d+\s+seconds$/i)) return;

    // Clear player from internal mute list if they bypass/get unmuted and chat
    if (muteList.has(sender)) {
      muteList.delete(sender);
      console.log(`[MOD] ${sender} spoke in chat. Cleared from internal mute list.`);
    }

    console.log(`[Chat] ${sender}: ${message}`);
    addMemory(sender, message);

    if (isInGame) {
      const violated = await checkViolation(sender, message);
      if (violated) return; // If violated, don't let the conversational AI respond.
    }

    const mentioned = message.toLowerCase().includes('habibi');
    if (mentioned || message.startsWith('!')) {
      const now = Date.now();
      if (now - lastChatTime < CONFIG.chat.cooldown) return;
      lastChatTime = now;

      if (message.startsWith('!')) {
        handleBangCommand(sender, message);
      } else {
        setTimeout(async () => {
          const response = await getAIResponse(message, sender);
          if (response) {
            say(response);
            addMemory('Habibi', response);
          }
        }, 100);
      }
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
