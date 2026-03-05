const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");
const path = require("path");
const db = require("./db");
const bcrypt = require("bcryptjs");

// Stripe is loaded for payment verification only
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 300 * 1024 * 1024 });

const PORT = process.env.PORT || 3000;
const ROOM_LIFETIME_MS = parseInt(process.env.ROOM_LIFETIME_MS, 10) || 10 * 60 * 1000; // default 10 minutes
const MAX_MESSAGE_LENGTH = 500;
const MAX_MEDIA_BYTES = 200 * 1024 * 1024; // 200 MB
const RATE_LIMIT_MESSAGES_PER_SECOND = 5;
const RATE_LIMIT_ROOMS_PER_MINUTE = 5;
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || "veryHardChallenges!1";
const TESTING_MODE = process.env.TESTING_MODE === "true";
const STRIPE_PAYMENT_LINK = process.env.STRIPE_PAYMENT_LINK || null;
const BREVO_API_KEY = process.env.BREVO_API_KEY || null;
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || "noreply@chatoffrecord.com";

// ---------------------------------------------------------------------------
// PRIVACY NOTE: Chat messages are NEVER stored or logged. The PostgreSQL
// database only stores anonymous analytics (visit counts, room creation
// counts by IP). No message content is ever persisted.
// ---------------------------------------------------------------------------

// In-memory room store: roomId -> { createdAt, timer, destroyed, permanent, sockets: Map }
const rooms = new Map();

// Rate limiting for room creation: ip -> [timestamps]
const roomCreationLog = new Map();

// Admin auth tokens (in-memory, cleared on restart)
const adminTokens = new Set();

// In-memory store for testing mode (replaces DB)
// slug -> { slug, passphrase_hash, paid }
const testPermanentRooms = new Map();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// Analytics middleware — log page visits (not static assets or API calls)
app.use((req, _res, next) => {
  if (req.method === "GET" && (req.path === "/" || req.path.startsWith("/room/") || req.path.startsWith("/p/"))) {
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    db.logVisit(ip, req.path); // fire-and-forget
  }
  next();
});

// ---------------------------------------------------------------------------
// API: Config
// ---------------------------------------------------------------------------
app.get("/api/config", (_req, res) => {
  const permanentRoomsEnabled = TESTING_MODE || !!(stripe && STRIPE_PAYMENT_LINK && process.env.DATABASE_URL);
  res.json({
    roomLifetimeMs: ROOM_LIFETIME_MS,
    permanentRoomsEnabled,
    permanentRoomCheckoutUrl: TESTING_MODE ? "/success" : STRIPE_PAYMENT_LINK,
  });
});

// ---------------------------------------------------------------------------
// API: Create room
// ---------------------------------------------------------------------------
app.post("/api/rooms", (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;

  // Rate limit room creation
  const now = Date.now();
  const timestamps = roomCreationLog.get(ip) || [];
  const recent = timestamps.filter((t) => now - t < 60_000);
  if (recent.length >= RATE_LIMIT_ROOMS_PER_MINUTE) {
    return res.status(429).json({ error: "Too many rooms created. Try again shortly." });
  }
  recent.push(now);
  roomCreationLog.set(ip, recent);

  // Generate room ID (10 chars, URL-safe)
  const roomId = generateRoomId();

  // Log room creation to analytics DB
  db.logRoomCreation(ip, roomId);

  // Don't create the room data yet — it starts when first socket connects
  res.json({ roomId });
});

// Serve room page for /room/:roomId
app.get("/room/:roomId", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "room.html"));
});

// ---------------------------------------------------------------------------
// Permanent rooms
// ---------------------------------------------------------------------------

