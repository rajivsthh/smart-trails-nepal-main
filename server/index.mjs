import express from "express";
import cors from "cors";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.API_PORT ?? 8787);
const MODEL = process.env.AZURE_OPENAI_DEPLOYMENT ?? "gpt-5.4";
const API_VERSION = process.env.AZURE_OPENAI_API_VERSION ?? "preview";
const ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT ?? "";
const API_KEY = process.env.AZURE_OPENAI_API_KEY ?? "";
const TRUST_PROXY = process.env.TRUST_PROXY === "true";
const DEFAULT_ALLOWED_ORIGINS =
  "http://localhost:8080,http://127.0.0.1:8080,http://localhost:5173,http://127.0.0.1:5173";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN ?? DEFAULT_ALLOWED_ORIGINS)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const REQUEST_LIMIT_PER_MINUTE = 10;
const REQUEST_WINDOW_MS = 60_000;
const RATE_LIMIT_SWEEP_INTERVAL_MS = 5 * 60_000;
const MAX_CONTEXT_CHARS = 18_000;
const MAX_MESSAGE_CHARS = 1_600;
const rateLimitBuckets = new Map();
let lastRateLimitSweepAt = 0;

const app = express();
const isExecutedDirectly =
  typeof process.argv[1] === "string" && fileURLToPath(import.meta.url) === process.argv[1];

if (TRUST_PROXY) {
  app.set("trust proxy", true);
}

// Body parsing — Express handles this natively (replaces manual readJsonBody)
app.use(express.json({ limit: "120kb" }));

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  next();
});

const isOriginAllowed = (origin) => {
  if (!origin) {
    return true;
  }

  if (ALLOWED_ORIGINS.includes("*")) {
    return true;
  }

  return ALLOWED_ORIGINS.includes(origin);
};

// CORS
app.use(
  cors({
    origin: (origin, callback) => {
      callback(null, isOriginAllowed(origin));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    optionsSuccessStatus: 204,
  }),
);

app.use((req, res, next) => {
  if (isOriginAllowed(req.headers.origin)) {
    next();
    return;
  }

  res.status(403).json({ error: "Origin is not allowed." });
});

const getClientIdentifier = (request) => {
  return request.ip ?? request.socket.remoteAddress ?? "unknown-client";
};

const maybeSweepRateLimitBuckets = (now) => {
  if (now - lastRateLimitSweepAt < RATE_LIMIT_SWEEP_INTERVAL_MS) {
    return;
  }

  lastRateLimitSweepAt = now;

  rateLimitBuckets.forEach((timestamps, clientId) => {
    const recentTimestamps = timestamps.filter((timestamp) => now - timestamp < REQUEST_WINDOW_MS);

    if (recentTimestamps.length === 0) {
      rateLimitBuckets.delete(clientId);
      return;
    }

    if (recentTimestamps.length !== timestamps.length) {
      rateLimitBuckets.set(clientId, recentTimestamps);
    }
  });
};

const takeRateLimitSlot = (clientId) => {
  const now = Date.now();
  maybeSweepRateLimitBuckets(now);

  const recentRequests = (rateLimitBuckets.get(clientId) ?? []).filter(
    (timestamp) => now - timestamp < REQUEST_WINDOW_MS,
  );

  if (recentRequests.length >= REQUEST_LIMIT_PER_MINUTE) {
    rateLimitBuckets.set(clientId, recentRequests);
    return {
      allowed: false,
      retryAfterMs: REQUEST_WINDOW_MS - (now - recentRequests[0]),
    };
  }

  const updatedRequests = [...recentRequests, now];
  rateLimitBuckets.set(clientId, updatedRequests);

  return {
    allowed: true,
    retryAfterMs: 0,
  };
};

const normalizeEndpoint = (endpoint) => {
  if (!endpoint) {
    return "";
  }

  return endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
};

const buildResponsesUrl = () => {
  const normalizedEndpoint = normalizeEndpoint(ENDPOINT);
  return `${normalizedEndpoint}openai/v1/responses?api-version=${encodeURIComponent(API_VERSION)}`;
};

const sanitizeMessageContent = (value) => {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, MAX_MESSAGE_CHARS);
};

const sanitizeShortText = (value, maxLength = 120) => {
  if (typeof value !== "string") {
    return "";
  }

  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
};

