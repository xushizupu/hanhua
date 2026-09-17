import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { classes, classIds, commonPhrases, getClassById, publicDir } from "./config.mjs";
import { createAgentToken, createTeacherToken, safeCompare, verifyAgentToken, verifyTeacherToken } from "./auth.mjs";
import { createStorage } from "./storage.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || "2468";
const AUTH_SECRET = process.env.AUTH_SECRET || "dev-auth-secret-change-me";
const AGENT_SECRET = process.env.AGENT_SECRET || "dev-agent-secret-change-me";
const SESSION_TTL_SECONDS = 90 * 24 * 60 * 60;
const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const AGENT_PING_INTERVAL_MS = 30 * 1000;
const DELIVERY_ACK_TIMEOUT_MS = 10 * 1000;
const MIN_DELIVERY_RETENTION_MS = 10 * 60 * 1000;

let agentSecrets = {};
try {
  agentSecrets = process.env.AGENT_SECRETS_JSON ? JSON.parse(process.env.AGENT_SECRETS_JSON) : {};
} catch {
  console.warn("AGENT_SECRETS_JSON 格式错误，已使用默认 AGENT_SECRET。");
}

function validateEnvironment() {
  if (process.env.NODE_ENV !== "production") {
    return;
  }

  const missing = [];
  if (!process.env.TEACHER_PASSWORD) missing.push("TEACHER_PASSWORD");
  if (!process.env.AUTH_SECRET) missing.push("AUTH_SECRET");
  if (!process.env.AGENT_SECRETS_JSON && !process.env.AGENT_SECRET) missing.push("AGENT_SECRETS_JSON");
  if (!process.env.UPSTASH_REDIS_REST_URL) missing.push("UPSTASH_REDIS_REST_URL");
  if (!process.env.UPSTASH_REDIS_REST_TOKEN) missing.push("UPSTASH_REDIS_REST_TOKEN");

  if (missing.length) {
    throw new Error(`生产环境缺少必要配置：${missing.join(", ")}`);
  }
}

const storage = createStorage();
const teacherSockets = new Set();
const agentSockets = new Map();
const devicePresence = new Map();
const wss = new WebSocketServer({ noServer: true });
const agentPingTimer = setInterval(() => {
  for (const sockets of agentSockets.values()) {
    for (const socket of sockets) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }
  }
}, AGENT_PING_INTERVAL_MS);
agentPingTimer.unref?.();

let state = {
  version: 1,
  updatedAt: new Date().toISOString(),
  batches: []
};

function cleanText(value, maxLength) {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function toIso(value = Date.now()) {
  return new Date(value).toISOString();
}

function pruneState() {
  const cutoff = Date.now() - HISTORY_RETENTION_MS;
  state.batches = (state.batches || []).filter((batch) => {
    const createdAt = new Date(batch.createdAt).getTime();
    return Number.isFinite(createdAt) && createdAt >= cutoff;
  });
}

async function initialize() {
  validateEnvironment();
  const savedState = await storage.load();
  if (savedState && Array.isArray(savedState.batches)) {
    state = {
      version: Number(savedState.version) || 1,
      updatedAt: savedState.updatedAt || new Date().toISOString(),
      batches: savedState.batches
    };
  }
  pruneState();
}

async function persistState() {
  state.version += 1;
  state.updatedAt = new Date().toISOString();
  await storage.save(state);
}

function getTeacherIdentity(req, url) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ")
    ? header.slice(7).trim()
    : url.searchParams.get("token");
  return verifyTeacherToken(token, AUTH_SECRET);
}

function getAgentSecret(classId) {
  return agentSecrets[classId] || AGENT_SECRET;
}

function getAgentIdentity(req, url) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ")
    ? header.slice(7).trim()
    : url.searchParams.get("token");
  const classId = cleanText(url.searchParams.get("classId"), 64);

  if (!classId || !classIds.has(classId)) {
    return null;
  }

  const identity = verifyAgentToken(token, getAgentSecret(classId));
  if (!identity || identity.classId !== classId) {
    return null;
  }
  return identity;
}

