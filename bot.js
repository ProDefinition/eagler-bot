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
  engine: 'Polaris v4.5',

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

const chatGroq = new Groq({ apiKey: CONFIG.groq.chatApiKey });
const muteCooldown = new Map();

// ==================== UTIL: STRIP COLOUR CODES ====================
function stripColorCodes(str) {
  return str.replace(/§[0-9a-fk-or]/g, '');
}

// ==================== LEVENSHTEIN DISTANCE ====================
function levenshtein(a, b) {
  const m = [];
  for (let i = 0; i <= b.length; i++) m[i] = [i];
  for (let j = 0; j <= a.length; j++) m[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      m[i][j] = b[i - 1] === a[j - 1]
        ? m[i - 1][j - 1]
        : Math.min(m[i - 1][j - 1] + 1, m[i][j - 1] + 1, m[i - 1][j] + 1);
    }
  }
  return m[b.length][a.length];
}

// ==================== 7‑LAYER PROFANITY FILTER ====================
// 1. Unicode Scrub
function unicodeScrub(str) {
  let normalized = str.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  normalized = normalized.replace(/[\u200B-\u200D\uFEFF]/g, '');
  return normalized;
}

// 2. Leet‑Swap
const leetMap = new Map([
  ['0','o'], ['1','i'], ['2','z'], ['3','e'], ['4','a'], ['5','s'], ['6','g'],
  ['7','t'], ['8','b'], ['9','g'], ['@','a'], ['$','s'], ['!','i'], ['+','t'],
  ['#','h'], ['(','c'], ['µ','u'], ['ß','b'], ['€','e'], ['¥','y']
]);

function leetSwap(str) {
  return str.toLowerCase().split('').map(c => leetMap.get(c) || c).join('');
}

// 3. De‑Spacing
function despacing(str) {
  return str.replace(/[^a-z]/g, '');
}

// 4. Squeeze
function squeeze(str) {
  return str.replace(/([a-z])\1{2,}/g, '$1$1');
}

// 5. Entropy Prune
function entropyPrune(str) {
  const bigramRepeated = /(.{2})\1{2,}/g;
  let cleaned = str.replace(bigramRepeated, '$1');
  cleaned = cleaned.replace(/(.{2})\1{2,}/g, '$1');
  if (cleaned.length > 10) cleaned = cleaned.slice(0, 8);
  return cleaned;
}

// 6. Sound‑Match (Double Metaphone – simplified)
function doubleMetaphone(word) {
  word = word.toLowerCase().replace(/[^a-z]/g, '');
  if (word.length === 0) return '';

  const rules = [
    [/^kn/, 'n'], [/^gn/, 'n'], [/^pn/, 'n'], [/^ae/, 'e'], [/^wr/, 'r'],
    [/^wh/, 'w'], [/^x/, 's'], [/^c(?=[iey])/, 's'], [/^c/, 'k'],
    [/^g(?=[iey])/, 'j'], [/^g/, 'k'], [/^d(?=[gj])/, 'j'], [/^ph/, 'f'],
    [/^qu/, 'k'], [/^s(?=[h])/, 's'], [/^t(?=[ia])/, 'x'], [/^v/, 'f'],
    [/^w(?=[aeiou])/, 'w'], [/^y/, 'j'], [/^z/, 's'],
    [/sch/g, 'sk'], [/tch/g, 'ch'], [/ck/g, 'k'], [/gh$/, 'f'],
    [/ght/g, 't'], [/dg/g, 'j'], [/ph/g, 'f'], [/sh/g, 'x'],
    [/th/g, '0'], [/ch/g, 'x'], [/c(?=[iey])/g, 's'], [/c/g, 'k'],
    [/g(?=[iey])/g, 'j'], [/g/g, 'k'], [/s(?=[h])/g, 's'],
    [/t(?=[ia])/g, 'x'], [/d(?=[gj])/g, 'j'], [/ng/g, 'nk'],
    [/y/g, 'j'], [/z/g, 's'], [/v/g, 'f'], [/w/g, 'w'],
    [/([b-df-hj-np-tv-xz])\1+/g, '$1'],
    [/[aeiou]/g, '']
  ];

  let result = word;
  for (const [pattern, replacement] of rules) {
    result = result.replace(pattern, replacement);
  }
  return result.slice(0, 4);
}

// Pre‑compute phonetic codes for banned words
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

// Normalized banned words (for exact matching)
const normalizedBanned = CONFIG.bannedWords.map(w => {
  let n = unicodeScrub(w);
  n = leetSwap(n);
  n = despacing(n);
  return n;
});

// 7. Statistical Arbiter – algorithmic, NO SAFE LIST
// 7. Statistical Arbiter – algorithmic, NO SAFE LIST
function isProfane(text) {
  // Layers 1-5: clean the text
  let processed = unicodeScrub(text);
  processed = leetSwap(processed);
  processed = despacing(processed);
  processed = squeeze(processed);
  processed = entropyPrune(processed);

  if (processed.length === 0) return false;

  // Direct substring match against every banned word (normalized)
  for (const banned of CONFIG.bannedWords) {
    // Normalize banned word the same way
    let normBanned = unicodeScrub(banned);
    normBanned = leetSwap(normBanned);
    normBanned = despacing(normBanned);
    normBanned = squeeze(normBanned);
    normBanned = entropyPrune(normBanned);

    // If the processed text contains the normalized banned word, it's profane
    if (processed.includes(normBanned)) {
      return true;
    }
  }

  return false;
}
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

    if (containsProfanity(message)) {
      log(`PROFANITY → ${sender}: ${message}`);
      const now = Date.now();
      const last = muteCooldown.get(sender) || 0;
      if (now - last < 2000) {
        log(`Mute cooldown active for ${sender}, skipping.`);
        return;
      }
      muteCooldown.set(sender, now);
      say(`/tempmute ${sender} 10m Automod: Profanity detected`);
      return;
    }

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
