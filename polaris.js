/**
 * Polaris - Minecraft Bot with Firebase Integration
 * No SDKs. Pure HTTP for Firebase Realtime Database.
 */

const mineflayer = require('mineflayer');
const readline = require('readline');
const dns = require('dns').promises;
const net = require('net');

// ==================== DEBUG ====================
const DEBUG = true;
const log = (...a) => console.log('[Polaris]', ...a);
const dbg = (...a) => DEBUG && console.log('[DEBUG]', ...a);
const err = (...a) => console.log('[ERROR]', ...a);

// ==================== CONFIG ====================
const CONFIG = {
  engine: 'Polaris v6.5',
  server: {
    host: 'play.pcsmp.net',
    port: 25565,
    username: 'ChewKok',
    version: '1.12.2',
    password: '551417114',
    targetServer: 'lifesteal'
  },
  chat: { max_length: 250 },
  groq: {
    chatApiKey: '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',
    chatModel: 'llama-3.1-8b-instant'
  },
  debug: {
    probePorts: true,
    ports: [25565, 25566, 25567, 25570, 25575]
  },
  // Firebase configuration (no auth)
  firebase: {
    databaseURL: 'https://polaris-358ae-default-rtdb.firebaseio.com',
    statusPath: 'status',
    chatPath: 'chat',
    commandsPath: 'commands',
    pollInterval: 2000 // ms
  },
  // Mild terms go to logging only. Everything else goes to mute mode.
  softWords: [
    'ass', 'damn', 'hell', 'bloody', 'piss', 'bastard', 'douche', 'wanker', 'bugger'
  ],
  bannedWords: [
    'fuck', 'fck', 'fuk', 'f**k', 'fucking', 'fucked', 'fucker', 'motherfucker', 'mofo', 'fukboi', 'fukboy', 'fudgepacker',
    'shit', 'sh1t', 'sh!t', 's**t', 'shitty', 'bullshit', 'bullsh!t', 'dipshit',
    'ass', 'asshole', 'arse', 'arsehole', 'jackass', 'dumbass', 'smartass', 'badass',
    'bitch', 'b!tch', 'biatch', 'bitching', 'bitchy', 'sonofabitch',
    'cunt', 'c**t',
    'dick', 'd1ck', 'd!ck', 'cock', 'prick',
    'pussy', 'pusy', 'pussies',
    'bastard',
    'douche', 'douchebag', 'douchecanoe',
    'wanker', 'tosser',
    'bugger',
    'hell', 'bloody', 'bloody hell', 'damn', 'goddamn',
    'piss', 'pissed', 'piss off',
    'slut', 'whore',
    'retard', 'retarded',
    'nigger', 'nigga', 'n1gg3r', 'nigg3r', 'nig-nog', 'coon', 'spic', 'spik', 'kike', 'chink', 'chinky', 'gook', 'gooker', 'goy', 'goyim', 'honky', 'cracker', 'jap', 'paki', 'raghead', 'wop', 'guido', 'dago', 'beaner', 'wetback', 'zipperhead', 'heeb', 'kraut', 'yid', 'gypsy', 'gippo', 'half-breed', 'mulatto', 'oreo', 'uncle tom', 'darky', 'darkie', 'golliwog', 'golly', 'sambo', 'wog', 'boong', 'pikey', 'spade', 'jungle bunny', 'porch monkey', 'sand nigger', 'timber nigger',
    'faggot', 'fag', 'faggy', 'dyke', 'dike', 'tranny', 'shemale', 'poof', 'poofter',
    'spaz', 'spastic', 'cripple', 'midget', 'gimp', 'window licker',
    'infidel', 'christ-killer', 'papist', 'kafir',
    'hillbilly', 'redneck',
    'rape', 'raper', 'rapist', 'molest', 'cunnilingus', 'fellatio', 'blowjob', 'bukkake', 'cuck', 'cuckold', 'circlejerk', 'handjob', 'rimjob', 'fisting', 'pegging', 'scat', 'watersports', 'anal', 'analingus', 'clit', 'clitoris', 'penis', 'vagina', 'vulva', 'labia', 'testicles', 'tits', 'titties', 'boobs', 'cum', 'jizz', 'semen', 'sperm', 'precum', 'orgasm', 'masturbate', 'wank', 'jerk off',
    'kill yourself', 'kys', 'suicide', 'cut yourself', 'go die', 'hang yourself',
    'pedo', 'pedophile', 'loli', 'lolicon', 'childporn', 'jailbait',
    'nazi', 'hitler', 'heil hitler', '1488', 'swastika', 'klu klux klan', 'reich', 'fuhrer', 'aryan', 'white power'
  ]
};

