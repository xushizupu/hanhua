const query = new URLSearchParams(window.location.search);
const configuredApiBase = query.get("api") || window.HANHUA_CONFIG?.API_BASE || "";
const apiBase = configuredApiBase.replace(/\/+$/, "");

const elements = {
  form: document.querySelector("#agentForm"),
  classSelect: document.querySelector("#classSelect"),
  secretInput: document.querySelector("#secretInput"),
  deviceInput: document.querySelector("#deviceInput"),
  connectButton: document.querySelector("#connectButton"),
  status: document.querySelector("#agentStatus"),
  connectionRow: document.querySelector(".connection-row"),
  popup: document.querySelector("#popupOverlay"),
  popupTeacher: document.querySelector("#popupTeacher"),
  popupContent: document.querySelector("#popupContent"),
  popupPriority: document.querySelector("#popupPriority"),
  ackButton: document.querySelector("#ackButton"),
  toast: document.querySelector("#simulatorToast")
};

const state = {
  socket: null,
  classId: "",
  deviceId: "",
  currentMessage: null,
  toastTimer: null,
  heartbeatTimer: null
};

function randomDeviceId() {
  return `simulator-${crypto.randomUUID().slice(0, 8)}`;
}

elements.deviceInput.value = localStorage.getItem("hanhua_simulator_device") || randomDeviceId();
localStorage.setItem("hanhua_simulator_device", elements.deviceInput.value);

function apiUrl(path) {
  return `${apiBase}${path}`;
}

function socketUrl(token) {
  const base = apiBase || window.location.origin;
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.searchParams.set("role", "agent");
  url.searchParams.set("classId", state.classId);
  url.searchParams.set("token", token);
  return url.toString();
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  state.toastTimer = setTimeout(() => elements.toast.classList.remove("is-visible"), 2200);
}

function setStatus(online, text) {
  elements.connectionRow.classList.toggle("is-online", online);
  elements.status.textContent = text;
}

async function loadClasses() {
  const response = await fetch(apiUrl("/api/public-config"));
  const data = await response.json();
  elements.classSelect.replaceChildren();
  for (const classItem of data.classes || []) {
    const option = document.createElement("option");
    option.value = classItem.id;
    option.textContent = classItem.name;
    elements.classSelect.append(option);
  }
}

function showMessage(message) {
  state.currentMessage = message;
  elements.popupTeacher.textContent = message.teacherName;
  elements.popupContent.textContent = message.content;
  elements.popupPriority.textContent = {
    normal: "普通通知",
    important: "重要通知",
    urgent: "紧急通知"
  }[message.priority] || "通知";
  elements.popup.classList.remove("is-hidden");
  elements.ackButton.focus();
}

function acknowledgeCurrent() {
  if (!state.currentMessage || state.socket?.readyState !== WebSocket.OPEN) {
    showToast("连接已断开，请稍后重试");
    return;
  }
  state.socket.send(JSON.stringify({
    type: "ack",
    batchId: state.currentMessage.batchId
  }));
  elements.popup.classList.add("is-hidden");
  state.currentMessage = null;
}

function connect(token) {
  state.socket = new WebSocket(socketUrl(token));
  setStatus(false, "正在连接");

  state.socket.addEventListener("open", () => {
    setStatus(true, "教室端已连接");
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = setInterval(() => {
      if (state.socket?.readyState === WebSocket.OPEN) {
        state.socket.send(JSON.stringify({ type: "heartbeat", appVersion: "simulator-1.0" }));
      }
    }, 5 * 60 * 1000);
  });

  state.socket.addEventListener("message", (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (payload.type === "message") {
      showMessage(payload.message);
    }
    if (payload.type === "ack-confirmed") {
      showToast("确认已回传");
    }
  });

  state.socket.addEventListener("close", () => {
    setStatus(false, "连接已断开");
    clearInterval(state.heartbeatTimer);
  });
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  state.classId = elements.classSelect.value;
  state.deviceId = elements.deviceInput.value.trim();
  elements.connectButton.disabled = true;
  elements.connectButton.textContent = "正在连接";

  try {
    const response = await fetch(apiUrl("/api/agent/token"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        classId: state.classId,
        deviceId: state.deviceId,
        secret: elements.secretInput.value
      })
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "连接失败");
    }
    localStorage.setItem("hanhua_simulator_device", state.deviceId);
    connect(data.token);
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.connectButton.disabled = false;
    elements.connectButton.textContent = "连接教室端";
  }
});

elements.ackButton.addEventListener("click", acknowledgeCurrent);

loadClasses().catch((error) => showToast(error.message));
