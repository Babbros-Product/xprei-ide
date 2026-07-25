import assert from "node:assert/strict";
import { test } from "node:test";
import { isBlockedAddress, isSafeUrl } from "./urlSafety";

test("isSafeUrl accepts http and https", () => {
  assert.equal(isSafeUrl(new URL("http://example.com")), true);
  assert.equal(isSafeUrl(new URL("https://example.com")), true);
});

test("isSafeUrl rejects non-http(s) schemes", () => {
  assert.equal(isSafeUrl(new URL("file:///etc/passwd")), false);
  assert.equal(isSafeUrl(new URL("ftp://example.com")), false);
  assert.equal(isSafeUrl(new URL("data:text/plain;base64,aGk=")), false);
});

test("isBlockedAddress blocks 10.0.0.0/8", () => {
  assert.equal(isBlockedAddress("10.0.0.1"), true);
  assert.equal(isBlockedAddress("10.255.255.255"), true);
});

test("isBlockedAddress blocks 172.16.0.0/12 and correctly bounds it", () => {
  assert.equal(isBlockedAddress("172.16.0.1"), true);
  assert.equal(isBlockedAddress("172.31.255.255"), true);
  assert.equal(isBlockedAddress("172.15.255.255"), false); // just below the range
  assert.equal(isBlockedAddress("172.32.0.1"), false); // just above the range
});

test("isBlockedAddress blocks 192.168.0.0/16", () => {
  assert.equal(isBlockedAddress("192.168.1.1"), true);
  assert.equal(isBlockedAddress("192.169.1.1"), false);
});

test("isBlockedAddress blocks 127.0.0.0/8 (loopback)", () => {
  assert.equal(isBlockedAddress("127.0.0.1"), true);
  assert.equal(isBlockedAddress("127.255.255.255"), true);
});

test("isBlockedAddress blocks 169.254.0.0/16 (link-local, incl. cloud metadata)", () => {
  assert.equal(isBlockedAddress("169.254.169.254"), true);
});

test("isBlockedAddress allows real public IPv4 addresses", () => {
  assert.equal(isBlockedAddress("8.8.8.8"), false);
  assert.equal(isBlockedAddress("1.1.1.1"), false);
});

test("isBlockedAddress blocks ::1 (IPv6 loopback)", () => {
  assert.equal(isBlockedAddress("::1"), true);
});

test("isBlockedAddress blocks fc00::/7 (IPv6 unique local)", () => {
  assert.equal(isBlockedAddress("fc00::1"), true);
  assert.equal(isBlockedAddress("fd12:3456::1"), true);
});

test("isBlockedAddress allows a real public IPv6 address", () => {
  assert.equal(isBlockedAddress("2001:4860:4860::8888"), false);
});

test("isBlockedAddress blocks IPv4-mapped IPv6 loopback/private addresses", () => {
  assert.equal(isBlockedAddress("::ffff:127.0.0.1"), true);
  assert.equal(isBlockedAddress("::ffff:10.0.0.1"), true);
});

test("isBlockedAddress allows an IPv4-mapped IPv6 public address", () => {
  assert.equal(isBlockedAddress("::ffff:8.8.8.8"), false);
});
