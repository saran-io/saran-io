#!/usr/bin/env node
/**
 * Snapshots GitHub traffic for every public repo and mirrors it into Plausible.
 *
 * GitHub's traffic API only retains 14 days, so this appends each day's numbers
 * to data/traffic-history.json to build a permanent record. It then sends the
 * newly-observed views to Plausible as custom events so GitHub reach and
 * saran.build reach live on the same dashboard.
 *
 * Env:
 *   GH_TOKEN         token with repo scope (traffic API needs push access)
 *   PLAUSIBLE_DOMAIN Plausible site to report into (skips sending if unset)
 *   DRY_RUN          set to "1" to collect without sending events
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const OWNER = 'saran-io';
const HISTORY_PATH = 'data/traffic-history.json';
const SENT_PATH = 'data/plausible-sent.json';
const SUMMARY_PATH = 'data/traffic-summary.md';

const GH_TOKEN = process.env.GH_TOKEN;
const PLAUSIBLE_DOMAIN = process.env.PLAUSIBLE_DOMAIN;
const DRY_RUN = process.env.DRY_RUN === '1';

// Backstop so a bad diff can never spray thousands of events at Plausible.
const MAX_EVENTS_PER_RUN = 2000;

// A fixed synthetic identity: Plausible hashes IP+UA to derive a visitor, so
// every mirrored event collapses into one visitor per day instead of inflating
// the site's visitor count once per GitHub view.
const SYNTHETIC_IP = '203.0.113.1'; // TEST-NET-3, never a real client
const SYNTHETIC_UA = 'saran-io-traffic-mirror/1.0 (+https://github.com/saran-io/saran-io)';

if (!GH_TOKEN) {
  console.error('GH_TOKEN is required');
  process.exit(1);
}

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'saran-io-traffic-collector',
    },
  });
  if (!res.ok) {
    throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** All public, non-fork repos owned by OWNER. Private repos are excluded on
 *  purpose — this history file is committed to a public repo. */
async function listRepos() {
  const repos = [];
  for (let page = 1; ; page++) {
    const batch = await gh(`/user/repos?affiliation=owner&per_page=100&page=${page}`);
    if (batch.length === 0) break;
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos
    .filter((r) => r.owner.login === OWNER && !r.private && !r.fork)
    .map((r) => r.name)
    .sort();
}

const day = (timestamp) => timestamp.slice(0, 10);

async function collectRepo(repo) {
  // A repo can lose its traffic endpoints (transfer, permissions); don't let
  // one failure abort the whole run.
  const safe = async (path) => {
    try {
      return await gh(path);
    } catch (err) {
      console.warn(`  skipped ${path}: ${err.message.split('\n')[0]}`);
      return null;
    }
  };

  const [views, clones] = await Promise.all([
    safe(`/repos/${OWNER}/${repo}/traffic/views`),
    safe(`/repos/${OWNER}/${repo}/traffic/clones`),
  ]);

  const byDate = {};
  for (const v of views?.views ?? []) {
    byDate[day(v.timestamp)] = { views: v.count, view_uniques: v.uniques, clones: 0, clone_uniques: 0 };
  }
  for (const c of clones?.clones ?? []) {
    const d = day(c.timestamp);
    byDate[d] = { views: 0, view_uniques: 0, ...byDate[d], clones: c.count, clone_uniques: c.uniques };
  }
  return byDate;
}

/**
 * Sends `count` events to Plausible's Events API. No API key needed — the
 * endpoint is the same one the browser script posts to.
 */
async function sendEvents(repo, count) {
  let sent = 0;
  for (let i = 0; i < count; i++) {
    const res = await fetch('https://plausible.io/api/event', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': SYNTHETIC_UA,
        'X-Forwarded-For': SYNTHETIC_IP,
      },
      body: JSON.stringify({
        name: 'GitHub Repo View',
        url: `https://github.com/${OWNER}/${repo}`,
        domain: PLAUSIBLE_DOMAIN,
        props: { repo },
      }),
    });
    if (!res.ok) {
      console.warn(`  plausible ${repo} -> ${res.status} ${await res.text()}`);
      break;
    }
    sent++;
  }
  return sent;
}

