import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(__dirname, "..");
export const publicDir = path.join(rootDir, "public");
export const configDir = path.join(rootDir, "config");

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

export const classes = readJson(path.join(configDir, "classes.json"), []).map((item) => ({
  id: String(item.id),
  name: String(item.name)
}));

export const commonPhrases = readJson(path.join(configDir, "common-phrases.json"), [])
  .map((item) => String(item).trim())
  .filter(Boolean);

export const classIds = new Set(classes.map((item) => item.id));

export function getClassById(classId) {
  return classes.find((item) => item.id === classId) || null;
}
