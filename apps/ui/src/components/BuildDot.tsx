import { type ReactNode, useState } from 'react';
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
  const build = currentBuild();
  return (
    <div className="build-dot">
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
