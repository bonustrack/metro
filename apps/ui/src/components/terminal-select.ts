export interface Press {
  isTrusted: boolean;
  button: number;
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

export const plainPress = (press: Press): boolean =>
  press.isTrusted && press.button === 0 && !press.altKey && !press.shiftKey && !press.ctrlKey && !press.metaKey;

export function forcedInit(event: MouseEvent): MouseEventInit {
  return {
    bubbles: true,
    cancelable: true,
    detail: event.detail,
    clientX: event.clientX,
    clientY: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
    button: 0,
    buttons: event.buttons,
    altKey: true,
    shiftKey: true,
  };
}

export function keepSelectionLocal(box: HTMLElement): () => void {
  const onDown = (event: MouseEvent): void => {
    if (!plainPress(event)) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    event.target?.dispatchEvent(new MouseEvent('mousedown', forcedInit(event)));
  };
  box.addEventListener('mousedown', onDown, true);
  return () => {
    box.removeEventListener('mousedown', onDown, true);
  };
}

export function copyOnRelease(box: HTMLElement, selection: () => string): () => void {
  const onUp = (): void => {
    setTimeout(() => {
      const text = selection();
      if (text !== '') navigator.clipboard.writeText(text).catch(() => undefined);
    }, 0);
  };
  box.addEventListener('mouseup', onUp);
  return () => {
    box.removeEventListener('mouseup', onUp);
  };
}
