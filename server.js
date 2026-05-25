const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const crypto = require("crypto");
const net = require("net");
const dns = require("dns").promises;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const ACCESS_CODE = process.env.ACCESS_CODE || "longtimenosee";
const UPLOADS_DIR = path.join(__dirname, "uploads");
const STICKERS_DIR = path.join(__dirname, "stickers");
const PUBLIC_DIR = path.join(__dirname, "public");
const BUILTIN_STICKERS_DIR = path.join(PUBLIC_DIR, "stickers");
const LEGACY_BUILTIN_STICKERS_DIR = path.join(PUBLIC_DIR, "sticker");
const ACCESS_PAGE = path.join(PUBLIC_DIR, "access.html");
const APP_PAGE = path.join(PUBLIC_DIR, "index.html");

const tabSessions = new Map();
const deviceLogins = new Map();
const MAX_DEVICE_LOGINS = 200;

function sanitizeDeviceId(raw) {
  const value = `${raw || ""}`.trim();
  if (!value) return "";
  return value.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 128);
}

function sanitizeDeviceName(raw) {
  return `${raw || ""}`.trim().replace(/\s+/g, " ").slice(0, 64);
}

function trimUserAgent(raw) {
  return `${raw || ""}`.trim().replace(/\s+/g, " ").slice(0, 64);
}

function fallbackDeviceName(req, deviceId) {
  const ua = trimUserAgent(req.headers["user-agent"]);
  if (ua) return ua;
  if (!deviceId) return "Unknown device";
  return `Device ${deviceId.slice(0, 8)}`;
}

function recordDeviceLogin(req, rawDeviceId, rawDeviceName) {
  const deviceId = sanitizeDeviceId(rawDeviceId);
  if (!deviceId) return null;

  const deviceName = sanitizeDeviceName(rawDeviceName) || fallbackDeviceName(req, deviceId);
  const loginEntry = {
    deviceId,
    deviceName,
    lastLoginAt: Date.now(),
  };
  deviceLogins.set(deviceId, loginEntry);

  if (deviceLogins.size > MAX_DEVICE_LOGINS) {
    const oldest = Array.from(deviceLogins.values())
      .sort((a, b) => a.lastLoginAt - b.lastLoginAt)
      .slice(0, deviceLogins.size - MAX_DEVICE_LOGINS);
    oldest.forEach((entry) => deviceLogins.delete(entry.deviceId));
  }

  return loginEntry;
}

function getRecentDeviceLogins(limit = 12) {
  const boundedLimit = Math.min(30, Math.max(1, Number(limit) || 12));
  return Array.from(deviceLogins.values())
    .sort((a, b) => b.lastLoginAt - a.lastLoginAt)
    .slice(0, boundedLimit);
}

function buildRtcIceServers() {
  const iceServers = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];
  const turnUrlsRaw = `${process.env.RTC_TURN_URLS || process.env.RTC_TURN_URL || ""}`.trim();
  if (!turnUrlsRaw) return iceServers;

  const turnUrls = turnUrlsRaw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!turnUrls.length) return iceServers;

  const username = `${process.env.RTC_TURN_USERNAME || ""}`.trim();
  const credential = `${process.env.RTC_TURN_CREDENTIAL || ""}`.trim();
  const turnServer = { urls: turnUrls.length === 1 ? turnUrls[0] : turnUrls };
  if (username) turnServer.username = username;
  if (credential) turnServer.credential = credential;
  iceServers.push(turnServer);
  return iceServers;
}

// Ensure directories exist
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(STICKERS_DIR, { recursive: true });

app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "1mb" }));

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
  limits: { fileSize: 25 * 1024 * 1024 }, // Allow larger GIF uploads
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(`${file.originalname || ""}`).toLowerCase();
    const looksLikeImageByExt = [".gif", ".png", ".jpg", ".jpeg", ".webp"].includes(ext);
    const isImageMime = `${file.mimetype || ""}`.startsWith("image/");
    const isGenericBinary = `${file.mimetype || ""}` === "application/octet-stream";
    if (isImageMime || (isGenericBinary && looksLikeImageByExt)) {
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

  const deviceEntry = recordDeviceLogin(
    req,
    req.headers["x-device-id"] || req.body.deviceId,
    req.headers["x-device-name"] || req.body.deviceName,
  );
  const tabToken = createTabSession();
  return res.json({
    tabToken,
    loginAt: deviceEntry?.lastLoginAt || Date.now(),
  });
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

app.get("/rtc-config", requireAccess, (_req, res) => {
  return res.json({ iceServers: buildRtcIceServers() });
});

app.get("/login-devices", requireAccess, (req, res) => {
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) ? rawLimit : 12;
  return res.json({ devices: getRecentDeviceLogins(limit) });
});

