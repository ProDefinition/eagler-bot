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
    // Chat API keys
    apiKeysChat: [
        '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'
    ],
    // Primary moderation API keys
    apiKeysMod: [
        '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'
    ],
    // Background API key for queued moderation checks (when primary is rate-limited)
    apiKeysBackground: [
        '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'  // <-- Replace with your background key
    ],

    models: {
        chat: ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'],
        moderation: ['openai/gpt-oss-20b'],
        investigation: ['llama-3.1-8b-instant']   // Model for investigation analysis
    },

    server: {
        host: 'play.pcsmp.net',
        port: 25565,
        username: 'Habibi',
        version: '1.12.2',
    },

    moderation: {
        mute_duration: 5,                     // minutes
        moderators: ['ChewKok', 'eagly20', 'n2ab', 'Chew'],
    },

    chat: {
        cooldown: 1000,
        max_length: 250,
    },

    // New: Investigation settings
    investigation: {
        enabled: true,
        cooldown: 60000,                      // ms between investigations per player
        historyLimit: 100,                    // number of chat messages to keep
        deathHistoryLimit: 50,                // number of death events to keep
    },

    testMode: true,   // Automatically unmutes after 500ms in test mode
};

// ========================
// STATE & CLIENTS
// ========================
let bot = null;
let isInGame = false;
let isLoggedIn = false;
let lastChatTime = 0;
const playerMemory = new Map();
const muteList = new Set();

// Chat & death history for investigation
const chatHistory = [];
const deathEvents = [];

// Background moderation queue
const backgroundModQueue = [];
let processingBackground = false;

// API key indices
let currentChatKeyIndex = 0;
let currentModKeyIndex = 0;
let currentBackgroundKeyIndex = 0;

// Groq clients
let groqChat = new Groq({ apiKey: CONFIG.apiKeysChat[currentChatKeyIndex] });
let groqMod = new Groq({ apiKey: CONFIG.apiKeysMod[currentModKeyIndex] });
let groqBackground = new Groq({ apiKey: CONFIG.apiKeysBackground[currentBackgroundKeyIndex] });

// Cooldown map for investigation command
const investigationCooldowns = new Map();

function switchApiKey(type) {
    if (type === 'chat') {
        currentChatKeyIndex = (currentChatKeyIndex + 1) % CONFIG.apiKeysChat.length;
        console.log(`[API] 🔄 Switching to Chat API Key #${currentChatKeyIndex + 1}...`);
        groqChat = new Groq({ apiKey: CONFIG.apiKeysChat[currentChatKeyIndex] });
    } else if (type === 'mod') {
        currentModKeyIndex = (currentModKeyIndex + 1) % CONFIG.apiKeysMod.length;
        console.log(`[API] 🔄 Switching to Mod API Key #${currentModKeyIndex + 1}...`);
        groqMod = new Groq({ apiKey: CONFIG.apiKeysMod[currentModKeyIndex] });
    } else if (type === 'background') {
        currentBackgroundKeyIndex = (currentBackgroundKeyIndex + 1) % CONFIG.apiKeysBackground.length;
        console.log(`[API] 🔄 Switching to Background API Key #${currentBackgroundKeyIndex + 1}...`);
        groqBackground = new Groq({ apiKey: CONFIG.apiKeysBackground[currentBackgroundKeyIndex] });
    }
}

