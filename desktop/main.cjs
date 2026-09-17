const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");

const APP_VERSION = app.getVersion();

let config = null;
let tray = null;
let setupWindow = null;
let socket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let lastServerActivityAt = 0;
let reconnectAttempt = 0;
let activePopup = null;
let messageQueue = [];
let isQuitting = false;
let localState = {
  pendingAcks: [],
  seenMessageIds: []
};

function getAppIcon() {
  const iconPath = path.join(__dirname, "assets", "icon.png");
  return fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
}

function getConfigPath() {
  return path.join(app.getPath("userData"), "config.json");
}

function getConfigCandidates() {
  return [
    process.env.HANHUA_CONFIG,
    getConfigPath(),
    path.join(path.dirname(process.execPath), "config.json"),
    path.join(__dirname, "config.json")
  ].filter(Boolean);
}

function normalizeConfig(input = {}) {
  const serverUrl = String(input.serverUrl || "").trim().replace(/\/+$/, "");
  const classId = String(input.classId || "").trim().slice(0, 64);
  const deviceId = String(input.deviceId || "").trim().slice(0, 80);
  const deviceSecret = String(input.deviceSecret || "").trim().slice(0, 128);

  if (!/^https?:\/\//i.test(serverUrl)) {
    throw new Error("服务器地址必须是以 http:// 或 https:// 开头的地址");
  }
  if (!classId) {
    throw new Error("请选择教室班级");
  }
  if (!deviceId) {
    throw new Error("设备编号不能为空");
  }
  if (!deviceSecret) {
    throw new Error("设备密码不能为空");
  }

  return {
    serverUrl,
    classId,
    deviceId,
    deviceSecret,
    autoStart: input.autoStart !== false
  };
}

function loadConfig() {
  for (const configPath of getConfigCandidates()) {
    if (!fs.existsSync(configPath)) {
      continue;
    }
    try {
      return normalizeConfig(JSON.parse(fs.readFileSync(configPath, "utf8")));
    } catch (error) {
      console.error(`配置文件无效: ${configPath}`, error);
      return null;
    }
  }
  return null;
}

function saveConfig(input) {
  const nextConfig = normalizeConfig(input);
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  config = nextConfig;
  return configPath;
}

function getHttpBase(targetConfig = config) {
  return String(targetConfig?.serverUrl || "").replace(/\/+$/, "");
}

function getWebSocketUrl(token, targetConfig = config) {
  const url = new URL(getHttpBase(targetConfig));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.searchParams.set("role", "agent");
  url.searchParams.set("classId", targetConfig.classId);
  url.searchParams.set("token", token);
  return url.toString();
}

