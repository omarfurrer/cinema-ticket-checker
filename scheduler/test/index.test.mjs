import assert from "node:assert/strict";
import test from "node:test";

import { dispatchGitHubWorkflow } from "../src/index.js";

const ENV = {
  GITHUB_OWNER: "omarfurrer",
  GITHUB_REPOSITORY: "cinema-ticket-checker",
  GITHUB_WORKFLOW: "check.yml",
  GITHUB_REF: "main",
  GITHUB_TOKEN: "test-token",
};

function quietLogger() {
  return {
    log() {},
    error() {},
  };
}

test("dispatches a full real check to the configured workflow", async () => {
  let capturedUrl;
  let capturedOptions;
  const fetchRequest = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return new Response(null, {
      status: 200,
      headers: { "x-github-request-id": "test-request" },
    });
  };

  await dispatchGitHubWorkflow(ENV, fetchRequest, quietLogger());

  assert.equal(
    capturedUrl,
    "https://api.github.com/repos/omarfurrer/cinema-ticket-checker/actions/workflows/check.yml/dispatches",
  );
  assert.equal(capturedOptions.method, "POST");
  assert.equal(
    new Headers(capturedOptions.headers).get("Authorization"),
    "Bearer test-token",
  );
  assert.deepEqual(JSON.parse(capturedOptions.body), {
    ref: "main",
    inputs: {
      limited_probe: false,
      dry_run: false,
    },
  });
});

test("fails without making a request when the token is missing", async () => {
  let requested = false;
  const fetchRequest = async () => {
    requested = true;
    return new Response(null, { status: 204 });
  };

  await assert.rejects(
    dispatchGitHubWorkflow(
      { ...ENV, GITHUB_TOKEN: "" },
      fetchRequest,
      quietLogger(),
    ),
    /Missing required Worker binding: GITHUB_TOKEN/,
  );
  assert.equal(requested, false);
});

test("surfaces a rejected GitHub dispatch", async () => {
  const fetchRequest = async () =>
    new Response(null, {
      status: 401,
      headers: { "x-github-request-id": "failed-request" },
    });

  await assert.rejects(
    dispatchGitHubWorkflow(ENV, fetchRequest, quietLogger()),
    /GitHub workflow dispatch failed with HTTP 401/,
  );
});