// ========================
// API KEY TESTER
// ========================
async function testAllApiKeys() {
    console.log('\n[API] === Testing All API Keys ===');
    const allKeys = [...CONFIG.apiKeysChat, ...CONFIG.apiKeysMod, ...CONFIG.apiKeysBackground];
    for (let i = 0; i < allKeys.length; i++) {
        const key = allKeys[i];
        const testClient = new Groq({ apiKey: key });
        try {
            await testClient.chat.completions.create({
                model: 'llama-3.1-8b-instant',
                messages: [{ role: 'user', content: 'Say "test"' }],
                max_tokens: 5
            });
            console.log(`[API] Key #${i + 1} (${key.slice(0, 10)}...): ✅ VALID`);
        } catch (err) {
            console.log(`[API] Key #${i + 1} (${key.slice(0, 10)}...): ❌ FAILED - ${err.message}`);
        }
    }
    console.log('[API] ============================\n');
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
// GROQ API CALLER (with rate-limit detection & background queue)
// ========================
async function callGroq(messages, maxTokens = 100, temperature = 0.7, modelList = CONFIG.models.chat, type = 'chat') {
    const apiKeys = type === 'mod' ? CONFIG.apiKeysMod : (type === 'background' ? CONFIG.apiKeysBackground : CONFIG.apiKeysChat);
    let keysTried = 0;
    let rateLimitEncountered = false;

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
                console.error(`[API] Error (${model} on ${type.toUpperCase()} client): ${err.message}`);

                // Detect rate limit (status 429 or message contains "rate")
                if (err.status === 429 || err.message.toLowerCase().includes('rate')) {
                    rateLimitEncountered = true;
                    if (type === 'mod') {
                        // Instead of rotating, we'll queue this message for background processing
                        console.log(`[API] Rate limit on primary mod key. Will queue for background.`);
                        return { rateLimited: true };   // special flag
                    }
                }

                if (type === 'chat') {
                    let cleanErr = err.message.replace(/[\n\r]/g, ' ').substring(0, 60);
                    say(`[API Error] Model ${model} failed: ${cleanErr}...`);
                }

                continue;
            }
        }

        console.log(`[API] ⚠️ All models failed on ${type.toUpperCase()} Key #${(type === 'mod' ? currentModKeyIndex : (type === 'background' ? currentBackgroundKeyIndex : currentChatKeyIndex)) + 1}. Rotating...`);
        if (type === 'chat') say(`[API Warning] Rotating to next API key...`);

        switchApiKey(type);
        keysTried++;
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.error(`[API] ❌ All ${type.toUpperCase()} API keys failed or exhausted.`);
    if (type === 'chat') say('[API Fatal] All keys exhausted or rate-limited.');
    return null;
}

// ========================
// BACKGROUND MODERATION QUEUE PROCESSOR
// ========================
async function processBackgroundModQueue() {
    if (processingBackground || backgroundModQueue.length === 0) return;
    processingBackground = true;

    while (backgroundModQueue.length > 0) {
        const item = backgroundModQueue.shift();
        console.log(`[Background] Processing queued moderation for ${item.sender}: "${item.message}"`);

        const prompt = buildProfanityPrompt(item.message);
        const result = await callGroq(
            [{ role: 'user', content: prompt }],
            5,
            0.0,
            CONFIG.models.moderation,
            'background'   // use background client
        );

        if (result && !result.rateLimited) {
            const cleanResult = result.trim().toLowerCase();
            const isProfane = cleanResult.includes('yes');
            console.log(`[Background] AI response: "${result}" | Flagged: ${isProfane}`);
            if (isProfane) {
                mute(item.sender, `Profanity detected (background) - "${item.message}"`);
            }
        } else if (result && result.rateLimited) {
            // Background key also rate limited? Re-queue with delay
            console.log(`[Background] Rate limited, requeueing...`);
            backgroundModQueue.unshift(item);
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }

        await new Promise(r => setTimeout(r, 500)); // small delay between items
    }

    processingBackground = false;
}

// Start background queue processor interval
setInterval(processBackgroundModQueue, 10000); // check every 10 seconds

// ========================
// MEMORY MANAGEMENT
// ========================
function addMemory(player, message) {
    if (!playerMemory.has(player)) playerMemory.set(player, []);
    const arr = playerMemory.get(player);
    arr.push(message);
    if (arr.length > 10) arr.shift();
}

function getMemory(player) {
    return (playerMemory.get(player) || []).join('\n');
}

// ========================
// MODERATION (with background queue support)
// ========================
function buildProfanityPrompt(message) {
    const onlinePlayers = getOnlineUsernames();
    return `You are an elite, highly accurate moderation filter for a Minecraft server. Evaluate the following message for severe rule violations (e.g., severe swearing, hate speech, slurs, explicit content, encouraging self-harm).

Minecraft PvP terms ("kill", "destroy", "murder") and valid usernames currently online (${onlinePlayers}) are NOT violations.
Mild frustration ("crap", "damn", "stupid") is NOT a violation.

CRITICAL INSTRUCTION:
If the message contains a severe rule violation, reply ONLY with the word "Yes".
If the message is clean, safe, or mild trash talk, reply ONLY with the word "No".
Do not include any punctuation, explanations, or additional text. Just "Yes" or "No".

Message: "${message}"`;
}

