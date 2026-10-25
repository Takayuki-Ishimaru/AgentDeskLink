import {NativeDesktopAdapter,type NativeDesktopOptions} from './desktop.js';
import type {DesktopConfig} from './types.js';
/** macOS accessibility helper adapter (protocol v2). Thin platform wrapper over the shared native adapter. */
export class MacOSAdapter extends NativeDesktopAdapter {
  constructor(config:DesktopConfig,options:NativeDesktopOptions={}){super(config,{...options,platform:options.platform??'darwin'});}
}
