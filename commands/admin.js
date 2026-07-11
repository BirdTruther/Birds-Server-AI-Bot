// commands/admin.js
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { spawn } = require('child_process');
const { logCommand, logSystemEvent } = require('../logger.js');

// ===== SERVICE FUNCTIONS =====

function startPZRestartTask() {
    const child = spawn('sudo', ['bash', '/home/pz_restart.sh'], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
    });
    child.unref();
    return child;
}

async function pickRandomPlayers({ guild, count = 5, voiceOnly = false, filterRole = null }) {
    await guild.members.fetch();

    let memberPool = guild.members.cache.filter(m => !m.user.bot);

    if (voiceOnly) {
        memberPool = memberPool.filter(m => m.voice.channelId !== null);
    }

    if (filterRole) {
        memberPool = memberPool.filter(m => m.roles.cache.has(filterRole.id));
    }

    const poolArray = [...memberPool.values()];

    if (poolArray.length < count) {
        return { error: `⚠️ Not enough members in the pool! Found **${poolArray.length}** but you asked for **${count}**.` };
    }

    const picked = poolArray.sort(() => Math.random() - 0.5).slice(0, count);
    return { picked, poolSize: poolArray.length };
}

// ===== SLASH COMMAND DEFINITIONS =====

const commands = {
    pzrestart: {
        data: new SlashCommandBuilder()
            .setName('pzrestart')
            .setDescription('Restart the Project Zomboid server'),

        async execute(interaction) {
            await interaction.editReply('🔄 Project Zomboid server restart initiated...');
            const child = startPZRestartTask();
            logSystemEvent('PZ_RESTART', 'INFO', 'discord', `PZ restart triggered by ${interaction.user.username} (PID: ${child.pid})`);
            logCommand('discord', interaction.user.username, '/pzrestart', '', 'PZ restart initiated');
        }
    },

    pickplayers: {
        data: new SlashCommandBuilder()
            .setName('pickplayers')
            .setDescription('Randomly pick players for CS2!')
            .addIntegerOption(o =>
                o.setName('count')
                 .setDescription('How many players to pick (default: 5)')
                 .setMinValue(1)
                 .setMaxValue(25)
            )
            .addBooleanOption(o =>
                o.setName('voice_only')
                 .setDescription('Only pick from people currently in a voice channel? (default: false)')
            )
            .addRoleOption(o =>
                o.setName('role')
                 .setDescription('Only pick from members with this role (optional)')
            ),

        async execute(interaction) {
            const count      = interaction.options.getInteger('count') ?? 5;
            const voiceOnly  = interaction.options.getBoolean('voice_only') ?? false;
            const filterRole = interaction.options.getRole('role');

            const result = await pickRandomPlayers({
                guild: interaction.guild,
                count,
                voiceOnly,
                filterRole,
            });

            if (result.error) {
                await interaction.editReply(result.error);
                return;
            }

            const { picked, poolSize } = result;

            const embed = new EmbedBuilder()
                .setTitle(`🎯 CS2 Squad — ${count} Players Picked!`)
                .setColor(0xf4a223)
                .setDescription(
                    picked.map((m, i) => `**${i + 1}.** ${m.toString()} — \`${m.displayName}\``).join('\n')
                )
                .addFields(
                    { name: '🎱 Pool', value: voiceOnly ? '🔊 Voice channel only' : '🌐 Whole server', inline: true },
                    { name: '👥 Pool Size', value: `${poolSize} members`, inline: true }
                )
                .setFooter({ text: `Requested by ${interaction.user.tag}` })
                .setTimestamp();

            if (filterRole) {
                embed.addFields({ name: '🏷️ Role Filter', value: filterRole.name, inline: true });
            }

            await interaction.editReply({ embeds: [embed] });
            logCommand('discord', interaction.user.username, '/pickplayers', `count:${count} voice:${voiceOnly}`, 'pick complete');
        }
    },
};

// ===== EXPORTS =====
module.exports = {
    commands,
    startPZRestartTask,
    pickRandomPlayers,
};