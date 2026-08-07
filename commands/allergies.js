// commands/allergies.js
// Tarkov seasonal wipe — track a character's up-to-3 allergies and find
// who else is allergic to the same stuff.
const { SlashCommandBuilder } = require('discord.js');
const { logCommand } = require('../logger.js');
const {
    addAllergy,
    removeAllergy,
    getCharacterAllergies,
    searchAllergyHolders,
    getCommonAllergies,
} = require('../database.js');

// ===== SLASH COMMAND DEFINITIONS =====

const commands = {
    addallergy: {
        data: new SlashCommandBuilder()
            .setName('addallergy')
            .setDescription('Add an allergy to your Tarkov character (max 3)')
            .addStringOption(o =>
                o.setName('allergy').setDescription('Allergy name').setRequired(true)
            ),

        async execute(interaction) {
            const allergy = interaction.options.getString('allergy');
            const result  = addAllergy(interaction.user.id, allergy, interaction.user.username);
            await interaction.editReply(result.message);
            logCommand('discord', interaction.user.username, '/addallergy', allergy, result.message);
        }
    },

    removeallergy: {
        data: new SlashCommandBuilder()
            .setName('removeallergy')
            .setDescription('Remove an allergy from your Tarkov character')
            .addStringOption(o =>
                o.setName('allergy').setDescription('Allergy name').setRequired(true)
            ),

        async execute(interaction) {
            const allergy = interaction.options.getString('allergy');
            const result  = removeAllergy(interaction.user.id, allergy);
            await interaction.editReply(result.message);
            logCommand('discord', interaction.user.username, '/removeallergy', allergy, result.message);
        }
    },

    allergies: {
        data: new SlashCommandBuilder()
            .setName('allergies')
            .setDescription('List allergies for a character (defaults to you)')
            .addUserOption(o =>
                o.setName('user').setDescription('Which user to check (default: you)').setRequired(false)
            ),

        async execute(interaction) {
            const target  = interaction.options.getUser('user') || interaction.user;
            const { character, allergies } = getCharacterAllergies(target.id);

            const label   = character?.name || target.username;
            const result  = allergies.length > 0
                ? `${label}'s allergies (${allergies.length}/3): ${allergies.join(', ')}`
                : `${label} has no allergies registered. Use \`/addallergy\`.`;

            await interaction.editReply(result);
            logCommand('discord', interaction.user.username, '/allergies', target.username, result);
        }
    },

    searchallergy: {
        data: new SlashCommandBuilder()
            .setName('searchallergy')
            .setDescription('Find who is allergic to something')
            .addStringOption(o =>
                o.setName('allergy').setDescription('Allergy to search for').setRequired(true)
            ),

        async execute(interaction) {
            const allergy = interaction.options.getString('allergy');
            const holders = searchAllergyHolders(allergy);

            const result = holders.length > 0
                ? `**${holders[0].name || holders[0].user_id}** is allergic to **${allergy.toLowerCase()}**.`
                : `Nobody has **${allergy.toLowerCase()}** on their list yet.`;

            await interaction.editReply(result);
            logCommand('discord', interaction.user.username, '/searchallergy', allergy, result);
        }
    },

    commonallergies: {
        data: new SlashCommandBuilder()
            .setName('commonallergies')
            .setDescription('Find allergies shared by 2 or more characters'),

        async execute(interaction) {
            const common = getCommonAllergies();

            const result = common.length > 0
                ? `Shared allergies:\n${common.map(c => `- **${c.allergy}** (${c.holders} people)`).join('\n')}`
                : 'No allergies are shared between 2+ people yet.';

            await interaction.editReply(result);
            logCommand('discord', interaction.user.username, '/commonallergies', '', result);
        }
    },
};

// ===== EXPORTS =====
module.exports = {
    commands,
};
