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

const UPLOADS_DIR = path.join(__dirname, "uploads");
const STICKERS_DIR = path.join(__dirname, "stickers");

// Ensure directories exist
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(STICKERS_DIR, { recursive: true });

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

app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOADS_DIR));
app.use("/stickers", express.static(STICKERS_DIR));

// File upload endpoint
app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  const fileUrl = `/uploads/${req.file.filename}`;
  const mediaType = req.file.mimetype.startsWith("video/") ? "video" : "image";
  res.json({ url: fileUrl, mediaType });
});

// Sticker upload endpoint — load existing stickers from disk on startup
const stickers = fs.readdirSync(STICKERS_DIR)
  .filter((f) => f.endsWith(".png"))
  .map((f) => ({
    id: path.basename(f, ".png"),
    url: `/stickers/${f}`,
  }));

app.post("/upload-sticker", stickerUpload.single("sticker"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  const sticker = {
    id: path.basename(req.file.filename, ".png"),
    url: `/stickers/${req.file.filename}`,
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
    if (idx !== -1) {
      const removed = stickers.splice(idx, 1)[0];
      const filePath = path.join(__dirname, removed.url);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
