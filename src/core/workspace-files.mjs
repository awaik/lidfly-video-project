import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function pathIsInside(root, candidate) {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))
  );
}

export async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function readJson(filePath, label) {
  let source;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing: ${filePath}`);
    throw error;
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} contains invalid JSON at ${filePath}: ${error.message}`);
  }
}

export async function assertDirectory(directory, label) {
  const info = await stat(directory);
  if (!info.isDirectory()) throw new Error(`${label} is not a directory: ${directory}`);
}

export async function resolveWorkspaceRoot(workspaceRoot, defaultWorkspaceRoot) {
  const requested = resolve(workspaceRoot ?? defaultWorkspaceRoot);
  await assertDirectory(requested, "workspace_root");
  return realpath(requested);
}

/** Reject lexical traversal and every existing symlink segment that resolves outside the root. */
export async function assertSafeWorkspacePath(workspaceRoot, candidate, label) {
  const absolute = resolve(candidate);
  if (!pathIsInside(workspaceRoot, absolute)) {
    throw new Error(`${label} escapes workspace_root: ${absolute}`);
  }

  const parts = relative(workspaceRoot, absolute).split(sep).filter(Boolean);
  let current = workspaceRoot;
  for (const part of parts) {
    current = join(current, part);
    try {
      await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
    const resolvedExistingPath = await realpath(current);
    if (!pathIsInside(workspaceRoot, resolvedExistingPath)) {
      throw new Error(`${label} follows a symlink outside workspace_root: ${current}`);
    }
  }
  return absolute;
}

export async function mkdirSafe(workspaceRoot, directory, label) {
  await assertSafeWorkspacePath(workspaceRoot, directory, label);
  await mkdir(directory, { recursive: true });
  await assertSafeWorkspacePath(workspaceRoot, directory, label);
  await assertDirectory(directory, label);
}

/**
 * Replace a JSON file in one step: stage a sibling temp file, then rename.
 *
 * A reader never sees a half-written registry, and a crash mid-write leaves the
 * previous file intact rather than a truncated one.
 */
export async function writeJsonAtomic(workspaceRoot, filePath, value, label = "json file") {
  const staging = join(dirname(filePath), `.${randomUUID()}.tmp`);
  await assertSafeWorkspacePath(workspaceRoot, staging, `${label} staging file`);
  await writeFile(staging, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await rename(staging, filePath);
  } catch (error) {
    await unlink(staging).catch(() => {});
    throw error;
  }
}
