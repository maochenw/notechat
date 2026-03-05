const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("render.com")
    ? { rejectUnauthorized: false }
    : false,
});

// ---------------------------------------------------------------------------
// Schema initialization — auto-creates tables on startup
// ---------------------------------------------------------------------------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS page_visits (
      id SERIAL PRIMARY KEY,
      ip TEXT NOT NULL,
      path TEXT NOT NULL,
      visited_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_visits_visited_at ON page_visits (visited_at);
    CREATE INDEX IF NOT EXISTS idx_visits_ip ON page_visits (ip);

    CREATE TABLE IF NOT EXISTS room_creations (
      id SERIAL PRIMARY KEY,
      ip TEXT NOT NULL,
      room_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_rooms_created_at ON room_creations (created_at);
    CREATE INDEX IF NOT EXISTS idx_rooms_ip ON room_creations (ip);

    CREATE TABLE IF NOT EXISTS room_sessions (
      id SERIAL PRIMARY KEY,
      room_id TEXT NOT NULL,
      ip TEXT NOT NULL,
      joined_at TIMESTAMP DEFAULT NOW(),
      left_at TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_room_id ON room_sessions (room_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_joined_at ON room_sessions (joined_at);

    CREATE TABLE IF NOT EXISTS link_shares (
      id SERIAL PRIMARY KEY,
      room_id TEXT NOT NULL,
      ip TEXT NOT NULL,
      shared_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_shares_shared_at ON link_shares (shared_at);

    CREATE TABLE IF NOT EXISTS room_message_counts (
      id SERIAL PRIMARY KEY,
      room_id TEXT NOT NULL,
      sent_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_msg_counts_room_id ON room_message_counts (room_id);
    CREATE INDEX IF NOT EXISTS idx_msg_counts_sent_at ON room_message_counts (sent_at);

    CREATE TABLE IF NOT EXISTS permanent_rooms (
      id SERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      passphrase_hash TEXT,
      session_id TEXT,
      paid BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_permanent_rooms_slug ON permanent_rooms (slug);
  `);
}

// ---------------------------------------------------------------------------
// Logging (fire-and-forget, errors are silently ignored)
// PRIVACY NOTE: We log IPs and paths only. NEVER log message content.
// ---------------------------------------------------------------------------
function logVisit(ip, path) {
  pool
    .query("INSERT INTO page_visits (ip, path) VALUES ($1, $2)", [ip, path])
    .catch(() => {});
}

function logRoomCreation(ip, roomId) {
  pool
    .query("INSERT INTO room_creations (ip, room_id) VALUES ($1, $2)", [ip, roomId])
    .catch(() => {});
}

function logRoomJoin(ip, roomId) {
  return pool
    .query(
      "INSERT INTO room_sessions (room_id, ip) VALUES ($1, $2) RETURNING id",
      [roomId, ip]
    )
    .then((res) => res.rows[0].id)
    .catch(() => null);
}

function logRoomLeave(sessionId) {
  if (!sessionId) return;
  pool
    .query("UPDATE room_sessions SET left_at = NOW() WHERE id = $1", [sessionId])
    .catch(() => {});
}

function logLinkShare(ip, roomId) {
  pool
    .query("INSERT INTO link_shares (room_id, ip) VALUES ($1, $2)", [roomId, ip])
    .catch(() => {});
}

function logMessage(roomId) {
  pool
    .query("INSERT INTO room_message_counts (room_id) VALUES ($1)", [roomId])
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Analytics queries
// ---------------------------------------------------------------------------

function periodFilter(column, period) {
  switch (period) {
    case "day":
      return `${column} >= NOW() - INTERVAL '1 day'`;
    case "week":
      return `${column} >= NOW() - INTERVAL '7 days'`;
    case "month":
      return `${column} >= NOW() - INTERVAL '30 days'`;
    default:
      return `${column} >= NOW() - INTERVAL '1 day'`;
  }
}

async function getVisitorStats() {
  const periods = ["day", "week", "month"];
  const results = {};

  for (const period of periods) {
    const filter = periodFilter("visited_at", period);
    const total = await pool.query(
      `SELECT COUNT(*) AS count FROM page_visits WHERE ${filter}`
    );
    const unique = await pool.query(
      `SELECT COUNT(DISTINCT ip) AS count FROM page_visits WHERE ${filter}`
    );
    results[period] = {
      totalVisits: parseInt(total.rows[0].count, 10),
      uniqueVisitors: parseInt(unique.rows[0].count, 10),
    };
  }

  return results;
}

async function getRoomStats() {
  const periods = ["day", "week", "month"];
  const results = {};

  for (const period of periods) {
    const filter = periodFilter("created_at", period);
    const total = await pool.query(
      `SELECT COUNT(*) AS count FROM room_creations WHERE ${filter}`
    );
    results[period] = {
      roomsCreated: parseInt(total.rows[0].count, 10),
    };
  }

  return results;
}

async function getRoomsPerUser() {
  // Average rooms per IP and top 10 creators
  const avg = await pool.query(`
    SELECT ROUND(AVG(room_count)::numeric, 2) AS avg_rooms
    FROM (SELECT ip, COUNT(*) AS room_count FROM room_creations GROUP BY ip) sub
  `);

  const top = await pool.query(`
    SELECT ip, COUNT(*) AS room_count
    FROM room_creations
    GROUP BY ip
    ORDER BY room_count DESC
    LIMIT 10
  `);

  return {
    avgRoomsPerUser: parseFloat(avg.rows[0]?.avg_rooms) || 0,
    topCreators: top.rows.map((r) => ({
      ip: r.ip,
      rooms: parseInt(r.room_count, 10),
    })),
  };
}

async function getRetention() {
  // % of visitors who visited on more than 1 distinct day in the last 30 days
  const totalUnique = await pool.query(`
    SELECT COUNT(DISTINCT ip) AS count
    FROM page_visits
    WHERE visited_at >= NOW() - INTERVAL '30 days'
  `);

  const returning = await pool.query(`
    SELECT COUNT(*) AS count FROM (
      SELECT ip
      FROM page_visits
      WHERE visited_at >= NOW() - INTERVAL '30 days'
      GROUP BY ip
      HAVING COUNT(DISTINCT DATE(visited_at)) > 1
    ) sub
  `);

  const total = parseInt(totalUnique.rows[0].count, 10);
  const ret = parseInt(returning.rows[0].count, 10);

  // Also get retention by period
  const retention7d = await pool.query(`
    SELECT COUNT(*) AS count FROM (
      SELECT ip
      FROM page_visits
      WHERE visited_at >= NOW() - INTERVAL '7 days'
      GROUP BY ip
      HAVING COUNT(DISTINCT DATE(visited_at)) > 1
    ) sub
  `);
  const total7d = await pool.query(`
    SELECT COUNT(DISTINCT ip) AS count
    FROM page_visits
    WHERE visited_at >= NOW() - INTERVAL '7 days'
  `);

  const retention1d = await pool.query(`
    SELECT COUNT(*) AS count FROM (
      SELECT ip
      FROM page_visits
      WHERE visited_at >= NOW() - INTERVAL '1 day'
        AND ip IN (
          SELECT DISTINCT ip FROM page_visits
          WHERE visited_at < NOW() - INTERVAL '1 day'
        )
      GROUP BY ip
    ) sub
  `);
  const total1d = await pool.query(`
    SELECT COUNT(DISTINCT ip) AS count
    FROM page_visits
    WHERE visited_at >= NOW() - INTERVAL '1 day'
  `);

  const t1d = parseInt(total1d.rows[0].count, 10);
  const r1d = parseInt(retention1d.rows[0].count, 10);
  const t7d = parseInt(total7d.rows[0].count, 10);
  const r7d = parseInt(retention7d.rows[0].count, 10);

  return {
    day: { total: t1d, returning: r1d, rate: t1d > 0 ? Math.round((r1d / t1d) * 100) : 0 },
    week: { total: t7d, returning: r7d, rate: t7d > 0 ? Math.round((r7d / t7d) * 100) : 0 },
    month: { total, returning: ret, rate: total > 0 ? Math.round((ret / total) * 100) : 0 },
  };
}

async function getAvgTimeOnRoom() {
  const result = await pool.query(`
    SELECT
      ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(left_at, NOW()) - joined_at)))::numeric, 0) AS avg_seconds
    FROM room_sessions
    WHERE joined_at >= NOW() - INTERVAL '30 days'
  `);
  const avgSeconds = parseInt(result.rows[0]?.avg_seconds, 10) || 0;
  const minutes = Math.floor(avgSeconds / 60);
  const seconds = avgSeconds % 60;
  return { avgSeconds, formatted: `${minutes}m ${seconds}s` };
}

async function getLinkShareStats() {
  const periods = ["day", "week", "month"];
  const results = {};

  for (const period of periods) {
    const filter = periodFilter("shared_at", period);
    const total = await pool.query(
      `SELECT COUNT(*) AS count FROM link_shares WHERE ${filter}`
    );
    const unique = await pool.query(
      `SELECT COUNT(DISTINCT room_id) AS count FROM link_shares WHERE ${filter}`
    );
    results[period] = {
      totalShares: parseInt(total.rows[0].count, 10),
      uniqueRooms: parseInt(unique.rows[0].count, 10),
    };
  }

  return results;
}

// ---------------------------------------------------------------------------
// Permanent room queries
// ---------------------------------------------------------------------------

async function createPermanentRoom(slug, passphraseHash, sessionId) {
  const result = await pool.query(
    `INSERT INTO permanent_rooms (slug, passphrase_hash, session_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [slug, passphraseHash || null, sessionId]
  );
  return result.rows[0].id;
}

async function markPermanentRoomPaid(sessionId) {
  const result = await pool.query(
    `UPDATE permanent_rooms SET paid = TRUE WHERE session_id = $1 RETURNING slug`,
    [sessionId]
  );
  return result.rows[0] || null;
}

async function getPermanentRoom(slug) {
  const result = await pool.query(
    `SELECT * FROM permanent_rooms WHERE slug = $1 AND paid = TRUE`,
    [slug]
  );
  return result.rows[0] || null;
}

async function slugExists(slug) {
  const result = await pool.query(
    `SELECT 1 FROM permanent_rooms WHERE slug = $1`,
    [slug]
  );
  return result.rows.length > 0;
}

async function cleanupUnpaidRooms() {
  await pool.query(
    `DELETE FROM permanent_rooms WHERE paid = FALSE AND created_at < NOW() - INTERVAL '1 hour'`
  );
}

async function deletePermanentRoom(slug) {
  await pool.query(`DELETE FROM permanent_rooms WHERE slug = $1`, [slug]);
}

async function getRoomBySessionId(sessionId) {
  const result = await pool.query(
    `SELECT * FROM permanent_rooms WHERE session_id = $1`,
    [sessionId]
  );
  return result.rows[0] || null;
}

async function getFunnelStats() {
  const periods = ["day", "week", "month"];
  const results = {};

  for (const period of periods) {
    const visitFilter = periodFilter("visited_at", period);
    const createFilter = periodFilter("created_at", period);
    const sessionFilter = periodFilter("joined_at", period);

    // Step 1: Unique visitors
    const visitors = await pool.query(
      `SELECT COUNT(DISTINCT ip) AS count FROM page_visits WHERE ${visitFilter}`
    );

    // Step 2: Unique users who created a room
    const creators = await pool.query(
      `SELECT COUNT(DISTINCT ip) AS count FROM room_creations WHERE ${createFilter}`
    );

    // Step 3: Creators who shared the link
    const sharers = await pool.query(
      `SELECT COUNT(DISTINCT rc.ip) AS count
       FROM room_creations rc
       WHERE ${createFilter.replace("created_at", "rc.created_at")}
         AND EXISTS (
           SELECT 1 FROM link_shares ls WHERE ls.room_id = rc.room_id
         )`
    );

    // Step 4: Creators whose room had a conversation (2+ distinct users)
    const conversations = await pool.query(
      `SELECT COUNT(DISTINCT rc.ip) AS count
       FROM room_creations rc
       WHERE ${createFilter.replace("created_at", "rc.created_at")}
         AND EXISTS (
           SELECT 1 FROM room_sessions rs
           WHERE rs.room_id = rc.room_id
           GROUP BY rs.room_id
           HAVING COUNT(DISTINCT rs.ip) >= 2
         )`
    );

    // Avg session duration (completed sessions only)
    const avgDuration = await pool.query(
      `SELECT ROUND(AVG(EXTRACT(EPOCH FROM (left_at - joined_at)))::numeric, 0) AS avg_seconds
       FROM room_sessions
       WHERE left_at IS NOT NULL AND ${sessionFilter}`
    );

    // Rooms with 2+ people at auto-destruction (sessions ending within 5s of each other)
    const roomsAtDestruction = await pool.query(
      `SELECT COUNT(*) AS count FROM (
         SELECT rs.room_id
         FROM room_sessions rs
         JOIN room_creations rc ON rc.room_id = rs.room_id
         WHERE rs.left_at IS NOT NULL
           AND ${sessionFilter.replace("joined_at", "rs.joined_at")}
           AND EXTRACT(EPOCH FROM (rs.left_at - rc.created_at)) BETWEEN 570 AND 630
         GROUP BY rs.room_id
         HAVING COUNT(DISTINCT rs.ip) >= 2
       ) sub`
    );

    // Avg time for second person to join
    const timeToSecond = await pool.query(
      `SELECT ROUND(AVG(second_join_delay)::numeric, 0) AS avg_seconds FROM (
         SELECT rc.room_id,
           EXTRACT(EPOCH FROM (
             MIN(rs.joined_at) FILTER (WHERE rs.ip != rc.ip) - rc.created_at
           )) AS second_join_delay
         FROM room_creations rc
         JOIN room_sessions rs ON rs.room_id = rc.room_id
         WHERE ${createFilter.replace("created_at", "rc.created_at")}
         GROUP BY rc.room_id, rc.ip, rc.created_at
         HAVING COUNT(DISTINCT rs.ip) >= 2
       ) sub
       WHERE second_join_delay > 0`
    );

    // Avg messages per room
    const msgFilter = periodFilter("sent_at", period);
    const messagesPerRoom = await pool.query(
      `SELECT ROUND(AVG(msg_count)::numeric, 1) AS avg_messages FROM (
         SELECT room_id, COUNT(*) AS msg_count
         FROM room_message_counts
         WHERE ${msgFilter}
         GROUP BY room_id
       ) sub`
    );

    const avgSec = parseInt(avgDuration.rows[0]?.avg_seconds, 10) || 0;
    const avgSecondJoin = parseInt(timeToSecond.rows[0]?.avg_seconds, 10) || 0;
    const avgMsgs = parseFloat(messagesPerRoom.rows[0]?.avg_messages) || 0;

    results[period] = {
      uniqueVisitors: parseInt(visitors.rows[0].count, 10),
      roomCreators: parseInt(creators.rows[0].count, 10),
      linkSharers: parseInt(sharers.rows[0].count, 10),
      conversationsStarted: parseInt(conversations.rows[0].count, 10),
      avgSessionDuration: {
        seconds: avgSec,
        formatted: `${Math.floor(avgSec / 60)}m ${avgSec % 60}s`,
      },
      roomsWithMultipleAtDestruction: parseInt(roomsAtDestruction.rows[0].count, 10),
      avgTimeToSecondJoiner: {
        seconds: avgSecondJoin,
        formatted: avgSecondJoin > 0
          ? `${Math.floor(avgSecondJoin / 60)}m ${avgSecondJoin % 60}s`
          : "—",
      },
      avgMessagesPerRoom: avgMsgs,
    };
  }

  return results;
}

async function getPermanentRoomStats() {
  const result = await pool.query(`
    SELECT pr.slug, pr.created_at,
      COUNT(rs.id) AS session_count
    FROM permanent_rooms pr
    LEFT JOIN room_sessions rs ON rs.room_id = pr.slug
    WHERE pr.paid = TRUE
    GROUP BY pr.slug, pr.created_at
    ORDER BY pr.created_at DESC
  `);
  return result.rows.map((r) => ({
    slug: r.slug,
    createdAt: r.created_at,
    sessionCount: parseInt(r.session_count, 10),
  }));
}

async function updateCodeword(slug, passphraseHash) {
  await pool.query(
    `UPDATE permanent_rooms SET passphrase_hash = $1 WHERE slug = $2`,
    [passphraseHash, slug]
  );
}

async function getSessionList() {
  const result = await pool.query(`
    SELECT
      rc.room_id,
      rc.created_at,
      ROUND(EXTRACT(EPOCH FROM (
        COALESCE(MAX(rs.left_at), NOW()) - rc.created_at
      ))::numeric, 0) AS duration_seconds,
      COUNT(DISTINCT rs.ip) AS people_count,
      COALESCE(mc.msg_count, 0) AS message_count
    FROM room_creations rc
    LEFT JOIN room_sessions rs ON rs.room_id = rc.room_id
    LEFT JOIN (
      SELECT room_id, COUNT(*) AS msg_count
      FROM room_message_counts
      GROUP BY room_id
    ) mc ON mc.room_id = rc.room_id
    WHERE rc.created_at >= NOW() - INTERVAL '30 days'
    GROUP BY rc.room_id, rc.created_at, mc.msg_count
    ORDER BY rc.created_at DESC
    LIMIT 100
  `);

  return result.rows.map((r) => {
    const secs = parseInt(r.duration_seconds, 10) || 0;
    const mins = Math.floor(secs / 60);
    const remSecs = secs % 60;
    return {
      roomId: r.room_id,
      createdAt: r.created_at,
      duration: { seconds: secs, formatted: `${mins}m ${remSecs}s` },
      people: parseInt(r.people_count, 10),
      messages: parseInt(r.message_count, 10),
    };
  });
}

module.exports = {
  initDb,
  logVisit,
  logRoomCreation,
  logRoomJoin,
  logRoomLeave,
  logLinkShare,
  logMessage,
  getVisitorStats,
  getRoomStats,
  getRoomsPerUser,
  getRetention,
  getAvgTimeOnRoom,
  getLinkShareStats,
  createPermanentRoom,
  markPermanentRoomPaid,
  getPermanentRoom,
  slugExists,
  cleanupUnpaidRooms,
  deletePermanentRoom,
  getRoomBySessionId,
  updateCodeword,
  getPermanentRoomStats,
  getFunnelStats,
  getSessionList,
};