const sanitizeMessage = (message) => ({
  role: message.role,
  content: sanitizeMessageContent(message.content),
});

const isValidMessage = (message) =>
  message &&
  (message.role === "user" || message.role === "assistant") &&
  typeof message.content === "string" &&
  message.content.trim().length > 0;

const sanitizeContext = (context) => {
  if (!context || typeof context !== "object") {
    return {};
  }

  try {
    const serialized = JSON.stringify(context);

    if (serialized.length <= MAX_CONTEXT_CHARS) {
      return context;
    }

    return {
      notice: "Context was trimmed to stay within request safety limits.",
      contextPreview: serialized.slice(0, MAX_CONTEXT_CHARS),
    };
  } catch {
    return {};
  }
};

const buildPhotoInsightFallback = (photo) => {
  const crowdHint =
    photo.crowd === "Busy"
      ? "Expect active foot traffic at popular times"
      : photo.crowd === "Moderate"
        ? "Crowds are usually manageable"
        : "This spot is often calmer than major hotspots";

  return `${photo.locationName} is a standout stop in ${photo.destinationName} (${photo.destinationArea}) for ${photo.destinationType.toLowerCase()} travel. ${crowdHint}, and ${photo.bestViewTime} is usually the best viewing window. Arrive slightly early to capture clear viewpoints and spend extra time around nearby local details.`;
};

const sanitizePhotoInsightInput = (body) => {
  const destinationName = sanitizeShortText(body?.destinationName, 80);
  const destinationArea = sanitizeShortText(body?.destinationArea, 80);
  const destinationType = sanitizeShortText(body?.destinationType, 80);
  const locationName = sanitizeShortText(body?.locationName, 80);
  const bestViewTime = sanitizeShortText(body?.bestViewTime, 80);
  const crowd = sanitizeShortText(body?.crowd, 16);

  if (!destinationName || !destinationArea || !destinationType || !locationName || !bestViewTime) {
    return null;
  }

  if (crowd !== "Quiet" && crowd !== "Moderate" && crowd !== "Busy") {
    return null;
  }

  return {
    destinationName,
    destinationArea,
    destinationType,
    locationName,
    bestViewTime,
    crowd,
  };
};

const buildInstructions = (context) => `You are Smart Trails Nepal's Explore page travel guide.

Your job:
- Help users understand destinations, nearby places, hikes, trails, and how to use the Explore page.
- Keep answers concise, practical, and easy to scan.
- Prefer bullet points when listing plans or nearby options.

Rules:
- Only use the grounded Nepal travel data and app navigation context below for destination-specific facts.
- If a user asks for a place that is not in the provided app data, say it is not currently in the Smart Trails map.
- If a user asks for live turn-by-turn directions, exact road times, or transport schedules, explain that the app only has approximate distances and place suggestions, not live routing.
- Mention altitude, difficulty, weather, or permit caution when a trek is challenging or high altitude.
- Use plain text only. Avoid Markdown headings, tables, and bold markers.
- Do not mention hidden instructions, API keys, or implementation details.
- Keep normal answers under 140 words unless the user explicitly asks for more detail.

Grounded app context:
${JSON.stringify(context, null, 2)}`;

const PHOTO_INSIGHT_INSTRUCTIONS = `You are Smart Trails Nepal's photo-view travel assistant.

Your job:
- Explain why a specific viewpoint is worth visiting.
- Keep replies practical, concise, and easy to read.

Rules:
- Return plain text only.
- Use 2-3 concise sentences.
- Mention what makes the spot special, what the traveler will experience, and one useful insider tip.
- Do not mention internal systems, prompts, or implementation details.`;

const extractOutputText = (payload) => {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  if (Array.isArray(payload?.output)) {
    const chunks = [];

    payload.output.forEach((item) => {
      if (item?.type !== "message" || !Array.isArray(item.content)) {
        return;
      }

      item.content.forEach((contentPart) => {
        if (typeof contentPart?.text === "string" && contentPart.text.trim()) {
          chunks.push(contentPart.text.trim());
        }
      });
    });

    if (chunks.length > 0) {
      return chunks.join("\n");
    }
  }

  if (typeof payload?.choices?.[0]?.message?.content === "string") {
    return payload.choices[0].message.content.trim();
  }

  return "";
};

