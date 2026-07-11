import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateSecretsMasterKeyEnv } from "../secrets/master-key-env-guard.js";

function evaluate(env: NodeJS.ProcessEnv, strict = false) {
  return evaluateSecretsMasterKeyEnv({
    env,
    instanceKeyFilePath: "/home/me/.paperclip/instances/default/secrets/master.key",
    instanceRoot: "/home/me/.paperclip/instances/default",
    strict,
  });
}

describe("evaluateSecretsMasterKeyEnv", () => {
  it("keeps an explicit inline master key", () => {
    expect(evaluate({
      PAPERCLIP_SECRETS_MASTER_KEY: "x".repeat(32),
      PAPERCLIP_SECRETS_MASTER_KEY_FILE: "/tmp/stale.key",
    })).toMatchObject({ action: "keep-inline" });
  });

  it("sets the instance key when no key file env is present", () => {
    expect(evaluate({})).toEqual({
      action: "set",
      resolvedPath: "/home/me/.paperclip/instances/default/secrets/master.key",
    });
  });

  it("keeps the configured instance key and alternate paths inside the instance root", () => {
    expect(evaluate({
      PAPERCLIP_SECRETS_MASTER_KEY_FILE: "/home/me/.paperclip/instances/default/secrets/master.key",
    })).toMatchObject({ action: "keep" });
    expect(evaluate({
      PAPERCLIP_SECRETS_MASTER_KEY_FILE: "/home/me/.paperclip/instances/default/secrets/alternate.key",
    })).toMatchObject({ action: "keep" });
  });

  it("overrides transient worktree/rebalance key paths outside the active instance in non-strict mode", () => {
    const stalePath = path.join(os.tmpdir(), "paperclip-worktree-rebalance-abc", ".paperclip-worktrees", "instances", "old", "secrets", "master.key");
    expect(evaluate({
      PAPERCLIP_SECRETS_MASTER_KEY_FILE: stalePath,
    })).toMatchObject({
      action: "override",
      from: path.resolve(stalePath),
      resolvedPath: "/home/me/.paperclip/instances/default/secrets/master.key",
    });
  });

  it("keeps explicit custom outside-instance key paths in strict mode", () => {
    expect(evaluate({
      PAPERCLIP_SECRETS_MASTER_KEY_FILE: "/other/instance/secrets/master.key",
    }, true)).toMatchObject({
      action: "keep",
      resolvedPath: "/other/instance/secrets/master.key",
    });
  });

  it("overrides a bare /var/folders temp key path in non-strict mode", () => {
    expect(evaluate({
      PAPERCLIP_SECRETS_MASTER_KEY_FILE: "/var/folders/ab/cd/T/paperclip-temp/secrets/master.key",
    })).toMatchObject({
      action: "override",
      from: "/var/folders/ab/cd/T/paperclip-temp/secrets/master.key",
      resolvedPath: "/home/me/.paperclip/instances/default/secrets/master.key",
    });
  });

  it("overrides a standalone .paperclip-worktrees key path in non-strict mode", () => {
    expect(evaluate({
      PAPERCLIP_SECRETS_MASTER_KEY_FILE: "/data/.paperclip-worktrees/instances/old/secrets/master.key",
    })).toMatchObject({
      action: "override",
      resolvedPath: "/home/me/.paperclip/instances/default/secrets/master.key",
    });
  });

  it("keeps a plain outside-instance-root key path as an explicit custom override", () => {
    expect(evaluate({
      PAPERCLIP_SECRETS_MASTER_KEY_FILE: "/other/instance/secrets/master.key",
    })).toMatchObject({
      action: "keep",
      resolvedPath: "/other/instance/secrets/master.key",
    });
  });

  it("keeps mounted container secret key files outside the instance root", () => {
    expect(evaluate({
      PAPERCLIP_SECRETS_MASTER_KEY_FILE: "/run/secrets/paperclip-master.key",
    }, true)).toMatchObject({
      action: "keep",
      resolvedPath: "/run/secrets/paperclip-master.key",
    });
  });

  it("refuses a transient worktree/rebalance key path in strict mode", () => {
    const stalePath = path.join(os.tmpdir(), "paperclip-worktree-rebalance-abc", ".paperclip-worktrees", "instances", "old", "secrets", "master.key");
    expect(evaluate({
      PAPERCLIP_SECRETS_MASTER_KEY_FILE: stalePath,
    }, true)).toMatchObject({
      action: "refuse",
      from: path.resolve(stalePath),
    });
  });

  it("reproduces the 2026-07-07 outage path: overrides the stale rebalance key (non-strict) and refuses it (strict)", () => {
    const outagePath =
      "/var/folders/j2/xxxx/T/paperclip-worktree-rebalance-1720000000/.paperclip-worktrees/instances/pap-884-abc/secrets/master.key";
    expect(evaluate({ PAPERCLIP_SECRETS_MASTER_KEY_FILE: outagePath })).toMatchObject({
      action: "override",
      from: outagePath,
      resolvedPath: "/home/me/.paperclip/instances/default/secrets/master.key",
    });
    expect(evaluate({ PAPERCLIP_SECRETS_MASTER_KEY_FILE: outagePath }, true)).toMatchObject({
      action: "refuse",
      from: outagePath,
    });
  });
});
