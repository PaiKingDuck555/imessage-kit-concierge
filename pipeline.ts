import OpenAI from "openai";

// ──────────────────────────────────────────────
// Config — loaded from .env (bun auto-loads it)
// ──────────────────────────────────────────────
const RESY_API_KEY = process.env.RESY_API_KEY!;
const RESY_AUTH_TOKEN = process.env.RESY_AUTH_TOKEN!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;

const RESY_BASE = "https://api.resy.com";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────
interface ResySearchResult {
  id: number;
  name: string;
  location: { city: string };
  cuisine: string[];
  price_range: number;
}

interface ResySlot {
  date: { start: string; end: string };
  config: { id: string; token: string; type: string };
}

type ResyAction =
  | { action: "search_venues"; params: { query: string; location: string; day: string; party_size: number } }
  | { action: "check_availability"; params: { venue_id: number; day: string; party_size: number } };

// ──────────────────────────────────────────────
// 1. Resy API helpers
// ──────────────────────────────────────────────
function resyHeaders(): Record<string, string> {
  return {
    "Authorization": `ResyAPI api_key="${RESY_API_KEY}"`,
    "X-Resy-Auth-Token": RESY_AUTH_TOKEN,
    "X-Resy-Universal-Auth": RESY_AUTH_TOKEN,
    "Content-Type": "application/json",
    "Origin": "https://resy.com",
    "Referer": "https://resy.com/",
  };
}

async function resySearchVenues(query: string, location: string, day: string, partySize: number) {
  const GEO: Record<string, { latitude: number; longitude: number }> = {
    "new york":      { latitude: 40.7128, longitude: -74.006 },
    "los angeles":   { latitude: 34.0522, longitude: -118.2437 },
    "chicago":       { latitude: 41.8781, longitude: -87.6298 },
    "san francisco": { latitude: 37.7749, longitude: -122.4194 },
    "miami":         { latitude: 25.7617, longitude: -80.1918 },
  };

  const geo = GEO[location.toLowerCase()] ?? GEO["new york"];

  const url = `${RESY_BASE}/3/venuesearch/search`;
  const body = { per_page: 5, query, types: ["venue"], geo };

  console.log(`  📡  POST ${url}`);
  console.log(`       Body: ${JSON.stringify(body)}\n`);

  const res = await fetch(url, {
    method: "POST",
    headers: resyHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resy search failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function resyCheckAvailability(venueId: number, day: string, partySize: number) {
  const params = new URLSearchParams({
    venue_id: String(venueId),
    day,
    party_size: String(partySize),
  });

  const url = `${RESY_BASE}/4/find?${params}`;
  console.log(`  📡  GET ${url}\n`);

  const res = await fetch(url, { headers: resyHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resy availability check failed (${res.status}): ${body}`);
  }
  return res.json();
}

// ──────────────────────────────────────────────
// 2. LLM — extract intent via function calling
// ──────────────────────────────────────────────
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_venues",
      description:
        "Search for restaurants on Resy by name, cuisine, or location.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Restaurant name or cuisine keyword (e.g. 'Carbone', 'Italian')",
          },
          location: {
            type: "string",
            description: "City name (e.g. 'New York', 'Los Angeles')",
          },
          day: {
            type: "string",
            description: "Date in YYYY-MM-DD format",
          },
          party_size: {
            type: "number",
            description: "Number of guests",
          },
        },
        required: ["query", "location", "day", "party_size"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_availability",
      description:
        "Check available reservation slots at a specific Resy venue.",
      parameters: {
        type: "object",
        properties: {
          venue_id: {
            type: "number",
            description: "The Resy venue ID",
          },
          day: {
            type: "string",
            description: "Date in YYYY-MM-DD format",
          },
          party_size: {
            type: "number",
            description: "Number of guests",
          },
        },
        required: ["venue_id", "day", "party_size"],
      },
    },
  },
];

async function extractIntent(message: string): Promise<ResyAction> {
  const today = new Date().toISOString().split("T")[0];

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    tools: TOOLS,
    tool_choice: "required",
    messages: [
      {
        role: "system",
        content: [
          "You are a restaurant reservation assistant.",
          "The user will give you a natural-language request about dining.",
          `Today's date is ${today}.`,
          "Call the appropriate tool to fulfill their request.",
          "If they mention a specific restaurant, use search_venues with the restaurant name.",
          'If they say "tomorrow", compute the correct YYYY-MM-DD date.',
        ].join(" "),
      },
      { role: "user", content: message },
    ],
  });

  const toolCall = completion.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall) {
    throw new Error("LLM did not produce a tool call — cannot determine action.");
  }

  const args = JSON.parse(toolCall.function.arguments);
  return { action: toolCall.function.name as ResyAction["action"], params: args };
}

