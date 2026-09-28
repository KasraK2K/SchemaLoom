'use client';

import { Compartment, EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { useEffect, useRef } from 'react';
import { loadEditorLanguage, useEngine, useEngineUi } from '@/engines';

export interface EditorMark {
  readonly from: number;
  readonly to: number;
  readonly message: string;
}

const setMarks = StateEffect.define<readonly EditorMark[]>();

/** Underlines for unknown / ambiguous identifiers, replaced wholesale on each validation. */
const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setMarks)) continue;
      const length = tr.state.doc.length;
      next = Decoration.set(
        effect.value
          .filter((m) => m.from < m.to && m.to <= length)
          .map((m) =>
            Decoration.mark({ class: 'cm-sl-flagged', attributes: { title: m.message } }).range(m.from, m.to),
          ),
        true,
      );
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const theme = EditorView.baseTheme({
  '.cm-sl-flagged': {
    textDecoration: 'underline wavy var(--color-danger)',
    textUnderlineOffset: '3px',
  },
});

/**
 * CodeMirror 6 over the engine's editor language (`loadEditorLanguage`, doc 03 §16.4).
 * Uncontrolled after mount: `value` seeds the document, `onChange` reports edits, and
 * `marks` are pushed in as a state effect so validation never resets the cursor.
 */
export function SqlEditor({
  value,
  onChange,
  marks,
}: {
  readonly value: string;
  readonly onChange: (text: string) => void;
  readonly marks: readonly EditorMark[];
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const facet = useEngine();
  const ui = useEngineUi();

  useEffect(() => {
    if (host.current === null) return;
    const language = new Compartment();
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          language.of([]),
          marksField,
          theme,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    let live = true;
    void loadEditorLanguage(facet, ui).then((extension) => {
      if (live && extension !== null) editor.dispatch({ effects: language.reconfigure(extension) });
    });
    return () => {
      live = false;
      editor.destroy();
      view.current = null;
    };
    // `value` seeds once per mount; the parent remounts (by `key`) to load another query.
  }, [facet, ui]);

  useEffect(() => {
    view.current?.dispatch({ effects: setMarks.of(marks) });
  }, [marks]);

  return (
    <div
      ref={host}
      aria-label="Query editor"
      className="min-h-32 overflow-auto rounded-md border border-border bg-surface text-xs"
    />
  );
}
