import { type CSSProperties, type ReactNode } from 'react';

type Justify = 'start' | 'center' | 'end' | 'between';
type Align = 'start' | 'center' | 'end' | 'stretch';

const JUSTIFY: Record<Justify, CSSProperties['justifyContent']> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  between: 'space-between',
};

const ALIGN: Record<Align, CSSProperties['alignItems']> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
};

interface StackProps {
  direction: 'row' | 'column';
  gap?: number;
  justify?: Justify;
  align?: Align;
  wrap?: boolean;
  flex?: number;
  style?: CSSProperties;
  children: ReactNode;
}

function Stack({ direction, gap, justify, align, wrap, flex, style, children }: StackProps): ReactNode {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: direction,
        gap,
        justifyContent: justify ? JUSTIFY[justify] : undefined,
        alignItems: align ? ALIGN[align] : undefined,
        flexWrap: wrap ? 'wrap' : undefined,
        flex,
        minWidth: 0,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export type RowProps = Omit<StackProps, 'direction'>;
export type ColProps = Omit<StackProps, 'direction'>;

export function Row(props: RowProps): ReactNode {
  return <Stack direction="row" {...props} />;
}

export function Col(props: ColProps): ReactNode {
  return <Stack direction="column" {...props} />;
}
