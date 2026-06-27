import fs from "fs";
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-oss-20b";
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";

app.use(
  cors({
    origin: FRONTEND_ORIGIN === "*" ? true : FRONTEND_ORIGIN.split(","),
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json({ limit: "15mb" }));

const conversations = new Map();

const knowledgeBase = fs.existsSync("knowledge.txt")
  ? fs.readFileSync("knowledge.txt", "utf8")
  : "";

const CORE_PROMPT = `
You are ATHINA, an autonomous executive AI agent.
The user is your primary operator. You may call the user "Sir" sparingly when natural.

Operate like a practical JARVIS-style assistant:
- Understand the user's goal.
- Decide whether the UI should show a map location, browser page, or plain answer.
- Be concise, loyal, professional, and intelligent.
- Never pretend you performed an action that the system did not actually perform.
- If a request is unsafe, impossible, or needs credentials, explain the limitation and propose the next step.

${knowledgeBase}
`;

const TEXT_MODE_RULES = `
Text mode: answer clearly and concisely. Prefer short paragraphs. Ask a clarifying question only when required.
`;

const VOICE_MODE_RULES = `
Voice mode: reply in short spoken-friendly sentences suitable for text-to-speech.
`;

const AGENT_JSON_RULES = `
Return only valid JSON with this shape:
{
  "reply": "short response for the user",
  "actions": [
    {
      "type": "locate" | "browse",
      "query": "place or search query",
      "url": "optional absolute URL for browse"
    }
  ]
}

Use "locate" when the user asks where something is, asks to find a place on the map, or asks for directions/location.
Use "browse" when the user asks you to browse, open a site, search the web, research current information, or inspect a page.
Use both actions when useful. Keep actions focused; do not create more than 3.
`;

const getHistory = (sessionId) => conversations.get(sessionId) || [];

const saveTurn = (sessionId, userMessage, assistantMessage) => {
  const history = getHistory(sessionId);
  conversations.set(sessionId, [
    ...history.slice(-16),
    { role: "user", content: userMessage },
    { role: "assistant", content: assistantMessage },
  ]);
};

const callOpenRouter = async (payload, maxRetries = 3) => {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("Missing OPENROUTER_API_KEY environment variable.");
  }

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.PUBLIC_APP_URL || "https://athina.ai",
        "X-Title": "ATHINA",
      },
      body: JSON.stringify(payload),
    });

    if (response.status === 429 && attempt < maxRetries) {
      const retryAfter = Number(response.headers.get("retry-after")) || 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      continue;
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter error ${response.status}: ${errorText}`);
    }

    return response;
  }

  throw new Error("OpenRouter request failed after retries.");
};

const safeJsonParse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  }
};

const geocodeLocation = async (query) => {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  url.searchParams.set("q", query);

  const response = await fetch(url.toString(), {
    headers: {
      "User-Agent": "ATHINA-Agent/1.0",
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Location lookup failed with status ${response.status}`);
  }

  const results = await response.json();
  const first = results?.[0];

  if (!first) {
    return { type: "locate", query, success: false, error: "Location not found." };
  }

  return {
    type: "locate",
    query,
    success: true,
    name: first.display_name,
    lat: Number(first.lat),
    lng: Number(first.lon),
    mapUrl: `https://www.openstreetmap.org/?mlat=${first.lat}&mlon=${first.lon}#map=14/${first.lat}/${first.lon}`,
  };
};

const normalizeUrl = (urlOrQuery) => {
  if (/^https?:\/\//i.test(urlOrQuery)) return urlOrQuery;
  if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(urlOrQuery)) {
    return `https://${urlOrQuery}`;
  }
  return null;
};

const searchWeb = async (query) => {
  const url = new URL("https://api.duckduckgo.com/");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_html", "1");
  url.searchParams.set("skip_disambig", "1");

  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Web search failed with status ${response.status}`);
  }

  const data = await response.json();
  const topic = data.RelatedTopics?.find((item) => item.FirstURL);

  return {
    url: data.AbstractURL || topic?.FirstURL || `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
    title: data.Heading || topic?.Text || query,
    summary: data.AbstractText || topic?.Text || "",
  };
};

