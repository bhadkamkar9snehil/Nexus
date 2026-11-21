import { test } from 'node:test';
import assert from 'node:assert/strict';
import { group, names } from '../../monitor-ui/data.js';

test('all managed terminal tools have readable names and a Terminal category', () => {
  for (const tool of ['start_process', 'read_process_output', 'interact_with_process', 'list_sessions', 'force_terminate', 'list_processes', 'kill_process', 'restart_application', 'restart_status']) {
    assert.equal(group(tool), 'Terminal');
    assert.ok(names[tool] && names[tool] !== tool);
  }
});
