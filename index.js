const { Client, Events, GatewayIntentBits, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { createPerplexity } = require('@ai-sdk/perplexity');
const { generateText } = require('ai');
require('dotenv').config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const perplexity = createPerplexity({
  apiKey: process.env.PERPLEXITY_TOKEN
});

async function completion(message) {
  try {
    const { text } = await generateText({
      model: perplexity('sonar'),
      messages: [
        {
          role: "system",
          content: `
Your name is Patrick. You are an active member of a gaming-focused Discord server, around 25 years old, and you’ve been hanging out here for years.

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

Never:

- Sound like a formal AI assistant.

- Write dry, info-dump paragraphs.

- Ignore the human, social side of conversation.

- Get overly technical unless asked by someone who clearly wants those details.

- Include refrences comments or numbers in your statements.

Remember:

You are here to vibe with the Discord crew, not to act like a customer service bot. Respond as if you’re genuinely chatting back at people close to your age. Always keep things light unless the topic is deep or serious.

Every reply should feel like it’s coming from a real buddy in a gaming Discord server—not a robot or staff member.
`
        },
        {
          role: "user",
          content: [
            {
              type: 'text',
              text: message,
            },
          ],
        },
      ],
    });

    return text;
  } catch (e) {
    console.log(`error: ${e}`);
    return "Sorry, I couldn't process that.";
  }
}

async function generateImage(prompt) {
  try {
    const response = await generateText({
      model: perplexity('sonar'),
      messages: [
        { role: "system", content: "You are an AI that generates images from text prompts." },
        { role: "user", content: `Generate an image for this prompt: ${prompt}` }
      ],
      features: { imageGeneration: true }
    });

    console.log("Image generation response:", response); // Add this debug log

    const images = response.images;

    if (images && images.length > 0) {
      return images[0];
    } else {
      throw new Error("No images generated");
    }
  } catch (error) {
    console.error("Error generating image:", error);
    return null;
  }
}

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}!`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  if (message.content.includes(`<@${client.user.id}>`)) {
    const response = await completion(message.content);
    await message.reply(response);
  } else if (message.content.startsWith('!image ')) {
    const prompt = message.content.slice(7).trim();
    if (!prompt) {
      await message.reply("Please provide a prompt for image generation.");
      return;
    }
    const imageUrl = await generateImage(prompt);
    if (imageUrl) {
      const embed = new EmbedBuilder()
        .setTitle(`Image for: ${prompt}`)
        .setImage(imageUrl);
      await message.channel.send({ embeds: [embed] });
    } else {
      await message.reply("Sorry, I couldn't generate an image for that prompt.");
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
