const elements = {
  priority: document.querySelector("#priorityBadge"),
  teacherName: document.querySelector("#teacherName"),
  content: document.querySelector("#messageContent"),
  ackButton: document.querySelector("#ackButton")
};

const labels = {
  normal: "普通通知",
  important: "重要通知",
  urgent: "紧急通知"
};

window.hanhuaDesktop.onMessage((message) => {
  document.body.dataset.priority = message.priority || "normal";
  elements.priority.textContent = labels[message.priority] || "通知";
  elements.teacherName.textContent = message.teacherName || "老师";
  elements.content.textContent = message.content || "";
  elements.ackButton.focus();
});

elements.ackButton.addEventListener("click", () => {
  elements.ackButton.disabled = true;
  elements.ackButton.textContent = "已收到";
  window.hanhuaDesktop.acknowledge();
});
