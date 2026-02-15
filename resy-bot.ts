import { IMessageSDK } from "./src";
import OpenAI from "openai";

// ──────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────
const RESY_API_KEY = process.env.RESY_API_KEY!;
const RESY_AUTH_TOKEN = process.env.RESY_AUTH_TOKEN!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const RESY_BASE = "https://api.resy.com";
const MY_ID = process.env.MY_PHONE ?? process.env.MY_EMAIL ?? "";

const DEFAULT_GEO = { latitude: 40.7128, longitude: -74.006 };

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────
interface Venue { id: number; name: string; neighborhood: string; city: string; cuisine: string[]; rating: number; reviews: number; price: number }
interface Slot { start: string; end: string; type: string; token: string }
interface SearchParams { query: string; location: string; lat: number; lng: number; day: string; party_size: number }

type Step = "idle" | "venue_list" | "slot_list" | "confirm";

interface State {
  step: Step;
  search?: SearchParams;
  venues?: Venue[];
  pickedVenue?: Venue;
  slots?: Slot[];
  pickedSlot?: Slot;
  bookToken?: string;
  bookExpires?: Date;
}

let state: State = { step: "idle" };
function reset() { state = { step: "idle" }; }

// ──────────────────────────────────────────────
// Resy API
// ──────────────────────────────────────────────
function resyHeaders(): Record<string, string> {
  return {
    Authorization: `ResyAPI api_key="${RESY_API_KEY}"`,
    "X-Resy-Auth-Token": RESY_AUTH_TOKEN,
    "X-Resy-Universal-Auth": RESY_AUTH_TOKEN,
    "Content-Type": "application/json",
    Origin: "https://resy.com",
    Referer: "https://resy.com/",
  };
}

async function apiSearch(query: string, location: string, lat: number, lng: number): Promise<any> {
  const geo = { latitude: lat || DEFAULT_GEO.latitude, longitude: lng || DEFAULT_GEO.longitude };
  // Resy's geo field doesn't filter by proximity — it's purely text search.
  // Append the location to the query so results are actually local,
  // and over-fetch so we can post-filter out-of-area results.
  const fullQuery = `${query} ${location}`;
  const res = await fetch(`${RESY_BASE}/3/venuesearch/search`, {
    method: "POST", headers: resyHeaders(),
    body: JSON.stringify({ per_page: 20, query: fullQuery, types: ["venue"], geo }),
  });
  if (!res.ok) throw new Error(`Resy search failed (${res.status})`);
  return res.json();
}

async function apiAvailability(venueId: number, day: string, partySize: number, lat: number, lng: number): Promise<any> {
  const params = new URLSearchParams({
    venue_id: String(venueId), day, party_size: String(partySize),
    lat: String(lat || DEFAULT_GEO.latitude), long: String(lng || DEFAULT_GEO.longitude),
  });
  const res = await fetch(`${RESY_BASE}/4/find?${params}`, { headers: resyHeaders() });
  if (!res.ok) throw new Error(`Resy availability failed (${res.status})`);
  return res.json();
}

async function apiDetails(configToken: string, day: string, partySize: number): Promise<any> {
  const res = await fetch(`${RESY_BASE}/3/details`, {
    method: "POST", headers: resyHeaders(),
    body: JSON.stringify({ commit: 1, config_id: configToken, day, party_size: partySize }),
  });
  if (!res.ok) throw new Error(`Resy details failed (${res.status})`);
  return res.json();
}

async function apiBook(bookToken: string): Promise<any> {
  const headers = resyHeaders();
  headers["Content-Type"] = "application/x-www-form-urlencoded";
  const body = new URLSearchParams({ book_token: bookToken, source_id: "resy.com-venue-details" });
  const res = await fetch(`${RESY_BASE}/3/book`, { method: "POST", headers, body: body.toString() });
  if (res.status === 402) throw new Error("PAYMENT_REQUIRED");
  if (!res.ok) { const t = await res.text(); throw new Error(`Booking failed (${res.status}): ${t}`); }
  return res.json();
}

