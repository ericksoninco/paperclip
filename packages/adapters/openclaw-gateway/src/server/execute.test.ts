import { describe, expect, it } from "vitest";
import {
  buildOpenClawAgentParams,
  buildOpenClawPaperclipWakeEnvelope,
  OPENCLAW_V4_AGENT_PARAM_KEYS,
  PROTOCOL_VERSION,
  resolveSessionKey,
} from "./execute.js";

describe("PROTOCOL_VERSION", () => {
  it("matches the minimum protocol required by the current OpenClaw gateway", () => {
    expect(PROTOCOL_VERSION).toBe(4);
  });
});

describe("resolveSessionKey", () => {
  it("prefixes run-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "run",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip:run:run-123");
  });

  it("prefixes issue-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "issue",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: "issue-456",
      }),
    ).toBe("agent:meridian:paperclip:issue:issue-456");
  });

  it("prefixes fixed session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });

  it("does not double-prefix an already-routed session key", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "agent:meridian:paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });
});

describe("buildOpenClawAgentParams", () => {
  it("only emits root keys accepted by OpenClaw v4 AgentParamsSchema", () => {
    const params = buildOpenClawAgentParams({
      payloadTemplate: {
        message: "template message",
        text: "legacy text alias",
        paperclip: { runId: "run-123" },
        agentId: "template-agent",
        provider: "anthropic",
        model: "claude-sonnet-4.5",
        timeout: 45_000,
        unsupported: true,
      },
      message: "rendered wake message",
      sessionKey: "agent:template-agent:paperclip:issue:issue-456",
      idempotencyKey: "run-123",
      configuredAgentId: "configured-agent",
      waitTimeoutMs: 30_000,
    });

    expect(Object.keys(params).sort()).toEqual(
      ["agentId", "idempotencyKey", "message", "model", "paperclip", "provider", "sessionKey", "timeout"].sort(),
    );
    expect(params.paperclip).toEqual({ runId: "run-123" });
    expect(params).not.toHaveProperty("text");
    expect(params).not.toHaveProperty("unsupported");
    expect(
      Object.keys(params).every((key) => (OPENCLAW_V4_AGENT_PARAM_KEYS as readonly string[]).includes(key)),
    ).toBe(true);
  });

  it("uses the configured agent id and wait timeout when the template omits them", () => {
    const params = buildOpenClawAgentParams({
      payloadTemplate: {},
      message: "rendered wake message",
      sessionKey: "paperclip:run:run-123",
      idempotencyKey: "run-123",
      configuredAgentId: "configured-agent",
      waitTimeoutMs: 30_000,
    });

    expect(params.agentId).toBe("configured-agent");
    expect(params.timeout).toBe(30_000);
  });

  it("attaches generated Paperclip wake envelope while preserving template metadata", () => {
    const params = buildOpenClawAgentParams({
      payloadTemplate: {
        paperclip: {
          source: "template",
          wake: { stale: true },
        },
      },
      message: "rendered wake message",
      sessionKey: "paperclip:issue:issue-456",
      idempotencyKey: "run-123",
      configuredAgentId: null,
      waitTimeoutMs: 30_000,
      paperclipWake: {
        reason: "issue_commented",
        commentIds: ["comment-1", "comment-2"],
        latestCommentId: "comment-2",
      },
    });

    expect(params.paperclip).toEqual({
      source: "template",
      wake: {
        reason: "issue_commented",
        commentIds: ["comment-1", "comment-2"],
        latestCommentId: "comment-2",
      },
    });
  });
});

describe("buildOpenClawPaperclipWakeEnvelope", () => {
  it("normalizes the structured Paperclip wake payload for OpenClaw agent params", () => {
    const wake = buildOpenClawPaperclipWakeEnvelope({
      structuredWake: {
        reason: "issue_assigned",
        issue: {
          id: "issue-123",
          identifier: "EDD-123",
          title: "Fix it",
          status: "in_progress",
          priority: "high",
        },
        checkedOutByHarness: true,
        commentIds: [],
      },
      wakePayload: {
        runId: "run-123",
        agentId: "agent-123",
        companyId: "company-123",
        taskId: "issue-123",
        issueId: "issue-123",
        wakeReason: "issue_assigned",
        wakeCommentId: null,
        approvalId: null,
        approvalStatus: null,
        issueIds: [],
      },
    });

    expect(wake).toMatchObject({
      reason: "issue_assigned",
      issue: {
        id: "issue-123",
        identifier: "EDD-123",
        title: "Fix it",
        status: "in_progress",
        priority: "high",
      },
      checkedOutByHarness: true,
      commentIds: [],
    });
  });

  it("falls back to scalar wake context when no structured payload exists", () => {
    const wake = buildOpenClawPaperclipWakeEnvelope({
      structuredWake: null,
      wakePayload: {
        runId: "run-123",
        agentId: "agent-123",
        companyId: "company-123",
        taskId: "issue-123",
        issueId: "issue-123",
        wakeReason: "issue_commented",
        wakeCommentId: "comment-123",
        approvalId: null,
        approvalStatus: null,
        issueIds: [],
      },
    });

    expect(wake).toEqual({
      reason: "issue_commented",
      latestCommentId: "comment-123",
      commentIds: ["comment-123"],
    });
  });
});
