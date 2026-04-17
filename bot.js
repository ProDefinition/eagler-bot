const mineflayer = require('mineflayer');
const readline = require('readline');
const { Groq } = require('groq-sdk');
const admin = require('firebase-admin');

// ==================== CONFIGURATION ====================
const CONFIG = {
  engine: 'Polaris v2.0',
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
    chatApiKey: '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',
    chatModel: 'llama-3.1-8b-instant',
  },
  // Content filter thresholds
  filter: {
    warnOnFirstOffense: true,
    muteDuration: '10m',
  },
  // RTDB paths
  rtdb: {
    statusPath: '/status',
    commandsPath: '/commands',
    logsPath: '/logs',
    chatIncomingPath: '/chat/incoming',   // from game to dashboard
    chatOutgoingPath: '/chat/outgoing',   // from dashboard to game
  },
};

// ==================== FIREBASE INIT ====================
// Initialize Firebase Admin with a service account.
// IMPORTANT: Place your serviceAccountKey.json in the same directory.
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://polaris-358ae-default-rtdb.firebaseio.com',
});

const db = admin.database();
const firestore = admin.firestore();

// References
const statusRef = db.ref(CONFIG.rtdb.statusPath);
const commandsRef = db.ref(CONFIG.rtdb.commandsPath);
const logsRef = db.ref(CONFIG.rtdb.logsPath);
const chatIncomingRef = db.ref(CONFIG.rtdb.chatIncomingPath);
const chatOutgoingRef = db.ref(CONFIG.rtdb.chatOutgoingPath);

