import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { Atom, WritableAtom, createStore } from 'jotai';
import type { SetStateAction } from 'react';

/** Pane index a generation runs in: `0` for the main chat, `1` for the added one. */
export type PaneIndex = string | number;

type Store = ReturnType<typeof createStore>;

const submittingIndexesAtom = atom<ReadonlySet<PaneIndex>>(new Set<PaneIndex>());

/** Whether a generation is in flight in the pane at this index. */
export type SubmittingAtom = WritableAtom<boolean, [SetStateAction<boolean>], void>;

export const isSubmittingFamily: (index: PaneIndex) => SubmittingAtom = atomFamily(
  (index: PaneIndex): SubmittingAtom => {
    const valueAtom = atom(false);
    return atom(
      (get) => get(valueAtom),
      (get, set, update: SetStateAction<boolean>) => {
        const previous = get(valueAtom);
        const next = typeof update === 'function' ? update(previous) : update;
        if (next === previous) {
          return;
        }
        set(valueAtom, next);
        const indexes = new Set(get(submittingIndexesAtom));
        if (next) {
          indexes.add(index);
        } else {
          indexes.delete(index);
        }
        set(submittingIndexesAtom, indexes);
      },
    );
  },
);

/** Whether any pane is generating, for what must stay awake while a reply streams. */
export const anySubmittingAtom: Atom<boolean> = atom((get) => get(submittingIndexesAtom).size > 0);

/** Clears every pane's in-flight flag in the given store, for teardown between runs. */
export function resetSubmitting(store: Pick<Store, 'get' | 'set'>): void {
  store.get(submittingIndexesAtom).forEach((index) => store.set(isSubmittingFamily(index), false));
}
