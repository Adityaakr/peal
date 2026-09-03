// The header menu.
//
// Every link the site has used to sit across the header at once. On a page
// whose job is a single decision that reads as a directory competing with the
// decision, so the links live behind one control and the header carries only
// identity.
//
// Closed at every width, not just on a phone. A menu that is a dropdown on
// mobile and a row on desktop is two behaviours to keep working; this is one.
//
// Open and closed are a CLASS, not the `hidden` attribute. `hidden` is
// `display: none`, and an element that is not laid out cannot transition, so
// using it would have meant no motion at all. The panel stays laid out and
// `visibility` is what keeps its links out of the tab order while closed.

/** Wire the header menu. Returns nothing to unmount: the header lives outside
 * the router's element and is mounted once for the life of the page. */
export function mountNav(): void {
  const burger = document.getElementById('site-burger');
  const menu = document.getElementById('site-menu');
  if (!burger || !menu) return;

  // The attribute is dropped once, here: the markup ships with `hidden` so the
  // links are not on screen for the moment before this module runs.
  menu.hidden = false;

  const header = burger.closest('.site-header');

  let open = false;
  const setOpen = (next: boolean): void => {
    open = next;
    menu.classList.toggle('is-open', next);
    // The panel opens along the line the identity sits on, so the identity
    // steps back while it is out. Navigating closes the menu, which brings it
    // straight back; the CSS confines this to widths where they would collide.
    header?.classList.toggle('nav-open', next);
    menu.setAttribute('aria-hidden', String(!next));
    burger.setAttribute('aria-expanded', String(next));
    burger.setAttribute('aria-label', next ? 'Close menu' : 'Open menu');
  };
  setOpen(false);

  burger.addEventListener('click', (ev) => {
    ev.stopPropagation();
    setOpen(!open);
  });

  // Following a link navigates, so the menu has done its job. Closing on the
  // hash change rather than on the click also covers the back button.
  window.addEventListener('hashchange', () => setOpen(false));

  // Anywhere else, and Escape. Without these the menu stays over the page and
  // the only way out is the button that opened it.
  document.addEventListener('click', (ev) => {
    if (!open) return;
    if (!menu.contains(ev.target as Node)) setOpen(false);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && open) {
      setOpen(false);
      (burger as HTMLButtonElement).focus();
    }
  });

  /** Mark the entry for wherever the reader currently is. */
  const markCurrent = (): void => {
    const hash = location.hash || '#/';
    for (const a of Array.from(menu.querySelectorAll<HTMLAnchorElement>('a'))) {
      const href = a.getAttribute('href') ?? '';
      const here = href.startsWith('#') && (hash === href || hash.startsWith(`${href}/`));
      if (here) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  };
  window.addEventListener('hashchange', markCurrent);
  markCurrent();
}