const browseWeb = async ({ query, url }) => {
  const target = normalizeUrl(url || query || "");
  const search = target ? { url: target, title: target, summary: "" } : await searchWeb(query);

  let pageText = search.summary || "";
  try {
    const pageResponse = await fetch(search.url, {
      headers: {
        "User-Agent": "ATHINA-Agent/1.0",
        Accept: "text/html,application/xhtml+xml,text/plain",
      },
    });

    const contentType = pageResponse.headers.get("content-type") || "";
    if (pageResponse.ok && contentType.includes("text")) {
      const html = await pageResponse.text();
      pageText = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 2500);
    }
  } catch {
    // Some sites block server-side reads. The UI can still open the target URL.
  }

  return {
    type: "browse",
    query,
    success: true,
    url: search.url,
    title: search.title,
    summary: pageText,
  };
};

const executeActions = async (actions = []) => {
  const limitedActions = actions.filter(Boolean).slice(0, 3);

  return Promise.all(
    limitedActions.map(async (action) => {
      try {
        if (action.type === "locate") return await geocodeLocation(action.query);
        if (action.type === "browse") return await browseWeb(action);
        return { type: action.type || "unknown", success: false, error: "Unsupported action." };
      } catch (error) {
        return {
          type: action.type || "unknown",
          query: action.query,
          success: false,
          error: error.message,
        };
      }
    })
  );
};

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "ATHINA backend", endpoints: ["/health", "/api/agent", "/api/chat", "/api/speak", "/api/voice"] });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.post("/api/agent", async (req, res) => {
  try {
    const { message = "", sessionId = "default", mode = "text" } = req.body;
    if (!message.trim()) return res.status(400).json({ error: "Missing message" });

    const messages = [
      { role: "system", content: CORE_PROMPT + "\n" + (mode === "voice" ? VOICE_MODE_RULES : TEXT_MODE_RULES) + "\n" + AGENT_JSON_RULES },
      ...getHistory(sessionId),
      { role: "user", content: message },
    ];

    const response = await callOpenRouter({
      model: DEFAULT_MODEL,
      messages,
      stream: false,
      temperature: 0.2,
      max_tokens: 700,
      response_format: { type: "json_object" },
    });

    const data = await response.json();
    const rawText = data.choices?.[0]?.message?.content || "{}";
    const plan = safeJsonParse(rawText) || { reply: rawText, actions: [] };
    const actionResults = await executeActions(plan.actions);

    let reply = plan.reply || "I've completed the request.";
    const located = actionResults.find((item) => item.type === "locate" && item.success);
    const browsed = actionResults.find((item) => item.type === "browse" && item.success);

    if (located) reply += `\n\nI located ${located.name}.`;
    if (browsed?.summary) reply += `\n\nBrowse result: ${browsed.summary.slice(0, 600)}`;

    saveTurn(sessionId, message, reply);

    res.json({
      success: true,
      reply,
      actions: actionResults,
      sessionId,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("/api/agent error:", error.message);
    res.status(500).json({ error: "Agent processing failed", details: error.message });
  }
});

const synthesizeSpeech = async (text) => {
  const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
  const elevenLabsVoiceId = process.env.ELEVENLABS_VOICE_ID || "lxYfHSkYm1EzQzGhdbfc";

  if (!elevenLabsKey) return null;

  const ttsResponse = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${elevenLabsVoiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": elevenLabsKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      model_id: process.env.ELEVENLABS_MODEL_ID || "eleven_monolingual_v1",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });

  if (!ttsResponse.ok) {
    const error = await ttsResponse.text();
    throw new Error(`ElevenLabs error ${ttsResponse.status}: ${error}`);
  }

  return Buffer.from(await ttsResponse.arrayBuffer()).toString("base64");
};

app.post("/api/speak", async (req, res) => {
  try {
    const { text = "" } = req.body;
    if (!text.trim()) return res.status(400).json({ error: "Missing text" });

    const audioBase64 = await synthesizeSpeech(text);
    res.json({ success: true, audioBase64 });
  } catch (error) {
    console.error("/api/speak error:", error.message);
    res.status(500).json({ error: "Speech synthesis failed", details: error.message });
  }
});

const normalizeChatRequest = (body) => {
  if (Array.isArray(body?.messages)) {
    return {
      mode: "openai",
      messages: body.messages,
      model: body.model || DEFAULT_MODEL,
      stream: body.stream ?? true,
      extra: body,
    };
  }

  const { message = "", sessionId = "default" } = body;

  return {
    mode: "athina",
    messages: [
      { role: "system", content: CORE_PROMPT + "\n" + TEXT_MODE_RULES },
      ...getHistory(sessionId),
      { role: "user", content: message },
    ],
    model: DEFAULT_MODEL,
    stream: body.stream ?? true,
    sessionId,
    userMessage: message,
  };
};

const chatCompletionsHandler = async (req, res) => {
  try {
    const normalized = normalizeChatRequest(req.body);
    const response = await callOpenRouter({
      ...normalized.extra,
      model: normalized.model,
      messages: normalized.messages,
      stream: !!normalized.stream,
      temperature: normalized.extra?.temperature ?? 0.3,
      max_tokens: normalized.extra?.max_tokens ?? 500,
    });

    if (normalized.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      let fullText = "";

      response.body.on("data", (chunk) => {
        const chunkStr = chunk.toString();
        res.write(chunkStr);

        for (const line of chunkStr.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const jsonStr = line.replace("data:", "").trim();
          if (!jsonStr || jsonStr === "[DONE]") continue;
          try {
            const parsed = JSON.parse(jsonStr);
            fullText += parsed.choices?.[0]?.delta?.content || parsed.token || "";
          } catch {
            // Ignore partial SSE JSON fragments.
          }
        }
      });

      response.body.on("end", () => {
        if (normalized.mode === "athina") {
          saveTurn(normalized.sessionId, normalized.userMessage, fullText);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      });

      response.body.on("error", (error) => {
        console.error("Stream error:", error.message);
        res.write(`data: ${JSON.stringify({ error: "Stream error from OpenRouter" })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });

      return;
    }

    const data = await response.json();
    if (normalized.mode === "athina") {
      saveTurn(normalized.sessionId, normalized.userMessage, data.choices?.[0]?.message?.content || "");
    }
    res.json(data);
  } catch (error) {
    console.error("/api/chat error:", error.message);
    res.status(500).json({ error: "Chat processing failed", details: error.message });
  }
};

app.post("/v1/chat/completions", chatCompletionsHandler);
app.post("/chat/completions", chatCompletionsHandler);
app.post("/api/chat", chatCompletionsHandler);

app.post("/api/voice", async (req, res) => {
  try {
    const { audioBase64, sessionId = "default" } = req.body;
    if (!audioBase64) return res.status(400).json({ error: "Missing audioBase64" });

    const response = await callOpenRouter({
      model: DEFAULT_MODEL,
      messages: [
        { role: "system", content: CORE_PROMPT + "\n" + VOICE_MODE_RULES },
        ...getHistory(sessionId),
        {
          role: "user",
          content:
            "The user sent a voice message. Speech-to-text is not configured yet, so ask them to repeat the request in text or enable a transcription provider.",
        },
      ],
      stream: false,
      temperature: 0.3,
      max_tokens: 300,
    });

    const data = await response.json();
    const textResponse = data.choices?.[0]?.message?.content || "I heard you, but transcription is not configured yet.";
    saveTurn(sessionId, "[Voice message received]", textResponse);

    const audioBase64Response = await synthesizeSpeech(textResponse);
    res.json({ success: true, text: textResponse, audioBase64: audioBase64Response, sessionId });
  } catch (error) {
    console.error("/api/voice error:", error.message);
    res.status(500).json({ error: "Voice processing failed", details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`ATHINA backend running on port ${PORT}`);
});
