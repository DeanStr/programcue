import assert from 'node:assert/strict';

class ClassList {
  add() {}
  remove() {}
  toggle() {}
  contains() { return false; }
}
class FakeElement {
  constructor() { this.innerHTML = ''; this.classList = new ClassList(); this.dataset = {}; this.style = {}; this.value = ''; this.checked = false; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  addEventListener() {}
  removeEventListener() {}
  append() {}
  remove() {}
  focus() {}
  setSelectionRange() {}
  scrollIntoView() {}
}
const roots = { '#app': new FakeElement(), '#portal-root': new FakeElement(), '#toast-root': new FakeElement() };
globalThis.document = {
  querySelector(selector) { return roots[selector] || null; },
  querySelectorAll() { return []; },
  createElement() { return new FakeElement(); },
  activeElement: null,
  body: new FakeElement(),
  title: '',
};
globalThis.window = { addEventListener() {}, removeEventListener() {} };

globalThis.DOMParser = class {
  parseFromString(value) {
    const match = String(value).match(/<body>([\s\S]*)<\/body>/i);
    return { body: { children: [], innerHTML: match ? match[1] : String(value) } };
  }
};
globalThis.Node = { COMMENT_NODE: 8, ELEMENT_NODE: 1 };
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.location = { hash: '', pathname: '/', origin: 'http://127.0.0.1:4173', href: 'http://127.0.0.1:4173/' };
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText() {} } }, configurable: true });

const routes = new Map([
  ['admin/command', 'Command Centre'],
  ['admin/event', 'Event Setup'],
  ['admin/submissions', 'Submissions'],
  ['admin/submissions/form', 'Call for Speakers'],
  ['admin/review', 'Review Workbench'],
  ['admin/speakers', 'Speakers'],
  ['admin/schedule', 'Schedule Planner'],
  ['admin/communications', 'Communications Centre'],
  ['admin/tasks', 'Tasks &amp; Readiness'],
  ['admin/programme', 'Programme publication'],
  ['admin/integrations', 'Integrations'],
  ['admin/settings', 'Settings'],
  ['admin/assistant', 'Program Cue Assistant'],
  ['speaker/dashboard', 'Upload your presentation slides'],
  ['speaker/resources', 'Speaker resources'],
  ['public/programme', 'Search sessions, speakers, or topics'],
  ['apply/form', 'Call for Speakers'],
  ['design/system', 'Program Cue design system'],
]);
let index = 0;
for (const [route, marker] of routes) {
  location.hash = `#${route}`;
  roots['#app'].innerHTML = '';
  await import(new URL(`../public/app.js?route=${index++}`, import.meta.url));
  const html = roots['#app'].innerHTML;
  assert.ok(html.length > 1000, `${route} rendered too little HTML`);
  assert.ok(html.includes(marker), `${route} missing marker: ${marker}`);
  assert.ok(!html.includes('>undefined<'), `${route} rendered undefined content`);
  assert.ok(!/\bNaN\b/.test(html), `${route} rendered NaN`);
}
location.hash = '';
location.pathname = '/embed/future-of-events-2025';
roots['#app'].innerHTML = '';
await import(new URL(`../public/app.js?route=${index++}`, import.meta.url));
assert.ok(roots['#app'].innerHTML.includes('public-shell embedded'), 'embed route did not render the embedded public programme');
location.pathname = '/';
console.log(`rendered ${routes.size} routes plus embed`);
