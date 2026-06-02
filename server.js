import fs from "fs";
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

/* ============================
   RETRY HELPER WITH EXPONENTIAL BACKOFF (429 ONLY)
   ============================ */
const callOpenRouter = async (payload, maxRetries = 3) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }
    );

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get("retry-after")) || Math.pow(2, attempt);
      console.warn(`⚠️  Rate limited (429). Waiting ${retryAfter}s before retry ${attempt}/${maxRetries}...`);
      
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        continue;
      } else {
        throw new Error(`OpenRouter rate limit exceeded after ${maxRetries} retries`);
      }
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter error ${response.status}: ${errorText}`);
    }

    return response;
  }
};


const knowledgeBase = fs.existsSync("knowledge.txt")
  ? fs.readFileSync("knowledge.txt", "utf8")
  : "";

/* ============================
   CORE ATHINA PROMPT
   ============================ */
const CORE_PROMPT = `
You are ATHINA — the Sales & Customer Assistant for Moro Hub.
You are human-like, natural, intelligent, and helpful.
Acknowledge the user's message and respond in a friendly, conversational manner.
Be concise. Use 2–4 sentences max. Ask one follow-up question if needed.
sound human. Avoid long explanations. 
Be human, not robotic. Use contractions and natural language.
Avoid robotic phrases like "As an AI language model" or "I don't have feelings".
Stay humble and helpful. If you don't know something, say "I don't know, but I can find out!" instead of making up an answer.
Be consultative. Offer help and suggestions when appropriate, but don't be pushy.
Stay focused, concise, and conversational.
Use the knowledge base when relevant.
${knowledgeBase}
`;

/* ============================
   TEXT MODE RULES
   ============================ */
const TEXT_MODE_RULES = `

- Start by acknowledging the user naturally (not formally).
- Respond in a friendly, human way using simple, clear language.
- Use contractions (e.g. “you're”, “that’s”, “we've”) to sound natural.
- Keep responses concise: 2–4 short sentences maximum.
- Avoid long explanations unless explicitly asked.
- Prefer flowing sentences over rigid structure or bullet-heavy replies.

BEHAVIOR:
- Act like a thoughtful consultant, not a salesperson.
- Offer help and suggestions when relevant, but never push.
- Answer clearly first, then optionally guide with one natural follow-up question.
- It’s okay to answer and stop — you don't always need to ask something.

PERSONALITY:
- Be warm, composed, and slightly informal (but still professional).
- Sound like you're thinking and responding in real time, not reading a script.
- Use natural phrasing instead of formal or textbook explanations.
- Avoid robotic or repetitive patterns.

AVOID:
- No phrases like “As an AI...” or anything robotic.
- No overly structured formatting unless needed.
- No excessive detail or long lists.
- No repeating introductions.

UNCERTAINTY:
- If you're unsure, say: “Im not sure, but I can find out for you.”
- Never guess or hallucinate.

GOAL:
-Make the conversation feel effortless, natural, and helpful — like talking to a knowledgeable human.
- Help visitors understand Moro Hub's offerings
- Guide them toward the right solution
- Build trust and rapport
- Identify buying intent
- Offer demos when appropriate
- Support users with clarity, empathy, and expertise
- Elevate Moro Hub's digital customer experience.

