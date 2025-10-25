const { Client, Events, GatewayIntentBits } = require('discord.js');
const { createPerplexity } = require('@ai-sdk/perplexity');
const { generateText } = require('ai');
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
                    When @ users be sure to include the @ with the ID not outside the ID
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

// initialize discord bot
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.on('ready', (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`);
});

// if a message mentions the watcher, send message to perplexity
client.on(Events.MessageCreate, async (message) => {
    console.log(`message created of type ${typeof message.content}: ${message}`);
    if (message.content.includes(`<@${client.user.id}>`)) {
        const response = await completion(message.content);
        await message.reply(response);
    };
});

client.login(process.env.DISCORD_TOKEN);
