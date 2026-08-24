/** Things a person can generate from a wiki page, then drop live onto that page. */
export type PageMakeKind = 'app' | 'image' | 'video' | 'slides';

export interface PageMakeAction {
  kind: PageMakeKind;
  label: string;
  hint: string;
  glyph: string;
  keywords: readonly string[];
  noun: string;
  fileHint: string;
  projectKind: 'prototype' | 'image' | 'video' | 'deck';
}

export const PAGE_MAKE_ACTIONS: readonly PageMakeAction[] = [
  {
    kind: 'app',
    label: 'Make app',
    hint: 'Generate a unique interactive app for this page',
    glyph: '◈',
    keywords: ['make', 'create', 'app', 'tool', 'prototype', 'unique', 'new'],
    noun: 'interactive app',
    fileHint: 'a single HTML file (e.g. ops-console.html)',
    projectKind: 'prototype',
  },
  {
    kind: 'image',
    label: 'Make picture',
    hint: 'Generate a unique image for this page',
    glyph: '🖼',
    keywords: ['make', 'create', 'picture', 'image', 'photo', 'illustration', 'unique', 'new'],
    noun: 'picture',
    fileHint: 'a png or jpg (e.g. hero.png)',
    projectKind: 'image',
  },
  {
    kind: 'video',
    label: 'Make video',
    hint: 'Generate a unique video for this page',
    glyph: '▶',
    keywords: ['make', 'create', 'video', 'clip', 'mp4', 'unique', 'new'],
    noun: 'video',
    fileHint: 'an mp4 (e.g. walkthrough.mp4)',
    projectKind: 'video',
  },
  {
    kind: 'slides',
    label: 'Make slides',
    hint: 'Generate a unique slide deck for this page',
    glyph: '▦',
    keywords: ['make', 'create', 'slides', 'deck', 'pitch', 'presentation', 'unique', 'new'],
    noun: 'slide deck',
    fileHint: 'an HTML deck (e.g. pitch-deck.html)',
    projectKind: 'deck',
  },
];

export function pageMakeAction(kind: PageMakeKind): PageMakeAction {
  return PAGE_MAKE_ACTIONS.find((item) => item.kind === kind) ?? PAGE_MAKE_ACTIONS[0]!;
}

export function isPageMakeKind(value: unknown): value is PageMakeKind {
  return value === 'app' || value === 'image' || value === 'video' || value === 'slides';
}

/** Agent request: create an original file, then embed it on the current page. */
export function composePageMakeRequest(kind: PageMakeKind, prompt: string): string {
  const action = pageMakeAction(kind);
  return [
    `Create a unique ${action.noun} for the current wiki page, then embed it on that page.`,
    `What to make: ${prompt.trim()}`,
    `Output: ${action.fileHint}. Make it original to this page — do not reuse a generic template without customizing it.`,
    'When the file exists, embed it immediately with: tools pages embed --page <current page id> --type embed --url /api/projects/<this project id>/raw/<file>',
    `Do not stop at a description. The page should show the live ${action.noun} when you finish.`,
  ].join('\n');
}
