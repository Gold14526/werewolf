import { readFile, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

// REST contract: https://neon.com/docs/compute/functions/deploy
// Response fields also follow @neon/sdk's NeonFunction/NeonFunctionDeployment.
// No CLI login, credential creation, branch creation or GitHub mutation occurs.
const API = 'https://console.neon.tech/api/v2';
const SLUG = 'werewolf';
const idPattern = /^[a-z0-9][a-z0-9-]{0,127}$/i;
class DeploymentError extends Error {}
const fail = message => { throw new DeploymentError(message); };

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) fail(`Missing ${name}. Configure the Neon GitHub integration and repository variables first.`);
  return value;
}

function allowedOrigins(value) {
  const origins = value.split(',').map(part => part.trim()).filter(Boolean);
  if (!origins.length) fail('ALLOWED_ORIGINS must contain an explicit HTTPS origin.');
  for (const origin of origins) {
    let url;
    try { url = new URL(origin); } catch { fail('ALLOWED_ORIGINS contains an invalid URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.hostname.includes('*')) {
      fail('ALLOWED_ORIGINS must contain explicit HTTPS origins without credentials or paths.');
    }
  }
  return origins.map(origin => new URL(origin).origin).join(',');
}

function publicInvocationUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('Neon did not return a valid invocation_url.'); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.neon.tech') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    fail('Neon returned an unexpected invocation_url; inspect the function in the console.');
  }
  return url;
}

