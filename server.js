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
  filename: (_req, _file, cb) => {
    cb(null, crypto.randomUUID() + ".png");
  },
});

const stickerUpload = multer({
  storage: stickerStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB (already cropped client-side)
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

app.use("/sticker", requireAccess, express.static(path.join(PUBLIC_DIR, "sticker")));
app.use("/stickers", requireAccess, express.static(path.join(PUBLIC_DIR, "stickers")));
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

// Built-in stickers from public/sticker/ and public/stickers/
const BUILTIN_STICKER_DIRS = [
  { dir: path.join(__dirname, "public", "sticker"), urlPrefix: "/sticker" },
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
  .filter((f) => f.endsWith(".png"))
  .map((f) => ({
    id: path.basename(f, ".png"),
    url: `/uploaded-stickers/${f}`,
  }));

// Combined list: built-in first, then user-uploaded
const stickers = [...builtinStickers, ...userStickers];

app.post("/upload-sticker", requireAccess, stickerUpload.single("sticker"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  const sticker = {
    id: path.basename(req.file.filename, ".png"),
    url: `/uploaded-stickers/${req.file.filename}`,
  };
  stickers.push(sticker);
  io.emit("stickers", stickers);
  res.json(sticker);
});

// Track rooms and their message history
const rooms = new Map();

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

    // Send chat history to the joining user
    socket.emit("chat-history", rooms.get(room));

    // Notify others in the room
    const joinMsg = {
      type: "system",
      text: `${username} joined the room`,
      timestamp: Date.now(),
    };
    rooms.get(room).push(joinMsg);
    io.to(room).emit("message", joinMsg);

    // Send current user count
    const count = io.sockets.adapter.rooms.get(room)?.size || 0;
    io.to(room).emit("user-count", count);
  });

  socket.on("send-message", (data) => {
    if (!currentRoom || !username) return;

    const msg = {
      type: "user",
      name: username,
      text: data.text || "",
      fileUrl: data.fileUrl || null,
      mediaType: data.mediaType || null,
      stickerUrl: data.stickerUrl || null,
      timestamp: Date.now(),
    };
    rooms.get(currentRoom).push(msg);
    io.to(currentRoom).emit("message", msg);
  });

  socket.on("disconnect", () => {
    if (!currentRoom || !username) return;

    const leaveMsg = {
      type: "system",
      text: `${username} left the room`,
      timestamp: Date.now(),
    };

    if (rooms.has(currentRoom)) {
      rooms.get(currentRoom).push(leaveMsg);
    }
    io.to(currentRoom).emit("message", leaveMsg);

    const count = io.sockets.adapter.rooms.get(currentRoom)?.size || 0;
    io.to(currentRoom).emit("user-count", count);

    // Clean up empty rooms
    if (count === 0) {
      cleanupRoomFiles(currentRoom);
      rooms.delete(currentRoom);
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