// ==================== GLOBAL STATE ====================
let bot;
let isReady = false;
let isLoggedIn = false;
let loginSent = false;
let autoSwitchDone = false;
let moderationEnabled = true;       // can be toggled via dashboard
let commandPollInterval = null;
const muteCooldown = new Map();

// ==================== NORMALIZATION ====================
function normalizeForMatch(input) {
  const map = {
    '0': 'o', '1': 'i', '2': 'z', '3': 'e', '4': 'a',
    '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g',
    '@': 'a', '$': 's', '!': 'i', '+': 't', '#': 'h',
    '|': 'l', '(': 'c', '[': 'c'
  };
  
  // Strip unicode variations & diacritics
  let out = String(input).normalize('NFKD')
    .replace(/[\u0300-\u036f\u200B-\u200D\uFEFF]/g, '')
    .toLowerCase();
    
  let cleaned = '';
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    cleaned += map[ch] || ( (ch >= 'a' && ch <= 'z') ? ch : ' ' );
  }

  // Deduplicate chars (e.g., "shhhhittt" -> "shit")
  return cleaned
    .replace(/([a-z])\1+/g, '$1') 
    .replace(/\s+/g, ' ')
    .trim();
}

// ==================== PRODUCTION CUCKOO FILTER ====================
class ProdCuckooFilter {
  constructor(expectedItems = 4096) {
    this.bucketSize = 4;
    this.maxKicks = 500;
    this.size = 0;
    
    // Size to ensure max 85% load factor initially
    let desiredBuckets = Math.ceil((expectedItems * 1.25) / this.bucketSize);
    this.numBuckets = 2;
    while (this.numBuckets < desiredBuckets) this.numBuckets <<= 1;
    
    this.mask = this.numBuckets - 1;
    // High-performance 1D Array to prevent Garbage Collection stutters
    this.table = new Uint32Array(this.numBuckets * this.bucketSize);
  }

