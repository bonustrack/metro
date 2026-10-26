import { type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { Row } from '@stage-labs/kit/react-native/row';
import { dollarsWords } from '@metro-labs/client/api/gateway-usage';
import { Group } from '../ui/Group.js';
import { RouteLink } from '../RouteLink.js';
import { CallSparkline } from '../activity/CallSparkline.js';
import { Figure, SectionLink } from './SectionParts.js';
import { countWords, failedAlarm, percentWords, rangeWords } from '../../lib/call-stats.js';
import { chartTitle, secondsWords, usageMeasure, usageSummary } from '../../lib/gateway-usage.js';
import { useGatewayUsage } from '../../lib/gateway-usage-query.js';

const LABEL = 'Gateway';
const RANGE = '7d';

const styles = StyleSheet.create({
  week: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 24, paddingVertical: 14 },
});

export function GatewayActivity({ agent, href }: { agent: string; href: string }): ReactNode {
  const usage = useGatewayUsage({ range: RANGE, agent }).data;
  if (usage === undefined || usage === null) return null;
  const { calls, failed, spendMicros, p50FirstTokenMs } = usage.totals;
  if (calls === 0)
    return (
      <Group label={LABEL} note={`No model calls ${rangeWords(RANGE)}.`} wide>
        {null}
      </Group>
    );
  const measure = usageMeasure(usage);
  const values = usage.buckets.map((bucket) => (measure === 'spend' ? bucket.spendMicros : bucket.calls));
  return (
    <Group label={LABEL} wide action={<SectionLink to={href} label="Show all" />}>
      <RouteLink to={href} label={`${usageSummary(usage)}. Open the gateway usage of this agent.`} style={styles.week}>
        <Figure label="Spend, 7 days" value={dollarsWords(spendMicros)} />
        <Figure label="Model calls" value={countWords(calls)} />
        <Figure label="Failed" value={percentWords(failed, calls)} danger={failedAlarm(failed, calls)} />
        <Figure label="First token" value={secondsWords(p50FirstTokenMs)} />
        <Row weight={1} justify="end">
          <CallSparkline values={values} label={`${chartTitle(measure, RANGE)} ${rangeWords(RANGE)}`} />
        </Row>
      </RouteLink>
    </Group>
  );
}
