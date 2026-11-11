import assert from "node:assert/strict";
import test from "node:test";
import { isPrivateAddress, checkUrl, parsePreview, createPreviewer, publicLookup } from "../preview.js";

test("private and local addresses are never fetched", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "192.168.1.10", "172.20.0.5", "169.254.1.1", "100.100.1.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:192.168.1.1"]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ["1.1.1.1", "93.184.216.34", "2606:4700::1111"]) assert.equal(isPrivateAddress(address), false, address);
  for (const url of ["http://localhost/", "http://umbrel.local/", "http://192.168.1.2/", "http://[::1]/", "http://umbrel/", "https://example.com:8443/", "ftp://example.com/", "https://user:pass@example.com/", "nonsense"]) {
    assert.throws(() => checkUrl(url), undefined, url);
  }
  assert.equal(checkUrl("https://example.com/page#top").toString(), "https://example.com/page");
});

test("share card details are read from the page head", () => {
  const html = `<html><head><title>Fallback</title>
    <meta property="og:title" content="DigiNode Tools &amp; more">
    <meta name="description" content="Plain description">
    <meta property='og:image' content='/card.png'>
    <meta property="og:site_name" content="DigiNode">
  </head>`;
  assert.deepEqual(parsePreview(html, new URL("https://diginode.tools/blog/")), {
    url: "https://diginode.tools/blog/",
    title: "DigiNode Tools & more",
    description: "Plain description",
    image: "https://diginode.tools/card.png",
    siteName: "DigiNode",
  });
  assert.equal(parsePreview("<html><head></head></html>", new URL("https://a.example/")), null);
});

test("previews are cached and failures return null", async () => {
  let calls = 0;
  const preview = createPreviewer({
    fetchPage: async url => {
      calls++;
      if (url.hostname === "down.example") throw new Error("offline");
      return { url, html: '<meta property="og:title" content="Hi">' };
    },
  });
  assert.equal((await preview("https://up.example/a")).title, "Hi");
  await preview("https://up.example/a");
  assert.equal(calls, 1);
  assert.equal(await preview("https://down.example/"), null);
  await assert.rejects(preview("http://127.0.0.1/"), /public/);
});

test("a name that resolves to a private address is refused at connection time", async () => {
  // localhost always resolves to a loopback address, without needing DNS
  const error = await new Promise(resolve => publicLookup("localhost", {}, resolve));
  assert.match(String(error), /Not a public address/);
  const all = await new Promise(resolve => publicLookup("localhost", { all: true }, resolve));
  assert.match(String(all), /Not a public address/);
});
