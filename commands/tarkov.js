// commands/tarkov.js
const { SlashCommandBuilder } = require('discord.js');
const { request, gql } = require('graphql-request');
const { logCommand, logSystemEvent } = require('../logger.js');

// ===== CONFIG =====
const TARKOV_API_URL = 'https://api.tarkov.dev/graphql';
const EST_TIMEZONE = 'America/New_York';
const MAIN_TRADERS = ['Prapor', 'Therapist', 'Fence', 'Skier', 'Peacekeeper', 'Mechanic', 'Ragman', 'Jaeger'];

// ===== SERVICE FUNCTIONS =====

async function getTarkovPrice(itemName) {
    const query = gql`
        query GetItem($name: String!) {
            itemsByName(name: $name) {
                name shortName avg24hPrice
                sellFor { price source }
                properties { ... on ItemPropertiesAmmo { penetrationPower damage } }
                link
            }
        }
    `;
    try {
        const data = await request(TARKOV_API_URL, query, { name: itemName });
        if (data.itemsByName?.length > 0) {
            const item = data.itemsByName[0];
            const fleaPrice = item.avg24hPrice ? `₽${item.avg24hPrice.toLocaleString()}` : 'N/A';
            const traders = item.sellFor?.slice(0, 2).map(s => `${s.source}:₽${s.price.toLocaleString()}`).join(', ') || 'None';
            let stats = '';
            if (item.properties?.penetrationPower) stats = ` | PEN:${item.properties.penetrationPower} DMG:${item.properties.damage}`;
            const wikiLink = item.link ? ` | ${item.link}` : '';
            return `${item.shortName || item.name} | Flea:${fleaPrice} | Sell:${traders}${stats}${wikiLink}`;
        }
        return `No item found: ${itemName}`;
    } catch (error) {
        console.error('[Tarkov Price Error]', error);
        logSystemEvent('TARKOV_ERROR', 'WARNING', 'tarkov', `Price lookup failed for ${itemName}`, error);
        return `Error fetching: ${itemName}`;
    }
}

async function getBestAmmo(searchCaliber) {
    const query = gql`
        query {
            itemsByType(type: ammo) {
                name
                properties { ... on ItemPropertiesAmmo { penetrationPower damage caliber } }
                avg24hPrice
                sellFor { price source }
            }
        }
    `;
    try {
        const data = await request(TARKOV_API_URL, query);
        const ammoList = data.itemsByType?.filter(item => item.properties?.caliber) || [];
        const matchingAmmo = ammoList.filter(item =>
            item.name.toLowerCase().includes(searchCaliber.toLowerCase()) ||
            item.properties.caliber.toLowerCase().includes(searchCaliber.toLowerCase())
        );
        if (matchingAmmo.length > 0) {
            const bestAmmo = matchingAmmo.sort((a, b) =>
                (b.properties.penetrationPower || 0) - (a.properties.penetrationPower || 0)
            )[0];
            const fleaPrice = bestAmmo.avg24hPrice ? `₽${bestAmmo.avg24hPrice.toLocaleString()}` : 'N/A';
            const traderSource = bestAmmo.sellFor?.[0]?.source || 'Flea';
            const cleanTrader = traderSource === 'flea-market' ? 'Flea' : traderSource.replace(/-/g, ' L');
            return `${bestAmmo.name} | PEN:${bestAmmo.properties.penetrationPower} DMG:${bestAmmo.properties.damage} | ${fleaPrice} (${cleanTrader})`;
        }
        return `No ${searchCaliber} ammo found. Try partial names like "m995" or ".300"`;
    } catch (error) {
        console.error('[Best Ammo Error]', error);
        logSystemEvent('TARKOV_ERROR', 'WARNING', 'tarkov', `Best ammo lookup failed for ${searchCaliber}`, error);
        return `Error: ${searchCaliber}`;
    }
}

async function getTraderResets() {
    const query = gql`query { traders { name resetTime } }`;
    try {
        const data = await request(TARKOV_API_URL, query);
        const mainTraders = data.traders.filter(t => MAIN_TRADERS.includes(t.name));
        const traderList = mainTraders.map(t => {
            if (!t.resetTime) return `${t.name}: Now`;
            const date = new Date(t.resetTime);
            const estTime = date.toLocaleString('en-US', {
                timeZone: EST_TIMEZONE,
                hour: '2-digit', minute: '2-digit', hour12: true
            });
            return `${t.name}: ${estTime}`;
        }).join(', ');
        return `Traders: ${traderList}`;
    } catch (error) {
        console.error('[Trader Resets Error]', error);
        logSystemEvent('TARKOV_ERROR', 'WARNING', 'tarkov', 'Trader resets lookup failed', error);
        return 'Error fetching traders';
    }
}

