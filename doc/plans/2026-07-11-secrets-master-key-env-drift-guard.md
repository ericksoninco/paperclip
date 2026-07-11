# Spec: Prevent secrets master-key env drift from worktree rebalancing

- **Issue:** EDD-1575 (parent EDD-1571)
- **Author:** Architect
- **Date:** 2026-07-11
- **Status:** Ready for Engineer

## Problem

The 2026-07-07 Telegram inbound outage was a **wrong secrets master key**. Connector
activation failed with AES-GCM `Unsupported state or unable to authenticate data` — the
process resolved secrets with a key that did not encrypt them.

The company secret `TELEGRAM_BOT_TOKEN` was encrypted (2026-05-29) with the instance key
`~/.paperclip/instances/default/secrets/master.key`. But a long-lived process carried
`PAPERCLIP_SECRETS_MASTER_KEY_FILE=/var/folders/.../paperclip-worktree-rebalance-*/.paperclip-worktrees/instances/pap-884-.../secrets/master.key`
— a **stale temp worktree key** that does not decrypt the token.

## Root-cause chain (verified in code)

1. `server/src/secrets/local-encrypted-provider.ts::resolveMasterKeyFilePath()` trusts
   `PAPERCLIP_SECRETS_MASTER_KEY_FILE` unconditionally, with no instance-root check.
2. `server/src/index.ts` (startServer, ~L112-120) only fills the secrets env vars **when
   undefined**. An inherited stale value therefore wins over the config-derived, instance-
   scoped path (`config.secretsMasterKeyFilePath`, set correctly in `config.ts:317-322`).
3. `loadOrCreateMasterKey()` **silently generates a brand-new key** if the resolved path is
   missing — on the *decrypt* path too. A stale/absent path thus mints a random key that can
   never decrypt existing ciphertext, producing the opaque GCM error later.
4. No boot guard verifies the key path is inside the active instance root; no self-check
   verifies the resolved key actually decrypts an existing secret. The failure surfaces late,
   per-plugin, as an unactionable crypto error.

Note: `worktree-config.ts` already scopes `secrets.localEncrypted.keyFilePath` to the
instance root and validates it with `isPathInside` (L313). The gap is the **inherited env
var**, which bypasses that config value entirely.

## Design — three layers of defense

### A. Boot env-drift guard + self-heal (Asks 1 & 2)

New testable pure module `server/src/secrets/master-key-env-guard.ts`:

```ts
type MasterKeyEnvDecision =
  | { action: "keep-inline"; reason: string }        // PAPERCLIP_SECRETS_MASTER_KEY set inline
  | { action: "set"; resolvedPath: string }          // env file undefined -> use instance key
  | { action: "keep"; resolvedPath: string }          // env file already the instance key
  | { action: "override"; resolvedPath: string; from: string; reason: string }
  | { action: "refuse"; from: string; reason: string };

export function evaluateSecretsMasterKeyEnv(input: {
  env: NodeJS.ProcessEnv;
  instanceKeyFilePath: string;   // config.secretsMasterKeyFilePath (already instance-scoped)
  instanceRoot: string;          // resolvePaperclipInstanceRoot() from @paperclipai/shared
  strict: boolean;               // config.secretsStrictMode
}): MasterKeyEnvDecision;
```

Rules:
- If `PAPERCLIP_SECRETS_MASTER_KEY` (inline key) is non-empty → `keep-inline` (explicit
  operator choice; do not touch).
- Else read `PAPERCLIP_SECRETS_MASTER_KEY_FILE`:
  - undefined/empty → `set` to `instanceKeyFilePath`.
  - equals `instanceKeyFilePath` (resolved) → `keep`.
  - resolves **inside** `instanceRoot` → `keep` (legit alternate instance-local path).
  - otherwise (outside instance root, **or** matches a temp/rebalance heuristic: under
    `os.tmpdir()` / `/var/folders` / `/tmp`, or path contains `paperclip-worktree-rebalance`
    or `.paperclip-worktrees`) → `refuse` when `strict`, else `override` to
    `instanceKeyFilePath`.

Wire into `startServer` at the existing secrets-env normalization block:
- `override` → `logger.warn` a loud, single-line message and set the env var to the instance
  key; include both paths and a fingerprint hint.
- `refuse` → `logger.error` and `throw` (fail fast; do not boot with a poisoned key path).
- Use `isPathInside` (mirror `worktree-config.ts:88`) and
  `resolvePaperclipInstanceRoot` from `@paperclipai/shared`.

### B. Provider hardening — never auto-create on decrypt (defense in depth)

In `local-encrypted-provider.ts`, split `loadOrCreateMasterKey()`:
- `loadMasterKeyForWrite()` — may create (used by `prepareManagedVersion`).
- `loadMasterKeyForRead()` — **must not create**; if the key file is missing, throw a clear
  error (`Secrets master key file not found at <path>; refusing to mint a new key on the
  decrypt path`). Used by `resolveVersion`.

This removes the silent-new-key catastrophe when a stale path is resolved.

### C. Boot secrets self-check (Ask 3)

Add `secretService(db).selfCheckLocalEncrypted()`:
- Only when active provider is `local_encrypted`.
- Find one `local_encrypted_v1` active secret version (any company); attempt
  `provider.resolveVersion` on it.
- On GCM/auth failure → return
  `{ status: "error", message: "SECRETS KEY MISMATCH: configured master key cannot decrypt
  existing secrets (key fingerprint <hex12>). Connectors will fail until the correct key is
  restored." }`.
- No local secrets present, or provider not local → `{ status: "ok"/"skipped" }`.

Call after DB init/migrations in `startServer`:
- Log loudly; **strict mode** → refuse boot; otherwise continue but mark unhealthy.
- Surface in the existing secrets health aggregation (`provider-registry.ts` health path /
  status endpoint) so operators see it immediately rather than as per-plugin resolve errors.

## Testing (Engineer unit + QA integration)

- Unit `master-key-env-guard.test.ts` truth table: inside-root, temp `/var/folders` path,
  `paperclip-worktree-rebalance` path, `.paperclip-worktrees` path, undefined, inline key,
  equals-instance-key; strict vs non-strict → correct action.
- Unit provider: read path **throws** (does not create) when key file missing; write path
  still creates.
- Integration: boot with a deliberately wrong `PAPERCLIP_SECRETS_MASTER_KEY_FILE`
  → override + warn (non-strict) / refuse (strict); self-check reports error against a seeded
  local_encrypted secret.

## Files touched

- `server/src/secrets/master-key-env-guard.ts` (new) + test
- `server/src/index.ts` (wire guard + self-check into startServer)
- `server/src/secrets/local-encrypted-provider.ts` (split load fns)
- `server/src/services/secrets.ts` (add `selfCheckLocalEncrypted`)
- health/status surface as needed (`provider-registry.ts` / status route)

## Out of scope

- The external `paperclip-worktree-rebalance` temp tooling itself (lives outside this repo).
  This spec makes the **server resilient** to whatever env it inherits; that is the durable
  fix regardless of what set the stale var.
