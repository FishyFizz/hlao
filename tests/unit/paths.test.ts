import assert from "node:assert/strict";
import { test } from "node:test";
import { isPathWithin, pathKey } from "../../src/paths.js";

test("isPathWithin compares whole path segments", () => {
  const root = "/work/foo";
  assert.equal(isPathWithin(root, root), true);
  assert.equal(isPathWithin("/work/foo/bar", root), true);
  assert.equal(isPathWithin("/work/foobar", root), false);
});

test("pathKey ignores a trailing separator", () => {
  assert.equal(pathKey("/work/foo/"), pathKey("/work/foo"));
});
