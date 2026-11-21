type Window = { title?: string; app_name?: string; window_id?: number; minimized?: boolean; is_on_screen?: boolean };

/** One visible window, or the single minimized match to restore, or the reason no window can be chosen. */
export function selectWindow(windows: Window[], app: string, windowId?: number): { window?: Window; minimized?: Window; error?: string } {
  const matching = windows.filter(w => (windowId === undefined || w.window_id === windowId) &&
    [w.title, w.app_name].some(v => String(v).toLowerCase() === app.toLowerCase()));
  const visible = matching.filter(w => !w.minimized && w.is_on_screen);
  if (visible.length === 1) return { window: visible[0] };
  if (visible.length === 0 && matching.length === 1 && matching[0].minimized) return { minimized: matching[0] };
  return { error: 'Target must match exactly one visible window title or executable' };
}
