// What you started writing to a thread and didn't send yet, kept per thread in the plugin's data (key
// `drafts/<thread id>`), so the thread panel shows it again after closing it or switching threads, and a phone showing
// the panel from the PC sees the same. No DOM here (the unit tests run it in Node).
//   draft = {text, images?: [{mediaType, data, name}], picks?: {replyId, picked}, answers?: {[requestId]:
//            {[question index]: {picked: [labels], own}}}}

export const draftKey = (threadId) => `drafts/${threadId}`;

const hasPicks = (picks) => Boolean(picks) && Object.values(picks.picked ?? {}).some((p) => p?.length);
const hasAnswers = (answers) =>
  Object.values(answers ?? {}).some((byQuestion) =>
    Object.values(byQuestion ?? {}).some((a) => a?.picked?.length || String(a?.own ?? "").trim()),
  );

export function isBlankDraft(draft) {
  if (!draft) return true;
  return !String(draft.text ?? "").trim() && !draft.images?.length && !hasPicks(draft.picks) && !hasAnswers(draft.answers);
}

/**
 * Drafts on a data store with get/set/delete (layr.data). Writes run in order, so a clear never loses to a late
 * save; `save` waits `delayMs` and keeps only the newest draft of a thread meanwhile. `flush` writes what waits now.
 */
export function createDraftStore(data, { delayMs = 400 } = {}) {
  let queue = Promise.resolve();
  const waiting = new Map(); // thread id → {draft, timer}
  const later = (fn) => {
    queue = queue.then(fn).catch(() => {});
    return queue;
  };
  const write = (threadId, draft) =>
    later(() => (isBlankDraft(draft) ? data.delete(draftKey(threadId)) : data.set(draftKey(threadId), { ...draft, at: Date.now() })));
  const store = {
    async load(threadId) {
      await store.flush(threadId);
      await queue;
      const saved = await data.get(draftKey(threadId)).catch(() => null);
      return saved && typeof saved === "object" ? { ...saved, text: String(saved.text ?? "") } : null;
    },
    save(threadId, draft) {
      const old = waiting.get(threadId);
      if (old) clearTimeout(old.timer);
      const timer = setTimeout(() => {
        waiting.delete(threadId);
        void write(threadId, draft);
      }, delayMs);
      waiting.set(threadId, { draft, timer });
    },
    /** Write a waiting draft at once (before the panel goes away). */
    flush(threadId) {
      const ids = threadId ? [threadId] : [...waiting.keys()];
      for (const id of ids) {
        const w = waiting.get(id);
        if (!w) continue;
        clearTimeout(w.timer);
        waiting.delete(id);
        void write(id, w.draft);
      }
      return queue;
    },
    /** Forget a thread's draft (it was sent). */
    clear(threadId) {
      const w = waiting.get(threadId);
      if (w) clearTimeout(w.timer);
      waiting.delete(threadId);
      return write(threadId, null);
    },
  };
  return store;
}
