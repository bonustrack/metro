import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));

const check = `
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { cloneElement, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const platform = process.env.TEST_PLATFORM;
const routed = [];
const pressables = [];
function Pressable(props) {
  pressables.push(props);
  return createElement('a', { href: props.href }, props.children);
}
function Link({ href, onPress, children }) {
  const linkTo = (event) => {
    onPress?.(event);
    if (event.defaultPrevented) return;
    event.preventDefault();
    routed.push(href);
  };
  const slot = platform === 'web' ? { onPress, onClick: linkTo } : { onPress: linkTo };
  return cloneElement(children, { href: '/#' + href, role: 'link', ...slot });
}
mock.module('react-native', () => ({ Platform: { OS: platform }, Pressable, StyleSheet: { flatten: (style) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean)) } }));
mock.module('expo-router', () => ({ Link, router: { push: () => undefined, replace: () => undefined } }));
mock.module('expo/fetch', () => ({ fetch: globalThis.fetch }));

const { RouteLink } = await import('./src/components/RouteLink.tsx');

const click = () => {
  const event = { defaultPrevented: false, preventDefault() { event.defaultPrevented = true; } };
  return event;
};
const press = (props) => {
  pressables.length = 0;
  renderToStaticMarkup(createElement(RouteLink, { label: 'Connectors', ...props }, 'Connectors'));
  assert.equal(pressables.length, 1);
  const [pressable] = pressables;
  assert.equal(pressable.onClick, undefined);
  assert.equal(pressable.href, '/#/anderra/organization/connectors');
  const event = click();
  pressable.onPress(event);
  return event;
};

const plain = press({ to: '#/anderra/organization/connectors' });
assert.equal(plain.defaultPrevented, true);
assert.deepEqual(routed, ['/anderra/organization/connectors']);

const seen = [];
press({ to: '#/anderra/organization/connectors', onPress: (event) => { seen.push('own'); event.preventDefault(); } });
assert.deepEqual(seen, ['own']);
assert.deepEqual(routed, ['/anderra/organization/connectors']);

pressables.length = 0;
renderToStaticMarkup(createElement(RouteLink, { to: '#/anderra', label: 'Agents', disabled: true }, 'Agents'));
assert.equal(pressables[0].disabled, true);
assert.equal(pressables[0].href, undefined);
`;

test.each(['web', 'android'])('%s: a press on a RouteLink goes through the router, never the browser following the href', (platform) => {
  const result = Bun.spawnSync([process.execPath, '--eval', check], {
    cwd,
    env: { ...process.env, TEST_PLATFORM: platform },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
  });
  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);
});