// Landing image used by public/index.html
app.get("/index.jpg", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.jpg"));
});

// Keep /sticker as compatibility alias and support both folders if present.
app.use("/stickers", requireAccess, express.static(BUILTIN_STICKERS_DIR));
app.use("/sticker", requireAccess, express.static(LEGACY_BUILTIN_STICKERS_DIR));
app.use("/sticker", requireAccess, express.static(BUILTIN_STICKERS_DIR));
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

function isStickerFile(filePath) {
  return /\.(png|jpe?g|gif|webp)$/i.test(filePath);
}

function toUrlPath(urlPrefix, relPath) {
  const encoded = relPath
    .split(path.sep)
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${urlPrefix}/${encoded}`;
}

function contentTypeToExtension(contentType) {
  const base = `${contentType || ""}`.split(";")[0].trim().toLowerCase();
  if (base === "image/jpeg") return ".jpg";
  if (base === "image/png") return ".png";
  if (base === "image/gif") return ".gif";
  if (base === "image/webp") return ".webp";
  return "";
}

function isGifUrl(url) {
  return /\.gif(?:$|[?#])/i.test(`${url || ""}`);
}

function isPrivateIpAddress(ip) {
  if (net.isIP(ip) === 4) {
    const parts = ip.split(".").map((v) => Number(v));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  if (net.isIP(ip) === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === "::1") return true;
    if (normalized.startsWith("::ffff:")) {
      const maybeV4 = normalized.slice(7);
      return isPrivateIpAddress(maybeV4);
    }
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
    if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
    return false;
  }

  return true;
}

async function isSafeRemoteHost(hostname) {
  const host = `${hostname || ""}`.trim().toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;

  if (net.isIP(host)) {
    return !isPrivateIpAddress(host);
  }

  let addresses = [];
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch (_error) {
    return false;
  }
  if (!addresses.length) return false;
  return addresses.every((addr) => !isPrivateIpAddress(addr.address));
}

function readStickerFilesRecursive(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const out = [];
  const walk = (currentDir, relBase) => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const absPath = path.join(currentDir, entry.name);
      const relPath = relBase ? path.join(relBase, entry.name) : entry.name;
      if (entry.isDirectory()) {
        walk(absPath, relPath);
        continue;
      }
      if (entry.isFile() && isStickerFile(relPath)) {
        out.push(relPath);
      }
    }
  };
  walk(rootDir, "");
  return out;
}

function loadBuiltinStickers() {
  const builtinStickerDirs = [
    { dir: BUILTIN_STICKERS_DIR, urlPrefix: "/stickers" },
    { dir: LEGACY_BUILTIN_STICKERS_DIR, urlPrefix: "/sticker" },
  ];
  const out = [];
  const seenUrl = new Set();

  for (const { dir, urlPrefix } of builtinStickerDirs) {
    for (const relPath of readStickerFilesRecursive(dir)) {
      const relNoExt = relPath.replace(path.extname(relPath), "");
      const safeIdPart = relNoExt.replace(/[\\/]+/g, "-");
      const url = toUrlPath(urlPrefix, relPath);
      if (seenUrl.has(url)) continue;
      seenUrl.add(url);
      out.push({
        id: `builtin-${urlPrefix.slice(1)}-${safeIdPart}`,
        url,
        builtin: true,
      });
    }
  }

  return out;
}

function loadUserStickers() {
  return fs.readdirSync(STICKERS_DIR)
    .filter((f) => isStickerFile(f))
    .map((f) => ({
      id: path.basename(f, path.extname(f)),
      url: `/uploaded-stickers/${encodeURIComponent(f)}`,
    }));
}

function rebuildStickerList() {
  const builtinStickers = loadBuiltinStickers();
  const userStickers = loadUserStickers();
  return [...builtinStickers, ...userStickers];
}

let stickers = rebuildStickerList();

async function searchCommonsStickers(q, limit) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: `${q} filemime:gif`,
    gsrnamespace: "6",
    gsrlimit: String(limit),
    prop: "imageinfo",
    iiprop: "url|mime",
    iiurlwidth: "240",
  });

  const response = await fetch(`https://commons.wikimedia.org/w/api.php?${params.toString()}`);
  if (!response.ok) {
    throw new Error("Commons search failed");
  }
  const data = await response.json();
  const pages = Object.values(data?.query?.pages || {});
  const normalized = pages
    .map((page) => {
      const info = Array.isArray(page?.imageinfo) ? page.imageinfo[0] : null;
      const sourceUrl = `${info?.url || ""}`.trim();
      const previewUrl = `${info?.thumburl || sourceUrl}`.trim();
      const mime = `${info?.mime || ""}`.toLowerCase();
      return {
        id: `commons-${page?.pageid || crypto.randomUUID()}`,
        title: `${page?.title || ""}`.replace(/^File:/i, "").trim(),
        url: sourceUrl,
        previewUrl,
        mime,
      };
    })
    .filter((item) => item.url && item.mime === "image/gif" && isGifUrl(item.url))
    .map(({ mime, ...rest }) => rest)
    .slice(0, limit);
  return normalized;
}