// ==================== CONTENT FILTER (FIRESTORE) ====================
// Character map from the HTML demo (leetspeak + homoglyphs)
const charMap = new Map([
  ["0", "o"], ["1", "i"], ["2", "z"], ["3", "e"], ["4", "a"],
  ["5", "s"], ["6", "g"], ["7", "t"], ["8", "b"], ["9", "g"],
  ["@", "a"], ["$", "s"], ["!", "i"], ["|", "i"], ["+", "t"],
  ["(", "c"], [")", "c"], ["€", "e"], ["£", "l"], ["¥", "y"],
  ["%", "o"], ["#", "h"], ["&", "a"], ["*", "x"], ["?", "i"],
  // Cyrillic
  ["а", "a"], ["б", "b"], ["в", "b"], ["г", "r"], ["д", "d"],
  ["е", "e"], ["ё", "e"], ["ж", "j"], ["з", "z"], ["и", "i"],
  ["й", "y"], ["к", "k"], ["л", "l"], ["м", "m"], ["н", "n"],
  ["о", "o"], ["п", "p"], ["р", "p"], ["с", "c"], ["т", "t"],
  ["у", "y"], ["ф", "f"], ["х", "x"], ["ц", "c"], ["ч", "ch"],
  ["ш", "sh"], ["щ", "sh"], ["ъ", "b"], ["ы", "y"], ["ь", "b"],
  ["э", "e"], ["ю", "yu"], ["я", "ya"],
  // Greek
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
    .replace(/[\u200B-\u200D\uFEFF\u200C\u2028\u2029\u00A0\u1680\u180E\u2000-\u200F\u202F\u205F\u3000\u2060\uFEFF\u034F\u180E\u200B\u200C\u200D\u200E\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFFF9-\uFFFB\u034F\u180E]/g, "")
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
  a = String(a || ""); b = String(b || "");
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
  return raw !== compact || compact !== squeezed || /[^a-zA-Z0-9]/.test(raw) || /(.)\1{2,}/.test(raw);
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

// Trained words from Firestore
const trainedWords = new Map(); // normalized -> original

// Listen to Firestore for trained words
firestore.collection('trainedWords').onSnapshot(snapshot => {
  trainedWords.clear();
  snapshot.forEach(doc => {
    const data = doc.data();
    const original = data.word || doc.id;
    const normalized = data.normalized || normalizeWord(original);
    if (normalized) trainedWords.set(normalized, original);
  });
  console.log(`[${CONFIG.engine}] Loaded ${trainedWords.size} trained words.`);
}, err => {
  console.error(`[${CONFIG.engine}] Firestore error: ${err.message}`);
});

// Check if a message contains any banned word
function containsBannedWord(text) {
  // Collapse spaces to catch spaced bypass (e.g., "f u c k")
  const hasSpaces = /\s/.test(text);
  let collapsed = null;
  if (hasSpaces) {
    collapsed = text.replace(/\s+/g, '');
  }

  for (const [normWord, original] of trainedWords.entries()) {
    // Check individual tokens (simulate tokenization)
    const tokens = text.split(/(\s+)/);
    for (const token of tokens) {
      if (/^\s+$/.test(token)) continue;
      if (isMatch(token, normWord)) return { word: original };
    }
    // Check collapsed version for spaced bypass
    if (collapsed && isMatch(collapsed, normWord)) {
      return { word: original, bypass: true };
    }
  }
  return null;
}

// ==================== BOT STATE ====================
let bot = null;
let isInGame = false;
let isLoggedIn = false;
let isReady = false;

const chatHistory = [];
const MAX_HISTORY = 15;
const warnedPlayers = new Set();

// Groq for chat responses only
const chatGroq = new Groq({ apiKey: CONFIG.groq.chatApiKey });
const chatTimestamps = [];
const MAX_RPM = 28;

const CHAT_SYSTEM_PROMPT = `
You are 'Habibi', a Minecraft server administrator. You are realistic and grounded.

PERSONALITY:
- Speak casually, like a normal person. Use lowercase occasionally.
- Keep responses concise.
- Ignore nonsensical or annoying messages by responding with exactly "[IGNORE]".
- Responses must be under 140 characters. No emojis.
`;

// ==================== UTILS ====================
function logEvent(type, data) {
  const entry = {
    timestamp: admin.database.ServerValue.TIMESTAMP,
    type,
    ...data,
  };
  logsRef.push(entry);
  // Keep only last 500 logs to save space
  logsRef.limitToLast(500).once('value', snap => {
    if (snap.numChildren() > 500) {
      const firstKey = Object.keys(snap.val())[0];
      logsRef.child(firstKey).remove();
    }
  });
}

function say(text) {
  if (!bot || !text) return;
  text = text.replace(/[\n\r]/g, ' ').trim();

  setTimeout(() => {
    if (text.length <= CONFIG.chat.max_length) {
      bot.chat(text);
      // Log outgoing chat to dashboard
      chatIncomingRef.push({
        sender: CONFIG.server.username,
        message: text,
        timestamp: admin.database.ServerValue.TIMESTAMP,
        type: 'bot',
      });
      return;
    }

    let remaining = text;
    let delay = 0;
    while (remaining.length > 0) {
      let chunk = remaining.slice(0, CONFIG.chat.max_length);
      const lastSpace = chunk.lastIndexOf(' ');
      if (lastSpace > CONFIG.chat.max_length / 2) chunk = chunk.slice(0, lastSpace);

      setTimeout(() => {
        bot.chat(chunk);
        chatIncomingRef.push({
          sender: CONFIG.server.username,
          message: chunk,
          timestamp: admin.database.ServerValue.TIMESTAMP,
          type: 'bot',
        });
      }, delay);

      delay += 500;
      remaining = remaining.slice(chunk.length).trim();
    }
  }, 250);
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

// ==================== PUNISHMENT HANDLER ====================
function handlePunishment(target, matchedWord, message) {
  const reason = `Inappropriate language (${matchedWord})`;
  const quote = message.length > 50 ? message.substring(0, 47) + '...' : message;

  if (warnedPlayers.has(target)) {
    // Escalate to mute
    say(`/tempmute ${target} ${CONFIG.filter.muteDuration} Automod: ${reason} - "${quote}"`);
    logEvent('mute', { target, reason, quote });
    console.log(`[${CONFIG.engine}] 🔇 Muted ${target} for: ${reason}`);
  } else {
    warnedPlayers.add(target);
    say(`${target}, warning: ${reason}. Next offense is a mute.`);
    logEvent('warn', { target, reason, quote });
    console.log(`[${CONFIG.engine}] ⚠️ Warned ${target}.`);
  }
}

// ==================== CHAT PROCESSING ====================
function processChatMessage(sender, message) {
  // 1. Content Filter
  const banned = containsBannedWord(message);
  if (banned) {
    handlePunishment(sender, banned.word, message);
  }

  // 2. Log to RTDB for dashboard
  chatIncomingRef.push({
    sender,
    message,
    timestamp: admin.database.ServerValue.TIMESTAMP,
    type: 'player',
    flagged: !!banned,
  });

  // 3. Respond if bot is mentioned
  if (message.toLowerCase().includes(CONFIG.server.username.toLowerCase())) {
    handleChatResponse(sender, message);
  }

  // 4. Keep history
  chatHistory.push({ time: new Date().toLocaleTimeString(), sender, message });
  if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
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
  } catch (error) {
    console.error(`[${CONFIG.engine} Chat] API Error: ${error.message}`);
  }
}

// ==================== RTDB COMMAND LISTENER ====================
function listenForCommands() {
  commandsRef.on('child_added', async (snapshot) => {
    const cmd = snapshot.val();
    const key = snapshot.key;
    if (!cmd || cmd.processed) return;

    // Mark as processed to avoid duplicate execution
    await commandsRef.child(key).update({ processed: true });

    console.log(`[${CONFIG.engine}] Received command:`, cmd);

    try {
      switch (cmd.type) {
        case 'say':
          if (cmd.message) say(cmd.message);
          break;
        case 'execute':
          if (cmd.command) bot.chat(cmd.command);
          break;
        case 'kick':
          if (cmd.player) say(`/kick ${cmd.player} ${cmd.reason || 'Staff action'}`);
          break;
        case 'mute':
          if (cmd.player) say(`/tempmute ${cmd.player} ${cmd.duration || '10m'} ${cmd.reason || 'Staff action'}`);
          break;
        default:
          console.warn(`Unknown command type: ${cmd.type}`);
      }
    } catch (err) {
      console.error('Command execution error:', err);
    }

    // Remove command after processing
    setTimeout(() => commandsRef.child(key).remove(), 1000);
  });
}

// ==================== STATUS UPDATER ====================
function startStatusUpdates() {
  const update = () => {
    if (!bot || !isReady) return;
    const players = Object.values(bot.players).map(p => p.username);
    statusRef.set({
      online: true,
      server: CONFIG.server.host,
      username: CONFIG.server.username,
      players: players,
      playerCount: players.length,
      health: bot.health,
      food: bot.food,
      lastUpdate: admin.database.ServerValue.TIMESTAMP,
    });
  };
  update();
  setInterval(update, 5000);
}

// ==================== BOT CREATION ====================
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
    startStatusUpdates();

    // Anti-AFK
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
    statusRef.update({ online: false });
    setTimeout(createBot, 15000);
  });

  bot.on('error', (err) => console.log(`[Error] ${err.message}`));
  bot.on('kicked', (reason) => console.log(`[Kicked] ${reason}`));

  bot.on('message', async (jsonMsg) => {
    const text = jsonMsg.toString().trim();
    if (!text || text.length > 500) return;

    const lower = text.toLowerCase();

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

    // Ignore server messages
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

    // Parse sender and message
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
    processChatMessage(sender, message);
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

  bot.on('windowOpen', async () => {
    await new Promise(r => setTimeout(r, 500));
    if (bot.currentWindow) bot.clickWindow(1, 0, 0);
  });
}

// ==================== SHUTDOWN ====================
function shutdown() {
  console.log(`\n[${CONFIG.engine}] Shutting down...`);
  statusRef.update({ online: false });
  if (bot) bot.quit();
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Console input
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

// ==================== BOOT ====================
async function boot() {
  console.log(`[${CONFIG.engine}] Starting...`);
  // Verify Groq chat key
  try {
    await chatGroq.models.list();
    console.log(`[${CONFIG.engine}] ✅ Chat API Key is valid.`);
  } catch (error) {
    console.error(`[${CONFIG.engine}] ❌ Chat API Key FAILED: ${error.message}`);
    process.exit(1);
  }

  listenForCommands();
  createBot();
}

boot();