// Settings page for permanent rooms (must be before /p/:slug)
app.get("/p/:slug/settings", async (req, res) => {
  if (TESTING_MODE) {
    const room = testPermanentRooms.get(req.params.slug);
    if (!room || !room.paid) {
      return res.status(404).sendFile(path.join(__dirname, "public", "index.html"));
    }
    return res.sendFile(path.join(__dirname, "public", "settings.html"));
  }

  if (!process.env.DATABASE_URL) {
    return res.status(404).send("Permanent rooms are not enabled.");
  }
  try {
    const room = await db.getPermanentRoom(req.params.slug);
    if (!room) {
      return res.status(404).sendFile(path.join(__dirname, "public", "index.html"));
    }
    res.sendFile(path.join(__dirname, "public", "settings.html"));
  } catch {
    res.status(500).send("Server error.");
  }
});

// Serve permanent room page
app.get("/p/:slug", async (req, res) => {
  if (TESTING_MODE) {
    const room = testPermanentRooms.get(req.params.slug);
    if (!room || !room.paid) {
      return res.status(404).sendFile(path.join(__dirname, "public", "index.html"));
    }
    return res.sendFile(path.join(__dirname, "public", "room.html"));
  }

  if (!process.env.DATABASE_URL) {
    return res.status(404).send("Permanent rooms are not enabled.");
  }
  try {
    const room = await db.getPermanentRoom(req.params.slug);
    if (!room) {
      return res.status(404).sendFile(path.join(__dirname, "public", "index.html"));
    }
    res.sendFile(path.join(__dirname, "public", "room.html"));
  } catch {
    res.status(500).send("Server error.");
  }
});

// Success page after checkout
app.get("/success", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "success.html"));
});

// Check slug availability
app.post("/api/permanent-rooms/check-slug", async (req, res) => {
  const { slug } = req.body;
  if (!slug || typeof slug !== "string") {
    return res.status(400).json({ error: "Slug is required." });
  }

  const normalized = slug.toLowerCase().trim();
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(normalized)) {
    return res.json({ available: false, reason: "Slug must be 3–40 characters, lowercase letters, numbers, and hyphens only." });
  }

  try {
    const exists = TESTING_MODE
      ? testPermanentRooms.has(normalized)
      : await db.slugExists(normalized);
    res.json({ available: !exists });
  } catch {
    res.status(500).json({ error: "Server error." });
  }
});

// Create permanent room (after payment)
app.post("/api/permanent-rooms/create", async (req, res) => {
  const { session_id, slug, passphrase } = req.body;

  if (!slug || typeof slug !== "string") {
    return res.status(400).json({ error: "Slug is required." });
  }

  const normalized = slug.toLowerCase().trim();
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(normalized)) {
    return res.status(400).json({ error: "Invalid slug format." });
  }

  try {
    // Verify payment (skip in testing mode)
    if (!TESTING_MODE) {
      if (!stripe || !session_id) {
        return res.status(400).json({ error: "Payment verification failed." });
      }

      const session = await stripe.checkout.sessions.retrieve(session_id);
      if (session.payment_status !== "paid") {
        return res.status(402).json({ error: "Payment not completed." });
      }

      // Check if this session was already used to create a room
      const existingRoom = await db.getRoomBySessionId(session_id);
      if (existingRoom) {
        return res.status(409).json({ error: "This payment has already been used." });
      }
    }

    // Check if slug is taken
    const exists = TESTING_MODE
      ? testPermanentRooms.has(normalized)
      : await db.slugExists(normalized);
    if (exists) {
      return res.status(409).json({ error: "This slug is already taken." });
    }

    // Hash passphrase if provided
    let passphraseHash = null;
    if (passphrase && typeof passphrase === "string" && passphrase.trim().length > 0) {
      passphraseHash = await bcrypt.hash(passphrase.trim(), 10);
    }

    if (TESTING_MODE) {
      testPermanentRooms.set(normalized, {
        slug: normalized,
        passphrase_hash: passphraseHash,
        paid: true,
      });
      return res.json({ slug: normalized });
    }

    // Production: create room in DB (already verified payment above)
    await db.createPermanentRoom(normalized, passphraseHash, session_id);
    await db.markPermanentRoomPaid(session_id);

    res.json({ slug: normalized });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "This slug is already taken." });
    }
    console.error("Create room error:", err.message);
    res.status(500).json({ error: "Could not create room." });
  }
});

