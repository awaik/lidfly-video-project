import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("--execute rejects a value instead of silently disabling execution", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ["src/cli.mjs", "submit", "--job", "unused", "--execute", "true"]),
    (error) => {
      assert.match(error.stderr, /--execute does not accept a value/);
      return true;
    },
  );
});

test("models lists Seedance 2.5 first and marks it as default", async () => {
  const { stdout } = await execFileAsync(process.execPath, ["src/cli.mjs", "models"]);
  const result = JSON.parse(stdout);
  assert.equal(result.models[0].key, "seedance-2.5");
  assert.equal(result.models[0].is_default, true);
  assert.equal(result.models[0].exact_model_ids.video_extend, "seedance-2.5-video-extend");
});

test("assets check rejects --model without a value", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      "src/cli.mjs",
      "assets",
      "check",
      "--project",
      "unused",
      "--model",
      "--mode",
      "image_to_video",
    ]),
    (error) => {
      assert.match(error.stderr, /--model is required/);
      assert.doesNotMatch(error.stderr, /Unknown model: true/);
      return true;
    },
  );
});
