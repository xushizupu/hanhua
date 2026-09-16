const elements = {
  form: document.querySelector("#setupForm"),
  modeLabel: document.querySelector("#modeLabel"),
  serverInput: document.querySelector("#serverInput"),
  loadClassesButton: document.querySelector("#loadClassesButton"),
  classSelect: document.querySelector("#classSelect"),
  deviceInput: document.querySelector("#deviceInput"),
  secretInput: document.querySelector("#secretInput"),
  autoStartInput: document.querySelector("#autoStartInput"),
  statusRow: document.querySelector("#statusRow"),
  statusText: document.querySelector("#statusText"),
  cancelButton: document.querySelector("#cancelButton"),
  testButton: document.querySelector("#testButton"),
  saveButton: document.querySelector("#saveButton")
};

const state = {
  classes: [],
  currentConfig: null
};

function setStatus(type, text) {
  elements.statusRow.classList.toggle("is-success", type === "success");
  elements.statusRow.classList.toggle("is-error", type === "error");
  elements.statusText.textContent = text;
}

function getFormData() {
  return {
    serverUrl: elements.serverInput.value.trim(),
    classId: elements.classSelect.value,
    deviceId: elements.deviceInput.value.trim(),
    deviceSecret: elements.secretInput.value,
    autoStart: elements.autoStartInput.checked
  };
}

function setBusy(busy, label) {
  for (const button of [elements.loadClassesButton, elements.testButton, elements.saveButton]) {
    button.disabled = busy;
  }
  if (label) {
    setStatus("", label);
  }
}

function renderClasses(selectedClassId = "") {
  elements.classSelect.replaceChildren();
  if (!state.classes.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "没有读取到班级";
    elements.classSelect.append(option);
    return;
  }

  for (const classItem of state.classes) {
    const option = document.createElement("option");
    option.value = classItem.id;
    option.textContent = classItem.name;
    option.selected = classItem.id === selectedClassId;
    elements.classSelect.append(option);
  }
}

async function loadClasses({ quiet = false } = {}) {
  const serverUrl = elements.serverInput.value.trim();
  if (!serverUrl) {
    setStatus("error", "请先填写 Render 服务器地址");
    return false;
  }

  if (!quiet) {
    setBusy(true, "正在读取班级列表");
  }

  try {
    const previousClassId = elements.classSelect.value || state.currentConfig?.classId || "";
    state.classes = await window.hanhuaSetup.loadClasses(serverUrl);
    renderClasses(previousClassId);
    if (!quiet) {
      setStatus("success", `已读取 ${state.classes.length} 个班级`);
    }
    return true;
  } catch (error) {
    if (!quiet) {
      setStatus("error", error.message);
    }
    return false;
  } finally {
    if (!quiet) {
      setBusy(false);
    }
  }
}

async function testConnection() {
  const data = getFormData();
  if (!data.classId) {
    setStatus("error", "请选择教室班级");
    return false;
  }

  setBusy(true, "正在测试连接");
  try {
    await window.hanhuaSetup.testConnection(data);
    setStatus("success", "连接成功，设备凭据有效");
    return true;
  } catch (error) {
    setStatus("error", error.message);
    return false;
  } finally {
    setBusy(false);
  }
}

elements.loadClassesButton.addEventListener("click", () => loadClasses());

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = getFormData();
  setBusy(true, "正在保存配置");

  try {
    await window.hanhuaSetup.testConnection(data);
    await window.hanhuaSetup.save(data);
    setStatus("success", "配置已保存，教室端正在启动");
  } catch (error) {
    setStatus("error", error.message);
    setBusy(false);
  }
});

elements.testButton.addEventListener("click", testConnection);
elements.cancelButton.addEventListener("click", () => window.hanhuaSetup.cancel());

window.hanhuaSetup.onMode(({ editing }) => {
  elements.modeLabel.textContent = editing ? "修改配置" : "首次配置";
});

async function initialize() {
  const info = await window.hanhuaSetup.getState();
  state.currentConfig = info.config;
  elements.deviceInput.value = info.config?.deviceId || info.computerName || "";
  elements.serverInput.value = info.config?.serverUrl || "";
  elements.secretInput.value = info.config?.deviceSecret || "";
  elements.autoStartInput.checked = info.config?.autoStart !== false;

  if (elements.serverInput.value) {
    await loadClasses({ quiet: true });
    if (info.config?.classId) {
      renderClasses(info.config.classId);
    }
  }
}

initialize().catch((error) => setStatus("error", error.message));