function getDeviceStatus() {
  const now = Date.now();
  return Object.fromEntries(classes.map((classItem) => {
    const presence = devicePresence.get(classItem.id);
    const connections = agentSockets.get(classItem.id)?.size || 0;
    return [classItem.id, {
      online: Boolean(
        connections > 0
        && presence
        && now - presence.lastSeenAt < 90 * 1000
      ),
      lastSeenAt: presence?.lastSeenAt ? toIso(presence.lastSeenAt) : null,
      version: presence?.version || "",
      connections
    }];
  }));
}

function isDeliveryExpired(batch) {
  const cutoff = batch.deliveryExpiresAt || batch.expiresAt;
  return Boolean(cutoff && new Date(cutoff).getTime() <= Date.now());
}

function presentBatch(batch, teacherId) {
  const targetClassIds = batch.targetClassIds || [];
  const deliveries = batch.deliveries || {};
  const deliveredCount = targetClassIds.filter((classId) => deliveries[classId]?.deliveredAt).length;
  const acknowledgedCount = targetClassIds.filter((classId) => deliveries[classId]?.acknowledgedAt).length;
  const expired = isDeliveryExpired(batch);
  let status = "pending";

  if (acknowledgedCount === targetClassIds.length && targetClassIds.length > 0) {
    status = "acknowledged";
  } else if (expired) {
    status = "expired";
  } else if (deliveredCount === targetClassIds.length && targetClassIds.length > 0) {
    status = "delivered";
  }

  return {
    id: batch.id,
    teacherId: batch.teacherId,
    teacherName: batch.teacherName,
    targetClassIds,
    targetClassNames: targetClassIds.map((classId) => getClassById(classId)?.name || classId),
    content: batch.content,
    priority: batch.priority,
    visibility: batch.visibility,
    duration: batch.duration,
    createdAt: batch.createdAt,
    expiresAt: batch.expiresAt,
    status,
    deliveredCount,
    acknowledgedCount,
    targetCount: targetClassIds.length,
    mine: batch.teacherId === teacherId,
    deliveries: Object.fromEntries(targetClassIds.map((classId) => [
      classId,
      {
        classId,
        className: getClassById(classId)?.name || classId,
        deliveredAt: deliveries[classId]?.deliveredAt || null,
        acknowledgedAt: deliveries[classId]?.acknowledgedAt || null
      }
    ]))
  };
}

function visibleBatches(teacherId) {
  return (state.batches || [])
    .filter((batch) => batch.visibility === "public" || batch.teacherId === teacherId)
    .map((batch) => presentBatch(batch, teacherId));
}

function getTeacherSnapshot(identity) {
  return {
    teacher: {
      id: identity.teacherId,
      name: identity.teacherName
    },
    classes,
    commonPhrases,
    batches: visibleBatches(identity.teacherId),
    deviceStatus: getDeviceStatus(),
    version: state.version,
    serverTime: toIso()
  };
}

function getAgentBatch(batch, classId) {
  return {
    batchId: batch.id,
    classId,
    teacherName: batch.teacherName,
    content: batch.content,
    priority: batch.priority,
    visibility: batch.visibility,
    createdAt: batch.createdAt,
    expiresAt: batch.expiresAt
  };
}

function pendingBatchesForClass(classId) {
  return (state.batches || []).filter((batch) => {
    const delivery = batch.deliveries?.[classId];
    return delivery
      && batch.targetClassIds?.includes(classId)
      && !delivery.acknowledgedAt
      && !isDeliveryExpired(batch);
  });
}

function setDevicePresence(classId, identity, appVersion = "") {
  devicePresence.set(classId, {
    lastSeenAt: Date.now(),
    deviceId: identity.deviceId,
    version: cleanText(appVersion, 32)
  });
}

function sendJson(res, statusCode, body, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(JSON.stringify(body));
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

function getCorsHeaders(req) {
  const origin = req.headers.origin || "";
  const configured = (process.env.ALLOWED_ORIGINS || "*")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!configured.length) {
    return {};
  }
  const allowOrigin = configured.includes("*")
    ? "*"
    : configured.includes(origin)
      ? origin
      : configured[0] || "*";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Agent-Token",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    Vary: "Origin"
  };
}

function applyCors(req, res) {
  for (const [key, value] of Object.entries(getCorsHeaders(req))) {
    res.setHeader(key, value);
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(new Error("请求内容过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("JSON 格式错误"));
      }
    });
    req.on("error", reject);
  });
}

function getMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml"
  }[extension] || "application/octet-stream";
}

