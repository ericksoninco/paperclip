import { describe, expect, it, vi } from "vitest";
import type { Agent, Company } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin, { pollTelegramInbound } from "../src/worker.js";
import { INBOUND_JOB_KEY, OFFSET_STATE_KEY, ORIGIN_KIND, STATE_NAMESPACE } from "../src/constants.js";

function companyStateKey(companyId: string, stateKey: string) {
  return { scopeKind: "company" as const, scopeId: companyId, namespace: STATE_NAMESPACE, stateKey };
}

function ceoAgent(): Agent {
  const now = new Date();
  return {
    id: "ceo-agent",
    companyId: "company-1",
    name: "CEO",
    urlKey: "ceo",
    role: "ceo",
    title: "CEO",
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
  };
}

function company(): Company {
  const now = new Date();
  return {
    id: "company-1",
    name: "Acme",
    description: null,
    status: "active",
    pauseReason: null,
    pausedAt: null,
    issuePrefix: "ACME",
    issueCounter: 0,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    attachmentMaxBytes: 10_000_000,
    requireBoardApprovalForNewAgents: false,
    feedbackDataSharingEnabled: false,
    feedbackDataSharingConsentAt: null,
    feedbackDataSharingConsentByUserId: null,
    feedbackDataSharingTermsVersion: null,
    brandColor: null,
    logoAssetId: null,
    logoUrl: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("telegram connector plugin", () => {
  it("declares a single scheduled inbound cursor owner", () => {
    expect(manifest.capabilities).toEqual(expect.arrayContaining([
      "http.outbound",
      "companies.read",
      "secrets.read-ref",
      "issues.create",
      "plugin.state.read",
      "plugin.state.write",
      "jobs.schedule",
    ]));
    expect(manifest.jobs).toContainEqual(expect.objectContaining({
      jobKey: INBOUND_JOB_KEY,
      schedule: "* * * * *",
    }));
  });

  it("routes allowed Telegram messages into assigned Paperclip issues exactly once", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({
      tokenSecretRef: "TELEGRAM_BOT_TOKEN",
      allowedChatId: "7230170718",
      assigneeAgentId: "ceo-agent",
      projectId: "project-1",
      timeoutSeconds: 1,
    });
    harness.seed({ agents: [ceoAgent()] });

    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      new Response(JSON.stringify({
        ok: true,
        result: [{
          update_id: 101,
          message: {
            message_id: 55,
            date: 1_782_962_400,
            chat: { id: 7_230_170_718, type: "private" },
            from: { id: 1, first_name: "Mike", username: "mike" },
            text: "Are we reading this channel?",
          },
        }],
      }), { status: 200 })
    );
    harness.ctx.http.fetch = fetchMock;
    harness.ctx.secrets.resolve = async (secretRef) => {
      expect(secretRef).toBe("TELEGRAM_BOT_TOKEN");
      return "token";
    };

    const first = await pollTelegramInbound(harness.ctx, "company-1");
    const second = await pollTelegramInbound(harness.ctx, "company-1");

    expect(first).toMatchObject({ fetched: 1, routed: 1, skipped: 0, nextOffset: 102 });
    expect(second).toMatchObject({ fetched: 1, routed: 0, skipped: 1, nextOffset: 102 });
    const firstUrl = fetchMock.mock.calls.at(0)?.[0];
    const secondUrl = fetchMock.mock.calls.at(1)?.[0];
    expect(typeof firstUrl === "string" ? firstUrl : "").toContain("getUpdates?");
    expect(typeof secondUrl === "string" ? secondUrl : "").toContain("offset=102");

    const issues = await harness.ctx.issues.list({ companyId: "company-1", originKind: ORIGIN_KIND });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      projectId: "project-1",
      status: "todo",
      priority: "high",
      assigneeAgentId: "ceo-agent",
      originKind: ORIGIN_KIND,
      originId: "101",
    });
    expect(issues[0]?.description).toContain("Are we reading this channel?");
    expect(harness.getState(companyStateKey("company-1", OFFSET_STATE_KEY))).toBe(102);
  });

  it("acknowledges but skips messages from non-allowlisted chats", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({
      tokenSecretRef: "TELEGRAM_BOT_TOKEN",
      allowedChatId: "7230170718",
    });
    harness.ctx.http.fetch = async () =>
      new Response(JSON.stringify({
        ok: true,
        result: [{
          update_id: 201,
          message: {
            message_id: 60,
            chat: { id: 999 },
            text: "ignore me",
          },
        }],
      }), { status: 200 });

    const result = await pollTelegramInbound(harness.ctx, "company-1");
    const issues = await harness.ctx.issues.list({ companyId: "company-1", originKind: ORIGIN_KIND });

    expect(result).toMatchObject({ fetched: 1, routed: 0, skipped: 1, nextOffset: 202 });
    expect(issues).toHaveLength(0);
    expect(harness.getState(companyStateKey("company-1", OFFSET_STATE_KEY))).toBe(202);
  });

  it("registers the inbound job handler", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ tokenSecretRef: "TELEGRAM_BOT_TOKEN" });
    harness.seed({ companies: [company()] });
    harness.ctx.http.fetch = async () => new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
    await plugin.definition.setup(harness.ctx);
    await expect(harness.runJob(INBOUND_JOB_KEY)).resolves.toBeUndefined();
  });
});
