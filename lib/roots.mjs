// 监视根目录发现：profile 里用 `link:` 装入的插件目录就是「可热重载」的插件源码目录。
// 纯逻辑 + 一次 package.json 读取，便于单测。
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

/** 从 profile 的 package.json 里挑出 `link:` 依赖 → [{ name, dir }]。 */
export function linkTargetsFromManifest(manifest, profileDir) {
  const dependencies = manifest?.dependencies ?? {};
  const targets = [];
  for (const [name, spec] of Object.entries(dependencies)) {
    if (typeof spec !== 'string') continue;
    if (!spec.startsWith('link:')) continue;
    const raw = spec.slice('link:'.length).trim().replace(/\\/g, '/');
    if (!raw) continue;
    targets.push({ name, dir: isAbsolute(raw) ? raw : resolve(profileDir, raw) });
  }
  return targets;
}

/** 读取 profile 目录下的 package.json，得到 link 目标（读不到就返回空数组）。 */
export async function profileLinkTargets(profileDir) {
  if (!profileDir) return [];
  try {
    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'));
    return linkTargetsFromManifest(manifest, profileDir);
  } catch {
    return [];
  }
}

/** 读取某个插件目录的 package.json 名字（读不到就返回 undefined）。 */
export async function packageNameOf(dir) {
  try {
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    const name = manifest?.name;
    return typeof name === 'string' && name.trim() ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

function keyOf(dir) {
  return String(dir ?? '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * 汇总要监视的根目录。
 * @param {{ profileDir?: string, extraWatch?: string[], exclude?: string[], linkTargets?: Array<{name:string,dir:string}> }} options
 * @returns {Promise<{ roots: string[], sources: Record<string,string> }>} sources: 根目录 → 来源插件名
 */
export async function collectWatchRoots(options = {}) {
  const { profileDir, extraWatch = [], exclude = [], linkTargets } = options;
  const targets = linkTargets ?? (await profileLinkTargets(profileDir));
  const sources = {};
  const roots = [];
  const add = (dir, source) => {
    if (typeof dir !== 'string' || !dir.trim()) return;
    const abs = isAbsolute(dir) ? dir : resolve(profileDir ?? process.cwd(), dir);
    const key = keyOf(abs);
    if (!key) return;
    if (exclude.some((item) => keyOf(resolve(profileDir ?? process.cwd(), item)) === key)) return;
    if (sources[key] !== undefined) return;
    sources[key] = source;
    roots.push(abs);
  };
  for (const target of targets) add(target.dir, target.name);
  for (const dir of extraWatch) add(dir, 'watch');
  return { roots, sources };
}
