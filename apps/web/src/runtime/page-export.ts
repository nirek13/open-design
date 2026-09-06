import type { PageBlockType } from '@open-design/contracts';
import type { DraftBlock } from '../components/pages/page-draft';

function headingPrefix(type: PageBlockType): string {
  if (type === 'heading_1') return '# ';
  if (type === 'heading_2') return '## ';
  if (type === 'heading_3') return '### ';
  return '';
}

function walkMarkdown(blocks: DraftBlock[], depth = 0): string[] {
  const lines: string[] = [];
  const indent = '  '.repeat(depth);
  for (const block of blocks) {
    const text = block.text.trim();
    switch (block.type) {
      case 'heading_1':
      case 'heading_2':
      case 'heading_3':
        lines.push(`${headingPrefix(block.type)}${text}`);
        break;
      case 'bulleted_list_item':
        lines.push(`${indent}- ${text}`);
        break;
      case 'numbered_list_item':
        lines.push(`${indent}1. ${text}`);
        break;
      case 'to_do':
        lines.push(`${indent}- [${block.props.checked ? 'x' : ' '}] ${text}`);
        break;
      case 'toggle':
        lines.push(`${indent}<details><summary>${text}</summary>`);
        break;
      case 'quote':
        lines.push(`${indent}> ${text}`);
        break;
      case 'callout':
        lines.push(`${indent}> ${String(block.props.icon ?? '💡')} ${text}`);
        break;
      case 'code':
        lines.push(`${indent}\`\`\`${String(block.props.language ?? '')}`.trimEnd());
        lines.push(block.text);
        lines.push(`${indent}\`\`\``);
        break;
      case 'divider':
        lines.push(`${indent}---`);
        break;
      case 'equation':
        lines.push(`${indent}$$`);
        lines.push(text);
        lines.push(`${indent}$$`);
        break;
      case 'bookmark':
      case 'embed':
      case 'image':
      case 'video':
      case 'audio':
      case 'file':
      case 'pdf': {
        const url = String(block.props.url ?? text);
        const caption = String(block.props.caption ?? '');
        lines.push(`${indent}[${caption || url}](${url})`);
        break;
      }
      case 'page': {
        const id = String(block.props.pageId ?? text);
        lines.push(`${indent}[${text || id}](page:${id})`);
        break;
      }
      case 'table_of_contents':
        lines.push(`${indent}<!-- table of contents -->`);
        break;
      case 'breadcrumb':
        lines.push(`${indent}<!-- breadcrumb -->`);
        break;
      case 'column_list':
      case 'column':
        break;
      case 'table': {
        const rows = tableRows(block);
        if (rows[0]) {
          lines.push(`${indent}| ${rows[0].join(' | ')} |`);
          lines.push(`${indent}| ${rows[0].map(() => '---').join(' | ')} |`);
          for (const row of rows.slice(1)) lines.push(`${indent}| ${row.join(' | ')} |`);
        }
        break;
      }
      default:
        if (text) lines.push(`${indent}${text}`);
        break;
    }
    if (block.children.length) {
      lines.push(...walkMarkdown(block.children, block.type === 'column' ? depth : depth + 1));
    }
    if (block.type === 'toggle') lines.push(`${indent}</details>`);
  }
  return lines;
}

function tableRows(block: DraftBlock): string[][] {
  const raw = block.props.rows;
  const nested = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { rows?: unknown }).rows : raw;
  if (!Array.isArray(nested)) return [];
  return nested.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? '')) : ['']));
}

export function pageToMarkdown(title: string, blocks: DraftBlock[]): string {
  const heading = `# ${title.trim() || 'Untitled'}`;
  const body = walkMarkdown(blocks).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return body ? `${heading}\n\n${body}\n` : `${heading}\n`;
}

export function countPageWords(title: string, blocks: DraftBlock[]): number {
  const text = `${title} ${flattenText(blocks)}`.trim();
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

function flattenText(blocks: DraftBlock[]): string {
  return blocks
    .map((block) => `${block.text} ${flattenText(block.children)}`)
    .join(' ')
    .trim();
}