async function checkProfanity(message) {
    const prompt = buildProfanityPrompt(message);
    const result = await callGroq(
        [{ role: 'user', content: prompt }],
        5,
        0.0,
        CONFIG.models.moderation,
        'mod'
    );

    if (!result) return { isProfane: false };
    if (result.rateLimited) return { isProfane: false, rateLimited: true };

    const cleanResult = result.trim().toLowerCase();
    const isProfane = cleanResult.includes('yes');
    console.log(`[Profanity] Raw AI response: "${result}" | Flagged: ${isProfane}`);
    return { isProfane };
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

function kickPlayer(player, reason = 'Rule violation') {
    let safeReason = reason.replace(/[:\n\r]/g, ' ').substring(0, 100);
    bot.chat(`/kick ${player} ${safeReason}`);
    console.log(`[MOD] Kicked ${player}. Reason: ${safeReason}`);
}

async function checkViolation(sender, message) {
    // Hardcoded severe slurs (fast path)
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
    if (aiCheck.rateLimited) {
        // Queue for background processing
        console.log(`[Mod] Rate limit hit, queueing message from ${sender} for background check.`);
        backgroundModQueue.push({ sender, message, timestamp: Date.now() });
        return false; // don't block response, will be handled later
    }
    if (aiCheck.isProfane) {
        console.log(`[MOD] AI flagged profanity: ${sender}`);
        mute(sender, `Profanity detected - "${message}"`);
        return true;
    }

    return false;
}

// ========================
// AI RESPONSE (Chat)
// ========================
async function getAIResponse(message, sender) {
    const memory = getMemory(sender);

    const system = `You are Habibi, a highly professional, articulate, and remarkably human presence on this Minecraft server. You are absolutely NOT a bot, an AI, or an automated script.

COMMUNICATION STYLE:
- NEVER WRITE PARAGRAPHS. Keep responses to EXACTLY 1 or 2 short sentences. MAXIMUM 15 WORDS TOTAL.
- Sound entirely human, warm, and natural. Use contractions.
- Maintain polished grammar and spelling.
- Avoid robotic jargon.

SPECIFIC SCENARIOS:
- If players are chaotic or begging: Respond with polite boundaries.
- If accused of being an AI: Deflect with humor (e.g., "I'm just a fast typer").
- If asked about math/coding: Politely decline.

STRICT RULES:
- Never output Minecraft commands.
- Never admit being an AI.
- If you notice severe profanity missed by filter, start response with "[ALERT]".`;

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
        } else {
            mute(sender, `Missed profanity Alert - "${message}"`);
        }
        return response.replace('[ALERT]', '').trim();
    }

    return response;
}

// ========================
// INVESTIGATION FEATURE
// ========================
function addChatHistory(sender, message) {
    chatHistory.push({
        timestamp: Date.now(),
        sender,
        message
    });
    if (chatHistory.length > CONFIG.investigation.historyLimit) {
        chatHistory.shift();
    }
}

function addDeathEvent(victim, killer, weapon = null) {
    deathEvents.push({
        timestamp: Date.now(),
        victim,
        killer,
        weapon
    });
    if (deathEvents.length > CONFIG.investigation.deathHistoryLimit) {
        deathEvents.shift();
    }
    console.log(`[Death] ${victim} killed by ${killer} ${weapon ? `with ${weapon}` : ''}`);
}

