import { describe, expect, it } from 'vitest';
import {
  iframeSnippet,
  isOpaqueLocalHtmlEmbed,
  looksLikeUrl,
  parseEmbedUrl,
  resolveRichEmbed,
} from '../../src/runtime/rich-embed';

describe('resolveRichEmbed', () => {
  it('turns YouTube watch and share links into a privacy-friendly player', () => {
    const watch = resolveRichEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(watch?.kind).toBe('iframe');
    expect(watch?.provider).toBe('YouTube');
    expect(watch?.src).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');

    const short = resolveRichEmbed('https://youtu.be/dQw4w9WgXcQ');
    expect(short?.src).toContain('dQw4w9WgXcQ');
  });

  it('embeds Figma, Google Slides, and Notion sites live', () => {
    const figma = resolveRichEmbed('https://www.figma.com/design/abc123/Brand');
    expect(figma?.provider).toBe('Figma');
    expect(figma?.src).toContain('figma.com/embed');

    const slides = resolveRichEmbed(
      'https://docs.google.com/presentation/d/1abcDEF/edit#slide=id.p',
    );
    expect(slides?.provider).toBe('Google Slides');
    expect(slides?.src).toContain('/embed');

    const notion = resolveRichEmbed('https://open-design.notion.site/Handbook');
    expect(notion?.provider).toBe('Notion');
    expect(notion?.kind).toBe('iframe');
  });

  it('renders images, video files, and PDFs with the matching player', () => {
    expect(resolveRichEmbed('https://cdn.example.com/cover.png')?.kind).toBe('image');
    expect(resolveRichEmbed('https://cdn.example.com/demo.mp4')?.kind).toBe('video');
    expect(resolveRichEmbed('https://cdn.example.com/brief.pdf')?.kind).toBe('pdf');
  });

  it('embeds created project pictures, videos, apps, and slides from /raw/ URLs', () => {
    const picture = resolveRichEmbed('/api/projects/p1/raw/hero.png');
    expect(picture?.kind).toBe('image');
    expect(picture?.provider).toBe('Image');

    const video = resolveRichEmbed('/api/projects/p1/raw/walkthrough.mp4');
    expect(video?.kind).toBe('video');
    expect(video?.provider).toBe('Video');

    const app = resolveRichEmbed('/api/projects/p1/raw/expense-form.html');
    expect(app?.kind).toBe('iframe');
    expect(app?.provider).toBe('App');
    expect(app?.sandbox).not.toContain('allow-same-origin');
    expect(isOpaqueLocalHtmlEmbed(app!)).toBe(true);

    const slides = resolveRichEmbed('/api/projects/p1/raw/pitch-deck.html');
    expect(slides?.kind).toBe('iframe');
    expect(slides?.provider).toBe('Slides');
    expect(isOpaqueLocalHtmlEmbed(slides!)).toBe(true);

    const youtube = resolveRichEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(isOpaqueLocalHtmlEmbed(youtube!)).toBe(false);
  });

  it('falls back to a rich card for ordinary websites', () => {
    const card = resolveRichEmbed('https://example.com/about');
    expect(card?.kind).toBe('card');
    expect(card?.provider).toBe('Example');
  });

  it('rejects javascript and other unsafe protocols', () => {
    expect(parseEmbedUrl('javascript:alert(1)')).toBeNull();
    expect(resolveRichEmbed('javascript:alert(1)')).toBeNull();
    expect(looksLikeUrl('https://open-design.ai/docs')).toBe(true);
    expect(looksLikeUrl('not a link')).toBe(false);
  });

  it('prints an iframe snippet people can paste into Notion or a wiki', () => {
    const model = resolveRichEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(model).toBeTruthy();
    const snippet = iframeSnippet(model!);
    expect(snippet).toContain('<iframe');
    expect(snippet).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');
  });
});
