#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(root, "skills-source");
const manifestName = ".lidfly-video-generated-skills.json";
const targets = [
  ".agents/skills",
  ".codex/skills",
  ".claude/skills",
  ".openclaw/skills",
];

const args = new Set(process.argv.slice(2));
if (args.has("--help") || args.has("-h")) {
  console.log("Usage: node scripts/sync-skills.mjs [--check]");
  process.exit(0);
}
for (const argument of args) {
  if (argument !== "--check") throw new Error(`Unknown argument: ${argument}`);
}
const checkOnly = args.has("--check");

function hash(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function isObjectRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function parseQuotedYamlValue(rawValue, label) {
  if (!rawValue?.startsWith('"')) {
    throw new Error(`${label}: value must be a double-quoted YAML string`);
  }
  try {
    return JSON.parse(rawValue);
  } catch (error) {
    throw new Error(`${label}: invalid quoted value (${error.message})`);
  }
}

function parseFrontmatter(markdown, skillName) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error(`${skillName}: missing YAML frontmatter`);

  const values = new Map();
  for (const line of match[1].split("\n")) {
    if (!line.trim()) continue;
    const field = line.match(/^([a-z-]+):\s*(.+)$/);
    if (!field) throw new Error(`${skillName}: unsupported frontmatter line: ${line}`);
    if (values.has(field[1])) throw new Error(`${skillName}: duplicate ${field[1]}`);
    values.set(field[1], field[2].trim());
  }

  if ([...values.keys()].sort().join(",") !== "description,name") {
    throw new Error(`${skillName}: frontmatter must contain only name and description`);
  }

  const name = values.get("name");
  const description = parseQuotedYamlValue(
    values.get("description"),
    `${skillName}: description`,
  );
  if (name !== skillName) throw new Error(`${skillName}: folder and frontmatter names differ`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    throw new Error(`${skillName}: invalid skill name`);
  }
  if (!description.trim() || description.length > 1024) {
    throw new Error(`${skillName}: description must contain 1-1024 characters`);
  }
  if (markdown.includes("[TODO:")) throw new Error(`${skillName}: unresolved TODO remains`);
  if (markdown.split("\n").length > 500) throw new Error(`${skillName}: SKILL.md exceeds 500 lines`);
}

function readMetadataField(yaml, field, skillName) {
  const match = yaml.match(new RegExp(`^\\s+${field}:\\s*(.+)$`, "m"));
  if (!match) throw new Error(`${skillName}: agents/openai.yaml missing ${field}`);
  return parseQuotedYamlValue(match[1].trim(), `${skillName}: ${field}`);
}

function validateOpenAiMetadata(skillDir, skillName) {
  const metadataPath = path.join(skillDir, "agents", "openai.yaml");
  if (!fs.existsSync(metadataPath)) throw new Error(`${skillName}: missing agents/openai.yaml`);
  const yaml = readText(metadataPath);
  const displayName = readMetadataField(yaml, "display_name", skillName);
  const shortDescription = readMetadataField(yaml, "short_description", skillName);
  const defaultPrompt = readMetadataField(yaml, "default_prompt", skillName);
  if (!displayName.trim()) throw new Error(`${skillName}: display_name is empty`);
  if (shortDescription.length < 25 || shortDescription.length > 64) {
    throw new Error(`${skillName}: short_description must contain 25-64 characters`);
  }
  if (!defaultPrompt.includes(`$${skillName}`)) {
    throw new Error(`${skillName}: default_prompt must mention $${skillName}`);
  }
}

