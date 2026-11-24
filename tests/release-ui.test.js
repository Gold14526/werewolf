import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../web/release.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

async function frontend({ current = 'release-a', published = { id: 'release-a' }, abortSignal = AbortSignal } = {}) {
  const calls = [], navigations = [], timers = [], documentEvents = new Map(), windowEvents = new Map();
  let now = 1000000, manifest = published;
  function element(tagName) {
    return { tagName, style: {}, attributes: new Map(), events: new Map(), children: [],
      setAttribute(name, value) { this.attributes.set(name, value); },
      addEventListener(name, handler) { this.events.set(name, handler); },
      append(...children) { this.children.push(...children); for (const child of children) child.parent = this; },
      remove() { this.parent.children = this.parent.children.filter(child => child !== this); },
    };
  }
  const document = { visibilityState: 'visible', body: element('body'), createElement: element,
    querySelector: selector => selector === 'meta[name="moonwolf-release"]' && current ? { content: current } : null,
    addEventListener: (name, handler) => documentEvents.set(name, handler),
  };
  const location = { href: 'https://gold14526.github.io/werewolf/?room=123456&theme=light#discussion',
    replace: url => navigations.push(url) };
  vm.runInNewContext(source, {
    document, location, URL, AbortSignal: abortSignal, Date: { now: () => now },
    window: { addEventListener: (name, handler) => windowEvents.set(name, handler) },
    setInterval: (handler, milliseconds) => timers.push({ handler, milliseconds }),
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (manifest instanceof Error) throw manifest;
      return { ok: true, json: async () => manifest };
    },
  }, { filename: 'release.js' });
  await settle();
  return { calls, navigations, timers, document, location,
    notice: () => document.body.children.find(child => child.id === 'release-notice'),
    publish: value => { manifest = value; },
    advance: milliseconds => { now += milliseconds; },
    async focus() { await windowEvents.get('focus')?.(); },
    async visibility(value) { document.visibilityState = value; await documentEvents.get('visibilitychange')?.(); },
    async tick() { for (const timer of timers) await timer.handler(); },
  };
}

test('release checks use a fixed same-origin no-store manifest and equal releases stay silent', async () => {
  const ui = await frontend();
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.calls[0].url, 'https://gold14526.github.io/werewolf/release.json');
  assert.equal(ui.calls[0].options.cache, 'no-store');
  assert.equal(ui.calls[0].options.credentials, 'same-origin');
  assert.equal(ui.timers[0].milliseconds, 5 * 60 * 1000);
  assert.equal(ui.notice(), undefined);
  assert.deepEqual(ui.navigations, []);
});

test('unbuilt pages with no known release do not fetch or suggest an unknown update', async () => {
  const ui = await frontend({ current: null, published: { id: 'release-b' } });
  assert.equal(ui.calls.length, 0);
  assert.equal(ui.timers.length, 0);
  assert.equal(ui.notice(), undefined);
});

test('release checks still work in browsers without AbortSignal.timeout', async () => {
  for (const abortSignal of [{}, null]) {
    const ui = await frontend({ published: { id: 'release-b' }, abortSignal });
    assert.equal(ui.calls.length, 1);
    assert.equal(ui.calls[0].options.signal, undefined);
    assert.ok(ui.notice());
    assert.deepEqual(ui.navigations, []);
  }
});

test('a different published release offers one polite notice without reloading the game', async () => {
  const ui = await frontend({ published: { id: 'release-b' } });
  const notice = ui.notice();
  assert.equal(notice.attributes.get('role'), 'status');
  assert.equal(notice.attributes.get('aria-live'), 'polite');
  assert.deepEqual(notice.children.map(child => child.textContent), ['网页有新版，', '刷新', '稍后']);
  ui.advance(5 * 60 * 1000);
  await ui.tick();
  assert.equal(ui.notice(), notice);
  assert.equal(ui.document.body.children.length, 1);
  assert.deepEqual(ui.navigations, []);
});

test('focus and visibility checks are throttled and hidden tabs do not poll', async () => {
  const ui = await frontend();
  await ui.focus();
  await ui.visibility('visible');
  assert.equal(ui.calls.length, 1);
  await ui.visibility('hidden');
  ui.advance(5 * 60 * 1000);
  await ui.tick();
  assert.equal(ui.calls.length, 1);
  await ui.visibility('visible');
  assert.equal(ui.calls.length, 2);
  await ui.focus();
  assert.equal(ui.calls.length, 2);
});

test('only a manual refresh navigates, preserving the room, other query values and hash', async () => {
  const ui = await frontend({ published: { id: 'release-b' } });
  let stopped = false;
  const refresh = ui.notice().children.find(child => child.textContent === '刷新');
  assert.equal(refresh.type, 'button');
  refresh.events.get('click')({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true, 'refresh must not bubble into the game button handler');
  assert.equal(ui.navigations.length, 1);
  const target = new URL(ui.navigations[0]);
  assert.equal(target.origin, new URL(ui.location.href).origin);
  assert.equal(target.pathname, '/werewolf/');
  assert.equal(target.searchParams.get('room'), '123456');
  assert.equal(target.searchParams.get('theme'), 'light');
  assert.equal(target.hash, '#discussion');
  assert.ok(target.searchParams.get('__moonwolf_refresh'));
  assert.notEqual(target.href, ui.location.href);
});

test('稍后 suppresses that release until another published release appears', async () => {
  const ui = await frontend({ published: { id: 'release-b' } });
  ui.notice().children.find(child => child.textContent === '稍后').events.get('click')({ stopPropagation() {} });
  assert.equal(ui.notice(), undefined);
  ui.advance(5 * 60 * 1000);
  await ui.tick();
  assert.equal(ui.notice(), undefined);
  ui.publish({ id: 'release-c' });
  ui.advance(5 * 60 * 1000);
  await ui.tick();
  assert.ok(ui.notice());
  ui.publish({ id: 'release-b' });
  ui.advance(5 * 60 * 1000);
  await ui.tick();
  assert.equal(ui.notice(), undefined, 'a rollback to the dismissed release must not leave a stale notice');
  assert.deepEqual(ui.navigations, []);
});

test('network failures or invalid manifests stay silent and a later valid check still works', async () => {
  const ui = await frontend({ published: new Error('offline') });
  assert.equal(ui.notice(), undefined);
  for (const invalid of [{}, { id: '' }, { id: '<script>alert(1)</script>' }]) {
    ui.publish(invalid);
    ui.advance(5 * 60 * 1000);
    await ui.tick();
    assert.equal(ui.notice(), undefined);
  }
  ui.publish({ id: 'release-b' });
  ui.advance(5 * 60 * 1000);
  await ui.tick();
  assert.ok(ui.notice());
  assert.deepEqual(ui.navigations, []);
});

test('a notice disappears if the active deployment returns to the already loaded release', async () => {
  const ui = await frontend({ published: { id: 'release-b' } });
  ui.publish({ id: 'release-a' });
  ui.advance(5 * 60 * 1000);
  await ui.tick();
  assert.equal(ui.notice(), undefined);
  assert.deepEqual(ui.navigations, []);
});
