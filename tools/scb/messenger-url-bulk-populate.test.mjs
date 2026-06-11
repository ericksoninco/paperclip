import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  assertPlaintextRegistryWriteAllowed,
  collectMissingSupplierCodes,
  findReusableSupplierForTarget,
  populateIssueDescription,
  populateIssuesFromRegistry,
  sha256,
  supplierIdentityKey,
} from "./messenger-url-bulk-populate.js";

const messengerUrl = (() => {
  const url = new URL("https://message.alibaba.com/message/messenger.htm");
  url.searchParams.set("activeAccountId", "123");
  url.searchParams.set("activeAccountIdEncrypt", "abc");
  url.searchParams.set("chatToken", "def");
  return url.toString();
})();

describe("supplier stable identity", () => {
  test("uses ali_id before normalized storefront host", () => {
    assert.equal(
      supplierIdentityKey({
        ali_id: "17380631591",
        storefront_url_hint: "https://WWW.dgshengjie.en.alibaba.com/path",
      }),
      "ali_id:17380631591",
    );
  });

  test("falls back to normalized storefront host", () => {
    assert.equal(
      supplierIdentityKey({
        storefront_url_hint: "https://WWW.dgshengjie.en.alibaba.com/path",
      }),
      "storefront_host:dgshengjie.en.alibaba.com",
    );
  });
});

describe("cross-cohort reuse coverage", () => {
  test("does not report a later cohort row missing when a captured stable identity exists", () => {
    const captured = {
      issue: "EDD-191",
      supplier_code: "SUP-A-001",
      ali_id: "17380631591",
      messenger_url_sha256: sha256(messengerUrl),
    };
    const laterCohortReuse = {
      issue: "EDD-500",
      supplier_code: "SUP-B-001",
      ali_id: "17380631591",
      messenger_url_sha256: null,
    };
    const genuinelyNew = {
      issue: "EDD-501",
      supplier_code: "SUP-B-002",
      ali_id: "999",
      messenger_url_sha256: null,
    };

    assert.deepEqual(
      collectMissingSupplierCodes([laterCohortReuse, genuinelyNew], [captured]),
      ["SUP-B-002"],
    );
    assert.equal(findReusableSupplierForTarget(laterCohortReuse, [captured]), captured);
  });
});

describe("issue population", () => {
  test("replaces an empty messenger_url field", () => {
    assert.equal(
      populateIssueDescription("Supplier\nmessenger_url:\nDone", messengerUrl),
      `Supplier\nmessenger_url: ${messengerUrl}\nDone`,
    );
  });

  test("resolves, verifies, and patches target issue bodies only when write is set", async () => {
    const registry = {
      schema_version: 1,
      suppliers: [
        {
          id: "source-row",
          issue: "EDD-191",
          supplier_code: "SUP-A-001",
          ali_id: "17380631591",
          messenger_url_sha256: sha256(messengerUrl),
          source: { issue: "EDD-191" },
        },
        {
          issue: "EDD-500",
          supplier_code: "SUP-B-001",
          ali_id: "17380631591",
          messenger_url_sha256: null,
        },
      ],
    };
    const patched = [];
    const logs = [];
    const originalLog = console.log;
    console.log = (line) => logs.push(String(line));
    try {
      await populateIssuesFromRegistry(
        registry,
        { manifestFile: "__missing_manifest__.json", issues: ["EDD-500"], write: true },
        {
          fetchIssueByIdentifier: async (identifier) => {
            if (identifier === "EDD-191") {
              return { id: "issue-source", description: `messenger_url: ${messengerUrl}` };
            }
            if (identifier === "EDD-500") {
              return { id: "issue-target", description: "Supplier\nmessenger_url:\n" };
            }
            throw new Error(`unexpected issue ${identifier}`);
          },
          patchIssueDescription: async (issueId, description) => {
            patched.push({ issueId, description });
          },
        },
      );
    } finally {
      console.log = originalLog;
    }

    assert.equal(patched.length, 1);
    assert.equal(patched[0].issueId, "issue-target");
    assert.match(patched[0].description, /^Supplier\nmessenger_url: https:\/\/message\.alibaba\.com/m);
    assert.equal(logs.some((line) => line.includes(messengerUrl)), false);
    assert.equal(logs.some((line) => line.includes("populated sha256=")), true);
  });
});

describe("plaintext registry writes", () => {
  test("refuses with-plaintext writes to trackable registry paths", () => {
    assert.throws(
      () =>
        assertPlaintextRegistryWriteAllowed(
          {
            registryFile: "data/scb/supplier-registry.json",
            withPlaintext: true,
            write: true,
          },
          { isGitIgnoredPath: () => false },
        ),
      /requires --registry-file to point to a gitignored local-only path/,
    );
  });

  test("allows with-plaintext writes only when the registry path is gitignored", () => {
    assert.doesNotThrow(() =>
      assertPlaintextRegistryWriteAllowed(
        {
          registryFile: "data/scb/supplier-registry.with-plaintext.json",
          withPlaintext: true,
          write: true,
        },
        { isGitIgnoredPath: () => true },
      ),
    );
  });
});
