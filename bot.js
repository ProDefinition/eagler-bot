const mineflayer = require('mineflayer');
const readline = require('readline');
const { Groq } = require('groq-sdk');

['log', 'warn', 'error'].forEach((method) => {
  const original = console[method];
  console[method] = function(...args) {
    if (args.length && typeof args[0] === 'string' && args[0].includes('Ignoring block entities')) return;
    original.apply(console, args);
  };
});

const CONFIG = {
  engine: 'Solaris v1.4',
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
    modApiKeys: [
      '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',
      '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',
      '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'
    ],
    chatApiKey: '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',
    model: 'llama-3.3-70b-versatile',
    chatModel: 'llama-3.1-8b-instant',
    smartScan: {
      maxBuffer: 15,    // Scan INSTANTLY if buffer hits this many messages
      maxWaitMs: 7000   // Otherwise, wait this long for slow chat to bundle up
    }
  }
};

let bot = null;
let isInGame = false;
let isLoggedIn = false;
let isReady = false; 

const chatHistory = [];
const MAX_HISTORY = 15; 
const warnedPlayers = new Set(); 

const chatTimestamps = [];
const MAX_RPM = 28; 

let modClients = CONFIG.groq.modApiKeys.map(key => new Groq({ apiKey: key }));
let currentModClientIndex = 0;
let modTimestamps = Array(CONFIG.groq.modApiKeys.length).fill().map(() => []);

const chatGroq = new Groq({ apiKey: CONFIG.groq.chatApiKey });

let chunkBuffer = [];
let isProcessingChunk = false;
let scanTimer = null; // Used for the new smart scanner

const SYSTEM_PROMPT = `
You are a moderation engine for a Minecraft server. Evaluate a CHUNK of recent chat messages.

RULES:
1. IGNORE MINOR OFFENSES: Do not punish shouting (caps), demanding behavior, or mild spam.
2. ZERO TOLERANCE FOR PROFANITY: You MUST issue a "MUTE" for ANY cuss words, swearing, slurs, or highly offensive language. Do not let any cursing slide.

Analyze the chunk. Return a strictly formatted JSON OBJECT containing a "punishments" array.
If no rules were broken, return an empty array inside the object: {"punishments": []}

Format exactly like this:
{
  "punishments": [
    {
      "action": "WARN",
      "target": "username",
      "duration": "10m",
      "reason": "Brief reason",
      "quote": "The exact chat message that broke the rule"
    }
  ]
}
`;

const CHAT_SYSTEM_PROMPT = `
You are 'Habibi', a Minecraft server administrator. You are realistic and grounded.

PERSONALITY:
- Speak casually, like a normal person. Use lowercase occasionally.
- Keep responses concise. 
- Ignore nonsensical or annoying messages by responding with exactly "[IGNORE]".
- Responses must be under 140 characters. No emojis.
`;

// --- API VERIFICATION ---
async function verifyApiKeys() {
  console.log(`\n[${CONFIG.engine}] 🔐 Verifying Groq API Keys...`);
  
  try {
    await chatGroq.models.list();
    console.log(`[${CONFIG.engine}] ✅ Chat API Key is functioning properly.`);
  } catch (error) {
    console.error(`[${CONFIG.engine}] ❌ Chat API Key FAILED: ${error.message}`);
  }

  const validModClients = [];
  const validModTimestamps = [];

  for (let i = 0; i < modClients.length; i++) {
    try {
      await modClients[i].models.list();
      console.log(`[${CONFIG.engine}] ✅ Mod API Key ${i + 1} is functioning properly.`);
      validModClients.push(modClients[i]);
      validModTimestamps.push([]);
    } catch (error) {
      console.error(`[${CONFIG.engine}] ❌ Mod API Key ${i + 1} FAILED: ${error.message}. Removing from rotation.`);
    }
  }

  modClients = validModClients;
  modTimestamps = validModTimestamps;

  if (modClients.length === 0) {
    console.error(`\n[${CONFIG.engine}] 🚨 FATAL: All Moderation API keys failed. The bot cannot moderate. Shutting down...`);
    process.exit(1);
  }
  
  console.log(`[${CONFIG.engine}] 🟢 Key verification complete. Starting bot...\n`);
}

async function enforceRateLimit(timestampsArray) {
  const now = Date.now();
  while (timestampsArray.length > 0 && now - timestampsArray[0] > 60000) {
    timestampsArray.shift();
  }

  if (timestampsArray.length >= MAX_RPM) {
    const waitTime = 60000 - (now - timestampsArray[0]) + 100;
    await new Promise(r => setTimeout(r, waitTime));
    return enforceRateLimit(timestampsArray); 
  }

  timestampsArray.push(Date.now());
}

