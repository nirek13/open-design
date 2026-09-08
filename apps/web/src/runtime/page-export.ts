import {
  isPageToolType,
  pageToolPlainText,
  parsePageTool,
  type PageBlockType,
} from '@open-design/contracts';
import { toolPayload, type DraftBlock } from '../components/pages/page-draft';

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
      case 'board':
      case 'checklist':
      case 'assigner':
      case 'poll':
      case 'timeline':
      case 'decision':
      case 'goals':
      case 'spreadsheet':
      case 'budget':
      case 'calendar':
      case 'habit':
      case 'countdown':
      case 'schedule':
        lines.push(...toolMarkdown(block, indent));
        break;
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

function toolMarkdown(block: DraftBlock, indent: string): string[] {
  if (!isPageToolType(block.type)) return [];
  const tool = parsePageTool(block.type, toolPayload(block));
  switch (tool.kind) {
    case 'board':
      return tool.columns.flatMap((column) => [
        `${indent}### ${column.title || 'Untitled'}`,
        ...column.cards.map((card) => `${indent}- ${card.title || 'Untitled card'}`),
      ]);
    case 'checklist':
      return tool.items.map((item) => `${indent}- [${item.checked ? 'x' : ' '}] ${item.text}`);
    case 'assigner':
      return tool.tasks.map((task) => {
        const who = task.assigneeName || task.assigneeId || 'unassigned';
        return `${indent}- [${task.status}] ${task.title || 'Untitled'} (${who})`;
      });
    case 'poll': {
      const lines = tool.question ? [`${indent}**${tool.question}**`] : [];
      for (const option of tool.options) {
        lines.push(`${indent}- ${option.label || 'Option'} — ${option.voterIds.length}`);
      }
      return lines;
    }
    case 'timeline':
      return tool.items.map(
        (item) => `${indent}- [${item.done ? 'x' : ' '}] ${item.date ? `${item.date} · ` : ''}${item.title}`,
      );
    case 'decision': {
      const lines = tool.question ? [`${indent}**${tool.question}**`] : [];
      for (const option of tool.options) {
        const mark = option.id === tool.chosenId ? '[x]' : '[ ]';
        lines.push(`${indent}- ${mark} ${option.label || 'Option'}`);
      }
      if (tool.notes.trim()) lines.push(`${indent}${tool.notes.trim()}`);
      return lines;
    }
    case 'goals':
      return tool.items.map((item) => {
        const pct = item.target <= 0 ? 0 : Math.round((item.current / item.target) * 100);
        return `${indent}- ${item.title || 'Goal'}: ${item.current}/${item.target}${item.unit ? ` ${item.unit}` : ''} (${pct}%)`;
      });
    case 'spreadsheet':
      return tool.cells
        .filter((row) => row.some((cell) => cell.trim()))
        .map((row) => `${indent}| ${row.join(' | ')} |`);
    case 'budget':
      return tool.items.map(
        (item) =>
          `${indent}- [${item.flow}] ${item.date ? `${item.date} · ` : ''}${item.label || 'Item'}${item.category ? ` (${item.category})` : ''}: ${item.amount}`,
      );
    case 'calendar':
      return tool.events.map((item) => `${indent}- ${item.date ? `${item.date} · ` : ''}${item.title || 'Event'}`);
    case 'habit':
      return tool.habits.map(
        (item) => `${indent}- ${item.title || 'Habit'} (${item.stamps.length}/${tool.days})`,
      );
    case 'countdown':
      return tool.items.map((item) => `${indent}- ${item.title || 'Event'}: ${item.date || 'no date'}`);
    case 'schedule':
      return tool.items.map(
        (item) =>
          `${indent}- ${item.day} ${item.start}${item.end ? `–${item.end}` : ''} ${item.title || 'Block'}`.trim(),
      );
  }
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
    .map((block) => {
      const tool = isPageToolType(block.type) ? pageToolPlainText(toolPayload(block)) : '';
      return `${block.text} ${tool} ${flattenText(block.children)}`;
    })
    .join(' ')
    .trim();
}
