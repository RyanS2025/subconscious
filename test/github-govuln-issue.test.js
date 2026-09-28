import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLEAN_COMMENT,
  calledFindings,
  githubClient,
  ISSUE_TITLE,
  LABELS,
  renderBody,
  syncGovulnIssue,
} from '../scripts/github-govuln-issue.js';

const reportText = `
{"osv":{"id":"GO-2026-1111","summary":"Uncalled module issue"}}
{"finding":{"osv":"GO-2026-1111","trace":[{"module":"golang.org/x/sys","version":"v0.1.0"}]}}
{"finding":{"osv":"GO-2026-2222","trace":[{"module":"stdlib","package":"net/http"}]}}
{
  "finding": {
    "osv": "GO-2026-4601",
    "fixed_version": "v1.25.2",
    "trace": [
      {"module":"stdlib","package":"net/url","function":"Parse"},
      {"module":"github.com/subconscious-systems/subconscious/cli/tui","function":"normalizeBaseURL"}
    ]
  }
}
{"osv":{"id":"GO-2026-4601","summary":"Incorrect parsing of IPv6 host literals"}}
{"finding":{"osv":"GO-2026-4601","fixed_version":"v1.25.2","trace":[{"module":"stdlib","function":"Parse"}]}}
`;

test('called findings stay and uncalled findings drop', () => {
  const findings = calledFindings(reportText);
  assert.deepEqual(findings, [
    {
      id: 'GO-2026-4601',
      summary: 'Incorrect parsing of IPv6 host literals',
      fixedVersion: 'v1.25.2',
      symbol: 'normalizeBaseURL',
    },
  ]);
});

test('the issue body names both trees', () => {
  const body = renderBody({
    publishedVersion: '6.0.0',
    publishedFindings: calledFindings(reportText),
    mainSha: 'abc123',
    mainFindings: [],
    runUrl:
      'https://github.com/subconscious-systems/subconscious/actions/runs/1',
  });
  assert.match(
    body,
    /Pull requests that fix the published tag or main are welcome/,
  );
  assert.match(body, /## Published subconscious-cli@6\.0\.0/);
  assert.match(body, /GO-2026-4601/);
  assert.match(body, /normalizeBaseURL/);
  assert.match(body, /## main \(abc123\)\n\nnone/);
  assert.match(body, /actions\/runs\/1/);
  assert.doesNotMatch(body, /GO-2026-1111/);
});

function memoryClient(open = null) {
  const calls = [];
  return {
    calls,
    async findOpenIssue() {
      return open;
    },
    async create(issue) {
      calls.push(['create', issue]);
      return { number: 42 };
    },
    async update(number, body) {
      calls.push(['update', number, body]);
    },
    async comment(number, body) {
      calls.push(['comment', number, body]);
    },
    async close(number) {
      calls.push(['close', number]);
    },
  };
}

const affected = {
  publishedVersion: '6.0.0',
  publishedFindings: calledFindings(reportText),
  mainSha: 'abc123',
  mainFindings: [],
  runUrl: 'https://example.test/run',
};

const clean = {
  ...affected,
  publishedFindings: [],
};

test('findings open an issue when none is open', async () => {
  const client = memoryClient(null);
  const result = await syncGovulnIssue(client, affected);
  assert.equal(result.action, 'created');
  assert.equal(result.number, 42);
  assert.equal(client.calls[0][1].title, ISSUE_TITLE);
  assert.deepEqual(client.calls[0][1].labels, LABELS);
});

test('findings replace the body of the open issue', async () => {
  const client = memoryClient({ number: 7, title: ISSUE_TITLE });
  const result = await syncGovulnIssue(client, affected);
  assert.deepEqual(result, { action: 'updated', number: 7 });
  assert.equal(client.calls[0][0], 'update');
  assert.match(client.calls[0][2], /GO-2026-4601/);
});

test('a clean scan does nothing when no issue is open', async () => {
  const client = memoryClient(null);
  const result = await syncGovulnIssue(client, clean);
  assert.deepEqual(result, { action: 'none' });
  assert.deepEqual(client.calls, []);
});

test('a clean scan comments and closes the open issue', async () => {
  const client = memoryClient({ number: 7, title: ISSUE_TITLE });
  const result = await syncGovulnIssue(client, clean);
  assert.deepEqual(result, { action: 'closed', number: 7 });
  assert.deepEqual(client.calls, [
    ['comment', 7, CLEAN_COMMENT],
    ['close', 7],
  ]);
});

test('GitHub API errors fail the client', async () => {
  const client = githubClient({
    token: 'token',
    repo: 'subconscious-systems/subconscious',
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      async text() {
        return JSON.stringify({ message: 'boom' });
      },
    }),
  });
  await assert.rejects(
    () => client.findOpenIssue(ISSUE_TITLE),
    /GitHub GET .* failed \(500\)/,
  );
});

test('the client matches the open issue title and skips pull requests', async () => {
  const calls = [];
  const client = githubClient({
    token: 'token',
    repo: 'subconscious-systems/subconscious',
    fetchImpl: async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify([
            {
              number: 1,
              title: ISSUE_TITLE,
              pull_request: { url: 'https://example.test' },
            },
            { number: 9, title: 'something else' },
            { number: 4, title: ISSUE_TITLE },
          ]);
        },
      };
    },
  });
  const issue = await client.findOpenIssue(ISSUE_TITLE);
  assert.deepEqual(issue, { number: 4, title: ISSUE_TITLE });
  assert.match(
    calls[0],
    /\/repos\/subconscious-systems\/subconscious\/issues\?/,
  );
});