function handlePunishment(decision, target) {
  if (!decision || decision.action === 'NONE') return;
  
  let baseReason = decision.reason || 'Policy violation';
  let quoteText = decision.quote ? ` - "${decision.quote}"` : '';
  
  if (quoteText.length > 60) {
    quoteText = quoteText.substring(0, 57) + '..."';
  }
  
  const fullReason = `Automod: ${baseReason}${quoteText}`;
  
  switch (decision.action.toUpperCase()) {
    case 'WARN':
      if (warnedPlayers.has(target)) {
        say(`/tempmute ${target} 10m ${fullReason} (Ignored Warning)`);
        console.log(`[${CONFIG.engine}] 🔨 Escalated ${target} to MUTE.`);
      } else {
        warnedPlayers.add(target);
        say(`${target}, warning: ${baseReason}. next offense is a mute.`);
        console.log(`[${CONFIG.engine}] ⚠️ Warned ${target}.`);
      }
      break;
    case 'MUTE':
      const duration = decision.duration || '10m';
      say(`/tempmute ${target} ${duration} ${fullReason}`);
      console.log(`[${CONFIG.engine}] 🔇 Muted ${target} for reason: ${fullReason}`);
      break;
    case 'KICK':
      say(`/kick ${target} ${fullReason}`);
      console.log(`[${CONFIG.engine}] 🥾 Kicked ${target}.`);
      break;
  }
}

// --- SMART DYNAMIC SCANNER ---
function triggerSmartScan() {
  if (isProcessingChunk) return;
  
  // If we hit the threshold, scan immediately
  if (chunkBuffer.length >= CONFIG.groq.smartScan.maxBuffer) {
    processChunkScanner();
  } 
  // Otherwise, start a wait timer for slow chat (if one isn't already running)
  else if (!scanTimer && chunkBuffer.length > 0) {
    scanTimer = setTimeout(() => {
      processChunkScanner();
    }, CONFIG.groq.smartScan.maxWaitMs);
  }
}

async function processChunkScanner() {
  // Clear any pending timers since we are scanning now
  if (scanTimer) {
    clearTimeout(scanTimer);
    scanTimer = null;
  }

  if (isProcessingChunk || chunkBuffer.length === 0) return;
  isProcessingChunk = true;

  const messagesToScan = chunkBuffer.length;
  console.log(`[${CONFIG.engine}] 🔍 Smart scanning ${messagesToScan} messages...`);

  const chunkToProcess = chunkBuffer.splice(0, 50);
  const formattedChunk = chunkToProcess.map(item => `Sender: ${item.sender} | Message: "${item.message}"`).join('\n');
  
  const keyIndex = currentModClientIndex;
  const currentGroq = modClients[keyIndex];
  currentModClientIndex = (currentModClientIndex + 1) % modClients.length;

  try {
    await enforceRateLimit(modTimestamps[keyIndex]);

    const response = await currentGroq.chat.completions.create({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `EVALUATE THIS CHUNK:\n\n${formattedChunk}` }
      ],
      model: CONFIG.groq.model,
      temperature: 0.0, 
      response_format: { type: "json_object" }, 
      max_tokens: 300,  
    });

    const reply = response.choices[0]?.message?.content || '{"punishments": []}';
    const cleanReply = reply.replace(/```json/gi, '').replace(/```/g, '').trim();

    try {
      const parsedData = JSON.parse(cleanReply);
      const decisions = parsedData.punishments || [];
      
      if (Array.isArray(decisions) && decisions.length > 0) {
        console.log(`[${CONFIG.engine}] 🛑 Scan complete. Found ${decisions.length} violation(s).`);
        decisions.forEach(decision => handlePunishment(decision, decision.target));
      } else {
        console.log(`[${CONFIG.engine}] ✅ Scan complete. No violations found.`);
      }
    } catch (parseError) {
      console.error(`[${CONFIG.engine}] JSON parse failed. Raw snippet: ${cleanReply.substring(0, 50)}...`);
    }

  } catch (error) {
    if (error.status === 429) {
       chunkBuffer = [...chunkToProcess, ...chunkBuffer];
    } else {
       console.error(`[${CONFIG.engine}] Moderation API Error: ${error.message}`);
    }
  }

  isProcessingChunk = false;
  
  // If more messages piled up while the AI was thinking, trigger the next scan cycle
  if (chunkBuffer.length > 0) {
    triggerSmartScan();
  }
}

