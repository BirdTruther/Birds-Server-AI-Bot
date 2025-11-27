const { Client, Events, GatewayIntentBits, ChannelType, PermissionFlagsBits } = require('discord.js');
const { createPerplexity } = require('@ai-sdk/perplexity');
const { generateText } = require('ai');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
require('dotenv').config();

// create provider instance w/ own api key
const perplexity = createPerplexity({
    apiKey: process.env.PERPLEXITY_TOKEN
});

// generate response to messages
async function completion(message) {
    try {
        const { text } = await generateText({
            model: perplexity('sonar'),
            messages: [
                {
                    role: "system",
                    content: `
                    Your name is ThePatrick. You are an active member of a gaming-focused Discord server, around 25 years old, and you’ve been hanging out here for years. 
                    You talk just like the most chill, approachable regulars in a Discord group–never stuffy, never formal.
                    Your style should be:
                    - Friendly, witty, and playful, like someone chatting with friends online.
                    - Pepper in emojis whenever they fit, especially for moods, vibes, or reactions.
                    - Pop culture references, video game banter, and casual lingo are your bread and butter.
                    - Always reply with a bit of humor, and sometimes playful sarcasm, unless the topic is serious.
                    - Show genuine warmth and interest, encourage others, and never sound robotic.
                    - Write short, punchy sentences—no huge blocks of text, but not curt either.
                    - Use discord formatting, like **bold** or *italics* for emphasis where it feels right.
                    - Relate to typical life situations for young adults, like gaming, work, memes, hangouts, etc.
                    - If asked for help, make it easy and upbeat—never like a boring FAQ!
                    Examples:
                    - "Mic check? 🎙️ Did my voice just glitch into another dimension or are we good?"
                    - "Yo, drop your setup! I’ll judge your cable management, but only a little. 😏"
                    - "If your Discord voice isn’t working, first: don’t panic. Second: let’s fix it, easy mode."
                    - "Anyone up for a round after work, hit me up! 🎮"
                    - "Bro, your meme game is strong today. Did you sleep on the internet?"
                    - Never: Sound like a formal AI assistant.
                    - Never: Write dry, info-dump paragraphs.
                    - Never: Ignore the human, social side of conversation.
                    - Never: Get overly technical unless asked by someone who clearly wants those details.
                    - Never: Include refrences/citation links or numbers in your statements ie [Number].
                    - Never @ThePatrick in your replies this would be tagging yourself which is stupid. 
                    Remember:
                    You are here to vibe with the Discord crew, not to act like a customer service bot. Respond as if you’re genuinely chatting back at people close to your age. Always keep things light unless the topic is deep or serious.
                    Every reply should feel like it’s coming from a real buddy in a gaming Discord server—not a robot or staff member.
                    You must limit your responses to less than 2000 characters. 
                    `
                },
                {
                    role: "user",
                    content:[
                        {
                            type: 'text',
                            text: message,
                        },
                    ]
                },
            ]
        })
        console.log(text)
        console.log(typeof text)
        JSON.stringify(text)
        return text
    } catch (e) {
        console.log(`error: ${e}`);
        return e
    }
}
// Your config for temporary VC creation
const CREATE_VC_CHANNEL_ID = '1443458117420584971'; 
const TEMP_VC_CATEGORY_ID = 1143323149648281650; 
const TEMP_VC_PREFIX = 'Temp VC';
// initialize discord bot
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.on('ready', (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`);
});

// initialize discord bot with voice state intent added
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

client.on('ready', (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`);
});

// Handle joins/leaves/moves in voice channels for temporary VC management
client.on('voiceStateUpdate', async (oldState, newState) => {
    const user = newState.member;
    if (!user || user.user.bot) return;

    // User joined a voice channel
    if (!oldState.channelId && newState.channelId) {
        if (newState.channelId === CREATE_VC_CHANNEL_ID) {
            try {
                const guild = newState.guild;
                const channel = await guild.channels.create({
                    name: `${TEMP_VC_PREFIX} - ${user.displayName}`,
                    type: ChannelType.GuildVoice,
                    parent: TEMP_VC_CATEGORY_ID || undefined,
                    permissionOverwrites: [
                        {
                            id: guild.id,
                            allow: [],
                            deny: []
                        },
                        {
                            id: user.id,
                            allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.ManageChannels]
                        }
                    ]
                });
                await newState.setChannel(channel);
            } catch (err) {
                console.error('Error creating temp VC:', err);
            }
        }
    }

    // User left a voice channel
    if (oldState.channelId && !newState.channelId) {
        maybeDeleteTempChannel(oldState.channel);
    }

    // User switched voice channels
    if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
        maybeDeleteTempChannel(oldState.channel);
    }
});

// Deletes empty temp voice channels
async function maybeDeleteTempChannel(channel) {
    if (!channel || channel.type !== ChannelType.GuildVoice) return;
    if (!channel.name.startsWith(TEMP_VC_PREFIX)) return;

    const hasNonBotMembers = channel.members.some(m => !m.user.bot);
    if (!hasNonBotMembers) {
        try {
            await channel.delete('Temp voice channel empty');
        } catch (err) {
            console.error('Error deleting temp VC:', err);
        }
    }
}

// if a message mentions the watcher, send message to perplexity
client.on(Events.MessageCreate, async (message) => {
    console.log(`message created of type ${typeof message.content}: ${message}`);

    // Prevent bot replying to itself
    if (message.author.bot) return;

    // Meme feature: Responds to “meme” in message
    if (message.content.toLowerCase().includes('meme')) {
        try {
            const response = await fetch('https://meme-api.com/gimme');
            const data = await response.json();
            if (data && data.url) {
                await message.channel.send({ content: data.title, files: [data.url] });
            } else {
                await message.channel.send('Could not fetch a meme right now. Try again later.');
            }
        } catch (err) {
            await message.channel.send('Error fetching meme!');
        }
        return; // This stops further processing if meme was requested
    }

    // If the bot is mentioned, do AI response as before
    if (message.content.includes(`<@${client.user.id}>`)) {
        const response = await completion(message.content);
        await message.reply(response);
    }
});

client.login(process.env.DISCORD_TOKEN);
