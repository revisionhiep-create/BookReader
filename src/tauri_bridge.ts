import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type Event, type UnlistenFn } from "@tauri-apps/api/event";
import { open as tauriOpen, save as tauriSave, type OpenDialogOptions, type SaveDialogOptions } from "@tauri-apps/plugin-dialog";

export interface BookReaderMockRuntime {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  listen: <T>(event: string, handler: (event: Event<T>) => void) => Promise<UnlistenFn>;
  openDialog: (options?: OpenDialogOptions) => Promise<string | string[] | null>;
  saveDialog: (options?: SaveDialogOptions) => Promise<string | null>;
}

declare global {
  interface Window {
    __BOOKREADER_MOCK__?: BookReaderMockRuntime;
    __TAURI_INTERNALS__?: unknown;
  }
}

function getMock(): BookReaderMockRuntime | undefined {
  if (typeof window === "undefined") return undefined;
  if (window.__TAURI_INTERNALS__) return undefined;
  return window.__BOOKREADER_MOCK__;
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const mock = getMock();
  if (mock) return mock.invoke<T>(cmd, args);
  return tauriInvoke<T>(cmd, args);
}

export async function listen<T>(
  event: string,
  handler: (event: Event<T>) => void,
): Promise<UnlistenFn> {
  const mock = getMock();
  if (mock) return mock.listen<T>(event, handler);
  return tauriListen<T>(event, handler);
}

export async function openDialog(options?: OpenDialogOptions): Promise<string | string[] | null> {
  const mock = getMock();
  if (mock) return mock.openDialog(options);
  return tauriOpen(options);
}

export async function saveDialog(options?: SaveDialogOptions): Promise<string | null> {
  const mock = getMock();
  if (mock) return mock.saveDialog(options);
  return tauriSave(options);
}
