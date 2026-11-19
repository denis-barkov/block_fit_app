import { appIdentity } from '../config/app.ts';

// Titles appear in HTML source in both the Vite app and the Pages fallback.
export const appTitleHTML = appIdentity.name.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
