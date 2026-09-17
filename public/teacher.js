const query = new URLSearchParams(window.location.search);
const persistedApiBase = localStorage.getItem("hanhua_api_base") || "";
const configuredApiBase = query.get("api") || window.HANHUA_CONFIG?.API_BASE || persistedApiBase || "";
const apiBase = configuredApiBase.replace(/\/+$/, "");

if (query.get("api")) {
  localStorage.setItem("hanhua_api_base", query.get("api").replace(/\/+$/, ""));
}

const elements = {
  connectionStatus: document.querySelector("#connectionStatus"),
  connectionLabel: document.querySelector("#connectionLabel"),
  serverLabel: document.querySelector("#serverLabel"),
  profileButton: document.querySelector("#profileButton"),
  refreshButton: document.querySelector("#refreshButton"),
  feedFilters: document.querySelector("#feedFilters"),
  feedTitle: document.querySelector("#feedTitle"),
  feedList: document.querySelector("#feedList"),
  composerForm: document.querySelector("#composerForm"),
  classPicker: document.querySelector("#classPicker"),
  classPickerButton: document.querySelector("#classPickerButton"),
  classPickerMenu: document.querySelector("#classPickerMenu"),
  classPickerLabel: document.querySelector("#classPickerLabel"),
  classOptions: document.querySelector("#classOptions"),
  phraseList: document.querySelector("#phraseList"),
  selectAllClasses: document.querySelector("#selectAllClasses"),
  selectAllLabel: document.querySelector("#selectAllLabel"),
  contentInput: document.querySelector("#contentInput"),
  contentCount: document.querySelector("#contentCount"),
  prioritySelect: document.querySelector("#prioritySelect"),
  durationSelect: document.querySelector("#durationSelect"),
  sendButton: document.querySelector("#sendButton"),
  loginOverlay: document.querySelector("#loginOverlay"),
  loginForm: document.querySelector("#loginForm"),
  passwordInput: document.querySelector("#passwordInput"),
  teacherNameInput: document.querySelector("#teacherNameInput"),
  loginButton: document.querySelector("#loginButton"),
  toast: document.querySelector("#toast")
};

const state = {
  token: localStorage.getItem("hanhua_token") || "",
  teacher: null,
  classes: [],
  commonPhrases: [],
  batches: [],
  deviceStatus: {},
  selectedClassIds: new Set(),
  currentFilter: "all",
  classPickerOpen: false,
  socket: null,
  reconnectTimer: null,
  reconnectAttempt: 0,
  heartbeatTimer: null,
  pollingTimer: null,
  toastTimer: null
};

function getDeviceId() {
  let deviceId = localStorage.getItem("hanhua_device_id");
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem("hanhua_device_id", deviceId);
  }
  return deviceId;
}

function apiUrl(path) {
  return `${apiBase}${path}`;
}

function websocketUrl() {
  const base = apiBase || window.location.origin;
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.searchParams.set("role", "teacher");
  url.searchParams.set("token", state.token);
  return url.toString();
}

function setConnectionStatus(status, label) {
  elements.connectionStatus.classList.toggle("is-online", status === "online");
  elements.connectionStatus.classList.toggle("is-offline", status !== "online");
  elements.connectionLabel.textContent = label;
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  state.toastTimer = setTimeout(() => {
    elements.toast.classList.remove("is-visible");
  }, 2800);
}

async function request(path, options = {}) {
  const headers = {
    ...(options.headers || {})
  };

  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }

  let body = options.body;
  if (body && typeof body !== "string") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }

  const response = await fetch(apiUrl(path), {
    ...options,
    headers,
    body
  });
  const payload = await response.json().catch(() => ({}));

  if (response.status === 401) {
    clearSession();
    showLogin();
    throw new Error(payload.error || "登录已过期，请重新登录");
  }

  if (!response.ok) {
    throw new Error(payload.error || "请求失败");
  }

  return payload;
}

function clearSession() {
  state.token = "";
  state.teacher = null;
  localStorage.removeItem("hanhua_token");
}

function showLogin() {
  elements.loginOverlay.classList.remove("is-hidden");
  elements.passwordInput.focus();
}

function hideLogin() {
  elements.loginOverlay.classList.add("is-hidden");
}

