const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const REQUEST_TIMEOUT_MS = 15_000;
const USER_AGENT = "vox-ticket-watcher-scheduler";
const FULL_CHECK_INPUTS = {
  limited_probe: false,
  dry_run: false,
};

function requiredValue(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required Worker binding: ${name}`);
  }

  return value;
}

export async function dispatchGitHubWorkflow(
  env,
  fetchRequest = fetch,
  logger = console,
) {
  const owner = requiredValue(env, "GITHUB_OWNER");
  const repository = requiredValue(env, "GITHUB_REPOSITORY");
  const workflow = requiredValue(env, "GITHUB_WORKFLOW");
  const ref = requiredValue(env, "GITHUB_REF");
  const token = requiredValue(env, "GITHUB_TOKEN");
  const workflowUrl = [
    GITHUB_API_BASE_URL,
    "repos",
    encodeURIComponent(owner),
    encodeURIComponent(repository),
    "actions",
    "workflows",
    encodeURIComponent(workflow),
    "dispatches",
  ].join("/");

  const response = await fetchRequest(workflowUrl, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
    body: JSON.stringify({
      ref,
      inputs: FULL_CHECK_INPUTS,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const githubRequestId = response.headers.get("x-github-request-id");
  await response.body?.cancel();

  if (!response.ok) {
    logger.error({
      event: "github_workflow_dispatch_failed",
      githubRequestId,
      status: response.status,
    });
    throw new Error(`GitHub workflow dispatch failed with HTTP ${response.status}`);
  }

  logger.log({
    event: "github_workflow_dispatched",
    githubRequestId,
    status: response.status,
  });
}

export default {
  async scheduled(controller, env) {
    console.log({
      event: "scheduler_started",
      cron: controller.cron,
      scheduledTime: new Date(controller.scheduledTime).toISOString(),
    });
    await dispatchGitHubWorkflow(env);
  },
};
