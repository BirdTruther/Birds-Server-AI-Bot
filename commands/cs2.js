// commands/cs2.js
const { SlashCommandBuilder } = require('discord.js');
const { logCommand, logSystemEvent } = require('../logger.js');

// ===== CONFIG =====
const CS2_KEY_COST_USD = 2.49;
const CS2_CASE_MAX_OPENS = 100;
const CS2_PRICE_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ===== CS2 PRICE CACHE =====
const cs2PriceCache = new Map();

// Prune stale cache entries hourly so the Map doesn't grow forever
setInterval(() => {
    const now = Date.now();
    for (const [key, val] of cs2PriceCache) {
        if (now > val.expiresAt) cs2PriceCache.delete(key);
    }
}, 60 * 60 * 1000);

// ===== SERVICE FUNCTIONS =====

async function getCS2SkinPrice(skinName) {
    try {
        const cacheKey = skinName.trim().toLowerCase();
        const cached = cs2PriceCache.get(cacheKey);
        if (cached && Date.now() < cached.expiresAt) {
            console.log(`[CS2 Cache] HIT for "${skinName}" — serving cached price.`);
            return cached.result;
        }

        const encoded = encodeURIComponent(skinName);
        const searchUrl = `https://steamcommunity.com/market/search/render/?query=${encoded}&appid=730&search_descriptions=0&count=3&norender=1`;
        const searchRes = await fetch(searchUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BirdBot/1.0)' }
        });
        if (!searchRes.ok) {
            if (searchRes.status === 429) {
                logSystemEvent('CS2_RATE_LIMIT', 'WARNING', 'cs2', `Steam rate limit hit for "${skinName}"`);
            }
            return `❌ Steam Market returned an error (${searchRes.status}). Try again in a moment.`;
        }
        const searchData = await searchRes.json();
        const results = searchData?.results;
        if (!results || results.length === 0) {
            return `❌ No results found for **"${skinName}"** on Steam Market.\nTip: Use the full name like \`AK-47 | Redline (Field-Tested)\``;
        }
        const item = results[0];
        const name      = item.name || skinName;
        const lowestUSD = item.sell_price_text || 'N/A';
        const listCount = item.sell_listings?.toLocaleString() || '?';
        const hashName  = encodeURIComponent(item.hash_name || name);
        const priceUrl  = `https://steamcommunity.com/market/priceoverview/?appid=730&currency=1&market_hash_name=${hashName}`;
        const priceRes  = await fetch(priceUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BirdBot/1.0)' } });
        let medianPrice = 'N/A';
        if (priceRes.ok) {
            const priceData = await priceRes.json();
            medianPrice = priceData?.median_price || priceData?.lowest_price || 'N/A';
        }
        const result = [
            `🔫 **${name}**`,
            `💰 Lowest: ${lowestUSD} | Median (30d): ${medianPrice}`,
            `📦 Listings: ${listCount}`,
            `🔗 https://steamcommunity.com/market/listings/730/${encodeURIComponent(item.hash_name || name)}`,
        ].join('\n');

        cs2PriceCache.set(cacheKey, { result, expiresAt: Date.now() + CS2_PRICE_CACHE_TTL_MS });
        console.log(`[CS2 Cache] STORED "${skinName}" — expires in ${CS2_PRICE_CACHE_TTL_MS / 60000} minutes.`);
        return result;
    } catch (error) {
        console.error('[CS2 Price Error]', error);
        logSystemEvent('CS2_ERROR', 'WARNING', 'cs2', `cs2price fetch failed for "${skinName}": ${error.message}`);
        return `❌ Error fetching CS2 price for "${skinName}". Try again later.`;
    }
}

