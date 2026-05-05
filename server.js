require("dotenv").config();
const express = require("express");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { SarvamAIClient } = require("sarvamai");
const twilio = require("twilio");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const FormData = require("form-data");
const cloudinary = require("cloudinary").v2;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── ENV ─────────────────────────────
const {
  GEMINI_API_KEY,
  SARVAM_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  PORT = 3000,
  BASE_URL,
  CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET,
  CLOUDINARY_GREETING_URL,
  CLOUDINARY_HOLD_URL,
  CLOUDINARY_ELSE_URL,
  CLOUDINARY_BYE_URL,
} = process.env;

// ── Clients ─────────────────────────
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const sarvamClient = new SarvamAIClient({
  apiSubscriptionKey: SARVAM_API_KEY,
});

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
});

// ── Per-call state (in-memory; replace with Redis for HA) ──
// callSid -> { history: [...gemini parts], files: Set, cloudinaryIds: Set, lastActivity: ms }
const calls = new Map();

function getCall(sid) {
  let c = calls.get(sid);
  if (!c) {
    c = { history: [], files: new Set(), cloudinaryIds: new Set(), lastActivity: Date.now() };
    calls.set(sid, c);
  }
  c.lastActivity = Date.now();
  return c;
}

async function cleanupCall(sid) {
  const c = calls.get(sid);
  if (!c) return;
  for (const f of c.files) {
    fs.promises.unlink(f).catch(() => {});
  }
  for (const pid of c.cloudinaryIds) {
    cloudinary.uploader
      .destroy(pid, { resource_type: "video" })
      .catch(() => {});
  }
  calls.delete(sid);
  console.log(`🧹 cleaned up ${sid}`);
}

// Safety net: drop any call we haven't heard from in 10 min (e.g. status callback not configured).
setInterval(() => {
  const now = Date.now();
  for (const [sid, c] of calls) {
    if (now - c.lastActivity > 10 * 60 * 1000) cleanupCall(sid);
  }
}, 60 * 1000);

// ── Sarvam speaker by language (bulbul:v3 — names must be from the v3 list) ──
const SPEAKER_BY_LANG = {
  "hi-IN": "simran",
  "pa-IN": "simran",
  "mr-IN": "simran",
  "gu-IN": "simran",
  "en-IN": "simran",
  "bn-IN": "priya",
  "or-IN": "priya",
  "ta-IN": "kavitha",
  "te-IN": "kavitha",
  "kn-IN": "kavitha",
  "ml-IN": "kavitha",
};
const DEFAULT_SPEAKER = "simran";
const speakerFor = (lang) => SPEAKER_BY_LANG[lang] || DEFAULT_SPEAKER;

// ── Trim reply at the last sentence boundary under `max` chars ──
function smartTrim(text, max = 500) {
  const t = (text || "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const boundary = Math.max(
    cut.lastIndexOf("."),
    cut.lastIndexOf("?"),
    cut.lastIndexOf("!"),
    cut.lastIndexOf("।"),
    cut.lastIndexOf("॥")
  );
  return boundary > max * 0.5 ? cut.slice(0, boundary + 1) : cut + "…";
}

// ── Prompt ──────────────────────────
const SYSTEM_PROMPT = `You are a helpful legal assistant for India.
You have access to MCP tools that look up real Indian statutes and citations — prefer tool results over your own memory whenever you need a section number, statute name, or to verify a citation.
Reply in the SAME language as the user. Keep it to at most 3 sentences and under 500 characters. Mention next steps and a relevant helpline if applicable.`;

// ── MCP wiring (india-law-mcp via stdio) ──
let mcpClient = null;
let mcpToolNames = new Set();
let geminiTools = [];

async function setupMCP() {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/stdio.js"
  );

  // Spawn the india-law-mcp server. `npx` will fetch and cache the package the first time.
  const transport = new StdioClientTransport({
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["-y", "@ansvar/india-law-mcp"],
  });

  const client = new Client(
    { name: "voice-legal-assistant", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);
  const { tools } = await client.listTools();

  // Convert MCP tool schemas → Gemini function declarations.
  geminiTools = tools.map((t) => ({
    name: t.name,
    description: t.description || "",
    parameters: sanitizeSchemaForGemini(t.inputSchema),
  }));
  mcpToolNames = new Set(tools.map((t) => t.name));
  mcpClient = client;
  console.log(
    `🔌 MCP connected: ${tools.length} tools (${tools.map((t) => t.name).join(", ")})`
  );
}

// Gemini function declarations accept a subset of JSON schema. Drop unsupported keys.
function sanitizeSchemaForGemini(schema) {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  const allowed = ["type", "properties", "required", "items", "enum", "description", "format"];
  const out = {};
  for (const k of allowed) if (k in schema) out[k] = schema[k];
  if (out.properties) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([k, v]) => [k, sanitizeSchemaForGemini(v)])
    );
  }
  if (out.items) out.items = sanitizeSchemaForGemini(out.items);
  if (!out.type) out.type = "object";
  return out;
}

async function callMCPTool(name, args) {
  const out = await mcpClient.callTool({ name, arguments: args || {} });
  // Flatten content blocks into a single string for the model.
  return (out.content || [])
    .map((b) => (b.type === "text" ? b.text : JSON.stringify(b)))
    .join("\n");
}

// ── LLM call with tool loop ─────────
async function generateReply(history, userText) {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: SYSTEM_PROMPT,
    tools: geminiTools.length ? [{ functionDeclarations: geminiTools }] : undefined,
  });

  const chat = model.startChat({ history });
  let result = await chat.sendMessage(userText);

  for (let i = 0; i < 4; i++) {
    const fns = (result.response.functionCalls && result.response.functionCalls()) || [];
    if (!fns.length) break;

    const responses = [];
    for (const call of fns) {
      try {
        const text = await callMCPTool(call.name, call.args || {});
        responses.push({
          functionResponse: { name: call.name, response: { result: text } },
        });
      } catch (e) {
        responses.push({
          functionResponse: { name: call.name, response: { error: e.message } },
        });
      }
    }
    result = await chat.sendMessage(responses);
  }

  return { reply: result.response.text(), newHistory: await chat.getHistory() };
}

