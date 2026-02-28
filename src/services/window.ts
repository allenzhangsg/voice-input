import { activeWindow } from 'get-windows';

export interface WindowInfo {
  name: string | null;
  processId: number | null;
}

export async function getActiveWindowInfo(): Promise<WindowInfo> {
  try {
    const win = await activeWindow();
    return {
      name: win?.owner?.name ?? null,
      processId: win?.owner?.processId ?? null,
    };
  } catch {
    return { name: null, processId: null };
  }
}
