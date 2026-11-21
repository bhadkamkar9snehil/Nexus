export type ToolInvocation = {
  name: string;
  args: Record<string, any>;
  required: (key: string, maxLength?: number) => string;
  limit: number;
  goal: string;
  addUsage: (usage: unknown) => void;
  root: string;
  browserTask: (args: object, choice: 'chrome' | 'edge', addUsage: (usage: unknown) => void) => Promise<string>;
  desktopTask: (goal: string, app: string, expect: string, text: string | undefined, limit: number, addUsage: (usage: unknown) => void, windowId?: number, launchAumid?: string) => Promise<string>;
};
