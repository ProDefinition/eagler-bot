const mineflayer = require('mineflayer');
const readline = require('readline');
const { Groq } = require('groq-sdk');

['log', 'warn', 'error'].forEach((method) => {
    const original = console[method];
    console[method] = function(...args) {
        if (args.length && typeof args[0] === 'string' && args[0].includes('Ignoring block entities as chunk failed to load')) return;
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
    modApiKeys: [
      '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',
      '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',
      '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'
    ],
    chatApiKey: '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',
    model: 'qwen/qwen3-32b',      
    chatModel: 'llama-3.1-8b-instant',
    chunkIntervalMs: 4000 // How often to process a chunk of messages (4 seconds)
  }
};

let bot = null;
let isInGame = false;
let isLoggedIn = false;
let isReady = false; 

const chatHistory = [];
const MAX_HISTORY = 15; 
const warnedPlayers = new Set(); 
const modCache = new Map(); 

const chatTimestamps = [];
const MAX_RPM = 28; 

const modClients = CONFIG.groq.modApiKeys.map(key => new Groq({ apiKey: key }));
let currentModClientIndex = 0;
const modTimestamps = Array(CONFIG.groq.modApiKeys.length).fill().map(() => []);

const chatGroq = new Groq({ apiKey: CONFIG.groq.chatApiKey });

// We changed this from a single queue to a chunk buffer
let chunkBuffer = [];
let isProcessingChunk = false;

// NEW PROMPT: Tells the AI to process a chunk and return an Array.
const SYSTEM_PROMPT = `
You are an AI moderator for a Minecraft server.
You will evaluate a CHUNK of recent chat messages.

CRITICAL RULES - READ CAREFULLY:
1. IGNORE RUDENESS & CAPS: You MUST NOT punish players for shouting (ALL CAPS), whining, demanding things, or mild spam.
2. PROFANITY = MUTE: ANY profanity (e.g., "fuck", "shit", "bitch"), slurs, or swearing MUST result in a MUTE. Do not issue warnings for swearing.

Analyze the chunk of messages. Return a strictly formatted JSON ARRAY of punishments for anyone who broke the rules.
If NO ONE broke any rules, you MUST return an empty array: []

Format exactly like this:
[
  {
    "action": "WARN" | "MUTE" | "KICK",
    "target": "username of offender",
    "duration": "10m",
    "reason": "Brief reason"
  }
]
`;

const CHAT_SYSTEM_PROMPT = `
You are 'Habibi', a veteran Minecraft administrator. You've seen everything. You are highly realistic, grounded, and slightly cynical. 

PERSONALITY & REALISM:
- You are professional but speak like a real person. Use lowercase occasionally, use common internet shorthand (idk, mb, dw, lol) where it feels natural.
- RELEVANCE: Only respond if the message is actually worth your time. 
- IGNORING: If a player is being annoying, asking stupid questions, or saying something nonsensical, respond with the exact word "[IGNORE]".
- DISMISSIVENESS: If you don't want to explain something, just say "idk" or "google it" or "not my problem."
- THE RIZZ: On extremely rare occasions (1 in 50 chance), if a player is being genuinely cool or charming, you can drop a very subtle, smooth, or charismatic line. Do not be thirsty; be "cool."
- You are an AI, but don't act like a corporate assistant. Act like a guy who gets paid to keep this server running.

RULES:
- Responses MUST be under 140 characters.
- No emojis. No markdown.
- Address players by name.
`;

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
  
  const reason = decision.reason ? `Automod: ${decision.reason}` : `Automod: Policy violation`;
  
  switch (decision.action.toUpperCase()) {
    case 'WARN':
      if (warnedPlayers.has(target)) {
        say(`/tempmute ${target} 10m ${reason} (Ignored Warning)`);
        console.log(`[System] Escalated ${target} to MUTE.`);
      } else {
        warnedPlayers.add(target);
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

// THIS IS THE NEW CHUNK SCANNER
async function processChunkScanner() {
  if (isProcessingChunk || chunkBuffer.length === 0) return;
  isProcessingChunk = true;

  // Grab all messages currently in the buffer (up to 20 to prevent context overload)
  const chunkToProcess = chunkBuffer.splice(0, 20);
  
  // Format the chunk into a single readable string for the AI
  const formattedChunk = chunkToProcess.map(item => `Sender: ${item.sender} | Message: "${item.message}"`).join('\n');
  
  console.log(`[Mod Debug] Scanning Chunk of ${chunkToProcess.length} messages...`);

  const keyIndex = currentModClientIndex;
  const currentGroq = modClients[keyIndex];
  currentModClientIndex = (currentModClientIndex + 1) % modClients.length;

  try {
    await enforceRateLimit(modTimestamps[keyIndex]);

    const response = await currentGroq.chat.completions.create({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `EVALUATE THIS CHUNK OF MESSAGES:\n\n${formattedChunk}` }
      ],
      model: CONFIG.groq.model,
      temperature: 0.0, 
      max_tokens: 300,  
    });

    let reply = response.choices[0]?.message?.content?.trim() || '[]';
    console.log(`[Mod Debug] AI RAW Reply:`, reply.replace(/[\n\r]/g, ' '));
    
    // Extract JSON Array
    const startIdx = reply.indexOf('[');
    const endIdx = reply.lastIndexOf(']');
    if (startIdx !== -1 && endIdx !== -1) {
      reply = reply.substring(startIdx, endIdx + 1);
    }

    try {
      const decisions = JSON.parse(reply);
      
      if (Array.isArray(decisions) && decisions.length > 0) {
        decisions.forEach(decision => {
           // Don't repunish if we've already cached this exact message context
           handlePunishment(decision, decision.target);
        });
      }
    } catch (parseError) {
      console.error(`[Moderation] Agent returned invalid JSON Array:`, reply);
    }

  } catch (error) {
    console.error(`[Moderation] API Error during chunk scan: ${error.message}`);
    // If it fails (like a 429), push the messages back to the front of the buffer to try again
    if (error.status === 429) {
       chunkBuffer = [...chunkToProcess, ...chunkBuffer];
    }
  }

  isProcessingChunk = false;
}

// Run the chunk scanner every 4 seconds
setInterval(processChunkScanner, CONFIG.groq.chunkIntervalMs);

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

    if (!reply || reply.includes('[IGNORE]') || reply === '...') {
      console.log(`[AI Chat] Habibi decided to ignore ${sender}.`);
      return; 
    }
    
    if (Math.random() > 0.5) {
      reply = reply.toLowerCase().replace(/[.!?]$/, "");
    }

    say(reply);
    console.log(`[AI Chat] Responded to ${sender}: ${reply}`);
  } catch (error) {
    console.error(`[AI Chat] API Error: ${error.message}`);
  }
}

function say(text) {
  if (!bot || !text) return;
  text = text.replace(/[\n\r]/g, ' ').trim();
  
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
      
      delay += 500; 
      remaining = remaining.slice(chunk.length).trim();
    }
  }, 250);
}

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

    console.log('[System] >>> ALL CHECKS PASSED. AGENT ARMED. <<<');
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
    console.log('[Bot] Disconnected. Waiting 15s for server to clear ghost session...');
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

    // Send chat to the chat history for context
    chatHistory.push({ time: new Date().toLocaleTimeString(), sender, message });
    if (chatHistory.length > MAX_HISTORY) chatHistory.shift();

    // Push the message directly into the new Chunk Buffer
    if (message.length >= 3) {
      chunkBuffer.push({ sender, message });
    }

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
  console.log('\n[System] Shutting down gracefully. Disconnecting bot...');
  if (bot) bot.quit(); 
  setTimeout(() => process.exit(0), 500); 
}

process.on('SIGINT', shutdown);  
process.on('SIGTERM', shutdown); 

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
  shutdown();
});

createBot();