  // Fast Murmur3-inspired 64-bit split hash function
  static hashData(str) {
    let h1 = 0x811c9dc5, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      let ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 0x01000193);
      h2 = Math.imul(h2 ^ ch, 0x1597334677);
    }
    h1 = (Math.imul(h1 ^ (h1 >>> 16), 0x2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 0x3266489909)) >>> 0;
    h2 = (Math.imul(h2 ^ (h2 >>> 16), 0x2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 0x3266489909)) >>> 0;
    return [h1, h2]; // [IndexHash, Fingerprint]
  }

  _altIndex(index, fp) {
    let hash = Math.imul(fp, 0x5bd1e995);
    hash = hash ^ (hash >>> 15);
    return (index ^ hash) & this.mask;
  }

  insert(item) {
    const [h, rawFp] = ProdCuckooFilter.hashData(item);
    let fp = rawFp === 0 ? 1 : rawFp; 
    let idx1 = h & this.mask;
    let idx2 = this._altIndex(idx1, fp);

    if (this._insertIntoBucket(idx1, fp) || this._insertIntoBucket(idx2, fp)) {
      this.size++; return true;
    }

    let curIdx = Math.random() < 0.5 ? idx1 : idx2;
    let curFp = fp;

    for (let n = 0; n < this.maxKicks; n++) {
      const slot = Math.floor(Math.random() * this.bucketSize);
      const ptr = (curIdx * this.bucketSize) + slot;
      
      const evicted = this.table[ptr];
      this.table[ptr] = curFp;
      curFp = evicted;
      
      curIdx = this._altIndex(curIdx, curFp);
      if (this._insertIntoBucket(curIdx, curFp)) {
        this.size++; return true;
      }
    }
    
    // Auto-expand if bucket collision is too dense
    this._expand();
    return this.insert(item);
  }

  _insertIntoBucket(index, fp) {
    const base = index * this.bucketSize;
    for (let i = 0; i < this.bucketSize; i++) {
      if (this.table[base + i] === 0) {
        this.table[base + i] = fp;
        return true;
      }
    }
    return false;
  }

  contains(item) {
    const [h, rawFp] = ProdCuckooFilter.hashData(item);
    const fp = rawFp === 0 ? 1 : rawFp;
    
    const idx1 = h & this.mask;
    const base1 = idx1 * this.bucketSize;
    if (this.table[base1]===fp || this.table[base1+1]===fp || 
        this.table[base1+2]===fp || this.table[base1+3]===fp) return true;

    const idx2 = this._altIndex(idx1, fp);
    const base2 = idx2 * this.bucketSize;
    if (this.table[base2]===fp || this.table[base2+1]===fp || 
        this.table[base2+2]===fp || this.table[base2+3]===fp) return true;

    return false;
  }

  _expand() {
      // Stub - Overridden in buildFilter to re-insert string items safely
  }
}

function buildFilter(rawTerms) {
  const normalizedTerms = new Set();
  let maxWords = 1;

  for (const raw of rawTerms) {
    const term = normalizeForMatch(raw);
    if (!term) continue;
    normalizedTerms.add(term);
    
    // Length-bounded Compaction: Only compact long words to prevent False Positives (like "glass" -> "ass")
    if (term.replace(/\s+/g, '').length > 4) {
        normalizedTerms.add(term.replace(/\s+/g, ''));
    }
    const wordCount = term.split(' ').length;
    if (wordCount > maxWords) maxWords = wordCount;
  }

  const termsArray = Array.from(normalizedTerms);
  const filter = new ProdCuckooFilter(Math.max(4096, termsArray.length));
  
  // Safe expansion handles filter rebuilding without data loss
  filter._expand = function() {
      log(`[Automod] Expanding Cuckoo capacity...`);
      this.numBuckets <<= 1;
      this.mask = this.numBuckets - 1;
      this.table = new Uint32Array(this.numBuckets * this.bucketSize);
      this.size = 0;
      for (const term of termsArray) {
          if (!this.insert(term)) throw new Error("Filter expansion loop!");
      }
  };

  for (const term of termsArray) filter.insert(term);
  return { filter, maxWords };
}

const softTermsNormalized = CONFIG.softWords.map(normalizeForMatch).filter(Boolean);
const softSet = new Set(softTermsNormalized);
const hardWords = CONFIG.bannedWords.filter(raw => {
  const cleaned = normalizeForMatch(raw);
  return cleaned && !softSet.has(cleaned);
});

const HARD_INDEX = buildFilter(hardWords);
const SOFT_INDEX = buildFilter(CONFIG.softWords);

