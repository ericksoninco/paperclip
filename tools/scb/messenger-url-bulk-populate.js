#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_REGISTRY_FILE = path.join(
  "data",
  "scb",
  "supplier-registry.json",
);

const PIPE_100_COHORT = [
  {
    issue: "EDD-191",
    supplier_code: "SUP-EDD147-001",
    displayed_supplier_name_expected:
      "Sheng Jie (Dongguan) Silicone Rubber Product Factory",
    cohort: "PIPE-100",
  },
  {
    issue: "EDD-192",
    supplier_code: "SUP-EDD147-002",
    displayed_supplier_name_expected:
      "Zhongshan Fangyuan Silicone Products Co., Ltd.",
    cohort: "PIPE-100",
  },
  {
    issue: "EDD-193",
    supplier_code: "SUP-EDD147-003",
    displayed_supplier_name_expected: "Wenzhou Fante Commodity Co., Ltd.",
    cohort: "PIPE-100",
  },
  {
    issue: "EDD-194",
    supplier_code: "SUP-EDD147-004",
    displayed_supplier_name_expected:
      "Guangdong Wireking Housewares & Hardware Co., Ltd.",
    cohort: "PIPE-100",
  },
  {
    issue: "EDD-195",
    supplier_code: "SUP-EDD147-005",
    displayed_supplier_name_expected: "Dongguan GMI Electronic Co., Ltd.",
    cohort: "PIPE-100",
  },
  {
    issue: "EDD-196",
    supplier_code: "SUP-EDD151-001",
    displayed_supplier_name_expected:
      "Cixi Hongmao Daily Necessities Co. Ltd.",
    cohort: "PIPE-105",
  },
  {
    issue: "EDD-197",
    supplier_code: "SUP-EDD151-002",
    displayed_supplier_name_expected:
      "Nantong Bonn Home Textile Co. Ltd.",
    cohort: "PIPE-105",
  },
  {
    issue: "EDD-198",
    supplier_code: "SUP-EDD151-003",
    displayed_supplier_name_expected:
      "Yiwu Yuanyu Storage Products Co. Ltd.",
    cohort: "PIPE-105",
  },
  {
    issue: "EDD-199",
    supplier_code: "SUP-EDD151-004",
    displayed_supplier_name_expected: "Cangzhou Boxin Trading Co. Ltd.",
    cohort: "PIPE-105",
  },
  {
    issue: "EDD-200",
    supplier_code: "SUP-EDD151-005",
    displayed_supplier_name_expected:
      "Shantou Chenghai Lecheng Houseware Co. Ltd.",
    cohort: "PIPE-105",
  },
  {
    issue: "EDD-201",
    supplier_code: "SUP-EDD152-001",
    displayed_supplier_name_expected:
      "Chaozhou Billion Day Stainless Steel Co. Ltd.",
    cohort: "PIPE-071",
  },
  {
    issue: "EDD-202",
    supplier_code: "SUP-EDD152-002",
    displayed_supplier_name_expected:
      "Chaozhou Chaoan Caitang Yongyu Stainless Steel Products Factory",
    cohort: "PIPE-071",
  },
  {
    issue: "EDD-203",
    supplier_code: "SUP-EDD152-003",
    displayed_supplier_name_expected:
      "Chaozhou Caitang Lihong Hardware Equipment Factory",
    cohort: "PIPE-071",
  },
  {
    issue: "EDD-204",
    supplier_code: "SUP-EDD152-004",
    displayed_supplier_name_expected:
      "Jiangmen Xinhe Stainless Steel Products Co. Ltd.",
    cohort: "PIPE-071",
  },
  {
    issue: "EDD-205",
    supplier_code: "SUP-EDD152-005",
    displayed_supplier_name_expected:
      "Ningbo Gcheng Daily Necessities Co. Ltd.",
    cohort: "PIPE-071",
  },
];

