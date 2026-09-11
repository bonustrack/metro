import { type ReactNode, useEffect, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { Modal } from './Modal.js';
import { bootLog } from '../aws/launch.js';
import { metroSetupLines, type BootLog as Parsed } from '../aws/boot-log.js';
import { launches, readAwsSettings } from '../aws/settings.js';
import { whenLabel } from '../api/when.js';
import type { Server } from '../api/servers.js';
import { serverLabel } from '../api/servers.js';

interface Shown {
  parsed: Parsed;
  at: string | null;
}

function summary(shown: Shown): string {
  const when = shown.at === null ? '' : ` Console captured ${whenLabel(shown.at)}; AWS refreshes it every few minutes.`;
  if (!shown.parsed.started) return `The first-boot script has not printed anything yet.${when}`;
  if (shown.parsed.done) return `The first-boot script finished.${when}`;
  return `The first-boot script is still running, or stopped at the last line shown.${when}`;
}

function useBootLog(server: Server | null): { shown: Shown | null; error: string | null; busy: boolean; refresh: () => void } {
  const [shown, setShown] = useState<Shown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const host = server?.host ?? null;
  useEffect(() => {
    if (host === null) return;
    const launch = launches()[host];
    const settings = readAwsSettings();
    if (launch === undefined) {
      setError('This server was not launched from this browser, so there is no instance to read.');
      return;
    }
    if (settings === null) {
      setError('No AWS key is kept in this browser.');
      return;
    }
    let live = true;
    setBusy(true);
    setError(null);
    bootLog(settings, launch)
      .then((output) => {
        if (live) setShown({ parsed: metroSetupLines(output.text), at: output.at });
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
  }, [host, tick]);
  return {
    shown,
    error,
    busy,
    refresh: () => {
      setTick((n) => n + 1);
    },
  };
}

export function BootLog({ server, onClose }: { server: Server | null; onClose: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { shown, error, busy, refresh } = useBootLog(server);
  return (
    <Modal title={server === null ? 'Boot log' : `Boot log of ${serverLabel(server)}`} open={server !== null} onClose={onClose}>
      <Col gap={12}>
        <Text size="sm" role="secondary">
          {shown === null ? 'Reading the instance console from AWS…' : summary(shown)}
        </Text>
        {error === null ? null : (
          <Text size="sm" role="danger">{error}</Text>
        )}
        {shown === null ? null : (
          <div className="boot-log">
            {shown.parsed.lines.map((line, index) => (
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
