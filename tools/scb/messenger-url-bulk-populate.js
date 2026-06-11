#!/usr/bin/env node

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REGISTRY_FILE = path.join(
  "data",
  "scb",
  "supplier-registry.json",
);

const DEFAULT_MANIFEST_FILE = path.join(
  "data",
  "scb",
  "supplier-cohort-manifest.json",
);

function usage() {
  console.log(`Usage:
  node tools/scb/messenger-url-bulk-populate.js --from-registry [--issues EDD-191,EDD-192] [--report-missing]
  node tools/scb/messenger-url-bulk-populate.js --populate-issues --cohort PIPE-105 [--write]
  node tools/scb/messenger-url-bulk-populate.js --update-registry --dump-file dump.json [--report-missing]
  node tools/scb/messenger-url-bulk-populate.js --update-registry --from-comment comment-body.txt

Options:
  --registry-file <path>  Registry JSON path (default: ${DEFAULT_REGISTRY_FILE})
  --manifest-file <path>  Supplier cohort manifest path (default: ${DEFAULT_MANIFEST_FILE})
  --from-registry         Read messenger_url records from the registry
  --populate-issues       Populate target issue body messenger_url fields from registry reuse
  --update-registry       Merge a validated operator dump into the registry
  --report-missing        Print supplier_codes without a messenger_url
  --dump-file <path>      Read operator dump JSON from a file
  --from-comment <path>   Alias for --dump-file; extracts the first JSON dump from a comment body
  --stdin                 Read operator dump JSON/comment text from stdin
  --issues <csv>          Target issue identifiers; defaults to all registry entries
  --cohort <name>         Restrict targets by cohort, e.g. PIPE-100
  --verify-issues         Fetch live Paperclip issues and compare body messenger_url hashes
  --with-plaintext        Local-only opt-in: include plaintext messenger_url in registry output
  --dry-run               Validate and print actions without writing issue bodies (default)
  --write                 Rewrite the registry file when used with --update-registry
  --help                  Show this help
`);
}

