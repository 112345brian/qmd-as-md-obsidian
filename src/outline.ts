import { ItemView, MarkdownView, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import type QmdAsMdPlugin from './main';

// --- Quarto outline -------------------------------------------------------
//
// Obsidian's core Outline panel reads headings from metadataCache, which
// only parses .md files — a .qmd opened via registerExtensions still gets
// no heading cache, so the panel stays blank (issue #3). parseQmdHeadings
// scans the file text directly: ATX headings (`# ...`, up to 3 spaces of
// indent per CommonMark) only — setext headings (underlined with === / ---)
// are intentionally not supported, they are vanishingly rare in Quarto and
// the --- form collides with YAML/frontmatter syntax. The scan skips the
// YAML frontmatter block and fenced code blocks (``` / ~~~) so a `#` line
// inside an R/Python cell is not mistaken for a heading.

export const QMD_OUTLINE_VIEW = 'qmd-outline-view';

interface QmdHeading {
  level: number;
  text: string;
  line: number; // 0-based line index in the source
}

interface QmdHeadingNode extends QmdHeading {
  children: QmdHeadingNode[];
}

// Nest a flat heading list into a tree so the outline can fold sub-trees,
// matching Obsidian's core Outline panel. A heading owns every later heading
// of a deeper level until one at its own level or shallower appears. Levels
// may skip (h1 -> h3); the level-stack handles that without synthetic nodes.
function buildHeadingTree(headings: QmdHeading[]): QmdHeadingNode[] {
  const roots: QmdHeadingNode[] = [];
  const stack: QmdHeadingNode[] = [];
  for (const h of headings) {
    const node: QmdHeadingNode = { ...h, children: [] };
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    (stack.length ? stack[stack.length - 1].children : roots).push(node);
    stack.push(node);
  }
  return roots;
}

function parseQmdHeadings(content: string): QmdHeading[] {
  const lines = content.split(/\r?\n/);
  const headings: QmdHeading[] = [];
  let inFrontmatter = false;
  // Open code-fence state. Per CommonMark, a fence closes only on the same
  // marker char with a run at least as long as the opener — so a longer
  // ```` inside a ``` block, or a ~~~ inside a ``` block, does not close it.
  let fenceMarker: string | null = null; // '`' or '~' while inside a code block
  let fenceLength = 0; // length of the run that opened the current block

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // YAML frontmatter is only frontmatter when --- is the very first line.
    if (i === 0 && /^---\s*$/.test(line)) {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (/^(---|\.\.\.)\s*$/.test(line)) inFrontmatter = false;
      continue;
    }

    // Fenced code block: a run of >=3 backticks or tildes, up to 3 spaces
    // of indent.
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      const run = fence[1];
      const marker = run[0];
      if (fenceMarker === null) {
        fenceMarker = marker;
        fenceLength = run.length;
      } else if (marker === fenceMarker && run.length >= fenceLength) {
        fenceMarker = null;
        fenceLength = 0;
      }
      continue;
    }
    if (fenceMarker !== null) continue;

    const h = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*$/);
    if (h) {
      // Drop a trailing pandoc/quarto attribute block: `## Title {#id .cls}`.
      const text = h[2].replace(/\s*\{[^}]*\}\s*$/, '').trim();
      if (text) headings.push({ level: h[1].length, text, line: i });
    }
  }
  return headings;
}

export class QmdOutlineView extends ItemView {
  plugin: QmdAsMdPlugin;
  // Headings whose children are folded away. Keyed by a text-path (the chain
  // of ancestor heading texts) so a fold survives the re-render that an edit
  // elsewhere in the file triggers — a line-based key would drift. Lives for
  // the view's lifetime; cleared only when the view is closed.
  private collapsed = new Set<string>();

  constructor(leaf: WorkspaceLeaf, plugin: QmdAsMdPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return QMD_OUTLINE_VIEW;
  }

  getDisplayText(): string {
    return 'Quarto outline';
  }

  getIcon(): string {
    return 'list';
  }

  async onOpen(): Promise<void> {
    // Enforce singleton: detach any other outline leaves so only this one
    // remains. Covers manual splits, popouts, or duplicate spawns.
    for (const leaf of this.app.workspace.getLeavesOfType(QMD_OUTLINE_VIEW)) {
      if (leaf !== this.leaf) leaf.detach();
    }
    // The outline may already be the active leaf at this point (opened via
    // command/setting), so capture the underlying .qmd before rendering.
    this.plugin.trackActiveQuartoFile();
    this.render();
  }