function usage() {
  console.log(`Usage:
  node tools/scb/messenger-url-bulk-populate.js --from-registry [--issues EDD-191,EDD-192] [--report-missing]
  node tools/scb/messenger-url-bulk-populate.js --update-registry --dump-file dump.json [--report-missing]
  node tools/scb/messenger-url-bulk-populate.js --update-registry --from-comment comment-body.txt

Options:
  --registry-file <path>  Registry JSON path (default: ${DEFAULT_REGISTRY_FILE})
  --from-registry         Read messenger_url records from the registry
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
    dryRun: true,
    write: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--from-registry") args.fromRegistry = true;
    else if (arg === "--update-registry") args.updateRegistry = true;
    else if (arg === "--report-missing") args.reportMissing = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--write") args.write = true;
    else if (arg === "--stdin") args.stdin = true;
    else if (arg === "--verify-issues") args.verifyIssues = true;
    else if (arg === "--with-plaintext") args.withPlaintext = true;
    else if (arg === "--registry-file") args.registryFile = requireValue(argv, ++i, arg);
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
  for (const supplier of registry.suppliers) {
    if (!supplier.supplier_code) throw new Error("Registry supplier missing supplier_code");
    if (seenCodes.has(supplier.supplier_code)) {
      throw new Error(`Duplicate supplier_code in registry: ${supplier.supplier_code}`);
    }
    seenCodes.add(supplier.supplier_code);
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

function cohortSupplierRows(registry) {
  const byCode = new Map(registry.suppliers.map((supplier) => [supplier.supplier_code, supplier]));
  return PIPE_100_COHORT.map((row) => ({ ...row, ...byCode.get(row.supplier_code) }));
}

function mergeDumpIntoRegistry(registry, dump, args) {
  if (!Array.isArray(dump.conversations)) {
    throw new Error("Operator dump must contain conversations[]");
  }
  const rows = cohortSupplierRows(registry);
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
    const existing = byCode.get(matched.supplier_code) || matched;
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
      supplier_code: matched.supplier_code,
      issue: matched.issue,
      cohort: matched.cohort,
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
    if (args.withPlaintext) next.messenger_url = conversation.messenger_url;
    else delete next.messenger_url;
    byCode.set(next.supplier_code, next);
    updated.push(next.supplier_code);
  }
  for (const row of PIPE_100_COHORT) {
    if (!byCode.has(row.supplier_code)) {
      byCode.set(row.supplier_code, {
        ...row,
        display_name: row.displayed_supplier_name_expected,
        messenger_url_sha256: null,
        operator_account_hint: dump.operator_account_hint || null,
        status: "missing_thread",
      });
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
  let suppliers = registry.suppliers;
  if (args.cohort) suppliers = suppliers.filter((supplier) => supplier.cohort === args.cohort);
  if (args.issues) {
    const issueSet = new Set(args.issues);
    suppliers = suppliers.filter((supplier) => issueSet.has(supplier.issue));
  }
  return suppliers;
}

function reportMissing(suppliers) {
  const missing = suppliers
    .filter((supplier) => !supplier.messenger_url_sha256)
    .map((supplier) => supplier.supplier_code);
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

async function paperclipJson(pathname) {
  const baseUrl = process.env.PAPERCLIP_API_URL;
  const apiKey = process.env.PAPERCLIP_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("--verify-issues requires PAPERCLIP_API_URL and PAPERCLIP_API_KEY");
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
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
  if (args.reportMissing) reportMissing(suppliers);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    return;
  }
  const registry = loadRegistry(args.registryFile);
  if (args.updateRegistry) {
    const dump = readDump(args);
    const updated = mergeDumpIntoRegistry(registry, dump, args);
    console.log(`registry_updated: ${updated.length} supplier(s)`);
    if (args.reportMissing) reportMissing(registry.suppliers);
    if (args.write) {
      fs.mkdirSync(path.dirname(args.registryFile), { recursive: true });
      fs.writeFileSync(args.registryFile, `${JSON.stringify(registry, null, 2)}\n`);
      console.log(`wrote ${args.registryFile}`);
    }
  }
  if (args.fromRegistry) {
    await printRegistryActions(registry, args);
  }
  if (!args.updateRegistry && !args.fromRegistry && !args.reportMissing) {
    usage();
  } else if (args.reportMissing && !args.updateRegistry && !args.fromRegistry) {
    reportMissing(selectTargets(registry, args));
  }
}

try {
  await main();
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exit(1);
}
