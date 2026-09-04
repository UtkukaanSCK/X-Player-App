import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DesktopApi } from '../shared/api'

/**
 * The entire surface the window is allowed to reach.
 *
 * Nothing here takes a file path from the page and hands it to the filesystem
 * without the user having chosen it first: `open` goes through the gateway,
 * which only serves what it was asked to open, and `pathForFile` resolves a
 * file the user physically dropped on the window.
 */
const api: DesktopApi = {
  pick: () => ipcRenderer.invoke('desktop:pick'),
  pickFolder: () => ipcRenderer.invoke('desktop:pick-folder'),
  open: (path) => ipcRenderer.invoke('desktop:open', path),
  setAudio: (id, order) => ipcRenderer.invoke('desktop:set-audio', id, order),
  expand: (paths) => ipcRenderer.invoke('desktop:expand', paths),
  // Electron stopped exposing File.path to renderers; this is the replacement,
  // and it only works for files the user actually dropped or picked.
  pathForFile: (file) => webUtils.getPathForFile(file),
  recent: () => ipcRenderer.invoke('desktop:recent'),
  clearRecent: () => ipcRenderer.invoke('desktop:clear-recent'),
  diagnostics: () => ipcRenderer.invoke('desktop:diagnostics'),
  setAlwaysOnTop: (value) => ipcRenderer.invoke('desktop:always-on-top', value),
  preferences: () => ipcRenderer.invoke('desktop:preferences'),
  savePreferences: (next) => ipcRenderer.invoke('desktop:save-preferences', next),
  openDefaultAppsSettings: () => ipcRenderer.invoke('desktop:default-apps'),
  onOpenPaths: (handler) => {
    const listener = (_event: unknown, paths: string[]) => handler(paths)
    ipcRenderer.on('desktop:open-paths', listener)
    return () => ipcRenderer.removeListener('desktop:open-paths', listener)
  },
}

contextBridge.exposeInMainWorld('desktop', api)
