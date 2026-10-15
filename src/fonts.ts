import { fileURLToPath } from 'node:url';

/** TikTok Sans v4.000, the 36pt (display) optical size, static cuts. Family name "TikTok Sans". */
export const fontsDir = fileURLToPath(new URL('../resources/fonts/', import.meta.url));
export const fontFiles = ['TikTokSans36pt-Bold.ttf', 'TikTokSans36pt-Black.ttf'];
export const fontLicense = 'OFL.txt';
