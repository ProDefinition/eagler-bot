const mineflayer = require('mineflayer');
const Groq = require('groq-sdk');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { plugin: collectBlock } = require('mineflayer-collectblock');
const readline = require('readline');

// Suppress chunk spam
['log', 'warn', 'error'].forEach((method) => {
    const original = console[method];
    console[method] = function(...args) {
        if (args.length && typeof args[0] === 'string' && args[0].includes('Ignoring block entities as chunk failed to load')) {
            return;
        }
        original.apply(console, args);
    };
});

const CONFIG = {
  // Chat API Keys
  apiKeysChat: [
    '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' 
  ],
  // Moderation API Keys (Real-time)
  apiKeysMod: [
    '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',
    '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'
  ],
  // Background API Key (for queued messages, rate-limited investigations)
  apiKeyBackground: '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',
  
  models: {
    chat: ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'],
    moderation: ['openai/gpt-oss-20b'],
    investigation: ['llama-3.1-8b-instant']
  },
  server: {
    host: 'play.pcsmp.net',
    port: 25565,
    username: 'Habibi',
    version: '1.12.2',
  },
  moderation: {
    mute_duration: 5,                  
    moderators: ['ChewKok', 'eagly20', 'n2ab', 'Chew'], 
    investigation_threshold_kills: 4,  // Flag if player kills another 4+ times
    investigation_threshold_deaths: 5, // Flag if player dies 5+ times rapidly
  },
  chat: {
    cooldown: 1000,   
    max_length: 250,  
  },
  investigation: {
    enabled: true,
    interval: 30000,  // Run every 30 seconds
    chat_history_size: 50,
  },
  testMode: true,   
};

// ========================
// STATE & GROQ CLIENTS
// ========================
let bot = null;
let isInGame = false;
let isLoggedIn = false;
let lastChatTime = 0;
let isInvestigating = false;

const playerMemory = new Map();
const muteList = new Set();
const chatHistory = [];
const playerStats = new Map(); // Track kills/deaths
const messageQueue = []; // Queue for rate-limited messages

// Setup Groq clients
let currentChatKeyIndex = 0;
let currentModKeyIndex = 0;
let groqChat = new Groq({ apiKey: CONFIG.apiKeysChat[currentChatKeyIndex] });
let groqMod = new Groq({ apiKey: CONFIG.apiKeysMod[currentModKeyIndex] });
let groqBackground = new Groq({ apiKey: CONFIG.apiKeyBackground });

function switchApiKey(type) {
  if (type === 'chat') {
    currentChatKeyIndex = (currentChatKeyIndex + 1) % CONFIG.apiKeysChat.length;
    console.log(`[API] 🔄 Switching to Chat API Key #${currentChatKeyIndex + 1}...`);
    groqChat = new Groq({ apiKey: CONFIG.apiKeysChat[currentChatKeyIndex] });
  } else if (type === 'mod') {
    currentModKeyIndex = (currentModKeyIndex + 1) % CONFIG.apiKeysMod.length;
    console.log(`[API] 🔄 Switching to Mod API Key #${currentModKeyIndex + 1}...`);
    groqMod = new Groq({ apiKey: CONFIG.apiKeysMod[currentModKeyIndex] });
  }
}

// ========================
// API KEY TESTER
// ========================
async function testAllApiKeys() {
    console.log('\n[API] === Testing All API Keys ===');
    const allKeys = [
      ...CONFIG.apiKeysChat.map(k => ({ key: k, type: 'Chat' })),
      ...CONFIG.apiKeysMod.map(k => ({ key: k, type: 'Mod' })),
      { key: CONFIG.apiKeyBackground, type: 'Background' }
    ];
    
    for (let i = 0; i < allKeys.length; i++) {
        const { key, type } = allKeys[i];
        const testClient = new Groq({ apiKey: key });
        try {
            await testClient.chat.completions.create({
                model: 'llama-3.1-8b-instant',
                messages: [{ role: 'user', content: 'Say "test"' }],
                max_tokens: 5
            });
            console.log(`[API] ${type} Key #${i + 1} (${key.slice(0, 10)}...): ✅ VALID`);
        } catch (err) {
            console.log(`[API] ${type} Key #${i + 1} (${key.slice(0, 10)}...): ❌ FAILED - ${err.message}`);
        }
    }
    console.log('[API] ============================\n');
}

