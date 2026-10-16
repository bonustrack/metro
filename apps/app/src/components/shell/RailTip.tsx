import { hideRailTip, showRailTip } from '../../lib/rail-tip-store.js';

const GAP = 10;

export interface TipHandlers {
  onHoverIn: (event: { currentTarget: unknown }) => void;
  onHoverOut: () => void;
}

const isElement = (node: unknown): node is HTMLElement => typeof HTMLElement !== 'undefined' && node instanceof HTMLElement;

export function railTip(label: string, shortcut?: string): TipHandlers {
  return {
    onHoverIn: (event) => {
      if (!isElement(event.currentTarget)) return;
      const rect = event.currentTarget.getBoundingClientRect();
      showRailTip({ label, ...(shortcut === undefined ? {} : { shortcut }), left: rect.right + GAP, centerY: rect.top + rect.height / 2 });
    },
    onHoverOut: hideRailTip,
  };
}

export { hideRailTip };