// Authenticate for passphrase-protected rooms
app.post("/api/permanent-rooms/auth", async (req, res) => {
  const { slug, passphrase } = req.body;
  if (!slug) {
    return res.status(400).json({ error: "Slug is required." });
  }

  try {
    const room = TESTING_MODE
      ? testPermanentRooms.get(slug)
      : await db.getPermanentRoom(slug);

    if (!room || (TESTING_MODE && !room.paid)) {
      return res.status(404).json({ error: "Room not found." });
    }

    if (!room.passphrase_hash) {
      return res.json({ authenticated: true, hasPassphrase: false });
    }

    if (!passphrase) {
      return res.json({ authenticated: false, hasPassphrase: true });
    }

    const match = await bcrypt.compare(passphrase, room.passphrase_hash);
    if (!match) {
      return res.status(401).json({ error: "Wrong codeword." });
    }

    res.json({ authenticated: true, hasPassphrase: true });
  } catch {
    res.status(500).json({ error: "Server error." });
  }
});

// Update codeword for a permanent room
app.post("/api/permanent-rooms/:slug/codeword", async (req, res) => {
  const { slug } = req.params;
  const { currentCodeword, newCodeword } = req.body;

  if (!slug) {
    return res.status(400).json({ error: "Slug is required." });
  }

  try {
    const room = TESTING_MODE
      ? testPermanentRooms.get(slug)
      : await db.getPermanentRoom(slug);

    if (!room || (TESTING_MODE && !room.paid)) {
      return res.status(404).json({ error: "Room not found." });
    }

    // If room has an existing codeword, verify the current one
    if (room.passphrase_hash) {
      if (!currentCodeword) {
        return res.status(401).json({ error: "Current codeword is required." });
      }
      const match = await bcrypt.compare(currentCodeword, room.passphrase_hash);
      if (!match) {
        return res.status(401).json({ error: "Current codeword is incorrect." });
      }
    }

    // Hash new codeword (or set to null to remove it)
    let newHash = null;
    if (newCodeword && typeof newCodeword === "string" && newCodeword.trim().length > 0) {
      newHash = await bcrypt.hash(newCodeword.trim(), 10);
    }

    if (TESTING_MODE) {
      room.passphrase_hash = newHash;
    } else {
      await db.updateCodeword(slug, newHash);
    }

    res.json({ updated: true });
  } catch {
    res.status(500).json({ error: "Server error." });
  }
});

// Delete a permanent room
app.delete("/api/permanent-rooms/:slug", async (req, res) => {
  const { slug } = req.params;
  if (!slug) {
    return res.status(400).json({ error: "Slug is required." });
  }

  try {
    if (TESTING_MODE) {
      const room = testPermanentRooms.get(slug);
      if (!room) {
        return res.status(404).json({ error: "Room not found." });
      }
      testPermanentRooms.delete(slug);
    } else {
      const room = await db.getPermanentRoom(slug);
      if (!room) {
        return res.status(404).json({ error: "Room not found." });
      }
      await db.deletePermanentRoom(slug);
    }

    // Also destroy the in-memory room if it exists
    const activeRoom = rooms.get(slug);
    if (activeRoom) {
      activeRoom.destroyed = true;
      io.to(slug).emit("room-destroyed");
      io.in(slug).socketsLeave(slug);
      setTimeout(() => {
        rooms.delete(slug);
      }, 5000);
    }

    res.json({ deleted: true });
  } catch {
    res.status(500).json({ error: "Server error." });
  }
});