async function requestAgentToken(targetConfig = config) {
  const response = await fetch(`${getHttpBase(targetConfig)}/api/agent/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      classId: targetConfig.classId,
      deviceId: targetConfig.deviceId,
      secret: targetConfig.deviceSecret
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "无法获取教室设备令牌");
  }
  return payload.token;
}

async function loadClasses(serverUrl) {
  const baseUrl = String(serverUrl || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error("请先填写正确的服务器地址");
  }
  const response = await fetch(`${baseUrl}/api/public-config`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "无法读取班级列表");
  }
  return payload.classes || [];
}

function getLocalStatePath() {
  return path.join(app.getPath("userData"), "classroom-callboard-state.json");
}

function loadLocalState() {
  try {
    const saved = JSON.parse(fs.readFileSync(getLocalStatePath(), "utf8"));
    localState = {
      pendingAcks: Array.isArray(saved.pendingAcks) ? saved.pendingAcks : [],
      seenMessageIds: Array.isArray(saved.seenMessageIds) ? saved.seenMessageIds.slice(-500) : []
    };
  } catch {
    localState = { pendingAcks: [], seenMessageIds: [] };
  }
}

function saveLocalState() {
  fs.mkdirSync(path.dirname(getLocalStatePath()), { recursive: true });
  fs.writeFileSync(getLocalStatePath(), JSON.stringify(localState, null, 2), "utf8");
}

function updateTrayStatus(text) {
  if (tray) {
    tray.setToolTip(`课堂喊话教室端\n${text}`);
  }
}

function sendPendingAcks() {
  if (!socket || socket.readyState !== WebSocket.OPEN || !localState.pendingAcks.length) {
    return;
  }

  for (const batchId of [...localState.pendingAcks]) {
    socket.send(JSON.stringify({ type: "ack", batchId }));
  }
}

function acknowledge(batchId) {
  if (!localState.pendingAcks.includes(batchId)) {
    localState.pendingAcks.push(batchId);
    saveLocalState();
  }
  sendPendingAcks();
}

function createPopup(message) {
  activePopup = new BrowserWindow({
    width: 760,
    height: 470,
    minWidth: 520,
    minHeight: 360,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    center: true,
    skipTaskbar: true,
    show: false,
    icon: getAppIcon(),
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  activePopup.__message = message;
  activePopup.setAlwaysOnTop(true, "screen-saver");
  activePopup.setMenuBarVisibility(false);
  activePopup.loadFile(path.join(__dirname, "popup.html"));

  activePopup.webContents.once("did-finish-load", () => {
    activePopup.webContents.send("message", message);
  });

  activePopup.once("ready-to-show", () => {
    activePopup.show();
    activePopup.focus();
    activePopup.moveTop();

    const durationMs = Number(message.duration) > 0 ? Number(message.duration) * 1000 : 0;
    if (durationMs > 0) {
      activePopup.__expiryTimer = setTimeout(() => {
        if (activePopup) {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
              type: "dismissed",
              batchId: message.batchId
            }));
          }
          activePopup.close();
        }
      }, durationMs);
    }
  });

  activePopup.on("closed", () => {
    clearTimeout(activePopup?.__expiryTimer);
    activePopup = null;
    showNextMessage();
  });
}

function enqueueMessage(message) {
  if (!message?.batchId) {
    return;
  }

  const alreadyQueued = messageQueue.some((item) => item.batchId === message.batchId);
  const alreadyActive = activePopup?.__message?.batchId === message.batchId;
  const alreadyAcknowledged = localState.pendingAcks.includes(message.batchId);
  if (alreadyQueued || alreadyActive || alreadyAcknowledged) {
    return;
  }

  if (!localState.seenMessageIds.includes(message.batchId)) {
    localState.seenMessageIds.push(message.batchId);
    localState.seenMessageIds = localState.seenMessageIds.slice(-500);
    saveLocalState();
  }

  messageQueue.push(message);
  showNextMessage();
}

function showNextMessage() {
  if (activePopup || !messageQueue.length) {
    return;
  }
  createPopup(messageQueue.shift());
}

function handleSocketMessage(raw) {
  lastServerActivityAt = Date.now();
  let payload;
  try {
    payload = JSON.parse(raw.toString());
  } catch {
    return;
  }

  if (payload.type === "ready") {
    updateTrayStatus(`已连接，班级：${config.classId}`);
    sendPendingAcks();
    return;
  }

  if (payload.type === "message") {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: "received",
        batchId: payload.message.batchId
      }));
    }
    enqueueMessage(payload.message);
    return;
  }

  if (payload.type === "ack-confirmed") {
    localState.pendingAcks = localState.pendingAcks.filter((batchId) => batchId !== payload.batchId);
    saveLocalState();
  }
}

function disconnectAgent() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  if (socket) {
    socket.removeAllListeners();
    socket.close();
    socket = null;
  }
  messageQueue = [];
  if (activePopup) {
    activePopup.destroy();
    activePopup = null;
  }
}

async function connect() {
  if (!config) {
    openSetupWindow();
    return;
  }

  disconnectAgent();

  try {
    const token = await requestAgentToken();
    const currentSocket = new WebSocket(getWebSocketUrl(token));
    socket = currentSocket;
    updateTrayStatus("正在连接 Render");

    currentSocket.on("open", () => {
      reconnectAttempt = 0;
      lastServerActivityAt = Date.now();
      updateTrayStatus(`已连接，班级：${config.classId}`);
      const sendHeartbeat = () => {
        if (currentSocket.readyState !== WebSocket.OPEN) {
          return;
        }
        currentSocket.send(JSON.stringify({
          type: "heartbeat",
          appVersion: APP_VERSION,
          requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`
        }), (error) => {
          if (error) {
            currentSocket.terminate();
          }
        });
      };

      sendHeartbeat();
      clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        if (Date.now() - lastServerActivityAt > 75 * 1000) {
          currentSocket.terminate();
          return;
        }
        sendHeartbeat();
      }, 30 * 1000);
      sendPendingAcks();
    });

    currentSocket.on("message", handleSocketMessage);
    currentSocket.on("ping", () => {
      lastServerActivityAt = Date.now();
    });
    currentSocket.on("close", () => {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      if (socket !== currentSocket || isQuitting) {
        return;
      }
      socket = null;
      updateTrayStatus("连接已断开，正在重连");
      const delay = Math.min(30_000, 1000 * (2 ** reconnectAttempt));
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    });
    currentSocket.on("error", () => {
      updateTrayStatus("连接异常，正在重连");
      currentSocket.terminate();
    });
  } catch (error) {
    console.error(error);
    updateTrayStatus(`连接失败：${error.message}`);
    reconnectTimer = setTimeout(connect, 10000);
  }
}