async function getMapInfo(mapName) {
    const query = gql`
        query GetMap($name: String!) {
            maps(name: $name) { name enemies }
        }
    `;
    try {
        const data = await request(TARKOV_API_URL, query, { name: mapName });
        if (data.maps?.length > 0) {
            const map = data.maps[0];
            const bosses = map.enemies?.join(', ') || 'None';
            return `${map.name} | Bosses: ${bosses}`;
        }
        return `No map: ${mapName}`;
    } catch (error) {
        console.error('[Map Info Error]', error);
        logSystemEvent('TARKOV_ERROR', 'WARNING', 'tarkov', `Map info lookup failed for ${mapName}`, error);
        return `Error: ${mapName}`;
    }
}

async function getPlayerStats(playerName) {
    const query = gql`
        query GetPlayer($name: String!) {
            players(name: $name) { name level experience }
        }
    `;
    try {
        const data = await request(TARKOV_API_URL, query, { name: playerName });
        if (data.players?.length > 0) {
            const player = data.players[0];
            return `${player.name} | Level: ${player.level} | XP: ${player.experience?.toLocaleString() || 'N/A'}`;
        }
        return `No player found: ${playerName}`;
    } catch (error) {
        console.error('[Player Stats Error]', error);
        logSystemEvent('TARKOV_ERROR', 'WARNING', 'tarkov', `Player stats lookup failed for ${playerName}`, error);
        return `Error fetching player: ${playerName}`;
    }
}

// ===== SLASH COMMAND DEFINITIONS =====

const commands = {
    price: {
        data: new SlashCommandBuilder()
            .setName('price')
            .setDescription('Look up a Tarkov item price')
            .addStringOption(o => o.setName('item').setDescription('Item name').setRequired(true)),

        async execute(interaction) {
            const item = interaction.options.getString('item');
            const result = await getTarkovPrice(item);
            await interaction.editReply(result);
            logCommand('discord', interaction.user.username, '/price', item, result);
        }
    },

    bestammo: {
        data: new SlashCommandBuilder()
            .setName('bestammo')
            .setDescription('Find the best Tarkov ammo for a caliber')
            .addStringOption(o => o.setName('caliber').setDescription('Caliber (e.g. 5.45x39)').setRequired(true)),

        async execute(interaction) {
            const caliber = interaction.options.getString('caliber');
            const result = await getBestAmmo(caliber);
            await interaction.editReply(result);
            logCommand('discord', interaction.user.username, '/bestammo', caliber, result);
        }
    },

    trader: {
        data: new SlashCommandBuilder()
            .setName('trader')
            .setDescription('Show Tarkov trader reset times'),

        async execute(interaction) {
            const result = await getTraderResets();
            await interaction.editReply(result);
            logCommand('discord', interaction.user.username, '/trader', '', result);
        }
    },

    map: {
        data: new SlashCommandBuilder()
            .setName('map')
            .setDescription('Get Tarkov map info and bosses')
            .addStringOption(o => o.setName('map').setDescription('Map name').setRequired(true)),

        async execute(interaction) {
            const mapName = interaction.options.getString('map');
            const result = await getMapInfo(mapName);
            await interaction.editReply(result);
            logCommand('discord', interaction.user.username, '/map', mapName, result);
        }
    },

    player: {
        data: new SlashCommandBuilder()
            .setName('player')
            .setDescription('Look up a Tarkov player')
            .addStringOption(o => o.setName('name').setDescription('Player name').setRequired(true)),

        async execute(interaction) {
            const playerName = interaction.options.getString('name');
            const result = await getPlayerStats(playerName);
            await interaction.editReply(result);
            logCommand('discord', interaction.user.username, '/player', playerName, result);
        }
    },
};

// ===== EXPORTS =====
// Service functions exported so twitch.js can reuse them without duplicating logic
module.exports = {
    commands,
    getTarkovPrice,
    getBestAmmo,
    getTraderResets,
    getMapInfo,
    getPlayerStats,
};