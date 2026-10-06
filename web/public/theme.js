// Light or dark before the first paint: the student's choice, else the device's setting.
try {
  var saved = localStorage.getItem('room.theme');
  var theme = saved === 'light' || saved === 'dark' ? saved : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  if (theme === 'dark') document.querySelector('meta[name="theme-color"]').setAttribute('content', '#0a1130');
} catch (error) {
  // storage or matchMedia unavailable: the stylesheet's own default applies
}
