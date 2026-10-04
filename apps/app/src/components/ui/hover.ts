import { useState } from 'react';

export interface HoverHandlers {
  onHoverIn: () => void;
  onHoverOut: () => void;
}

export function useHover(): [boolean, HoverHandlers] {
  const [hovered, setHovered] = useState(false);
  return [
    hovered,
    {
      onHoverIn: () => {
        setHovered(true);
      },
      onHoverOut: () => {
        setHovered(false);
      },
    },
  ];
}