function applySnapshot(snapshot) {
  state.teacher = snapshot.teacher;
  state.classes = snapshot.classes || [];
  state.commonPhrases = snapshot.commonPhrases || [];
  state.batches = snapshot.batches || [];
  state.deviceStatus = snapshot.deviceStatus || {};

  const validClassIds = new Set(state.classes.map((item) => item.id));
  state.selectedClassIds = new Set([...state.selectedClassIds].filter((classId) => validClassIds.has(classId)));

  elements.feedTitle.textContent = "喊话记录";
  renderClasses();
  renderPhrases();
  renderFeed();
}

async function loadSnapshot({ silent = false } = {}) {
  if (!state.token) {
    showLogin();
    return;
  }

  try {
    const snapshot = await request("/api/bootstrap");
    applySnapshot(snapshot);
    hideLogin();
  } catch (error) {
    if (!silent) {
      showToast(error.message);
    }
  }
}

function parseWsMessage(event) {
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
}

function connectSocket() {
  if (!state.token) {
    return;
  }

  clearTimeout(state.reconnectTimer);
  clearInterval(state.heartbeatTimer);

  let socket;
  try {
    socket = new WebSocket(websocketUrl());
  } catch {
    setConnectionStatus("offline", "服务地址错误");
    return;
  }

  state.socket = socket;
  setConnectionStatus("offline", "正在连接");

  socket.addEventListener("open", () => {
    state.reconnectAttempt = 0;
    setConnectionStatus("online", "实时连接");
    state.heartbeatTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "ping" }));
      }
    }, 25_000);
  });

  socket.addEventListener("message", (event) => {
    const message = parseWsMessage(event);
    if (message?.type === "snapshot" && message.data) {
      applySnapshot(message.data);
    }
  });

  socket.addEventListener("close", () => {
    clearInterval(state.heartbeatTimer);
    if (state.socket === socket) {
      state.socket = null;
    }
    setConnectionStatus("offline", "正在重连");
    const delay = Math.min(30_000, 1_000 * (2 ** state.reconnectAttempt));
    state.reconnectAttempt += 1;
    state.reconnectTimer = setTimeout(connectSocket, delay);
  });

  socket.addEventListener("error", () => {
    setConnectionStatus("offline", "连接异常");
  });
}

function startPollingFallback() {
  if (state.pollingTimer) {
    return;
  }
  state.pollingTimer = setInterval(() => {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      loadSnapshot({ silent: true });
    }
  }, 15_000);
}

function renderClasses() {
  elements.classOptions.replaceChildren();

  for (const classItem of state.classes) {
    const row = document.createElement("div");
    row.className = "class-option";
    row.dataset.classId = classItem.id;
    row.setAttribute("role", "option");

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = classItem.id;
    input.checked = state.selectedClassIds.has(classItem.id);
    input.setAttribute("aria-label", classItem.name);

    const text = document.createElement("span");
    text.className = "class-option-name";
    text.textContent = classItem.name;

    const device = state.deviceStatus[classItem.id];
    const deviceState = document.createElement("span");
    deviceState.className = `device-state ${device?.online ? "is-online" : "is-offline"}`;
    deviceState.textContent = device?.online ? "在线" : "离线";

    row.append(input, text, deviceState);
    input.addEventListener("change", () => {
      if (input.checked) {
        state.selectedClassIds.add(classItem.id);
      } else {
        state.selectedClassIds.delete(classItem.id);
      }
      updateSelectionSummary();
    });

    row.addEventListener("click", (event) => {
      if (event.target.closest("input")) {
        return;
      }
      state.selectedClassIds = new Set([classItem.id]);
      updateSelectionSummary();
      setClassPickerOpen(false);
    });

    elements.classOptions.append(row);
  }

  elements.selectAllLabel.textContent = `全选 ${state.classes.length} 个班级`;
  updateSelectionSummary();
}

function updateSelectionSummary() {
  const selectedCount = state.selectedClassIds.size;
  const allCount = state.classes.length;

  if (selectedCount === 0) {
    elements.classPickerLabel.textContent = "请选择班级";
  } else if (selectedCount === 1) {
    const [classId] = state.selectedClassIds;
    const className = state.classes.find((item) => item.id === classId)?.name || classId;
    elements.classPickerLabel.textContent = `已选 ${className}`;
  } else {
    elements.classPickerLabel.textContent = `已选中 ${selectedCount} 个班级`;
  }

  elements.selectAllClasses.checked = allCount > 0 && selectedCount === allCount;
  elements.selectAllClasses.indeterminate = selectedCount > 0 && selectedCount < allCount;
}