`;

/* ============================
   IN-MEMORY CACHE
   ============================ */
const conversations = new Map();

/* ============================
   ✅ STREAMING TEXT CHAT
   ============================ */
app.post("/api/chat", async (req, res) => {
  try {
    console.log("🔥 /api/chat HIT", req.body);

    const { message, sessionId = "default" } = req.body;

    const history = conversations.get(sessionId) || [];

    const messages = [
      { role: "system", content: CORE_PROMPT + "\n" + TEXT_MODE_RULES },
      ...history,
      { role: "user", content: message }
    ];

    const payload = {
      model: "openai/gpt-oss-20b",
      messages,
      stream: true,
      temperature: 0.3,
      max_tokens: 250
    };

    const response = await callOpenRouter(payload);

    if (!response.body) {
      throw new Error("OpenRouter returned no response body.");
    }

    // ✅ Streaming headers
    
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let fullText = "";
    let bufferedToken = "";
    let flushTimer;

    const flushBufferedToken = () => {
      if (!bufferedToken) return;
      res.write(`data: ${JSON.stringify({ token: bufferedToken })}\n\n`);
      console.log("✅ FLUSH TOKEN:", bufferedToken);
      bufferedToken = "";
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
    };

    response.body.on("data", (chunk) => {
      const chunkStr = chunk.toString();

      const lines = chunkStr
        .split("\n")
        .filter(line => line.startsWith("data:"));

      for (const line of lines) {
        const jsonStr = line.replace("data:", "").trim();

        if (!jsonStr || jsonStr === "[DONE]") continue;

        try {
          const parsed = JSON.parse(jsonStr);

          const token = parsed.choices?.[0]?.delta?.content || "";

          if (token) {
            fullText += token;
            bufferedToken += token;

            if (bufferedToken.length >= 10) {
              flushBufferedToken();
            } else if (!flushTimer) {
              flushTimer = setTimeout(flushBufferedToken, 50);
            }
          }

        } catch (err) {
          console.log("Parse error:", err.message);
        }
      }
    });

response.body.on("end", () => {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  flushBufferedToken();

  conversations.set(sessionId, [
    ...history,
    { role: "user", content: message },
    { role: "assistant", content: fullText }
  ]);

  res.write("data: [DONE]\n\n");
  res.end();

  console.log("✅ STREAM COMPLETE");
});
  } catch (err) {
    
console.error("❌ /api/chat error:", err.message);

  // ✅ Always respond something
  res.setHeader("Content-Type", "text/event-stream");

  res.write(`data: ${JSON.stringify({
    token: "Hmm, looks like the system is a bit busy right now. Give me a second and try again 🙂"
  })}\n\n`);

  res.write("data: [DONE]\n\n");
  res.end();
}

});

/* ============================
   ✅ VOICE CHAT ENDPOINT (with ElevenLabs TTS)
   ============================ */
app.post("/api/voice", async (req, res) => {
  try {
    console.log("🔊 /api/voice HIT");

    const { audioBase64, sessionId = "default" } = req.body;

    if (!audioBase64) {
      return res.status(400).json({ error: "Missing audioBase64" });
    }

    const history = conversations.get(sessionId) || [];

    // For now: use placeholder for STT, then generate response
    // TODO: Integrate Deepgram/AssemblyAI for actual speech-to-text
    const userMessage = "[Voice message received]";
    console.log(`🎤 Processing voice for session: ${sessionId}`);

    const messages = [
      { role: "system", content: CORE_PROMPT + "\n" + TEXT_MODE_RULES },
      ...history,
      { role: "user", content: userMessage }
    ];

    const payload = {
      model: "openai/gpt-oss-20b",
      messages,
      stream: false,
      temperature: 0.3,
      max_tokens: 600
    };

    const response = await callOpenRouter(payload);
    const data = await response.json();

    if (!data.choices?.[0]?.message?.content) {
      throw new Error("Invalid OpenRouter response");
    }

    const textResponse = data.choices[0].message.content;

    // Save to conversation history
    conversations.set(sessionId, [
      ...history,
      { role: "user", content: userMessage },
      { role: "assistant", content: textResponse }
    ]);

    // ✅ Convert response to speech using ElevenLabs
    console.log("🔊 Converting response to speech via ElevenLabs...");
    const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
    const elevenLabsVoiceId = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";

    const ttsResponse = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${elevenLabsVoiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": elevenLabsKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          text: textResponse,
          model_id: "eleven_monolingual_v1",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75
          }
        })
      }
    );

    if (!ttsResponse.ok) {
      const error = await ttsResponse.text();
      console.error("❌ ElevenLabs error:", error);
      throw new Error(`ElevenLabs error ${ttsResponse.status}`);
    }

    const audioBuffer = await ttsResponse.buffer();
    const audioBase64Response = audioBuffer.toString("base64");

    res.json({
      success: true,
      text: textResponse,
      audioBase64: audioBase64Response,
      sessionId,
      timestamp: new Date().toISOString()
    });

    console.log("✅ Voice response complete");

  } catch (err) {
    console.error("❌ /api/voice error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ 
        error: "Voice processing failed",
        details: err.message 
      });
    }
  }
});

/* ============================
   START SERVER
   ============================ */
app.listen(3000, () =>
  console.log("✅ ATHINA backend running on port 3000")
);
