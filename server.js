const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const ACCESS_CODE = process.env.ACCESS_CODE || "longtimenosee";
const UPLOADS_DIR = path.join(__dirname, "uploads");
const STICKERS_DIR = path.join(__dirname, "stickers");
const PUBLIC_DIR = path.join(__dirname, "public");
const ACCESS_PAGE = path.join(PUBLIC_DIR, "access.html");
const APP_PAGE = path.join(PUBLIC_DIR, "index.html");

const tabSessions = new Map();

// Ensure directories exist
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(STICKERS_DIR, { recursive: true });

app.use(express.urlencoded({ extended: false }));

function createTabSession() {
  const tabToken = crypto.randomUUID();
  tabSessions.set(tabToken, { authorized: true, createdAt: Date.now() });
  return tabToken;
}

function getTabToken(req) {
  const headerToken = `${req.headers["x-tab-token"] || ""}`.trim();
  if (headerToken) return headerToken;
  return `${req.query.tab || ""}`.trim();
}

function getTabSession(req) {
  const tabToken = getTabToken(req);
  if (!tabToken) return null;
  return tabSessions.get(tabToken) || null;
}

function requireAccess(req, res, next) {
  if (getTabSession(req)?.authorized) {
    return next();
  }
  return res.status(403).json({ error: "Access denied" });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, crypto.randomUUID() + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/") || file.mimetype.startsWith("video/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image and video files are allowed"));
    }
  },
});

// Configure multer for sticker uploads
const stickerStorage = multer.diskStorage({
  destination: STICKERS_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".png";
    cb(null, crypto.randomUUID() + ext);
  },
});

const stickerUpload = multer({
  storage: stickerStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // Allow larger GIF uploads
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});

app.get("/access", (req, res) => {
  return res.sendFile(ACCESS_PAGE);
});

app.get("/", (_req, res) => {
  return res.sendFile(ACCESS_PAGE);
});

app.post("/access", (req, res) => {
  const submittedCode = `${req.body.code || ""}`.trim();
  if (submittedCode !== ACCESS_CODE) {
    return res.redirect("/access?error=1");
  }

  const tabToken = createTabSession();
  return res.redirect("/app");
});

app.post("/access-token", (req, res) => {
  const submittedCode = `${req.body.code || ""}`.trim();
  if (submittedCode !== ACCESS_CODE) {
    return res.status(401).json({ error: "Invalid access code" });
  }

  const tabToken = createTabSession();
  return res.json({ tabToken });
});

app.post("/logout", (req, res) => {
  const tabToken = getTabToken(req);
  if (tabToken) {
    tabSessions.delete(tabToken);
  }
  return res.status(204).end();
});

app.get("/app", (_req, res) => {
  res.sendFile(APP_PAGE);
});

app.get("/index-archived", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index-archived.html"));
});

// Landing image used by public/index.html
app.get("/index.jpg", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.jpg"));
});

const BUILTIN_STICKERS_DIR = path.join(PUBLIC_DIR, "stickers");
// Keep /sticker as a compatibility alias for previously shared URLs.
app.use("/sticker", requireAccess, express.static(BUILTIN_STICKERS_DIR));
app.use("/stickers", requireAccess, express.static(BUILTIN_STICKERS_DIR));
app.use("/uploads", requireAccess, express.static(UPLOADS_DIR));
app.use("/uploaded-stickers", requireAccess, express.static(STICKERS_DIR));

// File upload endpoint
app.post("/upload", requireAccess, upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  const fileUrl = `/uploads/${req.file.filename}`;
  const mediaType = req.file.mimetype.startsWith("video/") ? "video" : "image";
  res.json({ url: fileUrl, mediaType });
});

// Built-in stickers from public/stickers/
const BUILTIN_STICKER_DIRS = [
  { dir: path.join(__dirname, "public", "stickers"), urlPrefix: "/stickers" },
];
const builtinStickers = [];
for (const { dir, urlPrefix } of BUILTIN_STICKER_DIRS) {
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (/\.(png|jpe?g|gif|webp)$/i.test(f)) {
        builtinStickers.push({
          id: `builtin-${urlPrefix.slice(1)}-${path.basename(f, path.extname(f))}`,
          url: `${urlPrefix}/${f}`,
          builtin: true,
        });
      }
    }
  }
}

// User-uploaded stickers from disk on startup
const userStickers = fs.readdirSync(STICKERS_DIR)
  .filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f))
  .map((f) => ({
    id: path.basename(f, path.extname(f)),
    url: `/uploaded-stickers/${f}`,
  }));

// Combined list: built-in first, then user-uploaded
const stickers = [...builtinStickers, ...userStickers];