function setClassPickerOpen(open) {
  state.classPickerOpen = open;
  elements.classPickerMenu.classList.toggle("is-hidden", !open);
  elements.classPickerButton.setAttribute("aria-expanded", String(open));
}

function renderPhrases() {
  elements.phraseList.replaceChildren();
  for (const phrase of state.commonPhrases) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "phrase-button";
    button.textContent = phrase;
    button.addEventListener("click", () => {
      elements.contentInput.value = phrase;
      elements.contentInput.dispatchEvent(new Event("input"));
      elements.contentInput.focus();
    });
    elements.phraseList.append(button);
  }
}

function getFilteredBatches() {
  switch (state.currentFilter) {
    case "mine":
      return state.batches.filter((batch) => batch.mine);
    case "private":
      return state.batches.filter((batch) => batch.visibility === "private" && batch.mine);
    case "unconfirmed":
      return state.batches.filter((batch) => batch.status !== "acknowledged" && batch.status !== "expired");
    default:
      return state.batches;
  }
}

function createTextElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) {
    element.className = className;
  }
  element.textContent = text;
  return element;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function getTargetLabel(batch) {
  if (batch.targetCount === state.classes.length) {
    return "全部班级";
  }
  return batch.targetClassNames.join("、");
}

function getStatusLabel(batch) {
  if (batch.status === "acknowledged") {
    return "已确认";
  }
  if (batch.status === "expired") {
    return "已过期";
  }
  if (batch.status === "delivered") {
    return "教室已收到，待学生确认";
  }
  return `待送达 ${batch.deliveredCount}/${batch.targetCount}`;
}

function createMessageCard(batch) {
  const card = document.createElement("article");
  card.className = "message-card";
  card.classList.toggle("is-important", batch.priority === "important");
  card.classList.toggle("is-urgent", batch.priority === "urgent");
  card.classList.toggle("is-expired", batch.status === "expired");

  const meta = document.createElement("div");
  meta.className = "message-meta";
  const leftMeta = document.createElement("div");
  const author = createTextElement("span", "message-author", batch.teacherName);
  const arrow = createTextElement("span", "", " → ");
  const target = createTextElement("span", "message-target", getTargetLabel(batch));
  leftMeta.append(author, arrow, target);

  const badges = document.createElement("div");
  badges.className = "message-badges";
  const visibilityBadge = createTextElement(
    "span",
    `badge ${batch.visibility === "private" ? "badge-private" : "badge-public"}`,
    batch.visibility === "private" ? "私自喊话" : "公开"
  );
  badges.append(visibilityBadge);
  if (batch.priority !== "normal") {
    badges.append(createTextElement(
      "span",
      `badge ${batch.priority === "urgent" ? "badge-urgent" : "badge-important"}`,
      batch.priority === "urgent" ? "紧急" : "重要"
    ));
  }
  meta.append(leftMeta, badges);

  const content = createTextElement("p", "message-content", batch.content);
  const footer = document.createElement("div");
  footer.className = "message-footer";

  const status = document.createElement("div");
  const tick = createTextElement(
    "span",
    `tick ${batch.status === "acknowledged" ? "" : batch.status === "expired" ? "expired" : "pending"}`,
    batch.status === "acknowledged" ? "✓✓" : batch.status === "expired" ? "!" : "✓"
  );
  status.append(tick, createTextElement("span", "", ` ${getStatusLabel(batch)} · ${formatTime(batch.createdAt)}`));

  const progressRow = document.createElement("div");
  progressRow.className = "progress-row";
  const progressTrack = document.createElement("div");
  progressTrack.className = "progress-track";
  const progressValue = document.createElement("div");
  progressValue.className = "progress-value";
  progressValue.style.width = `${batch.targetCount ? Math.round((batch.acknowledgedCount / batch.targetCount) * 100) : 0}%`;
  progressTrack.append(progressValue);
  progressRow.append(
    progressTrack,
    createTextElement("span", "", `${batch.acknowledgedCount}/${batch.targetCount}`)
  );

  footer.append(status, progressRow);
  card.append(meta, content, footer);

  if (batch.targetCount > 1) {
    const details = document.createElement("details");
    details.className = "class-details";
    details.append(createTextElement("summary", "", "查看各班状态"));
    const list = document.createElement("div");
    list.className = "class-status-list";
    for (const classId of batch.targetClassIds) {
      const delivery = batch.deliveries[classId];
      const row = document.createElement("div");
      row.className = "class-status-row";
      row.append(
        createTextElement("span", "", delivery.className),
        createTextElement("span", "", delivery.acknowledgedAt ? "学生已确认" : delivery.deliveredAt ? "教室已收到" : "待送达")
      );
      list.append(row);
    }
    details.append(list);
    card.append(details);
  }

  return card;
}

