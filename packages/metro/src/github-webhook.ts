/** GitHub webhook → readable message formatting. */
/** Maps (`x-github-event`, JSON body) → a concise one-liner authored by a */
/** synthetic, label-only "github" account (no XMTP wallet — `githubFrom()` is */
/** just a participant URI + display name). Callers keep events on the webhook */
/** station line, which `passesMode` already feed-excludes (flood stays contained). */

import { Line } from './lines.js';

/** Synthetic author for GitHub webhook messages — a label, not a real account/wallet. */
export const GITHUB_ACCOUNT = 'github';

/** Participant URI for the synthetic GitHub author: `metro://github/user/github`. */
export const githubFrom = (): Line => Line.user(GITHUB_ACCOUNT, GITHUB_ACCOUNT);

/** Display name shown next to GitHub-authored messages. */
export const GITHUB_FROM_NAME = 'github';

/* ──────────── payload shapes (only the fields we read) ──────────── */

type Repo = { full_name?: string; name?: string };
type User = { login?: string };
type Issue = { number?: number; title?: string; html_url?: string };
type PullRequest = {
  number?: number; title?: string; merged?: boolean; html_url?: string;
  base?: { ref?: string }; head?: { ref?: string };
};
type Comment = { body?: string; html_url?: string };
type Commit = { message?: string };

interface GitHubBody {
  action?: string;
  repository?: Repo;
  sender?: User;
  pusher?: { name?: string };
  ref?: string;
  forced?: boolean;
  commits?: Commit[];
  head_commit?: Commit | null;
  pull_request?: PullRequest;
  issue?: Issue;
  comment?: Comment;
  review?: { state?: string; html_url?: string };
  release?: { tag_name?: string; name?: string; html_url?: string; draft?: boolean; prerelease?: boolean };
  check_run?: { name?: string; conclusion?: string; status?: string };
  check_suite?: { conclusion?: string; status?: string };
  workflow_run?: { name?: string; conclusion?: string; status?: string };
  ref_type?: string;
  starred_at?: string | null;
}

const repoName = (b: GitHubBody): string =>
  b.repository?.full_name ?? b.repository?.name ?? 'repo';

const actor = (b: GitHubBody): string => b.sender?.login ?? b.pusher?.name ?? 'someone';

/** Strip a ref like `refs/heads/main` → `main`, `refs/tags/v1` → `v1`. */
const shortRef = (ref?: string): string =>
  (ref ?? '').replace(/^refs\/(heads|tags)\//, '') || ref || '';

/** First line of a (possibly multiline) string, trimmed and length-capped. */
const firstLine = (s: string | undefined, max = 120): string => {
  const line = (s ?? '').split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Format a GitHub webhook into a one-line message. Returns `null` when the */
/** event is not worth surfacing (e.g. `ping` or a low-signal sub-action) so the */
/** caller drops it instead of posting noise to the channel. */
export function formatGitHubEvent(eventName: string | undefined, rawBody: unknown): string | null {
  const b: GitHubBody = rawBody && typeof rawBody === 'object' ? (rawBody as GitHubBody) : {};
  const repo = repoName(b);
  const who = actor(b);

  switch (eventName) {
    case 'ping':
      return null;

    case 'push': {
      const branch = shortRef(b.ref);
      const n = b.commits?.length ?? 0;
      if (n === 0 && !b.head_commit) {
        // branch/tag create or delete via push (no commits)
        return `${repo}: ${who} updated ${branch}`;
      }
      const msg = firstLine(b.head_commit?.message ?? b.commits?.[b.commits.length - 1]?.message, 80);
      const force = b.forced ? ' (force)' : '';
      const count = `${n} commit${n === 1 ? '' : 's'}`;
      return `${repo}: ${who} pushed ${count} to ${branch}${force}${msg ? ` — ${msg}` : ''}`;
    }

    case 'pull_request': {
      const pr = b.pull_request;
      const num = pr?.number;
      const title = firstLine(pr?.title);
      let verb = b.action ?? 'updated';
      if (b.action === 'closed') verb = pr?.merged ? 'merged' : 'closed';
      // Skip low-signal sub-actions to avoid flooding the channel.
      if (b.action && ['synchronize', 'labeled', 'unlabeled', 'edited'].includes(b.action)) return null;
      return `${repo}: PR #${num} ${verb} by ${who} — ${title}`;
    }

    case 'pull_request_review': {
      if (b.action !== 'submitted') return null;
      const pr = b.pull_request;
      const state = b.review?.state ?? 'reviewed';
      return `${repo}: ${who} ${state} PR #${pr?.number} — ${firstLine(pr?.title)}`;
    }

    case 'issues': {
      const iss = b.issue;
      if (b.action && ['labeled', 'unlabeled', 'edited', 'assigned', 'unassigned'].includes(b.action)) return null;
      return `${repo}: issue #${iss?.number} ${b.action ?? 'updated'} by ${who} — ${firstLine(iss?.title)}`;
    }

    case 'issue_comment': {
      if (b.action !== 'created') return null;
      const iss = b.issue;
      const kind = iss?.title !== undefined ? 'issue' : 'PR';
      return `${repo}: ${who} commented on ${kind} #${iss?.number} — ${firstLine(b.comment?.body)}`;
    }

    case 'commit_comment':
      return `${repo}: ${who} commented on a commit — ${firstLine(b.comment?.body)}`;

    case 'create':
      return `${repo}: ${who} created ${b.ref_type ?? 'ref'} ${b.ref ?? ''}`.trimEnd();

    case 'delete':
      return `${repo}: ${who} deleted ${b.ref_type ?? 'ref'} ${b.ref ?? ''}`.trimEnd();

    case 'release': {
      if (b.action && !['published', 'released'].includes(b.action)) return null;
      const rel = b.release;
      const tag = rel?.tag_name ?? rel?.name ?? '';
      return `${repo}: ${who} released ${tag}`.trimEnd();
    }

    case 'check_run':
    case 'check_suite':
    case 'workflow_run': {
      const c = b.check_run ?? b.check_suite ?? b.workflow_run;
      // Only surface terminal results — and only failures, to avoid CI flood.
      const conclusion = c?.conclusion;
      if (!conclusion) return null;
      if (conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped') return null;
      const name = b.check_run?.name ?? b.workflow_run?.name ?? eventName;
      return `${repo}: CI ${conclusion} — ${name}`;
    }

    case 'star':
      // Only "created" carries starred_at; "deleted" is an unstar.
      return b.action === 'created' ? `${repo}: ⭐ starred by ${who}` : null;

    case 'fork':
      return `${repo}: forked by ${who}`;

    default: {
      // Generic fallback for any event we don't explicitly model.
      if (!eventName) return null;
      const action = b.action ? ` ${b.action}` : '';
      return `${repo}: ${eventName}${action} by ${who}`;
    }
  }
}
