import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://stakemap.info',
  trailingSlash: 'ignore',
  build: {
    format: 'directory',
  },
  // The dev toolbar audits the whole page after every DOM change; the app
  // changes the DOM all the time, so a local run stays close to the
  // published site without it.
  devToolbar: {
    enabled: false,
  },
  integrations: [
    sitemap({
      // Every build restamps the pages: data pages change with the epoch.
      lastmod: new Date(),
    }),
  ],
});
