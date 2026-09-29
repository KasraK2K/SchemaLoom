'use client';

import { Button, cn } from '@schemaloom/ui';
import Mention from '@tiptap/extension-mention';
import { EditorContent, useEditor, type JSONContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';
import { useRef, useState, type ReactNode } from 'react';
import { mentionsIn, type MentionCandidate } from './comments-api';

interface Menu {
  readonly items: readonly MentionCandidate[];
  readonly index: number;
  readonly pick: (item: MentionCandidate) => void;
}

/**
 * TipTap + the official `@tiptap/extension-mention` (Phase 4 Q5), fed by
 * `mention-candidates` — people who can see this target. The suggestion list renders
 * under the editor rather than at the caret: no positioning library for one popup.
 *
 * L17 warning: a mention of someone outside the candidate list (pasted, or they lost
 * access since) gets "<name> cannot see this <noun> — they will not be notified".
 */
export function CommentComposer({
  candidates,
  selfId,
  noun,
  initial,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  readonly candidates: readonly MentionCandidate[];
  readonly selfId: string | null;
  /** "table" / "column" in the engine's own words. */
  readonly noun: string;
  readonly initial?: JSONContent;
  readonly submitLabel: string;
  readonly busy: boolean;
  readonly onSubmit: (content: JSONContent) => Promise<unknown>;
  readonly onCancel?: () => void;
}) {
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;
  const [menu, setMenu] = useState<Menu | null>(null);
  const menuRef = useRef(menu);
  menuRef.current = menu;
  const [doc, setDoc] = useState<JSONContent | null>(initial ?? null);

  const open = (p: SuggestionProps<MentionCandidate>) => {
    setMenu({
      items: p.items,
      index: 0,
      pick: (item) => {
        p.command({ id: item.id, label: item.name });
      },
    });
  };
  const onKeyDown = ({ event }: SuggestionKeyDownProps): boolean => {
    const m = menuRef.current;
    if (m === null || m.items.length === 0) return false;
    const step = (by: number) => {
      setMenu({ ...m, index: (m.index + by + m.items.length) % m.items.length });
    };
    if (event.key === 'ArrowDown') step(1);
    else if (event.key === 'ArrowUp') step(-1);
    else if (event.key === 'Enter' || event.key === 'Tab') {
      const item = m.items[m.index];
      if (item !== undefined) m.pick(item);
    } else if (event.key === 'Escape') setMenu(null);
    else return false;
    return true;
  };

  const editor = useEditor({
    immediatelyRender: false,
    content: initial ?? '',
    extensions: [
      StarterKit.configure({ heading: false, codeBlock: false, horizontalRule: false }),
      Mention.configure({
        HTMLAttributes: { class: 'rounded bg-accent-subtle px-1 text-accent-text' },
        suggestion: {
          items: ({ query }: { query: string }): MentionCandidate[] =>
            candidatesRef.current
              .filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
              .slice(0, 8),
          render: () => ({
            onStart: open,
            onUpdate: open,
            onKeyDown,
            onExit: () => {
              setMenu(null);
            },
          }),
        },
      }),
    ],
    editorProps: {
      attributes: {
        // A contenteditable is not announced as an input without these.
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': 'Comment',
        class:
          'min-h-16 rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text focus:outline-none',
      },
    },
    onUpdate: ({ editor: e }) => {
      setDoc(e.getJSON());
    },
  });

  const known = new Set([...candidates.map((c) => c.id), ...(selfId === null ? [] : [selfId])]);
  const unreachable = mentionsIn(doc).filter((m) => !known.has(m.id));

  const submit = async () => {
    if (editor === null || editor.isEmpty) return;
    await onSubmit(editor.getJSON());
    editor.commands.clearContent();
    setDoc(null);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <EditorContent editor={editor} />
      {menu !== null && menu.items.length > 0 ? (
        <ul
          role="listbox"
          aria-label="People"
          className="rounded-md border border-border bg-surface-raised p-1 text-sm"
        >
          {menu.items.map((item, i) => (
            <li key={item.id} role="option" aria-selected={i === menu.index}>
              <button
                type="button"
                className={cn(
                  'w-full rounded px-2 py-1 text-left',
                  i === menu.index && 'bg-surface-hover',
                )}
                onMouseDown={(e) => {
                  e.preventDefault();
                  menu.pick(item);
                }}
              >
                {item.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {unreachable.map((m) => (
        <p
          key={m.id}
          role="status"
          className="rounded bg-warning-subtle px-2 py-1 text-xs text-warning-text"
        >
          {m.label} cannot see this {noun} — they will not be notified.
        </p>
      ))}
      <div className="flex justify-end gap-1">
        {onCancel === undefined ? null : (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button size="sm" disabled={busy} onClick={() => void submit()}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

interface Node {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: Node[];
}

/**
 * Read-only render of a (server-redacted) comment body or doc. A handful of node types, not a
 * second editor per comment; anything unknown renders its children.
 */
export function RichText({ doc }: { readonly doc: unknown }) {
  return <div className="space-y-1 text-sm text-text">{render(doc as Node, 'r')}</div>;
}

function render(node: Node, key: string): ReactNode {
  const kids = (node.content ?? []).map((child, i) => render(child, `${key}.${String(i)}`));
  switch (node.type) {
    case 'paragraph':
      return <p key={key}>{kids}</p>;
    case 'hardBreak':
      return <br key={key} />;
    case 'bulletList':
      return (
        <ul key={key} className="list-disc pl-5">
          {kids}
        </ul>
      );
    case 'orderedList':
      return (
        <ol key={key} className="list-decimal pl-5">
          {kids}
        </ol>
      );
    case 'listItem':
      return <li key={key}>{kids}</li>;
    case 'heading':
      return (
        <p key={key} className="font-semibold">
          {kids}
        </p>
      );
    case 'codeBlock':
      return (
        <pre key={key} className="overflow-auto rounded bg-surface-sunken p-2 font-mono text-xs">
          {kids}
        </pre>
      );
    case 'horizontalRule':
      return <hr key={key} className="border-border" />;
    case 'blockquote':
      return (
        <blockquote key={key} className="border-l-2 border-border pl-2 text-text-muted">
          {kids}
        </blockquote>
      );
    case 'mention':
      return node.attrs?.restricted === true ? (
        <span key={key} className="rounded bg-surface-sunken px-1 text-text-subtle">
          restricted
        </span>
      ) : (
        <span key={key} className="rounded bg-accent-subtle px-1 text-accent-text">
          @{typeof node.attrs?.label === 'string' ? node.attrs.label : ''}
        </span>
      );
    case 'text': {
      let out: ReactNode = node.text ?? '';
      for (const mark of node.marks ?? []) {
        if (mark.type === 'bold') out = <strong>{out}</strong>;
        else if (mark.type === 'italic') out = <em>{out}</em>;
        else if (mark.type === 'code') out = <code className="font-mono text-xs">{out}</code>;
        else if (mark.type === 'strike') out = <s>{out}</s>;
        else if (mark.type === 'underline') out = <u>{out}</u>;
        // The API keeps only http(s)/mailto hrefs (docs-rules.ts).
        else if (mark.type === 'link' && typeof mark.attrs?.href === 'string') {
          out = (
            <a
              href={mark.attrs.href}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="text-accent-text underline"
            >
              {out}
            </a>
          );
        }
      }
      return <span key={key}>{out}</span>;
    }
    default:
      return <span key={key}>{kids}</span>;
  }
}