function applyAutoStart() {
  app.setLoginItemSettings({
    openAtLogin: config?.autoStart !== false,
    openAsHidden: true
  });
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: "修改配置",
      click: () => openSetupWindow({ editing: true })
    },
    {
      label: "重新连接",
      click: () => connect()
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
}

function createTray() {
  if (tray) {
    tray.setContextMenu(buildTrayMenu());
    return;
  }

  const icon = getAppIcon().resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip("课堂喊话教室端");
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", () => tray.popUpContextMenu());
}

function openSetupWindow({ editing = false } = {}) {
  if (setupWindow) {
    setupWindow.show();
    setupWindow.focus();
    return;
  }

  setupWindow = new BrowserWindow({
    width: 620,
    height: 690,
    minWidth: 560,
    minHeight: 640,
    resizable: true,
    maximizable: false,
    title: "课堂喊话教室端 - 配置",
    icon: getAppIcon(),
    backgroundColor: "#f3f6f4",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  setupWindow.setMenuBarVisibility(false);
  setupWindow.loadFile(path.join(__dirname, "setup.html"));
  setupWindow.webContents.once("did-finish-load", () => {
    setupWindow.webContents.send("setup-mode", { editing });
  });
  setupWindow.on("closed", () => {
    setupWindow = null;
    if (!config && !isQuitting) {
      app.quit();
    }
  });
}

function startAgent() {
  if (!config) {
    openSetupWindow();
    return;
  }
  loadLocalState();
  createTray();
  applyAutoStart();
  connect();
}

ipcMain.handle("setup:get-state", () => ({
  config,
  computerName: os.hostname(),
  configPath: getConfigPath()
}));

ipcMain.handle("setup:load-classes", async (_event, serverUrl) => loadClasses(serverUrl));

ipcMain.handle("setup:test", async (_event, input) => {
  const candidate = normalizeConfig(input);
  await requestAgentToken(candidate);
  return { ok: true };
});

ipcMain.handle("setup:save", async (_event, input) => {
  const candidate = normalizeConfig(input);
  await requestAgentToken(candidate);
  disconnectAgent();
  const configPath = saveConfig(candidate);
  startAgent();
  setupWindow?.close();
  return { ok: true, configPath };
});

ipcMain.on("setup:cancel", () => {
  if (config) {
    setupWindow?.close();
  } else {
    isQuitting = true;
    app.quit();
  }
});

ipcMain.on("ack-message", (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const message = window?.__message;
  if (message) {
    acknowledge(message.batchId);
  }
  window?.close();
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

app.on("second-instance", () => {
  if (setupWindow) {
    setupWindow.show();
    setupWindow.focus();
  } else if (!config) {
    openSetupWindow();
  }
});

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) {
    return;
  }

  loadLocalState();
  config = loadConfig();
  if (config) {
    startAgent();
  } else {
    openSetupWindow();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  disconnectAgent();
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});
