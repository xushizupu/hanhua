const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hanhuaDesktop", {
  onMessage(callback) {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on("message", listener);
    return () => ipcRenderer.removeListener("message", listener);
  },
  acknowledge() {
    ipcRenderer.send("ack-message");
  }
});

contextBridge.exposeInMainWorld("hanhuaSetup", {
  getState() {
    return ipcRenderer.invoke("setup:get-state");
  },
  loadClasses(serverUrl) {
    return ipcRenderer.invoke("setup:load-classes", serverUrl);
  },
  testConnection(input) {
    return ipcRenderer.invoke("setup:test", input);
  },
  save(input) {
    return ipcRenderer.invoke("setup:save", input);
  },
  cancel() {
    ipcRenderer.send("setup:cancel");
  },
  onMode(callback) {
    const listener = (_event, mode) => callback(mode);
    ipcRenderer.on("setup-mode", listener);
    return () => ipcRenderer.removeListener("setup-mode", listener);
  }
});