app.post("/upload-sticker", requireAccess, stickerUpload.single("sticker"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  const sticker = {
    id: path.basename(req.file.filename, path.extname(req.file.filename)),
    url: `/uploaded-stickers/${req.file.filename}`,
  };
  stickers.push(sticker);
  io.emit("stickers", stickers);
  res.json(sticker);
});

// Track rooms and their message history
const rooms = new Map();
// Active participants and contribution stats per room
const roomParticipants = new Map();

// Scheduled rooms visible on the landing page
const scheduledRooms = [];

// Delete uploaded files for a room
function cleanupRoomFiles(room) {
  const messages = rooms.get(room);
  if (!messages) return;
  for (const msg of messages) {
    if (msg.fileUrl) {
      const filePath = path.join(__dirname, msg.fileUrl);
      fs.unlink(filePath, () => {});
    }
  }
}

function getTextStats(text) {
  const raw = `${text || ""}`;
  const noWhitespace = raw.replace(/\s+/g, "");
  const chars = Array.from(noWhitespace).length;
  if (!noWhitespace) return { words: 0, chars: 0 };

  const hanChars = raw.match(/\p{Script=Han}/gu) || [];
  const nonHanText = raw.replace(/\p{Script=Han}/gu, " ").trim();
  const nonHanWords = nonHanText ? nonHanText.split(/\s+/).length : 0;

  return { words: hanChars.length + nonHanWords, chars };
}

function getMessageStats(msg) {
  const textStats = getTextStats(msg?.text || "");
  if (msg?.stickerUrl || msg?.fileUrl) {
    return {
      words: textStats.words + 1,
      chars: textStats.chars + 1,
    };
  }
  return textStats;
}

function getUserStatsFromHistory(room, userId) {
  const history = rooms.get(room) || [];
  let msgs = 0;
  let words = 0;
  let chars = 0;
  for (const msg of history) {
    if (msg.type !== "user" || msg.userId !== userId) continue;
    msgs += 1;
    const stats = getMessageStats(msg);
    words += stats.words;
    chars += stats.chars;
  }
  return { msgs, words, chars };
}

function emitRoomParticipants(room) {
  const participantsMap = roomParticipants.get(room) || new Map();
  const participants = Array.from(participantsMap.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({
      userId: p.userId,
      name: p.name,
      msgs: p.msgs,
      words: p.words,
      chars: p.chars,
    }));

  io.to(room).emit("room-participants", participants);
  io.to(room).emit("user-count", participants.length);
}

io.use((socket, next) => {
  const tabToken = `${socket.handshake.auth?.tab || ""}`.trim();
  const session = tabToken ? tabSessions.get(tabToken) : null;

  if (!session?.authorized) {
    return next(new Error("unauthorized"));
  }

  return next();
});

