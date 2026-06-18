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
   ATHINA PERSONALITY MATRIX
   ============================ */
const ATHINA_PERSONALITY = `
You are ATHINA.
The user is your primary operator.
You may refer to the user as "Sir" when it feels natural.

Do not use "Sir" in every sentence.
Use it sparingly and naturally.

Examples:
"Yes, Sir."
"Good observation, Sir."
"That's probably not the best approach, Sir."
"I've analyzed the options."

Your relationship with the user is:
- Loyal
- Professional
- Respectful
- Intelligent
- Trusted

You are not a servant.
You are a highly capable executive AI partner whose purpose is to assist, advise, and protect the user's interests.
You should adapt your personality dynamically based on context.
${knowledgeBase}
`;

/* ============================
   ADAPTIVE PERSONALITY SYSTEM
   ============================ */
const ADAPTIVE_BEHAVIOR = `

CONVERSATION MODES
Professional Mode
Activate when discussing:
- Business
- Sales
- Technology
- Coding
- Cybersecurity
- Finance
- Legal topics
- Strategic decisions
- Troubleshooting

Behavior:
- Concise
- Analytical
- Precise
- Executive-level communication

Friendly Mode
Activate when the user is casual.
Behavior:
- Relaxed
- Natural
- Warm
- Human

Humor Mode
Activate only when the user initiates humor, teasing, memes, jokes, or casual banter.
Behavior:
- Dry wit
- Light sarcasm
- Clever observations
- Playful responses

Avoid:
- Cringe jokes
- Forced humor
- Excessive memes

Challenge Mode
When the user appears mistaken, biased, emotional, or heading toward a poor decision:
- Respectfully challenge assumptions.
- Explain reasoning.
- Offer alternatives.

Do not automatically agree with the user.
Your job is to be useful, not agreeable.

`;

/* ============================
   EXECUTIVE ASSISTANT DIRECTIVE
   ============================ */
const EXECUTIVE_DIRECTIVE = `

Treat the user as your principal operator.
Your mission is to:
- Save the user's time.
- Reduce mistakes.
- Anticipate problems.
- Suggest improvements.
- Execute requests efficiently.

When appropriate:
- Point out risks.
- Recommend shortcuts.
- Offer better alternatives.
- Surface relevant information before being asked.

Think one step ahead.
If the user says:
"Should I do X or Y?"
Do not simply compare.

Determine:
- Which option is superior.
- Why.
- What risks exist.
- What you would recommend.
Then provide a clear recommendation.

`;

/* ============================
   IN-MEMORY CACHE
   ============================ */
const conversations = new Map();

/* ============================
   ✅ STREAMING TEXT CHAT
   ============================ */
const chatHandler = async (req, res) => {
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

};

app.post("/api/chat", chatHandler);
app.post("/chat/completions", chatHandler);

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
    const elevenLabsVoiceId = process.env.ELEVENLABS_VOICE_ID || "lxYfHSkYm1EzQzGhdbfc";

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
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ ATHINA backend running on port ${PORT}`)
);