async function handleChatResponse(sender, message) {
  try {
    await enforceRateLimit(chatTimestamps);

    const response = await chatGroq.chat.completions.create({
      messages: [
        { role: 'system', content: CHAT_SYSTEM_PROMPT },
        { role: 'user', content: `${sender}: ${message}` }
      ],
      model: CONFIG.groq.chatModel,
      temperature: 0.9, 
      max_tokens: 60,
    });

    let reply = response.choices[0]?.message?.content?.trim();

    if (!reply || reply.includes('[IGNORE]') || reply === '...') return;
    
    if (Math.random() > 0.5) {
      reply = reply.toLowerCase().replace(/[.!?]$/, "");
    }

    say(reply);
    console.log(`[${CONFIG.engine} Chat] Responded to ${sender}: ${reply}`);
  } catch (error) {
    console.error(`[${CONFIG.engine} Chat] API Error: ${error.message}`);
  }
}

function say(text) {
  if (!bot || !text) return;
  text = text.replace(/[\n\r]/g, ' ').trim();
  
  setTimeout(() => {
    if (text.length <= CONFIG.chat.max_length) {
      bot.chat(text);
      return;
    }

    let remaining = text;
    let delay = 0;
    while (remaining.length > 0) {
      let chunk = remaining.slice(0, CONFIG.chat.max_length);
      const lastSpace = chunk.lastIndexOf(' ');
      if (lastSpace > CONFIG.chat.max_length / 2) chunk = chunk.slice(0, lastSpace);
      
      setTimeout(() => bot.chat(chunk), delay);
      
      delay += 500; 
      remaining = remaining.slice(chunk.length).trim();
    }
  }, 250);
}

function createBot() {
  console.log(`[${CONFIG.engine}] Connecting...`);

  bot = mineflayer.createBot({
    host: CONFIG.server.host,
    port: CONFIG.server.port,
    username: CONFIG.server.username,
    version: CONFIG.server.version,
  });

  bot.once('spawn', async () => {
    console.log(`[${CONFIG.engine}] Spawned. Running checks.`);
    isInGame = true;

    await new Promise(r => setTimeout(r, 2000));

    if (!isLoggedIn) {
      let attempts = 0;
      while (!isLoggedIn && attempts < 15) {
          await new Promise(r => setTimeout(r, 1000));
          attempts++;
      }
    }

    bot.setControlState('jump', true);
    await new Promise(r => setTimeout(r, 300));
    bot.setControlState('jump', false);

    await new Promise(r => setTimeout(r, 3000));

    console.log(`[${CONFIG.engine}] Ready.`);
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
    console.log(`[${CONFIG.engine}] Disconnected. Reconnecting in 15s...`);
    isInGame = false;
    isLoggedIn = false;
    isReady = false;
    setTimeout(createBot, 15000); 
  });

  bot.on('error', (err) => console.log(`[Error] ${err.message}`));
  bot.on('kicked', (reason) => console.log(`[Kicked] ${reason}`));

  bot.on('message', async (jsonMsg) => {
    const text = jsonMsg.toString().trim();
    if (!text || text.length > 500) return;

    const lower = text.toLowerCase();
    
    if (lower.includes('ignoring block entities')) return;

    if (!isLoggedIn && lower.includes('/login')) {
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

    const cleanText = text.replace(/^(?:\[[^\]]+\]\s*)*(?:MOD|HELPER|SRHELPER|OWNER|ADMIN|COOWNER|BUILDER|VIP|MVP|YOUTUBE|DEFAULT)\s+/i, '').trim();
    
    const matchVanilla = cleanText.match(/^<~?([a-zA-Z0-9_]{3,16})>\s*(.+)/);
    const matchPrefix = cleanText.match(/^~?([a-zA-Z0-9_]{3,16})\s*[:»\->]\s*(.+)/);
    
    if (matchVanilla) {
      sender = matchVanilla[1];
      message = matchVanilla[2];
    } else if (matchPrefix) {
      sender = matchPrefix[1];
      message = matchPrefix[2];
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

    console.log(`[LIVE CHAT] ${sender}: ${message}`);

    chatHistory.push({ time: new Date().toLocaleTimeString(), sender, message });
    if (chatHistory.length > MAX_HISTORY) chatHistory.shift();

    // Push the message to the queue and instantly alert the smart scanner
    chunkBuffer.push({ sender, message });
    triggerSmartScan();

    if (message.toLowerCase().includes(CONFIG.server.username.toLowerCase())) {
        handleChatResponse(sender, message);
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

function shutdown() {
  console.log(`\n[${CONFIG.engine}] Shutting down...`);
  if (bot) bot.quit(); 
  setTimeout(() => process.exit(0), 500); 
}

process.on('SIGINT', shutdown);  
process.on('SIGTERM', shutdown); 

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'Console> ',
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
  shutdown();
});

async function boot() {
  await verifyApiKeys();
  createBot();
}

boot();
