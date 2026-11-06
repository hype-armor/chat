-- Queue quotas (audit H3). The delivery queue is bounded per recipient
-- device, and senders are charged for the bytes they store, so one sender
-- cannot fill a person's queue.
-- The read path asks for one recipient ordered by queue_id:
CREATE INDEX queued_envelopes_recipient_idx
    ON queued_envelopes (recipient_device_id, queue_id);
