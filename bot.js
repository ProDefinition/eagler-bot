const mineflayer = require('mineflayer');
const readline = require('readline');
const { Groq } = require('groq-sdk');
const admin = require('firebase-admin');

// ==================== FIREBASE INIT ====================
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://polaris-358ae-default-rtdb.firebaseio.com',
});

const db = admin.database();
const firestore = admin.firestore();

// ==================== CONFIGURATION ====================
const CONFIG = {
  engine: 'Polaris v2.0',
  server: {
    host: 'play.pcsmp.net',
    port: 25565,
    username: 'Habibi',
    version: '1.12.2',
  },
  chat: { max_length: 250 },
  groq: {
    chatApiKey: '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',
    chatModel: 'llama-3.1-8b-instant',
  },
  filter: { warnOnFirstOffense: true, muteDuration: '10m' },
};

// ==================== RTDB REFERENCES ====================
const statusRef = db.ref('/status');
const commandsRef = db.ref('/commands');
const logsRef = db.ref('/logs');
const chatIncomingRef = db.ref('/chat/incoming');

// ==================== CONTENT FILTER (FIRESTORE) ====================
const charMap = new Map([
  ['0','o'],['1','i'],['2','z'],['3','e'],['4','a'],['5','s'],['6','g'],['7','t'],['8','b'],['9','g'],
  ['@','a'],['$','s'],['!','i'],['|','i'],['+','t'],['(','c'],[')','c'],['€','e'],['£','l'],['¥','y'],
  ['%','o'],['#','h'],['&','a'],['*','x'],['?','i'],
  ['а','a'],['б','b'],['в','b'],['г','r'],['д','d'],['е','e'],['ё','e'],['ж','j'],['з','z'],['и','i'],
  ['й','y'],['к','k'],['л','l'],['м','m'],['н','n'],['о','o'],['п','p'],['р','p'],['с','c'],['т','t'],
  ['у','y'],['ф','f'],['х','x'],['ц','c'],['ч','ch'],['ш','sh'],['щ','sh'],['ъ','b'],['ы','y'],['ь','b'],
  ['э','e'],['ю','yu'],['я','ya'],
  ['α','a'],['β','b'],['γ','g'],['δ','d'],['ε','e'],['ζ','z'],['η','n'],['θ','o'],['ι','i'],['κ','k'],
  ['λ','l'],['μ','m'],['ν','v'],['ξ','x'],['ο','o'],['π','p'],['ρ','p'],['σ','s'],['τ','t'],['υ','y'],
  ['φ','f'],['χ','x'],['ψ','ps'],['ω','o'],
  ['ⅼ','l'],['ⅰ','i'],['ⅴ','v'],['ⅹ','x']
]);

function normalizeWord(v) {
  return String(v||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[\u200B-\u200D\uFEFF\u200C\u2028\u2029\u00A0\u1680\u180E\u2000-\u200F\u202F\u205F\u3000\u2060\u200B\u200C\u200D\u200E\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFFF9-\uFFFB\u034F\u180E]/g,'')
    .toLowerCase().split('').map(ch=>charMap.get(ch)??ch).join('').replace(/[^a-z0-9]/g,'');
}
function squeezeRuns(v){ return String(v||'').replace(/(.)\1+/g,'$1'); }
function isSubsequence(n,h){ if(!n||!h) return false; let i=0,j=0; while(i<n.length&&j<h.length){ if(n[i]===h[j])i++; j++; } return i===n.length; }
function levenshtein(a,b){
  a=String(a||''); b=String(b||''); if(a===b) return 0; if(!a.length) return b.length; if(!b.length) return a.length;
  if(a.length>b.length)[a,b]=[b,a]; const p=new Array(a.length+1); for(let i=0;i<=a.length;i++)p[i]=i;
  for(let j=1;j<=b.length;j++){ let d=p[0]; p[0]=j; for(let i=1;i<=a.length;i++){ const t=p[i]; p[i]=Math.min(p[i]+1,p[i-1]+1,d+(a[i-1]===b[j-1]?0:1)); d=t; } }
  return p[a.length];
}
function isObfuscated(raw,compact,squeezed){ return raw!==compact||compact!==squeezed||/[^a-zA-Z0-9]/.test(raw)||/(.)\1{2,}/.test(raw); }
function isMatch(rawChunk,targetNorm){
  const compact=normalizeWord(rawChunk); if(!compact||!targetNorm) return false;
  const squeezed=squeezeRuns(compact);
  if(compact===targetNorm||squeezed===targetNorm) return true;
  if(isObfuscated(rawChunk,compact,squeezed)&&(compact.includes(targetNorm)||squeezed.includes(targetNorm)||isSubsequence(targetNorm,squeezed))) return true;
  const len=targetNorm.length, maxDist=len<=3?0:len<=5?1:len<=8?2:3;
  return levenshtein(squeezed,targetNorm)<=maxDist;
}

