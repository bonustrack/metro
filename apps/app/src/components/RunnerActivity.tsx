import type { ReactNode } from 'react';
import { Text } from '@stage-labs/kit/react-native/text';
import type { ClaudeSessionStatus } from '@metro-labs/client/api/claude-box';
import { activityView, sessionPollMs } from '@metro-labs/client/api/runner-activity';
import { SettingsPad, SettingsSection } from './SettingsSection.js';
import { Disclosure } from './ui/Disclosure.js';

const WORKERS = 'Workers and background tasks, active ones first. The last 30 only.';
const STOP = 'Stop cancels the session and its workers without waiting.';

function RecentInputs({ inputs }: { inputs: ReturnType<typeof activityView>['inputs'] | undefined }): ReactNode {
  if (inputs === undefined) return null;
  return <SettingsPad>
    <Text size="xs" weight="medium">Recent inputs</Text>
    <Text size="md" role="secondary">The last 40 inputs. Output may be a tool call, not a sent reply.</Text>
    {inputs.length === 0 ? <Text size="md" role="secondary">None reported.</Text> : inputs.map((input) => (
      <Disclosure key={input.id} summary={input.summary} body={input.details} />
    ))}
  </SettingsPad>;
}

export function RunnerActivity({ status, now, live }: { status: ClaudeSessionStatus; now: number; live: boolean }): ReactNode {
  const activity = status.activity;
  if (activity === null) return <SettingsSection title="Agent SDK activity" note="No activity reported.">{null}</SettingsSection>;
  const view = activityView(status, activity, now);
  const polling = `Checked every ${sessionPollMs(status, live) / 1_000} s while this page is open.`;
  return (
    <>
      <SettingsSection title="Agent SDK activity" note={`${view.note} ${polling}`}>
        <Text size="md" role={view.mode === 'stale' || activity.mainPhase === 'error' ? 'danger' : 'secondary'}>{view.main}</Text>
        <Text size="md" role="secondary">{view.tools}</Text>
        <Text size="md" role="secondary">Pending messages: {String(activity.pending)} · Active workers at report: {String(activity.workers)} · Approvals: {String(activity.approvals)}</Text>
        {[view.queue, view.call].map((text) => text === null ? null : <Text key={text} size="md" role="secondary">{text}</Text>)}
        <Text size="md" role="secondary">Session: {activity.sessionId ?? 'Not reported yet'}</Text>
        {view.failures.map((failure) => <Text key={failure.text} size="md" role={failure.danger ? 'danger' : 'secondary'}>{failure.text}</Text>)}
      </SettingsSection>
      <SettingsPad>
        <Text size="xs" weight="medium">Workers</Text>
        <Text size="md" role="secondary">{WORKERS} Active includes running, waiting and paused workers.</Text>
        {status.running && !status.legacyRunner ? <Text size="md" role="secondary">{STOP}</Text> : null}
        {view.workers.length === 0 ? <Text size="md" role="secondary">None reported.</Text> : view.workers.map((worker) => (
          <Disclosure key={worker.id} summary={worker.summary} body={worker.details} danger={worker.danger} />
        ))}
      </SettingsPad>
      <RecentInputs inputs={activity.inputs === undefined ? undefined : view.inputs} />
      <SettingsPad>
        <Text size="xs" weight="medium">Recent activity</Text>
        <Text size="md" role="secondary">Up to 40 recent events, newest first, calls included.</Text>
        <Text size="md" role="secondary">Names, states and times only, no prompts or tool data. A restart clears this list.</Text>
        {view.events.length === 0 ? <Text size="md" role="secondary">None reported.</Text> : (
          <Disclosure summary={`Show ${view.events.length} recent events`} body={view.events.join('\n')} />
        )}
      </SettingsPad>
    </>
  );
}
