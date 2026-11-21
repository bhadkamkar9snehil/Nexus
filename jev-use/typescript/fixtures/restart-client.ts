import { restartApplication } from '../../restart-application.js';

const [pid, expected_name, expected_start_time, shortcut] = process.argv.slice(2);
const result = await restartApplication({ pid: Number(pid), expected_name, expected_start_time, confirm: true, quit_via_ctrl_q: shortcut === 'ctrl-q' });
process.stdout.write(JSON.stringify(result));
