// commands/hate.js
// Manage the bot's "hate list". Permission-gating is done through Discord's
// native slash-command permission system (configured per-guild in the server),
// so no role names are hardcoded here.

const { SlashCommandBuilder } = require('discord.js');
const { logCommand } = require('../logger.js');
const { getHatedUserIds, addToHateList, removeFromHateList } = require('../hate-manager.js');

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
            ),

        async execute(interaction) {
            const sub = interaction.options.getSubcommand();
            const username = interaction.user.username;

            if (sub === 'list') {
                const ids = getHatedUserIds();
                let result;
                if (ids.length === 0) {
                    result = '😇 Nobody on the hate list right now. Weirdly peaceful.';
                } else {
                    const names = ids.map(id => {
                        const member = interaction.guild?.members?.cache?.get(id);
                        return member ? `**${member.displayName}**` : `<@${id}>`;
                    });
                    result = `😈 The hate list (${ids.length}):\n${names.join('\n')}`;
                }
                await interaction.editReply(result);
                logCommand('discord', username, '/hate list', '', result);
                return;
            }

            const userId = interaction.options.getUser('user').id;
            const result = sub === 'add'
                ? addToHateList(userId)
                : removeFromHateList(userId);

            const reply = `${sub === 'add' ? '😈' : '😇'} <@${userId}> ${result.message}`;
            await interaction.editReply(reply);
            logCommand('discord', username, `/hate ${sub}`, userId, reply);
        },
    },
};

module.exports = { commands };
