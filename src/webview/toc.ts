/**
 * Notion-style floating table of contents: a rail of dashes on the right
 * edge that expands into a heading list on hover. Click to jump; the current
 * section is highlighted while scrolling.
 */
export interface Toc {
  toggle(): boolean;
  setVisible(visible: boolean): void;
}

interface Heading {
  el: HTMLElement;
  level: number;
  text: string;
}

export function createToc(editorRoot: HTMLElement, initialVisible: boolean): Toc {
  let visible = initialVisible;
  let headings: Heading[] = [];
  let signature = '';

  const rail = document.createElement('div');
  rail.className = 'mdw-toc';

  const marks = document.createElement('div');
  marks.className = 'mdw-toc-marks';

  const panel = document.createElement('div');
  panel.className = 'mdw-toc-panel';

  rail.append(marks, panel);
  document.body.appendChild(rail);

  const collect = (): Heading[] =>
    Array.from(
      // Scope to the ProseMirror document so UI chrome (slash menu, toolbars)
      // mounted elsewhere in the editor is not picked up.
      editorRoot
        .querySelector('.ProseMirror')
        ?.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6') ?? []
    ).map((el) => ({
      el,
      level: Number(el.tagName[1]),
      text: el.textContent?.trim() || '…',
    }));

  const rebuild = () => {
    headings = collect();
    const nextSignature = headings.map((h) => `${h.level}:${h.text}`).join('\n');
    if (nextSignature === signature) {
      updateActive();
      return;
    }
    signature = nextSignature;

    rail.style.display = visible && headings.length > 0 ? 'block' : 'none';

    marks.replaceChildren(
      ...headings.map(({ level }) => {
        const mark = document.createElement('div');
        mark.className = 'mdw-toc-mark';
        mark.style.width = `${Math.max(8, 22 - (level - 1) * 4)}px`;
        return mark;
      })
    );

    panel.replaceChildren(
      ...headings.map(({ level, text }, i) => {
        const item = document.createElement('div');
        item.className = 'mdw-toc-item';
        item.style.paddingLeft = `${8 + (level - 1) * 12}px`;
        item.textContent = text;
        item.title = text;
        // Resolve the heading at click time: an external edit can replace the
        // DOM nodes while leaving the signature (and so this list) unchanged.
        item.addEventListener('click', () => {
          headings[i]?.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        return item;
      })
    );

    updateActive();
  };

  const updateActive = () => {
    let activeIndex = 0;
    for (let i = 0; i < headings.length; i++) {
      if (headings[i].el.getBoundingClientRect().top <= 90) {
        activeIndex = i;
      }
    }
    marks.childNodes.forEach((node, i) =>
      (node as HTMLElement).classList.toggle('active', i === activeIndex)
    );
    panel.childNodes.forEach((node, i) =>
      (node as HTMLElement).classList.toggle('active', i === activeIndex)
    );
  };

  let scheduled = false;
  const schedule = () => {
    if (scheduled) {
      return;
    }
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      rebuild();
    });
  };

  new MutationObserver(schedule).observe(editorRoot, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  window.addEventListener('scroll', updateActive, { passive: true });
  schedule();

  const apply = () => {
    rail.style.display = visible && headings.length > 0 ? 'block' : 'none';
  };

  return {
    toggle: () => {
      visible = !visible;
      apply();
      return visible;
    },
    setVisible: (v) => {
      visible = v;
      apply();
    },
  };
}