function serveStatic(req, res, pathname) {
  const routeFiles = {
    "/": "teacher.html",
    "/teacher": "teacher.html",
    "/simulator": "simulator.html"
  };
  const relativePath = routeFiles[pathname] || pathname.replace(/^\/+/, "");
  const filePath = path.resolve(publicDir, relativePath);
  const relativeToPublic = path.relative(publicDir, filePath);

  if (relativeToPublic.startsWith("..") || path.isAbsolute(relativeToPublic)) {
    sendError(res, 404, "页面不存在");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendError(res, 404, "页面不存在");
      return;
    }
    res.writeHead(200, {
      "Content-Type": getMimeType(filePath),
      "Cache-Control": "no-cache"
    });
    res.end(content);
  });
}

function broadcastTeachers() {
  for (const socket of teacherSockets) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: "snapshot",
        data: getTeacherSnapshot(socket.identity)
      }));
    }
  }
}

function broadcastAgents() {
  for (const [classId, sockets] of agentSockets.entries()) {
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN && socket.isAlive !== false) {
        sendPendingToAgent(classId, socket);
      }
    }
  }
}

async function markBatchDelivered(batchId, classId) {
  const batch = state.batches.find((item) => item.id === batchId);
  const delivery = batch?.deliveries?.[classId];
  if (!batch || !delivery || delivery.deliveredAt) {
    return;
  }

  delivery.deliveredAt = toIso();
  await persistState();
  broadcastTeachers();
}

function clearDeliveryTimer(socket, batchId) {
  const timer = socket.pendingDeliveryTimers?.get(batchId);
  if (timer) {
    clearTimeout(timer);
    socket.pendingDeliveryTimers.delete(batchId);
  }
}

function sendPendingToAgent(classId, socket) {
  socket.sentBatchIds ||= new Set();
  socket.pendingDeliveryTimers ||= new Map();
  const pending = pendingBatchesForClass(classId);
  for (const batch of pending) {
    if (socket.sentBatchIds.has(batch.id)) {
      continue;
    }
    if (socket.readyState === WebSocket.OPEN) {
      socket.sentBatchIds.add(batch.id);
      socket.send(JSON.stringify({
        type: "message",
        message: getAgentBatch(batch, classId)
      }), (error) => {
        if (error) {
          socket.sentBatchIds.delete(batch.id);
          clearDeliveryTimer(socket, batch.id);
          socket.terminate();
        }
      });
      clearDeliveryTimer(socket, batch.id);
      const retryTimer = setTimeout(() => {
        socket.pendingDeliveryTimers.delete(batch.id);
        if (socket.readyState === WebSocket.OPEN) {
          socket.sentBatchIds.delete(batch.id);
          sendPendingToAgent(classId, socket);
        }
      }, DELIVERY_ACK_TIMEOUT_MS);
      socket.pendingDeliveryTimers.set(batch.id, retryTimer);
    }
  }
}

function registerTeacherSocket(socket, identity) {
  socket.identity = identity;
  teacherSockets.add(socket);
  socket.send(JSON.stringify({
    type: "snapshot",
    data: getTeacherSnapshot(identity)
  }));

  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === "ping") {
        socket.send(JSON.stringify({ type: "pong", at: toIso() }));
      }
    } catch {
      // Ignore malformed client messages.
    }
  });

  socket.on("close", () => {
    teacherSockets.delete(socket);
  });
}