// ========================
// PLAYER STATS TRACKING
// ========================
function addPlayerInteraction(actor, victim, action) {
  // Track kills, deaths, etc.
  if (!playerStats.has(actor)) playerStats.set(actor, { kills: 0, deaths: 0, lastActions: [] });
  if (!playerStats.has(victim)) playerStats.set(victim, { kills: 0, deaths: 0, lastActions: [] });
  
  if (action === 'kill') {
    playerStats.get(actor).kills++;
    playerStats.get(victim).deaths++;
  }
  
  playerStats.get(actor).lastActions.push(`${action} ${victim} at ${new Date().toISOString()}`);
  if (playerStats.get(actor).lastActions.length > 20) playerStats.get(actor).lastActions.shift();
}

function getPlayerStats(player) {
  return playerStats.get(player) || { kills: 0, deaths: 0, lastActions: [] };
}

// ========================
// MESSAGE QUEUE SYSTEM
// ========================
async function queueMessage(message, sender, type = 'moderation') {
  messageQueue.push({
    timestamp: Date.now(),
    message,
    sender,
    type,
    processed: false
  });
  console.log(`[Queue] Message from ${sender} queued for background processing (Queue size: ${messageQueue.length})`);
}

async function processMessageQueue() {
  if (messageQueue.length === 0) return;
  
  const unprocessed = messageQueue.filter(m => !m.processed);
  if (unprocessed.length === 0) return;
  
  console.log(`[Queue] Processing ${unprocessed.length} queued message(s)...`);
  
  for (const item of unprocessed) {
    try {
      const aiCheck = await checkProfanityBackground(item.message);
      if (aiCheck.isProfane || aiCheck.isBad) {
        console.log(`[Background] Flagged queued message from ${item.sender}: ${item.message}`);
        if (!muteList.has(item.sender)) {
          mute(item.sender, `Delayed content violation - "${item.message.substring(0, 50)}..."`);
        }
      }
      item.processed = true;
    } catch (err) {
      console.error(`[Queue] Error processing message: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
}

// ========================
// UTILITIES
// ========================
function say(text) {
  if (!bot || !text) return;
  text = text.replace(/[\n\r]/g, ' ').trim();
  if (text.length <= CONFIG.chat.max_length) {
    console.log(`[Say] ${text}`);
    bot.chat(text);
    return;
  }
  // Split long messages
  let remaining = text;
  while (remaining.length > 0) {
    let chunk = remaining.slice(0, CONFIG.chat.max_length);
    const lastSpace = chunk.lastIndexOf(' ');
    if (lastSpace > CONFIG.chat.max_length / 2) chunk = chunk.slice(0, lastSpace);
    console.log(`[Say] ${chunk}`);
    bot.chat(chunk);
    remaining = remaining.slice(chunk.length).trim();
  }
}

function getOnlineUsernames() {
  if (!bot || !bot.players) return 'None';
  return Object.keys(bot.players).join(', ');
}

// ========================
// GROQ API CALLER
// ========================
async function callGroq(messages, maxTokens = 100, temperature = 0.7, modelList = CONFIG.models.chat, type = 'chat') {
  const apiKeys = type === 'mod' ? CONFIG.apiKeysMod : (type === 'background' ? [CONFIG.apiKeyBackground] : CONFIG.apiKeysChat);
  let keysTried = 0;
  
  while (keysTried < apiKeys.length) { 
    let currentClient = type === 'mod' ? groqMod : (type === 'background' ? groqBackground : groqChat);
    
    for (const model of modelList) {
      try {
        const response = await currentClient.chat.completions.create({
          model: model,
          messages: messages,
          max_tokens: maxTokens,
          temperature: temperature,
        });
        
        const content = response.choices[0]?.message?.content;
        if (content) return content; 
        
      } catch (err) {
        const errMsg = err.message.toLowerCase();
        
        // Check for rate limit errors
        if (errMsg.includes('rate') || errMsg.includes('429') || errMsg.includes('quota')) {
          console.log(`[API] Rate limit hit on ${type.toUpperCase()}, queuing for background processing...`);
          return null; // Signal to queue
        }
        
        console.error(`[API] Error (${model} on ${type.toUpperCase()} client): ${err.message}`);
        
        if (type === 'chat') {
          let cleanErr = err.message.replace(/[\n\r]/g, ' ').substring(0, 60);
          say(`[API Error] Model ${model} failed: ${cleanErr}...`);
        }
        
        continue; 
      }
    }
    
    console.log(`[API] ⚠️ All models failed on ${type.toUpperCase()} Key #${(type === 'mod' ? currentModKeyIndex : currentChatKeyIndex) + 1}. Rotating to next key...`);
    if (type === 'chat') say(`[API Warning] Rotating to next API key...`);
    
    if (type !== 'background') switchApiKey(type);
    keysTried++;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  console.error(`[API] ❌ All ${type.toUpperCase()} API keys failed or exhausted for this request.`);
  if (type === 'chat') say('[API Fatal] All keys exhausted or rate-limited.');
  return null; 
}

function addMemory(player, message) {
  if (!playerMemory.has(player)) playerMemory.set(player, []);
  const arr = playerMemory.get(player);
  arr.push(message);
  if (arr.length > 10) arr.shift();
}

function getMemory(player) {
  return (playerMemory.get(player) || []).join('\n');
}

function addChatHistory(sender, message) {
  chatHistory.push({
    timestamp: Date.now(),
    sender,
    message,
    type: 'chat'
  });
  if (chatHistory.length > CONFIG.investigation.chat_history_size) chatHistory.shift();
}

// ========================
// ENHANCED MODERATION
// ========================

async function checkProfanityBackground(message) {
  const onlinePlayers = getOnlineUsernames();
  
  const prompt = `You are an expert content moderation system. Analyze this Minecraft chat message for violations:
1. SEVERE PROFANITY: Slurs, hate speech, explicit content
2. HARMFUL BEHAVIOR: Encouraging harm, toxic manipulation, bullying
3. OFFENSIVE CONTENT: Racist, sexist, homophobic, ableist remarks
4. RULE VIOLATIONS: Hacking admissions, exploit discussion

Context - Online players: ${onlinePlayers}
Minecraft PvP terms ("kill", "destroy", "murder") and usernames are NOT violations.

Message: "${message}"

Respond ONLY in JSON format:
{
  "isProfane": boolean,
  "isBad": boolean,
  "severity": "none|low|medium|high|severe",
  "reason": "brief explanation"
}`;
  
  const result = await callGroq(
    [{ role: 'user', content: prompt }],
    50, 
    0.0,
    ['llama-3.1-8b-instant'],
    'background'
  );
  
  if (!result) return { isProfane: false, isBad: false, severity: 'none' };
  
  try {
    const cleanResult = result.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleanResult);
    console.log(`[Background Mod] ${parsed.reason} (Severity: ${parsed.severity})`);
    return parsed;
  } catch (err) {
    console.error(`[Background Mod] Parse error: ${err.message}`);
    return { isProfane: false, isBad: false, severity: 'none' };
  }
}

async function checkProfanity(message) {
  const onlinePlayers = getOnlineUsernames();
  
  const prompt = `You are an elite, highly accurate moderation filter for a Minecraft server. Evaluate for:
1. SEVERE profanity, slurs, hate speech, explicit content
2. Encouraging harm or toxic behavior
3. Offensive content toward groups or individuals
  
Context - Online players: ${onlinePlayers}
Minecraft PvP terms ("kill", "destroy") and valid usernames are NOT violations.
Mild frustration ("crap", "damn") is NOT a violation unless combined with other violations.

CRITICAL: Respond ONLY with "Yes" (violation) or "No" (clean). No other text.
Message: "${message}"`;

  const result = await callGroq(
    [{ role: 'user', content: prompt }],
    5, 
    0.0,
    CONFIG.models.moderation,
    'mod' 
  );
  
  if (!result) {
    // Rate limit hit, queue for background processing
    return { isProfane: null, rateLimit: true };
  }
  
  const cleanResult = result.trim().toLowerCase();
  const isProfane = cleanResult.includes('yes');
  
  console.log(`[Profanity] Raw AI response: "${result}" | Flagged: ${isProfane ? 'yes' : 'no'}`);
  return { isProfane, rateLimit: false };
}

function mute(player, reason = 'Rule violation') {
  const duration = CONFIG.moderation.mute_duration;
  let safeReason = reason.replace(/[:\n\r]/g, ' ').substring(0, 100);
  
  bot.chat(`/tempmute ${player} ${duration}m ${safeReason}`);
  
  muteList.add(player);
  console.log(`[MOD] Muted ${player} for ${duration}m. Reason: ${safeReason}`);
  
  if (CONFIG.testMode) {
    setTimeout(() => {
      bot.chat(`/unmute ${player}`);
      console.log(`[TEST] Unmuted ${player} (test mode)`);
    }, 500);
  } else {
    setTimeout(() => muteList.delete(player), duration * 60 * 1000);
  }
}

function kick(player, reason = 'Rule violation') {
  let safeReason = reason.replace(/[:\n\r]/g, ' ').substring(0, 100);
  bot.chat(`/kick ${player} ${safeReason}`);
  console.log(`[MOD] Kicked ${player}. Reason: ${safeReason}`);
}

async function checkViolation(sender, message) {
  // Hardcoded regex block
  const SEVERE_SLURS = [
    /\bn[i1@]+gg[ae3@]+r\b/i,
    /\bf[a@4]+gg[o0@]+t\b/i,
    /\bc[u\*@]+nt\b/i,
    /\b(kys|kill.{0,2}yourself)\b/i,
    /\bf[u\*@]+c[k\*@]+/i,          
    /\bb[i1\*@]+t[c\*@]+h/i,        
    /\bwh[o0\*@]+r[e3\*@]+/i,       
    /\bsh[i1\*@]+t\b/i              
  ];
  
  for (const pattern of SEVERE_SLURS) {
    if (pattern.test(message)) {
      console.log(`[MOD] Severe Hardcoded Violation: ${sender}`);
      mute(sender, `Profanity detected - "${message}"`);
      return true;
    }
  }
  
  // AI check
  const aiCheck = await checkProfanity(message);
  
  if (aiCheck.rateLimit) {
    console.log(`[MOD] Rate limit hit, queuing message for background review...`);
    await queueMessage(message, sender, 'moderation');
    return false; // Don't take action yet
  }
  
  if (aiCheck.isProfane) {
    console.log(`[MOD] AI flagged content: ${sender}`);
    mute(sender, `Profanity detected - "${message}"`);
    return true;
  }
  
  return false;
}

// ========================
// CHAT INVESTIGATION
// ========================
async function investigateChatPatterns() {
  if (!CONFIG.investigation.enabled || isInvestigating || chatHistory.length < 10) return;
  
  isInvestigating = true;
  console.log(`[Investigation] Starting chat pattern analysis...`);
  
  try {
    // Build context
    const recentChat = chatHistory.slice(-30).map(h => `${h.sender}: ${h.message}`).join('\n');
    const playerStatsContext = Array.from(playerStats.entries())
      .map(([player, stats]) => `${player}: ${stats.kills} kills, ${stats.deaths} deaths`)
      .join('\n');
    
    const investigationPrompt = `You are a Minecraft server moderation analyst. Review this chat and player stats for suspicious patterns:

CHAT HISTORY:
${recentChat}

PLAYER STATISTICS:
${playerStatsContext}

ANALYZE FOR:
1. Suspicious kill patterns (1 player repeatedly killing another without context/roleplay)
2. Harassment or bullying in chat
3. Scamming or deceptive behavior
4. Toxic behavior escalation
5. Suspicious account behavior

RESPOND IN JSON ONLY:
{
  "alerts": [
    {
      "type": "player_harassment|kill_pattern|toxic_behavior|other",
      "player": "name",
      "severity": "low|medium|high",
      "description": "brief description",
      "action": "none|mute|kick|investigate"
    }
  ]
}`;

    const result = await callGroq(
      [{ role: 'user', content: investigationPrompt }],
      200,
      0.3,
      CONFIG.models.investigation,
      'background'
    );
    
    if (!result) {
      console.log(`[Investigation] Rate limited, will retry later`);
      isInvestigating = false;
      return;
    }
    
    try {
      const cleanResult = result.replace(/```json|```/g, '').trim();
      const analysis = JSON.parse(cleanResult);
      
      for (const alert of (analysis.alerts || [])) {
        console.log(`[Investigation] 🚨 ${alert.type.toUpperCase()}: ${alert.player} - ${alert.description} (${alert.severity})`);
        
        if (alert.action === 'kick' && alert.severity === 'high') {
          console.log(`[Investigation] Taking action: Kicking ${alert.player}`);
          kick(alert.player, `Suspicious pattern detected: ${alert.description}`);
        } else if (alert.action === 'mute' && alert.severity === 'high') {
          if (!muteList.has(alert.player)) {
            console.log(`[Investigation] Taking action: Muting ${alert.player}`);
            mute(alert.player, `Suspicious pattern detected: ${alert.description}`);
          }
        }
      }
    } catch (err) {
      console.error(`[Investigation] Parse error: ${err.message}`);
    }
    
  } catch (err) {
    console.error(`[Investigation] Error: ${err.message}`);
  } finally {
    isInvestigating = false;
  }
}

// ========================
// AI RESPONSE
// ========================
async function getAIResponse(message, sender) {
  const memory = getMemory(sender);
  
  const system = `You are Habibi, a highly professional, articulate, and remarkably human presence on this Minecraft server. You are absolutely NOT a bot, an AI, or an automated script.
COMMUNICATION STYLE:
- NEVER WRITE PARAGRAPHS. You must keep your responses to EXACTLY 1 or 2 short sentences. MAXIMUM 15 WORDS TOTAL.
- Sound entirely human, warm, and natural. Use contractions (I'm, you're, that's) to maintain conversational flow.
- Maintain polished, flawless grammar and spelling. Be the most articulate person in the room.
- Completely avoid robotic customer service jargon. Never use mechanical phrases like "How may I assist you today?" or "Please be advised."
SPECIFIC SCENARIOS:
- If players act chaotic, toxic, or beg for things (like money/items): Respond with polite, calm boundaries or mild, professional amusement. (e.g., "I'm afraid I can't help with that," or "Let's keep things civil, please.")
- If someone accuses you of being an AI or a bot: Deflect with polite, natural humor. (e.g., "I'm just a very fast typer," or "I assure you, I'm a regular person.")
- If asked about complex math or coding: Politely decline in a human way. (e.g., "I'm here to play, not to do homework!")
STRICT RULES:
- Never output Minecraft commands (like /spawn).
- Never admit you are an AI or a language model. 
- If you notice the user's message contains severe profanity or slurs that might have been missed by the filter, start your response EXACTLY with "[ALERT]". Otherwise, reply normally.`;
    
  const response = await callGroq(
    [
      { role: 'system', content: system },
      { role: 'user', content: `${sender}: ${message}\n${memory}` }
    ],
    40, 
    0.7,
    CONFIG.models.chat,
    'chat' 
  );
  
  if (!response) return null;
  
  if (response.startsWith('[ALERT]')) {
    console.log(`[Alert] Conversational model flagged missed profanity from ${sender}`);
    const secondCheck = await checkProfanity(message);
    if (secondCheck.isProfane) {
      mute(sender, `Profanity detected - "${message}"`);
    } else if (!secondCheck.rateLimit) {
      mute(sender, `Missed profanity Alert - "${message}"`);
    }
    return response.replace('[ALERT]', '').trim();
  }
  
  return response;
}

// ========================
// COMMANDS
// ========================
function handleBangCommand(sender, msg) {
  const args = msg.slice(1).split(/\s+/);
  const cmd = args[0].toLowerCase();
  
  switch (cmd) {
    case 'inventory':
      const items = bot.inventory.items().map(i => `${i.name}: ${i.count}`).join(', ');
      say(`Inventory: ${items || 'empty'}`);
      break;
      
    case 'status':
      say(`Health: ${Math.round(bot.health)}/${bot.maxHealth}, Food: ${bot.food}/20`);
      break;
      
    case 'help':
      say('Commands: !inventory, !status, !joke, !roll, !fact, !testkeys, !stats <player>, !mute <player> [reason], !kick <player> [reason], !investigate');
      break;
      
    case 'joke':
      getAIResponse('Tell me a short, clean joke about Minecraft.', sender).then(r => r && say(r));
      break;
      
    case 'roll':
      const sides = parseInt(args[1]) || 6;
      const roll = Math.floor(Math.random() * sides) + 1;
      say(`🎲 Rolled: ${roll}/${sides}`);
      break;
      
    case 'fact':
      getAIResponse('Tell me an interesting Minecraft fact.', sender).then(r => r && say(r));
      break;
      
    case 'testkeys':
      if (sender !== 'Terminal' && !CONFIG.moderation.moderators.includes(sender)) { 
        say('Permission denied.'); 
        return; 
      }
      say('Testing API keys... Check terminal for results.');
      testAllApiKeys();
      break;
      
    case 'stats':
      const player = args[1];
      if (!player) { say('Usage: !stats <player>'); return; }
      const stats = getPlayerStats(player);
      say(`${player}: ${stats.kills} kills, ${stats.deaths} deaths`);
      break;
      
    case 'investigate':
      if (!CONFIG.moderation.moderators.includes(sender)) { 
        say('Permission denied.'); 
        return; 
      }
      say('Starting investigation...');
      investigateChatPatterns();
      break;
      
    case 'mute':
      if (!CONFIG.moderation.moderators.includes(sender)) { say('Permission denied.'); return; }
      const muteTarget = args[1];
      const muteReason = args.slice(2).join(' ') || 'Chat violation';
      if (muteTarget) mute(muteTarget, muteReason);
      break;
      
    case 'kick':
      if (!CONFIG.moderation.moderators.includes(sender)) { say('Permission denied.'); return; }
      const kickTarget = args[1];
      const kickReason = args.slice(2).join(' ') || 'Rule violation';
      if (kickTarget) kick(kickTarget, kickReason);
      break;
      
    default:
      say(`Unknown command: ${cmd}`);
  }
}

// ========================
// BOT CREATION
// ========================
function createBot() {
  console.log('[Bot] Connecting to server...');
  bot = mineflayer.createBot({
    host: CONFIG.server.host,
    port: CONFIG.server.port,
    username: CONFIG.server.username,
    version: CONFIG.server.version,
  });
  
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(collectBlock);
  
  bot.once('spawn', () => {
    console.log('[Bot] Spawned!');
    isInGame = true;
    const mcData = require('minecraft-data')(bot.version);
    bot.pathfinder.setMovements(new Movements(bot, mcData));
    
    // Start investigation interval
    if (CONFIG.investigation.enabled) {
      setInterval(investigateChatPatterns, CONFIG.investigation.interval);
    }
    
    // Start queue processor
    setInterval(processMessageQueue, 10000);
    
    // Periodic jumping
    setInterval(() => {
      if (!bot.entity || !isInGame) return;
      if (Math.random() < 0.1) {
        bot.setControlState('jump', true);
        setTimeout(() => bot.setControlState('jump', false), 300);
      }
    }, 8000);
  });
  
  bot.on('end', () => {
    console.log('[Bot] Disconnected. Reconnecting in 5s...');
    isInGame = false;
    isLoggedIn = false;
    setTimeout(createBot, 5000);
  });
  
  bot.on('error', (err) => console.log(`[Error] ${err.message}`));
  bot.on('kicked', (reason) => console.log(`[Kicked] ${reason}`));
  
  bot.on('message', async (jsonMsg) => {
    const text = jsonMsg.toString().trim();
    if (!text || text.length > 500) return;
    const lower = text.toLowerCase();
    
    if (lower.includes('ignoring block entities')) return;
    console.log(`[Server] ${text}`);
    
    // Auto-login
    if (!isLoggedIn && lower.includes('/login')) {
      console.log('[Bot] Auto-logging in...');
      say('/login 551417114');
      isLoggedIn = true;
      return;
    }
    
    if (lower.includes('successfully logged')) isLoggedIn = true;
    if (lower.includes('[+] habibi') || (lower.includes('joined the game') && lower.includes('habibi'))) {
      isInGame = true;
    }
    if (lower.includes('limbo') || lower.includes('queue')) isInGame = false;
    if (lower.includes('teleport to you')) {
      setTimeout(() => bot.chat('/tpaccept'), 1000);
      return;
    }
    
    // Track kills
    const killMatch = text.match(/(.+?)\s+was\s+killed\s+by\s+(.+?)(?:\s+using|\s+with|$)/i);
    if (killMatch) {
      const victim = killMatch[1].trim();
      const killer = killMatch[2].trim();
      addPlayerInteraction(killer, victim, 'kill');
      
      // Check for kill patterns
      const stats = getPlayerStats(killer);
      if (stats.kills >= CONFIG.moderation.investigation_threshold_kills) {
        console.log(`[Investigation] ⚠️ ${killer} has ${stats.kills} kills - flagged for review`);
      }
    }
    
    // Filter server messages
    const isServerMessage = /^\[(Server|INFO|WARN|ERROR|System)\]/i.test(text) ||
                            /^\*{3}/.test(text) ||
                            /^\[[+\-]\]/.test(text) ||
                            /(joined|left) the game/i.test(text) ||
                            /(time|seconds|queue|position|limbo|lifesteal|full|estimated)/i.test(text) ||
                            /(tempmuted|unmuted|muted|banned|kicked|was killed)/i.test(text) ||
                            /^Habibi/i.test(text) ||
                            /\[Spartan Notification\]/i.test(text) ||
                            /Welcome back!/i.test(text);
    if (isServerMessage) return;
    
    // Parse chat message
    let sender = null;
    let message = null;
    
    const cleanText = text.replace(/^(?:\[[^\]]+\]\s*)*(?:MOD|HELPER|SRHELPER|OWNER|ADMIN|COOWNER|BUILDER|VIP|MVP|YOUTUBE)\s+/i, '');
    const match1 = cleanText.match(/^([a-zA-Z0-9_]{3,16})\s*[:»\-]\s*(.+)/);
    if (match1) {
      sender = match1[1];
      message = match1[2];
    }
    
    if (!sender && text.includes(':')) {
      const parts = text.split(':');
      const beforeColon = parts[0].replace(/^\[.*?\]\s*/, '').trim();
      const words = beforeColon.split(/\s+/);
      const possibleSender = words[words.length - 1];
      if (possibleSender && possibleSender.length >= 3 && possibleSender.length <= 16 && /^[a-zA-Z0-9_]+$/.test(possibleSender)) {
        sender = possibleSender;
        message = parts.slice(1).join(':').trim();
      }
    }
    
    if (!sender || !message || sender === 'Habibi' || sender === 'detected') return;
    if (message.length < 2 || message.match(/^\d+\s+seconds$/i)) return;
    
    // Add to chat history for investigation
    addChatHistory(sender, message);
    
    if (muteList.has(sender)) {
      muteList.delete(sender);
      console.log(`[MOD] ${sender} spoke in chat. Cleared from internal mute list.`);
    }
    
    console.log(`[Chat] ${sender}: ${message}`);
    addMemory(sender, message);
    
    if (isInGame) {
      const violated = await checkViolation(sender, message);
      if (violated) return;
    }
    
    const mentioned = message.toLowerCase().includes('habibi');
    if (mentioned || message.startsWith('!')) {
      const now = Date.now();
      if (now - lastChatTime < CONFIG.chat.cooldown) return;
      lastChatTime = now;
      
      if (message.startsWith('!')) {
        handleBangCommand(sender, message);
      } else {
        setTimeout(async () => {
          const response = await getAIResponse(message, sender);
          if (response) {
            say(response);
            addMemory('Habibi', response);
          }
        }, 100);
      }
    }
  });
  
  bot.on('health', () => {
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

// ========================
// TERMINAL INPUT
// ========================
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'Habibi> ',
});

rl.prompt();
rl.on('line', (line) => {
  const msg = line.trim();
  if (msg.startsWith('!')) {
    handleBangCommand('Terminal', msg);
  } else if (msg.startsWith('/')) {
    if (bot) bot.chat(msg);
  } else if (msg) {
    say(msg);
  }
  rl.prompt();
});

rl.on('close', () => {
  console.log('[Bot] Shutting down...');
  if (bot) bot.quit();
  process.exit(0);
});

// ========================
// START
// ========================
createBot();
