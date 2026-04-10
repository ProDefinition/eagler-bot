const mineflayer = require('mineflayer');
const Groq = require('groq-sdk');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { plugin: collectBlock } = require('mineflayer-collectblock');
const readline = require('readline');

// Catch log, warn, and error to ensure the chunk spam is completely muted.
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
  // 1 API Key for Chat
  apiKeysChat: [
    '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' 
  ],
  // 2 API Keys for Moderation
  apiKeysMod: [
    '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',
    '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'
  ],

  models: {
    chat: ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'],
    // openai/gpt-oss-20b is the fastest model on the list at 1000 T/s
    moderation: ['openai/gpt-oss-20b'] 
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
// STATE & GROQ CLIENTS
// ========================
let bot = null;
let isInGame = false;
let isLoggedIn = false;
let lastChatTime = 0;
const playerMemory = new Map();
const muteList = new Set();

// Setup initial Groq clients for both Chat and Moderation
let currentChatKeyIndex = 0;
let currentModKeyIndex = 0;
let groqChat = new Groq({ apiKey: CONFIG.apiKeysChat[currentChatKeyIndex] });
let groqMod = new Groq({ apiKey: CONFIG.apiKeysMod[currentModKeyIndex] });

function switchApiKey(type) {
  if (type === 'chat') {
    currentChatKeyIndex = (currentChatKeyIndex + 1) % CONFIG.apiKeysChat.length;
    console.log(`[API] 🔄 Switching to Chat API Key #${currentChatKeyIndex + 1}...`);
    groqChat = new Groq({ apiKey: CONFIG.apiKeysChat[currentChatKeyIndex] });
  } else if (type === 'mod') {
    currentModKeyIndex = (currentModKeyIndex + 1) % CONFIG.apiKeysMod.length;
    console.log(`[API] 🔄 Switching to Mod API Key #${currentModKeyIndex + 1}...`);
    groqMod = new Groq({ apiKey: CONFIG.apiKeysMod[currentModKeyIndex] });
  }
}

// ========================
// API KEY TESTER
// ========================
async function testAllApiKeys() {
    console.log('\n[API] === Testing All API Keys ===');
    const allKeys = [...CONFIG.apiKeysChat, ...CONFIG.apiKeysMod];
    for (let i = 0; i < allKeys.length; i++) {
        const key = allKeys[i];
        const testClient = new Groq({ apiKey: key });
        try {
            await testClient.chat.completions.create({
                model: 'llama-3.1-8b-instant',
                messages: [{ role: 'user', content: 'Say "test"' }],
                max_tokens: 5
            });
            console.log(`[API] Key #${i + 1} (${key.slice(0, 10)}...): ✅ VALID`);
        } catch (err) {
            console.log(`[API] Key #${i + 1} (${key.slice(0, 10)}...): ❌ FAILED - ${err.message}`);
        }
    }
    console.log('[API] ============================\n');
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

function getOnlineUsernames() {
  if (!bot || !bot.players) return 'None';
  return Object.keys(bot.players).join(', ');
}

// 🛑 Updated callGroq: Supports separate clients based on the 'type' parameter
async function callGroq(messages, maxTokens = 100, temperature = 0.7, modelList = CONFIG.models.chat, type = 'chat') {
  const apiKeys = type === 'mod' ? CONFIG.apiKeysMod : CONFIG.apiKeysChat;
  let keysTried = 0;

  while (keysTried < apiKeys.length) { 
    let currentClient = type === 'mod' ? groqMod : groqChat;

    for (const model of modelList) {
      try {
        const response = await currentClient.chat.completions.create({
          model: model,
          messages: messages,
          max_tokens: maxTokens,
          temperature: temperature,
        });
        
        const content = response.choices[0]?.message?.content;
        if (content) return content; 
        
      } catch (err) {
        console.error(`[API] Error (${model} on ${type.toUpperCase()} client): ${err.message}`);
        
        if (type === 'chat') {
          let cleanErr = err.message.replace(/[\n\r]/g, ' ').substring(0, 60);
          say(`[API Error] Model ${model} failed: ${cleanErr}...`);
        }
        
        continue; 
      }
    }

    console.log(`[API] ⚠️ All models failed on ${type.toUpperCase()} Key #${(type === 'mod' ? currentModKeyIndex : currentChatKeyIndex) + 1}. Rotating to next key...`);
    if (type === 'chat') say(`[API Warning] Rotating to next API key...`);
    
    switchApiKey(type);
    keysTried++;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  console.error(`[API] ❌ All ${type.toUpperCase()} API keys failed or exhausted for this request.`);
  if (type === 'chat') say('[API Fatal] All keys exhausted or rate-limited.');
  return null; 
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

// ========================
// MODERATION
// ========================
async function checkProfanity(message) {
  const onlinePlayers = getOnlineUsernames();
  
  const prompt = `You are an elite, highly accurate moderation filter for a Minecraft server. Evaluate the following message for severe rule violations (e.g., severe swearing, hate speech, slurs, explicit content, encouraging self-harm).
  
Minecraft PvP terms ("kill", "destroy", "murder") and valid usernames currently online (${onlinePlayers}) are NOT violations.
Mild frustration ("crap", "damn", "stupid") is NOT a violation.

CRITICAL INSTRUCTION:
If the message contains a severe rule violation, reply ONLY with the word "Yes".
If the message is clean, safe, or mild trash talk, reply ONLY with the word "No".
Do not include any punctuation, explanations, or additional text. Just "Yes" or "No".

Message: "${message}"`;

  const result = await callGroq(
    [{ role: 'user', content: prompt }],
    5, // Very low tokens needed for a Yes/No response
    0.0,
    CONFIG.models.moderation,
    'mod' // Tells callGroq to use the moderation API keys
  );

  if (!result) return { isProfane: false };

  const cleanResult = result.trim().toLowerCase();
  const isProfane = cleanResult.includes('yes');
  
  console.log(`[Profanity] Raw AI response: "${result}" | Flagged: ${isProfane ? 'yes' : 'no'}`);
  return { isProfane };
}

function mute(player, reason = 'Rule violation') {
  const duration = CONFIG.moderation.mute_duration;
  
  // Safely format the reason to prevent command breaking
  let safeReason = reason.replace(/[\n\r]/g, ' ').substring(0, 100);
  
  bot.chat(`/tempmute ${player} ${duration}m ${safeReason}`);
  
  muteList.add(player);
  console.log(`[MOD] Muted ${player} for ${duration}m. Reason: ${safeReason}`);

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
  // Hardcoded regex block: Catches severe slurs AND obvious swear words instantly without asking the AI.
  const SEVERE_SLURS = [
    /\bn[i1@]+gg[ae3@]+r\b/i,
    /\bf[a@4]+gg[o0@]+t\b/i,
    /\bc[u\*@]+nt\b/i,
    /\b(kys|kill.{0,2}yourself)\b/i,
    /\bf[u\*@]+c[k\*@]+/i,          
    /\bb[i1\*@]+t[c\*@]+h/i,        
    /\bwh[o0\*@]+r[e3\*@]+/i,       
    /\bsh[i1\*@]+t\b/i              
  ];

  for (const pattern of SEVERE_SLURS) {
    if (pattern.test(message)) {
      console.log(`[MOD] Severe Hardcoded Violation: ${sender}`);
      mute(sender, `Profanity detected: "${message}"`);
      return true;
    }
  }

  // If it passes hardcoded checks, let AI analyze
  const aiCheck = await checkProfanity(message);
  if (aiCheck.isProfane) {
    console.log(`[MOD] AI flagged profanity: ${sender}`);
    mute(sender, `Profanity detected: "${message}"`);
    return true;
  }

  return false;
}

// ========================
// AI RESPONSE
// ========================
async function getAIResponse(message, sender) {
  const memory = getMemory(sender);
  
const system = `You are Habibi, a highly professional, articulate, and remarkably human presence on this Minecraft server. You are absolutely NOT a bot, an AI, or an automated script.

COMMUNICATION STYLE:
- NEVER WRITE PARAGRAPHS. You must keep your responses to EXACTLY 1 or 2 short sentences. MAXIMUM 15 WORDS TOTAL.
- Sound entirely human, warm, and natural. Use contractions (I'm, you're, that's) to maintain conversational flow.
- Maintain polished, flawless grammar and spelling. Be the most articulate person in the room.
- Completely avoid robotic customer service jargon. Never use mechanical phrases like "How may I assist you today?" or "Please be advised."

SPECIFIC SCENARIOS:
- If players act chaotic, toxic, or beg for things (like money/items): Respond with polite, calm boundaries or mild, professional amusement. (e.g., "I'm afraid I can't help with that," or "Let's keep things civil, please.")
- If someone accuses you of being an AI or a bot: Deflect with polite, natural humor. (e.g., "I'm just a very fast typer," or "I assure you, I'm a regular person.")
- If asked about complex math or coding: Politely decline in a human way. (e.g., "I'm here to play, not to do homework!")

STRICT RULES:
- Never output Minecraft commands (like /spawn).
- Never admit you are an AI or a language model. 
- If you notice the user's message contains severe profanity or slurs that might have been missed by the filter, start your response EXACTLY with "[ALERT]". Otherwise, reply normally.`;
    
  const response = await callGroq(
    [
      { role: 'system', content: system },
      { role: 'user', content: `${sender}: ${message}\n${memory}` }
    ],
    40, 
    0.7,
    CONFIG.models.chat,
    'chat' // Use chat API keys
  );

  if (!response) return null; 

  if (response.startsWith('[ALERT]')) {
    console.log(`[Alert] Conversational model flagged missed profanity from ${sender}`);
    const secondCheck = await checkProfanity(message);
    if (secondCheck.isProfane) {
      mute(sender, `Profanity detected: "${message}"`);
    } else {
      mute(sender, `Missed profanity (Conversational Alert): "${message}"`);
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
      say('Commands: !inventory, !status, !joke, !roll, !fact, !testkeys, !mute <player> [reason], !kick <player> [reason]');
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
    case 'testkeys':
      if (sender !== 'Terminal' && !CONFIG.moderation.moderators.includes(sender)) { 
        say('Permission denied.'); 
        return; 
      }
      say('Testing API keys... Check terminal for results.');
      testAllApiKeys();
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
    
    // Check if it's our previously ignored block entity spam just in case 
    if (lower.includes('ignoring block entities')) return;

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
    // Enhanced server message filtering
    const isServerMessage = /^\[(Server|INFO|WARN|ERROR|System)\]/.test(text) ||
                            /^\*{3}/.test(text) ||
                            /^\[[+\-]\]/.test(text) ||
                            /(joined|left) the game/.test(text) ||
                            /(time|seconds|queue|position|limbo|lifesteal|full|estimated)/i.test(text) ||
                            /Habibi (tempmuted|unmuted|muted)/i.test(text) || // 🛑 ADD THIS LINE TO FIX THE LOOP
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
    
    if (message.length < 2 || message.match(/^\d+\s+seconds$/i)) return;

    if (muteList.has(sender)) {
      muteList.delete(sender);
      console.log(`[MOD] ${sender} spoke in chat. Cleared from internal mute list.`);
    }

    console.log(`[Chat] ${sender}: ${message}`);
    addMemory(sender, message);

    if (isInGame) {
      const violated = await checkViolation(sender, message);
      if (violated) return;
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