app.get("/search-stickers", requireAccess, async (req, res) => {
  const q = `${req.query.q || ""}`.trim();
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) ? Math.min(24, Math.max(1, rawLimit)) : 12;

  if (!q) {
    return res.status(400).json({ error: "Missing query" });
  }

  const tenorApiKey = `${process.env.TENOR_API_KEY || ""}`.trim();
  if (tenorApiKey) {
    const params = new URLSearchParams({
      key: tenorApiKey,
      q,
      limit: String(limit),
      media_filter: "gif,tinygif,mediumgif",
      contentfilter: "off",
      locale: "zh_CN",
    });

    try {
      const response = await fetch(`https://tenor.googleapis.com/v2/search?${params.toString()}`);
      if (!response.ok) {
        return res.status(502).json({ error: "Failed to fetch Tenor results" });
      }
      const data = await response.json();
      const results = Array.isArray(data?.results) ? data.results : [];

      const normalized = results.map((item) => {
        const media = item?.media_formats || {};
        const best = media.mediumgif || media.gif || media.tinygif || null;
        const preview = media.tinygif || media.nanogif || media.gif || best;
        return {
          id: `${item?.id || crypto.randomUUID()}`,
          title: `${item?.content_description || ""}`.trim(),
          url: `${best?.url || ""}`,
          previewUrl: `${preview?.url || best?.url || ""}`,
        };
      }).filter((item) => item.url && isGifUrl(item.url));

      if (normalized.length) {
        return res.json({ results: normalized, provider: "tenor" });
      }
    } catch (_error) {
      // fall through to next provider
    }
  }

  const giphyKey = `${process.env.GIPHY_API_KEY || ""}`.trim();
  if (giphyKey) {
    const giphyParams = new URLSearchParams({
      api_key: giphyKey,
      q,
      limit: String(limit),
      rating: "pg-13",
      lang: "zh-CN",
    });

    try {
      const response = await fetch(`https://api.giphy.com/v1/stickers/search?${giphyParams.toString()}`);
      if (response.ok) {
        const data = await response.json();
        const results = Array.isArray(data?.data) ? data.data : [];
        const normalized = results.map((item) => {
          const images = item?.images || {};
          const best = images.fixed_height || images.original || images.downsized || null;
          const preview = images.fixed_width_small || images.preview_gif || images.downsized_small || best;
          return {
            id: `${item?.id || crypto.randomUUID()}`,
            title: `${item?.title || ""}`.trim(),
            url: `${best?.url || ""}`,
            previewUrl: `${preview?.url || best?.url || ""}`,
          };
        }).filter((item) => item.url && isGifUrl(item.url));
        if (normalized.length) {
          return res.json({ results: normalized, provider: "giphy" });
        }
      }
    } catch (_error) {
      // fall through to next provider
    }
  }

  try {
    const commonsResults = await searchCommonsStickers(q, limit);
    return res.json({ results: commonsResults, provider: "wikimedia-commons" });
  } catch (_error) {
    return res.status(502).json({
      error: "Sticker search unavailable. Configure TENOR_API_KEY or GIPHY_API_KEY to restore full search.",
    });
  }
});