function parseArgs(argv) {
  const args = {
    registryFile: DEFAULT_REGISTRY_FILE,
    manifestFile: DEFAULT_MANIFEST_FILE,
    dryRun: true,
    write: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--from-registry") args.fromRegistry = true;
    else if (arg === "--populate-issues") args.populateIssues = true;
    else if (arg === "--update-registry") args.updateRegistry = true;
    else if (arg === "--report-missing") args.reportMissing = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--write") args.write = true;
    else if (arg === "--stdin") args.stdin = true;
    else if (arg === "--verify-issues") args.verifyIssues = true;
    else if (arg === "--with-plaintext") args.withPlaintext = true;
    else if (arg === "--registry-file") args.registryFile = requireValue(argv, ++i, arg);
    else if (arg === "--manifest-file") args.manifestFile = requireValue(argv, ++i, arg);
    else if (arg === "--dump-file") args.dumpFile = requireValue(argv, ++i, arg);
    else if (arg === "--from-comment") {
      args.dumpFile = requireValue(argv, ++i, arg);
      args.fromComment = true;
    } else if (arg === "--issues") args.issues = splitCsv(requireValue(argv, ++i, arg));
    else if (arg === "--cohort") args.cohort = requireValue(argv, ++i, arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function requireValue(argv, index, flag) {
  if (index >= argv.length || argv[index].startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return argv[index];
}

function splitCsv(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function isGitIgnoredPath(file, cwd = process.cwd()) {
  try {
    execFileSync("git", ["check-ignore", "--quiet", "--", file], {
      cwd,
      stdio: "ignore",
    });
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    return false;
  }
}

function assertPlaintextRegistryWriteAllowed(args, deps = {}) {
  if (!args.withPlaintext || !args.write) return;
  const isIgnored = deps.isGitIgnoredPath || isGitIgnoredPath;
  if (!isIgnored(args.registryFile)) {
    throw new Error(
      "--with-plaintext --write requires --registry-file to point to a gitignored local-only path; " +
        `${args.registryFile} is trackable`,
    );
  }
}

function loadSupplierManifest(file) {
  if (!fs.existsSync(file)) return [];
  const manifest = readJsonFile(file);
  const suppliers = Array.isArray(manifest) ? manifest : manifest.suppliers;
  if (!Array.isArray(suppliers)) {
    throw new Error("Supplier manifest must be an array or contain suppliers[]");
  }
  const seenCodes = new Set();
  return suppliers.map((supplier) => {
    if (!supplier.issue) throw new Error("Manifest supplier missing issue");
    if (!supplier.supplier_code) throw new Error("Manifest supplier missing supplier_code");
    if (seenCodes.has(supplier.supplier_code)) {
      throw new Error(`Duplicate supplier_code in manifest: ${supplier.supplier_code}`);
    }
    seenCodes.add(supplier.supplier_code);
    const stable_identity_key = supplierIdentityKey(supplier);
    return stable_identity_key ? { ...supplier, stable_identity_key } : { ...supplier };
  });
}

function loadRegistry(file) {
  if (!fs.existsSync(file)) {
    return {
      schema_version: 1,
      generated_by: "tools/scb/messenger-url-bulk-populate.js",
      suppliers: [],
    };
  }
  const registry = readJsonFile(file);
  validateRegistry(registry);
  return registry;
}

function validateRegistry(registry) {
  if (registry.schema_version !== 1) {
    throw new Error(`Unsupported registry schema_version: ${registry.schema_version}`);
  }
  if (!Array.isArray(registry.suppliers)) {
    throw new Error("Registry must contain a suppliers array");
  }
  const seenCodes = new Set();
  const seenHashes = new Map();
  const seenCapturedIdentities = new Map();
  for (const supplier of registry.suppliers) {
    if (!supplier.supplier_code) throw new Error("Registry supplier missing supplier_code");
    if (seenCodes.has(supplier.supplier_code)) {
      throw new Error(`Duplicate supplier_code in registry: ${supplier.supplier_code}`);
    }
    seenCodes.add(supplier.supplier_code);
    const stableIdentityKey = supplierIdentityKey(supplier);
    if (supplier.stable_identity_key && stableIdentityKey && supplier.stable_identity_key !== stableIdentityKey) {
      throw new Error(
        `Registry stable_identity_key drift for ${supplier.supplier_code}: ` +
          `${supplier.stable_identity_key} != ${stableIdentityKey}`,
      );
    }
    if (supplier.messenger_url) {
      validateMessengerUrl(supplier.messenger_url);
      const actual = sha256(supplier.messenger_url);
      if (supplier.messenger_url_sha256 !== actual) {
        throw new Error(
          `Registry sha256 drift for ${supplier.supplier_code}: ` +
            `${supplier.messenger_url_sha256} != ${actual}`,
        );
      }
    }
    if (supplier.messenger_url_sha256) {
      const existingCode = seenHashes.get(supplier.messenger_url_sha256);
      if (existingCode && existingCode !== supplier.supplier_code) {
        throw new Error(
          `Duplicate messenger_url hash ${supplier.messenger_url_sha256} for ${existingCode} and ` +
            supplier.supplier_code,
        );
      }
      seenHashes.set(supplier.messenger_url_sha256, supplier.supplier_code);
    }
    if (stableIdentityKey && supplier.messenger_url_sha256) {
      const existingCode = seenCapturedIdentities.get(stableIdentityKey);
      if (existingCode && existingCode !== supplier.supplier_code) {
        throw new Error(
          `Duplicate captured stable identity ${stableIdentityKey} for ${existingCode} and ` +
            supplier.supplier_code,
        );
      }
      seenCapturedIdentities.set(stableIdentityKey, supplier.supplier_code);
    }
  }
}

function validateMessengerUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`Invalid messenger_url: ${value}`);
  }
  const validPath =
    url.hostname === "message.alibaba.com" &&
    (url.pathname === "/message/messenger.htm" || url.pathname === "/messenger.htm");
  if (!validPath) throw new Error(`Unsupported messenger_url host/path: ${value}`);
  for (const param of ["activeAccountId", "activeAccountIdEncrypt", "chatToken"]) {
    if (!url.searchParams.get(param)) {
      throw new Error(`messenger_url missing ${param}: ${value}`);
    }
  }
  return url;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeStorefrontHost(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch (error) {
    return raw
      .replace(/^https?:\/\//i, "")
      .split("/")[0]
      .toLowerCase()
      .replace(/^www\./, "")
      .trim() || null;
  }
}

function supplierIdentityKey(supplier) {
  const aliId = String(supplier.ali_id || "").trim();
  if (aliId) return `ali_id:${aliId}`;
  const host = normalizeStorefrontHost(supplier.storefront_url_hint);
  return host ? `storefront_host:${host}` : null;
}

function applyStableIdentity(supplier) {
  const stable_identity_key = supplierIdentityKey(supplier);
  if (!stable_identity_key) {
    const { stable_identity_key: _ignored, ...withoutIdentity } = supplier;
    return withoutIdentity;
  }
  return { ...supplier, stable_identity_key };
}

function readDump(args) {
  if (args.stdin) return extractDumpFromText(fs.readFileSync(0, "utf8"));
  if (args.dumpFile) return extractDumpFromText(fs.readFileSync(args.dumpFile, "utf8"));
  throw new Error("--update-registry requires --dump-file, --from-comment, or --stdin");
}

function extractDumpFromText(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const fencedBlocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) =>
    m[1].trim(),
  );
  for (const candidate of fencedBlocks) {
    if (candidate.startsWith("{")) return JSON.parse(candidate);
  }
  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    return JSON.parse(text.slice(objectStart, objectEnd + 1));
  }
  throw new Error("Could not find a JSON operator dump");
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(co|ltd|limited|factory|company|products|product)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j];
  }
  return prev[b.length];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a.includes(b) || b.includes(a)) return 1;
  const max = Math.max(a.length, b.length);
  return max === 0 ? 0 : 1 - levenshtein(a, b) / max;
}

