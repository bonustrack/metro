import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Box, Col } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui.js';
import { currentBuild, type BuildInfo } from '../build.js';

const DOT = 8;
const CARD_RADIUS = 8;

function Card({ build }: { build: BuildInfo }): ReactNode {
  const palette = useKitPalette();
  const side = { width: 1, color: palette.border };
  const head = build.relative === '' ? build.sha : `${build.sha} · ${build.relative}`;
  return (
    <a className="build-dot-card" href={build.href ?? undefined} target="_blank" rel="noreferrer">
      <Col
        gap={2}
        padding={{ x: 10, y: 7 }}
        radius={CARD_RADIUS}
        surface="raised"
        border={{ top: side, right: side, bottom: side, left: side }}
      >
        <Text size="sm" weight="medium">
          {head}
        </Text>
        {build.time === '' ? null : (
          <Text size="sm" role="secondary">
            {build.time}
          </Text>
        )}
      </Col>
    </a>
  );
}

export function BuildDot(): ReactNode {
  const palette = useKitPalette();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const build = currentBuild();
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent): void => {
      if (box.current !== null && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div className="build-dot" ref={box}>
      {open ? <Card build={build} /> : null}
      <button
        type="button"
        className="build-dot-toggle"
        aria-label={`Build ${build.sha}`}
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        <Box width={DOT} height={DOT} radius={DOT} background={build.fresh ? palette.text : palette.sub} />
      </button>
    </div>
  );
}
