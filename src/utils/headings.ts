import type { HeadingCache, SectionCache } from 'obsidian';

// Strips markdown formatting from a heading so the label shows clean text:
// links/wikilinks become their visible text, emphasis/code markers are removed.
// e.g. "[Canabalt](https://canabalt.com/)" → "Canabalt".
export function cleanHeadingText(raw: string): string {
	let text = raw;
	// Images: ![alt](url) → alt
	text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
	// Markdown links: [text](url) → text
	text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
	// Wikilinks: [[target|alias]] → alias, [[target]] → target
	text = text.replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, '$1');
	text = text.replace(/\[\[([^\]]+)\]\]/g, '$1');
	// Emphasis / highlight / strikethrough / inline code
	text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
	text = text.replace(/(\*|_)(.*?)\1/g, '$2');
	text = text.replace(/==(.*?)==/g, '$1');
	text = text.replace(/~~(.*?)~~/g, '$1');
	text = text.replace(/`([^`]+)`/g, '$1');
	return text.trim();
}

const excerptBlockTypes = new Set(['paragraph', 'text', 'list', 'blockquote', 'callout']);
const excerptLimit = 360;

export function getHeadingExcerpts(markdown: string, headings: HeadingCache[], sections: SectionCache[]) {
	const excerpts = new Map<HeadingCache, string>();
	let blockIndex = 0;

	for (const [index, heading] of headings.entries()) {
		// Use every heading as a boundary, including levels hidden from the outline.
		const end = headings[index + 1]?.position.start.offset ?? markdown.length;
		const parts: string[] = [];
		let length = 0;

		for (; blockIndex < sections.length; blockIndex++) {
			const block = sections[blockIndex];
			if (!block) break;
			const { start, end: blockEnd } = block.position;
			if (start.offset >= end) break;
			if (start.line <= heading.position.end.line || !excerptBlockTypes.has(block.type) || length >= excerptLimit) continue;

			const text = cleanHeadingText(markdown.slice(start.offset, Math.min(blockEnd.offset, end))
				.replace(/^[\t ]*(?:>[\t ]*)+/gm, '')
				.replace(/^\[![\w-]+\][+-]?[\t ]*/m, '')
				.replace(/^[\t ]*(?:[-+*]|\d+[.)])[\t ]+(?:\[[ xX]\][\t ]+)?/gm, '')
				.replace(/(?:^|\s)\^[\w-]+$/gm, '')
				.replace(/!\[\[[^\]]+\]\]|%%[\s\S]*?%%/g, ''))
				.replace(/\s+/g, ' ');
			if (text) {
				parts.push(text);
				length += text.length + 1;
			}
		}

		if (parts.length) excerpts.set(heading, parts.join(' ').slice(0, excerptLimit));
	}

	return excerpts;
}
