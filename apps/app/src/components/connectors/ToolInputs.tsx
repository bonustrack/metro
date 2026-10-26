import { type ReactNode } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { side } from '../ui/edges.js';
import { toolInputs, type ToolInput } from '../../lib/connector-inputs.js';
import { useIsNarrow } from '../../lib/media.js';
import { MONO } from '../../lib/style.js';

const NAME = 3;
const TYPE = 1.2;
const NEEDED = 1;
const ABOUT = 4;

function Required({ input }: { input: ToolInput }): ReactNode {
  return input.required ? (
    <Text size="xs" fontWeight="semibold">
      Required
    </Text>
  ) : (
    <Text size="xs" color="secondary">
      Optional
    </Text>
  );
}

function WideRow({ input, header = false }: { input: ToolInput; header?: boolean }): ReactNode {
  const palette = useKitPalette();
  return (
    <Row align="start" gap={16} padding={{ y: 10 }} border={{ bottom: side(palette.border) }}>
      <Column weight={NAME} minWidth={0}>
        <Text size="xs" color={header ? 'secondary' : undefined} style={header ? undefined : MONO}>
          {input.name}
        </Text>
      </Column>
      <Column weight={TYPE} minWidth={0}>
        <Text size="xs" color="secondary">
          {input.type}
        </Text>
      </Column>
      <Column weight={NEEDED} minWidth={0}>
        {header ? (
          <Text size="xs" color="secondary">
            Required
          </Text>
        ) : (
          <Required input={input} />
        )}
      </Column>
      <Column weight={ABOUT} minWidth={0}>
        <Text size="xs" color={header ? 'secondary' : undefined}>
          {input.description}
        </Text>
      </Column>
    </Row>
  );
}

function NarrowRow({ input }: { input: ToolInput }): ReactNode {
  const palette = useKitPalette();
  return (
    <Column gap={4} padding={{ y: 10 }} border={{ bottom: side(palette.border) }}>
      <Text size="sm" style={MONO}>
        {input.name}
      </Text>
      <Row gap={8} align="center">
        <Text size="xs" color="secondary">
          {input.type}
        </Text>
        <Required input={input} />
      </Row>
      {input.description === '' ? null : <Text size="xs">{input.description}</Text>}
    </Column>
  );
}

const HEADER: ToolInput = { name: 'Name', type: 'Type', required: false, description: 'Description' };

export function ToolInputs({ schema }: { schema: Record<string, unknown> | null }): ReactNode {
  const narrow = useIsNarrow();
  if (schema === null) return null;
  const inputs = toolInputs(schema);
  return (
    <Column gap={8}>
      <Text size="xs" color="secondary">
        Inputs
      </Text>
      {inputs.length === 0 ? (
        <Text size="md" color="secondary">
          It takes no inputs.
        </Text>
      ) : (
        <Column>
          {narrow ? null : <WideRow input={HEADER} header />}
          {inputs.map((input) => (narrow ? <NarrowRow key={input.name} input={input} /> : <WideRow key={input.name} input={input} />))}
        </Column>
      )}
    </Column>
  );
}
