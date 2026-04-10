const mineflayer = require('mineflayer');
const Groq = require('groq-sdk');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { plugin: collectBlock } = require('mineflayer-collectblock');
const readline = require('readline');

// Catch log, warn, and error to ensure chunk spam is completely muted.
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
  apiKeysChat: [
    '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' 
  ],
  apiKeysMod: [
    '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',
    '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'
  ],
  // 🛑 ADD YOUR BACKGROUND API KEY HERE
  apiKeysBackground: [
    'YOUR_BACKGROUND_API_KEY_HERE' 
  ],

  models: {
    chat: ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'],
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
// STATE, MEMORY & QUEUES
// ========================
let bot = null;
let isInGame = false;
let isLoggedIn = false;
let lastChatTime = 0;
const playerMemory = new Map();
const muteList = new Set();

// The Global Event Log for Investigations (Stores last 100 chat/death events)
const globalHistory = []; 

// Background Queue for Rate-Limited Moderation Checks
const modQueue = [];
let isProcessingQueue = false;

// ========================
// BACKGROUND RATE-LIMIT MANAGER
// ========================
const keyPool = {
  chat: CONFIG.apiKeysChat.map((k, i) => ({ id: i + 1, key: k, status: 'active', cooldownUntil: 0 })),
  mod: CONFIG.apiKeysMod.map((k, i) => ({ id: i + 1, key: k, status: 'active', cooldownUntil: 0 })),
  background: CONFIG.apiKeysBackground.map((k, i) => ({ id: i + 1, key: k, status: 'active', cooldownUntil: 0 }))
};

function getAvailableKey(type) {
  const pool = keyPool[type];
  const now = Date.now();
  
  pool.forEach(k => {
    if (k.status === 'cooldown' && now > k.cooldownUntil) {
      k.status = 'active';
      const msg = `[API Debug] ${type.toUpperCase()} Key #${k.id} finished cooldown. Back in action!`;
      console.log(msg);
      if (type !== 'background') say(msg);
    }
  });

  return pool.find(k => k.status === 'active');
}

function handleKeyFailure(type, keyId, errorMsg) {
  const pool = keyPool[type];
  const keyObj = pool.find(k => k.id === keyId);
  if (!keyObj) return;

  const cleanErr = errorMsg.replace(/[\n\r]/g, ' ').substring(0, 50);
  const isRateLimit = cleanErr.includes('429') || cleanErr.toLowerCase().includes('rate limit');
  const isAuthError = cleanErr.includes('401') || cleanErr.toLowerCase().includes('unauthorized');
  
  if (isRateLimit) {
    keyObj.status = 'cooldown';
    keyObj.cooldownUntil = Date.now() + 60000; 
    const msg = `[API Debug] ${type.toUpperCase()} Key #${keyId} hit a 429 Rate Limit. Sleeping for 60s.`;
    console.log(msg);
    if (type !== 'background') say(msg);
  } else if (isAuthError) {
    keyObj.status = 'dead';
    const msg = `[API Debug] ${type.toUpperCase()} Key #${keyId} threw a 401. Key is dead or invalid.`;
    console.log(msg);
    if (type !== 'background') say(msg);
  } else {
    keyObj.status = 'cooldown';
    keyObj.cooldownUntil = Date.now() + 15000; 
    const msg = `[API Debug] ${type.toUpperCase()} Key #${keyId} failed: ${cleanErr}. Sleeping 15s.`;
    console.log(msg);
    if (type !== 'background') say(msg);
  }
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

function addMemory(player, message) {
  if (!playerMemory.has(player)) playerMemory.set(player, []);
  const arr = playerMemory.get(player);
  arr.push(message);
  if (arr.length > 10) arr.shift();
}

function getMemory(player) {
  return (playerMemory.get(player) || []).join('\n');
}

function logGlobalEvent(text) {
  const timestamp = new Date().toLocaleTimeString();
  globalHistory.push(`[${timestamp}] ${text}`);
  if (globalHistory.length > 100) globalHistory.shift();
}

// ========================
// GROQ API CALLER
// ========================
async function callGroq(messages, maxTokens = 100, temperature = 0.7, modelList = CONFIG.models.chat, type = 'chat') {
  let attempts = 0;
  const maxAttempts = keyPool[type].length;

  while (attempts < maxAttempts) { 
    const activeKeyObj = getAvailableKey(type);
    
    if (!activeKeyObj) {
      const msg = `[API Fatal] No active ${type.toUpperCase()} keys available!`;
      console.error(msg);
      if (type !== 'background') say(msg);
      throw new Error('RATE_LIMIT_EXHAUSTED'); // Throw so we can catch and queue
    }

    const client = new Groq({ apiKey: activeKeyObj.key });

    for (const model of modelList) {
      try {
        const response = await client.chat.completions.create({
          model: model,
          messages: messages,
          max_tokens: maxTokens,
          temperature: temperature,
        });
        
        const content = response.choices[0]?.message?.content;
        if (content) return content; 
        
      } catch (err) {
        if (err.message.includes('429') || err.message.includes('401') || err.message.toLowerCase().includes('rate') || err.message.toLowerCase().includes('unauthorized')) {
            handleKeyFailure(type, activeKeyObj.id, err.message);
            break; 
        } else {
            console.error(`[API] Error (${model} on ${type.toUpperCase()} Key #${activeKeyObj.id}): ${err.message}`);
        }
      }
    }

    attempts++;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  throw new Error('RATE_LIMIT_EXHAUSTED');
}

// ========================
// MODERATION & QUEUE PROCESSING
// ========================
async function checkProfanity(message, useBackgroundKey = false) {
  const onlinePlayers = getOnlineUsernames();
  
  const prompt = `You are an elite moderation filter for a Minecraft server. Evaluate the message for severe rule violations.
  
Violations include:
- Severe swearing, slurs, or hate speech.
- High toxicity, bullying, or targeted harassment.
- Explicit, highly offensive, or "bad" content.

Minecraft PvP terms ("kill", "destroy") and valid usernames (${onlinePlayers}) are NOT violations.
Mild frustration ("crap", "stupid") is NOT a violation.

CRITICAL INSTRUCTION:
If the message contains a severe rule violation or toxicity, reply ONLY with the word "Yes".
If the message is clean, safe, or mild trash talk, reply ONLY with the word "No".
Do not include any punctuation or explanations. Just "Yes" or "No".

Message: "${message}"`;

  const apiType = useBackgroundKey ? 'background' : 'mod';

  try {
    const result = await callGroq(
      [{ role: 'user', content: prompt }],
      5, 
      0.0,
      CONFIG.models.moderation,
      apiType 
    );

    if (!result) return { isViolation: false };

    const cleanResult = result.trim().toLowerCase();
    const isViolation = cleanResult.includes('yes');
    
    console.log(`[Mod Check] Raw AI response: "${result}" | Flagged: ${isViolation ? 'yes' : 'no'}`);
    return { isViolation };

  } catch (err) {
    if (err.message === 'RATE_LIMIT_EXHAUSTED') throw err;
    return { isViolation: false };
  }
}

function punish(player, action, reason = 'Rule violation') {
  const safeReason = reason.replace(/[:\n\r]/g, ' ').substring(0, 100);
  
  if (action === 'mute') {
    const duration = CONFIG.moderation.mute_duration;
    bot.chat(`/tempmute ${player} ${duration}m ${safeReason}`);
    muteList.add(player);
    console.log(`[MOD] Muted ${player}. Reason: ${safeReason}`);
    
    if (CONFIG.testMode) {
      setTimeout(() => { bot.chat(`/unmute ${player}`); }, 500);
    } else {
      setTimeout(() => muteList.delete(player), duration * 60 * 1000);
    }
  } else if (action === 'kick') {
    bot.chat(`/kick ${player} ${safeReason}`);
    console.log(`[MOD] Kicked ${player}. Reason: ${safeReason}`);
  }
}

async function processBackgroundQueue() {
  if (isProcessingQueue || modQueue.length === 0) return;
  isProcessingQueue = true;

  while (modQueue.length > 0) {
    const task = modQueue[0]; // Peek
    console.log(`[Queue] Processing background check for ${task.sender}...`);

    try {
      const check = await checkProfanity(task.message, true); // true = use background key
      if (check.isViolation) {
        punish(task.sender, 'mute', `Delayed Mod Review - Toxic behavior detected`);
      }
      modQueue.shift(); // Success, remove from queue
    } catch (err) {
      console.log(`[Queue] Background key also exhausted. Retrying later.`);
      break; // Stop processing and wait for next interval
    }
    
    await new Promise(res => setTimeout(res, 2000)); // Respectful delay between background checks
  }
  
  isProcessingQueue = false;
}
setInterval(processBackgroundQueue, 5000);

async function checkViolation(sender, message) {
  const SEVERE_SLURS = [
    /\bn[i1@]+gg[ae3@]+r\b/i, /\bf[a@4]+gg[o0@]+t\b/i, /\bc[u\*@]+nt\b/i,
    /\b(kys|kill.{0,2}yourself)\b/i, /\bf[u\*@]+c[k\*@]+/i,          
    /\bb[i1\*@]+t[c\*@]+h/i, /\bwh[o0\*@]+r[e3\*@]+/i, /\bsh[i1\*@]+t\b/i              
  ];

  for (const pattern of SEVERE_SLURS) {
    if (pattern.test(message)) {
      punish(sender, 'mute', `Severe Rule Violation`);
      return true;
    }
  }

  try {
    const aiCheck = await checkProfanity(message, false);
    if (aiCheck.isViolation) {
      punish(sender, 'mute', `Toxicity/Violation detected`);
      return true;
    }
  } catch (err) {
    if (err.message === 'RATE_LIMIT_EXHAUSTED') {
      console.log(`[MOD] Primary keys exhausted. Queueing message from ${sender} for background review.`);
      modQueue.push({ sender, message });
    }
  }
  return false;
}

// ========================
// INVESTIGATION LOGIC
// ========================
async function runInvestigation(target) {
  if (!target) return say("You need to tell me who to investigate! (e.g. !investigate Player123)");
  
  say(`[Investigation] Reviewing the global event log for ${target}...`);
  
  const historyText = globalHistory.join('\n');
  
  const prompt = `You are a Minecraft Server Admin. Review the recent server event log provided below to investigate the player named "${target}".
  
Look for:
- Random Deathmatching (RDM): The target killing multiple people without context.
- Toxicity/Harassment: The target harassing, bullying, or targeting someone in chat.
- Spam: The target flooding the chat.

Respond STRICTLY in JSON format:
{
  "guilty": true or false,
  "action": "kick" or "mute" or "none",
  "reason": "Brief 5-word reason for punishment"
}

Event Log:
${historyText}`;

  try {
    const response = await callGroq([{ role: 'user', content: prompt }], 100, 0.2, CONFIG.models.chat, 'chat');
    
    // Extract JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[0]);
      if (data.guilty && data.action !== 'none') {
        say(`[Investigation Completed] Action taken against ${target}. Reason: ${data.reason}`);
        punish(target, data.action, `Investigation: ${data.reason}`);
      } else {
        say(`[Investigation Completed] ${target} appears to be innocent or there isn't enough evidence.`);
      }
    } else {
      say(`[Investigation] AI failed to format the review properly.`);
    }
  } catch (err) {
    say(`[Investigation Failed] Systems are currently overloaded.`);
  }
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

STRICT RULES:
- Never output Minecraft commands (like /spawn).
- Never admit you are an AI or a language model.`;
    
  try {
      const response = await callGroq(
        [
          { role: 'system', content: system },
          { role: 'user', content: `${sender}: ${message}\n${memory}` }
        ],
        40, 
        0.7,
        CONFIG.models.chat,
        'chat' 
      );
      return response;
  } catch (err) {
      return null;
  }
}

// ========================
// COMMANDS
// ========================
function handleBangCommand(sender, msg) {
  const args = msg.slice(1).split(/\s+/);
  const cmd = args[0].toLowerCase();

  switch (cmd) {
    case 'investigate':
      runInvestigation(args[1]);
      break;
    case 'inventory':
      const items = bot.inventory.items().map(i => `${i.name}: ${i.count}`).join(', ');
      say(`Inventory: ${items || 'empty'}`);
      break;
    case 'status':
      say(`Health: ${Math.round(bot.health)}/${bot.maxHealth}`);
      break;
    case 'help':
      say('Commands: !investigate <player>, !inventory, !status, !mute, !kick');
      break;
    case 'mute':
      if (!CONFIG.moderation.moderators.includes(sender)) { say('Permission denied.'); return; }
      if (args[1]) punish(args[1], 'mute', args.slice(2).join(' ') || 'Manual Mod Action');
      break;
    case 'kick':
      if (!CONFIG.moderation.moderators.includes(sender)) { say('Permission denied.'); return; }
      if (args[1]) punish(args[1], 'kick', args.slice(2).join(' ') || 'Manual Mod Action');
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
  });

  bot.on('end', () => {
    console.log('[Bot] Disconnected. Reconnecting in 5s...');
    isInGame = false;
    isLoggedIn = false;
    setTimeout(createBot, 5000);
  });

  bot.on('message', async (jsonMsg) => {
    const text = jsonMsg.toString().trim();
    if (!text || text.length > 500) return;

    const lower = text.toLowerCase();
    if (lower.includes('ignoring block entities')) return;

    // Log EVERYTHING to global history for investigations before the bot ignores it
    logGlobalEvent(text);

    console.log(`[Server] ${text}`);

    if (!isLoggedIn && lower.includes('/login')) {
      say('/login 551417114');
      isLoggedIn = true;
      return;
    }

    if (lower.includes('successfully logged')) isLoggedIn = true;
    if (lower.includes('[+] habibi')) isInGame = true;
    if (lower.includes('teleport to you')) { setTimeout(() => bot.chat('/tpaccept'), 1000); return; }

    const isServerMessage = /^\[(Server|INFO|WARN|ERROR|System)\]/i.test(text) ||
                            /^\*{3}/.test(text) || /^\[[+\-]\]/.test(text) ||
                            /(joined|left) the game/i.test(text) ||
                            /(tempmuted|unmuted|muted|banned|kicked)/i.test(text) ||
                            /^Habibi/i.test(text);
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
      const possibleSender = parts[0].replace(/^\[.*?\]\s*/, '').trim().split(/\s+/).pop();
      if (possibleSender && possibleSender.length >= 3 && possibleSender.length <= 16 && /^[a-zA-Z0-9_]+$/.test(possibleSender)) {
        sender = possibleSender;
        message = parts.slice(1).join(':').trim();
      }
    }

    if (!sender || !message || sender === 'Habibi' || sender === 'detected') return;
    
    if (muteList.has(sender)) muteList.delete(sender);

    console.log(`[Chat] ${sender}: ${message}`);
    addMemory(sender, message);

    if (isInGame) {
      const violated = await checkViolation(sender, message);
      if (violated) return;
    }

    if (message.toLowerCase().includes('investigate')) {
        const parts = message.split(' ');
        const targetIdx = parts.findIndex(w => w.toLowerCase() === 'investigate') + 1;
        if (parts[targetIdx]) {
            runInvestigation(parts[targetIdx]);
            return;
        }
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
}

// ========================
// START
// ========================
createBot();
