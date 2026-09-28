#!/usr/bin/env node

import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const ISSUE_TITLE = 'Go vulnerabilities in subconscious-cli';
export const LABELS = ['bug', 'help wanted'];
export const CLEAN_COMMENT =
  'Daily govulncheck is clean for the published tag and main.';

const WELCOME =
  'A daily govulncheck found called vulnerabilities in subconscious-cli. Pull requests that fix the published tag or main are welcome.';

export function parseJsonValues(text) {
  const values = [];
  let index = 0;
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) index += 1;
    if (index >= text.length) break;
    const end = endOfJsonValue(text, index);
    values.push(JSON.parse(text.slice(index, end)));
    index = end;
  }
  return values;
}

function endOfJsonValue(text, start) {
  const opener = text[start];
  if (opener !== '{' && opener !== '[') {
    throw new Error(`govulncheck report has non-JSON at offset ${start}`);
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') depth += 1;
    if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  throw new Error('govulncheck report ended inside a JSON value');
}

// Symbol-level findings are the ones whose first trace frame names a
// function. Those are the calls that make a text-mode govulncheck exit 3.
// Module and package findings have no function and stay out of the issue.
export function calledFindings(reportText) {
  const summaries = new Map();
  const byId = new Map();
  for (const message of parseJsonValues(reportText)) {
    if (message.osv?.id) {
      summaries.set(message.osv.id, message.osv.summary || '');
    }
    const finding = message.finding;
    const trace = finding?.trace || [];
    if (!finding?.osv || !trace[0]?.function || byId.has(finding.osv)) continue;
    byId.set(finding.osv, {
      id: finding.osv,
      summary: '',
      fixedVersion: finding.fixed_version || '',
      symbol: callingSymbol(trace),
    });
  }
  for (const finding of byId.values()) {
    finding.summary = summaries.get(finding.id) || '';
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function callingSymbol(trace) {
  for (let index = trace.length - 1; index >= 0; index -= 1) {
    if (trace[index].function) return trace[index].function;
  }
  return trace[0].function;
}

export function renderBody({
  publishedVersion,
  publishedFindings,
  mainSha,
  mainFindings,
  runUrl,
}) {
  return [
    WELCOME,
    '',
    `## Published subconscious-cli@${publishedVersion}`,
    '',
    findingLines(publishedFindings),
    '',
    `## main (${mainSha})`,
    '',
    findingLines(mainFindings),
    '',
    `Scan: ${runUrl}`,
    '',
  ].join('\n');
}

function findingLines(findings) {
  if (findings.length === 0) return 'none';
  return findings
    .map((finding) => {
      const summary = finding.summary
        ? `${finding.summary}.`
        : 'Called vulnerability.';
      const fixed = finding.fixedVersion
        ? ` Fixed in \`${finding.fixedVersion}\`.`
        : '';
      return `- \`${finding.id}\`: ${summary}${fixed} Called from \`${finding.symbol}\`.`;
    })
    .join('\n');
}

export async function syncGovulnIssue(client, report) {
  const affected =
    report.publishedFindings.length + report.mainFindings.length > 0;
  const open = await client.findOpenIssue(ISSUE_TITLE);
  if (!affected) {
    if (!open) return { action: 'none' };
    await client.comment(open.number, CLEAN_COMMENT);
    await client.close(open.number);
    return { action: 'closed', number: open.number };
  }
  const body = renderBody(report);
  if (open) {
    await client.update(open.number, body);
    return { action: 'updated', number: open.number };
  }
  const created = await client.create({
    title: ISSUE_TITLE,
    body,
    labels: LABELS,
  });
  return { action: 'created', number: created.number };
}

export function githubClient({ token, repo, fetchImpl = fetch }) {
  const separator = repo.indexOf('/');
  if (separator <= 0 || separator === repo.length - 1) {
    throw new Error(`GITHUB_REPOSITORY must be owner/name, got ${repo}`);
  }
  const owner = repo.slice(0, separator);
  const name = repo.slice(separator + 1);

  async function request(method, path, body) {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'subconscious-cli-govulncheck',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (!response.ok) {
      const detail =
        typeof payload === 'string' ? payload : JSON.stringify(payload);
      throw new Error(
        `GitHub ${method} ${path} failed (${response.status}): ${detail}`,
      );
    }
    return payload;
  }

  return {
    async findOpenIssue(title) {
      for (let page = 1; page <= 10; page += 1) {
        const items = await request(
          'GET',
          `/repos/${owner}/${name}/issues?state=open&per_page=100&page=${page}`,
        );
        if (!Array.isArray(items)) {
          throw new Error('GitHub issues list was not an array');
        }
        const match = items.find(
          (item) => item.title === title && !item.pull_request,
        );
        if (match) return { number: match.number, title: match.title };
        if (items.length < 100) return null;
      }
      return null;
    },
    create(issue) {
      return request('POST', `/repos/${owner}/${name}/issues`, issue);
    },
    update(number, body) {
      return request('PATCH', `/repos/${owner}/${name}/issues/${number}`, {
        body,
      });
    },
    comment(number, body) {
      return request(
        'POST',
        `/repos/${owner}/${name}/issues/${number}/comments`,
        {
          body,
        },
      );
    },
    close(number) {
      return request('PATCH', `/repos/${owner}/${name}/issues/${number}`, {
        state: 'closed',
        state_reason: 'completed',
      });
    },
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key?.startsWith('--') || argv[index + 1] === undefined) {
      throw new Error(`unexpected argument ${key}`);
    }
    args[key.slice(2)] = argv[index + 1];
  }
  return args;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  for (const key of [
    'published-version',
    'published-report',
    'main-sha',
    'main-report',
    'run-url',
  ]) {
    if (!args[key]) throw new Error(`missing --${key}`);
  }
  if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is required');
  if (!env.GITHUB_REPOSITORY) throw new Error('GITHUB_REPOSITORY is required');

  const [publishedReport, mainReport] = await Promise.all([
    fs.readFile(args['published-report'], 'utf8'),
    fs.readFile(args['main-report'], 'utf8'),
  ]);
  const report = {
    publishedVersion: args['published-version'],
    publishedFindings: calledFindings(publishedReport),
    mainSha: args['main-sha'],
    mainFindings: calledFindings(mainReport),
    runUrl: args['run-url'],
  };
  const result = await syncGovulnIssue(
    githubClient({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPOSITORY }),
    report,
  );
  console.log(`${result.action}${result.number ? ` #${result.number}` : ''}`);
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
