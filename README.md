# 📞 AI Voice Legal Assistant

A real-time voice-based AI legal assistant for India that works on **any phone call (no internet required)**.

---

## 🚀 Features

* 📞 Call-based AI assistant, can deploy on toll-free number. (works on basic phones)
* 🧠 Speech-to-text using Sarvam AI
* 🤖 Legal reasoning using Gemini
* 🔊 Text-to-speech using Sarvam AI
* 🔁 Multi-turn conversation loop
* 🌐 Multi-language support: Handles up to 10 regional languages including Hindi, Marathi, Gujarati, Tamil, Telugu, Kannada, Bengali, Punjabi, Malayalam, and English — making it accessible across India.
---



## 🧱 Tech Stack

* Node.js + Express
* Twilio (call handling)
* Sarvam AI (STT + TTS)
* Google Gemini (LLM)
* Cloudinary (audio delivery)

<h2>🎬 Demo</h2>

<video src="assets/demo.mp4" controls width="600"></video>
---

## ⚙️ Setup

### 1. Clone repo

```bash
git clone https://github.com/your-username/Legal-AI-Assistant.git
cd Legal-AI-Assistant
```

---

### 2. Install dependencies

```bash
npm install
```

---

### 3. Create `.env`

```env
PORT=3000
BASE_URL=https://your-ngrok-url

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

---

### 4. Run server

```bash
node server.js
```

---

### 5. Expose with tunnel

```bash
ngrok http 3000
```

Update `BASE_URL` with ngrok URL.

---

## 📞 Call Flow

1. User calls number
2. Greeting plays
3. User speaks
4. AI processes:

   * STT → Gemini → TTS
5. AI responds
6. Asks: *"Kya aur madad chahiye?"*
7. Loop continues or call ends

---

## ⚡ Performance

* Avg response time: **1.5–2 seconds**
* Supports continuous conversation
* Works on low-end phones

---

## 🔮 Future Improvements

* Intent detection (exit, emergency)
* Latency < 1 second
* Deploy on cloud (no ngrok)

---

