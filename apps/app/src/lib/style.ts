import { Platform, type TextStyle, type ViewStyle } from 'react-native';

export const SHRINK = { flexShrink: 1, minWidth: 0 } as const;

export const GROW = { flexGrow: 1, minWidth: 0 } as const;

export const CENTER_TEXT: TextStyle = { textAlign: 'center' };

export const FULL_WIDTH: ViewStyle = { alignSelf: 'stretch' };

export const WEB = Platform.OS === 'web';

type WebStyle = Record<string, string | number | undefined>;

export const css = (style: WebStyle): ViewStyle => style;

export const webOnly = (style: WebStyle): ViewStyle => (WEB ? css(style) : {});


export const ABSOLUTE_FILL = { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } as const;