const trainedWords = new Map();
firestore.collection('trainedWords').onSnapshot(snap=>{
  trainedWords.clear();
  snap.forEach(doc=>{ const d=doc.data(); const o=d.word||doc.id; const n=d.normalized||normalizeWord(o); if(n)trainedWords.set(n,o); });
  console.log(`[Polaris] Loaded ${trainedWords.size} trained words.`);
}, err=>console.error('Firestore error:',err.message));

function containsBannedWord(text){
  const hasSpaces=/\s/.test(text);
  let collapsed=hasSpaces?text.replace(/\s+/g,''):null;
  const tokens=text.split(/(\s+)/);
  for(const [norm,orig] of trainedWords){
    for(const t of tokens){ if(!/^\s+$/.test(t)&&isMatch(t,norm)) return {word:orig}; }
    if(collapsed&&isMatch(collapsed,norm)) return {word:orig,bypass:true};
  }
  return null;
}

// ==================== BOT STATE ====================
let bot=null, isInGame=false, isLoggedIn=false, isReady=false;
const chatHistory=[], MAX_HISTORY=15, warnedPlayers=new Set();
const chatGroq = new Groq({ apiKey: CONFIG.groq.chatApiKey });
const chatTimestamps=[], MAX_RPM=28;
const CHAT_SYSTEM_PROMPT = `You are 'Habibi', a Minecraft server administrator. Speak casually, lowercase occasionally. Keep responses under 140 characters. Ignore nonsense with "[IGNORE]". No emojis.`;

