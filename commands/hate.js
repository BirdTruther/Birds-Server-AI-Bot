// commands/hate.js
// Manage the bot's "hate list". Permission-gating is done through Discord's
// native slash-command permission system (configured per-guild in the server),
// so no role names are hardcoded here.

const { SlashCommandBuilder } = require('discord.js');
const { logCommand } = require('../logger.js');
const { getHatedUserIds, addToHateList, removeFromHateList, isHated, getHateChannelId, setHateChannelId } = require('../hate-manager.js');

const commands = {
    hate: {
        data: new SlashCommandBuilder()
            .setName('hate')
            .setDescription('Manage the bot hate list')
            .addSubcommand(sub =>
                sub.setName('add')
                    .setDescription('Add a user the bot hates')
                    .addUserOption(o => o.setName('user').setDescription('The unlucky user').setRequired(true))
            )
            .addSubcommand(sub =>
                sub.setName('remove')
                    .setDescription('Remove a user from the hate list')
                    .addUserOption(o => o.setName('user').setDescription('The forgiven user').setRequired(true))
            )
            .addSubcommand(sub =>
                sub.setName('list')
                    .setDescription('List everyone the bot hates')
            )
            .addSubcommand(sub =>
                sub.setName('remove-me')
                    .setDescription('Remove yourself from the hate list')
            )
            .addSubcommand(sub =>
                sub.setName('channel')
                    .setDescription('Set which channel the bot randomly roasts into')
                    .addChannelOption(o => o.setName('channel').setDescription('The channel').setRequired(true))
            ),

        async execute(interaction) {
            const sub = interaction.options.getSubcommand();
            const username = interaction.user.username;
            const guildId = interaction.guildId;

            if (sub === 'list') {
                const ids = getHatedUserIds(guildId);
                let result;
                if (ids.length === 0) {
                    result = '😇 Nobody on the hate list right now. Weirdly peaceful.';
                } else {
                    const names = ids.map(id => {
                        const member = interaction.guild?.members?.cache?.get(id);
                        return member ? `**${member.displayName}**` : `<@${id}>`;
                    });
                    const chan = getHateChannelId(guildId)
                        ? `\nRoasts fire into: <#${getHateChannelId(guildId)}>`
                        : '\n⚠️ No roast channel set — use `/hate channel` to enable random roasts.';
                    result = `😈 The hate list (${ids.length}):\n${names.join('\n')}${chan}`;
                }
                await interaction.editReply(result);
                logCommand('discord', username, '/hate list', '', result);
                return;
            }

            if (sub === 'channel') {
                const channelId = interaction.options.getChannel('channel').id;
                setHateChannelId(channelId, guildId);
                const result = `📢 Roasts will fire into <#${channelId}>.`;
                await interaction.editReply(result);
                logCommand('discord', username, '/hate channel', channelId, result);
                return;
            }

            // Self-service: the caller can remove THEMSELVES from the list.
            // (Self-remove is intentionally open so a listed player can opt out
            // anytime; targeted add/remove for others stays permission-gated.)
            if (sub === 'remove-me') {
                const userId = interaction.user.id;
                if (!isHated(userId, guildId)) {
                    await interaction.editReply('😇 You aren\'t on the hate list anyway. No redemption arc needed.');
                    logCommand('discord', username, '/hate remove-me', userId, 'not on list');
                    return;
                }
                const result = removeFromHateList(userId, guildId);
                const reply = `${result.message} (<@${userId}> stepped out)`;
                await interaction.editReply(reply);
                logCommand('discord', username, '/hate remove-me', userId, reply);
                return;
            }

            const userId = interaction.options.getUser('user').id;
            const result = sub === 'add'
                ? addToHateList(userId, guildId)
                : removeFromHateList(userId, guildId);

            const reply = `${sub === 'add' ? '😈' : '😇'} <@${userId}> ${result.message}`;
            await interaction.editReply(reply);
            logCommand('discord', username, `/hate ${sub}`, userId, reply);
        },
    },
};

module.exports = { commands };
