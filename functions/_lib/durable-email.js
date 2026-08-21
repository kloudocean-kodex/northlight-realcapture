// Executes a Gmail draft/send state machine whose checkpoints are persisted by
// the caller. A consumed draft after a recorded send intent is treated as an
// ambiguous-success receipt, preventing a duplicate recipient message.
export async function deliverDurableDraft({
  state = {},
  deliveryKey,
  messageId,
  createDraft,
  getDraft,
  sendDraft,
  persist,
  now = () => new Date().toISOString(),
}) {
  if (!deliveryKey || !messageId) throw new Error('email_delivery_identity_required');
  if (![createDraft, getDraft, sendDraft, persist].every(x => typeof x === 'function')) throw new Error('email_delivery_adapter_required');

  let current = { ...state }, draftId = current.gmail_draft_id || null, providerMessageId = current.gmail_message_id || null, inferred = false;
  const checkpoint = async patch => {
    const next = { ...current, ...patch };
    const saved = await persist(next);
    current = saved && typeof saved === 'object' ? { ...saved } : next;
    return current;
  };

  if (draftId && !providerMessageId) {
    const draft = await getDraft(draftId);
    if (!draft && current.gmail_send_started_at) {
      providerMessageId = `consumed-draft:${draftId}`;
      inferred = true;
      await checkpoint({ gmail_message_id: providerMessageId, gmail_inferred_at: now() });
    } else if (!draft) {
      draftId = null;
      await checkpoint({ gmail_draft_id: null });
    }
  }

  if (!draftId && !providerMessageId) {
    const draft = await createDraft();
    if (!draft?.id) throw new Error('gmail_draft_missing_id');
    draftId = draft.id;
    await checkpoint({
      email_delivery_key: deliveryKey,
      email_message_id: messageId,
      gmail_draft_id: draftId,
      gmail_message_id: null,
      gmail_send_started_at: null,
    });
  }

  if (!providerMessageId) {
    await checkpoint({ gmail_send_started_at: now() });
    const sent = await sendDraft(draftId);
    if (!sent?.id) throw new Error('gmail_send_missing_id');
    providerMessageId = sent.id;
    await checkpoint({ gmail_message_id: providerMessageId, gmail_sent_at: now() });
  }

  return { draftId, providerMessageId, inferred, state: current };
}