function matchConversationToSupplier(conversation, suppliers) {
  const name = normalize(conversation.displayed_supplier_name);
  const storefront = normalize(
    String(conversation.storefront_url_hint || "").replace(/^https?:\/\//, ""),
  );
  let best = null;
  for (const supplier of suppliers) {
    const candidates = [
      supplier.displayed_supplier_name_expected,
      supplier.display_name,
      supplier.storefront_url_hint,
    ].map(normalize);
    const score = Math.max(
      ...candidates.map((candidate) => Math.max(similarity(name, candidate), similarity(storefront, candidate))),
    );
    if (!best || score > best.score) best = { supplier, score };
  }
  if (!best || best.score < 0.82) {
    throw new Error(
      `Could not match dump row to supplier: ${conversation.displayed_supplier_name || conversation.supplier_name_hint}`,
    );
  }
  return best.supplier;
}

function supplierUniverseRows(registry, args) {
  const manifestRows = loadSupplierManifest(args.manifestFile);
  const byCode = new Map(registry.suppliers.map((supplier) => [supplier.supplier_code, supplier]));
  const rows = manifestRows.map((row) => applyStableIdentity({ ...row, ...byCode.get(row.supplier_code) }));
  for (const supplier of registry.suppliers) {
    if (!byCode.has(supplier.supplier_code)) continue;
    if (!rows.some((row) => row.supplier_code === supplier.supplier_code)) {
      rows.push(applyStableIdentity(supplier));
    }
  }
  return rows;
}

function capturedSupplierIdentityIndex(suppliers) {
  const index = new Map();
  for (const supplier of suppliers) {
    if (!supplier.messenger_url_sha256) continue;
    const stableIdentityKey = supplierIdentityKey(supplier);
    if (!stableIdentityKey) continue;
    const existing = index.get(stableIdentityKey);
    if (existing && existing.supplier_code !== supplier.supplier_code) {
      throw new Error(
        `Duplicate captured stable identity ${stableIdentityKey} for ${existing.supplier_code} and ` +
          supplier.supplier_code,
      );
    }
    index.set(stableIdentityKey, supplier);
  }
  return index;
}

function findReusableSupplierForTarget(target, registrySuppliers) {
  if (target.messenger_url_sha256) return target;
  const stableIdentityKey = supplierIdentityKey(target);
  if (!stableIdentityKey) return null;
  return capturedSupplierIdentityIndex(registrySuppliers).get(stableIdentityKey) || null;
}

function mergeDumpIntoRegistry(registry, dump, args) {
  if (!Array.isArray(dump.conversations)) {
    throw new Error("Operator dump must contain conversations[]");
  }
  const rows = supplierUniverseRows(registry, args);
  const byCode = new Map(registry.suppliers.map((supplier) => [supplier.supplier_code, supplier]));
  const updated = [];
  for (const conversation of dump.conversations) {
    if (!conversation.messenger_url) continue;
    validateMessengerUrl(conversation.messenger_url);
    let matched;
    try {
      matched = matchConversationToSupplier(conversation, rows);
    } catch (error) {
      console.error(`warning: ${error.message}; skipping dump row`);
      continue;
    }
    const matchedWithConversationIdentity = applyStableIdentity({
      ...matched,
      ali_id: conversation.ali_id || matched.ali_id || null,
      storefront_url_hint: conversation.storefront_url_hint || matched.storefront_url_hint || null,
    });
    const reusable = findReusableSupplierForTarget(matchedWithConversationIdentity, registry.suppliers);
    const existing = reusable || byCode.get(matched.supplier_code) || matchedWithConversationIdentity;
    if (
      existing.operator_account_hint &&
      dump.operator_account_hint &&
      existing.operator_account_hint !== dump.operator_account_hint
    ) {
      throw new Error(
        `operator_account_hint mismatch for ${matched.supplier_code}: ` +
          `${existing.operator_account_hint} != ${dump.operator_account_hint}`,
      );
    }
    const next = {
      ...existing,
      supplier_code: existing.supplier_code || matched.supplier_code,
      issue: existing.issue || matched.issue,
      cohort: existing.cohort || matched.cohort,
      displayed_supplier_name_expected:
        matched.displayed_supplier_name_expected || conversation.displayed_supplier_name,
      display_name:
        matched.display_name || conversation.displayed_supplier_name || matched.displayed_supplier_name_expected,
      supplier_name_hint: conversation.supplier_name_hint || existing.supplier_name_hint || null,
      storefront_url_hint: conversation.storefront_url_hint || existing.storefront_url_hint || null,
      ali_id: conversation.ali_id || existing.ali_id || null,
      messenger_url_sha256: sha256(conversation.messenger_url),
      operator_account_hint: dump.operator_account_hint || existing.operator_account_hint || null,
      source: {
        issue: dump.source_issue || existing.source?.issue || "EDD-287",
        comment_id: dump.source_comment_id || existing.source?.comment_id || null,
        captured_at_iso: dump.captured_at_iso || existing.source?.captured_at_iso || null,
      },
      status: "captured",
    };
    Object.assign(next, applyStableIdentity(next));
    if (args.withPlaintext) next.messenger_url = conversation.messenger_url;
    else delete next.messenger_url;
    byCode.set(next.supplier_code, next);
    updated.push(next.supplier_code);
  }
  for (const row of supplierUniverseRows(registry, args)) {
    if (!byCode.has(row.supplier_code)) {
      byCode.set(row.supplier_code, applyStableIdentity({
        ...row,
        display_name: row.displayed_supplier_name_expected,
        messenger_url_sha256: null,
        operator_account_hint: dump.operator_account_hint || null,
        status: "missing_thread",
      }));
    }
  }
  registry.updated_at_iso = new Date().toISOString();
  registry.suppliers = [...byCode.values()]
    .map((supplier) => {
      if (args.withPlaintext) return supplier;
      const { messenger_url, ...redactedSupplier } = supplier;
      return redactedSupplier;
    })
    .sort((a, b) => a.supplier_code.localeCompare(b.supplier_code));
  validateRegistry(registry);
  return updated;
}

function selectTargets(registry, args) {
  let suppliers = supplierUniverseRows(registry, args);
  if (args.cohort) suppliers = suppliers.filter((supplier) => supplier.cohort === args.cohort);
  if (args.issues) {
    const issueSet = new Set(args.issues);
    suppliers = suppliers.filter((supplier) => issueSet.has(supplier.issue));
  }
  return suppliers;
}

function collectMissingSupplierCodes(suppliers, registrySuppliers = suppliers) {
  const capturedByIdentity = capturedSupplierIdentityIndex(registrySuppliers);
  return suppliers
    .filter((supplier) => {
      if (supplier.messenger_url_sha256) return false;
      const stableIdentityKey = supplierIdentityKey(supplier);
      return !stableIdentityKey || !capturedByIdentity.has(stableIdentityKey);
    })
    .map((supplier) => supplier.supplier_code);
}

function reportMissing(suppliers, registrySuppliers = suppliers) {
  const missing = suppliers
    ? collectMissingSupplierCodes(suppliers, registrySuppliers)
    : [];
  if (missing.length === 0) {
    console.log("coverage_ok: no missing supplier_codes");
    return;
  }
  console.log("coverage_warning:");
  console.log(`  missing_supplier_codes: [${missing.join(", ")}]`);
}

function extractIssueMessengerUrl(description) {
  const match = String(description || "").match(/messenger_url:\s*(https?:\/\/[^\s"'`]+)/);
  return match ? match[1].trim() : null;
}

async function paperclipJson(pathname, options = {}) {
  const baseUrl = process.env.PAPERCLIP_API_URL;
  const apiKey = process.env.PAPERCLIP_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("Paperclip API access requires PAPERCLIP_API_URL and PAPERCLIP_API_KEY");
  }
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    ...(options.headers || {}),
  };
  if (options.method && options.method !== "GET") {
    const runId = process.env.PAPERCLIP_RUN_ID;
    if (!runId) throw new Error(`${options.method} ${pathname} requires PAPERCLIP_RUN_ID`);
    headers["X-Paperclip-Run-Id"] = runId;
  }
  const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers });
  if (!response.ok) {
    throw new Error(`Paperclip API ${pathname} failed: ${response.status}`);
  }
  return response.json();
}

