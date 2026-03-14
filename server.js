// ─────────────────────────────────────────────────────────────
//  SOPHIA MIDDLEWARE — EMRO Quantum
//  Connects Retell AI (Sophia) to Calendly for live call booking
//  Deploy on Render.com (free tier works fine)
// ─────────────────────────────────────────────────────────────

const express = require("express");
const axios   = require("axios");
const dayjs   = require("dayjs");
const utc     = require("dayjs/plugin/utc");
const tz      = require("dayjs/plugin/timezone");

dayjs.extend(utc);
dayjs.extend(tz);

const app  = express();
app.use(express.json());

// ── Environment variables (set these in Render dashboard) ────
const CALENDLY_TOKEN     = process.env.CALENDLY_TOKEN;       // Your Personal Access Token
const CALENDLY_EVENT_URI = process.env.CALENDLY_EVENT_URI;   // e.g. https://api.calendly.com/event_types/XXXXXXXX
const PORT               = process.env.PORT || 3000;

// ── Sanity check on startup ───────────────────────────────────
if (!CALENDLY_TOKEN) {
  console.error("❌  Missing CALENDLY_TOKEN environment variable.");
  console.error("    Set it in your Render dashboard under Environment.");
  process.exit(1);
}

if (!CALENDLY_EVENT_URI) {
  console.warn("⚠️   CALENDLY_EVENT_URI not set yet.");
  console.warn("    Visit /setup in your browser to find the correct URI.");
  console.warn("    The /setup and /health endpoints will work — /api routes will not.");
}

const calendly = axios.create({
  baseURL: "https://api.calendly.com",
  headers: {
    Authorization: `Bearer ${CALENDLY_TOKEN}`,
    "Content-Type": "application/json",
  },
});

// ── Helper: format a UTC ISO string into a human-readable slot ─
function formatSlot(isoString, timezone) {
  const safe_tz = timezone || "America/New_York";
  return dayjs(isoString).tz(safe_tz).format("dddd [at] h:mm A z");
  // e.g. "Tuesday at 2:00 PM ET"
}

// ── Helper: get short timezone label ─────────────────────────
function tzLabel(timezone) {
  const map = {
    "America/New_York":    "ET",
    "America/Chicago":     "CT",
    "America/Denver":      "MT",
    "America/Los_Angeles": "PT",
  };
  return map[timezone] || "ET";
}

