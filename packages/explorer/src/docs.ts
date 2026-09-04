/** The documentation shell: sidebar, content, and an "on this page" rail.
 *
 * ONE SOURCE. A page is written as markdown and rendered here. The alternative,
 * authoring HTML and keeping a markdown copy for the copy button, guarantees
 * the two drift and the copy is the one nobody notices is stale. It also means
 * the copy button hands somebody the exact text the page was built from, which
 * is what makes it worth pasting into a model.
 *
 * The renderer covers the subset these guides use and nothing else. A general
 * markdown implementation is a dependency and a parser; this is the eight
 * constructs we write, each one visible in forty lines.
 */
import { esc } from './util';

export interface DocsPage {
  title: string;
  lede: string;
  /** The body, in markdown. Also what the copy button hands over. */
  markdown: string;
}

export interface DocsNavItem {
  label: string;
  /** A hash route. */
  href: string;
}

/** Every documentation page, so the sidebar is the same on all of them. */
export const DOCS_NAV: DocsNavItem[] = [
  { label: 'API overview', href: '#/developers' },
  { label: 'Create an auction', href: '#/developers/createauction' },
  { label: 'Protocol reference', href: '#/protocol' },
  { label: 'Encrypted mempool', href: '#/mempool' },
  { label: 'Private actions', href: '#/execution' },
];

interface Heading {
  id: string;
  level: 2 | 3;
  text: string;
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

export function renderMarkdown(md: string): { html: string; headings: Heading[] } {
  const lines = md.split('\n');
  const headings: Heading[] = [];
  const out: string[] = [];
  let i = 0;

  const flushList = (items: string[], ordered: boolean): void => {
    if (items.length === 0) return;
    const tag = ordered ? 'ol' : 'ul';
    out.push(`<${tag} class="doc-list">${items.map((x) => `<li>${inline(x)}</li>`).join('')}</${tag}>`);
    items.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) body.push(lines[i++]!);
      i++;
      out.push(
        `<pre class="doc-code"${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(body.join('\n'))}</code></pre>`,
      );
      continue;
    }

    const heading = /^(##|###)\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length as 2 | 3;
      const text = heading[2]!.trim();
      const id = slug(text);
      headings.push({ id, level, text });
      out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
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
      flushList(items, ordered);
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

  return { html: out.join('\n'), headings };
}

/** Render a documentation page and wire its navigation. Returns a cleanup. */
export function renderDocs(root: HTMLElement, page: DocsPage, activeHref: string): () => void {
  const previousTitle = document.title;
  document.title = `${page.title} · Peal`;
  const { html, headings } = renderMarkdown(page.markdown);

  root.innerHTML = `
    <div class="doc-shell">
      <aside class="doc-side" aria-label="documentation">
        <p class="doc-side-head">Documentation</p>
        <nav>
          ${DOCS_NAV.map(
            (item) =>
              `<a href="${item.href}"${item.href === activeHref ? ' aria-current="page"' : ''}>${esc(item.label)}</a>`,
          ).join('')}
        </nav>
      </aside>

      <article class="doc-main">
        <h1>${esc(page.title)}</h1>
        <p class="doc-lede">${esc(page.lede)}</p>
        <div class="doc-actions">
          <button class="doc-btn" type="button" id="doc-copy">copy as markdown</button>
          <a class="doc-btn" href="#/developers">back to the API</a>
        </div>
        <div class="doc-body">${html}</div>
      </article>

      <nav class="doc-toc" aria-label="on this page">
        <p class="doc-toc-head">On this page</p>
        ${headings
          .map(
            (h) =>
              `<button type="button" data-goto="${h.id}" class="doc-toc-${h.level}">${esc(h.text)}</button>`,
          )
          .join('')}
      </nav>
    </div>`;

  // Copy hands over the exact source the page was rendered from, which is what
  // makes it useful to paste into a model rather than a lossy scrape.
  const copy = root.querySelector<HTMLButtonElement>('#doc-copy');
  copy?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(`# ${page.title}\n\n${page.lede}\n\n${page.markdown}`);
      copy.textContent = 'copied';
    } catch {
      copy.textContent = 'clipboard unavailable';
    }
    window.setTimeout(() => {
      copy.textContent = 'copy as markdown';
    }, 1600);
  });

  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-goto]'));
  const setCurrent = (id: string): void => {
    for (const b of buttons) {
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

  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => Math.abs(a.boundingClientRect.top) - Math.abs(b.boundingClientRect.top));
      if (visible[0]) setCurrent(visible[0].target.id);
    },
    { rootMargin: '-8% 0px -74% 0px' },
  );
  for (const h of headings) {
    const el = document.getElementById(h.id);
    if (el) observer.observe(el);
  }

  // Copy buttons on the code blocks, same behaviour as the API page.
  for (const block of Array.from(root.querySelectorAll<HTMLElement>('pre.doc-code'))) {
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

  return () => {
    toc?.removeEventListener('click', jump);
    observer.disconnect();
    document.title = previousTitle;
  };
}
