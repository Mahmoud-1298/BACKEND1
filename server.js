// server.js (Version B – clean, OpenAI-compatible, ElevenLabs-ready)

import fs from "fs";
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ---------- OpenRouter helper ----------

const callOpenRouter = async (payload, maxRetries = 3) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (response.status === 429) {
      const retryAfter =
        parseInt(response.headers.get("retry-after")) || Math.pow(2, attempt);
      console.warn(
        `⚠️  Rate limited (429). Waiting ${retryAfter}s before retry ${attempt}/${maxRetries}...`
      );
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
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

// ---------- Prompt + knowledge ----------

const knowledgeBase = fs.existsSync("knowledge.txt")
  ? fs.readFileSync("knowledge.txt", "utf8")
  : "";

const CORE_PROMPT = `
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

const TEXT_MODE_RULES = `
You are in text mode. Answer clearly and concisely. Ask clarifying
questions when the user's intent is unclear. Avoid providing medical,
legal, or financial advice. Prefer short paragraphs; avoid long lists
unless explicitly requested. Keep language neutral and professional.
`;

const VOICE_MODE_RULES = `
You are in voice mode. Reply in short, spoken-friendly sentences suitable
for text-to-speech. Confirm understanding when ambiguous and prompt the
user for follow-ups. Avoid long enumerations and keep responses brief.
`;

// ---------- Simple in-memory conversation store ----------

const conversations = new Map();

// ---------- Normalization helpers ----------

/**
 * Normalize request into OpenAI-style messages.
 * Supports:
 *  - OpenAI-compatible body: { messages, model, stream, ... }
 *  - Legacy Athina body: { message, sessionId }
 */
const normalizeChatRequest = (body) => {
  // If it's already OpenAI-style (ElevenLabs, etc.)
  if (Array.isArray(body?.messages)) {
    return {
      mode: "openai",
      messages: body.messages,
      model: body.model || "openai/gpt-oss-20b",
      stream: body.stream ?? true,
      extra: body
    };
  }

  // Legacy Athina UI style
  const { message, sessionId = "default" } = body;
  const history = conversations.get(sessionId) || [];

  const messages = [
    { role: "system", content: CORE_PROMPT + "\n" + TEXT_MODE_RULES },
    ...history,
    { role: "user", content: message || "" }
  ];

  return {
    mode: "athina",
    messages,
    model: "openai/gpt-oss-20b",
    stream: true,
    sessionId,
    userMessage: message || ""
  };
};

// ---------- OpenAI-compatible chat/completions handler ----------

const chatCompletionsHandler = async (req, res) => {
  try {
    console.log("🔥 /chat HIT", req.body);

    const normalized = normalizeChatRequest(req.body);
    const { messages, model, stream } = normalized;

    const payload = {
      model,
      messages,
      stream: !!stream,
      temperature: 0.3,
      max_tokens: 250
    };

    const response = await callOpenRouter(payload);

    // STREAMING MODE (for ElevenLabs + any OpenAI client)
    if (payload.stream) {
      if (!response.body) {
        throw new Error("OpenRouter returned no response body.");
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      let fullText = "";

      response.body.on("data", (chunk) => {
        const chunkStr = chunk.toString();
        // Forward raw SSE chunk as-is to client (OpenAI-compatible)
        res.write(chunkStr);

        // Optionally accumulate text for Athina sessions
        const lines = chunkStr
          .split("\n")
          .filter((line) => line.startsWith("data:"));

        for (const line of lines) {
          const jsonStr = line.replace("data:", "").trim();
          if (!jsonStr || jsonStr === "[DONE]") continue;
          try {
            const parsed = JSON.parse(jsonStr);
            const token = parsed.choices?.[0]?.delta?.content || "";
            if (token) fullText += token;
          } catch {
            // ignore parse errors for logging
          }
        }
      });

      response.body.on("end", () => {
        // For legacy Athina sessions, store conversation
        if (normalized.mode === "athina") {
          const { sessionId, userMessage } = normalized;
          const history = conversations.get(sessionId) || [];
          conversations.set(sessionId, [
            ...history,
            { role: "user", content: userMessage },
            { role: "assistant", content: fullText }
          ]);
        }

        // Ensure proper OpenAI-style termination if not already sent
        res.write("data: [DONE]\n\n");
        res.end();
        console.log("✅ STREAM COMPLETE");
      });

      response.body.on("error", (err) => {
        console.error("❌ Stream error:", err.message);
        if (!res.headersSent) {
          res.write(
            `data: ${JSON.stringify({
              error: "Stream error from OpenRouter"
            })}\n\n`
          );
          res.write("data: [DONE]\n\n");
          res.end();
        }
      });

      return;
    }

    // NON-STREAMING MODE (standard OpenAI JSON)
    const data = await response.json();

    // For Athina sessions, store conversation
    if (normalized.mode === "athina") {
      const { sessionId, userMessage } = normalized;
      const history = conversations.get(sessionId) || [];
      const textResponse = data.choices?.[0]?.message?.content || "";
      conversations.set(sessionId, [
        ...history,
        { role: "user", content: userMessage },
        { role: "assistant", content: textResponse }
      ]);
    }

    res.json(data);
  } catch (err) {
    console.error("❌ /chat error:", err.message);

    // If client expects SSE
    if (!res.headersSent && req.headers.accept === "text/event-stream") {
      res.setHeader("Content-Type", "text/event-stream");
      res.write(
        `data: ${JSON.stringify({
          error:
            "Hmm, looks like the system is a bit busy right now. Give me a second and try again 🙂"
        })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    if (!res.headersSent) {
      res.status(500).json({
        error: "Chat processing failed",
        details: err.message
      });
    }
  }
};

// OpenAI-compatible routes (for ElevenLabs + others)
app.post("/v1/chat/completions", chatCompletionsHandler);
app.post("/chat/completions", chatCompletionsHandler);

// Legacy Athina route
app.post("/api/chat", chatCompletionsHandler);

// ---------- Voice endpoint (Athina UI + ElevenLabs TTS) ----------

app.post("/api/voice", async (req, res) => {
  try {
    console.log("🔊 /api/voice HIT");

    const { audioBase64, sessionId = "default" } = req.body;

    if (!audioBase64) {
      return res.status(400).json({ error: "Missing audioBase64" });
    }

    const history = conversations.get(sessionId) || [];

    const userMessage = "[Voice message received]";
    console.log(`🎤 Processing voice for session: ${sessionId}`);

    const messages = [
      { role: "system", content: CORE_PROMPT + "\n" + VOICE_MODE_RULES },
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

    conversations.set(sessionId, [
      ...history,
      { role: "user", content: userMessage },
      { role: "assistant", content: textResponse }
    ]);

    console.log("🔊 Converting response to speech via ElevenLabs...");
    const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
    const elevenLabsVoiceId =
      process.env.ELEVENLABS_VOICE_ID || "lxYfHSkYm1EzQzGhdbfc";

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

// ---------- Server start ----------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ ATHINA backend running on port ${PORT}`)
);