function logEvent(type,data){ logsRef.push({timestamp:admin.database.ServerValue.TIMESTAMP,type,...data}); }
function say(text){
  if(!bot||!text) return;
  text=text.replace(/[\n\r]/g,' ').trim();
  setTimeout(()=>{
    if(text.length<=CONFIG.chat.max_length){
      bot.chat(text);
      chatIncomingRef.push({sender:CONFIG.server.username,message:text,timestamp:admin.database.ServerValue.TIMESTAMP,type:'bot'});
      return;
    }
    let rem=text, delay=0;
    while(rem.length>0){
      let chunk=rem.slice(0,CONFIG.chat.max_length);
      const ls=chunk.lastIndexOf(' '); if(ls>CONFIG.chat.max_length/2) chunk=chunk.slice(0,ls);
      setTimeout(()=>{ bot.chat(chunk); chatIncomingRef.push({sender:CONFIG.server.username,message:chunk,timestamp:admin.database.ServerValue.TIMESTAMP,type:'bot'}); },delay);
      delay+=500; rem=rem.slice(chunk.length).trim();
    }
  },250);
}
async function enforceRateLimit(arr){
  const now=Date.now();
  while(arr.length&&now-arr[0]>60000) arr.shift();
  if(arr.length>=MAX_RPM){ await new Promise(r=>setTimeout(r,60000-(now-arr[0])+100)); return enforceRateLimit(arr); }
  arr.push(Date.now());
}
function handlePunishment(target,matchedWord,message){
  const reason=`Inappropriate language (${matchedWord})`;
  const quote=message.length>50?message.slice(0,47)+'...':message;
  if(warnedPlayers.has(target)){
    say(`/tempmute ${target} ${CONFIG.filter.muteDuration} Automod: ${reason} - "${quote}"`);
    logEvent('mute',{target,reason,quote});
  }else{
    warnedPlayers.add(target);
    say(`${target}, warning: ${reason}. Next offense is a mute.`);
    logEvent('warn',{target,reason,quote});
  }
}
function processChatMessage(sender,message){
  const banned=containsBannedWord(message);
  if(banned) handlePunishment(sender,banned.word,message);
  chatIncomingRef.push({sender,message,timestamp:admin.database.ServerValue.TIMESTAMP,type:'player',flagged:!!banned});
  if(message.toLowerCase().includes(CONFIG.server.username.toLowerCase())) handleChatResponse(sender,message);
  chatHistory.push({time:new Date().toLocaleTimeString(),sender,message});
  if(chatHistory.length>MAX_HISTORY) chatHistory.shift();
}
async function handleChatResponse(sender,message){
  try{
    await enforceRateLimit(chatTimestamps);
    const res=await chatGroq.chat.completions.create({
      messages:[{role:'system',content:CHAT_SYSTEM_PROMPT},{role:'user',content:`${sender}: ${message}`}],
      model:CONFIG.groq.chatModel, temperature:0.9, max_tokens:60
    });
    let reply=res.choices[0]?.message?.content?.trim();
    if(!reply||reply.includes('[IGNORE]')||reply==='...') return;
    if(Math.random()>0.5) reply=reply.toLowerCase().replace(/[.!?]$/,'');
    say(reply);
  }catch(e){ console.error('Chat API error:',e.message); }
}

// ==================== COMMAND LISTENER ====================
commandsRef.on('child_added', async snap=>{
  const cmd=snap.val(), key=snap.key;
  if(!cmd||cmd.processed) return;
  await commandsRef.child(key).update({processed:true});
  console.log('[CMD]',cmd);
  try{
    switch(cmd.type){
      case'say': if(cmd.message) say(cmd.message); break;
      case'execute': if(cmd.command) bot.chat(cmd.command); break;
      case'kick': if(cmd.player) say(`/kick ${cmd.player} ${cmd.reason||'Staff action'}`); break;
      case'mute': if(cmd.player) say(`/tempmute ${cmd.player} ${cmd.duration||'10m'} ${cmd.reason||'Staff action'}`); break;
    }
  }catch(e){}
  setTimeout(()=>commandsRef.child(key).remove(),1000);
});