async function getCS2Float(inspectLink) {
    if (!inspectLink || !inspectLink.includes('csgo_econ_action_preview')) {
        return [
            '❌ Invalid inspect link.',
            'Right-click a skin in your CS2 inventory or on the Steam Market → **"Inspect in Game"** and paste that full link.',
            'Example: `!cs2float steam://rungame/730/76561202255233023/+csgo_econ_action_preview%20S76561...A...D...`',
        ].join('\n');
    }
    try {
        const apiUrl = `https://api.csfloat.com/?url=${encodeURIComponent(inspectLink)}`;
        const response = await fetch(apiUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BirdBot/1.0)' }
        });

        if (response.status === 429) return '⏳ CSFloat rate limit hit. Try again in a moment.';

        if (response.ok) {
            const data = await response.json();
            const item = data?.iteminfo || data;
            if (item?.floatvalue) {
                const fv        = parseFloat(item.floatvalue);
                const floatVal  = fv.toFixed(10);
                const paintSeed = item.paintseed ?? 'N/A';
                const skinName  = item.full_item_name || item.weapon_type || 'Unknown Skin';
                const stickers  = item.stickers?.length > 0 ? item.stickers.map(s => s.name).join(', ') : 'None';
                let wear = 'Battle-Scarred';
                if      (fv < 0.07) wear = 'Factory New';
                else if (fv < 0.15) wear = 'Minimal Wear';
                else if (fv < 0.38) wear = 'Field-Tested';
                else if (fv < 0.45) wear = 'Well-Worn';
                let rare = '';
                if (fv < 0.01)  rare = ' 🌟 (Rare low float!)';
                if (fv > 0.999) rare = ' 💀 (Max float!)';
                return [
                    `🔍 **${skinName}**`,
                    `📊 Float: \`${floatVal}\` — **${wear}**${rare}`,
                    `🎨 Pattern Seed: ${paintSeed}`,
                    `🪧 Stickers: ${stickers}`,
                    `🔗 https://csfloat.com/db?inspectLink=${encodeURIComponent(inspectLink)}`,
                ].join('\n');
            }
        }

        return [
            `🔍 **Inspect Link Received** (float API unavailable right now)`,
            `🔗 Try manually: https://csfloat.com/db?inspectLink=${encodeURIComponent(inspectLink)}`,
        ].join('\n');

    } catch (error) {
        console.error('[CS2 Float Error]', error);
        logSystemEvent('CS2_ERROR', 'WARNING', 'cs2', `cs2float failed: ${error.message}`);
        return '❌ Error processing inspect link. Try again later.';
    }
}

