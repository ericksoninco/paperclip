import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkSecretProviders, listSecretProviders } from "../secrets/provider-registry.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";

describe("secret provider registry", () => {
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const previousMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  const tmpDirs: string[] = [];

  afterEach(() => {
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    if (previousMasterKey === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY = previousMasterKey;
    }
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("describes managed and external-reference provider capabilities", () => {
    const descriptors = listSecretProviders();

    expect(descriptors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "local_encrypted",
          supportsManagedValues: true,
          supportsExternalReferences: false,
          configured: true,
        }),
        expect.objectContaining({
          id: "aws_secrets_manager",
          supportsManagedValues: true,
          supportsExternalReferences: true,
          configured: false,
        }),
      ]),
    );
  });

  it("warns when the local encrypted key file is readable by group or others", async () => {
    const dir = path.join(os.tmpdir(), `paperclip-secret-provider-${randomBytes(6).toString("hex")}`);
    tmpDirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const keyFile = path.join(dir, "master.key");
    writeFileSync(keyFile, randomBytes(32).toString("base64"), { encoding: "utf8", mode: 0o644 });
    chmodSync(keyFile, 0o644);
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = keyFile;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;

    const checks = await checkSecretProviders();
    const local = checks.find((check) => check.provider === "local_encrypted");

    expect(local).toMatchObject({
      status: "warn",
      details: { keyFilePath: keyFile },
    });
    expect(local?.warnings?.join("\n")).toContain("chmod 600");
    expect(local?.backupGuidance?.join("\n")).toContain("database");
  });

  it("does not create a missing master key file while resolving existing encrypted material", async () => {
    const dir = path.join(os.tmpdir(), `paperclip-secret-provider-${randomBytes(6).toString("hex")}`);
    tmpDirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const keyFile = path.join(dir, "missing-master.key");
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = keyFile;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;

    await expect(localEncryptedProvider.resolveVersion({
      material: {
        scheme: "local_encrypted_v1",
        iv: randomBytes(12).toString("base64"),
        tag: randomBytes(16).toString("base64"),
        ciphertext: randomBytes(16).toString("base64"),
      },
      externalRef: null,
    })).rejects.toThrow(/refusing to mint a new key on the decrypt path/i);
    expect(existsSync(keyFile)).toBe(false);
  });

  it("still creates the master key file when writing a new managed secret", async () => {
    const dir = path.join(os.tmpdir(), `paperclip-secret-provider-${randomBytes(6).toString("hex")}`);
    tmpDirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const keyFile = path.join(dir, "master.key");
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = keyFile;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;

    await localEncryptedProvider.createSecret({ value: "new-secret-value" });

    expect(existsSync(keyFile)).toBe(true);
  });
});
