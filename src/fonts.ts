import { fileURLToPath } from 'node:url';

/** Inter 4.1 ExtraBold, the static cut (libass matches it as "Inter ExtraBold"). */
export const fontsDir = fileURLToPath(new URL('../resources/fonts/', import.meta.url));
export const fontFiles = ['Inter-ExtraBold.ttf'];
export const fontLicense = 'OFL.txt';