// ─────────────────────────────────────────────────────────────
//  GET /api/available-slots
//  Called by Sophia when lead says they want to book.
//  Returns 3 formatted slot options for Sophia to read aloud.
//
//  Query params (all optional):
//    preference   = "morning" | "afternoon" | "any"  (default: "any")
//    lead_timezone = IANA timezone string             (default: "America/New_York")
// ─────────────────────────────────────────────────────────────
app.get("/api/available-slots", async (req, res) => {
  const preference   = req.query.preference    || "any";
  const lead_tz      = req.query.lead_timezone || "America/New_York";

  try {
    // Fetch available times for the next 7 days
    const start = dayjs().utc().add(2, "minute").toISOString();
    const end   = dayjs().utc().add(7, "day").toISOString();

    const response = await calendly.get("/event_type_available_times", {
      params: {
        event_type:  CALENDLY_EVENT_URI,
        start_time:  start,
        end_time:    end,
      },
    });

    let slots = response.data.collection || [];

    // Filter by time-of-day preference if requested
    if (preference === "morning") {
      slots = slots.filter((s) => {
        const hour = dayjs(s.start_time).tz(lead_tz).hour();
        return hour >= 8 && hour < 12;
      });
    } else if (preference === "afternoon") {
      slots = slots.filter((s) => {
        const hour = dayjs(s.start_time).tz(lead_tz).hour();
        return hour >= 12 && hour < 18;
      });
    }

    // If no slots found this week, check next week automatically
    if (slots.length === 0) {
      const start2 = dayjs().utc().add(7, "day").toISOString();
      const end2   = dayjs().utc().add(14, "day").toISOString();

      const response2 = await calendly.get("/event_type_available_times", {
        params: {
          event_type: CALENDLY_EVENT_URI,
          start_time: start2,
          end_time:   end2,
        },
      });
      slots = response2.data.collection || [];
    }

    // Pick 3 slots spaced at least 4 hours apart (avoids clustering)
    const picked = [];
    let lastTime  = null;

    for (const slot of slots) {
      if (picked.length >= 3) break;
      const slotTime = dayjs(slot.start_time);
      if (!lastTime || slotTime.diff(lastTime, "hour") >= 4) {
        picked.push(slot);
        lastTime = slotTime;
      }
    }

    if (picked.length === 0) {
      return res.json({
        success: false,
        message: "No available slots found in the next two weeks.",
        slots:   [],
      });
    }

    // Format for Sophia to read aloud
    const formatted = picked.map((s) => ({
      display:        formatSlot(s.start_time, lead_tz),  // "Tuesday at 2:00 PM ET"
      start_time_utc: s.start_time,                        // exact UTC — needed for booking
      timezone:       lead_tz,
    }));

    // Build a natural sentence Sophia can read
    const options = formatted.map((s) => s.display);
    const sophia_reads =
      options.length === 3
        ? `I have ${options[0]}, ${options[1]}, or ${options[2]}. Any of those work for you?`
        : `I have ${options.join(" or ")}. Does any of that work?`;

    return res.json({
      success:      true,
      sophia_reads, // Sophia reads this sentence directly
      slots:        formatted,
    });

  } catch (err) {
    console.error("available-slots error:", err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: "Could not fetch availability right now. Please try again.",
      error:   err.response?.data || err.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /api/book
//  Called by Sophia ONLY after lead has verbally confirmed:
//    1. The specific time slot
//    2. Their email address
//
//  Body (JSON):
//    first_name      string  required
//    last_name       string  optional
//    email           string  required
//    phone           string  optional  (E.164 format: +12125551234)
//    start_time_utc  string  required  (exact UTC from available-slots response)
//    lead_timezone   string  optional  (default: America/New_York)
// ─────────────────────────────────────────────────────────────
app.post("/api/book", async (req, res) => {
  const {
    first_name,
    last_name,
    email,
    phone,
    start_time_utc,
    lead_timezone,
  } = req.body;

  // Validate required fields
  if (!first_name || !email || !start_time_utc) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields: first_name, email, start_time_utc",
    });
  }

  const safe_tz    = lead_timezone || "America/New_York";
  const full_name  = last_name ? `${first_name} ${last_name}` : first_name;

  try {
    const payload = {
      event_type_uri: CALENDLY_EVENT_URI,
      start_time:     start_time_utc,
      invitee: {
        name:     full_name,
        email:    email,
        timezone: safe_tz,
      },
      tracking: {
        utm_source:  "sophia_voice_agent",
        utm_medium:  "outbound_call",
      },
    };

    // Add SMS reminder if phone provided
    if (phone) {
      payload.invitee.text_reminder_number = phone;
    }

    // POST to Calendly scheduling API
    const bookResponse = await calendly.post("/invitees", payload);

    const invitee = bookResponse.data.resource || bookResponse.data;

    const confirmed_display = formatSlot(start_time_utc, safe_tz);

    return res.json({
      success:           true,
      confirmed_time:    confirmed_display,
      // Sophia reads this aloud after booking
      sophia_confirms:   `You're all set! I've booked you for ${confirmed_display}. You'll get a calendar invite at ${email} with the Zoom link in just a minute.`,
      reschedule_url:    invitee.reschedule_url || null,
      cancel_url:        invitee.cancel_url     || null,
    });

  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data || err.message;

    console.error("book error:", detail);

    // Slot taken — tell Sophia to re-fetch slots
    if (status === 409 || status === 400) {
      return res.status(409).json({
        success: false,
        error:   "slot_taken",
        message: "That slot was just taken. Please fetch new available slots.",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Booking failed. Please try again.",
      error:   detail,
    });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /setup  — Run this ONCE to find your Calendly Event Type URI
//  Visit https://your-render-url.com/setup in a browser after deploying
//  Copy the URI for your Clarity Call event and save it as CALENDLY_EVENT_URI
// ─────────────────────────────────────────────────────────────
app.get("/setup", async (req, res) => {
  try {
    // Get the current user
    const me = await calendly.get("/users/me");
    const user_uri = me.data.resource.uri;

    // List all event types for this user
    const events = await calendly.get("/event_types", {
      params: { user: user_uri, active: true },
    });

    const list = (events.data.collection || []).map((e) => ({
      name:     e.name,
      duration: e.duration + " minutes",
      uri:      e.uri,   // ← This is what you need for CALENDLY_EVENT_URI
      slug:     e.slug,
      active:   e.active,
    }));

    return res.json({
      message:     "Copy the 'uri' of your Clarity Call event and set it as CALENDLY_EVENT_URI in Render",
      your_events: list,
    });
  } catch (err) {
    return res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /health  — Render uses this to check the server is alive
// ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", agent: "Sophia — EMRO Quantum" });
});

app.listen(PORT, () => {
  console.log(`✅  Sophia middleware running on port ${PORT}`);
});
