/** The documentation shell: a sidebar, a content column, and an "on this page"
 * rail, shared by every developer page.
 *
 * WHY A SHELL RATHER THAN ONE LONG ARTICLE. The developer section was a single
 * page with nine sections in it. That reads as an essay: a reader looking for
 * the error codes has to scroll past the philosophy, and there is no address to
 * send anyone for one topic. Splitting it gives each topic a URL, a title, and a
 * place in a list somebody can scan before they start reading.
 *
 * PAGES COME IN TWO SHAPES. Prose pages are markdown, so the copy button hands
 * over the exact source. Pages with runnable examples or live numbers bring
 * their own HTML and a `mount` that wires it. Both get the same shell, and the
 * contents rail is built by reading the headings out of the rendered DOM rather
 * than from the source, so it cannot disagree with what is on screen.
 */
import { esc } from './util';

export interface DocsPage {
  title: string;
  lede: string;
  /** Prose pages. Rendered here, and what the copy button hands over. */
  markdown?: string;
  /** Pages that are more than prose bring their own markup. */
  html?: string;
  /** Wire anything interactive after the markup is in the document. */
  mount?: (root: HTMLElement) => (() => void) | void;
}

export interface DocsLink {
  label: string;
  href: string;
}

export interface DocsGroup {
  label: string;
  items: DocsLink[];
}

/** The whole developer section, in the order somebody should meet it. */
export const DOCS_NAV: DocsGroup[] = [
  {
    label: 'Getting started',
    items: [
      { label: 'Introduction', href: '#/developers' },
      { label: 'Quickstart', href: '#/developers/quickstart' },
      { label: 'Use it from an agent', href: '#/developers/agents' },
      { label: 'How it works', href: '#/developers/howitworks' },
    ],
  },
  {
    label: 'Guides',
    items: [
      { label: 'Sealed bid auctions', href: '#/developers/auctions' },
      { label: 'Create an auction', href: '#/developers/createauction' },
      { label: 'What to build', href: '#/developers/usecases' },
    ],
  },
  {
    label: 'Reference',
    items: [
      { label: 'API reference', href: '#/developers/api' },
      { label: 'Limits and errors', href: '#/developers/limits' },
    ],
  },
  {
    label: 'The network',
    items: [
      { label: 'Live activity', href: '#/developers/network' },
      { label: 'Roadmap', href: '#/developers/roadmap' },
    ],
  },
];

function flatNav(): DocsLink[] {
  return DOCS_NAV.flatMap((g) => g.items);
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/** Inline markdown: code, bold, links. Escaped first, so nothing in the source
 * can inject markup; the small set of tags below is added afterwards. */
function inline(text: string): string {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => {
      const external = /^https?:/.test(href);
      const rel = external ? ' target="_blank" rel="noopener"' : '';
      return `<a href="${href}"${rel}>${label}</a>`;
    });
}

/** The subset these guides use, and nothing else. A general markdown
 * implementation is a dependency and a parser; this is eight constructs. */
export function renderMarkdown(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) body.push(lines[i++]!);
      i++;
      out.push(`<pre class="doc-code"><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = /^(##|###)\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const text = heading[2]!.trim();
      out.push(`<h${level} id="${slug(text)}">${inline(text)}</h${level}>`);
      i++;
      continue;
    }

    if (line.startsWith('> ')) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('> ')) body.push(lines[i++]!.slice(2));
      out.push(`<blockquote class="doc-quote">${inline(body.join(' '))}</blockquote>`);
      continue;
    }

    if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      const ordered = /^\d+\.\s/.test(line);
      const items: string[] = [];
      while (
        i < lines.length &&
        (ordered ? /^\d+\.\s+/.test(lines[i]!) : /^[-*]\s+/.test(lines[i]!))
      ) {
        items.push(lines[i++]!.replace(/^([-*]|\d+\.)\s+/, ''));
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag} class="doc-list">${items.map((x) => `<li>${inline(x)}</li>`).join('')}</${tag}>`);
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !lines[i]!.startsWith('```') &&
      !lines[i]!.startsWith('#') &&
      !lines[i]!.startsWith('> ') &&
      !/^[-*]\s/.test(lines[i]!) &&
      !/^\d+\.\s/.test(lines[i]!)
    ) {
      para.push(lines[i++]!);
    }
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }

  return out.join('\n');
}

