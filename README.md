# AI Voice Legal Assistant

Free legal-aid hotline for India. The caller dials a phone number from any handset — basic phone, no smartphone, no internet, no app, no signup — and speaks naturally in their own language. The system listens, reasons over actual Indian statutes via MCP-grounded tools, and replies in the same language with the right next steps and helpline.

The goal: meet people where they already are. A phone call is the lowest-common-denominator interface in India — 100% reach, zero onboarding. Most legal aid online assumes a smartphone and English literacy, which excludes the majority of those who actually need it: rural callers, elderly callers, women in distress, migrant workers.

---

## Features

- **Phone-only, internet-free for the caller.** Works on any phone, including 10-year-old feature phones with no data plan.
- **10 Indian languages.** Hindi, Punjabi, Marathi, Gujarati, Bengali, Odia, Tamil, Telugu, Kannada, Malayalam, and Indian English. The language is auto-detected from the caller's first words; the reply uses a TTS voice matched to that language.
- **Grounded by MCP.** The model has access to [india-law-mcp](https://github.com/Ansvar-Systems/india-law-mcp), exposing 13 tools that search the Indian Code, retrieve provision text by section, validate citations, and check whether a provision is still in force. The model is instructed to prefer tool results over its own memory whenever a section number or statute is involved.
- **Multi-turn conversation.** Each call is a session — follow-up questions remember context.
- **Latency-aware design.** Sentence-boundary trimming (no mid-word cuts), short-form prompt (≤3 sentences, ≤500 chars), pre-recorded greeting/hold/bye clips served from a CDN, and a hold message that streams while the AI pipeline runs.
- **Per-call cleanup.** When the caller hangs up, in-memory history is wiped, the temporary mp3 is deleted, and the Cloudinary asset is destroyed. A 10-minute idle sweep is the safety net.

---

## Demo

https://github.com/user-attachments/assets/fc60aa08-19b6-4713-9fa3-222808e3bdfe

---

## Architecture

```
   Caller (basic phone)
        |
        |   PSTN call
        v
   +-------------+
   |   Twilio    |  <-- TwiML webhooks
   |   Voice     |
   +------+------+
          |
          v
   +-----------------------------------------------+
   |  Express server (server.js)                   |
   |                                               |
   |   POST /incoming-call     greeting + record   |
   |   POST /process-recording AI pipeline         |
   |   POST /call-status       cleanup on hangup   |
   |                                               |
   +----+------------------------------------------+
        |
        v
   +--------------+   +--------------+   +--------------+
   |  Sarvam AI   |-->|   Gemini     |-->|  Sarvam AI   |
   | saarika v2.5 |   |  2.5 Flash   |   |  bulbul v3   |
   |     STT      |   |  (function-  |   |     TTS      |
   +--------------+   |   calling)   |   +------+-------+
                      +------+-------+          |
                             |                  v
                       stdio | MCP        +--------------+
                             v            |  Cloudinary  |
                      +--------------+    | (mp3 host)   |
                      | india-law-   |    +------+-------+
                      |    mcp       |           |
                      |  13 tools    |           v
                      +--------------+    +--------------+
                                          | Twilio Play  |
                                          | back to call |
                                          +--------------+
```

---

## How it works

1. Caller dials the Twilio number.
2. Pre-recorded greeting plays (Cloudinary clip).
3. Caller speaks; Twilio records up to 20 seconds and POSTs to `/process-recording`.
4. Server replies with a hold-music TwiML and asynchronously runs the pipeline:
   - download the recording from Twilio
   - Sarvam STT (auto language detection)
   - Gemini 2.5 Flash reasons over the question, calling MCP tools as needed (up to 4 hops)
   - Sarvam TTS converts the reply to mp3 using the speaker mapped to the detected language
   - mp3 uploaded to Cloudinary
   - Twilio call updated with new TwiML: play reply, ask "any more help?", record again
5. Loop continues until the caller stays silent or hangs up.
6. On hangup, `/call-status` fires; server clears the conversation, deletes the audio file, destroys the Cloudinary asset.

---

## MCP integration

`server.js` is an MCP client (`@modelcontextprotocol/sdk`) that spawns the `india-law-mcp` server as a stdio child process at startup, lists its tools, sanitizes the JSON schemas, and registers them with Gemini as function declarations. Mid-call, Gemini can invoke any of these:

| Tool                  | Purpose                                            |
|-----------------------|----------------------------------------------------|
| `search_legislation`  | Full-text BM25 search across the Indian Code      |
| `get_provision`       | Fetch a specific section by act and number        |
| `validate_citation`   | Verify a section reference is real                |
| `build_legal_stance`  | Aggregate citations for a fact pattern            |
| `check_currency`      | Is this provision still in force, amended, or repealed |
| `format_citation`     | Format in standard Indian legal style             |
| `list_sources`        | List statutes the server covers                   |
| `about`               | Server metadata                                   |

Plus 5 EU-comparative tools (rarely used in a voice context).

If the MCP server fails to start, the main server still boots in a no-tools fallback mode.

---

## Languages and voices

| Code   | Language   | TTS speaker |
|--------|------------|-------------|
| hi-IN  | Hindi      | simran      |
| pa-IN  | Punjabi    | simran      |
| mr-IN  | Marathi    | simran      |
| gu-IN  | Gujarati   | simran      |
| en-IN  | English    | simran      |
| bn-IN  | Bengali    | priya       |
| or-IN  | Odia       | priya       |
| ta-IN  | Tamil      | kavitha     |
| te-IN  | Telugu     | kavitha     |
| kn-IN  | Kannada    | kavitha     |
| ml-IN  | Malayalam  | kavitha     |

Edit `SPEAKER_BY_LANG` in `server.js` to tune. Voice names must come from the Sarvam `bulbul:v3` set.

---

## Tech stack

- Node.js + Express
- Twilio Voice (PSTN call handling, TwiML)
- Sarvam AI — `saarika:v2.5` (STT) and `bulbul:v3` (TTS)
- Google Gemini 2.5 Flash (LLM, function-calling)
- `@ansvar/india-law-mcp` over `@modelcontextprotocol/sdk` (legal-knowledge tools)
- Cloudinary (per-call mp3 hosting)
- ngrok (local tunnel during development)

---



## Setup

### 1. Clone and install

```bash
git clone https://github.com/your-username/AI-assistant.git
cd AI-assistant
npm install
```

### 2. Configure `.env`

```env
PORT=3000
BASE_URL=https://your-tunnel-url

TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...

GEMINI_API_KEY=...
SARVAM_API_KEY=...

CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...

CLOUDINARY_GREETING_URL=...
CLOUDINARY_HOLD_URL=...
CLOUDINARY_ELSE_URL=...
CLOUDINARY_BYE_URL=...
```

### 3. Start

```bash
node server.js
```

The server will spawn `npx -y @ansvar/india-law-mcp` on first run (one-time package fetch) and log:

```
[india-law-mcp] DB opened: tier=free, caps=[...]
MCP connected: 13 tools (search_legislation, get_provision, ...)
Running on 3000
```

### 4. Expose via tunnel

```bash
ngrok http 3000
```

Set `BASE_URL` to the public ngrok URL.

### 5. Configure Twilio

Twilio Console → Phone Numbers → your number → Voice Configuration:

- **A call comes in:** `POST {BASE_URL}/incoming-call`
- **A call status changes:** `POST {BASE_URL}/call-status`

The status webhook is required for clean per-call resource cleanup.

---

## Roadmap

- Intent detection (emergency, exit)
- Optional SMS follow-up after the call with the cited section and helpline number
- Persistent caller history (Redis), keyed on phone number, with consent
- Cloud deploy (drop ngrok)
- Sub-10-second per-turn latency target
