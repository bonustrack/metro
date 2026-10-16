import { Platform, type TextStyle, type ViewStyle } from 'react-native';

export const SHRINK = { flexShrink: 1, minWidth: 0 } as const;

export const GROW = { flexGrow: 1, minWidth: 0 } as const;

export const CENTER_TEXT: TextStyle = { textAlign: 'center' };

export const FULL_WIDTH: ViewStyle = { alignSelf: 'stretch' };

export const WEB = Platform.OS === 'web';

export const MONO: TextStyle = { fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' }) };

type WebStyle = Record<string, string | number | undefined>;

export const css = (style: WebStyle): ViewStyle => style;

export const webOnly = (style: WebStyle): ViewStyle => (WEB ? css(style) : {});
