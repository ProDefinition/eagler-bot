const mineflayer = require('mineflayer');
const readline = require('readline');
const { Groq } = require('groq-sdk');
const dns = require('dns').promises;

// Suppress annoying console spam
['log', 'warn', 'error'].forEach((method) => {
  const original = console[method];
  console[method] = function(...args) {
    if (args.length && typeof args[0] === 'string' && args[0].includes('Ignoring block entities')) return;
    original.apply(console, args);
  };
});

// ==================== CONFIGURATION ====================
const CONFIG = {
  engine: 'Polaris v2.1',
  server: {
    host: 'play.pcsmp.net',        // Will be resolved to IP
    port: 25565,
    username: 'Habibi',
    version: '1.12.2',
  },
  chat: {
    max_length: 250,
  },
  groq: {
    chatApiKey: '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',
    chatModel: 'llama-3.1-8b-instant',
  },
  bannedWords: [
    'fuck', 'shit', 'cunt', 'nigger', 'faggot', 'asshole', 'bitch', 'dick', 'pussy',
    'whore', 'slut', 'bastard', 'retard', 'kys', 'kill yourself', 'nazi', 'hitler'
  ]
};

// ==================== GLOBAL STATE ====================
let bot = null;
let isInGame = false;
let isLoggedIn = false;
let isReady = false;

const chatHistory = [];
const MAX_HISTORY = 15;
const warnedPlayers = new Set();

const chatTimestamps = [];
const MAX_RPM = 28;

let chatGroq = null;
let groqAvailable = false;

const trainedWords = new Map();

// ==================== CONTENT FILTER LOGIC ====================
const charMap = new Map([
  ["0", "o"], ["1", "i"], ["2", "z"], ["3", "e"], ["4", "a"],
  ["5", "s"], ["6", "g"], ["7", "t"], ["8", "b"], ["9", "g"],
  ["@", "a"], ["$", "s"], ["!", "i"], ["|", "i"], ["+", "t"],
  ["(", "c"], [")", "c"], ["€", "e"], ["£", "l"], ["¥", "y"],
  ["%", "o"], ["#", "h"], ["&", "a"], ["*", "x"], ["?", "i"],
  ["а", "a"], ["б", "b"], ["в", "b"], ["г", "r"], ["д", "d"],
  ["е", "e"], ["ё", "e"], ["ж", "j"], ["з", "z"], ["и", "i"],
  ["й", "y"], ["к", "k"], ["л", "l"], ["м", "m"], ["н", "n"],
  ["о", "o"], ["п", "p"], ["р", "p"], ["с", "c"], ["т", "t"],
  ["у", "y"], ["ф", "f"], ["х", "x"], ["ц", "c"], ["ч", "ch"],
  ["ш", "sh"], ["щ", "sh"], ["ъ", "b"], ["ы", "y"], ["ь", "b"],
  ["э", "e"], ["ю", "yu"], ["я", "ya"],
  ["α", "a"], ["β", "b"], ["γ", "g"], ["δ", "d"], ["ε", "e"],
  ["ζ", "z"], ["η", "n"], ["θ", "o"], ["ι", "i"], ["κ", "k"],
  ["λ", "l"], ["μ", "m"], ["ν", "v"], ["ξ", "x"], ["ο", "o"],
  ["π", "p"], ["ρ", "p"], ["σ", "s"], ["τ", "t"], ["υ", "y"],
  ["φ", "f"], ["χ", "x"], ["ψ", "ps"], ["ω", "o"],
  ["ⅼ", "l"], ["ⅰ", "i"], ["ⅴ", "v"], ["ⅹ", "x"]
]);

function normalizeWord(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u200B-\u200D\uFEFF\u200C\u2028\u2029\u00A0\u1680\u180E\u2000-\u200F\u202F\u205F\u3000\u2060\u2061\u2062\u2063\u2064\u206A-\u206F\uFFF9-\uFFFB]/g, "")
    .toLowerCase()
    .split("")
    .map(ch => charMap.get(ch) ?? ch)
    .join("")
    .replace(/[^a-z0-9]/g, "");
}

function squeezeRuns(value) {
  return String(value || "").replace(/(.)\1+/g, "$1");
}

function isSubsequence(needle, haystack) {
  if (!needle || !haystack) return false;
  let i = 0, j = 0;
  while (i < needle.length && j < haystack.length) {
    if (needle[i] === haystack[j]) i++;
    j++;
  }
  return i === needle.length;
}

function levenshtein(a, b) {
  a = String(a || "");
  b = String(b || "");
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (a.length > b.length) [a, b] = [b, a];
  const prev = new Array(a.length + 1);
  for (let i = 0; i <= a.length; i++) prev[i] = i;
  for (let j = 1; j <= b.length; j++) {
    let diag = prev[0];
    prev[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const temp = prev[i];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[i] = Math.min(prev[i] + 1, prev[i - 1] + 1, diag + cost);
      diag = temp;
    }
  }
  return prev[a.length];
}

