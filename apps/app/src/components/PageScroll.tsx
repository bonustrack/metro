import { type ReactNode, useEffect, useRef } from 'react';
import { StyleSheet, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollView } from 'react-native';
import { Scroll } from '@stage-labs/kit/react-native/scroll';
import { notePageOffset, setPageScroller } from '../lib/page-scroll.js';

const styles = StyleSheet.create({ fill: { flex: 1 }, content: { flexGrow: 1 } });

const SCROLL_EVENTS_MS = 64;

const noteScroll = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
  notePageOffset(event.nativeEvent.contentOffset.y);
};

export function PageScroll({ children }: { children: ReactNode }): ReactNode {
  const ref = useRef<ScrollView>(null);
  useEffect(() => {
    setPageScroller(() => {
      ref.current?.scrollTo({ y: 0, animated: true });
    });
    return () => {
      setPageScroller(null);
    };
  }, []);
  return (
    <Scroll ref={ref} style={styles.fill} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" onScroll={noteScroll} scrollEventThrottle={SCROLL_EVENTS_MS}>
      {children}
    </Scroll>
  );
}
