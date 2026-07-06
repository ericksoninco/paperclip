import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  createDb,
  plugins,
  secretAccessEvents,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  createPluginSecretsHandler,
  PLUGIN_SECRET_REFS_DISABLED_MESSAGE,
} from "../services/plugin-secrets-handler.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin secrets handler integration tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

function createBindingLookupDb(rows: Array<{ companyId: string; configPath: string }>) {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
  };
}

describe("createPluginSecretsHandler", () => {
  it("fails closed for plugin secret resolution until company scoping lands", async () => {
    const handler = createPluginSecretsHandler({
      db: createBindingLookupDb([]) as never,
      pluginId: "11111111-1111-4111-8111-111111111111",
    });

    await expect(
      handler.resolve({ secretRef: "77777777-7777-4777-8777-777777777777" }),
    ).rejects.toThrow(PLUGIN_SECRET_REFS_DISABLED_MESSAGE);
  });

  it("still rejects malformed secret refs before the feature-disable guard", async () => {
    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId: "11111111-1111-4111-8111-111111111111",
    });

    await expect(
      handler.resolve({ secretRef: "not-a-uuid" }),
    ).rejects.toThrow(/invalid secret reference/i);
  });
});

describeEmbeddedPostgres("createPluginSecretsHandler integration", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("plugin-secrets-handler");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany(name = "Plugin Secrets") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  it("resolves a plugin secret through the real host secrets service when a binding exists", async () => {
    const companyId = await seedCompany();
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: `paperclip.test.${pluginId}`,
      packageName: "@paperclipai/plugin-test",
      version: "1.0.0",
      apiVersion: 1,
      manifestJson: {
        id: "paperclip.test",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Plugin Test",
        capabilities: ["secrets.read-ref"],
        entrypoints: { worker: "./worker.js" },
      },
      status: "ready",
      installedAt: new Date(),
      updatedAt: new Date(),
    });
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `plugin-token-${randomUUID()}`,
      provider: "local_encrypted",
      value: "telegram-token-value",
    });
    await svc.createBinding({
      companyId,
      secretId: secret.id,
      targetType: "plugin",
      targetId: pluginId,
      configPath: "tokenSecretRef",
    });

    const handler = createPluginSecretsHandler({ db, pluginId });

    await expect(handler.resolve({ secretRef: secret.id })).resolves.toBe("telegram-token-value");
    const events = await db
      .select()
      .from(secretAccessEvents)
      .where(eq(secretAccessEvents.secretId, secret.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      companyId,
      secretId: secret.id,
      consumerType: "plugin",
      consumerId: pluginId,
      configPath: "tokenSecretRef",
      pluginId,
      outcome: "success",
    });
    expect(JSON.stringify(events)).not.toContain("telegram-token-value");
  });

  it("fails closed when no plugin binding exists for the secret ref", async () => {
    const companyId = await seedCompany();
    const pluginId = randomUUID();
    const secret = await secretService(db).create(companyId, {
      name: `unbound-plugin-token-${randomUUID()}`,
      provider: "local_encrypted",
      value: "should-not-resolve",
    });
    const handler = createPluginSecretsHandler({ db, pluginId });

    await expect(handler.resolve({ secretRef: secret.id })).rejects.toThrow(
      PLUGIN_SECRET_REFS_DISABLED_MESSAGE,
    );
  });
});
