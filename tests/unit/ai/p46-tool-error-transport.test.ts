import { describe, expect, it } from "vitest";
import {
  createUIMessageStream,
  readUIMessageStream,
  streamText,
  tool,
  type UIMessage,
} from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { AiToolAuthorizationError, type AssistantErrorCode } from "@/lib/ai/errors";

/**
 * Transport-level regression suite for P4.6 phase review #2, H2.
 *
 * Review #1 fixed the mid-stream denial path on the premise that a tool
 * `execute()` throw "lands in `toUIMessageStreamResponse`'s `onError`" and is
 * rendered from `useChat`'s `error`. It does not, and review #2 found the fix
 * unreachable for the transport it was written for. The test that was supposed
 * to protect it called `options.onError(...)` directly — which proves the
 * function body and nothing about where its return value goes.
 *
 * So these tests drive the **real** SDK: a real `streamText` call over a real
 * mock model, a real tool that really throws, the real
 * `toUIMessageStreamResponse` encoder, and `readUIMessageStream` — the same
 * reconstruction `useChat` performs on the client. Nothing here stubs the
 * chunk shapes; the chunk shapes are what is under test.
 *
 * If the SDK's routing ever changes — a tool throw becoming a stream error, or
 * `errorText` moving — these fail, which is the point.
 */

type FinishArgs = { finishReason: string; responseMessage: UIMessage };

const usage = () => ({
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
});

/**
 * A model that calls `probe_tool` once, then answers in text — the shape of a
 * real turn in which a tool fails and the model recovers.
 */
function modelCallingTool(options: { thenText: string | null }) {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      call += 1;
      const parts =
        call === 1
          ? [
              {
                type: "tool-call" as const,
                toolCallId: "call-1",
                toolName: "probe_tool",
                input: JSON.stringify({ q: "x" }),
              },
              {
                type: "finish" as const,
                finishReason: { unified: "tool-calls" as const, raw: undefined },
                usage: usage(),
              },
            ]
          : [
              ...(options.thenText
                ? ([
                    { type: "text-start" as const, id: "t1" },
                    { type: "text-delta" as const, id: "t1", delta: options.thenText },
                    { type: "text-end" as const, id: "t1" },
                  ] as const)
                : []),
              {
                type: "finish" as const,
                finishReason: { unified: "stop" as const, raw: undefined },
                usage: usage(),
              },
            ];
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  });
}

/** The exact `onError` contract `app/api/agent/chat/route.ts` installs. */
function routeOnError(error: unknown): string {
  if (error instanceof AiToolAuthorizationError) return error.reason;
  return "temporarily_unavailable" satisfies AssistantErrorCode;
}

