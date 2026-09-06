import type { PageColorId, PageFont } from '@open-design/contracts';

export const PAGE_COLOR_SWATCHES: Record<
  PageColorId,
  { label: string; text: string; bg: string }
> = {
  default: { label: 'Default', text: '', bg: '' },
  gray: { label: 'Gray', text: '#787774', bg: '#f1f1ef' },
  brown: { label: 'Brown', text: '#9f6b53', bg: '#f4eeee' },
  orange: { label: 'Orange', text: '#d9730d', bg: '#fbecdd' },
  yellow: { label: 'Yellow', text: '#cb912f', bg: '#fbf3db' },
  green: { label: 'Green', text: '#448361', bg: '#edf3ec' },
  blue: { label: 'Blue', text: '#337ea9', bg: '#e7f3f8' },
  purple: { label: 'Purple', text: '#9065b0', bg: '#f6f3f9' },
  pink: { label: 'Pink', text: '#c14c8a', bg: '#faf1f5' },
  red: { label: 'Red', text: '#d44c47', bg: '#fdebec' },
};

export function pageColorStyle(
  color?: string | null,
  background?: string | null,
): { color?: string; background?: string } {
  const text = color && color !== 'default' ? PAGE_COLOR_SWATCHES[color as PageColorId]?.text : '';
  const bg =
    background && background !== 'default' ? PAGE_COLOR_SWATCHES[background as PageColorId]?.bg : '';
  return {
    ...(text ? { color: text } : {}),
    ...(bg ? { background: bg } : {}),
  };
}

export function pageFontFamily(font: PageFont | undefined): string | undefined {
  if (font === 'serif') return 'Lyon-Text, Charter, Georgia, "Times New Roman", serif';
  if (font === 'mono') return 'iawriter-mono, ui-monospace, SFMono-Regular, Menlo, monospace';
  return undefined;
}
