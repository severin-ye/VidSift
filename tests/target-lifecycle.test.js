const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the production target-wait code with a deterministic clock. This does
// not simulate Chrome suspending a worker or claim a live browser acceptance.
function fixture({ rejectPulse = false } = {}) {
  let now = 0, nextId = 0, pulses = 0;
  const timers = new Map();
  const schedule = (fn, delay, repeat) => {
    const id = ++nextId;
    timers.set(id, { fn, at: now + delay, repeat });
    return id;
  };
  const context = vm.createContext({
    chrome: { runtime: { getPlatformInfo() {
      pulses++;
      return rejectPulse ? Promise.reject(new Error('synthetic API failure')) : Promise.resolve({ os: 'win' });
    } } },
    setInterval: (fn, delay) => schedule(fn, delay, delay),
    clearInterval: id => timers.delete(id),
    setTimeout: (fn, delay) => schedule(fn, delay, 0),
    clearTimeout: id => timers.delete(id),
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'background-video.js'), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('async function sendVideoChatGPT')) +
    '\nglobalThis.api={waitForTarget,targets:_targetCompletions};', context);
  return {
    ...context.api,
    get pulses() { return pulses; },
    get timerCount() { return timers.size; },
    advance(ms) {
      const until = now + ms;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.at;
        if (timer.repeat) timer.at += timer.repeat;
        else timers.delete(id);
        timer.fn();
      }
      now = until;
    },
  };
}

test('target wait pulses the extension API every 20 seconds only while active', async () => {
  const f = fixture(), task = { id: 'legacy-1' };
  f.advance(60000);
  assert.equal(f.pulses, 0);
  const completion = f.waitForTarget(task, 42);
  assert.equal(task.targetTabId, 42);
  f.advance(19999);
  assert.equal(f.pulses, 0);
  f.advance(1);
  assert.equal(f.pulses, 1);
  f.advance(40000);
  assert.equal(f.pulses, 3);
  const payload = { transcript: 'synthetic complete transcript' };
  f.targets.get(task.id).resolve(payload);
  assert.equal(await completion, payload);
  assert.equal(f.targets.size, 0);
  assert.equal(f.timerCount, 0);
  f.advance(60000);
  assert.equal(f.pulses, 3);
});

test('target rejection including cancellation stops all keepalive timers', async () => {
  const f = fixture(), task = { id: 'cancelled' };
  const completion = f.waitForTarget(task, 42);
  const rejected = assert.rejects(completion, /synthetic cancellation/);
  f.advance(20000);
  f.targets.get(task.id).reject(new Error('synthetic cancellation'));
  await rejected;
  assert.equal(f.targets.size, 0);
  assert.equal(f.timerCount, 0);
  f.advance(60000);
  assert.equal(f.pulses, 1);
});

test('target timeout stops keepalive without leaving a target registration', async () => {
  const f = fixture(), task = { id: 'timeout' };
  const completion = f.waitForTarget(task, 42);
  const rejected = assert.rejects(completion, /等待超时/);
  f.advance(30 * 60 * 1000);
  await rejected;
  const finalCount = f.pulses;
  assert.ok(finalCount > 0);
  assert.equal(f.targets.size, 0);
  assert.equal(f.timerCount, 0);
  f.advance(60000);
  assert.equal(f.pulses, finalCount);
});

test('one finished target does not stop another active target keepalive', async () => {
  const f = fixture({ rejectPulse: true });
  const first = f.waitForTarget({ id: 'one' }, 41);
  const second = f.waitForTarget({ id: 'two' }, 42);
  f.advance(20000);
  await Promise.resolve(); // Rejected diagnostic calls are handled by production.
  assert.equal(f.pulses, 2);
  f.targets.get('one').resolve({});
  await first;
  f.advance(20000);
  await Promise.resolve();
  assert.equal(f.pulses, 3);
  assert.equal(f.targets.size, 1);
  f.targets.get('two').resolve({});
  await second;
  assert.equal(f.timerCount, 0);
});
