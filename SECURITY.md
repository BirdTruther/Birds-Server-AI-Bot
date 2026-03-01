This project currently uses undici@6.21.3, which is affected by CVE‑2026‑22036 (GHSA‑g9mf‑h72j‑4rw9).
The bot only makes limited, trusted API calls (Discord, Twitch, AI APIs) and does not fetch arbitrary user URLs, so the practical risk is minimal for this use case.
