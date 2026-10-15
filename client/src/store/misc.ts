import { atom } from 'recoil';
import { atomWithLocalStorage } from './utils';
import { BadgeItem } from '~/common';

const hideBannerHint = atomWithLocalStorage('hideBannerHint', [] as string[]);

const queriesEnabled = atom<boolean>({
  key: 'queriesEnabled',
  default: true,
});

const isEditingBadges = atom<boolean>({
  key: 'isEditingBadges',
  default: false,
});

const showShortcutsDialog = atom<boolean>({
  key: 'showShortcutsDialog',
  default: false,
});

export type KeyboardDeleteTarget = {
  conversationId: string;
  title: string;
};

const keyboardDeleteTarget = atom<KeyboardDeleteTarget | null>({
  key: 'keyboardDeleteTarget',
  default: null,
});

export type ShortcutOverride = {
  mac: string | null;
  other: string | null;
};

const customShortcuts = atomWithLocalStorage<Record<string, ShortcutOverride>>(
  'customKeyboardShortcuts',
  {},
);

/** When false, no keyboard shortcut fires and the UI stops advertising them. */
const shortcutsEnabled = atomWithLocalStorage<boolean>('keyboardShortcutsEnabled', true);

const chatBadges = atomWithLocalStorage<Pick<BadgeItem, 'id'>[]>('chatBadges', [
  // When adding new badges, make sure to add them to useChatBadges.ts as well and add them as last item
  // DO NOT CHANGE THE ORDER OF THE BADGES ALREADY IN THE ARRAY
  { id: '1' },
  // { id: '2' },
]);

export default {
  hideBannerHint,
  queriesEnabled,
  isEditingBadges,
  showShortcutsDialog,
  keyboardDeleteTarget,
  customShortcuts,
  shortcutsEnabled,
  chatBadges,
};
