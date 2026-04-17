const mineflayer = require('mineflayer');
const readline = require('readline');
const dns = require('dns').promises;
const net = require('net');
const { Groq } = require('groq-sdk');

// ==================== DEBUG ====================
const DEBUG = true;
const log = (...a) => console.log('[Polaris]', ...a);
const dbg = (...a) => DEBUG && console.log('[DEBUG]', ...a);
const err = (...a) => console.log('[ERROR]', ...a);

// ==================== CONFIG ====================
const CONFIG = {
  engine: 'Polaris v4.3',

  server: {
    host: 'play.pcsmp.net',
    port: 25565,
    username: 'Habibi',
    version: '1.12.2',
    password: '551417114',
    targetServer: 'lifesteal'      // auto-join after login
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

  bannedWords: [
    'fuck','shit','cunt','nigger','faggot','asshole','bitch','dick','pussy',
    'whore','slut','bastard','retard','kys','kill yourself','nazi','hitler'
  ]
};

// ==================== GLOBAL ====================
let bot;
let isReady = false;
let isLoggedIn = false;
let loginSent = false;
let autoSwitchDone = false;

const chatGroq = new Groq({ apiKey: CONFIG.groq.chatApiKey });

// Cooldown map to prevent repeated mutes (30 seconds)
const muteCooldown = new Map();

// ==================== UTIL: STRIP COLOUR CODES ====================
function stripColorCodes(str) {
  return str.replace(/§[0-9a-fk-or]/g, '');
}

// ==================== 7‑LAYER PROFANITY FILTER ====================
// ------------------------------------------------------------------
// 1. Unicode Scrub – NFKD + remove zero‑width spaces and diacritics
function unicodeScrub(str) {
  // Normalise to decomposed form, then remove combining diacritical marks
  let normalized = str.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  // Remove zero‑width spaces and other invisible characters
  normalized = normalized.replace(/[\u200B-\u200D\uFEFF]/g, '');
  return normalized;
}

// 2. Leet‑Swap – comprehensive symbol → letter map
const leetMap = new Map([
  ['0','o'], ['1','i'], ['2','z'], ['3','e'], ['4','a'], ['5','s'], ['6','g'],
  ['7','t'], ['8','b'], ['9','g'], ['@','a'], ['$','s'], ['!','i'], ['+','t'],
  ['#','h'], ['(','c'], ['µ','u'], ['ß','b'], ['€','e'], ['¥','y']
]);

function leetSwap(str) {
  return str.toLowerCase().split('').map(c => leetMap.get(c) || c).join('');
}

// 3. De‑Spacing – remove all non‑alphabetic characters
function despacing(str) {
  return str.replace(/[^a-z]/g, '');
}

// 4. Squeeze – collapse any letter repeated more than twice to exactly two
function squeeze(str) {
  return str.replace(/([a-z])\1{2,}/g, '$1$1');
}

// 5. Entropy Check – detect keyboard smashing and extract the likely core word
function entropyPrune(str) {
  // Look for repeated bigrams (e.g., "ckckck" -> "ck")
  const bigramRepeated = /(.{2})\1{2,}/g;
  let cleaned = str.replace(bigramRepeated, '$1');
  // Remove any remaining alternating patterns like "fufufu"
  cleaned = cleaned.replace(/(.{2})\1{2,}/g, '$1');
  // If after pruning the string is very long (>10), trim to first 8 chars as a heuristic
  if (cleaned.length > 10) cleaned = cleaned.slice(0, 8);
  return cleaned;
}

// 6. Sound‑Match – Double Metaphone (simplified but effective)
function doubleMetaphone(word) {
  // Pre‑process: convert to lowercase and remove any remaining non‑alpha
  word = word.toLowerCase().replace(/[^a-z]/g, '');
  if (word.length === 0) return '';

  // Basic Double Metaphone rules (sufficient for most profanity)
  const rules = [
    [/^kn/, 'n'], [/^gn/, 'n'], [/^pn/, 'n'], [/^ae/, 'e'], [/^wr/, 'r'],
    [/^wh/, 'w'], [/^x/, 's'], [/^c(?=[iey])/, 's'], [/^c/, 'k'],
    [/^g(?=[iey])/, 'j'], [/^g/, 'k'], [/^d(?=[gj])/, 'j'], [/^ph/, 'f'],
    [/^qu/, 'k'], [/^s(?=[h])/, 's'], [/^t(?=[ia])/, 'x'], [/^v/, 'f'],
    [/^w(?=[aeiou])/, 'w'], [/^y/, 'j'], [/^z/, 's'],
    // Internal rules (simplified)
    [/sch/g, 'sk'], [/tch/g, 'ch'], [/ck/g, 'k'], [/gh$/, 'f'],
    [/ght/g, 't'], [/dg/g, 'j'], [/ph/g, 'f'], [/sh/g, 'x'],
    [/th/g, '0'], [/ch/g, 'x'], [/c(?=[iey])/g, 's'], [/c/g, 'k'],
    [/g(?=[iey])/g, 'j'], [/g/g, 'k'], [/s(?=[h])/g, 's'],
    [/t(?=[ia])/g, 'x'], [/d(?=[gj])/g, 'j'], [/ng/g, 'nk'],
    [/y/g, 'j'], [/z/g, 's'], [/v/g, 'f'], [/w/g, 'w'],
    // Remove duplicates and vowels (except leading vowel)
    [/([b-df-hj-np-tv-xz])\1+/g, '$1'],
    [/[aeiou]/g, '']
  ];

  let result = word;
  for (const [pattern, replacement] of rules) {
    result = result.replace(pattern, replacement);
  }
  // Truncate to first 4 consonants for a stable code
  return result.slice(0, 4);
}

// 7. Statistical Arbiter – check against safe‑root database and boundary logic
// We'll maintain a small set of "safe roots" – common words that contain banned substrings.
const safeRoots = new Set([
  'pass', 'class', 'grass', 'assassin', 'bass', 'glass', 'mass', 'harass',
  'assist', 'associate', 'assume', 'assure', 'cassette', 'embarrass',
  'jackass', 'smartass', 'dumbass'  // these are still profane but context may differ
]);

// Master list of banned phonetic codes (pre‑computed for bannedWords)
const bannedPhonetics = new Set(
  CONFIG.bannedWords.map(w => {
    let processed = unicodeScrub(w);
    processed = leetSwap(processed);
    processed = despacing(processed);
    processed = squeeze(processed);
    processed = entropyPrune(processed);
    return doubleMetaphone(processed);
  })
);

function isProfane(text) {
  // Apply layers 1‑5
  let processed = unicodeScrub(text);
  processed = leetSwap(processed);
  processed = despacing(processed);
  processed = squeeze(processed);
  processed = entropyPrune(processed);

  // If the processed string is empty, it's not profane
  if (processed.length === 0) return false;

  // Layer 6: get phonetic code
  const phonetic = doubleMetaphone(processed);
  if (!phonetic) return false;

  // Layer 7: Statistical Arbiter – check safe roots
  // If the phonetic code matches a banned word, but the original text
  // contains a safe root as a substring (and the banned word is a substring
  // of that safe root), then override.
  if (bannedPhonetics.has(phonetic)) {
    // Check safe roots in the original (lowercase, no leet)
    const lowerOriginal = text.toLowerCase();
    for (const safe of safeRoots) {
      if (lowerOriginal.includes(safe)) {
        // Ensure the banned substring is wholly inside the safe root
        for (const banned of CONFIG.bannedWords) {
          if (safe.includes(banned)) {
            return false;   // safe override
          }
        }
      }
    }
    return true;
  }
  return false;
}

// Legacy function renamed for compatibility
const containsProfanity = isProfane;

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
function testPort(host,port){
  return new Promise(res=>{
    const s = new net.Socket();
    s.setTimeout(3000);
    s.on('connect',()=>{s.destroy();res(true)});
    s.on('error',()=>res(false));
    s.on('timeout',()=>res(false));
    s.connect(port,host);
  });
}

async function findPort(host,base){
  if(!CONFIG.debug.probePorts) return base;
  for(let p of [base,...CONFIG.debug.ports]){
    dbg(`Testing ${host}:${p}`);
    if(await testPort(host,p)){
      log(`OPEN PORT → ${p}`);
      return p;
    }
  }
  return base;
}

// ==================== CHAT AI ====================
async function chatReply(sender,msg){
  try{
    const res = await chatGroq.chat.completions.create({
      messages:[
        {role:'system',content:'casual minecraft admin, short replies'},
        {role:'user',content:`${sender}: ${msg}`}
      ],
      model: CONFIG.groq.chatModel,
      max_tokens: 60
    });
    let reply = res.choices[0]?.message?.content?.trim();
    if(!reply || reply.includes('[IGNORE]')) return;
    bot.chat(reply);
  }catch(e){ err('Chat API:',e.message); }
}

// ==================== SAY ====================
function say(text){
  if(!bot) return;
  if(text.length <= CONFIG.chat.max_length){
    bot.chat(text);
    return;
  }
  let remaining = text;
  let delay = 0;
  while(remaining.length){
    let chunk = remaining.slice(0,CONFIG.chat.max_length);
    const lastSpace = chunk.lastIndexOf(' ');
    if(lastSpace > 100) chunk = chunk.slice(0,lastSpace);
    setTimeout(()=>bot.chat(chunk),delay);
    delay += 400;
    remaining = remaining.slice(chunk.length).trim();
  }
}

// ==================== BOT ====================
async function createBot(){
  loginSent = false;
  isReady = false;
  isLoggedIn = false;
  autoSwitchDone = false;

  log('Resolving...');
  const resolved = await resolveServer();
  const port = await findPort(resolved.host,resolved.port);

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

    // --- Automatic login ---
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

    // --- Parse player chat ---
    const match = text.match(/^([^:]+?):\s(.+)$/);
    if (!match) return;
    const sender = match[1].trim();
    const message = match[2].trim();
    if (sender === CONFIG.server.username) return;

    // ===== 7‑LAYER PROFANITY DETECTION =====
    if (containsProfanity(message)) {
      log(`PROFANITY → ${sender}: ${message}`);
      const now = Date.now();
      const last = muteCooldown.get(sender) || 0;
      if (now - last < 30000) {
        log(`Mute cooldown active for ${sender}, skipping.`);
        return;
      }
      muteCooldown.set(sender, now);
      say(`/tempmute ${sender} 10m Automod: Profanity detected`);
      return;
    }

    // ===== CHAT RESPONSE (AI) =====
    if (message.toLowerCase().includes(CONFIG.server.username.toLowerCase())) {
      chatReply(sender, message);
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