app.post("/import-sticker-url", requireAccess, async (req, res) => {
  const sourceUrl = `${req.body?.url || ""}`.trim();
  if (!sourceUrl) {
    return res.status(400).json({ error: "Missing url" });
  }

  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch (_error) {
    return res.status(400).json({ error: "Invalid url" });
  }
  if (parsed.protocol !== "https:") {
    return res.status(400).json({ error: "Only https urls are allowed" });
  }
  const safeHost = await isSafeRemoteHost(parsed.hostname);
  if (!safeHost) {
    return res.status(400).json({ error: "Blocked host" });
  }

  try {
    const controller = new AbortController();
    let timeoutId = null;
    timeoutId = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(sourceUrl, { signal: controller.signal })
      .finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });
    if (!response.ok) {
      return res.status(502).json({ error: "Failed to download sticker" });
    }

    const contentType = `${response.headers.get("content-type") || ""}`.toLowerCase();
    if (!contentType.startsWith("image/")) {
      return res.status(400).json({ error: "URL does not point to an image" });
    }

    const maxBytes = 25 * 1024 * 1024;
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      return res.status(400).json({ error: "Image is too large (max 25MB)" });
    }

    let buffer = null;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          return res.status(400).json({ error: "Image is too large (max 25MB)" });
        }
        chunks.push(Buffer.from(value));
      }
      buffer = Buffer.concat(chunks, total);
    } else {
      const ab = await response.arrayBuffer();
      buffer = Buffer.from(ab);
      if (buffer.length > maxBytes) {
        return res.status(400).json({ error: "Image is too large (max 25MB)" });
      }
    }

    const extFromType = contentTypeToExtension(contentType);
    const extFromPath = path.extname(parsed.pathname).toLowerCase();
    const ext = extFromType || (isStickerFile(extFromPath) ? extFromPath : ".png");
    const filename = `${crypto.randomUUID()}${ext}`;
    const target = path.join(STICKERS_DIR, filename);
    fs.writeFileSync(target, buffer);

    const sticker = {
      id: path.basename(filename, path.extname(filename)),
      url: `/uploaded-stickers/${filename}`,
    };
    stickers.push(sticker);
    io.emit("stickers", stickers);
    return res.json(sticker);
  } catch (_error) {
    return res.status(502).json({ error: "Failed to import sticker" });
  }
});

