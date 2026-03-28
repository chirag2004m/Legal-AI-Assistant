

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
const geminiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

const sarvamClient = new SarvamAIClient({
  apiSubscriptionKey: SARVAM_API_KEY,
});

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ── Cloudinary ──────────────────────
cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
});

// ── Memory ──────────────────────────
const conversations = {};

// ── Prompt ──────────────────────────
const SYSTEM_PROMPT = `You are a helpful legal assistant for India. 
Explain clearly with rights violated, give next steps and helpline numbers. 
Max 3 sentences. Same language as user.`;

// ── Incoming Call ───────────────────
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

// ── Process Recording ───────────────
app.post("/process-recording", async (req, res) => {
  const recordingUrl = req.body.RecordingUrl;
  const callSid = req.body.CallSid;

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.play(CLOUDINARY_HOLD_URL);
  twiml.pause({ length: 15 });
  res.type("text/xml").send(twiml.toString());

  processRecording(recordingUrl, callSid);
});

// ── MAIN PIPELINE ───────────────────
async function processRecording(recordingUrl, callSid) {
  try {
    // 1. Download audio
    const audioRes = await axios.get(`${recordingUrl}.mp3`, {
      responseType: "arraybuffer",
      auth: {
        username: TWILIO_ACCOUNT_SID,
        password: TWILIO_AUTH_TOKEN,
      },
    });

    const inputPath = path.join(__dirname, "audio", `${callSid}_input.mp3`);
    fs.mkdirSync(path.join(__dirname, "audio"), { recursive: true });
    fs.writeFileSync(inputPath, Buffer.from(audioRes.data));

    // 2. STT
    const { transcript, languageCode } = await transcribeWithSarvam(inputPath);
    console.log("📝 User:", transcript);

    // ❗ If no speech → exit
    if (!transcript || transcript.trim().length < 2) {
      return twilioClient.calls(callSid).update({
        twiml: `<Response>
          <Play>${CLOUDINARY_BYE_URL}</Play>
          <Hangup/>
        </Response>`,
      });
    }

    // 3. Memory
    if (!conversations[callSid]) conversations[callSid] = [];
    conversations[callSid].push(`User: ${transcript}`);

    // 4. LLM
    const history = conversations[callSid].join("\n");

    const result = await geminiModel.generateContent(
      `${SYSTEM_PROMPT}\n\n${history}`
    );

    let reply = result.response.text().trim().slice(0, 300);
    console.log("🤖 AI:", reply);

    conversations[callSid].push(`AI: ${reply}`);

    // 5. TTS
    const tts = await sarvamClient.textToSpeech.convert({
      text: reply,
      target_language_code: languageCode || "hi-IN",
      speaker: "simran",
      model: "bulbul:v3",
      speech_sample_rate: 8000,
    });

    const outputBuffer = Buffer.from(tts.audios[0], "base64");

    // 6. Upload
    const outputPath = path.join(__dirname, "audio", `${callSid}.mp3`);
    fs.writeFileSync(outputPath, outputBuffer);

    const upload = await cloudinary.uploader.upload(outputPath, {
      resource_type: "video",
      public_id: `call_${callSid}`,
      overwrite: true,
      format: "mp3",
    });

    const audioUrl = upload.secure_url;

    // 7. LOOP FLOW
    await twilioClient.calls(callSid).update({
      twiml: `<Response>

        <!-- AI Response -->
        <Play>${audioUrl}</Play>
         <Pause length="2"/>

        <!-- Ask if more help needed -->
        <Play>${CLOUDINARY_ELSE_URL}</Play>

        <!-- Listen -->
        <Record 
          action="${BASE_URL}/process-recording"
          method="POST"
          maxLength="7"
          playBeep="false"
        />

        <!-- If silence -->
        <Play>${CLOUDINARY_BYE_URL}</Play>

      </Response>`,
    });

  } catch (err) {
    console.error("❌ ERROR:", err.message);

    await twilioClient.calls(callSid).update({
      twiml: `<Response>
        <Play>${CLOUDINARY_BYE_URL}</Play>
      </Response>`,
    });
  }
}

// ── STT ─────────────────────────────
async function transcribeWithSarvam(filePath) {
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath));
  form.append("model", "saarika:v2.5");
  form.append("language_code", "unknown");

  const res = await axios.post(
    "https://api.sarvam.ai/speech-to-text",
    form,
    {
      headers: {
        "api-subscription-key": SARVAM_API_KEY,
        ...form.getHeaders(),
      },
    }
  );

  return {
    transcript: res.data.transcript,
    languageCode: res.data.language_code,
  };
}

// ── Start ───────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Running on ${PORT}`);
});