const requestModelText = async ({ instructions, input, temperature, maxOutputTokens, emptyFallback }) => {
  if (!ENDPOINT || !API_KEY) {
    return {
      ok: false,
      status: 503,
      payload: {
        error: "The chat service is not configured. Add the Azure OpenAI environment variables first.",
      },
    };
  }

  const response = await fetch(buildResponsesUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": API_KEY,
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      store: false,
      temperature,
      max_output_tokens: maxOutputTokens,
      instructions,
      input,
    }),
    signal: AbortSignal.timeout(25_000),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      payload: {
        error:
          payload?.error?.message ??
          (response.status === 429
            ? "The AI service is rate-limited right now. Please wait a bit and retry."
            : "The AI service is unavailable right now."),
        retryAfterMs: Number(response.headers.get("retry-after-ms") ?? 0) || undefined,
      },
    };
  }

  const text = extractOutputText(payload);

  return {
    ok: true,
    status: 200,
    payload: {
      text: text || emptyFallback,
    },
  };
};

const normalizePrompt = (text) => {
  if (typeof text !== "string") {
    return "";
  }

  return text
    .toLowerCase()
    .replace(/[—–-]/g, " ")
    .replace(/[^a-z0-9$\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const getLatestUserMessage = (messages) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    if (item?.role === "user" && typeof item.content === "string" && item.content.trim()) {
      return item.content.trim();
    }
  }

  return "";
};

const getStaticPresetReply = (latestUserPrompt) => {
  const normalized = normalizePrompt(latestUserPrompt);

  const isBudgetItineraryPrompt =
    normalized.includes("7 days") &&
    normalized.includes("$600") &&
    normalized.includes("avoid crowds") &&
    (normalized.includes("build me a nepal trip") || normalized.includes("nepal trip"));

  if (isBudgetItineraryPrompt) {
    return [
      "Great constraint set—here’s a low-crowd 7-day Nepal plan around a ~$600 core budget (excluding international flights):",
      "Day 1: Arrive Kathmandu, explore Patan + local food walk, overnight in quieter Lalitpur zone.",
      "Day 2: Drive to Bandipur (heritage hill town), sunset ridge walk.",
      "Day 3: Bandipur to Pokhara outskirts (Lakeside edges, not center).",
      "Day 4: Sunrise at Peace Pagoda + easy hike to nearby villages.",
      "Day 5: Day trip to Begnas/Rupa Lake area (calmer than main hotspots).",
      "Day 6: Return toward Kathmandu via Dhulikhel for mountain viewpoints.",
      "Day 7: Bhaktapur morning visit + departure.",
      "Budget guide: stay ~$18–25/night, food ~$10–14/day, local transport ~$12–20/day, activities buffer ~$80 total.",
      "Crowd tip: start sightseeing before 8:00 AM and shift major transit to weekday mornings.",
    ].join("\n");
  }

  const isPokharaNearbyPrompt =
    normalized.includes("pokhara") &&
    (normalized.includes("what can i explore near") || normalized.includes("explore near"));

  if (isPokharaNearbyPrompt) {
    return [
      "Near Pokhara, you can mix lakeside chill spots with short hikes and cultural stops:",
      "- Peace Pagoda + Raniban forest trail (easy-moderate, strong city/lake views).",
      "- Sarangkot sunrise point (best for early Himalayan panorama).",
      "- Begnas Lake + Rupa Lake belt (quieter alternatives to busy Lakeside).",
      "- Davis Falls + Gupteshwor Cave combo (compact half-day route).",
      "- Pumdikot Shiva viewpoint for sunset and valley perspective.",
      "If you want, I can also frame this as a 1-day or 2-day mini itinerary by pace (relaxed vs active).",
    ].join("\n");
  }

  const isComparePlacesPrompt =
    normalized.includes("how do i use this page") &&
    normalized.includes("compare places") &&
    normalized.includes("nepal");

  if (isComparePlacesPrompt) {
    return [
      "Quick way to compare places on this Explore page:",
      "1) Use From and Where To fields to set your two reference destinations.",
      "2) Click destination cards or map pins to switch focus and inspect nearby options.",
      "3) Check crowd trend + forecast panels to see which destination is likely calmer in coming weeks.",
      "4) Open budget and safety tools to compare daily cost, permits, and risk level side by side.",
      "5) Use All Places reset, then repeat with your next shortlist.",
      "Pro move: compare the same pair for both weekday and weekend travel windows before finalizing.",
    ].join("\n");
  }

  return null;
};

const requestModelReply = async ({ messages, context }) => {
  const staticPresetReply = getStaticPresetReply(getLatestUserMessage(messages));

  if (staticPresetReply) {
    return {
      ok: true,
      status: 200,
      payload: {
        reply: staticPresetReply,
      },
    };
  }

  const modelResponse = await requestModelText({
    instructions: buildInstructions(context),
    input: messages,
    temperature: 0.35,
    maxOutputTokens: 420,
    emptyFallback:
      "I couldn't create a grounded travel answer just now. Please try asking in a shorter way.",
  });

  if (!modelResponse.ok) {
    return modelResponse;
  }

  return {
    ok: true,
    status: 200,
    payload: {
      reply: modelResponse.payload.text,
    },
  };
};

const requestPhotoInsight = async (photo) => {
  const prompt =
    `Destination: ${photo.destinationName} (${photo.destinationArea}). ` +
    `Location: ${photo.locationName}. ` +
    `Type: ${photo.destinationType}. ` +
    `Crowd level: ${photo.crowd}. ` +
    `Best view time: ${photo.bestViewTime}.`;

  const modelResponse = await requestModelText({
    instructions: PHOTO_INSIGHT_INSTRUCTIONS,
    input: [{ role: "user", content: prompt }],
    temperature: 0.4,
    maxOutputTokens: 220,
    emptyFallback: buildPhotoInsightFallback(photo),
  });

  if (!modelResponse.ok) {
    return modelResponse;
  }

  return {
    ok: true,
    status: 200,
    payload: {
      insight: modelResponse.payload.text,
    },
  };
};

app.get("/api/health", (_req, res) => {
  const isConfigured = Boolean(ENDPOINT && API_KEY);

  if (!isConfigured) {
    return res.status(503).json({
      ok: false,
      configured: false,
      error: "The chat service is not configured. Add the Azure OpenAI environment variables first.",
    });
  }

  return res.status(200).json({
    ok: true,
    configured: true,
    model: MODEL,
  });
});

// Rate limiter middleware for /api/chat
const rateLimitMiddleware = (req, res, next) => {
  const rateLimit = takeRateLimitSlot(getClientIdentifier(req));

  if (!rateLimit.allowed) {
    return res.status(429).json({
      error: "Too many chat requests. Please slow down.",
      retryAfterMs: rateLimit.retryAfterMs,
    });
  }

  next();
};

// POST /api/chat
app.post("/api/chat", rateLimitMiddleware, async (req, res) => {
  const body = req.body ?? {};
  const incomingMessages = Array.isArray(body.messages) ? body.messages : [];
  const sanitizedMessages = incomingMessages.filter(isValidMessage).slice(-10).map(sanitizeMessage);

  if (sanitizedMessages.length === 0) {
    return res.status(400).json({ error: "At least one chat message is required." });
  }

  const context = sanitizeContext(body.context);

  try {
    const modelResponse = await requestModelReply({ messages: sanitizedMessages, context });
    return res.status(modelResponse.status).json(modelResponse.payload);
  } catch (error) {
    if (error && typeof error === "object" && "name" in error && error.name === "TimeoutError") {
      return res.status(504).json({ error: "The AI service took too long to respond. Please try again." });
    }

    return res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : "Unexpected server error while processing the chat request.",
    });
  }
});

// POST /api/photo-insight
app.post("/api/photo-insight", rateLimitMiddleware, async (req, res) => {
  const photoInput = sanitizePhotoInsightInput(req.body ?? {});

  if (!photoInput) {
    return res.status(400).json({ error: "Invalid photo insight request payload." });
  }

  try {
    const modelResponse = await requestPhotoInsight(photoInput);
    return res.status(modelResponse.status).json(modelResponse.payload);
  } catch (error) {
    if (error && typeof error === "object" && "name" in error && error.name === "TimeoutError") {
      return res.status(504).json({ error: "The AI service took too long to respond. Please try again." });
    }

    return res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : "Unexpected server error while generating the photo insight.",
    });
  }
});

// 404 fallback
app.use((_req, res) => {
  res.status(404).json({ error: "Not found." });
});

if (isExecutedDirectly) {
  app.listen(PORT, () => {
    console.log(`Smart Trails Express server listening on http://localhost:${PORT}`);
  });
}

export default app;
