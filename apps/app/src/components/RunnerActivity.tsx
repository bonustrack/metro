import type { ReactNode } from 'react';
import { Text } from '@stage-labs/kit/react-native/text';
import type { ClaudeSessionStatus } from '@metro-labs/client/api/claude-box';
import { activityView, sessionPollMs } from '@metro-labs/client/api/runner-activity';
import { SettingsPad, SettingsSection } from './SettingsSection.js';
import { Disclosure } from './ui/Disclosure.js';

const SUPPORT = 'Only the Agent SDK runner reports activity. Claude Code sessions and voice calls do not.';
const WORKERS = 'Subagents and background tasks, active at report first. Up to 30 recent rows, not a full history.';
const STOP = 'Stop cancels the session and its workers. It does not wait for work to finish.';

export function RunnerActivity({ status, now, live }: { status: ClaudeSessionStatus; now: number; live: boolean }): ReactNode {
  const activity = status.activity;
  if (activity === null) return <SettingsSection title="Agent SDK activity" note={`No activity reported. ${SUPPORT}`}>{null}</SettingsSection>;
  const view = activityView(status, activity, now);
  const polling = `Checked every ${sessionPollMs(status, live) / 1_000} s while this page is open (polled, not pushed).`;
  return (
    <>
      <SettingsSection title="Agent SDK activity" note={`${view.note} ${polling}`}>
        <Text size="2xs" role={view.mode === 'stale' || activity.mainPhase === 'error' ? 'danger' : 'secondary'}>{view.main}</Text>
        <Text size="2xs" role="secondary">{view.tools}</Text>
        <Text size="2xs" role="secondary">Pending messages: {String(activity.pending)} · Active workers at report: {String(activity.workers)} · Approvals: {String(activity.approvals)}</Text>
        <Text size="2xs" role="secondary">Session: {activity.sessionId ?? 'Not reported yet'}</Text>
        {view.failures.map((failure) => <Text key={failure.text} size="2xs" role={failure.danger ? 'danger' : 'secondary'}>{failure.text}</Text>)}
      </SettingsSection>
      <SettingsPad>
        <Text size="xs" weight="medium">Workers</Text>
        <Text size="2xs" role="secondary">{WORKERS} Active includes running, waiting and paused workers.</Text>
        {status.running && status.runner !== 'cli' ? <Text size="2xs" role="secondary">{STOP}</Text> : null}
        {view.workers.length === 0 ? <Text size="2xs" role="secondary">None reported.</Text> : view.workers.map((worker) => (
          <Disclosure key={worker.id} summary={worker.summary} body={worker.details} danger={worker.danger} />
        ))}
      </SettingsPad>
      <SettingsPad>
        <Text size="xs" weight="medium">Recent activity</Text>
        <Text size="2xs" role="secondary">Up to 40 recent events, newest first. {SUPPORT}</Text>
        <Text size="2xs" role="secondary">Names, states and timings only. No prompts, descriptions or tool input and output. Workers are not recovered here after a restart.</Text>
        {view.events.length === 0 ? <Text size="2xs" role="secondary">None reported.</Text> : (
          <Disclosure summary={`Show ${view.events.length} recent events`} body={view.events.join('\n')} />
        )}
      </SettingsPad>
    </>
  );
}
