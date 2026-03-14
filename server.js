// ─────────────────────────────────────────────────────────────
//  SOPHIA MIDDLEWARE — EMRO Quantum
//  Connects Retell AI (Sophia) to Calendly for live call booking
//  Deploy on Render.com
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

const CALENDLY_TOKEN     = process.env.CALENDLY_TOKEN;
const CALENDLY_EVENT_URI = process.env.CALENDLY_EVENT_URI;
const PORT               = process.env.PORT || 3000;

if (!CALENDLY_TOKEN) {
  console.error("❌  Missing CALENDLY_TOKEN environment variable.");
  process.exit(1);
}

if (!CALENDLY_EVENT_URI) {
  console.warn("⚠️   CALENDLY_EVENT_URI not set yet. Visit /setup to find it.");
}

const calendly = axios.create({
  baseURL: "https://api.calendly.com",
  headers: {
    Authorization: `Bearer ${CALENDLY_TOKEN}`,
    "Content-Type": "application/json",
  },
});

function tzLabel(timezone) {
  const map = {
    "America/New_York":    "ET",
    "America/Chicago":     "CT",
    "America/Denver":      "MT",
    "America/Los_Angeles": "PT",
  };
  return map[timezone] || "ET";
}

function formatSlot(isoString, timezone) {
  const safe_tz = timezone || "America/New_York";
  return dayjs(isoString).tz(safe_tz).format("dddd [at] h:mm A") + " " + tzLabel(safe_tz);
}

// ─────────────────────────────────────────────────────────────
//  GET /setup  — find your Calendly Event Type URI
// ─────────────────────────────────────────────────────────────
app.get("/setup", async (req, res) => {
  try {
    const me     = await calendly.get("/users/me");
    const user_uri = me.data.resource.uri;
    const events = await calendly.get("/event_types", {
      params: { user: user_uri, active: true },
    });
    const list = (events.data.collection || []).map((e) => ({
      name:     e.name,
      duration: e.duration + " minutes",
      uri:      e.uri,
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
//  GET /api/available-slots
// ─────────────────────────────────────────────────────────────
app.get("/api/available-slots", async (req, res) => {
  const preference = req.query.preference    || "any";
  const lead_tz    = req.query.lead_timezone || "America/New_York";

  try {
    const start = dayjs().utc().add(2, "minute").toISOString();
    const end   = dayjs().utc().add(7, "day").toISOString();

    const response = await calendly.get("/event_type_available_times", {
      params: { event_type: CALENDLY_EVENT_URI, start_time: start, end_time: end },
    });

    let slots = response.data.collection || [];

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

    // Check next week if no slots this week
    if (slots.length === 0) {
      const start2 = dayjs().utc().add(7, "day").toISOString();
      const end2   = dayjs().utc().add(14, "day").toISOString();
      const r2     = await calendly.get("/event_type_available_times", {
        params: { event_type: CALENDLY_EVENT_URI, start_time: start2, end_time: end2 },
      });
      slots = r2.data.collection || [];
    }

    // Pick 3 slots spaced at least 4 hours apart
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
      return res.json({ success: false, message: "No available slots found.", slots: [] });
    }

    const formatted = picked.map((s) => ({
      display:        formatSlot(s.start_time, lead_tz),
      start_time_utc: s.start_time,
      timezone:       lead_tz,
    }));

    const options = formatted.map((s) => s.display);
    const sophia_reads =
      options.length === 3
        ? `I have ${options[0]}, ${options[1]}, or ${options[2]}. Any of those work for you?`
        : `I have ${options.join(" or ")}. Does any of that work?`;

    return res.json({ success: true, sophia_reads, slots: formatted });

  } catch (err) {
    console.error("available-slots error:", err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: "Could not fetch availability right now.",
      error:   err.response?.data || err.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /api/book
//  Uses Calendly Scheduling API — POST /scheduled_events/{uuid}/invitees
// ─────────────────────────────────────────────────────────────
app.post("/api/book", async (req, res) => {
  const { first_name, last_name, email, phone, start_time_utc, lead_timezone } = req.body;

  if (!first_name || !email || !start_time_utc) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields: first_name, email, start_time_utc",
    });
  }

  const safe_tz   = lead_timezone || "America/New_York";
  const full_name = last_name ? `${first_name} ${last_name}` : first_name;

  try {
    // Step 1: Find the scheduled event UUID for this exact start time
    const eventsResponse = await calendly.get("/scheduled_events", {
      params: {
        event_type:      CALENDLY_EVENT_URI,
        min_start_time:  start_time_utc,
        max_start_time:  start_time_utc,
        status:          "active",
      },
    });

    let eventUUID = null;
    const existingEvents = eventsResponse.data.collection || [];

    if (existingEvents.length > 0) {
      // Slot already has a scheduled event — get its UUID
      const eventUri = existingEvents[0].uri;
      eventUUID = eventUri.split("/").pop();
    } else {
      // Step 2: No event yet — create one via the Scheduling API
      // POST to /scheduled_events (Calendly Scheduling API)
      const createResponse = await calendly.post("/scheduled_events", {
        event_type_uri: CALENDLY_EVENT_URI,
        start_time:     start_time_utc,
      });
      const eventUri = createResponse.data.resource?.uri;
      eventUUID = eventUri ? eventUri.split("/").pop() : null;
    }

    if (!eventUUID) {
      throw new Error("Could not get event UUID from Calendly");
    }

    // Step 3: Create the invitee on the scheduled event
    const inviteePayload = {
      name:     full_name,
      email:    email,
      timezone: safe_tz,
    };

    if (phone) {
      inviteePayload.text_reminder_number = phone;
    }

    const inviteeResponse = await calendly.post(
      `/scheduled_events/${eventUUID}/invitees`,
      inviteePayload
    );

    const invitee         = inviteeResponse.data.resource || inviteeResponse.data;
    const confirmed_display = formatSlot(start_time_utc, safe_tz);

    return res.json({
      success:         true,
      confirmed_time:  confirmed_display,
      sophia_confirms: `You're all set! I've booked you for ${confirmed_display}. You'll get a calendar invite at ${email} with the Zoom link in just a minute.`,
      reschedule_url:  invitee.reschedule_url || null,
      cancel_url:      invitee.cancel_url     || null,
    });

  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data || err.message;
    console.error("book error:", JSON.stringify(detail));

    if (status === 409 || (status === 400 && JSON.stringify(detail).includes("taken"))) {
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
//  GET /health
// ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", agent: "Sophia — EMRO Quantum" });
});

app.listen(PORT, () => {
  console.log(`✅  Sophia middleware running on port ${PORT}`);
});
