# StakeMap

The map of Solana stake: which stake pools, delegation programs and known
stakeholders stake on which validators, epoch by epoch.

Live: https://stakemap.info

Built and run by [CryptoVik](https://cryptovik.info/) - independent Solana
validator since 2021, open-source builder, on-chain researcher.

## What is in this repository

The website of StakeMap: an Astro site that wraps the StakeMap app, a
single-page application in plain JavaScript with no framework and no build
step of its own.

| Path | What |
|---|---|
| `src/pages/index.astro` | the page: head, structured data, the list of pool sprites |
| `src/lib/dashboard-body.html` | the HTML body of the app, including the Documentation tab |
| `public/dashboard-assets/stake-dashboard.js` | the app: data loading, views, charts |
| `public/dashboard-assets/stake-dashboard.css` | its styles, light and dark themes |
| `public/pool-logos/` | isometric sprites of pool and program logos, two sizes |
| `src/lib/site.ts` | brand strings and links, the single place to edit them |
| `public/robots.txt`, `public/llms.txt` | crawler rules and the summary for AI agents |

## Data

The app reads open data that the StakeMap pipeline publishes:

- JSON API: https://data.stakemap.info/v1/ - reference in
  [DATA_API.md](https://github.com/stakemap-sol/Solana-Stake-Pools-Research/blob/main/DATA_API.md)
- Dataset, registry and every archived snapshot:
  [Solana-Stake-Pools-Research](https://github.com/stakemap-sol/Solana-Stake-Pools-Research)

History starts at epoch 820 (July 2025) and grows every epoch.

## Run it locally

Node 22.12 or newer.

```
npm install
npm run dev
```

`npm run build` writes the static site to `dist/`.

## Adding a pool sprite

Put `<stem>.webp` into `public/pool-logos/96/` and `public/pool-logos/256/`,
where `<stem>` is the file name of the pool image in the registry without
its extension (`imgs/jpool.svg` -> `jpool.webp`). Theme variants follow the
flat logos: `<stem>_light.webp` for the light theme, `<stem>_dark.webp` for
the dark one. The page lists the sprites at build time; a pool without a
sprite shows its flat logo.

## License

Code: MIT, see [LICENSE](LICENSE). Copyright (c) 2026 CryptoVik.

Data: CC BY 4.0. Cite as "Data: StakeMap by CryptoVik, as of epoch N" with a
link to https://stakemap.info/.

Pool and program logos belong to their owners. They are shown to identify
the pools and programs.

Stand with Ukraine.
