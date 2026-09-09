'use client';

// Interactive page tools: kanban board, checklist, task assigner, poll,
// timeline, decision, goals, spreadsheet, budget, calendar, habit tracker,
// countdown, and weekly schedule. Payload lives on the block (`props.tool` in
// the draft, `content` on the server) so a page can carry a working tool
// without a workspace table.

import { useEffect, useState, type DragEvent as ReactDragEvent } from 'react';
import {
  personLabel,
  type AssignerStatus,
  type OrgMember,
  type PageToolPayload,
  type PageToolType,
  type WeekDay,
  WEEK_DAYS,
  budgetTotals,
  columnLetters,
  daysUntil,
  evaluateSheet,
  formatIsoDate,
  habitDayRange,
  monthCells,
  newPageToolId,
  parsePageTool,
} from '@open-design/contracts';
import { fetchOrgMembers } from '../../providers/registry';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import { toolPayload, type DraftBlock } from './page-draft';
import styles from './PageTools.module.css';

interface PersonOption {
  id: string;
  label: string;
}

interface Props {
  block: DraftBlock;
  readOnly?: boolean;
  orgId?: string | null;
  onChange: (patch: Partial<DraftBlock>) => void;
}

const peopleCache = new Map<string, PersonOption[]>();

function useOrgPeople(orgId: string | null | undefined): PersonOption[] {
  const [people, setPeople] = useState<PersonOption[]>(() =>
    orgId ? (peopleCache.get(orgId) ?? []) : [],
  );
  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    void fetchOrgMembers(orgId)
      .then((members: OrgMember[]) => {
        const next = members.map((member) => ({
          id: member.userId,
          label: personLabel(member),
        }));
        peopleCache.set(orgId, next);
        if (!cancelled) setPeople(next);
      })
      .catch(() => {
        if (!cancelled) setPeople(peopleCache.get(orgId) ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);
  return people;
}

function setTool(block: DraftBlock, tool: PageToolPayload): Partial<DraftBlock> {
  return { props: { ...block.props, tool } };
}

export function PageTool({ block, readOnly, orgId, onChange }: Props) {
  const type = block.type as PageToolType;
  const tool = toolPayload(block);
  const org = useOptionalOrg() ?? NO_ORG_CONTEXT;
  const voterId = org.auth?.viewer?.userId ?? 'local';

  const commit = (next: PageToolPayload) => onChange(setTool(block, parsePageTool(type, next)));

  switch (tool.kind) {
    case 'board':
      return <BoardView tool={tool} readOnly={readOnly} onChange={commit} />;
    case 'checklist':
      return <ChecklistView tool={tool} readOnly={readOnly} onChange={commit} />;
    case 'assigner':
      return <AssignerView tool={tool} readOnly={readOnly} orgId={orgId} onChange={commit} />;
    case 'poll':
      return <PollView tool={tool} readOnly={readOnly} voterId={voterId} onChange={commit} />;
    case 'timeline':
      return <TimelineView tool={tool} readOnly={readOnly} onChange={commit} />;
    case 'decision':
      return <DecisionView tool={tool} readOnly={readOnly} onChange={commit} />;
    case 'goals':
      return <GoalsView tool={tool} readOnly={readOnly} onChange={commit} />;
    case 'spreadsheet':
      return <SpreadsheetView tool={tool} readOnly={readOnly} onChange={commit} />;
    case 'budget':
      return <BudgetView tool={tool} readOnly={readOnly} onChange={commit} />;
    case 'calendar':
      return <CalendarView tool={tool} readOnly={readOnly} onChange={commit} />;
    case 'habit':
      return <HabitView tool={tool} readOnly={readOnly} onChange={commit} />;
    case 'countdown':
      return <CountdownView tool={tool} readOnly={readOnly} onChange={commit} />;
    case 'schedule':
      return <ScheduleView tool={tool} readOnly={readOnly} onChange={commit} />;
  }
}

function BoardView({
  tool,
  readOnly,
  onChange,
}: {
  tool: Extract<PageToolPayload, { kind: 'board' }>;
  readOnly?: boolean;
  onChange: (next: PageToolPayload) => void;
}) {
  const [drag, setDrag] = useState<{ columnId: string; cardId: string } | null>(null);
  const [over, setOver] = useState<{ columnId: string; cardId: string | null } | null>(null);

  const moveCard = (toColumnId: string, beforeCardId: string | null) => {
    if (!drag) return;
    if (drag.columnId === toColumnId && beforeCardId === drag.cardId) return;
    const card = tool.columns.flatMap((column) => column.cards).find((item) => item.id === drag.cardId);
    if (!card) return;
    const nextColumns = tool.columns.map((column) => {
      const without = column.cards.filter((item) => item.id !== drag.cardId);
      if (column.id !== toColumnId) return { ...column, cards: without };
      const insertAt = beforeCardId ? without.findIndex((item) => item.id === beforeCardId) : -1;
      const cards = [...without];
      cards.splice(insertAt >= 0 ? insertAt : cards.length, 0, card);
      return { ...column, cards };
    });
    onChange({ ...tool, columns: nextColumns });
    setDrag(null);
    setOver(null);
  };

  return (
    <div className={styles.shell} data-testid="pages-tool-board">
      <div
        className={styles.board}
        onDragLeave={(event) => {
          const next = event.relatedTarget as Node | null;
          if (next && event.currentTarget.contains(next)) return;
          setOver(null);
        }}
      >
        {tool.columns.map((column) => (
          <section
            key={column.id}
            className={styles.column}
            data-over={over?.columnId === column.id && !over.cardId ? 'true' : undefined}
            onDragOver={(event) => {
              if (!drag) return;
              event.preventDefault();
              setOver((current) =>
                current?.columnId === column.id && current.cardId === null
                  ? current
                  : { columnId: column.id, cardId: null },
              );
            }}
            onDrop={(event) => {
              event.preventDefault();
              moveCard(column.id, over?.columnId === column.id ? over.cardId : null);
            }}
          >
            <header className={styles.columnHead}>
              <input
                className={styles.titleInput}
                value={column.title}
                disabled={readOnly}
                aria-label="Column title"
                onChange={(event) =>
                  onChange({
                    ...tool,
                    columns: tool.columns.map((item) =>
                      item.id === column.id ? { ...item, title: event.target.value } : item,
                    ),
                  })
                }
              />
              <span className={styles.count}>{column.cards.length}</span>
              {readOnly ? null : (
                <button
                  type="button"
                  className={styles.ghost}
                  aria-label="Remove column"
                  onClick={() =>
                    onChange({ ...tool, columns: tool.columns.filter((item) => item.id !== column.id) })
                  }
                >
                  ×
                </button>
              )}
            </header>
            <div className={styles.cards}>
              {column.cards.map((card) => (
                <article
                  key={card.id}
                  className={styles.card}
                  draggable={!readOnly}
                  data-over={over?.cardId === card.id ? 'true' : undefined}
                  onDragStart={(event: ReactDragEvent<HTMLElement>) => {
                    event.dataTransfer.effectAllowed = 'move';
                    event.stopPropagation();
                    setDrag({ columnId: column.id, cardId: card.id });
                  }}
                  onDragEnd={() => {
                    setDrag(null);
                    setOver(null);
                  }}
                  onDragOver={(event) => {
                    if (!drag || drag.cardId === card.id) return;
                    event.preventDefault();
                    event.stopPropagation();
                    setOver((current) =>
                      current?.columnId === column.id && current.cardId === card.id
                        ? current
                        : { columnId: column.id, cardId: card.id },
                    );
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    moveCard(column.id, card.id);
                  }}
                >
                  <input
                    className={styles.cardInput}
                    value={card.title}
                    disabled={readOnly}
                    placeholder="Card"
                    aria-label="Card title"
                    onChange={(event) =>
                      onChange({
                        ...tool,
                        columns: tool.columns.map((item) =>
                          item.id === column.id
                            ? {
                                ...item,
                                cards: item.cards.map((entry) =>
                                  entry.id === card.id ? { ...entry, title: event.target.value } : entry,
                                ),
                              }
                            : item,
                        ),
                      })
                    }
                  />
                  {readOnly ? null : (
                    <button
                      type="button"
                      className={styles.ghost}
                      aria-label="Remove card"
                      onClick={() =>
                        onChange({
                          ...tool,
                          columns: tool.columns.map((item) =>
                            item.id === column.id
                              ? { ...item, cards: item.cards.filter((entry) => entry.id !== card.id) }
                              : item,
                          ),
                        })
                      }
                    >
                      ×
                    </button>
                  )}
                </article>
              ))}
            </div>
            {readOnly ? null : (
              <button
                type="button"
                className={styles.add}
                onClick={() =>
                  onChange({
                    ...tool,
                    columns: tool.columns.map((item) =>
                      item.id === column.id
                        ? { ...item, cards: [...item.cards, { id: newPageToolId(), title: '' }] }
                        : item,
                    ),
                  })
                }
              >
                + Card
              </button>
            )}
          </section>
        ))}
        {readOnly ? null : (
          <button
            type="button"
            className={styles.addColumn}
            onClick={() =>
              onChange({
                ...tool,
                columns: [...tool.columns, { id: newPageToolId(), title: 'New column', cards: [] }],
              })
            }
          >
            + Column
          </button>
        )}
      </div>
    </div>
  );
}

function ChecklistView({
  tool,
  readOnly,
  onChange,
}: {
  tool: Extract<PageToolPayload, { kind: 'checklist' }>;
  readOnly?: boolean;
  onChange: (next: PageToolPayload) => void;
}) {
  const done = tool.items.filter((item) => item.checked).length;
  const total = tool.items.length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <div className={styles.shell} data-testid="pages-tool-checklist">
      <div className={styles.progressRow}>
        <span>
          {done}/{total}
        </span>
        <div className={styles.track} aria-hidden="true">
          <div className={styles.fill} style={{ width: `${pct}%` }} />
        </div>
        <span>{pct}%</span>
      </div>
      <ul className={styles.list}>
        {tool.items.map((item) => (
          <li key={item.id} className={styles.row}>
            <input
              type="checkbox"
              className={styles.check}
              checked={item.checked}
              disabled={readOnly}
              aria-label={item.text.trim() || 'To-do'}
              onChange={(event) =>
                onChange({
                  ...tool,
                  items: tool.items.map((entry) =>
                    entry.id === item.id ? { ...entry, checked: event.target.checked } : entry,
                  ),
                })
              }
            />
            <input
              className={`${styles.grow}${item.checked ? ` ${styles.done}` : ''}`}
              value={item.text}
              disabled={readOnly}
              placeholder="To-do"
              aria-label="To-do text"
              onChange={(event) =>
                onChange({
                  ...tool,
                  items: tool.items.map((entry) =>
                    entry.id === item.id ? { ...entry, text: event.target.value } : entry,
                  ),
                })
              }
            />
            {readOnly ? null : (
              <button
                type="button"
                className={styles.ghost}
                aria-label="Remove to-do"
                onClick={() => onChange({ ...tool, items: tool.items.filter((entry) => entry.id !== item.id) })}
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {readOnly ? null : (
        <button
          type="button"
          className={styles.add}
          onClick={() =>
            onChange({
              ...tool,
              items: [...tool.items, { id: newPageToolId(), text: '', checked: false }],
            })
          }
        >
          + Item
        </button>
      )}
    </div>
  );
}

const STATUS_LABEL: Record<AssignerStatus, string> = {
  todo: 'To do',
  doing: 'Doing',
  done: 'Done',
};

function AssignerView({
  tool,
  readOnly,
  orgId,
  onChange,
}: {
  tool: Extract<PageToolPayload, { kind: 'assigner' }>;
  readOnly?: boolean;
  orgId?: string | null;
  onChange: (next: PageToolPayload) => void;
}) {
  const people = useOrgPeople(orgId);
  return (
    <div className={styles.shell} data-testid="pages-tool-assigner">
      <ul className={styles.list}>
        {tool.tasks.map((task) => (
          <li key={task.id} className={styles.assignRow}>
            <input
              className={styles.grow}
              value={task.title}
              disabled={readOnly}
              placeholder="Task"
              aria-label="Task title"
              onChange={(event) =>
                onChange({
                  ...tool,
                  tasks: tool.tasks.map((entry) =>
                    entry.id === task.id ? { ...entry, title: event.target.value } : entry,
                  ),
                })
              }
            />
            <select
              className={styles.select}
              value={task.assigneeId ?? ''}
              disabled={readOnly}
              aria-label="Assignee"
              onChange={(event) => {
                const id = event.target.value;
                const person = people.find((entry) => entry.id === id);
                onChange({
                  ...tool,
                  tasks: tool.tasks.map((entry) =>
                    entry.id === task.id
                      ? {
                          ...entry,
                          assigneeId: id || null,
                          assigneeName: person?.label ?? null,
                        }
                      : entry,
                  ),
                });
              }}
            >
              <option value="">Unassigned</option>
              {task.assigneeId && !people.some((person) => person.id === task.assigneeId) ? (
                <option value={task.assigneeId}>{task.assigneeName || task.assigneeId}</option>
              ) : null}
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.label}
                </option>
              ))}
            </select>
            <select
              className={styles.select}
              value={task.status}
              disabled={readOnly}
              aria-label="Status"
              onChange={(event) =>
                onChange({
                  ...tool,
                  tasks: tool.tasks.map((entry) =>
                    entry.id === task.id
                      ? { ...entry, status: event.target.value as AssignerStatus }
                      : entry,
                  ),
                })
              }
            >
              {(['todo', 'doing', 'done'] as const).map((status) => (
                <option key={status} value={status}>
                  {STATUS_LABEL[status]}
                </option>
              ))}
            </select>
            {readOnly ? null : (
              <button
                type="button"
                className={styles.ghost}
                aria-label="Remove task"
                onClick={() => onChange({ ...tool, tasks: tool.tasks.filter((entry) => entry.id !== task.id) })}
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {readOnly ? null : (
        <button
          type="button"
          className={styles.add}
          onClick={() =>
            onChange({
              ...tool,
              tasks: [
                ...tool.tasks,
                { id: newPageToolId(), title: '', assigneeId: null, assigneeName: null, status: 'todo' },
              ],
            })
          }
        >
          + Task
        </button>
      )}
    </div>
  );
}

function PollView({
  tool,
  readOnly,
  voterId,
  onChange,
}: {
  tool: Extract<PageToolPayload, { kind: 'poll' }>;
  readOnly?: boolean;
  voterId: string;
  onChange: (next: PageToolPayload) => void;
}) {
  const total = tool.options.reduce((sum, option) => sum + option.voterIds.length, 0);

  return (
    <div className={styles.shell} data-testid="pages-tool-poll">
      <input
        className={styles.question}
        value={tool.question}
        disabled={readOnly}
        placeholder="Ask a question…"
        aria-label="Poll question"
        onChange={(event) => onChange({ ...tool, question: event.target.value })}
      />
      <ul className={styles.list}>
        {tool.options.map((option) => {
          const votes = option.voterIds.length;
          const pct = total === 0 ? 0 : Math.round((votes / total) * 100);
          const mine = option.voterIds.includes(voterId);
          return (
            <li key={option.id} className={styles.pollRow}>
              <button
                type="button"
                className={styles.vote}
                data-on={mine ? 'true' : undefined}
                disabled={readOnly}
                onClick={() =>
                  onChange({
                    ...tool,
                    options: tool.options.map((entry) => {
                      if (entry.id !== option.id) {
                        return { ...entry, voterIds: entry.voterIds.filter((id) => id !== voterId) };
                      }
                      const has = entry.voterIds.includes(voterId);
                      return {
                        ...entry,
                        voterIds: has
                          ? entry.voterIds.filter((id) => id !== voterId)
                          : [...entry.voterIds, voterId],
                      };
                    }),
                  })
                }
              >
                {mine ? 'Voted' : 'Vote'}
              </button>
              <div className={styles.pollBody}>
                <input
                  className={styles.grow}
                  value={option.label}
                  disabled={readOnly}
                  placeholder="Option"
                  aria-label="Poll option"
                  onChange={(event) =>
                    onChange({
                      ...tool,
                      options: tool.options.map((entry) =>
                        entry.id === option.id ? { ...entry, label: event.target.value } : entry,
                      ),
                    })
                  }
                />
                <div className={styles.track} aria-hidden="true">
                  <div className={styles.fill} style={{ width: `${pct}%` }} />
                </div>
              </div>
              <span className={styles.count}>
                {votes} · {pct}%
              </span>
              {readOnly ? null : (
                <button
                  type="button"
                  className={styles.ghost}
                  aria-label="Remove option"
                  onClick={() =>
                    onChange({ ...tool, options: tool.options.filter((entry) => entry.id !== option.id) })
                  }
                >
                  ×
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {readOnly ? null : (
        <button
          type="button"
          className={styles.add}
          onClick={() =>
            onChange({
              ...tool,
              options: [...tool.options, { id: newPageToolId(), label: '', voterIds: [] }],
            })
          }
        >
          + Option
        </button>
      )}
    </div>
  );
}

function TimelineView({
  tool,
  readOnly,
  onChange,
}: {
  tool: Extract<PageToolPayload, { kind: 'timeline' }>;
  readOnly?: boolean;
  onChange: (next: PageToolPayload) => void;
}) {
  return (
    <div className={styles.shell} data-testid="pages-tool-timeline">
      <ol className={styles.timeline}>
        {tool.items.map((item) => (
          <li key={item.id} className={styles.milestone} data-done={item.done ? 'true' : undefined}>
            <input
              type="checkbox"
              className={styles.check}
              checked={item.done}
              disabled={readOnly}
              aria-label="Milestone done"
              onChange={(event) =>
                onChange({
                  ...tool,
                  items: tool.items.map((entry) =>
                    entry.id === item.id ? { ...entry, done: event.target.checked } : entry,
                  ),
                })
              }
            />
            <input
              className={styles.date}
              value={item.date}
              disabled={readOnly}
              placeholder="Date"
              aria-label="Milestone date"
              onChange={(event) =>
                onChange({
                  ...tool,
                  items: tool.items.map((entry) =>
                    entry.id === item.id ? { ...entry, date: event.target.value } : entry,
                  ),
                })
              }
            />
            <input
              className={`${styles.grow}${item.done ? ` ${styles.done}` : ''}`}
              value={item.title}
              disabled={readOnly}
              placeholder="Milestone"
              aria-label="Milestone title"
              onChange={(event) =>
                onChange({
                  ...tool,
                  items: tool.items.map((entry) =>
                    entry.id === item.id ? { ...entry, title: event.target.value } : entry,
                  ),
                })
              }
            />
            {readOnly ? null : (
              <button
                type="button"
                className={styles.ghost}
                aria-label="Remove milestone"
                onClick={() => onChange({ ...tool, items: tool.items.filter((entry) => entry.id !== item.id) })}
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ol>
      {readOnly ? null : (
        <button
          type="button"
          className={styles.add}
          onClick={() =>
            onChange({
              ...tool,
              items: [...tool.items, { id: newPageToolId(), title: '', date: '', done: false }],
            })
          }
        >
          + Milestone
        </button>
      )}
    </div>
  );
}

function DecisionView({
  tool,
  readOnly,
  onChange,
}: {
  tool: Extract<PageToolPayload, { kind: 'decision' }>;
  readOnly?: boolean;
  onChange: (next: PageToolPayload) => void;
}) {
  return (
    <div className={styles.shell} data-testid="pages-tool-decision">
      <input
        className={styles.question}
        value={tool.question}
        disabled={readOnly}
        placeholder="What are we deciding?"
        aria-label="Decision question"
        onChange={(event) => onChange({ ...tool, question: event.target.value })}
      />
      <div className={styles.choices}>
        {tool.options.map((option) => (
          <div key={option.id} className={styles.choice} data-on={tool.chosenId === option.id ? 'true' : undefined}>
            <button
              type="button"
              className={styles.pick}
              disabled={readOnly}
              onClick={() =>
                onChange({
                  ...tool,
                  chosenId: tool.chosenId === option.id ? null : option.id,
                })
              }
            >
              {tool.chosenId === option.id ? 'Chosen' : 'Choose'}
            </button>
            <input
              className={styles.grow}
              value={option.label}
              disabled={readOnly}
              placeholder="Option"
              aria-label="Decision option"
              onChange={(event) =>
                onChange({
                  ...tool,
                  options: tool.options.map((entry) =>
                    entry.id === option.id ? { ...entry, label: event.target.value } : entry,
                  ),
                })
              }
            />
            {readOnly ? null : (
              <button
                type="button"
                className={styles.ghost}
                aria-label="Remove option"
                onClick={() =>
                  onChange({
                    ...tool,
                    chosenId: tool.chosenId === option.id ? null : tool.chosenId,
                    options: tool.options.filter((entry) => entry.id !== option.id),
                  })
                }
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
      {readOnly ? null : (
        <button
          type="button"
          className={styles.add}
          onClick={() =>
            onChange({
              ...tool,
              options: [...tool.options, { id: newPageToolId(), label: '' }],
            })
          }
        >
          + Option
        </button>
      )}
      <textarea
        className={styles.notes}
        value={tool.notes}
        disabled={readOnly}
        placeholder="Why this choice…"
        aria-label="Decision notes"
        rows={2}
        onChange={(event) => onChange({ ...tool, notes: event.target.value })}
      />
    </div>
  );
}

function GoalsView({
  tool,
  readOnly,
  onChange,
}: {
  tool: Extract<PageToolPayload, { kind: 'goals' }>;
  readOnly?: boolean;
  onChange: (next: PageToolPayload) => void;
}) {
  return (
    <div className={styles.shell} data-testid="pages-tool-goals">
      <ul className={styles.list}>
        {tool.items.map((item) => {
          const pct = item.target <= 0 ? 0 : Math.min(100, Math.round((item.current / item.target) * 100));
          return (
            <li key={item.id} className={styles.goal}>
              <input
                className={styles.grow}
                value={item.title}
                disabled={readOnly}
                placeholder="Goal"
                aria-label="Goal title"
                onChange={(event) =>
                  onChange({
                    ...tool,
                    items: tool.items.map((entry) =>
                      entry.id === item.id ? { ...entry, title: event.target.value } : entry,
                    ),
                  })
                }
              />
              <label className={styles.metric}>
                <span>Now</span>
                <input
                  type="number"
                  value={item.current}
                  disabled={readOnly}
                  aria-label="Current value"
                  onChange={(event) =>
                    onChange({
                      ...tool,
                      items: tool.items.map((entry) =>
                        entry.id === item.id
                          ? { ...entry, current: Number(event.target.value) || 0 }
                          : entry,
                      ),
                    })
                  }
                />
              </label>
              <label className={styles.metric}>
                <span>Target</span>
                <input
                  type="number"
                  value={item.target}
                  disabled={readOnly}
                  aria-label="Target value"
                  onChange={(event) =>
                    onChange({
                      ...tool,
                      items: tool.items.map((entry) =>
                        entry.id === item.id
                          ? { ...entry, target: Math.max(Number(event.target.value) || 1, 1) }
                          : entry,
                      ),
                    })
                  }
                />
              </label>
              <input
                className={styles.unit}
                value={item.unit}
                disabled={readOnly}
                placeholder="unit"
                aria-label="Unit"
                onChange={(event) =>
                  onChange({
                    ...tool,
                    items: tool.items.map((entry) =>
                      entry.id === item.id ? { ...entry, unit: event.target.value } : entry,
                    ),
                  })
                }
              />
              {readOnly ? null : (
                <button
                  type="button"
                  className={styles.ghost}
                  aria-label="Remove goal"
                  onClick={() => onChange({ ...tool, items: tool.items.filter((entry) => entry.id !== item.id) })}
                >
                  ×
                </button>
              )}
              <div className={styles.track} aria-hidden="true">
                <div className={styles.fill} style={{ width: `${pct}%` }} />
              </div>
              <span className={styles.count}>{pct}%</span>
            </li>
          );
        })}
      </ul>
      {readOnly ? null : (
        <button
          type="button"
          className={styles.add}
          onClick={() =>
            onChange({
              ...tool,
              items: [...tool.items, { id: newPageToolId(), title: '', current: 0, target: 100, unit: '%' }],
            })
          }
        >
          + Goal
        </button>
      )}
    </div>
  );
}

function money(currency: string, amount: number): string {
  const formatted = amount.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return `${currency}${formatted}`;
}

function SpreadsheetView({
  tool,
  readOnly,
  onChange,
}: {
  tool: Extract<PageToolPayload, { kind: 'spreadsheet' }>;
  readOnly?: boolean;
  onChange: (next: PageToolPayload) => void;
}) {
  const [edit, setEdit] = useState<{ row: number; col: number; draft: string } | null>(null);
  const computed = evaluateSheet(tool.cells);
  const cols = Math.max(tool.cells[0]?.length ?? 0, 1);

  const setCell = (row: number, col: number, value: string) => {
    const next = tool.cells.map((entry) => [...entry]);
    const target = next[row];
    if (!target) return;
    target[col] = value;
    onChange({ ...tool, cells: next });
  };

  return (
    <div className={styles.shell} data-testid="pages-tool-spreadsheet">
      <div className={styles.sheetHint}>=SUM(A1:A3) · =A1+B1 · AVERAGE MIN MAX COUNT</div>
      <div className={styles.sheetWrap}>
        <table className={styles.sheet}>
          <thead>
            <tr>
              <th />
              {Array.from({ length: cols }, (_, col) => (
                <th key={col}>{columnLetters(col)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tool.cells.map((row, ri) => (
              <tr key={ri}>
                <th>{ri + 1}</th>
                {row.map((cell, ci) => {
                  const active = Boolean(edit && edit.row === ri && edit.col === ci);
                  const shown = active && edit ? edit.draft : (computed[ri]?.[ci] ?? cell);
                  const formula = cell.trim().startsWith('=');
                  return (
                    <td key={ci} data-formula={formula && !active ? 'true' : undefined}>
                      <input
                        className={styles.sheetInput}
                        value={shown}
                        disabled={readOnly}
                        aria-label={columnLetters(ci) + String(ri + 1)}
                        onFocus={() => setEdit({ row: ri, col: ci, draft: cell })}
                        onBlur={() => setEdit((current) => (current?.row === ri && current.col === ci ? null : current))}
                        onChange={(event) => {
                          setEdit({ row: ri, col: ci, draft: event.target.value });
                          setCell(ri, ci, event.target.value);
                        }}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {readOnly ? null : (
        <div className={styles.rowActions}>
          <button
            type="button"
            className={styles.add}
            onClick={() =>
              onChange({
                ...tool,
                cells: [...tool.cells, Array.from({ length: cols }, () => '')],
              })
            }
          >
            + Row
          </button>
          <button
            type="button"
            className={styles.add}
            onClick={() =>
              onChange({
                ...tool,
                cells: tool.cells.map((row) => [...row, '']),
              })
            }
          >
            + Column
          </button>
        </div>
      )}
    </div>
  );
}

function BudgetView({
  tool,
  readOnly,
  onChange,
}: {
  tool: Extract<PageToolPayload, { kind: 'budget' }>;
  readOnly?: boolean;
  onChange: (next: PageToolPayload) => void;
}) {
  const totals = budgetTotals(tool);
  return (
    <div className={styles.shell} data-testid="pages-tool-budget">
      <div className={styles.budgetTotals}>
        <span>
          In <strong>{money(tool.currency, totals.income)}</strong>
        </span>
        <span>
          Out <strong>{money(tool.currency, totals.expense)}</strong>
        </span>
        <span data-neg={totals.balance < 0 ? 'true' : undefined}>
          Left <strong>{money(tool.currency, totals.balance)}</strong>
        </span>
        {readOnly ? null : (
          <input
            className={styles.unit}
            value={tool.currency}
            aria-label="Currency"
            onChange={(event) => onChange({ ...tool, currency: event.target.value || '$' })}
          />
        )}
      </div>
      <ul className={styles.list}>
        {tool.items.map((item) => (
          <li key={item.id} className={styles.budgetRow}>
            <input
              className={styles.date}
              value={item.date}
              disabled={readOnly}
              placeholder="Date"
              aria-label="Entry date"
              onChange={(event) =>
                onChange({
                  ...tool,
                  items: tool.items.map((entry) =>
                    entry.id === item.id ? { ...entry, date: event.target.value } : entry,
                  ),
                })
              }
            />
            <input
              className={styles.grow}
              value={item.label}
              disabled={readOnly}
              placeholder="Item"
              aria-label="Entry label"
              onChange={(event) =>
                onChange({
                  ...tool,
                  items: tool.items.map((entry) =>
                    entry.id === item.id ? { ...entry, label: event.target.value } : entry,
                  ),
                })
              }
            />
            <input
              className={styles.unit}
              value={item.category}
              disabled={readOnly}
              placeholder="Category"
              aria-label="Entry category"
              onChange={(event) =>
                onChange({
                  ...tool,
                  items: tool.items.map((entry) =>
                    entry.id === item.id ? { ...entry, category: event.target.value } : entry,
                  ),
                })
              }
            />
            <select
              className={styles.select}
              value={item.flow}
              disabled={readOnly}
              aria-label="Income or expense"
              onChange={(event) =>
                onChange({
                  ...tool,
                  items: tool.items.map((entry) =>
                    entry.id === item.id ? { ...entry, flow: event.target.value as 'income' | 'expense' } : entry,
                  ),
                })
              }
            >
              <option value="income">In</option>
              <option value="expense">Out</option>
            </select>
            <input
              type="number"
              className={styles.amount}
              value={item.amount || ''}
              disabled={readOnly}
              placeholder="0"
              aria-label="Amount"
              onChange={(event) =>
                onChange({
                  ...tool,
                  items: tool.items.map((entry) =>
                    entry.id === item.id ? { ...entry, amount: Math.max(Number(event.target.value) || 0, 0) } : entry,
                  ),
                })
              }
            />
            {readOnly ? null : (
              <button
                type="button"
                className={styles.ghost}
                aria-label="Remove entry"
                onClick={() => onChange({ ...tool, items: tool.items.filter((entry) => entry.id !== item.id) })}
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {readOnly ? null : (
        <button
          type="button"
          className={styles.add}
          onClick={() =>
            onChange({
              ...tool,
              items: [
                ...tool.items,
                { id: newPageToolId(), date: '', label: '', category: '', amount: 0, flow: 'expense' },
              ],
            })
          }
        >
          + Entry
        </button>
      )}
    </div>
  );
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function CalendarView({
  tool,
  readOnly,
  onChange,
}: {
  tool: Extract<PageToolPayload, { kind: 'calendar' }>;
  readOnly?: boolean;
  onChange: (next: PageToolPayload) => void;
}) {
  const cells = monthCells(tool.year, tool.month);
  const byDate = new Map<string, string[]>();
  for (const event of tool.events) {
    if (!event.date) continue;
    const titles = byDate.get(event.date) ?? [];
    titles.push(event.title);
    byDate.set(event.date, titles);
  }
  const shift = (delta: number) => {
    const next = new Date(tool.year, tool.month - 1 + delta, 1);
    onChange({ ...tool, year: next.getFullYear(), month: next.getMonth() + 1 });
  };

  return (
    <div className={styles.shell} data-testid="pages-tool-calendar">
      <div className={styles.monthHead}>
        {readOnly ? null : (
          <button type="button" className={styles.ghost} aria-label="Previous month" onClick={() => shift(-1)}>
            ‹
          </button>
        )}
        <strong>
          {MONTH_NAMES[tool.month - 1]} {tool.year}
        </strong>
        {readOnly ? null : (
          <button type="button" className={styles.ghost} aria-label="Next month" onClick={() => shift(1)}>
            ›
          </button>
        )}
      </div>
      <div className={styles.monthGrid}>
        {WEEKDAY_SHORT.map((label) => (
          <span key={label} className={styles.monthDow}>
            {label}
          </span>
        ))}
        {cells.map((cell) => (
          <button
            key={cell.date}
            type="button"
            className={styles.monthDay}
            data-out={!cell.inMonth ? 'true' : undefined}
            disabled={readOnly || !cell.inMonth}
            onClick={() =>
              onChange({
                ...tool,
                events: [...tool.events, { id: newPageToolId(), date: cell.date, title: '' }],
              })
            }
          >
            <span>{Number(cell.date.slice(-2))}</span>
            {(byDate.get(cell.date) ?? []).slice(0, 2).map((title, index) => (
              <em key={index}>{title || 'Event'}</em>
            ))}
          </button>
        ))}
      </div>
      <ul className={styles.list}>
        {tool.events.map((event) => (
          <li key={event.id} className={styles.milestone}>
            <input
              className={styles.date}
              value={event.date}
              disabled={readOnly}
              placeholder="YYYY-MM-DD"
              aria-label="Event date"
              onChange={(eventChange) =>
                onChange({
                  ...tool,
                  events: tool.events.map((entry) =>
                    entry.id === event.id ? { ...entry, date: eventChange.target.value } : entry,
                  ),
                })
              }
            />
            <input
              className={styles.grow}
              value={event.title}
              disabled={readOnly}
              placeholder="Event"
              aria-label="Event title"
              onChange={(eventChange) =>
                onChange({
                  ...tool,
                  events: tool.events.map((entry) =>
                    entry.id === event.id ? { ...entry, title: eventChange.target.value } : entry,
                  ),
                })
              }
            />
            {readOnly ? null : (
              <button
                type="button"
                className={styles.ghost}
                aria-label="Remove event"
                onClick={() => onChange({ ...tool, events: tool.events.filter((entry) => entry.id !== event.id) })}
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {readOnly ? null : (
        <button
          type="button"
          className={styles.add}
          onClick={() =>
            onChange({
              ...tool,
              events: [...tool.events, { id: newPageToolId(), date: formatIsoDate(new Date()), title: '' }],
            })
          }
        >
          + Event
        </button>
      )}
    </div>
  );
}

function HabitView({
  tool,
  readOnly,
  onChange,
}: {
  tool: Extract<PageToolPayload, { kind: 'habit' }>;
  readOnly?: boolean;
  onChange: (next: PageToolPayload) => void;
}) {
  const days = habitDayRange(tool.days);
  return (
    <div className={styles.shell} data-testid="pages-tool-habit">
      <div className={styles.habitHead} style={{ gridTemplateColumns: `minmax(0, 1fr) repeat(${days.length}, 28px) 22px` }}>
        <span />
        {days.map((day) => (
          <span key={day} className={styles.habitDow}>
            {WEEKDAY_SHORT[new Date(`${day}T00:00:00`).getDay()]}
            <small>{Number(day.slice(-2))}</small>
          </span>
        ))}
      </div>
      <ul className={styles.list}>
        {tool.habits.map((habit) => (
          <li key={habit.id} className={styles.habitRow} style={{ gridTemplateColumns: `minmax(0, 1fr) repeat(${days.length}, 28px) 22px` }}>
            <input
              className={styles.grow}
              value={habit.title}
              disabled={readOnly}
              placeholder="Habit"
              aria-label="Habit name"
              onChange={(event) =>
                onChange({
                  ...tool,
                  habits: tool.habits.map((entry) =>
                    entry.id === habit.id ? { ...entry, title: event.target.value } : entry,
                  ),
                })
              }
            />
            {days.map((day) => {
              const on = habit.stamps.includes(day);
              return (
                <input
                  key={day}
                  type="checkbox"
                  className={styles.check}
                  checked={on}
                  disabled={readOnly}
                  aria-label={`${habit.title || 'Habit'} ${day}`}
                  onChange={() =>
                    onChange({
                      ...tool,
                      habits: tool.habits.map((entry) => {
                        if (entry.id !== habit.id) return entry;
                        const stamps = on
                          ? entry.stamps.filter((stamp) => stamp !== day)
                          : [...entry.stamps, day];
                        return { ...entry, stamps };
                      }),
                    })
                  }
                />
              );
            })}
            {readOnly ? null : (
              <button
                type="button"
                className={styles.ghost}
                aria-label="Remove habit"
                onClick={() => onChange({ ...tool, habits: tool.habits.filter((entry) => entry.id !== habit.id) })}
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {readOnly ? null : (
        <button
          type="button"
          className={styles.add}
          onClick={() =>
            onChange({
              ...tool,
              habits: [...tool.habits, { id: newPageToolId(), title: '', stamps: [] }],
            })
          }
        >
          + Habit
        </button>
      )}
    </div>
  );
}

function CountdownView({
  tool,
  readOnly,
  onChange,
}: {
  tool: Extract<PageToolPayload, { kind: 'countdown' }>;
  readOnly?: boolean;
  onChange: (next: PageToolPayload) => void;
}) {
  return (
    <div className={styles.shell} data-testid="pages-tool-countdown">
      <ul className={styles.list}>
        {tool.items.map((item) => {
          const left = daysUntil(item.date);
          const label =
            left === null ? 'Set a date' : left === 0 ? 'Today' : left > 0 ? `${left} days` : `${Math.abs(left)} days ago`;
          return (
            <li key={item.id} className={styles.countdownRow}>
              <input
                className={styles.grow}
                value={item.title}
                disabled={readOnly}
                placeholder="Event"
                aria-label="Countdown title"
                onChange={(event) =>
                  onChange({
                    ...tool,
                    items: tool.items.map((entry) =>
                      entry.id === item.id ? { ...entry, title: event.target.value } : entry,
                    ),
                  })
                }
              />
              <input
                className={styles.date}
                value={item.date}
                disabled={readOnly}
                placeholder="YYYY-MM-DD"
                aria-label="Countdown date"
                onChange={(event) =>
                  onChange({
                    ...tool,
                    items: tool.items.map((entry) =>
                      entry.id === item.id ? { ...entry, date: event.target.value } : entry,
                    ),
                  })
                }
              />
              <span className={styles.count}>{label}</span>
              {readOnly ? null : (
                <button
                  type="button"
                  className={styles.ghost}
                  aria-label="Remove countdown"
                  onClick={() => onChange({ ...tool, items: tool.items.filter((entry) => entry.id !== item.id) })}
                >
                  ×
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {readOnly ? null : (
        <button
          type="button"
          className={styles.add}
          onClick={() =>
            onChange({
              ...tool,
              items: [...tool.items, { id: newPageToolId(), title: '', date: '' }],
            })
          }
        >
          + Date
        </button>
      )}
    </div>
  );
}

function ScheduleView({
  tool,
  readOnly,
  onChange,
}: {
  tool: Extract<PageToolPayload, { kind: 'schedule' }>;
  readOnly?: boolean;
  onChange: (next: PageToolPayload) => void;
}) {
  return (
    <div className={styles.shell} data-testid="pages-tool-schedule">
      <ul className={styles.list}>
        {tool.items.map((item) => (
          <li key={item.id} className={styles.scheduleRow}>
            <select
              className={styles.select}
              value={item.day}
              disabled={readOnly}
              aria-label="Weekday"
              onChange={(event) =>
                onChange({
                  ...tool,
                  items: tool.items.map((entry) =>
                    entry.id === item.id ? { ...entry, day: event.target.value as WeekDay } : entry,
                  ),
                })
              }
            >
              {WEEK_DAYS.map((day) => (
                <option key={day} value={day}>
                  {day[0]!.toUpperCase() + day.slice(1)}
                </option>
              ))}
            </select>
            <input
              className={styles.date}
              value={item.start}
              disabled={readOnly}
              placeholder="9:00"
              aria-label="Start time"
              onChange={(event) =>
                onChange({
                  ...tool,
                  items: tool.items.map((entry) =>
                    entry.id === item.id ? { ...entry, start: event.target.value } : entry,
                  ),
                })
              }
            />
            <input
              className={styles.date}
              value={item.end}
              disabled={readOnly}
              placeholder="10:00"
              aria-label="End time"
              onChange={(event) =>
                onChange({
                  ...tool,
                  items: tool.items.map((entry) =>
                    entry.id === item.id ? { ...entry, end: event.target.value } : entry,
                  ),
                })
              }
            />
            <input
              className={styles.grow}
              value={item.title}
              disabled={readOnly}
              placeholder="Block"
              aria-label="Schedule title"
              onChange={(event) =>
                onChange({
                  ...tool,
                  items: tool.items.map((entry) =>
                    entry.id === item.id ? { ...entry, title: event.target.value } : entry,
                  ),
                })
              }
            />
            {readOnly ? null : (
              <button
                type="button"
                className={styles.ghost}
                aria-label="Remove block"
                onClick={() => onChange({ ...tool, items: tool.items.filter((entry) => entry.id !== item.id) })}
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {readOnly ? null : (
        <button
          type="button"
          className={styles.add}
          onClick={() =>
            onChange({
              ...tool,
              items: [...tool.items, { id: newPageToolId(), day: 'mon', start: '', end: '', title: '' }],
            })
          }
        >
          + Block
        </button>
      )}
    </div>
  );
}
