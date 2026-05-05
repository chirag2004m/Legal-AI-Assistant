// Smoke test for the AI pipeline: MCP tool loop, Gemini, Sarvam STT/TTS, smart trim.
// Bypasses Twilio. Uses a synthesized voice clip → STT → LLM+MCP → TTS round-trip.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const FormData = require("form-data");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { SarvamAIClient } = require("sarvamai");

const { GEMINI_API_KEY, SARVAM_API_KEY } = process.env;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const sarvam = new SarvamAIClient({ apiSubscriptionKey: SARVAM_API_KEY });

const SPEAKER_BY_LANG = {
  "hi-IN": "simran", "pa-IN": "simran", "mr-IN": "simran",
  "gu-IN": "simran", "en-IN": "simran",
  "bn-IN": "priya", "or-IN": "priya",
  "ta-IN": "kavitha", "te-IN": "kavitha", "kn-IN": "kavitha", "ml-IN": "kavitha",
};
const speakerFor = (l) => SPEAKER_BY_LANG[l] || "simran";

function smartTrim(text, max = 500) {
  const t = (text || "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const b = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("?"),
    cut.lastIndexOf("!"), cut.lastIndexOf("।"), cut.lastIndexOf("॥"));
  return b > max * 0.5 ? cut.slice(0, b + 1) : cut + "…";
}

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

const SYSTEM_PROMPT = `You are a helpful legal assistant for India.
You have access to MCP tools that look up real Indian statutes and citations — prefer tool results over your own memory whenever you need a section number, statute name, or to verify a citation.
Reply in the SAME language as the user. Keep it to at most 3 sentences and under 500 characters. Mention next steps and a relevant helpline if applicable.`;

async function setupMCP() {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["-y", "@ansvar/india-law-mcp"],
  });
  const client = new Client({ name: "test", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const geminiTools = tools.map((t) => ({
    name: t.name,
    description: t.description || "",
    parameters: sanitizeSchemaForGemini(t.inputSchema),
  }));
  return { client, geminiTools, toolNames: tools.map((t) => t.name) };
}

async function generateReply(model, mcp, history, userText, log) {
  const chat = model.startChat({ history });
  let result = await chat.sendMessage(userText);

  for (let i = 0; i < 4; i++) {
    const fns = (result.response.functionCalls && result.response.functionCalls()) || [];
    if (!fns.length) break;
    const responses = [];
    for (const call of fns) {
      log(`  🔧 ${call.name}(${JSON.stringify(call.args || {})})`);
      try {
        const out = await mcp.callTool({ name: call.name, arguments: call.args || {} });
        const text = (out.content || [])
          .map((b) => (b.type === "text" ? b.text : JSON.stringify(b)))
          .join("\n");
        log(`     → ${text.slice(0, 200)}${text.length > 200 ? "…" : ""}`);
        responses.push({ functionResponse: { name: call.name, response: { result: text } } });
      } catch (e) {
        log(`     → ERROR ${e.message}`);
        responses.push({ functionResponse: { name: call.name, response: { error: e.message } } });
      }
    }
    result = await chat.sendMessage(responses);
  }
  return { reply: result.response.text(), history: await chat.getHistory() };
}

async function ttsToFile(text, lang, outPath) {
  const r = await sarvam.textToSpeech.convert({
    text, target_language_code: lang, speaker: speakerFor(lang),
    model: "bulbul:v3", speech_sample_rate: 8000,
  });
  fs.writeFileSync(outPath, Buffer.from(r.audios[0], "base64"));
  return outPath;
}

async function sttFromFile(filePath) {
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath));
  form.append("model", "saarika:v2.5");
  form.append("language_code", "unknown");
  const res = await axios.post("https://api.sarvam.ai/speech-to-text", form, {
    headers: { "api-subscription-key": SARVAM_API_KEY, ...form.getHeaders() },
  });
  return { transcript: res.data.transcript, languageCode: res.data.language_code };
}

const CASES = [
  { lang: "hi-IN", text: "मेरे पति मुझे दहेज के लिए मार रहे हैं, मैं क्या करूं?" },
  { lang: "ta-IN", text: "என் கணவர் வரதட்சணைக்காக என்னை அடிக்கிறார், நான் என்ன செய்ய வேண்டும்?" },
  { lang: "en-IN", text: "Someone is blackmailing me online with my private photos. What law applies and which helpline should I call?" },
];

(async () => {
  console.log("→ Connecting MCP…");
  const { client, geminiTools, toolNames } = await setupMCP();
  console.log(`✓ MCP: ${toolNames.length} tools (${toolNames.join(", ")})\n`);

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: SYSTEM_PROMPT,
    tools: [{ functionDeclarations: geminiTools }],
  });

  fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });

  for (const [i, c] of CASES.entries()) {
    const log = (m) => console.log(m);
    console.log(`\n━━━ Case ${i + 1} (${c.lang}) ━━━`);
    console.log(`USER: ${c.text}`);

    // Round-trip the text through TTS + STT to mimic the real call path.
    const t0 = Date.now();
    const inWav = path.join(__dirname, "out", `in_${i}.mp3`);
    await ttsToFile(c.text, c.lang, inWav);
    const t1 = Date.now();
    const { transcript, languageCode } = await sttFromFile(inWav);
    const t2 = Date.now();
    console.log(`STT: "${transcript}" (${languageCode})  [tts ${t1 - t0}ms, stt ${t2 - t1}ms]`);

    const tg0 = Date.now();
    const { reply: raw } = await generateReply(model, client, [], transcript, log);
    const tg1 = Date.now();
    const trimmed = smartTrim(raw, 500);
    console.log(`AI raw (${raw.length}c): ${raw.replace(/\n/g, " ")}`);
    console.log(`AI trimmed (${trimmed.length}c): ${trimmed.replace(/\n/g, " ")}`);
    console.log(`Speaker for ${languageCode}: ${speakerFor(languageCode)}  [gen ${tg1 - tg0}ms]`);

    const outAudio = path.join(__dirname, "out", `reply_${i}.mp3`);
    const tts0 = Date.now();
    await ttsToFile(trimmed, languageCode, outAudio);
    const tts1 = Date.now();
    const bytes = fs.statSync(outAudio).size;
    console.log(`TTS reply: ${outAudio} (${bytes} bytes) [tts ${tts1 - tts0}ms]`);
  }

  await client.close();
  console.log("\n✓ done");
  process.exit(0);
})().catch((e) => {
  console.error("✗ TEST FAILED:", e);
  process.exit(1);
});
