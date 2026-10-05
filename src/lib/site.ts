// Single source of truth for brand strings, links and public wording.
// Edit here, never hardcode these in components.

export const SITE = {
  name: 'StakeMap',
  domain: 'stakemap.info',
  url: 'https://stakemap.info',
  tagline: 'The map of Solana stake',
  title: 'StakeMap - the map of Solana stake pools and validators',
  description:
    'See which pools and delegation programs stake on which Solana validators, epoch by epoch. Open data and API, history since July 2025.',
  formerName: 'CryptoVik StakePools Dashboard',
  ogImage: '/og/stakemap-og.jpg',
  themeColor: '#074449',
  email: 'hello@stakemap.info',

  x: {
    handle: 'stakemap_sol',
    url: 'https://x.com/stakemap_sol',
  },

  // Open data: the dataset, the registry and the API reference.
  data: {
    apiBase: 'https://data.stakemap.info/v1',
    repoUrl: 'https://github.com/SOFZP/Solana-Stake-Pools-Research',
    apiDocsUrl: 'https://github.com/SOFZP/Solana-Stake-Pools-Research/blob/main/DATA_API.md',
    licenseName: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    startEpoch: 820,
  },

  // The builder. StakeMap is built and run by the CryptoVik validator.
  builder: {
    name: 'CryptoVik',
    url: 'https://cryptovik.info/',
    stakeUrl: 'https://cryptovik.info/#stake',
    avatar: '/brand/cryptovik.png',
    role: 'independent Solana validator since 2021, open-source builder, on-chain researcher',
    x: {
      handle: 'vik_sol',
      url: 'https://x.com/vik_sol',
    },
    githubUrl: 'https://github.com/SOFZP',
    // The builder's own validator, as a page of this site.
    validatorPath: '/?validator=Fhks5gukimP6vxKYbRY4V1aw888EgHhpdDSscD9V6bub',
  },

  // Plausible Analytics script for this site (production builds only).
  plausibleSrc: 'https://plausible.io/js/pa-BJQJD5o4vNhCvAXTiKVAD.js',
} as const;
