/**
 * Value object: SubmissionKey.
 *
 * The client-generated retry key that identifies one submission attempt. It is
 * stored on the accepted Order as its unique `submission_key`. It is not part
 * of what is ordered, so it is not in `OrderRequest`.
 *
 * @see docs/architecture.md, "Domain model"
 * @module
 */

import { z } from "zod";

/**
 * Longest key the `orders.submission_key` column accepts
 * (`char_length(submission_key) <= 255`, see docs/database-schema.md).
 */
export const SUBMISSION_KEY_MAX_LENGTH = 255;

/**
 * Domain input guard for a client `submissionId`: a non-blank string of at most
 * {@link SUBMISSION_KEY_MAX_LENGTH} characters with no leading or trailing
 * whitespace.
 *
 * Surrounding whitespace is rejected, not trimmed, so the stored key is exactly
 * what the client sent and a retry with the same value always matches. This
 * also rejects whitespace-only keys (including tabs and newlines, which the
 * database's space-only `btrim` check would let through).
 *
 * The length is counted in UTF-16 code units (`string.length`), which is never
 * less than PostgreSQL's `char_length`, so every accepted key fits the column.
 * Callers use `.safeParse` (see "Error handling" in packages/core/README.md).
 */
export const submissionKeySchema = z
  .string()
  .min(1)
  .max(SUBMISSION_KEY_MAX_LENGTH)
  .refine((key) => key.trim() === key, {
    message: "Submission key must not have leading or trailing whitespace.",
  })
  .brand<"SubmissionKey">();

/** A validated client submission key, stored verbatim on the accepted Order. */
export type SubmissionKey = z.infer<typeof submissionKeySchema>;