io.on("connection", (socket) => {
  let currentRoom = null;
  let username = null;
  const clientId = `${socket.handshake.auth?.tab || socket.id}`;

  // Send current state on connect
  socket.emit("scheduled-rooms", scheduledRooms);
  socket.emit("stickers", stickers);

  socket.on("publish-room", ({ room, time }) => {
    if (!room || !time) return;
    scheduledRooms.push({ room, time, id: crypto.randomUUID() });
    io.emit("scheduled-rooms", scheduledRooms);
  });

  socket.on("remove-scheduled", ({ id }) => {
    const idx = scheduledRooms.findIndex((s) => s.id === id);
    if (idx !== -1) {
      scheduledRooms.splice(idx, 1);
      io.emit("scheduled-rooms", scheduledRooms);
    }
  });

  socket.on("remove-sticker", ({ id }) => {
    const idx = stickers.findIndex((s) => s.id === id);
    if (idx !== -1 && !stickers[idx].builtin) {
      const removed = stickers.splice(idx, 1)[0];
      const filePath = path.join(STICKERS_DIR, path.basename(removed.url));
      fs.unlink(filePath, () => {});
      io.emit("stickers", stickers);
    }
  });

  socket.on("join-room", ({ room, name }) => {
    username = name;
    currentRoom = room;

    socket.join(room);

    if (!rooms.has(room)) {
      rooms.set(room, []);
    }
    if (!roomParticipants.has(room)) {
      roomParticipants.set(room, new Map());
    }

    // Send chat history to the joining user
    socket.emit("chat-history", rooms.get(room));

    const participantsMap = roomParticipants.get(room);
    const existingParticipant = participantsMap.get(clientId);
    if (!existingParticipant) {
      const stats = getUserStatsFromHistory(room, clientId);
      participantsMap.set(clientId, {
        userId: clientId,
        name: username,
        msgs: stats.msgs,
        words: stats.words,
        chars: stats.chars,
      });
    } else {
      existingParticipant.name = username;
    }

    // Notify others in the room
    const joinMsg = {
      id: crypto.randomUUID(),
      type: "system",
      text: `${username} joined the room`,
      timestamp: Date.now(),
    };
    rooms.get(room).push(joinMsg);
    io.to(room).emit("message", joinMsg);

    emitRoomParticipants(room);
  });

  socket.on("update-name", ({ name }) => {
    const nextName = `${name || ""}`.trim().slice(0, 30);
    if (!currentRoom || !username || !nextName || nextName === username) return;

    const previousName = username;
    username = nextName;
    socket.emit("name-updated", username);

    const participantsMap = roomParticipants.get(currentRoom);
    if (participantsMap?.has(clientId)) {
      participantsMap.get(clientId).name = username;
      emitRoomParticipants(currentRoom);
    }

    if (rooms.has(currentRoom)) {
      for (const msg of rooms.get(currentRoom)) {
        if (msg.type === "user" && msg.userId === clientId) {
          msg.name = username;
        }
      }
    }

    io.to(currentRoom).emit("name-changed", { userId: clientId, name: username });

    const renameMsg = {
      id: crypto.randomUUID(),
      type: "system",
      text: `${previousName} is now known as ${username}`,
      timestamp: Date.now(),
    };

    if (rooms.has(currentRoom)) {
      rooms.get(currentRoom).push(renameMsg);
    }
    io.to(currentRoom).emit("message", renameMsg);
  });

  socket.on("clear-room", () => {
    if (!currentRoom || !rooms.has(currentRoom)) return;

    cleanupRoomFiles(currentRoom);
    rooms.set(currentRoom, []);
    const participantsMap = roomParticipants.get(currentRoom);
    if (participantsMap) {
      participantsMap.forEach((participant) => {
        participant.msgs = 0;
        participant.words = 0;
        participant.chars = 0;
      });
      emitRoomParticipants(currentRoom);
    }
    io.to(currentRoom).emit("room-cleared");
  });

  socket.on("send-message", (data) => {
    if (!currentRoom || !username) return;

    let replyTo = null;
    const replyToId = `${data.replyToId || ""}`.trim();
    if (replyToId && rooms.has(currentRoom)) {
      const original = rooms.get(currentRoom).find((m) => m.id === replyToId);
      if (original) {
        replyTo = {
          id: original.id,
          name: original.name || "System",
          text: original.text || "",
          fileUrl: original.fileUrl || null,
          mediaType: original.mediaType || null,
          stickerUrl: original.stickerUrl || null,
        };
      }
    }

    const msg = {
      id: crypto.randomUUID(),
      type: "user",
      userId: clientId,
      name: username,
      text: data.text || "",
      fileUrl: data.fileUrl || null,
      mediaType: data.mediaType || null,
      stickerUrl: data.stickerUrl || null,
      replyTo,
      seenBy: [clientId],
      timestamp: Date.now(),
    };
    rooms.get(currentRoom).push(msg);
    io.to(currentRoom).emit("message", msg);

    const participantsMap = roomParticipants.get(currentRoom);
    if (participantsMap?.has(clientId)) {
      const stats = getMessageStats(msg);
      const participant = participantsMap.get(clientId);
      participant.msgs += 1;
      participant.words += stats.words;
      participant.chars += stats.chars;
      emitRoomParticipants(currentRoom);
    }
  });

  socket.on("mark-seen", ({ messageId }) => {
    const id = `${messageId || ""}`.trim();
    if (!currentRoom || !id || !rooms.has(currentRoom)) return;

    const msg = rooms.get(currentRoom).find((m) => m.id === id && m.type === "user");
    if (!msg) return;

    if (!Array.isArray(msg.seenBy)) {
      msg.seenBy = [msg.userId].filter(Boolean);
    }
    if (msg.seenBy.includes(clientId)) return;

    msg.seenBy.push(clientId);
    const seenCount = Math.max(0, msg.seenBy.length - 1);
    io.to(currentRoom).emit("message-seen", { messageId: id, seenCount });
  });

  socket.on("disconnect", () => {
    if (!currentRoom || !username) return;

    const participantsMap = roomParticipants.get(currentRoom);
    if (participantsMap) {
      participantsMap.delete(clientId);
      emitRoomParticipants(currentRoom);
    }

    const leaveMsg = {
      id: crypto.randomUUID(),
      type: "system",
      text: `${username} left the room`,
      timestamp: Date.now(),
    };

    if (rooms.has(currentRoom)) {
      rooms.get(currentRoom).push(leaveMsg);
    }
    io.to(currentRoom).emit("message", leaveMsg);

    // Clean up empty rooms
    const count = io.sockets.adapter.rooms.get(currentRoom)?.size || 0;
    if (count === 0) {
      cleanupRoomFiles(currentRoom);
      rooms.delete(currentRoom);
      roomParticipants.delete(currentRoom);
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