/** Render a documentation page and wire its navigation. Returns a cleanup. */
export function renderDocs(root: HTMLElement, page: DocsPage, activeHref: string): () => void {
  const previousTitle = document.title;
  document.title = `${page.title} · Peal for developers`;
  const body = page.html ?? renderMarkdown(page.markdown ?? '');

  const flat = flatNav();
  const here = flat.findIndex((l) => l.href === activeHref);
  const prev = here > 0 ? flat[here - 1] : null;
  const next = here >= 0 && here < flat.length - 1 ? flat[here + 1] : null;

  root.innerHTML = `
    <div class="doc-shell">
      <aside class="doc-side" aria-label="documentation">
        <button class="doc-side-toggle" type="button" id="doc-side-toggle"
                aria-expanded="false" aria-controls="doc-side-nav">
          <span></span><span></span><span></span>
          <em>Documentation</em>
        </button>
        <nav id="doc-side-nav">
          ${DOCS_NAV.map(
            (group) => `
            <p class="doc-side-group">${esc(group.label)}</p>
            ${group.items
              .map(
                (item) =>
                  `<a href="${item.href}"${item.href === activeHref ? ' aria-current="page"' : ''}>${esc(item.label)}</a>`,
              )
              .join('')}`,
          ).join('')}
        </nav>
      </aside>

      <div class="doc-main-wrap">
        <article class="doc-main" id="doc-main">
          <header class="doc-head">
            <h1>${esc(page.title)}</h1>
            <p class="doc-lede">${esc(page.lede)}</p>
            <div class="doc-actions">
              ${page.markdown ? '<button class="doc-btn" type="button" id="doc-copy">copy as markdown</button>' : ''}
              <a class="doc-btn" href="#/protocol">protocol reference</a>
            </div>
          </header>
          <div class="doc-body">${body}</div>

          <nav class="doc-pager" aria-label="previous and next">
            ${prev ? `<a class="doc-pager-prev" href="${prev.href}"><span>previous</span><strong>${esc(prev.label)}</strong></a>` : '<span></span>'}
            ${next ? `<a class="doc-pager-next" href="${next.href}"><span>next</span><strong>${esc(next.label)}</strong></a>` : '<span></span>'}
          </nav>
        </article>
      </div>

      <nav class="doc-toc" aria-label="on this page">
        <p class="doc-toc-head">On this page</p>
        <div id="doc-toc-links"></div>
      </nav>
    </div>`;

  const cleanups: (() => void)[] = [];

  // Interactive pages wire themselves once their markup is in the document.
  const unmount = page.mount?.(root);
  if (unmount) cleanups.push(unmount);

  // The contents rail is read out of the rendered DOM, so it lists what is
  // actually on the page whether that came from markdown or from markup.
  const headings = Array.from(root.querySelectorAll<HTMLElement>('.doc-body h2, .doc-body h3'));
  for (const h of headings) if (!h.id) h.id = slug(h.textContent ?? '');
  const tocHost = root.querySelector<HTMLElement>('#doc-toc-links');
  if (tocHost) {
    tocHost.innerHTML = headings
      .map(
        (h) =>
          `<button type="button" data-goto="${h.id}" class="doc-toc-${h.tagName.toLowerCase()}">${esc(h.textContent ?? '')}</button>`,
      )
      .join('');
  }

  const tocButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-goto]'));
  const setCurrent = (id: string): void => {
    for (const b of tocButtons) {
      if (b.dataset.goto === id) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    }
  };
  const jump = (event: Event): void => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-goto]');
    if (!button) return;
    const id = button.dataset.goto ?? '';
    setCurrent(id);
    document.getElementById(id)?.scrollIntoView({
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  };
  const toc = root.querySelector<HTMLElement>('.doc-toc');
  toc?.addEventListener('click', jump);
  cleanups.push(() => toc?.removeEventListener('click', jump));

  if (headings.length) {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => Math.abs(a.boundingClientRect.top) - Math.abs(b.boundingClientRect.top));
        if (visible[0]) setCurrent(visible[0].target.id);
      },
      { rootMargin: '-8% 0px -72% 0px' },
    );
    for (const h of headings) observer.observe(h);
    cleanups.push(() => observer.disconnect());
  }

  // The sidebar collapses on a narrow screen and opens with the same motion the
  // site header's menu uses, so the two do not feel like different products.
  const toggle = root.querySelector<HTMLButtonElement>('#doc-side-toggle');
  const side = root.querySelector<HTMLElement>('.doc-side');
  const onToggle = (): void => {
    const open = side?.classList.toggle('is-open') ?? false;
    toggle?.setAttribute('aria-expanded', String(open));
  };
  toggle?.addEventListener('click', onToggle);
  cleanups.push(() => toggle?.removeEventListener('click', onToggle));

  // Copy hands over the exact source the page was rendered from, which is what
  // makes it worth pasting into a model rather than a lossy scrape.
  const copy = root.querySelector<HTMLButtonElement>('#doc-copy');
  copy?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(`# ${page.title}\n\n${page.lede}\n\n${page.markdown ?? ''}`);
      copy.textContent = 'copied';
    } catch {
      copy.textContent = 'clipboard unavailable';
    }
    window.setTimeout(() => {
      copy.textContent = 'copy as markdown';
    }, 1600);
  });

  // Copy buttons on every code block, read from the <code> itself so a snippet
  // cannot be copied in a stale form.
  for (const block of Array.from(root.querySelectorAll<HTMLElement>('pre.doc-code, pre.dev-code'))) {
    if (block.querySelector('.dev-copy')) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dev-copy';
    button.textContent = 'copy';
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(block.querySelector('code')?.textContent ?? '');
        button.textContent = 'copied';
        button.classList.add('is-copied');
      } catch {
        button.textContent = 'select it';
      }
      window.setTimeout(() => {
        button.textContent = 'copy';
        button.classList.remove('is-copied');
      }, 1600);
    });
    block.appendChild(button);
  }

  // The enter transition. One frame with the content low and transparent, then
  // released, so moving between pages reads as movement rather than a redraw.
  const main = root.querySelector<HTMLElement>('#doc-main');
  if (main && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    main.classList.add('is-entering');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => main.classList.remove('is-entering'));
    });
  }

  return () => {
    for (const done of cleanups) done();
    document.title = previousTitle;
  };
}
