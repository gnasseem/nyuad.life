// Sizes each .fit headline line so it spans the headline's full width, then marks the page ready to print.
document.fonts.ready.then(() => {
  for (const line of document.querySelectorAll('.fit')) {
    const width = line.parentElement.clientWidth;
    line.style.fontSize = '100px';
    line.style.fontSize = (100 * width / line.getBoundingClientRect().width) + 'px';
  }
  // A .match line takes the size of the line above it instead of filling the width.
  for (const line of document.querySelectorAll('.match')) line.style.fontSize = line.previousElementSibling.style.fontSize;
  document.body.dataset.ready = '1';
});
