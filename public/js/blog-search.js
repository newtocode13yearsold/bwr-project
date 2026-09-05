/* Blog index client-side search.
 * Filters the static .blog-card grid by title / tag / description, hides section
 * headers whose grid ends up empty, and shows a "no results" line. Entirely
 * client-side — the blog is a fixed set of static articles, so no backend. */

(function () {
  const input = document.getElementById('blogSearch');
  if (!input) return;

  const noResults = document.getElementById('blogNoResults');
  const cards = Array.from(document.querySelectorAll('.blog-card'));
  // Each grid, with the label + title that immediately precede it, so an empty
  // grid hides its whole section heading too.
  const sections = Array.from(document.querySelectorAll('.blog-grid')).map(grid => {
    const nodes = [grid];
    let prev = grid.previousElementSibling;
    while (prev && (prev.classList.contains('blog-section-title') || prev.classList.contains('blog-section-label'))) {
      nodes.unshift(prev);
      prev = prev.previousElementSibling;
    }
    return { grid, nodes };
  });

  // Pre-compute each card's searchable text once.
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const haystacks = new Map(cards.map(c => [c, norm(c.textContent)]));

  function apply() {
    const q = norm(input.value.trim());
    let anyVisible = false;

    cards.forEach(c => {
      const match = !q || haystacks.get(c).includes(q);
      c.hidden = !match;
      if (match) anyVisible = true;
    });

    sections.forEach(({ grid, nodes }) => {
      const gridHasVisible = Array.from(grid.querySelectorAll('.blog-card')).some(c => !c.hidden);
      nodes.forEach(n => { n.hidden = !gridHasVisible; });
    });

    if (noResults) noResults.hidden = anyVisible;
  }

  let debounce;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(apply, 120);
  });
})();