function textOf(args: FinishArgs | null): string {
  return (args?.responseMessage.parts ?? [])
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

async function runTurn({
  execute,
  thenText = "Here is what I could find.",
}: {
  execute: () => Promise<unknown>;
  thenText?: string | null;
}) {
  const result = streamText({
    model: modelCallingTool({ thenText }),
    prompt: "go",
    tools: {
      probe_tool: tool({
        description: "probe",
        inputSchema: z.object({ q: z.string() }),
        execute,
      }),
    },
    stopWhen: ({ steps }) => steps.length >= 2,
  });

  // Held in an object rather than a `let`: TypeScript narrows a null-initialized
  // local to `null` and does not track the callback assignment.
  const finish: { args: FinishArgs | null } = { args: null };
  const response = result.toUIMessageStreamResponse({
    onError: routeOnError,
    onFinish(args) {
      finish.args = args as unknown as FinishArgs;
    },
  });

  // Decode the wire format the browser actually receives.
  const raw = await response.text();
  const chunks = raw
    .split("\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)) as { type: string } & Record<string, unknown>);

  return { chunks, finishArgs: finish.args };
}

describe("H2 — a throwing tool never reaches the stream-level error channel", () => {
  it("routes an execute() throw to a tool-output-error part, not to an error chunk", async () => {
    const { chunks } = await runTurn({
      execute: async () => {
        throw new AiToolAuthorizationError("page_hidden");
      },
    });

    const toolError = chunks.find((chunk) => chunk.type === "tool-output-error");
    expect(toolError).toBeDefined();

    // The load-bearing negative. `useChat` sets its `error` from the
    // stream-level `error` chunk and from nothing else, so its absence here is
    // exactly why the route's reason code and the client's ERROR_COPY_KEYS
    // table were unreachable for this transport, and why `ToolActivity` has to
    // classify the part itself.
    expect(chunks.some((chunk) => chunk.type === "error")).toBe(false);
  });

  it("carries the reason code intact as the tool part's errorText", async () => {
    for (const reason of [
      "page_hidden",
      "subscription_inactive",
      "permission_not_granted",
      "lookup_failed",
    ] as const) {
      const { chunks } = await runTurn({
        execute: async () => {
          throw new AiToolAuthorizationError(reason);
        },
      });
      const toolError = chunks.find((chunk) => chunk.type === "tool-output-error");
      expect(toolError).toMatchObject({ errorText: reason });
    }
  });

  it("sends a classifiable code, never a localized sentence, for an internal failure", async () => {
    const { chunks } = await runTurn({
      execute: async () => {
        throw new Error("Patient statistics lookup failed.");
      },
    });

    const toolError = chunks.find((chunk) => chunk.type === "tool-output-error");
    // Not the raw message: an internal sentence must not reach the user or the
    // model's context, and it must be something ERROR_COPY_KEYS can key on.
    expect(toolError).toMatchObject({ errorText: "temporarily_unavailable" });
    expect(JSON.stringify(chunks)).not.toContain("Patient statistics lookup failed.");
  });

  it("reconstructs on the client exactly as ToolActivity reads it", async () => {
    const { chunks } = await runTurn({
      execute: async () => {
        throw new AiToolAuthorizationError("subscription_inactive");
      },
    });

    // readUIMessageStream is the same reconstruction useChat performs.
    const stream = createUIMessageStream({
      execute({ writer }) {
        for (const chunk of chunks) writer.write(chunk as never);
      },
    });
    let last: UIMessage | undefined;
    for await (const message of readUIMessageStream({ stream })) last = message;

    const part = last?.parts.find(
      (candidate) => candidate.type === "tool-probe_tool",
    ) as { state?: string; errorText?: string } | undefined;

    expect(part?.state).toBe("output-error");
    expect(part?.errorText).toBe("subscription_inactive");
  });
});

describe("M2 — a tool error the model recovers from is not a failed turn", () => {
  it("finishes with a normal reason and real assistant text after a tool throws", async () => {
    const { finishArgs } = await runTurn({
      execute: async () => {
        throw new Error("transient lookup failure");
      },
      thenText: "I could not read that, but here is what I can tell you.",
    });

    // These are precisely the two signals the route now uses instead of
    // `streamFailed`, which fires for every tool-error part. `finishReason` is
    // not "error" and there is assistant text, so the turn is persisted and
    // billed as a success — the user watched a complete answer stream in.
    expect(finishArgs?.finishReason).not.toBe("error");
    const text = textOf(finishArgs);
    expect(text).toContain("here is what I can tell you");
  });

  it("still looks like a failure when the tool error left no answer behind", async () => {
    const { finishArgs } = await runTurn({
      execute: async () => {
        throw new Error("fatal");
      },
      thenText: null,
    });

    const text = textOf(finishArgs);
    // No assistant text — the route's remaining failure condition. This is what
    // keeps M2 from turning "do not fail on a recovered error" into "never fail".
    expect(text).toBe("");
  });
});

describe("H2 — a denial converted by harden() never reaches the error transport at all", () => {
  it("arrives as an ordinary tool output the UI can render as a notice", async () => {
    // What `harden()` now returns in place of the throw.
    const { chunks } = await runTurn({
      execute: async () => ({
        permission_denied: true,
        reason: "permission_not_granted",
        guidance: "Ask an administrator.",
      }),
    });

    expect(chunks.some((chunk) => chunk.type === "tool-output-error")).toBe(false);
    const output = chunks.find((chunk) => chunk.type === "tool-output-available");
    expect(output).toMatchObject({
      output: expect.objectContaining({ reason: "permission_not_granted" }),
    });
  });
});
