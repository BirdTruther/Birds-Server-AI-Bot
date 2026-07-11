// ===== DISCORD MESSAGE HANDLER (non-reply messages) =====
// Prefix commands removed — all commands are slash commands only.
// This handler only processes @mentions and image attachments.
discordClient.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (message.reference)  return; // replies handled below

    const channelId = message.channelId;
    const username  = message.author.username;

    // Only care if the bot is @mentioned
    if (!message.mentions.has(discordClient.user)) return;

    addToMemory('discord', channelId, username, message.content);
    console.log(`[DISCORD] ${username}: ${message.content}`);

    const userMessage = message.content.replace(/<@!?\d+>/g, '').trim();

    if (!userMessage && !hasImageAttachment(message)) return;

    // Wild request filter
    if (isWildRequest(userMessage)) {
        const roast = await getWildRequestResponse(userMessage, 'discord', channelId, username);
        await safeDiscordReply(message, roast);
        logCommand('discord', username, '@mention (wild)', userMessage, roast);
        return;
    }

    // Image generation request
    if (detectImageRequest(userMessage)) {
        const rateCheck = checkImageRateLimit(message.author.id);
        if (!rateCheck.allowed) {
            await safeDiscordReply(message, `⏳ Rate limit hit. Try again in ${rateCheck.timeLeft} minute(s).`);
            return;
        }
        const cleanPrompt = sanitizeImagePrompt(extractImagePrompt(userMessage));
        logCommand('discord', username, '@mention (image)', cleanPrompt, '[generating...]');
        try {
            await message.channel.sendTyping();
            const { buffer, mimeType } = await generateImage(cleanPrompt);
            const ext        = mimeType.split('/')[1] || 'png';
            const attachment = new AttachmentBuilder(buffer, { name: `generated.${ext}` });
            await message.reply({ files: [attachment] });
        } catch (imgErr) {
            await safeDiscordReply(message, `❌ Image generation failed: ${imgErr.message}`);
        }
        return;
    }

    // Image attachment analysis
    if (hasImageAttachment(message)) {
        const images   = await getImageAttachments(message);
        const response = await getAIResponse(userMessage || 'What do you see?', 'discord', channelId, username, images);
        await safeDiscordReply(message, response);
        logCommand('discord', username, '@mention (image analysis)', userMessage, response);
        return;
    }

    // Standard AI response
    const response = await getAIResponse(userMessage, 'discord', channelId, username);
    await safeDiscordReply(message, response);
    logCommand('discord', username, '@mention', userMessage, response);
});