async function fetchIssueByIdentifier(identifier) {
  const companyId = process.env.PAPERCLIP_COMPANY_ID;
  if (!companyId) throw new Error("--verify-issues requires PAPERCLIP_COMPANY_ID");
  const search = await paperclipJson(
    `/api/companies/${companyId}/issues?q=${encodeURIComponent(identifier)}`,
  );
  const issues = Array.isArray(search) ? search : search.issues || search.items || [];
  const issue = issues.find((item) => item.identifier === identifier);
  if (!issue) throw new Error(`Issue not found: ${identifier}`);
  const detail = await paperclipJson(`/api/issues/${issue.id}`);
  return detail.issue || detail;
}

async function fetchIssueComment(issueId, commentId) {
  const detail = await paperclipJson(`/api/issues/${issueId}/comments/${commentId}`);
  return detail.comment || detail;
}

function commentBody(comment) {
  return comment.body || comment.content || comment.text || "";
}

async function verifyIssueBodyHashes(suppliers) {
  for (const supplier of suppliers) {
    if (!supplier.messenger_url_sha256) continue;
    const issue = await fetchIssueByIdentifier(supplier.issue);
    const bodyUrl = extractIssueMessengerUrl(issue.description);
    if (!bodyUrl) {
      throw new Error(`${supplier.issue} has no messenger_url in issue body`);
    }
    validateMessengerUrl(bodyUrl);
    const bodyHash = sha256(bodyUrl);
    if (bodyHash !== supplier.messenger_url_sha256) {
      throw new Error(
        `${supplier.issue} ${supplier.supplier_code} issue body sha256 drift: ` +
          `${bodyHash} != ${supplier.messenger_url_sha256}`,
      );
    }
    console.log(
      `${supplier.issue} ${supplier.supplier_code} issue_body_sha256=${bodyHash.slice(0, 8)}`,
    );
  }
}

