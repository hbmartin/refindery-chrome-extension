/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-ui-to-background-internals',
      severity: 'error',
      comment:
        'Content and UI code must use runtime messaging instead of mutating background state directly.',
      from: { path: '^src/(?:content|options|popup|ui)/' },
      to: { path: '^src/background/' },
    },
    {
      name: 'centralize-upstream-client-access',
      severity: 'error',
      comment:
        'Only the orchestrator and poller may call the upstream client, keeping timeout policy centralized.',
      from: {
        path: '^src/background/',
        pathNot: '^src/background/(?:index|poller)[.]ts$',
      },
      to: { path: '^src/background/client[.]ts$' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
  },
};