// ──────────────────────────────────────────────
// Parsers
// ──────────────────────────────────────────────
function parseVenues(data: any, location: string): Venue[] {
  const all = (data?.search?.hits ?? []).map((h: any) => ({
    id: h.id?.resy ?? 0, name: h.name ?? "Unknown",
    neighborhood: h.neighborhood ?? "", city: h.locality ?? "",
    cuisine: h.cuisine ?? [], rating: h.rating?.average ?? 0,
    reviews: h.rating?.count ?? 0, price: h.price_range_id ?? 0,
  }));

  // Post-filter: keep only venues whose city matches the searched location.
  // Compare lowercased — "Philadelphia" matches "Philadelphia", "NYC" matches partial, etc.
  const loc = location.toLowerCase().replace(/[,.\-]/g, " ").trim();
  const locWords = loc.split(/\s+/);

  const local = all.filter((v: Venue) => {
    const vCity = (v.city + " " + v.neighborhood).toLowerCase();
    // At least one significant word from the location must appear in the venue's city/neighborhood
    return locWords.some((w: string) => w.length > 2 && vCity.includes(w));
  });

  // If filtering removed everything, fall back to unfiltered (better than no results)
  return (local.length > 0 ? local : all).slice(0, 5);
}

function parseSlots(data: any, venueId: number): Slot[] {
  const venues = data?.results?.venues ?? [];
  const v = venues.find((v: any) => v.venue?.id?.resy === venueId) ?? venues[0];
  if (!v) return [];
  return (v.slots ?? []).map((s: any) => ({
    start: s.date?.start?.split(" ")[1]?.slice(0, 5) ?? "??:??",
    end: s.date?.end?.split(" ")[1]?.slice(0, 5) ?? "??:??",
    type: s.config?.type ?? "Standard",
    token: s.config?.token ?? "",
  }));
}

// ──────────────────────────────────────────────
// Formatters
// ──────────────────────────────────────────────
function to12h(t: string): string {
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

function fmtVenueList(venues: Venue[], s: SearchParams): string {
  const header = `🍴 Top ${venues.length} · "${s.query}" in ${s.location}\n📅 ${s.day} · 👥 ${s.party_size} guests\n`;
  const lines = venues.map((v, i) => {
    const price = v.price > 0 ? " " + "$".repeat(v.price) : "";
    const cuisine = v.cuisine[0] ?? "";
    return `${i + 1}. ${v.name}${price}\n   📍 ${v.neighborhood || v.city} · ${cuisine}\n   ⭐ ${v.rating.toFixed(1)} (${v.reviews} reviews)`;
  });
  return `${header}\n${lines.join("\n\n")}\n\nReply with a number (1–${venues.length}) to see times, or type a new search.`;
}

function fmtSlotList(venue: Venue, slots: Slot[], day: string, party: number): string {
  if (slots.length === 0) return `😕 ${venue.name} has no open slots on ${day} for ${party} guests.\n\nReply with a different number, or type a new search.`;
  const display = slots.slice(0, 10);
  const lines = display.map((s, i) => `${i + 1}. ${to12h(s.start)} – ${to12h(s.end)}  (${s.type})`);
  return `🕐 ${venue.name}\n📅 ${day} · 👥 ${party} guests\n\n${lines.join("\n")}\n\nReply with a number (1–${display.length}) to book that slot.\nOr reply "back" to pick a different restaurant.`;
}

function fmtConfirm(venue: Venue, slot: Slot, day: string, party: number, payment: any, cancellation: any): string {
  const cancelPolicy = cancellation?.display?.policy?.[0] ?? "No cancellation policy listed.";
  const total = payment?.amounts?.total ?? 0;
  const payInfo = total > 0 ? `💳 Deposit: $${total.toFixed(2)}` : "💳 No deposit required";
  return `📋 Booking summary:\n\n🍴 ${venue.name}\n📅 ${day} at ${to12h(slot.start)}\n👥 ${party} guests · 🪑 ${slot.type}\n${payInfo}\n\n${cancelPolicy}\n\nReply "yes" to confirm, or "no" to go back.`;
}

function fmtSuccess(venue: Venue, slot: Slot, day: string, party: number, data: any): string {
  const token = data?.resy_token ?? "N/A";
  return `✅ You're booked!\n\n🍴 ${venue.name}\n📅 ${day} at ${to12h(slot.start)}\n👥 ${party} guests · 🪑 ${slot.type}\n🆔 ${token}\n\nEnjoy! 🎉`;
}

// ──────────────────────────────────────────────
// LLM — extract search intent (only used for initial search)
// ──────────────────────────────────────────────
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const SEARCH_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "search_venues",
    description: "Search for restaurants on Resy.",
    parameters: {
      type: "object",
      properties: {
        query:     { type: "string", description: "Restaurant name or cuisine keyword" },
        location:  { type: "string", description: "Human-readable location (e.g. 'Williamsburg, Brooklyn')" },
        latitude:  { type: "number", description: "Latitude of the location" },
        longitude: { type: "number", description: "Longitude of the location" },
        day:       { type: "string", description: "Date as YYYY-MM-DD" },
        party_size:{ type: "integer", description: "Number of guests" },
      },
      required: ["query", "location", "latitude", "longitude", "day", "party_size"],
    },
  },
};

