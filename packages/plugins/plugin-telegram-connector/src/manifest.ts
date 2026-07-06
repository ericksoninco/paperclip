import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { INBOUND_JOB_KEY, PLUGIN_ID, PLUGIN_VERSION } from "./constants.js";
import {
  TELEGRAM_LONG_POLL_TIMEOUT_SECONDS_DEFAULT,
  TELEGRAM_LONG_POLL_TIMEOUT_SECONDS_MAX,
} from "./polling-config.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Telegram Bot Connector",
  description:
    "Routes inbound Telegram board messages into Paperclip using a single getUpdates cursor owner.",
  author: "Paperclip",
  categories: ["connector", "automation"],
  capabilities: [
    "companies.read",
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "issues.read",
    "issues.create",
    "agents.read",
    "activity.log.write",
    "jobs.schedule",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      tokenSecretRef: {
        type: "string",
        format: "secret-ref",
        title: "Telegram bot token secret reference",
        description: "Secret reference containing the bot token. Store only the reference, never the token value.",
      },
      companyId: {
        type: "string",
        title: "Paperclip company ID",
        description:
          "Company that owns the Telegram getUpdates cursor. Required when the Paperclip instance has more than one company.",
      },
      allowedChatId: {
        type: "string",
        title: "Allowed Telegram chat ID",
        description: "Optional Telegram chat ID allowlist. Messages from other chats are acknowledged but not routed.",
      },
      assigneeAgentId: {
        type: "string",
        title: "Inbound issue assignee agent ID",
        description: "Optional Paperclip agent ID to receive inbound Telegram issues. Defaults to the first active CEO agent.",
      },
      projectId: {
        type: "string",
        title: "Inbound issue project ID",
        description: "Optional Paperclip project ID for inbound Telegram issues.",
      },
      timeoutSeconds: {
        type: "number",
        title: "Long-poll timeout seconds",
        default: TELEGRAM_LONG_POLL_TIMEOUT_SECONDS_DEFAULT,
        minimum: 0,
        maximum: TELEGRAM_LONG_POLL_TIMEOUT_SECONDS_MAX,
      },
    },
    required: ["tokenSecretRef"],
  },
  jobs: [
    {
      jobKey: INBOUND_JOB_KEY,
      displayName: "Telegram inbound router",
      description: "Owns the Telegram getUpdates cursor and routes board messages into Paperclip.",
      schedule: "* * * * *",
    },
  ],
};

export default manifest;
