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
  engine: 'Polaris v4.2',

  server: {
    host: 'play.pcsmp.net',
    port: 25565,
    username: 'Habibi',
    version: '1.12.2',
    password: '551417114'
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
let loginSent = false;               // prevent multiple login attempts

const chatGroq = new Groq({ apiKey: CONFIG.groq.chatApiKey });

// ==================== UTIL: STRIP MINECRAFT COLOUR CODES ====================
function stripColorCodes(str) {
  return str.replace(/§[0-9a-fk-or]/g, '');
}

// ==================== ADVANCED FILTER ====================
const charMap = new Map([
  ["0","o"],["1","i"],["3","e"],["4","a"],["5","s"],["@","a"],["$","s"],["!","i"]
]);

function normalize(str){
  return str.toLowerCase().split('').map(c=>charMap.get(c)||c).join('').replace(/[^a-z0-9]/g,'');
}

function squeeze(str){
  return str.replace(/(.)\1+/g,'$1');
}

function levenshtein(a,b){
  const m = [];
  for(let i=0;i<=b.length;i++){ m[i]=[i]; }
  for(let j=0;j<=a.length;j++){ m[0][j]=j; }
  for(let i=1;i<=b.length;i++){
    for(let j=1;j<=a.length;j++){
      m[i][j] = b[i-1]==a[j-1] ? m[i-1][j-1] :
        Math.min(m[i-1][j-1]+1, m[i][j-1]+1, m[i-1][j]+1);
    }
  }
  return m[b.length][a.length];
}

function isMatch(word, target){
  const n = normalize(word);
  const s = squeeze(n);
  if(n === target || s === target) return true;

  if(s.includes(target)) return true;

  return levenshtein(s,target) <= 2;
}

const trained = CONFIG.bannedWords.map(w=>normalize(w));

function containsProfanity(text){
  const parts = text.split(/\s+/);
  for(let p of parts){
    for(let t of trained){
      if(isMatch(p,t)) return true;
    }
  }
  return false;
}

// ==================== SRV ====================
async function resolveServer() {
  try {
    const srv = await dns.resolveSrv(`_minecraft._tcp.${CONFIG.server.host}`);
    if (srv.length) {
      const r = srv[0];

      log(`SRV FOUND → port ${r.port}`);
      dbg(`SRV target (ignored): ${r.name}`);

      // IMPORTANT: use ORIGINAL HOST, NOT SRV HOST
      return {
        host: CONFIG.server.host,
        port: r.port
      };
    }
  } catch (e) {
    dbg('SRV failed:', e.code);
  }

  const ip = await dns.lookup(CONFIG.server.host);
  log(`A → ${ip.address}`);

  return {
    host: CONFIG.server.host,
    port: CONFIG.server.port
  };
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

// ==================== CHAT AI (ONLY CHAT) ====================
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
    // Login will be triggered by the server prompt, not a fixed timer.
  });

  bot.on('message', (msg) => {
    const rawText = msg.toString();
    const text = stripColorCodes(rawText);   // remove colour codes for reliable parsing
    log('CHAT:', text);

    // --- Automatic login when server asks for password ---
    if (!isLoggedIn && !loginSent) {
      if (text.includes('Use the command /login') || text.includes('/login <password>')) {
        log('Login prompt detected – sending password...');
        bot.chat(`/login ${CONFIG.server.password}`);
        loginSent = true;
        return;
      }
      // Already logged in message – prevent future attempts
      if (text.includes('You have successfully logged') || text.includes('You are already logged in')) {
        isLoggedIn = true;
        loginSent = true;
        return;
      }
    }

    // --- Parse actual player chat ---
    // Format expected: "Sender: message"  (no angle brackets, may include rank like "MOD Chew")
    const match = text.match(/^([^:]+?):\s(.+)$/);
    if (!match) return;

    const sender = match[1].trim();
    const message = match[2].trim();

    // Ignore own messages
    if (sender === CONFIG.server.username) return;

    // ===== PROFANITY MODERATION =====
    if (containsProfanity(message)) {
      log(`PROFANITY → ${sender}: ${message}`);
      // Use /tempmute (adjust command if your server uses /mute)
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
