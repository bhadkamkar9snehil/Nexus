import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectWindow } from '../window-selection.js';

test('a single minimized target is returned for restoring, ambiguous windows are never guessed', () => {
  const minimized = { app_name: 'chrome.exe', window_id: 1, minimized: true, is_on_screen: false };
  const visible = { app_name: 'chrome.exe', window_id: 2, minimized: false, is_on_screen: true };
  assert.equal(selectWindow([minimized], 'chrome.exe').minimized, minimized);
  assert.equal(selectWindow([minimized, visible], 'chrome.exe').window, visible);
  assert.match(selectWindow([minimized, { ...minimized, window_id: 3 }], 'chrome.exe').error!, /exactly one/i);
  assert.equal(selectWindow([minimized, visible], 'chrome.exe', 1).minimized, minimized);
  assert.match(selectWindow([], 'chrome.exe').error!, /exactly one/i);
});