async function investigatePlayer(target, requester) {
    // Cooldown check
    const now = Date.now();
    const last = investigationCooldowns.get(requester) || 0;
    if (now - last < CONFIG.investigation.cooldown) {
        say(`Investigation cooldown. Please wait ${Math.ceil((CONFIG.investigation.cooldown - (now - last)) / 1000)}s.`);
        return;
    }
    investigationCooldowns.set(requester, now);

    say(`🔍 Investigating ${target}...`);

    // Gather recent chat from target
    const targetChats = chatHistory.filter(c => c.sender.toLowerCase() === target.toLowerCase())
        .slice(-20)
        .map(c => `[${new Date(c.timestamp).toLocaleTimeString()}] ${c.sender}: ${c.message}`)
        .join('\n');

    // Gather death events involving target (as victim or killer)
    const targetDeaths = deathEvents.filter(d =>
        d.victim.toLowerCase() === target.toLowerCase() ||
        d.killer.toLowerCase() === target.toLowerCase()
    ).slice(-20)
        .map(d => {
            if (d.victim.toLowerCase() === target.toLowerCase()) {
                return `[${new Date(d.timestamp).toLocaleTimeString()}] ${target} was killed by ${d.killer} ${d.weapon ? `using ${d.weapon}` : ''}`;
            } else {
                return `[${new Date(d.timestamp).toLocaleTimeString()}] ${target} killed ${d.victim} ${d.weapon ? `using ${d.weapon}` : ''}`;
            }
        }).join('\n');

    const onlinePlayers = getOnlineUsernames();

    const prompt = `You are a Minecraft server moderator AI. Analyze the behavior of player "${target}" based on the provided evidence.

Recent chat from ${target}:
${targetChats || '(No recent chat)'}

Recent death events involving ${target}:
${targetDeaths || '(No recent death events)'}

Online players: ${onlinePlayers}

Determine if ${target} is violating server rules such as:
- Excessive toxicity, harassment, or hate speech
- Targeting or spawn-killing the same player repeatedly without provocation
- Cheating or exploiting

If the player deserves action, respond with exactly one of these uppercase commands:
- MUTE (if chat is toxic but not severe)
- KICK (if behavior warrants removal but not permanent)
- BAN (if severe, but we only support kick/mute, so use KICK)
- NOTHING (if no action needed)

Do not include any extra text. Just one word.`;

    const decision = await callGroq(
        [{ role: 'user', content: prompt }],
        5,
        0.0,
        CONFIG.models.investigation,
        'chat'   // using chat API for investigation
    );

    if (!decision) {
        say(`Investigation failed (API error).`);
        return;
    }

    const action = decision.trim().toUpperCase();
    console.log(`[Investigate] AI decision for ${target}: ${action}`);

    switch (action) {
        case 'MUTE':
            mute(target, 'Investigation concluded - toxic behavior');
            say(`Investigation complete. ${target} has been muted.`);
            break;
        case 'KICK':
        case 'BAN':
            kickPlayer(target, 'Investigation concluded - rule violation');
            say(`Investigation complete. ${target} has been kicked.`);
            break;
        case 'NOTHING':
        default:
            say(`Investigation complete. No action taken against ${target}.`);
            break;
    }
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
            say('Commands: !inventory, !status, !joke, !roll, !fact, !testkeys, !mute <player> [reason], !kick <player> [reason], !investigate <player>');
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
        case 'mute':
            if (!CONFIG.moderation.moderators.includes(sender)) { say('Permission denied.'); return; }
            const target = args[1];
            const reason = args.slice(2).join(' ') || 'Chat violation';
            if (target) mute(target, reason);
            break;
        case 'kick':
            if (!CONFIG.moderation.moderators.includes(sender)) { say('Permission denied.'); return; }
            const kickTarget = args[1];
            const kickReason = args.slice(2).join(' ') || 'Rule violation';
            if (kickTarget) kickPlayer(kickTarget, kickReason);
            break;
        case 'investigate':
            if (!CONFIG.moderation.moderators.includes(sender)) { say('Permission denied.'); return; }
            const investigateTarget = args[1];
            if (investigateTarget) {
                investigatePlayer(investigateTarget, sender);
            } else {
                say('Usage: !investigate <player>');
            }
            break;
        default:
            say(`Unknown command: ${cmd}`);
    }
}

// ========================
// BOT CREATION & EVENT HANDLERS
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

        // Detect death messages
        const deathPatterns = [
            /(\w+) was slain by (\w+)(?: using (.+))?/i,
            /(\w+) was shot by (\w+)(?: using (.+))?/i,
            /(\w+) was killed by (\w+)(?: using (.+))?/i,
            /(\w+) was blown up by (\w+)/i,
            /(\w+) was fireballed by (\w+)/i,
        ];
        for (const pattern of deathPatterns) {
            const match = text.match(pattern);
            if (match) {
                const victim = match[1];
                const killer = match[2];
                const weapon = match[3] || null;
                if (victim && killer) {
                    addDeathEvent(victim, killer, weapon);
                }
                break;
            }
        }

        // Ignore server/mod messages
        const isServerMessage = /^\[(Server|INFO|WARN|ERROR|System)\]/i.test(text) ||
                                /^\*{3}/.test(text) ||
                                /^\[[+\-]\]/.test(text) ||
                                /(joined|left) the game/i.test(text) ||
                                /(time|seconds|queue|position|limbo|lifesteal|full|estimated)/i.test(text) ||
                                /(tempmuted|unmuted|muted|banned|kicked)/i.test(text) ||
                                /^Habibi/i.test(text) ||
                                /\[Spartan Notification\]/i.test(text) ||
                                /Welcome back!/i.test(text);
        if (isServerMessage) return;

        // Parse player chat
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

        if (muteList.has(sender)) {
            muteList.delete(sender);
            console.log(`[MOD] ${sender} spoke in chat. Cleared from internal mute list.`);
        }

        console.log(`[Chat] ${sender}: ${message}`);
        addMemory(sender, message);
        addChatHistory(sender, message);   // store for investigation

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
