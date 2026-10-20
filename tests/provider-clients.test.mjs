import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { ProviderError } from "../src/core/errors.mjs";
import { EvolinkClient } from "../src/providers/evolink/client.mjs";
import { KomendClient } from "../src/providers/komend/client.mjs";

test("EVOLINK submit uses bearer auth and returns task without polling resubmit", async () => {
  const calls = [];
  const client = new EvolinkClient({
    apiKey: "test-secret",
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      return Response.json({
        id: "task-unified-123-abc",
        model: "kling-v3-text-to-video",
        status: "pending",
      });
    },
  });
  const result = await client.submitVideo({ model: "kling-v3-text-to-video", prompt: "x" });
  assert.equal(result.id, "task-unified-123-abc");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.evolink.ai/v1/videos/generations");
  assert.equal(calls[0].init.headers.Authorization, "Bearer test-secret");
});

test("EVOLINK doctor can query credits without creating a task", async () => {
  let request;
  const client = new EvolinkClient({
    apiKey: "test-secret",
    fetchFn: async (url, init) => {
      request = { url, init };
      return Response.json({
        success: true,
        message: "",
        data: {
          token: { remaining_credits: 10, unlimited_credits: false, used_credits: 1 },
          user: { remaining_credits: 10, used_credits: 1 },
        },
      });
    },
  });
  const result = await client.getCredits();
  assert.equal(result.success, true);
  assert.equal(request.url, "https://api.evolink.ai/v1/credits");
  assert.equal(request.init.method, undefined);
});

test("EVOLINK polling queries one existing task until completion", async () => {
  let calls = 0;
  const client = new EvolinkClient({
    apiKey: "test-secret",
    fetchFn: async (url, init) => {
      calls += 1;
      assert.match(url, /\/v1\/tasks\/task-unified-123-abc$/);
      assert.equal(init.method, undefined);
      return Response.json(
        calls === 1
          ? { id: "task-unified-123-abc", status: "processing", progress: 50 }
          : {
              id: "task-unified-123-abc",
              status: "completed",
              progress: 100,
              results: ["https://example.com/result.mp4"],
            },
      );
    },
  });
  const result = await client.waitForTask("task-unified-123-abc", {
    timeoutMs: 1_000,
    initialDelayMs: 0,
    maxDelayMs: 0,
  });
  assert.equal(result.status, "completed");
  assert.equal(calls, 2);
});

test("EVOLINK normalizes HTTP retryability and redacts provider error details", async () => {
  for (const [status, retryable] of [[429, true], [503, true], [400, false]]) {
    const client = new EvolinkClient({
      apiKey: "test-secret",
      fetchFn: async () => Response.json(
        {
          error: { message: "provider rejected request", code: `status_${status}` },
          access_token: "access-secret",
          password: "password-secret",
          session: "session-secret",
          cookie: "cookie-secret",
          callback: "https://example.com/result?access_token=url-secret&session=session-id",
        },
        { status },
      ),
    });
    await assert.rejects(
      client.submitVideo({ model: "kling-v3-text-to-video", prompt: "x" }),
      (error) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.status, status);
        assert.equal(error.code, `status_${status}`);
        assert.equal(error.retryable, retryable);
        assert.equal(error.details.access_token, "[redacted]");
        assert.equal(error.details.password, "[redacted]");
        assert.equal(error.details.session, "[redacted]");
        assert.equal(error.details.cookie, "[redacted]");
        assert.match(error.details.callback, /access_token=%5Bredacted%5D/);
        assert.match(error.details.callback, /session=%5Bredacted%5D/);
        return true;
      },
    );
  }
});

test("EVOLINK polling rejects every documented terminal failure", async () => {
  for (const status of ["failed", "cancelled", "expired"]) {
    const client = new EvolinkClient({
      apiKey: "test-secret",
      fetchFn: async () => Response.json({
        id: "task-unified-terminal",
        status,
        error: { code: `${status}_code`, message: `${status} detail` },
        access_token: "provider-secret",
      }),
    });
    await assert.rejects(
      client.waitForTask("task-unified-terminal", {
        timeoutMs: 1_000,
        initialDelayMs: 0,
        maxDelayMs: 0,
      }),
      (error) => {
        assert.ok(error instanceof ProviderError);
        assert.match(error.message, new RegExp(`task ${status}`));
        assert.equal(error.code, `${status}_code`);
        assert.equal(error.retryable, false);
        assert.equal(error.details.access_token, "[redacted]");
        return true;
      },
    );
  }
});

