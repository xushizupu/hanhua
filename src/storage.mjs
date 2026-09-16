import { Redis } from "@upstash/redis";

const STATE_KEY = "hanhua:state";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createMemoryStorage() {
  let state = null;

  return {
    driver: "memory",
    async load() {
      return state ? clone(state) : null;
    },
    async save(nextState) {
      state = clone(nextState);
    },
    async close() {}
  };
}

export function createRedisStorage({ url, token }) {
  const redis = new Redis({ url, token });

  return {
    driver: "redis",
    async load() {
      const value = await redis.get(STATE_KEY);
      if (!value) {
        return null;
      }
      return typeof value === "string" ? JSON.parse(value) : value;
    },
    async save(nextState) {
      await redis.set(STATE_KEY, JSON.stringify(nextState));
    },
    async close() {}
  };
}

export function createStorage() {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();

  if (url && token) {
    return createRedisStorage({ url, token });
  }

  console.warn("未配置 Upstash，当前使用内存存储，重启后会丢失动态数据。");
  return createMemoryStorage();
}
