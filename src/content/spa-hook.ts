// Runs in the page's MAIN world so it can observe the page's own SPA
// navigations (history.pushState/replaceState happen in the main world; a hook
// installed from the isolated content-script world would never see them).
// It simply notifies the isolated world via postMessage.

(() => {
  const notify = () => {
    window.postMessage({ source: 'refindery', kind: 'locationchange' }, '*');
  };

  for (const type of ['pushState', 'replaceState'] as const) {
    const orig = history[type];
    history[type] = function (
      this: History,
      ...args: Parameters<History['pushState']>
    ) {
      const result = orig.apply(this, args);
      notify();
      return result;
    };
  }

  window.addEventListener('popstate', notify);
  window.addEventListener('hashchange', notify);
})();
