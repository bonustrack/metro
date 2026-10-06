import { useEffect, useState } from 'react';
import { accountScopeIdentity, subscribeAccountScope } from '@metro-labs/client/auth/account';
import { DashboardPoll, initialDashboard } from '@metro-labs/client/api/dashboard-poll';
import { dashboardSource } from '@metro-labs/client/api/dashboard-source';
import type { DashboardState } from '@metro-labs/client/api/dashboard';

export function useAllAgents(): DashboardState {
  const [scope, setScope] = useState(accountScopeIdentity);
  const [result, setResult] = useState(() => ({ scope, state: initialDashboard() }));
  useEffect(() => subscribeAccountScope(() => { setScope(accountScopeIdentity()); }), []);
  useEffect(() => {
    let alive = true;
    const poll = new DashboardPoll(dashboardSource(scope, () => alive), (state) => { setResult({ scope, state }); });
    const unsubscribe = subscribeAccountScope(() => { alive = false; poll.stop(); });
    poll.start();
    return () => { alive = false; unsubscribe(); poll.stop(); };
  }, [scope]);
  return result.scope === scope ? result.state : initialDashboard();
}
