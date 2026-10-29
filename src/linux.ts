import { NativeDesktopAdapter, type NativeDesktopOptions } from './desktop.js';
import type { DesktopConfig } from './types.js';
/** Linux AT-SPI2 helper adapter (protocol v2). Thin platform wrapper over the shared native adapter; operationMode selects the standard tier. */
export class LinuxAdapter extends NativeDesktopAdapter {
  constructor(config: DesktopConfig, options: NativeDesktopOptions = {}) {
    super(config, { ...options, platform: options.platform ?? 'linux' });
  }
}