// ── Routes ──────────────────────────
app.post("/incoming-call", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.play(CLOUDINARY_GREETING_URL);
  twiml.record({
    action: `${BASE_URL}/process-recording`,
    method: "POST",
    maxLength: 20,
    playBeep: true,
  });
  res.type("text/xml").send(twiml.toString());
});

app.post("/process-recording", async (req, res) => {
  const recordingUrl = req.body.RecordingUrl;
  const callSid = req.body.CallSid;
  getCall(callSid);

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.play(CLOUDINARY_HOLD_URL);
  twiml.pause({ length: 25 });
  res.type("text/xml").send(twiml.toString());

  processRecording(recordingUrl, callSid).catch((err) =>
    console.error("processRecording error:", err)
  );
});

// Configure this URL in Twilio Console → Phone Number → Voice → "Call status changes".
app.post("/call-status", async (req, res) => {
  const { CallSid, CallStatus } = req.body;
  console.log(`☎️ ${CallSid} → ${CallStatus}`);
  if (["completed", "failed", "busy", "no-answer", "canceled"].includes(CallStatus)) {
    await cleanupCall(CallSid);
  }
  res.sendStatus(200);
});

// ── MAIN PIPELINE ───────────────────
async function processRecording(recordingUrl, callSid) {
  const c = getCall(callSid);
  let inputPath, outputPath;

  try {
    // 1. Download audio
    const audioRes = await axios.get(`${recordingUrl}.mp3`, {
      responseType: "arraybuffer",
      auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN },
    });

    inputPath = path.join(__dirname, "audio", `${callSid}_input.mp3`);
    fs.mkdirSync(path.join(__dirname, "audio"), { recursive: true });
    fs.writeFileSync(inputPath, Buffer.from(audioRes.data));
    c.files.add(inputPath);

    // 2. STT
    const { transcript, languageCode } = await transcribeWithSarvam(inputPath);
    console.log("📝 User:", transcript, `(${languageCode})`);

    // input audio no longer needed
    await fs.promises.unlink(inputPath).catch(() => {});
    c.files.delete(inputPath);

    if (!transcript || transcript.trim().length < 2) {
      await twilioClient.calls(callSid).update({
        twiml: `<Response><Play>${CLOUDINARY_BYE_URL}</Play><Hangup/></Response>`,
      });
      await cleanupCall(callSid);
      return;
    }

    // 3+4. LLM with MCP tool loop
    const { reply: rawReply, newHistory } = await generateReply(c.history, transcript);
    c.history = newHistory;

    const reply = smartTrim(rawReply, 500);
    console.log("🤖 AI:", reply);

    // 5. TTS — speaker chosen per detected language
    const tts = await sarvamClient.textToSpeech.convert({
      text: reply,
      target_language_code: languageCode || "hi-IN",
      speaker: speakerFor(languageCode || "hi-IN"),
      model: "bulbul:v3",
      speech_sample_rate: 8000,
    });
    const outputBuffer = Buffer.from(tts.audios[0], "base64");

    // 6. Upload to Cloudinary (overwrite same public_id each turn)
    outputPath = path.join(__dirname, "audio", `${callSid}.mp3`);
    fs.writeFileSync(outputPath, outputBuffer);
    c.files.add(outputPath);

    const publicId = `call_${callSid}`;
    const upload = await cloudinary.uploader.upload(outputPath, {
      resource_type: "video",
      public_id: publicId,
      overwrite: true,
      format: "mp3",
    });
    c.cloudinaryIds.add(publicId);

    // local file no longer needed once Cloudinary has it
    await fs.promises.unlink(outputPath).catch(() => {});
    c.files.delete(outputPath);

    const audioUrl = upload.secure_url;

    // 7. Loop
    await twilioClient.calls(callSid).update({
      twiml: `<Response>
        <Play>${audioUrl}</Play>
        <Pause length="2"/>
        <Play>${CLOUDINARY_ELSE_URL}</Play>
        <Record action="${BASE_URL}/process-recording" method="POST" maxLength="7" playBeep="false"/>
        <Play>${CLOUDINARY_BYE_URL}</Play>
      </Response>`,
    });
  } catch (err) {
    console.error("❌ ERROR:", err.message);
    if (inputPath) await fs.promises.unlink(inputPath).catch(() => {});
    if (outputPath) await fs.promises.unlink(outputPath).catch(() => {});
    try {
      await twilioClient.calls(callSid).update({
        twiml: `<Response><Play>${CLOUDINARY_BYE_URL}</Play></Response>`,
      });
    } catch {}
    await cleanupCall(callSid);
  }
}

// ── STT ─────────────────────────────
async function transcribeWithSarvam(filePath) {
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath));
  form.append("model", "saarika:v2.5");
  form.append("language_code", "unknown");

  const res = await axios.post("https://api.sarvam.ai/speech-to-text", form, {
    headers: {
      "api-subscription-key": SARVAM_API_KEY,
      ...form.getHeaders(),
    },
  });
  return { transcript: res.data.transcript, languageCode: res.data.language_code };
}

// ── Start ───────────────────────────
(async () => {
  try {
    await setupMCP();
  } catch (e) {
    console.warn("⚠️ MCP setup failed, running without tools:", e.message);
  }
  app.listen(PORT, () => console.log(`🚀 Running on ${PORT}`));
})();
