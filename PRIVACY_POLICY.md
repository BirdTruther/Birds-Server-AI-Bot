# Privacy Policy

**Birds-Server-AI-Bot**
**Last Updated: June 16, 2026**

---

## 1. Overview

This Privacy Policy describes how Birds-Server-AI-Bot ("the Bot", "we", "our") handles information when you interact with the Bot on Discord or Twitch. We are committed to being transparent about what data is collected, why, and how it is used.

## 2. Information We Collect

### 2a. Message Content

The Bot processes the content of messages that are:

- Directed at the Bot via `@mention` in Discord
- Sent as a reply to a Bot message in Discord
- Sent in Twitch channels the Bot is active in
- Submitted via slash commands (`/ask`, `/image`, etc.)

Message text is stored temporarily in a local SQLite database for **conversation memory** purposes (see Section 3).

### 2b. User Identifiers

The Bot stores:

- **Discord usernames** (display name, not user ID) — for conversation memory and command logging
- **Twitch usernames** — for conversation memory and command logging

The Bot does **not** collect or store email addresses, passwords, payment information, real names, or any other personally identifiable information beyond platform usernames.

### 2c. Images

When you send an image to the Bot for analysis:

- Images are downloaded temporarily to process your request
- Images are passed to Google Gemini AI for analysis
- Images are **not** permanently stored by the Bot
- Discord CDN URLs for Bot-generated images may be logged in the command log database for dashboard display

### 2d. Command Logs

All commands and their responses are logged to a local SQLite database. Logs include:

- Platform (Discord or Twitch)
- Username
- Command used
- Input text
- Bot response
- Timestamp

These logs are stored locally on the server running the Bot. They are accessible to the server administrator via the web dashboard. Logs older than 30 days are automatically purged.

## 3. How We Use Information

| Data | Purpose | Retention |
|---|---|---|
| Message content | AI conversation context (last 8 messages per channel) | 7 days, then auto-deleted |
| Usernames | Display in conversation context and command logs | 7 days (memory), 30 days (logs) |
| Command inputs/outputs | Dashboard command log display | 30 days, then auto-deleted |
| Images sent for analysis | Passed to Google Gemini for analysis only | Not stored |
| Generated image URLs | Dashboard display (clickable links) | 30 days with command log |

## 4. Data Sharing

The Bot shares limited data with the following third-party services to function:

- **Google Gemini AI** — Message content and images are sent to Google's API to generate AI responses. Google's [Privacy Policy](https://policies.google.com/privacy) and [AI Terms](https://ai.google.dev/terms) apply.
- **Tarkov.dev** — Item names/queries are sent for price/data lookups. No personal data is transmitted.
- **Steam Web API** — Steam usernames or SteamID64s submitted via `cs2stats` commands are sent to Valve's API. Valve's [Privacy Policy](https://store.steampowered.com/privacy_agreement/) applies.
- **CSFloat API** — CS2 inspect links submitted via `cs2float` commands are sent to CSFloat's API.
- **meme-api.com** — No personal data is sent; the Bot simply fetches a random meme.

We do **not** sell, rent, or share your data with advertisers or data brokers.

## 5. Data Storage and Security

- All data is stored locally in a SQLite database on the server where the Bot is hosted.
- The web dashboard (accessible at `localhost:3001`) is intended to be run locally or behind a firewall — it is **not** intended to be exposed publicly.
- The developer does not have access to data from self-hosted instances.
- We implement reasonable security practices, but cannot guarantee absolute security.

## 6. Data Retention

- **Conversation memory:** Messages are kept for 7 days, with a maximum of 1,000 messages per channel. Older messages are automatically deleted.
- **Command logs:** Logs are retained for up to 30 days and can be manually cleared via the dashboard (`POST /api/bot/logs/clear`).
- **Images:** Not retained. Processed in-memory only.

## 7. Your Rights

You have the right to:

- **Clear your conversation memory** at any time using `!clearmemory` or `/clearmemory` in any channel
- **Request removal** of your data by contacting the server administrator or the developer via a [GitHub issue](https://github.com/BirdTruther/Birds-Server-AI-Bot/issues)
- **Stop data collection** by not interacting with the Bot, or by asking a server administrator to remove the Bot from the server

## 8. Children's Privacy

The Bot is not directed at children under the age of 13. We do not knowingly collect data from children under 13. If you believe a child has provided personal data, please contact us via the GitHub repository.

## 9. Open Source Transparency

Birds-Server-AI-Bot is fully open-source. You can review exactly how data is collected, stored, and used by reading the source code at [https://github.com/BirdTruther/Birds-Server-AI-Bot](https://github.com/BirdTruther/Birds-Server-AI-Bot).

## 10. Changes to This Policy

This Privacy Policy may be updated at any time. The "Last Updated" date at the top of this document will reflect any changes. Continued use of the Bot after changes constitutes acceptance of the updated policy.

## 11. Contact

For privacy-related questions or data removal requests, please open an issue on the [GitHub repository](https://github.com/BirdTruther/Birds-Server-AI-Bot/issues).

---

*This policy applies to the publicly hosted instance of Birds-Server-AI-Bot operated by BirdTruther. Self-hosted instances are the responsibility of their respective operators.*