// ──────────────────────────────────────────────
// 3. Format hits into a clean list
// ──────────────────────────────────────────────
function formatHits(data: any): string {
  // venuesearch/search response
  const hits: any[] = data?.search?.hits ?? [];
  if (hits.length === 0) return "  No results found.";

  return hits.map((hit: any, i: number) => {
    const name = hit.name ?? "Unknown";
    const neighborhood = hit.neighborhood ?? "";
    const city = hit.locality ?? hit.location?.name ?? "";
    const cuisine = (hit.cuisine ?? []).join(", ") || "N/A";
    const rating = hit.rating?.average?.toFixed(2) ?? "–";
    const reviews = hit.rating?.count?.toLocaleString() ?? "–";
    const price = "$".repeat(hit.price_range ?? 0) || "–";
    const venueId = hit.id?.resy ?? "–";
    const slug = hit.url_slug ?? "";

    return [
      `  ${i + 1}. ${name}`,
      `     📍 ${neighborhood}${city ? `, ${city}` : ""}`,
      `     🍽  ${cuisine}  ·  ${price}`,
      `     ⭐ ${rating} (${reviews} reviews)`,
      `     🔗 https://resy.com/cities/${slug}`,
      `     🆔 Venue ID: ${venueId}`,
    ].join("\n");
  }).join("\n\n");
}

// ──────────────────────────────────────────────
// 4. Pipeline — glue it all together
// ──────────────────────────────────────────────
async function runPipeline(message: string) {
  console.log("\n═══════════════════════════════════════════");
  console.log("  🍴 Resy Pipeline");
  console.log("═══════════════════════════════════════════\n");

  console.log(`▸ You said: "${message}"\n`);

  // --- LLM extracts structured intent ---
  console.log("▸ Thinking...");
  const intent = await extractIntent(message);
  console.log(`  Action : ${intent.action}`);
  console.log(`  Params : ${JSON.stringify(intent.params)}\n`);

  // --- Call Resy API ---
  console.log("▸ Searching Resy...\n");
  let result: any;

  switch (intent.action) {
    case "search_venues": {
      const { query, location, day, party_size } = intent.params;
      result = await resySearchVenues(query, location, day, party_size);
      break;
    }
    case "check_availability": {
      const { venue_id, day, party_size } = intent.params;
      result = await resyCheckAvailability(venue_id, day, party_size);
      break;
    }
    default:
      throw new Error(`Unknown action: ${(intent as any).action}`);
  }

  // --- Pretty-print hits ---
  console.log("═══════════════════════════════════════════");
  console.log("  Results");
  console.log("═══════════════════════════════════════════\n");
  console.log(formatHits(result));
  console.log();
}

// ──────────────────────────────────────────────
// Run — take input from CLI args
// Usage: bun run pipeline.ts "your request here"
// ──────────────────────────────────────────────
const input = process.argv.slice(2).join(" ").trim();

if (!input) {
  console.log("Usage: bun run pipeline.ts \"<your request>\"");
  console.log("  e.g. bun run pipeline.ts \"Table for 2 at Carbone in NYC tomorrow\"");
  process.exit(0);
}

runPipeline(input).catch((err) => {
  console.error("\n❌ Pipeline error:", err.message);
  process.exit(1);
});

