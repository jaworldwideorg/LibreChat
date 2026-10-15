import { getDefaultStore } from 'jotai';
import { act, renderHook } from '@testing-library/react';
import { RecoilRoot, useRecoilValue, useSetRecoilState } from 'recoil';
import { isSubmittingFamily, useIsSubmitting, resetSubmitting } from '@librechat/chat/react';
import type { ReactNode } from 'react';
import store from '~/store';

const CONVO_ID = 'convo-1';
const jotaiStore = getDefaultStore();
const wrapper = ({ children }: { children: ReactNode }) => <RecoilRoot>{children}</RecoilRoot>;

afterEach(() => {
  resetSubmitting(jotaiStore);
});

describe('useIsSubmitting beside a Recoil atom', () => {
  it('never commits the new Recoil value with the previous generating flag', () => {
    jotaiStore.set(isSubmittingFamily(0), true);
    const commits: Array<{ epoch: number | null; submitting: boolean }> = [];
    const { result } = renderHook(
      () => {
        const epoch = useRecoilValue(store.activeGenerationCreatedAtByConvoId(CONVO_ID));
        const submitting = useIsSubmitting(0);
        commits.push({ epoch, submitting });
        return useSetRecoilState(store.activeGenerationCreatedAtByConvoId(CONVO_ID));
      },
      { wrapper },
    );

    act(() => {
      jotaiStore.set(isSubmittingFamily(0), false);
      result.current(42);
    });

    const withNewEpoch = commits.filter(({ epoch }) => epoch === 42);
    expect(withNewEpoch.length).toBeGreaterThan(0);
    expect(withNewEpoch.every(({ submitting }) => !submitting)).toBe(true);
  });
});
