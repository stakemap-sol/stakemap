import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://stakemap.info',
  trailingSlash: 'ignore',
  build: {
    format: 'directory',
  },
  integrations: [
    sitemap({
      // Every build restamps the pages: data pages change with the epoch.
      lastmod: new Date(),
    }),
  ],
});