test("Komend sends form data and writes a new audio artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-komend-"));
  const output = join(directory, "narration.mp3");
  let captured;
  const client = new KomendClient({
    authToken: "tts-secret",
    endpoint: "https://tts.example.com/api/synthesize",
    fetchFn: async (url, init) => {
      captured = { url, init };
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "Content-Type": "audio/mpeg" },
      });
    },
  });
  const result = await client.synthesize({
    text: "Я вас слушаю.",
    voice: "female",
    format: "mp3",
    outputPath: output,
  });
  assert.equal(result.voice_id, "ru_zhadyra");
  assert.deepEqual([...new Uint8Array(await readFile(output))], [1, 2, 3]);
  assert.equal(captured.url, "https://tts.example.com/api/synthesize");
  assert.equal(captured.init.headers.Authorization, "Bearer tts-secret");
  assert.equal(captured.init.body.get("voice"), "ru_zhadyra");
  assert.equal(captured.init.body.get("format"), "mp3");
});

test("Komend refuses synthesis when KOMEND_TTS_ENDPOINT is not configured", async () => {
  const client = new KomendClient({ authToken: "tts-secret", endpoint: null });
  await assert.rejects(
    client.synthesize({ text: "Тест.", format: "mp3", outputPath: "/tmp/out.mp3" }),
    /KOMEND_TTS_ENDPOINT is not configured/,
  );
});

test("Komend normalizes HTTP retryability and redacts provider error details", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-komend-errors-"));
  for (const [status, retryable] of [[429, true], [502, true], [422, false]]) {
    const client = new KomendClient({
      authToken: "tts-secret",
      endpoint: "https://tts.example.com/api/synthesize",
      fetchFn: async () => Response.json(
        {
          message: "synthesis failed",
          code: `status_${status}`,
          password: "password-secret",
          access_token: "access-secret",
          session_id: "session-secret",
          cookie: "cookie-secret",
        },
        { status },
      ),
    });
    await assert.rejects(
      client.synthesize({
        text: "Тест.",
        format: "mp3",
        outputPath: join(directory, `narration-${status}.mp3`),
      }),
      (error) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.status, status);
        assert.equal(error.retryable, retryable);
        assert.equal(error.details.password, "[redacted]");
        assert.equal(error.details.access_token, "[redacted]");
        assert.equal(error.details.session_id, "[redacted]");
        assert.equal(error.details.cookie, "[redacted]");
        return true;
      },
    );
  }
});

test("the task list is a plain GET that normalizes both creation-time shapes", async () => {
  const calls = [];
  const client = new EvolinkClient({
    apiKey: "test-secret",
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      return Response.json({
        data: [
          { id: "task-a", model: "seedance-2.5-text-to-video", status: "processing", created_at: 1786913280 },
          { id: "task-b", model: "seedance-2.5-text-to-video", status: "completed", created: 1786913000 },
        ],
      });
    },
  });

  const listed = await client.listTasks({ limit: 5 });
  assert.equal(calls[0].url, "https://api.evolink.ai/v1/tasks?limit=5");
  assert.equal(calls[0].init.method, undefined);
  assert.equal(calls[0].init.headers.Authorization, "Bearer test-secret");
  assert.equal(listed.count, 2);
  // Seconds in, milliseconds out, whichever field the endpoint used.
  assert.equal(listed.tasks[0].created_at_ms, 1786913280000);
  assert.equal(listed.tasks[1].created_at_ms, 1786913000000);
});

test("a task list that is not an array is a provider error, not silent emptiness", async () => {
  const client = new EvolinkClient({
    apiKey: "test-secret",
    fetchFn: async () => Response.json({ data: { id: "task-a" } }),
  });
  await assert.rejects(client.listTasks(), /EVOLINK task list returned an unexpected response/);
});