function registerAgentSocket(socket, identity) {
  socket.identity = identity;
  socket.isAlive = true;
  const classId = identity.classId;
  if (!agentSockets.has(classId)) {
    agentSockets.set(classId, new Set());
  }
  agentSockets.get(classId).add(socket);
  setDevicePresence(classId, identity);
  socket.send(JSON.stringify({
    type: "ready",
    classId,
    deviceId: identity.deviceId
  }));
  sendPendingToAgent(classId, socket);
  broadcastTeachers();

  socket.on("message", async (raw) => {
    const wasAlive = socket.isAlive;
    socket.isAlive = true;
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.type === "heartbeat") {
      setDevicePresence(classId, identity, message.appVersion);
      socket.send(JSON.stringify({
        type: "heartbeat-confirmed",
        requestId: message.requestId || ""
      }));
      if (!wasAlive) {
        sendPendingToAgent(classId, socket);
      }
      return;
    }

    if (message.type === "received" && typeof message.batchId === "string") {
      clearDeliveryTimer(socket, message.batchId);
      await markBatchDelivered(message.batchId, classId);
      socket.send(JSON.stringify({
        type: "received-confirmed",
        batchId: message.batchId
      }));
      return;
    }

    if (message.type === "ack" && typeof message.batchId === "string") {
      clearDeliveryTimer(socket, message.batchId);
      const batch = state.batches.find((item) => item.id === message.batchId);
      const delivery = batch?.deliveries?.[classId];
      if (!batch || !delivery) {
        return;
      }

      if (!delivery.acknowledgedAt) {
        delivery.acknowledgedAt = toIso();
        if (!delivery.deliveredAt) {
          delivery.deliveredAt = delivery.acknowledgedAt;
        }
        await persistState();
        broadcastTeachers();
      }

      socket.send(JSON.stringify({
        type: "ack-confirmed",
        batchId: batch.id
      }));
    }
  });

  socket.on("close", () => {
    for (const timer of socket.pendingDeliveryTimers?.values() || []) {
      clearTimeout(timer);
    }
    socket.pendingDeliveryTimers?.clear();
    const sockets = agentSockets.get(classId);
    sockets?.delete(socket);
    if (sockets && sockets.size === 0) {
      agentSockets.delete(classId);
    }
    broadcastTeachers();
  });

  socket.on("pong", () => {
    const wasAlive = socket.isAlive;
    socket.isAlive = true;
    setDevicePresence(classId, identity);
    if (!wasAlive) {
      sendPendingToAgent(classId, socket);
    }
  });

  socket.on("error", () => {
    socket.terminate();
  });
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      storage: storage.driver,
      version: state.version,
      classes: classes.length,
      time: toIso()
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/public-config") {
    sendJson(res, 200, {
      classes,
      commonPhrases
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readJson(req);
    const password = cleanText(body.password, 64);
    const teacherName = cleanText(body.teacherName, 24);
    const requestedDeviceId = cleanText(body.deviceId, 80);

    if (!teacherName) {
      sendError(res, 400, "请输入教师姓名");
      return;
    }

    if (!safeCompare(password, TEACHER_PASSWORD)) {
      sendError(res, 401, "访问码不正确");
      return;
    }

    const teacherId = requestedDeviceId || crypto.randomUUID();
    const token = createTeacherToken({ teacherId, teacherName }, AUTH_SECRET, SESSION_TTL_SECONDS);
    sendJson(res, 200, {
      token,
      expiresIn: SESSION_TTL_SECONDS,
      teacher: { id: teacherId, name: teacherName }
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    const identity = getTeacherIdentity(req, url);
    if (!identity) {
      sendError(res, 401, "登录已过期，请重新登录");
      return;
    }
    sendJson(res, 200, getTeacherSnapshot(identity));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/messages") {
    const identity = getTeacherIdentity(req, url);
    if (!identity) {
      sendError(res, 401, "登录已过期，请重新登录");
      return;
    }

    const body = await readJson(req);
    const targetClassIds = Array.isArray(body.targetClassIds)
      ? [...new Set(body.targetClassIds.map((item) => cleanText(item, 64)))]
      : [];
    const content = cleanText(body.content, 120);
    const priority = ["normal", "important", "urgent"].includes(body.priority)
      ? body.priority
      : "normal";
    const visibility = body.visibility === "private" ? "private" : "public";
    const duration = Number(body.duration);

    if (!targetClassIds.length) {
      sendError(res, 400, "请至少选择一个班级");
      return;
    }
    if (targetClassIds.some((classId) => !classIds.has(classId))) {
      sendError(res, 400, "包含无效班级");
      return;
    }
    if (!content) {
      sendError(res, 400, "请输入喊话内容");
      return;
    }
    if (![0, 30, 60, 300].includes(duration)) {
      sendError(res, 400, "显示时长不正确");
      return;
    }

    const now = Date.now();
    const batch = {
      id: crypto.randomUUID(),
      teacherId: identity.teacherId,
      teacherName: identity.teacherName,
      targetClassIds,
      content,
      priority,
      visibility,
      duration,
      createdAt: toIso(now),
      expiresAt: duration > 0 ? toIso(now + duration * 1000) : null,
      deliveryExpiresAt: duration > 0
        ? toIso(now + Math.max(duration * 1000, MIN_DELIVERY_RETENTION_MS))
        : null,
      deliveries: Object.fromEntries(targetClassIds.map((classId) => [
        classId,
        { deliveredAt: null, acknowledgedAt: null }
      ]))
    };

    state.batches.unshift(batch);
    state.batches = state.batches.slice(0, 300);
    await persistState();
    broadcastTeachers();
    broadcastAgents();

    sendJson(res, 201, {
      batch: presentBatch(batch, identity.teacherId)
    });
    return;
  }

  if (req.method === "POST" && /^\/api\/messages\/[^/]+\/ack$/.test(url.pathname)) {
    const identity = getAgentIdentity(req, url);
    if (!identity) {
      sendError(res, 401, "教室设备未授权");
      return;
    }

    const batchId = decodeURIComponent(url.pathname.split("/")[3]);
    const batch = state.batches.find((item) => item.id === batchId);
    const delivery = batch?.deliveries?.[identity.classId];
    if (!batch || !delivery) {
      sendError(res, 404, "消息不存在或不属于当前班级");
      return;
    }

    if (!delivery.acknowledgedAt) {
      delivery.acknowledgedAt = toIso();
      delivery.deliveredAt ||= delivery.acknowledgedAt;
      await persistState();
      broadcastTeachers();
    }

    sendJson(res, 200, {
      ok: true,
      batchId: batch.id,
      classId: identity.classId,
      acknowledgedAt: delivery.acknowledgedAt
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/agent/messages") {
    const identity = getAgentIdentity(req, url);
    if (!identity) {
      sendError(res, 401, "教室设备未授权");
      return;
    }

    setDevicePresence(identity.classId, identity, url.searchParams.get("appVersion") || "");
    sendJson(res, 200, {
      classId: identity.classId,
      deviceId: identity.deviceId,
      messages: pendingBatchesForClass(identity.classId).map((batch) => getAgentBatch(batch, identity.classId)),
      serverTime: toIso()
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/token") {
    const body = await readJson(req);
    const classId = cleanText(body.classId, 64);
    const deviceId = cleanText(body.deviceId, 80);
    const secret = cleanText(body.secret, 128);

    if (!classIds.has(classId) || !deviceId || !safeCompare(secret, getAgentSecret(classId))) {
      sendError(res, 401, "教室设备凭据不正确");
      return;
    }

    sendJson(res, 200, {
      token: createAgentToken({ classId, deviceId }, getAgentSecret(classId), SESSION_TTL_SECONDS)
    });
    return;
  }

  sendError(res, 404, "接口不存在");
}

const server = http.createServer(async (req, res) => {
  applyCors(req, res);
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
      await handleApi(req, res, url);
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendError(res, 405, "请求方式不支持");
      return;
    }

    serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      sendError(res, 500, error.message || "服务器处理请求失败");
    } else {
      res.end();
    }
  }
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const role = url.searchParams.get("role");
  if (role === "teacher") {
    const identity = verifyTeacherToken(url.searchParams.get("token"), AUTH_SECRET);
    if (!identity) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => registerTeacherSocket(ws, identity));
    return;
  }

  if (role === "agent") {
    const classId = cleanText(url.searchParams.get("classId"), 64);
    const token = url.searchParams.get("token");
    const identity = verifyAgentToken(token, getAgentSecret(classId));
    if (!identity || identity.classId !== classId) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => registerAgentSocket(ws, identity));
    return;
  }

  socket.destroy();
});

export async function startServer(options = {}) {
  await initialize();
  const port = options.port ?? PORT;
  const host = options.host ?? HOST;
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      resolve(address);
    });
  });
}

export { server, state, storage, classes, commonPhrases };

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  startServer().then(() => {
    console.log("");
    console.log("课堂远程喊话系统已启动");
    console.log(`教师端: http://localhost:${PORT}/teacher`);
    console.log(`健康检查: http://localhost:${PORT}/health`);
    console.log(`存储驱动: ${storage.driver}`);
    console.log("");
    console.log("生产环境请配置 UPSTASH_REDIS_REST_URL、UPSTASH_REDIS_REST_TOKEN、TEACHER_PASSWORD、AUTH_SECRET 和 AGENT_SECRETS_JSON。");
    console.log("");
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