function isObfuscated(raw, compact, squeezed) {
  return (
    raw !== compact ||
    compact !== squeezed ||
    /[^a-zA-Z0-9]/.test(raw) ||
    /(.)\1{2,}/.test(raw)
  );
}

function isMatch(rawChunk, targetNorm) {
  const compact = normalizeWord(rawChunk);
  if (!compact || !targetNorm) return false;
  const squeezed = squeezeRuns(compact);
  if (compact === targetNorm || squeezed === targetNorm) return true;

  const obfuscated = isObfuscated(rawChunk, compact, squeezed);
  if (obfuscated && (compact.includes(targetNorm) || squeezed.includes(targetNorm) || isSubsequence(targetNorm, squeezed))) {
    return true;
  }

  const len = targetNorm.length;
  const maxDist = len <= 3 ? 0 : len <= 5 ? 1 : len <= 8 ? 2 : 3;
  return levenshtein(squeezed, targetNorm) <= maxDist;
}

function tokenize(text) {
  return String(text || "").split(/(\s+)/);
}

function containsProfanity(text) {
  if (trainedWords.size === 0) return false;

  const hasSpaces = /\s/.test(text);
  if (hasSpaces) {
    const noSpace = text.replace(/\s+/g, "");
    for (const [normWord] of trainedWords) {
      if (isMatch(noSpace, normWord)) return true;
    }
  }

  const parts = tokenize(text);
  for (const part of parts) {
    if (/^\s+$/.test(part)) continue;
    for (const [normWord] of trainedWords) {
      if (isMatch(part, normWord)) return true;
    }
  }
  return false;
}

function loadLocalBannedWords() {
  CONFIG.bannedWords.forEach(word => {
    const normalized = normalizeWord(word);
    if (normalized) trainedWords.set(normalized, word);
  });
  console.log(`[${CONFIG.engine}] 📚 Local profanity filter loaded: ${trainedWords.size} words.`);
}

// ==================== GROQ CHAT ====================
const CHAT_SYSTEM_PROMPT = `
You are 'Habibi', a Minecraft server administrator. You are realistic and grounded.

PERSONALITY:
- Speak casually, like a normal person. Use lowercase occasionally.
- Keep responses concise. 
- Ignore nonsensical or annoying messages by responding with exactly "[IGNORE]".
- Responses must be under 140 characters. No emojis.
`;

async function handleChatResponse(sender, message) {
  if (!groqAvailable) return;

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
    if (error.status === 401) groqAvailable = false;
  }
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

// ==================== BOT CREATION WITH DNS RESOLUTION ====================
async function resolveHost(hostname) {
  try {
    const { address } = await dns.lookup(hostname, { family: 4 });
    console.log(`[${CONFIG.engine}] 🌐 Resolved ${hostname} → ${address}`);
    return address;
  } catch (err) {
    console.warn(`[${CONFIG.engine}] ⚠️ DNS lookup failed for ${hostname}, using hostname directly.`);
    return hostname;
  }
}

async function createBot() {
  console.log(`[${CONFIG.engine}] Connecting...`);

  // Resolve host to IP to bypass SRV records
  const resolvedHost = await resolveHost(CONFIG.server.host);

  bot = mineflayer.createBot({
    host: resolvedHost,
    port: CONFIG.server.port,
    username: CONFIG.server.username,
    version: CONFIG.server.version,
    // Skip SRV/A record validation entirely
    skipValidation: true,
    // Disable SRV lookup (available in newer mineflayer versions)
    // If your mineflayer version doesn't support this, it's harmless.
    srvLookup: false
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

    if (containsProfanity(message)) {
      console.log(`[${CONFIG.engine}] 🚫 Profanity detected from ${sender}: "${message}"`);
      say(`/tempmute ${sender} 10m Automod: Profanity detected`);
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

// ==================== STARTUP ====================
async function boot() {
  console.log(`\n[${CONFIG.engine}] 🚀 Initializing...`);

  loadLocalBannedWords();

  try {
    chatGroq = new Groq({ apiKey: CONFIG.groq.chatApiKey });
    await chatGroq.models.list();
    groqAvailable = true;
    console.log(`[${CONFIG.engine}] ✅ Chat API (Groq) is ready.`);
  } catch (error) {
    console.warn(`[${CONFIG.engine}] ⚠️ Chat API unavailable: ${error.message}. Bot will run without conversational responses.`);
    groqAvailable = false;
  }

  createBot();
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

rl.on('close', shutdown);

boot();