// ==================== BOT CREATION ====================
function createBot(){
  console.log('[Polaris] Connecting...');
  bot=mineflayer.createBot({host:CONFIG.server.host,port:CONFIG.server.port,username:CONFIG.server.username,version:CONFIG.server.version});
  bot.once('spawn',async()=>{
    isInGame=true; await new Promise(r=>setTimeout(r,2000));
    if(!isLoggedIn){ let a=0; while(!isLoggedIn&&a<15){ await new Promise(r=>setTimeout(r,1000)); a++; } }
    bot.setControlState('jump',true); await new Promise(r=>setTimeout(r,300)); bot.setControlState('jump',false);
    await new Promise(r=>setTimeout(r,3000)); isReady=true;
    setInterval(()=>{ if(!bot.entity||!isInGame) return; if(Math.random()<0.1){ bot.setControlState('jump',true); setTimeout(()=>bot.setControlState('jump',false),300); } },8000);
    setInterval(()=>{ if(!bot||!isReady) return; const players=Object.values(bot.players).map(p=>p.username); statusRef.set({online:true,server:CONFIG.server.host,username:CONFIG.server.username,players,playerCount:players.length,health:bot.health,food:bot.food,lastUpdate:admin.database.ServerValue.TIMESTAMP}); },5000);
  });
  bot.on('end',()=>{ console.log('[Polaris] Disconnected. Reconnecting in 15s...'); isInGame=isLoggedIn=isReady=false; statusRef.update({online:false}); setTimeout(createBot,15000); });
  bot.on('error',e=>console.log('[Error]',e.message));
  bot.on('kicked',r=>console.log('[Kicked]',r));
  bot.on('message',async json=>{
    const text=json.toString().trim(); if(!text||text.length>500) return;
    const lower=text.toLowerCase();
    if(!isLoggedIn&&lower.includes('/login')){ say('/login 551417114'); return; }
    if(lower.includes('successfully logged')) isLoggedIn=true;
    if(lower.includes('[+] habibi')||(lower.includes('joined the game')&&lower.includes('habibi'))) isInGame=true;
    if(lower.includes('limbo')||lower.includes('queue')) isInGame=false;
    if(!isReady) return;
    if(lower.includes('teleport to you')){ setTimeout(()=>bot.chat('/tpaccept'),1000); return; }
    if(/^\[(Server|INFO|WARN|ERROR|System)\]/i.test(text)||/^\*{3}/.test(text)||/^\[[+\-]\]/.test(text)||/(joined|left) the game/i.test(text)||/(time|seconds|queue|position|limbo|lifesteal|full|estimated)/i.test(text)||/(tempmuted|unmuted|muted|banned|kicked|warned)/i.test(text)||/^Habibi/i.test(text)||/\[Spartan Notification\]/i.test(text)||/Welcome back!/i.test(text)) return;
    let sender=null, message=null;
    const clean=text.replace(/^(?:\[[^\]]+\]\s*)*(?:MOD|HELPER|SRHELPER|OWNER|ADMIN|COOWNER|BUILDER|VIP|MVP|YOUTUBE|DEFAULT)\s+/i,'').trim();
    const mv=clean.match(/^<~?([a-zA-Z0-9_]{3,16})>\s*(.+)/);
    const mp=clean.match(/^~?([a-zA-Z0-9_]{3,16})\s*[:»\->]\s*(.+)/);
    if(mv){ sender=mv[1]; message=mv[2]; }
    else if(mp){ sender=mp[1]; message=mp[2]; }
    else if(text.includes(':')){
      const parts=text.split(':');
      const before=parts[0].replace(/^\[.*?\]\s*/,'').trim();
      const words=before.split(/\s+/);
      const possible=words[words.length-1];
      if(possible&&possible.length>=3&&possible.length<=16&&/^[a-zA-Z0-9_]+$/.test(possible)){ sender=possible; message=parts.slice(1).join(':').trim(); }
    }
    if(!sender||!message||sender===CONFIG.server.username||sender==='detected') return;
    console.log(`[LIVE] ${sender}: ${message}`);
    processChatMessage(sender,message);
  });
  bot.on('health',()=>{ if(!isReady||bot.food>=14) return; const food=bot.inventory.items().find(i=>i.name.includes('apple')||i.name.includes('bread')||i.name.includes('carrot')||i.name.includes('beef')); if(food){ bot.equip(food,'hand'); bot.activateItem(); } });
  bot.on('windowOpen',async()=>{ await new Promise(r=>setTimeout(r,500)); if(bot.currentWindow) bot.clickWindow(1,0,0); });
}

function shutdown(){ console.log('\n[Polaris] Shutting down...'); statusRef.update({online:false}); if(bot) bot.quit(); setTimeout(()=>process.exit(0),500); }
process.on('SIGINT',shutdown); process.on('SIGTERM',shutdown);

const rl=readline.createInterface({input:process.stdin,output:process.stdout,prompt:'Console> '});
rl.prompt();
rl.on('line',line=>{ const m=line.trim(); if(m.startsWith('/')){ if(bot) bot.chat(m); }else if(m){ say(m); } rl.prompt(); });
rl.on('close',shutdown);

(async()=>{
  try{ await chatGroq.models.list(); console.log('[Polaris] Chat API key valid.'); }catch(e){ console.error('Chat API key failed:',e.message); process.exit(1); }
  createBot();
})();
