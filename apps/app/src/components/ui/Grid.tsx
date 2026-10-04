import { Children, type ReactNode, useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';

interface GridProps {
  min: number;
  gap: number;
  children: ReactNode;
}

const ROW = { flexDirection: 'row', flexWrap: 'wrap' } as const;

export function columnsFor(width: number, min: number, gap: number): number {
  return Math.max(1, Math.floor((width + gap) / (min + gap)));
}

export function Grid({ min, gap, children }: GridProps): ReactNode {
  const [width, setWidth] = useState(0);
  const items = Children.toArray(children);
  const columns = columnsFor(width, min, gap);
  const cell = width === 0 ? min : (width - gap * (columns - 1)) / columns;
  const onLayout = (e: LayoutChangeEvent): void => {
    setWidth(e.nativeEvent.layout.width);
  };
  const layout = { ...ROW, gap };
  const box = { width: cell, minWidth: 0 };
  return (
    <View style={layout} onLayout={onLayout}>
      {items.map((item, index) => (
        <View key={index} style={box}>
          {item}
        </View>
      ))}
    </View>
  );
}