function renderFeed() {
  const batches = getFilteredBatches();
  elements.feedList.replaceChildren();

  if (!batches.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = state.currentFilter === "private"
      ? "还没有私自喊话记录"
      : "暂无喊话记录";
    elements.feedList.append(empty);
    return;
  }

  for (const batch of batches) {
    elements.feedList.append(createMessageCard(batch));
  }
}

elements.classPickerButton.addEventListener("click", () => {
  setClassPickerOpen(!state.classPickerOpen);
});

elements.selectAllClasses.addEventListener("change", () => {
  if (elements.selectAllClasses.checked) {
    state.selectedClassIds = new Set(state.classes.map((item) => item.id));
  } else {
    state.selectedClassIds.clear();
  }
  renderClasses();
});

document.addEventListener("click", (event) => {
  if (!elements.classPicker.contains(event.target)) {
    setClassPickerOpen(false);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setClassPickerOpen(false);
  }
});

elements.contentInput.addEventListener("input", () => {
  elements.contentCount.textContent = `${elements.contentInput.value.length} / 120`;
});

elements.feedFilters.addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (!button) {
    return;
  }
  state.currentFilter = button.dataset.filter;
  for (const item of elements.feedFilters.querySelectorAll("[data-filter]")) {
    item.classList.toggle("is-active", item === button);
  }
  renderFeed();
});

elements.refreshButton.addEventListener("click", async () => {
  await loadSnapshot();
  showToast("消息已刷新");
});

elements.profileButton.addEventListener("click", () => {
  state.teacher = null;
  state.token = "";
  localStorage.removeItem("hanhua_token");
  elements.socket?.close();
  showLogin();
});

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const teacherName = elements.teacherNameInput.value.trim();
  const password = elements.passwordInput.value;

  if (!teacherName || !password) {
    showToast("请输入访问码和教师姓名");
    return;
  }

  elements.loginButton.disabled = true;
  elements.loginButton.textContent = "正在登录";
  try {
    const result = await request("/api/login", {
      method: "POST",
      body: {
        password,
        teacherName,
        deviceId: getDeviceId()
      }
    });
    state.token = result.token;
    state.teacher = result.teacher;
    localStorage.setItem("hanhua_token", result.token);
    localStorage.setItem("hanhua_teacher_name", result.teacher.name);
    elements.passwordInput.value = "";
    hideLogin();
    await loadSnapshot();
    connectSocket();
    startPollingFallback();
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.loginButton.disabled = false;
    elements.loginButton.textContent = "进入控制台";
  }
});

elements.composerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const content = elements.contentInput.value.trim();
  const targetClassIds = [...state.selectedClassIds];
  const visibility = document.querySelector("input[name='visibility']:checked")?.value || "public";

  if (!targetClassIds.length) {
    showToast("请至少选择一个班级");
    return;
  }
  if (!content) {
    showToast("请输入喊话内容");
    return;
  }

  elements.sendButton.disabled = true;
  elements.sendButton.textContent = "正在发送";

  try {
    await request("/api/messages", {
      method: "POST",
      body: {
        targetClassIds,
        content,
        priority: elements.prioritySelect.value,
        duration: Number(elements.durationSelect.value),
        visibility
      }
    });
    elements.contentInput.value = "";
    elements.contentInput.dispatchEvent(new Event("input"));
    await loadSnapshot({ silent: true });
    showToast(visibility === "private" ? "私自喊话已发送" : "喊话已发送");
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.sendButton.disabled = false;
    elements.sendButton.textContent = "发送到教室";
  }
});

async function boot() {
  elements.teacherNameInput.value = localStorage.getItem("hanhua_teacher_name") || "";
  elements.serverLabel.textContent = apiBase || window.location.origin;
  elements.contentCount.textContent = "0 / 120";

  if (!apiBase && !["localhost", "127.0.0.1"].includes(window.location.hostname)) {
    showToast("请先在 public/config.js 中配置 Render 服务地址");
  }

  if (!state.token) {
    showLogin();
    return;
  }

  try {
    await loadSnapshot();
    connectSocket();
  } catch {
    showLogin();
  }

  startPollingFallback();
}

boot();
