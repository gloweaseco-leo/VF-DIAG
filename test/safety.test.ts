import assert from "node:assert/strict";
import test from "node:test";
import { evaluateTarget, type Lookup } from "../src/safety/target.ts";

const lookup: Lookup = async (host) => {
  if (host === "factory.example") return ["93.184.216.34"];
  if (host === "fixture-site") return ["172.18.0.4"];
  if (host === "rebind.example") return ["93.184.216.34", "10.0.0.8"];
  if (host === "metadata.example") return ["169.254.169.254"];
  if (host === "public-fixture.example") return ["1.1.1.1"];
  throw new Error("nxdomain");
};

const synthetic = new Set(["fixture-site"]);

test("accepts a public https domain pinned to a public address", async () => {
  const verdict = await evaluateTarget("https://factory.example/products", { lookup, syntheticHosts: synthetic });
  assert.equal(verdict.ok, true);
  if (verdict.ok) {
    assert.deepEqual(verdict.target.addresses, ["93.184.216.34"]);
    assert.equal(verdict.target.port, 443);
    assert.equal(verdict.target.synthetic, false);
  }
});

test("rejects private, loopback, metadata, and mixed DNS answers", async () => {
  const cases = [
    ["https://127.0.0.1/", "TARGET_PRIVATE_ADDRESS"],
    ["https://[::ffff:127.0.0.1]/", "TARGET_PRIVATE_ADDRESS"],
    ["https://100.64.0.2/", "TARGET_PRIVATE_ADDRESS"],
    ["https://10.1.1.1/", "TARGET_PRIVATE_ADDRESS"],
    ["https://192.168.1.20/", "TARGET_PRIVATE_ADDRESS"],
    ["https://169.254.169.254/", "TARGET_PRIVATE_ADDRESS"],
    ["https://[::1]/", "TARGET_PRIVATE_ADDRESS"],
    ["https://metadata.example/", "TARGET_PRIVATE_ADDRESS"],
    ["https://rebind.example/", "TARGET_PRIVATE_ADDRESS"],
    ["http://factory.example/", "TARGET_SCHEME_REJECTED"],
    ["https://factory.example:8443/", "TARGET_PORT_REJECTED"],
    ["https://user:pw@factory.example/", "TARGET_URL_INVALID"],
    ["https://localhost/", "TARGET_HOST_REJECTED"],
    ["https://missing.example/", "TARGET_DNS_FAILED"],
  ] as const;
  for (const [url, code] of cases) {
    const verdict = await evaluateTarget(url, { lookup, syntheticHosts: synthetic });
    assert.equal(verdict.ok, false, url);
    if (!verdict.ok) assert.equal(verdict.code, code, url);
  }
});

test("synthetic host is http on the docker network only", async () => {
  const allowed = await evaluateTarget("http://fixture-site:8080/", { lookup, syntheticHosts: synthetic });
  assert.equal(allowed.ok, true);
  const publicAnswer = await evaluateTarget("http://fixture-site:8080/", {
    lookup: async () => ["1.1.1.1"],
    syntheticHosts: synthetic,
  });
  assert.equal(publicAnswer.ok, false);
  if (!publicAnswer.ok) assert.equal(publicAnswer.code, "TARGET_PRIVATE_ADDRESS");
  const closed = await evaluateTarget("http://fixture-site:8080/", { lookup, syntheticHosts: new Set() });
  assert.equal(closed.ok, false);
  if (!closed.ok) assert.equal(closed.code, "TARGET_SCHEME_REJECTED");
});