async function resolveSupplierMessengerUrl(supplier, deps = {}) {
  const fetchIssue = deps.fetchIssueByIdentifier || fetchIssueByIdentifier;
  const fetchComment = deps.fetchIssueComment || fetchIssueComment;
  const sourceIssueIdentifier = supplier.source?.issue || supplier.issue;
  if (!sourceIssueIdentifier) {
    throw new Error(`${supplier.supplier_code} has no source issue for messenger_url resolution`);
  }
  const sourceIssue = await fetchIssue(sourceIssueIdentifier);
  let sourceText = sourceIssue.description || "";
  if (supplier.source?.comment_id) {
    const sourceComment = await fetchComment(sourceIssue.id, supplier.source.comment_id);
    sourceText = commentBody(sourceComment);
  }
  const messengerUrl = extractIssueMessengerUrl(sourceText);
  if (!messengerUrl) {
    throw new Error(`${supplier.supplier_code} source ${sourceIssueIdentifier} has no messenger_url`);
  }
  validateMessengerUrl(messengerUrl);
  const resolvedHash = sha256(messengerUrl);
  if (resolvedHash !== supplier.messenger_url_sha256) {
    throw new Error(
      `${supplier.supplier_code} source sha256 drift: ${resolvedHash} != ${supplier.messenger_url_sha256}`,
    );
  }
  return messengerUrl;
}

function populateIssueDescription(description, messengerUrl) {
  const body = String(description || "");
  const linePattern = /^([ \t]*messenger_url:[ \t]*)(.*)$/m;
  if (linePattern.test(body)) {
    return body.replace(linePattern, (_line, prefix) => `${prefix.trimEnd()} ${messengerUrl}`);
  }
  const separator = body.endsWith("\n") || body.length === 0 ? "" : "\n";
  return `${body}${separator}\nmessenger_url: ${messengerUrl}\n`;
}