async function extractSearch(message: string): Promise<SearchParams> {
  const today = new Date().toISOString().split("T")[0];
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini", temperature: 0,
    tools: [SEARCH_TOOL], tool_choice: "required",
    messages: [
      {
        role: "system",
        content: [
          "You are a restaurant reservation assistant.",
          `Today's date is ${today}.`,
          "Extract the search parameters from the user's message.",
          'If they say "tomorrow", compute the correct YYYY-MM-DD.',
          "Default party_size to 2 if not specified.",
          'Default location to "New York" if not specified.',
          "You MUST provide accurate latitude and longitude for the location.",
          "Examples: NYC → 40.7128, -74.006 | Williamsburg Brooklyn → 40.7081, -73.9571 | downtown LA → 34.0407, -118.2468",
        ].join(" "),
      },
      { role: "user", content: message },
    ],
  });

  const tc = completion.choices[0]?.message?.tool_calls?.[0];
  if (!tc || tc.type !== "function") throw new Error("Couldn't understand that — try something like: \"Italian in NYC tomorrow for 4\"");

  const args = JSON.parse(tc.function.arguments);
  return { query: args.query, location: args.location, lat: args.latitude, lng: args.longitude, day: args.day, party_size: args.party_size };
}

// ──────────────────────────────────────────────
// Message handler — simple step-based flow
// ──────────────────────────────────────────────
async function handleMessage(text: string): Promise<string> {
  const lower = text.toLowerCase().trim();

  // Global commands
  if (lower === "reset" || lower === "start over") {
    reset();
    return "🔄 Starting fresh! What are you looking for? (e.g. \"Italian in NYC tomorrow\")";
  }

  // ── Step: idle → search ──
  if (state.step === "idle") {
    console.log(`  🤖 Extracting search...`);
    const search = await extractSearch(text);
    console.log(`  📍 ${search.location} → (${search.lat}, ${search.lng})`);

    const data = await apiSearch(search.query, search.location, search.lat, search.lng);
    const venues = parseVenues(data, search.location);

    if (venues.length === 0) {
      return `No results for "${search.query}" in ${search.location}. Try a different search.`;
    }

    state = { step: "venue_list", search, venues };
    return fmtVenueList(venues, search);
  }

  // ── Step: venue_list → pick a venue ──
  if (state.step === "venue_list") {
    if (lower === "back") {
      reset();
      return "🔄 What would you like to search for?";
    }

    const num = parseInt(lower, 10);
    if (isNaN(num) || num < 1 || num > (state.venues?.length ?? 0)) {
      // Not a number — treat as a new search
      console.log(`  🤖 New search from venue_list...`);
      reset();
      return await handleMessage(text);
    }

    const venue = state.venues![num - 1];
    const s = state.search!;
    console.log(`  📡 Availability: ${venue.name} (${venue.id})`);

    const data = await apiAvailability(venue.id, s.day, s.party_size, s.lat, s.lng);
    const slots = parseSlots(data, venue.id);

    state = { ...state, step: "slot_list", pickedVenue: venue, slots };
    return fmtSlotList(venue, slots, s.day, s.party_size);
  }

  // ── Step: slot_list → pick a time ──
  if (state.step === "slot_list") {
    if (lower === "back") {
      state = { ...state, step: "venue_list", pickedVenue: undefined, slots: undefined };
      return fmtVenueList(state.venues!, state.search!);
    }

    const maxSlots = Math.min(state.slots?.length ?? 0, 10);
    const num = parseInt(lower, 10);

    if (isNaN(num) || num < 1 || num > maxSlots) {
      return `Pick a number from 1–${maxSlots}, say "back" to see restaurants, or type a new search.`;
    }

    const slot = state.slots![num - 1];
    const venue = state.pickedVenue!;
    const s = state.search!;
    console.log(`  📡 Details: ${venue.name} at ${slot.start}`);

    const details = await apiDetails(slot.token, s.day, s.party_size);
    const bookToken = details?.book_token?.value;
    const expires = details?.book_token?.date_expires ? new Date(details.book_token.date_expires) : undefined;

    if (!bookToken) {
      return `😕 That slot just got taken! Pick another number, or say "back".`;
    }

    state = { ...state, step: "confirm", pickedSlot: slot, bookToken, bookExpires: expires };
    return fmtConfirm(venue, slot, s.day, s.party_size, details.payment, details.cancellation);
  }

  // ── Step: confirm → book or decline ──
  if (state.step === "confirm") {
    if (lower === "no" || lower === "back") {
      state = { ...state, step: "slot_list", pickedSlot: undefined, bookToken: undefined, bookExpires: undefined };
      return `No problem!\n\n${fmtSlotList(state.pickedVenue!, state.slots!, state.search!.day, state.search!.party_size)}`;
    }

    if (lower === "yes" || lower === "confirm" || lower === "book") {
      // Check expiration
      if (state.bookExpires && new Date() > state.bookExpires) {
        state = { ...state, step: "slot_list", pickedSlot: undefined, bookToken: undefined };
        return `⏰ That hold expired. Pick a time again:\n\n${fmtSlotList(state.pickedVenue!, state.slots!, state.search!.day, state.search!.party_size)}`;
      }

      console.log(`  📡 Booking: ${state.pickedVenue!.name} at ${state.pickedSlot!.start}`);

      try {
        const result = await apiBook(state.bookToken!);
        const msg = fmtSuccess(state.pickedVenue!, state.pickedSlot!, state.search!.day, state.search!.party_size, result);
        reset();
        return msg;
      } catch (err: any) {
        if (err.message === "PAYMENT_REQUIRED") {
          const name = state.pickedVenue!.name;
          state = { ...state, step: "slot_list", pickedSlot: undefined, bookToken: undefined };
          return `💳 ${name} requires a credit card or deposit to complete the booking.\n\n👉 Head to resy.com or the Resy app to finish booking this one.\n\nWant to pick a different restaurant or time instead?`;
        }
        throw err;
      }
    }

    return `Reply "yes" to book, "no" to go back, or "reset" to start over.`;
  }

  // Fallback
  reset();
  return await handleMessage(text);
}