// ---------------------------------------------------------------------------
// Email room link via Brevo
// ---------------------------------------------------------------------------
app.post("/api/email-room-link", async (req, res) => {
  const { email, roomUrl } = req.body;
  if (!email || typeof email !== "string" || !email.includes("@")) {
    return res.status(400).json({ error: "Valid email is required." });
  }
  if (!roomUrl || typeof roomUrl !== "string") {
    return res.status(400).json({ error: "Room URL is required." });
  }

  if (TESTING_MODE) {
    console.log(`[TEST] Email would be sent to ${email} with link ${roomUrl}`);
    return res.json({ sent: true });
  }

  if (!BREVO_API_KEY) {
    return res.status(400).json({ error: "Email is not configured." });
  }

  try {
    const payload = JSON.stringify({
      sender: { name: "ChatOffRecord", email: BREVO_SENDER_EMAIL },
      to: [{ email: email.trim() }],
      subject: "Your ChatOffRecord Room Link",
      htmlContent: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #0f172a; color: #f8fafc; border-radius: 12px;">
          <h2 style="margin: 0 0 16px;">ChatOffRecord</h2>
          <p style="color: #94a3b8; margin: 0 0 24px;">Here's your permanent room link. Save this email so you don't lose it.</p>
          <a href="${roomUrl}" style="display: inline-block; padding: 12px 24px; background: #6366f1; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600;">${roomUrl}</a>
          <p style="color: #64748b; font-size: 12px; margin-top: 24px;">This is an automated email from ChatOffRecord. Do not reply.</p>
        </div>
      `,
    });

    const https = require("https");
    const result = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: "api.brevo.com",
          path: "/v3/smtp/email",
          method: "POST",
          headers: {
            "api-key": BREVO_API_KEY,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
        },
        (response) => {
          let body = "";
          response.on("data", (chunk) => (body += chunk));
          response.on("end", () => {
            if (response.statusCode >= 200 && response.statusCode < 300) {
              resolve({ ok: true });
            } else {
              console.error("Brevo error:", body);
              resolve({ ok: false });
            }
          });
        }
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    });

    if (!result.ok) {
      return res.status(500).json({ error: "Could not send email." });
    }

    res.json({ sent: true });
  } catch (err) {
    console.error("Email error:", err.message);
    res.status(500).json({ error: "Could not send email." });
  }
});

// ---------------------------------------------------------------------------
// Admin routes
// ---------------------------------------------------------------------------
app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.post("/admin/auth", (req, res) => {
  const { passcode } = req.body;
  if (passcode !== ADMIN_PASSCODE) {
    return res.status(401).json({ error: "Invalid passcode." });
  }

  const token = crypto.randomBytes(32).toString("hex");
  adminTokens.add(token);

  res.json({ token });
});

function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ error: "Unauthorized." });
  }
  next();
}

app.get("/api/admin/stats", requireAdmin, async (_req, res) => {
  try {
    const [visitors, rooms, roomsPerUser, retention, avgTimeOnRoom, linkShares, permanentRooms, funnel, sessions] =
      await Promise.all([
        db.getVisitorStats(),
        db.getRoomStats(),
        db.getRoomsPerUser(),
        db.getRetention(),
        db.getAvgTimeOnRoom(),
        db.getLinkShareStats(),
        db.getPermanentRoomStats(),
        db.getFunnelStats(),
        db.getSessionList(),
      ]);

    res.json({ visitors, rooms, roomsPerUser, retention, avgTimeOnRoom, linkShares, permanentRooms, funnel, sessions });
  } catch (err) {
    console.error("Analytics query error:", err.message);
    res.status(500).json({ error: "Failed to fetch analytics." });
  }
});

// ---------------------------------------------------------------------------
// WebSocket handling
// ---------------------------------------------------------------------------
io.on("connection", (socket) => {
  let currentRoom = null;
  let messageTimes = [];
  let sessionId = null;
  const socketIp = socket.handshake.headers["x-forwarded-for"] || socket.handshake.address;

  socket.on("join-room", async ({ roomId, displayName, roomType }) => {
    if (!roomId || typeof roomId !== "string" || roomId.length > 50) {
      socket.emit("error-msg", "Invalid room ID.");
      return;
    }

    const safeName = sanitizeName(displayName);
    if (!safeName) {
      socket.emit("error-msg", "Invalid display name.");
      return;
    }

    const isPermanent = roomType === "permanent";

    // For permanent rooms, verify the slug exists and is paid
    if (isPermanent) {
      try {
        const pRoom = TESTING_MODE
          ? testPermanentRooms.get(roomId)
          : await db.getPermanentRoom(roomId);
        if (!pRoom || (TESTING_MODE && !pRoom.paid)) {
          socket.emit("error-msg", "Room not found or payment incomplete.");
          return;
        }
      } catch {
        socket.emit("error-msg", "Could not verify room.");
        return;
      }
    }

    // Check if room was already destroyed (ephemeral only)
    const existing = rooms.get(roomId);
    if (existing && existing.destroyed) {
      socket.emit("room-destroyed");
      return;
    }

    // Create room if it doesn't exist (first joiner starts the timer)
    if (!existing) {
      const room = {
        createdAt: Date.now(),
        destroyed: false,
        permanent: isPermanent,
        sockets: new Map(), // socketId -> displayName
      };

      // Set self-destruct timer only for ephemeral rooms
      if (!isPermanent) {
        room.timer = setTimeout(() => {
          destroyRoom(roomId);
        }, ROOM_LIFETIME_MS);
      }

      rooms.set(roomId, room);
    }

    const room = rooms.get(roomId);
    currentRoom = roomId;

    socket.join(roomId);
    room.sockets.set(socket.id, safeName);

    // Log room session for analytics
    db.logRoomJoin(socketIp, roomId).then((id) => {
      sessionId = id;
    });

    // Send room info to the joining client
    const remainingMs = room.permanent ? null : ROOM_LIFETIME_MS - (Date.now() - room.createdAt);
    const users = Array.from(room.sockets.values());
    socket.emit("room-joined", {
      remainingMs: room.permanent ? null : Math.max(0, remainingMs),
      userCount: room.sockets.size,
      displayName: safeName,
      roomType: room.permanent ? "permanent" : "ephemeral",
      users,
    });

    // Notify others in the room
    socket.to(roomId).emit("user-joined", {
      displayName: safeName,
      userCount: room.sockets.size,
      users,
    });
  });

  socket.on("chat-message", ({ message }) => {
    if (!currentRoom) return;

    const room = rooms.get(currentRoom);
    if (!room || room.destroyed) return;

    // Rate limit messages
    const now = Date.now();
    messageTimes = messageTimes.filter((t) => now - t < 1000);
    if (messageTimes.length >= RATE_LIMIT_MESSAGES_PER_SECOND) {
      socket.emit("error-msg", "Slow down! Too many messages.");
      return;
    }
    messageTimes.push(now);

    // Validate message
    if (!message || typeof message !== "string") return;
    const trimmed = message.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_MESSAGE_LENGTH) {
      socket.emit("error-msg", `Message must be 1–${MAX_MESSAGE_LENGTH} characters.`);
      return;
    }

    const displayName = room.sockets.get(socket.id) || "Anonymous";

    // PRIVACY NOTE: We broadcast the message but do NOT store or log it.
    // We only log a count (no content, no sender) for analytics.
    db.logMessage(currentRoom);
    io.to(currentRoom).emit("chat-message", {
      displayName,
      message: trimmed,
      timestamp: Date.now(),
      senderId: socket.id,
    });
  });

  socket.on("chat-media", ({ dataUrl, mediaType }) => {
    if (!currentRoom) return;

    const room = rooms.get(currentRoom);
    if (!room || room.destroyed) return;

    // Rate limit (shared with text messages)
    const now = Date.now();
    messageTimes = messageTimes.filter((t) => now - t < 1000);
    if (messageTimes.length >= RATE_LIMIT_MESSAGES_PER_SECOND) {
      socket.emit("error-msg", "Slow down! Too many messages.");
      return;
    }
    messageTimes.push(now);

    // Validate
    if (!dataUrl || typeof dataUrl !== "string") return;
    if (!mediaType || !["image", "video"].includes(mediaType)) return;

    // Check size (base64 data URL: ~4/3 of original, so check the string length)
    const sizeEstimate = Math.ceil((dataUrl.length * 3) / 4);
    if (sizeEstimate > MAX_MEDIA_BYTES) {
      socket.emit("error-msg", "File is too large. Maximum size is 200 MB.");
      return;
    }

    const displayName = room.sockets.get(socket.id) || "Anonymous";

    // PRIVACY NOTE: We broadcast the media but do NOT store or log it.
    // We only log a count (no content, no sender) for analytics.
    db.logMessage(currentRoom);
    io.to(currentRoom).emit("chat-media", {
      displayName,
      dataUrl,
      mediaType,
      timestamp: Date.now(),
      senderId: socket.id,
    });
  });

  socket.on("link-share", () => {
    if (!currentRoom) return;
    db.logLinkShare(socketIp, currentRoom);
  });

  socket.on("disconnect", () => {
    // Log session end
    db.logRoomLeave(sessionId);

    if (!currentRoom) return;

    const room = rooms.get(currentRoom);
    if (!room) return;

    const displayName = room.sockets.get(socket.id) || "Anonymous";
    room.sockets.delete(socket.id);

    if (!room.destroyed) {
      io.to(currentRoom).emit("user-left", {
        displayName,
        userCount: room.sockets.size,
        users: Array.from(room.sockets.values()),
      });

      // For permanent rooms, clean up in-memory data when all users leave
      // The slug stays valid in DB — room will be recreated when someone joins again
      if (room.permanent && room.sockets.size === 0) {
        rooms.delete(currentRoom);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Room destruction
// ---------------------------------------------------------------------------
function destroyRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.destroyed = true;
  clearTimeout(room.timer);

  // Notify all connected clients
  io.to(roomId).emit("room-destroyed");

  // Disconnect all sockets from the room
  io.in(roomId).socketsLeave(roomId);

  // Remove room from memory after a short delay (let clients receive the event)
  setTimeout(() => {
    rooms.delete(roomId);
  }, 5000);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function generateRoomId() {
  const chars = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 10; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  // Ensure uniqueness
  if (rooms.has(id)) return generateRoomId();
  return id;
}

function sanitizeName(name) {
  if (!name || typeof name !== "string") return null;
  const trimmed = name.trim().slice(0, 30);
  // Allow letters, numbers, spaces, underscores, hyphens
  const safe = trimmed.replace(/[^a-zA-Z0-9 _\-]/g, "");
  return safe.length > 0 ? safe : null;
}

// ---------------------------------------------------------------------------
// Periodic cleanup of stale rate-limit data
// ---------------------------------------------------------------------------
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of roomCreationLog) {
    const recent = timestamps.filter((t) => now - t < 60_000);
    if (recent.length === 0) {
      roomCreationLog.delete(ip);
    } else {
      roomCreationLog.set(ip, recent);
    }
  }
}, 60_000);

// ---------------------------------------------------------------------------
// Periodic cleanup of stale unpaid permanent room reservations
// ---------------------------------------------------------------------------
setInterval(() => {
  db.cleanupUnpaidRooms().catch(() => {});
}, 15 * 60_000);

// ---------------------------------------------------------------------------
// Start server (initialize DB first)
// ---------------------------------------------------------------------------
async function start() {
  if (process.env.DATABASE_URL) {
    try {
      await db.initDb();
      console.log("Analytics database initialized.");
    } catch (err) {
      console.warn("Could not connect to analytics DB:", err.message);
      console.warn("Analytics will be disabled. Set DATABASE_URL to enable.");
    }
  } else {
    console.log("No DATABASE_URL set — analytics disabled.");
  }

  server.listen(PORT, () => {
    console.log(`ChatOffRecord running on http://localhost:${PORT}`);
    if (TESTING_MODE) {
      console.log("TESTING MODE enabled — payments are bypassed, permanent rooms use in-memory storage.");
    }
  });
}

start();
