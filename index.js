const { Client, Events, GatewayIntentBits } = require('discord.js');
const tmi = require('tmi.js');
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
                    **IMPORTANT: Keep all twitch chat responses under 400 characters total. Be punchy and concise - Twitch chat moves fast!**
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

// Twitch client configuration
const twitchClient = new tmi.Client({
    options: { debug: true },
    identity: {
        username: process.env.TWITCH_BOT_USERNAME,
        password: process.env.TWITCH_OAUTH_TOKEN
    },
    channels: [process.env.TWITCH_CHANNEL]
});

// Connect to Twitch
twitchClient.connect().catch(console.error);

// When connected to Twitch
twitchClient.on('connected', (address, port) => {
    console.log(`Connected to Twitch chat at ${address}:${port}`);
});

async function sendTwitchMessage(channel, text, delayMs = 1500) {
    return new Promise((resolve) => {
        twitchClient.say(channel, text);
        setTimeout(resolve, delayMs);
    });
}

// Listen to Twitch chat messages
twitchClient.on('message', async (channel, tags, message, self) => {
    // Ignore messages from the bot itself
    if (self) return;

    console.log(`[TWITCH] ${tags.username}: ${message}`);

    //Gives a link to this code
    if (message.toLowerCase().includes('!code') || message.toLowerCase().includes('!github')) {
        twitchClient.say(channel, 'Check out my code! 🤖 https://github.com/BirdTruther/Birds-Server-AI-Bot');
        return;
    }
    
    //Auto dungeon join
    if (tags.username.toLowerCase() === 'tangiabot' && 
    (message.toLowerCase().includes('started a tangia dungeon') || 
     message.toLowerCase().includes('started a tangia boss fight')) && 
    message.toLowerCase().includes('!join')) {
    // Wait 1 second then auto-join
    setTimeout(() => {
        twitchClient.say(channel, '!join');
        console.log('[DUNGEON/BOSS] Auto-joined!');
    }, 1000);
    return;
}
    
    // Meme feature for Twitch
    if (message.toLowerCase().includes('meme')) {
        try {
            const response = await fetch('https://meme-api.com/gimme');
            const data = await response.json();
            if (data && data.url) {
                twitchClient.say(channel, `${data.title} ${data.url}`);
            } else {
                twitchClient.say(channel, 'Could not fetch a meme right now. Try again later.');
            }
        } catch (err) {
            twitchClient.say(channel, 'Error fetching meme!');
        }
        return;
    }

    // If bot is mentioned (using @BotName or !patrick)
    if (message.toLowerCase().includes('@' + process.env.TWITCH_BOT_USERNAME.toLowerCase()) || 
        message.toLowerCase().startsWith('!patrick')) {
        
        const response = await completion(message);
        
        // Twitch has a 500 character limit per message
        // Split into chunks if needed and send with delay
        if (response.length > 480) {
            // Split at sentence boundaries for cleaner messages
            const sentences = response.match(/[^.!?]+[.!?]+/g) || [response];
            let currentChunk = '';
            
            for (const sentence of sentences) {
                // If adding this sentence would exceed limit, send current chunk
                if ((currentChunk + sentence).length > 480) {
                    if (currentChunk) {
                        await sendTwitchMessage(channel, currentChunk.trim(), 1500);
                    }
                    currentChunk = sentence;
                } else {
                    currentChunk += sentence;
                }
            }
            
            // Send remaining chunk
            if (currentChunk) {
                await sendTwitchMessage(channel, currentChunk.trim(), 1500);
            }
        } else {
            twitchClient.say(channel, response);
        }
    }
});

// initialize discord bot
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.on('ready', (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`);
});

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