app.post("/upload-sticker", requireAccess, (req, res) => {
  stickerUpload.single("sticker")(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "Sticker file is too large (max 25MB)" });
      }
      return res.status(400).json({ error: err.message || "Sticker upload failed" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    const sticker = {
      id: path.basename(req.file.filename, path.extname(req.file.filename)),
      url: `/uploaded-stickers/${req.file.filename}`,
    };
    stickers.push(sticker);
    io.emit("stickers", stickers);
    return res.json(sticker);
  });
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
      typing: !!p.typing,
      lastActiveAt: p.lastActiveAt || 0,
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
  const normalizeTargetUserId = (raw) => {
    const value = `${raw || ""}`.trim();
    return value || null;
  };
  const emitToTargetUserInRoom = (room, targetUserId, eventName, payload) => {
    if (!room || !targetUserId) return 0;
    let sent = 0;
    for (const peerSocket of io.sockets.sockets.values()) {
      if (`${peerSocket.handshake.auth?.tab || peerSocket.id}` !== targetUserId) continue;
      if (!peerSocket.rooms.has(room)) continue;
      peerSocket.emit(eventName, payload);
      sent += 1;
    }
    return sent;
  };

  // Send current state on connect
  socket.emit("scheduled-rooms", scheduledRooms);
  stickers = rebuildStickerList();
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
    username = `${name || ""}`.trim().slice(0, 30);
    currentRoom = room;
    const now = Date.now();

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
        typing: false,
        lastActiveAt: now,
      });
    } else {
      existingParticipant.name = username;
      existingParticipant.typing = false;
      existingParticipant.lastActiveAt = now;
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

  socket.on("typing", ({ isTyping }) => {
    if (!currentRoom) return;
    const participantsMap = roomParticipants.get(currentRoom);
    if (!participantsMap?.has(clientId)) return;

    const participant = participantsMap.get(clientId);
    participant.typing = !!isTyping;
    if (participant.typing) {
      participant.lastActiveAt = Date.now();
    }
    emitRoomParticipants(currentRoom);
  });

  socket.on("call-invite", ({ targetUserId }) => {
    if (!currentRoom) return;
    const target = normalizeTargetUserId(targetUserId);
    const payload = {
      fromUserId: clientId,
      fromName: username || "Unknown",
      targetUserId: target,
    };
    if (target) {
      emitToTargetUserInRoom(currentRoom, target, "call-invite", payload);
      return;
    }
    socket.to(currentRoom).emit("call-invite", {
      ...payload,
    });
  });

  socket.on("call-accepted", ({ targetUserId }) => {
    if (!currentRoom) return;
    const target = normalizeTargetUserId(targetUserId);
    if (!target) return;
    emitToTargetUserInRoom(currentRoom, target, "call-accepted", {
      fromUserId: clientId,
      targetUserId: target,
    });
  });

  socket.on("call-declined", ({ targetUserId }) => {
    if (!currentRoom) return;
    const target = normalizeTargetUserId(targetUserId);
    if (!target) return;
    emitToTargetUserInRoom(currentRoom, target, "call-declined", {
      fromUserId: clientId,
      targetUserId: target,
    });
  });

  socket.on("webrtc-offer", ({ targetUserId, sdp }) => {
    if (!currentRoom || !sdp) return;
    const target = normalizeTargetUserId(targetUserId);
    if (!target) return;
    emitToTargetUserInRoom(currentRoom, target, "webrtc-offer", {
      fromUserId: clientId,
      fromName: username || "Unknown",
      targetUserId: target,
      sdp,
    });
  });

  socket.on("webrtc-answer", ({ targetUserId, sdp }) => {
    if (!currentRoom || !sdp) return;
    const target = normalizeTargetUserId(targetUserId);
    if (!target) return;
    emitToTargetUserInRoom(currentRoom, target, "webrtc-answer", {
      fromUserId: clientId,
      targetUserId: target,
      sdp,
    });
  });

  socket.on("webrtc-ice-candidate", ({ targetUserId, candidate }) => {
    if (!currentRoom || !candidate) return;
    const target = normalizeTargetUserId(targetUserId);
    if (!target) return;
    emitToTargetUserInRoom(currentRoom, target, "webrtc-ice-candidate", {
      fromUserId: clientId,
      targetUserId: target,
      candidate,
    });
  });

  socket.on("webrtc-hangup", ({ targetUserId }) => {
    if (!currentRoom) return;
    const target = normalizeTargetUserId(targetUserId);
    if (!target) return;
    emitToTargetUserInRoom(currentRoom, target, "webrtc-hangup", {
      fromUserId: clientId,
      targetUserId: target,
    });
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
      participant.typing = false;
      participant.lastActiveAt = Date.now();
      emitRoomParticipants(currentRoom);
    }
  });

  socket.on("mark-seen", ({ messageId }) => {
    const id = `${messageId || ""}`.trim();
    if (!currentRoom || !id || !rooms.has(currentRoom)) return;

    const participantsMap = roomParticipants.get(currentRoom);
    const participant = participantsMap?.get(clientId);

    const msg = rooms.get(currentRoom).find((m) => m.id === id && m.type === "user");
    if (!msg) return;

    if (!Array.isArray(msg.seenBy)) {
      msg.seenBy = [msg.userId].filter(Boolean);
    }
    if (msg.seenBy.includes(clientId)) return;

    msg.seenBy.push(clientId);
    if (participant) {
      participant.lastActiveAt = Date.now();
      emitRoomParticipants(currentRoom);
    }
    const seenCount = Math.max(0, msg.seenBy.length - 1);
    io.to(currentRoom).emit("message-seen", { messageId: id, seenCount });
  });

  socket.on("disconnect", () => {
    if (currentRoom) {
      socket.to(currentRoom).emit("webrtc-peer-left", { userId: clientId });
    }
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
