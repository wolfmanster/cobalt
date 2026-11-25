import { Capacitor } from '@capacitor/core';

export const isNativeAndroid = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

/** Room, download folder, X login, system back, and share import stay on Android. */
export const usesLocalArchive = isNativeAndroid;
export const xLoginSupported = isNativeAndroid;
export const downloadFolderSupported = isNativeAndroid;
export const systemBackBridge = isNativeAndroid;
export const shareImportSupported = isNativeAndroid;

/** The four-tab phone shell is used by Android and by the browser PWA. */
export const mobileShell = true;