function validateSkillReferences(skillDir, skillName, markdown, knownSkills) {
  for (const match of markdown.matchAll(/\]\((references\/[^)#?]+)(?:#[^)]*)?\)/g)) {
    const relativePath = match[1];
    const resolvedPath = path.resolve(skillDir, relativePath);
    const pathInsideSkill = path.relative(skillDir, resolvedPath);
    if (
      !pathInsideSkill
      || pathInsideSkill.startsWith("..")
      || path.isAbsolute(pathInsideSkill)
      || !fs.existsSync(resolvedPath)
      || !fs.statSync(resolvedPath).isFile()
    ) {
      throw new Error(`${skillName}: missing or unsafe reference ${relativePath}`);
    }
  }

  for (const match of markdown.matchAll(
    /(?<![A-Za-z0-9_])\$([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?![A-Za-z0-9_-]|\.[A-Za-z0-9_])/g,
  )) {
    const referencedSkill = match[1];
    if (!knownSkills.has(referencedSkill)) {
      throw new Error(`${skillName}: references unknown skill $${referencedSkill}`);
    }
  }
}

function listFiles(directory, baseDirectory = directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Symlinks are not allowed in skills-source: ${path.relative(sourceRoot, entryPath)}`,
      );
    }
    if (entry.name === ".DS_Store" || entry.name === "__pycache__" || entry.name.endsWith(".pyc")) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...listFiles(entryPath, baseDirectory));
    } else if (entry.isFile()) {
      files.push(path.relative(baseDirectory, entryPath));
    } else {
      throw new Error(
        `Unsupported filesystem entry in skills-source: ${path.relative(sourceRoot, entryPath)}`,
      );
    }
  }
  return files.sort();
}

function listTargetEntries(directory, baseDirectory = directory) {
  const entries = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      entries.push(...listTargetEntries(entryPath, baseDirectory));
    } else {
      entries.push(path.relative(baseDirectory, entryPath));
    }
  }
  return entries.sort();
}

function warnAboutUnmanagedEntries(targetRoot, skillName, expectedFiles) {
  const skillRoot = path.join(targetRoot, skillName);
  if (!fs.existsSync(skillRoot) || !fs.statSync(skillRoot).isDirectory()) return;

  const expected = new Set(expectedFiles);
  for (const relativePath of listTargetEntries(skillRoot)) {
    if (!expected.has(relativePath)) {
      console.warn(
        `Warning: unmanaged entry in generated skill directory: ${path.relative(root, path.join(skillRoot, relativePath))}`,
      );
    }
  }
}

function validateManifest(manifest, label) {
  if (!isObjectRecord(manifest) || manifest.version !== 1 || !isObjectRecord(manifest.skills)) {
    throw new Error(`${label}: invalid generated manifest`);
  }
  for (const [skillName, files] of Object.entries(manifest.skills)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName) || !isObjectRecord(files)) {
      throw new Error(`${label}: invalid generated skill ${skillName}`);
    }
    for (const [relativePath, expectedHash] of Object.entries(files)) {
      const parts = relativePath.split(/[\\/]/);
      if (
        !relativePath
        || path.isAbsolute(relativePath)
        || parts.some((part) => !part || part === "." || part === "..")
        || !/^[a-f0-9]{64}$/.test(expectedHash)
      ) {
        throw new Error(`${label}: unsafe generated path ${skillName}/${relativePath}`);
      }
    }
  }
}

function readManifest(targetRoot) {
  const manifestPath = path.join(targetRoot, manifestName);
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readText(manifestPath));
  validateManifest(manifest, manifestPath);
  return manifest;
}

function generatedPath(targetRoot, skillName, relativePath) {
  const resolved = path.resolve(targetRoot, skillName, relativePath);
  const relative = path.relative(targetRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Generated path escapes target root: ${skillName}/${relativePath}`);
  }
  return resolved;
}

function removeEmptyParents(startDirectory, stopDirectory) {
  let current = startDirectory;
  while (current !== stopDirectory && current.startsWith(`${stopDirectory}${path.sep}`)) {
    if (!fs.existsSync(current) || fs.readdirSync(current).length > 0) return;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

if (!fs.existsSync(sourceRoot)) throw new Error(`Missing source directory: ${sourceRoot}`);
const sourceEntries = fs.readdirSync(sourceRoot, { withFileTypes: true });
for (const entry of sourceEntries) {
  if (entry.isSymbolicLink()) {
    throw new Error(`Symlinks are not allowed in skills-source: ${entry.name}`);
  }
}
const skills = sourceEntries
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
if (skills.length === 0) throw new Error("No canonical skills found");
const knownSkills = new Set(skills);

const sourceFiles = new Map();
const nextManifest = { version: 1, skills: {} };
for (const skillName of skills) {
  const skillDir = path.join(sourceRoot, skillName);
  const skillPath = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillPath)) throw new Error(`${skillName}: missing SKILL.md`);
  const skillMarkdown = readText(skillPath);
  parseFrontmatter(skillMarkdown, skillName);
  validateSkillReferences(skillDir, skillName, skillMarkdown, knownSkills);
  validateOpenAiMetadata(skillDir, skillName);
  const files = listFiles(skillDir);
  sourceFiles.set(skillName, files);
  nextManifest.skills[skillName] = {};
  for (const relativePath of files) {
    nextManifest.skills[skillName][relativePath] = hash(
      fs.readFileSync(path.join(skillDir, relativePath)),
    );
  }
}

for (const target of targets) {
  const targetRoot = path.join(root, target);
  const previousManifest = readManifest(targetRoot);

  if (checkOnly) {
    if (JSON.stringify(previousManifest) !== JSON.stringify(nextManifest)) {
      throw new Error(`${target}: generated manifest is missing or stale`);
    }
    for (const skillName of skills) {
      for (const relativePath of sourceFiles.get(skillName)) {
        const sourcePath = path.join(sourceRoot, skillName, relativePath);
        const targetPath = generatedPath(targetRoot, skillName, relativePath);
        if (!fs.existsSync(targetPath) || !fs.readFileSync(targetPath).equals(fs.readFileSync(sourcePath))) {
          throw new Error(`${target}: out of sync: ${skillName}/${relativePath}`);
        }
      }
      warnAboutUnmanagedEntries(targetRoot, skillName, sourceFiles.get(skillName));
    }
    continue;
  }

  fs.mkdirSync(targetRoot, { recursive: true });

  if (previousManifest) {
    for (const [skillName, files] of Object.entries(previousManifest.skills)) {
      for (const [relativePath, previousHash] of Object.entries(files)) {
        const targetPath = generatedPath(targetRoot, skillName, relativePath);
        if (!fs.existsSync(targetPath)) continue;
        const currentHash = hash(fs.readFileSync(targetPath));
        const nextHash = nextManifest.skills[skillName]?.[relativePath];
        if (currentHash !== previousHash && currentHash !== nextHash) {
          throw new Error(`Refusing to overwrite modified generated file: ${targetPath}`);
        }
        if (!nextHash) {
          fs.unlinkSync(targetPath);
          removeEmptyParents(path.dirname(targetPath), targetRoot);
        }
      }
    }
  }

  for (const skillName of skills) {
    for (const relativePath of sourceFiles.get(skillName)) {
      const sourcePath = path.join(sourceRoot, skillName, relativePath);
      const targetPath = generatedPath(targetRoot, skillName, relativePath);
      const wasTracked = Boolean(previousManifest?.skills?.[skillName]?.[relativePath]);
      if (fs.existsSync(targetPath) && !wasTracked && !fs.readFileSync(targetPath).equals(fs.readFileSync(sourcePath))) {
        throw new Error(`Refusing to overwrite unmanaged file: ${targetPath}`);
      }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(sourcePath, targetPath);
    }
  }

  fs.writeFileSync(
    path.join(targetRoot, manifestName),
    `${JSON.stringify(nextManifest, null, 2)}\n`,
  );
}

console.log(
  checkOnly
    ? `Validated ${skills.length} skill(s) across ${targets.length} client directories.`
    : `Synced ${skills.length} skill(s) to ${targets.length} client directories.`,
);
