import {
  runEndByIndex,
  runEndsByIndex,
  detachedRunByConvoId,
  pendingRunEndByConvoId,
  pendingRunEndsByConvoId,
  drainAfterAbortByIndex,
  queuedMessagesByConvoId,
  stopRequestedByConvoId,
  settledQueuedTurnReceiptsByConvoId,
  pendingQueuedTurnEnqueueIdsByConvoId,
} from '~/hooks/Chat/queue';

const clearFamily = <Param>(family: {
  getParams(): Iterable<Param>;
  remove(param: Param): void;
}) => {
  for (const param of [...family.getParams()]) {
    family.remove(param);
  }
};

/** Drops every per-key queue atom, so the next read of any key starts from its default. Isolates
 *  tests that share the default store. */
export function resetQueueFamilies(): void {
  clearFamily(queuedMessagesByConvoId);
  clearFamily(settledQueuedTurnReceiptsByConvoId);
  clearFamily(pendingQueuedTurnEnqueueIdsByConvoId);
  clearFamily(pendingRunEndsByConvoId);
  clearFamily(pendingRunEndByConvoId);
  clearFamily(drainAfterAbortByIndex);
  clearFamily(runEndsByIndex);
  clearFamily(runEndByIndex);
  clearFamily(detachedRunByConvoId);
  clearFamily(stopRequestedByConvoId);
}
