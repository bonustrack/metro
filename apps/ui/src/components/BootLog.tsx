import { type ReactNode, useEffect, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { Modal } from './Modal.js';
import { fetchBootView, type BootView } from '../api/launch.js';
import { whenLabel } from '../api/when.js';
import type { Server } from '../api/servers.js';
import { serverLabel } from '../api/servers.js';

function summary(view: BootView): string {
  const when = view.at === null ? '' : ` Console captured ${whenLabel(view.at)}; AWS refreshes it every few minutes.`;
  if (view.lines.length === 0) return `The first-boot script has not printed anything yet.${when}`;
  if (view.finished) return `The first-boot script finished.${when}`;
  return `The first-boot script is still running, or stopped at the last line shown.${when}`;
}

function useBootLog(server: Server | null): { view: BootView | null; error: string | null; busy: boolean; refresh: () => void } {
  const [view, setView] = useState<BootView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const id = server?.id ?? null;
  const launched = server?.instanceId ?? null;
  useEffect(() => {
    if (id === null) return;
    if (launched === null) {
      setError('Metro did not issue this server, so there is no instance to read.');
      return;
    }
    let live = true;
    setBusy(true);
    setError(null);
    fetchBootView(id)
      .then((next) => {
        if (live) setView(next);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : 'Could not read the boot log.');
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [id, launched, tick]);
  return {
    view,
    error,
    busy,
    refresh: () => {
      setTick((n) => n + 1);
    },
  };
}

export function BootLog({ server, onClose }: { server: Server | null; onClose: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { view, error, busy, refresh } = useBootLog(server);
  return (
    <Modal title={server === null ? 'Boot log' : `Boot log of ${serverLabel(server)}`} open={server !== null} onClose={onClose}>
      <Col gap={12}>
        <Text size="sm" role="secondary">
          {view === null ? 'Reading the instance console from AWS…' : summary(view)}
        </Text>
        {error === null ? null : (
          <Text size="sm" role="danger">{error}</Text>
        )}
        {view === null ? null : (
          <div className="boot-log">
            {view.lines.map((line, index) => (
              <div key={`${String(index)}-${line.slice(0, 16)}`}>{line}</div>
            ))}
          </div>
        )}
        <Row justify="end" gap={10}>
          <Button size="sm" color="secondary" dark={dark} label="Refresh" loading={busy} disabled={busy} onPress={refresh} />
          <Button size="sm" color="primary" dark={dark} label="Close" onPress={onClose} />
        </Row>
      </Col>
    </Modal>
  );
}
