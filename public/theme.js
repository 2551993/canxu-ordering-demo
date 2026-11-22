(() => {
  const storageKey = 'canxu:theme';
  const root = document.documentElement;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let reveal;

  function applyTheme(theme) {
    const night = theme === 'night';
    root.dataset.theme = night ? 'night' : 'day';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', night ? '#161d19' : '#f7f4ec');
    const button = document.querySelector('.theme-toggle');
    if (button) {
      button.setAttribute('aria-pressed', String(night));
      button.title = night ? '切换到日间模式' : '切换到夜间模式';
    }
  }

  let selectedTheme = 'day';
  try { selectedTheme = localStorage.getItem(storageKey) === 'night' ? 'night' : 'day'; } catch {}
  applyTheme(selectedTheme);

  document.addEventListener('DOMContentLoaded', () => {
    const button = document.querySelector('.theme-toggle');
    applyTheme(selectedTheme);
    button.addEventListener('click', () => {
      selectedTheme = selectedTheme === 'night' ? 'day' : 'night';
      try { localStorage.setItem(storageKey, selectedTheme); } catch {}

      if (reveal || reducedMotion.matches || !document.startViewTransition) {
        reveal?.skipTransition();
        applyTheme(selectedTheme);
        return;
      }

      const bounds = button.getBoundingClientRect();
      const x = bounds.left + bounds.width / 2;
      const y = bounds.top + bounds.height / 2;
      const radius = Math.ceil(Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)));
      root.style.setProperty('--theme-origin', `${x}px ${y}px`);
      root.style.setProperty('--theme-radius', `${radius}px`);
      root.dataset.themeReveal = '';
      reveal = document.startViewTransition(() => applyTheme(selectedTheme));
      reveal.ready.catch(() => {});
      const finish = () => {
        delete root.dataset.themeReveal;
        root.style.removeProperty('--theme-origin');
        root.style.removeProperty('--theme-radius');
        reveal = null;
      };
      reveal.finished.then(finish, finish);
    });
  }, { once: true });

  window.addEventListener('storage', ({ key, newValue }) => {
    if (key === storageKey || key === null) {
      selectedTheme = newValue === 'night' ? 'night' : 'day';
      reveal?.skipTransition();
      applyTheme(selectedTheme);
    }
  });
})();
