import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLibraryInvitation, parseLibraryInvitationFragment } from "../apps/web/src/shared/lib/library-invite.ts";

const libraryId = "123e4567-e89b-12d3-a456-426614174000";
const token = "abcdefghijklmnopqrstuvwxyzABCDEFG0123456789_-";

test("library invitation parser accepts bounded fragment values", () => {
  assert.deepEqual(parseLibraryInvitationFragment(`#token=${token}&libraryId=${libraryId}`), { token, libraryId });
  assert.deepEqual(parseLibraryInvitation(token, libraryId), { token, libraryId });
});

test("library invitation parser rejects malformed or oversized secrets", () => {
  assert.equal(parseLibraryInvitation("a".repeat(31), libraryId), null);
  assert.equal(parseLibraryInvitationFragment(`#token=bad%2Ftoken&libraryId=${libraryId}`), null);
  assert.equal(parseLibraryInvitationFragment(`#token=${"a".repeat(513)}&libraryId=${libraryId}`), null);
  assert.equal(parseLibraryInvitationFragment(`#token=${token}&libraryId=not-a-uuid`), null);
});
