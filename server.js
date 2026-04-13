const express = require("express");
const http = require("http");
const cors = require("cors");
const crypto = require("crypto");
const { Server } = require("socket.io");
const { createClient } = require("redis");

const app = express();
const server = http.createServer(app);

const SOCKET_JWT_SECRET = String(process.env.SOCKET_JWT_SECRET || "");
const SOCKET_SERVER_SECRET = String(process.env.SOCKET_SERVER_SECRET || "");
const SOCKET_MAX_EMIT_DRIFT_SECONDS = Number(process.env.SOCKET_MAX_EMIT_DRIFT_SECONDS || 30);
const SOCKET_EMIT_RATE_LIMIT_WINDOW_MS = Number(process.env.SOCKET_EMIT_RATE_LIMIT_WINDOW_MS || 1000);
const SOCKET_EMIT_RATE_LIMIT_MAX = Number(process.env.SOCKET_EMIT_RATE_LIMIT_MAX || 120);
const SOCKET_JTI_REPLAY_STRICT = String(process.env.SOCKET_JTI_REPLAY_STRICT || "true").toLowerCase() === "true";
const SOCKET_JTI_REDIS_PREFIX = String(process.env.SOCKET_JTI_REDIS_PREFIX || "socket:jti:");
const REDIS_URL = String(process.env.REDIS_URL || "");
const CLIENT_EVENT_ALLOWLIST = String(process.env.SOCKET_CLIENT_EVENT_ALLOWLIST || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const SERVER_EMIT_EVENT_ALLOWLIST = String(process.env.SOCKET_SERVER_EVENT_ALLOWLIST || "stock.updated")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const corsOrigin = process.env.SOCKET_CORS_ORIGIN || "*";
const parsedOrigins = corsOrigin === "*" ? true : corsOrigin.split(",").map((item) => item.trim());

const io = new Server(server, {
  cors: {
    origin: parsedOrigins,
    methods: ["GET", "POST"],
  },
});

app.use(
  cors({
    origin: parsedOrigins,
  })
);
app.use(express.json({ limit: "64kb" }));

const securityLog = (event, details = {}) => {
  // eslint-disable-next-line no-console
  console.warn(`[socket-security] ${event}`, details);
};

const auditLog = (event, details = {}) => {
  // eslint-disable-next-line no-console
  console.log(`[socket-audit] ${event}`, details);
};

const emitRateLimitMap = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of emitRateLimitMap.entries()) {
    if (!bucket || now > bucket.resetAt) {
      emitRateLimitMap.delete(ip);
    }
  }
}, 60_000).unref();

let redisClient = null;

if (REDIS_URL !== "") {
  redisClient = createClient({ url: REDIS_URL });
  redisClient.on("error", (error) => {
    securityLog("redis_error", { message: error.message });
  });
}

const base64UrlEncode = (value) =>
  Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

const base64UrlDecode = (value) => {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const paddingLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(paddingLength);
  return Buffer.from(padded, "base64").toString("utf8");
};

