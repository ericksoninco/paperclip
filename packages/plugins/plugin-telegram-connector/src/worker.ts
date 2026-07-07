import { definePlugin, runWorker, type Agent, type Issue, type PluginContext, type PluginJobContext } from "@paperclipai/plugin-sdk";
import {
  INBOUND_JOB_KEY,
  OFFSET_STATE_KEY,
  ORIGIN_KIND,
  PLUGIN_ID,
  PROCESSED_UPDATE_PREFIX,
  STATE_NAMESPACE,
} from "./constants.js";
import {
  TELEGRAM_LONG_POLL_TIMEOUT_SECONDS_DEFAULT,
  TELEGRAM_LONG_POLL_TIMEOUT_SECONDS_MAX,
} from "./polling-config.js";

interface TelegramConnectorConfig {
  tokenSecretRef?: string;
  companyId?: string;
  allowedChatId?: string;
  assigneeAgentId?: string;
  projectId?: string;
  timeoutSeconds?: number;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TelegramChat {
  id: number | string;
  type?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  title?: string;
}

interface TelegramUser {
  id?: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_bot?: boolean;
}

interface TelegramMessage {
  message_id: number;
  date?: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

interface PollResult {
  fetched: number;
  routed: number;
  skipped: number;
  nextOffset: number | null;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function chatIdValue(value: number | string): string {
  return String(value);
}

function displayName(user?: TelegramUser): string {
  if (!user) return "unknown sender";
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  if (user.username) return name ? `${name} (@${user.username})` : `@${user.username}`;
  return name || "unknown sender";
}

function messageBody(message: TelegramMessage): string {
  return (message.text ?? message.caption ?? "").trim();
}

function stateKey(companyId: string, key: string) {
  return { scopeKind: "company" as const, scopeId: companyId, namespace: STATE_NAMESPACE, stateKey: key };
}

async function getConfig(ctx: PluginContext): Promise<Required<Pick<TelegramConnectorConfig, "timeoutSeconds">> & TelegramConnectorConfig> {
  const raw = asObject(await ctx.config.get());
  return {
    tokenSecretRef: stringValue(raw.tokenSecretRef),
    companyId: stringValue(raw.companyId),
    allowedChatId: stringValue(raw.allowedChatId),
    assigneeAgentId: stringValue(raw.assigneeAgentId),
    projectId: stringValue(raw.projectId),
    timeoutSeconds: Math.max(
      0,
      Math.min(
        TELEGRAM_LONG_POLL_TIMEOUT_SECONDS_MAX,
        numberValue(raw.timeoutSeconds) ?? TELEGRAM_LONG_POLL_TIMEOUT_SECONDS_DEFAULT,
      ),
    ),
  };
}

async function resolvePollingCompanyId(ctx: PluginContext, configuredCompanyId?: string): Promise<string> {
  if (configuredCompanyId) return configuredCompanyId;

  const companies = await ctx.companies.list({ limit: 2, offset: 0 });
  if (companies.length === 1) return companies[0]!.id;
  if (companies.length === 0) {
    throw new Error("Telegram connector requires one Paperclip company or an explicit companyId in plugin config");
  }
  throw new Error("Telegram connector uses one global Telegram getUpdates cursor; set companyId when more than one company exists");
}

async function resolveAssigneeAgentId(
  ctx: PluginContext,
  companyId: string,
  configuredAssigneeAgentId?: string,
): Promise<string | undefined> {
  if (configuredAssigneeAgentId) return configuredAssigneeAgentId;
  const agents = await ctx.agents.list({ companyId, limit: 100, offset: 0 });
  return agents.find((agent: Agent) => agent.role === "ceo" || agent.name.toLowerCase() === "ceo")?.id;
}

async function deleteWebhook(ctx: PluginContext, token: string): Promise<void> {
  const params = new URLSearchParams({ drop_pending_updates: "false" });
  const response = await ctx.http.fetch(`https://api.telegram.org/bot${token}/deleteWebhook?${params.toString()}`, {
    method: "POST",
  });
  const payload = await response.json() as TelegramApiResponse<boolean>;
  if (!response.ok || !payload.ok) {
    throw new Error(`Telegram deleteWebhook failed: ${payload.description ?? response.statusText}`);
  }
}

async function fetchUpdates(
  ctx: PluginContext,
  token: string,
  offset: number | null,
  timeoutSeconds: number,
): Promise<TelegramUpdate[]> {
  const params = new URLSearchParams({
    timeout: String(timeoutSeconds),
    allowed_updates: JSON.stringify(["message", "edited_message"]),
  });
  if (offset !== null) params.set("offset", String(offset));

  const response = await ctx.http.fetch(`https://api.telegram.org/bot${token}/getUpdates?${params.toString()}`, {
    method: "GET",
  });
  const payload = await response.json() as TelegramApiResponse<TelegramUpdate[]>;
  if (!response.ok || !payload.ok || !Array.isArray(payload.result)) {
    throw new Error(`Telegram getUpdates failed: ${payload.description ?? response.statusText}`);
  }
  return payload.result;
}

async function createInboundIssue(
  ctx: PluginContext,
  companyId: string,
  update: TelegramUpdate,
  message: TelegramMessage,
  config: TelegramConnectorConfig,
  assigneeAgentId?: string,
): Promise<Issue> {
  const body = messageBody(message);
  const sender = displayName(message.from);
  const chatId = chatIdValue(message.chat.id);
  const sentAt = message.date ? new Date(message.date * 1000).toISOString() : "unknown";
  const titleText = body.length > 80 ? `${body.slice(0, 77)}...` : body || "(non-text Telegram message)";

  return await ctx.issues.create({
    companyId,
    projectId: config.projectId,
    title: `Telegram from ${sender}: ${titleText}`,
    description: [
      "## Inbound Telegram message",
      "",
      `- Sender: ${sender}`,
      `- Chat ID: \`${chatId}\``,
      `- Telegram message ID: \`${message.message_id}\``,
      `- Telegram update ID: \`${update.update_id}\``,
      `- Sent at: ${sentAt}`,
      "",
      "## Message",
      "",
      body || "_Telegram update had no text or caption._",
    ].join("\n"),
    status: "todo",
    priority: "high",
    assigneeAgentId,
    originKind: ORIGIN_KIND,
    originId: String(update.update_id),
  });
}

export async function pollTelegramInbound(ctx: PluginContext, companyId: string): Promise<PollResult> {
  const config = await getConfig(ctx);
  if (!config.tokenSecretRef) {
    throw new Error("Telegram connector requires tokenSecretRef in plugin config");
  }

  const rawOffset = await ctx.state.get(stateKey(companyId, OFFSET_STATE_KEY));
  const offset = typeof rawOffset === "number" && Number.isInteger(rawOffset) ? rawOffset : null;
  const token = await ctx.secrets.resolve(config.tokenSecretRef);
  const updates = await fetchUpdates(ctx, token, offset, config.timeoutSeconds);
  const assigneeAgentId = await resolveAssigneeAgentId(ctx, companyId, config.assigneeAgentId);

  let routed = 0;
  let skipped = 0;
  let maxUpdateId = offset === null ? null : offset - 1;

  for (const update of updates) {
    maxUpdateId = Math.max(maxUpdateId ?? update.update_id, update.update_id);
    const message = update.message ?? update.edited_message;
    if (!message) {
      skipped += 1;
      continue;
    }

    const chatId = chatIdValue(message.chat.id);
    if (config.allowedChatId && chatId !== config.allowedChatId) {
      skipped += 1;
      continue;
    }

    const processedKey = `${PROCESSED_UPDATE_PREFIX}${update.update_id}`;
    if (await ctx.state.get(stateKey(companyId, processedKey))) {
      skipped += 1;
      continue;
    }
    const existingIssues = await ctx.issues.list({
      companyId,
      originKind: ORIGIN_KIND,
      originId: String(update.update_id),
      limit: 1,
      offset: 0,
    });
    if (existingIssues.length > 0) {
      await ctx.state.set(stateKey(companyId, processedKey), {
        issueId: existingIssues[0]!.id,
        processedAt: new Date().toISOString(),
        recoveredFromExistingIssue: true,
      });
      skipped += 1;
      continue;
    }

    await ctx.state.set(stateKey(companyId, processedKey), { status: "creating", claimedAt: new Date().toISOString() });
    let issue: Issue;
    try {
      issue = await createInboundIssue(ctx, companyId, update, message, config, assigneeAgentId);
    } catch (error) {
      await ctx.state.delete(stateKey(companyId, processedKey));
      throw error;
    }
    await ctx.state.set(stateKey(companyId, processedKey), { issueId: issue.id, processedAt: new Date().toISOString() });
    await ctx.activity.log({
      companyId,
      entityType: "issue",
      entityId: issue.id,
      message: "Telegram connector routed inbound board message",
      metadata: {
        plugin: PLUGIN_ID,
        updateId: update.update_id,
        messageId: message.message_id,
        chatId,
      },
    });
    routed += 1;
  }

  const nextOffset = maxUpdateId === null ? offset : maxUpdateId + 1;
  if (nextOffset !== null && nextOffset !== offset) {
    await ctx.state.set(stateKey(companyId, OFFSET_STATE_KEY), nextOffset);
  }

  return { fetched: updates.length, routed, skipped, nextOffset };
}

const plugin = definePlugin({
  async setup(ctx) {
    const config = await getConfig(ctx);
    if (!config.tokenSecretRef) {
      throw new Error("Telegram connector requires tokenSecretRef in plugin config");
    }
    const token = await ctx.secrets.resolve(config.tokenSecretRef);
    await deleteWebhook(ctx, token);

    ctx.jobs.register(INBOUND_JOB_KEY, async (job: PluginJobContext) => {
      const companyId = await resolvePollingCompanyId(ctx, config.companyId);
      const result = await pollTelegramInbound(ctx, companyId);
      ctx.logger.info("Telegram inbound poll completed", { companyId, runId: job.runId, ...result });
    });

    ctx.data.register("health", async (params) => {
      const companyId = stringValue(asObject(params).companyId);
      const config = await getConfig(ctx);
      const nextOffset = companyId ? await ctx.state.get(stateKey(companyId, OFFSET_STATE_KEY)) : null;
      return {
        configured: Boolean(config.tokenSecretRef),
        companyId: config.companyId ?? null,
        allowedChatId: config.allowedChatId ?? null,
        projectId: config.projectId ?? null,
        assigneeAgentId: config.assigneeAgentId ?? null,
        timeoutSeconds: config.timeoutSeconds,
        nextOffset,
      };
    });
  },

  async onHealth() {
    return { status: "ok", message: "Telegram connector worker is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
