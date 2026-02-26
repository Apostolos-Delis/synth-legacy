import { stat } from "node:fs/promises";
import { getLogger } from "../logging/logger.js";
import { readText } from "../utils/fs.js";

export type PromptCacheComponent = "agents" | "progress";

export interface PromptCacheReadOptions {
  path: string;
  sessionId: string;
  phase: string;
  component: PromptCacheComponent;
}

export interface PromptCache {
  readText(options: PromptCacheReadOptions): Promise<string | null>;
  invalidate(options?: { component?: PromptCacheComponent; path?: string }): void;
  clear(): void;
}

interface CacheEntry {
  content: string;
  mtimeMs: number;
}

export function createPromptCache(): PromptCache {
  // Cache key: `${component}:${path}`. Invalidate on mtime changes, invalidate(), or clear().
  const cache = new Map<string, CacheEntry>();

  const keyFor = (component: PromptCacheComponent, path: string): string =>
    `${component}:${path}`;

  const logHit = (options: PromptCacheReadOptions, mtimeMs: number): void => {
    getLogger().debug("prompt-cache:hit", "Prompt cache hit", {
      sessionId: options.sessionId,
      phase: options.phase,
      component: options.component,
      path: options.path,
      mtimeMs,
    });
  };

  const logMiss = (options: PromptCacheReadOptions, reason: string): void => {
    getLogger().debug("prompt-cache:miss", "Prompt cache miss", {
      sessionId: options.sessionId,
      phase: options.phase,
      component: options.component,
      path: options.path,
      reason,
    });
  };

  const invalidate = (options: { component?: PromptCacheComponent; path?: string } = {}): void => {
    if (!options.component && !options.path) {
      cache.clear();
      return;
    }

    if (options.component && options.path) {
      cache.delete(keyFor(options.component, options.path));
      return;
    }

    if (options.component) {
      const prefix = `${options.component}:`;
      for (const key of cache.keys()) {
        if (key.startsWith(prefix)) cache.delete(key);
      }
      return;
    }

    if (options.path) {
      for (const key of cache.keys()) {
        if (key.endsWith(`:${options.path}`)) cache.delete(key);
      }
    }
  };

  const readTextWithCache = async (
    options: PromptCacheReadOptions,
  ): Promise<string | null> => {
    try {
      const st = await stat(options.path);
      const key = keyFor(options.component, options.path);
      const cached = cache.get(key);
      if (cached && cached.mtimeMs === st.mtimeMs) {
        logHit(options, st.mtimeMs);
        return cached.content;
      }
      const content = await readText(options.path);
      cache.set(key, { content, mtimeMs: st.mtimeMs });
      logMiss(options, cached ? "stale" : "cold");
      return content;
    } catch {
      logMiss(options, "missing");
      return null;
    }
  };

  return {
    readText: readTextWithCache,
    invalidate,
    clear: () => cache.clear(),
  };
}