// ==================== MODERATION CLASSIFIER ====================
function classifyModeration(text) {
  const normalized = normalizeForMatch(text);
  if (!normalized) return { hardHits: [], softHits: [] };
  
  const tokens = normalized.split(' ').filter(Boolean);
  const candidates = new Set();
  
  // 1. Safe N-Grams (Exact boundaries)
  const maxW = Math.max(HARD_INDEX.maxWords, SOFT_INDEX.maxWords);
  for (let size = 1; size <= maxW; size++) {
    for (let i = 0; i + size <= tokens.length; i++) {
      candidates.add(tokens.slice(i, i + size).join(' '));
    }
  }

  // 2. Sliding Window on Compact Strings (Catches spacing evasion without triggering small false positives)
  const compactedText = tokens.join('');
  if (compactedText.length > 4) {
      candidates.add(compactedText);
      for(let len = 5; len <= 12 && len <= compactedText.length; len++) {
          for(let i = 0; i + len <= compactedText.length; i++) {
              candidates.add(compactedText.substring(i, i + len));
          }
      }
  }

  const hardHits = [];
  const softHits = [];

  for (const candidate of candidates) {
    if (HARD_INDEX.filter.contains(candidate)) hardHits.push(candidate);
    else if (SOFT_INDEX.filter.contains(candidate)) softHits.push(candidate);
  }

  return { 
      hardHits: [...new Set(hardHits)], 
      softHits: [...new Set(softHits)] 
  };
}

const containsProfanity = (text) => classifyModeration(text).hardHits.length > 0;

// ==================== UTIL: STRIP COLOUR CODES ====================
function stripColorCodes(str) {
  return str.replace(/§[0-9a-fk-or]/g, '');
}

// ==================== SRV ====================
async function resolveServer() {
  try {
    const srv = await dns.resolveSrv(`_minecraft._tcp.${CONFIG.server.host}`);
    if (srv.length) {
      const r = srv[0];
      log(`SRV FOUND → port ${r.port}`);
      dbg(`SRV target (ignored): ${r.name}`);
      return { host: CONFIG.server.host, port: r.port };
    }
  } catch (e) {
    dbg('SRV failed:', e.code);
  }
  const ip = await dns.lookup(CONFIG.server.host);
  log(`A → ${ip.address}`);
  return { host: CONFIG.server.host, port: CONFIG.server.port };
}