async function getCS2PlayerStats(steamInput) {
    const apiKey = process.env.STEAM_API_KEY;
    if (!apiKey) return 'CS2 stats lookup is not configured (missing STEAM_API_KEY).';
    try {
        let steamId = steamInput.trim();
        if (!/^\d{17}$/.test(steamId)) {
            const vanityRes  = await fetch(`https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${apiKey}&vanityurl=${encodeURIComponent(steamId)}`);
            const vanityData = await vanityRes.json();
            if (vanityData?.response?.success === 1) {
                steamId = vanityData.response.steamid;
            } else {
                return `❌ Could not find a Steam account for **"${steamInput}"**.\nTry using your full SteamID64 (17-digit number from steamid.io).`;
            }
        }
        let displayName = steamId;
        try {
            const summaryRes  = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${apiKey}&steamids=${steamId}`);
            const summaryData = await summaryRes.json();
            const player      = summaryData?.response?.players?.[0];
            if (player?.personaname) displayName = player.personaname;
        } catch (_) {}
        const statsRes = await fetch(`https://api.steampowered.com/ISteamUserStats/GetUserStatsForGame/v2/?appid=730&key=${apiKey}&steamid=${steamId}`);
        if (!statsRes.ok) {
            if (statsRes.status === 403) return `❌ **${displayName}**'s stats are set to private.\nThey need to go to Steam → Edit Profile → Privacy Settings → set **Game Details** to Public.`;
            return `❌ Could not retrieve stats (Steam API error ${statsRes.status}).`;
        }
        const statsData = await statsRes.json();
        const stats     = statsData?.playerstats?.stats;
        if (!stats || stats.length === 0) return `❌ No CS2 stats found for **${displayName}**. Stats may be private or they haven't played CS2.`;
        const getStat = (name) => stats.find(s => s.name === name)?.value || 0;
        const kills         = getStat('total_kills');
        const deaths        = getStat('total_deaths');
        const hsKills       = getStat('total_kills_headshot');
        const wins          = getStat('total_wins');
        const roundsPlayed  = getStat('total_rounds_played');
        const matchesPlayed = getStat('total_matches_played');
        const mvps          = getStat('total_mvps');
        const shotsFired    = getStat('total_shots_fired');
        const shotsHit      = getStat('total_shots_hit');
        const timePlayed    = getStat('total_time_played');
        const bombsPlanted  = getStat('total_planted_bombs');
        const bombsDefused  = getStat('total_defused_bombs');
        const hoursPlayed   = (timePlayed / 3600).toFixed(0);
        const kd            = deaths > 0 ? (kills / deaths).toFixed(2) : kills.toFixed(2);
        const hsPercent     = kills > 0 ? ((hsKills / kills) * 100).toFixed(1) : '0.0';
        const accuracy      = shotsFired > 0 ? ((shotsHit / shotsFired) * 100).toFixed(1) : '0.0';
        const winRate       = roundsPlayed > 0 ? ((wins / roundsPlayed) * 100).toFixed(1) : '0.0';
        return [
            `🎮 **CS2 Stats — ${displayName}**`,
            `⚔️  K/D: ${kd} | Kills: ${kills.toLocaleString()} | Deaths: ${deaths.toLocaleString()}`,
            `🎯 Headshots: ${hsKills.toLocaleString()} (${hsPercent}%) | Accuracy: ${accuracy}%`,
            `🏆 Matches Played: ${matchesPlayed.toLocaleString()} | Round Win Rate: ${winRate}% | MVPs: ${mvps.toLocaleString()}`,
            `💣 Bombs Planted: ${bombsPlanted.toLocaleString()} | Defused: ${bombsDefused.toLocaleString()} | Hours: ${hoursPlayed}h`,
            `⚠️ *Stats are all-time totals (casual + competitive combined) via Steam API.*`,
        ].join('\n');
    } catch (error) {
        console.error('[CS2 Stats Error]', error);
        logSystemEvent('CS2_ERROR', 'WARNING', 'cs2', `cs2stats fetch failed for "${steamInput}": ${error.message}`);
        return `❌ Error fetching CS2 stats for "${steamInput}".`;
    }
}

const CS2_MAP_DATA = {
    mirage:  { name: 'Mirage',   setting: 'Moroccan city',                    side: 'CT-sided',  callouts: 'A Site: Palace, Ramp, CT, Jungle, Stairs, Ticket Booth | B Site: Short, Van, Bench, Default, B Apps | Mid: Window, Catwalk, Top Mid, Connector, Underpass', tip: 'Window control mid is everything — whoever owns it controls the map.' },
    inferno: { name: 'Inferno',  setting: 'Italian village',                  side: 'CT-sided',  callouts: 'A Site: Pit, Library, Short, CT, Arch, Balcony | B Site: Banana, Car, Spools, Coffins, Dark | Mid: Top Mid, Mid Apartments', tip: 'Banana control determines most B executes — smoke it or lose it.' },
    nuke:    { name: 'Nuke',     setting: 'Nuclear facility',                 side: 'CT-sided',  callouts: 'Upper: Ramp, Secret, Lobby, Silo, Outside | Lower: Lower A, Vents, Heaven, Hell | B Site: Squeaky, B Hut', tip: 'Nuke rewards map knowledge above all else — learn the vents.' },
    ancient: { name: 'Ancient',  setting: 'Mayan ruins',                      side: 'Balanced',  callouts: 'A Site: Donut, Temple, CT, Ramp, Ruins | B Site: River, Cave, Elbow, Pillar | Mid: Mid, Speed', tip: 'Mid speed round to Cave can catch CT rotations completely off guard.' },
    anubis:  { name: 'Anubis',   setting: 'Egyptian ruins',                   side: 'Balanced',  callouts: 'A Site: Speed, Palace, Fountain, Connector | B Site: Bridge, Water, Hovel, Canal | Mid: Mid, Alley', tip: 'Bridge control on B is crucial — it cuts off CT rotation.' },
    dust2:   { name: 'Dust 2',   setting: 'Middle Eastern town',              side: 'T-sided',   callouts: 'A Site: Long, Short, CT, Pit, Ramp | B Site: Tunnels, B Doors, B Platform, Window | Mid: Catwalk, Xbox, Top Mid', tip: 'Long A control early game is a huge advantage — commit to it or leave it.' },
    cache:   { name: 'Cache',    setting: 'Chernobyl industrial facility',    side: 'Balanced',  callouts: 'A Site: A Main, Squeaky, Forklift, Quad, Balcony | B Site: B Main, Checkers, Headshot, Heaven, Tree | Mid: Vents, Z (Connector), White Box, Boost, Garage', tip: 'Controlling Mid is essential for both sides; use smokes to block Z and Vents to dictate the pace of the round.' },
};

function getCS2MapInfo(mapInput) {
    const key = mapInput.toLowerCase().replace(/[^a-z0-9]/g, '').replace('dust_2', 'dust2');
    let map = CS2_MAP_DATA[key];
    if (!map) {
        const partialKey = Object.keys(CS2_MAP_DATA).find(k => k.includes(key) || key.includes(k));
        map = partialKey ? CS2_MAP_DATA[partialKey] : null;
    }
    if (!map) {
        const available = Object.values(CS2_MAP_DATA).map(m => m.name).join(', ');
        return `Map "${mapInput}" not found. Available maps: ${available}`;
    }
    return [
        `🗺️ **${map.name}** | ${map.setting} | ${map.side}`,
        `📍 Callouts: ${map.callouts}`,
        `💡 Tip: ${map.tip}`,
    ].join('\n');
}

const CS2_CASE_ODDS = [
    { tier: '🔵 Mil-Spec',     rarity: 'Blue',   chance: 0.7992 },
    { tier: '🟣 Restricted',   rarity: 'Purple', chance: 0.1598 },
    { tier: '🩷 Classified',   rarity: 'Pink',   chance: 0.0320 },
    { tier: '🔴 Covert',       rarity: 'Red',    chance: 0.0064 },
    { tier: '🟡 Knife/Gloves', rarity: 'Gold',   chance: 0.0026 },
];
const CS2_STATTRAK_CHANCE = 0.10;

function simulateCS2Case(caseName, count, caseCostUSD) {
    const numCases = Math.min(Math.max(Math.floor(count), 1), CS2_CASE_MAX_OPENS);
    const caseCost = Math.max(parseFloat(caseCostUSD) || 0, 0);
    const totalCostPerCase = caseCost + CS2_KEY_COST_USD;
    const totalCost = (totalCostPerCase * numCases).toFixed(2);
    const results = { Blue: 0, Purple: 0, Pink: 0, Red: 0, Gold: 0 };
    let statTrakCount = 0;
    for (let i = 0; i < numCases; i++) {
        const roll = Math.random();
        let cumulative = 0;
        for (const tier of CS2_CASE_ODDS) {
            cumulative += tier.chance;
            if (roll <= cumulative) {
                results[tier.rarity]++;
                if (Math.random() <= CS2_STATTRAK_CHANCE) statTrakCount++;
                break;
            }
        }
    }
    const outcomeLines = CS2_CASE_ODDS
        .filter(t => results[t.rarity] > 0)
        .map(t => `${t.tier}: ${results[t.rarity]}x`)
        .join(' | ');
    let flavor = '💀 Rough run — the market is not your friend today.';
    if (results.Gold > 0)                         flavor = '🎉 YOU HIT A KNIFE/GLOVES! Screenshot that NOW!';
    else if (results.Red > 0)                     flavor = "🔥 A Covert drop?! That's actually solid.";
    else if (results.Pink > 0)                    flavor = '😤 A Classified — not bad, not great.';
    else if (results.Purple >= numCases * 0.3)    flavor = '📦 Mostly Restricted. Could be worse... barely.';
    return [
        `📦 **CS2 Case Simulator** — ${caseName} (${numCases} opened)`,
        `💰 Case: $${caseCost.toFixed(2)} + Key: $${CS2_KEY_COST_USD.toFixed(2)} = **$${totalCostPerCase.toFixed(2)}/open** | Total spent: **$${totalCost}**`,
        `📊 Results: ${outcomeLines || 'Nothing notable'}`,
        `🎰 StatTrak drops: ${statTrakCount}`,
        flavor,
    ].join('\n');
}

// ===== SLASH COMMAND DEFINITIONS =====

const commands = {
    cs2price: {
        data: new SlashCommandBuilder()
            .setName('cs2price')
            .setDescription('Get a CS2 skin price from Steam Market')
            .addStringOption(o => o.setName('skin').setDescription('Skin name (e.g. AK-47 | Redline (Field-Tested))').setRequired(true)),

        async execute(interaction) {
            const skin = interaction.options.getString('skin');
            const result = await getCS2SkinPrice(skin);
            await interaction.editReply(result);
            logCommand('discord', interaction.user.username, '/cs2price', skin, result);
        }
    },

    cs2float: {
        data: new SlashCommandBuilder()
            .setName('cs2float')
            .setDescription('Get the float value of a CS2 skin')
            .addStringOption(o => o.setName('link').setDescription('Steam inspect link').setRequired(true)),

        async execute(interaction) {
            const link = interaction.options.getString('link');
            const result = await getCS2Float(link);
            await interaction.editReply(result);
            logCommand('discord', interaction.user.username, '/cs2float', link.substring(0, 60), result);
        }
    },

    cs2stats: {
        data: new SlashCommandBuilder()
            .setName('cs2stats')
            .setDescription('Get CS2 player stats')
            .addStringOption(o => o.setName('steam').setDescription('Steam ID or username').setRequired(true)),

        async execute(interaction) {
            const steam = interaction.options.getString('steam');
            const result = await getCS2PlayerStats(steam);
            await interaction.editReply(result);
            logCommand('discord', interaction.user.username, '/cs2stats', steam, result);
        }
    },

    cs2map: {
        data: new SlashCommandBuilder()
            .setName('cs2map')
            .setDescription('Get CS2 map callouts and tips')
            .addStringOption(o => o.setName('map').setDescription('Map name (e.g. mirage)').setRequired(true)),

        async execute(interaction) {
            const mapInput = interaction.options.getString('map');
            const result = getCS2MapInfo(mapInput);
            await interaction.editReply(result);
            logCommand('discord', interaction.user.username, '/cs2map', mapInput, result);
        }
    },

    cs2case: {
        data: new SlashCommandBuilder()
            .setName('cs2case')
            .setDescription('Simulate CS2 case openings')
            .addStringOption(o => o.setName('case').setDescription('Case name').setRequired(true))
            .addIntegerOption(o => o.setName('count').setDescription('Number of cases to open').setRequired(true))
            .addNumberOption(o => o.setName('cost').setDescription('Case cost in USD').setRequired(true)),

        async execute(interaction) {
            const caseName = interaction.options.getString('case');
            const count    = interaction.options.getInteger('count');
            const cost     = interaction.options.getNumber('cost');
            const result   = simulateCS2Case(caseName, count, cost);
            await interaction.editReply(result);
            logCommand('discord', interaction.user.username, '/cs2case', `${caseName} ${count} ${cost}`, result);
        }
    },
};

// ===== EXPORTS =====
// Service functions exported separately so twitch.js can reuse them
module.exports = {
    commands,
    getCS2SkinPrice,
    getCS2Float,
    getCS2PlayerStats,
    getCS2MapInfo,
    simulateCS2Case,
};