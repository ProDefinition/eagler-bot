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
  engine: 'Polaris v6.0',

  server: {
    host: 'play.pcsmp.net',
    port: 25565,
    username: 'Habibi',
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
    'pedo', 'pedophile', 'loli', 'lolicon', 'childporn', 'preteen', 'jailbait',
    'nazi', 'hitler', 'heil hitler', '1488', 'swastika', 'kkk', 'klu klux klan', 'reich', 'fuhrer', 'aryan', 'white power'
  ]
};

// ==================== GLOBAL ====================
let bot;
let isReady = false;
let isLoggedIn = false;
let loginSent = false;
let autoSwitchDone = false;

const muteCooldown = new Map();

// ==================== NORMALIZATION ====================
function normalizeForMatch(input) {
  const map = {
    '0': 'o', '1': 'i', '2': 'z', '3': 'e', '4': 'a',
    '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g',
    '@': 'a', '$': 's', '!': 'i', '+': 't', '#': 'h'
  };

  let out = String(input)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .toLowerCase();

  let cleaned = '';
  for (const ch of out) {
    if (map[ch]) cleaned += map[ch];
    else if (ch >= 'a' && ch <= 'z') cleaned += ch;
    else if (/\s/.test(ch)) cleaned += ' ';
    else cleaned += ' ';
  }

  cleaned = cleaned
    .replace(/([a-z])\1{2,}/g, '$1$1')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned;
}

// ==================== FAST CUCKOO FILTER ====================
class CuckooFilter {
  constructor(capacity = 4096, bucketSize = 4, fingerprintBits = 16, maxKicks = 500) {
    this.bucketSize = bucketSize;
    this.maxKicks = maxKicks;
    this.fingerprintMask = (1 << fingerprintBits) - 1;

    this.numBuckets = 1;
    const desiredBuckets = Math.ceil(capacity / bucketSize);
    while (this.numBuckets < desiredBuckets) this.numBuckets <<= 1;

    this.mask = this.numBuckets - 1;
    this.buckets = Array.from({ length: this.numBuckets }, () => []);
  }

  static fnv1a32(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }

  _hash(str) {
    return CuckooFilter.fnv1a32(str);
  }

  _fingerprint(str) {
    let fp = this._hash(str) & this.fingerprintMask;
    if (fp === 0) fp = 1;
    return fp >>> 0;
  }

  _altIndex(index, fingerprint) {
    return (index ^ CuckooFilter.fnv1a32(String(fingerprint))) & this.mask;
  }

  insert(item) {
    const h = this._hash(item);
    const fp = this._fingerprint(item);
    const i1 = h & this.mask;
    const i2 = this._altIndex(i1, fp);

    if (this.buckets[i1].length < this.bucketSize) {
      this.buckets[i1].push(fp);
      return true;
    }

    if (this.buckets[i2].length < this.bucketSize) {
      this.buckets[i2].push(fp);
      return true;
    }

    let index = Math.random() < 0.5 ? i1 : i2;
    let curFp = fp;

    for (let n = 0; n < this.maxKicks; n++) {
      const bucket = this.buckets[index];
      const slot = Math.floor(Math.random() * this.bucketSize);

      if (bucket.length < this.bucketSize) {
        bucket.push(curFp);
        return true;
      }

      const evicted = bucket[slot];
      bucket[slot] = curFp;
      curFp = evicted;

      index = this._altIndex(index, curFp);

      if (this.buckets[index].length < this.bucketSize) {
        this.buckets[index].push(curFp);
        return true;
      }
    }

    return false;
  }

  contains(item) {
    const h = this._hash(item);
    const fp = this._fingerprint(item);
    const i1 = h & this.mask;
    const i2 = this._altIndex(i1, fp);

    return this.buckets[i1].includes(fp) || this.buckets[i2].includes(fp);
  }
}

function buildFilter(rawTerms) {
  const normalizedTerms = [];
  let maxWords = 1;

  for (const raw of rawTerms) {
    const term = normalizeForMatch(raw);
    if (!term) continue;
    normalizedTerms.push(term);
    const wordCount = term.split(' ').length;
    if (wordCount > maxWords) maxWords = wordCount;
  }

  const filter = new CuckooFilter(Math.max(4096, normalizedTerms.length * 16));

  for (const term of normalizedTerms) {
    filter.insert(term);

    const compact = term.replace(/\s+/g, '');
    if (compact !== term) filter.insert(compact);
  }

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
function collectCandidates(normalizedText, maxWindow) {
  const tokens = normalizedText ? normalizedText.split(' ').filter(Boolean) : [];
  const candidates = new Set();

  for (const token of tokens) {
    candidates.add(token);
  }

  for (let size = 2; size <= maxWindow; size++) {
    for (let i = 0; i + size <= tokens.length; i++) {
      candidates.add(tokens.slice(i, i + size).join(' '));
    }
  }

  const compact = tokens.join('');
  if (compact) candidates.add(compact);

  return [...candidates];
}

function classifyModeration(text) {
  const normalized = normalizeForMatch(text);
  if (!normalized) return { hardHits: [], softHits: [] };

  const candidates = collectCandidates(
    normalized,
    Math.max(HARD_INDEX.maxWords, SOFT_INDEX.maxWords)
  );

  const hardHits = [];
  const softHits = [];

  for (const candidate of candidates) {
    if (HARD_INDEX.filter.contains(candidate)) {
      hardHits.push(candidate);
      continue;
    }

    if (SOFT_INDEX.filter.contains(candidate)) {
      softHits.push(candidate);
    }
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

// ==================== BOT ====================
async function createBot() {
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
  });

  bot.on('message', (msg) => {
    const rawText = msg.toString();
    const text = stripColorCodes(rawText);
    log('CHAT:', text);

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

    const match = text.match(/^([^:]+?):\s(.+)$/);
    if (!match) return;

    const sender = match[1].trim();
    const message = match[2].trim();

    if (sender === CONFIG.server.username) return;

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

  bot.on('error', e => err(e.message));
  bot.on('kicked', r => err('Kicked:', r));
  bot.on('end', () => {
    log('Reconnect in 10s...');
    setTimeout(createBot, 10000);
  });
}

// ==================== CONSOLE ====================
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.on('line', line => {
  if (bot) bot.chat(line);
});

// ==================== START ====================
createBot();
