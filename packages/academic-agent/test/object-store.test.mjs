import assert from "node:assert/strict";
import test from "node:test";
import { ObjectStore, sha256, signedHeaders } from "../src/object-store.mjs";

test("matches independent Smithy SigV4 signatures for paginated GET and encoded streaming PUT", () => {
  const credentials = {
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    sessionToken: "fixture-token",
  };
  for (const fixture of [
    {
      method: "GET",
      pathname: "/test-bucket/",
      query: {
        "list-type": "2",
        prefix: "glossa/snapshots/",
        "continuation-token": "some+token==",
      },
      body: "",
      signature: "9964f81ef60f3fd38b1ae8c69cc69d93151c2dd4db826feb0bdc94991365d39c",
    },
    {
      method: "PUT",
      pathname: "/test-bucket/glossa/%E7%AC%94%E8%AE%B0%20%21.md",
      query: {},
      body: "backup content",
      signature: "f306625727475731b80cff469b0aadd31c6e754c04467c4fbfcfebec67fa8425",
    },
  ]) {
    const url = new URL(`https://s3.us-east-1.amazonaws.com${fixture.pathname}`);
    for (const [key, value] of Object.entries(fixture.query)) url.searchParams.set(key, value);
    const headers = signedHeaders({
      url,
      method: fixture.method,
      payloadHash: sha256(fixture.body),
      credentials,
      region: "us-east-1",
      now: new Date("2026-11-15T12:00:00.000Z"),
      headers:
        fixture.method === "PUT"
          ? { "content-length": String(Buffer.byteLength(fixture.body)) }
          : {},
    });
    assert.equal(headers.authorization.split("Signature=")[1], fixture.signature);
  }
});

test("rejects invalid XML, oversized pages and pagination loops", async () => {
  const store = new ObjectStore(
    {
      provider: "r2",
      endpoint: "https://example.com",
      bucket: "test-bucket",
      prefix: "glossa",
      enabled: false,
      intervalMinutes: 30,
    },
    { accessKeyId: "test", secretAccessKey: "test" },
  );
  for (const text of [
    "<html>error</html>",
    "<!DOCTYPE evil><ListBucketResult></ListBucketResult>",
    "x".repeat(4 * 1024 * 1024 + 1),
  ]) {
    store.request = async () => new Response(text);
    await assert.rejects(store.list("glossa/snapshots/"), /CLOUD_RESPONSE|CLOUD_SIZE_LIMIT/);
  }
  let page = 0;
  store.request = async () =>
    new Response(
      `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>${page++ % 2 ? "second" : "first"}</NextContinuationToken></ListBucketResult>`,
    );
  await assert.rejects(store.list("glossa/snapshots/"), /CLOUD_RESPONSE/);
});