  // Find the open markdown view for a file, regardless of which leaf is
  // active. .qmd files open as 'markdown' leaves (registerExtensions).
  private markdownViewFor(file: TFile): MarkdownView | null {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) {
        return leaf.view;
      }
    }
    return null;
  }

  render(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass('qmd-outline');

    const file = this.plugin.lastActiveQuartoFile;
    if (!file) {
      container.createDiv({
        cls: 'qmd-outline-empty',
        text: this.plugin.settings.outlineMarkdownFiles
          ? 'No Quarto (.qmd) or Markdown (.md) file is active.'
          : 'No Quarto (.qmd) file is active.',
      });
      return;
    }

    // Read live content from the open editor rather than the active leaf —
    // clicking inside this sidebar makes it the active leaf.
    const mdView = this.markdownViewFor(file);
    if (!mdView) {
      container.createDiv({
        cls: 'qmd-outline-empty',
        text: `Open ${file.name} to see its outline.`,
      });
      return;
    }

    const headings = parseQmdHeadings(mdView.editor.getValue());
    if (headings.length === 0) {
      container.createDiv({
        cls: 'qmd-outline-empty',
        text: 'No headings in this file.',
      });
      return;
    }

    const list = container.createDiv({ cls: 'qmd-outline-list' });
    for (const node of buildHeadingTree(headings)) {
      this.renderNode(list, node, file, '');
    }
  }

  // Render one heading row plus, recursively, its sub-tree. A heading with
  // children gets a chevron that folds them away; the fold state is kept in
  // this.collapsed so it persists across re-renders.
  private renderNode(
    parentEl: HTMLElement,
    node: QmdHeadingNode,
    file: TFile,
    parentPath: string
  ): void {
    // Path = ancestor heading texts chained. A newline cannot occur in a
    // heading's text, so it is a collision-free separator between levels.
    const path = `${parentPath}\n${node.level}:${node.text}`;
    const hasChildren = node.children.length > 0;
    let isCollapsed = hasChildren && this.collapsed.has(path);

    const item = parentEl.createDiv({
      cls: 'qmd-outline-item',
      // Keyboard-accessible: focusable, announced as a link, and the keydown
      // handler below makes Enter/Space jump and Left/Right fold.
      attr: { tabindex: '0', role: 'link' },
    });
    // Indentation is driven by CSS off this attribute — no inline styles.
    item.dataset.level = String(node.level);

    // Toggle slot is always present (even leaf headings) so heading text
    // lines up regardless of whether a chevron is shown.
    const toggle = item.createSpan({ cls: 'qmd-outline-toggle' });
    item.createSpan({ cls: 'qmd-outline-item-text', text: node.text });

    let childrenEl: HTMLElement | null = null;
    if (hasChildren) {
      setIcon(toggle, 'chevron-down');
      toggle.addClass('is-clickable');
      childrenEl = parentEl.createDiv({ cls: 'qmd-outline-children' });
      for (const child of node.children) {
        this.renderNode(childrenEl, child, file, path);
      }
    }

    const applyFold = () => {
      item.toggleClass('is-collapsed', isCollapsed);
      childrenEl?.toggleClass('is-collapsed', isCollapsed);
    };
    const setFold = (collapse: boolean) => {
      isCollapsed = collapse;
      if (collapse) this.collapsed.add(path);
      else this.collapsed.delete(path);
      applyFold();
    };
    applyFold(); // reflect any persisted fold state on first paint

    const jumpTo = () => {
      // Resolve the editor by file, not by "active leaf" — the click itself
      // just moved focus to this sidebar.
      const view = this.markdownViewFor(file);
      if (!view) return;
      const pos = { line: node.line, ch: 0 };
      this.app.workspace.setActiveLeaf(view.leaf, { focus: true });
      view.editor.setCursor(pos);
      view.editor.scrollIntoView({ from: pos, to: pos }, true);
      view.editor.focus();
    };

    item.addEventListener('click', jumpTo);
    item.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' || evt.key === ' ') {
        evt.preventDefault();
        jumpTo();
      } else if (hasChildren && evt.key === 'ArrowRight' && isCollapsed) {
        evt.preventDefault();
        setFold(false);
      } else if (hasChildren && evt.key === 'ArrowLeft' && !isCollapsed) {
        evt.preventDefault();
        setFold(true);
      }
    });

    if (hasChildren) {
      toggle.addEventListener('click', (evt) => {
        // Fold instead of jumping; the click would otherwise bubble to the
        // row's jump handler.
        evt.stopPropagation();
        setFold(!isCollapsed);
      });
    }
  }
}
