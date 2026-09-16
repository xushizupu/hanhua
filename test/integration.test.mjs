import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { server, startServer, storage } from "../src/server.mjs";

let baseUrl;
let teacherToken;
let teacherName;

async function api(path, options = {}) {
  const headers = {
    ...(options.headers || {})
  };
  let body = options.body;
  if (body && typeof body !== "string") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }

  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers,
    body
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${response.status}: ${payload.error || "request failed"}`);
  }
  return payload;
}

async function login(name, deviceId) {
  const result = await api("/api/login", {
    method: "POST",
    body: {
      password: "2468",
      teacherName: name,
      deviceId
    }
  });
  return result;
}

function waitForWebSocketMessage(socket, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`Timed out waiting for ${type}`));
    }, 3000);

    function onMessage(raw) {
      const message = JSON.parse(raw.toString());
      if (message.type !== type) {
        return;
      }
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(message);
    }

    socket.on("message", onMessage);
  });
}

before(async () => {
  const address = await startServer({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${address.port}`;
  const session = await login("李老师", "teacher-a");
  teacherToken = session.token;
  teacherName = session.teacher.name;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await storage.close();
});

test("rejects an invalid teacher password", async () => {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      password: "wrong",
      teacherName: "测试老师",
      deviceId: "invalid-password-device"
    })
  });
  assert.equal(response.status, 401);
});

test("public messages are visible to all teachers and can be acknowledged by an agent", async () => {
  const otherTeacher = await login("王老师", "teacher-b");
  const created = await api("/api/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${teacherToken}` },
    body: {
      targetClassIds: ["class-01"],
      content: "请班长来办公室",
      priority: "important",
      duration: 60,
      visibility: "public"
    }
  });

  const otherSnapshot = await api("/api/bootstrap", {
    headers: { Authorization: `Bearer ${otherTeacher.token}` }
  });
  assert.equal(otherSnapshot.batches[0].id, created.batch.id);
  assert.equal(otherSnapshot.batches[0].teacherName, teacherName);

  const agent = await api("/api/agent/token", {
    method: "POST",
    body: {
      classId: "class-01",
      deviceId: "classroom-test-pc",
      secret: "dev-agent-secret-change-me"
    }
  });
  const socket = new WebSocket(
    `ws://127.0.0.1:${new URL(baseUrl).port}/ws?role=agent&classId=class-01&token=${encodeURIComponent(agent.token)}`
  );
  const pushed = await waitForWebSocketMessage(socket, "message");
  assert.equal(pushed.message.batchId, created.batch.id);

  const confirmed = waitForWebSocketMessage(socket, "ack-confirmed");
  socket.send(JSON.stringify({ type: "ack", batchId: created.batch.id }));
  await confirmed;
  socket.close();

  const snapshot = await api("/api/bootstrap", {
    headers: { Authorization: `Bearer ${teacherToken}` }
  });
  assert.equal(snapshot.batches[0].status, "acknowledged");
  assert.equal(snapshot.batches[0].acknowledgedCount, 1);
});

test("private messages are visible only to their sender", async () => {
  const otherTeacher = await login("赵老师", "teacher-c");
  const created = await api("/api/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${teacherToken}` },
    body: {
      targetClassIds: ["class-02"],
      content: "请数学课代表来办公室",
      priority: "normal",
      duration: 0,
      visibility: "private"
    }
  });

  const senderSnapshot = await api("/api/bootstrap", {
    headers: { Authorization: `Bearer ${teacherToken}` }
  });
  const otherSnapshot = await api("/api/bootstrap", {
    headers: { Authorization: `Bearer ${otherTeacher.token}` }
  });
  assert.equal(senderSnapshot.batches[0].id, created.batch.id);
  assert.equal(senderSnapshot.batches[0].visibility, "private");
  assert.equal(otherSnapshot.batches.some((batch) => batch.id === created.batch.id), false);
});
