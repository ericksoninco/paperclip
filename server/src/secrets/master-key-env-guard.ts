import os from "node:os";
import path from "node:path";

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isPathInside(candidatePath: string, rootPath: string): boolean {
  const candidate = path.resolve(candidatePath);
  const root = path.resolve(rootPath);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function isLikelyTransientWorktreeKeyPath(resolvedPath: string): boolean {
  const normalized = resolvedPath.split(path.sep).join("/");
  const tmpRoot = path.resolve(os.tmpdir());
  return (
    isPathInside(resolvedPath, tmpRoot) ||
    normalized.startsWith("/tmp/") ||
    normalized.startsWith("/var/folders/") ||
    normalized.includes("/paperclip-worktree-rebalance") ||
    normalized.includes("/.paperclip-worktrees/")
  );
}

export type MasterKeyEnvDecision =
  | { action: "keep-inline"; reason: string }
  | { action: "set"; resolvedPath: string }
  | { action: "keep"; resolvedPath: string }
  | { action: "override"; resolvedPath: string; from: string; reason: string }
  | { action: "refuse"; from: string; reason: string };

export function evaluateSecretsMasterKeyEnv(input: {
  env: NodeJS.ProcessEnv;
  instanceKeyFilePath: string;
  instanceRoot: string;
  strict: boolean;
}): MasterKeyEnvDecision {
  if (nonEmpty(input.env.PAPERCLIP_SECRETS_MASTER_KEY)) {
    return {
      action: "keep-inline",
      reason: "PAPERCLIP_SECRETS_MASTER_KEY is set explicitly",
    };
  }

  const instanceKeyFilePath = path.resolve(input.instanceKeyFilePath);
  const fromEnv = nonEmpty(input.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE);
  if (!fromEnv) {
    return { action: "set", resolvedPath: instanceKeyFilePath };
  }

  const resolvedFromEnv = path.resolve(fromEnv);
  if (resolvedFromEnv === instanceKeyFilePath || isPathInside(resolvedFromEnv, input.instanceRoot)) {
    return { action: "keep", resolvedPath: resolvedFromEnv };
  }

  const reason = isLikelyTransientWorktreeKeyPath(resolvedFromEnv)
    ? "PAPERCLIP_SECRETS_MASTER_KEY_FILE points at a transient worktree/rebalance key outside the active instance root"
    : "PAPERCLIP_SECRETS_MASTER_KEY_FILE points outside the active instance root";
  if (input.strict) {
    return { action: "refuse", from: resolvedFromEnv, reason };
  }
  return {
    action: "override",
    from: resolvedFromEnv,
    resolvedPath: instanceKeyFilePath,
    reason,
  };
}