const history = await readJson(HISTORY_PATH, {});
const sentLog = await readJson(SENT_PATH, {});

const repos = await listRepos();
console.log(`Collecting traffic for ${repos.length} public repos`);

// Today's numbers are still accruing, so never mark them as fully mirrored.
const today = new Date().toISOString().slice(0, 10);

let pending = [];
for (const repo of repos) {
  const byDate = await collectRepo(repo);
  if (Object.keys(byDate).length === 0) continue;

  history[repo] ??= {};
  for (const [date, stats] of Object.entries(byDate)) {
    // Overwrite rather than merge: GitHub's value for a given day is
    // authoritative and re-running the same day should not double-count.
    history[repo][date] = stats;

    const alreadySent = sentLog[`${repo}|${date}`] ?? 0;
    const delta = stats.views - alreadySent;
    if (delta > 0) pending.push({ repo, date, delta, isToday: date === today });
  }
}

// Persist history first — the permanent record matters more than the mirror.
const sortedHistory = Object.fromEntries(
  Object.keys(history)
    .sort()
    .map((repo) => [repo, Object.fromEntries(Object.entries(history[repo]).sort())]),
);
await writeJson(HISTORY_PATH, sortedHistory);

const totals = Object.entries(sortedHistory)
  .map(([repo, days]) => {
    const rows = Object.values(days);
    return {
      repo,
      views: rows.reduce((a, r) => a + r.views, 0),
      uniques: rows.reduce((a, r) => a + r.view_uniques, 0),
      clones: rows.reduce((a, r) => a + r.clones, 0),
    };
  })
  .filter((r) => r.views > 0 || r.clones > 0)
  .sort((a, b) => b.views - a.views);

await writeFile(
  SUMMARY_PATH,
  [
    '# GitHub traffic',
    '',
    `All-time totals since collection began. Updated ${today}.`,
    '',
    '| Repo | Views | Unique visitors | Clones |',
    '| --- | ---: | ---: | ---: |',
    ...totals.map((r) => `| [${r.repo}](https://github.com/${OWNER}/${r.repo}) | ${r.views} | ${r.uniques} | ${r.clones} |`),
    '',
  ].join('\n'),
);

console.log(`History: ${totals.length} repos with traffic, ${totals.reduce((a, r) => a + r.views, 0)} views all-time`);

if (!PLAUSIBLE_DOMAIN || DRY_RUN) {
  console.log('Plausible mirroring skipped (no PLAUSIBLE_DOMAIN or DRY_RUN=1)');
  process.exit(0);
}

let budget = MAX_EVENTS_PER_RUN;
const totalPending = pending.reduce((a, p) => a + p.delta, 0);
if (totalPending > budget) {
  console.warn(`Capping at ${budget} events this run (${totalPending} pending); the rest carries to tomorrow`);
}

for (const { repo, date, delta, isToday } of pending) {
  if (budget <= 0) break;
  const count = Math.min(delta, budget);
  const sent = await sendEvents(repo, count);
  budget -= sent;
  // Record what actually landed, so a partial run resumes rather than repeats.
  sentLog[`${repo}|${date}`] = (sentLog[`${repo}|${date}`] ?? 0) + sent;
  if (sent > 0) console.log(`  ${repo} ${date}: mirrored ${sent} view(s)${isToday ? ' (day in progress)' : ''}`);
}

// GitHub prunes at 14 days; keep the log a little longer, then drop it.
const cutoff = new Date(Date.now() - 45 * 86400_000).toISOString().slice(0, 10);
for (const key of Object.keys(sentLog)) {
  if (key.split('|')[1] < cutoff) delete sentLog[key];
}
await writeJson(SENT_PATH, sentLog);