async function patchIssueDescription(issueId, description) {
  const payload = JSON.stringify({ description });
  const detail = await paperclipJson(`/api/issues/${issueId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: payload,
  });
  return detail.issue || detail;
}

async function populateIssuesFromRegistry(registry, args, deps = {}) {
  const targets = selectTargets(registry, args);
  const fetchIssue = deps.fetchIssueByIdentifier || fetchIssueByIdentifier;
  const patchDescription = deps.patchIssueDescription || patchIssueDescription;
  const reusableByCode = new Map();
  for (const target of targets) {
    const reusable = findReusableSupplierForTarget(target, registry.suppliers);
    if (!reusable) continue;
    reusableByCode.set(target.supplier_code, reusable);
  }

  for (const target of targets) {
    const reusable = reusableByCode.get(target.supplier_code);
    if (!reusable) {
      console.log(`${target.issue} ${target.supplier_code} populate_missing_reusable_source`);
      continue;
    }
    const messengerUrl = await resolveSupplierMessengerUrl(reusable, deps);
    const targetIssue = await fetchIssue(target.issue);
    const existingUrl = extractIssueMessengerUrl(targetIssue.description);
    if (existingUrl) {
      validateMessengerUrl(existingUrl);
      const existingHash = sha256(existingUrl);
      if (existingHash !== reusable.messenger_url_sha256) {
        throw new Error(
          `${target.issue} ${target.supplier_code} existing issue body sha256 drift: ` +
            `${existingHash} != ${reusable.messenger_url_sha256}`,
        );
      }
      console.log(
        `${target.issue} ${target.supplier_code} already_populated sha256=${existingHash.slice(0, 8)}`,
      );
      continue;
    }
    const nextDescription = populateIssueDescription(targetIssue.description, messengerUrl);
    if (args.write) {
      await patchDescription(targetIssue.id, nextDescription);
      console.log(
        `${target.issue} ${target.supplier_code} populated sha256=${reusable.messenger_url_sha256.slice(0, 8)} ` +
          `source=${reusable.source?.issue || reusable.issue}`,
      );
    } else {
      console.log(
        `${target.issue} ${target.supplier_code} dry_run_populate ` +
          `sha256=${reusable.messenger_url_sha256.slice(0, 8)} source=${reusable.source?.issue || reusable.issue}`,
      );
    }
  }
}

async function printRegistryActions(registry, args) {
  const suppliers = selectTargets(registry, args);
  for (const supplier of suppliers) {
    if (!supplier.messenger_url_sha256) continue;
    if (supplier.messenger_url) {
      validateMessengerUrl(supplier.messenger_url);
      const hash = sha256(supplier.messenger_url);
      if (hash !== supplier.messenger_url_sha256) {
        throw new Error(`sha256 drift for ${supplier.supplier_code}`);
      }
    }
    console.log(
      `${supplier.issue} ${supplier.supplier_code} ` +
        `sha256=${supplier.messenger_url_sha256.slice(0, 8)} source=registry`,
    );
  }
  if (args.verifyIssues) await verifyIssueBodyHashes(suppliers);
  if (args.reportMissing) reportMissing(suppliers, registry.suppliers);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    return;
  }
  const registry = loadRegistry(args.registryFile);
  if (args.updateRegistry) {
    assertPlaintextRegistryWriteAllowed(args);
    const dump = readDump(args);
    const updated = mergeDumpIntoRegistry(registry, dump, args);
    console.log(`registry_updated: ${updated.length} supplier(s)`);
    if (args.reportMissing) reportMissing(selectTargets(registry, args), registry.suppliers);
    if (args.write) {
      fs.mkdirSync(path.dirname(args.registryFile), { recursive: true });
      fs.writeFileSync(args.registryFile, `${JSON.stringify(registry, null, 2)}\n`);
      console.log(`wrote ${args.registryFile}`);
    }
  }
  if (args.fromRegistry) {
    await printRegistryActions(registry, args);
  }
  if (args.populateIssues) {
    await populateIssuesFromRegistry(registry, args);
  }
  if (!args.updateRegistry && !args.fromRegistry && !args.populateIssues && !args.reportMissing) {
    usage();
  } else if (args.reportMissing && !args.updateRegistry && !args.fromRegistry) {
    reportMissing(selectTargets(registry, args), registry.suppliers);
  }
}

export {
  assertPlaintextRegistryWriteAllowed,
  applyStableIdentity,
  collectMissingSupplierCodes,
  findReusableSupplierForTarget,
  loadSupplierManifest,
  normalizeStorefrontHost,
  populateIssueDescription,
  populateIssuesFromRegistry,
  resolveSupplierMessengerUrl,
  sha256,
  supplierIdentityKey,
};

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  try {
    await main();
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
}
