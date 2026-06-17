/**
 * GitHub webhook → message formatting matrix. `formatGitHubEvent` is pure: it
 * maps (event name, body) → a concise one-liner, or null for events we drop.
 */

import { describe, expect, test } from 'bun:test';
import { formatGitHubEvent, githubFrom, GITHUB_FROM_NAME } from '../src/github-webhook.ts';

const repo = { full_name: 'bonustrack/metro' };
const sender = { login: 'less' };

describe('synthetic github account', () => {
  test('participant URI + display name', () => {
    expect(githubFrom()).toBe('metro://github/user/github');
    expect(GITHUB_FROM_NAME).toBe('github');
  });
});

describe('formatGitHubEvent', () => {
  test('push: count + branch + head commit subject', () => {
    expect(formatGitHubEvent('push', {
      repository: repo, sender, ref: 'refs/heads/main',
      commits: [{ message: 'a' }, { message: 'b' }],
      head_commit: { message: 'fix: the thing\n\ndetails' },
    })).toBe('bonustrack/metro: less pushed 2 commits to main — fix: the thing');
  });

  test('push: single commit, force', () => {
    expect(formatGitHubEvent('push', {
      repository: repo, pusher: { name: 'bot' }, ref: 'refs/heads/dev', forced: true,
      commits: [{ message: 'rebased' }], head_commit: { message: 'rebased' },
    })).toBe('bonustrack/metro: bot pushed 1 commit to dev (force) — rebased');
  });

  test('pull_request opened', () => {
    expect(formatGitHubEvent('pull_request', {
      action: 'opened', repository: repo, sender,
      pull_request: { number: 42, title: 'Add feature' },
    })).toBe('bonustrack/metro: PR #42 opened by less — Add feature');
  });

  test('pull_request closed-merged ⇒ "merged"', () => {
    expect(formatGitHubEvent('pull_request', {
      action: 'closed', repository: repo, sender,
      pull_request: { number: 42, title: 'Add feature', merged: true },
    })).toBe('bonustrack/metro: PR #42 merged by less — Add feature');
  });

  test('pull_request closed-unmerged ⇒ "closed"', () => {
    expect(formatGitHubEvent('pull_request', {
      action: 'closed', repository: repo, sender,
      pull_request: { number: 7, title: 'Nope', merged: false },
    })).toBe('bonustrack/metro: PR #7 closed by less — Nope');
  });

  test('pull_request synchronize ⇒ null (low signal)', () => {
    expect(formatGitHubEvent('pull_request', {
      action: 'synchronize', repository: repo, sender, pull_request: { number: 1, title: 'x' },
    })).toBeNull();
  });

  test('issues opened', () => {
    expect(formatGitHubEvent('issues', {
      action: 'opened', repository: repo, sender, issue: { number: 99, title: 'Bug report' },
    })).toBe('bonustrack/metro: issue #99 opened by less — Bug report');
  });

  test('issue_comment created', () => {
    expect(formatGitHubEvent('issue_comment', {
      action: 'created', repository: repo, sender,
      issue: { number: 99, title: 'Bug' }, comment: { body: 'I can repro this\nmore' },
    })).toBe('bonustrack/metro: less commented on issue #99 — I can repro this');
  });

  test('issue_comment edited ⇒ null', () => {
    expect(formatGitHubEvent('issue_comment', {
      action: 'edited', repository: repo, sender, issue: { number: 1 }, comment: { body: 'x' },
    })).toBeNull();
  });

  test('pull_request_review submitted', () => {
    expect(formatGitHubEvent('pull_request_review', {
      action: 'submitted', repository: repo, sender,
      review: { state: 'approved' }, pull_request: { number: 5, title: 'Ship it' },
    })).toBe('bonustrack/metro: less approved PR #5 — Ship it');
  });

  test('release published', () => {
    expect(formatGitHubEvent('release', {
      action: 'published', repository: repo, sender, release: { tag_name: 'v1.2.0' },
    })).toBe('bonustrack/metro: less released v1.2.0');
  });

  test('check_run failure surfaces', () => {
    expect(formatGitHubEvent('check_run', {
      repository: repo, check_run: { name: 'lint', conclusion: 'failure' },
    })).toBe('bonustrack/metro: CI failure — lint');
  });

  test('check_run success ⇒ null (no CI flood)', () => {
    expect(formatGitHubEvent('check_run', {
      repository: repo, check_run: { name: 'lint', conclusion: 'success' },
    })).toBeNull();
  });

  test('workflow_run in-progress (no conclusion) ⇒ null', () => {
    expect(formatGitHubEvent('workflow_run', {
      repository: repo, workflow_run: { name: 'ci', status: 'in_progress' },
    })).toBeNull();
  });

  test('create branch', () => {
    expect(formatGitHubEvent('create', {
      repository: repo, sender, ref_type: 'branch', ref: 'feat/x',
    })).toBe('bonustrack/metro: less created branch feat/x');
  });

  test('star created', () => {
    expect(formatGitHubEvent('star', { action: 'created', repository: repo, sender }))
      .toBe('bonustrack/metro: ⭐ starred by less');
  });

  test('star deleted ⇒ null', () => {
    expect(formatGitHubEvent('star', { action: 'deleted', repository: repo, sender })).toBeNull();
  });

  test('ping ⇒ null', () => {
    expect(formatGitHubEvent('ping', { zen: 'keep it simple' })).toBeNull();
  });

  test('unknown event ⇒ generic fallback', () => {
    expect(formatGitHubEvent('deployment', { action: 'created', repository: repo, sender }))
      .toBe('bonustrack/metro: deployment created by less');
  });

  test('missing repo/sender ⇒ safe defaults', () => {
    expect(formatGitHubEvent('push', { ref: 'refs/heads/main', commits: [], head_commit: null }))
      .toBe('repo: someone updated main');
  });
});
