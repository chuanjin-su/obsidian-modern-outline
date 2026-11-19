import { App, CachedMetadata, debounce, HeadingCache, MarkdownView, Platform, TFile } from 'obsidian';
import type ModernOutlinePlugin from '../main';
import { cleanHeadingText, getHeadingExcerpts } from '../utils/headings';

export class OverlayOutline {
	private overlayEl: HTMLElement | null = null;
	private currentView: MarkdownView | null = null;
	private headings: HeadingCache[] = [];
	private rows: HTMLElement[] = [];
	private activeRow: HTMLElement | null = null;
	private previewRow: HTMLElement | null = null;
	private hoveredRow: HTMLElement | null = null;
	private treeLines: { line: HTMLElement; parent: HTMLElement; lastChild: HTMLElement }[] = [];
	private layoutObserver = new ResizeObserver(() => this.updateLayout());
	private refreshTimer: number | null = null;
	private _enabled = true;
	private animateNextRefresh = false;

	constructor(private app: App, private plugin: ModernOutlinePlugin) {
		this.registerGlobalScrollListener();
	}

	get enabled() { return this._enabled; }

	toggle() {
		if (this._enabled) {
			this._enabled = false;
			this.detach();
		} else {
			this._enabled = true;
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view) this.attachTo(view);
		}
	}

	attachTo(view: MarkdownView) {
		if (!this._enabled) return;

		if (this.currentView === view && this.overlayEl) {
			this.scheduleRefresh(0);
			return;
		}

		this.detach();
		this.currentView = view;
		const overlay = view.contentEl.createDiv({ cls: 'modern-outline-overlay' });
		this.overlayEl = overlay;

		// Wheeling over the outline would otherwise hit the dashes (pointer-events:
		// auto) and never reach the note's scroller (not a DOM ancestor of the
		// overlay). Forward the wheel to the note so it scrolls as if the outline
		// weren't there — and the strip itself never scrolls on its own.
		overlay.addEventListener('wheel', (e: WheelEvent) => {
			const scroller = this.getNoteScroller(view);
			if (!scroller) return;
			e.preventDefault();
			this.clearHoverPreview();
			// Normalize delta: 0 = pixels, 1 = lines, 2 = pages.
			const factor = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? scroller.clientHeight : 1;
			scroller.scrollTop += e.deltaY * factor;
		}, { passive: false });

		overlay.addEventListener('mouseenter', () => {
			overlay.classList.remove('outline-peek', 'outline-peek-labels');
		});

		// Pointer movement selects the card. Reflow can fire pointerover on a
		// different row even while the pointer is stationary.
		overlay.addEventListener('pointermove', (event) => {
			if (event.pointerType === 'touch') return;
			const row = (event.target as HTMLElement).closest<HTMLElement>('.outline-row');
			if (!row) return;
			this.hoveredRow = row;
			this.setPreviewRow(row);
		});
		overlay.addEventListener('pointerleave', () => {
			this.clearHoverPreview();
			this.updateLayout();
		});

		// Play the entry animation only when attaching to a (new) note, not on
		// the content/layout refreshes that happen while editing.
		this.animateNextRefresh = true;
		this.scheduleRefresh(0);
	}

	detach() {
		if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
		this.resetRows();
		this.overlayEl?.remove();
		this.overlayEl = null;
		this.currentView = null;
	}

	private resetRows() {
		this.layoutObserver.disconnect();
		this.headings = [];
		this.rows = [];
		this.activeRow = null;
		this.previewRow = null;
		this.hoveredRow = null;
		this.treeLines = [];
	}

	scheduleRefresh(delay = 300) {
		if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => this.doRefresh(), delay);
	}

	private doRefresh() {
		const view = this.currentView;
		const overlay = this.overlayEl;
		if (!view || !overlay) return;

		this.resetRows();
		overlay.empty();
		overlay.className = 'modern-outline-overlay';
		if (Platform.isMobile) overlay.classList.add('outline-mobile');
		overlay.classList.add(
			this.plugin.settings.sidebarSide === 'left' ? 'overlay-left' : 'overlay-right'
		);
		overlay.classList.add(`overlay-${this.plugin.settings.verticalPosition}`);
		overlay.classList.add(`outline-dash-${this.plugin.settings.markerColor}`);
		overlay.classList.add(`outline-label-${this.plugin.settings.labelColor}`);
		overlay.classList.add(`outline-highlight-${this.plugin.settings.highlightColor}`);
		overlay.classList.add(`outline-shape-${this.plugin.settings.markerShape}`);
		overlay.classList.add(`outline-size-${this.plugin.settings.markerSize}`);
		overlay.classList.add(`outline-font-${this.plugin.settings.labelFont}`);
		overlay.classList.add(`outline-hierarchy-${this.plugin.settings.labelHierarchy}`);
		const { markerVisibility } = this.plugin.settings;
		if (markerVisibility === 'peek' || markerVisibility === 'hover') overlay.classList.add('outline-markers-auto-reveal');
		if (this.plugin.settings.labelsAlwaysOn && markerVisibility === 'always') overlay.classList.add('outline-labels-always-on');
		overlay.classList.add(`outline-tree-lines-${this.plugin.settings.treeLineColor}`);

		const isNewNote = this.animateNextRefresh;
		const animate = this.plugin.settings.animationsEnabled;
		if (!animate) overlay.classList.add('outline-no-anim');
		if (animate && isNewNote) overlay.classList.add('outline-animate-in');
		this.animateNextRefresh = false;

		const file = view.file;
		const metadata = file && this.app.metadataCache.getFileCache(file);
		if (!file || !metadata?.headings) return;

		const { minHeadingLevel, maxHeadingLevel } = this.plugin.settings;
		this.headings = metadata.headings.filter(
			h => h.level >= minHeadingLevel && h.level <= maxHeadingLevel
		);

		if (this.headings.length === 0) return;

		// With many headings the cascade takes too long to finish — drop the
		// stagger so labels/dashes animate together instead.
		if (this.headings.length > 30) overlay.classList.add('outline-no-stagger');

		const excerpts = new Map<HeadingCache, HTMLElement>();
		this.rows = this.headings.map((h, i) => {
			const row = overlay.createDiv({ cls: 'outline-row' });
			row.style.setProperty('--i', String(i)); // cascade order, inherited by dash + label
			const marker = row.createDiv({ cls: 'outline-marker' });
			marker.createDiv({ cls: `outline-dash outline-dash--h${h.level}` });
			const label = row.createDiv({ cls: 'outline-label-box' });
			label.createSpan({
				cls: `outline-label outline-label--h${h.level}`,
				text: cleanHeadingText(h.heading),
				attr: { dir: 'auto' },
			});
			excerpts.set(h, label.createDiv({ cls: 'outline-excerpt', attr: { dir: 'auto' } }));
			row.addEventListener('click', () => this.scrollToHeading(h, view));
			return row;
		});

		this.buildTreeLines();
		this.layoutObserver.observe(overlay);
		this.highlightCurrentHeading();
		void this.loadExcerpts(file, metadata, excerpts);

		if (markerVisibility === 'peek' && isNewNote && !overlay.matches(':hover')) {
			overlay.classList.add('outline-peek');
			if (this.plugin.settings.labelsAlwaysOn) overlay.classList.add('outline-peek-labels');
			overlay.lastElementChild?.querySelector('.outline-dash')?.addEventListener('animationend', () => {
				overlay.classList.remove('outline-peek', 'outline-peek-labels');
			}, { once: true });
		}
	}

	private async loadExcerpts(file: TFile, metadata: CachedMetadata, excerpts: Map<HeadingCache, HTMLElement>) {
		const { headings, sections } = metadata;
		if (!headings || !sections?.length) return;
		const rows = this.rows;
		const markdown = await this.app.vault.cachedRead(file).catch(() => null);
		if (markdown === null || this.rows !== rows || this.currentView?.file !== file) return;

		for (const [heading, text] of getHeadingExcerpts(markdown, headings, sections)) {
			const excerpt = excerpts.get(heading);
			if (excerpt) excerpt.textContent = text;
		}
	}

	// Connect each parent row to its last descendant. Heights follow the rows
	// when the active card opens, closes, or moves to a different heading.
	private buildTreeLines() {
		if (!this.plugin.settings.treeLines || this.headings.length > 30) return;

		for (let i = 0; i < this.headings.length; i++) {
			const parentHeading = this.headings[i];
			if (!parentHeading) continue;
			const parentLevel = parentHeading.level;

			// Find the last heading that is a descendant of this one.
			let lastChildIdx = -1;
			for (let j = i + 1; j < this.headings.length; j++) {
				const h = this.headings[j];
				if (!h || h.level <= parentLevel) break;
				lastChildIdx = j;
			}
			if (lastChildIdx < 0) continue;

			const parentRow = this.rows[i];
			const lastChildRow = this.rows[lastChildIdx];
			if (!parentRow || !lastChildRow) continue;

			const line = parentRow.createDiv({ cls: 'outline-tree-line' });
			line.style.setProperty('--tree-indent', `${(parentLevel - 1) * 8 + 4}px`);
			if (this.plugin.settings.treeLineColor === 'match') {
				const label = parentRow.querySelector<HTMLElement>('.outline-label');
				if (label) line.style.backgroundColor = getComputedStyle(label).color;
			}
			this.treeLines.push({ line, parent: parentRow, lastChild: lastChildRow });
		}
	}

	private updateLayout() {
		const overlay = this.overlayEl;
		if (!overlay) return;

		const row = this.activeRow;
		const lineHeights = this.treeLines.map(({ line, parent, lastChild }) => ({
			line,
			height: lastChild.offsetTop + lastChild.offsetHeight / 2 - parent.offsetTop - parent.offsetHeight,
		}));
		if (row && !this.hoveredRow && overlay.scrollHeight > overlay.clientHeight) {
			overlay.scrollTop = row.offsetTop + (row.offsetHeight - overlay.clientHeight) / 2;
		}
		for (const { line, height } of lineHeights) line.style.height = `${height}px`;
	}

	// The note's scrollable element — the CodeMirror scroller in editing mode,
	// the preview container in reading mode.
	private getNoteScroller(view: MarkdownView): HTMLElement | null {
		if (view.getMode() === 'preview') {
			const el = view.contentEl;
			return el.querySelector<HTMLElement>('.markdown-preview-view')
				?? el.querySelector<HTMLElement>('.markdown-reading-view');
		}
		const editor = view.editor as unknown as { cm?: { scrollDOM?: HTMLElement } } | undefined;
		return editor?.cm?.scrollDOM
			?? view.contentEl.querySelector<HTMLElement>('.cm-scroller');
	}

	private scrollToHeading(h: HeadingCache, view: MarkdownView) {
		const line = h.position.start.line;
		if (!(view.file instanceof TFile)) return;
		const file = view.file;

		// Activate the leaf first, so a click works even when focus was
		// elsewhere (sidebar, another pane) — otherwise the first click only
		// re-focuses the note and a second click is needed to navigate.
		this.app.workspace.setActiveLeaf(view.leaf, { focus: true });

		// Mirrors obsidian-dynamic-outline's _navigateToHeading:
		// openFile sets the initial position, applyScroll ensures the line
		// is visible once the view is ready.
		void view.leaf.openFile(file, { active: true, eState: { line } });
		window.setTimeout(() => {
			view.currentMode.applyScroll(line);
		}, 0);
	}

	// Single global scroll listener in the capture phase — the exact technique
	// used by obsidian-dynamic-outline. Capturing on document catches scroll
	// from ANY container (editor, reading view, embeds) without having to know
	// which element is actually scrolling.
	private registerGlobalScrollListener() {
		const handler = debounce((event: Event) => {
			const target = event.target as HTMLElement | null;
			// Ignore scrolling that happens inside the overlay itself.
			if (target?.classList?.contains('modern-outline-overlay')) return;
			this.highlightCurrentHeading();
		}, 0);

		// `activeWindow` accounts for pop-out windows; capture = true.
		this.plugin.registerDomEvent(
			activeWindow.document as unknown as HTMLElement,
			'scroll',
			handler,
			true
		);
	}

	// Reads the top visible line via view.currentMode.getScroll() — identical
	// in both editing and reading modes — and binary-searches the closest
	// heading. closestIndex starts at 0 so the first heading is always active.
	private highlightCurrentHeading() {
		if (!this._enabled) return;
		const view = this.currentView;
		const overlay = this.overlayEl;
		if (!view || !overlay) return;
		if (this.headings.length === 0) return;

		let currentScrollPosition: number;
		try {
			currentScrollPosition = view.currentMode.getScroll();
		} catch {
			return;
		}

		const targetLine = currentScrollPosition + 1;
		let closestIndex = 0;
		let low = 0;
		let high = this.headings.length - 1;
		while (low <= high) {
			const mid = Math.floor((low + high) / 2);
			const h = this.headings[mid];
			if (!h) break;
			if (h.position.start.line <= targetLine) {
				closestIndex = mid;
				low = mid + 1;
			} else {
				high = mid - 1;
			}
		}

		this.setActiveItem(closestIndex);
	}

	private setActiveItem(index: number) {
		const row = this.rows[index];
		if (!row || row === this.activeRow) return;

		this.activeRow?.classList.remove('is-active');
		this.activeRow = row;
		row.classList.add('is-active');
		if (!this.hoveredRow) this.setPreviewRow(row);
	}

	private setPreviewRow(row: HTMLElement | null) {
		if (row === this.previewRow) return;

		if (this.previewRow) {
			this.layoutObserver.unobserve(this.previewRow);
			this.previewRow.classList.remove('has-preview');
		}
		this.previewRow = row;
		if (row) {
			row.classList.add('has-preview');
			this.layoutObserver.observe(row);
		}
	}

	private clearHoverPreview() {
		if (!this.hoveredRow) return;
		this.hoveredRow = null;
		this.setPreviewRow(this.activeRow);
	}
}