// ==================== PORT SCAN ====================
function testPort(host, port) {
  return new Promise(res => {
    const s = new net.Socket();
    s.setTimeout(3000);
    s.on('connect', () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
    s.on('timeout', () => res(false));
    s.connect(port, host);
  });
}

async function findPort(host, base) {
  if (!CONFIG.debug.probePorts) return base;
  for (const p of [base, ...CONFIG.debug.ports]) {
    dbg(`Testing ${host}:${p}`);
    if (await testPort(host, p)) {
      log(`OPEN PORT → ${p}`);
      return p;
    }
  }
  return base;
}

// ==================== SAY ====================
function say(text) {
  if (!bot) return;
  if (text.length <= CONFIG.chat.max_length) {
    bot.chat(text);
    return;
  }
  let remaining = text;
  let delay = 0;
  while (remaining.length) {
    let chunk = remaining.slice(0, CONFIG.chat.max_length);
    const lastSpace = chunk.lastIndexOf(' ');
    if (lastSpace > 100) chunk = chunk.slice(0, lastSpace);
    setTimeout(() => bot.chat(chunk), delay);
    delay += 400;
    remaining = remaining.slice(chunk.length).trim();
  }
}

// ==================== FIREBASE REST HELPERS ====================
const firebase = {
  baseURL: CONFIG.firebase.databaseURL,

  async put(path, data) {
    const url = `${this.baseURL}/${path}.json`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(`Firebase PUT failed: ${res.status}`);
    return res.json();
  },

  async patch(path, data) {
    const url = `${this.baseURL}/${path}.json`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(`Firebase PATCH failed: ${res.status}`);
    return res.json();
  },

  async post(path, data) {
    const url = `${this.baseURL}/${path}.json`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(`Firebase POST failed: ${res.status}`);
    return res.json();
  },

  async get(path) {
    const url = `${this.baseURL}/${path}.json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Firebase GET failed: ${res.status}`);
    return res.json();
  },

  async delete(path) {
    const url = `${this.baseURL}/${path}.json`;
    const res = await fetch(url, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Firebase DELETE failed: ${res.status}`);
    return res.json();
  }
};

// Update bot status in Firebase
async function updateFirebaseStatus() {
  if (!bot) return;
  const status = {
    online: isReady && isLoggedIn,
    username: CONFIG.server.username,
    server: `${CONFIG.server.host}:${CONFIG.server.port}`,
    targetServer: CONFIG.server.targetServer || null,
    moderationEnabled: moderationEnabled,
    lastSeen: new Date().toISOString(),
    players: bot.players ? Object.keys(bot.players).length : 0
  };
  try {
    await firebase.put(CONFIG.firebase.statusPath, status);
  } catch (e) {
    err('Firebase status update error:', e.message);
  }
}

// Push a chat message to Firebase
async function pushChatMessage(sender, message, type = 'public') {
  const entry = {
    sender,
    message,
    timestamp: Date.now(),
    type
  };
  try {
    await firebase.post(CONFIG.firebase.chatPath, entry);
    // Keep chat list manageable: we could add a cleanup function later
  } catch (e) {
    err('Firebase chat push error:', e.message);
  }
}

// Process incoming commands from Firebase
async function processFirebaseCommands() {
  try {
    const commands = await firebase.get(CONFIG.firebase.commandsPath);
    if (!commands) return;
    
    for (const [id, cmd] of Object.entries(commands)) {
      if (!cmd || cmd.processed) continue;
      
      log(`Received command: ${cmd.type} from dashboard`);
      
      try {
        switch (cmd.type) {
          case 'chat':
            if (cmd.text) say(cmd.text);
            break;
            
          case 'command':
            // Execute raw Minecraft command (e.g., /kick Habibi)
            if (cmd.command) bot.chat(cmd.command);
            break;
            
          case 'toggleModeration':
            moderationEnabled = cmd.enabled === true;
            log(`Moderation ${moderationEnabled ? 'enabled' : 'disabled'}`);
            await updateFirebaseStatus();
            break;
            
          case 'shutdown':
            log('Shutdown command received. Exiting...');
            await updateFirebaseStatus();
            process.exit(0);
            break;
            
          case 'kickGhost':
            // Kick the bot's own username to resolve ghost issue
            bot.chat(`/kick ${CONFIG.server.username}`);
            say(`Attempted to kick ghost ${CONFIG.server.username}`);
            break;
            
          default:
            err(`Unknown command type: ${cmd.type}`);
        }
        
        // Mark as processed by deleting the command
        await firebase.delete(`${CONFIG.firebase.commandsPath}/${id}`);
      } catch (cmdErr) {
        err(`Error processing command ${id}:`, cmdErr);
        // Optionally leave it for retry, but we'll delete to avoid loops
        await firebase.delete(`${CONFIG.firebase.commandsPath}/${id}`);
      }
    }
  } catch (e) {
    err('Firebase command polling error:', e.message);
  }
}

// Start polling for commands
function startCommandPolling() {
  if (commandPollInterval) clearInterval(commandPollInterval);
  commandPollInterval = setInterval(() => {
    if (bot && isReady && isLoggedIn) {
      processFirebaseCommands().catch(e => err('Command poll error:', e));
    }
  }, CONFIG.firebase.pollInterval);
}

// Stop polling
function stopCommandPolling() {
  if (commandPollInterval) {
    clearInterval(commandPollInterval);
    commandPollInterval = null;
  }
}

// ==================== BOT CREATION ====================
async function createBot() {
  // Clean up previous polling
  stopCommandPolling();
  
  loginSent = false;
  isReady = false;
  isLoggedIn = false;
  autoSwitchDone = false;
  
  log('Resolving...');
  const resolved = await resolveServer();
  const port = await findPort(resolved.host, resolved.port);
  
  log(`CONNECT → ${resolved.host}:${port}`);
  bot = mineflayer.createBot({
    host: resolved.host,
    port,
    username: CONFIG.server.username,
    version: CONFIG.server.version
  });

  bot.on('spawn', () => {
    log('Spawned');
    isReady = true;
    updateFirebaseStatus().catch(e => err('Status update error:', e));
    startCommandPolling();
    
    // Periodically update status every 30 seconds
    setInterval(() => {
      if (bot && isReady) updateFirebaseStatus().catch(e => err('Status update error:', e));
    }, 30000);
  });

  bot.on('message', (msg) => {
    const rawText = msg.toString();
    const text = stripColorCodes(rawText);
    log('CHAT:', text);
    
    // Push all chat messages to Firebase for dashboard
    if (text && !text.startsWith('[') && !text.includes('joined the game') && !text.includes('left the game')) {
      // Try to parse public chat messages
      const match = text.match(/^([^:]+?):\s(.+)$/);
      if (match) {
        const sender = match[1].trim();
        const message = match[2].trim();
        pushChatMessage(sender, message, 'public').catch(e => err('Chat push error:', e));
      } else {
        // System messages, etc.
        pushChatMessage('SERVER', text, 'system').catch(e => err('Chat push error:', e));
      }
    }
    
    if (!isLoggedIn && !loginSent) {
      if (text.includes('Use the command /login') || text.includes('/login <password>')) {
        log('Login prompt detected – sending password...');
        bot.chat(`/login ${CONFIG.server.password}`);
        loginSent = true;
        return;
      }
    }
    
    if (!isLoggedIn && (text.includes('You have successfully logged') || text.includes('You are already logged in'))) {
      isLoggedIn = true;
      loginSent = true;
      log('Login confirmed.');
      updateFirebaseStatus().catch(e => err('Status update error:', e));
      if (!autoSwitchDone && CONFIG.server.targetServer) {
        autoSwitchDone = true;
        setTimeout(() => {
          if (bot) {
            log(`Switching to ${CONFIG.server.targetServer}...`);
            bot.chat(`/server ${CONFIG.server.targetServer}`);
          }
        }, 2000);
      }
      return;
    }
    
    // Moderation only for public chat messages
    const match = text.match(/^([^:]+?):\s(.+)$/);
    if (!match) return;
    
    const sender = match[1].trim();
    const message = match[2].trim();
    if (sender === CONFIG.server.username) return;
    
    if (!moderationEnabled) {
      dbg(`Moderation disabled, skipping: ${sender}: ${message}`);
      return;
    }
    
    const mod = classifyModeration(message);
    
    if (mod.hardHits.length) {
      log(`MUTE HIT → ${sender}: ${message} [${mod.hardHits.join(', ')}]`);
      const now = Date.now();
      const last = muteCooldown.get(sender) || 0;
      if (now - last < 2000) {
        log(`Mute cooldown active for ${sender}, skipping.`);
        return;
      }
      muteCooldown.set(sender, now);
      say(`/tempmute ${sender} 10m Automod: Cuckoo filter match`);
      return;
    }
    
    if (mod.softHits.length) {
      log(`SOFT HIT → ${sender}: ${message} [${mod.softHits.join(', ')}]`);
    }
  });

  bot.on('error', e => {
    err(e.message);
    updateFirebaseStatus().catch(() => {});
  });
  
  bot.on('kicked', r => {
    err('Kicked:', r);
    updateFirebaseStatus().catch(() => {});
  });
  
  bot.on('end', () => {
    log('Reconnect in 1s...');
    isReady = false;
    updateFirebaseStatus().catch(() => {});
    stopCommandPolling();
    setTimeout(createBot, 1000);
  });
}

// ==================== CONSOLE ====================
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.on('line', line => {
  if (bot) {
    bot.chat(line);
  } else {
    log('Bot not connected.');
  }
});

// Graceful shutdown
process.on('SIGINT', async () => {
  log('Received SIGINT. Shutting down...');
  if (bot) {
    try {
      await firebase.patch(CONFIG.firebase.statusPath, { online: false, lastSeen: new Date().toISOString() });
    } catch (e) {}
    bot.quit();
  }
  process.exit(0);
});

// ==================== START ====================
createBot();