const stableStringify = (value) => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  const pairs = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${pairs.join(",")}}`;
};

const timingSafeEqualHex = (receivedHex, expectedHex) => {
  if (typeof receivedHex !== "string" || typeof expectedHex !== "string") {
    return false;
  }

  const received = Buffer.from(receivedHex, "hex");
  const expected = Buffer.from(expectedHex, "hex");
  if (received.length === 0 || expected.length === 0 || received.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(received, expected);
};

const isPositiveInt = (value) => Number.isInteger(value) && value > 0;

const sanitizeLocationIds = (input) => {
  if (!Array.isArray(input)) {
    return [];
  }

  const values = input
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0);

  return [...new Set(values)];
};

const isEmitRateLimited = (ipAddress) => {
  const ip = String(ipAddress || "unknown");
  const now = Date.now();
  const existing = emitRateLimitMap.get(ip);

  if (!existing || now > existing.resetAt) {
    emitRateLimitMap.set(ip, {
      count: 1,
      resetAt: now + SOCKET_EMIT_RATE_LIMIT_WINDOW_MS,
    });
    return false;
  }

  existing.count += 1;
  if (existing.count > SOCKET_EMIT_RATE_LIMIT_MAX) {
    return true;
  }

  return false;
};

const consumeSocketJti = async (jti) => {
  if (typeof jti !== "string" || jti.trim() === "") {
    throw new Error("token_jti_missing");
  }

  if (!redisClient) {
    if (SOCKET_JTI_REPLAY_STRICT) {
      throw new Error("jti_store_unavailable");
    }

    return;
  }

  if (!redisClient.isOpen) {
    await redisClient.connect();
  }

  const redisKey = `${SOCKET_JTI_REDIS_PREFIX}${jti}`;
  const current = await redisClient.get(redisKey);

  if (!current) {
    throw new Error("token_jti_replayed_or_unknown");
  }

  if (SOCKET_JTI_REPLAY_STRICT) {
    await redisClient.del(redisKey);
  }
};

const verifySocketJwt = (token) => {
  if (!SOCKET_JWT_SECRET) {
    throw new Error("socket_jwt_secret_missing");
  }

  if (typeof token !== "string" || token.trim() === "") {
    throw new Error("token_missing");
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("token_malformed");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = crypto
    .createHmac("sha256", SOCKET_JWT_SECRET)
    .update(signingInput)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  const providedSignatureBuffer = Buffer.from(encodedSignature);
  const expectedSignatureBuffer = Buffer.from(expectedSignature);
  if (
    providedSignatureBuffer.length !== expectedSignatureBuffer.length ||
    !crypto.timingSafeEqual(providedSignatureBuffer, expectedSignatureBuffer)
  ) {
    throw new Error("token_signature_invalid");
  }

  let header = null;
  let payload = null;

  try {
    header = JSON.parse(base64UrlDecode(encodedHeader));
    payload = JSON.parse(base64UrlDecode(encodedPayload));
  } catch (_error) {
    throw new Error("token_decode_invalid");
  }

  if (!header || header.alg !== "HS256" || header.typ !== "JWT") {
    throw new Error("token_header_invalid");
  }

  const nowTs = Math.floor(Date.now() / 1000);
  const exp = Number(payload?.exp);
  const iat = Number(payload?.iat);

  if (!Number.isFinite(exp) || exp <= nowTs) {
    throw new Error("token_expired");
  }

  if (!Number.isFinite(iat) || iat > nowTs + 30) {
    throw new Error("token_iat_invalid");
  }

  const userId = Number(payload?.sub ?? payload?.user_id);
  const jti = String(payload?.jti || "").trim();
  const businessId = Number(payload?.business_id);
  const locationIds = sanitizeLocationIds(payload?.location_ids);
  const role = String(payload?.role || "").trim();

  if (!isPositiveInt(userId)) {
    throw new Error("token_sub_invalid");
  }

  if (!isPositiveInt(businessId)) {
    throw new Error("token_business_invalid");
  }

  if (jti === "") {
    throw new Error("token_jti_missing");
  }

  return {
    userId,
    jti,
    businessId,
    locationIds,
    role: role || "user",
    exp,
  };
};

const isAllowedRoomFormat = (room) => {
  if (typeof room !== "string" || room.trim() === "") {
    return false;
  }

  if (/^business:\d+$/.test(room)) {
    return true;
  }

  if (/^location:\d+:\d+$/.test(room)) {
    return true;
  }

  return /^device:[A-Za-z0-9\-_.:]+$/.test(room);
};

io.use(async (socket, next) => {
  try {
    const token = socket.handshake?.auth?.token;
    const user = verifySocketJwt(token);
    await consumeSocketJti(user.jti);

    socket.user = user;
    return next();
  } catch (error) {
    const reason = error instanceof Error ? error.message : "token_invalid";
    securityLog("invalid_token", {
      socketId: socket.id,
      ip: socket.handshake.address,
      reason,
    });

    return next(new Error("unauthorized"));
  }
});

io.on("connection", (socket) => {
  const { user } = socket;
  if (!user) {
    securityLog("missing_user_context", { socketId: socket.id });
    socket.disconnect(true);
    return;
  }

  const businessRoom = `business:${user.businessId}`;
  socket.join(businessRoom);

  for (const locationId of user.locationIds) {
    const locationRoom = `location:${user.businessId}:${locationId}`;
    socket.join(locationRoom);
  }

  auditLog("client_connected", {
    socketId: socket.id,
    userId: user.userId,
    businessId: user.businessId,
    locationIds: user.locationIds,
    role: user.role,
  });

  socket.onAny((eventName) => {
    if (!CLIENT_EVENT_ALLOWLIST.includes(eventName)) {
      securityLog("client_event_blocked", {
        socketId: socket.id,
        userId: user.userId,
        event: eventName,
      });
      return;
    }

    securityLog("client_event_allowlist_hit", {
      socketId: socket.id,
      userId: user.userId,
      event: eventName,
    });
  });

  socket.on("disconnect", (reason) => {
    auditLog("client_disconnected", {
      socketId: socket.id,
      userId: user.userId,
      reason,
    });
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/emit", (req, res) => {
  if (isEmitRateLimited(req.ip)) {
    securityLog("emit_rate_limited", { ip: req.ip });
    return res.status(429).json({ success: false, message: "too many requests" });
  }

  if (!SOCKET_SERVER_SECRET) {
    securityLog("emit_secret_missing");
    return res.status(500).json({ success: false, message: "server secret is not configured" });
  }

  const { event, room, data, ts, signature } = req.body ?? {};

  if (typeof event !== "string" || event.trim() === "") {
    return res.status(422).json({ success: false, message: "event is required" });
  }

  if (!SERVER_EMIT_EVENT_ALLOWLIST.includes(event)) {
    securityLog("emit_event_not_allowlisted", { event });
    return res.status(403).json({ success: false, message: "event is not allowed" });
  }

  if (!isAllowedRoomFormat(room)) {
    securityLog("emit_room_invalid", { room });
    return res.status(422).json({ success: false, message: "room is invalid" });
  }

  if (event === "stock.updated" && !/^location:\d+:\d+$/.test(room)) {
    securityLog("emit_room_not_location_scoped", { event, room });
    return res.status(422).json({ success: false, message: "room must be location scoped" });
  }

  const tsNumber = Number(ts);
  if (!Number.isInteger(tsNumber)) {
    securityLog("emit_timestamp_invalid", { ts });
    return res.status(422).json({ success: false, message: "ts is invalid" });
  }

  const drift = Math.abs(Math.floor(Date.now() / 1000) - tsNumber);
  if (drift > SOCKET_MAX_EMIT_DRIFT_SECONDS) {
    securityLog("emit_timestamp_drift_exceeded", {
      drift,
      maxDrift: SOCKET_MAX_EMIT_DRIFT_SECONDS,
    });
    return res.status(401).json({ success: false, message: "timestamp drift too high" });
  }

  const normalizedData = data && typeof data === "object" ? data : {};
  const payload = {
    event,
    room,
    data: normalizedData,
    ts: tsNumber,
  };

  const expectedSignature = crypto
    .createHmac("sha256", SOCKET_SERVER_SECRET)
    .update(stableStringify(payload))
    .digest("hex");

  if (!timingSafeEqualHex(String(signature || ""), expectedSignature)) {
    securityLog("invalid_signature", {
      event,
      room,
      ts: tsNumber,
    });
    return res.status(401).json({ success: false, message: "signature is invalid" });
  }

  io.to(room).emit(event, normalizedData);
  auditLog("server_emit_forwarded", {
    event,
    room,
  });

  return res.json({ success: true });
});

const port = Number(process.env.PORT || 3001);

const start = async () => {
  if (redisClient && !redisClient.isOpen) {
    try {
      await redisClient.connect();
      auditLog("redis_connected", { url: REDIS_URL });
    } catch (error) {
      securityLog("redis_connect_failed", {
        message: error instanceof Error ? error.message : "unknown",
      });

      if (SOCKET_JTI_REPLAY_STRICT) {
        process.exit(1);
      }
    }
  }

  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`[socket-server] listening on :${port}`);
  });
};

void start();
