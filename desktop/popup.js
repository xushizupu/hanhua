const elements = {
  priority: document.querySelector("#priorityBadge"),
  teacherName: document.querySelector("#teacherName"),
  messageTime: document.querySelector("#messageTime"),
  content: document.querySelector("#messageContent"),
  ackButton: document.querySelector("#ackButton")
};

const labels = {
  normal: "普通通知",
  important: "重要通知",
  urgent: "紧急通知"
};

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

window.hanhuaDesktop.onMessage((message) => {
  document.body.dataset.priority = message.priority || "normal";
  elements.priority.textContent = labels[message.priority] || "通知";
  elements.teacherName.textContent = `${message.teacherName || "老师"}：`;
  elements.messageTime.textContent = formatTime(message.createdAt);
  elements.content.textContent = message.content || "";
  elements.ackButton.focus();
});

elements.ackButton.addEventListener("click", () => {
  elements.ackButton.disabled = true;
  elements.ackButton.textContent = "已收到";
  window.hanhuaDesktop.acknowledge();
});