export async function deployNeon({ env = process.env, fetchImpl = fetch, wait = sleep, now = Date.now, log = console.log } = {}) {
  const apiKey = required(env, 'NEON_API_KEY');
  const project = required(env, 'NEON_PROJECT_ID');
  const branchSelector = (env.NEON_BRANCH_ID || env.NEON_BRANCH || '').trim();
  if (!idPattern.test(project)) fail('NEON_PROJECT_ID is invalid.');
  if (!branchSelector || branchSelector.length > 256) fail('Set NEON_BRANCH_ID or NEON_BRANCH to an existing branch ID or exact name.');
  const origins = allowedOrigins(env.ALLOWED_ORIGINS || 'https://gold14526.github.io');
  let zip;
  try { zip = await readFile(new URL('../dist-neon/werewolf.zip', import.meta.url)); }
  catch { fail('Function ZIP is missing; run npm run build:neon first.'); }
  if (zip.length < 4 || zip.length > 32 * 1024 * 1024 || zip.readUInt32LE(0) !== 0x04034b50) fail('Function ZIP is invalid or exceeds 32 MiB.');

  async function request(path, { method = 'GET', body } = {}) {
    let response;
    try {
      response = await fetchImpl(API + path, {
        method,
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(method === 'POST' ? 60000 : 30000),
      });
    } catch {
      fail(method === 'POST'
        ? 'Neon upload response was lost. Check the function in the console before retrying; the deployment may already exist.'
        : 'Could not read Neon deployment status. Check the function in the console.');
    }
    if (!response.ok) fail(`Neon API returned HTTP ${response.status}. Check project access and function status in the console.`);
    try { return await response.json(); }
    catch { fail('Neon API returned an invalid JSON response.'); }
  }

  // Resolve only an existing exact match. Never create or choose a default branch.
  const validateBranch = branch => {
    if (!branch || !idPattern.test(branch.id) || branch.project_id !== project || typeof branch.name !== 'string' || !branch.name) {
      fail('Neon returned an invalid branch or one outside the selected project.');
    }
  };
  let branchId;
  if (branchSelector.startsWith('br-') && idPattern.test(branchSelector)) {
    // IDs have a direct lookup; do not depend on branch-search semantics.
    const { branch } = await request(`/projects/${project}/branches/${branchSelector}`);
    validateBranch(branch);
    if (branch.id !== branchSelector) fail('Neon returned a different branch than requested.');
    branchId = branch.id;
  } else {
    const matches = new Map();
    const cursors = new Set();
    let cursor;
    do {
      const query = new URLSearchParams({ search: branchSelector, limit: '100' });
      if (cursor) query.set('cursor', cursor);
      const data = await request(`/projects/${project}/branches?${query}`);
      if (!Array.isArray(data.branches)) fail('Neon branch list has an unexpected shape.');
      for (const branch of data.branches) {
        if (branch.name === branchSelector) {
          validateBranch(branch);
          matches.set(branch.id, branch);
        }
      }
      cursor = data.pagination?.next;
      if (cursor && (typeof cursor !== 'string' || cursors.has(cursor) || cursors.size >= 100)) fail('Neon branch pagination did not complete.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (matches.size !== 1) fail('The selected existing Neon branch was not found uniquely. Set NEON_BRANCH_ID to its exact ID.');
    branchId = [...matches.keys()][0];
  }
  const functionPath = `/projects/${project}/branches/${branchId}/functions/${SLUG}`;

  const form = new FormData();
  form.set('zip', new Blob([zip], { type: 'application/zip' }), 'werewolf.zip');
  form.set('runtime', 'nodejs24');
  form.set('environment', JSON.stringify({ ALLOWED_ORIGINS: origins }));
  const result = await request(`${functionPath}/deployments`, { method: 'POST', body: form });
  const deployment = result.deployment;
  if (!Number.isSafeInteger(deployment?.id) || deployment.id < 0) fail('Neon accepted the upload but returned no valid deployment ID; inspect the console before retrying.');
  const deploymentId = deployment.id;
  log(`Neon accepted deployment ${deploymentId}. Waiting for this version to become active.`);

  const deadline = now() + 8 * 60 * 1000;
  let lastStatus;
  let invocation;
  while (now() < deadline) {
    const { function: fn } = await request(functionPath);
    if (!fn || fn.slug !== SLUG) fail('Neon function status has an unexpected shape.');
    const current = fn.current_deployment;
    const active = fn.active_deployment;
    if (current && !['pending', 'building', 'completed', 'failed'].includes(current.status)) fail('Neon returned an unknown deployment status.');
    if (current && current.id > deploymentId) fail('A newer deployment superseded this run. Inspect the function before publishing its URL.');
    if (current?.id === deploymentId && current.status === 'failed') fail('Neon function build failed. See the function deployment details in the console.');
    if (active?.id === deploymentId && active.status === 'completed') {
      invocation = publicInvocationUrl(fn.invocation_url);
      break;
    }
    const status = current?.id === deploymentId ? current.status : 'waiting for deployment status';
    if (status !== lastStatus) { log(`Deployment ${deploymentId}: ${status}`); lastStatus = status; }
    await wait(5000);
  }
  if (!invocation) fail('Timed out waiting for the uploaded deployment to become active. Inspect the console before retrying.');

  // Call only the public health endpoint, without the control-plane API key.
  let healthy = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const response = await fetchImpl(new URL('api/health', invocation), { redirect: 'error', signal: AbortSignal.timeout(15000) });
      const data = await response.json();
      if (response.ok && data.service === 'moonwolf' && data.storage === 'postgres') { healthy = true; break; }
    } catch {}
    if (attempt < 11) await wait(5000);
  }
  if (!healthy) fail('The function deployed, but its Postgres health check did not pass. Keep the existing frontend API setting and inspect Neon logs.');

  const apiBase = invocation.origin;
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `api_base_url=${apiBase}\ninvocation_url=${invocation.href}\ndeployment_id=${deploymentId}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, `Neon deployment **${deploymentId}** is active and its Postgres health check passed.\n\nAPI: [${apiBase}](${apiBase})\n\nSet the repository variable \`API_BASE_URL\` to \`${apiBase}\`, then run **Deploy GitHub Pages**. This workflow does not change repository settings.\n`);
  }
  log(`Neon deployment ${deploymentId} is active; Postgres health check passed.`);
  log(`API_BASE_URL=${apiBase}`);
  return { apiBase, invocationUrl: invocation.href, deploymentId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await deployNeon(); }
  catch (error) {
    // API responses and driver errors may contain sensitive detail; never dump them.
    console.error(error instanceof DeploymentError ? error.message : 'Deployment failed unexpectedly. Inspect the Neon console and retry after resolving the problem.');
    process.exitCode = 1;
  }
}
