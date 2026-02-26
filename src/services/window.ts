import { activeWindow } from 'get-windows';

export async function getActiveAppName(): Promise<string | null> {
  try {
    const win = await activeWindow();
    return win?.owner?.name ?? null;
  } catch {
    return null;
  }
}
