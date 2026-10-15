// 目录指纹扫描 + 差异比较（纯逻辑，可在宿主外单测）。
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_IGNORE = [
  'node_modules',
  '.git',
  '.pnpm-store',
  '.cache',
  'dist',
  'build',
  'coverage',
  'tmp',
  '.turbo',
  '.vite',
  '*.log',
  '*.tmp',
];

function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/** relPath 是否应被忽略：不含通配符的条目按「路径段」精确匹配，含通配符的按文件名匹配。 */
export function shouldIgnore(relPath, ignore = DEFAULT_IGNORE) {
  const parts = String(relPath ?? '').split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return false;
  const base = parts[parts.length - 1];
  for (const raw of ignore) {
    if (!raw) continue;
    if (raw.includes('*') || raw.includes('?')) {
      if (wildcardToRegExp(raw).test(base)) return true;
    } else if (parts.includes(raw)) {
      return true;
    }
  }
  return false;
}

/**
 * 深度优先扫描一个根目录，返回相对路径 → { mtimeMs, size } 的指纹表。
 * 出错（目录不存在/无权限）不抛，记在 error 字段里。
 */
export async function scanRoot(root, { ignore = DEFAULT_IGNORE, maxFiles = 5000 } = {}) {
  const files = new Map();
  let truncated = false;
  let error;
  const walk = async (dir, relDir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (cause) {
      if (!error) error = cause?.message ?? String(cause);
      return;
    }
    for (const entry of entries) {
      if (files.size >= maxFiles) {
        truncated = true;
        return;
      }
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (shouldIgnore(relPath, ignore)) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, relPath);
      } else if (entry.isFile()) {
        try {
          const info = await stat(abs);
          files.set(relPath, { mtimeMs: Math.round(info.mtimeMs), size: info.size });
        } catch {
          // 文件在扫描途中消失：忽略
        }
      }
    }
  };
  await walk(root, '');
  return { root, files, truncated, count: files.size, error };
}

/** 比较两次扫描结果，得到 changed / added / removed 相对路径列表。 */
export function diffSnapshots(before, after) {
  const beforeFiles = before?.files instanceof Map ? before.files : new Map();
  const afterFiles = after?.files instanceof Map ? after.files : new Map();
  const changed = [];
  const added = [];
  const removed = [];
  for (const [rel, info] of afterFiles) {
    const prev = beforeFiles.get(rel);
    if (!prev) added.push(rel);
    else if (prev.mtimeMs !== info.mtimeMs || prev.size !== info.size) changed.push(rel);
  }
  for (const rel of beforeFiles.keys()) {
    if (!afterFiles.has(rel)) removed.push(rel);
  }
  return { changed, added, removed, total: changed.length + added.length + removed.length };
}

/** 对一组根目录做快照：返回 Map<root, snapshot>。 */
export async function scanRoots(roots, options = {}) {
  const snapshot = new Map();
  for (const root of roots) snapshot.set(root, await scanRoot(root, options));
  return snapshot;
}

/** 比较两组根目录快照，返回「哪个根目录变了、变了哪些文件」。 */
export function diffRootSnapshots(before, after) {
  const keys = new Set([...(before?.keys?.() ?? []), ...(after?.keys?.() ?? [])]);
  const touched = [];
  for (const root of keys) {
    const result = diffSnapshots(before?.get?.(root), after?.get?.(root));
    if (result.total > 0) touched.push({ root, ...result });
  }
  return touched;
}
