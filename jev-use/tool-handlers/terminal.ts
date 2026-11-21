import { startProcess, readProcessOutput, interactWithProcess, listSessions, forceTerminate, listProcesses, killProcess } from '../terminal-sessions.js';
import { restartApplication, restartStatus } from '../restart-application.js';
import type { ToolRegistry } from '../tool-registry.js';
import type { ToolInvocation } from '../tool-context.js';

export function registerTerminalTools(registry: ToolRegistry<ToolInvocation>) {
  registry.bind('start_process', async ({ name, args, required, limit, goal, addUsage, root, browserTask, desktopTask }) => {
    let output: string;
    output = JSON.stringify(await startProcess({ command: args.command as string, shell: args.shell as string | undefined, cwd: args.cwd as string | undefined, timeout_ms: args.timeout_ms as number | undefined }));
    return output;
  });
  registry.bind('read_process_output', async ({ name, args, required, limit, goal, addUsage, root, browserTask, desktopTask }) => {
    let output: string;
    output = JSON.stringify(await readProcessOutput({ session_id: args.session_id as string | undefined, pid: args.pid as number | undefined, offset: args.offset as number | undefined, length: args.length as number | undefined, timeout_ms: args.timeout_ms as number | undefined, char_offset: args.char_offset as number | undefined }));
    return output;
  });
  registry.bind('interact_with_process', async ({ name, args, required, limit, goal, addUsage, root, browserTask, desktopTask }) => {
    let output: string;
    output = JSON.stringify(await interactWithProcess({ session_id: args.session_id as string | undefined, pid: args.pid as number | undefined, input: args.input as string, append_newline: args.append_newline as boolean | undefined, timeout_ms: args.timeout_ms as number | undefined }));
    return output;
  });
  registry.bind('list_sessions', async ({ name, args, required, limit, goal, addUsage, root, browserTask, desktopTask }) => {
    let output: string;
    output = JSON.stringify(await listSessions());
    return output;
  });
  registry.bind('force_terminate', async ({ name, args, required, limit, goal, addUsage, root, browserTask, desktopTask }) => {
    let output: string;
    output = JSON.stringify(await forceTerminate({ session_id: args.session_id as string | undefined, pid: args.pid as number | undefined }));
    return output;
  });
  registry.bind('list_processes', async ({ name, args, required, limit, goal, addUsage, root, browserTask, desktopTask }) => {
    let output: string;
    output = JSON.stringify(await listProcesses({ pid: args.pid as number | undefined, name: args.name as string | undefined, limit: args.limit as number | undefined }));
    return output;
  });
  registry.bind('kill_process', async ({ name, args, required, limit, goal, addUsage, root, browserTask, desktopTask }) => {
    let output: string;
    output = JSON.stringify(await killProcess({ pid: args.pid as number, expected_name: required('expected_name'), expected_start_time: required('expected_start_time'), confirm: args.confirm as boolean }));
    return output;
  });
  registry.bind('restart_application', async ({ name, args, required, limit, goal, addUsage, root, browserTask, desktopTask }) => {
    let output: string;
    output = JSON.stringify(await restartApplication({ pid: args.pid as number, expected_name: required('expected_name'), expected_start_time: required('expected_start_time'), confirm: args.confirm as boolean, quit_via_ctrl_q: args.quit_via_ctrl_q as boolean | undefined }));
    return output;
  });
  registry.bind('restart_status', async ({ name, args, required, limit, goal, addUsage, root, browserTask, desktopTask }) => {
    let output: string;
    output = JSON.stringify(await restartStatus(required('id')));
    return output;
  });
}