// ──────────────────────────────────────────────
// iMessage watcher
// ──────────────────────────────────────────────
const sdk = new IMessageSDK({
  debug: process.env.DEBUG === "true",
  watcher: { excludeOwnMessages: false, pollInterval: 2000 },
});

console.log("═══════════════════════════════════════════");
console.log("  🍴 Resy Bot");
console.log("═══════════════════════════════════════════");
console.log("  Text yourself to search restaurants.");
console.log("  Flow: search → pick restaurant → pick time → book");
console.log("  Say \"reset\" anytime to start over.");
console.log("  Watching... (Ctrl+C to stop)");
console.log("───────────────────────────────────────────\n");

const botSentTexts = new Set<string>();
const seenGuids = new Set<string>();
let processing = false;

await sdk.startWatching({
  onMessage: async (msg) => {
    if (!msg.isFromMe || !msg.text || msg.isReaction) return;
    if (MY_ID && msg.chatId && !msg.chatId.includes(MY_ID)) return;

    const text = msg.text.trim();
    if (!text) return;

    // Dedup by GUID — never process the same message twice
    if (seenGuids.has(msg.guid)) return;
    seenGuids.add(msg.guid);

    // Skip our own bot replies (exact text match)
    if (botSentTexts.has(text)) { botSentTexts.delete(text); return; }
    const prefix = text.slice(0, 200);
    for (const sent of botSentTexts) {
      if (sent.slice(0, 200) === prefix) { botSentTexts.delete(sent); return; }
    }

    // One at a time
    if (processing) return;
    processing = true;

    console.log(`\n📨 [${state.step}] "${text}"`);

    try {
      const reply = await handleMessage(text);
      botSentTexts.add(reply);
      await sdk.send(msg.chatId || msg.sender, reply);
      console.log(`  ✅ [${state.step}]`);
    } catch (err: any) {
      console.error(`  ❌ ${err.message}`);
      const errReply = `❌ Something went wrong: ${err.message}\n\nSay "reset" to start over.`;
      botSentTexts.add(errReply);
      await sdk.send(msg.chatId || msg.sender, errReply);
    } finally {
      processing = false;
    }

    console.log("───────────────────────────────────────────");
  },
});

process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  sdk.stopWatching();
  await sdk.close();
  process.exit(0);
});
