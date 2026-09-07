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

export interface PageMakeIds {
  pageId?: string | null;
  projectId?: string | null;
}

/** Agent request: native page tools first; generate a file only when those cannot express the brief. */
export function composePageMakeRequest(kind: PageMakeKind, prompt: string, ids?: PageMakeIds): string {
  const action = pageMakeAction(kind);
  const pageId = ids?.pageId?.trim() || '<current page id>';
  const projectId = ids?.projectId?.trim() || '$OD_PROJECT_ID';
  const visible =
    `The live result must show on a page in the notes tab bar (the current open tab, or a new page you create that will open as a tab).`;
  if (kind === 'app') {
    return [
      'Build this as a native wiki tool on the current page when it fits: `board` (kanban), `checklist`, `assigner`, `poll`, `timeline`, `decision`, or `goals`.',
      `What to make: ${prompt.trim()}`,
      'Default: append a native page-tool block via `tools pages append` or `upsert` with a filled `content` payload. Do not generate HTML and embed it when a native tool covers the request.',
      `Only if the request needs UI those tools cannot express, create a unique ${action.noun} (${action.fileHint}) and embed it with: tools pages embed --page ${pageId} --type embed --url /api/projects/${projectId}/raw/<file>`,
      visible,
    ].join('\n');
  }
  return [
    `Create a unique ${action.noun} for the current wiki page, then embed it on that page.`,
    `What to make: ${prompt.trim()}`,
    `Output: ${action.fileHint}. Make it original to this page — do not reuse a generic template without customizing it.`,
    `When the file exists, embed it immediately with: tools pages embed --page ${pageId} --type embed --url /api/projects/${projectId}/raw/<file>`,
    `Do not stop at a description. ${visible}`,
  ].join('\n');
}
